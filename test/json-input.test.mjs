// json-input, whose two hard parts are both invisible to the person who wrote it.
//
// The first is that the component must never rewrite the text. Parse the text, hand the object to
// the parent, stringify it back in — the obvious shape — and the field cannot be typed in at all,
// but only in ways that a demo never reaches: you have to get as far as a second key before the
// round trip eats it. So the assertions below do not stop at "it reported invalid"; they pin that
// the text in the field is character-for-character what was typed, before and after the verdict
// lands.
//
// The second is the error location, and it has something almost no component test gets: a perfect
// free oracle. `JSON.parse` already knows whether any string is valid JSON, so the scanner in this
// component can be checked against it on as many inputs as we care to generate — including every
// single-character mutation of a real document. A re-implementation of the grammar would only test
// the copy; agreement with the runtime is the property that actually matters, because the runtime
// is what the caller's data will meet.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { JsonInput, scanJson, parseJsonInput, formatJson } = loadComponent(
  join(ROOT, "registry", "ui", "json-input.tsx")
)

const parses = (text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

// --- the scanner, against JSON.parse ---------------------------------------

const CORPUS = [
  // things that should parse
  "{}",
  "[]",
  "null",
  "true",
  "false",
  "0",
  "-0",
  "1e5",
  "1E+5",
  "1.5e-3",
  "123456789012345678901234567890",
  "1e400",
  '""',
  '"\\u0041"',
  '"\\ud800"',
  '"\\uD83D\\uDE00"',
  '"é"',
  '"\\\\"',
  '"\\/"',
  '"\\b\\f\\n\\r\\t"',
  '"\u007f"',
  "[[[[[]]]]]",
  '{"":1}',
  '{"a":{}}',
  '{"a":1,"b":[1,2,{"c":null}]}',
  ' \t\r\n {} \n ',
  // things that should not
  "",
  "   ",
  "{",
  "}",
  "[",
  "]",
  "{,}",
  "[1,2,]",
  '{"a":1,}',
  "{a:1}",
  '{"a" 1}',
  '{"a":}',
  "[1,,2]",
  "+1",
  "01",
  "-01",
  "1.",
  ".5",
  "1e",
  "1e+",
  "-",
  "tru",
  "truex",
  "NaN",
  "Infinity",
  "undefined",
  "'a'",
  '"a',
  '"\\x"',
  '"\\u12"',
  '"\\uZZZZ"',
  '{"a":1}{"b":2}',
  "﻿{}",
  '"\n"',
  '"\t"',
  "[1 2]",
  '{"a":1 "b":2}',
  "{}}",
  "[}",
  "[1,2",
  '{"a":',
  '{"a":1',
  " {}",
]

test("the corpus is not vacuous — it holds both valid and invalid documents", () => {
  const valid = CORPUS.filter(parses)
  assert.ok(valid.length >= 20, `only ${valid.length} valid cases`)
  assert.ok(CORPUS.length - valid.length >= 20, "not enough invalid cases")
})

test("scanJson agrees with JSON.parse on every document in the corpus", () => {
  for (const text of CORPUS) {
    assert.equal(
      scanJson(text).ok,
      parses(text),
      `disagreed on ${JSON.stringify(text)}: scanner said ${scanJson(text).ok}`
    )
  }
})

test("scanJson agrees with JSON.parse on every single-character mutation of a document", () => {
  // Every deletion, and every substitution and insertion drawn from the characters that actually
  // appear in hand-edited JSON. This is where a grammar written from memory falls over: the
  // leading zero, the lone minus, the escape at the very end of a string, the brace that closes a
  // container that was never opened.
  const seed = '{"a": 1, "b": [true, null, "x\\n"], "c": {"d": -2.5e+3}}'
  const alphabet = [...'{}[]",:0123456789.-+eE \n\ttrue\\/'].filter(
    (c, i, all) => all.indexOf(c) === i
  )
  let checked = 0
  let disagreements = []

  const check = (text) => {
    checked++
    if (scanJson(text).ok !== parses(text)) disagreements.push(text)
  }

  for (let i = 0; i < seed.length; i++) {
    check(seed.slice(0, i) + seed.slice(i + 1))
    for (const c of alphabet) {
      check(seed.slice(0, i) + c + seed.slice(i + 1))
      check(seed.slice(0, i) + c + seed.slice(i))
    }
  }

  assert.deepEqual(disagreements.map((t) => JSON.stringify(t)), [])
  assert.ok(checked > 2000, `only ${checked} mutations checked`)
})

test("a valid document the scanner walks leaves nothing unconsumed", () => {
  // Guards the one way the agreement test above could pass while the scanner is broken: a scanner
  // that returns ok without reaching the end would agree on every valid case and only differ on
  // trailing garbage, which `{"a":1}{"b":2}` alone would not prove if the walk stopped early.
  assert.equal(scanJson('{"a":1}{"b":2}').ok, false)
  assert.equal(scanJson("[1,2] 3").ok, false)
  assert.equal(scanJson("null null").ok, false)
})

// --- where the error is ----------------------------------------------------

test("the trailing comma is located — the case no engine message carries a position for", () => {
  // V8 answers `[1,2,]` with `Unexpected token ']', "[1,2,]" is not valid JSON` — no position at
  // all — and JavaScriptCore never includes one. This is the whole reason the scanner exists.
  const array = parseJsonInput("[1,2,]")
  assert.equal(array.valid, false)
  assert.equal(array.error.offset, 5)
  assert.equal(array.error.line, 1)
  assert.equal(array.error.column, 6)

  const object = parseJsonInput('{"a":1,}')
  assert.equal(object.error.offset, 7)
})

test("the error offset points at the offending character", () => {
  for (const [text, offset] of [
    ["{a:1}", 1],
    ['{"a" 1}', 5],
    ["[1,,2]", 3],
    ["[1 2]", 3],
    ['{"a":1 "b":2}', 7],
    ['{"a":1}{"b":2}', 7],
    ["01", 1],
    [".5", 0],
    ['"a', 2],
  ]) {
    const result = parseJsonInput(text)
    assert.equal(result.valid, false, `${JSON.stringify(text)} unexpectedly parsed`)
    assert.equal(result.error.offset, offset, `wrong offset for ${JSON.stringify(text)}`)
  }
})

test("line and column count through newlines, not just characters", () => {
  const result = parseJsonInput('{\n  "a": 1,\n}')
  assert.equal(result.error.offset, 12)
  assert.equal(result.error.line, 3)
  assert.equal(result.error.column, 1)

  const second = parseJsonInput('{\n  "a" 1\n}')
  assert.equal(second.error.line, 2)
  assert.equal(second.error.column, 7)
})

test("a raw control character inside a string is named as such", () => {
  const result = parseJsonInput('{"a": "one\ntwo"}')
  assert.equal(result.valid, false)
  assert.match(result.error.message, /escaped inside a string/)
  assert.equal(result.error.offset, 10)
})

test("an unknown escape points at the backslash, not past it", () => {
  const result = parseJsonInput('"a\\qb"')
  assert.equal(result.valid, false)
  assert.equal(result.error.offset, 2)
  assert.match(result.error.message, /Unknown escape/)
})

test("JSON.parse stays the authority on validity", () => {
  // The scanner can only ever cost a worse message. It must never be able to reject a document the
  // runtime accepts, which is what makes it safe to ship a hand-written grammar at all.
  for (const text of CORPUS) {
    assert.equal(parseJsonInput(text).valid, parses(text), JSON.stringify(text))
  }
  assert.deepEqual(parseJsonInput('{"a":[1,2]}').value, { a: [1, 2] })
  assert.equal(parseJsonInput('{"a":1}').error, null)
})

test("formatJson pretty-prints valid text and returns invalid text untouched", () => {
  assert.equal(formatJson('{"a":[1]}'), '{\n  "a": [\n    1\n  ]\n}')
  assert.equal(formatJson('{"a":[1]}', 4), '{\n    "a": [\n        1\n    ]\n}')
  assert.equal(formatJson('{"a":1,'), '{"a":1,')
  assert.equal(formatJson(""), "")
})

// --- the component ---------------------------------------------------------

/**
 * Drives one field.
 *
 * `controlled` makes the parent do the correct thing — store the *text* it is handed and give that
 * text straight back. The wrong thing (storing a parsed object and stringifying it back into
 * `value`) is not expressible against this API, which is the point of the API.
 */
const show = ({ controlled = false, ...initial } = {}) => {
  const texts = []
  const parsed = []
  let stored = initial.value ?? initial.defaultValue ?? ""

  const nextProps = () => ({
    ...initial,
    ...(controlled ? { value: stored } : {}),
    onValueChange: (text) => {
      texts.push(text)
      stored = text
    },
    onParse: (result) => parsed.push(result),
  })

  const instance = render(JsonInput, nextProps())
  const field = () => byTag(walk(instance.tree), "textarea")[0]
  const buttons = () => byTag(walk(instance.tree), "button")
  const button = (label) =>
    buttons().find((node) => JSON.stringify(node.props.children).includes(label))

  return {
    instance,
    texts,
    parsed,
    field,
    button,
    /** The textarea's stand-in node, carrying the log of imperative calls made on it. */
    node: () => instance.nodes[0],
    value: () => field().props.value,
    status: () =>
      walk(instance.tree).find((n) => n.props?.["aria-live"] === "polite")?.props.children,
    type(text) {
      field().props.onChange({ target: { value: text } })
      instance.update(nextProps())
    },
    key(name, { shiftKey = false, selectionStart = 0, selectionEnd = selectionStart } = {}) {
      const event = {
        key: name,
        shiftKey,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true
        },
        currentTarget: { selectionStart, selectionEnd },
      }
      field().props.onKeyDown(event)
      instance.update(nextProps())
      return event
    },
    blur() {
      field().props.onBlur({})
      instance.update(nextProps())
    },
    /** Lets the debounce elapse and settles the tree on the verdict it produced. */
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 30))
      instance.update(nextProps())
    },
  }
}

/** Renders the status line to a flat string, whatever shape its children took. */
const statusText = (children) => {
  const out = []
  const walkChildren = (node) => {
    if (node === null || node === undefined || typeof node === "boolean") return
    if (Array.isArray(node)) return node.forEach(walkChildren)
    if (typeof node === "object") return walkChildren(node.props?.children)
    out.push(String(node))
  }
  walkChildren(children)
  return out.join("")
}

test("half-typed JSON is left exactly as typed — the component never rewrites the text", async () => {
  const field = show({ controlled: true, debounceMs: 5 })

  // The sequence that breaks the obvious implementation: by the second key there is no parseable
  // object to stringify back, so a component that round-trips through JSON.parse eats the comma
  // and the key that follows it can never be typed.
  for (const step of ['{', '{"', '{"a', '{"a"', '{"a":', '{"a": 1', '{"a": 1,', '{"a": 1, "b"']) {
    field.type(step)
    assert.equal(field.value(), step, `text was rewritten at ${JSON.stringify(step)}`)
  }

  await field.settle()
  assert.equal(field.value(), '{"a": 1, "b"', "the verdict landing rewrote the text")
  assert.equal(field.parsed.at(-1).valid, false)
})

test("the verdict waits for a pause and says nothing in the meantime", async () => {
  const field = show({ defaultValue: '{"a": 1}', debounceMs: 5 })
  assert.equal(statusText(field.status()), "Valid JSON", "a prefilled field should open settled")

  field.type('{"a": 1,')
  // Mid-edit the old verdict is stale and the new one is not in yet. Neither may be shown: "Valid
  // JSON" would be a lie and an error would be red on every keystroke of ordinary typing.
  assert.equal(statusText(field.status()), "")
  assert.equal(field.field().props["aria-invalid"], undefined)

  await field.settle()
  assert.match(statusText(field.status()), /Line 1, column 9/)
  assert.equal(field.field().props["aria-invalid"], true)
})

test("the parse is scheduled with debounceMs rather than run on the keystroke", () => {
  // The test above proves the verdict is not computed synchronously, but it cannot tell a 200ms
  // debounce from a 0ms one: no timer fires until the test awaits either way. And the *reset* —
  // the part that makes it a debounce rather than a delay — is invisible here for a structural
  // reason, namely that the harness deliberately never runs effect cleanups between passes, so
  // the clearTimeout that cancels the superseded parse is never reached. What can be pinned is
  // the delay the component asks for, by watching the scheduling itself.
  const scheduled = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, delay, ...rest) => {
    scheduled.push(delay)
    return realSetTimeout(fn, delay, ...rest)
  }
  let field
  try {
    field = show({ debounceMs: 250 })
    assert.deepEqual(scheduled, [], "a settled field scheduled a parse it did not need")
    field.type('{"a":1}')
    assert.deepEqual([...new Set(scheduled)], [250])
  } finally {
    globalThis.setTimeout = realSetTimeout
    // Clears the 250ms timers, which would otherwise fire into whichever test is running by then.
    field?.instance.unmount()
  }
})

test("an empty field has no verdict", async () => {
  const field = show({ debounceMs: 5 })
  assert.equal(statusText(field.status()), "")
  assert.equal(field.field().props["aria-invalid"], undefined)

  field.type("   ")
  await field.settle()
  assert.equal(statusText(field.status()), "", "whitespace is still untouched, not an error")
})

test("onValueChange fires on the keystroke and onParse only after the pause", async () => {
  const field = show({ debounceMs: 5 })

  field.type('{"a":1}')
  assert.deepEqual(field.texts, ['{"a":1}'], "the text was not reported immediately")

  // Asserted on the verdict's content rather than on a call count: the harness runs every effect
  // on every pass regardless of its dependency list, so onParse is re-invoked with the *same*
  // result each time the tree settles. What matters is that the result still describes the old
  // text — the parent has not been told anything about `{"a":1}` yet.
  assert.equal(field.parsed.at(-1).valid, false, "a verdict on the new text arrived early")

  await field.settle()
  assert.equal(field.parsed.at(-1).valid, true)
  assert.deepEqual(field.parsed.at(-1).value, { a: 1 })
})

test("Tab inserts indentation and puts the caret after it", () => {
  const field = show({ defaultValue: '{"a":1}', indent: 2 })
  const event = field.key("Tab", { selectionStart: 1 })

  assert.equal(event.defaultPrevented, true, "Tab moved focus instead of indenting")
  assert.equal(field.value(), '{  "a":1}')
  // The caret call is the half that reading the code cannot check: without it the browser puts the
  // caret at the end of the replaced value, two characters from where the person was typing.
  assert.deepEqual(field.node().calls.at(-1), { name: "setSelectionRange", args: [3, 3] })
})

test("Tab with a selection indents every line it touches", () => {
  const field = show({ defaultValue: '{\n"a":1,\n"b":2\n}', indent: 2 })
  // A selection covering the two middle lines: from the start of `"a"` to the end of `"b":2`.
  field.key("Tab", { selectionStart: 2, selectionEnd: 15 })

  assert.equal(field.value(), '{\n  "a":1,\n  "b":2\n}')
  // Both ends move: the start by one indent, the end by one per line indented.
  assert.deepEqual(field.node().calls.at(-1), { name: "setSelectionRange", args: [4, 19] })
})

test("Shift+Tab outdents, and does nothing when there is no indentation to remove", () => {
  const field = show({ defaultValue: '{\n    "a":1\n}', indent: 2 })
  field.key("Tab", { shiftKey: true, selectionStart: 6 })
  assert.equal(field.value(), '{\n  "a":1\n}')

  const flush = show({ defaultValue: '{\n"a":1\n}', indent: 2 })
  const callsBefore = flush.node().calls.length
  flush.key("Tab", { shiftKey: true, selectionStart: 2 })
  assert.equal(flush.value(), '{\n"a":1\n}', "outdent invented whitespace to remove")
  assert.equal(flush.node().calls.length, callsBefore, "moved the caret for a no-op outdent")
})

test("Escape releases the Tab trap for exactly one keypress", () => {
  const field = show({ defaultValue: "{}" })

  const escape = field.key("Escape", { selectionStart: 1 })
  assert.equal(escape.defaultPrevented, false, "Escape was swallowed from the dialog around it")

  // WCAG 2.1.2: a Tab that is always captured is a keyboard trap. After Escape the key must reach
  // the browser, so focus moves on and the field can be left without a mouse.
  const released = field.key("Tab", { selectionStart: 1 })
  assert.equal(released.defaultPrevented, false, "Escape did not release Tab")
  assert.equal(field.value(), "{}", "the released Tab still inserted indentation")

  // And the trap is back for the next one, so Tab keeps indenting during ordinary editing.
  const trapped = field.key("Tab", { selectionStart: 1 })
  assert.equal(trapped.defaultPrevented, true)
  assert.equal(field.value(), "{  }")
})

test("typing after Escape re-arms the trap", () => {
  const field = show({ defaultValue: "{}" })
  field.key("Escape", { selectionStart: 1 })
  field.key("a", { selectionStart: 1 })

  const event = field.key("Tab", { selectionStart: 1 })
  assert.equal(event.defaultPrevented, true, "the release outlived the keypress it was for")
})

test("tabIndent off leaves Tab to the browser entirely", () => {
  const field = show({ defaultValue: "{}", tabIndent: false })
  const event = field.key("Tab", { selectionStart: 1 })
  assert.equal(event.defaultPrevented, false)
  assert.equal(field.value(), "{}")
})

test("a read-only field does not capture Tab", () => {
  const field = show({ defaultValue: "{}", readOnly: true })
  const event = field.key("Tab", { selectionStart: 1 })
  assert.equal(event.defaultPrevented, false)
  assert.equal(field.value(), "{}")
})

test("Format pretty-prints only when asked, and only when the text parses", async () => {
  const field = show({ defaultValue: '{"a":[1]}', debounceMs: 5 })
  field.button("Format").props.onClick()
  field.instance.rerender()
  assert.equal(field.value(), '{\n  "a": [\n    1\n  ]\n}')

  // Nothing to format while the text is broken: the button is not offered at all, which is better
  // than a button that silently does nothing.
  field.type('{"a":[1,}')
  await field.settle()
  assert.equal(field.button("Format"), undefined)
})

test("formatOnBlur reformats on the way out, and is off by default", () => {
  const quiet = show({ defaultValue: '{"a":[1]}' })
  quiet.blur()
  assert.equal(quiet.value(), '{"a":[1]}')

  const tidy = show({ defaultValue: '{"a":[1]}', formatOnBlur: true })
  tidy.blur()
  assert.equal(tidy.value(), '{\n  "a": [\n    1\n  ]\n}')
})

test("Go to error focuses the field and sends the caret to the offending character", async () => {
  const field = show({ defaultValue: '{\n  "a": 1,\n}', debounceMs: 5 })
  await field.settle()

  field.button("Go to error").props.onClick()
  const calls = field.node().calls
  assert.deepEqual(
    calls.slice(-2),
    [
      { name: "focus", args: [] },
      { name: "setSelectionRange", args: [12, 12] },
    ],
    "the caret was not sent to the error, or the field was not focused first"
  )
})

test("Go to error is not offered when there is no location to jump to", async () => {
  const field = show({ defaultValue: '{"a":1}', debounceMs: 5 })
  await field.settle()
  assert.equal(field.button("Go to error"), undefined)
  assert.ok(field.button("Format"), "Format should be offered for valid text")
})

test("the field is described by its status and by the keyboard hint", () => {
  const field = show({ defaultValue: "{}", "aria-describedby": "outside-hint" })
  const describedBy = field.field().props["aria-describedby"].split(" ")

  assert.ok(describedBy.includes("outside-hint"), "the caller's description was dropped")
  assert.equal(describedBy.length, 3, "status and hint should both be referenced")

  const hint = walk(field.instance.tree).find((n) => n.props?.className === "sr-only")
  assert.match(statusText(hint.props.children), /Escape, then Tab/)
  assert.ok(describedBy.includes(hint.props.id))
})

test("the keyboard hint is dropped when there is no trap to announce", () => {
  const plain = show({ defaultValue: "{}", tabIndent: false })
  assert.equal(
    walk(plain.instance.tree).find((n) => n.props?.className === "sr-only"),
    undefined,
    "announced a Tab trap that does not exist"
  )

  const custom = show({ defaultValue: "{}", hint: null })
  assert.equal(walk(custom.instance.tree).find((n) => n.props?.className === "sr-only"), undefined)
})

test("mobile keyboard rewriting is off by default and still overridable", () => {
  const field = show({ defaultValue: "{}" })
  const props = field.field().props
  assert.equal(props.spellCheck, false)
  assert.equal(props.autoCapitalize, "off")
  assert.equal(props.autoCorrect, "off")
  assert.equal(props.autoComplete, "off")

  const loud = show({ defaultValue: "{}", spellCheck: true })
  assert.equal(loud.field().props.spellCheck, true)
})

test("an uncontrolled field keeps its own text", () => {
  const field = show({ defaultValue: '{"a":1}' })
  field.type('{"b":2}')
  assert.equal(field.value(), '{"b":2}')
})
