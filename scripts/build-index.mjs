#!/usr/bin/env node
// Writes public/r/index.json — the catalogue under the path clients actually probe.
//
// pulld's index has always been at /r/registry.json, but official shadcn keeps its own at
// /r/index.json, so that is the path every client built against official reaches for. The largest
// client in this log does exactly that: `shadcn-helper-intellij-plugin` asked for /r/index.json
// 1,107 times in thirty days and received an HTML page until 2026-08-09 and a 404 after it, which
// means pulld's components have never once been visible through it. Two registry-directory
// indexers (shadly-sync-worker on 2026-08-10, sh4dcn-directory-enricher on 2026-08-14) arrived on
// their own and found the same nothing.
//
// The shape follows official's index (name, type, files, meta) so a client written against that
// one can read this without special-casing, and adds `title`/`description`, which official omits.
// Keeping them is the whole point here: the description is where this registry says when a
// component is the right one, and an index an agent can match against is worth more than an index
// it can only enumerate.
//
// `files[].path` is deliberately name-only, without file contents: the index says what exists and
// where to fetch it, and a client that wants a component follows the convention every shadcn
// registry shares and GETs /r/<name>.json.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/$/, "")
const outDir = join(ROOT, "public", "r")

export function buildIndex(registry, base = "") {
  const site = String(base || "").replace(/\/$/, "")
  const url = (name) => (site ? `${site}/r/${name}.json` : `/r/${name}.json`)
  return (registry.items ?? []).map((item) => {
    const entry = {
      name: item.name,
      type: item.type,
      title: item.title,
      description: item.description,
      files: (item.files ?? []).map((f) => ({ path: f.path, type: f.type })),
      meta: { url: url(item.name) },
    }
    // Only carry the dependency fields when the component actually has them, so the index does
    // not claim an empty dependency list where official would have written nothing at all.
    if (item.dependencies?.length) entry.dependencies = item.dependencies
    if (item.registryDependencies?.length)
      entry.registryDependencies = item.registryDependencies
    return entry
  })
}

// Only run the CLI when invoked directly, not when imported by the unit tests — the guard the
// other three scripts with a CLI use. It has to go through pathToFileURL rather than pasting
// argv[1] after `file://`: `import.meta.url` is a percent-encoded URL, so any path component
// needing encoding (a space is enough) makes the two strings differ and the block never runs.
// Nothing announces that — the script exits 0 having written nothing, `npm run registry:build`
// reports success, and the deploy serves no /r/index.json at all.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
  const index = buildIndex(registry, SITE_BASE)
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n")
  console.log(
    `OK\tpublic/r/index.json generated: ${index.length} components` +
      (SITE_BASE ? ` (base ${SITE_BASE})` : " (relative URLs — SITE_BASE not set)")
  )
}
