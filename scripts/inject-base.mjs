#!/usr/bin/env node
// Post-processing for `shadcn build`. Expands the bare item names written in a composed
// component's registryDependencies (which reference this registry) into their serving URLs
// `${SITE_BASE}/r/<name>.json`.
// shadcn resolves bare names against the official registry (ui.shadcn.com), so composing your
// own components requires absolute URLs. SITE_BASE is passed via env.
// If SITE_BASE is unset, do nothing (inject after serving; locally, pass localhost).
//
// Every file `shadcn build` leaves behind is rewritten, not just the per-item ones: it also writes
// the whole catalogue to registry.json, which used to keep the bare names, so the same dependency
// shipped spelled two ways in one deploy — see scripts/_registry-deps.mjs for what that costs.
//
// public/r/index.json is the exception, and deliberately: scripts/build-index.mjs regenerates it
// from registry.json in the very next step of `npm run registry:build`, so everything written into
// it here is discarded seconds later. Measured on the real tree — after this script ran with
// SITE_BASE set, all 93 entries of index.json carried the docs line; after build-index.mjs ran,
// none did, which is also what the deployed file shows. That made it the one file whose apparent
// coverage here was pure accounting: its 93 entries were counted into the line this script prints,
// putting the docs total at 279 for a catalogue of 93 components. The file is correct in
// production because build-index.mjs expands its own dependencies (test/build-index.test.mjs pins
// that, end to end), not because of anything this step does.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expandLocalDeps, localNamesOf } from "./_registry-deps.mjs"
import { INDEX_FILE } from "./build-index.mjs"

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

// The two shapes `shadcn build` writes: one component (registry.json's per-item siblings) and the
// catalogue ({ items: [...] }). Reading the shape rather than the filename means a third output is
// covered the day it appears, and no name has to be kept in step here. The bare-array shape
// build-index.mjs writes is still accepted for the same reason, even though that file is skipped
// below — the dispatch is about shapes, not about which files happen to arrive.
const itemsOf = (doc) => (Array.isArray(doc) ? doc : Array.isArray(doc?.items) ? doc.items : [doc])

let files = 0
// The one line this registry gets to say to the person who just installed something. shadcn's
// `docs` field is printed by the CLI after an install, which makes it the only surface that
// reaches the people who actually use pulld: they arrive through `npx shadcn add <url>` and never
// load the site. Thirty days of log: 31 real install actions, against 5 people who reached the
// site at all.
//
// So it is a route, not a pitch. What an installer most plausibly wants next is the second
// component without hunting for its URL, and that is what the namespace config gives them. The
// link carries utm_source=cli so the click log can say whether anyone ever follows it — the whole
// point of putting something here is to find out.
//
// Injected at build time rather than written into registry.json so that every component has it,
// including the one the daily routine adds tomorrow, and so the wording is changed in one place.
const docsLine = (count) =>
  `Install any pulld component by name: add "@pulld": "${SITE_BASE}/r/{name}.json" to the ` +
  `registries block in components.json, then \`npx shadcn add @pulld/<name>\`. ` +
  `All ${count} components: ${SITE_BASE}/?utm_source=cli`

const DOCS = docsLine(Array.isArray(reg?.items) ? reg.items.length : 0)

let deps = 0
// Counted by component name, not by object visited. A component appears twice in what this script
// rewrites — once in its own file and once in the catalogue — so counting visits reported twice the
// components there are (three times, while index.json was still being rewritten here). The number
// is only worth printing if "93" means the 93 components in registry.json all got the line.
const injected = new Set()
for (const f of readdirSync(rDir).filter((f) => f.endsWith(".json") && f !== INDEX_FILE)) {
  const p = join(rDir, f)
  const doc = JSON.parse(readFileSync(p, "utf8"))
  let changed = false
  for (const item of itemsOf(doc)) {
    // Never overwrite a component that says something of its own — a component needing an env var
    // or a peer install has more to say here than the catalogue does.
    if (item && typeof item === "object" && item.name && !item.docs) {
      item.docs = DOCS
      injected.add(item.name)
      changed = true
    }
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
console.log(`OK\tinjected the install-time docs line into ${injected.size} components`)
