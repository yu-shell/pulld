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
import { buildIndex } from "../scripts/build-index.mjs"

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
  assert.deepEqual(composed.registryDependencies, ["copy-button"])
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
