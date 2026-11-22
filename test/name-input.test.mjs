// name-input renders a different form per locale, so the thing that can be wrong is not "does it
// render" but "does it render what that locale actually writes" — and the design note for this
// component got that wrong in a way reading the component cannot catch. It named the surname-first
// cultures as "Japan, China, Korea, Hungary". Derived from CLDR the answer is eleven languages, and
// the seven it left out (Khmer, Mongolian, Sinhala, Tamil, Telugu, Cantonese, and Hungarian only
// surviving by luck — see below) each get a reversed form.
//
// So the expectations here are measured, not recalled. Every language asserted below was taken from
// CLDR's person-names data by scripts/person-name-data.mjs, which asks each of 657 locales whether
// it lists *itself* as surname-first. That question matters: the obvious one — read `en`'s
// `surnameFirst` list — returns `ja ko vi yue zh` and *drops Hungary*, because an English sentence
// reorders a Hungarian name to Viktor Orbán. A test written against `en`'s view would pass while the
// component asked Hungarian readers for their name backwards.
//
// The second half is the two defects this registry has already shipped once each, plus the one this
// component is uniquely able to ship. A controlled multi-field input that drops keystrokes is
// invisible to anyone testing it uncontrolled — that was date-input. A required field that a large
// population cannot fill corrupts the column instead of filling it — that was address-input's
// required state, and here it is the family name. And the new one: the phonetic fields have no
// autofill token, so the tempting repair is to reuse `given-name`, which tells the browser to fill
// the *written* name into the reading box. Each has a test here that fails if the guard is removed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"
import { shippedLanguages, languageOf as scriptLanguageOf } from "../scripts/person-name-data.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE_PATH = join(ROOT, "registry", "ui", "name-input.tsx")
const SOURCE = readFileSync(SOURCE_PATH, "utf8")

const {
  NameInput,
  SURNAME_FIRST_LANGUAGES,
  DEFAULT_REQUIRED,
  FIELD_LABELS,
  nameOrderFor,
  languageOf,
  resolveOrder,
  fieldsFor,
  validateName,
  formatName,
  emptyName,
} = loadComponent(SOURCE_PATH)

const fieldNames = (options) => fieldsFor(options).map((spec) => spec.field)
const tokenOf = (field, options) =>
  fieldsFor(options).find((spec) => spec.field === field)?.autoComplete ?? null

/** Renders and reads back the fields as a form would present them. */
const show = (props = {}) => {
  const instance = render(NameInput, { locale: "en-US", ...props })
  // The harness marks state dirty but does not re-settle on its own, so reading is what a
  // commit would be: settle first, then look at the tree.
  const read = () => {
    instance.rerender()
    const nodes = walk(instance.tree)
    const inputs = byTag(nodes, "input")
    const labels = byTag(nodes, "label")
    return {
      nodes,
      inputs,
      checkbox: inputs.find((i) => i.props.type === "checkbox"),
      fields: inputs.filter((i) => i.props.type === "text"),
      labelFor: (id) => {
        const label = labels.find((l) => l.props.htmlFor === id)
        const children = label?.props.children
        return Array.isArray(children) ? children[0] : children
      },
      alerts: nodes.filter((n) => n.props?.role === "alert"),
      group: nodes.find((n) => n.props?.role === "group"),
    }
  }
  return { instance, read, ...read() }
}

const find = (view, field) => view.fields.find((f) => String(f.props.id).endsWith(`-${field}`))
const order = (view) =>
  view.fields.map((f) => String(f.props.id).replace(/^.*?-(?=[^-]+$)/, ""))

// ---------------------------------------------------------------------------
// Which languages write the family name first. Measured, not recalled.
// ---------------------------------------------------------------------------

test("every language CLDR reports as self surname-first is one, and there are eleven", () => {
  // The exact set `node scripts/person-name-data.mjs` derived: 657 locales asked, 29 self-report
  // surname-first, and they are every locale of exactly these eleven languages. Pinned here so a
  // hand-edit of the table is caught without the network, and so the four-item list the roadmap
  // carried cannot come back.
  assert.deepEqual([...SURNAME_FIRST_LANGUAGES], [
    "hu",
    "ja",
    "km",
    "ko",
    "mn",
    "si",
    "ta",
    "te",
    "vi",
    "yue",
    "zh",
  ])
  for (const language of SURNAME_FIRST_LANGUAGES) {
    assert.equal(nameOrderFor(language), "surnameFirst", language)
  }
})

test("the seven languages the design note missed are surname-first", () => {
  // The note said "Japan, China, Korea, Hungary". These are the ones it did not say, and each is a
  // population that would meet a reversed form. This test is the one that fails if the table is
  // ever "simplified" back to the memorable four.
  for (const language of ["km", "mn", "si", "ta", "te", "yue"]) {
    assert.equal(nameOrderFor(language), "surnameFirst", language)
  }
})

test("Hungarian is surname-first, which asking `en` would have got wrong", () => {
  // CLDR's `en` file lists `ja ko vi yue zh` as surname-first and omits `hu`, because displaying a
  // Hungarian name in English reorders it. The derivation asks whether `hu` lists *itself*, and it
  // does. If anyone re-derives this table from `en`'s list, this assertion is what breaks.
  assert.equal(nameOrderFor("hu"), "surnameFirst")
  assert.equal(nameOrderFor("hu-HU"), "surnameFirst")
})

test("given-first is the default, including for CLDR's own root locale", () => {
  // `und` lists itself given-first, so the fallback is measured rather than an Anglocentric guess.
  for (const locale of ["und", "en", "en-US", "en-GB", "de", "fr-CA", "es-MX", "is", "id", "fil"]) {
    assert.equal(nameOrderFor(locale), "givenFirst", locale)
  }
})

test("the order follows the language subtag, whatever decorates it", () => {
  for (const locale of ["ja-JP", "zh-Hant-MO", "zh-Hans-SG", "ko-KP", "ta-SG", "yue-Hant-CN"]) {
    assert.equal(nameOrderFor(locale), "surnameFirst", locale)
  }
  // Case and the underscore form some runtimes hand back.
  assert.equal(nameOrderFor("JA"), "surnameFirst")
  assert.equal(nameOrderFor("ja_JP"), "surnameFirst")
  assert.equal(languageOf("zh-Hant-MO"), "zh")
  assert.equal(languageOf("YUE-hant"), "yue")
})

test("a malformed or missing locale falls back instead of throwing", () => {
  // This runs on whatever a caller puts in `locale`, inside a form's render. An exception here is a
  // blank page; the wrong order is a form that still works.
  for (const locale of [undefined, null, "", "x", "!!!", "   ", 42, {}]) {
    assert.equal(nameOrderFor(locale), "givenFirst", String(locale))
  }
  assert.equal(languageOf(undefined), "")
})

test("resolveOrder prefers an explicit order and defaults to the hydration locale", () => {
  assert.equal(resolveOrder({}), "givenFirst")
  assert.equal(resolveOrder({ locale: "ja" }), "surnameFirst")
  assert.equal(resolveOrder({ locale: "ja", order: "givenFirst" }), "givenFirst")
  assert.equal(resolveOrder({ locale: "en", order: "surnameFirst" }), "surnameFirst")
})

test("the shipped table is the one the derivation script reads back", () => {
  // `--check` parses the table out of the source. If the declaration is reformatted so the regex
  // misses it, the daily check starts throwing instead of comparing — so the parser is tested
  // against the real file rather than a fixture.
  assert.deepEqual(shippedLanguages(SOURCE), [...SURNAME_FIRST_LANGUAGES].sort())
  assert.equal(scriptLanguageOf("zh-Hant"), "zh")
})

// ---------------------------------------------------------------------------
// The fields, and the order they come in.
// ---------------------------------------------------------------------------

test("a given-first form asks for the given name first", () => {
  assert.deepEqual(fieldNames({ locale: "en-US" }), ["given", "surname"])
  assert.deepEqual(fieldNames({ locale: "en-US", additional: true }), [
    "given",
    "additional",
    "surname",
  ])
})

test("a surname-first form reverses it, keeping the middle name in the middle", () => {
  // CLDR's own patterns: `{given} {given2} {surname}` and `{surname} {given2} {given}`. The middle
  // name does not move to an end.
  assert.deepEqual(fieldNames({ locale: "ja-JP" }), ["surname", "given"])
  assert.deepEqual(fieldNames({ locale: "ja-JP", additional: true }), [
    "surname",
    "additional",
    "given",
  ])
})

test("the phonetic pair follows the written fields in the same order", () => {
  assert.deepEqual(fieldNames({ locale: "ja-JP", phonetic: true }), [
    "surname",
    "given",
    "phoneticSurname",
    "phoneticGiven",
  ])
  assert.deepEqual(fieldNames({ locale: "en-US", phonetic: true }), [
    "given",
    "surname",
    "phoneticGiven",
    "phoneticSurname",
  ])
})

test("the title comes first in both orders, and is off unless asked for", () => {
  assert.equal(fieldNames({ locale: "en-US" }).includes("honorificPrefix"), false)
  assert.equal(fieldNames({ locale: "en-US", honorific: true })[0], "honorificPrefix")
  assert.equal(fieldNames({ locale: "ja-JP", honorific: true })[0], "honorificPrefix")
})

test("single-name mode replaces the split fields with one", () => {
  assert.deepEqual(fieldNames({ locale: "ja-JP", singleName: true }), ["fullName"])
  assert.deepEqual(fieldNames({ locale: "en-US", singleName: true, additional: true, phonetic: true }), [
    "fullName",
  ])
  assert.deepEqual(fieldNames({ singleName: true, honorific: true }), [
    "honorificPrefix",
    "fullName",
  ])
})

// ---------------------------------------------------------------------------
// The autofill tokens — the part that looks done and is not.
// ---------------------------------------------------------------------------

test("a split field never carries `name`, which means the whole name", () => {
  // HTML defines `name` as the full name; the spec's example is "Sir Timothy John Berners-Lee, OM,
  // KBE, FRS, FREng, FRSA". On a half-width field it asks the browser to fill all of that into one
  // part of the form.
  assert.equal(tokenOf("given", { locale: "en-US" }), "given-name")
  assert.equal(tokenOf("surname", { locale: "en-US" }), "family-name")
  assert.equal(tokenOf("additional", { locale: "en-US", additional: true }), "additional-name")
  assert.equal(tokenOf("honorificPrefix", { honorific: true }), "honorific-prefix")
  for (const spec of fieldsFor({ locale: "ja-JP", additional: true, phonetic: true, honorific: true })) {
    assert.notEqual(spec.autoComplete, "name", spec.field)
  }
})

test("`name` is used exactly where it is correct — the single field", () => {
  assert.equal(tokenOf("fullName", { singleName: true }), "name")
})

test("the phonetic fields opt out rather than borrowing the written field's token", () => {
  // There is no phonetic autofill token: `phonetic`, `furigana` and `kana` appear zero times in the
  // HTML standard's autofill section, and CLDR's person-name fields have no phonetic member either.
  // Reusing `given-name` here would tell the browser to fill the kanji into the furigana box, so a
  // reader who autofills has to clear it by hand. This is the assertion that fails if someone
  // "completes" the tokens.
  const specs = fieldsFor({ locale: "ja-JP", phonetic: true })
  for (const field of ["phoneticSurname", "phoneticGiven"]) {
    const spec = specs.find((s) => s.field === field)
    assert.equal(spec.autoComplete, "off", field)
    assert.notEqual(spec.autoComplete, "given-name")
    assert.notEqual(spec.autoComplete, "family-name")
    assert.notEqual(spec.autoComplete, "name")
  }
})

test("an autofill section prefixes the real tokens and leaves `off` alone", () => {
  // "shipping off" is not a token sequence the spec defines, and a browser that cannot parse it
  // falls back to guessing — which is exactly what the `off` was there to prevent.
  assert.equal(tokenOf("given", { autoCompleteSection: "shipping" }), "shipping given-name")
  assert.equal(
    tokenOf("fullName", { singleName: true, autoCompleteSection: "section-a" }),
    "section-a name"
  )
  assert.equal(
    tokenOf("phoneticGiven", { locale: "ja-JP", phonetic: true, autoCompleteSection: "shipping" }),
    "off"
  )
})

// ---------------------------------------------------------------------------
// Who the form locks out. The required-family-name defect.
// ---------------------------------------------------------------------------

test("the family name is not required by default", () => {
  // W3C: "don't require that people supply a family name. In cultures such as parts of Southern
  // India, Malaysia and Indonesia, a large number of people have names that consist of a given name
  // only" — and when a form demands one, people "enter garbage data like '.' or 'Mr.' in the family
  // name field just to escape the form". A required family name does not collect family names.
  assert.equal(DEFAULT_REQUIRED.includes("surname"), false)
  const spec = fieldsFor({ locale: "en-US" }).find((s) => s.field === "surname")
  assert.equal(spec.required, false)
  assert.deepEqual(validateName({ ...emptyName(), given: "Sukarno" }), {})
})

test("the given name is required, and whitespace is not a value", () => {
  assert.deepEqual(Object.keys(validateName(emptyName())), ["given"])
  assert.deepEqual(Object.keys(validateName({ ...emptyName(), given: "   " })), ["given"])
  assert.equal(validateName(emptyName()).given, "Given name is required")
})

test("single-name mode requires the one field it shows", () => {
  const value = { ...emptyName(), singleName: true }
  assert.deepEqual(Object.keys(validateName(value)), ["fullName"])
  assert.deepEqual(validateName({ ...value, fullName: "Sukarno" }), {})
  // The split fields are not checked while they are not on screen.
  assert.deepEqual(validateName({ ...emptyName(), singleName: true, fullName: "Sukarno" }), {})
})

test("only the fields currently rendered are validated", () => {
  // A phonetic value left over from a form that no longer asks for one is not an error, and a
  // phonetic field that is asked for is not required unless the caller says so.
  const value = { ...emptyName(), given: "Taro", phoneticGiven: "タロウ" }
  assert.deepEqual(validateName(value, { locale: "ja-JP" }), {})
  assert.deepEqual(validateName(value, { locale: "ja-JP", phonetic: true }), {})
  assert.deepEqual(
    Object.keys(validateName(value, { locale: "ja-JP", phonetic: true, required: ["phoneticSurname"] })),
    ["phoneticSurname"]
  )
})

test("a caller can require nothing at all", () => {
  assert.deepEqual(validateName(emptyName(), { required: [] }), {})
})

test("no name is rejected for its characters", () => {
  // Every character rule rejects a real name somewhere. W3C's list alone covers apostrophes
  // (O'Brien), spaces inside one name (Rose Marie), interior capitals (McNamara) and uncapitalised
  // particles (van der Waals). Emptiness is the only thing checked — including for `.`, which this
  // component deliberately accepts rather than policing a reader's name.
  for (const given of ["O'Brien", "Rose Marie", "McNamara", "van der Waals", "山田", "Ægir", "."]) {
    assert.deepEqual(validateName({ ...emptyName(), given }), {}, given)
  }
})

// ---------------------------------------------------------------------------
// Putting it back together.
// ---------------------------------------------------------------------------

test("formatName assembles in the locale's order", () => {
  const value = { ...emptyName(), given: "Taro", surname: "Yamada" }
  assert.equal(formatName(value, { locale: "ja-JP" }), "Yamada Taro")
  assert.equal(formatName(value, { locale: "en-US" }), "Taro Yamada")
  const withMiddle = { ...value, additional: "J" }
  assert.equal(formatName(withMiddle, { locale: "en-US" }), "Taro J Yamada")
  assert.equal(formatName(withMiddle, { locale: "ja-JP" }), "Yamada J Taro")
})

test("formatName drops the empty parts and trims without editing the value", () => {
  const value = { ...emptyName(), given: "  Taro  ", surname: "" }
  assert.equal(formatName(value), "Taro")
  // The stored value is untouched: trimming is for presenting, not for correcting what was typed.
  assert.equal(value.given, "  Taro  ")
  assert.equal(formatName(emptyName()), "")
})

test("formatName puts the title first and uses the single field when that is the name", () => {
  assert.equal(
    formatName({ ...emptyName(), honorificPrefix: "Dr.", given: "Ada", surname: "Lovelace" }),
    "Dr. Ada Lovelace"
  )
  assert.equal(
    formatName({ ...emptyName(), singleName: true, fullName: "Sukarno", given: "ignored" }),
    "Sukarno"
  )
})

// ---------------------------------------------------------------------------
// What the form renders.
// ---------------------------------------------------------------------------

test("the rendered fields are in the locale's order, with the labels to match", () => {
  const english = show({ locale: "en-US" })
  assert.deepEqual(order(english), ["given", "surname"])
  assert.equal(english.labelFor(find(english, "given").props.id), "Given name")

  const japanese = show({ locale: "ja-JP" })
  assert.deepEqual(order(japanese), ["surname", "given"])
})

test("the optional fields say so, and the required ones do not", () => {
  const view = show({ locale: "en-US" })
  // The family name is the optional one, which is the whole point of the default.
  assert.equal(find(view, "surname").props["aria-required"], false)
  assert.equal(find(view, "given").props["aria-required"], true)
  const labels = byTag(view.nodes, "label")
  const surnameLabel = labels.find((l) => l.props.htmlFor === find(view, "surname").props.id)
  const marker = surnameLabel.props.children.find(
    (child) => child && child.props && child.props.children === "(optional)"
  )
  assert.ok(marker, "the optional family name is marked optional")
})

test("the group carries an accessible name either way", () => {
  const plain = show()
  assert.equal(plain.group.props["aria-label"], "Name")
  assert.equal(plain.group.props["aria-labelledby"], undefined)

  const titled = show({ legend: "Legal name" })
  assert.equal(titled.group.props["aria-label"], undefined)
  assert.ok(titled.group.props["aria-labelledby"])
  const legend = titled.nodes.find((n) => n.props?.id === titled.group.props["aria-labelledby"])
  assert.equal(legend.props.children, "Legal name")
})

test("nothing limits how long a name may be, and nothing spell-checks it", () => {
  // W3C asks forms not to limit the field size for names, and a red underline under every surname
  // teaches the reader that their own name is a mistake.
  const view = show({ locale: "ja-JP", phonetic: true, additional: true, honorific: true })
  assert.equal(view.fields.length, 6)
  for (const field of view.fields) {
    assert.equal(field.props.maxLength, undefined, String(field.props.id))
    assert.equal(field.props.spellCheck, false, String(field.props.id))
  }
})

test("what was typed is what is stored — no casing, no trimming, no tidying", () => {
  // W3C asks forms to "preserve the case the user enters". A form that renders MCNAMARA back at
  // someone has not tidied their name, it has misspelt it — and the trimming that looks harmless is
  // what turns a name with a meaningful space into a different one.
  let committed = null
  const view = show({ locale: "en-US", onChange: (v) => (committed = v) })
  const typed = "  van der Waals-McNamara  "
  find(view, "surname").props.onChange({ target: { value: typed } })
  assert.equal(committed.surname, typed)
  assert.equal(find(view.read(), "surname").props.value, typed)
})

test("labels can be replaced, which is how a Japanese form gets セイ and メイ", () => {
  const view = show({
    locale: "ja-JP",
    phonetic: true,
    labels: { surname: "姓", given: "名", phoneticSurname: "セイ", phoneticGiven: "メイ" },
  })
  assert.deepEqual(
    view.fields.map((f) => view.labelFor(f.props.id)),
    ["姓", "名", "セイ", "メイ"]
  )
})

test("namePrefix makes it post as a plain form, the checkbox included", () => {
  const view = show({ locale: "en-US", namePrefix: "applicant" })
  assert.equal(find(view, "given").props.name, "applicant.given")
  assert.equal(find(view, "surname").props.name, "applicant.surname")
  assert.equal(view.checkbox.props.name, "applicant.singleName")
  // Without one, nothing is named — an unnamed control is not submitted, which is the right
  // default for a component a caller may be driving entirely through onChange.
  assert.equal(find(show({ locale: "en-US" }), "given").props.name, undefined)
})

test("disabled reaches every control", () => {
  const view = show({ locale: "ja-JP", phonetic: true, disabled: true })
  for (const input of view.inputs) assert.equal(input.props.disabled, true)
})

// ---------------------------------------------------------------------------
// Errors, and when they are allowed to appear.
// ---------------------------------------------------------------------------

test("an error waits for the field to be visited, then describes it", () => {
  const view = show({ locale: "en-US" })
  assert.equal(view.alerts.length, 0)
  assert.equal(find(view, "given").props["aria-invalid"], undefined)

  find(view, "given").props.onBlur()
  const after = view.read()
  assert.equal(after.alerts.length, 1)
  const given = find(after, "given")
  assert.equal(given.props["aria-invalid"], true)
  assert.equal(given.props["aria-describedby"], after.alerts[0].props.id)
  assert.equal(after.alerts[0].props.children, "Given name is required")

  // Blurring the optional family name produces nothing, because nothing is wrong with it.
  find(after, "surname").props.onBlur()
  assert.equal(view.read().alerts.length, 1)
})

test("showErrors surfaces everything at once, for submit", () => {
  const view = show({ locale: "ja-JP", showErrors: true, required: ["given", "surname"] })
  assert.equal(view.alerts.length, 2)
})

// ---------------------------------------------------------------------------
// The controlled-input defect this registry has shipped once already.
// ---------------------------------------------------------------------------

test("a controlled parent that rebuilds the object does not reset the field being typed", () => {
  // date-input shipped this: the effect re-seeded from the prop whenever the prop was a new object,
  // and a parent whose render produces a fresh-but-equal value does that on every render. Comparing
  // by field instead of by identity is what makes a controlled name typable at all — without it the
  // component sets state on each pass with a new object, which in React is a re-render that never
  // settles and which discards whatever the parent has not yet echoed back.
  let committed = null
  const onChange = (v) => (committed = v)
  const instance = render(NameInput, {
    locale: "en-US",
    value: { ...emptyName(), given: "Ada" },
    onChange,
  })
  const givenField = () => {
    instance.rerender()
    return byTag(walk(instance.tree), "input").find((i) => String(i.props.id).endsWith("-given"))
  }

  givenField().props.onChange({ target: { value: "Adam" } })
  assert.equal(committed.given, "Adam")

  // The parent adopts the change and re-renders with a new object carrying the same data.
  instance.update({ locale: "en-US", value: { ...committed }, onChange })
  assert.equal(givenField().props.value, "Adam", "the keystroke survived an equal-but-new value prop")

  // And again, because a parent that rebuilds once rebuilds every time.
  instance.update({ locale: "en-US", value: { ...committed }, onChange })
  assert.equal(givenField().props.value, "Adam")

  // A genuinely different value from the parent still wins — this is a controlled input.
  instance.update({ locale: "en-US", value: { ...emptyName(), given: "Grace" }, onChange })
  assert.equal(givenField().props.value, "Grace")
})

test("a change commits every field, so a half-filled name round-trips", () => {
  let committed = null
  const view = show({ locale: "ja-JP", phonetic: true, onChange: (v) => (committed = v) })
  find(view, "phoneticSurname").props.onChange({ target: { value: "ヤマダ" } })
  assert.equal(committed.phoneticSurname, "ヤマダ")
  // Every key is present, including the ones this form does not render.
  assert.deepEqual(Object.keys(committed).sort(), Object.keys(emptyName()).sort())
  assert.equal(committed.singleName, false)
})

test("an uncontrolled form keeps what was typed into it", () => {
  const view = show({ locale: "en-US", defaultValue: { given: "Ada" } })
  assert.equal(find(view, "given").props.value, "Ada")
  find(view, "given").props.onChange({ target: { value: "Ada L" } })
  assert.equal(find(view.read(), "given").props.value, "Ada L")
})

// ---------------------------------------------------------------------------
// The single-name escape.
// ---------------------------------------------------------------------------

test("the single-name checkbox is offered, labelled, and can be turned off", () => {
  const view = show({ locale: "en-US" })
  assert.ok(view.checkbox)
  const label = byTag(view.nodes, "label").find((l) => l.props.htmlFor === view.checkbox.props.id)
  assert.equal(label.props.children, FIELD_LABELS.singleName)
  assert.equal(show({ locale: "en-US", allowSingleName: false }).checkbox, undefined)
})

test("ticking it replaces the split fields with one that takes the whole name", () => {
  const view = show({ locale: "en-US" })
  view.checkbox.props.onChange({ target: { checked: true } })
  const after = view.read()
  assert.deepEqual(order(after), ["fullName"])
  assert.equal(find(after, "fullName").props.autoComplete, "name")
  assert.equal(find(after, "fullName").props["aria-required"], true)
})

test("ticking it carries the name already typed, in the locale's order", () => {
  const japanese = show({ locale: "ja-JP", defaultValue: { surname: "山田", given: "太郎" } })
  japanese.checkbox.props.onChange({ target: { checked: true } })
  assert.equal(find(japanese.read(), "fullName").props.value, "山田 太郎")

  const english = show({ locale: "en-US", defaultValue: { given: "Ada", surname: "Lovelace" } })
  english.checkbox.props.onChange({ target: { checked: true } })
  assert.equal(find(english.read(), "fullName").props.value, "Ada Lovelace")
})

test("unticking it gives the two fields back as they were left", () => {
  const view = show({ locale: "en-US", defaultValue: { given: "Ada", surname: "Lovelace" } })
  view.checkbox.props.onChange({ target: { checked: true } })
  view.read().checkbox.props.onChange({ target: { checked: false } })
  const back = view.read()
  assert.deepEqual(order(back), ["given", "surname"])
  assert.equal(find(back, "given").props.value, "Ada")
  assert.equal(find(back, "surname").props.value, "Lovelace")
})

test("the carry never overwrites a full name the reader has already corrected", () => {
  const view = show({
    locale: "en-US",
    defaultValue: { given: "Ada", surname: "Lovelace", fullName: "Ada King, Countess of Lovelace" },
  })
  view.checkbox.props.onChange({ target: { checked: true } })
  assert.equal(find(view.read(), "fullName").props.value, "Ada King, Countess of Lovelace")
})

test("the choice is part of the committed value, not hidden in the component", () => {
  // A parent that stores the name without it has stored a row it cannot read back: it cannot tell
  // which field holds the reader's actual name.
  let committed = null
  const view = show({ locale: "en-US", onChange: (v) => (committed = v) })
  view.checkbox.props.onChange({ target: { checked: true } })
  assert.equal(committed.singleName, true)
  assert.deepEqual(Object.keys(validateName(committed)), ["fullName"])
})

test("a single name validates and formats without a family name anywhere", () => {
  // The whole path, end to end, for the reader the split form would have locked out.
  let committed = null
  const view = show({ locale: "en-US", onChange: (v) => (committed = v) })
  view.checkbox.props.onChange({ target: { checked: true } })
  view.read().fields[0].props.onChange({ target: { value: "Sukarno" } })
  assert.deepEqual(validateName(committed), {})
  assert.equal(formatName(committed), "Sukarno")
  assert.equal(committed.surname, "")
})
