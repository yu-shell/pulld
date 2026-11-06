// The formatting toolbar everyone writes first reads the selection, concatenates the markers around
// it, and writes the result back with `setRangeText`. It looks finished the moment you press Bold.
// The cases below are written to fail against that implementation and the four others it grows into:
//
//   - `setRangeText`, which writes the text and silently drops the browser's undo entry, so Cmd+Z
//     after a bold skips past it to whatever was typed before,
//   - a toggle that tests for markers in only one of the two places they can be, and so adds a
//     second `**` instead of removing the first,
//   - a line marker applied per line, so a four-line selection with one bullet already in it comes
//     back three bullets and one plain line,
//   - a line block taken from `selectionEnd` as given, which puts a bullet on the line a downward
//     drag merely touched at column 0,
//   - and inline backticks around a multi-line selection, which is not a code block.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

const {
  applyEdit,
  toggleWrap,
  toggleLinePrefix,
  lineBlock,
  insertLink,
  editFor,
  writeEdit,
  MARKDOWN_ACTIONS,
  MarkdownToolbar,
} = loadComponent(join(ROOT, "registry", "ui", "markdown-toolbar.tsx"), {
  stubs: {
    "lucide-react": {
      Bold: icon("bold"),
      Italic: icon("italic"),
      Strikethrough: icon("strike"),
      Code: icon("code"),
      Link: icon("link"),
      List: icon("list"),
      ListOrdered: icon("ordered"),
      Quote: icon("quote"),
    },
  },
})

/** Runs an action the way the component does, and reports the result as text plus the selection. */
function act(value, start, end, spec) {
  const edit = editFor({ value, start, end }, spec)
  const next = applyEdit(value, edit)
  return {
    value: next,
    start: edit.selectionStart,
    end: edit.selectionEnd,
    selected: next.slice(edit.selectionStart, edit.selectionEnd),
  }
}

const BOLD = MARKDOWN_ACTIONS.bold.spec
const ITALIC = MARKDOWN_ACTIONS.italic.spec
const CODE = MARKDOWN_ACTIONS.code.spec
const BULLETS = MARKDOWN_ACTIONS.bulletList.spec
const NUMBERS = MARKDOWN_ACTIONS.orderedList.spec
const QUOTE = MARKDOWN_ACTIONS.quote.spec

// --- wrapping -------------------------------------------------------------------------------------

test("bold wraps the selection and leaves the same words highlighted", () => {
  const out = act("Alpha bravo charlie", 6, 11, BOLD)
  assert.equal(out.value, "Alpha **bravo** charlie")
  // Not `**bravo**`: the highlight stays on what the person highlighted.
  assert.equal(out.selected, "bravo")
})

test("a second press removes the markers it just added", () => {
  const first = act("Alpha bravo charlie", 6, 11, BOLD)
  const second = act(first.value, first.start, first.end, BOLD)
  assert.equal(second.value, "Alpha bravo charlie")
  assert.equal(second.selected, "bravo")
})

test("bold, italic, bold again leaves the italics alone", () => {
  const bolded = act("Alpha bravo charlie", 6, 11, BOLD)
  const italicised = act(bolded.value, bolded.start, bolded.end, ITALIC)
  assert.equal(italicised.value, "Alpha **_bravo_** charlie")
  const unbolded = act(italicised.value, italicised.start, italicised.end, BOLD)
  assert.equal(unbolded.value, "Alpha _bravo_ charlie")
})

test("markers dragged over by hand are removed too", () => {
  // The selection covers `**bravo**` itself, which is the other arrangement a toggle has to see.
  const out = act("Alpha **bravo** charlie", 6, 15, BOLD)
  assert.equal(out.value, "Alpha bravo charlie")
  assert.equal(out.selected, "bravo")
})

test("an empty selection inserts the pair and parks the caret between the markers", () => {
  const out = act("Alpha  charlie", 6, 6, BOLD)
  assert.equal(out.value, "Alpha ****  charlie".replace("  ", " "))
  assert.equal(out.start, 8)
  assert.equal(out.end, 8)
  assert.equal(out.value.slice(0, out.start), "Alpha **")
})

test("a caret already sitting between markers clears them", () => {
  const opened = act("", 0, 0, BOLD)
  assert.equal(opened.value, "****")
  assert.equal(opened.start, 2)
  const closed = act(opened.value, opened.start, opened.end, BOLD)
  assert.equal(closed.value, "")
})

test("a backward range is read in order rather than collapsing", () => {
  // The DOM never reports one, but a caller computing offsets can hand one over, and
  // `setSelectionRange(11, 6)` collapses to (6,6) rather than selecting backwards.
  assert.deepEqual(act("Alpha bravo charlie", 11, 6, BOLD), act("Alpha bravo charlie", 6, 11, BOLD))
})

test("a selection shorter than the markers is not mistaken for a wrapped one", () => {
  // A length-blind startsWith/endsWith pair reads the single `*` as both halves at once and
  // deletes the only character there was.
  assert.equal(act("*", 0, 1, BOLD).value, "*****")
  assert.equal(act("*", 0, 1, BOLD).selected, "*")
})

test("bold next to someone else's markers is not read as closing them", () => {
  // `**` touches the selection on the left, and nothing closes it on the right. A check that only
  // looks at the characters touching the selection unwraps the bold off `bold` instead.
  const out = act("**bold**text", 8, 12, BOLD)
  assert.equal(out.value, "**bold****text**")
})

test("bold comes off through a layer of italics rather than nesting inside it", () => {
  // The markers are there, with the italic ones standing between them and the selection.
  const out = act("Alpha **_bravo_** charlie", 9, 14, BOLD)
  assert.equal(out.value, "Alpha _bravo_ charlie")
  assert.equal(out.selected, "bravo")
})

test("the inner marker still comes off from the inside", () => {
  const out = act("Alpha **_bravo_** charlie", 9, 14, ITALIC)
  assert.equal(out.value, "Alpha **bravo** charlie")
  assert.equal(out.selected, "bravo")
})

test("a wrap at the very start of the field comes off", () => {
  // The leftward scan has to be able to reach index 0; stopping one short of it reads the opening
  // `**` as a single `*` and adds a second pair instead.
  const out = act("**bravo** charlie", 2, 7, BOLD)
  assert.equal(out.value, "bravo charlie")
  assert.equal(out.start, 0)
})

test("a nested wrap at the very start of the field comes off", () => {
  // Not the same case as the one above: here the markers do not touch the selection, so the
  // leftward scan is the only thing that can find them and it has to reach index 0 to do it.
  const out = act("**_bravo_**", 3, 8, BOLD)
  assert.equal(out.value, "_bravo_")
  assert.equal(out.selected, "bravo")
})

test("an opening marker before the selection is not enough on its own", () => {
  // `**` sits just before `b` and `!!` just after it. Accepting either side alone strips a pair
  // that was never there and takes the previous word's bold with it.
  const out = act("**a**b!!", 5, 6, BOLD)
  assert.equal(out.value, "**a****b**!!")
})

test("the marker it is looking for is found through two other layers", () => {
  const out = act("~~**_bravo_**~~", 5, 10, BOLD)
  assert.equal(out.value, "~~_bravo_~~")
  assert.equal(out.selected, "bravo")
})

test("an empty pair selected whole is removed rather than doubled", () => {
  // `****` is exactly as long as the two markers, with nothing between them.
  assert.equal(act("****", 0, 4, BOLD).value, "")
})

test("a lone marker pair is not read as a wrapped empty string", () => {
  // `**` both starts and ends with `**` when the length is not checked, and a toggle that skips
  // that check deletes the characters instead of bolding them.
  assert.equal(act("**", 0, 2, BOLD).value, "******")
})

test("a half-wrapped selection is not unwrapped from the middle", () => {
  // `**bravo` starts with the marker and does not end with it. Accepting either half alone cuts
  // two characters off the far end of the person's own words.
  assert.equal(act("**bravo xyz", 0, 7, BOLD).value, "****bravo** xyz")
})

test("code uses a fence when the selection spans lines, and backticks when it does not", () => {
  const inline = act("one", 0, 3, CODE)
  assert.equal(inline.value, "`one`")

  const block = act("one\ntwo", 0, 7, CODE)
  assert.equal(block.value, "```\none\ntwo\n```")
  assert.equal(block.selected, "one\ntwo")
})

test("a fenced block toggles back off", () => {
  const block = act("one\ntwo", 0, 7, CODE)
  const back = act(block.value, block.start, block.end, CODE)
  assert.equal(back.value, "one\ntwo")
})

// --- line markers ---------------------------------------------------------------------------------

test("a bullet goes on every line the selection touches", () => {
  const out = act("one\ntwo\nthree", 1, 9, BULLETS)
  assert.equal(out.value, "- one\n- two\n- three")
  // The whole rewritten block stays selected, so a second press can clear it.
  assert.equal(out.selected, "- one\n- two\n- three")
})

test("a mixed selection normalises to all-bulleted rather than toggling line by line", () => {
  const out = act("- one\ntwo\nthree", 0, 15, BULLETS)
  assert.equal(out.value, "- one\n- two\n- three")
})

test("a fully bulleted selection clears", () => {
  const out = act("- one\n- two\n- three", 0, 19, BULLETS)
  assert.equal(out.value, "one\ntwo\nthree")
})

test("one press then another returns the text it started with", () => {
  const on = act("one\ntwo\nthree", 0, 13, BULLETS)
  const off = act(on.value, on.start, on.end, BULLETS)
  assert.equal(off.value, "one\ntwo\nthree")
})

test("the other bullet characters count as already bulleted", () => {
  assert.equal(act("* one\n+ two", 0, 11, BULLETS).value, "one\ntwo")
})

test("a selection ending at column 0 does not reach the line below it", () => {
  // "one\n" selected: one line of visible highlight. The naive block runs to the end of "two".
  const out = act("one\ntwo", 0, 4, BULLETS)
  assert.equal(out.value, "- one\ntwo")
})

test("blank lines keep their place and do not block clearing", () => {
  const out = act("- one\n\n- two", 0, 12, BULLETS)
  assert.equal(out.value, "one\n\ntwo")
})

test("a selection of nothing but blank lines gets markers rather than being read as cleared", () => {
  const out = act("\n\n", 0, 2, BULLETS)
  assert.equal(out.value, "\n\n")
})

test("numbers are rewritten to their position, not repeated", () => {
  const out = act("one\ntwo\nthree", 0, 13, NUMBERS)
  assert.equal(out.value, "1. one\n2. two\n3. three")
})

test("adding numbers to a part-numbered block numbers the whole of it in order", () => {
  // This is where renumbering has to happen: the lines that already had a number keep their
  // position in the list rather than their old digit.
  const out = act("3. one\ntwo\n7. three", 0, 18, NUMBERS)
  assert.equal(out.value, "1. one\n2. two\n3. three")
})

test("an already-numbered block clears, and a second press renumbers it", () => {
  // The button stays a toggle: every line already has a number, so the press takes them off.
  // Mis-numbered input is therefore fixed by two presses, not one.
  const cleared = act("3. one\n7. two\n7. three", 0, 22, NUMBERS)
  assert.equal(cleared.value, "one\ntwo\nthree")
  const renumbered = act(cleared.value, cleared.start, cleared.end, NUMBERS)
  assert.equal(renumbered.value, "1. one\n2. two\n3. three")
})

test("a numbered block clears, and the numbers do not survive as text", () => {
  const on = act("one\ntwo", 0, 7, NUMBERS)
  const off = act(on.value, on.start, on.end, NUMBERS)
  assert.equal(off.value, "one\ntwo")
})

test("numbering skips blank lines without spending a number on them", () => {
  const out = act("one\n\ntwo", 0, 8, NUMBERS)
  assert.equal(out.value, "1. one\n\n2. two")
})

test("a quote marker written without its space is still recognised", () => {
  assert.equal(act(">one\n>two", 0, 9, QUOTE).value, "one\ntwo")
  assert.equal(act("one", 0, 3, QUOTE).value, "> one")
})

test("a caret stays a caret and travels with its own line", () => {
  // Caret after "tw" on the second line of three.
  const value = "one\ntwo\nthree"
  const out = act(value, 6, 6, BULLETS)
  assert.equal(out.value, "one\n- two\nthree")
  assert.equal(out.start, out.end, "a button press should not create a selection")
  assert.equal(out.value.slice(0, out.start), "one\n- tw")
})

test("a caret on a line that loses its marker travels back", () => {
  const out = act("- two", 4, 4, BULLETS)
  assert.equal(out.value, "two")
  assert.equal(out.start, 2)
  assert.equal(out.end, 2)
})

test("lineBlock finds the whole line for a caret at either edge", () => {
  const value = "one\ntwo\nthree"
  assert.deepEqual(lineBlock(value, 0, 0), { from: 0, to: 3 })
  assert.deepEqual(lineBlock(value, 3, 3), { from: 0, to: 3 })
  assert.deepEqual(lineBlock(value, 4, 4), { from: 4, to: 7 })
  assert.deepEqual(lineBlock(value, 8, 13), { from: 8, to: 13 })
})

// --- links ----------------------------------------------------------------------------------------

const LINK = MARKDOWN_ACTIONS.link.spec

test("the link action is reached through the same dispatcher as the others", () => {
  // Routed through `editFor` rather than straight to `insertLink`, so the branch that picks the
  // link case is covered too: a dispatcher that falls through returns a no-op edit and the button
  // silently does nothing.
  const out = act("docs", 0, 4, LINK)
  assert.equal(out.value, "[docs]()")
})

test("every default action is dispatched by its own kind", () => {
  // One pass over the table, so a spec whose `kind` no longer matches its branch shows up here
  // rather than as a button that does nothing.
  const cases = [
    ["bold", "x", "**x**"],
    ["italic", "x", "_x_"],
    ["strikethrough", "x", "~~x~~"],
    ["code", "x", "`x`"],
    ["link", "x", "[x]()"],
    ["bulletList", "x", "- x"],
    ["orderedList", "x", "1. x"],
    ["quote", "x", "> x"],
  ]
  for (const [name, input, expected] of cases) {
    const spec = MARKDOWN_ACTIONS[name].spec
    assert.equal(act(input, 0, input.length, spec).value, expected, `${name} should produce ${expected}`)
  }
})

test("the default table carries the names, labels and shortcuts it documents", () => {
  const table = Object.entries(MARKDOWN_ACTIONS).map(([key, action]) => [
    key,
    action.name,
    action.label,
    action.shortcut,
  ])
  assert.deepEqual(table, [
    ["bold", "bold", "Bold", "b"],
    ["italic", "italic", "Italic", "i"],
    ["strikethrough", "strikethrough", "Strikethrough", undefined],
    ["code", "code", "Code", "e"],
    ["link", "link", "Link", "k"],
    ["bulletList", "bulletList", "Bulleted list", undefined],
    ["orderedList", "orderedList", "Numbered list", undefined],
    ["quote", "quote", "Quote", undefined],
  ])
})

test("selected words become the label, with the caret waiting in the parentheses", () => {
  const out = insertLink({ value: "see the docs", start: 8, end: 12 })
  const next = applyEdit("see the docs", out)
  assert.equal(next, "see the [docs]()")
  assert.equal(out.selectionStart, out.selectionEnd)
  assert.equal(next.slice(0, out.selectionStart), "see the [docs](")
})

test("a selected URL becomes the target, with the caret waiting in the label", () => {
  const value = "https://example.com"
  const out = insertLink({ value, start: 0, end: value.length })
  const next = applyEdit(value, out)
  assert.equal(next, "[](https://example.com)")
  assert.equal(out.selectionStart, 1)
  assert.equal(out.selectionEnd, 1)
})

test("mailto: and bare www. count as URLs too", () => {
  assert.equal(
    applyEdit("mailto:a@b.c", insertLink({ value: "mailto:a@b.c", start: 0, end: 12 })),
    "[](mailto:a@b.c)"
  )
  assert.equal(
    applyEdit("www.example.com", insertLink({ value: "www.example.com", start: 0, end: 15 })),
    "[](www.example.com)"
  )
})

test("no placeholder word is left in the empty slot", () => {
  const next = applyEdit("docs", insertLink({ value: "docs", start: 0, end: 4 }))
  assert.equal(next, "[docs]()")
  assert.ok(!/url|text|https/i.test(next), "an untouched link should not read as a real one")
})

test("a whole link unwraps back to its label", () => {
  const value = "see [the docs](https://example.com) now"
  const end = value.indexOf(")") + 1
  const out = insertLink({ value, start: 4, end })
  assert.equal(applyEdit(value, out), "see the docs now")
  assert.equal(out.selectionStart, 4)
  assert.equal(out.selectionEnd, 12)
})

test("an empty selection opens an empty link with the caret in the label", () => {
  const out = insertLink({ value: "", start: 0, end: 0 })
  assert.equal(applyEdit("", out), "[]()")
  // The label is the empty slot here, so that is where the typing starts.
  assert.equal(out.selectionStart, 1)
  assert.equal(out.selectionEnd, 1)
})

// --- writing it into a field ----------------------------------------------------------------------

/** A stand-in for a textarea: records the calls that matter and keeps a real value. */
function fakeField(value, { withSetRangeText = true } = {}) {
  const calls = []
  const field = {
    value,
    selectionStart: 0,
    selectionEnd: 0,
    focus: () => calls.push({ name: "focus" }),
    setSelectionRange: (start, end) => {
      calls.push({ name: "setSelectionRange", args: [start, end] })
      field.selectionStart = start
      field.selectionEnd = end
    },
    dispatchEvent: (event) => {
      calls.push({ name: "dispatchEvent", args: [event.type, event.bubbles] })
      return true
    },
    addEventListener: (...args) => calls.push({ name: "addEventListener", args }),
    removeEventListener: (...args) => calls.push({ name: "removeEventListener", args }),
    calls,
  }
  if (withSetRangeText) {
    field.setRangeText = (text, start, end) => {
      calls.push({ name: "setRangeText", args: [text, start, end] })
      field.value = field.value.slice(0, start) + text + field.value.slice(end)
    }
  }
  return field
}

/** Installs a `document` with the editing commands, and hands back what was asked of it. */
function withDocument({ supported, execReturns }, body) {
  const asked = []
  const previous = globalThis.document
  globalThis.document = {
    queryCommandSupported: (name) => {
      asked.push({ name: "queryCommandSupported", args: [name] })
      return supported
    },
    execCommand: (...args) => {
      asked.push({ name: "execCommand", args })
      return execReturns
    },
  }
  try {
    return { result: body(), asked }
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
}

test("the undo-preserving command is the one tried first", () => {
  const field = fakeField("Alpha bravo charlie")
  const edit = editFor({ value: field.value, start: 6, end: 11 }, BOLD)
  const { result, asked } = withDocument({ supported: true, execReturns: true }, () =>
    writeEdit(field, edit)
  )

  assert.equal(result, true, "writeEdit should report that undo survives")
  assert.deepEqual(asked[0], { name: "queryCommandSupported", args: ["insertText"] })
  assert.deepEqual(asked[1], { name: "execCommand", args: ["insertText", false, "**bravo**"] })
  assert.ok(
    !field.calls.some((call) => call.name === "setRangeText"),
    "setRangeText drops the undo entry and must not run when execCommand worked"
  )
})

test("the selection is moved onto the range being replaced before the write, and onto the result after", () => {
  const field = fakeField("Alpha bravo charlie")
  const edit = editFor({ value: field.value, start: 6, end: 11 }, BOLD)
  withDocument({ supported: true, execReturns: true }, () => writeEdit(field, edit))

  const ranges = field.calls.filter((call) => call.name === "setSelectionRange").map((c) => c.args)
  // Before: the characters execCommand is to replace. After: the words to leave highlighted.
  assert.deepEqual(ranges, [
    [6, 11],
    [8, 13],
  ])
  assert.equal(field.calls[0].name, "focus", "the field has to be focused for the command to apply")
})

test("an unsupported command falls back, and the fallback announces itself with an input event", () => {
  const field = fakeField("Alpha bravo charlie")
  const edit = editFor({ value: field.value, start: 6, end: 11 }, BOLD)
  const { result } = withDocument({ supported: false, execReturns: false }, () =>
    writeEdit(field, edit)
  )

  assert.equal(result, false, "the caller should be told undo was lost")
  assert.equal(field.value, "Alpha **bravo** charlie")
  assert.deepEqual(
    field.calls.filter((call) => call.name === "setRangeText").map((c) => c.args),
    [["**bravo**", 6, 11]],
    "the fallback is setRangeText, not an assignment to .value"
  )
  // A controlled React textarea learns about a change only from `input`, and setRangeText fires
  // none — without this the edit lands and the next render snaps it back.
  assert.deepEqual(
    field.calls.filter((call) => call.name === "dispatchEvent").map((c) => c.args),
    [["input", true]]
  )
})

test("a command that is supported but refuses still falls back", () => {
  const field = fakeField("one")
  const edit = editFor({ value: "one", start: 0, end: 3 }, BOLD)
  const { result } = withDocument({ supported: true, execReturns: false }, () =>
    writeEdit(field, edit)
  )
  assert.equal(result, false)
  assert.equal(field.value, "**one**")
})

test("a command that throws falls back rather than leaving the field untouched", () => {
  const field = fakeField("one")
  const edit = editFor({ value: "one", start: 0, end: 3 }, BOLD)
  const previous = globalThis.document
  globalThis.document = {
    queryCommandSupported: () => true,
    execCommand: () => {
      throw new Error("blocked")
    },
  }
  try {
    assert.equal(writeEdit(field, edit), false)
    assert.equal(field.value, "**one**")
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test("with no document at all the write still lands, which is what rendering on a server means", () => {
  // No `withDocument` here: `document` is genuinely absent, as it is during SSR and in this very
  // test process. Reaching for `document.queryCommandSupported` would throw and lose the edit.
  assert.equal(globalThis.document, undefined, "this test is only meaningful without a document")
  const field = fakeField("one")
  const edit = editFor({ value: "one", start: 0, end: 3 }, BOLD)
  assert.equal(writeEdit(field, edit), false)
  assert.equal(field.value, "**one**")
})

test("a field without setRangeText is still written", () => {
  const field = fakeField("one", { withSetRangeText: false })
  const edit = editFor({ value: "one", start: 0, end: 3 }, BOLD)
  withDocument({ supported: false, execReturns: false }, () => writeEdit(field, edit))
  assert.equal(field.value, "**one**")
})

// --- the toolbar ----------------------------------------------------------------------------------

const mount = (props, options) =>
  render(MarkdownToolbar, { textareaRef: { current: null }, ...props }, options)

test("it is a labelled toolbar", () => {
  const view = mount({})
  const [toolbar] = byRole(walk(view.tree), "toolbar")
  assert.ok(toolbar, "there should be a role=toolbar")
  assert.equal(toolbar.props["aria-label"], "Formatting")
  assert.equal(toolbar.props["aria-orientation"], "horizontal")
})

test("the whole row is one tab stop", () => {
  const buttons = byTag(walk(mount({}).tree), "button")
  assert.equal(buttons.length, 7)
  assert.equal(
    buttons.filter((b) => b.props.tabIndex === 0).length,
    1,
    "eight buttons above a comment box must not be eight stops on the way to it"
  )
  assert.equal(buttons[0].props.tabIndex, 0)
  // The others must be -1 and not 1. A positive tabindex does not merely add a stop, it jumps the
  // button ahead of every element on the page that never asked for an order.
  assert.deepEqual(
    buttons.slice(1).map((b) => b.props.tabIndex),
    Array(buttons.length - 1).fill(-1)
  )
})

test("every button has a name, a type, and a hidden icon", () => {
  for (const button of byTag(walk(mount({}).tree), "button")) {
    assert.equal(button.props.type, "button", "a toolbar inside a form must not submit it")
    assert.ok(button.props["aria-label"], "an icon button needs an accessible name")
    assert.equal(button.props.title, button.props["aria-label"])
    const [marker] = walk(button.props.children).filter((n) => n.props?.["aria-hidden"] === "true")
    assert.ok(marker, "the icon is decoration and should be hidden from the accessibility tree")
  }
})

test("the shortcut is advertised on the button that has one", () => {
  const buttons = byTag(walk(mount({}).tree), "button")
  const bold = buttons.find((b) => b.props["aria-label"] === "Bold")
  assert.equal(bold.props["aria-keyshortcuts"], "Meta+B")
  const quote = buttons.find((b) => b.props["aria-label"] === "Quote")
  assert.equal(quote.props["aria-keyshortcuts"], undefined, "no shortcut, no claim of one")
})

test("the arrow keys move the tab stop and wrap around", () => {
  const view = mount({})
  const stop = () => byTag(walk(view.tree), "button").findIndex((b) => b.props.tabIndex === 0)
  const press = (key) => {
    byRole(walk(view.tree), "toolbar")[0].props.onKeyDown({
      key,
      preventDefault() {},
      defaultPrevented: false,
    })
    view.rerender()
  }

  // Stepped all the way along rather than jumped with End: an off-by-one in the wrap test skips
  // the last button entirely, and only arriving at it one press at a time shows that.
  for (let i = 1; i <= 6; i += 1) {
    press("ArrowRight")
    assert.equal(stop(), i, `Right ${i} time(s) should land on button ${i}`)
  }
  press("ArrowRight")
  assert.equal(stop(), 0, "Right from the last button should land on the first")
  press("ArrowLeft")
  assert.equal(stop(), 6, "Left from the first button should land on the last")
  // And back down one at a time, which is the only way to see that moving left to the *first*
  // button lands on it rather than wrapping past it to the last.
  for (let i = 5; i >= 0; i -= 1) {
    press("ArrowLeft")
    assert.equal(stop(), i, `Left should step down to button ${i}`)
  }
  // End then Home, in that order: Home pressed while already on the first button proves nothing.
  press("End")
  assert.equal(stop(), 6)
  press("Home")
  assert.equal(stop(), 0)
})

test("arrow keys leave an event another handler already dealt with alone", () => {
  const view = mount({})
  const stop = () => byTag(walk(view.tree), "button").findIndex((b) => b.props.tabIndex === 0)
  byRole(walk(view.tree), "toolbar")[0].props.onKeyDown({
    key: "ArrowRight",
    preventDefault() {},
    defaultPrevented: true,
  })
  view.rerender()
  assert.equal(stop(), 0, "a consumer that handled the key owns it")
})

test("on an RTL page the arrows follow the text rather than the screen", () => {
  const view = mount({}, { direction: "rtl" })
  const stop = () => byTag(walk(view.tree), "button").findIndex((b) => b.props.tabIndex === 0)
  byRole(walk(view.tree), "toolbar")[0].props.onKeyDown({
    key: "ArrowRight",
    preventDefault() {},
    defaultPrevented: false,
  })
  view.rerender()
  assert.equal(stop(), 6, "Right on an RTL row moves toward the start of the line")
})

test("mousedown on the row is prevented, so a button press is not a visit elsewhere", () => {
  let prevented = false
  const view = mount({})
  byRole(walk(view.tree), "toolbar")[0].props.onMouseDown({
    defaultPrevented: false,
    preventDefault: () => {
      prevented = true
    },
  })
  assert.ok(prevented, "without this the textarea fires blur and focus on every press")
})

test("a caller's own mousedown handler still runs, and can keep the default", () => {
  const seen = []
  const view = mount({ onMouseDown: () => seen.push("caller") })
  byRole(walk(view.tree), "toolbar")[0].props.onMouseDown({
    defaultPrevented: true,
    preventDefault: () => seen.push("prevented"),
  })
  assert.deepEqual(seen, ["caller"], "an already-prevented event should not be prevented twice")
})

test("pressing a button edits the field it was given", () => {
  const field = fakeField("Alpha bravo charlie")
  field.selectionStart = 6
  field.selectionEnd = 11
  const changed = []
  const view = mount({ textareaRef: { current: field }, onValueChange: (v) => changed.push(v) })
  const bold = byTag(walk(view.tree), "button").find((b) => b.props["aria-label"] === "Bold")

  withDocument({ supported: false, execReturns: false }, () => bold.props.onClick())

  assert.equal(field.value, "Alpha **bravo** charlie")
  assert.deepEqual(changed, ["Alpha **bravo** charlie"])
})

test("pressing a button with no field attached does nothing rather than throwing", () => {
  const view = mount({ textareaRef: { current: null } })
  const bold = byTag(walk(view.tree), "button").find((b) => b.props["aria-label"] === "Bold")
  assert.doesNotThrow(() => bold.props.onClick())
})

test("disabled buttons are disabled, the row says so, and a press is inert", () => {
  const field = fakeField("one")
  field.selectionEnd = 3
  const view = mount({ textareaRef: { current: field }, disabled: true })
  const [toolbar] = byRole(walk(view.tree), "toolbar")
  assert.equal(toolbar.props["aria-disabled"], true)
  const buttons = byTag(walk(view.tree), "button")
  assert.ok(buttons.every((b) => b.props.disabled === true))
  withDocument({ supported: false, execReturns: false }, () => buttons[0].props.onClick())
  assert.equal(field.value, "one", "a disabled toolbar must not write")
})

test("the action list is the caller's, names or whole actions", () => {
  const named = byTag(walk(mount({ actions: ["bold", "quote"] }).tree), "button")
  assert.deepEqual(
    named.map((b) => b.props["aria-label"]),
    ["Bold", "Quote"]
  )

  const custom = byTag(
    walk(
      mount({
        actions: [{ name: "spoiler", label: "Spoiler", spec: { kind: "wrap", before: "||", after: "||" } }],
      }).tree
    ),
    "button"
  )
  assert.deepEqual(
    custom.map((b) => b.props["aria-label"]),
    ["Spoiler"]
  )
})

test("a custom action with no icon falls back to a letter rather than an empty button", () => {
  const view = mount({
    actions: [{ name: "spoiler", label: "Spoiler", spec: { kind: "wrap", before: "||", after: "||" } }],
  })
  const [button] = byTag(walk(view.tree), "button")
  const [marker] = walk(button.props.children).filter((n) => n.props?.["aria-hidden"] === "true")
  assert.ok(marker, "the letter stands in for an icon and is decoration like one")
  assert.equal(marker.props.children, "S")
})

test("an empty action list renders nothing at all", () => {
  assert.equal(mount({ actions: [] }).tree, null)
})

test("an unknown action name is dropped instead of crashing the row", () => {
  const buttons = byTag(walk(mount({ actions: ["bold", "nope", "quote"] }).tree), "button")
  assert.deepEqual(
    buttons.map((b) => b.props["aria-label"]),
    ["Bold", "Quote"]
  )
})

test("shrinking the action list does not leave the row unreachable by Tab", () => {
  const view = mount({ actions: ["bold", "italic", "quote"] })
  const toolbar = byRole(walk(view.tree), "toolbar")[0]
  toolbar.props.onKeyDown({ key: "End", preventDefault() {}, defaultPrevented: false })
  view.rerender()
  view.update({ textareaRef: { current: null }, actions: ["bold"] })
  const buttons = byTag(walk(view.tree), "button")
  assert.equal(
    buttons.filter((b) => b.props.tabIndex === 0).length,
    1,
    "the roving stop must stay on a button that exists"
  )
})

test("the shortcuts are bound on the field, in the capture phase, and taken down again", () => {
  const field = fakeField("one")
  const view = mount({ textareaRef: { current: field } })
  const added = field.calls.filter((c) => c.name === "addEventListener")
  assert.equal(added.length, 1)
  assert.equal(added[0].args[0], "keydown")
  assert.equal(added[0].args[2], true, "capture, so the consumer's own handler cannot eat the chord")

  view.unmount()
  const removed = field.calls.filter((c) => c.name === "removeEventListener")
  assert.equal(removed.length, 1)
  // All three arguments, not just the function: removeEventListener only matches a listener whose
  // type, function and capture flag all agree, so a wrong name or phase leaves it attached.
  assert.deepEqual(removed[0].args, added[0].args)
})

test("nothing is bound when shortcuts are turned off", () => {
  const field = fakeField("one")
  mount({ textareaRef: { current: field }, shortcuts: false })
  assert.equal(field.calls.filter((c) => c.name === "addEventListener").length, 0)
})

test("nothing is bound when no action in the row has a shortcut", () => {
  const field = fakeField("one")
  mount({ textareaRef: { current: field }, actions: ["quote", "bulletList"] })
  assert.equal(
    field.calls.filter((c) => c.name === "addEventListener").length,
    0,
    "a listener that can never match anything should not be attached"
  )
})

test("a field that reports no selection is treated as a caret at the start", () => {
  // `selectionStart` is absent rather than 0 here. Defaulting to anything else writes into the
  // middle of somebody's text, and `||` instead of `??` would hide a real 0 behind the default.
  const field = fakeField("one")
  delete field.selectionStart
  delete field.selectionEnd
  const view = mount({ textareaRef: { current: field } })
  const bold = byTag(walk(view.tree), "button").find((b) => b.props["aria-label"] === "Bold")
  withDocument({ supported: false, execReturns: false }, () => bold.props.onClick())
  assert.equal(field.value, "****one")
})

test("Mod+B formats and Mod+Alt+B does not", () => {
  const field = fakeField("Alpha bravo charlie")
  field.selectionStart = 6
  field.selectionEnd = 11
  mount({ textareaRef: { current: field } })
  const handler = field.calls.find((c) => c.name === "addEventListener").args[1]

  const press = (init) => {
    const event = { preventDefault: () => event.prevented = true, prevented: false, ...init }
    withDocument({ supported: false, execReturns: false }, () => handler(event))
    return event
  }

  const plain = press({ key: "b", metaKey: false, ctrlKey: false, altKey: false })
  assert.equal(field.value, "Alpha bravo charlie", "a bare b is a letter someone is typing")
  assert.equal(plain.prevented, false)

  const withAlt = press({ key: "b", metaKey: true, ctrlKey: false, altKey: true })
  assert.equal(field.value, "Alpha bravo charlie", "Mod+Alt+B is somebody else's chord")
  assert.equal(withAlt.prevented, false)

  const bold = press({ key: "b", metaKey: true, ctrlKey: false, altKey: false })
  assert.equal(field.value, "Alpha **bravo** charlie")
  assert.equal(bold.prevented, true, "the browser's own bold would otherwise also run")
})

test("Ctrl+B works too, because a page cannot tell which keyboard is in front of it", () => {
  const field = fakeField("one")
  field.selectionEnd = 3
  mount({ textareaRef: { current: field } })
  const handler = field.calls.find((c) => c.name === "addEventListener").args[1]
  withDocument({ supported: false, execReturns: false }, () =>
    handler({ key: "b", metaKey: false, ctrlKey: true, altKey: false, preventDefault() {} })
  )
  assert.equal(field.value, "**one**")
})

test("an upper-case key still matches, so Shift does not break the chord", () => {
  const field = fakeField("one")
  field.selectionEnd = 3
  mount({ textareaRef: { current: field } })
  const handler = field.calls.find((c) => c.name === "addEventListener").args[1]
  withDocument({ supported: false, execReturns: false }, () =>
    handler({ key: "B", metaKey: true, ctrlKey: false, altKey: false, preventDefault() {} })
  )
  assert.equal(field.value, "**one**")
})

test("a key with no action behind it is left to the field", () => {
  const field = fakeField("one")
  field.selectionEnd = 3
  mount({ textareaRef: { current: field } })
  const handler = field.calls.find((c) => c.name === "addEventListener").args[1]
  let prevented = false
  handler({
    key: "a",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true
    },
  })
  assert.equal(prevented, false, "Mod+A is select-all and belongs to the browser")
  assert.equal(field.value, "one")
})
