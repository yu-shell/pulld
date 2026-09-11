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
      "/api/search/ingest` header `x-pulld-admin-key`, body `{documents:[{id,title,url,content}]}` (≤100/req; same `id` overwrites)."
  )
  lines.push(
    "- Remove (server-side, secret admin_key): `POST " +
      BASE +
      "/api/search/delete` body `{ids:[\"docId\"]}` (same id range as ingest; non-existent ids are no-ops)."
  )
  lines.push(
    "- Search (public query_key): `GET " +
      BASE +
      "/api/search/query?key=<query_key>&q=<text>&limit=8` → `{results:[{id,label,url,snippet,score}]}`. " +
      "`limit` is 1-20 (default 8; out of range is clamped, not rejected) and results are one row per " +
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
