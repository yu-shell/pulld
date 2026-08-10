// Handler-level tests for the public search query endpoint (functions/api/search/query.js) — the
// only endpoint reachable with the public query_key, and previously the only search handler with no
// automated coverage. functions/ is excluded from tsconfig, so `node --test` is its only safety net.
//
// The load-bearing behavior covered here:
//   - the `limit` clamp: [1,20] with a default of 8, and — the regression this guards — non-numeric
//     input must NOT poison topK. `Number("abc")` is NaN, which Math.min/max propagate; that NaN
//     used to flow into `env.VEC.query({ topK: NaN*3 })` and the `results.length >= NaN` dedup
//     guard, breaking search on the public path from trivial input.
//   - over-fetch (topK*3) then dedup-by-docId, first-seen wins, capped at the requested limit.
//   - every topK the handler can ask for is one Vectorize will actually accept: a whole number no
//     greater than 50. Both halves of that were violated in production — `?limit=17` and up sent
//     51..60, and `?limit=2.5` sent 7.5, each answered with a 502 from a limit the endpoint itself
//     documents as valid. The assertions below sweep the whole advertised range rather than
//     spot-checking, because the broken part was the top fifth of it.
//   - the quota (429) and burst rate-limit (429) gates.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  onRequestGet,
  onRequestPost,
  clampLimit,
  overFetch,
  VEC_TOPK_MAX,
} from "../functions/api/search/query.js"

const PROJECT = "prj_test"
const QUERY_KEY = "pk_test"

// Minimal fake of the Cloudflare bindings query touches: D1 (project lookup, rate-limit counter,
// usage bump), Workers AI (query embedding), and Vectorize (query). `queries` records the options
// each VEC.query received so the topK the handler asks for can be asserted directly.
function fakeEnv({ matches = [], usageN = 1, qLimit = 1000, rlN = 1 } = {}) {
  const queries = []
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (/FROM search_projects/.test(sql)) return { id: PROJECT, q_limit: qLimit }
              if (/rate_limits/.test(sql)) return { n: rlN } // INSERT ... RETURNING n
              if (/FROM search_usage/.test(sql)) return { n: usageN }
              return null
            },
            async run() {},
          }
        },
      }
    },
  }
  const AI = { run: async (_model, { text }) => ({ data: text.map(() => [0.1, 0.2, 0.3]) }) }
  const VEC = {
    async query(_vector, opts) {
      queries.push(opts)
      return { matches }
    },
  }
  return { env: { DB, AI, VEC }, queries }
}

function get(q, params = {}) {
  const u = new URL("https://pulld.pages.dev/api/search/query")
  if (q != null) u.searchParams.set("q", q)
  u.searchParams.set("key", QUERY_KEY)
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return { method: "GET", url: u.toString(), headers: { get: () => null } }
}

function post(body) {
  return {
    method: "POST",
    url: "https://pulld.pages.dev/api/search/query",
    headers: { get: () => null },
    json: async () => body,
  }
}

const match = (docId, extra = {}) => ({
  metadata: { docId, title: docId.toUpperCase(), url: `/${docId}`, text: `text-${docId}`, ...extra },
  score: 0.9,
})

// clampLimit is the pure guard; assert its contract independently of the handler.
test("clampLimit: clamps to [1,20], defaults on missing/empty/non-numeric input", () => {
  assert.equal(clampLimit(null, 8), 8) // absent query param
  assert.equal(clampLimit(undefined, 8), 8)
  assert.equal(clampLimit("", 8), 8) // ?limit= with no value
  assert.equal(clampLimit("abc", 8), 8) // the bug: Number("abc") is NaN → fall back, never NaN
  assert.equal(clampLimit("5", 8), 5)
  assert.equal(clampLimit("0", 8), 1) // clamp up
  assert.equal(clampLimit("-5", 8), 1)
  assert.equal(clampLimit("100", 8), 20) // clamp down
  assert.equal(clampLimit(12, 8), 12)
})

// topK counts rows, so a fractional one is not a smaller request — it is a rejected one.
test("clampLimit: floors to a whole number (topK is a count, not a measurement)", () => {
  assert.equal(clampLimit("2.5", 8), 2) // the bug: 2.5 survived, over-fetched to 7.5, 502
  assert.equal(clampLimit("8.5", 8), 8)
  assert.equal(clampLimit("19.9", 8), 19)
  assert.equal(clampLimit("0.5", 8), 1) // floors to 0, then clamped up into range
  assert.equal(clampLimit("1e1", 8), 10) // Number() accepts more shapes than the docs advertise
  assert.equal(clampLimit(" 4 ", 8), 4)
  for (const raw of ["2.5", "8.5", "19.9", "0.5", "1e1", " 4 "]) {
    assert.ok(Number.isInteger(clampLimit(raw, 8)), `clampLimit(${JSON.stringify(raw)}) not integer`)
  }
})

// The ceiling itself, asserted directly: Vectorize serves at most 50 matches when they carry
// metadata, and this query asks for `returnMetadata: "all"`.
test("overFetch: 3x headroom, clamped to the Vectorize topK ceiling", () => {
  assert.equal(VEC_TOPK_MAX, 50)
  assert.equal(overFetch(1), 3)
  assert.equal(overFetch(8), 24) // the default, unaffected
  assert.equal(overFetch(16), 48) // last limit that fit under the cap before the fix
  assert.equal(overFetch(17), 50) // was 51 → Vectorize rejected the query
  assert.equal(overFetch(20), 50) // was 60
})

test("query: a non-numeric limit falls back to the default (topK stays finite, not NaN)", async () => {
  const { env, queries } = fakeEnv({ matches: [] })
  const res = await onRequestGet({ request: get("hello", { limit: "abc" }), env })

  assert.equal(res.status, 200)
  assert.equal(queries.length, 1)
  const { topK } = queries[0]
  assert.ok(Number.isFinite(topK), `topK must be finite, got ${topK}`) // pre-fix: NaN
  assert.equal(topK, 8 * 3) // default 8, over-fetched 3x
  assert.deepEqual(await res.json().then((b) => b.results), [])
})

test("query: limit is clamped to [1,20] and over-fetched 3x for the Vectorize query", async () => {
  // [requested limit, clamped limit, topK asked of Vectorize]
  const cases = [
    [undefined, 8, 24], // default
    [3, 3, 9],
    [0, 1, 3], // clamped up
    [100, 20, 50], // clamped down to 20, then the over-fetch meets the 50 ceiling
  ]
  for (const [limit, clamped, wantTopK] of cases) {
    const { env, queries } = fakeEnv()
    await onRequestGet({ request: get("hi", limit === undefined ? {} : { limit }), env })
    assert.equal(queries[0].topK, wantTopK, `limit=${limit} → clamped ${clamped} → topK ${wantTopK}`)
  }
})

// The regression that reached production: the endpoint documents limit up to 20, but the 3x
// over-fetch turned the top of that range into a topK Vectorize refuses, so `?limit=17` and above
// answered 502 "search failed". Sweeping the whole advertised range is the point — a spot check at
// the default (8) passes either way.
test("query: every limit the endpoint accepts asks Vectorize for a topK it accepts", async () => {
  for (let limit = 1; limit <= 20; limit++) {
    const { env, queries } = fakeEnv()
    const res = await onRequestGet({ request: get("hi", { limit }), env })

    assert.equal(res.status, 200, `limit=${limit} should not error`)
    const { topK } = queries[0]
    assert.ok(Number.isInteger(topK), `limit=${limit} → topK ${topK} is not a whole number`)
    assert.ok(topK >= 1 && topK <= VEC_TOPK_MAX, `limit=${limit} → topK ${topK} outside [1,50]`)
    assert.ok(topK >= limit, `limit=${limit} → topK ${topK} cannot fill the requested count`)
  }
})

test("query: a fractional limit still asks for a whole topK", async () => {
  const { env, queries } = fakeEnv()
  const res = await onRequestGet({ request: get("hi", { limit: "2.5" }), env })

  assert.equal(res.status, 200)
  assert.equal(queries[0].topK, 6) // pre-fix: 7.5, which Vectorize rejected
})

// The dedup guard reads the same clamped value, so flooring has to reach it too: `results.length
// >= 2.5` would have let a third document through a request that asked for two.
test("query: a fractional limit caps the result list at a whole number of documents", async () => {
  const { env } = fakeEnv({ matches: [match("a"), match("b"), match("c"), match("d")] })
  const res = await onRequestGet({ request: get("hi", { limit: "2.5" }), env })

  const { results } = await res.json()
  assert.deepEqual(results.map((r) => r.id), ["a", "b"])
})

test("query: results are deduped by docId (first-seen wins) and capped at the requested limit", async () => {
  const matches = [
    match("a"),
    { ...match("a"), metadata: { docId: "a", title: "A-DUP", url: "/dup", text: "dup" } }, // same doc
    match("b"),
    match("c"),
  ]
  const { env } = fakeEnv({ matches })
  const res = await onRequestPost({ request: post({ q: "hi", key: QUERY_KEY, limit: 2 }), env })

  assert.equal(res.status, 200)
  const { results } = await res.json()
  assert.deepEqual(results.map((r) => r.id), ["a", "b"]) // deduped, capped at 2
  assert.equal(results[0].label, "A") // first occurrence wins, not "A-DUP"
  assert.equal(results[0].snippet, "text-a")
})

test("query: a match with no docId is skipped", async () => {
  const matches = [{ metadata: { title: "orphan" }, score: 0.9 }, match("b")]
  const { env } = fakeEnv({ matches })
  const res = await onRequestGet({ request: get("hi"), env })

  const { results } = await res.json()
  assert.deepEqual(results.map((r) => r.id), ["b"])
})

test("query: an empty query short-circuits to no results without touching Vectorize", async () => {
  const { env, queries } = fakeEnv()
  const res = await onRequestGet({ request: get("   "), env })

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json().then((b) => b.results), [])
  assert.equal(queries.length, 0)
})

test("query: exceeding the monthly quota returns 429", async () => {
  const { env } = fakeEnv({ usageN: 1001, qLimit: 1000 })
  const res = await onRequestGet({ request: get("hi"), env })

  assert.equal(res.status, 429)
  assert.equal(await res.json().then((b) => b.error), "quota_exceeded")
})

test("query: exceeding the burst rate limit returns 429 before any embedding work", async () => {
  const { env, queries } = fakeEnv({ rlN: 121 }) // RL_LIMIT is 120
  const res = await onRequestGet({ request: get("hi"), env })

  assert.equal(res.status, 429)
  assert.equal(await res.json().then((b) => b.error), "rate_limited")
  assert.equal(queries.length, 0) // rejected before the Vectorize query
})

test("query: an unknown key is unauthorized", async () => {
  const { env } = fakeEnv()
  // projectByKey returns null for a key the DB doesn't resolve; force that by overriding the row.
  env.DB.prepare = (sql) => ({
    bind: () => ({ async first() { return /rate_limits|search_usage/.test(sql) ? { n: 1 } : null }, async run() {} }),
  })
  const res = await onRequestGet({ request: get("hi"), env })
  assert.equal(res.status, 401)
})
