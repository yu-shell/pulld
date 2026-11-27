// Every number public/search-integration.md quotes, checked against the code that enforces it.
//
// That guide is the contract a paying customer — or the AI coding agent wiring pulld Search up for
// them — builds against, and it is prose in public/ describing constants in functions/. Nothing
// but a reader connects the two, so a limit that moves in one tree goes on reading as true in the
// other, and the customer finds out from a 429 the guide promised would not come, from content the
// guide said was indexed, or from a plan that turned out smaller than the one they bought.
//
// One of these numbers was already pinned this way — the account endpoint's "20 lookups / 60s per
// IP", in test/account-handler.test.mjs, where the limiter it describes is tested. That check
// explains the reasoning in full; this file is the rest of the guide, which had none. Collected
// here rather than scattered across the four handlers because the guide is one artifact: a reader
// asking "what holds the guide honest?" should find one answer, and a number added to the guide
// with no pin should be conspicuous by its absence from this file.
//
// Each check asserts the regex matched before comparing, so rewording the sentence out from under
// the number fails here instead of quietly pinning nothing. Whitespace is collapsed first: the
// guide is wrapped prose, and where a line happens to break inside a sentence must not decide
// whether the number can be read.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

import { RL_LIMIT, RL_WINDOW, MAX_CHUNKS_PER_DOC, chunk } from "../functions/api/search/_lib.js"
import { clampLimit, DEFAULT_LIMIT } from "../functions/api/search/query.js"
import {
  onRequestPost,
  MAX_DOCS_PER_REQUEST,
  MAX_CHUNKS_PER_REQUEST,
  MAX_REPORTED_IDS,
} from "../functions/api/search/ingest.js"
import { MAX_IDS_PER_REQUEST } from "../functions/api/search/delete.js"
import { PRO_Q_LIMIT, PRO_DOC_LIMIT } from "../functions/api/polar-webhook.js"
import { fakeEnv, request } from "./_ingest-env.mjs"

const GUIDE_RAW = readFileSync(
  new URL("../public/search-integration.md", import.meta.url),
  "utf8"
)
const GUIDE = GUIDE_RAW.replace(/\s+/g, " ")

// The guide's one runnable script, step 4A's fenced block — the only thing in the file a reader
// does not have to translate before using, and what an agent wiring this up copies verbatim into
// CI. Taken unwrapped, since collapsing whitespace is what makes the prose readable above and
// would make this unreadable. Anchored on the script's own filename line rather than on "the
// first ```ts", which already has a near-miss in the file (step 2's block opens ```tsx).
const RECIPE = (() => {
  const m = GUIDE_RAW.match(/```ts\n(\/\/ scripts\/index-content\.ts[\s\S]*?)```/)
  assert.ok(m, "search-integration.md no longer carries step 4A's scripts/index-content.ts block")
  return m[1]
})()

// The same script with its comment lines removed. The assertions below ask whether the script
// *reads* a field, and an identifier is spelled in the prose around it as well as in the code —
// matching the whole block would be satisfied by a comment that names a counter the code ignores,
// which is the exact failure this section exists to prevent. Found by deleting each read in turn
// and watching the check stay green.
const RECIPE_CODE = RECIPE.replace(/^\s*\/\/.*$/gm, "")

/**
 * The largest document, in characters, that still fits `chunks` chunks. Derived the way a caller
 * would experience it — grow a body until one more character would need a chunk past the budget
 * — rather than from chunk()'s size and overlap, which are default parameters. chunk() is
 * monotonic in input length, so the doubling-down search lands on the exact capacity.
 */
function capacityFor(chunks) {
  let capacity = 0
  for (let step = 1 << 15; step >= 1; step >>= 1) {
    while (chunk("x".repeat(capacity + step)).length <= chunks) capacity += step
  }
  return capacity
}

// The numbers one sentence of the guide states, as numbers. `what` names the claim so a failure
// says which sentence stopped matching rather than only that a regex did not.
function quoted(what, re) {
  const m = GUIDE.match(re)
  assert.ok(m, `search-integration.md no longer states ${what} in the form this check reads`)
  // Thousands separators are the guide's, not the code's: "50,000" and 50000 are the same number.
  return m.slice(1).map((g) => Number(String(g).replace(/,/g, "")))
}

test("the guide's query `limit` default and range are the ones clampLimit applies", () => {
  const [dflt, min, max] = quoted(
    "the `limit` default and range",
    /Default \*\*(\d+)\*\*, range \*\*(\d+)–(\d+)\*\*/
  )
  assert.equal(dflt, DEFAULT_LIMIT)
  // The bounds are read out of clampLimit rather than off a constant of their own. A request far
  // outside the range is clamped to the edge, which is the guide's own promise ("A value outside
  // that range is clamped rather than rejected") — so the edges it lands on *are* the documented
  // range, and asking the function is a stronger check than comparing two spellings of a literal.
  assert.equal(clampLimit(-1e9, DEFAULT_LIMIT), min)
  assert.equal(clampLimit(1e9, DEFAULT_LIMIT), max)
})

test("the guide's query burst limit is the one the limiter enforces", () => {
  const [limit, window] = quoted(
    "the query endpoint's burst limit",
    /Rate-limited to (\d+) requests \/ (\d+)s per `query_key` \+ IP/
  )
  assert.equal(limit, RL_LIMIT)
  // Quoted together, and a limit without its window says nothing — the same pairing as the
  // account endpoint's "20 lookups / 60s".
  assert.equal(window, RL_WINDOW)
})

test("the guide's ingest caps are the ones ingest refuses on", () => {
  const [docs, perDoc, perRequest] = quoted(
    "the ingest per-request and per-document caps",
    /Up to \*\*(\d+) documents per request\*\* \(each doc is chunked: ≤(\d+) chunks\/doc, ≤(\d+) chunks\/request\)/
  )
  assert.equal(docs, MAX_DOCS_PER_REQUEST)
  assert.equal(perDoc, MAX_CHUNKS_PER_DOC)
  assert.equal(perRequest, MAX_CHUNKS_PER_REQUEST)
})

test("the guide's truncation threshold matches what a document is actually indexed up to", () => {
  const [chunks, characters] = quoted(
    "the per-document truncation threshold",
    /A document longer than (\d+) chunks \(~([\d,]+) characters of text\)/
  )
  assert.equal(chunks, MAX_CHUNKS_PER_DOC)

  // The character figure is the one number in the guide that is nobody's constant: it is what
  // MAX_CHUNKS_PER_DOC comes to once chunk()'s size and overlap are applied (see capacityFor).
  const capacity = capacityFor(MAX_CHUNKS_PER_DOC)

  // Two directions, because both are a lie to the customer. Over-stating it tells them content is
  // searchable that was dropped; under-stating it tells them to split documents that did not need
  // it. The guide writes "~", so the slack is deliberate — but 5% of it, not an unbounded tilde.
  assert.ok(
    characters <= capacity,
    `the guide promises ${characters} characters are indexed; only ${capacity} are`
  )
  assert.ok(
    capacity - characters <= capacity * 0.05,
    `the guide under-states the indexed length: ${characters} characters against ${capacity}`
  )
})

test("the guide's count of named truncated ids is the number ingest returns", () => {
  const [reported] = quoted(
    "how many truncated ids the ingest response names",
    /\(which ones, up to (\d+) of them\)/
  )
  assert.equal(reported, MAX_REPORTED_IDS)
})

test("the guide's delete cap is the one delete refuses on", () => {
  const [ids] = quoted("the delete endpoint's per-request cap", /Up to (\d+) ids per request/)
  assert.equal(ids, MAX_IDS_PER_REQUEST)
})

test("the Pro plan the guide sells is the one the webhook provisions", () => {
  const [queries, docs] = quoted(
    "the Pro plan's monthly quotas",
    /Pro plan: ([\d,]+) queries\/month, ([\d,]+) documents indexed per month/
  )
  // The most expensive pair in the file to get wrong: these are what the customer is told they are
  // buying, and functions/api/polar-webhook.js is what the row they get is actually created with.
  // Nothing else compares the two — the quotas are enforced off the row, so a webhook provisioning
  // less than the guide sells is correct everywhere except where it matters.
  assert.equal(queries, PRO_Q_LIMIT)
  assert.equal(docs, PRO_DOC_LIMIT)
})

// --- step 4A's script, the one thing in the guide that is run rather than read ---
//
// Everything above pins a number in the prose to the constant that enforces it. This section pins
// the guide's only runnable artifact, for a reason the prose does not have: a reader who
// misunderstands a sentence finds out, and a CI step that misunderstands one does not.
//
// The script batched at 100 and discarded every response. Both halves were wrong, and together
// they were silent. 100 is the *document* cap, and it is not the one that binds: a document is
// chunked to at most MAX_CHUNKS_PER_DOC and a request holds at most MAX_CHUNKS_PER_REQUEST, so 100
// documents only fit while each stays under ~3,000 characters of text. Measured against the real
// handler, a batch of 100 ordinary documentation pages is refused with 413 `too_many_chunks` —
// before any embed or upsert, so nothing in it is indexed — and 28 fit at 10,000 characters a page.
//
// Discarding the response is what made that invisible. The build step awaited `fetch` and read
// nothing back, so the 413 exited 0 and the deploy reported success over content search had never
// seen. The same silence covered `429 quota_exceeded`, which the guide says rejects a request
// whole, and the two counters the guide twice tells the reader to check after a run —
// `skipped_docs` ("usually means a field-mapping bug on your side") and `truncated_ids` ("treat a
// non-zero `truncated_docs` as a signal to split that document"). The one script in the file that
// could have acted on any of them read none of them.
//
// MAX_CHUNKS_PER_REQUEST / MAX_CHUNKS_PER_DOC is the batch size that cannot be refused whatever
// the content is, because a document cannot contribute more than its own cap. Asserted as the
// exact edge rather than as a safe number — one more document must be refused — so the guide
// cannot drift to a smaller batch that passes this check while costing the customer requests.

// A document that uses its whole per-document allowance: anything longer is truncated to
// MAX_CHUNKS_PER_DOC chunks, so a batch of these is the worst case one can be made of. Grown
// through chunk() rather than from a pasted length, so it stays maximal if size/overlap move.
const maximalBody = (() => {
  let n = 1
  while (chunk("x".repeat(n)).length < MAX_CHUNKS_PER_DOC) n *= 2
  return "x".repeat(n)
})()

const maximalBatch = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `doc-${i}`, title: `t${i}`, content: maximalBody }))

test("the guide's script batches at the largest size that can never be refused", async () => {
  const m = RECIPE_CODE.match(/const BATCH = (\d+)/)
  assert.ok(m, "step 4A's script no longer names its batch size as `const BATCH = <n>`")
  const batch = Number(m[1])

  assert.equal(
    batch,
    MAX_CHUNKS_PER_REQUEST / MAX_CHUNKS_PER_DOC,
    "a batch of this many maximal documents is not the per-request chunk cap exactly"
  )

  // The edge, driven through the real handler rather than argued from the constants: the caps are
  // enforced by a running count inside the chunk loop, which is the thing a batch size has to
  // survive.
  const ok = await onRequestPost({ request: request(maximalBatch(batch)), env: fakeEnv().env })
  assert.equal(
    ok.status,
    200,
    `the guide tells the reader ${batch} documents cannot cross the chunk total; ingest refused them`
  )

  const over = await onRequestPost({ request: request(maximalBatch(batch + 1)), env: fakeEnv().env })
  assert.equal(
    over.status,
    413,
    `${batch} is below the edge, so the guide is costing the customer requests it does not need`
  )
})

test("the guide's script reads what came back", () => {
  // Spelled as three separate claims because each one is a different silence. A fire-and-forget
  // `await fetch(...)` satisfies none of them, which is where this started.
  assert.match(
    RECIPE_CODE,
    /if \(!res\.ok\)/,
    "the script does not check the status, so a refused batch — which indexes nothing — leaves a " +
      "green build over content that was never indexed"
  )
  assert.match(
    RECIPE_CODE,
    /body\.skipped_docs/,
    "the script never reads `skipped_docs`, which the guide tells the reader to check after a run"
  )
  assert.match(
    RECIPE_CODE,
    /body\.truncated_ids/,
    "the script never reads `truncated_ids`, the one limit the guide says costs content rather " +
      "than a retry"
  )
  assert.match(
    RECIPE_CODE,
    /i \+= BATCH/,
    "the loop steps by something other than the batch size it declares"
  )
})

test("the binding-cap bullet's two measurements are the ones chunk() produces", () => {
  const [perDoc] = quoted(
    "how long a document may be for the document cap to be reachable",
    /100 documents only fit in one request while each is under ~([\d,]+) characters of text/
  )
  // Same derivation and the same 5% slack as the truncation threshold above: the figure is what
  // one document's share of MAX_CHUNKS_PER_REQUEST comes to once chunk()'s size and overlap are
  // applied, and the guide writes "under ~", so it must not over-state it.
  const share = capacityFor(MAX_CHUNKS_PER_REQUEST / MAX_DOCS_PER_REQUEST)
  assert.ok(perDoc <= share, `the guide promises 100 documents of ${perDoc} fit; ${share} is the cap`)
  assert.ok(
    share - perDoc <= share * 0.05,
    `the guide under-states the per-document share: ${perDoc} against ${share}`
  )

  const [pageChars, fit] = quoted(
    "how many ordinary pages fit in one request",
    /at ([\d,]+) characters a\s+page, (\d+) fit/
  )
  assert.equal(
    fit,
    Math.floor(MAX_CHUNKS_PER_REQUEST / chunk("x".repeat(pageChars)).length),
    `${pageChars}-character pages do not come to ${fit} per request`
  )
})
