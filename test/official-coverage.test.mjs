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

// --- the catalogue request, which has no fallback ---
//
// Every per-item failure already has somewhere to go: the second style, and then `missing`, which is
// printed. The catalogue has neither, and it sets both the denominator and the source text every
// word is counted in. These are the four shapes a failing request takes, measured against the
// function before the check existed: two of them threw `index.map is not a function`, one threw a
// SyntaxError out of `.json()`, and the fourth — a 200 with `[]` — returned a complete-looking
// `catalogue 0, fetched 0, 404: none` with `0` for every word asked about.
//
// What is pinned is that none of the four can come back as a result. The messages are asserted on
// too, because the two that already threw threw usefully enough to be loud and not usefully enough
// to act on: a script the daily routine runs unattended has to name the URL it could not read.

/** A catalogue response of a given shape; no item is ever reached, so items are not modelled. */
const catalogueOnly = (res) => async () => res

test("a catalogue that answers non-ok is refused, not measured", async () => {
  await assert.rejects(
    fetchOfficialSources(catalogueOnly({ ok: false, status: 404, json: async () => ({ error: "nope" }) })),
    (e) => {
      assert.match(e.message, /official catalogue unavailable/)
      assert.match(e.message, /ui\.shadcn\.com\/r\/index\.json/, "the message names the URL")
      assert.match(e.message, /404/, "and the status")
      return true
    }
  )
})

test("a non-ok catalogue with no status still says which request failed", async () => {
  // `fetch` always carries a status, but the stand-ins this project writes do not always, and a
  // message built by interpolating `undefined` is the one that sends somebody to the wrong place.
  await assert.rejects(fetchOfficialSources(catalogueOnly({ ok: false })), (e) => {
    assert.match(e.message, /official catalogue unavailable/)
    assert.doesNotMatch(e.message, /undefined/)
    return true
  })
})

test("an error page served under 200 is named as such, not reported as a SyntaxError", async () => {
  await assert.rejects(
    fetchOfficialSources(
      catalogueOnly({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'")
        },
      })
    ),
    (e) => {
      assert.match(e.message, /official catalogue is not JSON/)
      assert.match(e.message, /Unexpected token/, "the parser's own cause survives")
      return true
    }
  )
})

test("a catalogue that is an object rather than a list is refused", async () => {
  // The shape this script reads changing is a thing to be told about, not to divide by.
  await assert.rejects(
    fetchOfficialSources(catalogueOnly({ ok: true, status: 200, json: async () => ({ items: [] }) })),
    (e) => {
      assert.match(e.message, /official catalogue is not a list/)
      return true
    }
  )
})

test("an empty catalogue is refused, because every word would come back a measured zero", async () => {
  // The one shape that said nothing at all. `0` is documented in this script as evidence that
  // official ships nothing of the kind, so a zero that came from an empty reply must not be
  // available to report — and its 404 list is empty for the only honest reason it could be.
  await assert.rejects(
    fetchOfficialSources(catalogueOnly({ ok: true, status: 200, json: async () => [] })),
    (e) => {
      assert.match(e.message, /official catalogue is empty/)
      return true
    }
  )
})

test("one real item is still enough to measure — the refusal is of nothing, not of little", async () => {
  // The guard above must not have turned "thin" into "broken": a catalogue of one is a catalogue.
  const impl = fakeFetch([{ name: "alpha" }], { "new-york-v4/alpha": { files: [{ content: "ab" }] } })
  const out = await fetchOfficialSources(impl)
  assert.equal(out.total, 1)
  assert.equal(out.got, 1)
  assert.equal(out.sources, "ab")
})
