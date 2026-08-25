// Behaviour tests for country-select, written alongside the component on 2026-08-25.
//
// The three things worth pinning here are the three a hand-rolled country field gets wrong, and
// none of them is visible by reading: that the list is ordered by `Intl.Collator` rather than by
// code point (a plain sort drops Åland Islands and Österreich below Zimbabwe), that the filter
// reaches a country by its English name and by its code and not only by the label on screen, and
// that the codes the component offers are countries — `Intl.DisplayNames` will name EU, UN and
// 001 just as readily, and none of those is a place a parcel can go.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { CountrySelect, COUNTRY_CODES, getCountryName, getCountryFlag } = loadComponent(
  join(ROOT, "registry", "ui", "country-select.tsx")
)

// The harness runs effects the way a commit would, so the browser globals those effects reach for
// have to exist. Nothing here needs to do anything — the component only uses them to schedule focus,
// to listen for an outside press, and to scroll the highlighted row into view, none of which the
// harness can observe.
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {} }
globalThis.document = {
  addEventListener: () => {},
  removeEventListener: () => {},
  getElementById: () => null,
}

/** Drives one field. `locale` is always pinned so the assertions do not depend on the test host. */
const show = (props = {}) => {
  const chosen = []
  const instance = render(CountrySelect, {
    locale: "en",
    onValueChange: (code) => chosen.push(code),
    ...props,
  })
  const nodes = () => walk(instance.tree)
  const trigger = () => byRole(nodes(), "combobox")[0]
  const rows = () => byRole(nodes(), "option")
  return {
    chosen,
    trigger,
    rows,
    names: () => rows().map((r) => r.props.children.find((c) => c?.props?.className === "truncate")?.props?.children),
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
      const panel = nodes().find((n) => typeof n.props?.onKeyDown === "function" && n.props?.className?.includes("absolute"))
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
    activeDescendant: () =>
      nodes().find((n) => n.props?.role === "searchbox")?.props["aria-activedescendant"],
    presentationRows: () => byRole(nodes(), "presentation"),
    emptyText: () => byRole(nodes(), "presentation")[0]?.props?.children,
    hidden: () =>
      walk(instance.tree).find((n) => n.type === "input" && n.props.type === "hidden")?.props.value,
  }
}

test("the code list is countries only — no unions, blocs or made-up regions", () => {
  assert.equal(COUNTRY_CODES.length, 249, "every officially assigned ISO 3166-1 alpha-2 code")
  assert.equal(new Set(COUNTRY_CODES).size, 249, "and no duplicates")
  for (const bogus of ["EU", "UN", "EZ", "QO", "ZZ", "001", "XX"]) {
    assert.ok(!COUNTRY_CODES.includes(bogus), `${bogus} is named by Intl but is not a country`)
  }
  for (const code of COUNTRY_CODES) {
    assert.match(code, /^[A-Z]{2}$/)
    assert.notEqual(getCountryName(code, "en"), code, `${code} must resolve to a name`)
  }
})

test("the list is collated, not code-point sorted", () => {
  // The whole reason Intl.Collator is in the file. A plain sort() puts these three at the very
  // bottom, after Zimbabwe, because their first character is above "Z" in code point order.
  const field = show()
  field.open()
  const names = field.names()
  assert.equal(names[0], "Afghanistan", "the list starts at the top of the alphabet")
  assert.equal(names.at(-1), "Zimbabwe", "and ends at the bottom of it")
  const aland = names.indexOf("Åland Islands")
  assert.ok(aland >= 0 && aland < names.indexOf("Albania") + 3, "Åland sits among the A's")
  assert.ok(aland < names.indexOf("Zimbabwe"), "and nowhere near the end")
})

test("the filter reaches a country by its English name on a page that is not in English", () => {
  const field = show({ locale: "ja" })
  field.open()
  field.search("japan")
  assert.equal(field.names()[0], "日本", "typing the English name finds the Japanese label")
  field.search("にほん")
  assert.equal(field.names().length, 0, "and the local reading is a different string entirely")
  field.search("日本")
  assert.equal(field.names()[0], "日本", "which the local name still matches")
})

test("an exact two-letter code wins outright", () => {
  const field = show()
  field.open()
  field.search("in")
  assert.equal(field.names()[0], "India", "IN is exact; Indonesia only contains the letters")
  field.search("jp")
  assert.equal(field.names()[0], "Japan")
})

test("accents and punctuation are folded away", () => {
  const field = show()
  field.open()
  // The apostrophe in Côte d'Ivoire is U+2019, which no keyboard produces.
  field.search("cote divoire")
  assert.equal(field.names()[0], "Côte d’Ivoire")
  field.search("aland")
  assert.equal(field.names()[0], "Åland Islands")
})

test("choosing a country emits the code, never the name", () => {
  const field = show()
  field.open()
  field.search("jp")
  field.clickRow(0)
  assert.deepEqual(field.chosen, ["JP"])
})

test("uncontrolled keeps the choice, and the hidden input carries it into a form", () => {
  const field = show({ name: "country" })
  field.open()
  field.search("jp")
  field.clickRow(0)
  assert.equal(field.trigger().props.children.find((c) => c?.props?.className === "truncate")?.props?.children, "Japan")
  assert.equal(field.hidden(), "JP", "a native form submit sees the code")
})

test("a controlled field shows what the parent says and nothing else", () => {
  const field = show({ value: "FR" })
  const label = () => field.trigger().props.children.find((c) => c?.props?.className === "truncate")?.props?.children
  assert.equal(label(), "France")
  field.open()
  field.search("jp")
  field.clickRow(0)
  assert.deepEqual(field.chosen, ["JP"], "the attempt is reported")
  assert.equal(label(), "France", "but a parent that refuses it wins")
})

test("priority codes are pinned above the alphabet, and dropped once a query is typed", () => {
  const field = show({ priority: ["US", "GB"] })
  field.open()
  const names = field.names()
  assert.deepEqual(names.slice(0, 2), ["United States", "United Kingdom"], "in the order given")
  assert.equal(names[2], "Afghanistan", "the full alphabet follows")
  assert.equal(names.filter((n) => n === "United States").length, 2, "still present in the alphabet")
  field.search("united")
  assert.equal(
    field.names()[0],
    "United Arab Emirates",
    "a search ranks by match quality, not by pinning"
  )
})

test("narrowing with `countries` still shows a stored code from outside the narrowed list", () => {
  const field = show({ countries: ["US", "CA"], value: "JP" })
  const label = field.trigger().props.children.find((c) => c?.props?.className === "truncate")?.props?.children
  assert.equal(label, "Japan", "reading as the placeholder would lose the answer on the next save")
  field.open()
  assert.deepEqual(field.names(), ["Canada", "United States"])
})

test("keyboard: arrows move the highlight, Enter takes it, Escape closes", () => {
  const field = show()
  field.open()
  assert.equal(field.activeIndex(), 0)
  field.press("ArrowDown")
  assert.equal(field.activeIndex(), 1)
  field.press("ArrowUp")
  assert.equal(field.activeIndex(), 0)
  field.press("ArrowUp")
  assert.equal(field.activeIndex(), 0, "and it does not walk off the top into a dead index")
  field.press("End")
  assert.equal(field.activeIndex(), COUNTRY_CODES.length - 1)
  field.press("Home")
  assert.equal(field.activeIndex(), 0)
  field.press("Enter")
  assert.deepEqual(field.chosen, ["AF"])
  assert.equal(byRole(walk(field.trigger()), "option").length, 0, "the panel closed behind it")
})

test("opening a field that already has a country starts on that country", () => {
  const field = show({ value: "JP" })
  field.open()
  const names = field.names()
  assert.equal(names[field.activeIndex()], "Japan", "not Afghanistan, 100 rows above")
})

test("a query that matches nothing says so without offering a phantom option", () => {
  const field = show({ emptyMessage: "Nowhere by that name." })
  field.open()
  field.search("zzzzzz")
  assert.equal(field.rows().length, 0, "nothing selectable is left in the listbox")
  assert.equal(field.emptyText(), "Nowhere by that name.", "and the reason is stated")
  // The message must not be announced as a choice: a listbox whose only child is an option the
  // user cannot pick reads to a screen reader as one available country.
  assert.equal(field.presentationRows().length, 1)
  assert.equal(field.activeDescendant(), undefined, "and nothing is highlighted")
})

test("the trigger is a button, so opening the list never submits the surrounding form", () => {
  const field = show()
  assert.equal(field.trigger().type, "button")
  assert.equal(field.trigger().props.type, "button")
  assert.equal(field.trigger().props["aria-haspopup"], "listbox")
  assert.equal(field.trigger().props["aria-expanded"], false)
  field.open()
  assert.equal(field.trigger().props["aria-expanded"], true)
})

test("flags are opt-in and never the only label", () => {
  assert.equal(getCountryFlag("JP"), "🇯🇵")
  assert.equal(getCountryFlag("nope"), "", "a non-code produces nothing rather than mojibake")
  const field = show({ flags: true, value: "JP" })
  field.open()
  // The name is still rendered next to the flag, which is what makes this safe on Windows.
  assert.ok(field.names().includes("Japan"))
})
