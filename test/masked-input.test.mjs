// masked-input, whose whole reason to exist is three bugs that a hand-rolled mask has and that are
// invisible to the person who wrote it.
//
// The caret is the one worth the most care. Typing a fresh code left to right never reveals it —
// every reformat puts the caret at the end, which is where it already was. It only shows up when
// someone goes back to fix the third character, and then every keystroke throws them to the end of
// the field. So the assertions below do not stop at "the text came out right": they check where the
// component asked the caret to go, which is a call it makes on the node and therefore something the
// harness can see even though nothing here has a real caret to move.
//
// The other two are the paste that doubles the separators and the value that gets submitted with
// the presentation baked into it. Both are checked against the formatted *and* the raw side, since
// either alone stays green while the other is wrong.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const {
  MaskedInput,
  MASK_TOKENS,
  compileMask,
  formatWithMask,
  unmask,
  isMaskComplete,
  describeMask,
} = loadComponent(join(ROOT, "registry", "ui", "masked-input.tsx"))

/**
 * Drives one field.
 *
 * `change` is handed the text the browser would already have produced — a change event arrives
 * after the edit, not before it — so a test spells out the mutation a keystroke or a paste makes,
 * and the component gets exactly what a browser would give it. `controlled` makes the parent do the
 * ordinary thing: store what it is told and hand it straight back.
 */
const show = ({ controlled = false, ...initial } = {}) => {
  const events = []
  const current = { mask: "###-####", ...initial }
  let stored = initial.value ?? ""

  const nextProps = () => ({
    ...current,
    ...(controlled ? { value: stored } : {}),
    onValueChange: (value, meta) => {
      events.push({ value, ...meta })
      stored = value
    },
  })

  const instance = render(MaskedInput, nextProps())
  const inputs = () => byTag(walk(instance.tree), "input")
  const field = () => inputs().find((node) => node.props.type === "text")

  return {
    instance,
    events,
    field,
    tree: () => instance.tree,
    value: () => field().props.value,
    hidden: (name) =>
      inputs().find((node) => node.props.type === "hidden" && node.props.name === name),
    change(text, caret = text.length) {
      field().props.onChange({ target: { value: text, selectionStart: caret } })
      instance.update(nextProps())
    },
    press(key, caret, end = caret) {
      const event = {
        key,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true
        },
        currentTarget: {
          value: field().props.value,
          selectionStart: caret,
          selectionEnd: end,
        },
      }
      field().props.onKeyDown(event)
      instance.update(nextProps())
      return event.defaultPrevented
    },
    /** The offset the component last asked the caret to move to, or null if it never asked. */
    caret() {
      const calls = instance.nodes
        .flatMap((node) => node.calls)
        .filter((call) => call.name === "setSelectionRange")
      return calls.length ? calls[calls.length - 1].args[0] : null
    },
    /** A prop change made by the parent — a new mask, a new value, or both at once. */
    set({ storedValue, ...patch }) {
      if (storedValue !== undefined) stored = storedValue
      Object.assign(current, patch)
      instance.update(nextProps())
    },
    rerender() {
      instance.update(nextProps())
    },
  }
}

// --- the mask itself, without React -----------------------------------------

test("a mask is a shape: digits, letters, either, and separators the field writes", () => {
  assert.equal(formatWithMask("1234567", "###-####"), "123-4567")
  assert.equal(formatWithMask("AB1234", "AA-####"), "AB-1234")
  assert.equal(formatWithMask("A1B2", "**-**"), "A1-B2")
})

test("a separator is written only once there is something after it to separate", () => {
  // "123-" would put a character on screen that nobody typed, and backspace would then have to
  // pretend to delete it.
  assert.equal(formatWithMask("123", "###-####"), "123")
  assert.equal(formatWithMask("1234", "###-####"), "123-4")
  assert.equal(formatWithMask("", "###-####"), "")
})

test("formatting is idempotent — the already-formatted value comes back unchanged", () => {
  // This is the paste bug stated as an equation. A mask that strips and re-inserts separators fails
  // it by producing "123--4567".
  assert.equal(formatWithMask("123-4567", "###-####"), "123-4567")
  assert.equal(formatWithMask(formatWithMask("1234567", "###-####"), "###-####"), "123-4567")
})

test("unmask gives back the value to store, from either form", () => {
  assert.equal(unmask("123-4567", "###-####"), "1234567")
  assert.equal(unmask("1234567", "###-####"), "1234567")
  assert.equal(unmask("  12 34-567 ", "###-####"), "1234567")
})

test("a value longer than the mask is cut at the last slot, not kept out of sight", () => {
  assert.equal(unmask("12345678901", "###-####"), "1234567")
  assert.equal(formatWithMask("12345678901", "###-####"), "123-4567")
})

test("a backslash makes the next character a separator, so # A and * stay reachable", () => {
  assert.equal(formatWithMask("12", "\\#-##"), "#-12")
  assert.equal(unmask("#-12", "\\#-##"), "12")
  // A lone trailing backslash is a mask someone is still typing, not a reason to throw.
  assert.deepEqual(compileMask("\\"), [{ kind: "literal", char: "\\" }])
})

test("completeness is every slot filled, and an empty mask is never complete", () => {
  assert.equal(isMaskComplete("123456", "###-####"), false)
  assert.equal(isMaskComplete("1234567", "###-####"), true)
  assert.equal(isMaskComplete("123-4567", "###-####"), true)
  assert.equal(isMaskComplete("", ""), false)
})

test("the mask is said out loud in groups, because underscores are not read out", () => {
  assert.equal(describeMask("###-####"), "3 digits, then 4 digits")
  assert.equal(describeMask("AA-####"), "2 letters, then 4 digits")
  assert.equal(describeMask("****-****"), "4 letters or digits, then 4 letters or digits")
  assert.equal(describeMask("#"), "1 digit")
  // A separator breaks a run even when the token does not change: ##-## is two groups of two.
  assert.equal(describeMask("##-##"), "2 digits, then 2 digits")
  assert.equal(describeMask("####"), "4 digits")
})

test("a custom token is named generically rather than guessed at", () => {
  const tokens = { ...MASK_TOKENS, V: /[A-HJ-NPR-Z0-9]/ }
  assert.equal(describeMask("VVV", { tokens }), "3 characters")
})

test("the token patterns are not global, so testing one twice answers the same way twice", () => {
  // A /g/ pattern keeps a lastIndex between calls and would accept every other keystroke.
  for (const pattern of Object.values(MASK_TOKENS)) {
    assert.equal(pattern.global, false)
    assert.equal(pattern.test("7"), pattern.test("7"))
  }
})

// --- typing -----------------------------------------------------------------

test("the separator appears without being typed", () => {
  const ui = show()
  ui.change("1")
  ui.change("12")
  ui.change("123")
  assert.equal(ui.value(), "123")
  ui.change("1234")
  assert.equal(ui.value(), "123-4")
  ui.change("123-45")
  ui.change("123-456")
  ui.change("123-4567")
  assert.equal(ui.value(), "123-4567")
})

test("a separator typed by hand is absorbed rather than doubled", () => {
  const ui = show()
  ui.change("123")
  ui.change("123-")
  assert.equal(ui.value(), "123")
  ui.change("123-4")
  assert.equal(ui.value(), "123-4")
})

test("an already-formatted string pasted in does not double its separators", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.value(), "123-4567")
  assert.equal(ui.events.at(-1).value, "1234567")
})

test("a fixed segment in the mask is recognised on paste, not eaten as typed content", () => {
  // The other half of the paste rule, and the half a digits-and-dashes mask can never show: there,
  // the dash is rejected by the digit slot anyway, so a version that ignores its own literals
  // entirely still looks correct. Here the literals are digits and the slots take digits, so the
  // fixed year has to be matched as the separator it is — otherwise it is read as four of the
  // characters the person is supposed to be typing, and the last four slots never get filled.
  const ui = show({ mask: "****-2026-****", transform: "uppercase" })
  ui.change("abcd-2026-efgh")
  assert.equal(ui.value(), "ABCD-2026-EFGH")
  assert.equal(ui.events.at(-1).value, "ABCDEFGH")
})

test("a pasted string with the wrong separators is read through the mask anyway", () => {
  const ui = show()
  ui.change("123 4567")
  assert.equal(ui.value(), "123-4567")
  assert.equal(ui.events.at(-1).value, "1234567")
})

test("typing past the last slot drops the extra rather than growing the field", () => {
  const ui = show()
  ui.change("12345678901")
  assert.equal(ui.value(), "123-4567")
  assert.equal(ui.events.at(-1).value, "1234567")
})

// --- the caret --------------------------------------------------------------

test("the caret lands after the character just typed, not at the end of the field", () => {
  const ui = show()
  ui.change("123-4567")
  // "123-4567" with the caret between the 4 and the 5; typing 9 there.
  ui.change("123-49567", 6)
  assert.equal(ui.value(), "123-4956")
  // 6 is just after the 9. 8 would be the end of the field — the bug this component exists for.
  assert.equal(ui.caret(), 6)
})

test("the caret keeps its place across the separator the reformat inserts", () => {
  const ui = show()
  ui.change("123")
  // Typing the fourth digit inserts two characters where one was typed.
  ui.change("1234")
  assert.equal(ui.value(), "123-4")
  assert.equal(ui.caret(), 5)
})

test("the caret stays at the start when the field is emptied", () => {
  const ui = show()
  ui.change("123-4567")
  ui.change("", 0)
  assert.equal(ui.value(), "")
  assert.equal(ui.caret(), 0)
})

// --- deleting ---------------------------------------------------------------

test("backspace over a separator deletes the character before it, not the separator", () => {
  // Left to the browser, this deletes the dash, the reformat puts it straight back, and the key
  // looks broken.
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.press("Backspace", 4), true)
  assert.equal(ui.value(), "124-567")
  assert.equal(ui.caret(), 2)
})

test("backspace at the start of the field is left alone", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.press("Backspace", 0), false)
  assert.equal(ui.value(), "123-4567")
})

test("delete removes the character after the caret, skipping the separator", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.press("Delete", 3), true)
  assert.equal(ui.value(), "123-567")
  assert.equal(ui.caret(), 3)
})

test("delete at the end of the value is left alone", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.press("Delete", 8), false)
  assert.equal(ui.value(), "123-4567")
})

test("a selection is left to the browser, which deletes it correctly", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(ui.press("Backspace", 2, 6), false)
})

test("a caller's own key handler runs first and can take the key", () => {
  const seen = []
  const ui = show({
    onKeyDown: (event) => {
      seen.push(event.key)
      event.preventDefault()
    },
  })
  ui.change("123-4567")
  ui.press("Backspace", 4)
  assert.deepEqual(seen, ["Backspace"])
  assert.equal(ui.value(), "123-4567")
})

// --- what comes out ---------------------------------------------------------

test("the change callback reports the value to store, the presentation, and whether it is full", () => {
  const ui = show()
  ui.change("123456")
  assert.deepEqual(ui.events.at(-1), {
    value: "123456",
    formatted: "123-456",
    complete: false,
  })
  ui.change("123-4567")
  assert.deepEqual(ui.events.at(-1), {
    value: "1234567",
    formatted: "123-4567",
    complete: true,
  })
})

test("the submitted value has no separators in it, and the formatted one is beside it", () => {
  const ui = show({ name: "postal_code", formattedName: "postal_code_display" })
  ui.change("123-4567")
  assert.equal(ui.hidden("postal_code").props.value, "1234567")
  assert.equal(ui.hidden("postal_code_display").props.value, "123-4567")
})

test("no hidden input is rendered without a name to give it", () => {
  const ui = show()
  ui.change("123-4567")
  assert.equal(byTag(walk(ui.tree()), "input").length, 1)
})

// --- controlled mode --------------------------------------------------------

test("a controlled field keeps the keystroke a parent has not re-rendered for yet", () => {
  const ui = show({ controlled: true })
  ui.change("1234")
  assert.equal(ui.value(), "123-4")
  // The parent re-renders for something unrelated, handing back the same value it already had.
  ui.rerender()
  ui.rerender()
  assert.equal(ui.value(), "123-4")
})

test("a controlled parent that hands back a formatted value does not re-format it again", () => {
  const ui = show({ controlled: true })
  ui.change("123-4567")
  ui.set({ storedValue: "123-4567" })
  assert.equal(ui.value(), "123-4567")
  assert.equal(ui.events.at(-1).value, "1234567")
})

test("a parent that changes the value on purpose is followed", () => {
  const ui = show({ controlled: true })
  ui.change("123-4567")
  ui.set({ storedValue: "" })
  assert.equal(ui.value(), "")
  ui.set({ storedValue: "9876543" })
  assert.equal(ui.value(), "987-6543")
})

// --- a mask that changes ----------------------------------------------------

test("a shorter mask takes the value with it, and the parent is told", () => {
  const ui = show()
  ui.change("123-4567")
  ui.set({ mask: "####" })
  assert.equal(ui.value(), "1234")
  assert.deepEqual(ui.events.at(-1), { value: "1234", formatted: "1234", complete: true })
})

test("a mask and a value changing in the same render do not fight over the result", () => {
  // Both effects run in that one pass. The mask effect reading the value from the render before it
  // would re-clip the old value and emit it over the one the parent just sent.
  const ui = show({ controlled: true })
  ui.change("123-4567")
  ui.set({ mask: "####", storedValue: "9999" })
  assert.equal(ui.value(), "9999")
  // The clobber is an emit of "1234" — the old value re-clipped to the new mask — sent after the
  // parent had already said "9999". It has to be absent from the whole log, not just from the end.
  assert.equal(ui.events.some((event) => event.value === "1234"), false)
})

test("a mask that has not changed does not emit anything on a re-render", () => {
  const ui = show()
  ui.change("123-4567")
  const count = ui.events.length
  ui.rerender()
  ui.rerender()
  assert.equal(ui.events.length, count)
})

// --- folding and custom tokens ----------------------------------------------

test("uppercase folding applies to what is typed and to what is pasted", () => {
  const ui = show({ mask: "****-****", transform: "uppercase" })
  ui.change("ab12")
  assert.equal(ui.value(), "AB12")
  ui.change("ab12-cd34")
  assert.equal(ui.value(), "AB12-CD34")
  assert.equal(ui.events.at(-1).value, "AB12CD34")
})

test("a custom token refuses the characters it excludes", () => {
  // A VIN leaves out I, O and Q so they cannot be misread as 1 and 0. No general table knows that.
  const ui = show({
    mask: "VVV",
    tokens: { ...MASK_TOKENS, V: /[A-HJ-NPR-Z0-9]/ },
    transform: "uppercase",
  })
  ui.change("aiq1")
  assert.equal(ui.value(), "A1")
})

test("a character that does not fit its slot is dropped, not slid into one that would take it", () => {
  // Sliding would silently reorder what someone typed: "12ab" would become "ab-12".
  const ui = show({ mask: "AA-##" })
  ui.change("12ab")
  assert.equal(ui.value(), "ab")
})

// --- what a browser and a screen reader are told ----------------------------

test("an all-digit mask asks for the number pad and a mixed one does not", () => {
  const digits = show({ mask: "###-####" })
  assert.equal(digits.field().props.inputMode, "numeric")
  const mixed = show({ mask: "AA-####" })
  assert.equal(mixed.field().props.inputMode, "text")
})

test("the field is a text input, so a leading zero survives and the separators can exist", () => {
  const ui = show()
  ui.change("0123456")
  assert.equal(ui.field().props.type, "text")
  assert.equal(ui.value(), "012-3456")
})

test("the placeholder shows the shape, and its character can be changed", () => {
  assert.equal(show().field().props.placeholder, "___-____")
  assert.equal(show({ placeholderChar: "•" }).field().props.placeholder, "•••-••••")
  assert.equal(show({ placeholder: "Postal code" }).field().props.placeholder, "Postal code")
})

test("the shape is described in words, because a placeholder of underscores is not read out", () => {
  const ui = show()
  const described = ui.field().props["aria-describedby"]
  assert.ok(described)
  const hint = walk(ui.tree()).find((node) => node.props?.id === described)
  assert.equal(hint.props.className, "sr-only")
  assert.equal([].concat(hint.props.children).join(""), "Format: 3 digits, then 4 digits")
})

test("a caller's own description is kept alongside the generated one", () => {
  const ui = show({ "aria-describedby": "postal-help" })
  assert.match(ui.field().props["aria-describedby"], /postal-help$/)
})

test("a caller can replace the description or remove it", () => {
  const custom = show({ hint: "郵便番号（ハイフンあり）" })
  const id = custom.field().props["aria-describedby"]
  const node = walk(custom.tree()).find((n) => n.props?.id === id)
  assert.equal([].concat(node.props.children).join(""), "Format: 郵便番号（ハイフンあり）")

  const none = show({ hint: null })
  assert.equal(none.field().props["aria-describedby"], undefined)
  assert.equal(walk(none.tree()).some((n) => n.props?.className === "sr-only"), false)
})

test("the caller's classes are merged onto the field rather than replacing it", () => {
  const ui = show({ className: "w-40" })
  assert.match(ui.field().props.className, /border-input/)
  assert.match(ui.field().props.className, /w-40$/)
})

test("a disabled field carries the disabled styling and the attribute", () => {
  const ui = show({ disabled: true })
  assert.equal(ui.field().props.disabled, true)
  assert.match(ui.field().props.className, /disabled:opacity-50/)
})
