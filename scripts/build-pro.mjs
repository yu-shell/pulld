#!/usr/bin/env node
// Bundle the built Pro block JSON from pro/dist into a single module, functions/_pro-blocks.js,
// which the gate Function reads. registryDependencies that reference this registry's own (free)
// components are expanded to their public SITE_BASE URLs, so on Pro install the free components
// are fetched from the public URL.
// This module is gitignored, so Pro contents are not in the public repo. wrangler deploys from
// the local filesystem, so they are included in the deployed (behind-the-gate) build.
//
// Two things this script had that nothing else in the pipeline still has:
//
//   * Its own copy of the local-dependency rule. scripts/_registry-deps.mjs exists precisely so
//     that rule has one home — inject-base.mjs and build-index.mjs were given it after the same
//     dependency shipped spelled two different ways in one deploy. This script publishes that
//     rule a fourth time, into the one output a customer pays for, and was never wired to it.
//     Its copy happened to agree; nothing made it keep agreeing.
//   * No test, and no way to have one. `/pro/` is gitignored in its entirety, so on a fresh
//     checkout there is no pro/registry.json and no pro/dist to run this against — the same bind
//     functions/_pro-gate.js was split out of its route to escape ("the one code path that decides
//     whether paid content is handed out was the only handler under functions/ with no test, and
//     could not have had one"). The gate is now tested and the script that builds what it serves
//     was not, which is the half of the paid path where a silent drop actually starts.
//
// So the bundling is a pure function over its inputs, the way verify-registry.mjs, sweep.mjs,
// learn.mjs, build-index.mjs and _pro-gate.js all take theirs, and the CLI below hands it the real
// pro/dist. A Pro item whose build output is absent is still skipped rather than fatal — the free
// core deploying matters more than the block does, and `npm run deploy` runs this with `&&` — but
// it is now named in the summary line on stdout instead of only in a WARN on stderr. Dropping a
// paid block from the bundle turns its URL into the gate's 404 for everyone holding a license, and
// that is not something the successful-looking "pro blocks bundled: 0" line should hide.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expandLocalDeps, localNamesOf } from "./_registry-deps.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SITE_BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")

/**
 * Assembles the `{ [name]: block }` map the gate serves.
 *
 * `proItems` is pro/registry.json's item list — the source of truth for what is sold, so a stale
 * file left in pro/dist after an item was dropped is not bundled by being on disk. `readBuilt(name)`
 * returns that item's built JSON or null when it was not built. `freeRegistry` is the free
 * registry.json, whose item names are what makes a dependency one of ours, and `base` the site the
 * free components are served from.
 *
 * Returns `{ blocks, missing }`; `missing` names the sold items that had no build output, which is
 * the caller's to report. Inputs are not mutated.
 */
export function bundleProBlocks({ proItems = [], freeRegistry = null, readBuilt, base = "" } = {}) {
  const localNames = localNamesOf(freeRegistry)
  const blocks = {}
  const missing = []

  for (const item of proItems ?? []) {
    // A nameless item cannot be looked up in pro/dist or served by the gate, which keys on the
    // name from the URL. Reported rather than skipped in silence: it is a malformed listing, and
    // the reason it is not for sale should be as visible as an unbuilt one's.
    const name = item?.name
    if (!name) {
      missing.push("(item with no name)")
      continue
    }
    const built = readBuilt(name)
    if (!built) {
      missing.push(name)
      continue
    }
    blocks[name] = Array.isArray(built.registryDependencies)
      ? {
          ...built,
          registryDependencies: expandLocalDeps(built.registryDependencies, localNames, base),
        }
      : built
  }

  return { blocks, missing }
}

// --- CLI: run against the real pro/registry.json, pro/dist and registry.json ---
function main() {
  const outPath = join(ROOT, "functions", "_pro-blocks.js")
  const distDir = join(ROOT, "pro", "dist")
  const proRegPath = join(ROOT, "pro", "registry.json")

  if (!existsSync(proRegPath) || !existsSync(distDir)) {
    // When the Pro set is absent, emit an empty module so a free-core-only deploy still works.
    writeFileSync(outPath, "export const PRO_BLOCKS = {}\n")
    console.log("INFO\tpro not built → functions/_pro-blocks.js = {}")
    return
  }

  const proReg = JSON.parse(readFileSync(proRegPath, "utf8"))
  const freeReg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))

  const { blocks, missing } = bundleProBlocks({
    proItems: proReg.items ?? [],
    freeRegistry: freeReg,
    readBuilt: (name) => {
      const p = join(distDir, `${name}.json`)
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null
    },
    base: SITE_BASE,
  })

  for (const name of missing) console.error(`WARN\tpro item not built: ${name}`)

  writeFileSync(outPath, "export const PRO_BLOCKS = " + JSON.stringify(blocks, null, 2) + "\n")
  console.log(
    `OK\tpro blocks bundled: ${Object.keys(blocks).length} (base ${SITE_BASE})` +
      (missing.length ? ` — ${missing.length} sold but NOT bundled: ${missing.join(", ")}` : "")
  )
}

// Only run the CLI when invoked directly, not when imported by the unit tests — the guard the
// other scripts with a CLI use. It goes through pathToFileURL rather than pasting argv[1] after
// `file://` for the reason build-index.mjs spells out: `import.meta.url` is percent-encoded, so a
// path component needing encoding makes the two strings differ and the block never runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
