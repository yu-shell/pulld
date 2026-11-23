// What a deployed Pages Function is allowed to import.
//
// `wrangler pages deploy` uploads public/ and compiles the project-root functions/ directory
// alongside it (test/deploy-gate.test.mjs says so where it puts `node --test` in front of the
// upload). Everything a module under functions/ imports is therefore bundled into a Worker and
// evaluated in the Workers runtime, which has no filesystem, no child processes, and — wrangler.toml
// declares no `nodejs_compat` flag — no Node built-ins at all.
//
// scripts/ is the opposite kind of code: build scripts that read and write the tree through
// node:fs, shell out to `npx wrangler` through node:child_process, and in two cases
// (build-landing.mjs, inject-base.mjs) do their work simply by being imported. One edge between the
// two trees already exists and runs the safe way round — scripts/_installs.mjs imports
// functions/_traffic.js, so "who fetched this" has one definition rather than two. The reverse edge
// is the one that cannot exist.
//
// It has already been reached for. functions/_pro-gate.js builds its paywall link around the `id`
// that scripts/build-landing.mjs puts on the landing page's Pro section, and the obvious move is
// the one scripts/_landing-markup.mjs exists to make: hold the string once, import it from both
// sides. The Function cannot, and both files say why in prose —
//
//   functions/_pro-gate.js:  "this module is bundled into the deployed Function, so it must not
//                             import a build script"
//   test/pro-license-link.test.mjs: "this module is bundled into the deployed Cloudflare Function,
//                             so it must not import anything from scripts/"
//
// — and the agreement was pinned by a test on the two sides' output instead. So the rule was
// understood, written down twice, and worked around once, with nothing checking it. That is the
// state test/cli-main-guard.test.mjs was written for after three comments failed to stop a ninth
// script: "prose beside eight correct examples does not stop the ninth, so the rule lives here now".
//
// Nothing would catch the next attempt before a customer does. functions/ is excluded from tsconfig
// (functions/_pro-gate.js: its handlers have `node --test` coverage "precisely because functions/ is
// excluded from tsconfig and that is its only automated check"), and `node --test` imports a handler
// into Node, where node:fs resolves perfectly and a build script's top-level write lands in the real
// public/. Every signal in `npm run check` is green for an import that cannot run in production. The
// handlers behind it are the Polar webhook that provisions and revokes paid access, the Pro license
// gate, the /r/*.json log, and the search endpoints.
//
// Derived by resolving each specifier rather than by matching its text, and over every file under
// functions/ rather than the routes alone: a shared module like api/search/_lib.js is bundled into
// every route that imports it, so the rule has to hold for it too. Because every such file is
// scanned, a direct-edge check is the whole closure — the bundle can only leave functions/ through
// an import written in a file inside it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const FUNCTIONS = join(ROOT, "functions")
const WRANGLER = join(ROOT, "wrangler.toml")

/** Every module file under functions/, at any depth — the routes and the shared modules alike. */
function modulesUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...modulesUnder(path))
    else if (/\.(js|mjs|cjs|ts)$/.test(entry.name)) out.push(path)
  }
  return out.sort()
}

const bundled = modulesUnder(FUNCTIONS)

/** Whole-line comments dropped, so prose that quotes an import is not read as one. */
const withoutComments = (src) =>
  src
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    })
    .join("\n")

/**
 * Every module specifier a file reaches for: `import … from`, a bare `import "…"`, `export … from`,
 * and the dynamic `import("…")`. Both quote styles, matched over the whole source rather than
 * line by line, because the multi-line `import {\n … \n} from "./_lib.js"` that ingest.js and
 * query.js use puts the specifier on a line with no `import` on it.
 */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*(["'])([^"']+)\1/g

const specifiersOf = (src) =>
  [...withoutComments(src).matchAll(SPECIFIER)].map((m) => m[2])

/** Is `file` inside `dir`? Compared as paths, never as a prefix of the string. */
const isUnder = (dir, file) => file === dir || file.startsWith(dir + sep)

/**
 * A specifier naming a Node built-in, in either spelling. Taken from node:module's own list rather
 * than from a hand-written one, so a built-in added to Node is covered without an edit here; the
 * first path segment, so `node:fs/promises` and `fs/promises` are the built-in they are part of.
 */
const isNodeBuiltin = (spec) => {
  const bare = String(spec).replace(/^node:/, "")
  return String(spec).startsWith("node:") || builtinModules.includes(bare.split("/")[0])
}

/** One `{ file, spec }` per import written in a bundled module. */
const edges = bundled.flatMap((file) =>
  specifiersOf(readFileSync(file, "utf8")).map((spec) => ({ file, spec }))
)
const relativeEdges = edges.filter((e) => e.spec.startsWith("."))

test("the functions directory is being read at all", () => {
  // A walk that matches nothing is a rule that passes without checking anything — the hazard the
  // globs in test/cli-main-guard.test.mjs guard against for the same reason.
  assert.ok(
    bundled.length >= 10,
    `expected the modules under functions/, found ${bundled.length}`
  )
  for (const route of [
    join(FUNCTIONS, "_traffic.js"),
    join(FUNCTIONS, "_pro-gate.js"),
    join(FUNCTIONS, "api", "search", "query.js"),
    join(FUNCTIONS, "r", "[[path]].js"),
  ]) {
    assert.ok(bundled.includes(route), `the walk missed ${relative(ROOT, route)}`)
  }
})

test("the import scan still finds the imports it is meant to police", () => {
  // Most of functions/ imports a sibling today, and two of those imports are multi-line. A single
  // digit here means the specifier pattern or the comment stripper has drifted and the rules below
  // are reading an empty list.
  assert.ok(
    relativeEdges.length >= 6,
    `expected the imports under functions/, found ${relativeEdges.length}: ` +
      relativeEdges.map((e) => `${relative(ROOT, e.file)} → ${e.spec}`).join(", ")
  )
  // The shape the scan has to cope with, pinned against synthetic sources rather than against
  // whichever files happen to be written that way today.
  assert.deepEqual(specifiersOf('import {\n  json,\n} from "./_lib.js"\n'), ["./_lib.js"])
  assert.deepEqual(specifiersOf('const m = await import("../_traffic.js")\n'), ["../_traffic.js"])
  assert.deepEqual(specifiersOf('// see scripts/build-landing.mjs, imported from "../scripts/x.mjs"\n'), [])
})

test("the escape and built-in classifiers still answer the question", () => {
  const route = join(FUNCTIONS, "r", "pro", "[[path]].js")
  // A sibling and the uncommitted block map (which may not exist in this checkout) stay inside;
  // reaching up into scripts/ does not.
  assert.equal(isUnder(FUNCTIONS, resolve(dirname(route), "../../_pro-gate.js")), true)
  assert.equal(isUnder(FUNCTIONS, resolve(dirname(route), "../../_pro-blocks.js")), true)
  assert.equal(
    isUnder(FUNCTIONS, resolve(dirname(route), "../../../scripts/_landing-markup.mjs")),
    false,
    "the exact import _pro-gate.js wanted and could not have"
  )
  // A sibling directory whose name starts with "functions" is not inside functions/.
  assert.equal(isUnder(FUNCTIONS, `${FUNCTIONS}-legacy${sep}x.js`), false)
  for (const spec of ["node:fs", "fs", "node:child_process", "node:fs/promises", "fs/promises"]) {
    assert.equal(isNodeBuiltin(spec), true, `${spec} is a Node built-in`)
  }
  for (const spec of ["./_lib.js", "lucide-react", "react"]) {
    assert.equal(isNodeBuiltin(spec), false, `${spec} is not a Node built-in`)
  }
})

test("every module a Pages Function imports lives under functions/", () => {
  const escapes = relativeEdges
    .filter((e) => !isUnder(FUNCTIONS, resolve(dirname(e.file), e.spec)))
    .map((e) => `${relative(ROOT, e.file)} imports ${e.spec}`)
  assert.deepEqual(
    escapes,
    [],
    "this module is bundled into a deployed Worker, so an import that leaves functions/ ships " +
      "with it — a build script brings node:fs and node:child_process into a runtime that has " +
      "neither, and scripts/build-landing.mjs and scripts/inject-base.mjs do their work on import. " +
      "`node --test` and `tsc` both pass on one, because in Node it resolves. Share the value the " +
      "way functions/_pro-gate.js and scripts/build-landing.mjs share the Pro section's id: pin the " +
      "two sides' output in a test (test/pro-license-link.test.mjs), not the string in an import."
  )
})

test("no Pages Function imports a Node built-in", () => {
  const toml = existsSync(WRANGLER) ? readFileSync(WRANGLER, "utf8") : ""
  // The rule is a consequence of the deploy config, so it is read off the config. Adding
  // `nodejs_compat` to compatibility_flags is what makes node: imports available in the Workers
  // runtime, and it is a deliberate, visible change; until it is made, a node: import is a Function
  // that cannot boot. The assertion below keeps this from retiring the rule by accident.
  assert.match(
    toml,
    /pages_build_output_dir/,
    `${relative(ROOT, WRANGLER)} is not the Pages config this rule reads — the compatibility ` +
      `flags it is conditioned on are no longer being checked`
  )
  if (/nodejs_compat/.test(toml)) return

  const offenders = edges
    .filter((e) => isNodeBuiltin(e.spec))
    .map((e) => `${relative(ROOT, e.file)} imports ${e.spec}`)
  assert.deepEqual(
    offenders,
    [],
    "wrangler.toml declares no `nodejs_compat` flag, so the Workers runtime provides no Node " +
      "built-ins — this import resolves under `node --test`, which is functions/'s only automated " +
      "check, and fails in production"
  )
})
