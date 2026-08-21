// month-picker answers with a "YYYY-MM" string and is driven almost entirely by the keyboard, and
// both of those are places where a component can be wrong without looking wrong.
//
// The value side: a month is a calendar span, so the component never produces a Date and never
// reads UTC fields for a question about the local calendar. Get that backwards and a billing period
// silently starts on the last day of the previous month for every user west of UTC — which no
// amount of clicking around in one time zone will show you.
//
// The keyboard side: a month grid is a composite widget, so it owns one tab stop and moves focus
// itself. Twelve tab stops, an arrow that dead-ends in December, a Home key that lands somewhere
// different depending on the column count, or arrows that run backwards on an RTL page are all
// invisible to a reader of the source and to anyone testing with a mouse in English.
//
// These run against the real source through the harness, so they fail when the component changes
// rather than when a copy of it does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { MonthPicker, toMonthValue, parseMonthValue } = loadComponent(
  join(ROOT, "registry", "ui", "month-picker.tsx")
)

const show = (props, opts) => {
  const instance = render(MonthPicker, props, opts)
  const read = () => {
    const nodes = walk(instance.tree)
    const cells = byRole(nodes, "gridcell")
    return {
      nodes,
      cells,
      // The twelve month buttons. Filtering by aria-label would also catch the two year arrows.
      months: cells.map((cell) => cell.props.children),
      arrows: byTag(nodes, "button").filter((b) => /year$/.test(String(b.props["aria-label"]))),
      year: nodes.find((n) => n.props?.id === "harness-id").props.children,
      grid: byRole(nodes, "grid")[0],
      focused: cells.map((c) => c.props.children).findIndex((b) => b.props.tabIndex === 0),
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
    update: (next) => instance.update(next),
  }
}

test("the value is a calendar month, read from local fields and never from UTC", () => {
  // Both edges of a month, so whichever way the running zone is offset one of them crosses midnight
  // UTC and a UTC read comes back with the neighbouring month.
  for (const [year, monthIndex, day, hour] of [
    [2026, 7, 31, 23],
    [2026, 8, 1, 0],
  ]) {
    const at = new Date(year, monthIndex, day, hour, 30)
    const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`
    assert.equal(toMonthValue(at), local, `${at} should be ${local}, not the UTC month`)
  }
  assert.equal(toMonthValue(new Date(2026, 0, 5)), "2026-01", "the month is zero-padded")
})

test("parseMonthValue takes a bare month and nothing else", () => {
  assert.deepEqual(parseMonthValue("2026-08"), { year: 2026, month: 8 })
  for (const bad of ["2026-08-01", "2026-13", "2026-00", "2026-8", "26-08", "", "nope"]) {
    assert.equal(parseMonthValue(bad), null, `"${bad}" is not a month value`)
  }
})

test("the grid is a grid: twelve cells, one tab stop, and every cell named in full", () => {
  const { cells, months, nodes, grid } = show({ value: "2026-08", onValueChange: () => {} }).read()
  assert.equal(cells.length, 12)
  assert.equal(byRole(nodes, "row").length, 4, "three columns makes four rows")
  assert.equal(grid.props["aria-labelledby"], "harness-id", "the grid is named by the year caption")
  assert.equal(
    months.filter((b) => b.props.tabIndex === 0).length,
    1,
    "a roving tabindex leaves exactly one tab stop"
  )
  assert.equal(cells.filter((c) => c.props["aria-selected"]).length, 1)
  assert.equal(cells[7].props["aria-selected"], true)
  // "Aug" alone stops meaning anything once the year arrows have moved.
  assert.equal(months[7].props["aria-label"], "August 2026")
  assert.equal(months[7].props.children, "Aug")
  assert.ok(
    months.every((b) => b.props.type === "button"),
    "a cell inside a form must not submit it"
  )
  assert.ok(
    byTag(nodes, "svg").every((s) => String(s.props["aria-hidden"]) === "true"),
    "the arrow glyphs are decorative"
  )
})

test("the visible label is contained in the accessible name, in any locale", () => {
  // WCAG 2.5.3: someone saying "click Aug" has to reach the cell that reads Aug.
  for (const locale of ["en-US", "ja-JP", "de-DE"]) {
    const { months } = show({ defaultValue: "2026-08", locale }).read()
    for (const button of months) {
      assert.ok(
        button.props["aria-label"].includes(String(button.props.children)),
        `${locale}: "${button.props.children}" is not inside "${button.props["aria-label"]}"`
      )
    }
  }
})

test("month names come from the locale and do not slip a zone", () => {
  const { months } = show({ defaultValue: "2026-08", locale: "en-US" }).read()
  assert.deepEqual(
    months.map((b) => String(b.props.children)),
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    "the first of a month at 00:00 UTC is the previous month west of Greenwich"
  )
  const ja = show({ defaultValue: "2026-08", locale: "ja-JP" }).read()
  assert.equal(ja.months[7].props.children, "8月")
  assert.equal(ja.months[7].props["aria-label"], "2026年8月")
  const long = show({ defaultValue: "2026-08", monthFormat: "long" }).read()
  assert.equal(long.months[7].props.children, "August")
})

test("a year under 100 is not read as the nineteen-hundreds", () => {
  // Date.UTC(50, 0, 1) is 1950 — the two-digit-year rule reaches Date.UTC too.
  const { months } = show({ defaultValue: "0050-03", locale: "en-US" }).read()
  assert.equal(months[2].props["aria-label"], "March 50")
})

test("min and max stop the cells and the year arrows together", () => {
  const inside = show({ defaultValue: "2026-06", min: "2026-04", max: "2026-09" }).read()
  assert.deepEqual(
    inside.months.map((b, i) => (b.props["aria-disabled"] ? i : -1)).filter((i) => i >= 0),
    [0, 1, 2, 9, 10, 11]
  )
  assert.ok(
    inside.months.every((b) => !b.props.disabled),
    "aria-disabled, not disabled — a month the keyboard skips is a month nobody knows is there"
  )
  assert.deepEqual(
    inside.arrows.map((b) => b.props.disabled),
    [true, true],
    "a range inside one year has nowhere to go"
  )

  const open = show({ defaultValue: "2026-06", min: "2025-11" }).read()
  assert.deepEqual(open.arrows.map((b) => b.props.disabled), [false, false])
})

test("a disabled month cannot be chosen, an enabled one answers with YYYY-MM", () => {
  const picked = []
  const view = show({
    defaultValue: "2026-06",
    min: "2026-04",
    max: "2026-09",
    onValueChange: (v) => picked.push(v),
  })
  view.read().months[0].props.onClick()
  assert.deepEqual(picked, [], "January is outside the range")
  view.read().months[6].props.onClick()
  assert.deepEqual(picked, ["2026-07"])
})

test("the arrow keys walk the calendar, not just the twelve cells on screen", () => {
  const step = (from, keys) => {
    const view = show({ defaultValue: from })
    for (const key of keys) view.press(key)
    const { months, focused, year } = view.read()
    return { at: months[focused].props["aria-label"], year }
  }
  assert.equal(step("2026-08", ["ArrowRight"]).at, "September 2026")
  assert.equal(step("2026-02", ["ArrowDown"]).at, "May 2026", "down is one row of three")
  assert.equal(step("2026-08", ["Home"]).at, "January 2026", "rows are layout; Home means the year")
  assert.equal(step("2026-02", ["End"]).at, "December 2026")
  assert.deepEqual(step("2026-12", ["ArrowRight"]), { at: "January 2027", year: 2027 })
  assert.deepEqual(step("2026-01", ["ArrowLeft"]), { at: "December 2025", year: 2025 })
  assert.deepEqual(step("2026-08", ["PageUp", "PageUp"]), { at: "August 2024", year: 2024 })
  assert.equal(step("2026-08", ["PageDown"]).at, "August 2027")

  // Movement stops at the range rather than landing on something unpickable — at both ends, since
  // the two bounds are two separate lines of code and one of them is easy to leave out.
  for (const [key, expected] of [
    ["Home", "April 2026"],
    ["PageUp", "April 2026"],
    ["End", "September 2026"],
    ["PageDown", "September 2026"],
  ]) {
    const clamped = show({ defaultValue: "2026-06", min: "2026-04", max: "2026-09" })
    clamped.press(key)
    const { months, focused } = clamped.read()
    assert.equal(months[focused].props["aria-label"], expected, `${key} left the range`)
  }
})

test("arrow keys are taken from the page, other keys are left alone", () => {
  const view = show({ defaultValue: "2026-08" })
  assert.equal(view.press("ArrowRight"), true, "otherwise the page scrolls under the grid")
  assert.equal(view.press("a"), false)
})

test("left and right follow the writing direction", () => {
  const rtl = (key) => {
    const view = show({ defaultValue: "2026-08" }, { direction: "rtl" })
    view.press(key)
    const { months, focused } = view.read()
    return months[focused].props["aria-label"]
  }
  assert.equal(rtl("ArrowRight"), "July 2026", "the cell to the right is the earlier month")
  assert.equal(rtl("ArrowLeft"), "September 2026")
  const down = show({ defaultValue: "2026-02" }, { direction: "rtl" })
  down.press("ArrowDown")
  assert.equal(
    down.read().months[down.read().focused].props["aria-label"],
    "May 2026",
    "rows do not reverse"
  )
})

test("navigation cannot walk out of the range a YYYY-MM string can hold", () => {
  const emitted = []
  const view = show({ defaultValue: "0000-01", onValueChange: (v) => emitted.push(v) })
  view.press("ArrowLeft")
  assert.equal(view.read().year, 0, "there is no year -1 to show")
  for (const button of view.read().months) button.props.onClick()
  assert.equal(emitted.length, 12)
  for (const value of emitted) {
    assert.notEqual(parseMonthValue(value), null, `"${value}" is not a month value this can parse`)
  }
})

test("the columns prop reshapes the grid and the vertical arrows with it", () => {
  for (const columns of [2, 3, 4]) {
    const { nodes, cells } = show({ defaultValue: "2026-08", columns }).read()
    assert.equal(byRole(nodes, "row").length, 12 / columns)
    assert.equal(cells.length, 12, "no row is ever short")
  }
  const wide = show({ defaultValue: "2026-01", columns: 4 })
  wide.press("ArrowDown")
  assert.equal(wide.read().months[wide.read().focused].props["aria-label"], "May 2026")
})

test("a value set from outside pulls the grid to it, and nothing else does", () => {
  const view = show({ value: "2026-08", onValueChange: () => {} })
  assert.equal(view.read().year, 2026)

  view.update({ value: "2027-03", onValueChange: () => {} })
  const moved = view.read()
  assert.equal(moved.year, 2027, "otherwise the selection sits off screen with no hint")
  assert.equal(moved.cells.findIndex((c) => c.props["aria-selected"]), 2)
  assert.equal(moved.focused, 2, "the tab stop moves with the selection")

  // Navigating away is the user's decision; an unrelated re-render must not undo it.
  view.press("PageDown")
  assert.equal(view.read().year, 2028)
})

test("the current month is marked, once", () => {
  const now = new Date()
  const { months } = show({ defaultValue: toMonthValue(now) }).read()
  const current = months.filter((b) => b.props["aria-current"] === "date")
  assert.equal(current.length, 1)
  assert.ok(
    current[0].props["aria-label"].startsWith(
      new Intl.DateTimeFormat("en-US", { month: "long" }).format(now)
    )
  )
})

test("a name posts the value with a plain form", () => {
  const withName = byTag(walk(render(MonthPicker, { defaultValue: "2026-08", name: "period" }).tree), "input")
  assert.equal(withName.length, 1)
  assert.equal(withName[0].props.type, "hidden")
  assert.equal(withName[0].props.name, "period")
  assert.equal(withName[0].props.value, "2026-08")
  assert.equal(
    byTag(walk(render(MonthPicker, { defaultValue: "2026-08" }).tree), "input").length,
    0,
    "no stray input without a name"
  )
})
