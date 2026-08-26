#!/usr/bin/env node
// Post-processing for `shadcn build`. Expands the bare item names written in a composed
// component's registryDependencies (which reference this registry) into their serving URLs
// `${SITE_BASE}/r/<name>.json`.
// shadcn resolves bare names against the official registry (ui.shadcn.com), so composing your
// own components requires absolute URLs. SITE_BASE is passed via env.
// If SITE_BASE is unset, do nothing (inject after serving; locally, pass localhost).
//
// Every file in public/r that publishes registryDependencies is rewritten, not just the per-item
// ones: `shadcn build` also writes the whole catalogue to registry.json, and scripts/build-index.mjs
// writes it again to index.json. Those two used to keep the bare names, so the same dependency
// shipped spelled two ways in one deploy — see scripts/_registry-deps.mjs for what that costs.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expandLocalDeps, localNamesOf } from "./_registry-deps.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/$/, "")
const rDir = join(ROOT, "public", "r")

if (!existsSync(rDir)) {
  console.log("INFO\tpublic/r not found → run `shadcn build` first")
  process.exit(0)
}

const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
const localNames = localNamesOf(reg)

if (!SITE_BASE) {
  console.log(
    "INFO\tSITE_BASE not set → URLs for self-composed components are not injected (pass SITE_BASE=... after deploy or locally)"
  )
  process.exit(0)
}

// The three shapes public/r holds: one component (registry.json's per-item siblings), the
// catalogue `shadcn build` writes ({ items: [...] }), and the catalogue build-index.mjs writes at
// official's path (a bare array). Reading the shape rather than the filename means a fourth output
// is covered the day it appears, and no name has to be kept in step here.
const itemsOf = (doc) => (Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : [doc])

let files = 0
let deps = 0
for (const f of readdirSync(rDir).filter((f) => f.endsWith(".json"))) {
  const p = join(rDir, f)
  const doc = JSON.parse(readFileSync(p, "utf8"))
  let changed = false
  for (const item of itemsOf(doc)) {
    if (!Array.isArray(item?.registryDependencies)) continue
    const expanded = expandLocalDeps(item.registryDependencies, localNames, SITE_BASE)
    const moved = expanded.filter((dep, i) => dep !== item.registryDependencies[i]).length
    if (!moved) continue
    item.registryDependencies = expanded
    deps += moved
    changed = true
  }
  if (changed) {
    writeFileSync(p, JSON.stringify(doc, null, 2) + "\n")
    files++
  }
}
console.log(
  `OK\tinjected SITE_BASE into registryDependencies: ${deps} in ${files} files (${SITE_BASE})`
)
