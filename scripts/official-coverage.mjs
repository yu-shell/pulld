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
// would otherwise look like a shrinking registry.
//
// Usage: node scripts/official-coverage.mjs [word ...]
//   With words, each is counted in the concatenated sources — that is the "is this a hole" check.
//   A word that is zero everywhere is evidence official has nothing of the kind; a word that is not
//   is a prompt to look at where it occurs before claiming the hole.

import { pathToFileURL } from "node:url"

const CATALOGUE = "https://ui.shadcn.com/r/index.json"
const STYLES = ["new-york-v4", "new-york"]

export async function fetchOfficialSources(fetchImpl = fetch) {
  const index = await (await fetchImpl(CATALOGUE)).json()
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
