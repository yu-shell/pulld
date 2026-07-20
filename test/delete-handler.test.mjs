// Handler-level tests for the search delete endpoint (functions/api/search/delete.js) — the only
// destructive search handler (it removes a project's indexed vectors) and, until now, the last one
// with no automated coverage. functions/ is excluded from tsconfig, so `node --test` is its only
// safety net.
//
// The load-bearing behavior covered here:
//   - the id→vector-id contract: each document id expands to the full `<project>:<id>:<0..MAX-1>`
//     range, the same range ingest can write, so a delete removes every chunk a doc could have left
//     behind. search-lib.test.mjs pins this at the vecId() level; this drives the real handler that
//     reconstructs the range, so the two can't silently drift.
//   - batching: vector ids are removed in chunks of at most DELETE_BATCH, so a full-size request
//     (100 docs × MAX_CHUNKS_PER_DOC vectors) can't exceed Vectorize's per-call id cap.
//   - the auth (401), config (503), and input guards (bad json / no ids / >100 ids / all-empty),
//     and that a Vectorize failure surfaces as 502 rather than a false `{ ok: true }`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestPost } from "../functions/api/search/delete.js"
import { MAX_CHUNKS_PER_DOC, vecId } from "../functions/api/search/_lib.js"

const PROJECT = "prj_test"

// Minimal fake of the bindings delete touches: D1 (projectByKey lookup) and Vectorize
// (deleteByIds). `deletedBatches` records each deleteByIds call's id array so the id-range contract
// and the batching can be asserted without a real Vectorize index.
function fakeEnv({ authed = true, deleteThrows = false } = {}) {
  const deletedBatches = []
  const DB = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              // projectByKey: SELECT * FROM search_projects WHERE admin_key = ? AND active = 1
              if (/FROM search_projects/.test(sql)) return authed ? { id: PROJECT } : null
              return null
            },
            async run() {},
          }
        },
      }
    },
  }
  const VEC = {
    async deleteByIds(ids) {
      if (deleteThrows) throw new Error("vectorize down")
      deletedBatches.push(ids)
    },
  }
  return { env: { DB, VEC }, deletedBatches }
}

function request(ids, { adminKey = "ak_test", badJson = false } = {}) {
  return {
    url: "https://pulld.pages.dev/api/search/delete",
    headers: { get: (k) => (k === "x-pulld-admin-key" ? adminKey : null) },
    json: async () => {
      if (badJson) throw new Error("bad json")
      return { ids }
    },
  }
}

// The full chunk-id range a single document id expands to on delete.
const rangeFor = (docId) =>
  Array.from({ length: MAX_CHUNKS_PER_DOC }, (_, ci) => vecId(PROJECT, docId, ci))

test("delete: removes the full 0..MAX-1 chunk range for each id and reports deleted_docs", async () => {
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(["doc-1", "doc-2"]), env })

  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, deleted_docs: 2 })

  const deleted = deletedBatches.flat()
  const expected = [...rangeFor("doc-1"), ...rangeFor("doc-2")]
  assert.deepEqual(new Set(deleted), new Set(expected))
  assert.equal(deleted.length, 2 * MAX_CHUNKS_PER_DOC) // no duplicate / missing ids
})

test("delete: empty/nullish ids are skipped; an all-empty list is rejected as no valid ids", async () => {
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(["", null, undefined]), env })

  assert.equal(res.status, 400)
  assert.equal(await res.json().then((b) => b.error), "no valid ids")
  assert.equal(deletedBatches.length, 0) // nothing removed
})

test("delete: a mix of empty and real ids only counts the real ones", async () => {
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(["", "doc-1"]), env })

  assert.equal(res.status, 200)
  assert.equal(await res.json().then((b) => b.deleted_docs), 1)
  assert.deepEqual(new Set(deletedBatches.flat()), new Set(rangeFor("doc-1")))
})

test("delete: vector ids are removed in batches of at most DELETE_BATCH (1000)", async () => {
  // 60 docs × MAX_CHUNKS_PER_DOC (20) = 1200 vector ids → two deleteByIds calls (1000 + 200).
  const ids = Array.from({ length: 60 }, (_, i) => `doc-${i}`)
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(ids), env })

  assert.equal(res.status, 200)
  assert.equal(await res.json().then((b) => b.deleted_docs), 60)
  assert.equal(deletedBatches.length, 2)
  assert.ok(deletedBatches.every((b) => b.length <= 1000), "no batch exceeds DELETE_BATCH")
  assert.equal(deletedBatches.flat().length, 60 * MAX_CHUNKS_PER_DOC)
})

test("delete: an unknown admin key is unauthorized", async () => {
  const { env, deletedBatches } = fakeEnv({ authed: false })
  const res = await onRequestPost({ request: request(["doc-1"]), env })

  assert.equal(res.status, 401)
  assert.equal(deletedBatches.length, 0)
})

test("delete: search not configured (no Vectorize binding) returns 503", async () => {
  const { env } = fakeEnv()
  delete env.VEC
  const res = await onRequestPost({ request: request(["doc-1"]), env })

  assert.equal(res.status, 503)
  assert.equal(await res.json().then((b) => b.error), "search not configured")
})

test("delete: malformed JSON body returns 400", async () => {
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(["doc-1"], { badJson: true }), env })

  assert.equal(res.status, 400)
  assert.equal(await res.json().then((b) => b.error), "bad json")
  assert.equal(deletedBatches.length, 0)
})

test("delete: an empty id list returns 400", async () => {
  const { env } = fakeEnv()
  const res = await onRequestPost({ request: request([]), env })

  assert.equal(res.status, 400)
  assert.equal(await res.json().then((b) => b.error), "no ids")
})

test("delete: more than 100 ids per request is rejected before any delete", async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `doc-${i}`)
  const { env, deletedBatches } = fakeEnv()
  const res = await onRequestPost({ request: request(ids), env })

  assert.equal(res.status, 400)
  assert.match(await res.json().then((b) => b.error), /max 100 ids/)
  assert.equal(deletedBatches.length, 0)
})

test("delete: a Vectorize failure surfaces as 502 rather than a false success", async () => {
  const { env } = fakeEnv({ deleteThrows: true })
  const res = await onRequestPost({ request: request(["doc-1"]), env })

  assert.equal(res.status, 502)
  assert.equal(await res.json().then((b) => b.error), "delete failed")
})
