#!/usr/bin/env node
// Post-processing for `shadcn build`. Expands the bare item names written in a composed
// component's registryDependencies (which reference this registry) into their serving URLs
// `${SITE_BASE}/r/<name>.json`.
// shadcn resolves bare names against the official registry (ui.shadcn.com), so composing your
// own components requires absolute URLs. SITE_BASE is passed via env.
// If SITE_BASE is unset, do nothing (inject after serving; locally, pass localhost).

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SITE_BASE = (process.env.SITE_BASE || "").replace(/\/$/, "")
const rDir = join(ROOT, "public", "r")

if (!existsSync(rDir)) {
  console.log("INFO\tpublic/r not found → run `shadcn build` first")
  process.exit(0)
}

const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
const localNames = new Set((reg.items ?? []).map((i) => i.name))

if (!SITE_BASE) {
  console.log(
    "INFO\tSITE_BASE not set → URLs for self-composed components are not injected (pass SITE_BASE=... after deploy or locally)"
  )
  process.exit(0)
}

let n = 0
for (const f of readdirSync(rDir).filter((f) => f.endsWith(".json"))) {
  if (f === "registry.json") continue
  const p = join(rDir, f)
  const item = JSON.parse(readFileSync(p, "utf8"))
  if (!Array.isArray(item.registryDependencies)) continue
  let changed = false
  item.registryDependencies = item.registryDependencies.map((dep) => {
    if (typeof dep === "string" && localNames.has(dep)) {
      changed = true
      return `${SITE_BASE}/r/${dep}.json`
    }
    return dep
  })
  if (changed) {
    writeFileSync(p, JSON.stringify(item, null, 2) + "\n")
    n++
  }
}
console.log(`OK\tinjected SITE_BASE into registryDependencies: ${n} files (${SITE_BASE})`)
