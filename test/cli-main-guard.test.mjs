// Every script in scripts/ with a CLI block guards it by comparing `import.meta.url` against
// argv[1], so importing it from a test does not also run it. There are two ways to spell that
// comparison and only one of them works:
//
//   import.meta.url === pathToFileURL(process.argv[1]).href   // correct
//   import.meta.url === `file://${process.argv[1]}`           // silently wrong
//
// `import.meta.url` is a percent-encoded URL and argv[1] is a plain path, so one space anywhere in
// the checkout path (`/Users/me/My Projects/pulld`) makes the second form compare `…/a%20b/x.mjs`
// against `…/a b/x.mjs`, the block never runs, and the script exits 0 having done nothing. No
// error, no warning, no output — `npm run registry:build` reports success having written no files.
//
// build-index.mjs, build-pro.mjs and report.mjs each carry a comment explaining this, and
// test/build-index.test.mjs proves it for build-index by running the real script from a path with a
// space in it. Three comments and one test were still not enough: official-coverage.mjs, the most
// recently added script, was written with the broken form. Prose beside eight correct examples does
// not stop the ninth, so the rule lives here now, where adding a script with the wrong guard fails
// the gate instead of waiting for somebody to clone into a path with a space.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPTS = join(ROOT, "scripts")
const TEST = join(ROOT, "test")

const scriptNames = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".mjs"))
  .sort()

/** Code only. The three explanatory comments above mention `file://` on purpose. */
const codeLines = (src) =>
  src
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("*"))

test("the scripts directory is being read at all", () => {
  // A glob that matches nothing is a test that passes without checking anything.
  assert.ok(scriptNames.length >= 9, `expected the scripts/ dir, found ${scriptNames.length} .mjs`)
})

for (const name of scriptNames) {
  const src = readFileSync(join(SCRIPTS, name), "utf8")
  const code = codeLines(src)

  test(`${name} does not build a file:// URL by concatenating a path`, () => {
    // Both spellings of the mistake: a template literal and a plain `+`.
    const offenders = code.filter((line) => /`file:\/\/\$\{|["'`]file:\/\/["'`]\s*\+/.test(line))
    assert.deepEqual(
      offenders,
      [],
      `pasting a path after file:// skips percent-encoding; use pathToFileURL(path).href`
    )
  })

  const guards = code.filter((line) => line.includes("import.meta.url ==="))
  if (guards.length) {
    test(`${name} compares import.meta.url through pathToFileURL`, () => {
      for (const guard of guards) {
        assert.match(
          guard,
          /pathToFileURL\(/,
          `${name}: an import.meta.url comparison must go through pathToFileURL`
        )
      }
    })
  }
}

// The static checks above read the source; this one runs it. official-coverage.mjs is the script
// the rule was broken in, and its CLI block is the only part of it that produces the measurement
// the file exists for — the unit tests all call the exported functions directly, so they passed
// just as happily with a guard that never fired.
//
// Its CLI block calls the global `fetch`, so the real catalogue is replaced with an empty one via
// `--import` (which runs before the entry module and leaves argv[1] alone). An empty catalogue is
// enough: what is under test is whether the block runs, not what it counts.
test("official-coverage's CLI block runs from a path that needs URL-encoding", () => {
  // realpath, because macOS's tmpdir() is a symlink and Node resolves a module's own URL through it
  // while leaving argv[1] as given — which would fail the guard for a reason that has nothing to do
  // with the encoding this test is about.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pulld-guard-")))
  const root = join(tmp, "a b") // the space is the point
  mkdirSync(join(root, "scripts"), { recursive: true })
  copyFileSync(join(SCRIPTS, "official-coverage.mjs"), join(root, "scripts", "official-coverage.mjs"))
  writeFileSync(
    join(root, "offline-fetch.mjs"),
    'globalThis.fetch = async (url) => ({\n' +
      '  ok: true,\n' +
      '  json: async () => (String(url).endsWith("/r/index.json") ? [] : {}),\n' +
      '})\n'
  )

  const out = execFileSync(
    process.execPath,
    ["--import", join(root, "offline-fetch.mjs"), join(root, "scripts", "official-coverage.mjs"), "shiftKey"],
    { encoding: "utf8" }
  )

  assert.notEqual(out.trim(), "", "the CLI block printed nothing — it did not run")
  assert.match(out, /catalogue 0, fetched 0, 404: none/)
  assert.match(out, /files\[\]\.content concatenated = 0 bytes/)
  // The word argument is read from argv too, so this covers the whole CLI path, not just its head.
  assert.match(out, /0\s+shiftKey/)
})

// --- importing an entry point that has no guard ---
//
// Two scripts in scripts/ are not libraries at all. build-landing.mjs and inject-base.mjs are flat
// top-level programs: there is no guard to put the work behind, so `import`ing one does not read
// it, it runs it — against whatever tree the importing process happens to be standing in. Both
// write into public/, which is the directory `npm run deploy` uploads.
//
// The project has already paid for this once. test/_landing-page.mjs and
// test/pro-license-link.test.mjs each ran build-landing.mjs against the repo's own root, and
// `node --test` schedules test FILES concurrently, so `npm test` had two writers on
// public/index.html at the same time. Polling the path during a run caught 36 of 36 reads on a
// partially written file, one of them missing the `id="pro"` that one of those two tests looks for
// in it. Thirty consecutive runs were green anyway, which is what a race looks like right up until
// the day it is not — and the gate it would fail is the one that decides whether a day's work ships.
//
// Both call sites were fixed and the reason left as a comment in each, which is the same shape as
// the `file://` rule at the top of this file: three comments there did not stop a ninth script from
// being written wrong. So this rule is mechanical too — nothing may import a module that executes
// on import.

/** A side-effecting call in column 0: a statement at module scope, which evaluating the file runs. */
const TOP_LEVEL_EFFECT =
  /^(writeFileSync|console\.(log|error|warn)|execFileSync|mkdirSync|rmSync|process\.exit)\(/

/**
 * Whether a module in scripts/ does its work simply by being imported.
 *
 * Read off the raw source, because the indentation IS the signal — `codeLines` above trims, which
 * would make every call inside every function look top-level. Paired with the absence of a guard,
 * since a guarded program keeps its work behind the argv[1] check and is safe to import.
 *
 * Derived rather than written as a list of the two filenames, so giving one of them a guard, or
 * adding a third flat script, moves it out of or into the rule with no edit here.
 */
const selfExecuting = (src) =>
  !src.includes("import.meta.url ===") && src.split("\n").some((line) => TOP_LEVEL_EFFECT.test(line))

const flatPrograms = new Set(
  scriptNames.filter((name) => selfExecuting(readFileSync(join(SCRIPTS, name), "utf8")))
)

/** Whole-line comments dropped, so prose that mentions an import is not read as one. */
const withoutComments = (src) =>
  src
    .split("\n")
    .filter((line) => {
      const t = line.trim()
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    })
    .join("\n")

/**
 * Every double-quoted module specifier a file reaches for, static or dynamic.
 *
 * Both forms, because test/report-scope.test.mjs already uses `await import("../scripts/…")` and a
 * rule that read only `from "…"` would be one `await` away from vacuous. The bare side-effect form
 * `import "…"` is covered by the same pattern, which is the spelling that would hurt most here.
 * A specifier built from a template literal is not knowable without running the file and is left
 * alone; build-pro.test.mjs has the only one, and it points into its own temp tree.
 */
const SPECIFIER = /\b(?:from|import)\s*\(?\s*"([^"]+)"/g

/** The scripts/ files a source imports, by resolving each specifier rather than matching its text. */
function importedScripts(file, src) {
  const found = []
  for (const [, spec] of withoutComments(src).matchAll(SPECIFIER)) {
    if (!spec.startsWith(".")) continue // bare and node: specifiers are not files in this repo
    const target = resolve(dirname(file), spec)
    if (dirname(target) === SCRIPTS) found.push(basename(target))
  }
  return found
}

// test/ helpers included, not just *.test.mjs: test/_landing-page.mjs is not a test file, and it is
// where one of the two historical call sites lived. scripts/ too, because a script importing a flat
// sibling is the same double-write with the same silence.
const importers = [
  ...readdirSync(TEST)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => join(TEST, f)),
  ...scriptNames.map((f) => join(SCRIPTS, f)),
].sort()

test("the classifier still tells a flat program from a guarded one", () => {
  // Pinned against synthetic sources rather than against whichever scripts are flat today: putting
  // a guard on build-landing.mjs would be an improvement and must not read as this rule breaking.
  // What this holds down is that the classifier still answers the question at all — a pattern that
  // has quietly stopped matching would retire the rule below while leaving it green.
  assert.equal(selfExecuting('writeFileSync("out", "x")\n'), true, "a column-0 write is top-level")
  assert.equal(
    selfExecuting('if (import.meta.url === pathToFileURL(process.argv[1]).href) {\n  writeFileSync("out", "x")\n}\n'),
    false,
    "a guarded write is not top-level"
  )
  assert.equal(
    selfExecuting('export const f = () => {\n  writeFileSync("out", "x")\n}\n'),
    false,
    "a write inside a function is not top-level"
  )
})

test("the import scan still finds the imports it is meant to police", () => {
  // The same hazard as the glob at the top of this file: a specifier pattern that matches nothing
  // turns the rule below into a test that passes without reading anything. Most of scripts/ is
  // imported by some test today, so a single digit here means the spelling has drifted.
  const seen = new Set()
  for (const file of importers) {
    for (const name of importedScripts(file, readFileSync(file, "utf8"))) seen.add(name)
  }
  assert.ok(seen.size >= 10, `expected the scripts/ imports, found ${seen.size}: ${[...seen].sort()}`)
})

test("nothing imports a script that executes when it is imported", () => {
  const offences = []
  for (const file of importers) {
    for (const name of importedScripts(file, readFileSync(file, "utf8"))) {
      if (flatPrograms.has(name)) offences.push(`${relative(ROOT, file)} imports ${name}`)
    }
  }
  assert.deepEqual(
    offences,
    [],
    `these scripts run their work on import, against the importing process's own tree — drive them ` +
      `as a subprocess over a temp root instead (test/inject-base.test.mjs, test/_landing-page.mjs)`
  )
})
