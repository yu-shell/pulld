// Handler-level tests for ingest's orphan-tail prune — the trickiest load-bearing logic in the
// search plumbing. Ingest always marks the chunk ids beyond a document's current length
// (parts.length .. MAX_CHUNKS_PER_DOC-1) for deletion, so when a document is re-indexed with fewer
// chunks than a previous, longer version, the now-unused higher-index chunks are removed. Without
// this, those orphaned vectors keep matching queries, contradicting the documented "re-sending the
// same id overwrites that document" contract (public/search-integration.md).
//
// The pure _lib helpers (chunk/vecId/json) are unit-tested in search-lib.test.mjs; this drives the
// real onRequestPost with a fake env (DB/AI/VEC) so the prune computation in ingest.js is itself
// covered. functions/ is excluded from tsconfig, so these tests are its only safety net. Chunk
// counts are derived from the real chunk() rather than hardcoded, so the assertions can't drift.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost } from "../functions/api/search/ingest.js"
import { chunk, MAX_CHUNKS_PER_DOC, vecId } from "../functions/api/search/_lib.js"

const PROJECT = "prj_test"

// Minimal fake of the Cloudflare bindings ingest touches: D1 (project lookup + usage bump), Workers
// AI (embeddings), and Vectorize (upsert/deleteByIds). Records the ids upserted and deleted so the
// prune contract can be asserted without a real Vectorize index.
function fakeEnv() {
  const upserted = []
  const deleted = []
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              // projectByKey: SELECT * FROM search_projects ... → an active project row.
              if (/FROM search_projects/.test(sql)) return { id: PROJECT, doc_limit: 5000 }
              // bumpUsage: SELECT <counter> AS n FROM search_usage ... → the running total.
              if (/FROM search_usage/.test(sql)) return { n: 1 }
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
    async upsert(vectors) {
      upserted.push(...vectors.map((v) => v.id))
    },
    async deleteByIds(ids) {
      deleted.push(...ids)
    },
  }
  return { env: { DB, AI, VEC }, upserted, deleted }
}

function request(documents, adminKey = "ak_test") {
  return {
    url: "https://pulld.pages.dev/api/search/ingest",
    headers: { get: (k) => (k === "x-pulld-admin-key" ? adminKey : null) },
    json: async () => ({ documents }),
  }
}

// ingest chunks `${title ?? ""}\n${content ?? ""}`; with no title this is what it splits on.
const chunkCount = (content) => chunk(`\n${content}`).length
const range = (from, to) => Array.from({ length: to - from }, (_, i) => vecId(PROJECT, "doc-1", from + i))

test("ingest: a document is upserted as chunks 0..n-1 and the unused tail n..MAX-1 is pruned", async () => {
  const content = "lorem ipsum ".repeat(300) // 5 chunks
  const n = chunkCount(content)
  assert.ok(n >= 2 && n < MAX_CHUNKS_PER_DOC, `fixture must be a multi-chunk, sub-cap doc (got ${n})`)

  const { env, upserted, deleted } = fakeEnv()
  const res = await onRequestPost({ request: request([{ id: "doc-1", content }]), env })

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json().then((b) => b.indexed_chunks), n)
  assert.deepEqual(upserted, range(0, n)) // wrote 0..n-1
  assert.deepEqual(new Set(deleted), new Set(range(n, MAX_CHUNKS_PER_DOC))) // pruned n..MAX-1
})

test("ingest: prune never targets a chunk id it just upserted", async () => {
  const { env, upserted, deleted } = fakeEnv()
  await onRequestPost({ request: request([{ id: "doc-1", content: "lorem ipsum ".repeat(300) }]), env })

  const wrote = new Set(upserted)
  for (const id of deleted) assert.ok(!wrote.has(id), `prune must not delete a just-upserted id: ${id}`)
})

test("ingest: a document longer than MAX chunks is capped and prunes nothing", async () => {
  const content = "a ".repeat(10000) // ~27 chunks, above the cap
  assert.ok(chunkCount(content) > MAX_CHUNKS_PER_DOC)

  const { env, upserted, deleted } = fakeEnv()
  const res = await onRequestPost({ request: request([{ id: "doc-1", content }]), env })

  assert.equal(res.status, 200)
  assert.equal(upserted.length, MAX_CHUNKS_PER_DOC)
  assert.deepEqual(upserted, range(0, MAX_CHUNKS_PER_DOC))
  assert.deepEqual(deleted, []) // no tail beyond the cap, so nothing to prune
})

test("ingest: empty-content document indexes nothing and deletes nothing (delete is a separate endpoint)", async () => {
  const { env, upserted, deleted } = fakeEnv()
  const res = await onRequestPost({ request: request([{ id: "doc-1", content: "" }]), env })

  assert.equal(res.status, 400) // "nothing to index"
  assert.deepEqual(upserted, [])
  assert.deepEqual(deleted, []) // removing a document must not be a side effect of empty ingest
})

test("ingest: same id twice in one request never prunes a chunk written by the other copy", async () => {
  const long = "lorem ipsum ".repeat(300) // 5 chunks
  const short = "alpha beta gamma" // 1 chunk
  const nLong = chunkCount(long)
  assert.ok(nLong > 1)

  const { env, upserted, deleted } = fakeEnv()
  await onRequestPost({
    request: request([
      { id: "doc-1", content: long },
      { id: "doc-1", content: short },
    ]),
    env,
  })

  // Union of both copies' chunks (0..nLong-1) is written; none of them may appear in the prune set,
  // even though the short copy marks 1..MAX-1 as its stale tail.
  const wrote = new Set(upserted)
  assert.deepEqual(wrote, new Set(range(0, nLong)))
  for (const id of deleted) assert.ok(!wrote.has(id), `must not prune a written id: ${id}`)
  assert.deepEqual(new Set(deleted), new Set(range(nLong, MAX_CHUNKS_PER_DOC)))
})
