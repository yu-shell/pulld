// The mention box that looks right and is not, in the six ways this file pins down:
//
//   - opening the menu on the `@` in an email address, because the trigger was found by scanning
//     backwards without asking what precedes it,
//   - letting a query run past the first space, so one stray `@` turns the rest of the paragraph
//     into a search term,
//   - anchoring the menu to the field instead of the caret, so an `@` on line three offers its
//     suggestions next to line one,
//   - taking Enter and the arrow keys while an IME conversion is open, which leaves a Japanese
//     writer unable to finish a word,
//   - inserting the name with setState, which looks identical and empties the browser's undo stack,
//   - and re-announcing the result count into a live region on every keystroke.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  findMentionQuery,
  defaultMentionFilter,
  insertMentionText,
  measureCaretPosition,
  defaultMentionLabels,
  useMentionInput,
  MentionInput,
} = loadComponent(join(ROOT, "registry", "ui", "mention-input.tsx"))

const PEOPLE = [
  { id: "1", label: "Ada Lovelace", value: "ada", description: "ada@example.com" },
  { id: "2", label: "Alan Turing", value: "alan", description: "Engineering" },
  { id: "3", label: "Grace Hopper", value: "grace", description: "grace@example.com" },
  { id: "4", label: "José Valim", value: "jose", description: "Elixir" },
]

// --- finding the query ---------------------------------------------------------------------------

test("an email address is not a mention", () => {
  // The whole reason the trigger needs a boundary rule: every one of these has an `@` in it and a
  // caret after it, and a backwards scan alone would open the menu on all of them.
  for (const value of ["ada@example.com", "write to ada@example", "a@b", "ADA@EXAMPLE.COM"]) {
    assert.equal(findMentionQuery(value, value.length), null, value)
  }
})

test("a trigger at a word boundary opens a query", () => {
  assert.deepEqual(findMentionQuery("@ad", 3), { trigger: "@", query: "ad", start: 0, end: 3 })
  assert.deepEqual(findMentionQuery("hi @ad", 6), { trigger: "@", query: "ad", start: 3, end: 6 })
  // Punctuation is a boundary too — "(@ada" happens inside parentheses and after a newline.
  assert.equal(findMentionQuery("(@ad", 4)?.query, "ad")
  assert.equal(findMentionQuery("line one\n@ad", 12)?.query, "ad")
  // The trigger alone is a query for the empty string: the menu opens showing everyone.
  assert.deepEqual(findMentionQuery("@", 1), { trigger: "@", query: "", start: 0, end: 1 })
})

test("a space ends the query, so one stray @ does not search the paragraph", () => {
  assert.equal(findMentionQuery("@ada is here", 12), null)
  assert.equal(findMentionQuery("@ada ", 5), null)
  // ...unless the caller asks for names with spaces in them.
  assert.equal(findMentionQuery("@ada love", 9, { allowSpaces: true })?.query, "ada love")
  // A line break ends it even then: the mention cannot span paragraphs.
  assert.equal(findMentionQuery("@ada\nlove", 9, { allowSpaces: true }), null)
})

test("the query is read at the caret, not at the end of the value", () => {
  const value = "hi @ad, and thanks"
  // Caret sits after "@ad" — the text to its right must not be part of the query, and must not
  // stop one being found either.
  assert.deepEqual(findMentionQuery(value, 6), { trigger: "@", query: "ad", start: 3, end: 6 })
})

test("the backwards scan is bounded, and the bound is the longest query", () => {
  const long = `@${"a".repeat(40)}`
  assert.equal(findMentionQuery(long, long.length), null)
  assert.equal(findMentionQuery(long, long.length, { maxQueryLength: 64 })?.query.length, 40)
  // A value with no trigger at all still answers in bounded time rather than walking 40 KB.
  assert.equal(findMentionQuery("x".repeat(40_000), 40_000), null)
})

test("the trigger is a prop, and doubling it is not a mention", () => {
  assert.equal(findMentionQuery("fixes #12", 9, { trigger: "#" })?.query, "12")
  assert.equal(findMentionQuery(":smi", 4, { trigger: ":" })?.query, "smi")
  assert.equal(findMentionQuery("@@ad", 4), null)
})

// --- filtering -----------------------------------------------------------------------------------

test("accents fold both ways, so José answers to jose and josé finds Jose", () => {
  assert.deepEqual(
    defaultMentionFilter(PEOPLE, "jose").map((p) => p.id),
    ["4"]
  )
  assert.deepEqual(
    defaultMentionFilter([{ id: "x", label: "Jose Valim" }], "josé").map((p) => p.id),
    ["x"]
  )
  // Decomposed and precomposed spellings of the same name are the same name.
  assert.deepEqual(
    defaultMentionFilter([{ id: "y", label: "José Valim" }], "jose").map((p) => p.id),
    ["y"]
  )
})

test("a match at the start of a word outranks one buried inside", () => {
  const items = [
    { id: "clover", label: "Clover Team" },
    { id: "ada", label: "Ada Lovelace" },
  ]
  // "Lovelace" starts a word; "Clover" only contains the letters.
  assert.deepEqual(
    defaultMentionFilter(items, "love").map((p) => p.id),
    ["ada", "clover"]
  )
})

test("the handle matches, and the description matches last", () => {
  assert.deepEqual(
    defaultMentionFilter(PEOPLE, "grace").map((p) => p.id),
    ["3"]
  )
  // "Engineering" is only in Alan's description, so he is found — behind anyone matched by name.
  assert.deepEqual(
    defaultMentionFilter(PEOPLE, "engineering").map((p) => p.id),
    ["2"]
  )
  assert.deepEqual(defaultMentionFilter(PEOPLE, "nobody"), [])
  assert.equal(defaultMentionFilter(PEOPLE, "").length, PEOPLE.length)
})

// --- inserting -----------------------------------------------------------------------------------

function fakeField(value, caret = value.length, ownerDocument = {}) {
  return {
    tagName: "TEXTAREA",
    value,
    selectionStart: caret,
    selectionEnd: caret,
    ownerDocument,
    events: [],
    ranges: [],
    focus() {},
    setSelectionRange(start, end) {
      this.selectionStart = start
      this.selectionEnd = end
      this.ranges.push([start, end])
    },
    dispatchEvent(event) {
      this.events.push(event.type)
      return true
    },
  }
}

test("the insert goes through the browser's own editing pipeline, so undo still works", () => {
  const calls = []
  const el = fakeField("hi @ad", 6, {
    execCommand(command, ui, text) {
      calls.push([command, ui, text])
      return true
    },
  })
  assert.equal(insertMentionText(el, 3, 6, "@ada "), true)
  // The range is selected first, then replaced by the command — the component never assigns to
  // .value itself, which is exactly what would have thrown the undo stack away.
  assert.deepEqual(el.ranges, [[3, 6]])
  assert.deepEqual(calls, [["insertText", false, "@ada "]])
  assert.equal(el.value, "hi @ad")
  assert.deepEqual(el.events, [])
})

test("without that pipeline the value is written and React is told, exactly once", () => {
  const el = fakeField("hi @ad, thanks", 6)
  assert.equal(insertMentionText(el, 3, 6, "@ada "), false)
  assert.equal(el.value, "hi @ada , thanks")
  // Caret lands after the inserted text, not at the end of the value.
  assert.deepEqual(el.ranges.at(-1), [8, 8])
  assert.deepEqual(el.events, ["input"])
})

test("a command that refuses still leaves the text inserted", () => {
  // Firefox returned false here for years, and a component that trusted the return value silently
  // did nothing when a name was picked.
  const el = fakeField("@ad", 3, { execCommand: () => false })
  assert.equal(insertMentionText(el, 0, 3, "@ada "), false)
  assert.equal(el.value, "@ada ")
})

// --- measuring -----------------------------------------------------------------------------------

test("the caret measurement answers null rather than throwing off the browser", () => {
  // Server render and the first client pass both reach this; the menu falls back to sitting under
  // the field instead of failing to render at all.
  assert.equal(measureCaretPosition(fakeField("hi @ad"), 3), null)
})

// --- the component -------------------------------------------------------------------------------

const nodesOf = (view) => walk(view.tree)
const listboxOf = (view) => nodesOf(view).find((n) => n.props?.role === "listbox")
const optionsOf = (view) => nodesOf(view).filter((n) => n.props?.role === "option")
const fieldOf = (view) => byTag(nodesOf(view), "textarea")[0]
const liveOf = (view) => nodesOf(view).find((n) => n.props?.["aria-live"] === "polite")

const inputEvent = (value, caret = value.length) => ({ currentTarget: { value, selectionStart: caret } })
// Each row renders a fragment (label, then an optional description), so the label is the first span.
const labelsOf = (view) =>
  optionsOf(view).map((option) => walk(option.props.children).find((n) => n.type === "span")?.props.children)

function keyEvent(key, extra = {}) {
  const event = {
    key,
    shiftKey: false,
    keyCode: 0,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
    ...extra,
  }
  return event
}

test("the field is a combobox before anything is typed, and there is no menu", () => {
  const view = render(MentionInput, { items: PEOPLE })
  const field = fieldOf(view)
  assert.equal(field.props.role, "combobox")
  // aria-expanded is required on a combobox and has to be there while it is closed too.
  assert.equal(field.props["aria-expanded"], false)
  assert.equal(field.props["aria-activedescendant"], undefined)
  assert.equal(listboxOf(view), undefined)
})

test("typing a trigger opens the menu and points activedescendant at the first row", () => {
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("hi @a"))
  view.rerender()

  const options = optionsOf(view)
  // Everyone here has an "a" somewhere; the two whose name starts with one come first.
  assert.deepEqual(labelsOf(view), [
    "Ada Lovelace",
    "Alan Turing",
    "Grace Hopper",
    "José Valim",
  ])
  const field = fieldOf(view)
  assert.equal(field.props["aria-expanded"], true)
  assert.equal(field.props["aria-controls"], listboxOf(view).props.id)
  assert.equal(field.props["aria-activedescendant"], options[0].props.id)
  assert.equal(options[0].props["aria-selected"], true)
  assert.equal(options[1].props["aria-selected"], false)
})

test("an email typed into the field never opens the menu", () => {
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("write to ada@example.com"))
  view.rerender()
  assert.equal(listboxOf(view), undefined)
  assert.equal(fieldOf(view).props["aria-expanded"], false)
})

test("the arrows move the highlight, wrap, and step over disabled rows", () => {
  const items = [
    { id: "1", label: "Ada" },
    { id: "2", label: "Alan", disabled: true },
    { id: "3", label: "Grace" },
  ]
  const view = render(MentionInput, { items })
  fieldOf(view).props.onInput(inputEvent("@"))
  view.rerender()

  const press = (key) => {
    const event = keyEvent(key)
    fieldOf(view).props.onKeyDown(event)
    view.rerender()
    return event
  }
  assert.equal(press("ArrowDown").prevented, true)
  assert.equal(fieldOf(view).props["aria-activedescendant"], optionsOf(view)[2].props.id)
  // Down again from the last row wraps to the first rather than sticking.
  press("ArrowDown")
  assert.equal(fieldOf(view).props["aria-activedescendant"], optionsOf(view)[0].props.id)
  press("ArrowUp")
  assert.equal(fieldOf(view).props["aria-activedescendant"], optionsOf(view)[2].props.id)
})

test("Escape closes the menu and typing on does not reopen the same mention", () => {
  const view = render(MentionInput, { items: PEOPLE })
  const type = (value) => {
    fieldOf(view).props.onInput(inputEvent(value))
    view.rerender()
  }
  type("hi @a")
  assert.ok(listboxOf(view))

  const escape = keyEvent("Escape")
  fieldOf(view).props.onKeyDown(escape)
  view.rerender()
  assert.equal(escape.prevented, true)
  assert.equal(listboxOf(view), undefined)

  // Still dismissed while the same `@` is being typed into...
  type("hi @ad")
  assert.equal(listboxOf(view), undefined)
  // ...and alive again for the next one.
  type("hi @ad and @g")
  assert.ok(listboxOf(view))
})

test("an open IME conversion keeps its own keys", () => {
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("@a"))
  view.rerender()

  for (const event of [
    keyEvent("Enter", { nativeEvent: { isComposing: true } }),
    keyEvent("Enter", { keyCode: 229 }),
    keyEvent("ArrowDown", { nativeEvent: { isComposing: true } }),
  ]) {
    fieldOf(view).props.onKeyDown(event)
    view.rerender()
    // Not taken: the Enter commits the reading and the arrow walks the candidate window.
    assert.equal(event.prevented, false, event.key)
  }
  // The menu is still there, still on its first row — nothing was chosen behind the writer's back.
  assert.equal(fieldOf(view).props["aria-activedescendant"], optionsOf(view)[0].props.id)
})

test("compositionstart is enough on its own, for the browsers that clear isComposing early", () => {
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("@a"))
  fieldOf(view).props.onCompositionStart({})
  view.rerender()

  const event = keyEvent("Enter")
  fieldOf(view).props.onKeyDown(event)
  view.rerender()
  assert.equal(event.prevented, false)

  // Once the conversion is committed the key is the menu's again.
  fieldOf(view).props.onCompositionEnd(inputEvent("@a"))
  view.rerender()
  const after = keyEvent("ArrowDown")
  fieldOf(view).props.onKeyDown(after)
  view.rerender()
  assert.equal(after.prevented, true)
})

test("the count is announced when the menu opens and not again on every keystroke", () => {
  const view = render(MentionInput, { items: PEOPLE })
  const type = (value) => {
    fieldOf(view).props.onInput(inputEvent(value))
    view.rerender()
  }
  assert.equal(liveOf(view).props.children, "")

  type("hi @a")
  assert.equal(optionsOf(view).length, 4)
  assert.equal(liveOf(view).props.children, defaultMentionLabels.results(4))

  // Narrowing to one match is not news worth interrupting for: the row itself is announced by
  // aria-activedescendant, and a live region that fires per keystroke reads the count over the
  // letters being typed.
  type("hi @ada")
  assert.equal(optionsOf(view).length, 1)
  assert.equal(liveOf(view).props.children, defaultMentionLabels.results(4))

  // Running out of matches is news.
  type("hi @adax")
  assert.equal(liveOf(view).props.children, defaultMentionLabels.empty)
})

test("no matches closes the menu unless the caller wants the empty row", () => {
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("@nobody"))
  view.rerender()
  assert.equal(listboxOf(view), undefined)

  const shown = render(MentionInput, { items: PEOPLE, showEmpty: true })
  fieldOf(shown).props.onInput(inputEvent("@nobody"))
  shown.rerender()
  assert.ok(listboxOf(shown))
  assert.equal(optionsOf(shown).length, 0)
})

test("the menu sits under the field until the caret has been measured", () => {
  // No layout here, which is also the server's answer — the menu still has to render somewhere.
  const view = render(MentionInput, { items: PEOPLE })
  fieldOf(view).props.onInput(inputEvent("@a"))
  view.rerender()
  const panel = listboxOf(view)
  assert.equal(panel.props.style, undefined)
  assert.match(panel.props.className, /top-full/)
})

// --- the hook, driving a field it can actually write to -------------------------------------------

function probe(options) {
  let api = null
  const Probe = (props) => {
    api = useMentionInput(props)
    return null
  }
  const view = render(Probe, options)
  // A getter, and never spread into another object: the hook returns a fresh result every pass and
  // a copy taken once would be asserted on long after it stopped being true.
  return { view, get api() { return api } }
}

test("choosing a row replaces the query, keeps the trigger, and closes the menu", () => {
  const chosen = []
  const p = probe({ items: PEOPLE, onMentionSelect: (item) => chosen.push(item.id) })
  const el = fakeField("hi @ad, thanks", 6)
  p.api.fieldRef.current = el

  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  assert.equal(p.api.open, true)
  assert.equal(p.api.items[0].label, "Ada Lovelace")

  p.api.select(p.api.items[0])
  p.view.rerender()
  // The handle is inserted rather than the label, because "@Ada Lovelace" is not a token anything
  // can find again — and only the query is replaced, not the text after the caret.
  assert.equal(el.value, "hi @ada , thanks")
  assert.deepEqual(chosen, ["1"])
  assert.equal(p.api.open, false)
})

test("Enter chooses, Shift+Enter is still a new line", () => {
  const p = probe({ items: PEOPLE })
  const el = fakeField("@ad")
  p.api.fieldRef.current = el

  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()

  const shifted = keyEvent("Enter", { shiftKey: true })
  p.api.fieldProps.onKeyDown(shifted)
  p.view.rerender()
  assert.equal(shifted.prevented, false)
  assert.equal(el.value, "@ad")

  const enter = keyEvent("Enter")
  p.api.fieldProps.onKeyDown(enter)
  p.view.rerender()
  assert.equal(enter.prevented, true)
  assert.equal(el.value, "@ada ")
})

test("a custom insertion that does not end in a space still closes the menu", () => {
  // Otherwise the name just chosen becomes the next query and the menu reopens on top of itself.
  const p = probe({ items: PEOPLE, toInsertText: (item) => `@${item.value}` })
  const el = fakeField("@ad")
  p.api.fieldRef.current = el

  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  p.api.select(p.api.items[0])
  p.view.rerender()
  assert.equal(el.value, "@ada")

  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  assert.equal(p.api.open, false)
})

test("the query is reported as it changes, and never as a null nobody asked for", () => {
  const seen = []
  const p = probe({ items: PEOPLE, onQueryChange: (q) => seen.push(q && q.query) })
  const el = fakeField("")
  p.api.fieldRef.current = el

  // Mounting is not a question: an async lookup should not fire before anything is typed.
  assert.deepEqual(seen, [])

  el.value = "@a"
  el.selectionStart = 2
  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  el.value = "@ad"
  el.selectionStart = 3
  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  p.api.dismiss()
  p.view.rerender()
  assert.deepEqual(seen, ["a", "ad", null])
})

test("server-side filtering is left alone", () => {
  const p = probe({ items: PEOPLE, filter: false })
  const el = fakeField("@zzz")
  p.api.fieldRef.current = el
  p.api.fieldProps.onInput({ currentTarget: el })
  p.view.rerender()
  // Nothing matches "zzz" locally, and that is not this component's call to make.
  assert.equal(p.api.items.length, 4)
})
