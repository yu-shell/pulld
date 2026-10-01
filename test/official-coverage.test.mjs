// The figure this script prints is only worth writing down if the next run produces it the same way.
// These pin the three decisions that made the previous, hand-run figures incomparable: which style
// is fetched, what happens when one 404s, and what exactly is counted.
import { test } from "node:test"
import assert from "node:assert/strict"

import { fetchOfficialSources, countWords } from "../scripts/official-coverage.mjs"

/** A stand-in registry: `items` maps "style/name" to the item JSON that URL serves. */
function fakeFetch(catalogue, items) {
  const asked = []
  const impl = async (url) => {
    asked.push(url)
    if (url.endsWith("/r/index.json")) return { ok: true, json: async () => catalogue }
    const key = url.replace("https://ui.shadcn.com/r/styles/", "").replace(".json", "")
    if (key in items) return { ok: true, json: async () => items[key] }
    return { ok: false, json: async () => ({}) }
  }
  impl.asked = asked
  return impl
}

test("v4 is preferred and the old style is only reached when v4 has nothing", async () => {
  const impl = fakeFetch(
    [{ name: "alpha" }, { name: "beta" }],
    {
      "new-york-v4/alpha": { files: [{ content: "AAAA" }] },
      "new-york/beta": { files: [{ content: "BB" }] },
    }
  )
  const out = await fetchOfficialSources(impl)
  assert.equal(out.got, 2)
  assert.equal(out.sources.length, 6)
  // alpha was answered by v4, so the old style was never asked for it.
  assert.ok(!impl.asked.includes("https://ui.shadcn.com/r/styles/new-york/alpha.json"))
  assert.ok(impl.asked.includes("https://ui.shadcn.com/r/styles/new-york/beta.json"))
})

test("an item missing from both styles is named, not quietly dropped", async () => {
  const impl = fakeFetch([{ name: "alpha" }, { name: "ghost" }], {
    "new-york-v4/alpha": { files: [{ content: "AAAA" }] },
  })
  const out = await fetchOfficialSources(impl)
  assert.equal(out.total, 2, "the denominator is the catalogue, not what was fetched")
  assert.equal(out.got, 1)
  assert.deepEqual(out.missing, ["ghost"])
})

test("only file contents are counted — the JSON around them is not", async () => {
  // The frame is what made one day's figure 245KB and another's 223KB for the same registry.
  const impl = fakeFetch([{ name: "alpha" }], {
    "new-york-v4/alpha": {
      name: "alpha",
      description: "a description long enough to move any total that counted it",
      files: [{ path: "a/very/long/path/that/is/not/content.tsx", content: "abc" }],
    },
  })
  const out = await fetchOfficialSources(impl)
  assert.equal(out.sources, "abc")
})

test("an item with no files at all contributes nothing and is still counted as fetched", async () => {
  const impl = fakeFetch([{ name: "alpha" }], { "new-york-v4/alpha": {} })
  const out = await fetchOfficialSources(impl)
  assert.equal(out.got, 1)
  assert.equal(out.sources, "")
})

test("words are counted as substrings, because they are identifiers", async () => {
  const sources = "if (e.shiftKey && e.altKey) { e.preventDefault() } // shiftKey again"
  assert.deepEqual(countWords(sources, ["shiftKey", "metaKey"]), [
    { word: "shiftKey", count: 2 },
    { word: "metaKey", count: 0 },
  ])
})
