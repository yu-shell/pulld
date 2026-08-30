// A regression test for one defect, found on 2026-08-22 while building time-input against the same
// pattern: a controlled date-input could not be typed into at all.
//
// `commit` updated the segment state only when the field was uncontrolled, on the reasoning that a
// controlled parent owns the value and it will flow back through the prop. It does not. The prop is
// an ISO string, and there is no ISO string for "the month is 03 and the rest is still empty", so a
// parent doing the ordinary `value={v} onChange={setV}` stores "" for every keystroke until the
// last one — and each of those keystrokes was thrown away. The field showed mm/dd/yyyy no matter
// what was typed, which is invisible to anyone testing it uncontrolled.
//
// The fix is that the segments are always local state; the effect that re-seeds from the prop is
// what keeps the parent authoritative, and it only fires once the segments read as a complete date
// that disagrees with the prop.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { DateInput } = loadComponent(join(ROOT, "registry", "ui", "date-input.tsx"))

const show = (props) => {
  const emitted = []
  const instance = render(DateInput, { ...props, onChange: (v) => emitted.push(v) })
  const segs = () => byRole(walk(instance.tree), "spinbutton")
  return {
    emitted,
    text: () => segs().map((s) => s.props.value),
    type(index, digits) {
      for (const d of digits) {
        segs()[index].props.onKeyDown({ key: d, preventDefault() {} })
        instance.rerender()
      }
    },
    update: (next) => instance.update({ ...next, onChange: (v) => emitted.push(v) }),
    hidden: () => byTag(walk(instance.tree), "input").filter((n) => n.props.type === "hidden"),
  }
}

test("a controlled date-input can be typed into one segment at a time", () => {
  // The parent behaves the way every controlled parent does: it stores what onChange reports, which
  // is "" until all three segments are filled.
  const field = show({ value: "", locale: "en-US" })
  field.type(0, "03")
  assert.deepEqual(field.text(), ["03", "dd", "yyyy"], "the month survives being reported as \"\"")
  field.type(1, "14")
  assert.deepEqual(field.text(), ["03", "14", "yyyy"])
  field.type(2, "2026")
  assert.equal(field.emitted.at(-1), "2026-03-14", "and the finished date is reported once")
})

test("the prop still wins once it disagrees with a complete date", () => {
  const field = show({ value: "2026-03-14", locale: "en-US" })
  assert.deepEqual(field.text(), ["03", "14", "2026"])
  field.update({ value: "1999-12-31", locale: "en-US" })
  assert.deepEqual(field.text(), ["12", "31", "1999"], "a parent-driven change is followed")

  // A parent that refuses the change snaps the field back, which is what controlled means.
  const refusing = show({ value: "2026-03-14", locale: "en-US" })
  refusing.type(0, "05")
  refusing.update({ value: "2026-03-14", locale: "en-US" })
  assert.deepEqual(refusing.text(), ["03", "14", "2026"])
})

// A disabled field still posted its value, found on 2026-08-30 during the weekly sweep.
//
// `disabled` reached every visible segment but not the hidden input that mirrors the ISO value for
// a native form submit, so a date the reader was never allowed to touch was submitted anyway. A
// native `<input type="date" disabled>` is barred from submission; this one was not, which is the
// kind of gap a server only notices as a field it did not expect to receive.
//
// Three components in this registry already pass `disabled` through to their hidden mirror
// (color-picker, duration-input, rating); this brings date-input in line with them.
test("a disabled date-input does not submit its value", () => {
  const off = show({ name: "dob", defaultValue: "2026-03-14", locale: "en-US", disabled: true })
  assert.equal(off.hidden().length, 1, "the mirror is still rendered")
  assert.equal(off.hidden()[0].props.disabled, true, "and it is disabled, so a form skips it")

  const on = show({ name: "dob", defaultValue: "2026-03-14", locale: "en-US" })
  assert.equal(on.hidden()[0].props.disabled, undefined, "an enabled field still submits")
  assert.equal(on.hidden()[0].props.value, "2026-03-14")

  const unnamed = show({ defaultValue: "2026-03-14", locale: "en-US" })
  assert.equal(unnamed.hidden().length, 0, "no name, no mirror")
})
