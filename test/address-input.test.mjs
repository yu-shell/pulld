// address-input renders a different form per country, so the thing that can be wrong is not "does
// it render" but "does it render what that country actually writes" — and that is a claim about 252
// countries which no amount of reading the component can check.
//
// So the expectations here are measured, not recalled. Every per-country assertion below was taken
// from the dataset the table is derived from (Google's Address Data Service, the data behind
// Chrome's address autofill) and several of them contradict what the roadmap entry for this
// component predicted: Japan ships no city field at all, Hong Kong *requires* an area, Singapore
// has no state but a required postal code. A test written from the same memory the component was
// written from asserts nothing.
//
// The other half is the two bug classes this registry has already shipped once each. A controlled
// multi-field input that drops keystrokes is invisible to anyone testing it uncontrolled — that was
// date-input, found only when a harness existed. And a postal-code pattern that is a top-level
// alternation anchors only its first and last branch, so `^GIR ?0AA|…|BFPO ?\d{1,4}$` accepts
// anything at all with a UK postcode somewhere in it. Both have a test here that fails if the guard
// is removed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const COUNTRY_SELECT_SOURCE = readFileSync(
  join(ROOT, "registry", "ui", "country-select.tsx"),
  "utf8"
)
const OFFERED_CODES = [
  ...COUNTRY_SELECT_SOURCE.match(/export const COUNTRY_CODES = \[([\s\S]*?)\] as const/)[1].matchAll(
    /"([A-Z]{2})"/g
  ),
].map((m) => m[1])

const {
  AddressInput,
  fieldsFor,
  rulesFor,
  validateAddress,
  isValidPostalCode,
  postalCodePattern,
  normalizePostalCode,
  emptyAddress,
  FIELD_LABELS,
} = loadComponent(join(ROOT, "registry", "ui", "address-input.tsx"), {
  stubs: {
    "@/registry/ui/country-select": {
      COUNTRY_CODES: OFFERED_CODES,
      // The real one goes through Intl.DisplayNames; the spelling is not what these tests are
      // about, and pinning it keeps them from depending on the runtime's ICU data.
      getCountryName: (code) => `Country ${code}`,
    },
  },
})

const fieldNames = (country, options) => fieldsFor(country, options).map((s) => s.field)
const labelOf = (country, field) =>
  fieldsFor(country).find((s) => s.field === field)?.label ?? null
const requiredOf = (country) =>
  fieldsFor(country)
    .filter((s) => s.required)
    .map((s) => s.field)

/** Renders and reads back the fields as a form would present them. */
const show = (props = {}) => {
  const instance = render(AddressInput, { locale: "en-US", ...props })
  const read = () => {
    const nodes = walk(instance.tree)
    const controls = [...byTag(nodes, "input"), ...byTag(nodes, "select")]
    const labels = byTag(nodes, "label")
    return {
      nodes,
      controls,
      // The country select is the one whose id ends in -country; the rest are address fields.
      country: controls.find((c) => String(c.props.id).endsWith("-country")),
      fields: controls.filter((c) => !String(c.props.id).endsWith("-country")),
      labelFor: (id) => {
        const label = labels.find((l) => l.props.htmlFor === id)
        const children = label?.props.children
        return Array.isArray(children) ? children[0] : children
      },
      alerts: nodes.filter((n) => n.props?.role === "alert"),
    }
  }
  return { instance, read, ...read() }
}

const find = (view, field) => view.fields.find((f) => String(f.props.id).endsWith(`-${field}`))

// ---------------------------------------------------------------------------
// What each country actually writes. Measured, not recalled.
// ---------------------------------------------------------------------------

test("Japan writes postal code, prefecture, street — and has no city field", () => {
  // The roadmap predicted "postal code -> prefecture -> municipality". Upstream's format for JP is
  // `〒%Z%n%S%n%A%n%O%n%N`: there is no %C anywhere in it, because the municipality is written as
  // part of the street-address block. A form that asks a Japanese address for a separate city is
  // asking for a field that address does not have.
  assert.deepEqual(fieldNames("JP", { addressLines: 1 }), [
    "postalCode",
    "administrativeArea",
    "addressLine1",
  ])
  assert.equal(labelOf("JP", "administrativeArea"), "Prefecture")
  assert.deepEqual(requiredOf("JP").sort(), ["addressLine1", "administrativeArea", "postalCode"])
})

test("the United Kingdom has no administrative area, and its city is a post town", () => {
  assert.deepEqual(fieldNames("GB", { addressLines: 1 }), [
    "addressLine1",
    "locality",
    "postalCode",
  ])
  assert.equal(labelOf("GB", "locality"), "Post town")
})

test("Hong Kong requires an area and has no postal code", () => {
  // The roadmap had Hong Kong down as having neither a state nor a postal code. It requires the
  // area — `require: "AS"` — and writes it first, largest unit leading.
  assert.deepEqual(fieldNames("HK", { addressLines: 1 }), [
    "administrativeArea",
    "locality",
    "addressLine1",
  ])
  assert.equal(labelOf("HK", "administrativeArea"), "Area")
  assert.equal(labelOf("HK", "locality"), "District")
  assert.ok(requiredOf("HK").includes("administrativeArea"))
  assert.equal(postalCodePattern("HK"), null)
})

test("Singapore has no administrative area but requires a postal code", () => {
  assert.deepEqual(fieldNames("SG", { addressLines: 1 }), ["addressLine1", "postalCode"])
  assert.deepEqual(requiredOf("SG").sort(), ["addressLine1", "postalCode"])
})

test("Ireland has a townland line, a county and an optional Eircode", () => {
  assert.deepEqual(fieldNames("IE", { addressLines: 1 }), [
    "addressLine1",
    "dependentLocality",
    "locality",
    "administrativeArea",
    "postalCode",
  ])
  assert.equal(labelOf("IE", "dependentLocality"), "Townland")
  assert.equal(labelOf("IE", "administrativeArea"), "County")
  assert.equal(labelOf("IE", "postalCode"), "Eircode")
  // IE overrides no `require`, so it inherits the default: street and town only. The county and the
  // Eircode are optional, which is the whole reason the required set is inherited separately from
  // the field order.
  assert.deepEqual(requiredOf("IE").sort(), ["addressLine1", "locality"])
})

test("the labels follow the name upstream gives the field, not the country", () => {
  assert.equal(labelOf("US", "postalCode"), "ZIP code")
  assert.equal(labelOf("IN", "postalCode"), "PIN code")
  assert.equal(labelOf("AE", "administrativeArea"), "Emirate")
  assert.equal(labelOf("RU", "administrativeArea"), "Oblast")
  assert.equal(labelOf("KR", "administrativeArea"), "Do / Si")
  assert.equal(labelOf("AU", "locality"), "Suburb")
  // The default for a country that says nothing.
  assert.equal(labelOf("FR", "locality"), "City")
  assert.equal(labelOf("FR", "postalCode"), "Postal code")
})

test("a country that is not in the table still gets a usable form", () => {
  // A country list is a moving target, and a form that renders nothing is worse than one that asks
  // for a street and a city.
  assert.deepEqual(fieldNames("ZZ", { addressLines: 1 }), ["addressLine1", "locality"])
  assert.deepEqual(fieldNames("", { addressLines: 1 }), ["addressLine1", "locality"])
  assert.deepEqual(requiredOf("ZZ").sort(), ["addressLine1", "locality"])
})

test("a lower-case country code resolves, because autofill hands them back that way", () => {
  assert.deepEqual(fieldNames("jp", { addressLines: 1 }), fieldNames("JP", { addressLines: 1 }))
  assert.equal(rulesFor(" gb ").country, "GB")
})

// ---------------------------------------------------------------------------
// The table as a whole.
// ---------------------------------------------------------------------------

test("every country country-select offers has address rules", () => {
  // The precedent is phone-input's own check. Without it a country reachable from the selector can
  // fall through to the default silently, and the form asks a Japanese address for a city again.
  const source = readFileSync(join(ROOT, "registry", "ui", "address-input.tsx"), "utf8")
  const table = source.match(
    /const COUNTRY_RULES: Record<string, CountryRule> = \{([\s\S]*?)\n\}/
  )[1]
  const known = new Set([...table.matchAll(/^\s*([A-Z]{2}): \{/gm)].map((m) => m[1]))
  const missing = OFFERED_CODES.filter((code) => !known.has(code))
  assert.deepEqual(missing, [], `countries offered but with no rules: ${missing.join(" ")}`)
  assert.ok(known.size >= OFFERED_CODES.length, `${known.size} rules for ${OFFERED_CODES.length}`)
})

test("every rule is internally consistent and every pattern compiles", () => {
  const source = readFileSync(join(ROOT, "registry", "ui", "address-input.tsx"), "utf8")
  const table = source.match(
    /const COUNTRY_RULES: Record<string, CountryRule> = \{([\s\S]*?)\n\}/
  )[1]
  const codes = [...table.matchAll(/^\s*([A-Z]{2}): \{/gm)].map((m) => m[1])
  assert.ok(codes.length > 240, `only ${codes.length} countries in the table`)
  for (const code of codes) {
    const rule = rulesFor(code)
    assert.match(rule.order, /^[ADCSZ]+$/, `${code}: order "${rule.order}"`)
    assert.equal(new Set(rule.order).size, rule.order.length, `${code}: duplicate field in order`)
    // A field cannot be required if the country does not have it.
    for (const letter of rule.required) {
      assert.ok(rule.order.includes(letter), `${code}: requires ${letter} but does not write it`)
    }
    // Every label type resolves to a word; an unmapped one would render as the raw key.
    for (const type of Object.values(rule.labelTypes)) {
      assert.ok(FIELD_LABELS[type], `${code}: no label for name type "${type}"`)
    }
    if (rule.pattern) {
      assert.doesNotThrow(() => postalCodePattern(code), `${code}: pattern does not compile`)
      assert.ok(postalCodePattern(code) instanceof RegExp)
    }
    // A country with no postal code must not require one, and vice versa.
    if (!rule.order.includes("Z")) assert.ok(!rule.required.includes("Z"), `${code}`)
  }
})

// ---------------------------------------------------------------------------
// Postal codes.
// ---------------------------------------------------------------------------

test("postal codes are checked against their own country's shape", () => {
  const cases = [
    ["US", "62704", true],
    ["US", "62704-1234", true],
    ["US", "6270", false],
    ["JP", "150-0001", true],
    ["JP", "1500001", true],
    ["JP", "15-0001", false],
    ["GB", "SW1A 1AA", true],
    ["GB", "SW1A1AA", true],
    ["GB", "GIR 0AA", true],
    ["GB", "XX1 1XX", false],
    ["CA", "K1A 0B1", true],
    ["CA", "D1A 0B1", false], // D is not a valid leading letter
    ["NL", "1012 AB", true],
    ["NL", "0123 AB", false], // may not start with 0
    ["DE", "10115", true],
    ["DE", "1011", false],
    ["SG", "238823", true],
    ["IE", "D02 AF30", true],
  ]
  for (const [country, code, expected] of cases) {
    assert.equal(
      isValidPostalCode(country, code),
      expected,
      `${country} ${code} should be ${expected ? "valid" : "invalid"}`
    )
  }
})

test("a postal code pattern that is an alternation is still anchored as a whole", () => {
  // The regression guard. The UK's pattern upstream is `GIR ?0AA|(?:AB|AL|…)…|BFPO ?\d{1,4}` — three
  // top-level branches. Anchoring it as `^GIR ?0AA|…|BFPO ?\d{1,4}$` binds `^` to the first branch
  // and `$` to the last only, so every middle branch matches unanchored and junk sails through.
  // Removing the `(?:…)` wrapper in postalCodePattern makes each of these pass.
  for (const junk of [
    "nonsense SW1A 1AA nonsense",
    "SW1A 1AA; DROP TABLE",
    "  prefix GIR 0AA",
    "see BFPO 1234 overleaf",
  ]) {
    assert.equal(isValidPostalCode("GB", junk), false, `GB should reject ${JSON.stringify(junk)}`)
  }
  assert.ok(postalCodePattern("GB").source.startsWith("^(?:"))
})

test("a postal code is matched case-insensitively but stored the way the country writes it", () => {
  // Postal codes are not case-sensitive anywhere, so a lower-case one is accepted...
  assert.equal(isValidPostalCode("GB", "sw1a 1aa"), true)
  assert.equal(isValidPostalCode("CA", "k1a 0b1"), true)
  // ...and capitalised on the way out only where upstream marks the country as writing them in
  // capitals. Ireland is the case that pins the distinction: an Eircode is printed in capitals but
  // upstream does not mark IE `upper`, and overriding it here would be this component's opinion
  // rather than the data's.
  assert.equal(normalizePostalCode("GB", " sw1a  1aa "), "SW1A 1AA")
  assert.equal(normalizePostalCode("CA", "k1a 0b1"), "K1A 0B1")
  assert.equal(normalizePostalCode("IE", "d02 af30"), "d02 af30")
  assert.equal(normalizePostalCode("JP", "  150-0001  "), "150-0001")
})

test("an empty postal code is the required check's business, not the shape check's", () => {
  // A field that is optional and also invalid-when-empty can never be left alone.
  assert.equal(isValidPostalCode("US", ""), true)
  assert.equal(isValidPostalCode("US", "   "), true)
  assert.deepEqual(validateAddress({ ...emptyAddress("IE"), addressLine1: "1 Main St", locality: "Dublin" }), {})
})

test("numeric keyboards only where the postal code cannot contain a letter", () => {
  const modeOf = (country) =>
    fieldsFor(country).find((s) => s.field === "postalCode")?.inputMode ?? null
  assert.equal(modeOf("JP"), "numeric")
  assert.equal(modeOf("DE"), "numeric")
  assert.equal(modeOf("SG"), "numeric")
  assert.equal(modeOf("GB"), null)
  assert.equal(modeOf("CA"), null)
  assert.equal(modeOf("NL"), null)
})

// ---------------------------------------------------------------------------
// Validation and required fields.
// ---------------------------------------------------------------------------

test("validateAddress reports only the fields the country actually uses", () => {
  const errors = validateAddress(emptyAddress("US"))
  assert.deepEqual(Object.keys(errors).sort(), [
    "addressLine1",
    "administrativeArea",
    "locality",
    "postalCode",
  ])
  // Great Britain has no administrative area, so an empty one is not a problem there even when the
  // value still carries it.
  const gb = validateAddress({ ...emptyAddress("GB"), administrativeArea: "stale" })
  assert.deepEqual(Object.keys(gb).sort(), ["addressLine1", "locality", "postalCode"])
})

test("validateAddress reports a bad postal code only once the required check passes", () => {
  const value = { ...emptyAddress("US"), addressLine1: "1 Main St", locality: "Springfield", administrativeArea: "IL", postalCode: "abc" }
  assert.deepEqual(validateAddress(value), { postalCode: "Enter a valid ZIP code" })
})

test("messages are overridable per field label", () => {
  const errors = validateAddress(emptyAddress("JP"), {
    messages: { required: (label) => `${label} を入力してください` },
  })
  assert.equal(errors.administrativeArea, "Prefecture を入力してください")
})

test("labels are overridable by name type, which translates every country that uses it", () => {
  const specs = fieldsFor("JP", { labels: { prefecture: "都道府県" } })
  assert.equal(specs.find((s) => s.field === "administrativeArea").label, "都道府県")
  // And the same override leaves a country that calls it something else alone.
  assert.equal(labelOf("US", "administrativeArea"), "State")
})

// ---------------------------------------------------------------------------
// Autofill tokens.
// ---------------------------------------------------------------------------

test("each field carries the autofill token the browser fills it from", () => {
  const tokens = Object.fromEntries(
    fieldsFor("IE", { addressLines: 2 }).map((s) => [s.field, s.autoComplete])
  )
  assert.deepEqual(tokens, {
    addressLine1: "address-line1",
    addressLine2: "address-line2",
    dependentLocality: "address-level3",
    locality: "address-level2",
    administrativeArea: "address-level1",
    postalCode: "postal-code",
  })
})

test("one address line is a street-address, several are its numbered parts", () => {
  // `street-address` is the whole block and `address-line1` is its first line; a single field
  // labelled `address-line1` is a field the browser fills with half the address.
  assert.equal(fieldsFor("US", { addressLines: 1 })[0].autoComplete, "street-address")
  assert.equal(fieldsFor("US", { addressLines: 2 })[0].autoComplete, "address-line1")
  assert.deepEqual(
    fieldsFor("US", { addressLines: 3 }).slice(0, 3).map((s) => s.autoComplete),
    ["address-line1", "address-line2", "address-line3"]
  )
  // Out-of-range counts are clamped rather than producing an `address-line0` or `address-line4`.
  assert.equal(fieldsFor("US", { addressLines: 9 }).filter((s) => s.field.startsWith("addressLine")).length, 3)
})

test("only the first address line is ever required", () => {
  const specs = fieldsFor("US", { addressLines: 3 })
  assert.equal(specs.find((s) => s.field === "addressLine1").required, true)
  assert.equal(specs.find((s) => s.field === "addressLine2").required, false)
  assert.equal(specs.find((s) => s.field === "addressLine3").required, false)
})

test("a section prefix goes on every token, including the country", () => {
  // Without it a page with a shipping and a billing address hands the browser two fields both
  // claiming to be postal-code.
  for (const spec of fieldsFor("US", { autoCompleteSection: "shipping" })) {
    assert.match(spec.autoComplete, /^shipping /, spec.field)
  }
  const view = show({ autoCompleteSection: "billing", defaultValue: emptyAddress("US") })
  assert.equal(view.country.props.autoComplete, "billing country")
})

test("the country field is autofillable, which is why it is a native select", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.equal(view.country.type, "select")
  assert.equal(view.country.props.autoComplete, "country")
})

// ---------------------------------------------------------------------------
// Rendering, labelling and the controlled path.
// ---------------------------------------------------------------------------

test("the rendered fields are the country's, in the country's order", () => {
  const view = show({ defaultValue: emptyAddress("JP"), addressLines: 1 })
  assert.deepEqual(
    view.fields.map((f) => String(f.props.id).replace("harness-id-", "")),
    ["postalCode", "administrativeArea", "addressLine1"]
  )
})

test("every field has a label pointing at it, and optional ones say so", () => {
  const view = show({ defaultValue: emptyAddress("IE"), addressLines: 1 })
  assert.equal(view.fields.length, 5, "Ireland writes five address fields")
  for (const field of view.fields) {
    assert.ok(view.labelFor(field.props.id), `no label for ${field.props.id}`)
  }
  assert.ok(view.labelFor(view.country.props.id))
  // aria-required rather than the native attribute: the component reports its own messages, and a
  // native bubble on top of them says the same thing twice in a different voice.
  assert.equal(find(view, "locality").props["aria-required"], true)
  assert.equal(find(view, "postalCode").props["aria-required"], false)
})

test("an error appears only after the field has been visited, and is announced", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.equal(view.alerts.length, 0, "nothing is wrong before anything is touched")
  assert.equal(find(view, "locality").props["aria-invalid"], undefined)

  find(view, "locality").props.onBlur()
  view.instance.rerender()
  const after = view.read()
  assert.equal(after.alerts.length, 1)
  assert.equal(after.alerts[0].props.children, "City is required")
  const locality = find(after, "locality")
  assert.equal(locality.props["aria-invalid"], true)
  assert.equal(locality.props["aria-describedby"], after.alerts[0].props.id)
})

test("showErrors surfaces every problem at once, for a submit", () => {
  const view = show({ defaultValue: emptyAddress("US"), showErrors: true })
  assert.equal(view.alerts.length, 4)
})

test("a controlled address is typable — every keystroke survives the round trip", () => {
  // This is the date-input bug, which was invisible uncontrolled and cost a shipped component. If
  // the commit path skips local state when controlled, the parent below stores the value fine but
  // the field renders the stale prop until the parent re-renders, and a test that only looks at
  // onChange would still pass. So this asserts both: what was emitted, and what is on screen.
  let value = emptyAddress("US")
  const emitted = []
  const instance = render(AddressInput, {
    locale: "en-US",
    value,
    onChange: (next) => {
      emitted.push(next)
      value = next
    },
  })
  const controls = () =>
    [...byTag(walk(instance.tree), "input")].filter(
      (c) => !String(c.props.id).endsWith("-country")
    )

  for (const chunk of ["S", "Sp", "Spr", "Spri"]) {
    const city = controls().find((c) => String(c.props.id).endsWith("-locality"))
    city.props.onChange({ target: { value: chunk } })
    instance.update({ locale: "en-US", value, onChange: (next) => { emitted.push(next); value = next } })
  }

  assert.deepEqual(emitted.map((v) => v.locality), ["S", "Sp", "Spr", "Spri"])
  const city = controls().find((c) => String(c.props.id).endsWith("-locality"))
  assert.equal(city.props.value, "Spri", "the field shows what was typed")
})

test("a parent that rebuilds an equal address on every render does not reset the field", () => {
  // The effect that keeps the parent authoritative compares field by field. Comparing by object
  // identity instead would re-seed on every render, which is the same dropped-keystroke symptom
  // arriving by a different route.
  const instance = render(AddressInput, {
    locale: "en-US",
    value: { ...emptyAddress("US"), locality: "Springfield" },
  })
  instance.update({
    locale: "en-US",
    value: { ...emptyAddress("US"), locality: "Springfield" },
  })
  const city = byTag(walk(instance.tree), "input").find((c) =>
    String(c.props.id).endsWith("-locality")
  )
  assert.equal(city.props.value, "Springfield")
})

test("an uncontrolled address keeps what was typed", () => {
  const view = show({ defaultValue: emptyAddress("GB") })
  find(view, "locality").props.onChange({ target: { value: "London" } })
  view.instance.rerender()
  assert.equal(find(view.read(), "locality").props.value, "London")
})

// ---------------------------------------------------------------------------
// Changing the country.
// ---------------------------------------------------------------------------

test("changing the country reshapes the form", () => {
  const view = show({ defaultValue: emptyAddress("US"), addressLines: 1 })
  assert.ok(find(view, "administrativeArea"), "the US has a state")
  view.country.props.onChange({ target: { value: "GB" } })
  view.instance.rerender()
  const after = view.read()
  assert.equal(find(after, "administrativeArea"), undefined, "the UK has none")
  assert.equal(after.labelFor(find(after, "locality").props.id), "Post town")
})

test("changing the country drops the fields the new one does not have, and keeps the rest", () => {
  // Keeping them would mean the value carries a US state while the address is in Hong Kong, and
  // that is what eventually gets submitted.
  const emitted = []
  const view = show({
    defaultValue: {
      ...emptyAddress("US"),
      addressLine1: "1 Main St",
      locality: "Springfield",
      administrativeArea: "IL",
      postalCode: "62704",
    },
    onChange: (next) => emitted.push(next),
  })
  view.country.props.onChange({ target: { value: "HK" } })
  view.instance.rerender()
  const next = emitted.at(-1)
  assert.equal(next.country, "HK")
  assert.equal(next.addressLine1, "1 Main St", "the street survives")
  assert.equal(next.locality, "Springfield", "Hong Kong has a district, so the locality survives")
  assert.equal(next.administrativeArea, "IL", "Hong Kong has an area, so it survives")
  assert.equal(next.postalCode, "", "Hong Kong has no postal code, so the ZIP is dropped")
})

test("a postal code is tidied on blur, not while it is being typed", () => {
  const emitted = []
  const view = show({ defaultValue: emptyAddress("GB"), onChange: (next) => emitted.push(next) })
  find(view, "postalCode").props.onChange({ target: { value: "sw1a  1aa" } })
  view.instance.rerender()
  assert.equal(emitted.at(-1).postalCode, "sw1a  1aa", "left alone mid-word")
  find(view.read(), "postalCode").props.onBlur()
  view.instance.rerender()
  assert.equal(emitted.at(-1).postalCode, "SW1A 1AA")
})

test("the group is labelled, so a screen reader announces what the fields belong to", () => {
  const plain = show({ defaultValue: emptyAddress("US") })
  const group = plain.nodes.find((n) => n.props?.role === "group")
  assert.equal(group.props["aria-label"], "Address")
  const titled = show({ defaultValue: emptyAddress("US"), legend: "Shipping address" })
  const titledGroup = titled.nodes.find((n) => n.props?.role === "group")
  assert.equal(titledGroup.props["aria-label"], undefined)
  assert.ok(titledGroup.props["aria-labelledby"])
})

test("namePrefix makes the address post with a plain form", () => {
  const view = show({ defaultValue: emptyAddress("US"), namePrefix: "shipping" })
  assert.equal(view.country.props.name, "shipping.country")
  assert.equal(find(view, "locality").props.name, "shipping.locality")
  const bare = show({ defaultValue: emptyAddress("US") })
  assert.equal(find(bare, "locality").props.name, undefined)
})

test("the administrative area becomes a select when the subdivisions are supplied", () => {
  const view = show({
    defaultValue: emptyAddress("US"),
    administrativeAreaOptions: [
      { value: "IL", label: "Illinois" },
      { value: "CA", label: "California" },
    ],
  })
  const area = find(view, "administrativeArea")
  assert.equal(area.type, "select")
  assert.equal(area.props.autoComplete, "address-level1", "still autofillable")
  const text = show({ defaultValue: emptyAddress("US") })
  assert.equal(find(text, "administrativeArea").type, "input")
})

test("disabled disables every control, including the country", () => {
  const view = show({ defaultValue: emptyAddress("US"), disabled: true })
  for (const control of view.controls) assert.equal(control.props.disabled, true)
})

// ---------------------------------------------------------------------------
// Holes the mutation run found. Each of these had a mutation survive the suite above.
// ---------------------------------------------------------------------------

test("every field name upstream distinguishes renders as its own word", () => {
  // One country per name type, found by scanning the dataset rather than chosen by hand, so a
  // label silently changing to another word fails here. Twelve of these are the administrative
  // area alone — the field English-speaking forms call "State" and most of the world does not.
  const administrativeArea = {
    AM: "Province", // no override upstream, so it inherits the default
    AS: "State",
    AE: "Emirate",
    BB: "Parish",
    BS: "Island",
    CO: "Department",
    HK: "Area",
    IE: "County",
    JP: "Prefecture",
    KR: "Do / Si",
    NR: "District",
    RU: "Oblast",
  }
  for (const [country, label] of Object.entries(administrativeArea)) {
    assert.equal(labelOf(country, "administrativeArea"), label, country)
  }
  const locality = { AU: "Suburb", GB: "Post town", HK: "District", FR: "City" }
  for (const [country, label] of Object.entries(locality)) {
    assert.equal(labelOf(country, "locality"), label, country)
  }
  const dependentLocality = { BR: "Neighborhood", CN: "District", IE: "Townland", MY: "Village / township", CO: "Suburb" }
  for (const [country, label] of Object.entries(dependentLocality)) {
    assert.equal(labelOf(country, "dependentLocality"), label, country)
  }
  const postal = { US: "ZIP code", IN: "PIN code", IE: "Eircode", FR: "Postal code" }
  for (const [country, label] of Object.entries(postal)) {
    assert.equal(labelOf(country, "postalCode"), label, country)
  }
})

test("the country and the street are labelled with their own words", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.equal(view.labelFor(view.country.props.id), "Country")
  assert.equal(view.labelFor(find(view, "addressLine1").props.id), "Address")
  assert.equal(view.labelFor(find(view, "addressLine2").props.id), "Address line 2")
})

test("two address lines by default — the shape nearly every checkout uses", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.ok(find(view, "addressLine1"), "a street line")
  assert.ok(find(view, "addressLine2"), "and somewhere to put the apartment number")
  assert.equal(find(view, "addressLine3"), undefined)
  assert.equal(fieldsFor("US").filter((s) => s.field.startsWith("addressLine")).length, 2)
  // A caller reaching past the type with 0 still gets a street field rather than none at all.
  assert.equal(fieldsFor("US", { addressLines: 0 }).filter((s) => s.field.startsWith("addressLine")).length, 1)
})

test("a country with no postal code accepts anything, because it has nothing to check", () => {
  // Not the same as rejecting everything, which is what a missing guard here would do: Hong Kong
  // has no postal code at all, so there is no shape for a value to fail to match.
  assert.equal(isValidPostalCode("HK", "whatever"), true)
  assert.equal(isValidPostalCode("HK", ""), true)
  assert.deepEqual(validateAddress({ ...emptyAddress("HK"), addressLine1: "1 Queen's Rd", administrativeArea: "Hong Kong Island" }), {})
})

test("only the postal code of a country that capitals them asks for capitals", () => {
  // autoCapitalize on a city field types LONDON into it. The flag belongs to the one field upstream
  // marks, and to no other.
  const gb = show({ defaultValue: emptyAddress("GB") })
  assert.equal(find(gb, "postalCode").props.autoCapitalize, "characters")
  assert.equal(find(gb, "locality").props.autoCapitalize, undefined)
  assert.equal(find(gb, "addressLine1").props.autoCapitalize, undefined)
  // Japan writes its postal code in digits, so there is nothing to capitalise.
  const jp = show({ defaultValue: emptyAddress("JP") })
  assert.equal(find(jp, "postalCode").props.autoCapitalize, undefined)
})

test("the inputs are text inputs with spellcheck off", () => {
  // A street name underlined in red as a misspelling is noise on every address ever typed.
  const view = show({ defaultValue: emptyAddress("US") })
  for (const field of view.fields) {
    assert.equal(field.props.type, "text", field.props.id)
    assert.equal(field.props.spellCheck, false, field.props.id)
  }
})

test("the country is always required — nothing else can be decided without it", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.equal(view.country.props["aria-required"], true)
})

test("the error ring appears only on the field that has an error", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  assert.ok(!String(find(view, "locality").props.className).includes("border-destructive"))
  find(view, "locality").props.onBlur()
  view.instance.rerender()
  const after = view.read()
  assert.ok(String(find(after, "locality").props.className).includes("border-destructive"))
  assert.ok(!String(find(after, "postalCode").props.className).includes("border-destructive"))
})

test("a postal code survives a country change when the new country has one too", () => {
  // The complement of the Hong Kong case. Both the US and Canada write ACSZ, so nothing should be
  // thrown away — a field dropped here is a person retyping an address they already entered.
  const emitted = []
  const view = show({
    defaultValue: {
      ...emptyAddress("US"),
      addressLine1: "1 Main St",
      addressLine2: "Apt 4",
      locality: "Springfield",
      administrativeArea: "IL",
      postalCode: "62704",
    },
    onChange: (next) => emitted.push(next),
  })
  view.country.props.onChange({ target: { value: "CA" } })
  view.instance.rerender()
  assert.deepEqual(emitted.at(-1), {
    country: "CA",
    addressLine1: "1 Main St",
    addressLine2: "Apt 4",
    addressLine3: "",
    dependentLocality: "",
    locality: "Springfield",
    administrativeArea: "IL",
    postalCode: "62704",
  })
})

test("a controlled parent can change the country, and the form follows", () => {
  // The re-seed compares the country as well as the fields. Comparing only the fields leaves a
  // parent-driven country change rendering the old country's form — a US state box on a UK address.
  const instance = render(AddressInput, {
    locale: "en-US",
    value: { ...emptyAddress("US"), locality: "Springfield" },
    addressLines: 1,
  })
  instance.update({
    locale: "en-US",
    value: { ...emptyAddress("GB"), locality: "London" },
    addressLines: 1,
  })
  const controls = byTag(walk(instance.tree), "input")
  assert.equal(
    controls.find((c) => String(c.props.id).endsWith("-administrativeArea")),
    undefined,
    "the UK has no administrative area"
  )
  assert.equal(controls.find((c) => String(c.props.id).endsWith("-locality")).props.value, "London")
})

test("a malformed locale falls back instead of taking the form down", () => {
  // Intl.Collator throws on a bad tag, and an unsorted country list is a far smaller failure than
  // an address form that will not render.
  assert.doesNotThrow(() => {
    const instance = render(AddressInput, { locale: "not a locale", defaultValue: emptyAddress("US") })
    assert.ok(byTag(walk(instance.tree), "select").length >= 1)
  })
})

test("a dependent locality carries over between two countries that both have one", () => {
  // Ireland and Brazil both write the line above the town, so neither the townland nor the
  // neighbourhood should be thrown away on the way between them. A field missing from the carry-over
  // list is silently dropped, which reads to the person as the form forgetting what they typed.
  const emitted = []
  const view = show({
    defaultValue: { ...emptyAddress("IE"), dependentLocality: "Ballybrit", locality: "Galway" },
    onChange: (next) => emitted.push(next),
  })
  view.country.props.onChange({ target: { value: "BR" } })
  view.instance.rerender()
  assert.equal(emitted.at(-1).dependentLocality, "Ballybrit")
  assert.equal(emitted.at(-1).locality, "Galway")
  assert.equal(view.read().labelFor(find(view.read(), "dependentLocality").props.id), "Neighborhood")
})

test("the form is usable without being told to be — nothing is disabled by default", () => {
  const view = show({ defaultValue: emptyAddress("US") })
  for (const control of view.controls) assert.equal(control.props.disabled, false, control.props.id)
})
