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
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPTS = join(ROOT, "scripts")

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
