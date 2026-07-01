#!/usr/bin/env node
// Dependency-free self-check. Verifies that each item in registry.json:
//  - has the required fields (name/type/files)
//  - has a unique name and no repeated file paths within an item
//  - references source files that actually exist
//  - has a title/description of sufficient length for discoverability
// and, if a build output exists in public/r, that it corresponds to the items.
//
// The validation is exposed as a pure function (verifyRegistry) so it can be unit-tested without
// touching the filesystem; the CLI below wires it to the real registry.json and public/r.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const VALID_TYPES = new Set([
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

// Pure validator. Returns { messages: [{level, msg}], alert, warn } and never touches the disk or
// process state — callers inject `fileExists(path)` (relative to the repo root) and, when a build
// exists, `builtNames` (the list of names under public/r, or null when no build output is present).
export function verifyRegistry(reg, { fileExists = () => true, builtNames = null } = {}) {
  const messages = []
  let warn = 0
  let alert = 0
  const push = (level, msg) => messages.push({ level, msg })
  const fail = (msg) => {
    alert++
    push("ALERT", msg)
  }
  const warning = (msg) => {
    warn++
    push("WARN", msg)
  }

  if (!Array.isArray(reg?.items) || reg.items.length === 0) {
    fail("registry.json has no items")
  } else {
    push("OK", `registry "${reg.name}" — items: ${reg.items.length}`)
  }

  // Names must be unique: shadcn builds one public/r/<name>.json per item and consumers install by
  // name, so a collision would silently clobber a component (and the build-output check below would
  // still pass because one file exists). Catch it here instead.
  const seenNames = new Set()

  for (const item of reg?.items ?? []) {
    const id = item.name ?? "(no name)"
    if (!item.name) {
      fail(`item is missing name`)
    } else if (seenNames.has(item.name)) {
      fail(`${id}: duplicate item name — names must be unique (build output/install-by-name collide)`)
    } else {
      seenNames.add(item.name)
    }
    if (!VALID_TYPES.has(item.type)) fail(`${id}: invalid type "${item.type}"`)
    if (!Array.isArray(item.files) || item.files.length === 0)
      fail(`${id}: files is empty`)

    const seenPaths = new Set()
    for (const f of item.files ?? []) {
      if (!f.path) {
        fail(`${id}: missing file.path`)
        continue
      }
      if (seenPaths.has(f.path)) {
        fail(`${id}: duplicate file.path → ${f.path}`)
        continue
      }
      seenPaths.add(f.path)
      if (!fileExists(f.path)) fail(`${id}: source file does not exist → ${f.path}`)
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
  if (builtNames) {
    const built = new Set(builtNames)
    for (const item of reg?.items ?? []) {
      if (item.name && !built.has(item.name))
        warning(`${item.name}: build output public/r/${item.name}.json is missing → npx shadcn build`)
    }
    push("OK", `build output: ${built.size} files`)
  } else {
    push("INFO", "public/r not generated → run `npx shadcn build`")
  }

  push("RESULT", `ALERT=${alert} WARN=${warn}`)
  return { messages, alert, warn }
}

// --- CLI: run against the real registry.json and public/r ---
function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  let reg
  try {
    reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  } catch (e) {
    console.log(`ALERT\tcannot read/parse registry.json: ${e.message}`)
    process.exit(1)
  }

  const rDir = join(ROOT, "public", "r")
  const builtNames = existsSync(rDir)
    ? readdirSync(rDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    : null

  const { messages, alert } = verifyRegistry(reg, {
    fileExists: (p) => existsSync(join(ROOT, p)),
    builtNames,
  })
  for (const m of messages) console.log(`${m.level}\t${m.msg}`)
  process.exit(alert ? 1 : 0)
}

// Only run the CLI when invoked directly (`node scripts/verify-registry.mjs`), not when imported
// by the unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
