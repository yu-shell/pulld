// Handler-level tests for the Polar webhook (functions/api/polar-webhook.js), driving the real
// onRequestPost through a valid signature rather than testing verifySignature in isolation (that
// is test/webhook-signature.test.mjs).
//
// Why these exist: the REVOCATION path is the one branch that has never been exercised against
// real Polar traffic. Issuance was proven end-to-end with real purchases in June, but revoking
// requires actually refunding one, and Polar's signature can't be forged to simulate it. So the
// logic itself is pinned here instead: the right row must be deactivated, the wrong one must not,
// and a refunded Pro license must be terminal. A silent failure in this path means a customer
// keeps paid access after cancelling or refunding, which nothing else in the system would catch.
//
// Also covered: the product-id routing that decides Search vs Pro (a mismatch with
// POLAR_*_PRODUCT_IDS is the misconfiguration that would take a payment and issue nothing), the
// retryable 503 when the license key isn't granted yet, and the no-op logging that keeps an empty
// webhook_log from being ambiguous between "no sales" and "webhook never registered".
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost, hmacB64, secretCandidates } from "../functions/api/polar-webhook.js"

const SECRET = "polar_whs_test_secret"
const SEARCH_PRODUCT = "284512c9-search"
const PRO_PRODUCT = "6b4e677f-pro"
const SEARCH_BENEFIT = "ben_search"
const PRO_BENEFIT = "ben_pro"
const API = "https://api.polar.test"

// Records every statement the handler runs, so a test can assert on the SQL *and* its bindings.
// `failOn` makes writes to a chosen table throw, modelling a D1 outage on one statement.
function fakeDB({ failOn = null } = {}) {
  const calls = []
  return {
    calls,
    // Statements that touched a given table, ignoring the always-present webhook_log writes.
    forTable(t) {
      return calls.filter((c) => new RegExp(t, "i").test(c.sql))
    },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (failOn && new RegExp(failOn, "i").test(sql)) throw new Error("D1 down")
              calls.push({ sql, args })
              return { success: true }
            },
          }
        },
      }
    },
  }
}

// Models the two Polar API calls fetchLicenseKey makes: resolve the product's license_keys
// benefit, then list license keys filtered by that benefit. `keys` is what the list returns.
function stubFetch({ keys = [], productOk = true } = {}) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    const productMatch = u.match(/\/v1\/products\/([^?]+)$/)
    if (productMatch) {
      if (!productOk) return new Response("nope", { status: 404 })
      const benefit = productMatch[1] === SEARCH_PRODUCT ? SEARCH_BENEFIT : PRO_BENEFIT
      return Response.json({ benefits: [{ id: benefit, type: "license_keys" }] })
    }
    if (u.includes("/v1/license-keys/")) {
      const benefitId = new URL(u).searchParams.get("benefit_id")
      return Response.json({ items: keys.filter((k) => !benefitId || k.benefit_id === benefitId) })
    }
    return new Response("unexpected", { status: 500 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

function env(db, overrides = {}) {
  return {
    DB: db,
    POLAR_WEBHOOK_SECRET: SECRET,
    POLAR_ACCESS_TOKEN: "polar_at_test",
    POLAR_API_BASE: API,
    POLAR_ORG_ID: "org_test",
    POLAR_SEARCH_PRODUCT_IDS: SEARCH_PRODUCT,
    POLAR_PRO_PRODUCT_IDS: PRO_PRODUCT,
    ...overrides,
  }
}

// Signs exactly as Polar does, using the module's own primitives.
async function signedRequest(payload, { secret = SECRET } = {}) {
  const raw = JSON.stringify(payload)
  const id = "msg_test"
  const ts = String(Math.floor(Date.now() / 1000))
  const [keyBytes] = secretCandidates(secret)
  const sig = await hmacB64(keyBytes, `${id}.${ts}.${raw}`)
  return new Request("https://pulld.pages.dev/api/polar-webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${sig}`,
    },
    body: raw,
  })
}

const post = async (payload, e) => onRequestPost({ request: await signedRequest(payload), env: e })

test("subscription.revoked deactivates exactly the subscription named in the event", async () => {
  const db = fakeDB()
  const res = await post(
    {
      type: "subscription.revoked",
      data: { id: "sub_abc", product_id: SEARCH_PRODUCT, customer_id: "cus_1" },
    },
    env(db)
  )
  assert.equal(res.status, 200)
  const updates = db.forTable("search_projects")
  assert.equal(updates.length, 1, "one deactivation, not a blanket update")
  assert.match(updates[0].sql, /UPDATE search_projects SET active = 0 WHERE ls_subscription = \?/)
  assert.deepEqual(updates[0].args, ["sub_abc"], "matched on the subscription id, nothing else")
  // A revoked subscription must not also touch the one-time Pro licenses table.
  assert.equal(db.forTable("FROM licenses|UPDATE licenses").length, 0)
})

test("subscription.canceled does NOT deactivate — access lasts until the period ends", async () => {
  // Polar sends `canceled` at cancel-at-period-end and `revoked` when it actually lapses. Acting
  // on `canceled` would cut off a customer who has already paid for the rest of the period.
  const db = fakeDB()
  const res = await post(
    {
      type: "subscription.canceled",
      data: { id: "sub_abc", product_id: SEARCH_PRODUCT, customer_id: "cus_1" },
    },
    env(db)
  )
  assert.equal(res.status, 200)
  assert.equal(db.forTable("search_projects").length, 0)
})

test("order.refunded on a Pro purchase marks that license refunded (terminal)", async () => {
  const db = fakeDB()
  const f = stubFetch({
    keys: [{ key: "PRO-KEY-1", customer_id: "cus_1", benefit_id: PRO_BENEFIT }],
  })
  try {
    const res = await post(
      {
        type: "order.refunded",
        data: { product_id: PRO_PRODUCT, customer_id: "cus_1" },
      },
      env(db)
    )
    assert.equal(res.status, 200)
    const updates = db.forTable("UPDATE licenses")
    assert.equal(updates.length, 1)
    assert.match(updates[0].sql, /SET active = 0, status = 'refunded' WHERE key = \?/)
    assert.deepEqual(updates[0].args, ["PRO-KEY-1"])
  } finally {
    f.restore()
  }
})

test("a customer who owns both products never gets the other product's key", async () => {
  // The June cross-product bug: an unfiltered lookup returned the first key the customer held,
  // so a Search key could be written as the Pro license. The benefit filter is what prevents it.
  const db = fakeDB()
  const f = stubFetch({
    keys: [
      { key: "SEARCH-KEY", customer_id: "cus_1", benefit_id: SEARCH_BENEFIT },
      { key: "PRO-KEY-1", customer_id: "cus_1", benefit_id: PRO_BENEFIT },
    ],
  })
  try {
    await post({ type: "order.paid", data: { product_id: PRO_PRODUCT, customer_id: "cus_1" } }, env(db))
    const inserts = db.forTable("INSERT INTO licenses")
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0].args[0], "PRO-KEY-1", "the Pro benefit's key, not the Search one")
  } finally {
    f.restore()
  }
})

test("order.paid on the Search product provisions a project with that customer's key", async () => {
  const db = fakeDB()
  const f = stubFetch({
    keys: [{ key: "SEARCH-KEY", customer_id: "cus_1", benefit_id: SEARCH_BENEFIT }],
  })
  try {
    const res = await post(
      {
        type: "order.paid",
        data: {
          product_id: SEARCH_PRODUCT,
          customer_id: "cus_1",
          customer: { email: "buyer@example.com" },
          subscription_id: "sub_abc",
        },
      },
      env(db)
    )
    assert.equal(res.status, 200)
    const inserts = db.forTable("INSERT INTO search_projects")
    assert.equal(inserts.length, 1)
    const [projId, adminKey, queryKey, email, license, subId] = inserts[0].args
    assert.match(projId, /^prj_/)
    assert.match(adminKey, /^ak_/)
    assert.match(queryKey, /^pk_/)
    assert.equal(email, "buyer@example.com")
    assert.equal(license, "SEARCH-KEY")
    assert.equal(subId, "sub_abc")
  } finally {
    f.restore()
  }
})

test("a paid order whose product matches neither id list is logged loudly, not issued", async () => {
  // This is what a POLAR_*_PRODUCT_IDS mismatch looks like: money taken, nothing provisioned.
  const db = fakeDB()
  const res = await post(
    { type: "order.paid", data: { product_id: "prod_unknown", customer_id: "cus_1" } },
    env(db)
  )
  assert.equal(res.status, 200)
  assert.equal(db.forTable("INSERT INTO search_projects").length, 0)
  assert.equal(db.forTable("INSERT INTO licenses").length, 0)
  const log = db.forTable("webhook_log").at(-1)
  assert.equal(log.args[2], 0, "recorded as not-ok so it shows up as a failure")
  assert.match(log.args[3], /unrecognized product prod_unknown/)
})

test("an unissued license key yields a retryable 503, never a silent success", async () => {
  const db = fakeDB()
  const f = stubFetch({ keys: [] }) // benefit resolves, but no key granted yet
  try {
    const res = await post(
      { type: "subscription.created", data: { id: "sub_abc", product_id: SEARCH_PRODUCT, customer_id: "cus_1" } },
      env(db)
    )
    assert.equal(res.status, 503, "Polar redelivers, so the customer is provisioned on retry")
    assert.equal(db.forTable("INSERT INTO search_projects").length, 0)
  } finally {
    f.restore()
  }
})

test("an unresolvable product benefit fails closed rather than picking an arbitrary key", async () => {
  const db = fakeDB()
  const f = stubFetch({
    productOk: false, // benefit lookup fails
    keys: [{ key: "SOME-OTHER-KEY", customer_id: "cus_1", benefit_id: SEARCH_BENEFIT }],
  })
  try {
    const res = await post(
      { type: "order.paid", data: { product_id: PRO_PRODUCT, customer_id: "cus_1" } },
      env(db)
    )
    assert.equal(res.status, 503)
    assert.equal(db.forTable("INSERT INTO licenses").length, 0)
  } finally {
    f.restore()
  }
})

test("an event the handler does not act on still leaves a row in the log", async () => {
  // An empty webhook_log used to be ambiguous: no sales yet, or no webhook registered in Polar?
  const db = fakeDB()
  const res = await post({ type: "checkout.created", data: { id: "chk_1" } }, env(db))
  assert.equal(res.status, 200)
  const log = db.forTable("webhook_log").at(-1)
  assert.equal(log.args[1], "polar:checkout.created")
  assert.equal(log.args[2], 1)
  assert.equal(log.args[3], "no-op")
})

test("a renewal records why it did nothing, so it cannot be mistaken for a dropped sale", async () => {
  // An order.paid that provisions nothing is either a harmless renewal or a purchase we failed to
  // act on. The log has to say which — a bare "no-op" left an August 2026 renewal indistinguishable
  // from a silently dropped sale, and only the note can tell them apart after the fact.
  const db = fakeDB()
  const res = await post(
    {
      type: "order.paid",
      data: { product_id: SEARCH_PRODUCT, customer_id: "cus_1", billing_reason: "subscription_cycle" },
    },
    env(db)
  )
  assert.equal(res.status, 200)
  assert.equal(db.forTable("INSERT INTO search_projects").length, 0, "a renewal must not re-provision")
  const note = db.forTable("webhook_log").at(-1).args[3]
  assert.match(note, /reason=subscription_cycle/)
  assert.match(note, new RegExp("product=" + SEARCH_PRODUCT))
  assert.match(note, /ours=true/, "the product was one of ours — the no-op was deliberate")
})

test("a no-op subscription event records the subscription it was about", async () => {
  const db = fakeDB()
  await post({ type: "subscription.updated", data: { id: "sub_abc", product_id: SEARCH_PRODUCT } }, env(db))
  assert.match(db.forTable("webhook_log").at(-1).args[3], /no-op sub=sub_abc/)
})

test("a D1 failure on a state-changing event returns 500 so Polar retries", async () => {
  const db = fakeDB({ failOn: "UPDATE search_projects" })
  const res = await post(
    { type: "subscription.revoked", data: { id: "sub_abc", product_id: SEARCH_PRODUCT, customer_id: "cus_1" } },
    env(db)
  )
  assert.equal(res.status, 500, "a dropped revocation would leave paid access alive")
})

test("the gate itself: no secret is 503, a bad signature is 401, bad JSON is 400", async () => {
  const db = fakeDB()
  const noSecret = await onRequestPost({
    request: await signedRequest({ type: "order.paid" }),
    env: env(db, { POLAR_WEBHOOK_SECRET: undefined }),
  })
  assert.equal(noSecret.status, 503)

  const wrongKey = await onRequestPost({
    request: await signedRequest({ type: "order.paid" }, { secret: "not-the-secret" }),
    env: env(db),
  })
  assert.equal(wrongKey.status, 401)

  // Signed correctly, but the body isn't JSON.
  const raw = "{not json"
  const id = "msg_test"
  const ts = String(Math.floor(Date.now() / 1000))
  const [keyBytes] = secretCandidates(SECRET)
  const sig = await hmacB64(keyBytes, `${id}.${ts}.${raw}`)
  const badJson = await onRequestPost({
    request: new Request("https://pulld.pages.dev/api/polar-webhook", {
      method: "POST",
      headers: {
        "webhook-id": id,
        "webhook-timestamp": ts,
        "webhook-signature": `v1,${sig}`,
      },
      body: raw,
    }),
    env: env(db),
  })
  assert.equal(badJson.status, 400)
})
