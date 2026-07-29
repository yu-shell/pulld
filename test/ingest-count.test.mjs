// Handler-level tests for what ingest *counts*. A request's `documents` array is not the same as
// the documents that got indexed: an entry with no `id`, or with no text in title+content, produces
// no chunks and is never written. Two things must therefore reflect the real work, not the request
// size:
//   - `indexed_docs` in the response (public/search-integration.md documents it as what was
//     indexed, and a caller with a broken field mapping would otherwise see `ok` and a full count
//     while search stays empty), and
//   - the monthly `docs` usage bump, which usage-alert.mjs turns into a doc-quota alert against the
//     customer's doc_limit — charging for content that was never indexed raises false alerts.
// The prune contract is covered separately in ingest-prune.test.mjs; both share _ingest-env.mjs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost } from "../functions/api/search/ingest.js"
import { fakeEnv, request } from "./_ingest-env.mjs"

const body = (res) => res.json()

test("ingest: a document with no id is skipped, not counted or charged", async () => {
  const { env, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([
      { id: "doc-1", content: "alpha beta gamma" },
      { title: "no id here", content: "delta epsilon" },
      { id: "", content: "empty id" },
    ]),
    env,
  })

  const b = await body(res)
  assert.equal(res.status, 200)
  assert.equal(b.indexed_docs, 1)
  assert.equal(b.skipped_docs, 2)
  // Charged for the one document actually indexed, not for all three entries sent.
  assert.deepEqual(docBumps, [1])
})

test("ingest: a document with no text is skipped, not counted or charged", async () => {
  const { env, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([
      { id: "doc-1", content: "alpha beta gamma" },
      { id: "doc-2", content: "" },
      { id: "doc-3", title: "   ", content: "\n\t " }, // whitespace only → no chunks
    ]),
    env,
  })

  const b = await body(res)
  assert.equal(b.indexed_docs, 1)
  assert.equal(b.skipped_docs, 2)
  assert.deepEqual(docBumps, [1])
})

test("ingest: the same id twice in one request is one document, counted once", async () => {
  const { env, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([
      { id: "doc-1", content: "first version" },
      { id: "doc-1", content: "second version overwrites it" },
    ]),
    env,
  })

  const b = await body(res)
  // Both copies write to the same vector id range, so this is one document — and a duplicate is not
  // a skipped document either: its content was indexed.
  assert.equal(b.indexed_docs, 1)
  assert.equal(b.skipped_docs, 0)
  assert.deepEqual(docBumps, [1])
})

test("ingest: an all-good request counts every document and skips none", async () => {
  const { env, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([
      { id: "doc-1", title: "One", content: "alpha beta gamma" },
      { id: "doc-2", title: "Two", content: "delta epsilon zeta" },
      { id: "doc-3", title: "Three", content: "eta theta iota" },
    ]),
    env,
  })

  const b = await body(res)
  assert.equal(b.indexed_docs, 3)
  assert.equal(b.skipped_docs, 0)
  assert.equal(b.indexed_chunks, 3)
  assert.deepEqual(docBumps, [3])
})

test("ingest: a title-only document still indexes (title is searchable text)", async () => {
  const { env, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([{ id: "doc-1", title: "Refund policy" }]),
    env,
  })

  const b = await body(res)
  assert.equal(b.indexed_docs, 1)
  assert.equal(b.skipped_docs, 0)
  assert.deepEqual(docBumps, [1])
})
