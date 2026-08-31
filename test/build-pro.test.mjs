// What gets bundled into the map the Pro gate serves.
//
// `/pro/` is gitignored in its entirety, so scripts/build-pro.mjs had no test and no way to have
// one: a fresh checkout has no pro/registry.json and no pro/dist to run it against. That is the
// bind functions/_pro-gate.js was split out of its route to escape, and it left the two halves of
// the paid path unevenly covered — the gate that hands a block out is tested, the script that
// decides which blocks exist to hand out was not.
//
// Two things these pin. That a dependency on one of pulld's own free components is published as
// the URL that serves it, which build-pro.mjs used to decide with its own copy of the rule rather
// than scripts/_registry-deps.mjs (`stat-card` and `empty-state`, two of the five the one Pro
// block composes today, are exactly the kind of name a bare spelling resolves to somebody else's
// component under). And that a sold item whose build output is absent is named in the summary:
// it is silently dropped from the bundle, which turns its URL into the gate's 404 for everyone
// holding a license, and the run still exits 0.
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
import { bundleProBlocks } from "../scripts/build-pro.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = "https://pulld.pages.dev"

// The free registry, as build-pro.mjs reads it: its item names are what makes a dependency ours.
const freeRegistry = {
  name: "pulld",
  items: [
    { name: "stat-card", type: "registry:ui" },
    { name: "empty-state", type: "registry:ui" },
  ],
}

const bundle = (proItems, dist, base = BASE) =>
  bundleProBlocks({
    proItems,
    freeRegistry,
    readBuilt: (name) => (name in dist ? structuredClone(dist[name]) : null),
    base,
  })

test("a dependency on one of ours becomes the URL that serves it; nobody else's is touched", () => {
  const { blocks, missing } = bundle(
    [{ name: "dashboard-overview" }],
    {
      "dashboard-overview": {
        name: "dashboard-overview",
        type: "registry:block",
        registryDependencies: [
          "stat-card",
          "empty-state",
          "button",
          "https://example.com/r/x.json",
        ],
      },
    }
  )
  assert.deepEqual(missing, [])
  assert.deepEqual(blocks["dashboard-overview"].registryDependencies, [
    `${BASE}/r/stat-card.json`,
    `${BASE}/r/empty-state.json`,
    // official ships `button`; expanding it would point the install at a component we do not have.
    "button",
    "https://example.com/r/x.json",
  ])
})

test("the rest of the built block is carried through unchanged", () => {
  const built = {
    name: "dashboard-overview",
    type: "registry:block",
    title: "Dashboard Overview",
    files: [{ path: "pro/blocks/dashboard-overview.tsx", type: "registry:block", content: "x" }],
    registryDependencies: ["stat-card"],
  }
  const { blocks } = bundle([{ name: "dashboard-overview" }], { "dashboard-overview": built })
  const out = blocks["dashboard-overview"]
  assert.equal(out.title, "Dashboard Overview")
  assert.deepEqual(out.files, built.files)
  // The gate answers `hasOwnProperty(blocks, name)`, so the key has to be the item's own name.
  assert.deepEqual(Object.keys(blocks), ["dashboard-overview"])
})

test("a block with no registryDependencies is bundled as it was built", () => {
  const { blocks, missing } = bundle([{ name: "solo" }], { solo: { name: "solo", files: [] } })
  assert.deepEqual(missing, [])
  assert.deepEqual(blocks.solo, { name: "solo", files: [] })
})

test("the built block is not mutated — the expansion is written into a copy", () => {
  const built = { name: "b", registryDependencies: ["stat-card"] }
  bundleProBlocks({
    proItems: [{ name: "b" }],
    freeRegistry,
    readBuilt: () => built,
    base: BASE,
  })
  assert.deepEqual(built.registryDependencies, ["stat-card"])
})

test("a sold item with no build output is reported, and the others still ship", () => {
  const { blocks, missing } = bundle(
    [{ name: "dashboard-overview" }, { name: "never-built" }],
    { "dashboard-overview": { name: "dashboard-overview" } }
  )
  assert.deepEqual(Object.keys(blocks), ["dashboard-overview"])
  assert.deepEqual(missing, ["never-built"])
})

test("an item with no name cannot be served, so it is reported rather than skipped quietly", () => {
  const { blocks, missing } = bundle([{ type: "registry:block" }], {})
  assert.deepEqual(blocks, {})
  assert.deepEqual(missing, ["(item with no name)"])
})

test("pro/registry.json decides what is sold — a leftover file in pro/dist is not bundled", () => {
  const { blocks } = bundle([{ name: "current" }], {
    current: { name: "current" },
    "dropped-last-month": { name: "dropped-last-month" },
  })
  assert.deepEqual(Object.keys(blocks), ["current"])
})

test("without a base the names are left as written, rather than made into unresolvable paths", () => {
  const { blocks } = bundle(
    [{ name: "b" }],
    { b: { name: "b", registryDependencies: ["stat-card"] } },
    ""
  )
  assert.deepEqual(blocks.b.registryDependencies, ["stat-card"])
})

// --- the CLI, end to end against a real pro/ tree ---

function fixture(root, { withPro = true } = {}) {
  mkdirSync(join(root, "scripts"), { recursive: true })
  mkdirSync(join(root, "functions"), { recursive: true })
  for (const f of ["build-pro.mjs", "_registry-deps.mjs"]) {
    copyFileSync(join(ROOT, "scripts", f), join(root, "scripts", f))
  }
  writeFileSync(join(root, "registry.json"), JSON.stringify(freeRegistry))
  if (!withPro) return
  mkdirSync(join(root, "pro", "dist"), { recursive: true })
  writeFileSync(
    join(root, "pro", "registry.json"),
    JSON.stringify({
      name: "pulld-pro",
      items: [{ name: "dashboard-overview" }, { name: "never-built" }],
    })
  )
  writeFileSync(
    join(root, "pro", "dist", "dashboard-overview.json"),
    JSON.stringify({ name: "dashboard-overview", registryDependencies: ["stat-card", "button"] })
  )
}

// stderr is piped rather than inherited: the WARN for the unbuilt item is part of what is being
// asserted, not something to print over the test run's own output.
const run = (root, env) =>
  execFileSync(process.execPath, [join(root, "scripts", "build-pro.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })

// The module the gate imports, read back the way it is written — a single `export const`.
async function readBlocks(root) {
  const { PRO_BLOCKS } = await import(
    `${new URL(`file://${join(root, "functions", "_pro-blocks.js")}`)}`
  )
  return PRO_BLOCKS
}

const withTree = async (opts, fn) => {
  // realpath, because macOS's tmpdir() is a symlink and the script resolves its own root through
  // its module URL.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pulld-pro-")))
  try {
    fixture(tmp, opts)
    await fn(tmp)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

test("the module the gate imports carries the URL, and names the block it could not bundle", async () => {
  await withTree({}, async (root) => {
    const out = run(root, { SITE_BASE: BASE })
    assert.deepEqual((await readBlocks(root))["dashboard-overview"].registryDependencies, [
      `${BASE}/r/stat-card.json`,
      "button",
    ])
    // The count alone read as an ordinary success; the dropped block has to be in the line too.
    assert.match(out, /1 sold but NOT bundled: never-built/, out)
  })
})

test("with no pro/ at all the module is still written, so a free-core-only deploy works", async () => {
  await withTree({ withPro: false }, async (root) => {
    const out = run(root, { SITE_BASE: BASE })
    assert.match(out, /pro not built/, out)
    assert.deepEqual(await readBlocks(root), {})
  })
})
