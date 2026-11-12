// The recurrence editor everyone writes first clamps the 31st to the end of short months, counts a
// skipped date towards COUNT, keeps "2nd Tuesday" alive after the frequency becomes weekly, leaves a
// times box and an end-date box both live, and shows DTSTART as the first date whatever the rule
// says. All five look finished on screen, and the cases below are written to fail against them:
//
//   - "monthly on the 31st" presented as twelve dates a year when it fires seven times,
//   - COUNT=12 on that rule read as "for a year" when it runs about twenty months, because RFC 5545
//     requires a skipped instance not be counted and so it is not,
//   - BYMONTHDAY=31 and BYMONTHDAY=-1 treated as the same request, when one skips and one never does,
//   - a numbered weekday surviving into a weekly rule, which RFC 5545 forbids outright and other
//     calendars reject,
//   - COUNT and UNTIL emitted together, which RFC 5545 says MUST NOT happen,
//   - a start date shown as the first occurrence when the rule does not generate it,
//   - and an impossible start date (29 February in a common year) normalised to 1 March in silence.
//
// The date arithmetic is additionally cross-checked against rrule.js — the implementation the rest
// of this ecosystem is built on — for 22 rules covering every BY* part the editor can produce. That
// comparison is what found the DTSTART rule above; it is not reproduced here because it would add a
// dependency to the registry, so the agreed-upon outputs are pinned as literals instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  WEEKDAYS,
  defaultRecurrence,
  monthlyMode,
  frequencyChangeDrops,
  changeFrequency,
  setMonthlyMode,
  toggleWeekday,
  setEnding,
  endingOf,
  monthDaySkip,
  recurrenceIssues,
  formatRRule,
  parseRRule,
  describeRecurrence,
  nextOccurrences,
  daysInMonth,
  parseDay,
  RecurrenceInput,
  defaultRecurrenceInputLabels,
} = loadComponent(join(ROOT, "registry/ui/recurrence-input.tsx"))

const rule = (parts) => ({ ...defaultRecurrence(), ...parts })
const parsed = (text) => {
  const result = parseRRule(text)
  assert.equal(result.ok, true, `expected ${text} to parse`)
  return result.rule
}

// ---------------------------------------------------------------------------------------------
// The month-end rule, which is the whole reason this component is worth shipping.
// ---------------------------------------------------------------------------------------------

test("the 31st fires in seven months of the year, not twelve", () => {
  const got = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=31"), "2026-01-31", 7)
  assert.deepEqual(got.days, [
    "2026-01-31",
    "2026-03-31",
    "2026-05-31",
    "2026-07-31",
    "2026-08-31",
    "2026-10-31",
    "2026-12-31",
  ])
  // February, April, June, September and November asked for a 31st and got nothing. A clamping
  // implementation reports zero here and shows twelve dates above.
  assert.equal(got.skipped, 5)
})

test("a skipped date does not count towards COUNT, so COUNT=12 is not a year", () => {
  const got = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=31;COUNT=12"), "2026-01-31", 20)
  assert.equal(got.days.length, 12)
  assert.equal(got.complete, true)
  // Twelve firings of "the 31st" starting in January 2026 reach August 2027 — nineteen months, not
  // twelve. This is the number a person reads as "monthly for a year".
  assert.equal(got.days[11], "2027-08-31")
  assert.equal(got.days[0], "2026-01-31")
})

test("the last day of the month never skips, which is why it is a separate choice", () => {
  const got = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=-1"), "2026-01-31", 12)
  assert.equal(got.skipped, 0)
  assert.deepEqual(got.days.slice(0, 4), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
  // The pair that must not be collapsed: same month, different date.
  const thirtyFirst = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=31"), "2026-01-31", 3)
  assert.notDeepEqual(got.days.slice(0, 3), thirtyFirst.days.slice(0, 3))
})

test("the 29th is missing from February only outside leap years", () => {
  const skip = monthDaySkip(29)
  assert.deepEqual(skip.months, [2])
  assert.equal(skip.leapSensitive, true)
  assert.deepEqual(monthDaySkip(31).months, [2, 4, 6, 9, 11])
  assert.equal(monthDaySkip(31).leapSensitive, false)
  assert.deepEqual(monthDaySkip(30).months, [2])
  // 28 and below exist in every month, so there is nothing to warn about.
  assert.equal(monthDaySkip(28), null)
  assert.equal(monthDaySkip(1), null)
  // 2028 is a leap year and 2027 is not, which is what `leapSensitive` is about.
  assert.equal(daysInMonth(2028, 2), 29)
  assert.equal(daysInMonth(2027, 2), 28)
})

test("a fifth weekday exists in some months and falls back to nothing in the rest", () => {
  const got = nextOccurrences(parsed("FREQ=MONTHLY;BYDAY=5FR"), "2026-01-01", 5)
  assert.deepEqual(got.days, ["2026-01-30", "2026-05-29", "2026-07-31", "2026-10-30", "2027-01-29"])
  assert.ok(got.skipped > 0, "the months without a fifth Friday must be reported, not clamped")
  // The implementation that falls back to the fourth Friday produces a date every month.
  const lastFriday = nextOccurrences(parsed("FREQ=MONTHLY;BYDAY=-1FR"), "2026-01-01", 5)
  assert.deepEqual(lastFriday.days, [
    "2026-01-30",
    "2026-02-27",
    "2026-03-27",
    "2026-04-24",
    "2026-05-29",
  ])
  assert.equal(lastFriday.skipped, 0)
})

test("a rule that can never match ends empty instead of spinning", () => {
  const got = nextOccurrences(parsed("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"), "2026-01-01", 5)
  assert.deepEqual(got.days, [])
  assert.equal(got.startIsOccurrence, false)
})

// ---------------------------------------------------------------------------------------------
// DTSTART, and the part of the spec that is genuinely undefined.
// ---------------------------------------------------------------------------------------------

test("the start date appears only when the rule actually generates it", () => {
  // Synchronised: the 31st start matches a BYMONTHDAY=31 rule.
  const sync = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=31"), "2026-01-31", 2)
  assert.equal(sync.startIsOccurrence, true)
  assert.equal(sync.days[0], "2026-01-31")

  // Unsynchronised: a series starting on the 15th that repeats on the 29th does not include the
  // 15th. Matching rrule.js here is the point — a preview showing a date the caller's calendar will
  // not produce is worse than no preview.
  const unsync = nextOccurrences(parsed("FREQ=MONTHLY;BYMONTHDAY=29"), "2026-01-15", 3)
  assert.equal(unsync.startIsOccurrence, false)
  assert.deepEqual(unsync.days, ["2026-01-29", "2026-03-29", "2026-04-29"])

  // A Monday start on a weekend rule is the same situation with weekdays.
  const weekend = nextOccurrences(parsed("FREQ=WEEKLY;INTERVAL=3;BYDAY=SU,SA;WKST=SU"), "2026-01-05", 3)
  assert.equal(weekend.startIsOccurrence, false)
  assert.deepEqual(weekend.days, ["2026-01-10", "2026-01-25", "2026-01-31"])
})

test("COUNT counts emitted dates, so COUNT=1 is one date", () => {
  const got = nextOccurrences(parsed("FREQ=DAILY;COUNT=1"), "2026-01-01", 5)
  assert.deepEqual(got.days, ["2026-01-01"])
  assert.equal(got.complete, true)
})

test("an impossible start date is refused rather than rolled into the next month", () => {
  // `new Date(2026, 1, 29)` is 1 March 2026. Accepting it moves the whole series by a day.
  assert.equal(parseDay("2026-02-29"), null)
  assert.deepEqual(nextOccurrences(parsed("FREQ=MONTHLY"), "2026-02-29", 3).days, [])
  // The same string in a leap year is a real date and works.
  assert.deepEqual(nextOccurrences(parsed("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"), "2028-02-29", 2).days, [
    "2028-02-29",
    "2032-02-29",
  ])
})

test("WKST changes which days a fortnightly rule lands on", () => {
  const monday = nextOccurrences(parsed("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"), "2026-01-05", 4)
  const sunday = nextOccurrences(parsed("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;WKST=SU"), "2026-01-05", 4)
  assert.deepEqual(monday.days, ["2026-01-05", "2026-01-08", "2026-01-19", "2026-01-22"])
  assert.deepEqual(sunday.days, monday.days)
  // It bites where the week boundary falls between the chosen days rather than outside them.
  const across = nextOccurrences(parsed("FREQ=WEEKLY;INTERVAL=3;BYDAY=SU,SA;WKST=SU"), "2026-01-05", 4)
  assert.deepEqual(across.days, ["2026-01-10", "2026-01-25", "2026-01-31", "2026-02-15"])
})

test("BYSETPOS counts within the whole period, which for a yearly rule is the year", () => {
  const lastWeekday = nextOccurrences(
    parsed("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1"),
    "2026-01-01",
    4,
  )
  assert.deepEqual(lastWeekday.days, ["2026-01-30", "2026-02-27", "2026-03-31", "2026-04-30"])

  // The yearly case is the one that separates "within the period" from "within each month". One
  // interval of a yearly rule is the whole year, so the last Monday of a January-to-March window is
  // a single date in March — not one per month. Pinned against rrule.js.
  const lastMondayOfQuarter = nextOccurrences(
    parsed("FREQ=YEARLY;BYMONTH=1,2,3;BYDAY=MO;BYSETPOS=-1"),
    "2026-01-01",
    3,
  )
  assert.deepEqual(lastMondayOfQuarter.days, ["2026-03-30", "2027-03-29", "2028-03-27"])
  const firstMondayOfQuarter = nextOccurrences(
    parsed("FREQ=YEARLY;BYMONTH=1,2,3;BYDAY=MO;BYSETPOS=1"),
    "2026-01-01",
    3,
  )
  assert.deepEqual(firstMondayOfQuarter.days, ["2026-01-05", "2027-01-04", "2028-01-03"])
  // Two positions in one year is two dates a year, one per end of the window.
  assert.deepEqual(
    nextOccurrences(parsed("FREQ=YEARLY;BYMONTH=1,7;BYDAY=FR;BYSETPOS=-1,1"), "2026-01-01", 4).days,
    ["2026-01-02", "2026-07-31", "2027-01-01", "2027-07-30"],
  )
})

// ---------------------------------------------------------------------------------------------
// Changing frequency: the panel swaps, and what it discards is said out loud.
// ---------------------------------------------------------------------------------------------

test("a numbered weekday cannot survive into a weekly rule, and its loss is reported", () => {
  const monthly = rule({ freq: "MONTHLY", byDay: [{ weekday: "TU", ordinal: 2 }] })
  assert.deepEqual(frequencyChangeDrops(monthly, "WEEKLY"), ["byDayOrdinal"])
  const weekly = changeFrequency(monthly, "WEEKLY", "2026-01-13")
  // The weekday is kept because it is still on screen; only the ordinal goes.
  assert.deepEqual(weekly.byDay, [{ weekday: "TU" }])
  assert.deepEqual(recurrenceIssues(weekly), [])
  // Keeping the ordinal is the bug this guards: RFC 5545 forbids it outside MONTHLY/YEARLY.
  const illegal = rule({ freq: "WEEKLY", byDay: [{ weekday: "TU", ordinal: 2 }] })
  assert.equal(recurrenceIssues(illegal).length, 1)
  assert.equal(recurrenceIssues(illegal)[0].field, "byDay")
})

test("a newly relevant field is seeded from the start date, not invented", () => {
  const daily = rule({ freq: "DAILY" })
  // Switching to monthly with a series that starts on the 17th must repeat on the 17th.
  assert.deepEqual(changeFrequency(daily, "MONTHLY", "2026-03-17").byMonthDay, [17])
  // Switching to weekly picks the start's weekday. 17 March 2026 is a Tuesday.
  assert.deepEqual(changeFrequency(daily, "WEEKLY", "2026-03-17").byDay, [{ weekday: "TU" }])
  // Switching to yearly keeps the month too.
  const yearly = changeFrequency(daily, "YEARLY", "2026-03-17")
  assert.deepEqual(yearly.byMonth, [3])
  assert.deepEqual(yearly.byMonthDay, [17])
  // With nothing to go on it falls back rather than throwing, and says nothing untrue.
  assert.deepEqual(changeFrequency(daily, "MONTHLY", null).byMonthDay, [1])
})

test("daily keeps no BY* parts, and says which ones it cleared", () => {
  const monthly = rule({ freq: "MONTHLY", byMonthDay: [15], bySetPos: [-1] })
  assert.deepEqual(frequencyChangeDrops(monthly, "DAILY"), ["byMonthDay", "bySetPos"])
  const daily = changeFrequency(monthly, "DAILY", "2026-01-15")
  assert.deepEqual(daily.byMonthDay, [])
  assert.deepEqual(daily.bySetPos, [])
  assert.equal(formatRRule(daily), "FREQ=DAILY")
  // Nothing is dropped when the frequency has not changed.
  assert.deepEqual(frequencyChangeDrops(monthly, "MONTHLY"), [])
  assert.equal(changeFrequency(monthly, "MONTHLY"), monthly)
})

test("the monthly panel is three exclusive shapes, and reading one back agrees with it", () => {
  const base = rule({ freq: "MONTHLY", byMonthDay: [15] })
  assert.equal(monthlyMode(base), "dayOfMonth")
  const nth = setMonthlyMode(base, "nthWeekday", "2026-01-15")
  assert.equal(monthlyMode(nth), "nthWeekday")
  assert.deepEqual(nth.byMonthDay, [], "the day number has to go, or the two intersect")
  // 15 January 2026 is in the third week, so "third Thursday" is the honest seed.
  assert.equal(nth.byDay[0].ordinal, 3)
  const last = setMonthlyMode(nth, "lastDay")
  assert.equal(monthlyMode(last), "lastDay")
  assert.deepEqual(last.byMonthDay, [-1])
  assert.deepEqual(last.byDay, [])
  // Back to a day number, and the previous one is not resurrected from nowhere.
  assert.equal(monthlyMode(setMonthlyMode(last, "dayOfMonth", "2026-01-15")), "dayOfMonth")

  // Straight from a weekday to a day number is the transition that has to clear BYDAY: carrying
  // both means their intersection, which is a third rule no panel here can show. Asserting the
  // emitted string rather than the mode, because a leftover BYDAY is what actually ships.
  const backToDay = setMonthlyMode(nth, "dayOfMonth", "2026-01-15")
  assert.deepEqual(backToDay.byDay, [])
  assert.equal(formatRRule(backToDay), "FREQ=MONTHLY;BYMONTHDAY=15")
  assert.equal(monthlyMode(backToDay), "dayOfMonth")
})

test("the last selected weekday is refused rather than removed", () => {
  const one = rule({ freq: "WEEKLY", byDay: [{ weekday: "MO" }] })
  // An empty BYDAY is not "every day"; it silently falls back to DTSTART's weekday, which is a
  // different rule than the empty row on screen.
  assert.equal(toggleWeekday(one, "MO"), one)
  const two = toggleWeekday(one, "TH")
  assert.deepEqual(two.byDay, [{ weekday: "MO" }, { weekday: "TH" }])
  assert.deepEqual(toggleWeekday(two, "MO").byDay, [{ weekday: "TH" }])
})

// ---------------------------------------------------------------------------------------------
// The ending is one choice of three, not two switches.
// ---------------------------------------------------------------------------------------------

test("COUNT and UNTIL cannot both be live", () => {
  const counted = setEnding(defaultRecurrence(), "count", 10)
  assert.equal(counted.count, 10)
  assert.equal(counted.until, null)
  assert.equal(endingOf(counted), "count")

  const dated = setEnding(counted, "until", "2026-12-31")
  assert.equal(dated.count, null, "moving to a date must clear the count")
  assert.equal(dated.until, "2026-12-31")
  assert.equal(endingOf(dated), "until")

  const never = setEnding(dated, "never")
  assert.equal(never.count, null)
  assert.equal(never.until, null)
  assert.equal(endingOf(never), "never")

  // A rule holding both is reported, and refused by the parser rather than resolved.
  const both = rule({ count: 5, until: "2026-12-31" })
  assert.ok(recurrenceIssues(both).some((i) => i.message.includes("not both")))
  assert.equal(parseRRule("FREQ=DAILY;COUNT=5;UNTIL=20261231").ok, false)
})

test("a count below one is not accepted", () => {
  assert.equal(setEnding(defaultRecurrence(), "count", 0).count, 1)
  assert.equal(recurrenceIssues(rule({ count: 0 })).length, 1)
  assert.equal(parseRRule("FREQ=DAILY;COUNT=0").ok, false)
})

// ---------------------------------------------------------------------------------------------
// Serialising and parsing.
// ---------------------------------------------------------------------------------------------

test("the RRULE value round-trips through the parser unchanged", () => {
  for (const value of [
    "FREQ=DAILY",
    "FREQ=DAILY;INTERVAL=8",
    "FREQ=WEEKLY;BYDAY=MO,TH",
    "FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=MO,TH",
    "FREQ=MONTHLY;BYMONTHDAY=31",
    "FREQ=MONTHLY;BYMONTHDAY=-1",
    "FREQ=MONTHLY;BYDAY=2TU",
    "FREQ=MONTHLY;BYDAY=-1FR",
    "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
    "FREQ=YEARLY;BYMONTH=11;BYDAY=3TH",
    "FREQ=DAILY;COUNT=10",
    "FREQ=DAILY;UNTIL=20261231",
  ]) {
    assert.equal(formatRRule(parsed(value)), value, `round trip: ${value}`)
  }
})

test("INTERVAL=1 and WKST=MO are the defaults and are not emitted", () => {
  assert.equal(formatRRule(rule({ freq: "DAILY", interval: 1, weekStart: "MO" })), "FREQ=DAILY")
  assert.equal(formatRRule(rule({ freq: "DAILY", weekStart: "SU" })), "FREQ=DAILY;WKST=SU")
  // Reading a rule that spells the defaults out is still the same rule.
  assert.equal(formatRRule(parsed("FREQ=DAILY;INTERVAL=1;WKST=MO")), "FREQ=DAILY")
})

test("UNTIL is written in the form the caller's DTSTART needs", () => {
  const dated = rule({ freq: "DAILY", until: "2026-12-31" })
  assert.equal(formatRRule(dated), "FREQ=DAILY;UNTIL=20261231")
  assert.equal(
    formatRRule(dated, { untilForm: "utc-end-of-day" }),
    "FREQ=DAILY;UNTIL=20261231T235959Z",
  )
  // A zone this component cannot know is the caller's to supply.
  assert.equal(
    formatRRule(dated, { untilForm: (day) => `${day.replace(/-/g, "")}T150000Z` }),
    "FREQ=DAILY;UNTIL=20261231T150000Z",
  )
  assert.equal(formatRRule(dated, { prefix: true }), "RRULE:FREQ=DAILY;UNTIL=20261231")
  // All three legal shapes read back to the same calendar day.
  for (const value of ["20261231", "20261231T235959Z", "20261231T140000"]) {
    assert.equal(parsed(`FREQ=DAILY;UNTIL=${value}`).until, "2026-12-31")
  }
})

test("a rule this editor cannot show is refused or reported, never quietly simplified", () => {
  // Sub-daily frequencies have no panel, so the caller keeps its original string. They are real
  // RFC 5545 frequencies, so the message has to say "not covered here" and not "not a frequency" —
  // the two send a developer to completely different places.
  for (const freq of ["SECONDLY", "MINUTELY", "HOURLY"]) {
    const result = parseRRule(`FREQ=${freq};INTERVAL=30`)
    assert.equal(result.ok, false)
    assert.match(result.error, new RegExp(freq))
    assert.match(result.error, /within a day/)
    assert.doesNotMatch(result.error, /is not a frequency/)
  }
  // Whereas something that is genuinely not a frequency is told so.
  const nonsense = parseRRule("FREQ=FORTNIGHTLY")
  assert.equal(nonsense.ok, false)
  assert.match(nonsense.error, /is not a frequency/)
  // Parts that are editable nowhere here are listed so the form can refuse to overwrite the rule.
  const weekno = parseRRule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO")
  assert.equal(weekno.ok, true)
  assert.deepEqual(
    weekno.unsupported.map((p) => p.name),
    ["BYWEEKNO"],
  )
  // RFC 7529's clamping extension is recognised by name, so a clamping rule is not mistaken for a
  // plain one and stripped of the very part that made it clamp.
  const skipping = parseRRule("FREQ=MONTHLY;BYMONTHDAY=31;RSCALE=GREGORIAN;SKIP=BACKWARD")
  assert.equal(skipping.ok, true)
  assert.deepEqual(
    skipping.unsupported.map((p) => p.name).sort(),
    ["RSCALE", "SKIP"],
  )
  assert.ok(skipping.unsupported.every((p) => p.reason.length > 0))
  // And the times of day, which belong to DTSTART.
  assert.deepEqual(
    parseRRule("FREQ=DAILY;BYHOUR=9;BYMINUTE=30").unsupported.map((p) => p.name),
    ["BYHOUR", "BYMINUTE"],
  )
})

test("malformed rules are rejected with the part that failed", () => {
  for (const value of [
    "",
    "FREQ",
    "INTERVAL=2",
    "FREQ=NEVER",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;INTERVAL=-2",
    "FREQ=WEEKLY;BYDAY=FUNDAY",
    "FREQ=DAILY;UNTIL=20260230",
    "FREQ=DAILY;UNTIL=not-a-date",
    "FREQ=WEEKLY;WKST=XX",
    "FREQ=MONTHLY;BYMONTHDAY=abc",
  ]) {
    assert.equal(parseRRule(value).ok, false, `expected ${JSON.stringify(value)} to be refused`)
  }
  // The prefix is accepted, since that is how an RRULE appears in a VEVENT.
  assert.equal(parseRRule("RRULE:FREQ=DAILY").ok, true)
})

// ---------------------------------------------------------------------------------------------
// Reading it back in words.
// ---------------------------------------------------------------------------------------------

test("the rule reads back as a sentence a person can check", () => {
  const cases = [
    ["FREQ=DAILY", "Every day"],
    ["FREQ=DAILY;INTERVAL=3", "Every 3 days"],
    ["FREQ=WEEKLY;BYDAY=TU", "Every week on Tuesday"],
    ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", "Every 2 weeks on Monday and Thursday"],
    ["FREQ=WEEKLY;BYDAY=MO,WE,FR", "Every week on Monday, Wednesday and Friday"],
    ["FREQ=MONTHLY;BYMONTHDAY=15", "Every month on the 15th"],
    ["FREQ=MONTHLY;BYMONTHDAY=-1", "Every month on the last day of the month"],
    ["FREQ=MONTHLY;BYDAY=2MO", "Every month on the second Monday"],
    ["FREQ=MONTHLY;BYDAY=-1FR", "Every month on the last Friday"],
    ["FREQ=YEARLY;BYMONTH=11;BYDAY=3TH", "Every year in November on the third Thursday"],
    ["FREQ=DAILY;COUNT=10", "Every day, 10 times"],
    ["FREQ=DAILY;COUNT=1", "Every day, 1 time"],
    ["FREQ=DAILY;UNTIL=20261231", "Every day, until 31 December 2026"],
  ]
  for (const [value, sentence] of cases) {
    assert.equal(describeRecurrence(parsed(value)), sentence, value)
  }
  // The distinction the sentence exists to catch: "the 2nd" and "the second Monday" are different
  // rules and must not read the same.
  assert.notEqual(
    describeRecurrence(parsed("FREQ=MONTHLY;BYMONTHDAY=2")),
    describeRecurrence(parsed("FREQ=MONTHLY;BYDAY=2MO")),
  )
})

test("the sentence is localisable without touching the component", () => {
  const ja = describeRecurrence(parsed("FREQ=WEEKLY;BYDAY=TU"), {
    ...defaultRecurrenceInputLabels,
    frequency: {
      ...defaultRecurrenceInputLabels.frequency,
      WEEKLY: { every: "毎週", plural: "週" },
    },
    weekdays: { ...defaultRecurrenceInputLabels.weekdays, TU: "火曜日" },
    on: "",
  })
  assert.match(ja, /毎週/)
  assert.match(ja, /火曜日/)
})

test("the date in the sentence does not go through Intl", () => {
  // A locale-dependent string renders one way on the server and another in the browser, which React
  // reports as a hydration mismatch, so the default formatter is deliberately plain.
  const sentence = describeRecurrence(parsed("FREQ=DAILY;UNTIL=20260701"))
  assert.equal(sentence, "Every day, until 1 July 2026")
  assert.equal(
    describeRecurrence(parsed("FREQ=DAILY;UNTIL=20260701"), {
      ...defaultRecurrenceInputLabels,
      formatDate: (day) => day,
    }),
    "Every day, until 2026-07-01",
  )
})

// ---------------------------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------------------------

const renderInput = (props = {}) => {
  const emitted = []
  const instance = render(RecurrenceInput, {
    dtstart: "2026-01-15",
    onValueChange: (next) => emitted.push(next),
    ...props,
  })
  return { instance, emitted, get nodes() {
    return walk(instance.tree)
  } }
}

test("the hidden field posts the RRULE value, not the object", () => {
  const { nodes } = renderInput({
    name: "recurrence",
    defaultValue: { ...defaultRecurrence(), freq: "WEEKLY", byDay: [{ weekday: "MO" }] },
  })
  const hidden = byTag(nodes, "input").filter((n) => n.props.type === "hidden")
  assert.equal(hidden.length, 1)
  assert.equal(hidden[0].props.name, "recurrence")
  assert.equal(hidden[0].props.value, "FREQ=WEEKLY;BYDAY=MO")
})

test("no name means no hidden field, so nothing is posted by accident", () => {
  const hidden = byTag(renderInput().nodes, "input").filter((n) => n.props.type === "hidden")
  assert.deepEqual(hidden, [])
})

test("the live region is mounted from the start and carries the sentence", () => {
  const { nodes } = renderInput({ defaultValue: rule({ freq: "DAILY", interval: 2 }) })
  const live = nodes.filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(live.length, 1, "exactly one live region, and it is always there")
  assert.equal(live[0].props.role, "status")
  // A region inserted together with its message is often not announced at all, so it has to be
  // present and carrying text in the very first render.
  assert.match(JSON.stringify(live[0].props.children), /Every 2 days/)
})

test("the only selected weekday is marked unavailable rather than silently inert", () => {
  const { nodes } = renderInput({
    defaultValue: rule({ freq: "WEEKLY", byDay: [{ weekday: "MO" }] }),
  })
  const pressed = byTag(nodes, "button").filter((n) => n.props["aria-pressed"] === true)
  assert.equal(pressed.length, 1)
  // aria-disabled, not the disabled attribute: it keeps its tab stop and announces itself.
  assert.equal(pressed[0].props["aria-disabled"], true)
  assert.ok(pressed[0].props["aria-describedby"], "and it points at the reason")
  const unpressed = byTag(nodes, "button").filter((n) => n.props["aria-pressed"] === false)
  assert.equal(unpressed.length, WEEKDAYS.length - 1)
  assert.ok(unpressed.every((n) => n.props["aria-disabled"] === undefined))
})

test("the skip warning appears for a day that does not exist every month", () => {
  const text = (nodes) => JSON.stringify(nodes.map((n) => n.props?.children ?? null))
  const risky = renderInput({ defaultValue: rule({ freq: "MONTHLY", byMonthDay: [31] }) })
  assert.match(text(risky.nodes), /February/)
  assert.match(text(risky.nodes), /does not count towards a total/)
  // The 15th exists in every month, so there is nothing to say about it.
  const safe = renderInput({ defaultValue: rule({ freq: "MONTHLY", byMonthDay: [15] }) })
  assert.doesNotMatch(text(safe.nodes), /does not count towards a total/)
  // And neither does the last day, which is the answer the warning points at.
  const last = renderInput({ defaultValue: rule({ freq: "MONTHLY", byMonthDay: [-1] }) })
  assert.doesNotMatch(text(last.nodes), /does not count towards a total/)
})

test("a start date the rule does not generate is called out", () => {
  const text = (nodes) => JSON.stringify(nodes.map((n) => n.props?.children ?? null))
  const unsynced = renderInput({
    dtstart: "2026-01-15",
    defaultValue: rule({ freq: "MONTHLY", byMonthDay: [29] }),
  })
  assert.match(text(unsynced.nodes), /does not match this rule/)
  const synced = renderInput({
    dtstart: "2026-01-15",
    defaultValue: rule({ freq: "MONTHLY", byMonthDay: [15] }),
  })
  assert.doesNotMatch(text(synced.nodes), /does not match this rule/)
})

test("without a start date there is no preview, rather than one built from today", () => {
  const text = (nodes) => JSON.stringify(nodes.map((n) => n.props?.children ?? null))
  const withStart = renderInput({ dtstart: "2026-01-15", defaultValue: rule({ freq: "DAILY" }) })
  assert.match(text(withStart.nodes), /Next dates/)
  const without = renderInput({ dtstart: undefined, defaultValue: rule({ freq: "DAILY" }) })
  assert.doesNotMatch(text(without.nodes), /Next dates/)
})

test("changing the frequency emits the cleared rule and announces what went", () => {
  const { instance, emitted, nodes } = renderInput({
    defaultValue: rule({ freq: "MONTHLY", byDay: [{ weekday: "TU", ordinal: 2 }] }),
  })
  const select = nodes.filter((n) => n.type === "select" && n.props["aria-label"] === "Frequency")
  assert.equal(select.length, 1)
  select[0].props.onChange({ target: { value: "WEEKLY" } })
  instance.rerender()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].freq, "WEEKLY")
  assert.deepEqual(emitted[0].byDay, [{ weekday: "TU" }])
  const live = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.match(JSON.stringify(live[0].props.children), /byDayOrdinal/)
})

test("a controlled value is not overridden by internal state", () => {
  const emitted = []
  const instance = render(RecurrenceInput, {
    dtstart: "2026-01-15",
    value: rule({ freq: "DAILY", interval: 4 }),
    onValueChange: (next) => emitted.push(next),
  })
  const select = walk(instance.tree).filter(
    (n) => n.type === "select" && n.props["aria-label"] === "Frequency",
  )
  select[0].props.onChange({ target: { value: "WEEKLY" } })
  instance.rerender()
  // The parent is told, and the rendered value still comes from the prop.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].freq, "WEEKLY")
  const interval = walk(instance.tree).filter(
    (n) => n.type === "input" && n.props["aria-label"] === "Repeat every",
  )
  assert.equal(interval[0].props.value, 4)
})

test("an interval below one cannot be typed in", () => {
  const { instance, emitted } = renderInput({ defaultValue: rule({ freq: "DAILY", interval: 3 }) })
  const interval = walk(instance.tree).filter(
    (n) => n.type === "input" && n.props["aria-label"] === "Repeat every",
  )
  interval[0].props.onChange({ target: { value: "0" } })
  instance.rerender()
  assert.equal(emitted[0].interval, 1)
  assert.deepEqual(recurrenceIssues(emitted[0]), [])
})

test("the fieldset carries disabled, so the caller's fields go with it", () => {
  const { nodes } = renderInput({ disabled: true })
  const fieldsets = byTag(nodes, "fieldset")
  assert.equal(fieldsets.length, 1)
  assert.equal(fieldsets[0].props.disabled, true)
  assert.equal(byTag(nodes, "legend").length, 1, "a real fieldset needs a real legend")
})

test("every interactive control has an accessible name", () => {
  for (const freq of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]) {
    const { nodes } = renderInput({ defaultValue: changeFrequency(rule({ freq: "DAILY" }), freq, "2026-01-15") })
    for (const node of [...byTag(nodes, "select"), ...byTag(nodes, "input")]) {
      if (node.props.type === "hidden") continue
      if (node.props.type === "radio") {
        // Radios are wrapped in their own <label>, so the name comes from the text beside them.
        assert.ok(node.props.name, `a radio needs a group name (${freq})`)
        continue
      }
      const named =
        node.props["aria-label"] || node.props.id || node.props["aria-labelledby"]
      assert.ok(named, `unnamed control in ${freq}: ${node.type} ${JSON.stringify(node.props.type)}`)
    }
    for (const node of byTag(nodes, "button")) {
      assert.ok(node.props.children, `a weekday button needs a label (${freq})`)
    }
  }
})
