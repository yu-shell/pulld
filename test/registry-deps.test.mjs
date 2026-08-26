// How a dependency on one of pulld's own components is published.
//
// shadcn resolves a bare `registryDependencies` name against the official registry, so a pulld
// component that composes another pulld component has to name it by URL. inject-base.mjs has done
// that to the per-item files since the beginning and the two catalogue files never got it, so one
// deploy shipped the same dependency spelled two ways — and two of the six names pulld composes
// (`spinner`, `kbd`) are names official ships, so the bare spelling resolves to a different
// component rather than to a miss anyone would notice.
//
// inject-base.mjs had no test at all before this file, which is what let the catalogue sit outside
// its reach unremarked: it is the one build step that decides whether six components are
// installable, and nothing ran it except the deploy.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { expandLocalDeps, localNamesOf } from "../scripts/_registry-deps.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = "https://pulld.pages.dev"

const registry = {
  name: "pulld",
  items: [
    { name: "copy-button", type: "registry:ui", files: [{ path: "registry/ui/copy-button.tsx" }] },
    {
      name: "code-block",
      type: "registry:ui",
      files: [{ path: "registry/ui/code-block.tsx" }],
      registryDependencies: ["copy-button"],
    },
  ],
}

test("the names this registry ships are what counts as our own", () => {
  const names = localNamesOf(registry)
  assert.equal(names.has("copy-button"), true)
  assert.equal(names.has("button"), false)
  // An item with no name is not a name — it would otherwise put `undefined` in the set and make
  // every dependency-less entry compare equal to it.
  assert.equal(localNamesOf({ items: [{ type: "registry:ui" }] }).size, 0)
  assert.equal(localNamesOf({}).size, 0)
  assert.equal(localNamesOf(null).size, 0)
})

test("our own names become the URL that serves them; everyone else's are left alone", () => {
  const names = localNamesOf(registry)
  assert.deepEqual(
    expandLocalDeps(["copy-button", "button", "https://example.com/r/x.json"], names, BASE),
    [`${BASE}/r/copy-button.json`, "button", "https://example.com/r/x.json"]
  )
})

test("a trailing slash on the base does not double up in the URL", () => {
  assert.deepEqual(expandLocalDeps(["copy-button"], localNamesOf(registry), `${BASE}/`), [
    `${BASE}/r/copy-button.json`,
  ])
})

test("without a base the list is returned as written", () => {
  const names = localNamesOf(registry)
  assert.deepEqual(expandLocalDeps(["copy-button"], names, ""), ["copy-button"])
  assert.deepEqual(expandLocalDeps(["copy-button"], names, undefined), ["copy-button"])
})

test("a non-list, and a non-string inside a list, survive untouched", () => {
  const names = localNamesOf(registry)
  assert.equal(expandLocalDeps(undefined, names, BASE), undefined)
  assert.deepEqual(expandLocalDeps([null, 7, "copy-button"], names, BASE), [
    null,
    7,
    `${BASE}/r/copy-button.json`,
  ])
})

test("the input list is not mutated — callers compare against it to decide whether to write", () => {
  const deps = ["copy-button"]
  expandLocalDeps(deps, localNamesOf(registry), BASE)
  assert.deepEqual(deps, ["copy-button"])
})

// --- inject-base.mjs, end to end against a real public/r ---

// The three shapes public/r holds: one component, the catalogue `shadcn build` writes, and the
// catalogue build-index.mjs writes at official's path (a bare array).
function fixture(root) {
  mkdirSync(join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, "public", "r"), { recursive: true })
  for (const f of ["inject-base.mjs", "_registry-deps.mjs"]) {
    copyFileSync(join(ROOT, "scripts", f), join(root, "scripts", f))
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify(registry))
  const item = { name: "code-block", type: "registry:ui", registryDependencies: ["copy-button"] }
  writeFileSync(join(root, "public", "r", "code-block.json"), JSON.stringify(item))
  writeFileSync(
    join(root, "public", "r", "registry.json"),
    JSON.stringify({ name: "pulld", items: [item] })
  )
  writeFileSync(join(root, "public", "r", "index.json"), JSON.stringify([item]))
}

const run = (root, env) =>
  execFileSync(process.execPath, [join(root, "scripts", "inject-base.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })

const readDeps = (root, file) => {
  const doc = JSON.parse(readFileSync(join(root, "public", "r", file), "utf8"))
  const item = Array.isArray(doc) ? doc[0] : (doc.items?.[0] ?? doc)
  return item.registryDependencies
}

const withTree = (fn) => {
  // realpath, because macOS's tmpdir() is a symlink and the script resolves its own root through
  // its module URL.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pulld-inject-")))
  try {
    fixture(tmp)
    fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test("every file that publishes a dependency gets the URL, catalogues included", () => {
  withTree((root) => {
    const out = run(root, { SITE_BASE: BASE })
    for (const file of ["code-block.json", "registry.json", "index.json"]) {
      assert.deepEqual(
        readDeps(root, file),
        [`${BASE}/r/copy-button.json`],
        `${file} still ships the bare name:\n${out}`
      )
    }
  })
})

test("without SITE_BASE nothing is rewritten, so a half-injected build is never written out", () => {
  withTree((root) => {
    run(root, { SITE_BASE: "" })
    for (const file of ["code-block.json", "registry.json", "index.json"]) {
      assert.deepEqual(readDeps(root, file), ["copy-button"], file)
    }
  })
})

test("a second run changes nothing — the URLs it wrote are not names to expand again", () => {
  withTree((root) => {
    run(root, { SITE_BASE: BASE })
    const after = run(root, { SITE_BASE: BASE })
    assert.match(after, /: 0 in 0 files/, `re-ran the injection:\n${after}`)
    assert.deepEqual(readDeps(root, "registry.json"), [`${BASE}/r/copy-button.json`])
  })
})
