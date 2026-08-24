// weekly-hours edits a week of opening times, and everything worth testing here is a rule that a
// person reading the source in one locale, with a mouse, on a shop that closes before midnight,
// will never see fail:
//
// The order of the rows is data, not layout. en-US starts the week on Sunday, de-DE on Monday and
// ar-EG on Saturday, and a hardcoded order silently reorders someone else's week.
//
// A closed day and a day open around the clock are the two values most likely to be collapsed into
// one. `null` is closed; equal opening and closing times are the whole day; and `00:00`–`00:00` is
// the second of those, never the first.
//
// A closing time earlier than the opening time is the night shift, not a typo — the rule that keeps
// bars and 24-hour support windows expressible in a single row.
//
// And the failure this registry has already shipped once: a field whose on-screen state is richer
// than the value it emits loses every keystroke but the last as soon as a controlled parent stores
// what it hands back. The half-typed round trip below is that bug, aimed at this component.
//
// The time fields are stubbed. They have their own 18 tests; what matters here is the contract
// between the two — which value, which accessible name, which locale reaches each of the fourteen.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Stands in for the real time field: keeps its props visible and renders nothing. */
const TimeInput = () => null

const { WeeklyHours, readDaySpan, incompleteDays } = loadComponent(
  join(ROOT, "registry", "ui", "weekly-hours.tsx"),
  { stubs: { "@/registry/ui/time-input": { TimeInput } } }
)

const MON_TO_FRI = {
  mon: { open: "09:00", close: "17:00" },
  tue: { open: "09:00", close: "17:00" },
  wed: { open: "09:00", close: "17:00" },
  thu: { open: "09:00", close: "17:00" },
  fri: { open: "09:00", close: "17:00" },
}

function readRow(row) {
  const nodes = walk(row)
  const withId = (suffix) =>
    nodes.find((n) => typeof n.props?.id === "string" && n.props.id.endsWith(suffix))
  const times = nodes.filter((n) => n.type === TimeInput)
  const hint = withId("-hint")
  return {
    day: withId("-label").props.children,
    checkbox: byTag(nodes, "input").find((n) => n.props.type === "checkbox"),
    checked: byTag(nodes, "input").find((n) => n.props.type === "checkbox").props.checked,
    /** null when the row is closed and shows no fields at all. */
    open: times.length === 0 ? null : times[0].props.value,
    close: times.length === 0 ? null : times[1].props.value,
    labels: times.map((t) => t.props["aria-label"]),
    times,
    apply: byTag(nodes, "button")[0],
    hint: hint === undefined ? "" : hint.props.children,
    hintClass: hint === undefined ? "" : hint.props.className,
    describedBy: row.props["aria-describedby"],
  }
}

/** Renders uncontrolled and hands back the rows plus every value that was emitted. */
function show(props) {
  const emitted = []
  const instance = render(WeeklyHours, { ...props, onChange: (v) => emitted.push(v) })
  const read = () => {
    const nodes = walk(instance.tree)
    // The first group is the editor; the seven after it are the days, in reading order.
    const rows = byRole(nodes, "group").slice(1).map(readRow)
    return {
      rows,
      order: rows.map((r) => r.day),
      row: (day) => rows.find((r) => r.day === day),
      hidden: byTag(nodes, "input").find((n) => n.props.type === "hidden"),
    }
  }
  return {
    read,
    emitted,
    toggle(day, checked) {
      read().row(day).checkbox.props.onChange({ target: { checked } })
      instance.rerender()
    },
    type(day, side, value) {
      read().row(day).times[side === "open" ? 0 : 1].props.onChange(value)
      instance.rerender()
    },
    applyToAll(day) {
      read().row(day).apply.props.onClick()
      instance.rerender()
    },
  }
}

/**
 * Renders controlled, with a parent that stores whatever it is handed — the arrangement that turns
 * "the value is less expressive than the screen" into lost keystrokes.
 */
function controlled(initial, props = {}) {
  let stored = initial
  const emitted = []
  const onChange = (v) => {
    stored = v
    emitted.push(v)
  }
  const instance = render(WeeklyHours, { ...props, value: stored, onChange })
  const sync = () => instance.update({ ...props, value: stored, onChange })
  const read = () => byRole(walk(instance.tree), "group").slice(1).map(readRow)
  return {
    read,
    emitted,
    get stored() {
      return stored
    },
    type(day, side, value) {
      const row = read().find((r) => r.day === day)
      row.times[side === "open" ? 0 : 1].props.onChange(value)
      sync()
    },
  }
}

// --- the week is ordered by data ------------------------------------------

test("the week starts where the locale starts it", () => {
  assert.equal(show({ locale: "en-US" }).read().order[0], "Sunday")
  assert.equal(show({ locale: "de-DE" }).read().order[0], "Montag")
  // Saturday-first, and the row after it is Sunday — the whole week rotates, it is not reversed.
  const eg = show({ locale: "ar-EG" }).read().order
  const names = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"]
  assert.deepEqual(eg, [names[6], ...names.slice(0, 6)])
})

test("every locale still shows seven distinct days", () => {
  for (const locale of ["en-US", "de-DE", "ja-JP", "ar-EG", "he-IL", "pt-BR"]) {
    const order = show({ locale }).read().order
    assert.equal(order.length, 7)
    assert.equal(new Set(order).size, 7)
  }
})

test("weekStartsOn overrides the locale", () => {
  assert.equal(show({ locale: "en-US", weekStartsOn: "mon" }).read().order[0], "Monday")
  assert.equal(show({ locale: "de-DE", weekStartsOn: "sun" }).read().order[0], "Sonntag")
})

test("the day names do not move with the machine's time zone", () => {
  // The names are read off a date, and a date read in a zone west of UTC is the day before. This one
  // runs in a child process because the parent's TZ is fixed before it starts — setting process.env.TZ
  // here would only overwrite whatever TZ the suite was deliberately given from outside, which is how
  // a check like this ends up passing everywhere and proving nothing.
  const script = `
    import { loadComponent, render, walk, byRole } from ${JSON.stringify(join(ROOT, "test", "_react-harness.mjs"))}
    const { WeeklyHours } = loadComponent(${JSON.stringify(join(ROOT, "registry", "ui", "weekly-hours.tsx"))}, {
      stubs: { "@/registry/ui/time-input": { TimeInput: () => null } },
    })
    const tree = render(WeeklyHours, { locale: "en-US" }).tree
    const rows = byRole(walk(tree), "group").slice(1)
    const nameOf = (row) => walk(row).find((n) => String(n.props?.id ?? "").endsWith("-label")).props.children
    console.log(JSON.stringify(rows.map(nameOf)))
  `
  for (const TZ of ["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, TZ },
      encoding: "utf8",
    })
    assert.deepEqual(
      JSON.parse(out),
      ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
      `the week came out wrong under TZ=${TZ}`
    )
  }
})

test("an unusable locale tag falls back rather than rendering nothing", () => {
  // A malformed tag out of a user profile makes every Intl constructor throw. The week still has to
  // come out, so the fallbacks are ISO 8601's Monday and the English names.
  const view = show({ locale: "not a locale" })
  assert.equal(view.read().order[0], "Monday")
  assert.deepEqual(view.read().order, [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ])
})

test("day names are written the way the locale writes them", () => {
  assert.equal(show({ locale: "ja-JP" }).read().order[0], "日曜日")
  // And the name travels into what a screen reader is told, not just what is painted.
  const monday = show({ locale: "de-DE", defaultValue: MON_TO_FRI }).read().row("Montag")
  assert.equal(monday.checkbox.props["aria-label"], "Open on Montag")
  assert.deepEqual(monday.labels, ["Montag opening time", "Montag closing time"])
})

// --- closed is its own value ----------------------------------------------

test("a day left out of the value is closed, not open with empty fields", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "09:00", close: "17:00" } } })
  const sunday = view.read().row("Sunday")
  assert.equal(sunday.checked, false)
  assert.equal(sunday.open, null, "a closed day shows no time fields at all")
  assert.equal(sunday.hint, "")
})

test("switching a day off emits null, not midnight to midnight", () => {
  const view = show({ locale: "en-US", defaultValue: MON_TO_FRI })
  view.toggle("Monday", false)
  assert.equal(view.emitted.at(-1).mon, null)
  assert.equal(view.read().row("Monday").checked, false)
})

test("00:00 to 00:00 is a day open around the clock, and stays distinct from closed", () => {
  const view = show({
    locale: "en-US",
    defaultValue: { mon: { open: "00:00", close: "00:00" }, tue: null },
  })
  assert.equal(view.read().row("Monday").hint, "Open 24 hours")
  assert.equal(view.read().row("Monday").checked, true)
  assert.equal(view.read().row("Tuesday").checked, false)
  assert.deepEqual(readDaySpan({ open: "00:00", close: "00:00" }), { kind: "allDay", minutes: 1440 })
})

test("switching a day back on returns the hours that were typed, not the default", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "11:00", close: "23:00" } } })
  view.toggle("Monday", false)
  view.toggle("Monday", true)
  const monday = view.read().row("Monday")
  assert.equal(monday.open, "11:00")
  assert.equal(monday.close, "23:00")
})

test("a day switched on for the first time gets the default hours", () => {
  const view = show({ locale: "en-US" })
  view.toggle("Sunday", true)
  assert.deepEqual(view.emitted.at(-1).sun, { open: "09:00", close: "17:00" })
  const custom = show({ locale: "en-US", defaultDayHours: { open: "06:30", close: "14:00" } })
  custom.toggle("Sunday", true)
  assert.deepEqual(custom.emitted.at(-1).sun, { open: "06:30", close: "14:00" })
})

// --- the night shift is not an error --------------------------------------

test("a closing time before the opening time is the night, measured across midnight", () => {
  const view = show({ locale: "en-US", defaultValue: { fri: { open: "22:00", close: "02:00" } } })
  const friday = view.read().row("Friday")
  assert.equal(friday.hint, "4h, closes the next day")
  assert.doesNotMatch(friday.hintClass, /text-destructive/, "the night shift is not flagged as wrong")
  assert.deepEqual(readDaySpan({ open: "22:00", close: "02:00" }), { kind: "overnight", minutes: 240 })
})

test("an ordinary day is measured the plain way", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "09:15", close: "17:00" } } })
  assert.equal(view.read().row("Monday").hint, "7h 45m")
  assert.equal(
    show({ locale: "en-US", defaultValue: { mon: { open: "09:00", close: "09:30" } } })
      .read()
      .row("Monday").hint,
    "30m"
  )
})

test("only a half-filled day is called wrong", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "09:00", close: "" } } })
  const monday = view.read().row("Monday")
  assert.equal(monday.hint, "Needs an opening and a closing time")
  assert.match(monday.hintClass, /text-destructive/)
  assert.equal(monday.describedBy, monday.hint === "" ? undefined : monday.describedBy)
  assert.ok(monday.describedBy, "the reason is announced, not only painted")
  assert.deepEqual(incompleteDays({ mon: { open: "09:00", close: "" } }), ["mon"])
  // Closed days and night shifts are not incomplete.
  assert.deepEqual(incompleteDays({ sun: null, fri: { open: "22:00", close: "02:00" } }), [])
})

test("a day with nothing typed yet is not nagged at", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "", close: "" } } })
  assert.equal(view.read().row("Monday").hint, "")
  assert.equal(view.read().row("Monday").describedBy, undefined)
  assert.deepEqual(incompleteDays({ mon: { open: "", close: "" } }), [])
})

// --- what arrives from a server -------------------------------------------

test("times are accepted in the shapes stored data actually uses", () => {
  const view = show({
    locale: "en-US",
    defaultValue: {
      mon: { open: "9:00", close: "17:30:00" },
      // 24:00 is midnight at the end of the day, and throwing it away would lose the closing time.
      tue: { open: "09:00", close: "24:00" },
      wed: { open: "nonsense", close: "17:00" },
    },
  })
  const monday = view.read().row("Monday")
  assert.equal(monday.open, "09:00", "an unpadded hour is padded, not dropped")
  assert.equal(monday.close, "17:30", "seconds are dropped, the time is kept")
  assert.equal(view.read().row("Tuesday").hint, "15h, closes the next day")
  assert.equal(view.read().row("Wednesday").open, "", "unreadable text is emptied, not passed on")
  assert.equal(view.read().row("Wednesday").close, "17:00")
})

// --- the round trip that broke date-input ---------------------------------

test("a half-typed day survives a controlled parent that stores what it is handed", () => {
  const parent = controlled({ mon: { open: "", close: "" } }, { locale: "en-US" })
  // The time field emits "" until every segment is filled, so this is what a real parent stores.
  parent.type("Monday", "open", "")
  parent.type("Monday", "close", "17:00")
  assert.deepEqual(parent.stored.mon, { open: "", close: "17:00" })
  assert.equal(parent.read().find((r) => r.day === "Monday").close, "17:00")
  // Now the other side completes, and the side stored a moment ago is still there.
  parent.type("Monday", "open", "09:00")
  assert.deepEqual(parent.stored.mon, { open: "09:00", close: "17:00" })
  const monday = parent.read().find((r) => r.day === "Monday")
  assert.equal(monday.open, "09:00")
  assert.equal(monday.close, "17:00")
  assert.equal(monday.hint, "8h")
})

test("a controlled editor shows the parent's value, not a copy that drifted", () => {
  const instance = render(WeeklyHours, { locale: "en-US", value: { mon: { open: "09:00", close: "17:00" } } })
  const rowsOf = (tree) => byRole(walk(tree), "group").slice(1).map(readRow)
  assert.equal(rowsOf(instance.tree).find((r) => r.day === "Monday").open, "09:00")
  instance.update({ locale: "en-US", value: { mon: { open: "11:00", close: "19:00" } } })
  const monday = rowsOf(instance.tree).find((r) => r.day === "Monday")
  assert.equal(monday.open, "11:00")
  assert.equal(monday.hint, "8h")
})

// --- applying one day to the rest -----------------------------------------

test("apply to all copies the row to every day, closed ones included", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "10:00", close: "18:00" } } })
  view.applyToAll("Monday")
  const week = view.emitted.at(-1)
  for (const day of ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) {
    assert.deepEqual(week[day], { open: "10:00", close: "18:00" }, `${day} was not copied`)
  }
  // Each day gets its own object, so editing one afterwards does not move the other six.
  assert.notEqual(week.sun, week.mon)
})

test("apply to all is unavailable until the row it would copy is complete", () => {
  const view = show({ locale: "en-US", defaultValue: { mon: { open: "09:00", close: "" } } })
  assert.equal(view.read().row("Monday").apply.props.disabled, true)
  view.type("Monday", "close", "17:00")
  assert.equal(view.read().row("Monday").apply.props.disabled, false)
})

test("apply to all names the day it copies, after the words it shows", () => {
  const view = show({ locale: "en-US", defaultValue: MON_TO_FRI })
  const label = view.read().row("Monday").apply.props["aria-label"]
  assert.ok(label.startsWith("Apply to all"), "voice control matches the visible text first")
  assert.match(label, /Monday/)
})

// --- submitting with a plain form -----------------------------------------

test("the hidden input keeps closed days distinguishable from midnight ones", () => {
  const view = show({
    locale: "en-US",
    name: "hours",
    defaultValue: { mon: { open: "00:00", close: "00:00" }, tue: null },
  })
  const parsed = JSON.parse(view.read().hidden.props.value)
  assert.equal(parsed.tue, null)
  assert.deepEqual(parsed.mon, { open: "00:00", close: "00:00" })
  assert.equal(Object.keys(parsed).length, 7, "all seven days are submitted, not only the open ones")
})

test("no hidden input is rendered without a name", () => {
  assert.equal(show({ locale: "en-US", defaultValue: MON_TO_FRI }).read().hidden, undefined)
})

// --- the fields are handed the settings they need -------------------------

test("clock settings reach all fourteen fields", () => {
  const view = show({
    locale: "de-DE",
    hour12: false,
    minuteStep: 15,
    disabled: true,
    defaultValue: {
      sun: { open: "09:00", close: "17:00" },
      mon: { open: "09:00", close: "17:00" },
      tue: { open: "09:00", close: "17:00" },
      wed: { open: "09:00", close: "17:00" },
      thu: { open: "09:00", close: "17:00" },
      fri: { open: "09:00", close: "17:00" },
      sat: { open: "09:00", close: "17:00" },
    },
  })
  const fields = view.read().rows.flatMap((r) => r.times)
  assert.equal(fields.length, 14)
  for (const f of fields) {
    assert.equal(f.props.locale, "de-DE")
    assert.equal(f.props.hour12, false)
    assert.equal(f.props.minuteStep, 15)
    assert.equal(f.props.disabled, true)
  }
})
