// Derives the per-country address table that registry/ui/address-input.tsx carries, from the
// dataset Chrome's own address autofill uses.
//
// It exists because the roadmap entry for address-input wrote the field orders from memory and got
// two of them wrong: it had Japan as "postal -> prefecture -> municipality" when Japan ships no
// city field at all (the municipality goes in the street-address block), and it had Hong Kong as
// having neither a state nor a postal code when Hong Kong *requires* an area. A table of 252
// countries cannot be reviewed by reading it, so the only way "this is what that country does" is
// a fact rather than a recollection is to derive it and to be able to re-derive it later.
//
// The source is Google's Address Data Service (the data behind libaddressinput, Apache-2.0):
//   https://chromium-i18n.appspot.com/ssl-address/data        -> ~ separated country list
//   https://chromium-i18n.appspot.com/ssl-address/data/<CC>   -> that country's rules
//   https://chromium-i18n.appspot.com/ssl-address/data/ZZ     -> the defaults every country
//                                                               inherits where it says nothing
//
// Only five things are taken from it, because only five change what a *form* has to render:
//   fmt                   -> which address fields exist and the order they are written in
//   require               -> which of them may not be left empty
//   *_name_type           -> what that country calls the field (state/prefecture/post town/...)
//   zip                   -> the shape of its postal code
//   upper                 -> whether the postal code is written in capitals
// The literal decoration in `fmt` ("〒", "SINGAPORE ", the comma in "%C, %S %Z") is for *printing*
// an address label and is deliberately dropped: a form needs the order and the presence, not the
// punctuation.
//
// Usage:
//   node scripts/address-data.mjs            prints the TS table, to paste into the component
//   node scripts/address-data.mjs --check     compares the component's table against upstream and
//                                             exits 1 on any drift, naming the countries
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"

const BASE = "https://chromium-i18n.appspot.com/ssl-address/data"
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** The `fmt` tokens that are address fields, in the letter this table stores them as. */
const FIELD_TOKENS = { "%A": "A", "%D": "D", "%C": "C", "%S": "S", "%Z": "Z" }

export async function fetchAddressData(fetchImpl = fetch) {
  const root = await (await fetchImpl(BASE)).json()
  const codes = root.countries.split("~").filter(Boolean)
  const zz = await (await fetchImpl(`${BASE}/ZZ`)).json()
  const countries = {}
  for (const cc of codes) {
    const res = await fetchImpl(`${BASE}/${cc}`)
    if (res.ok) countries[cc] = await res.json()
  }
  return { zz, countries }
}

/** The address fields a country writes, in its own order — "ZSA" for Japan, "ACSZ" for the US. */
export function orderOf(fmt) {
  return (fmt.match(/%[ADCSZ]/g) ?? []).map((t) => FIELD_TOKENS[t]).join("")
}

/**
 * One country's rules, with everything it inherits from ZZ left out.
 *
 * A country that says nothing about `fmt` still has fields — it inherits the default order — so the
 * fallback happens here rather than being treated as "no address". 54 of the 252 are in that state
 * and four of them still override `require`, which is why the two are read separately.
 */
export function ruleOf(entry, zz) {
  const rule = { order: orderOf(entry.fmt ?? zz.fmt) }
  const required = entry.require ?? zz.require
  if (required !== zz.require) rule.required = required
  for (const [key, prop] of [
    ["state_name_type", "state"],
    ["locality_name_type", "locality"],
    ["zip_name_type", "postal"],
    ["sublocality_name_type", "sub"],
  ]) {
    if (entry[key] && entry[key] !== zz[key]) rule[prop] = entry[key]
  }
  if (entry.zip) rule.pattern = entry.zip
  if ((entry.upper ?? "").includes("Z")) rule.upperPostal = true
  return rule
}

export function buildTable({ zz, countries }) {
  const table = {}
  for (const cc of Object.keys(countries).sort()) table[cc] = ruleOf(countries[cc], zz)
  return { defaults: { order: orderOf(zz.fmt), required: zz.require }, table }
}

/** The table as the component spells it — one country per line, keys in a fixed order. */
export function printTable({ defaults, table }) {
  const lines = []
  for (const [cc, rule] of Object.entries(table)) {
    const parts = [`order: ${JSON.stringify(rule.order)}`]
    if (rule.required) parts.push(`required: ${JSON.stringify(rule.required)}`)
    for (const key of ["state", "locality", "postal", "sub"]) {
      if (rule[key]) parts.push(`${key}: ${JSON.stringify(rule[key])}`)
    }
    if (rule.pattern) parts.push(`pattern: ${JSON.stringify(rule.pattern)}`)
    if (rule.upperPostal) parts.push("upperPostal: true")
    lines.push(`  ${cc}: { ${parts.join(", ")} },`)
  }
  return `// defaults: order ${JSON.stringify(defaults.order)}, required ${JSON.stringify(
    defaults.required
  )}\n${lines.join("\n")}`
}

/**
 * Reads the table back out of the component source.
 *
 * By text rather than by importing it, because the component is TSX and this script is plain node;
 * the shape being matched is the one `printTable` writes, so a reformat of that block is expected
 * to break this and to be fixed here rather than worked around.
 */
export function readShippedTable(source) {
  const block = source.match(/const COUNTRY_RULES: Record<string, CountryRule> = \{([\s\S]*?)\n\}/)
  if (!block) throw new Error("COUNTRY_RULES block not found in address-input.tsx")
  const shipped = {}
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s*([A-Z]{2}): \{ (.*) \},\s*$/)
    if (!m) continue
    const rule = {}
    // The values are JSON scalars, so the body parses as a JSON object once the keys are quoted.
    const body = m[2].replace(/([a-zA-Z]+):/g, '"$1":')
    Object.assign(rule, JSON.parse(`{${body}}`))
    shipped[m[1]] = rule
  }
  return shipped
}

async function main() {
  const check = process.argv.includes("--check")
  const data = await fetchAddressData()
  const built = buildTable(data)
  if (!check) {
    console.log(printTable(built))
    return
  }
  const source = readFileSync(join(ROOT, "registry", "ui", "address-input.tsx"), "utf8")
  const shipped = readShippedTable(source)
  const drift = []
  const all = new Set([...Object.keys(built.table), ...Object.keys(shipped)])
  for (const cc of [...all].sort()) {
    const a = JSON.stringify(built.table[cc] ?? null)
    const b = JSON.stringify(shipped[cc] ?? null)
    if (a !== b) drift.push(`  ${cc}\n    upstream: ${a}\n    shipped:  ${b}`)
  }
  console.log(
    `address data — upstream ${Object.keys(built.table).length} countries, shipped ${
      Object.keys(shipped).length
    }`
  )
  if (!drift.length) {
    console.log("OK — no drift.")
    return
  }
  console.log(`DRIFT in ${drift.length} countr${drift.length === 1 ? "y" : "ies"}:`)
  console.log(drift.join("\n"))
  process.exitCode = 1
}

// Only when run directly, not when the unit tests import the helpers. Through pathToFileURL for the
// reason build-index.mjs spells out: `import.meta.url` is percent-encoded, so a space in the
// checkout path makes a raw argv[1] comparison differ and this block never runs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
