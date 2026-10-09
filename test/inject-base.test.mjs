// scripts/inject-base.mjs — the one step of `npm run registry:build` that nothing verified.
//
// It runs only on a deploy. `npm run check` runs `registry:build` with SITE_BASE unset, which is
// the script's documented no-op: it prints one INFO line and exits before touching a file. Only
// `npm run deploy` sets SITE_BASE, and nothing reads what the step writes there — so both of its
// transformations reached production through a gate that never executed them.
//
// What they are is why that matters. shadcn resolves a bare registryDependencies name against the
// official registry, so the absolute URLs written here are the only thing making a self-composed
// pulld component installable at all — and two of the names pulld composes (`spinner`, `kbd`) are
// names official ships, so getting it wrong does not even produce a miss a client could report.
// The `docs` line is the single sentence the CLI prints to somebody who just installed, and the
// only surface that reaches people who arrive through `npx shadcn add` and never load the site.
//
// Run as a subprocess over a temp tree rather than by import, because the script is a flat
// top-level program with no main guard — importing it would run it against the real public/r.
// scripts/ is copied whole so that a new import inside it does not break this test for a reason
// unrelated to what it checks. The precedent is test/cli-main-guard.test.mjs, which copies a
// script into a temp tree for the same reason.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// registry.json's items, and the per-item + catalogue outputs `shadcn build` would leave for them.
// Three components, and exactly one of them composing another: that one dependency is what makes
// "files a dependency moved in" (1) differ from "files this script rewrote" (3), which is the
// distinction the summary line used to blur.
const ITEMS = [
  { name: "copy-button", type: "registry:ui" },
  // `button` is official shadcn's, not ours — a dependency that must survive untouched.
  { name: "code-block", type: "registry:ui", registryDependencies: ["copy-button", "button"] },
  // A component that says something of its own; the catalogue must not talk over it.
  { name: "needs-a-key", type: "registry:ui", docs: "Set PULLD_KEY before using this." },
]

/**
 * A repo-shaped temp tree: the real scripts/, a registry.json of ITEMS, and one public/r output
 * per item plus the two catalogue files `npm run registry:build` produces.
 *
 * realpath, because macOS's tmpdir() is a symlink and the script derives its own root from
 * `import.meta.url`, which Node resolves through it.
 */
function tree({ withBuild = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pulld-inject-")))
  cpSync(join(ROOT, "scripts"), join(root, "scripts"), { recursive: true })
  writeFileSync(join(root, "registry.json"), JSON.stringify({ name: "pulld", items: ITEMS }))
  if (!withBuild) return root

  const rDir = join(root, "public", "r")
  mkdirSync(rDir, { recursive: true })
  for (const item of ITEMS) {
    writeFileSync(join(rDir, `${item.name}.json`), JSON.stringify({ ...item, files: [] }))
  }
  // The catalogue `shadcn build` writes, which carries every item a second time.
  writeFileSync(join(rDir, "registry.json"), JSON.stringify({ name: "pulld", items: ITEMS }))
  // public/r/index.json belongs to scripts/build-index.mjs, which regenerates it in the very next
  // step; anything written here would be discarded. Given a dependency of ours so that leaving it
  // alone is visible rather than vacuous.
  writeFileSync(
    join(rDir, "index.json"),
    JSON.stringify([{ name: "code-block", registryDependencies: ["copy-button"] }])
  )
  return root
}

const run = (root, env = {}) =>
  execFileSync(process.execPath, [join(root, "scripts", "inject-base.mjs")], {
    encoding: "utf8",
    env: { ...process.env, SITE_BASE: "", ...env },
  })

const read = (root, name) => JSON.parse(readFileSync(join(root, "public", "r", name), "utf8"))
const raw = (root, name) => readFileSync(join(root, "public", "r", name), "utf8")

test("without SITE_BASE nothing is written — the case the quality gate runs", () => {
  const root = tree()
  const before = ITEMS.map((i) => raw(root, `${i.name}.json`))
  const out = run(root)
  assert.match(out, /INFO\tSITE_BASE not set/)
  assert.deepEqual(
    ITEMS.map((i) => raw(root, `${i.name}.json`)),
    before,
    "an unset SITE_BASE must leave every output byte-identical"
  )
})

test("without a build output the step says so instead of failing", () => {
  const out = run(tree({ withBuild: false }), { SITE_BASE: "https://example.test" })
  assert.match(out, /INFO\tpublic\/r not found/)
})

test("a dependency on one of ours becomes the URL that serves it; a foreign one does not", () => {
  const root = tree()
  run(root, { SITE_BASE: "https://example.test" })
  assert.deepEqual(read(root, "code-block.json").registryDependencies, [
    "https://example.test/r/copy-button.json",
    "button",
  ])
})

test("the catalogue gets the same expansion as the per-item file", () => {
  // The drift scripts/_registry-deps.mjs was created to stop: the same dependency once shipped
  // spelled as a URL in code-block.json and as a bare name in the catalogue, and a client reading
  // the catalogue got official's component under our name rather than a reportable miss.
  const root = tree()
  run(root, { SITE_BASE: "https://example.test" })
  const fromCatalogue = read(root, "registry.json").items.find((i) => i.name === "code-block")
  assert.deepEqual(fromCatalogue.registryDependencies, [
    "https://example.test/r/copy-button.json",
    "button",
  ])
})

test("public/r/index.json is left for build-index.mjs to regenerate", () => {
  const root = tree()
  const before = raw(root, "index.json")
  run(root, { SITE_BASE: "https://example.test" })
  assert.equal(raw(root, "index.json"), before)
})

test("a trailing slash on SITE_BASE does not become a double slash", () => {
  const root = tree()
  run(root, { SITE_BASE: "https://example.test/" })
  assert.deepEqual(read(root, "code-block.json").registryDependencies[0], "https://example.test/r/copy-button.json")
})

test("the install-time docs line carries the base and the catalogue size", () => {
  const root = tree()
  run(root, { SITE_BASE: "https://example.test" })
  const docs = read(root, "copy-button.json").docs
  assert.match(docs, /"@pulld": "https:\/\/example\.test\/r\/\{name\}\.json"/)
  assert.match(docs, /npx shadcn add @pulld\/<name>/)
  // The count is registry.json's item total, not the number of files that happened to be rewritten.
  assert.match(docs, new RegExp(`All ${ITEMS.length} components: https://example\\.test/\\?utm_source=cli`))
})

test("a component that says something of its own keeps it", () => {
  const root = tree()
  run(root, { SITE_BASE: "https://example.test" })
  assert.equal(read(root, "needs-a-key.json").docs, "Set PULLD_KEY before using this.")
  const fromCatalogue = read(root, "registry.json").items.find((i) => i.name === "needs-a-key")
  assert.equal(fromCatalogue.docs, "Set PULLD_KEY before using this.")
})

test("the summary counts files a dependency moved in, not files it rewrote", () => {
  // The regression this pins. One dependency moves, in one per-item file and in the catalogue, so
  // the honest answer is 2 in 2 — while this tree has three outputs the docs line rewrites as well.
  // Counting those gave "2 in 3 files" here and "22 in 110 files" on the real catalogue, where 12
  // files had a dependency in them: a number that is always the file total cannot show the run
  // where the injection stopped happening.
  const root = tree()
  const out = run(root, { SITE_BASE: "https://example.test" })
  assert.match(out, /injected SITE_BASE into registryDependencies: 2 in 2 files \(https:\/\/example\.test\)/)
})

test("the docs line is counted once per component, not once per file it appears in", () => {
  // Two of the three items have no docs of their own, and each appears twice in what this script
  // rewrites — its own file and the catalogue. Counting visits would say 4.
  const root = tree()
  const out = run(root, { SITE_BASE: "https://example.test" })
  assert.match(out, /injected the install-time docs line into 2 components/)
})
