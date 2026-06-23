#!/usr/bin/env node
// Dependency-free self-check. Verifies that each item in registry.json:
//  - has the required fields (name/type/files)
//  - references source files that actually exist
//  - has a title/description of sufficient length for discoverability
// and, if a build output exists in public/r, that it corresponds to the items.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = (lvl, msg) => console.log(`${lvl}\t${msg}`)
let warn = 0
let alert = 0

function fail(msg) {
  alert++
  out("ALERT", msg)
}
function warning(msg) {
  warn++
  out("WARN", msg)
}

let reg
try {
  reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
} catch (e) {
  fail(`cannot read/parse registry.json: ${e.message}`)
  process.exit(1)
}

if (!Array.isArray(reg.items) || reg.items.length === 0) {
  fail("registry.json has no items")
} else {
  out("OK", `registry "${reg.name}" — items: ${reg.items.length}`)
}

const VALID_TYPES = new Set([
  "registry:ui",
  "registry:block",
  "registry:component",
  "registry:hook",
  "registry:lib",
  "registry:page",
  "registry:file",
  "registry:style",
  "registry:theme",
])

for (const item of reg.items ?? []) {
  const id = item.name ?? "(no name)"
  if (!item.name) fail(`item is missing name`)
  if (!VALID_TYPES.has(item.type)) fail(`${id}: invalid type "${item.type}"`)
  if (!Array.isArray(item.files) || item.files.length === 0)
    fail(`${id}: files is empty`)

  for (const f of item.files ?? []) {
    if (!f.path) {
      fail(`${id}: missing file.path`)
      continue
    }
    if (!existsSync(join(ROOT, f.path)))
      fail(`${id}: source file does not exist → ${f.path}`)
  }

  // Discoverability: a description should be specific about when to use the component,
  // hence the minimum length.
  if (!item.title) warning(`${id}: missing title`)
  if (!item.description) {
    warning(`${id}: missing description (AI cannot match it)`)
  } else if (item.description.length < 60) {
    warning(`${id}: description is short (${item.description.length} chars) — consider clarifying when to use it`)
  }
}

// If a build output exists (public/r), check it corresponds to the items (otherwise INFO).
const rDir = join(ROOT, "public", "r")
if (existsSync(rDir)) {
  const built = new Set(
    readdirSync(rDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
  )
  for (const item of reg.items ?? []) {
    if (item.name && !built.has(item.name))
      warning(`${item.name}: build output public/r/${item.name}.json is missing → npx shadcn build`)
  }
  out("OK", `build output: ${built.size} files`)
} else {
  out("INFO", "public/r not generated → run `npx shadcn build`")
}

out(alert ? "RESULT" : warn ? "RESULT" : "RESULT", `ALERT=${alert} WARN=${warn}`)
process.exit(alert ? 1 : 0)
