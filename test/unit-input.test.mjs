// A number box with a unit dropdown beside it looks finished in twenty lines: read the number, read
// the select, hand back `${n}${unit}`. The cases below are written to fail against that and the
// implementations it grows into:
//
//   - a conversion table carried in somebody's head, where `1pc` is 12px or `1Q` is forgotten,
//   - `px -> rem` done by dividing by a hardcoded 16, which is wrong for every page that set a
//     root font-size and silently moves the value on a page that did not,
//   - a round trip recomputed rather than remembered, so px -> rem -> px hands back 16.96 for 17,
//   - a bare number treated as pixels, which CSS does not accept for anything but zero,
//   - one `step` for every unit, so a rem steps by a whole rem or a px takes four presses,
//   - and `value + step` without rounding, which is how a spacing field ends up at
//     0.30000000000000004.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  ABSOLUTE_PX,
  RELATIVE_UNITS,
  ALL_UNITS,
  isAbsoluteUnit,
  pxPerUnit,
  resolvePx,
  convertLength,
  parseUnitValue,
  formatNumber,
  toCssLength,
  DEFAULT_STEPS,
  stepFor,
  stepValue,
  UnitInput,
} = loadComponent(join(ROOT, "registry", "ui", "unit-input.tsx"))

/** The field's two controls, plus whatever it is saying underneath them. */
function parts(instance) {
  const nodes = walk(instance.tree)
  const group = byRole(nodes, "group")[0]
  const inputs = byTag(nodes, "input")
  return {
    group,
    box: inputs.find((n) => n.props.type === "text"),
    hidden: inputs.find((n) => n.props.type === "hidden"),
    select: byTag(nodes, "select")[0],
    options: byTag(nodes, "option").map((n) => n.props.value),
    status: byTag(nodes, "span").find((n) => n.props["aria-live"] === "polite"),
  }
}

function type(instance, value) {
  parts(instance).box.props.onChange({ target: { value } })
  instance.rerender()
}

function pick(instance, unit) {
  parts(instance).select.props.onChange({ target: { value: unit } })
  instance.rerender()
}

function press(instance, key, { shiftKey = false } = {}) {
  parts(instance).box.props.onKeyDown({
    key,
    shiftKey,
    preventDefault() {},
  })
  instance.rerender()
}

// --- the conversion table, against the engine's own numbers -----------------------------------

test("the absolute table is the one the engine reports, to the digit", () => {
  // Measured in Chrome 152 via Typed OM: CSS.px(96).to("in") -> 1in, .to("cm") -> 2.54cm,
  // CSS.pc(1).to("px") -> 16, CSS.pt(1).to("px") -> 1.3333333333333333,
  // CSS.Q(1).to("px") -> 0.9448818897637794.
  assert.equal(ABSOLUTE_PX.px, 1)
  assert.equal(ABSOLUTE_PX.in, 96)
  assert.equal(ABSOLUTE_PX.pc, 16)
  assert.equal(ABSOLUTE_PX.pt, 1.3333333333333333)
  assert.equal(ABSOLUTE_PX.cm, 37.79527559055118)
  assert.equal(ABSOLUTE_PX.mm, 3.7795275590551176)
  assert.equal(ABSOLUTE_PX.Q, 0.9448818897637794)
})

test("absolute units convert both ways without a base", () => {
  assert.equal(convertLength(96, "px", "in"), 1)
  assert.equal(convertLength(1, "in", "px"), 96)
  assert.equal(convertLength(1, "in", "pt"), 72)
  assert.equal(convertLength(1, "pc", "px"), 16)
  assert.equal(convertLength(2.54, "cm", "in"), 1)
  // Through two conversions and back, still the original.
  assert.equal(convertLength(convertLength(72, "pt", "cm"), "cm", "pt"), 72)
})

test("every font- and viewport-relative unit refuses to convert without a base", () => {
  // This is the platform's own line, not a taste: CSS.rem(1).to("px") throws
  // "Cannot convert to px", and so does the same call on each of the other nine.
  assert.equal(RELATIVE_UNITS.length, 10)
  for (const unit of RELATIVE_UNITS) {
    assert.equal(
      convertLength(1, unit, "px"),
      null,
      `${unit} -> px should be null without a base`
    )
    assert.equal(
      convertLength(16, "px", unit),
      null,
      `px -> ${unit} should be null without a base`
    )
    assert.equal(isAbsoluteUnit(unit), false)
  }
})

test("a base is used when given, and only for the unit it describes", () => {
  assert.equal(convertLength(16, "px", "rem", { rem: 16 }), 1)
  assert.equal(convertLength(1.5, "rem", "px", { rem: 16 }), 24)
  assert.equal(convertLength(1, "rem", "px", { rem: 20 }), 20)
  // A rem base says nothing about em.
  assert.equal(convertLength(1, "em", "px", { rem: 16 }), null)
  assert.equal(convertLength(1, "em", "px", { rem: 16, em: 20 }), 20)
  // Nor about a percentage, whose base is a width rather than a font size.
  assert.equal(convertLength(50, "%", "px", { rem: 16 }), null)
  assert.equal(convertLength(50, "%", "px", { "%": 4 }), 200)
})

test("a bare number is a length only when it is zero", () => {
  // Measured: CSS.supports("width", "0") is true and CSS.supports("width", "16") is false, and
  // assigning the unitless string to element.style is a silent no-op.
  assert.equal(resolvePx(0, ""), 0)
  assert.equal(resolvePx(16, ""), null)
  assert.equal(convertLength(0, "", "px"), 0)
  assert.equal(convertLength(16, "", "px"), null)
  assert.equal(convertLength(0, "px", ""), 0)
  assert.equal(convertLength(16, "px", ""), null)
})

// --- reading what somebody typed or pasted ----------------------------------------------------

test("a number with a unit is read, in any case, with or without a space", () => {
  assert.deepEqual(parseUnitValue("16px"), { value: 16, unit: "px" })
  assert.deepEqual(parseUnitValue("16 px"), { value: 16, unit: "px" })
  assert.deepEqual(parseUnitValue("  1.5rem  "), { value: 1.5, unit: "rem" })
  assert.deepEqual(parseUnitValue(".5em"), { value: 0.5, unit: "em" })
  assert.deepEqual(parseUnitValue("-2px"), { value: -2, unit: "px" })
  assert.deepEqual(parseUnitValue("50%"), { value: 50, unit: "%" })
  assert.deepEqual(parseUnitValue("12"), { value: 12, unit: "" })
  // CSS unit identifiers are case-insensitive, and the canonical spelling comes back out.
  assert.deepEqual(parseUnitValue("16PX"), { value: 16, unit: "px" })
  assert.deepEqual(parseUnitValue("1REM"), { value: 1, unit: "rem" })
  assert.deepEqual(parseUnitValue("1q"), { value: 1, unit: "Q" })
})

test("things Number() would happily accept are refused", () => {
  // Number("1e3") is 1000 and Number("0x10") is 16; neither is something typed into a length box.
  for (const text of ["1e3", "0x10", "Infinity", "NaN", "1,5", "1.2.3", "", "   ", "px", "+-1px", "16 px rem"]) {
    assert.equal(parseUnitValue(text), null, `${JSON.stringify(text)} should not parse`)
  }
})

test("a unit outside the offered list does not parse", () => {
  assert.equal(parseUnitValue("3vw", ["px", "rem"]), null)
  assert.deepEqual(parseUnitValue("3vw", ALL_UNITS), { value: 3, unit: "vw" })
})

// --- printing it back -------------------------------------------------------------------------

test("trailing zeros go, and a round number keeps its zeros", () => {
  assert.equal(formatNumber(1.06, 4), "1.06")
  assert.equal(formatNumber(2, 4), "2")
  assert.equal(formatNumber(1.0625, 4), "1.0625")
  assert.equal(formatNumber(1.0625, 2), "1.06")
  // The bug a blanket /0+$/ strip introduces: 100 is not 1.
  assert.equal(formatNumber(100, 4), "100")
  assert.equal(formatNumber(10, 0), "10")
  assert.equal(formatNumber(1000, 2), "1000")
  assert.equal(toCssLength(1.5, "rem"), "1.5rem")
  assert.equal(toCssLength(0, ""), "0")
})

// --- the step, per unit, without drift --------------------------------------------------------

test("each unit steps by an amount that makes sense in that unit", () => {
  assert.equal(stepFor("px"), 1)
  assert.equal(stepFor("rem"), 0.25)
  assert.equal(stepFor("em"), 0.25)
  assert.equal(stepFor("%"), 1)
  assert.equal(stepFor("in"), 0.125)
  // A single shared step cannot be right for both: one rem is sixteen pixels.
  assert.notEqual(stepFor("px"), stepFor("rem"))
  // Callers override per unit, and a nonsense override falls back.
  assert.equal(stepFor("px", { px: 4 }), 4)
  assert.equal(stepFor("px", { px: 0 }), 1)
  assert.equal(stepFor("px", { px: -1 }), 1)
  for (const unit of Object.keys(DEFAULT_STEPS)) assert.ok(DEFAULT_STEPS[unit] > 0)
})

test("stepping does not drift", () => {
  // Ten additions of 0.1 in IEEE 754 land on 0.9999999999999999.
  let v = 0
  for (let i = 0; i < 10; i++) v = stepValue(v, 0.1, 1)
  assert.equal(v, 1)
  let r = 0
  for (let i = 0; i < 8; i++) r = stepValue(r, 0.25, 1)
  assert.equal(r, 2)
  assert.equal(stepValue(0.1, 0.2, 1), 0.3)
  assert.equal(stepValue(1, 0.25, -1), 0.75)
})

// --- the round trip, which is the reason this component is not a one-liner --------------------

test("px -> rem -> px gives back the number that was typed", () => {
  // Recomputing instead of remembering is what loses it. Measured over 1..200px with a 16px root,
  // rounding the trip to 2 decimals returns the original for only 50 of the 200 — 17px becomes
  // 1.06rem becomes 16.96px.
  const field = render(UnitInput, {
    defaultValue: { value: 17, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 16 },
    decimals: 2,
  })
  assert.equal(parts(field).box.props.value, "17")

  pick(field, "rem")
  assert.equal(parts(field).box.props.value, "1.06")

  pick(field, "px")
  assert.equal(parts(field).box.props.value, "17")
})

test("the round trip survives a base no number of decimals can express", () => {
  // Somebody set html { font-size: 15px }. 1/15 does not terminate in decimal, so 65 of 200 px
  // values survive at 2, 3 and 4 decimals alike — more precision is not the fix, not recomputing is.
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 15 },
    decimals: 4,
  })
  pick(field, "rem")
  assert.equal(parts(field).box.props.value, "1.0667")
  pick(field, "px")
  assert.equal(parts(field).box.props.value, "16")
})

test("typing is a new intention, so it drops the remembered values", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 17, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 16 },
    decimals: 2,
  })
  pick(field, "rem")
  type(field, "2")
  pick(field, "px")
  // 2rem is 32px. Handing back the remembered 17 here would be stale.
  assert.equal(parts(field).box.props.value, "32")
})

// --- changing the unit: convert, or carry and say so ------------------------------------------

test("converting keeps the rendered length and changes the number", () => {
  const seen = []
  const field = render(UnitInput, {
    defaultValue: { value: 32, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 16 },
    onValueChange: (next) => seen.push(next),
  })
  pick(field, "rem")
  assert.equal(parts(field).box.props.value, "2")
  assert.deepEqual(seen.at(-1), { value: 2, unit: "rem", px: 32 })
})

test("reinterpreting keeps the number and changes the length", () => {
  const seen = []
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 16 },
    behavior: "reinterpret",
    onValueChange: (next) => seen.push(next),
  })
  pick(field, "rem")
  assert.equal(parts(field).box.props.value, "16")
  // 16rem is 256px — sixteen times bigger, and that is what was asked for.
  assert.deepEqual(seen.at(-1), { value: 16, unit: "rem", px: 256 })
})

test("with no base the number is carried, and the field says it was carried", () => {
  // The failure this exists to prevent is dividing by an assumed 16 and reporting nothing.
  const seen = []
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px", "rem"],
    onValueChange: (next) => seen.push(next),
  })
  pick(field, "rem")
  assert.equal(parts(field).box.props.value, "16")
  assert.deepEqual(seen.at(-1), { value: 16, unit: "rem", px: null })
  assert.match(parts(field).status.props.children, /rem/)
})

test("a unit it cannot resolve is reported rather than shown as pixels", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 50, unit: "%" },
    units: ["px", "%"],
  })
  const status = parts(field).status
  assert.ok(status, "a field holding an unresolvable unit should say so")
  assert.doesNotMatch(status.props.children, /= \d/)
})

test("the resolved length is shown once a base accounts for it", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1.5, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
  })
  assert.equal(parts(field).status.props.children, "= 24px")
})

// --- what the box accepts ---------------------------------------------------------------------

test("a bare number keeps the unit the select is showing", () => {
  const seen = []
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
    onValueChange: (next) => seen.push(next),
  })
  type(field, "2")
  assert.deepEqual(seen.at(-1), { value: 2, unit: "rem", px: 32 })
  assert.equal(parts(field).select.props.value, "rem")
})

test("a value pasted with its unit moves the select", () => {
  // Copying "1.5rem" out of devtools and pasting it in should land in one action.
  const seen = []
  const field = render(UnitInput, {
    defaultValue: { value: 10, unit: "px" },
    units: ["px", "rem", "em"],
    base: { rem: 16 },
    onValueChange: (next) => seen.push(next),
  })
  type(field, "1.5rem")
  assert.equal(parts(field).select.props.value, "rem")
  assert.deepEqual(seen.at(-1), { value: 1.5, unit: "rem", px: 24 })
})

test("a bare non-zero number is marked invalid, and zero is not", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 0, unit: "" },
    units: ["", "px"],
  })
  assert.equal(parts(field).box.props["aria-invalid"], undefined)

  type(field, "16")
  assert.equal(parts(field).box.props["aria-invalid"], true)
  assert.ok(parts(field).status)

  type(field, "0")
  assert.equal(parts(field).box.props["aria-invalid"], undefined)
})

test("text that is not a number is kept on screen and marked, not deleted", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px"],
  })
  type(field, "16q")
  assert.equal(parts(field).box.props.value, "16q", "the reader's text should survive")
  assert.equal(parts(field).box.props["aria-invalid"], true)
})

// --- the arrow keys ---------------------------------------------------------------------------

test("the arrow keys step by the showing unit's step", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
  })
  press(field, "ArrowUp")
  assert.equal(parts(field).box.props.value, "1.25")
  press(field, "ArrowDown")
  assert.equal(parts(field).box.props.value, "1")
  // Shift takes ten steps at once.
  press(field, "ArrowUp", { shiftKey: true })
  assert.equal(parts(field).box.props.value, "3.5")
})

test("a key that is not an arrow is left alone", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["rem"],
  })
  press(field, "a")
  assert.equal(parts(field).box.props.value, "1")
})

test("stepping from an empty box starts at zero", () => {
  const field = render(UnitInput, { units: ["px"] })
  press(field, "ArrowUp")
  assert.equal(parts(field).box.props.value, "1")
})

test("a pixel bound holds in whichever unit the field is showing", () => {
  // minPx is in pixels so one bound means one thing; stepping stops there after conversion.
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
    minPx: 16,
  })
  press(field, "ArrowDown")
  assert.equal(parts(field).box.props.value, "1", "0.75rem is 12px, below the 16px floor")

  const wide = render(UnitInput, {
    defaultValue: { value: 20, unit: "px" },
    units: ["px"],
    maxPx: 20,
  })
  press(wide, "ArrowUp")
  assert.equal(parts(wide).box.props.value, "20")
})

test("a value outside the bounds is reported", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
    minPx: 24,
  })
  assert.equal(parts(field).box.props["aria-invalid"], true)
  assert.ok(parts(field).status)
})

// --- what a screen reader and a form get ------------------------------------------------------

test("the two controls are one named group, each separately labelled", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px", "rem"],
    label: "Padding",
    unitLabel: "Padding unit",
  })
  const { group, box, select } = parts(field)
  assert.equal(group.props["aria-label"], "Padding")
  assert.equal(group.props.role, "group")
  // type=text with inputMode=decimal, not type=number: a number input throws away text it cannot
  // parse, so "16q" would vanish instead of being explained.
  assert.equal(box.props.type, "text")
  assert.equal(box.props.inputMode, "decimal")
  assert.equal(select.props["aria-label"], "Padding unit")
})

test("the status is wired to the box it describes", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1, unit: "rem" },
    units: ["rem"],
    base: { rem: 16 },
  })
  const { box, status } = parts(field)
  assert.ok(status.props.id)
  assert.equal(box.props["aria-describedby"], status.props.id)
  assert.equal(status.props["aria-live"], "polite")
})

test("nothing is described when there is nothing to say", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px"],
  })
  const { box, status } = parts(field)
  assert.equal(status, undefined, "a plain 16px needs no commentary")
  assert.equal(box.props["aria-describedby"], undefined)
})

test("the select offers exactly the units it was given, and no unit reads as a dash", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 0, unit: "" },
    units: ["", "px", "rem"],
  })
  assert.deepEqual(parts(field).options, ["", "px", "rem"])
  const dash = walk(field.tree).filter((n) => n.type === "option" && n.props.value === "")
  assert.equal(dash[0].props.children, "—")
})

test("a named field posts canonical CSS, and posts nothing it would not stand behind", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 1.5, unit: "rem" },
    units: ["px", "rem", ""],
    base: { rem: 16 },
    name: "padding",
  })
  assert.equal(parts(field).hidden.props.value, "1.5rem")
  assert.equal(parts(field).hidden.props.name, "padding")

  // A bare 16 is not a length, so the server is not handed one.
  pick(field, "")
  type(field, "16")
  assert.equal(parts(field).hidden.props.value, "")
})

test("no hidden input exists until the field is named", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px"],
  })
  assert.equal(parts(field).hidden, undefined)
})

// --- controlled use ---------------------------------------------------------------------------

test("a controlled field follows the value it is handed", () => {
  const field = render(UnitInput, {
    value: { value: 16, unit: "px" },
    units: ["px", "rem"],
    base: { rem: 16 },
  })
  assert.equal(parts(field).box.props.value, "16")

  field.update({
    value: { value: 2, unit: "rem" },
    units: ["px", "rem"],
    base: { rem: 16 },
  })
  assert.equal(parts(field).box.props.value, "2")
  assert.equal(parts(field).select.props.value, "rem")
})

test("a disabled field disables both controls", () => {
  const field = render(UnitInput, {
    defaultValue: { value: 16, unit: "px" },
    units: ["px", "rem"],
    disabled: true,
  })
  const { box, select } = parts(field)
  assert.equal(box.props.disabled, true)
  assert.equal(select.props.disabled, true)
  // And does not move on an arrow key.
  press(field, "ArrowUp")
  assert.equal(parts(field).box.props.value, "16")
})

test("an untouched required field is not yet wrong", () => {
  // Marking a field the reader has not reached as invalid announces a mistake nobody has made; the
  // native required attribute is what carries the requirement.
  const field = render(UnitInput, { units: ["px"], required: true })
  const { box, status } = parts(field)
  assert.equal(box.props.required, true)
  assert.equal(box.props["aria-invalid"], undefined)
  assert.equal(status, undefined)
})

test("pxPerUnit answers for the units it knows and refuses the rest", () => {
  assert.equal(pxPerUnit("px"), 1)
  assert.equal(pxPerUnit("pt"), 96 / 72)
  assert.equal(pxPerUnit("rem"), null)
  assert.equal(pxPerUnit("rem", { rem: 16 }), 16)
  assert.equal(pxPerUnit("rem", { rem: Number.NaN }), null)
})
