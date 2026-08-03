// Handler-level tests for the monthly document quota on ingest.
//
// `search_projects.doc_limit` is a real commitment: it is defaulted in db/schema.sql, set to 5,000
// when a Pro project is provisioned, alerted on at 80% by usage-alert.mjs, and published in
// public/search-integration.md. It was nonetheless never enforced — ingest metered the `docs`
// counter and reported it back, but accepted every request regardless of the total, so a runaway
// indexer could spend unbounded Workers AI and Vectorize budget while the alert only narrated it.
//
// The check must run BEFORE embed/upsert (that spend is what it bounds), which is what separates it
// from the query quota's bump-then-compare: a rejected request must leave the index and the meter
// untouched. These tests assert both halves — the refusal, and that nothing was written or charged.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost } from "../functions/api/search/ingest.js"
import { fakeEnv, request } from "./_ingest-env.mjs"

const docs = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `doc-${i}`, content: `alpha beta ${i}` }))

test("ingest: a request that would exceed doc_limit is refused with 429", async () => {
  const { env, upserted, docBumps } = fakeEnv({ docLimit: 10, docsUsed: 8 })
  const res = await onRequestPost({ request: request(docs(3)), env }) // 8 + 3 > 10

  const b = await res.json()
  assert.equal(res.status, 429)
  assert.equal(b.error, "quota_exceeded")
  assert.equal(b.docs_this_month, 8)
  assert.equal(b.doc_limit, 10)
  // Refused before the expensive work: nothing indexed, and the customer is not charged for it.
  assert.deepEqual(upserted, [])
  assert.deepEqual(docBumps, [])
})

test("ingest: a request that exactly fills the quota is accepted", async () => {
  const { env, docBumps } = fakeEnv({ docLimit: 10, docsUsed: 8 })
  const res = await onRequestPost({ request: request(docs(2)), env }) // 8 + 2 == 10

  const b = await res.json()
  assert.equal(res.status, 200)
  assert.equal(b.indexed_docs, 2)
  assert.deepEqual(docBumps, [2])
})

test("ingest: only documents that will actually be indexed count toward the quota", async () => {
  // Skipped entries (no id, no text) are not charged by the meter, so they must not be counted by
  // the check either — otherwise a request well within the plan is refused for content it drops.
  const { env, docBumps } = fakeEnv({ docLimit: 10, docsUsed: 9 })
  const res = await onRequestPost({
    request: request([
      { id: "doc-1", content: "alpha beta gamma" },
      { title: "no id here", content: "delta" },
      { id: "doc-2", content: "   " },
    ]),
    env,
  })

  const b = await res.json()
  assert.equal(res.status, 200)
  assert.equal(b.indexed_docs, 1)
  assert.equal(b.skipped_docs, 2)
  assert.deepEqual(docBumps, [1])
})

test("ingest: an already-exhausted quota refuses even a single document", async () => {
  const { env, upserted } = fakeEnv({ docLimit: 10, docsUsed: 10 })
  const res = await onRequestPost({ request: request(docs(1)), env })

  assert.equal(res.status, 429)
  assert.deepEqual(upserted, [])
})

test("ingest: a NULL doc_limit falls back to the schema default, like q_limit does", async () => {
  // db/schema.sql defaults doc_limit to 200, so a NULL column is a free-tier project, not an
  // unlimited one — the same reading query.js gives a NULL q_limit.
  const { env, upserted } = fakeEnv({ docLimit: null, docsUsed: 200 })
  const res = await onRequestPost({ request: request(docs(1)), env })

  assert.equal(res.status, 429)
  assert.deepEqual(upserted, [])
})

test("ingest: a non-numeric doc_limit fails open rather than blocking a paying customer", async () => {
  const { env, docBumps } = fakeEnv({ docLimit: "unlimited", docsUsed: 100000 })
  const res = await onRequestPost({ request: request(docs(2)), env })

  assert.equal(res.status, 200)
  assert.deepEqual(docBumps, [2])
})
