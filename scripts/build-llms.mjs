#!/usr/bin/env node
// Generate llms.txt from registry.json (+ pro) so AI tools/agents can discover the components
// and how to install them (shadcn itself also publishes an llms.txt).
// Output: public/llms.txt. SITE_BASE overrides the URL.
//
// The generation is exposed as pure functions (summarize, buildLlms) so it can be unit-tested
// without touching the filesystem, the way build-index.mjs and verify-registry.mjs are; the CLI
// at the bottom wires them to the real registry.json and public/llms.txt.

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { chunk, MAX_CHUNKS_PER_DOC } from "../functions/api/search/_lib.js"
import { MAX_CHUNKS_PER_REQUEST, MAX_DOCS_PER_REQUEST } from "../functions/api/search/ingest.js"
import { MAX_IDS_PER_REQUEST } from "../functions/api/search/delete.js"
import { clampLimit, DEFAULT_LIMIT } from "../functions/api/search/query.js"

// llms.txt is an index: the file an agent loads to find out what exists, before fetching the one
// component it wants. That job has a budget, and the catalogue had outgrown it — 83 components
// came to 292 KB, roughly 73k tokens, of which 96.7% was item descriptions. Those descriptions are
// deliberately long: criteria.md §AEO makes them the primary text an agent matches a component
// against, so they carry a full "reach for it wherever…" list plus the phrases people search for.
// That is the right content for matching one component and the wrong content for listing all of
// them, and a reader that truncates a fetch this size does not get a shorter description of every
// component — it gets no mention at all of the ones past the cut, which is the failure the index
// exists to prevent.
//
// So the index carries the opening sentence and points at the full text rather than inlining it.
// Nothing is lost: registry.json keeps the descriptions, `shadcn build` copies each one into its
// own /r/<name>.json, and build-index.mjs writes every one of them, unabridged, into the catalogue
// at /r/index.json — which is the link offered below for an agent that wants to match on all of
// them at once.
const SUMMARY_MAX = 400

// The pulld Search section below is an API contract written in prose, and the numbers in it are
// constants in functions/. public/search-integration.md has exactly the same problem and was
// given exactly this fix: test/search-guide-limits.test.mjs pins every number that guide quotes
// to the code enforcing it, "because nothing but a reader connects the two, so a limit that moves
// in one tree goes on reading as true in the other".
//
// llms.txt was left out of that, and it is the surface with the most to lose: it is the index an
// AI coding agent loads, so its numbers — the ingest caps, the query range, and the default limit
// twice, once in the example URL and once in the sentence beside it — are what an agent wires a
// client up against before it ever reads the guide. They were string literals, and they agreed
// with the handlers only because nobody had moved a handler yet.
//
// Pinning the numbers it quoted left a second half: which numbers it quoted at all. Of the four
// ways an ingest request can go wrong, the index named only the one that costs the caller a
// retry — `≤100/req`. The two that cost them content or money were absent, and both are reachable
// from the recipe the index itself implies:
//
//   * MAX_CHUNKS_PER_REQUEST. A batch obeying `≤100/req` is refused WHOLE with 413
//     `too_many_chunks` as soon as its documents average more than four chunks — about 3,150
//     characters, which is an ordinary help article. No number in the index explained the
//     refusal, so the obvious response is to re-send the same batch and get the same 413.
//   * MAX_CHUNKS_PER_DOC. Past it the rest of a document is never searchable and the request
//     still answers `ok: true` — ingest.js's own comment measures a 40,000-character article
//     losing 62% of itself that way. It is reported in `truncated_docs` / `truncated_ids`, and
//     the index named neither the cap nor the fields, so there was nothing to check.
//
// Also the doc quota, which is a monthly FLOW: every document sent is charged, re-indexes
// included. The guide gives that its own bullet and a whole section ("the main thing that decides
// whether your quota fits"), because it is what decides between the build-time and on-change
// recipes — an agent that wired up the first from this index re-charged the whole catalogue on
// every deploy and found out from a 429.
//
// And the delete cap, which was simply missing: `MAX_IDS_PER_REQUEST` is a 400 with no number in
// the index to batch against.
//
// Interpolated rather than pinned by a test, which is the difference between this artifact and the
// guide: llms.txt is GENERATED, so the number can be read from the constant instead of compared
// against it. Same reason test/deploy-gate.test.mjs reads the deploy steps off package.json —
// "a fact written twice is a fact that drifts".
//
// The range is read off clampLimit rather than from a second pair of constants, the way
// test/search-guide-limits.test.mjs reads it: query.js deliberately does not export the bounds
// ("it is already reachable from a test through clampLimit itself, so naming it twice would only
// create a second place to drift"). A value far outside the range clamps to the edge, so the edge
// is what comes back — and the probes must be finite, because clampLimit sends a non-finite input
// to the fallback instead of through the clamp.
const LIMIT_MIN = clampLimit(-1e9, DEFAULT_LIMIT)
const LIMIT_MAX = clampLimit(1e9, DEFAULT_LIMIT)

/**
 * How long one document's `title` + `content` may be before MAX_CHUNKS_PER_DOC starts dropping the
 * rest of it.
 *
 * The one figure here that is nobody's constant: it is what the cap comes to once chunk()'s
 * default size and overlap are applied. Stated in characters because that is the unit a caller can
 * measure — "20 chunks" is an internal one, and an agent reading this index to decide how to split
 * its content cannot act on it. public/search-integration.md quotes the same figure for the same
 * reason, and test/search-guide-limits.test.mjs derives it there rather than trusting the prose.
 *
 * Derived the way a caller experiences it — grow a body until one more character would need a
 * chunk past the cap — rather than recomputed from size and overlap, which would be a second
 * expression of chunk()'s arithmetic that could disagree with it. chunk() is monotonic in input
 * length, so the refinement below lands on the exact capacity.
 *
 * The first loop finds an input the cap already rejects, so the second is not bounded by a literal
 * that a larger chunk size or cap would silently outgrow — which would leave this under-reporting
 * the capacity and telling callers to split documents that did not need it. Computed once at module
 * load: chunk() is pure and its inputs here are its own defaults, so the answer cannot change
 * between calls.
 */
function docCharCapacity() {
  let step = 1
  while (chunk("x".repeat(step)).length <= MAX_CHUNKS_PER_DOC) step *= 2
  let capacity = 0
  for (; step >= 1; step >>= 1) {
    while (chunk("x".repeat(capacity + step)).length <= MAX_CHUNKS_PER_DOC) capacity += step
  }
  return capacity
}
const DOC_CHAR_CAPACITY = docCharCapacity()

// The first sentence of a description. A sentence only ends at `.!?` when what follows starts a new
// one — a capital, a digit, or an opening quote — which is what keeps keyboard-shortcuts ("the help
// sheet that opens when the user presses ? — a modal listing…") from being cut to a fragment at a
// question mark that is part of the sentence rather than the end of it. Whitespace is collapsed
// first because the result is published as one markdown list item, where a newline would end the
// line early.
//
// SUMMARY_MAX is a guard, not the usual path: across the current 83 items the longest first
// sentence is 378 characters and nothing is truncated. It is here so that one description written
// without a sentence break can never put the whole catalogue back into the index.
export function summarize(description, max = SUMMARY_MAX) {
  const clean = String(description ?? "").replace(/\s+/g, " ").trim()
  if (!clean) return ""
  const match = clean.match(/^.*?[.!?](?=\s+["'(]?[A-Z0-9]|$)/)
  const sentence = match ? match[0] : clean
  if (sentence.length <= max) return sentence
  const cut = sentence.slice(0, max)
  const space = cut.lastIndexOf(" ")
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "") + "…"
}

const entry = (item, base, path) =>
  `- [${item.name}](${base}${path}/${item.name}.json): ` +
  (summarize(item.description) || item.title || item.name)

// Pure builder: registry in, llms.txt text out. `pro` is pro/registry.json's items (or []).
export function buildLlms(registry, { base = "", pro = [] } = {}) {
  const BASE = String(base || "").replace(/\/$/, "")
  const items = registry?.items ?? []
  const lines = []
  lines.push("# pulld")
  lines.push("")
  lines.push(
    "> AI-installable, shadcn-compatible component registry. Production-ready React/Tailwind " +
      "components that an AI coding agent (Claude Code, Cursor, v0) or the shadcn CLI can install " +
      "by name. Every component is typed, accessible, and theme-aware. Free atoms plus paid Pro blocks."
  )
  lines.push("")
  lines.push("## Install")
  lines.push("")
  lines.push("Add the namespace to your project's components.json, then add by name:")
  lines.push("")
  lines.push('```json')
  lines.push('{ "registries": { "@pulld": "' + BASE + '/r/{name}.json" } }')
  lines.push('```')
  lines.push("")
  lines.push("```bash")
  lines.push("npx shadcn@latest add @pulld/" + (items[0]?.name || "copy-button"))
  lines.push("# or directly by URL:")
  lines.push("npx shadcn@latest add " + BASE + "/r/" + (items[0]?.name || "copy-button") + ".json")
  lines.push("```")
  lines.push("")
  lines.push("## Components")
  lines.push("")
  lines.push(
    "One line each: what the component is for. Each link serves that component's full description " +
      "— the specific situations it is for, and the wording people ask for it by — alongside its " +
      "source; the whole catalogue with those descriptions unabridged is at " +
      BASE +
      "/r/index.json."
  )
  lines.push("")
  for (const it of items) {
    lines.push(entry(it, BASE, "/r"))
  }

  if (pro.length) {
    lines.push("")
    lines.push("## Pro blocks (license required)")
    lines.push("")
    lines.push(
      "Composed, production-ready blocks. Install with a license key: " +
        "`npx shadcn@latest add \"" + BASE + "/r/pro/<name>.json?key=YOUR_KEY\"`."
    )
    lines.push("")
    for (const it of pro) {
      lines.push(entry(it, BASE, "/r/pro"))
    }
  }
  lines.push("")
  lines.push("## pulld Search (hosted semantic search, subscription)")
  lines.push("")
  lines.push(
    "Hosted meaning-based search for your app — index your content, query by meaning, no vector DB " +
      "to run. Pairs with the command-palette via the exported `pulldSearchSource` helper. " +
      "Full integration guide (keys, ingest, keep-in-sync patterns): " +
      BASE +
      "/search-integration.md"
  )
  lines.push("")
  lines.push(
    "- Index (server-side, secret admin_key): `POST " +
      BASE +
      "/api/search/ingest` header `x-pulld-admin-key`, body `{documents:[{id,title,url,content}]}` " +
      `(≤${MAX_DOCS_PER_REQUEST}/req; same \`id\` overwrites) → ` +
      "`{ok,indexed_docs,skipped_docs,truncated_docs,truncated_ids,indexed_chunks,docs_this_month}`. " +
      `Each document is chunked: ≤${MAX_CHUNKS_PER_DOC} chunks/doc (~${DOC_CHAR_CAPACITY} ` +
      `characters of title+content) and ≤${MAX_CHUNKS_PER_REQUEST} chunks/req. Past the per-doc ` +
      "cap the request still succeeds and the rest of that document is never searchable — check " +
      "`truncated_docs` and split those documents, one per section. Past the per-req total the " +
      "whole request is refused with 413 `too_many_chunks`: send fewer documents per request, not " +
      "the same batch again. Every document indexed is charged against the month's doc quota, " +
      "re-sending an `id` you already have included, so send only what changed; over the quota the " +
      "request is refused whole with 429 `quota_exceeded` and nothing in it is indexed."
  )
  lines.push(
    "- Remove (server-side, secret admin_key): `POST " +
      BASE +
      "/api/search/delete` body `{ids:[\"docId\"]}` " +
      `(≤${MAX_IDS_PER_REQUEST} ids/req; same id range as ingest; non-existent ids are no-ops). ` +
      "Deleting credits nothing back against the doc quota."
  )
  lines.push(
    "- Search (public query_key): `GET " +
      BASE +
      `/api/search/query?key=<query_key>&q=<text>&limit=${DEFAULT_LIMIT}\` → \`{results:[{id,label,url,snippet,score}]}\`. ` +
      `\`limit\` is ${LIMIT_MIN}-${LIMIT_MAX} (default ${DEFAULT_LIMIT}; out of range is clamped, not ` +
      "rejected) and results are one row per " +
      "document, so a short list is normal. The key may travel in an `x-pulld-key` header instead of " +
      "the query string, and POST takes the same fields as a JSON body. An empty `q` returns no " +
      "results and costs no query quota."
  )
  lines.push("- Keys: `GET " + BASE + "/api/search/account?license=<license_key>`.")
  lines.push("")
  return lines.join("\n")
}

// Only run the CLI when invoked directly, not when imported by the unit tests — the same guard,
// via pathToFileURL, that build-index.mjs and verify-registry.mjs use.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
  const BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  const proPath = join(ROOT, "pro", "registry.json")
  const pro = existsSync(proPath)
    ? JSON.parse(readFileSync(proPath, "utf8")).items ?? []
    : []

  const text = buildLlms(reg, { base: BASE, pro })
  writeFileSync(join(ROOT, "public", "llms.txt"), text)
  console.log(
    `OK\tpublic/llms.txt generated: ${(reg.items ?? []).length} components, ` +
      `${Math.round(text.length / 1024)} KB (base ${BASE})`
  )
}
