// week-picker answers with an ISO week, and ISO weeks are the part of the calendar where being
// almost right is indistinguishable from being right for about fifty weeks a year.
//
// The value side: a week-year is not a calendar year. 2026-12-28 and 2027-01-03 are both
// 2026-W53, 2026 has fifty-three weeks and 2025 has fifty-two, and any implementation that walks
// weeks by adding to the week number breaks at exactly one week in each year — the week nobody
// clicks on while developing in February. The expectations below were measured against the
// definition (week 1 contains 4 January) rather than copied from an earlier implementation, and
// several of them are the dates the roadmap entry for this component got wrong the first time.
//
// The keyboard side: a week grid is a composite widget, so it owns one tab stop and moves focus
// itself. Fifty-three tab stops, an arrow that dead-ends in W52, a PageDown that lands on a W53
// that does not exist in the year it moved to, or arrows that run backwards on an RTL page are all
// invisible to a reader of the source and to anyone testing with a mouse in one locale.
//
// These run against the real source through the harness, so they fail when the component changes
// rather than when a copy of it does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { WeekPicker, toWeekValue, parseWeekValue, weekDates, weeksInWeekYear, shiftWeekValue } =
  loadComponent(join(ROOT, "registry", "ui", "week-picker.tsx"))

// The locale is pinned on every render here: once mounted the component falls through to the
// machine's own, and a test whose expectations depend on where it runs is not an assertion.
const show = (props, opts) => {
  const instance = render(WeekPicker, { locale: "en-US", ...props }, opts)
  const read = () => {
    const nodes = walk(instance.tree)
    const cells = byRole(nodes, "gridcell")
    const buttons = cells.map((cell) => cell.props.children)
    return {
      nodes,
      cells,
      buttons,
      // The week number is the first span inside each cell button.
      numbers: buttons.map((b) => b.props.children[0].props.children),
      dates: buttons.map((b) => b.props.children[1].props.children),
      labels: buttons.map((b) => b.props["aria-label"]),
      arrows: byTag(nodes, "button").filter((b) => /year$/.test(String(b.props["aria-label"]))),
      year: nodes.find((n) => n.props?.id === "harness-id").props.children,
      grid: byRole(nodes, "grid")[0],
      rows: byRole(nodes, "row"),
      focused: buttons.findIndex((b) => b.props.tabIndex === 0),
    }
  }
  return {
    read,
    press(key) {
      let prevented = false
      read().grid.props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    click(index) {
      read().buttons[index].props.onClick()
      instance.rerender()
    },
    update: (next) => instance.update({ locale: "en-US", ...next }),
  }
}

test("a week-year has 52 or 53 weeks, and the long ones are where implementations break", () => {
  // Measured from the definition, not recited: the long years in this span are the ones whose
  // week 1 Monday is 371 days after the previous year's.
  const long = []
  for (let year = 1990; year <= 2040; year++) {
    const weeks = weeksInWeekYear(year)
    assert.ok(weeks === 52 || weeks === 53, `${year} reported ${weeks} weeks`)
    if (weeks === 53) long.push(year)
  }
  assert.deepEqual(long, [1992, 1998, 2004, 2009, 2015, 2020, 2026, 2032, 2037])
})

test("the week-year is the year of the week's Thursday, not of its Monday", () => {
  // The four cases the roadmap entry fixed by calculation. The first one is the trap: a Monday in
  // December whose week stays in the old year, and a Sunday in January whose week does too.
  const cases = [
    [2026, 12, 28, "2026-W53"], // Monday
    [2027, 1, 3, "2026-W53"], // Sunday — the same week, a calendar year later
    [2027, 1, 4, "2027-W01"], // the Monday that finally starts the new week-year
    [2026, 1, 1, "2026-W01"], // a Thursday, so its week opens its own year
    [2024, 12, 30, "2025-W01"], // the other direction: December belonging to the next week-year
  ]
  for (const [year, month, day, expected] of cases) {
    assert.equal(toWeekValue(new Date(year, month - 1, day)), expected, `${year}-${month}-${day}`)
  }
})

test("the week is read from local fields, never from UTC", () => {
  // Whichever way the running zone is offset, one of these two crosses midnight UTC — and a UTC
  // read then reports the neighbouring week, which is how a timesheet gets filed against the wrong
  // period for everyone who submits it on a Sunday evening.
  for (const [year, month, day, hour] of [
    [2026, 2, 15, 23], // Sunday night: UTC may already be Monday, i.e. the next week
    [2026, 2, 9, 0], // Monday first thing: UTC may still be Sunday, i.e. the previous week
  ]) {
    const local = new Date(year, month - 1, day, hour, 30)
    assert.equal(
      toWeekValue(local),
      "2026-W07",
      `${local.toString()} is in the week that contains it locally`
    )
  }
})

test("parsing rejects the week-shaped strings that are not weeks", () => {
  assert.deepEqual(parseWeekValue("2026-W07"), { weekYear: 2026, week: 7 })
  assert.deepEqual(parseWeekValue("2026-W53"), { weekYear: 2026, week: 53 })
  for (const bad of [
    "2025-W53", // the one a regular expression cannot catch: 2025 has 52 weeks
    "2026-W54", // no year has one
    "2026-W00",
    "2026-W7", // unpadded, so it would not sort against the padded form
    "2026-W07-1", // an ISO week *date*, which names a day and is a different value
    "2026-02-09",
    "2026-W",
    "26-W07",
    "",
  ]) {
    assert.equal(parseWeekValue(bad), null, JSON.stringify(bad))
  }
})

test("a week resolves to seven inclusive calendar dates, which can straddle two years", () => {
  assert.deepEqual(weekDates("2026-W07"), { start: "2026-02-09", end: "2026-02-15" })
  // The shape to test any week-to-dates code against: one week, two calendar years.
  assert.deepEqual(weekDates("2026-W53"), { start: "2026-12-28", end: "2027-01-03" })
  assert.equal(weekDates("2025-W53"), null, "a week that does not exist has no dates")

  // Every week of a long year and the years either side of it, round-tripped. Both ends, because
  // an off-by-one on the end date is invisible at the start.
  for (const year of [2025, 2026, 2027]) {
    for (let week = 1; week <= weeksInWeekYear(year); week++) {
      const value = `${year}-W${String(week).padStart(2, "0")}`
      const { start, end } = weekDates(value)
      const [sy, sm, sd] = start.split("-").map(Number)
      const [ey, em, ed] = end.split("-").map(Number)
      assert.equal(toWeekValue(new Date(sy, sm - 1, sd)), value, `${value} start`)
      assert.equal(toWeekValue(new Date(ey, em - 1, ed)), value, `${value} end`)
      assert.equal(
        Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 864e5),
        6,
        `${value} spans seven days inclusive`
      )
    }
  }
})

test("shifting walks Mondays, so the year rolls over on its own", () => {
  assert.equal(shiftWeekValue("2026-W53", 1), "2027-W01")
  assert.equal(shiftWeekValue("2027-W01", -1), "2026-W53")
  assert.equal(shiftWeekValue("2025-W52", 1), "2026-W01")
  assert.equal(shiftWeekValue("2026-W01", -1), "2025-W52")
  // A year on from the first week of a long year is still inside it: 2026 has 53 weeks, so a
  // 52-week assumption answers 2027-W01 here and is a week early for the rest of the year.
  assert.equal(shiftWeekValue("2026-W01", 52), "2026-W53")
  assert.equal(shiftWeekValue("2026-W01", 53), "2027-W01")
  assert.equal(shiftWeekValue("not a week", 1), null)
  assert.equal(shiftWeekValue("0001-W01", -1), null, "a step out of range answers null")
})

test("the grid renders every week of the displayed year and no phantom cells", () => {
  assert.equal(show({ defaultValue: "2026-W07" }).read().numbers.length, 53)
  assert.equal(show({ defaultValue: "2025-W07" }).read().numbers.length, 52)

  // 53 does not divide by any allowed column count, so the last row is short. Padding it out with
  // empty cells would put unlabelled buttons in the grid and in the tab order.
  const view = show({ defaultValue: "2026-W07", columns: 4 })
  const { rows, numbers } = view.read()
  assert.equal(rows.length, 14)
  assert.equal(rows[rows.length - 1].props.children.length, 1, "the short row has one real cell")
  assert.deepEqual(numbers.slice(0, 3), [1, 2, 3])
  assert.equal(numbers[numbers.length - 1], 53)
})

test("the whole grid is one tab stop", () => {
  const { buttons } = show({ defaultValue: "2026-W07" }).read()
  const stops = buttons.filter((b) => b.props.tabIndex === 0)
  assert.equal(stops.length, 1)
  assert.equal(stops[0].props.children[0].props.children, 7, "and it starts on the selection")
})

test("the arrow keys cross the week-year boundary instead of dead-ending", () => {
  const view = show({ defaultValue: "2026-W53" })
  assert.equal(view.read().year, 2026)
  assert.ok(view.press("ArrowRight"), "the grid handles the key rather than letting it scroll")
  assert.equal(view.read().year, 2027, "past the last week is the next year")
  assert.equal(view.read().focused, 0)

  assert.ok(view.press("ArrowLeft"))
  assert.equal(view.read().year, 2026)
  // Back onto W53 specifically — the week a (year, week + 1) implementation cannot produce.
  assert.equal(view.read().focused, 52)
  assert.equal(view.read().numbers[52], 53)
})

test("PageDown holds the week number and clamps where the next year is shorter", () => {
  // 2026 has 53 weeks and 2027 has 52, so W53 has nowhere to land and must not try.
  const view = show({ defaultValue: "2026-W53" })
  view.press("PageDown")
  assert.equal(view.read().year, 2027)
  assert.equal(view.read().numbers[view.read().focused], 52, "clamped to the last week that exists")

  // The ordinary case keeps the number.
  const mid = show({ defaultValue: "2026-W07" })
  mid.press("PageDown")
  assert.equal(mid.read().year, 2027)
  assert.equal(mid.read().numbers[mid.read().focused], 7)
})

test("Home and End go to the ends of the year, not of the row", () => {
  const view = show({ defaultValue: "2026-W20", columns: 6 })
  view.press("Home")
  assert.equal(view.read().focused, 0)
  view.press("End")
  assert.equal(view.read().focused, 52)
  assert.equal(view.read().year, 2026, "neither moves the year")
})

test("up and down move a row, following the column count", () => {
  const view = show({ defaultValue: "2026-W10", columns: 6 })
  view.press("ArrowDown")
  assert.equal(view.read().numbers[view.read().focused], 16)
  view.press("ArrowUp")
  assert.equal(view.read().numbers[view.read().focused], 10)
})

test("on an RTL page the arrows follow the writing direction", () => {
  const ltr = show({ defaultValue: "2026-W10" })
  ltr.press("ArrowRight")
  assert.equal(ltr.read().numbers[ltr.read().focused], 11)

  const rtl = show({ defaultValue: "2026-W10" }, { direction: "rtl" })
  rtl.press("ArrowRight")
  assert.equal(rtl.read().numbers[rtl.read().focused], 9, "right is the earlier week")
})

test("min and max stop the cells and the year arrows together", () => {
  const view = show({ defaultValue: "2026-W07", min: "2026-W05", max: "2026-W09" })
  const { buttons, arrows } = view.read()
  assert.equal(buttons[3].props["aria-disabled"], true, "W04 is before min")
  assert.equal(buttons[4].props["aria-disabled"], undefined, "W05 is the first allowed")
  assert.equal(buttons[8].props["aria-disabled"], undefined, "W09 is the last allowed")
  assert.equal(buttons[9].props["aria-disabled"], true)
  assert.ok(arrows.every((a) => a.props.disabled === true), "no year holds anything selectable")

  // An out-of-range week is reachable and readable, and clicking it changes nothing.
  let changed = null
  const guarded = show({
    defaultValue: "2026-W07",
    max: "2026-W09",
    onValueChange: (next) => (changed = next),
  })
  assert.equal(guarded.read().buttons[9].props.disabled, undefined, "not the disabled attribute")
  guarded.click(9)
  assert.equal(changed, null)

  // A bound that is not a week at all is no bound, rather than a silent lock-out.
  const bogus = show({ defaultValue: "2026-W07", min: "2025-W53" })
  assert.ok(bogus.read().buttons.every((b) => b.props["aria-disabled"] === undefined))
})

test("scattered holes disable cells without locking the year arrows", () => {
  const view = show({
    defaultValue: "2026-W07",
    isWeekDisabled: (value) => value === "2026-W03",
  })
  const { buttons, arrows } = view.read()
  assert.equal(buttons[2].props["aria-disabled"], true)
  assert.equal(buttons[3].props["aria-disabled"], undefined)
  assert.ok(arrows.every((a) => a.props.disabled === false), "a year of holes is still worth seeing")
})

test("selecting reports the value and marks the cell", () => {
  let reported = null
  const view = show({ defaultValue: "2026-W07", onValueChange: (next) => (reported = next) })
  view.click(19)
  assert.equal(reported, "2026-W20")
  assert.equal(view.read().cells[19].props["aria-selected"], true)
  assert.equal(
    view.read().cells.filter((c) => c.props["aria-selected"] === true).length,
    1,
    "and only that one"
  )
})

test("a value set from outside pulls the grid to its year", () => {
  const view = show({ defaultValue: "2026-W07" })
  assert.equal(view.read().year, 2026)
  view.update({ value: "2024-W31" })
  assert.equal(view.read().year, 2024, "the selection is never left off screen")
  assert.equal(view.read().numbers[view.read().focused], 31)
})

test("each cell is named with the week and its dates, in the value's own calendar", () => {
  const { labels } = show({ defaultValue: "2026-W07" }).read()
  // Matched rather than compared: ICU puts thin spaces (U+2009) around the dash in a formatted
  // range, and pinning that byte would make this test fail on an ICU upgrade that changed nothing
  // anybody can see. Everything the reader depends on is still pinned.
  assert.match(labels[6], /^week 7, Feb 9\s*–\s*15, 2026$/)
  // The year in the name has to be the week-year the form will post.
  assert.match(labels[52], /53/)
  assert.match(labels[52], /2026/)

  // A locale that already carries a -u- extension is the case that breaks naive tag building:
  // appending "-u-ca-gregory" to it produces an invalid tag and throws.
  //
  // The absence of an era year is *not* enough to assert here, and the first version of this test
  // was wrong for that reason: swapping the implementation for the naive concatenation left it
  // green, because the throw is caught and the component falls back to the machine's own locale —
  // which on this machine is English and has no era year either. What separates "pinned the
  // calendar" from "quietly gave up on the locale" is that the language survives, so that is what
  // is asserted.
  const japanese = show({ defaultValue: "2026-W07", locale: "ja-JP-u-ca-japanese" }).read()
  assert.match(japanese.labels[6], /2026/, "the Gregorian week-year, not an era year")
  assert.doesNotMatch(japanese.labels[6], /令和|8年2月/)
  assert.match(japanese.labels[6], /週/, "still Japanese — the calendar changed, not the language")
  assert.match(japanese.labels[6], /2026\/02\/09/)

  // Thai would otherwise print the Buddhist year beside a value that says 2026.
  const thai = show({ defaultValue: "2026-W07", locale: "th-TH" }).read()
  assert.match(thai.labels[6], /2026/)
  assert.doesNotMatch(thai.labels[6], /2569/)

  // Persian is the one where even the day and the month come out different without the pin.
  const persian = show({ defaultValue: "2026-W07", locale: "fa-IR" }).read()
  assert.match(persian.labels[6], /2026/)

  // A malformed locale falls back instead of taking the page down.
  assert.doesNotThrow(() => show({ defaultValue: "2026-W07", locale: "not a locale" }).read())
})

test("the word for the week is the reader's, not English", () => {
  const german = show({ defaultValue: "2026-W07", locale: "de-DE" }).read()
  assert.match(german.labels[6], /Woche/)
  const japanese = show({ defaultValue: "2026-W07", locale: "ja-JP" }).read()
  assert.match(japanese.labels[6], /週/)
})

test("the label can be written by the caller", () => {
  const view = show({
    defaultValue: "2026-W53",
    formatWeekLabel: ({ value, start, end }) => `${value} (${start} to ${end})`,
  })
  assert.equal(view.read().labels[52], "2026-W53 (2026-12-28 to 2027-01-03)")
})

test("the date under each number is hidden from the reading order", () => {
  const { buttons, dates } = show({ defaultValue: "2026-W07" }).read()
  assert.equal(dates[6], "Feb 9", "the week's Monday, so a bare number means something")
  assert.equal(buttons[6].props.children[1].props["aria-hidden"], "true")
})

test("the current week is marked, once", () => {
  const now = new Date()
  const value = toWeekValue(now)
  const { buttons } = show({ defaultValue: value }).read()
  const current = buttons.filter((b) => b.props["aria-current"] === "date")
  assert.equal(current.length, 1)
  assert.equal(current[0].props.children[0].props.children, parseWeekValue(value).week)
})

test("a name posts the value with a plain form", () => {
  const withName = byTag(
    walk(render(WeekPicker, { locale: "en-US", defaultValue: "2026-W07", name: "period" }).tree),
    "input"
  )
  assert.equal(withName.length, 1)
  assert.equal(withName[0].props.type, "hidden")
  assert.equal(withName[0].props.name, "period")
  assert.equal(withName[0].props.value, "2026-W07")
  assert.equal(
    byTag(walk(render(WeekPicker, { locale: "en-US", defaultValue: "2026-W07" }).tree), "input")
      .length,
    0,
    "no stray input without a name"
  )
})

test("a controlled year is not moved behind the caller's back", () => {
  const moves = []
  const view = show({
    value: "2026-W07",
    weekYear: 2026,
    onWeekYearChange: (year) => moves.push(year),
  })
  view.press("End")
  view.press("ArrowRight")
  assert.deepEqual(moves, [2027], "it asks, once")
  assert.equal(view.read().year, 2026, "and waits to be told")
})

test("an unparseable value leaves the grid usable", () => {
  // A caller can hand this anything — an empty form field, a half-typed box, last year's "W53".
  for (const value of ["", "2025-W53", "nonsense"]) {
    const view = show({ defaultValue: value })
    const { buttons, cells } = view.read()
    assert.ok(buttons.length >= 52, JSON.stringify(value))
    assert.equal(
      buttons.filter((b) => b.props.tabIndex === 0).length,
      1,
      `${JSON.stringify(value)} still leaves a tab stop`
    )
    assert.equal(cells.filter((c) => c.props["aria-selected"] === true).length, 0)
  }
})
