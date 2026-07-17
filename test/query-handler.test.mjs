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
//   - the quota (429) and burst rate-limit (429) gates.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestGet, onRequestPost, clampLimit } from "../functions/api/search/query.js"

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
  for (const [limit, wantTopK] of [[undefined, 8], [3, 3], [100, 20], [0, 1]]) {
    const { env, queries } = fakeEnv()
    await onRequestGet({ request: get("hi", limit == null ? {} : { limit }), env })
    assert.equal(queries[0].topK, wantTopK * 3, `limit=${limit} → topK ${wantTopK}`)
  }
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
