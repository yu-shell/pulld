// A slot picker is a list of buttons until two things happen to it, and both of them happen every
// day: the times belong to a zone that is not necessarily the reader's, and the availability they
// describe goes stale while it is being read. The cases below are each written against a version
// that got one of these wrong:
//
//   - grouping the slots by their UTC date, so a 23:30 UTC slot is filed under yesterday for every
//     reader east of the meridian,
//   - building the day key with the caller's own locale, where th-TH answers 2569 for the year and
//     fa-IR answers a different day of a different month,
//   - letting an offset-less timestamp be read in the machine's zone, so the same page shows
//     different times to the server that rendered it and the browser that got it,
//   - reading a date-only string as UTC midnight, which `Date.parse` does and which puts the whole
//     day on the wrong side of the line,
//   - showing the two 1:30s of a clock-back morning as the same "1:30 AM",
//   - showing a start time alone on a day that mixes half hours with hours, so two different slots
//     read identically,
//   - filing a slot that ends at midnight under the next day,
//   - rendering a day with nothing free as a silent blank, instead of saying which of the four
//     reasons it is,
//   - keeping a tick on a slot somebody else has taken since the page loaded, and posting it,
//   - telling the caller about a lost selection once per render rather than once per loss,
//   - taking `disabled` to mean the slot should leave the list, so nobody can find out 9:00 existed,
//   - and giving every slot its own tab stop, which is forty presses of Tab to get past a week.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  TimeSlotPicker,
  resolveTimeSlots,
  slotIssues,
  reconcileSlotSelection,
  toggleSlotSelection,
  nextAvailableSlot,
  nextSlotFocus,
  defaultTimeSlotPickerLabels,
} = loadComponent(join(ROOT, "registry", "ui", "time-slot-picker.tsx"))

const TOKYO = "Asia/Tokyo"
const NY = "America/New_York"

/** Half-hour slots from an instant, so a case says what it is about and nothing else. */
const every30 = (startIso, count) =>
  Array.from({ length: count }, (_, i) => ({
    start: new Date(Date.parse(startIso) + i * 30 * 60_000).toISOString(),
    durationMinutes: 30,
  }))

const resolve = (slots, options = {}) =>
  resolveTimeSlots({ slots, timeZone: TOKYO, locale: "en-US", ...options })

const options = (tree) => byRole(walk(tree), "option")
const statuses = (tree) => byRole(walk(tree), "status")
const text = (node) => {
  const out = []
  const visit = (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return
    if (Array.isArray(child)) return child.forEach(visit)
    if (typeof child === "object") return visit(child.props?.children)
    out.push(String(child))
  }
  visit(node?.props?.children)
  return out.join(" ")
}

// ── the zone ────────────────────────────────────────────────────────────────────────────────────

test("a slot's day is the day it falls on where the times are shown, not in UTC", () => {
  const slots = [{ start: "2026-11-20T23:30:00Z", durationMinutes: 30 }]
  assert.deepEqual(
    resolve(slots).days.map((day) => day.key),
    ["2026-11-21"],
    "23:30 UTC is half past eight the next morning in Tokyo"
  )
  assert.deepEqual(
    resolve(slots, { timeZone: "UTC" }).days.map((day) => day.key),
    ["2026-11-20"]
  )
})

test("the day key is ISO whatever calendar the locale counts in", () => {
  const slots = [{ start: "2026-11-20T01:00:00Z", durationMinutes: 30 }]
  // th-TH is the Buddhist year 2569, ja-JP-u-ca-japanese is Reiwa 8, ar-EG writes Arabic-Indic
  // digits, and fa-IR's Persian calendar puts this instant on 1405-08-29 — a different day of a
  // different month. All four have to come out of here as the same key.
  for (const locale of ["en-US", "th-TH", "ja-JP-u-ca-japanese", "ar-EG", "fa-IR"]) {
    assert.deepEqual(
      resolve(slots, { locale }).days.map((day) => day.key),
      ["2026-11-20"],
      `day key under ${locale}`
    )
  }
  // The heading is still the reader's own calendar — only the key is fixed.
  assert.match(resolve(slots, { locale: "th-TH" }).days[0].label, /2569/)
})

test("a timestamp with no offset is read where the times are shown, never on the machine", () => {
  // This process runs in Asia/Tokyo, which is what makes the New York answer worth asserting: read
  // as machine-local it would be 00:00Z, and read in the display zone it is 14:00Z.
  const ny = resolve([{ start: "2026-11-20T09:00", durationMinutes: 30 }], { timeZone: NY })
  assert.equal(new Date(ny.days[0].slots[0].start).toISOString(), "2026-11-20T14:00:00.000Z")
  const tokyo = resolve([{ start: "2026-11-20T09:00", durationMinutes: 30 }])
  assert.equal(new Date(tokyo.days[0].slots[0].start).toISOString(), "2026-11-20T00:00:00.000Z")
})

test("a date on its own is midnight where the times are shown, not UTC midnight", () => {
  // `Date.parse` has two rules in one spec: a date-time without an offset is local, a date alone is
  // UTC. Neither is what a slot list means, so both go through the display zone.
  const resolved = resolve([{ start: "2026-11-20", durationMinutes: 30 }])
  assert.equal(new Date(resolved.days[0].slots[0].start).toISOString(), "2026-11-19T15:00:00.000Z")
  assert.equal(Date.parse("2026-11-20"), Date.UTC(2026, 10, 20), "the rule being avoided")
})

test("an offset-less timestamp is reported rather than relied on", () => {
  const issues = slotIssues([{ start: "2026-11-20T09:00" }], { timeZone: NY })
  assert.deepEqual(issues.map((issue) => issue.kind), ["no-offset"])
  assert.match(issues[0].message, /America\/New_York/)
  assert.deepEqual(slotIssues([{ start: "2026-11-20T09:00:00Z" }], { timeZone: NY }), [])
})

test("an unusable zone falls back instead of taking the page down", () => {
  // `Intl.DateTimeFormat` throws a RangeError on an unknown zone, and a typo in a prop should not be
  // the end of the render.
  const resolved = resolve([{ start: "2026-11-20T01:00:00Z" }], { timeZone: "Mars/Olympus" })
  assert.equal(resolved.timeZone, new Intl.DateTimeFormat().resolvedOptions().timeZone)
})

test("the zone is stated in words and in full", () => {
  const resolved = resolve([{ start: "2026-11-20T01:00:00Z" }])
  assert.equal(resolved.zoneName, "Japan Standard Time")
  assert.equal(
    defaultTimeSlotPickerLabels.timeZoneNote(resolved.zoneName, resolved.timeZone),
    "Times shown in Japan Standard Time (Asia/Tokyo)"
  )
})

// ── the morning the clocks go back ──────────────────────────────────────────────────────────────

test("the two 1:30s of a clock-back morning are told apart", () => {
  // Measured, not assumed: en-US formats both of these as "1:30 AM" in New York.
  const resolved = resolve(
    [
      { start: "2026-11-01T05:30:00Z", durationMinutes: 30 },
      { start: "2026-11-01T06:30:00Z", durationMinutes: 30 },
    ],
    { timeZone: NY }
  )
  const [first, second] = resolved.days[0].slots
  assert.equal(first.startLabel, second.startLabel, "the premise: they read alike")
  assert.deepEqual([first.zoneLabel, second.zoneLabel], ["EDT", "EST"])
  assert.notEqual(
    `${first.label} ${first.zoneLabel}`,
    `${second.label} ${second.zoneLabel}`,
    "so what is on screen differs"
  )
})

test("a slot whose label is already unique is not labelled with a zone", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 4))
  assert.deepEqual(resolved.days[0].slots.map((slot) => slot.zoneLabel), ["", "", "", ""])
})

test("a wall clock the zone skipped still resolves to one fixed instant", () => {
  // 02:30 on 2026-03-08 does not exist in New York. There is no right answer, so the requirement is
  // only that it is the same answer every time — a server and the browser it hydrates have to agree.
  const once = resolve([{ start: "2026-03-08T02:30" }], { timeZone: NY })
  const twice = resolve([{ start: "2026-03-08T02:30" }], { timeZone: NY })
  assert.equal(once.days[0].slots[0].start, twice.days[0].slots[0].start)
  assert.equal(once.order.length, 1)
})

// ── what a slot says ────────────────────────────────────────────────────────────────────────────

test("a day of one length shows start times; a day of two shows ranges", () => {
  const uniform = resolve(every30("2026-11-20T00:00:00Z", 3))
  assert.deepEqual(uniform.days[0].slots.map((slot) => slot.label), ["9:00 AM", "9:30 AM", "10:00 AM"])

  const mixed = resolve([
    { start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { start: "2026-11-20T01:00:00Z", durationMinutes: 60 },
  ])
  assert.deepEqual(mixed.days[0].slots.map((slot) => slot.label), [
    "9:00 AM – 9:30 AM",
    "10:00 AM – 11:00 AM",
  ])
})

test("the accessible name carries the range even when the slot shows only its start", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.deepEqual(options(tree).map((node) => node.props["aria-label"]), [
    "9:00 AM to 9:30 AM",
    "9:30 AM to 10:00 AM",
  ])
})

test("a slot that ends at midnight belongs to the day it started", () => {
  const resolved = resolve([
    { start: "2026-11-20T14:30:00Z", durationMinutes: 30 },
    { start: "2026-11-20T15:00:00Z", durationMinutes: 30 },
  ])
  const [lastOfDay, firstOfNext] = resolved.days[0].slots.concat(resolved.days[1].slots)
  assert.equal(lastOfDay.startLabel, "11:30 PM")
  assert.equal(lastOfDay.endsNextDay, false, "23:30–00:00 is the last half hour of this day")
  assert.deepEqual(resolved.days.map((day) => day.key), ["2026-11-20", "2026-11-21"])
  assert.equal(firstOfNext.startLabel, "12:00 AM")
})

test("a slot that runs past midnight says so", () => {
  const resolved = resolve([{ start: "2026-11-20T14:30:00Z", durationMinutes: 60 }])
  assert.equal(resolved.days[0].slots[0].endsNextDay, true)
  assert.equal(resolved.days[0].key, "2026-11-20", "and is still filed under the day it starts")
})

test("an end at or before the start is shown as a start time, and reported", () => {
  const resolved = resolve([{ start: "2026-11-20T01:00:00Z", end: "2026-11-20T00:30:00Z" }])
  const slot = resolved.days[0].slots[0]
  assert.equal(slot.end, null)
  assert.equal(slot.label, "10:00 AM", "not 10:00 AM – 9:30 AM")
  assert.deepEqual(
    slotIssues([{ start: "2026-11-20T01:00:00Z", end: "2026-11-20T00:30:00Z" }], { timeZone: TOKYO }).map(
      (issue) => issue.kind
    ),
    ["backwards"]
  )
})

// ── the four reasons a day has nothing ──────────────────────────────────────────────────────────

test("a day with nothing free says which of the four reasons it is", () => {
  const now = "2026-11-20T06:00:00Z"
  const resolved = resolve(
    [
      { start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
      { start: "2026-11-21T00:00:00Z", durationMinutes: 30, taken: true },
      { start: "2026-11-23T00:00:00Z", durationMinutes: 30 },
    ],
    { now, days: ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"] }
  )
  assert.deepEqual(
    resolved.days.map((day) => [day.key, day.state]),
    [
      ["2026-11-20", "past"],
      ["2026-11-21", "fullyBooked"],
      ["2026-11-22", "empty"],
      ["2026-11-23", "available"],
    ]
  )
  // The past day's slots are hidden, and that is exactly when the state has to survive: a day that
  // reports "empty" because its slots were filtered out is the silent blank this is here to avoid.
  assert.equal(resolved.days[0].slots.length, 0)
  assert.equal(resolved.days[0].offered, 1)
})

test("a day that is over says so, even if its times had also been booked", () => {
  // Written expecting "fullyBooked", because one of these was taken rather than merely missed. That
  // was the wrong way round: once every time on a day has been and gone, "fully booked" tells the
  // reader a cancellation might still free one, and nothing can. The day being over is the fact
  // that is true of all of them, so it is the one that gets said.
  const over = resolve(
    [
      { start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
      { start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
    ],
    { now: "2026-11-20T06:00:00Z" }
  )
  assert.equal(over.days[0].state, "past")

  // "fullyBooked" is for a day that still has time left on it and nothing free in that time, which
  // is the case where a cancellation would genuinely change the answer.
  const booked = resolve(
    [
      { start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
      { start: "2026-11-20T06:00:00Z", durationMinutes: 30, taken: true },
    ],
    { now: "2026-11-20T03:00:00Z" }
  )
  assert.equal(booked.days[0].state, "fullyBooked")
})

test("every empty day is rendered with its sentence, not left blank", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [],
    days: ["2026-11-20", "2026-11-21"],
    timeZone: TOKYO,
    locale: "en-US",
  })
  const groups = byRole(walk(tree), "group")
  assert.equal(groups.length, 2)
  for (const group of groups) assert.match(text(group), /No times available/)
})

test("with nothing offered and no days listed, the picker says so once", () => {
  const { tree } = render(TimeSlotPicker, { slots: [], timeZone: TOKYO, locale: "en-US" })
  assert.equal(options(tree).length, 0)
  assert.match(text(byRole(walk(tree), "listbox")[0]), /No times are available/)
})

test("a slot on a day the caller did not list is still offered", () => {
  const resolved = resolve([{ start: "2026-11-25T01:00:00Z", durationMinutes: 30 }], {
    days: ["2026-11-20"],
  })
  assert.deepEqual(resolved.days.map((day) => day.key), ["2026-11-20", "2026-11-25"])
  assert.equal(resolved.available, 1, "dropping a bookable time is worse than an extra heading")
})

// ── now, and how much notice is needed ──────────────────────────────────────────────────────────

test("nothing is past unless the caller says when now is", () => {
  const slots = every30("2026-01-01T00:00:00Z", 2)
  const resolved = resolve(slots)
  assert.equal(resolved.available, 2, "a component that read the clock would call these past")
  assert.equal(resolved.days[0].slots.every((slot) => !slot.past), true)
})

test("a slot inside the notice period is shown, unselectable, and says why", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 3), {
    now: "2026-11-19T23:00:00Z",
    minLeadMinutes: 120,
  })
  // now is 08:00 in Tokyo and two hours' notice is wanted, so everything before 10:00 is out — which
  // is the 9:00 and the 9:30, not just the 9:00. The boundary itself is in: 10:00 is exactly two
  // hours away and bookable.
  const [first, second, third] = resolved.days[0].slots
  assert.deepEqual([first.block, second.block, third.block], ["lead", "lead", ""])
  assert.equal(first.selectable, false)
  assert.equal(first.reason, "Too soon to book")
  assert.equal(third.startLabel, "10:00 AM")
  assert.equal(resolved.available, 1)
})

test("a notice period with no now is reported rather than silently ignored", () => {
  assert.deepEqual(
    slotIssues(every30("2026-11-20T00:00:00Z", 1), { timeZone: TOKYO, minLeadMinutes: 60 }).map(
      (issue) => issue.kind
    ),
    ["lead-without-now"]
  )
})

test("past slots can be kept on screen when the caller wants them", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2), {
    now: "2026-11-21T00:00:00Z",
    hidePastSlots: false,
  })
  assert.equal(resolved.days[0].slots.length, 2)
  assert.equal(resolved.order.length, 2, "and they are reachable")
  assert.equal(resolved.available, 0)
})

// ── bad data, named ─────────────────────────────────────────────────────────────────────────────

test("two slots sharing an id keep the first and report the clash", () => {
  const slots = [
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "a", start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ]
  assert.deepEqual(resolve(slots).order, ["a"])
  assert.deepEqual(slotIssues(slots, { timeZone: TOKYO }).map((issue) => issue.kind), ["duplicate-id"])
})

test("two free slots over the same time are reported; a free one beside a booked one is not", () => {
  const overlapping = [
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 60 },
    { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 60 },
  ]
  assert.deepEqual(slotIssues(overlapping, { timeZone: TOKYO }).map((issue) => issue.kind), ["overlap"])
  const beside = [
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 60, taken: true },
    { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 60 },
  ]
  assert.deepEqual(slotIssues(beside, { timeZone: TOKYO }), [], "a calendar offers the hour either side")
})

test("a start nothing can read is left out and reported", () => {
  const slots = [{ start: "next tuesdayish" }, { start: "2026-11-20T00:00:00Z" }]
  assert.equal(resolve(slots).order.length, 1)
  assert.deepEqual(slotIssues(slots, { timeZone: TOKYO }).map((issue) => issue.kind), ["unparsable-start"])
})

test("slots are ordered by the moment, not by the string", () => {
  // The same instant written two ways, plus one written in a different zone: sorting the text would
  // put the later one first.
  const resolved = resolve([
    { id: "late", start: "2026-11-20T23:00:00+09:00" },
    { id: "early", start: "2026-11-20T06:00:00Z" },
  ])
  assert.deepEqual(resolved.order, ["early", "late"])
})

// ── the selection going stale ───────────────────────────────────────────────────────────────────

test("a chosen slot that has gone comes out of the value and is handed back", () => {
  const before = resolve(every30("2026-11-20T00:00:00Z", 3))
  const chosen = [before.days[0].slots[1].id]
  assert.deepEqual(reconcileSlotSelection(chosen, before), { value: chosen, lost: [] })

  // Somebody else took it.
  const after = resolve([
    { start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { start: "2026-11-20T00:30:00Z", durationMinutes: 30, taken: true },
    { start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ])
  assert.deepEqual(reconcileSlotSelection(chosen, after), { value: [], lost: chosen })

  // Or it stopped being offered at all.
  const gone = resolve(every30("2026-11-20T00:00:00Z", 1))
  assert.deepEqual(reconcileSlotSelection(chosen, gone), { value: [], lost: chosen })
})

test("a selection repeated in the incoming value is counted once", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2))
  const id = resolved.order[0]
  assert.deepEqual(reconcileSlotSelection([id, id], resolved).value, [id])
})

test("a slot taken since the page loaded loses its tick and is named in the notice", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const id = slots[0].start
  const picker = render(TimeSlotPicker, {
    slots,
    value: [id],
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [true, false])

  const taken = [{ ...slots[0], taken: true }, slots[1]]
  picker.update({ slots: taken, value: [id], timeZone: TOKYO, locale: "en-US" })
  assert.deepEqual(
    options(picker.tree).map((node) => node.props["aria-selected"]),
    [false, false],
    "the tick cannot stay on a slot somebody else has"
  )
  const notice = statuses(picker.tree).map(text).join(" ")
  assert.match(notice, /no longer available/)
  assert.match(notice, /Friday, November 20, 2026, 9:00 AM to 9:30 AM/, "which day, not just a time")
})

test("a form only ever posts what is still available", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const id = slots[0].start
  const picker = render(TimeSlotPicker, {
    slots: [{ ...slots[0], taken: true }, slots[1]],
    value: [id],
    name: "slot",
    timeZone: TOKYO,
    locale: "en-US",
  })
  const hidden = walk(picker.tree).filter((node) => node.props?.type === "hidden")
  assert.deepEqual(hidden, [], "the whole point: the booking that would be refused is not sent")
})

test("the caller is told about a loss once, not once per render", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const id = slots[0].start
  const lost = []
  const props = {
    slots: [{ ...slots[0], taken: true }, slots[1]],
    value: [id],
    onLostSelection: (ids) => lost.push(ids),
    timeZone: TOKYO,
    locale: "en-US",
  }
  const picker = render(TimeSlotPicker, props)
  assert.deepEqual(lost, [[id]])
  picker.rerender()
  picker.update({ ...props })
  assert.deepEqual(lost, [[id]], "a caller clearing its value from this must not be told again")
})

test("nothing lost, nothing said", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const lost = []
  render(TimeSlotPicker, {
    slots,
    value: [slots[0].start],
    onLostSelection: (ids) => lost.push(ids),
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.deepEqual(lost, [], "an empty list is not news")
})

// ── pressing ────────────────────────────────────────────────────────────────────────────────────

test("choosing one replaces the last, and keeps multiples in the order they are offered", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 4))
  const [first, second, third] = resolved.order

  const single = toggleSlotSelection([first], second, { resolved })
  assert.deepEqual(single.value, [second])
  assert.deepEqual(single.removed, [first])

  const many = toggleSlotSelection([third, first], second, { resolved, multiple: true })
  assert.deepEqual(many.value, [first, second, third], "a schedule reads in time order")
})

test("pressing again lets go, including of a slot that has since been taken", () => {
  const resolved = resolve([
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
    { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
  ])
  // "a" is not in the reconciled value any more, so there is nothing to let go of and the press is
  // a request to select — which is refused.
  assert.equal(toggleSlotSelection(["a"], "a", { resolved }).refused, "taken")
  // One that is merely over, and still on screen because the caller kept it, does let go.
  const past = resolve(every30("2026-11-20T00:00:00Z", 2), {
    now: "2026-11-21T00:00:00Z",
    hidePastSlots: false,
  })
  assert.equal(toggleSlotSelection([past.order[0]], past.order[0], { resolved: past }).refused, "past")
})

test("a press that cannot be honoured changes nothing and says which rule stopped it", () => {
  const resolved = resolve([
    { id: "free", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "taken", start: "2026-11-20T00:30:00Z", durationMinutes: 30, taken: true },
    { id: "soon", start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ], { now: "2026-11-20T00:45:00Z", hidePastSlots: false, minLeadMinutes: 60 })
  for (const [id, refusal] of [["taken", "taken"], ["soon", "lead"], ["nope", "missing"]]) {
    const result = toggleSlotSelection([], id, { resolved })
    assert.equal(result.refused, refusal, `pressing ${id}`)
    assert.deepEqual(result.value, [], "and nothing moved")
  }
})

test("the cap refuses the press rather than quietly dropping the oldest choice", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 4))
  const [a, b, c] = resolved.order
  const result = toggleSlotSelection([a, b], c, { resolved, multiple: true, max: 2 })
  assert.equal(result.refused, "max")
  assert.deepEqual(result.value, [a, b])
})

test("a click selects, and the announcement says which day as well as which time", () => {
  const picker = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[1].props.onClick()
  picker.rerender()
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [false, true])
  assert.match(
    statuses(picker.tree).map(text).join(" "),
    /Friday, November 20, 2026, 9:30 AM to 10:00 AM selected/
  )
})

test("a controlled picker does not move its own ticks", () => {
  const seen = []
  const props = {
    slots: every30("2026-11-20T00:00:00Z", 2),
    value: [],
    onValueChange: (next, change) => seen.push([next, change.added.map((slot) => slot.startLabel)]),
    timeZone: TOKYO,
    locale: "en-US",
  }
  const picker = render(TimeSlotPicker, props)
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.deepEqual(seen, [[[props.slots[0].start], ["9:00 AM"]]])
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [false, false])
})

test("pressing a taken slot announces the reason and leaves the selection alone", () => {
  const picker = render(TimeSlotPicker, {
    slots: [
      { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true, reason: "Held for members" },
      { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    ],
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [false, false])
  assert.match(statuses(picker.tree).map(text).join(" "), /cannot be selected: Held for members/)
})

test("a disabled picker ignores presses", () => {
  const picker = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    disabled: true,
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [false, false])
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-disabled"]), [true, true])
})

// ── reaching the slots ──────────────────────────────────────────────────────────────────────────

test("the whole list is one tab stop", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 6).concat(every30("2026-11-21T00:00:00Z", 6)),
    timeZone: TOKYO,
    locale: "en-US",
  })
  const all = options(tree)
  assert.equal(all.length, 12)
  assert.equal(all.filter((node) => node.props.tabIndex === 0).length, 1, "twelve slots, one Tab")
  // Counting the zeroes is not enough: `tabIndex={1}` on the other eleven is also one zero, and it
  // is twelve tab stops in the wrong order. Every slot that is not the stop has to be out of the
  // tab ring altogether.
  assert.deepEqual(
    [...new Set(all.map((node) => node.props.tabIndex))].sort(),
    [-1, 0],
    "no slot is reachable by Tab except the one stop"
  )
})

test("a list where nothing can be taken still has somewhere for Tab to land", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [
      { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
      { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30, taken: true },
    ],
    timeZone: TOKYO,
    locale: "en-US",
  })
  const stops = options(tree).filter((node) => node.props.tabIndex === 0)
  assert.equal(stops.length, 1, "a list nothing can reach cannot say why it is empty")
  assert.equal(stops[0].props["aria-label"], "9:00 AM to 9:30 AM", "and it is the first, not the second")
})

test("the tab stop lands on the chosen slot, else the first that can be taken", () => {
  const slots = [
    { id: "taken", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
    { id: "free", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    { id: "also", start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ]
  const base = { slots, timeZone: TOKYO, locale: "en-US" }
  const first = render(TimeSlotPicker, base)
  assert.equal(options(first.tree).find((node) => node.props.tabIndex === 0).props["aria-label"], "9:30 AM to 10:00 AM")
  const chosen = render(TimeSlotPicker, { ...base, value: ["also"] })
  assert.equal(options(chosen.tree).find((node) => node.props.tabIndex === 0).props["aria-label"], "10:00 AM to 10:30 AM")
})

test("the tab stop survives the slot it was on disappearing", () => {
  const slots = every30("2026-11-20T00:00:00Z", 3)
  const picker = render(TimeSlotPicker, { slots, timeZone: TOKYO, locale: "en-US" })
  const listbox = byRole(walk(picker.tree), "listbox")[0]
  listbox.props.onKeyDown({ key: "End", preventDefault: () => {} })
  picker.rerender()
  assert.equal(
    options(picker.tree).find((node) => node.props.tabIndex === 0).props["aria-label"],
    "10:00 AM to 10:30 AM"
  )
  picker.update({ slots: slots.slice(0, 1), timeZone: TOKYO, locale: "en-US" })
  const stops = options(picker.tree).filter((node) => node.props.tabIndex === 0)
  assert.equal(stops.length, 1, "not nought, which is a list nothing can reach")
})

test("arrows walk the slots and run on into the next day, clamping at both ends", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2).concat(every30("2026-11-21T00:00:00Z", 2)))
  const [a, b, c, d] = resolved.order
  assert.equal(nextSlotFocus(resolved, a, "ArrowRight"), b)
  assert.equal(nextSlotFocus(resolved, b, "ArrowRight"), c, "across the day boundary")
  assert.equal(nextSlotFocus(resolved, d, "ArrowRight"), null, "clamped, not wrapped round to the first")
  assert.equal(nextSlotFocus(resolved, a, "ArrowLeft"), null)
  assert.equal(nextSlotFocus(resolved, a, "End"), d)
  assert.equal(nextSlotFocus(resolved, d, "Home"), a)
  assert.equal(nextSlotFocus(resolved, a, "Escape"), null)
})

test("up and down move a day at a time, over the days with nothing on them", () => {
  const resolved = resolve(
    every30("2026-11-20T00:00:00Z", 2).concat(every30("2026-11-23T00:00:00Z", 2)),
    { days: ["2026-11-21", "2026-11-22"] }
  )
  assert.deepEqual(resolved.days.map((day) => day.key), [
    "2026-11-20",
    "2026-11-21",
    "2026-11-22",
    "2026-11-23",
  ])
  const [first, , third] = resolved.order
  assert.equal(nextSlotFocus(resolved, first, "ArrowDown"), third, "over the two empty days")
  assert.equal(nextSlotFocus(resolved, third, "ArrowUp"), first)
  assert.equal(nextSlotFocus(resolved, third, "ArrowDown"), null)
})

test("a slot nobody can take is still walked onto", () => {
  const resolved = resolve([
    { id: "free", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "taken", start: "2026-11-20T00:30:00Z", durationMinutes: 30, taken: true },
    { id: "after", start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ])
  assert.equal(nextSlotFocus(resolved, "free", "ArrowRight"), "taken", "skipping it hides that it exists")
  assert.equal(nextSlotFocus(resolved, "taken", "ArrowRight"), "after")
})

test("Enter and Space choose the slot at the tab stop, and hold on to the key", () => {
  for (const key of ["Enter", " "]) {
    const picker = render(TimeSlotPicker, {
      slots: every30("2026-11-20T00:00:00Z", 2),
      timeZone: TOKYO,
      locale: "en-US",
    })
    const listbox = byRole(walk(picker.tree), "listbox")[0]
    let prevented = false
    listbox.props.onKeyDown({ key, preventDefault: () => (prevented = true) })
    picker.rerender()
    assert.equal(prevented, true, `${key} must not also scroll the page`)
    assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [true, false])
  }
})

test("the list says whether more than one time can be chosen", () => {
  const base = { slots: every30("2026-11-20T00:00:00Z", 2), timeZone: TOKYO, locale: "en-US" }
  const single = byRole(walk(render(TimeSlotPicker, base).tree), "listbox")[0]
  assert.equal(single.props["aria-multiselectable"], undefined)
  const many = byRole(walk(render(TimeSlotPicker, { ...base, multiple: true }).tree), "listbox")[0]
  assert.equal(many.props["aria-multiselectable"], true)
})

test("a slot nobody can take stays in the list and says why, out loud", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [
      { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
      { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    ],
    timeZone: TOKYO,
    locale: "en-US",
  })
  const [taken] = options(tree)
  assert.equal(taken.props["aria-disabled"], true)
  assert.equal(taken.props.disabled, undefined, "`disabled` would take it out of reach")
  assert.equal(typeof taken.props["aria-describedby"], "string")
  assert.match(text(taken), /Already taken/)
})

test("the zone caption can be turned off without changing which zone is used", () => {
  const base = { slots: every30("2026-11-20T00:00:00Z", 1), timeZone: NY, locale: "en-US" }
  assert.match(text({ props: { children: render(TimeSlotPicker, base).tree } }), /Eastern Standard Time/)
  const quiet = render(TimeSlotPicker, { ...base, showTimeZone: false })
  assert.doesNotMatch(text({ props: { children: quiet.tree } }), /Eastern Standard Time/)
  // Midnight UTC is seven in the evening of the day before in New York, which is the point: the
  // caption going quiet does not move the times to the reader's own clock.
  assert.equal(options(quiet.tree)[0].props["aria-label"], "7:00 PM to 7:30 PM", "still New York")
})

test("a note on a slot is shown with it", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [{ start: "2026-11-20T00:00:00Z", durationMinutes: 30, note: "2 left" }],
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.match(text(options(tree)[0]), /2 left/)
})

test("every label can be replaced one at a time", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [],
    days: ["2026-11-20"],
    labels: { dayEmpty: "空きなし" },
    timeZone: TOKYO,
    locale: "ja-JP",
  })
  assert.match(text(byRole(walk(tree), "group")[0]), /空きなし/)
  assert.match(text({ props: { children: tree } }), /日本標準時/, "and the rest keep their defaults")
})

test("the next free slot is reportable without mounting anything", () => {
  const resolved = resolve([
    { id: "taken", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
    { id: "free", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
  ])
  assert.equal(nextAvailableSlot(resolved).id, "free")
  assert.equal(nextAvailableSlot(resolve([])), null)
})

// ── what the mutation run found nothing watching ────────────────────────────────────────────────

test("a form posts the chosen slot under the name it was given", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const { tree } = render(TimeSlotPicker, {
    slots,
    value: [slots[1].start],
    name: "slot",
    timeZone: TOKYO,
    locale: "en-US",
  })
  // The companion case asserts that a taken slot is *not* posted, and on its own it passes against a
  // component that posts nothing ever. This is the other direction.
  const inputs = walk(tree).filter((node) => node.type === "input")
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].props.type, "hidden")
  assert.equal(inputs[0].props.name, "slot")
  assert.equal(inputs[0].props.value, slots[1].start)
  assert.equal(
    walk(render(TimeSlotPicker, { slots, value: [slots[1].start], timeZone: TOKYO, locale: "en-US" }).tree).filter(
      (node) => node.type === "input"
    ).length,
    0,
    "and nothing is posted without a name to post it under"
  )
})

test("letting a slot go is announced as letting go, not as choosing", () => {
  const picker = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.match(statuses(picker.tree).map(text).join(" "), /9:00 AM to 9:30 AM selected/)
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  const said = statuses(picker.tree).map(text).join(" ")
  assert.match(said, /9:00 AM to 9:30 AM cleared/)
  assert.doesNotMatch(said, /selected/)
})

test("the cap says it is the cap, not that the slot is unavailable", () => {
  const slots = every30("2026-11-20T00:00:00Z", 3)
  const picker = render(TimeSlotPicker, {
    slots,
    multiple: true,
    max: 2,
    defaultValue: [slots[0].start, slots[1].start],
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[2].props.onClick()
  picker.rerender()
  const said = statuses(picker.tree).map(text).join(" ")
  assert.match(said, /You can choose at most 2/)
  assert.doesNotMatch(said, /cannot be selected/, "the slot is fine; the basket is full")
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [true, true, false])
})

test("the announcer is polite and out of the way", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 1),
    timeZone: TOKYO,
    locale: "en-US",
  })
  const live = statuses(tree).filter((node) => node.props["aria-live"] !== undefined)
  assert.equal(live.length, 1)
  assert.equal(live[0].props["aria-live"], "polite", "assertive would interrupt what is being read")
  assert.match(live[0].props.className, /sr-only/)
})

test("the notice about a lost slot is on the screen, not only in the accessibility tree", () => {
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const quiet = render(TimeSlotPicker, { slots, value: [], timeZone: TOKYO, locale: "en-US" })
  const notice = (tree) => statuses(tree).find((node) => node.props["aria-live"] === undefined)
  // Mounted while there is nothing to say, so the sentence arriving is a change to a live region
  // rather than a region nobody was watching — but hidden, or it is a blank red line under the list.
  assert.match(notice(quiet.tree).props.className, /sr-only/)
  assert.equal(text(notice(quiet.tree)), "")

  const lost = render(TimeSlotPicker, {
    slots: [{ ...slots[0], taken: true }, slots[1]],
    value: [slots[0].start],
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.doesNotMatch(notice(lost.tree).props.className, /sr-only/, "somebody has to be able to read it")
  assert.match(text(notice(lost.tree)), /no longer available/)
})

test("each of the four empty days renders its own sentence", () => {
  const base = { timeZone: TOKYO, locale: "en-US", now: "2026-11-20T06:00:00Z" }
  const day = (props) => byRole(walk(render(TimeSlotPicker, { ...base, ...props }).tree), "group")[0]

  assert.match(text(day({ slots: [], days: ["2026-11-21"] })), /No times available/)
  assert.match(text(day({ slots: [{ start: "2026-11-20T00:00:00Z", durationMinutes: 30 }] })), /These times have passed/)
  assert.match(text({ props: { children: render(TimeSlotPicker, { ...base, slots: [] }).tree } }), /No times are available/)

  // Written expecting this one to read like the others — a sentence instead of a grid. It is not:
  // a taken slot stays on screen, so the day has both. Which is the point of saying it at all, and
  // the reason the sentence is not the grid's alternative: a day can only lose its grid by having
  // its times pass, so "fully booked" written that way could never be reached.
  const booked = day({ slots: [{ start: "2026-11-21T00:00:00Z", durationMinutes: 30, taken: true }] })
  assert.match(text(booked), /Fully booked/)
  assert.equal(byRole(walk(booked), "option").length, 1, "and the time that was taken is still there")
})

test("the two 1:30s are told apart on the screen, not just in the data", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [
      { start: "2026-11-01T05:30:00Z", durationMinutes: 30 },
      { start: "2026-11-01T06:30:00Z", durationMinutes: 30 },
    ],
    timeZone: NY,
    locale: "en-US",
  })
  const shown = options(tree).map(text)
  assert.match(shown[0], /EDT/)
  assert.match(shown[1], /EST/)
  assert.notEqual(shown[0], shown[1], "two slots that read alike are two slots nobody can choose between")
  // And it is not pinned to every slot in the catalogue.
  const plain = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.doesNotMatch(options(plain.tree).map(text).join(" "), /JST|GMT/)
})

test("a slot nobody can take looks like one", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [
      { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
      { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    ],
    timeZone: TOKYO,
    locale: "en-US",
  })
  const [taken, free] = options(tree)
  assert.match(taken.props.className, /line-through/)
  assert.match(taken.props.className, /cursor-not-allowed/)
  assert.doesNotMatch(free.props.className, /line-through/)
})

test("a disabled picker says so once, for the whole list", () => {
  const base = { slots: every30("2026-11-20T00:00:00Z", 2), timeZone: TOKYO, locale: "en-US" }
  const off = render(TimeSlotPicker, { ...base, disabled: true })
  const listbox = (tree) => byRole(walk(tree), "listbox")[0]
  assert.equal(listbox(off.tree).props["aria-disabled"], true)
  assert.match(listbox(off.tree).props.className, /opacity-50/, "and it looks switched off")
  const on = render(TimeSlotPicker, base)
  assert.equal(listbox(on.tree).props["aria-disabled"], undefined)
  assert.doesNotMatch(listbox(on.tree).props.className, /opacity-50/)
})

// ── the second mutation pass: rules with nothing standing on them ───────────────────────────────

test("a wall clock just after the clocks change lands on the right instant", () => {
  // The offset has to be the one in force at the *answer*, not at the first guess, which is why the
  // conversion makes a correction pass. Subtract the guess's own offset and stop, and every bare
  // time on the far side of a clock change is an hour out: 03:00 in New York on 8 March 2026 is
  // 07:00 UTC, and the one-pass version answers 08:00.
  const after = resolve([{ start: "2026-03-08T03:00" }], { timeZone: NY })
  assert.equal(new Date(after.days[0].slots[0].start).toISOString(), "2026-03-08T07:00:00.000Z")
  // And the ordinary case either side of it is unmoved.
  const before = resolve([{ start: "2026-03-07T03:00" }], { timeZone: NY })
  assert.equal(new Date(before.days[0].slots[0].start).toISOString(), "2026-03-07T08:00:00.000Z")
})

test("a Date, a number of milliseconds and a loose string are all accepted", () => {
  const ms = Date.UTC(2026, 10, 20, 0, 0)
  for (const start of [new Date(ms), ms, "2026-11-20T00:00:00Z"]) {
    const resolved = resolve([{ id: "x", start, durationMinutes: 30 }])
    assert.equal(resolved.byId.x.start, ms, `start given as ${typeof start}`)
    assert.deepEqual(
      slotIssues([{ id: "x", start }], { timeZone: TOKYO }),
      [],
      "a Date and an epoch are moments already; there is nothing to warn about"
    )
  }
  // A string the regexes do not recognise is handed to the engine, which may read it however it
  // likes — so it parses, and it is reported, because the zone it landed in is anyone's guess.
  const loose = slotIssues([{ id: "x", start: "Nov 20, 2026 09:00" }], { timeZone: TOKYO })
  assert.deepEqual(loose.map((issue) => issue.kind), ["no-offset"])
  assert.equal(resolve([{ id: "x", start: "Nov 20, 2026 09:00" }]).order.length, 1)
})

test("a bare wall clock carrying seconds keeps its minutes", () => {
  const resolved = resolve([{ start: "2026-11-20T09:00:30" }])
  assert.equal(new Date(resolved.days[0].slots[0].start).toISOString(), "2026-11-20T00:00:30.000Z")
})

test("the day heading is the day in the display zone, not the day UTC was on", () => {
  // Formatted from noon rather than midnight: midnight is the one hour a zone shift can carry to
  // the day before, and a heading a day out over a list of correct times is the worst of both.
  const resolved = resolve([{ start: "2026-11-20T18:00:00Z", durationMinutes: 30 }], { timeZone: NY })
  assert.equal(resolved.days[0].key, "2026-11-20")
  assert.match(resolved.days[0].label, /November 20, 2026/)
})

test("the zone is named as it is at the times being shown, not as it is in January", () => {
  const summer = resolve([{ start: "2026-07-01T16:00:00Z", durationMinutes: 30 }], { timeZone: NY })
  assert.equal(summer.zoneName, "Eastern Daylight Time")
  const winter = resolve([{ start: "2026-12-01T17:00:00Z", durationMinutes: 30 }], { timeZone: NY })
  assert.equal(winter.zoneName, "Eastern Standard Time")
})

test("a 24-hour clock can be insisted on", () => {
  assert.equal(resolve(every30("2026-11-20T00:00:00Z", 1), { hour12: false }).days[0].slots[0].startLabel, "09:00")
  assert.equal(resolve(every30("2026-11-20T00:00:00Z", 1), { hour12: true }).days[0].slots[0].startLabel, "9:00 AM")
})

test("a slot starting at this very moment has not passed", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2), {
    now: "2026-11-20T00:00:00Z",
    hidePastSlots: false,
  })
  assert.equal(resolved.days[0].slots[0].past, false, "now is not yet too late")
  assert.equal(resolved.available, 2)
  const later = resolve(every30("2026-11-20T00:00:00Z", 2), {
    now: "2026-11-20T00:00:01Z",
    hidePastSlots: false,
  })
  assert.equal(later.days[0].slots[0].past, true)
  assert.equal(later.days[0].slots[0].reason, "This time has passed")
})

test("the end wins over a length, and a default length only fills in for neither", () => {
  const explicit = resolve([
    { id: "both", start: "2026-11-20T00:00:00Z", end: "2026-11-20T02:00:00Z", durationMinutes: 30 },
  ])
  assert.equal(explicit.byId.both.durationMinutes, 120, "the end is the fact; the length is a shorthand")

  const fallback = resolve([{ id: "bare", start: "2026-11-20T00:00:00Z" }], { defaultDurationMinutes: 45 })
  assert.equal(fallback.byId.bare.durationMinutes, 45)
  const neither = resolve([{ id: "bare", start: "2026-11-20T00:00:00Z" }])
  assert.equal(neither.byId.bare.durationMinutes, null, "nothing is invented when nobody said")
  assert.equal(neither.byId.bare.end, null)
})

test("a slot with no length at all is a start time, not a zero-long range", () => {
  const same = resolve([{ id: "x", start: "2026-11-20T00:00:00Z", end: "2026-11-20T00:00:00Z" }])
  assert.equal(same.byId.x.end, null)
  assert.equal(same.byId.x.label, "9:00 AM")
  assert.deepEqual(
    slotIssues([{ id: "x", start: "2026-11-20T00:00:00Z", end: "2026-11-20T00:00:00Z" }], { timeZone: TOKYO }).map(
      (issue) => issue.kind
    ),
    ["backwards"]
  )
})

test("an end nothing can read is reported as the end, not as the slot", () => {
  const issues = slotIssues([{ id: "x", start: "2026-11-20T00:00:00Z", end: "whenever" }], { timeZone: TOKYO })
  assert.deepEqual(issues.map((issue) => issue.kind), ["unparsable-end"])
  assert.equal(resolve([{ id: "x", start: "2026-11-20T00:00:00Z", end: "whenever" }]).order.length, 1, "the start still stands")
})

test("slots that merely touch do not overlap", () => {
  const backToBack = every30("2026-11-20T00:00:00Z", 3)
  assert.deepEqual(
    slotIssues(backToBack, { timeZone: TOKYO }),
    [],
    "one ending as the next begins is a timetable, not a double booking"
  )
  // Three spans rather than two, so neither a slot compared with itself nor a mis-sorted list can
  // produce the same answer by accident.
  const clash = [
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 60 },
    { id: "c", start: "2026-11-20T01:00:00Z", durationMinutes: 30 },
  ]
  assert.deepEqual(slotIssues(clash, { timeZone: TOKYO }).map((issue) => issue.subject), ["c"])
})

test("no notice period, nothing to report", () => {
  assert.deepEqual(slotIssues(every30("2026-11-20T00:00:00Z", 1), { timeZone: TOKYO }), [])
  assert.deepEqual(
    slotIssues(every30("2026-11-20T00:00:00Z", 1), { timeZone: TOKYO, minLeadMinutes: 0 }),
    [],
    "asking for no notice is not asking for anything"
  )
})

test("an id given as an empty string falls back to the start, and is reported as that", () => {
  const resolved = resolve([{ id: "", start: "2026-11-20T00:00:00Z", durationMinutes: 30 }])
  assert.deepEqual(resolved.order, ["2026-11-20T00:00:00.000Z"])
})

test("two slots at the same moment keep a fixed order", () => {
  const same = [
    { id: "b", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
  ]
  assert.deepEqual(resolve(same).order, ["a", "b"], "a tie goes to the id, so the list cannot shuffle")
  assert.deepEqual(resolve(same.slice().reverse()).order, ["a", "b"])
})

test("letting one of several go keeps the others", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 3))
  const [a, b, c] = resolved.order
  const result = toggleSlotSelection([a, b, c], b, { resolved, multiple: true })
  assert.deepEqual(result.value, [a, c], "the other two are not collateral")
  assert.deepEqual(result.removed, [b])
  assert.deepEqual(result.added, [])
})

test("a tick goes away when the slot it is on is pressed again", () => {
  const picker = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [true, false])
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  assert.deepEqual(options(picker.tree).map((node) => node.props["aria-selected"]), [false, false])
})

test("the cap only refuses once it is reached", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 4))
  const [a, b, c] = resolved.order
  const room = toggleSlotSelection([a], b, { resolved, multiple: true, max: 3 })
  assert.equal(room.refused, null, "one of three chosen is not full")
  assert.deepEqual(room.value, [a, b])
  assert.equal(toggleSlotSelection([a, b, c], resolved.order[3], { resolved, multiple: true, max: 3 }).refused, "max")
})

test("a cap does not change what an unavailable slot says", () => {
  const picker = render(TimeSlotPicker, {
    slots: [
      { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true },
      { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    ],
    multiple: true,
    max: 2,
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[0].props.onClick()
  picker.rerender()
  const said = statuses(picker.tree).map(text).join(" ")
  assert.match(said, /cannot be selected: Already taken/)
  assert.doesNotMatch(said, /at most/, "the basket is not full; the slot is gone")
})

test("the change object names what went as well as what arrived", () => {
  const seen = []
  const slots = every30("2026-11-20T00:00:00Z", 2)
  const picker = render(TimeSlotPicker, {
    slots,
    value: [slots[0].start],
    onValueChange: (next, change) => seen.push({
      added: change.added.map((slot) => slot.startLabel),
      removed: change.removed.map((slot) => slot.startLabel),
    }),
    timeZone: TOKYO,
    locale: "en-US",
  })
  options(picker.tree)[1].props.onClick()
  assert.deepEqual(seen, [{ added: ["9:30 AM"], removed: ["9:00 AM"] }])
})

test("a day with times to offer says nothing extra", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 2),
    timeZone: TOKYO,
    locale: "en-US",
  })
  const said = text(byRole(walk(tree), "group")[0])
  for (const sentence of ["No times available", "Fully booked", "These times have passed"]) {
    assert.doesNotMatch(said, new RegExp(sentence), `an available day must not claim: ${sentence}`)
  }
})

test("a single unavailable slot is still reachable", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: [{ id: "only", start: "2026-11-20T00:00:00Z", durationMinutes: 30, taken: true }],
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.equal(options(tree).filter((node) => node.props.tabIndex === 0).length, 1)
})

test("with nothing focused yet, a key press starts at the beginning", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2).concat(every30("2026-11-21T00:00:00Z", 2)))
  const first = resolved.order[0]
  assert.equal(nextSlotFocus(resolved, null, "ArrowRight"), first)
  assert.equal(nextSlotFocus(resolved, null, "ArrowLeft"), first)
  assert.equal(nextSlotFocus(resolved, null, "Home"), first)
  assert.equal(nextSlotFocus(resolved, null, "ArrowDown"), resolved.days[1].slots[0].id)
  assert.equal(nextSlotFocus(resolve([]), null, "ArrowRight"), null, "and an empty list goes nowhere")
})

test("a day holding a single time is not jumped over", () => {
  const resolved = resolve(
    every30("2026-11-20T00:00:00Z", 2).concat([{ start: "2026-11-21T00:00:00Z", durationMinutes: 30 }])
  )
  assert.equal(resolved.days[1].slots.length, 1)
  assert.equal(nextSlotFocus(resolved, resolved.order[0], "ArrowDown"), resolved.days[1].slots[0].id)
})

test("a negative notice period is no notice period", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 2), {
    now: "2026-11-20T00:00:00Z",
    minLeadMinutes: -120,
  })
  assert.equal(resolved.available, 2, "it cannot reach back and free up times that have gone")
})

// ── third pass: the boundaries and the component's own defaults ─────────────────────────────────

test("a bare wall clock is accepted to the edges of the calendar and refused past them", () => {
  // The pattern only says two digits, so these bounds are the whole of the validation. Off by one
  // on any of them and a real date stops being bookable — December with `>= 12`, the 31st with
  // `>= 31`, the last minute of the day with `>= 59`.
  const edges = [
    ["2026-12-31T23:59:59", "2026-12-31T14:59:59.000Z"],
    ["2026-01-01T00:00:00", "2025-12-31T15:00:00.000Z"],
  ]
  for (const [input, expected] of edges) {
    const resolved = resolve([{ id: "x", start: input }])
    assert.equal(new Date(resolved.byId.x.start).toISOString(), expected, input)
  }
  for (const bad of ["2026-13-20T09:00", "2026-11-32T09:00", "2026-11-20T24:00", "2026-11-20T09:60", "2026-11-20T09:00:60"]) {
    assert.deepEqual(resolve([{ id: "x", start: bad }]).order, [], bad)
    assert.deepEqual(slotIssues([{ id: "x", start: bad }], { timeZone: TOKYO }).map((i) => i.kind), ["unparsable-start"], bad)
  }
})

test("an end without an offset is reported as the end, and a bad length as a bad length", () => {
  assert.deepEqual(
    slotIssues([{ id: "x", start: "2026-11-20T00:00:00Z", end: "2026-11-20T10:00" }], { timeZone: TOKYO }).map(
      (issue) => [issue.kind, issue.subject]
    ),
    [["no-offset", "x"]]
  )
  // Both at once, and worth having as a case: midnight UTC is nine in the morning in Tokyo, so a
  // bare end of "01:00" read in Tokyo lands eight hours *before* a start that named its own offset.
  // This is the shape of the bug the no-offset warning exists for — mixing the two forms in one
  // slot quietly reverses it.
  assert.deepEqual(
    slotIssues([{ id: "x", start: "2026-11-20T00:00:00Z", end: "2026-11-20T01:00" }], { timeZone: TOKYO }).map(
      (issue) => issue.kind
    ),
    ["no-offset", "backwards"]
  )
  for (const durationMinutes of [0, -30, Number.NaN]) {
    assert.deepEqual(
      slotIssues([{ id: "x", start: "2026-11-20T00:00:00Z", durationMinutes }], { timeZone: TOKYO }).map(
        (issue) => issue.kind
      ),
      ["backwards"],
      `durationMinutes ${durationMinutes}`
    )
    assert.equal(resolve([{ id: "x", start: "2026-11-20T00:00:00Z", durationMinutes }]).byId.x.end, null)
  }
})

test("an unreadable slot is reported under its id, or under what was written if it has none", () => {
  assert.deepEqual(
    slotIssues([{ id: "morning", start: "whenever" }], { timeZone: TOKYO }).map((issue) => issue.subject),
    ["morning"]
  )
  assert.deepEqual(
    slotIssues([{ start: "whenever" }], { timeZone: TOKYO }).map((issue) => issue.subject),
    ["whenever"],
    "there is no id to name it by, so the value is the only handle the caller has"
  )
})

test("even a minute of required notice is reported when there is no now to measure it from", () => {
  assert.deepEqual(
    slotIssues(every30("2026-11-20T00:00:00Z", 1), { timeZone: TOKYO, minLeadMinutes: 1 }).map((i) => i.kind),
    ["lead-without-now"]
  )
})

test("the overlap report names every clash and nothing else", () => {
  const slots = [
    { id: "a", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "b", start: "2026-11-20T00:30:00Z", durationMinutes: 30 },
    { id: "c", start: "2026-11-20T00:45:00Z", durationMinutes: 30 },
    { id: "d", start: "2026-11-20T02:00:00Z", durationMinutes: 30 },
  ]
  assert.deepEqual(
    slotIssues(slots, { timeZone: TOKYO }).map((issue) => [issue.kind, issue.subject]),
    [["overlap", "c"]],
    "c runs into b; a and d are clear"
  )
})

test("the left arrow steps back one, from the middle as well as the ends", () => {
  const resolved = resolve(every30("2026-11-20T00:00:00Z", 3))
  const [a, b, c] = resolved.order
  assert.equal(nextSlotFocus(resolved, b, "ArrowLeft"), a)
  assert.equal(nextSlotFocus(resolved, c, "ArrowLeft"), b)
  assert.equal(nextSlotFocus(resolved, a, "ArrowLeft"), null)
})

test("down from nothing goes to the second day, counting from the first slot", () => {
  // The first day holds a single slot, so starting from the wrong end of the list lands a day out.
  const resolved = resolve([
    { id: "one", start: "2026-11-20T00:00:00Z", durationMinutes: 30 },
    { id: "two", start: "2026-11-21T00:00:00Z", durationMinutes: 30 },
    { id: "three", start: "2026-11-22T00:00:00Z", durationMinutes: 30 },
  ])
  assert.equal(nextSlotFocus(resolved, null, "ArrowDown"), "two")
})

test("the list takes the name it is given", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 1),
    "aria-label": "Consultation times",
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.equal(byRole(walk(tree), "listbox")[0].props["aria-label"], "Consultation times")
})

test("the picker asks for no notice and hides the past unless told otherwise", () => {
  const slots = every30("2026-11-20T00:00:00Z", 3)
  const { tree } = render(TimeSlotPicker, { slots, now: "2026-11-20T00:30:00Z", timeZone: TOKYO, locale: "en-US" })
  const shown = options(tree)
  // No notice period by default, so the slot starting exactly now is still takeable...
  assert.deepEqual(shown.map((node) => node.props["aria-disabled"]), [undefined, undefined])
  // ...and the one that has already started is not on screen at all.
  assert.deepEqual(shown.map((node) => node.props["aria-label"]), [
    "9:30 AM to 10:00 AM",
    "10:00 AM to 10:30 AM",
  ])
})

test("a disabled picker's slots do not invite a press", () => {
  const { tree } = render(TimeSlotPicker, {
    slots: every30("2026-11-20T00:00:00Z", 1),
    disabled: true,
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.match(options(tree)[0].props.className, /cursor-not-allowed/)
})

test("the notice is written for one lost slot or for several", () => {
  const slots = every30("2026-11-20T00:00:00Z", 3)
  const taken = slots.map((slot, i) => (i < 2 ? { ...slot, taken: true } : slot))
  const one = render(TimeSlotPicker, { slots: taken, value: [slots[0].start], timeZone: TOKYO, locale: "en-US" })
  const notice = (tree) => text(statuses(tree).find((node) => node.props["aria-live"] === undefined))
  assert.match(notice(one.tree), /is no longer available\. Please choose another time\./)

  const two = render(TimeSlotPicker, {
    slots: taken,
    value: [slots[0].start, slots[1].start],
    multiple: true,
    timeZone: TOKYO,
    locale: "en-US",
  })
  assert.match(notice(two.tree), /are no longer available\. Please choose other times\./)
  assert.match(notice(two.tree), /9:00 AM to 9:30 AM, Friday/, "both are named, not counted")
})
