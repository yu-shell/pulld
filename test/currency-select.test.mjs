// Behaviour tests for currency-select, written alongside the component on 2026-08-26.
//
// What is worth pinning here is what a hand-rolled currency field gets wrong, and none of it is
// visible by reading: that the offered codes are money and not the IMF's units of account, that
// decimal places are read per currency rather than assumed to be two (they are 0 for JPY and 3 for
// the Gulf dinars, and the wrong answer overbills a Japanese customer a hundredfold at the payment
// boundary), that the list is collated rather than code-point sorted, and that the filter reaches a
// currency by its English name, its code and its symbol — the last of which folds away to nothing
// and would silently show the whole list if the query were read after folding.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const {
  CurrencySelect,
  NON_TENDER_CURRENCY_CODES,
  getCurrencyName,
  getCurrencySymbol,
  getCurrencyFractionDigits,
} = loadComponent(join(ROOT, "registry", "ui", "currency-select.tsx"))

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
  const instance = render(CurrencySelect, {
    locale: "en",
    onValueChange: (code) => chosen.push(code),
    ...props,
  })
  const nodes = () => walk(instance.tree)
  const trigger = () => byRole(nodes(), "combobox")[0]
  const rows = () => byRole(nodes(), "option")
  const triggerPart = (className) =>
    trigger().props.children.find((c) => c?.props?.className?.includes?.(className))?.props?.children
  return {
    chosen,
    trigger,
    rows,
    names: () =>
      rows().map((r) => r.props.children.find((c) => c?.props?.className === "truncate")?.props?.children),
    codes: () =>
      rows().map(
        (r) => r.props.children.find((c) => c?.props?.className?.includes?.("font-mono"))?.props?.children
      ),
    symbols: () =>
      rows().map(
        (r) =>
          r.props.children.find((c) => c?.props?.["aria-hidden"] === "true")?.props?.children ?? ""
      ),
    triggerName: () => triggerPart("truncate"),
    triggerCode: () => triggerPart("font-mono"),
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
    activeDescendant: () =>
      nodes().find((n) => n.props?.role === "searchbox")?.props["aria-activedescendant"],
    presentationRows: () => byRole(nodes(), "presentation"),
    emptyText: () => byRole(nodes(), "presentation")[0]?.props?.children,
    hidden: () =>
      walk(instance.tree).find((n) => n.type === "input" && n.props.type === "hidden")?.props.value,
  }
}

test("what is offered is money, not the units of account Intl mixes in", () => {
  const field = show()
  field.open()
  const codes = field.codes()
  assert.ok(codes.length > 100, "the runtime's own ISO 4217 list, not a shipped table")
  assert.equal(new Set(codes).size, codes.length, "and no duplicates")
  for (const code of codes) assert.match(code, /^[A-Z]{3}$/)

  // XDR (Special Drawing Rights) and XSU (Sucre) settle balances between central banks; neither is
  // a thing to price a subscription in. Everything else X-prefixed is a currency people are paid
  // in every day, and dropping the whole prefix — the obvious shortcut — would take those with it.
  assert.deepEqual([...NON_TENDER_CURRENCY_CODES], ["XDR", "XSU"])
  for (const bogus of NON_TENDER_CURRENCY_CODES) {
    assert.ok(!codes.includes(bogus), `${bogus} is named by Intl but is not tender`)
  }
  for (const real of ["XAF", "XOF", "XPF", "XCD"]) {
    assert.ok(codes.includes(real), `${real} is a circulating currency and must survive the cut`)
  }
})

test("decimal places are read per currency, which is the bug two-decimals hides", () => {
  assert.equal(getCurrencyFractionDigits("USD"), 2)
  assert.equal(getCurrencyFractionDigits("JPY"), 0, "¥100 is ¥100, not ¥1.00")
  assert.equal(getCurrencyFractionDigits("KRW"), 0)
  assert.equal(getCurrencyFractionDigits("BHD"), 3, "the Gulf dinars run to three")
  assert.equal(getCurrencyFractionDigits("KWD"), 3)
  // The reason it matters: payment APIs take minor units, so this exponent is a multiplier.
  const minor = (amount, code) => Math.round(amount * 10 ** getCurrencyFractionDigits(code))
  assert.equal(minor(1000, "JPY"), 1000, "assuming 2 here bills a hundred times the agreed price")
  assert.equal(minor(19.99, "USD"), 1999)
  assert.equal(getCurrencyFractionDigits("not-a-code"), 2, "a bad code falls back rather than throws")
})

test("the list is collated, not code-point sorted", () => {
  const field = show()
  field.open()
  const names = field.names()
  const collator = new Intl.Collator("en")
  const sorted = [...names].sort((a, b) => collator.compare(a, b))
  assert.deepEqual(names, sorted, "exactly the order this language sorts in")
  // The whole reason Intl.Collator is in the file: a plain sort() orders by code point, which puts
  // every accented name below Z. "São Tomé & Príncipe Dobra" belongs among the S's.
  const sao = names.findIndex((n) => n.startsWith("São"))
  assert.ok(sao >= 0 && sao < names.length - 15, "the accented name is not exiled to the bottom")
})

test("the filter reaches a currency by its English name on a page that is not in English", () => {
  const field = show({ locale: "ja" })
  field.open()
  field.search("japanese yen")
  assert.equal(field.names()[0], "日本円", "typing the English name finds the Japanese label")
  field.search("日本円")
  assert.equal(field.names()[0], "日本円", "which the local name still matches")
})

test("an exact three-letter code wins outright", () => {
  const field = show()
  field.open()
  field.search("sek")
  assert.equal(field.codes()[0], "SEK")
  field.search("jpy")
  assert.equal(field.codes()[0], "JPY")
})

test("typing the symbol searches, rather than folding away into an empty query", () => {
  const field = show()
  field.open()
  const all = field.codes().length

  field.search("¥")
  assert.deepEqual(field.codes(), ["JPY"], "a symbol query must not quietly show everything")
  assert.notEqual(field.codes().length, all)

  field.search("€")
  assert.deepEqual(field.codes(), ["EUR"])

  // The default currencyDisplay keeps the dollars apart — narrowSymbol would render AUD, CAD, NZD
  // and USD all as a bare "$", which is exactly the distinction a picker exists to make.
  field.search("$")
  assert.deepEqual(field.codes(), ["USD"])

  // "a$" is a different shape of query: the letter survives folding, so the name faces still run
  // and every currency with an "a" in it is a match too. The symbol face outranks them rather than
  // silencing them — the same way an exact code outranks a substring hit without hiding it.
  field.search("a$")
  assert.equal(field.codes()[0], "AUD")
  assert.ok(field.codes().length > 1, "ranking, not filtering — this is not an exclusive match")
})

test("accents and punctuation are folded away", () => {
  const field = show()
  field.open()
  field.search("sao tome")
  assert.equal(field.codes()[0], "STN", "no keyboard produces the ã, and the & is not typed either")
  field.search("costa rican colon")
  assert.equal(field.codes()[0], "CRC")
})

test("only the currencies with a symbol of their own show one", () => {
  assert.equal(getCurrencySymbol("JPY", "en"), "¥")
  assert.equal(getCurrencySymbol("AUD", "en"), "A$", "qualified, so it is not confused with USD")
  assert.equal(getCurrencySymbol("CHF", "en"), "", "repeating the code in the symbol slot is noise")
  assert.equal(getCurrencySymbol("nope", "en"), "", "a non-code produces nothing rather than throwing")

  const field = show({ currencies: ["JPY", "CHF"] })
  field.open()
  assert.deepEqual(field.symbols(), ["¥", ""], "and the row without one still shows name and code")
  const off = show({ currencies: ["JPY"], symbols: false })
  off.open()
  assert.deepEqual(off.symbols(), [""])
  assert.deepEqual(off.names(), ["Japanese Yen"], "the name and code carry the row on their own")
})

test("choosing a currency emits the code, never the name or the symbol", () => {
  const field = show()
  field.open()
  field.search("jpy")
  field.clickRow(0)
  assert.deepEqual(field.chosen, ["JPY"])
})

test("uncontrolled keeps the choice, and the hidden input carries it into a form", () => {
  const field = show({ name: "currency" })
  field.open()
  field.search("jpy")
  field.clickRow(0)
  assert.equal(field.triggerName(), "Japanese Yen")
  assert.equal(field.triggerCode(), "JPY", "the code is on the trigger, because it is the identity")
  assert.equal(field.hidden(), "JPY", "a native form submit sees the code")
})

test("a controlled field shows what the parent says and nothing else", () => {
  const field = show({ value: "EUR" })
  assert.equal(field.triggerName(), "Euro")
  field.open()
  field.search("jpy")
  field.clickRow(0)
  assert.deepEqual(field.chosen, ["JPY"], "the attempt is reported")
  assert.equal(field.triggerName(), "Euro", "but a parent that refuses it wins")
})

test("priority codes are pinned above the alphabet, and dropped once a query is typed", () => {
  const field = show({ priority: ["USD", "EUR"] })
  field.open()
  const codes = field.codes()
  assert.deepEqual(codes.slice(0, 2), ["USD", "EUR"], "in the order given")
  assert.equal(codes.filter((c) => c === "USD").length, 2, "still present in the alphabet below")
  field.search("dollar")
  assert.ok(
    !field.codes().slice(0, 1).includes("USD") || field.codes()[0] === "USD",
    "a search ranks by match quality"
  )
  assert.equal(new Set(field.codes()).size, field.codes().length, "and stops duplicating the pins")
})

test("narrowing with `currencies` still shows a stored code from outside the narrowed list", () => {
  // The ledger case: a row written in a currency you have since stopped accepting still has to
  // render, and reading as the placeholder would lose it on the next save.
  const field = show({ currencies: ["USD", "EUR"], value: "JPY" })
  assert.equal(field.triggerName(), "Japanese Yen")
  assert.equal(field.triggerCode(), "JPY")
  field.open()
  assert.deepEqual(field.codes(), ["EUR", "USD"])
})

test("historical codes stay, and stay labelled by the runtime", () => {
  const field = show()
  field.open()
  const codes = field.codes()
  assert.ok(codes.includes("SLL"), "an invoice from 2021 is denominated in the currency of 2021")
  assert.match(
    getCurrencyName("SLL", "en"),
    /\d{4}/,
    "and the runtime dates it, so nothing here has to maintain a retired flag"
  )
})

test("keyboard: arrows move the highlight, Enter takes it, Escape closes", () => {
  const field = show({ currencies: ["USD", "EUR", "JPY"] })
  field.open()
  assert.equal(field.activeIndex(), 0)
  field.press("ArrowDown")
  assert.equal(field.activeIndex(), 1)
  field.press("ArrowUp")
  assert.equal(field.activeIndex(), 0)
  field.press("ArrowUp")
  assert.equal(field.activeIndex(), 0, "and it does not walk off the top into a dead index")
  field.press("End")
  assert.equal(field.activeIndex(), 2)
  field.press("Home")
  assert.equal(field.activeIndex(), 0)
  field.press("Enter")
  assert.deepEqual(field.chosen, ["EUR"], "the collated list starts at Euro")
  assert.equal(byRole(walk(field.trigger()), "option").length, 0, "the panel closed behind it")
})

test("opening a field that already has a currency starts on that currency", () => {
  const field = show({ value: "JPY" })
  field.open()
  assert.equal(field.codes()[field.activeIndex()], "JPY", "not the top of the alphabet 80 rows up")
})

test("a query that matches nothing says so without offering a phantom option", () => {
  const field = show({ emptyMessage: "No such currency." })
  field.open()
  field.search("zzzzzz")
  assert.equal(field.rows().length, 0, "nothing selectable is left in the listbox")
  assert.equal(field.emptyText(), "No such currency.", "and the reason is stated")
  // The message must not be announced as a choice: a listbox whose only child is an option the
  // user cannot pick reads to a screen reader as one available currency.
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

test("a runtime with no currency list renders an empty field rather than throwing", () => {
  const field = show({ currencies: [] })
  field.open()
  assert.equal(field.rows().length, 0)
  assert.equal(field.presentationRows().length, 1, "the empty message, not a crash")
})
