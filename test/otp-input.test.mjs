// A regression test for one defect, found on 2026-08-25 while sweeping the five components the
// 2026-08-22 date-input fix left unchecked: a controlled otp-input could not hold a gap.
//
// `commit` stored the slots only when the field was uncontrolled, on the same reasoning date-input
// used — the parent owns the value and it flows back through the prop. It does not survive the
// round trip. The prop is a joined string, and there is no string for "box 1 is empty and boxes 2
// through 6 hold 23456": it joins to "23456", which `toSlots` packs back to the left. So clearing
// the first box of a full code slid every remaining digit one place left and emptied the last box,
// while an uncontrolled field kept the hole exactly where it was put. The two modes disagreed, and
// only the controlled one was wrong.
//
// The fix is that the slots are always local state; the effect that re-seeds from the prop keeps
// the parent authoritative, and it skips the echo of our own emit by comparing joined forms.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { OtpInput } = loadComponent(join(ROOT, "registry", "ui", "otp-input.tsx"))

/**
 * Drives one field. `controlled` makes the parent do the ordinary thing — store what onChange
 * reports and hand it straight back — which is the only way this defect is visible.
 */
const show = ({ controlled = false, ...props } = {}) => {
  const emitted = []
  let stored = props.value ?? ""
  const nextProps = () => ({
    length: 6,
    ...props,
    ...(controlled ? { value: stored } : {}),
    onChange: (v) => {
      emitted.push(v)
      stored = v
    },
  })
  const instance = render(OtpInput, nextProps())
  // The visible slots only; a `name` adds a hidden input mirroring the joined value.
  const boxes = () => byTag(walk(instance.tree), "input").filter((n) => n.props.type === "text")
  const settle = () => (controlled ? instance.update(nextProps()) : instance.rerender())
  return {
    emitted,
    /** The code as drawn, with an empty box written as "_". */
    text: () => boxes().map((b) => (b.props.value === "" ? "_" : b.props.value)).join(""),
    type(index, digits) {
      for (const d of digits) {
        const box = boxes()[index]
        box.props.onChange({ target: { value: (box.props.value ?? "") + d } })
        settle()
        index = Math.min(index + 1, 5)
      }
    },
    backspaceAt(index) {
      boxes()[index].props.onKeyDown({ key: "Backspace", preventDefault() {} })
      settle()
    },
    hidden: () =>
      byTag(walk(instance.tree), "input").find((n) => n.props.type === "hidden")?.props.value,
    update: (next) => {
      stored = next.value
      instance.update({ length: 6, ...props, ...next, onChange: (v) => emitted.push(v) })
    },
  }
}

test("a controlled otp-input keeps a digit in the box it was typed into", () => {
  const field = show({ controlled: true })
  field.type(2, "5")
  assert.equal(field.text(), "__5___", "the digit stays in box 3 rather than sliding to box 1")
  assert.equal(field.emitted.at(-1), "5", "and the parent is still told the code so far")
})

test("clearing the first box of a controlled code does not shift the rest left", () => {
  const field = show({ controlled: true })
  field.type(0, "123456")
  assert.equal(field.text(), "123456")
  field.backspaceAt(0)
  assert.equal(field.text(), "_23456", "the hole stays in box 1")
})

test("an uncontrolled field behaves identically — the two modes must not disagree", () => {
  const field = show()
  field.type(0, "123456")
  field.backspaceAt(0)
  assert.equal(field.text(), "_23456")
})

test("the prop still wins when it says something the slots do not", () => {
  const field = show({ controlled: true })
  field.type(0, "123456")
  field.update({ value: "999" })
  assert.equal(field.text(), "999___", "a parent-driven change is followed")
})

test("a parent that refuses the change snaps the field back", () => {
  // Controlled means the parent decides. One that keeps handing back "" must win.
  const emitted = []
  const instance = render(OtpInput, { length: 6, value: "", onChange: (v) => emitted.push(v) })
  const boxes = () => byTag(walk(instance.tree), "input").filter((n) => n.props.type === "text")
  boxes()[0].props.onChange({ target: { value: "7" } })
  instance.update({ length: 6, value: "", onChange: (v) => emitted.push(v) })
  assert.equal(boxes().map((b) => b.props.value || "_").join(""), "______")
  assert.equal(emitted.at(-1), "7", "the attempt was still reported")
})

test("onComplete fires once the last empty box is filled, not on every later edit", () => {
  const completed = []
  const emitted = []
  let stored = ""
  const props = () => ({
    length: 6,
    value: stored,
    onChange: (v) => {
      emitted.push(v)
      stored = v
    },
    onComplete: (v) => completed.push(v),
  })
  const instance = render(OtpInput, props())
  const boxes = () => byTag(walk(instance.tree), "input").filter((n) => n.props.type === "text")
  for (let i = 0; i < 6; i++) {
    boxes()[i].props.onChange({ target: { value: String(i + 1) } })
    instance.update(props())
  }
  assert.deepEqual(completed, ["123456"], "exactly once, on the transition into full")
})

test("the hidden mirror carries the joined code for a native form submit", () => {
  const field = show({ controlled: true, name: "code" })
  field.type(0, "1234")
  assert.equal(field.hidden(), "1234")
})
