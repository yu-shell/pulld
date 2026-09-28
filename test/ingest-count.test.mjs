// Handler-level tests for what ingest *counts*. A request's `documents` array is not the same as
// the documents that got indexed: an entry with no `id`, or with no text in title+content, produces
// no chunks and is never written. Two things must therefore reflect the real work, not the request
// size:
//   - `indexed_docs` in the response (public/search-integration.md documents it as what was
//     indexed, and a caller with a broken field mapping would otherwise see `ok` and a full count
//     while search stays empty), and
//   - the monthly `docs` usage bump, which usage-alert.mjs turns into a doc-quota alert against the
//     customer's doc_limit — charging for content that was never indexed raises false alerts, and
//   - `truncated_docs` / `truncated_ids`, which say when a document was indexed only in part. A
//     document is counted once in `indexed_docs` whether all of it or a fifth of it was stored, so
//     that count alone cannot distinguish the two — which is how a 40,000-character article came
//     back as `ok, indexed_docs: 1, skipped_docs: 0` with 62% of it never indexed.
// And because that meter is per month rather than per document held, its shape is pinned here too:
// re-sending a document costs again, which is the fact the plan copy, /account and the 429 message
// are all written around.
// The prune contract is covered separately in ingest-prune.test.mjs; both share _ingest-env.mjs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost } from "../functions/api/search/ingest.js"
import { MAX_CHUNKS_PER_DOC } from "../functions/api/search/_lib.js"
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

test("ingest: re-indexing the same id in a later request is charged again", async () => {
  // The `docs` meter is a flow, not a stock. Nothing anywhere records which ids a project already
  // holds — `search_usage` has one integer per (project, month) — so a second ingest of an
  // unchanged document is a second charge. That is the opposite of what its own name suggested
  // everywhere it was read: "5,000 indexed docs" on the plan, "5000 docs" on /account, "N indexed"
  // in the usage alert, all of which describe the size of an index rather than a monthly spend.
  //
  // It is pinned here because the guide now states the rule in customer-facing terms, and the
  // build-time sync recipe it recommends re-sends the entire catalogue on every deploy — the one
  // pattern this billing shape punishes. If the meter is ever changed to charge per distinct
  // document, this test fails, and the guide, the 429 message and /account have to change with it.
  const { env, docBumps } = fakeEnv()
  const doc = [{ id: "doc-1", title: "Refund policy", content: "alpha beta gamma" }]

  const first = await onRequestPost({ request: request(doc), env })
  const second = await onRequestPost({ request: request(doc), env })

  assert.equal((await body(first)).indexed_docs, 1)
  assert.equal((await body(second)).indexed_docs, 1)
  // Two sends of one document, charged twice — contrast the same-id-twice-in-one-request case
  // above, which is a single overwrite and charged once.
  assert.deepEqual(docBumps, [1, 1])
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

// --- what was indexed *of* each document, not just how many were ---

// The per-document chunk cap is the one limit in this handler that used to cost the caller content
// instead of a retry, and the only one that said nothing when it bit. Sized off the real chunker
// rather than a guessed character count: `chunk()` steps 750 characters at a time with a 900-wide
// window, so MAX_CHUNKS_PER_DOC chunks hold the first 15,150 characters and anything past that is
// dropped. Built here from MAX_CHUNKS_PER_DOC so a change to the cap moves the test with it.
const CHUNK_STEP = 750
const longText = (chunks) => "refund ".repeat(Math.ceil((chunks * CHUNK_STEP) / 7))

test("ingest: a document past the per-doc chunk cap is reported as truncated", async () => {
  const { env, upserted, docBumps } = fakeEnv()
  const res = await onRequestPost({
    request: request([
      { id: "long-article", title: "Refund policy", content: longText(MAX_CHUNKS_PER_DOC + 10) },
      { id: "short", title: "Fees", content: "alpha beta gamma" },
    ]),
    env,
  })

  const b = await body(res)
  assert.equal(res.status, 200)
  // Still a success, and still both documents: what was indexed of the long one is real and
  // searchable, so refusing the request would be the worse answer.
  assert.equal(b.indexed_docs, 2)
  assert.equal(b.skipped_docs, 0)
  assert.deepEqual(docBumps, [2])
  // The part that was missing: which document lost content, and how many did.
  assert.equal(b.truncated_docs, 1)
  assert.deepEqual(b.truncated_ids, ["long-article"])
  // The cap is unchanged — exactly MAX_CHUNKS_PER_DOC vectors for the long doc, one for the short.
  assert.equal(b.indexed_chunks, MAX_CHUNKS_PER_DOC + 1)
  assert.equal(upserted.filter((id) => id.includes(":long-article:")).length, MAX_CHUNKS_PER_DOC)
})

test("ingest: a document that fits the cap is not reported as truncated", async () => {
  const { env } = fakeEnv()
  const res = await onRequestPost({
    request: request([{ id: "doc-1", title: "Refund policy", content: "alpha beta gamma" }]),
    env,
  })

  const b = await body(res)
  // Present and zero rather than absent: a caller that has to test for the field's existence
  // before reading it is a caller who reads a missing field as "nothing was truncated" — which is
  // also what an older deployment answers, and the two must not look the same.
  assert.equal(b.truncated_docs, 0)
  assert.deepEqual(b.truncated_ids, [])
})

test("ingest: the same long id twice in one request is reported once", async () => {
  const { env, docBumps } = fakeEnv()
  const content = longText(MAX_CHUNKS_PER_DOC + 10)
  const res = await onRequestPost({
    request: request([
      { id: "long-article", title: "Refund policy", content },
      { id: "long-article", title: "Refund policy", content },
    ]),
    env,
  })

  const b = await body(res)
  // One document, one charge, one report — the rule indexed_docs already follows.
  assert.equal(b.indexed_docs, 1)
  assert.deepEqual(docBumps, [1])
  assert.equal(b.truncated_docs, 1)
  assert.deepEqual(b.truncated_ids, ["long-article"])
})

test("ingest: the reported id list is capped but the count is not", async () => {
  const { env } = fakeEnv()
  const content = longText(MAX_CHUNKS_PER_DOC + 10)
  // Twelve long documents — two more than the response names. The count has to stay honest when
  // the list stops, because "10 truncated" and "12 truncated, here are 10 of them" are different
  // sizes of problem and a caller acting on the list alone would fix ten of twelve and believe it
  // was done.
  const docs = Array.from({ length: 12 }, (_, i) => ({ id: `doc-${i}`, content }))
  const res = await onRequestPost({ request: request(docs), env })

  const b = await body(res)
  assert.equal(res.status, 200)
  assert.equal(b.indexed_docs, 12)
  assert.equal(b.truncated_docs, 12)
  assert.equal(b.truncated_ids.length, 10)
  // The first ten, in the order they were sent, so a caller can page through the rest by fixing
  // these and re-sending.
  assert.deepEqual(b.truncated_ids, docs.slice(0, 10).map((d) => d.id))
})
