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
  MAX_DOCS_PER_REQUEST,
  MAX_CHUNKS_PER_REQUEST,
  MAX_REPORTED_IDS,
} from "../functions/api/search/ingest.js"
import { MAX_IDS_PER_REQUEST } from "../functions/api/search/delete.js"
import { PRO_Q_LIMIT, PRO_DOC_LIMIT } from "../functions/api/polar-webhook.js"

const GUIDE = readFileSync(
  new URL("../public/search-integration.md", import.meta.url),
  "utf8"
).replace(/\s+/g, " ")

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
  // MAX_CHUNKS_PER_DOC comes to once chunk()'s size and overlap are applied, and both of those are
  // default parameters. So it is derived the way a caller would experience it — grow a body until
  // one more character would need a chunk past the cap. chunk() is monotonic in input length, so
  // the doubling-down search lands on the exact capacity.
  let capacity = 0
  for (let step = 1 << 15; step >= 1; step >>= 1) {
    while (chunk("x".repeat(capacity + step)).length <= MAX_CHUNKS_PER_DOC) capacity += step
  }

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
