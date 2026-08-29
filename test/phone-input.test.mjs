// phone-input assembles one E.164 string out of two controls, and every test here aims at a way
// that assembly is known to go wrong.
//
// The first is the failure this registry has already shipped once, in date-input: a field whose
// on-screen state is richer than the value it emits loses every keystroke but the last as soon as a
// controlled parent stores what it hands back. This component is exactly that shape — country plus
// national digits on screen, one string emitted — and worse than date-input, because a country
// chosen with no digits typed emits "", so a parent echoing "" back could erase the country too.
// The round-trip tests below are that bug, aimed here.
//
// The second is the North American Numbering Plan. Twenty-five countries share +1, and the area
// code belongs to the national number, not to the calling code. A field that stores +1-242 for the
// Bahamas emits a number nobody can dial, and one that infers the country back out of a +1 number
// silently relabels every Caribbean sign-up as American.
//
// The third is the mask. Separators are drawn, not typed, so backspacing over one has to delete the
// digit behind it, and the caret has to be tracked in digits rather than in characters — otherwise
// the field can only be corrected from the end.
//
// The country picker is stubbed. It has its own tests; what matters here is the contract between
// the two — which country reaches it, which list, and what the field does when it answers.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Stands in for the real picker: keeps its props visible and renders nothing. */
const CountrySelect = () => null

const {
  PhoneInput,
  DIAL_CODES,
  PHONE_COUNTRIES,
  getDialCode,
  splitPhoneNumber,
  toE164,
  formatPhoneDigits,
  getRegionCountry,
} = loadComponent(join(ROOT, "registry", "ui", "phone-input.tsx"), {
  stubs: { "@/registry/ui/country-select": { CountrySelect } },
})

/** Drives one field, and lets a test act as the controlled parent that stores what it emits. */
function show(props = {}) {
  const emitted = []
  const countries = []
  let current = { ...props }
  const instance = render(PhoneInput, {
    ...current,
    onValueChange: (v) => emitted.push(v),
    onCountryChange: (c) => countries.push(c),
  })
  const nodes = () => walk(instance.tree)
  const input = () => nodes().find((n) => n.props?.type === "tel")
  const picker = () => nodes().find((n) => n.type === CountrySelect)
  const hidden = (name) =>
    nodes().find((n) => n.props?.type === "hidden" && n.props?.name === name)

  return {
    emitted,
    countries,
    get displayed() {
      return input().props.value
    },
    get country() {
      return picker().props.value
    },
    pickerProps: () => picker().props,
    inputProps: () => input().props,
    hidden,
    /** Types into the number field the way a browser reports it: whole value plus caret. */
    type(value, caret = value.length) {
      input().props.onChange({ target: { value, selectionStart: caret } })
      instance.rerender()
    },
    /** One Backspace or Delete with the caret at `caret` (no selection). */
    press(key, caret) {
      const el = { value: input().props.value, selectionStart: caret, selectionEnd: caret }
      let prevented = false
      input().props.onKeyDown({
        key,
        currentTarget: el,
        defaultPrevented: false,
        preventDefault() {
          prevented = true
        },
      })
      instance.rerender()
      return prevented
    },
    choose(code) {
      picker().props.onValueChange(code)
      instance.rerender()
    },
    /** What a controlled parent does: re-render with the value the field last emitted. */
    storeBack(extra = {}) {
      current = { ...current, ...extra, value: emitted[emitted.length - 1] ?? current.value ?? "" }
      instance.update({
        ...current,
        onValueChange: (v) => emitted.push(v),
        onCountryChange: (c) => countries.push(c),
      })
    },
    update(next) {
      current = { ...current, ...next }
      instance.update({
        ...current,
        onValueChange: (v) => emitted.push(v),
        onCountryChange: (c) => countries.push(c),
      })
    },
  }
}

// --- the table -------------------------------------------------------------

test("every calling code is one to three digits, and the three unassigned countries are absent", () => {
  const bad = Object.entries(DIAL_CODES).filter(([, code]) => !/^[1-9][0-9]{0,2}$/.test(code))
  assert.deepEqual(bad, [], "a calling code that is not one to three digits")
  for (const absent of ["AQ", "HM", "UM"]) {
    assert.equal(DIAL_CODES[absent], undefined, `${absent} has no assigned calling code`)
  }
  assert.equal(PHONE_COUNTRIES.length, Object.keys(DIAL_CODES).length)
})

test("every country in the table is one country-select also offers", () => {
  const source = readFileSync(join(ROOT, "registry", "ui", "country-select.tsx"), "utf8")
  const block = source.match(/export const COUNTRY_CODES = \[([\s\S]*?)\] as const/)[1]
  const iso = new Set([...block.matchAll(/"([A-Z]{2})"/g)].map((m) => m[1]))
  const strangers = PHONE_COUNTRIES.filter((code) => !iso.has(code))
  assert.deepEqual(strangers, [], "a country the picker this composes cannot show")
})

// The property that makes splitting a number unambiguous, and the reason the split can be a loop
// over three lengths rather than a trie: E.164 assigns codes so that no code is a prefix of
// another. If a future edit broke it, splitPhoneNumber would start cutting numbers in the wrong
// place and nothing else here would notice.
test("no calling code is a prefix of another", () => {
  const codes = [...new Set(Object.values(DIAL_CODES))]
  const clashes = []
  for (const a of codes) {
    for (const b of codes) {
      if (a !== b && b.startsWith(a)) clashes.push(`${a} is a prefix of ${b}`)
    }
  }
  assert.deepEqual(clashes, [])
})

test("the North American plan carries the area code in the national number, not the calling code", () => {
  for (const nanp of ["US", "CA", "BS", "JM", "PR", "VI"]) {
    assert.equal(DIAL_CODES[nanp], "1", `${nanp} is +1`)
  }
  assert.equal(DIAL_CODES.GB, "44")
  assert.equal(DIAL_CODES.JE, "44")
})

// --- the pure helpers ------------------------------------------------------

test("splitPhoneNumber takes the longest code, and never guesses at a number with no +", () => {
  assert.deepEqual(splitPhoneNumber("+819012345678"), { dialCode: "81", national: "9012345678" })
  assert.deepEqual(splitPhoneNumber("+1 242 555 0100"), { dialCode: "1", national: "2425550100" })
  assert.deepEqual(splitPhoneNumber("+263771234567"), { dialCode: "263", national: "771234567" })
  // No leading +, so nothing is a calling code: the digits are a national number as they stand.
  assert.deepEqual(splitPhoneNumber("819012345678"), { dialCode: "", national: "819012345678" })
  assert.deepEqual(splitPhoneNumber(""), { dialCode: "", national: "" })
})

test("toE164 is empty until there are national digits", () => {
  assert.equal(toE164("JP", ""), "")
  assert.equal(toE164("", "9012345678"), "")
  assert.equal(toE164("JP", "90 1234 5678"), "+819012345678")
  // E.164 caps the whole number at fifteen digits.
  assert.equal(toE164("JP", "1".repeat(20)), "+81" + "1".repeat(13))
})

test("digits group in threes, with a trailing lone digit folded back", () => {
  assert.equal(formatPhoneDigits("4155550132"), "415 555 0132")
  assert.equal(formatPhoneDigits("415555013"), "415 555 013")
  assert.equal(formatPhoneDigits("4"), "4")
  assert.equal(formatPhoneDigits(""), "")
  assert.equal(formatPhoneDigits("12345678901"), "123 456 789 01")
})

test("a mask overrides the grouping, and keeps digits that outgrow it", () => {
  assert.equal(formatPhoneDigits("9012345678", "## #### ####"), "90 1234 5678")
  assert.equal(formatPhoneDigits("901", "## #### ####"), "90 1")
  assert.equal(formatPhoneDigits("90123456789999", "## ####"), "90 1234 56789999")
  assert.equal(formatPhoneDigits("4155550132", ""), "4155550132")
})

test("getRegionCountry resolves a locale to a country the table knows", () => {
  assert.equal(getRegionCountry("ja-JP"), "JP")
  assert.equal(getRegionCountry("ja"), "JP")
  assert.equal(getRegionCountry("en-GB"), "GB")
  assert.equal(getRegionCountry("qq-ZZ"), "")
})

// --- the field, uncontrolled ----------------------------------------------

test("typing emits the calling code with the digits, and shows them grouped", () => {
  const field = show({ defaultCountry: "JP" })
  assert.equal(field.country, "JP")
  assert.equal(field.inputProps()["aria-describedby"], "harness-id-dial")

  field.type("90")
  assert.equal(field.emitted.at(-1), "+8190")
  field.type("9012345678")
  assert.equal(field.displayed, "901 234 5678")
  assert.equal(field.emitted.at(-1), "+819012345678")
})

test("the number stops at E.164's fifteen digits, counting the calling code", () => {
  const field = show({ defaultCountry: "US" }) // +1 leaves fourteen
  field.type("9".repeat(20))
  assert.equal(field.emitted.at(-1), "+1" + "9".repeat(14))

  const zimbabwe = show({ defaultCountry: "ZW" }) // +263 leaves twelve
  zimbabwe.type("9".repeat(20))
  assert.equal(zimbabwe.emitted.at(-1), "+263" + "9".repeat(12))
})

test("changing the country keeps the digits and re-emits under the new code", () => {
  const field = show({ defaultCountry: "US" })
  field.type("4155550132")
  assert.equal(field.emitted.at(-1), "+14155550132")
  field.choose("JP")
  assert.equal(field.emitted.at(-1), "+814155550132")
  assert.equal(field.displayed, "415 555 0132", "the digits survive the country change")
})

test("pasting an international number moves the country and does not double its code", () => {
  const field = show({ defaultCountry: "US" })
  field.type("+81 90-1234-5678")
  assert.equal(field.emitted.at(-1), "+819012345678")
  assert.equal(field.country, "JP")
  assert.equal(field.countries.at(-1), "JP")
  assert.equal(field.displayed, "901 234 5678")
})

test("a pasted number already on this country leaves the country alone", () => {
  // +1 belongs to twenty-five countries; a Bahamian pasting a Bahamian number must stay Bahamian
  // rather than being relabelled American by the primary-country fallback.
  const field = show({ defaultCountry: "BS" })
  field.type("+1 242 555 0100")
  assert.equal(field.country, "BS")
  assert.equal(field.countries.length, 0, "no country change was announced")
  assert.equal(field.emitted.at(-1), "+12425550100")
})

// --- the field, controlled: the date-input failure aimed here ---------------

test("a controlled parent storing what it emits does not eat the keystrokes", () => {
  const field = show({ value: "", defaultCountry: "JP" })
  for (const [typed, expected] of [
    ["9", "+819"],
    ["90", "+8190"],
    ["901", "+81901"],
  ]) {
    field.type(typed)
    assert.equal(field.emitted.at(-1), expected)
    // The assertion that matters is this one, before the parent has answered. A parent's re-render
    // is a whole render later, and a field that only holds its digits because the value came back
    // is a field that empties itself under a parent that debounces, validates or simply is slow.
    assert.equal(field.displayed, formatPhoneDigits(typed), `${expected} survives a stale prop`)
    field.storeBack()
    assert.equal(field.displayed, formatPhoneDigits(typed), `after storing ${expected}`)
  }
})

test("a controlled parent holding \"\" for an empty number does not lose the chosen country", () => {
  // The country is on screen but not in the value, so a naive re-seed from "" would drop it and the
  // field could never be filled in at all.
  const field = show({ value: "", defaultCountry: "US" })
  field.choose("JP")
  assert.equal(field.emitted.at(-1), "", "no digits yet, so no number to emit")
  field.storeBack()
  assert.equal(field.country, "JP")
  field.type("9012345678")
  assert.equal(field.emitted.at(-1), "+819012345678")
})

test("a controlled value the parent actually changed is pulled back in", () => {
  const field = show({ value: "+819012345678", defaultCountry: "JP" })
  assert.equal(field.displayed, "901 234 5678")
  field.update({ value: "+33612345678" })
  assert.equal(field.displayed, "612 345 678")
  assert.equal(field.country, "FR")
  field.update({ value: "" })
  assert.equal(field.displayed, "")
})

test("a controlled country re-emits the number under the new code", () => {
  const field = show({ country: "US", defaultValue: "" })
  field.type("4155550132")
  assert.equal(field.emitted.at(-1), "+14155550132")
  field.update({ country: "JP" })
  assert.equal(field.emitted.at(-1), "+814155550132")
  assert.equal(field.country, "JP", "the prop stays authoritative")
})

// --- the mask, from the keyboard -------------------------------------------

test("backspace deletes a digit even when the caret sits after a separator", () => {
  const field = show({ defaultCountry: "US" })
  field.type("4155550132")
  assert.equal(field.displayed, "415 555 0132")
  // Caret at offset 4 — just past the space, before "555". Backspace there must take the "5" of
  // "415", not the space that was never typed.
  assert.equal(field.press("Backspace", 4), true, "the component handled the key itself")
  assert.equal(field.displayed, "415 550 132")
  assert.equal(field.emitted.at(-1), "+1415550132")
})

test("delete takes the digit in front of the caret, and neither key fires at the ends", () => {
  const field = show({ defaultCountry: "US" })
  field.type("4155550132")
  assert.equal(field.press("Delete", 3), true)
  assert.equal(field.displayed, "415 550 132")

  const empty = show({ defaultCountry: "US" })
  assert.equal(empty.press("Backspace", 0), false, "nothing before the caret to delete")
  empty.type("415")
  assert.equal(empty.press("Delete", 3), false, "nothing after the caret to delete")
})

// --- what reaches the picker and the form ----------------------------------

test("the picker is only offered countries that have a calling code", () => {
  const field = show({ countries: ["JP", "AQ", "US", "HM"], defaultCountry: "JP" })
  assert.deepEqual(field.pickerProps().countries, ["JP", "US"])
})

test("a narrowed list that leaves out the default starts on one it does offer", () => {
  const field = show({ countries: ["JP", "GB"] })
  assert.equal(field.country, "JP", "not the US default the caller excluded")
})

test("both halves of the answer submit with a native form", () => {
  const field = show({ defaultCountry: "BS", name: "phone", countryName: "phone_country" })
  field.type("2425550100")
  assert.equal(field.hidden("phone").props.value, "+12425550100")
  assert.equal(
    field.hidden("phone_country").props.value,
    "BS",
    "the number alone cannot say which of the twenty-five +1 countries this is"
  )
})

test("the field names itself only when the caller has not wired a label", () => {
  assert.equal(show({ defaultCountry: "US" }).inputProps()["aria-label"], "Phone number")
  assert.equal(show({ defaultCountry: "US", id: "phone" }).inputProps()["aria-label"], undefined)
  assert.equal(
    show({ defaultCountry: "US", "aria-label": "Mobile" }).inputProps()["aria-label"],
    "Mobile"
  )
})
