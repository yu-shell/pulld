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
import { onRequestGet } from "../functions/api/search/account.js"

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
function fakeDB(activeLicenses = new Set()) {
  return {
    prepare(sql) {
      return {
        bind(license) {
          return {
            async first() {
              if (!activeLicenses.has(license)) return null
              // The licenseFromSession probe only needs a truthy row; the final lookup needs the
              // full project row. Distinguish by the columns each query selects.
              if (/SELECT 1 FROM search_projects/.test(sql)) return { 1: 1 }
              return ROW
            },
          }
        },
      }
    },
  }
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

function req(params = {}) {
  const u = new URL("https://pulld.pages.dev/api/search/account")
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v))
  return { url: u.toString(), headers: { get: () => null } }
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
