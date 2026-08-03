// Shared fake Cloudflare bindings for the ingest handler tests. Not a test file itself (the `_`
// prefix keeps it out of the `test/**/*.test.mjs` glob) — it exists so the prune tests and the
// count tests drive the real onRequestPost against one fake instead of two drifting copies.
//
// Fakes the three bindings ingest touches: D1 (project lookup + usage bump), Workers AI
// (embeddings) and Vectorize (upsert/deleteByIds). Records the vector ids upserted and deleted, and
// the amount passed to the monthly `docs` usage bump, so both contracts can be asserted without a
// real index.

export const PROJECT = "prj_test"

// `docLimit` is the project's monthly doc quota and `docsUsed` the running `docs` total the usage
// table reports; the defaults keep a normal request far under the limit, so quota enforcement is
// invisible to the tests that aren't about it. Override them to drive the quota path.
export function fakeEnv({ docLimit = 5000, docsUsed = 1 } = {}) {
  const upserted = []
  const deleted = []
  // Amounts added to the month's `docs` counter, in call order (bumpUsage binds `by` twice: once
  // for the INSERT and once for the ON CONFLICT increment).
  const docBumps = []
  const DB = {
    prepare(sql) {
      return {
        bind(...args) {
          if (/INSERT INTO search_usage/.test(sql) && /docs/.test(sql)) docBumps.push(args[2])
          return {
            async first() {
              // projectByKey: SELECT * FROM search_projects ... → an active project row.
              if (/FROM search_projects/.test(sql)) return { id: PROJECT, doc_limit: docLimit }
              // The `docs` usage total, read both by the pre-ingest quota check and by bumpUsage.
              if (/FROM search_usage/.test(sql)) return { n: docsUsed }
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
  return { env: { DB, AI, VEC }, upserted, deleted, docBumps }
}

export function request(documents, adminKey = "ak_test") {
  return {
    url: "https://pulld.pages.dev/api/search/ingest",
    headers: { get: (k) => (k === "x-pulld-admin-key" ? adminKey : null) },
    json: async () => ({ documents }),
  }
}
