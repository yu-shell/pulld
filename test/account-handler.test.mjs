// Handler-level tests for the account endpoint (functions/api/search/account.js) — the endpoint
// that hands a customer their SECRET keys (admin_key = write access, query_key = search). It was
// the last search handler with no automated coverage, and functions/ is excluded from tsconfig
// (see tsconfig "include"), so `node --test` is its only safety net.
//
// The load-bearing behavior covered here:
//   - the two ways in: `?license=<key>` direct, and `?customer_session_token=` resolved via the
//     Polar customer-portal API by licenseFromSession.
//   - the security guard in licenseFromSession: a session is resolved ONLY to a key that maps to
//     one of this customer's ACTIVE search projects — never an arbitrary key the token can list.
//     A customer holding several license keys must not be handed the wrong (or an inactive)
//     project's secret keys.
//   - the auth outcomes: 401 when nothing resolves, 404 when a license has no active project.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestGet, ACCOUNT_RL_LIMIT } from "../functions/api/search/account.js"
import { RL_LIMIT, RL_WINDOW } from "../functions/api/search/_lib.js"
import { atClock, WINDOW_START } from "./_clock.mjs"

const ROW = {
  id: "prj_test",
  admin_key: "ak_secret",
  query_key: "pk_public",
  plan: "pro",
  q_limit: 50000,
  doc_limit: 5000,
}

// Minimal fake of the D1 binding account.js touches. `activeLicenses` is the set of license keys
// that resolve to an active project; both the licenseFromSession probe (SELECT 1 ... active = 1)
// and the final row lookup (SELECT id, admin_key ... active = 1) consult it, keyed by the bound
// license value — so an inactive/unknown license yields null from both, exactly like real D1.
//
// It also models the `rate_limits` upsert the burst limiter runs, counting per (key, bucket) the
// way `ON CONFLICT … DO UPDATE SET n = n + 1 RETURNING n` does. `limiterKeys` records the keys it
// was called with, in order, so a test can assert what the endpoint keyed the window on without
// reaching into the limiter.
function fakeDB(activeLicenses = new Set()) {
  const counts = new Map()
  const limiterKeys = []
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (/INSERT INTO rate_limits/.test(sql)) {
                const [key, bucket] = args
                limiterKeys.push(key)
                const k = `${key}\u0000${bucket}`
                const n = (counts.get(k) ?? 0) + 1
                counts.set(k, n)
                return { n }
              }
              const [license] = args
              if (!activeLicenses.has(license)) return null
              // The licenseFromSession probe only needs a truthy row; the final lookup needs the
              // full project row. Distinguish by the columns each query selects.
              if (/SELECT 1 FROM search_projects/.test(sql)) return { 1: 1 }
              return ROW
            },
            async run() {},
          }
        },
      }
    },
  }
  db.limiterKeys = limiterKeys
  return db
}

// Install a fake global fetch modeling the Polar customer-portal license-keys endpoint. Returns a
// restore fn. `items` is what the portal lists for the session token; `ok` toggles an API failure.
function stubFetch({ items = [], ok = true } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    return { ok, async json() { return { items } } }
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

// `ip` is what the limiter keys its window on (cf-connecting-ip); omitting it leaves every header
// null, which is the "0.0.0.0" fallback the handler uses and what the pre-limiter tests below ran
// under before it existed.
function req(params = {}, { ip } = {}) {
  const u = new URL("https://pulld.pages.dev/api/search/account")
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return {
    url: u.toString(),
    headers: { get: (h) => (ip && h.toLowerCase() === "cf-connecting-ip" ? ip : null) },
  }
}

test("account: a direct ?license for an active project returns its keys and limits", async () => {
  const env = { DB: fakeDB(new Set(["lic-active"])) }
  const res = await onRequestGet({ request: req({ license: "lic-active" }), env })

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.project, "prj_test")
  assert.equal(body.admin_key, "ak_secret")
  assert.equal(body.query_key, "pk_public")
  assert.equal(body.plan, "pro")
  assert.deepEqual(body.limits, { queries_per_month: 50000, docs: 5000 })
})

test("account: no license and no session is unauthorized (401)", async () => {
  const env = { DB: fakeDB() }
  const res = await onRequestGet({ request: req(), env })
  assert.equal(res.status, 401)
  assert.equal(await res.json().then((b) => b.error), "unauthorized")
})

test("account: a license with no active project is 404, not 401", async () => {
  const env = { DB: fakeDB() } // no active licenses → final lookup returns null
  const res = await onRequestGet({ request: req({ license: "lic-unknown" }), env })
  assert.equal(res.status, 404)
  assert.equal(await res.json().then((b) => b.error), "not_found")
})

test("account: a session token resolves via Polar to the customer's active-project key", async () => {
  // The portal lists two keys; only the second maps to an active project. The guard must pick it.
  const f = stubFetch({ items: [{ key: "lic-other" }, { key: "lic-active" }] })
  try {
    const env = { DB: fakeDB(new Set(["lic-active"])) }
    const res = await onRequestGet({ request: req({ customer_session_token: "polar_cst_x" }), env })

    assert.equal(res.status, 200)
    assert.equal(await res.json().then((b) => b.admin_key), "ak_secret")
    // The session token is sent as a Bearer credential to the Polar customer-portal endpoint.
    assert.equal(f.calls.length, 1)
    assert.match(f.calls[0].url, /customer-portal\/license-keys/)
    assert.equal(f.calls[0].init.headers.Authorization, "Bearer polar_cst_x")
  } finally {
    f.restore()
  }
})

test("account: a session whose keys map to NO active project is unauthorized, not leaked", async () => {
  // The token can list keys, but none resolve to an active project → licenseFromSession returns ""
  // → 401. This is the guard against handing back an arbitrary (or inactive) project's secrets.
  const f = stubFetch({ items: [{ key: "lic-inactive" }, { key: "lic-foreign" }] })
  try {
    const env = { DB: fakeDB(new Set(["lic-active"])) } // neither listed key is active
    const res = await onRequestGet({ request: req({ customer_session_token: "polar_cst_x" }), env })
    assert.equal(res.status, 401)
    assert.equal(await res.json().then((b) => b.error), "unauthorized")
  } finally {
    f.restore()
  }
})

test("account: a failed Polar lookup (non-ok) resolves to unauthorized, not a crash", async () => {
  const f = stubFetch({ ok: false })
  try {
    const env = { DB: fakeDB(new Set(["lic-active"])) }
    const res = await onRequestGet({ request: req({ session: "polar_cst_x" }), env })
    assert.equal(res.status, 401)
  } finally {
    f.restore()
  }
})

test("account: an explicit ?license takes precedence and skips the Polar round-trip", async () => {
  const f = stubFetch({ items: [{ key: "lic-active" }] })
  try {
    const env = { DB: fakeDB(new Set(["lic-active"])) }
    const res = await onRequestGet({
      request: req({ license: "lic-active", customer_session_token: "polar_cst_x" }),
      env,
    })
    assert.equal(res.status, 200)
    assert.equal(f.calls.length, 0) // license present → licenseFromSession never called
  } finally {
    f.restore()
  }
})

// --- the burst limiter ---
//
// This is the only endpoint in the service reachable with no credential that answers with one, and
// it was the only one with no limiter: the public query endpoint has had one since it shipped, on
// the stated ground that "a flood from one client can't drain a customer's quota or spike cost in
// minutes". Here the stakes are different and higher — nothing bounded how many license keys an
// anonymous caller could guess at, and nothing bounded how much work one could make this Worker
// do, since every session-token request is an outbound Polar call plus a D1 read per key it lists.
//
// Driven to the edge by the exported ACCOUNT_RL_LIMIT rather than a copy of it: a test that spells
// its own 20 goes on passing whatever that number becomes.
const spend = async (env, request, times) => {
  let last
  for (let i = 0; i < times; i++) last = await onRequestGet({ request, env })
  return last
}

test("account: a flood from one IP is refused once it passes the endpoint's own limit", async () => {
  const env = { DB: fakeDB(new Set(["lic-active"])) }
  const request = req({ license: "lic-active" }, { ip: "9.9.9.9" })

  const lastAllowed = await spend(env, request, ACCOUNT_RL_LIMIT)
  assert.equal(lastAllowed.status, 200, "the limit itself must still be served")

  const res = await onRequestGet({ request, env })
  assert.equal(res.status, 429)
  const body = await res.json()
  assert.equal(body.error, "rate_limited")
  assert.match(body.message, /slow down/i)
  // The page shows `message || error`, so the 429 has to carry a sentence, not just a code.
  assert.ok(body.message.length > 20)
  // The 429 has to carry a backoff at all; what the number must be is pinned on a frozen clock
  // in the test below, where the window's remaining seconds are knowable.
  assert.ok(res.headers.get("retry-after"), "the 429 carries no retry-after")
})

// The clock is frozen (test/_clock.mjs) so the expected number is exact. Sampling a live clock
// here would let the old answer — the whole RL_WINDOW, sent whatever the window had left — pass at
// the one position in sixty where it happens to be right, and would race the window boundary.
test("account: the 429 names the seconds its window still has to run, not the whole window", async () => {
  // Swept across the window: the header that shipped was a constant, and a constant agrees with
  // the truth at one position in sixty. Each pass gets its own DB so the flood starts from zero.
  for (const elapsed of [0, 17, 59]) {
    const env = { DB: fakeDB(new Set(["lic-active"])) }
    const request = req({ license: "lic-active" }, { ip: "9.9.9.9" })
    const res = await atClock(WINDOW_START + elapsed * 1000, async () => {
      await spend(env, request, ACCOUNT_RL_LIMIT)
      return onRequestGet({ request, env })
    })
    assert.equal(res.status, 429)
    assert.equal(
      res.headers.get("retry-after"),
      String(RL_WINDOW - elapsed),
      `${elapsed}s into the window, the caller is told to wait longer than the refusal lasts`
    )
  }
})

test("account: the limit is far below the query endpoint's, since a secret is what is behind it", () => {
  assert.ok(
    ACCOUNT_RL_LIMIT < RL_LIMIT,
    `an endpoint that hands out admin_key must not run on the search allowance (${ACCOUNT_RL_LIMIT} vs ${RL_LIMIT})`
  )
})

// The point of placing the limiter first: the Polar round-trip and the D1 lookups are the cost it
// exists to bound, so a refused request must not have paid either of them.
test("account: a refused request costs no Polar round-trip and no license lookup", async () => {
  const f = stubFetch({ items: [{ key: "lic-active" }] })
  try {
    const env = { DB: fakeDB(new Set(["lic-active"])) }
    const request = req({ customer_session_token: "polar_cst_x" }, { ip: "9.9.9.9" })
    await spend(env, request, ACCOUNT_RL_LIMIT)
    const callsBefore = f.calls.length

    const res = await onRequestGet({ request, env })
    assert.equal(res.status, 429)
    assert.equal(f.calls.length, callsBefore, "the 429 still called out to Polar")
  } finally {
    f.restore()
  }
})

test("account: one IP being over the limit does not refuse another", async () => {
  const env = { DB: fakeDB(new Set(["lic-active"])) }
  const flooder = req({ license: "lic-active" }, { ip: "9.9.9.9" })
  await spend(env, flooder, ACCOUNT_RL_LIMIT + 1)
  assert.equal((await onRequestGet({ request: flooder, env })).status, 429)

  const other = req({ license: "lic-active" }, { ip: "8.8.8.8" })
  assert.equal((await onRequestGet({ request: other, env })).status, 200)
})

// Namespaced because query.js keys its own window on `<project id>:<ip>`. Without the prefix an
// account lookup and a search from one address would spend each other's allowance.
test("account: the window is keyed per IP under its own namespace", async () => {
  const db = fakeDB(new Set(["lic-active"]))
  await onRequestGet({ request: req({ license: "lic-active" }, { ip: "9.9.9.9" }), env: { DB: db } })
  assert.deepEqual(db.limiterKeys, ["acct:9.9.9.9"])
  assert.ok(!db.limiterKeys[0].startsWith("prj_"))
})

// A bare GET carries no credential and resolves nothing, but it still costs a D1 write — and a
// flood of them is exactly the flood being bounded, so it has to count.
test("account: a credential-less request is counted against the window too", async () => {
  const db = fakeDB()
  const env = { DB: db }
  const res = await spend(env, req({}, { ip: "7.7.7.7" }), ACCOUNT_RL_LIMIT + 1)
  assert.equal(res.status, 429, "unauthorized requests were not spending the window")
  assert.equal(db.limiterKeys.length, ACCOUNT_RL_LIMIT + 1)
})

// Fail-open, the way the limiter itself does: with no DB binding there is no counter, and the
// endpoint must still answer its ordinary 401 rather than refuse everyone.
test("account: no DB binding still answers 401, not 429", async () => {
  const res = await onRequestGet({ request: req({ license: "lic-active" }, { ip: "9.9.9.9" }), env: {} })
  assert.equal(res.status, 401)
})

// The guide's number, checked against the constant it describes.
//
// public/search-integration.md is the contract a customer (or the AI agent wiring this up for
// them) builds against, and §1 now tells them how many lookups they get. A limit documented as
// prose beside a constant in another tree is a limit that drifts: the number here would go on
// reading as true after the code moved, and the reader would find out from a 429 they were told
// would not come. Pinned the way test/pro-license-link.test.mjs pins the paywall's link — read the
// real file, find the real number — so either side moving alone fails this file.
//
// The window is pinned with it because the two are quoted together ("20 lookups / 60s"), and a
// limit without its window says nothing.
test("the integration guide's documented lookup limit is the one the code enforces", async () => {
  const { readFileSync } = await import("node:fs")
  // Whitespace collapsed first: the sentence is wrapped prose, so where the line breaks inside it
  // is a formatting choice and must not be what decides whether this check can read the number.
  const guide = readFileSync(
    new URL("../public/search-integration.md", import.meta.url),
    "utf8"
  ).replace(/\s+/g, " ")
  const m = guide.match(/\*\*(\d+) lookups \/ (\d+)s per IP\*\*/)
  assert.ok(m, "search-integration.md no longer states the account endpoint's rate limit")
  assert.equal(Number(m[1]), ACCOUNT_RL_LIMIT)
  assert.equal(Number(m[2]), RL_WINDOW)
})
