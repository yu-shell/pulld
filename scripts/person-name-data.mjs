// Derives the set of languages that write the family name before the given name, which is what
// decides the field order registry/ui/name-input.tsx renders.
//
// It exists for the same reason scripts/address-data.mjs does, and it caught the same class of
// mistake. The roadmap entry for name-input named the surname-first cultures from memory as
// "Japan, China, Korea, Hungary". Those four are right, and the list is not: derived from CLDR it
// is eleven languages, and the seven it missed are Khmer, Mongolian, Sinhala, Tamil, Telugu and
// Cantonese alongside them. A form that puts the given name first for a Tamil or Khmer speaker is
// the same defect as putting it first for a Japanese one; there is no way to notice the omission by
// reading the component, so the list is derived and re-derivable instead of written down.
//
// The source is CLDR's person-names data, via cldr-json (Unicode licence):
//   .../cldr-person-names-full/main            -> the locale list
//   .../cldr-person-names-full/main/<loc>/personNames.json
//
// The question asked of each locale is narrower than it looks, and the narrowing is the whole
// point. Each file carries two lists, `givenFirst` and `surnameFirst`, naming *other* locales —
// they answer "when this locale displays a name from that locale, which order does it use". That
// is a question about display, not about forms, and the two give different answers: `en` lists
// `ja ko vi yue zh` as surname-first but *not* `hu`, because an English sentence reorders a
// Hungarian name to Viktor Orbán. Asking `en` therefore loses Hungary, which is how a plausible
// four-item list gets written in the first place.
//
// A form is not displaying someone else's name, it is collecting the reader's own, in the reader's
// own convention. So the question here is whether a locale lists *itself* as surname-first — and
// `hu` does. Measured: 29 of 657 locales self-list, and they are exactly every locale of eleven
// languages. That exactness is asserted rather than assumed (see checkGeneralization): the table
// the component carries is keyed by language, which is only sound while no locale of a
// surname-first language disagrees with its own language. If CLDR ever ships one that does,
// `--check` fails and names it instead of quietly rounding it off.
//
// Usage:
//   node scripts/person-name-data.mjs            prints the TS table, to paste into the component
//   node scripts/person-name-data.mjs --check    compares the component's set against upstream and
//                                                exits 1 on any drift, naming the languages
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const LOCALES =
  "https://api.github.com/repos/unicode-org/cldr-json/contents/cldr-json/cldr-person-names-full/main?ref=main&per_page=100"
const BASE =
  "https://raw.githubusercontent.com/unicode-org/cldr-json/main/cldr-json/cldr-person-names-full/main"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** How many locales are fetched at once. The whole run is 657 files of about 6 KB. */
const CONCURRENCY = 12

/** The language subtag of a locale id — `zh-Hant-MO` is `zh`, `hu` is `hu`. */
export function languageOf(locale) {
  return String(locale).split("-")[0]
}

/**
 * The locale list, refused rather than trusted.
 *
 * Same reasoning as the catalogue check in scripts/official-coverage.mjs: this response decides
 * the denominator *and* every language in the answer, so a response that is not a locale list has
 * no partial reading. An empty array would derive an empty surname-first set and report it as a
 * measurement — "no language writes the surname first" — which is both wrong and quiet.
 */
export async function fetchLocales(fetchImpl = fetch) {
  const res = await fetchImpl(LOCALES)
  if (!res.ok) throw new Error(`locale list: HTTP ${res.status} from ${LOCALES}`)
  const body = await res.json()
  if (!Array.isArray(body) || body.length === 0)
    throw new Error(`locale list: expected a non-empty array from ${LOCALES}`)
  const locales = body.map((entry) => entry?.name).filter((name) => typeof name === "string")
  if (locales.length === 0) throw new Error(`locale list: no names in the response from ${LOCALES}`)
  return locales
}

/**
 * Whether a locale lists its own language as surname-first.
 *
 * Returns `null` for a locale with no person-names data rather than `false`, so "we could not ask"
 * never reads as "it answered given-first".
 */
export function selfOrderOf(locale, json) {
  const personNames = json?.main?.[locale]?.personNames
  if (!personNames) return null
  const surnameFirst = personNames.surnameFirst ?? []
  if (!Array.isArray(surnameFirst)) return null
  return surnameFirst.includes(languageOf(locale)) ? "surnameFirst" : "givenFirst"
}

/** Fetches every locale's person-names data and sorts the locales by the order they self-report. */
export async function fetchNameOrders(fetchImpl = fetch) {
  const locales = await fetchLocales(fetchImpl)
  const surnameFirst = []
  const givenFirst = []
  const missing = []
  const queue = [...locales]

  async function worker() {
    for (;;) {
      const locale = queue.shift()
      if (locale === undefined) return
      const res = await fetchImpl(`${BASE}/${locale}/personNames.json`)
      if (!res.ok) {
        missing.push(locale)
        continue
      }
      const order = selfOrderOf(locale, await res.json())
      if (order === null) missing.push(locale)
      else if (order === "surnameFirst") surnameFirst.push(locale)
      else givenFirst.push(locale)
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return {
    total: locales.length,
    surnameFirst: surnameFirst.sort(),
    givenFirst: givenFirst.sort(),
    missing: missing.sort(),
  }
}

/** The languages behind the surname-first locales, deduplicated. */
export function languagesOf(locales) {
  return [...new Set(locales.map(languageOf))].sort()
}

/**
 * Checks that keying the table by language loses nothing.
 *
 * Two ways it could: a locale of a surname-first language that self-reports given-first (so the
 * language is not uniformly surname-first), and — the same fault read the other way — nothing,
 * since a locale that self-lists always contributes its own language. Only the first is possible,
 * and it is the one that would silently widen the table's claim from "these locales" to "these
 * languages". Returns the offending locales, empty when the generalization is exact.
 */
export function checkGeneralization({ surnameFirst, givenFirst }) {
  const languages = new Set(languagesOf(surnameFirst))
  return givenFirst.filter((locale) => languages.has(languageOf(locale)))
}

/** The set the component carries, read back out of its source. */
export function shippedLanguages(source) {
  const match = source.match(/export const SURNAME_FIRST_LANGUAGES = \[([\s\S]*?)\] as const/)
  if (!match) throw new Error("name-input.tsx: could not find SURNAME_FIRST_LANGUAGES")
  return [...match[1].matchAll(/"([a-z]{2,3})"/g)].map((m) => m[1]).sort()
}

function printTable(languages) {
  console.log("/**")
  console.log(" * The languages whose forms write the family name first, derived from CLDR by")
  console.log(" * `node scripts/person-name-data.mjs`. Run it with `--check` to diff this against upstream.")
  console.log(" */")
  console.log("export const SURNAME_FIRST_LANGUAGES = [")
  console.log(languages.map((lang) => `  "${lang}",`).join("\n"))
  console.log("] as const")
}

async function main() {
  const check = process.argv.includes("--check")
  const orders = await fetchNameOrders()
  const languages = languagesOf(orders.surnameFirst)

  process.stderr.write(
    `cldr person-names — locales ${orders.total}, self surname-first ${orders.surnameFirst.length}` +
      `, given-first ${orders.givenFirst.length}, no data ${orders.missing.length}\n`
  )

  const leaked = checkGeneralization(orders)
  if (leaked.length) {
    console.log(
      `ALERT\tsurname-first languages are no longer uniform — these locales of a surname-first ` +
        `language self-report given-first: ${leaked.join(", ")}. The table must become per-locale.`
    )
    process.exitCode = 1
    return
  }

  if (!check) {
    printTable(languages)
    return
  }

  const shipped = shippedLanguages(
    readFileSync(join(ROOT, "registry", "ui", "name-input.tsx"), "utf8")
  )
  const added = languages.filter((lang) => !shipped.includes(lang))
  const removed = shipped.filter((lang) => !languages.includes(lang))
  if (added.length === 0 && removed.length === 0) {
    console.log(`OK\tname-input matches CLDR — ${languages.length} surname-first languages`)
    return
  }
  if (added.length) console.log(`ALERT\tupstream has, name-input does not: ${added.join(", ")}`)
  if (removed.length) console.log(`ALERT\tname-input has, upstream does not: ${removed.join(", ")}`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
