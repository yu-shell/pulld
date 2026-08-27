// Behaviour tests for language-select, written alongside the component on 2026-08-27.
//
// What is worth pinning here is what a hand-rolled language picker gets wrong, and none of it shows
// up by reading the file: that every row is named in its own language rather than in the page's
// (the person opening this control is often the one who cannot read the page), that an unknown tag
// carrying a region — "xx-US", which `Intl` happily names "xx (United States)" — is dropped even
// though the test its sibling pickers use would let it through, that the tag which leaves the
// control is the caller's own string, and that the filter reaches a language by four different
// names because four different people type into it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const {
  LanguageSelect,
  DEFAULT_LANGUAGE_TAGS,
  getLanguageName,
  getLanguageEndonym,
  getLanguageDirection,
} = loadComponent(join(ROOT, "registry", "ui", "language-select.tsx"))

// The harness runs effects the way a commit would, so the browser globals those effects reach for
// have to exist. Nothing here needs to do anything — the component only uses them to schedule
// focus, to listen for an outside press, and to scroll the highlighted row into view, none of
// which the harness can observe.
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} }
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
}

/** Drives one field. `locale` is pinned by default so assertions do not depend on the test host. */
const show = (props = {}) => {
  const chosen = []
  const instance = render(LanguageSelect, {
    locale: "en",
    onValueChange: (tag) => chosen.push(tag),
    ...props,
  })
  const nodes = () => walk(instance.tree)
  const trigger = () => byRole(nodes(), "combobox")[0]
  const rows = () => byRole(nodes(), "option")
  const label = (row) => {
    const group = [].concat(row.props.children).find((c) => c?.props?.className?.includes?.("flex-1"))
    const kids = [].concat(group.props.children)
    const endonym = kids.find((c) => c?.props?.lang !== undefined)
    return { endonym, translated: kids.find((c) => c && c !== endonym) }
  }
  return {
    chosen,
    trigger,
    rows,
    endonyms: () => rows().map((r) => label(r).endonym.props.children),
    translations: () => rows().map((r) => label(r).translated?.props?.children ?? ""),
    langs: () => rows().map((r) => label(r).endonym.props.lang),
    dirs: () => rows().map((r) => label(r).endonym.props.dir),
    tags: () =>
      rows().map(
        (r) =>
          [].concat(r.props.children).find((c) => c?.props?.className?.includes?.("font-mono"))?.props
            ?.children
      ),
    triggerLabel: () =>
      [].concat(trigger().props.children).find((c) => c?.props?.className === "truncate")?.props,
    triggerTag: () =>
      [].concat(trigger().props.children).find((c) => c?.props?.className?.includes?.("font-mono"))
        ?.props?.children,
    open() {
      trigger().props.onClick()
      instance.rerender()
    },
    search(text) {
      const box = nodes().find((n) => n.props?.role === "searchbox")
      box.props.onChange({ target: { value: text } })
      instance.rerender()
    },
    press(key) {
      const panel = nodes().find(
        (n) => typeof n.props?.onKeyDown === "function" && n.props?.className?.includes("absolute")
      )
      panel.props.onKeyDown({ key, preventDefault() {} })
      instance.rerender()
    },
    clickRow(index) {
      rows()[index].props.onClick()
      instance.rerender()
    },
    activeIndex: () => {
      const box = nodes().find((n) => n.props?.role === "searchbox")
      const id = box?.props["aria-activedescendant"]
      return id ? Number(id.split("-opt-")[1]) : -1
    },
    emptyText: () => byRole(nodes(), "presentation")[0]?.props?.children,
    presentationRows: () => byRole(nodes(), "presentation"),
    isOpen: () => trigger().props["aria-expanded"],
    hidden: () =>
      nodes().find((n) => n.type === "input" && n.props.type === "hidden")?.props.value,
    update: (next) => instance.update({ locale: "en", onValueChange: (t) => chosen.push(t), ...next }),
  }
}

const SAMPLE = ["ja", "de", "ar", "pt-BR", "pt-PT", "zh-Hans"]

test("every row is named in its own language, with the reader's name beside it", () => {
  const field = show({ languages: SAMPLE })
  field.open()
  const endonyms = field.endonyms()

  // The whole point of the control: someone who cannot read this page has to find their way out of
  // it, and "Japanese" is no help to them.
  assert.ok(endonyms.includes("日本語"), "Japanese names itself 日本語")
  assert.ok(endonyms.includes("Deutsch"), "German names itself Deutsch")
  assert.ok(endonyms.includes("العربية"), "Arabic names itself العربية")
  assert.ok(!endonyms.includes("Japanese"), "the reader's word for it is not the row's label")

  // The reader's name is still there, second, for whoever is choosing on someone else's behalf.
  const rows = Object.fromEntries(field.endonyms().map((e, i) => [e, field.translations()[i]]))
  assert.equal(rows["日本語"], "Japanese")
  assert.equal(rows["português (Brasil)"], "Brazilian Portuguese")
  assert.equal(rows["português (Portugal)"] ?? rows["português europeu"], "European Portuguese")
})

test("the reader's own language is not labelled twice", () => {
  const field = show({ locale: "de", languages: ["de", "ja"] })
  field.open()
  const german = field.endonyms().indexOf("Deutsch")
  assert.equal(field.translations()[german], "", "Deutsch is already the German word for German")
  const japanese = field.endonyms().indexOf("日本語")
  assert.equal(field.translations()[japanese], "Japanisch", "and the other row is named in German")
})

test("a tag the runtime cannot name is dropped — including one wearing a region", () => {
  const field = show({ languages: ["ja", "xx", "xx-US", "zz-ZZ", "abc-DE", "pt_BR", "pt-BR"] })
  field.open()
  assert.deepEqual(field.tags(), ["pt-BR", "ja"], "collated by endonym, so the Latin one leads")
  assert.deepEqual(field.endonyms(), ["português (Brasil)", "日本語"])

  // The reason this component cannot reuse the sibling pickers' rule. `country-select` and
  // `currency-select` drop what the runtime returns unchanged, and that catches "xx". It does not
  // catch "xx-US": Intl names that "xx (United States)", which is not the tag, so the row would be
  // drawn with a made-up name built around two letters that mean nothing.
  assert.notEqual(getLanguageName("xx-US", "en"), "xx-US", "Intl does name it — that is the trap")
  assert.equal(getLanguageName("xx", "en"), "xx", "but its language subtag is unknown")

  // "pt_BR" is the POSIX and Java spelling of a locale, and a plausible thing to find in a config
  // file. It is not a valid BCP-47 tag: Intl throws on it rather than naming it.
  assert.equal(getLanguageName("pt_BR", "en"), "pt_BR", "underscored tags are not names")
})

test("a tag carrying a Unicode extension is dropped, subtag or no subtag", () => {
  // The other half of the drop rule, and the half the subtag test cannot do. A tag like
  // "ja-JP-u-ca-japanese" comes out of `Intl.DateTimeFormat().resolvedOptions().locale` and out of
  // some `navigator.language` values, so it is a real thing to be handed. Its language subtag is
  // "ja", which is perfectly nameable — but `DisplayNames` throws on the whole tag, so there is no
  // name to draw the row with and it has to go.
  assert.equal(new Intl.Locale("ja-JP-u-ca-japanese").language, "ja", "the subtag is fine")
  assert.equal(
    getLanguageEndonym("ja-JP-u-ca-japanese"),
    "ja-JP-u-ca-japanese",
    "but the tag itself has no name"
  )
  const field = show({ languages: ["ja-JP-u-ca-japanese", "ja"] })
  field.open()
  assert.deepEqual(field.tags(), ["ja"])
})

test("the tag that leaves the control is the caller's own string", () => {
  const field = show({ languages: ["PT-br", "ja"] })
  field.open()
  const row = field.endonyms().indexOf("português (Brasil)")
  field.clickRow(row)

  // Intl is case-insensitive and would canonicalise this to "pt-BR". The control does not: the tag
  // is a key into the caller's own translations, and "PT-br" is what their directory is called.
  assert.deepEqual(field.chosen, ["PT-br"])
})

test("the list is collated by what the rows say, not by tag order or by English", () => {
  const field = show({ languages: ["ja", "de", "cs", "ar", "es", "en"] })
  field.open()

  // čeština before Deutsch before English before español: a collator, not code points, which would
  // have put "English" before "cs" and "čeština" after every ASCII name.
  assert.deepEqual(field.endonyms(), ["čeština", "Deutsch", "English", "español", "العربية", "日本語"])

  // Sorted by the English names it would be Arabic, Czech, English, German, Japanese, Spanish —
  // an order most of these readers cannot see the logic of.
  assert.notDeepEqual(field.tags(), ["ar", "cs", "en", "de", "ja", "es"])
})

test("each row carries lang and dir, so it is pronounced and laid out correctly", () => {
  const field = show({ languages: ["ja", "ar", "he", "en"] })
  field.open()
  const by = Object.fromEntries(field.tags().map((t, i) => [t, { lang: field.langs()[i], dir: field.dirs()[i] }]))

  // Without `lang`, a screen reader set to English reads 日本語 as three unknown characters.
  assert.equal(by.ja.lang, "ja")
  assert.equal(by.ar.lang, "ar")
  // Without `dir`, an RTL endonym is laid out by the surrounding LTR list.
  assert.equal(by.ar.dir, "rtl")
  assert.equal(by.he.dir, "rtl")
  assert.equal(by.ja.dir, "ltr")
  assert.equal(by.en.dir, "ltr")
})

test("getLanguageDirection knows more RTL languages than Arabic and Hebrew", () => {
  for (const tag of ["ar", "he", "fa", "ur", "ps", "ckb", "yi", "dv", "sd", "ug"]) {
    assert.equal(getLanguageDirection(tag), "rtl", `${tag} is written right to left`)
  }
  // Kurmanji Kurdish is written in Latin script, which is exactly the kind of exception a
  // hand-written list of "RTL languages" gets wrong.
  for (const tag of ["en", "ja", "ku", "az", "tr"]) {
    assert.equal(getLanguageDirection(tag), "ltr", `${tag} is written left to right`)
  }
  // Never throws, whatever it is handed — a picker that throws is worse than one that is plain.
  assert.equal(getLanguageDirection("xx"), "ltr")
  assert.equal(getLanguageDirection("pt_BR"), "ltr")
  assert.equal(getLanguageDirection(""), "ltr")
})

test("direction still answers where the runtime will not answer it", () => {
  // `getLanguageDirection` asks `Intl.Locale` first and falls back to the language's script. On
  // this runtime the first path always answers, so the fallback is dead code that no other test in
  // this file can reach — and dead code that only runs on someone else's browser is exactly the
  // kind that rots unnoticed. Taking the API away is the only way to see it work.
  const proto = Intl.Locale.prototype
  const saved = Object.getOwnPropertyDescriptor(proto, "getTextInfo")
  assert.ok(saved, "this runtime does have the API — the fallback is what is being tested")
  delete proto.getTextInfo
  try {
    assert.equal(proto.textInfo, undefined, "and not the older accessor either")
    // Arabic and Hebrew script, and then the four scripts that carry one language each — the rows
    // a table written from memory stops before reaching.
    for (const tag of ["ar", "he", "fa", "ur", "ckb", "ug", "yi", "dv", "nqo", "syr", "ff-Adlm"]) {
      assert.equal(getLanguageDirection(tag), "rtl", `${tag} is written in a right-to-left script`)
    }
    for (const tag of ["en", "ja", "ku", "xx"]) {
      assert.equal(getLanguageDirection(tag), "ltr")
    }
  } finally {
    Object.defineProperty(proto, "getTextInfo", saved)
  }
  assert.equal(getLanguageDirection("ar"), "rtl", "and the API is back for everyone else")
})

test("the filter reaches a language by its own name, spelt without the accents", () => {
  const field = show({ languages: SAMPLE.concat(["cs", "tr"]) })
  field.open()
  field.search("cestina")
  assert.deepEqual(field.endonyms(), ["čeština"], "typed on a keyboard that has no č")
  field.search("türkçe")
  assert.deepEqual(field.endonyms(), ["Türkçe"], "and typed on one that does")
  field.search("日本")
  assert.deepEqual(field.endonyms(), ["日本語"], "a non-Latin endonym survives folding intact")
})

test("the filter reaches a language by the English name and by the reader's name", () => {
  const field = show({ locale: "ja", languages: ["de", "ja", "ar"] })
  field.open()
  // On a Japanese page, someone types the English name constantly — it is what the docs say.
  field.search("german")
  assert.deepEqual(field.endonyms(), ["Deutsch"])
  // And the page's own word for it works too.
  field.search("ドイツ")
  assert.deepEqual(field.endonyms(), ["Deutsch"])
  // Mid-word, which is the only query the English face answers on its own: "man" is inside
  // "German" and inside neither ドイツ語 nor Deutsch.
  field.search("man")
  assert.deepEqual(field.endonyms(), ["Deutsch"])
})

test("an exact tag wins outright and a partial tag finds a family", () => {
  const field = show({ languages: ["da", "de", "nl", "pt-BR", "pt-PT", "zh-Hans", "zh-Hant"] })
  field.open()

  // "da" is also inside "Nederlands" and "Deutsch"; the language whose tag it is comes first.
  field.search("da")
  assert.equal(field.endonyms()[0], "dansk")

  // The developer's query: two letters that name a pair of shipped translations.
  field.search("pt")
  assert.deepEqual(field.tags(), ["pt-BR", "pt-PT"])
  field.search("zh")
  assert.deepEqual(field.tags(), ["zh-Hans", "zh-Hant"])
  // The tag survives folding, so the punctuation in it is optional.
  field.search("ptbr")
  assert.deepEqual(field.tags(), ["pt-BR"])
})

test("the tag you typed exactly comes first, even when another sorts above it", () => {
  // Indonesian is "id" and Ido is "ido", and Ido collates first — so a prefix match alone would
  // answer "id" with a constructed language from 1907 above the one with 200 million speakers.
  const field = show({ languages: ["id", "ido"] })
  field.open()
  assert.deepEqual(field.endonyms(), ["Ido", "Indonesia"], "that is the collated order")
  field.search("id")
  assert.deepEqual(field.tags(), ["id", "ido"], "and typing the tag exactly reverses it")
})

test("a name that starts with the query beats one that merely contains it", () => {
  // "man" begins Manx and sits inside German and Romanian. All three are matches; the one the
  // person is most likely to have meant goes on top.
  const field = show({ languages: ["de", "gv", "ro"] })
  field.open()
  assert.deepEqual(field.endonyms(), ["Deutsch", "Gaelg", "română"], "collated, before any query")
  field.search("man")
  assert.deepEqual(field.tags(), ["gv", "de", "ro"], "Manx first, then the two containing it")
})

test("a query that folds away to nothing filters, rather than showing everything", () => {
  const field = show({ languages: SAMPLE })
  field.open()
  const all = field.rows().length
  field.search("()")
  // Folding strips punctuation, so this query becomes "". Testing emptiness after folding would
  // match every row and read as the filter being broken.
  assert.equal(field.rows().length, 0)
  assert.equal(field.emptyText(), "No language found.")
  field.search("")
  assert.equal(field.rows().length, all, "and clearing it brings the list back")
})

test("the trigger is labelled with the endonym, on the server as well as after hydration", () => {
  // No `locale` given: this is what a server render sees, where the runtime's own locale is the
  // server's. The label still has to be right, because unlike a name in the reader's language, the
  // endonym does not depend on who is reading.
  const field = show({ locale: undefined, value: "ja", languages: SAMPLE })
  assert.equal(field.triggerLabel().children, "日本語")
  assert.equal(field.triggerLabel().lang, "ja")
  assert.equal(field.triggerTag(), "ja")
  assert.equal(getLanguageEndonym("ja"), "日本語", "the same call, wherever it runs")
})

test("a stored tag that is no longer offered is still named", () => {
  // A language you have stopped shipping, or one saved before the list was narrowed. Falling back
  // to the placeholder would read as "nothing chosen" and lose the answer on the next save.
  const field = show({ value: "he", languages: ["en", "ja"] })
  assert.equal(field.triggerLabel().children, "עברית")
  assert.equal(field.triggerLabel().dir, "rtl")
  assert.equal(field.triggerTag(), "he")
})

test("the placeholder is not given a lang or a dir", () => {
  const field = show({ languages: SAMPLE })
  const label = field.triggerLabel()
  assert.equal(label.children, "Select a language")
  // It is written in the page's language, so tagging it as some other one would mispronounce it.
  assert.equal(label.lang, undefined)
  assert.equal(label.dir, undefined)
})

test("choosing: uncontrolled keeps the answer, controlled defers to the prop", () => {
  const uncontrolled = show({ languages: SAMPLE, defaultValue: "de" })
  uncontrolled.open()
  uncontrolled.clickRow(uncontrolled.endonyms().indexOf("日本語"))
  assert.deepEqual(uncontrolled.chosen, ["ja"])
  assert.equal(uncontrolled.triggerLabel().children, "日本語")
  assert.equal(uncontrolled.isOpen(), false, "and the panel closes behind it")

  const controlled = show({ languages: SAMPLE, value: "de" })
  controlled.open()
  controlled.clickRow(controlled.endonyms().indexOf("日本語"))
  assert.deepEqual(controlled.chosen, ["ja"])
  assert.equal(controlled.triggerLabel().children, "Deutsch", "the prop is the authority")
  controlled.update({ languages: SAMPLE, value: "ja" })
  assert.equal(controlled.triggerLabel().children, "日本語")
})

test("the keyboard walks the list, chooses, and closes", () => {
  const field = show({ languages: ["de", "en", "es", "ja"] })
  field.open()
  assert.equal(field.activeIndex(), 0)
  field.press("ArrowDown")
  field.press("ArrowDown")
  assert.equal(field.activeIndex(), 2)
  field.press("ArrowUp")
  assert.equal(field.activeIndex(), 1)
  field.press("End")
  assert.equal(field.activeIndex(), field.rows().length - 1)
  field.press("Home")
  assert.equal(field.activeIndex(), 0)
  field.press("Enter")
  assert.deepEqual(field.chosen, ["de"], "Deutsch sorts first")
  assert.equal(field.isOpen(), false)

  const escaping = show({ languages: SAMPLE })
  escaping.open()
  escaping.press("Escape")
  assert.equal(escaping.isOpen(), false)
  assert.deepEqual(escaping.chosen, [])
})

test("opening a field that already has an answer starts on that row", () => {
  const field = show({ languages: ["de", "en", "es", "ja"], value: "ja" })
  field.open()
  assert.equal(field.endonyms()[field.activeIndex()], "日本語")
})

test("priority pins rows above the list, and stops pinning once there is a query", () => {
  const field = show({ languages: SAMPLE, priority: ["pt-BR", "ja"] })
  field.open()
  assert.deepEqual(field.tags().slice(0, 2), ["pt-BR", "ja"], "in the order given")
  assert.equal(field.presentationRows().length, 1, "with a separator under them")
  assert.equal(field.tags().filter((t) => t === "ja").length, 2, "still in the list below")

  field.search("p")
  // A result list ordered by anything other than how well it matched reads as a bug.
  assert.equal(field.presentationRows().length, 0)

  const unpinnable = show({ languages: ["ja"], priority: ["xx", "de"] })
  unpinnable.open()
  assert.equal(unpinnable.presentationRows().length, 0, "nothing pinned, so no stray separator")
})

test("the field submits with a native form, and duplicates are dropped", () => {
  const field = show({ languages: ["ja", "ja", "de"], name: "language", defaultValue: "de" })
  assert.equal(field.hidden(), "de")
  field.open()
  assert.deepEqual(field.tags(), ["de", "ja"], "a tag listed twice is one row")
  field.clickRow(1)
  assert.equal(field.hidden(), "ja")
})

test("the tag column can be turned off without disturbing the row", () => {
  const field = show({ languages: SAMPLE, tags: false, value: "ja" })
  assert.equal(field.triggerTag(), undefined)
  field.open()
  assert.deepEqual(field.tags(), [undefined, undefined, undefined, undefined, undefined, undefined])
  assert.ok(field.endonyms().includes("日本語"), "the names are still there")
})

test("the trigger and listbox carry the roles and wiring a combobox needs", () => {
  const field = show({ languages: SAMPLE, "aria-label": "Interface language" })
  const trigger = field.trigger()
  assert.equal(trigger.props.type, "button", "never submit — it lives inside forms")
  assert.equal(trigger.props["aria-haspopup"], "listbox")
  assert.equal(trigger.props["aria-expanded"], false)
  assert.equal(trigger.props["aria-controls"], undefined, "nothing to control while closed")

  field.open()
  assert.equal(field.trigger().props["aria-expanded"], true)
  assert.ok(field.trigger().props["aria-controls"], "and now it names the listbox")
  assert.equal(field.rows()[0].props.role, "option")
  assert.equal(field.rows()[0].props["aria-selected"], false)
})

test("the shipped default list is a list that renders", () => {
  assert.equal(new Set(DEFAULT_LANGUAGE_TAGS).size, DEFAULT_LANGUAGE_TAGS.length, "no duplicates")
  assert.ok(DEFAULT_LANGUAGE_TAGS.length >= 30, "enough to be a demo worth looking at")
  const field = show()
  field.open()
  // Every tag survives the drop rule — a default list with a hole in it would ship a row missing
  // from the demo and nobody would notice.
  assert.equal(field.rows().length, DEFAULT_LANGUAGE_TAGS.length)
  for (const [i, endonym] of field.endonyms().entries()) {
    assert.notEqual(endonym, field.tags()[i], `${field.tags()[i]} is named, not shown raw`)
  }
})

test("Intl has no list of languages to read, which is why languages is the main prop", () => {
  // The fact the whole API is shaped around, and the one that separates this from its siblings:
  // currencies, time zones and calendars can be enumerated at runtime; languages cannot.
  for (const key of ["language", "locale", "region", "script"]) {
    assert.throws(() => Intl.supportedValuesOf(key), RangeError, `supportedValuesOf("${key}")`)
  }
  assert.ok(Intl.supportedValuesOf("currency").length > 100, "but currencies come back fine")
})
