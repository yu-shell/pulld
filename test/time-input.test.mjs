// time-input hands back a 24-hour string while showing whatever clock the reader's locale writes,
// and that translation is the whole component. Every failure mode below is invisible to someone
// reading the source in one locale with a mouse.
//
// The clock: "twelve-hour" is two different clocks. en-US writes midnight 12 AM and counts 12, 1, 2
// (h12); ja-JP writes it 午前0時 and counts 0, 1, 2 (h11). A field that only implements h12 shows a
// Japanese reader an hour that does not exist in their writing, and one that only implements h11
// shows an American reader "0 AM". The same split decides whether the displayed 12 means hour 0 or
// hour 12 — the off-by-twelve that turns a noon deadline into a midnight one.
//
// The layout: ko-KR puts the day period before the hour, ja-JP writes it with no space after, and
// ar-EG formats digits as Arabic-Indic numerals that cannot be typed back in. All three are decided
// by data, not by the developer's locale.
//
// The range: quiet hours and night shifts run past midnight, so a max earlier than min has to mean
// the night rather than an empty set.
//
// These run against the real source through the harness, so they fail when the component changes
// rather than when a copy of it does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { TimeInput } = loadComponent(join(ROOT, "registry", "ui", "time-input.tsx"))

const show = (props) => {
  const emitted = []
  const instance = render(TimeInput, { ...props, onChange: (v) => emitted.push(v) })
  const read = () => {
    const nodes = walk(instance.tree)
    const segs = byRole(nodes, "spinbutton")
    const group = byRole(nodes, "group")[0]
    return {
      segs,
      /** Segment names in the order the locale lays them out. */
      order: segs.map((s) => s.props["aria-label"]),
      /** What each segment shows on screen. */
      text: segs.map((s) => s.props.value),
      /** What a screen reader is told each segment is. */
      spoken: segs.map((s) => s.props["aria-valuetext"]),
      invalid: segs.some((s) => s.props["aria-invalid"] === true),
      flagged: /border-destructive/.test(group.props.className),
      hidden: byTag(nodes, "input").find((n) => n.props.type === "hidden"),
      /** Literal separators, which the locale also decides. */
      literals: nodes
        .filter((n) => n.type === "span" && n.props?.["aria-hidden"] === "true")
        .map((n) => n.props.children),
    }
  }
  const at = (label) => read().order.indexOf(label)
  return {
    read,
    emitted,
    /** Press a key on the segment with this accessible name. */
    press(label, key) {
      read().segs[at(label)].props.onKeyDown({ key, preventDefault() {} })
      instance.rerender()
    },
    /** Type a run of digits into one segment, the way a person fills it in. */
    type(label, digits) {
      for (const d of digits) this.press(label, d)
    },
    paste(text) {
      read().segs[0].props.onPaste({
        preventDefault() {},
        clipboardData: { getData: () => text },
      })
      instance.rerender()
    },
    update: (next) => instance.update({ ...next, onChange: (v) => emitted.push(v) }),
  }
}

// The reference table, written out rather than computed, so a mistake in the component cannot be
// mirrored by the same mistake in the test.
const H12 = ["12", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]

test("midnight and noon are not off by twelve, on either twelve-hour clock", () => {
  for (let hour = 0; hour < 24; hour++) {
    const value = `${String(hour).padStart(2, "0")}:30`

    // h12 — en-US. Midnight is 12 AM, noon is 12 PM, and 13:00 is 1 PM.
    const us = show({ value, locale: "en-US", hour12: true }).read()
    assert.deepEqual(
      [us.text[us.order.indexOf("Hour")], us.text[us.order.indexOf("AM/PM")]],
      [H12[hour % 12], hour < 12 ? "AM" : "PM"],
      `en-US should write ${value} as ${H12[hour % 12]} ${hour < 12 ? "AM" : "PM"}`
    )

    // h11 — ja-JP. The same instant, but the hour counts from zero and the wording is 午前/午後.
    const jp = show({ value, locale: "ja-JP", hour12: true }).read()
    assert.deepEqual(
      [jp.text[jp.order.indexOf("Hour")], jp.text[jp.order.indexOf("AM/PM")]],
      [String(hour % 12).padStart(2, "0"), hour < 12 ? "午前" : "午後"],
      `ja-JP should write ${value} as ${hour % 12} ${hour < 12 ? "午前" : "午後"}`
    )

    // h23 — de-DE. No day period at all, so there is nothing to be off by twelve about.
    const de = show({ value, locale: "de-DE" }).read()
    assert.equal(de.order.includes("AM/PM"), false, "a 24-hour clock has no AM/PM segment")
    assert.equal(de.text[de.order.indexOf("Hour")], String(hour).padStart(2, "0"))
  }
})

test("what the reader types on a twelve-hour clock comes back out as the right 24-hour value", () => {
  // Both twelves, because they are the two the arithmetic gets wrong, plus an ordinary afternoon.
  for (const [hour, period, expected] of [
    ["12", "a", "00:05"],
    ["12", "p", "12:05"],
    ["01", "a", "01:05"],
    ["07", "p", "19:05"],
    ["11", "p", "23:05"],
  ]) {
    const field = show({ locale: "en-US", hour12: true })
    field.type("Hour", hour)
    field.type("Minute", "05")
    field.press("AM/PM", period)
    assert.equal(
      field.emitted.at(-1),
      expected,
      `typing ${hour}:05 ${period.toUpperCase()}M should emit ${expected}`
    )
  }
})

test("changing the day period moves the hour with it instead of drifting apart", () => {
  const field = show({ value: "09:30", locale: "en-US", hour12: true })
  field.press("AM/PM", "ArrowUp")
  assert.equal(field.emitted.at(-1), "21:30", "9:30 AM flipped to PM is 21:30")

  const back = show({ value: "21:30", locale: "en-US", hour12: true })
  back.press("AM/PM", "p")
  assert.equal(back.emitted.length, 0, "asking for the period it is already on emits nothing new")
  back.press("AM/PM", "a")
  assert.equal(back.emitted.at(-1), "09:30")
})

test("the hour arrow stays in its half of the day", () => {
  // The trap: stepping 11 to 12 on a twelve-hour clock looks like crossing noon, and a component
  // that steps the underlying 24-hour hour would silently move an 11 AM meeting to 12 PM.
  const up = show({ value: "11:00", locale: "en-US", hour12: true })
  up.press("Hour", "ArrowUp")
  assert.equal(up.emitted.at(-1), "00:00", "11 AM steps to 12 AM, which is midnight — not noon")

  const wrapDown = show({ value: "00:00", locale: "en-US", hour12: true })
  wrapDown.press("Hour", "ArrowDown")
  assert.equal(wrapDown.emitted.at(-1), "11:00", "12 AM steps back to 11 AM")

  const pm = show({ value: "23:00", locale: "en-US", hour12: true })
  pm.press("Hour", "ArrowUp")
  assert.equal(pm.emitted.at(-1), "12:00", "11 PM steps to 12 PM, staying in the afternoon")
})

test("a 24-hour clock accepts midnight typed as a single zero", () => {
  // Auto-advance is decided by range, and a lone 0 is a real hour on this clock while it is only
  // the start of one on a twelve-hour clock. Getting that backwards makes midnight untypeable.
  const de = show({ locale: "de-DE" })
  de.type("Hour", "0")
  de.type("Minute", "00")
  assert.equal(de.emitted.at(-1), "00:00")

  const us = show({ locale: "en-US", hour12: true })
  us.type("Hour", "0")
  assert.equal(us.read().text[us.read().order.indexOf("Hour")], "0", "0 is held, waiting for 01-09")
  assert.equal(us.emitted.at(-1), "", "and it is not yet an hour")
  us.type("Hour", "9")
  us.type("Minute", "00")
  us.press("AM/PM", "a")
  assert.equal(us.emitted.at(-1), "09:00")
})

test("a two-digit pair that cannot exist starts a new number instead of being dropped", () => {
  const field = show({ locale: "de-DE" })
  field.type("Hour", "25") // 2 is a valid start, 25 is not an hour
  assert.equal(field.read().text[0], "05", "the 5 becomes the hour rather than vanishing")
})

test("segment order, separators and wording all come from the locale", () => {
  const kr = show({ value: "13:05", locale: "ko-KR", hour12: true }).read()
  assert.deepEqual(kr.order, ["AM/PM", "Hour", "Minute"], "ko-KR writes the day period first")
  assert.equal(kr.text[0], "오후")

  const jp = show({ value: "13:05", locale: "ja-JP", hour12: true }).read()
  assert.deepEqual(jp.order, ["AM/PM", "Hour", "Minute"])
  assert.equal(jp.text[0], "午後")

  const us = show({ value: "13:05", locale: "en-US", hour12: true }).read()
  assert.deepEqual(us.order, ["Hour", "Minute", "AM/PM"])
  assert.ok(us.literals.includes(":"), "the separator is the one the locale writes")
})

test("the digits stay typeable even where the locale would render them otherwise", () => {
  // ar-EG formats times with Arabic-Indic numerals. Rendering those would put characters in the
  // field that the number keys can never reproduce.
  const eg = show({ value: "13:05", locale: "ar-EG", hour12: true }).read()
  for (const [i, label] of eg.order.entries()) {
    if (label === "AM/PM") {
      // The wording is the one thing that should be localised — it is read, not typed.
      assert.equal(eg.text[i], "م", "the day period keeps the locale's own wording")
      continue
    }
    assert.match(eg.text[i], /^[0-9]{2}$/, `expected ASCII digits, got ${JSON.stringify(eg.text[i])}`)
  }
})

test("a range that ends before it starts is the night, not an empty set", () => {
  // Quiet hours, night shifts and maintenance windows all run past midnight. Comparing the two
  // bounds the ordinary way marks every one of those times invalid.
  const night = { min: "22:00", max: "06:00", locale: "de-DE" }
  for (const [value, expected] of [
    ["23:30", false],
    ["22:00", false],
    ["02:00", false],
    ["06:00", false],
    ["12:00", true],
    ["21:59", true],
    ["06:01", true],
  ]) {
    const field = show({ value, ...night }).read()
    assert.equal(field.invalid, expected, `${value} within 22:00-06:00 should be invalid=${expected}`)
    assert.equal(field.flagged, expected, "the border follows the same judgement")
  }

  // The ordinary direction still behaves the ordinary way.
  const day = { min: "09:00", max: "17:00", locale: "de-DE" }
  assert.equal(show({ value: "08:59", ...day }).read().invalid, true)
  assert.equal(show({ value: "12:00", ...day }).read().invalid, false)
  assert.equal(show({ value: "17:01", ...day }).read().invalid, true)
})

test("an out-of-range time is flagged but never blocked", () => {
  const field = show({ locale: "de-DE", min: "09:00", max: "17:00" })
  field.type("Hour", "03")
  field.type("Minute", "00")
  assert.equal(field.emitted.at(-1), "03:00", "the value the reader typed is still reported")
  assert.equal(field.read().invalid, true, "and it is marked invalid rather than rewritten")
})

test("bounds of a different width than the value still compare correctly", () => {
  // "09:30" against "09:30:00" is a string comparison that only works if both are padded first.
  assert.equal(show({ value: "09:30", min: "09:30:00", locale: "de-DE" }).read().invalid, false)
  assert.equal(show({ value: "09:29", min: "09:30:00", locale: "de-DE" }).read().invalid, true)
  assert.equal(show({ value: "17:00:01", max: "17:00", withSeconds: true, locale: "de-DE" }).read().invalid, true)
})

test("an off-step minute rounds toward the arrow", () => {
  const up = show({ value: "10:07", locale: "de-DE", minuteStep: 15 })
  up.press("Minute", "ArrowUp")
  assert.equal(up.emitted.at(-1), "10:15", "up from 07 lands on the next quarter, not 22")

  const down = show({ value: "10:07", locale: "de-DE", minuteStep: 15 })
  down.press("Minute", "ArrowDown")
  assert.equal(down.emitted.at(-1), "10:00", "down from 07 lands on the previous quarter, not 52")

  const onStep = show({ value: "10:15", locale: "de-DE", minuteStep: 15 })
  onStep.press("Minute", "ArrowUp")
  assert.equal(onStep.emitted.at(-1), "10:30", "an on-step minute moves a whole step")

  const wrapped = show({ value: "10:45", locale: "de-DE", minuteStep: 15 })
  wrapped.press("Minute", "ArrowUp")
  assert.equal(wrapped.emitted.at(-1), "10:00", "the minute wraps without touching the hour")
})

test("a pasted time is read the way it is written, on any clock", () => {
  for (const [locale, hour12, text, expected] of [
    ["en-US", true, "12:30 PM", "12:30"],
    ["en-US", true, "12:30 AM", "00:30"],
    ["ja-JP", true, "12:30 PM", "12:30"],
    ["de-DE", undefined, "14:30", "14:30"],
    ["en-US", true, "2:05 pm", "14:05"],
    ["de-DE", undefined, "24:00", "00:00"],
  ]) {
    const field = show({ locale, hour12 })
    field.paste(text)
    assert.equal(field.emitted.at(-1), expected, `pasting ${JSON.stringify(text)} should give ${expected}`)
  }

  // Localised wording, so a reader pasting from their own UI is understood too.
  const jp = show({ locale: "ja-JP", hour12: true })
  jp.paste("午後 3:45")
  assert.equal(jp.emitted.at(-1), "15:45")

  // Not a time: ignored rather than half applied.
  const ignored = show({ locale: "de-DE", value: "09:00" })
  ignored.paste("next tuesday")
  assert.equal(ignored.emitted.length, 0)
})

test("seconds are part of the value only when they are part of the field", () => {
  const without = show({ locale: "de-DE" })
  without.type("Hour", "09")
  without.type("Minute", "30")
  assert.equal(without.emitted.at(-1), "09:30")
  assert.equal(without.read().order.includes("Second"), false)

  const with_ = show({ locale: "de-DE", withSeconds: true })
  with_.type("Hour", "09")
  with_.type("Minute", "30")
  assert.equal(with_.emitted.at(-1), "", "an incomplete time is reported empty, not as 09:30:undefined")
  with_.type("Second", "07")
  assert.equal(with_.emitted.at(-1), "09:30:07")
})

test("the form value is the 24-hour string, whatever the field is showing", () => {
  const us = show({ value: "23:15", locale: "en-US", hour12: true, name: "start" }).read()
  assert.equal(us.text[us.order.indexOf("Hour")], "11", "the reader sees 11 PM")
  assert.equal(us.hidden.props.value, "23:15", "the form gets 23:15")
  assert.equal(us.hidden.props.name, "start")

  const empty = show({ locale: "en-US", hour12: true, name: "start" }).read()
  assert.equal(empty.hidden.props.value, "", "an incomplete time submits nothing rather than a guess")
})

test("clearing a segment empties the value without disturbing the others", () => {
  const field = show({ defaultValue: "14:30", locale: "de-DE" })
  field.press("Minute", "Backspace")
  assert.equal(field.emitted.at(-1), "", "an incomplete time is not a time")
  assert.equal(field.read().text[0], "14", "the hour is still there")
  assert.equal(field.read().text[1], "mm")
  field.type("Minute", "45")
  assert.equal(field.emitted.at(-1), "14:45")
})

test("each segment tells a screen reader what it holds, not a bare number", () => {
  const us = show({ value: "13:05", locale: "en-US", hour12: true }).read()
  assert.deepEqual(us.spoken, ["1", "5", "PM"], "the period is spoken by name")
  assert.deepEqual(us.segs.map((s) => s.props["aria-valuenow"]), [1, 5, 1])
  assert.deepEqual(
    us.segs.map((s) => [s.props["aria-valuemin"], s.props["aria-valuemax"]]),
    [
      [1, 12],
      [0, 59],
      [0, 1],
    ],
    "the hour range is the one this clock actually uses"
  )

  const de = show({ locale: "de-DE" }).read()
  assert.deepEqual(de.spoken, ["Empty", "Empty"])
  assert.deepEqual(
    de.segs.map((s) => [s.props["aria-valuemin"], s.props["aria-valuemax"]]),
    [
      [0, 23],
      [0, 59],
    ]
  )
})

test("a controlled field follows its prop and does not fight the reader mid-entry", () => {
  const field = show({ value: "09:00", locale: "de-DE" })
  field.update({ value: "17:45", locale: "de-DE" })
  assert.deepEqual(field.read().text, ["17", "45"])

  // A controlled parent stores "" while the time is incomplete. Echoing that back must not wipe the
  // half-typed hour on every keystroke.
  const typing = show({ value: "", locale: "de-DE" })
  typing.type("Hour", "09")
  typing.update({ value: "", locale: "de-DE" })
  assert.equal(typing.read().text[0], "09", "the typed hour survives the echo")
})
