// The catalogue, written a second time under the name official shadcn uses.
//
// pulld's index has always been at /r/registry.json; official's is at /r/index.json, which is the
// path clients built against official probe. The IntelliJ plugin asked for it 1,107 times in
// thirty days and got HTML, then a 404 — pulld's components were never visible through it. These
// tests pin the shape a client written against official can read, and pin that the file keeps
// being generated: it is not referenced by any registry item, so nothing else would notice it
// silently disappearing from the build.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
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
import { buildIndex } from "../scripts/build-index.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const registry = {
  name: "pulld",
  items: [
    {
      name: "copy-button",
      type: "registry:ui",
      title: "Copy Button",
      description: "Copies text and says so.",
      files: [{ path: "registry/ui/copy-button.tsx", type: "registry:ui" }],
    },
    {
      name: "copy-field",
      type: "registry:ui",
      title: "Copy Field",
      description: "A read-only field with a copy affordance.",
      files: [{ path: "registry/ui/copy-field.tsx", type: "registry:ui" }],
      registryDependencies: ["copy-button"],
      dependencies: ["lucide-react"],
    },
  ],
}

test("every item appears, in the field shape official's index uses", () => {
  const index = buildIndex(registry, "https://pulld.pages.dev")
  assert.equal(index.length, 2)
  assert.deepEqual(index[0], {
    name: "copy-button",
    type: "registry:ui",
    title: "Copy Button",
    description: "Copies text and says so.",
    files: [{ path: "registry/ui/copy-button.tsx", type: "registry:ui" }],
    meta: { url: "https://pulld.pages.dev/r/copy-button.json" },
  })
})

test("the description is carried, because it is what an agent matches on", () => {
  // Official's own index omits description entirely. Dropping it here would leave a directory or
  // an agent able to enumerate the catalogue but not to tell what any of it is for.
  for (const entry of buildIndex(registry, "https://pulld.pages.dev")) {
    assert.ok(entry.description, `${entry.name} lost its description`)
    assert.ok(entry.title, `${entry.name} lost its title`)
  }
})

test("file contents are not inlined — the index says what exists, not what it holds", () => {
  const index = buildIndex(registry, "https://pulld.pages.dev")
  for (const entry of index) {
    for (const file of entry.files) {
      assert.deepEqual(Object.keys(file).sort(), ["path", "type"])
    }
  }
})

test("each entry points at the URL a client should fetch to install it", () => {
  const index = buildIndex(registry, "https://pulld.pages.dev/")
  assert.equal(index[1].meta.url, "https://pulld.pages.dev/r/copy-field.json", "trailing slash trimmed")
})

test("without a site base the URLs stay relative rather than becoming broken absolutes", () => {
  const index = buildIndex(registry)
  assert.equal(index[0].meta.url, "/r/copy-button.json")
})

test("dependency fields are carried when present and omitted when not", () => {
  const [plain, composed] = buildIndex(registry, "https://pulld.pages.dev")
  assert.equal("dependencies" in plain, false)
  assert.equal("registryDependencies" in plain, false)
  assert.deepEqual(composed.dependencies, ["lucide-react"])
})

test("a dependency on one of our own components is published as the URL that serves it", () => {
  // The index used to carry the bare name while the per-item file inject-base.mjs writes carried
  // the URL, so one deploy shipped the same dependency spelled two ways. A bare name is resolved
  // against official's registry, and two of the names pulld composes (`spinner`, `kbd`) are names
  // official ships — so the reader gets a different component, not an error it could report.
  const [, composed] = buildIndex(registry, "https://pulld.pages.dev")
  assert.deepEqual(composed.registryDependencies, ["https://pulld.pages.dev/r/copy-button.json"])
})

test("a dependency we do not ship is left alone — it belongs to whoever does", () => {
  const withOfficial = {
    items: [
      registry.items[0],
      {
        ...registry.items[1],
        registryDependencies: ["copy-button", "button", "https://example.com/r/x.json"],
      },
    ],
  }
  assert.deepEqual(buildIndex(withOfficial, "https://pulld.pages.dev")[1].registryDependencies, [
    "https://pulld.pages.dev/r/copy-button.json",
    "button",
    "https://example.com/r/x.json",
  ])
})

test("without a site base a dependency keeps its bare name rather than becoming a relative path", () => {
  // meta.url can fall back to a relative URL because nothing installs from it. A registry
  // dependency is installed from, and `/r/copy-button.json` resolves nowhere at all — strictly
  // worse than the bare name, which at least still names the component.
  assert.deepEqual(buildIndex(registry)[1].registryDependencies, ["copy-button"])
})

test("an empty registry is an empty array, not a throw", () => {
  assert.deepEqual(buildIndex({ name: "pulld" }), [])
  assert.deepEqual(buildIndex({ name: "pulld", items: [] }), [])
})

test("the result serialises to JSON a client can parse", () => {
  const json = JSON.stringify(buildIndex(registry, "https://pulld.pages.dev"))
  const parsed = JSON.parse(json)
  assert.ok(Array.isArray(parsed), "official's index is a bare array")
  assert.equal(parsed[0].name, "copy-button")
})

// The header above says these tests pin that the file keeps being generated. The pure function
// cannot: everything that decides whether public/r/index.json appears lives in the CLI block, and
// that block is guarded by a comparison against `import.meta.url`. Pasting argv[1] after `file://`
// looks equivalent and is not — `import.meta.url` is percent-encoded, so one space anywhere in the
// checkout path makes the two strings differ, the block never runs, the script still exits 0, and
// `npm run registry:build` reports success having written nothing. So run the real script from a
// path with a space in it and require the file on disk, rather than asserting the shape of a guard.
test("the CLI writes the index when run from a path that needs URL-encoding", () => {
  // realpath, because macOS's tmpdir() is a symlink and Node resolves a module's own URL through
  // it while leaving argv[1] as given — which would fail the guard for a reason that has nothing
  // to do with the encoding this test is about.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pulld-index-")))
  try {
    const root = join(tmp, "a b") // the space is the point
    mkdirSync(join(root, "scripts"), { recursive: true })
    for (const f of ["build-index.mjs", "_registry-deps.mjs"]) {
      copyFileSync(join(ROOT, "scripts", f), join(root, "scripts", f))
    }
    writeFileSync(join(root, "registry.json"), JSON.stringify(registry))

    const out = execFileSync(process.execPath, [join(root, "scripts", "build-index.mjs")], {
      encoding: "utf8",
      env: { ...process.env, SITE_BASE: "https://pulld.pages.dev" },
    })

    const written = join(root, "public", "r", "index.json")
    assert.ok(existsSync(written), `index.json was not written — the CLI block did not run:\n${out}`)
    const parsed = JSON.parse(readFileSync(written, "utf8"))
    assert.deepEqual(
      parsed.map((e) => e.name),
      registry.items.map((i) => i.name)
    )
    assert.equal(parsed[0].meta.url, "https://pulld.pages.dev/r/copy-button.json")
    assert.deepEqual(parsed[1].registryDependencies, [
      "https://pulld.pages.dev/r/copy-button.json",
    ])
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
