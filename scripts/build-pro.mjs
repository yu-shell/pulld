#!/usr/bin/env node
// Bundle the built Pro block JSON from pro/dist into a single module, functions/_pro-blocks.js,
// which the gate Function reads. registryDependencies that reference this registry's own (free)
// components are expanded to their public SITE_BASE URLs, so on Pro install the free components
// are fetched from the public URL.
// This module is gitignored, so Pro contents are not in the public repo. wrangler deploys from
// the local filesystem, so they are included in the deployed (behind-the-gate) build.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SITE_BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")
const distDir = join(ROOT, "pro", "dist")
const proRegPath = join(ROOT, "pro", "registry.json")

if (!existsSync(proRegPath) || !existsSync(distDir)) {
  // When the Pro set is absent, emit an empty module so a free-core-only deploy still works.
  writeFileSync(join(ROOT, "functions", "_pro-blocks.js"), "export const PRO_BLOCKS = {}\n")
  console.log("INFO\tpro not built → functions/_pro-blocks.js = {}")
  process.exit(0)
}

const proReg = JSON.parse(readFileSync(proRegPath, "utf8"))
const freeReg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
const freeNames = new Set((freeReg.items ?? []).map((i) => i.name))

const map = {}
for (const item of proReg.items ?? []) {
  const p = join(distDir, item.name + ".json")
  if (!existsSync(p)) {
    console.error(`WARN\tpro item not built: ${item.name}`)
    continue
  }
  const built = JSON.parse(readFileSync(p, "utf8"))
  if (Array.isArray(built.registryDependencies)) {
    built.registryDependencies = built.registryDependencies.map((d) =>
      freeNames.has(d) ? `${SITE_BASE}/r/${d}.json` : d
    )
  }
  map[item.name] = built
}

writeFileSync(
  join(ROOT, "functions", "_pro-blocks.js"),
  "export const PRO_BLOCKS = " + JSON.stringify(map, null, 2) + "\n"
)
console.log(`OK\tpro blocks bundled: ${Object.keys(map).length} (base ${SITE_BASE})`)
