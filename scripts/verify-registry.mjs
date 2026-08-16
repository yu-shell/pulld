#!/usr/bin/env node
// Dependency-free self-check. Verifies that each item in registry.json:
//  - has the required fields (name/type/files)
//  - has a unique name and no repeated file paths within an item
//  - references source files that actually exist
//  - has a title/description of sufficient length for discoverability
// and, if a build output exists in public/r, that it corresponds to the items. The source tree is
// checked in the same both-ways spirit: a .tsx under registry/ that no item claims is flagged too.
//
// The validation is exposed as a pure function (verifyRegistry) so it can be unit-tested without
// touching the filesystem; the CLI below wires it to the real registry.json and public/r.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// The one build output in public/r that is not a component: `shadcn build` writes the catalogue
// index under this name alongside the per-item files (inject-base.mjs skips it for the same
// reason). It has no registry item and never will.
export const CATALOGUE_INDEX = "registry"

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
// process state — callers inject `fileExists(path)` (relative to the repo root), `sourceFiles` (the
// component sources actually present under registry/, or null when they were not enumerated) and,
// when a build exists, `builtNames` (the list of names under public/r, or null when no build output
// is present).
export function verifyRegistry(
  reg,
  { fileExists = () => true, builtNames = null, sourceFiles = null } = {}
) {
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

  // The source tree, checked the way public/r is: both directions, not just the one the build
  // happens to notice. `files[].path → does it exist` is already covered above; this is the
  // reverse, and nothing else in the pipeline looks at it. A component written into registry/ but
  // never added to registry.json is not built, not served, not on the landing page, not in
  // llms.txt and not installable — it is finished work that ships to nobody, and every signal the
  // project has stays green while it sits there. Found in the wild: registry/ui/color-picker.tsx,
  // 636 lines, complete, uncommitted and unreferenced, invisible to `npm run check`.
  if (sourceFiles) {
    const claimed = new Set()
    for (const item of reg?.items ?? []) {
      for (const f of item.files ?? []) if (f.path) claimed.add(f.path)
    }
    for (const path of sourceFiles) {
      if (claimed.has(path)) continue
      warning(
        `${path}: orphan source — no item in registry.json references it, so it is never built ` +
          `and cannot be installed → add an item for it or delete the file`
      )
    }
  }

  // If a build output exists (public/r), check it corresponds to the items (otherwise INFO).
  // "Corresponds" runs both ways. The missing direction is the obvious one; the extra direction
  // matters more, because nothing else in the pipeline looks at it: `shadcn build` writes the
  // items it is given and never removes anything else, and public/r is gitignored, so the
  // directory is long-lived local state rather than something a fresh checkout resets. Rename or
  // drop a component and public/r/<old>.json survives every subsequent build — then `npm run
  // deploy` uploads public/ wholesale and it keeps being served, with the old code, at a URL the
  // registry no longer lists. The landing page and llms.txt are both regenerated from
  // registry.json, so nothing on the site points at it and nothing shows it is there; an agent or
  // a CLI that cached the name goes on installing a component this project stopped shipping.
  if (builtNames) {
    const built = new Set(builtNames)
    const itemNames = new Set((reg?.items ?? []).map((i) => i.name).filter(Boolean))
    for (const name of itemNames) {
      if (!built.has(name))
        warning(`${name}: build output public/r/${name}.json is missing → npx shadcn build`)
    }
    for (const name of built) {
      if (name === CATALOGUE_INDEX || itemNames.has(name)) continue
      warning(
        `${name}: stale build output — public/r/${name}.json has no item in registry.json and ` +
          `would still be deployed and served → rm public/r/${name}.json (shadcn build leaves it)`
      )
    }
    // Reported as a correspondence rather than a file count: the old total counted every file in
    // public/r, so the catalogue index and any stale artifact both inflated it, and the one number
    // meant to say "the build matches the registry" was the number that hid when it did not.
    const componentsBuilt = [...built].filter((name) => itemNames.has(name)).length
    push("OK", `build output: ${componentsBuilt} of ${itemNames.size} items built`)
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

  // Every component source under registry/, as repo-relative paths — the same shape as the
  // `files[].path` the items carry, so the two sets compare directly.
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) return walk(join(dir, entry.name), path)
      return entry.name.endsWith(".tsx") ? [path] : []
    })
  }
  const sourceFiles = existsSync(join(ROOT, "registry")) ? walk(join(ROOT, "registry"), "registry") : null

  const { messages, alert } = verifyRegistry(reg, {
    fileExists: (p) => existsSync(join(ROOT, p)),
    builtNames,
    sourceFiles,
  })
  for (const m of messages) console.log(`${m.level}\t${m.msg}`)
  process.exit(alert ? 1 : 0)
}

// Only run the CLI when invoked directly (`node scripts/verify-registry.mjs`), not when imported
// by the unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
