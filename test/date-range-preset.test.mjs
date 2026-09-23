// date-range-preset answers with an expression — "last7d" — rather than with a pair of dates, and
// almost everything worth testing here is a rule that looks fine to someone clicking around in one
// time zone, on one day, in one locale:
//
// The value must not be folded. A picker that resolves "last 7 days" the moment it is clicked and
// stores the answer produces a URL that means someone else's week and a bookmark whose numbers
// never move again. The proof is that the same value resolves to different spans on different days,
// which is the first test below.
//
// The range must be half-open. An inclusive end has to name a last instant, every implementation
// picks a different one, and each of them quietly drops whatever happened in the last second of the
// final day. Here the end is the day after, and the display is the day before the end — a component
// that shows the excluded day is lying to the reader in a way no screenshot reveals.
//
// "Today" depends on where you are standing. At 23:30 UTC it is already tomorrow in Tokyo, so which
// day a preset means is a property of a zone and not of the clock.
//
// And the calendar arithmetic has two traps with no visible symptom: January's "last month" is in
// the previous year, and Date.UTC reads a year under 100 as nineteen-hundred-something.
//
// The date fields are stubbed. They have their own tests; what matters here is the contract between
// the two — which value, which bounds and which accessible name reach each of the pair, and that a
// half-typed range is never reported to the parent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Stands in for the real date field: keeps its props visible and renders nothing. */
const DateInput = () => null

const {
  DateRangePreset,
  DEFAULT_PRESETS,
  parseDateRange,
  resolveDateRange,
  formatDateRange,
  lastIncludedDay,
  toCalendarDay,
  toPlainDate,
  shiftDay,
  todayIn,
} = loadComponent(join(ROOT, "registry", "ui", "date-range-preset.tsx"), {
  stubs: { "@/registry/ui/date-input": { DateInput } },
})

const TODAY = "2026-09-23"

// --- the value is an expression -------------------------------------------

test("the same preset resolves to a different span on a different day", () => {
  // The whole point of the component. If the value were folded into dates at click time, these two
  // would be identical — which is exactly what a shared link and a reopened bookmark show.
  assert.deepEqual(resolveDateRange("last7d", { today: "2026-09-23" }), {
    start: "2026-09-17",
    end: "2026-09-24",
  })
  assert.deepEqual(resolveDateRange("last7d", { today: "2026-09-30" }), {
    start: "2026-09-24",
    end: "2026-10-01",
  })
})

test("every default preset is half-open: the end is the day after the last one included", () => {
  for (const preset of DEFAULT_PRESETS) {
    const range = resolveDateRange(preset.id, { today: TODAY })
    assert.ok(range, `${preset.id} should resolve`)
    assert.equal(
      toPlainDate(shiftDay(toCalendarDay(lastIncludedDay(range)), 1)),
      range.end,
      `${preset.id}: end must be one day past the last included day`
    )
    assert.ok(range.start < range.end, `${preset.id}: a range covers at least one day`)
  }
})

test("the default presets resolve to the spans they name", () => {
  const spans = Object.fromEntries(
    DEFAULT_PRESETS.map((p) => [p.id, resolveDateRange(p.id, { today: TODAY })])
  )
  assert.deepEqual(spans.today, { start: "2026-09-23", end: "2026-09-24" })
  assert.deepEqual(spans.yesterday, { start: "2026-09-22", end: "2026-09-23" })
  // Seven days counted back *including* today, which is the convention DEFAULT_PRESETS documents.
  assert.deepEqual(spans.last7d, { start: "2026-09-17", end: "2026-09-24" })
  assert.deepEqual(spans.last30d, { start: "2026-08-25", end: "2026-09-24" })
  assert.deepEqual(spans.last90d, { start: "2026-06-26", end: "2026-09-24" })
  assert.deepEqual(spans.mtd, { start: "2026-09-01", end: "2026-09-24" })
  assert.deepEqual(spans.lastMonth, { start: "2026-08-01", end: "2026-09-01" })
  assert.deepEqual(spans.ytd, { start: "2026-01-01", end: "2026-09-24" })
})

test("a custom range covers the last day it names", () => {
  const range = resolveDateRange("2026-09-01..2026-09-30", { today: TODAY })
  assert.deepEqual(range, { start: "2026-09-01", end: "2026-10-01" })
  // The bug this guards: reading the written end as the exclusive end makes every custom range one
  // day short, and September's last day is the one that goes missing from the month's figures.
  assert.ok("2026-09-30" < range.end, "the 30th is inside the range")
  assert.equal(lastIncludedDay(range), "2026-09-30")
})

test("a one-day custom range is a day, not an empty span", () => {
  assert.deepEqual(resolveDateRange("2026-09-01..2026-09-01", { today: TODAY }), {
    start: "2026-09-01",
    end: "2026-09-02",
  })
})

// --- calendar arithmetic ---------------------------------------------------

test("January's last month is in the previous year", () => {
  assert.deepEqual(resolveDateRange("lastMonth", { today: "2026-01-15" }), {
    start: "2025-12-01",
    end: "2026-01-01",
  })
  // The same rollover from the other side: yesterday, on New Year's Day.
  assert.deepEqual(resolveDateRange("yesterday", { today: "2026-01-01" }), {
    start: "2025-12-31",
    end: "2026-01-01",
  })
  assert.deepEqual(resolveDateRange("last30d", { today: "2026-01-15" }), {
    start: "2025-12-17",
    end: "2026-01-16",
  })
})

test("last month is as long as that month actually was", () => {
  // February, leap and not. A fixed 30- or 31-day step gets one of these wrong every year.
  assert.equal(lastIncludedDay(resolveDateRange("lastMonth", { today: "2024-03-10" })), "2024-02-29")
  assert.equal(lastIncludedDay(resolveDateRange("lastMonth", { today: "2026-03-15" })), "2026-02-28")
})

test("a year under 100 is that year, not nineteen-hundred-something", () => {
  // Date.UTC(50, 0, 1) is 1950. An archive picker that trips on this is off by nineteen centuries
  // and says nothing about it.
  assert.equal(toPlainDate({ year: 50, month: 1, day: 1 }), "0050-01-01")
  assert.deepEqual(shiftDay({ year: 50, month: 12, day: 31 }, 1), { year: 51, month: 1, day: 1 })
})

test("an out-of-range month rolls into the neighbouring year, keeping that year", () => {
  // The trap the shift exists for: normalising first and stamping the year on afterwards would
  // turn January's month 0 into December of the *same* year instead of the previous one.
  assert.equal(toPlainDate({ year: 2026, month: 0, day: 1 }), "2025-12-01")
  assert.equal(toPlainDate({ year: 2026, month: 13, day: 1 }), "2027-01-01")
})

test("toCalendarDay takes a bare calendar day and nothing else", () => {
  assert.deepEqual(toCalendarDay("2024-02-29"), { year: 2024, month: 2, day: 29 })
  for (const bad of [
    "2026-02-30",
    "2026-02-29", // 2026 is not a leap year
    "2026-13-01",
    "2026-00-10",
    "2026-09-00",
    "2026-9-1",
    "26-09-01",
    "2026-09-23T00:00:00Z", // a timestamp carries a zone; rejected rather than half-read
    "",
    "nope",
  ]) {
    assert.equal(toCalendarDay(bad), null, `"${bad}" is not a calendar day`)
  }
})

// --- which day is "today" --------------------------------------------------

test("which day it is depends on the zone, not on the clock", () => {
  const lateUTC = new Date("2026-09-23T23:30:00Z")
  assert.equal(todayIn("UTC", lateUTC), "2026-09-23")
  assert.equal(todayIn("Asia/Tokyo", lateUTC), "2026-09-24", "already tomorrow in Tokyo")

  const earlyUTC = new Date("2026-09-23T04:00:00Z")
  assert.equal(todayIn("UTC", earlyUTC), "2026-09-23")
  assert.equal(todayIn("America/Los_Angeles", earlyUTC), "2026-09-22", "still yesterday in LA")
})

test("an unknown time zone fails loudly rather than falling back to the machine's", () => {
  assert.throws(() => todayIn("Mars/Olympus"), RangeError)
})

// --- parsing ---------------------------------------------------------------

test("parseDateRange separates a preset id from a custom range", () => {
  assert.deepEqual(parseDateRange("last7d"), { kind: "preset", preset: "last7d" })
  assert.deepEqual(parseDateRange("2026-09-01..2026-09-30"), {
    kind: "custom",
    from: "2026-09-01",
    to: "2026-09-30",
  })
})

test("parseDateRange refuses anything a link should not carry", () => {
  for (const bad of [
    "2026-09-30..2026-09-01", // backwards: no query should be built from it
    "2026-02-30..2026-03-01", // a day that does not exist
    "2026-09-01..2026-09-30..2026-10-01",
    "2026-09-01..",
    "..2026-09-30",
    "nope!",
    "7days ",
    "",
  ]) {
    assert.equal(parseDateRange(bad), null, `"${bad}" should not parse`)
  }
})

test("resolveDateRange returns null for a preset nobody defined", () => {
  assert.equal(resolveDateRange("last3000d", { today: TODAY }), null)
  assert.equal(resolveDateRange("last7d", { today: "not-a-day" }), null)
  // A custom range needs no today at all, so a bad one cannot spoil it.
  assert.ok(resolveDateRange("2026-09-01..2026-09-30", { today: "not-a-day" }))
})

test("a caller's own presets replace the defaults", () => {
  const throughYesterday = [
    {
      id: "last7d",
      label: "Last 7 days",
      resolve: (t) => ({ start: toPlainDate(shiftDay(t, -7)), end: toPlainDate(t) }),
    },
  ]
  assert.deepEqual(resolveDateRange("last7d", { today: TODAY, presets: throughYesterday }), {
    start: "2026-09-16",
    end: "2026-09-23",
  })
  assert.equal(resolveDateRange("mtd", { today: TODAY, presets: throughYesterday }), null)
})

// --- the summary -----------------------------------------------------------

test("the span is written with the last included day, never the excluded end", () => {
  const text = formatDateRange("last7d", { today: TODAY, locale: "en-US" })
  assert.match(text, /17/)
  assert.match(text, /23/)
  assert.doesNotMatch(text, /24/, "the 24th is not in the range and must not be shown")
})

test("a single day is written as one date", () => {
  const text = formatDateRange("today", { today: TODAY, locale: "en-US" })
  assert.match(text, /23/)
  assert.doesNotMatch(text, /24/)
  assert.doesNotMatch(text, /–|-/, "no dash: it is one day, not a span")
})

test("the span follows the locale", () => {
  assert.notEqual(
    formatDateRange("last7d", { today: TODAY, locale: "en-US" }),
    formatDateRange("last7d", { today: TODAY, locale: "ja-JP" })
  )
  assert.equal(formatDateRange("nonsense", { today: TODAY, locale: "en-US" }), "")
})

// --- the component ---------------------------------------------------------

const show = (props, opts) => {
  const instance = render(DateRangePreset, props, opts)
  const read = () => {
    const nodes = walk(instance.tree)
    const radios = byRole(nodes, "radio")
    return {
      nodes,
      radios,
      labels: radios.map((r) => r.props.children),
      group: byRole(nodes, "radiogroup")[0],
      status: byRole(nodes, "status")[0],
      checked: radios.filter((r) => r.props["aria-checked"] === true),
      checkedIndex: radios.findIndex((r) => r.props["aria-checked"] === true),
      tabStops: radios.filter((r) => r.props.tabIndex === 0),
      focusedIndex: radios.findIndex((r) => r.props.tabIndex === 0),
      fields: nodes.filter((n) => n.type === DateInput),
      hidden: byTag(nodes, "input").find((n) => n.props.type === "hidden"),
    }
  }
  return {
    read,
    click(index) {
      read().radios[index].props.onClick()
      instance.rerender()
    },
    press(key) {
      let prevented = false
      read().group.props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    /** 0 = the "from" field, 1 = the "to" field. */
    type(which, value) {
      read().fields[which].props.onChange(value)
      instance.rerender()
    },
    update: (next) => instance.update(next),
  }
}

const LAST_30D = DEFAULT_PRESETS.findIndex((p) => p.id === "last30d")
const CUSTOM = DEFAULT_PRESETS.length

test("the row is a radio group: one tab stop, one checked option", () => {
  const ui = show({ value: "last7d", today: TODAY, onValueChange: () => {} }).read()
  assert.equal(ui.radios.length, DEFAULT_PRESETS.length + 1, "the presets plus Custom")
  assert.equal(ui.tabStops.length, 1, "nine tab stops is what a roving tabindex replaces")
  assert.equal(ui.checked.length, 1)
  assert.equal(ui.labels[ui.checkedIndex], "Last 7 days")
  assert.equal(ui.group.props["aria-label"], "Date range")
  assert.equal(
    ui.group.props["aria-describedby"],
    ui.status.props.id,
    "the group points at the line that says which dates it means"
  )
})

test("choosing a preset reports its id, not the dates it resolves to today", () => {
  let emitted = null
  const ui = show({ value: "last7d", today: TODAY, onValueChange: (v) => (emitted = v) })
  ui.click(LAST_30D)
  assert.equal(emitted, "last30d")
  assert.doesNotMatch(emitted, /\d{4}-\d{2}-\d{2}/, "a folded value is the bug this component exists to avoid")
})

test("arrow keys move the selection, wrap, and follow the writing direction", () => {
  // Every case starts from a fresh picker *and* a cleared record. Sharing one `emitted` across
  // presses is how a wrap assertion silently becomes vacuous: the variable still holds the value
  // the previous press put there, so a key that did nothing at all looks like it worked.
  const at = (value, opts) => {
    let emitted = null
    const ui = show({ value, today: TODAY, onValueChange: (v) => (emitted = v) }, opts)
    return { ui, press: (key) => ui.press(key), read: () => ({ ...ui.read(), emitted }) }
  }

  const right = at("today")
  assert.equal(right.press("ArrowRight"), true, "the key is handled, not left to the page")
  assert.equal(right.read().emitted, "yesterday", "a radio group selects as it moves")

  const left = at("yesterday")
  left.press("ArrowLeft")
  assert.equal(left.read().emitted, "today")

  // Off the front of the row wraps round to Custom at the back.
  const front = at("today")
  front.press("ArrowLeft")
  assert.equal(front.read().focusedIndex, CUSTOM, "focus wrapped to the last option")
  assert.equal(front.read().emitted, null, "Custom reports nothing until a range is typed")

  // ...and off the back wraps to the front.
  const back = at("2026-01-05..2026-01-19")
  back.press("ArrowRight")
  assert.equal(back.read().focusedIndex, 0)
  assert.equal(back.read().emitted, "today")

  const end = at("today")
  end.press("End")
  assert.equal(end.read().focusedIndex, CUSTOM)
  assert.equal(end.read().emitted, null)

  const home = at("ytd")
  home.press("Home")
  assert.equal(home.read().focusedIndex, 0)
  assert.equal(home.read().emitted, "today")

  // On an RTL page the option to the right of the focused one is the previous one.
  const rtl = at("yesterday", { direction: "rtl" })
  rtl.press("ArrowRight")
  assert.equal(rtl.read().emitted, "today", "right runs backwards on an RTL page")
})

test("ArrowDown and ArrowUp walk the row too, since it wraps onto several lines", () => {
  let emitted = null
  show({ value: "today", today: TODAY, onValueChange: (v) => (emitted = v) }).press("ArrowDown")
  assert.equal(emitted, "yesterday")
  show({ value: "yesterday", today: TODAY, onValueChange: (v) => (emitted = v) }).press("ArrowUp")
  assert.equal(emitted, "today")
})

test("a key the row does not own is left to the page", () => {
  const ui = show({ value: "today", today: TODAY, onValueChange: () => {} })
  assert.equal(ui.press("Tab"), false)
  assert.equal(ui.press("a"), false)
})

test("the summary line stays in the accessibility tree even with nothing to say", () => {
  // A live region has to exist before the text it will announce arrives. One that is rendered
  // along with its message — or given `hidden` when empty — is a region nobody was listening to,
  // which reads exactly like silence.
  for (const value of ["", "last7d"]) {
    const { status } = show({ value, today: TODAY, onValueChange: () => {} }).read()
    assert.ok(status, `the region is mounted for value "${value}"`)
    assert.equal(status.props["aria-live"], "polite")
    assert.equal(status.props.hidden, undefined, "hidden silences a live region")
    assert.equal(status.props["aria-hidden"], undefined, "aria-hidden silences it too")
  }
  const spoken = show({ value: "last7d", today: TODAY, onValueChange: () => {} }).read()
  assert.match(String(spoken.status.props.children), /Sep/)
  const silent = show({ value: "", today: TODAY, onValueChange: () => {} }).read()
  assert.equal(silent.status.props.children, "")
})

test("the custom fields appear only when custom is chosen", () => {
  const ui = show({ value: "last7d", today: TODAY, onValueChange: () => {} })
  assert.equal(ui.read().fields.length, 0)
  ui.click(CUSTOM)
  assert.equal(ui.read().fields.length, 2)
  assert.deepEqual(
    ui.read().fields.map((f) => f.props["aria-label"]),
    ["From", "To"]
  )
})

test("choosing custom reports nothing, and leaves the range in force", () => {
  let emitted = null
  const ui = show({ value: "last7d", today: TODAY, onValueChange: (v) => (emitted = v) })
  ui.click(CUSTOM)
  assert.equal(emitted, null, "blanking the dashboard behind the picker is not an edit")
  assert.equal(ui.read().hidden, undefined)
  assert.equal(ui.read().checkedIndex, CUSTOM, "but the row shows where the user is")
})

test("the custom fields open on the range being looked at, not on two empty boxes", () => {
  const ui = show({ value: "last7d", today: TODAY, onValueChange: () => {} })
  ui.click(CUSTOM)
  assert.deepEqual(
    ui.read().fields.map((f) => f.props.value),
    ["2026-09-17", "2026-09-23"],
    "seeded with the last *included* day, not the excluded end"
  )
})

test("a half-typed custom range is never reported", () => {
  let emitted = null
  const ui = show({ value: "last7d", today: TODAY, onValueChange: (v) => (emitted = v) })
  ui.click(CUSTOM)
  ui.type(0, "")
  ui.type(1, "")
  assert.equal(emitted, null)
  ui.type(0, "2026-03-01")
  assert.equal(emitted, null, "one date is not a range")
  ui.type(1, "2026-03-31")
  assert.equal(emitted, "2026-03-01..2026-03-31")
})

test("a backwards range is refused, and said out loud", () => {
  let emitted = null
  const ui = show({ value: "last7d", today: TODAY, onValueChange: (v) => (emitted = v) })
  ui.click(CUSTOM)
  // The fields open seeded, so editing one of them is already a complete range and is reported.
  ui.type(0, "2026-03-31")
  assert.equal(emitted, "2026-03-31..2026-09-23")
  // Now push the end in front of the start.
  ui.type(1, "2026-03-01")
  assert.equal(emitted, "2026-03-31..2026-09-23", "the backwards pair is not reported")
  assert.equal(ui.read().status.props.children, "The end date is before the start date.")
  // Correcting it recovers without the other field having to be re-entered.
  ui.type(1, "2026-04-02")
  assert.equal(emitted, "2026-03-31..2026-04-02")
})

test("a custom value arriving from outside opens the fields already filled", () => {
  const ui = show({
    value: "2026-01-05..2026-01-19",
    today: TODAY,
    onValueChange: () => {},
  })
  assert.equal(ui.read().checkedIndex, CUSTOM)
  assert.deepEqual(
    ui.read().fields.map((f) => f.props.value),
    ["2026-01-05", "2026-01-19"]
  )
  assert.match(String(ui.read().status.props.children), /Jan/)
})

test("a preset set from outside closes the custom fields", () => {
  const ui = show({ value: "last7d", today: TODAY, onValueChange: () => {} })
  ui.click(CUSTOM)
  assert.equal(ui.read().fields.length, 2)
  // The bug this guards: customOpened is local state, so a parent resetting the range to a preset
  // would leave the fields pinned open under a row that says "Last 30 days".
  ui.update({ value: "last30d", today: TODAY, onValueChange: () => {} })
  assert.equal(ui.read().fields.length, 0)
  assert.equal(ui.read().labels[ui.read().checkedIndex], "Last 30 days")
})

test("an uncontrolled picker keeps its own value", () => {
  const ui = show({ defaultValue: "today", today: TODAY })
  assert.equal(ui.read().labels[ui.read().checkedIndex], "Today")
  ui.click(LAST_30D)
  assert.equal(ui.read().labels[ui.read().checkedIndex], "Last 30 days")
})

test("a value nobody recognises checks nothing rather than guessing", () => {
  const ui = show({ value: "last3000d", today: TODAY, onValueChange: () => {} }).read()
  assert.equal(ui.checked.length, 0)
  assert.equal(ui.tabStops.length, 1, "the row is still reachable by keyboard")
  assert.equal(ui.status.props.children, "")
})

test("the bounds, locale and disabled state reach both date fields", () => {
  const ui = show({
    value: "2026-01-05..2026-01-19",
    today: TODAY,
    min: "2026-01-01",
    max: "2026-12-31",
    locale: "ja-JP",
    disabled: true,
    onValueChange: () => {},
  })
  for (const field of ui.read().fields) {
    assert.equal(field.props.min, "2026-01-01")
    assert.equal(field.props.max, "2026-12-31")
    assert.equal(field.props.locale, "ja-JP")
    assert.equal(field.props.disabled, true)
  }
  assert.ok(
    ui.read().radios.every((r) => r.props.disabled === true),
    "a disabled picker disables the row too"
  )
})

test("the value posts with a form when it is named", () => {
  const named = show({ value: "last7d", today: TODAY, name: "period", onValueChange: () => {} })
  assert.equal(named.read().hidden.props.name, "period")
  assert.equal(named.read().hidden.props.value, "last7d", "the expression posts, not the dates")
  const unnamed = show({ value: "last7d", today: TODAY, onValueChange: () => {} })
  assert.equal(unnamed.read().hidden, undefined)
})

test("allowCustom drops the custom option entirely", () => {
  const ui = show({ value: "last7d", today: TODAY, allowCustom: false, onValueChange: () => {} })
  assert.equal(ui.read().radios.length, DEFAULT_PRESETS.length)
  assert.ok(!ui.read().labels.includes("Custom"))
  ui.press("End")
  assert.equal(ui.read().labels[ui.read().focusedIndex], "Year to date", "End stops at the last preset")
})

test("the labels and messages are all replaceable", () => {
  const ui = show({
    value: "last7d",
    today: TODAY,
    label: "期間",
    customLabel: "指定",
    fromLabel: "開始",
    toLabel: "終了",
    onValueChange: () => {},
  })
  assert.equal(ui.read().group.props["aria-label"], "期間")
  assert.equal(ui.read().labels[CUSTOM], "指定")
  ui.click(CUSTOM)
  assert.deepEqual(
    ui.read().fields.map((f) => f.props["aria-label"]),
    ["開始", "終了"]
  )
})
