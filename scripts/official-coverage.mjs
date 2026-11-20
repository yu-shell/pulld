// Measures what official shadcn/ui actually ships, so "this is a hole" is a measurement rather than
// a memory.
//
// It exists because the number it prints kept being written down with the method described in prose
// beside it, differently each day — "item JSON connected", "files[].content only", "v4 preferred
// with fallback" — and the roadmap then carries a warning not to compare yesterday's figure with
// today's. A figure that cannot be compared to the previous one is not a measurement. Fixing the
// procedure in code is the only way the series means anything.
//
// The procedure, fixed:
//   - the catalogue is https://ui.shadcn.com/r/index.json
//   - each item is fetched from the new-york-v4 style, falling back to new-york when v4 404s
//   - the total is the concatenation of `files[].content` only — never the JSON around it
// Items that 404 on both are reported by name rather than skipped silently: a shrinking denominator
// would otherwise look like a shrinking registry. A catalogue that does not come back as a non-empty
// list is refused outright (see fetchCatalogue) for the stronger version of the same reason — it
// sets the denominator and the source text both, so there is no partial answer it leaves behind.
//
// Usage: node scripts/official-coverage.mjs [word ...]
//   With words, each is counted in the concatenated sources — that is the "is this a hole" check.
//   A word that is zero everywhere is evidence official has nothing of the kind; a word that is not
//   is a prompt to look at where it occurs before claiming the hole. That reading is what the
//   catalogue check protects: it only holds while the zero is known to be a count of something.

import { pathToFileURL } from "node:url"

const CATALOGUE = "https://ui.shadcn.com/r/index.json"
const STYLES = ["new-york-v4", "new-york"]

// The catalogue request, refused rather than trusted.
//
// It is the one fetch here with no fallback and no second opinion. Every per-item fetch has both:
// two styles are tried, and a name that answers from neither lands in `missing` and is printed. The
// catalogue has neither, and it decides the denominator and the entire word count — so a response
// that is not a catalogue has to stop the run, because the alternative is a measurement.
//
// Measured against the function before this check, over the four shapes a failing request actually
// takes. A 404 carrying a JSON error body, and a 200 carrying an object instead of a list, both
// reached `index.map` and threw `TypeError: index.map is not a function` — loud, but naming a local
// variable rather than the URL or the status, from a script the daily routine runs unattended. A
// 503 carrying an HTML error page threw `SyntaxError: Unexpected token '<'` out of `.json()`, same
// problem. The fourth is the one that said nothing at all: a 200 with `[]` returned
// `catalogue 0, fetched 0, 404: none` and `0 bytes`, and then `0` for every word asked about.
//
// That last line is the whole file. `0` is documented here as "evidence official has nothing of the
// kind" — it is what a roadmap entry gets written on. A zero from an empty reply is indistinguishable
// from a measured one, and it arrives with a 404 list that is empty for the only honest reason it
// could be: nothing was ever asked for. So an empty catalogue is refused too. Official shipping
// nothing is not a state this tool needs to be able to report; it is a state that means the fetch
// did not work.
//
// This is the distinction learn.mjs draws between a baseline of `null` and a baseline of 0, and the
// one scripts/_d1.mjs was written for ("zero installs is a legitimate-looking answer"). A failure
// that has to be told apart from a result cannot be reported as one.
async function fetchCatalogue(fetchImpl) {
  const res = await fetchImpl(CATALOGUE)
  if (!res?.ok) {
    throw new Error(
      `official catalogue unavailable: ${CATALOGUE} answered ${res?.status ?? "a non-ok response"}` +
        ` — no measurement was taken (a zero here is not a zero in the registry)`
    )
  }
  let index
  try {
    index = await res.json()
  } catch (e) {
    throw new Error(
      `official catalogue is not JSON: ${CATALOGUE} answered ok with ${e?.message || e} — this is` +
        ` usually an error page or an interstitial served under 200`
    )
  }
  if (!Array.isArray(index)) {
    throw new Error(
      `official catalogue is not a list: ${CATALOGUE} answered ok with ${typeof index} — the shape` +
        ` this script reads (an array of { name }) has changed`
    )
  }
  if (index.length === 0) {
    throw new Error(
      `official catalogue is empty: ${CATALOGUE} answered ok with 0 items — refused rather than` +
        ` reported, because every word would come back 0 with no 404 list to show why`
    )
  }
  return index
}

export async function fetchOfficialSources(fetchImpl = fetch) {
  const index = await fetchCatalogue(fetchImpl)
  const names = index.map((i) => i.name)
  const missing = []
  let sources = ""
  let got = 0
  for (const name of names) {
    let item = null
    for (const style of STYLES) {
      const res = await fetchImpl(`https://ui.shadcn.com/r/styles/${style}/${name}.json`)
      if (res.ok) {
        item = await res.json()
        break
      }
    }
    if (!item) {
      missing.push(name)
      continue
    }
    got += 1
    for (const file of item.files ?? []) sources += file.content ?? ""
  }
  return { total: names.length, got, missing, sources }
}

/** How many times each word occurs. Plain substring counting — these are identifiers, not prose. */
export function countWords(sources, words) {
  return words.map((word) => ({ word, count: sources.split(word).length - 1 }))
}

// Only run the CLI when invoked directly, not when imported by the unit tests. Through
// pathToFileURL, never argv[1] pasted after `file://`, for the reason build-index.mjs spells
// out: `import.meta.url` is a percent-encoded URL, so one space in the checkout path makes the
// two strings differ and this block never runs. Nothing announces that — the script exits 0
// having printed nothing, which for a measurement tool is the worst possible failure: the
// figure this file exists to make comparable simply does not appear, and the run looks fine.
// test/cli-main-guard.test.mjs enforces the form across every script in scripts/.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { total, got, missing, sources } = await fetchOfficialSources()
  console.log(`official shadcn/ui — catalogue ${total}, fetched ${got}, 404: ${missing.join(", ") || "none"}`)
  console.log(`files[].content concatenated = ${sources.length} bytes (v4 preferred, new-york fallback)`)
  const words = process.argv.slice(2)
  if (words.length) {
    console.log("")
    for (const { word, count } of countWords(sources, words)) {
      console.log(`  ${String(count).padEnd(4)} ${word}`)
    }
  }
}
