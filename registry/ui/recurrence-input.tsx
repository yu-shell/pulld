"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The frequencies a person schedules things in.
 *
 * RFC 5545 also defines `SECONDLY`, `MINUTELY` and `HOURLY`. They are deliberately absent: this is
 * the editor beside "repeats", and nobody sets a dentist appointment to every 30 seconds. A rule
 * carrying one of them is reported as unrepresentable by {@link parseRRule} rather than quietly
 * rewritten into something the person did not choose — see {@link ParsedRRule}.
 */
export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"

/** Weekday codes exactly as RFC 5545 spells them, so they serialise without a lookup. */
export type Weekday = "SU" | "MO" | "TU" | "WE" | "TH" | "FR" | "SA"

export const WEEKDAYS: readonly Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

/**
 * One `BYDAY` entry: a weekday, optionally with the ordinal that picks which one in the period.
 *
 * `{ weekday: "MO", ordinal: 2 }` is the second Monday; `{ weekday: "FR", ordinal: -1 }` the last
 * Friday. **The ordinal is only legal when `FREQ` is `MONTHLY` or `YEARLY`** — RFC 5545 is explicit
 * that "the BYDAY rule part MUST NOT be specified with a numeric value when the FREQ rule part is
 * not set to MONTHLY or YEARLY" — which is why {@link changeFrequency} strips ordinals on the way to
 * `WEEKLY` instead of leaving a rule that no other calendar will accept.
 */
export interface ByDay {
  weekday: Weekday
  /** `±1`–`53`. Omitted means "every one of them in the period". */
  ordinal?: number
}

/**
 * A recurrence rule, in the shape an editor needs rather than the shape it serialises to.
 *
 * Every `by*` field is an array even where the UI only ever sets one value, because the parser has
 * to round-trip rules written elsewhere: `BYMONTHDAY=1,15` is an ordinary rule and collapsing it to
 * a single number on the way in would silently rewrite somebody's data the first time they opened
 * the form.
 *
 * `count` and `until` are a pair with a hard constraint: RFC 5545 says the two "MUST NOT occur in
 * the same 'recur'", so the end condition is a three-way choice rather than two independent fields.
 * {@link setEnding} is the only safe way to move between them.
 */
export interface RecurrenceRule {
  freq: Frequency
  /** `INTERVAL`. A positive integer; `1` is the RFC default and is omitted when serialising. */
  interval: number
  byDay: ByDay[]
  /** `BYMONTHDAY`. `1`–`31` or `-31`–`-1`, where `-1` is the last day of the month. */
  byMonthDay: number[]
  /** `BYMONTH`. `1`–`12`. */
  byMonth: number[]
  /** `BYSETPOS`. `±1`–`366`; only meaningful alongside another `BY*` part. */
  bySetPos: number[]
  /** `COUNT`. Null unless the ending is "after N times". **Counts `DTSTART` as the first.** */
  count: number | null
  /** `UNTIL`, as a calendar day `YYYY-MM-DD`. Null unless the ending is "on a date". */
  until: string | null
  /** `WKST`. RFC default is `MO`. Only changes results for `WEEKLY` rules with `INTERVAL` > 1. */
  weekStart: Weekday
}

/** How the monthly panel is being edited. Derived from the rule, never stored beside it. */
export type MonthlyMode = "dayOfMonth" | "nthWeekday" | "lastDay"

export type Ending = "never" | "count" | "until"

/** A blank rule. `WEEKLY` because it is what "repeats" means to most people most of the time. */
export function defaultRecurrence(freq: Frequency = "WEEKLY"): RecurrenceRule {
  return {
    freq,
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    bySetPos: [],
    count: null,
    until: null,
    weekStart: "MO",
  }
}

// ---------------------------------------------------------------------------------------------
// Calendar arithmetic, done on plain {y,m,d} triples through Date.UTC only.
//
// Never on a local Date. A recurrence is a sequence of calendar days, and local Date arithmetic
// moves a day by an hour twice a year: `setDate(d.getDate() + 1)` across a spring-forward boundary
// in a zone that shifts at midnight lands on the same calendar day it started on. The whole series
// then silently doubles one date and skips another. Working in UTC removes the question, and the
// zone stays where it belongs — on DTSTART, which lives outside this component.
// ---------------------------------------------------------------------------------------------

/** A calendar day with no time and no zone. */
export interface PlainDay {
  y: number
  m: number
  d: number
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 0 = Sunday … 6 = Saturday, matching {@link WEEKDAYS}. */
export function dayOfWeek(day: PlainDay): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay()
}

export function isValidDay(day: PlainDay): boolean {
  return (
    Number.isInteger(day.y) &&
    Number.isInteger(day.m) &&
    Number.isInteger(day.d) &&
    day.m >= 1 &&
    day.m <= 12 &&
    day.d >= 1 &&
    day.d <= daysInMonth(day.y, day.m)
  )
}

/** Parses `YYYY-MM-DD` strictly. Returns null for anything else, including `2026-02-30`. */
export function parseDay(text: string | null | undefined): PlainDay | null {
  if (typeof text !== "string") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (!m) return null
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  return isValidDay(day) ? day : null
}

export function formatDay(day: PlainDay): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  return `${pad(day.y, 4)}-${pad(day.m)}-${pad(day.d)}`
}

function dayNumber(day: PlainDay): number {
  return Date.UTC(day.y, day.m - 1, day.d) / 86400000
}

function fromDayNumber(n: number): PlainDay {
  const date = new Date(n * 86400000)
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }
}

export function addDays(day: PlainDay, n: number): PlainDay {
  return fromDayNumber(dayNumber(day) + n)
}

function addMonths(day: PlainDay, n: number): PlainDay {
  const total = day.y * 12 + (day.m - 1) + n
  return { y: Math.floor(total / 12), m: (total % 12) + 1, d: day.d }
}

function compareDays(a: PlainDay, b: PlainDay): number {
  return dayNumber(a) - dayNumber(b)
}

/** The weekday index {@link WEEKDAYS} uses, for a code. `-1` if the code is not one. */
function weekdayIndex(code: Weekday): number {
  return WEEKDAYS.indexOf(code)
}

// ---------------------------------------------------------------------------------------------
// Editing the rule. Every transition is a pure function, because these are the decisions that are
// hard to get right and the only ones worth asserting on without a DOM.
// ---------------------------------------------------------------------------------------------

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function dedupeByDay(entries: ByDay[]): ByDay[] {
  const seen = new Set<string>()
  const out: ByDay[] = []
  for (const entry of entries) {
    if (weekdayIndex(entry.weekday) < 0) continue
    const key = `${entry.ordinal ?? ""}${entry.weekday}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry.ordinal === undefined ? { weekday: entry.weekday } : entry)
  }
  return out.sort(
    (a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0) || weekdayIndex(a.weekday) - weekdayIndex(b.weekday),
  )
}

/** Which monthly shape a rule is in. `dayOfMonth` is the fallback, because it is `BYMONTHDAY`'s. */
export function monthlyMode(rule: RecurrenceRule): MonthlyMode {
  if (rule.byMonthDay.length === 1 && rule.byMonthDay[0] === -1) return "lastDay"
  if (rule.byDay.length > 0) return "nthWeekday"
  return "dayOfMonth"
}

/**
 * The parts of `rule` that cannot survive a move to `freq`.
 *
 * Exported so the control can *say* what a frequency change is about to throw away. The panel
 * swapping under the person is the visible half of changing frequency; the invisible half is that
 * "on the 2nd Tuesday" cannot mean anything once the rule repeats weekly, and a form that silently
 * drops it leaves them believing they saved something they did not. RFC 5545 forbids most of these
 * combinations outright, so keeping them is not an option either — only announcing them is.
 */
export function frequencyChangeDrops(rule: RecurrenceRule, freq: Frequency): string[] {
  if (rule.freq === freq) return []
  const drops: string[] = []
  const ordinals = rule.byDay.some((d) => d.ordinal !== undefined)
  if (freq === "DAILY") {
    if (rule.byDay.length) drops.push("byDay")
    if (rule.byMonthDay.length) drops.push("byMonthDay")
    if (rule.byMonth.length) drops.push("byMonth")
    if (rule.bySetPos.length) drops.push("bySetPos")
  } else if (freq === "WEEKLY") {
    if (ordinals) drops.push("byDayOrdinal")
    if (rule.byMonthDay.length) drops.push("byMonthDay")
    if (rule.byMonth.length) drops.push("byMonth")
    if (rule.bySetPos.length) drops.push("bySetPos")
  } else if (freq === "MONTHLY") {
    if (rule.byMonth.length) drops.push("byMonth")
    if (rule.byDay.length && rule.byMonthDay.length) drops.push("byMonthDay")
  }
  return drops
}

/**
 * Moves a rule to another frequency, keeping what still means something and dropping what cannot.
 *
 * `seed` is the start date the rule hangs off — `DTSTART` — and is what a newly relevant field is
 * filled from: switching to monthly with nothing to go on would otherwise have to invent a day of
 * the month, and inventing the 1st when the series starts on the 17th is how these forms end up
 * quietly scheduling the wrong thing. Pair it with {@link frequencyChangeDrops} to tell the person
 * what went.
 */
export function changeFrequency(
  rule: RecurrenceRule,
  freq: Frequency,
  seed?: PlainDay | string | null,
): RecurrenceRule {
  if (rule.freq === freq) return rule
  const start = typeof seed === "string" ? parseDay(seed) : (seed ?? null)
  const next: RecurrenceRule = { ...rule, freq, bySetPos: [] }

  if (freq === "DAILY") {
    next.byDay = []
    next.byMonthDay = []
    next.byMonth = []
    return next
  }

  if (freq === "WEEKLY") {
    // Ordinals are illegal outside MONTHLY/YEARLY, so "2nd Tuesday" becomes "Tuesday" rather than
    // being thrown away whole — the weekday is the part the person can still see on screen.
    next.byDay = dedupeByDay(rule.byDay.map((d) => ({ weekday: d.weekday })))
    if (!next.byDay.length && start) next.byDay = [{ weekday: WEEKDAYS[dayOfWeek(start)] }]
    next.byMonthDay = []
    next.byMonth = []
    return next
  }

  // MONTHLY and YEARLY both pick days within a month, so they share the choice between a day
  // number and an nth weekday. Carrying both would mean their intersection, which no panel here
  // can show, so one of them wins and the other is reported as dropped.
  const keepsWeekday = rule.byDay.length > 0 && rule.byMonthDay.length === 0
  if (keepsWeekday) {
    next.byDay = dedupeByDay(
      rule.byDay.map((d) => ({ weekday: d.weekday, ordinal: d.ordinal ?? 1 })),
    )
    next.byMonthDay = []
  } else {
    next.byDay = []
    next.byMonthDay = rule.byMonthDay.length
      ? uniqueSorted(rule.byMonthDay)
      : start
        ? [start.d]
        : [1]
  }
  next.byMonth = freq === "YEARLY" ? (rule.byMonth.length ? uniqueSorted(rule.byMonth) : start ? [start.m] : [1]) : []
  return next
}

/** Switches the monthly/yearly panel between a day number, an nth weekday, and the last day. */
export function setMonthlyMode(
  rule: RecurrenceRule,
  mode: MonthlyMode,
  seed?: PlainDay | string | null,
): RecurrenceRule {
  const start = typeof seed === "string" ? parseDay(seed) : (seed ?? null)
  if (mode === "lastDay") return { ...rule, byDay: [], byMonthDay: [-1], bySetPos: [] }
  if (mode === "dayOfMonth") {
    const day = rule.byMonthDay.find((d) => d > 0) ?? start?.d ?? 1
    return { ...rule, byDay: [], byMonthDay: [day], bySetPos: [] }
  }
  const weekday = rule.byDay[0]?.weekday ?? (start ? WEEKDAYS[dayOfWeek(start)] : "MO")
  const ordinal = rule.byDay[0]?.ordinal ?? (start ? Math.ceil(start.d / 7) : 1)
  return { ...rule, byDay: [{ weekday, ordinal }], byMonthDay: [], bySetPos: [] }
}

/** Adds or removes one weekday from a `WEEKLY` rule, refusing to empty the set. */
export function toggleWeekday(rule: RecurrenceRule, weekday: Weekday): RecurrenceRule {
  const present = rule.byDay.some((d) => d.weekday === weekday)
  if (present) {
    // A weekly rule with no weekday is not "every day"; it falls back to DTSTART's weekday, which
    // is a different rule than the one on screen. Keeping the last one checked keeps the two equal.
    if (rule.byDay.length <= 1) return rule
    return { ...rule, byDay: rule.byDay.filter((d) => d.weekday !== weekday) }
  }
  return { ...rule, byDay: dedupeByDay([...rule.byDay, { weekday }]) }
}

/**
 * Moves between the three endings, which is a choice of one rather than two switches.
 *
 * RFC 5545: `UNTIL` and `COUNT` "MUST NOT occur in the same 'recur'". A form with a "times" box and
 * a "date" box both live will eventually emit both, and a rule carrying both is rejected or
 * arbitrarily resolved by whatever reads it next.
 */
export function setEnding(
  rule: RecurrenceRule,
  ending: Ending,
  value?: number | string | null,
): RecurrenceRule {
  if (ending === "never") return { ...rule, count: null, until: null }
  if (ending === "count") {
    const n = typeof value === "number" ? Math.floor(value) : Number(value)
    return { ...rule, count: Number.isFinite(n) && n >= 1 ? n : (rule.count ?? 1), until: null }
  }
  const day = typeof value === "string" ? value : rule.until
  return { ...rule, count: null, until: day ?? null }
}

/** Which ending a rule is in. */
export function endingOf(rule: RecurrenceRule): Ending {
  if (rule.count !== null) return "count"
  if (rule.until !== null) return "until"
  return "never"
}

// ---------------------------------------------------------------------------------------------
// The month-end problem, which is arithmetic rather than a preference.
// ---------------------------------------------------------------------------------------------

/** What a day-of-month number costs in missed months. */
export interface MonthDaySkip {
  day: number
  /** Months (1–12) that never contain this day, in a common year. */
  months: number[]
  /** True for the 29th, which exists in February in leap years and not otherwise. */
  leapSensitive: boolean
}

/**
 * Whether "on the Nth" silently skips months, and which.
 *
 * This is the one place where a recurrence editor is routinely, confidently wrong, and the reason is
 * worth stating exactly. RFC 5545 does not clamp: "Recurrence rules may generate recurrence
 * instances with an invalid date (e.g., February 30)" and "such recurrence instances MUST be ignored
 * and MUST NOT be counted as part of the recurrence set." So `FREQ=MONTHLY;BYMONTHDAY=31` fires in
 * seven months of the year, not twelve — and because a skipped instance is not counted, pairing it
 * with `COUNT=12` does not end in a year: it ends after the twelfth month that actually has a 31st,
 * roughly twenty months later. Nothing errors, and the schedule a person reads back as "monthly for
 * a year" is neither.
 *
 * Several products clamp instead — "the 31st" meaning the 30th in April. That behaviour is not RFC
 * 5545's, and a rule that means it cannot be written as `BYMONTHDAY=31`; it is `BYMONTHDAY=-1`, the
 * last day of the month, which exists in every month and is what {@link MonthlyMode}'s `lastDay`
 * emits. The two are different schedules and this component makes the person choose between them
 * rather than guessing, because guessing is invisible either way.
 */
export function monthDaySkip(day: number): MonthDaySkip | null {
  if (!Number.isInteger(day) || day <= 28 || day > 31) return null
  const months: number[] = []
  for (let m = 1; m <= 12; m += 1) {
    // 2027 is a common year: February has 28 days, so the 29th counts as missing here and
    // `leapSensitive` carries the nuance rather than the month list pretending to be absolute.
    if (daysInMonth(2027, m) < day) months.push(m)
  }
  return { day, months, leapSensitive: day === 29 }
}

// ---------------------------------------------------------------------------------------------
// Validation. Each issue names the RFC constraint it enforces, because "invalid" on its own sends
// the reader to the spec anyway.
// ---------------------------------------------------------------------------------------------

export interface RecurrenceIssue {
  field: "interval" | "byDay" | "byMonthDay" | "byMonth" | "bySetPos" | "count" | "until"
  message: string
}

export function recurrenceIssues(rule: RecurrenceRule): RecurrenceIssue[] {
  const issues: RecurrenceIssue[] = []
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    issues.push({ field: "interval", message: "Interval must be a whole number of 1 or more." })
  }
  if (rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") {
    if (rule.byDay.some((d) => d.ordinal !== undefined)) {
      issues.push({
        field: "byDay",
        message: "A numbered weekday such as “2nd Tuesday” is only allowed when repeating monthly or yearly.",
      })
    }
  }
  for (const entry of rule.byDay) {
    if (entry.ordinal !== undefined && (entry.ordinal === 0 || Math.abs(entry.ordinal) > 53)) {
      issues.push({ field: "byDay", message: "A weekday’s position must be between 1 and 53, or -1 and -53." })
      break
    }
  }
  if (rule.freq === "WEEKLY" && rule.byMonthDay.length) {
    issues.push({ field: "byMonthDay", message: "A day of the month cannot be set on a weekly rule." })
  }
  for (const day of rule.byMonthDay) {
    if (day === 0 || Math.abs(day) > 31) {
      issues.push({ field: "byMonthDay", message: "A day of the month must be 1 to 31, or -1 to -31." })
      break
    }
  }
  for (const month of rule.byMonth) {
    if (month < 1 || month > 12) {
      issues.push({ field: "byMonth", message: "A month must be 1 to 12." })
      break
    }
  }
  if (rule.bySetPos.length && !rule.byDay.length && !rule.byMonthDay.length && !rule.byMonth.length) {
    issues.push({
      field: "bySetPos",
      message: "A position such as “the last one” needs something to count, so it cannot be the only rule.",
    })
  }
  for (const pos of rule.bySetPos) {
    if (pos === 0 || Math.abs(pos) > 366) {
      issues.push({ field: "bySetPos", message: "A position must be 1 to 366, or -1 to -366." })
      break
    }
  }
  if (rule.count !== null && rule.until !== null) {
    issues.push({
      field: "count",
      message: "A rule can end after a number of times or on a date, not both.",
    })
  }
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1)) {
    issues.push({ field: "count", message: "A total must be a whole number of 1 or more." })
  }
  if (rule.until !== null && !parseDay(rule.until)) {
    issues.push({ field: "until", message: "An end date must be a real date, as YYYY-MM-DD." })
  }
  return issues
}

// ---------------------------------------------------------------------------------------------
// Serialising. The output is an RRULE value — `FREQ=…;…` — with no `RRULE:` prefix unless asked,
// because it is normally handed to a library or concatenated into a VEVENT by the caller.
// ---------------------------------------------------------------------------------------------

export interface FormatRRuleOptions {
  /**
   * How `UNTIL` is written, and the one thing this component genuinely cannot decide for you.
   *
   * RFC 5545 ties it to `DTSTART`: `UNTIL` "MUST have the same value type as the DTSTART property",
   * and when `DTSTART` is a date-time with a `TZID` — the normal case for anything with a clock time
   * — "the UNTIL rule part MUST be specified as a date with UTC time". This component edits a
   * calendar day and does not own `DTSTART`, so it cannot know whether to emit `20261231` or
   * `20261231T140000Z`, and the conversion from "the last day I want" to an instant in UTC needs the
   * zone and the hour, both of which live outside here.
   *
   * `"date"` (the default) is right when `DTSTART` is a `VALUE=DATE` — an all-day series.
   * `"utc-end-of-day"` emits `T235959Z`, which is right when the series has a clock time *and* runs
   * in UTC, and is wrong by up to a day for a zone far from it: in UTC+13 the last local day is
   * already over, and in UTC-10 a 23:59:59Z cut-off lands mid-afternoon and includes a day the
   * person did not ask for. Pass a function to do it properly with the zone you have.
   */
  untilForm?: "date" | "utc-end-of-day" | ((day: string) => string)
  /** Prefix the result with `RRULE:`. Off by default. */
  prefix?: boolean
}

function formatByDay(entries: ByDay[]): string {
  return entries.map((d) => `${d.ordinal !== undefined ? d.ordinal : ""}${d.weekday}`).join(",")
}

export function formatRRule(rule: RecurrenceRule, options: FormatRRuleOptions = {}): string {
  const parts: string[] = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  // Emitted only when it is not the RFC default, because WKST=MO on every rule is noise that
  // readers then wonder about. It changes results for weekly rules with an interval above 1.
  if (rule.weekStart !== "MO") parts.push(`WKST=${rule.weekStart}`)
  if (rule.byMonth.length) parts.push(`BYMONTH=${uniqueSorted(rule.byMonth).join(",")}`)
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${uniqueSorted(rule.byMonthDay).join(",")}`)
  if (rule.byDay.length) parts.push(`BYDAY=${formatByDay(dedupeByDay(rule.byDay))}`)
  if (rule.bySetPos.length) parts.push(`BYSETPOS=${uniqueSorted(rule.bySetPos).join(",")}`)
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`)
  else if (rule.until !== null) {
    const day = parseDay(rule.until)
    if (day) {
      const compact = formatDay(day).replace(/-/g, "")
      const form = options.untilForm ?? "date"
      parts.push(
        `UNTIL=${
          typeof form === "function"
            ? form(formatDay(day))
            : form === "utc-end-of-day"
              ? `${compact}T235959Z`
              : compact
        }`,
      )
    }
  }
  return `${options.prefix ? "RRULE:" : ""}${parts.join(";")}`
}

// ---------------------------------------------------------------------------------------------
// Parsing. The job here is to round-trip the rules this editor can show and to *refuse* the rest
// out loud, because the usual failure of a recurrence form is not a crash — it is being bolted onto
// data written by a real calendar and quietly simplifying a rule the first time somebody opens the
// form to change the end date.
// ---------------------------------------------------------------------------------------------

/** A rule part this editor understands but cannot edit. The caller decides what to do about it. */
export interface UnsupportedPart {
  name: string
  value: string
  reason: string
}

export type ParsedRRule =
  | { ok: true; rule: RecurrenceRule; unsupported: UnsupportedPart[] }
  | { ok: false; error: string }

const EDITABLE_FREQ = new Set<string>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
const CLOCK_FREQ = new Set(["SECONDLY", "MINUTELY", "HOURLY"])

const UNSUPPORTED_REASONS: Record<string, string> = {
  BYWEEKNO: "week-of-the-year rules are not editable here",
  BYYEARDAY: "day-of-the-year rules are not editable here",
  BYHOUR: "times of day belong to DTSTART, not to this editor",
  BYMINUTE: "times of day belong to DTSTART, not to this editor",
  BYSECOND: "times of day belong to DTSTART, not to this editor",
  // RFC 7529's answer to the month-end question: SKIP=BACKWARD is the standardised way to ask for
  // "the 31st means the 30th in April". It is recognised here so that a rule carrying it is not
  // mistaken for a plain BYMONTHDAY rule and stripped of the very part that made it clamp.
  RSCALE: "a non-Gregorian calendar scale (RFC 7529) is not editable here",
  SKIP: "RFC 7529 month-end clamping is not editable here; this editor offers “last day” instead",
}

function parseNumberList(value: string): number[] | null {
  const out: number[] = []
  for (const token of value.split(",")) {
    if (!/^[+-]?\d{1,3}$/.test(token.trim())) return null
    out.push(Number(token.trim()))
  }
  return out
}

function parseByDayList(value: string): ByDay[] | null {
  const out: ByDay[] = []
  for (const raw of value.split(",")) {
    const token = raw.trim().toUpperCase()
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token)
    if (!m) return null
    out.push(m[1] === undefined ? { weekday: m[2] as Weekday } : { weekday: m[2] as Weekday, ordinal: Number(m[1]) })
  }
  return out
}

/** Reads the `UNTIL` value in any of its three legal shapes back to a calendar day. */
function parseUntil(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value.trim())
  if (!m) return null
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }
  return isValidDay(day) ? formatDay(day) : null
}

export function parseRRule(text: string): ParsedRRule {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "The rule is empty." }
  const body = text.trim().replace(/^RRULE:/i, "")
  const rule = defaultRecurrence()
  const unsupported: UnsupportedPart[] = []
  let sawFreq = false

  for (const segment of body.split(";")) {
    if (segment.trim() === "") continue
    const eq = segment.indexOf("=")
    if (eq < 1) return { ok: false, error: `“${segment}” is not a NAME=VALUE pair.` }
    const name = segment.slice(0, eq).trim().toUpperCase()
    const value = segment.slice(eq + 1).trim()

    if (name === "FREQ") {
      const freq = value.toUpperCase()
      if (CLOCK_FREQ.has(freq)) {
        return { ok: false, error: `FREQ=${freq} repeats within a day, which this editor does not cover.` }
      }
      if (!EDITABLE_FREQ.has(freq)) return { ok: false, error: `FREQ=${value} is not a frequency.` }
      rule.freq = freq as Frequency
      sawFreq = true
      continue
    }
    if (name === "INTERVAL") {
      const n = Number(value)
      if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1) {
        return { ok: false, error: `INTERVAL=${value} is not a positive whole number.` }
      }
      rule.interval = n
      continue
    }
    if (name === "WKST") {
      const code = value.toUpperCase()
      if (weekdayIndex(code as Weekday) < 0) return { ok: false, error: `WKST=${value} is not a weekday.` }
      rule.weekStart = code as Weekday
      continue
    }
    if (name === "COUNT") {
      const n = Number(value)
      if (!/^\d+$/.test(value) || n < 1) return { ok: false, error: `COUNT=${value} is not a positive whole number.` }
      rule.count = n
      continue
    }
    if (name === "UNTIL") {
      const day = parseUntil(value)
      if (!day) return { ok: false, error: `UNTIL=${value} is not a date.` }
      rule.until = day
      continue
    }
    if (name === "BYDAY") {
      const list = parseByDayList(value)
      if (!list) return { ok: false, error: `BYDAY=${value} is not a list of weekdays.` }
      rule.byDay = dedupeByDay(list)
      continue
    }
    if (name === "BYMONTHDAY" || name === "BYMONTH" || name === "BYSETPOS") {
      const list = parseNumberList(value)
      if (!list) return { ok: false, error: `${name}=${value} is not a list of numbers.` }
      if (name === "BYMONTHDAY") rule.byMonthDay = uniqueSorted(list)
      else if (name === "BYMONTH") rule.byMonth = uniqueSorted(list)
      else rule.bySetPos = uniqueSorted(list)
      continue
    }
    unsupported.push({
      name,
      value,
      reason: UNSUPPORTED_REASONS[name] ?? "this rule part is not editable here",
    })
  }

  if (!sawFreq) return { ok: false, error: "A rule must have a FREQ." }
  // Both present is a rule no calendar agrees on, so it is refused rather than resolved — picking
  // one here would be this component deciding which of the two somebody meant.
  if (rule.count !== null && rule.until !== null) {
    return { ok: false, error: "The rule has both COUNT and UNTIL, which RFC 5545 forbids." }
  }
  return { ok: true, rule, unsupported }
}

// ---------------------------------------------------------------------------------------------
// Reading it back in words. Without this the person has built a rule they cannot check: an RRULE
// string is not a sentence, and "did I pick the second Monday or the 2nd?" is exactly the mistake
// the editor is supposed to prevent.
// ---------------------------------------------------------------------------------------------

export interface RecurrenceLabels {
  weekdays: Record<Weekday, string>
  weekdaysShort: Record<Weekday, string>
  months: string[]
  /** `first`…`fifth`, then `last`, used for a numbered weekday. */
  positions: { first: string; second: string; third: string; fourth: string; fifth: string; last: string }
  frequency: Record<Frequency, { every: string; plural: string }>
  lastDayOfMonth: string
  /** Turns `15` into `15th`. Replace for languages that do not work that way. */
  ordinalDay: (day: number) => string
  /** Turns `2026-12-31` into something readable. */
  formatDate: (day: string) => string
  on: string
  inMonth: string
  and: string
  until: string
  /** `(n) => "10 times"`. */
  times: (count: number) => string
  forever: string
}

function englishOrdinal(day: number): string {
  const abs = Math.abs(day)
  const suffix =
    abs % 100 >= 11 && abs % 100 <= 13 ? "th" : abs % 10 === 1 ? "st" : abs % 10 === 2 ? "nd" : abs % 10 === 3 ? "rd" : "th"
  return `${abs}${suffix}`
}

export const defaultRecurrenceLabels: RecurrenceLabels = {
  weekdays: {
    SU: "Sunday",
    MO: "Monday",
    TU: "Tuesday",
    WE: "Wednesday",
    TH: "Thursday",
    FR: "Friday",
    SA: "Saturday",
  },
  weekdaysShort: { SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat" },
  months: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  positions: { first: "first", second: "second", third: "third", fourth: "fourth", fifth: "fifth", last: "last" },
  frequency: {
    DAILY: { every: "Every day", plural: "days" },
    WEEKLY: { every: "Every week", plural: "weeks" },
    MONTHLY: { every: "Every month", plural: "months" },
    YEARLY: { every: "Every year", plural: "years" },
  },
  lastDayOfMonth: "last day of the month",
  ordinalDay: englishOrdinal,
  // Deliberately not Intl.DateTimeFormat. A locale-dependent string renders one way on the server
  // and another in the browser, which React reports as a hydration mismatch; and the ICU data a
  // runtime ships with is not guaranteed to match the next one's. Replace this to localise.
  formatDate: (day: string) => {
    const parsed = parseDay(day)
    if (!parsed) return day
    return `${parsed.d} ${defaultRecurrenceLabels.months[parsed.m - 1]} ${parsed.y}`
  },
  on: "on",
  inMonth: "in",
  and: "and",
  until: "until",
  times: (count: number) => `${count} ${count === 1 ? "time" : "times"}`,
  forever: "with no end date",
}

function joinList(items: string[], and: string): string {
  if (items.length <= 1) return items[0] ?? ""
  if (items.length === 2) return `${items[0]} ${and} ${items[1]}`
  return `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`
}

function positionWord(ordinal: number, labels: RecurrenceLabels): string {
  if (ordinal < 0) return labels.positions.last
  return (
    [labels.positions.first, labels.positions.second, labels.positions.third, labels.positions.fourth, labels.positions.fifth][
      ordinal - 1
    ] ?? labels.ordinalDay(ordinal)
  )
}

/** The rule as a sentence. Pair it with {@link nextOccurrences} — words plus dates catch more. */
export function describeRecurrence(rule: RecurrenceRule, labels: RecurrenceLabels = defaultRecurrenceLabels): string {
  const freq = labels.frequency[rule.freq]
  let head = rule.interval > 1 ? `Every ${rule.interval} ${freq.plural}` : freq.every

  if (rule.freq === "WEEKLY" && rule.byDay.length) {
    head += ` ${labels.on} ${joinList(
      rule.byDay.map((d) => labels.weekdays[d.weekday]),
      labels.and,
    )}`
  }

  if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
    if (rule.freq === "YEARLY" && rule.byMonth.length) {
      head += ` ${labels.inMonth} ${joinList(
        rule.byMonth.map((m) => labels.months[m - 1] ?? String(m)),
        labels.and,
      )}`
    }
    if (rule.byMonthDay.length) {
      const words = rule.byMonthDay.map((d) =>
        d === -1 ? labels.lastDayOfMonth : d < 0 ? `${labels.ordinalDay(-d)} from the end` : labels.ordinalDay(d),
      )
      head += ` ${labels.on} the ${joinList(words, labels.and)}`
    } else if (rule.byDay.length) {
      const words = rule.byDay.map((d) =>
        d.ordinal === undefined
          ? labels.weekdays[d.weekday]
          : `${positionWord(d.ordinal, labels)} ${labels.weekdays[d.weekday]}`,
      )
      head += ` ${labels.on} the ${joinList(words, labels.and)}`
    }
  }

  if (rule.count !== null) return `${head}, ${labels.times(rule.count)}`
  if (rule.until !== null) return `${head}, ${labels.until} ${labels.formatDate(rule.until)}`
  return head
}

// ---------------------------------------------------------------------------------------------
// Generating the next dates. This exists for checking: words can be read two ways, and dates
// cannot. It is also the only thing that makes the skip rule visible before it costs somebody a
// missed invoice.
// ---------------------------------------------------------------------------------------------

export interface OccurrenceResult {
  /** Calendar days, ascending. */
  days: string[]
  /**
   * Whether `DTSTART` is itself one of the occurrences.
   *
   * False means the rule and the start date disagree — a series starting on the 15th that repeats
   * on the 29th, or starting on a Monday that repeats on weekends. RFC 5545 calls that combination
   * "not synchronized with the recurrence rule" and declares the resulting set *undefined*, so
   * every implementation is free to resolve it differently and they do not all agree. Surfacing it
   * is the only honest option: the caller can show "your start date is not one of the dates" rather
   * than having this component pick a reading of an undefined rule and hide the choice.
   */
  startIsOccurrence: boolean
  /** True when the series actually ran out — `COUNT` reached or past `UNTIL` — rather than hitting `limit`. */
  complete: boolean
  /**
   * Instances the rule asked for and RFC 5545 requires be ignored, within the periods scanned.
   *
   * A February 30th, or a fifth Friday in a month with four. Non-zero here is the number that tells
   * a person their "monthly" rule is not monthly, and it is why this is reported rather than being
   * silently absorbed the way a clamping implementation absorbs it.
   */
  skipped: number
}

/** Every day in `y`/`m` that the rule's `BY*` parts pick out, plus how many it asked for and missed. */
function candidatesInMonth(
  y: number,
  m: number,
  rule: RecurrenceRule,
  start: PlainDay,
): { days: PlainDay[]; skipped: number } {
  const length = daysInMonth(y, m)
  const days: PlainDay[] = []
  let skipped = 0

  if (rule.byMonthDay.length) {
    for (const spec of rule.byMonthDay) {
      const d = spec > 0 ? spec : length + spec + 1
      if (d >= 1 && d <= length) days.push({ y, m, d })
      else skipped += 1
    }
  } else if (rule.byDay.length) {
    for (const entry of rule.byDay) {
      const target = weekdayIndex(entry.weekday)
      if (entry.ordinal === undefined) {
        const first = 1 + ((target - dayOfWeek({ y, m, d: 1 }) + 7) % 7)
        for (let d = first; d <= length; d += 7) days.push({ y, m, d })
        continue
      }
      let d: number
      if (entry.ordinal > 0) {
        const first = 1 + ((target - dayOfWeek({ y, m, d: 1 }) + 7) % 7)
        d = first + (entry.ordinal - 1) * 7
      } else {
        const last = length - ((dayOfWeek({ y, m, d: length }) - target + 7) % 7)
        d = last + (entry.ordinal + 1) * 7
      }
      // A fifth Monday exists in some months and not others. RFC 5545 is clear that the months
      // without one produce nothing rather than falling back to the fourth.
      if (d >= 1 && d <= length) days.push({ y, m, d })
      else skipped += 1
    }
  } else {
    // No BY* part: the day comes from DTSTART, which is where a monthly rule's day lives when the
    // rule does not spell it out — and a 31st start date skips the short months exactly the same way.
    if (start.d <= length) days.push({ y, m, d: start.d })
    else skipped += 1
  }

  return { days, skipped }
}

function applySetPos(days: PlainDay[], bySetPos: number[]): PlainDay[] {
  if (!bySetPos.length) return days
  const picked: PlainDay[] = []
  for (const pos of bySetPos) {
    const index = pos > 0 ? pos - 1 : days.length + pos
    const day = days[index]
    if (day) picked.push(day)
  }
  return picked
}

function sortDays(days: PlainDay[]): PlainDay[] {
  const seen = new Set<number>()
  return days
    .filter((d) => {
      const n = dayNumber(d)
      if (seen.has(n)) return false
      seen.add(n)
      return true
    })
    .sort(compareDays)
}

/**
 * The first `limit` days of the series.
 *
 * `DTSTART` appears when, and only when, the rule actually generates it. That is the behaviour of
 * rrule.js — the implementation most calendars and most of this ecosystem are built on — and it was
 * arrived at by comparison against it rather than from the spec, because the spec does not settle
 * it: RFC 5545 says a `DTSTART` "not synchronized with the recurrence rule" produces an *undefined*
 * recurrence set. Matching the reference matters more than being defensibly different, because the
 * whole value of a preview is that the dates it shows are the dates the caller's calendar will
 * later produce. {@link OccurrenceResult.startIsOccurrence} reports which case you are in.
 *
 * `COUNT` counts what this emits, so `COUNT=1` is one date — and because RFC 5545 requires that an
 * instance falling on an invalid date "MUST NOT be counted as part of the recurrence set", a
 * `COUNT` paired with a day that does not exist every month runs far longer in wall-clock time than
 * it reads. {@link OccurrenceResult.skipped} is how that becomes visible.
 *
 * Periods are stepped rather than days, and the scan is bounded: a rule that can never match at all
 * — `BYMONTH=2` with `BYMONTHDAY=30` — ends empty rather than spinning. Nothing here reads the
 * clock, so the same arguments always give the same answer.
 */
export function nextOccurrences(
  rule: RecurrenceRule,
  dtstart: PlainDay | string,
  limit = 5,
  options: { maxPeriods?: number } = {},
): OccurrenceResult {
  const start = typeof dtstart === "string" ? parseDay(dtstart) : dtstart
  const maxPeriods = options.maxPeriods ?? 600
  const empty = { days: [], complete: false, skipped: 0, startIsOccurrence: false }
  // An impossible start date is refused rather than normalised. `new Date(2026, 1, 29)` is 1 March
  // 2026, and a component that accepted it would move somebody's series by a day without a word.
  if (!start || !isValidDay(start) || limit < 1) return empty
  if (recurrenceIssues(rule).length) return empty

  const untilDay = rule.until ? parseDay(rule.until) : null
  const monthFilter = rule.byMonth.length ? new Set(rule.byMonth) : null
  const out: PlainDay[] = []
  let skipped = 0
  let complete = false

  const weekStartOffset = (dayOfWeek(start) - weekdayIndex(rule.weekStart) + 7) % 7
  const alignedWeekStart = addDays(start, -weekStartOffset)
  const weeklyCodes = rule.byDay.length ? rule.byDay.map((d) => d.weekday) : [WEEKDAYS[dayOfWeek(start)]]

  for (let period = 0; !complete && out.length < limit && period < maxPeriods; period += 1) {
    let candidates: PlainDay[] = []

    if (rule.freq === "DAILY") {
      candidates = [addDays(start, period * rule.interval)]
    } else if (rule.freq === "WEEKLY") {
      const base = addDays(alignedWeekStart, period * rule.interval * 7)
      candidates = weeklyCodes.map((code) =>
        addDays(base, (weekdayIndex(code) - weekdayIndex(rule.weekStart) + 7) % 7),
      )
    } else if (rule.freq === "MONTHLY") {
      const month = addMonths({ y: start.y, m: start.m, d: 1 }, period * rule.interval)
      const found = candidatesInMonth(month.y, month.m, rule, start)
      skipped += found.skipped
      candidates = applySetPos(sortDays(found.days), rule.bySetPos)
    } else {
      const year = start.y + period * rule.interval
      const months = rule.byMonth.length ? uniqueSorted(rule.byMonth) : [start.m]
      const collected: PlainDay[] = []
      for (const m of months) {
        if (m < 1 || m > 12) continue
        const found = candidatesInMonth(year, m, rule, start)
        skipped += found.skipped
        collected.push(...found.days)
      }
      // BYSETPOS counts within one interval of the rule, so for a yearly rule the whole year is
      // the set — not each month inside it.
      candidates = applySetPos(sortDays(collected), rule.bySetPos)
    }

    for (const candidate of sortDays(candidates)) {
      if (rule.freq !== "YEARLY" && monthFilter && !monthFilter.has(candidate.m)) continue
      if (compareDays(candidate, start) < 0) continue
      if (untilDay && compareDays(candidate, untilDay) > 0) {
        complete = true
        break
      }
      out.push(candidate)
      if (rule.count !== null && out.length >= rule.count) {
        complete = true
        break
      }
      if (out.length >= limit) break
    }
  }

  const days = out.map(formatDay)
  return { days, complete, skipped, startIsOccurrence: days[0] === formatDay(start) }
}

// ---------------------------------------------------------------------------------------------
// The control.
// ---------------------------------------------------------------------------------------------

export interface RecurrenceInputLabels extends RecurrenceLabels {
  legend: string
  description: string
  every: string
  frequencyLabel: string
  intervalLabel: string
  weekdaysLegend: string
  monthlyLegend: string
  monthLabel: string
  modeDayOfMonth: string
  modeNthWeekday: string
  modeLastDay: string
  dayOfMonthLabel: string
  positionLabel: string
  weekdayLabel: string
  endingLegend: string
  endingNever: string
  endingCount: string
  endingUntil: string
  countLabel: string
  untilLabel: string
  summaryLabel: string
  previewLabel: string
  previewMore: string
  previewComplete: string
  skipNotice: (skip: MonthDaySkip, monthNames: string[]) => string
  droppedNotice: (dropped: string[]) => string
  unsyncedNotice: (dtstart: string) => string
}

export const defaultRecurrenceInputLabels: RecurrenceInputLabels = {
  ...defaultRecurrenceLabels,
  legend: "Repeats",
  description: "How often this happens, and when it stops.",
  every: "Every",
  frequencyLabel: "Frequency",
  intervalLabel: "Repeat every",
  weekdaysLegend: "On these days",
  monthlyLegend: "On",
  monthLabel: "Month",
  modeDayOfMonth: "Day of the month",
  modeNthWeekday: "Weekday of the month",
  modeLastDay: "Last day of the month",
  dayOfMonthLabel: "Day",
  positionLabel: "Which one",
  weekdayLabel: "Weekday",
  endingLegend: "Ends",
  endingNever: "Never",
  endingCount: "After a number of times",
  endingUntil: "On a date",
  countLabel: "Times",
  untilLabel: "End date",
  summaryLabel: "In words",
  previewLabel: "Next dates",
  previewMore: "…",
  previewComplete: "That is all of them.",
  skipNotice: (skip, monthNames) =>
    `The ${englishOrdinal(skip.day)} does not exist in ${skip.months
      .map((m) => monthNames[m - 1])
      .join(", ")}${skip.leapSensitive ? " outside leap years" : ""}, so those months are skipped, and a skipped date does not count towards a total. Choose “last day of the month” instead if you mean the end of every month.`,
  droppedNotice: (dropped) => `Changing the frequency cleared: ${dropped.join(", ")}.`,
  unsyncedNotice: (dtstart) =>
    `The start date (${defaultRecurrenceLabels.formatDate(dtstart)}) does not match this rule, so it is not one of the dates below.`,
}

export interface RecurrenceInputProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange" | "value" | "defaultValue"> {
  /** Controlled rule. Pair with {@link onValueChange}. */
  value?: RecurrenceRule
  /** Uncontrolled starting rule. */
  defaultValue?: RecurrenceRule
  onValueChange?: (rule: RecurrenceRule) => void
  /**
   * The series' start date, `YYYY-MM-DD` — `DTSTART`, which this component reads and never owns.
   *
   * It is needed for three separate things and guessing it is wrong for all three: it seeds a field
   * that becomes relevant when the frequency changes, it is the first occurrence in the preview, and
   * it is the day an unqualified monthly rule repeats on. Omit it and the preview is hidden rather
   * than being computed from today's date — a preview that moves when the page is reloaded is worse
   * than none.
   */
  dtstart?: string
  /** Posts the RRULE value with a plain form submit or a server action. */
  name?: string
  /** How many dates the preview shows. */
  previewCount?: number
  /** Passed through to {@link formatRRule} for the emitted string and the `name` field. */
  formatOptions?: FormatRRuleOptions
  labels?: Partial<RecurrenceInputLabels>
  disabled?: boolean
  classNames?: {
    fieldset?: string
    row?: string
    control?: string
    summary?: string
    notice?: string
  }
}

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
const NUMBER_CLASS = `${SELECT_CLASS} w-16 tabular-nums`

export function RecurrenceInput({
  value,
  defaultValue,
  onValueChange,
  dtstart,
  name,
  previewCount = 5,
  formatOptions,
  labels: labelOverrides,
  disabled = false,
  classNames,
  className,
  ...rest
}: RecurrenceInputProps) {
  const labels = React.useMemo(
    () => ({ ...defaultRecurrenceInputLabels, ...labelOverrides }),
    [labelOverrides],
  )
  const [internal, setInternal] = React.useState<RecurrenceRule>(
    () => defaultValue ?? defaultRecurrence(),
  )
  const isControlled = value !== undefined
  const rule = isControlled ? value : internal
  const [dropped, setDropped] = React.useState<string[]>([])
  const reactId = React.useId()

  const commit = React.useCallback(
    (next: RecurrenceRule) => {
      // Always set local state, controlled or not. A controlled parent that re-renders with the same
      // object is then still consistent, and an uncontrolled one does not need a second path.
      setInternal(next)
      onValueChange?.(next)
    },
    [onValueChange],
  )

  const seed = dtstart ?? null
  const issues = React.useMemo(() => recurrenceIssues(rule), [rule])
  const rrule = React.useMemo(() => formatRRule(rule, formatOptions), [rule, formatOptions])
  const sentence = React.useMemo(() => describeRecurrence(rule, labels), [rule, labels])
  const preview = React.useMemo(
    () => (seed ? nextOccurrences(rule, seed, Math.max(1, previewCount)) : null),
    [rule, seed, previewCount],
  )

  const mode = monthlyMode(rule)
  const skip = React.useMemo(() => {
    if (rule.freq !== "MONTHLY" && rule.freq !== "YEARLY") return null
    if (rule.freq === "YEARLY") return null
    const day = rule.byMonthDay.find((d) => d > 0)
    return day === undefined ? null : monthDaySkip(day)
  }, [rule])

  const ending = endingOf(rule)
  const id = (part: string) => `${reactId}-${part}`

  const onFrequency = (freq: Frequency) => {
    setDropped(frequencyChangeDrops(rule, freq))
    commit(changeFrequency(rule, freq, seed))
  }

  return (
    <div className={cn("flex w-full flex-col gap-3 text-sm", className)} {...rest}>
      <fieldset
        disabled={disabled}
        className={cn("flex flex-col gap-3 rounded-lg border border-border p-3", classNames?.fieldset)}
      >
        <legend className="px-1 text-xs font-medium text-muted-foreground">{labels.legend}</legend>

        <div className={cn("flex flex-wrap items-center gap-2", classNames?.row)}>
          <label htmlFor={id("interval")} className="text-muted-foreground">
            {labels.every}
          </label>
          <input
            id={id("interval")}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={rule.interval}
            aria-label={labels.intervalLabel}
            aria-invalid={issues.some((i) => i.field === "interval") || undefined}
            className={cn(NUMBER_CLASS, classNames?.control)}
            onChange={(event) => {
              const n = Number(event.target.value)
              commit({ ...rule, interval: Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1 })
            }}
          />
          <select
            aria-label={labels.frequencyLabel}
            value={rule.freq}
            className={cn(SELECT_CLASS, classNames?.control)}
            onChange={(event) => onFrequency(event.target.value as Frequency)}
          >
            {(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const).map((freq) => (
              <option key={freq} value={freq}>
                {labels.frequency[freq].plural}
              </option>
            ))}
          </select>
        </div>

        {rule.freq === "WEEKLY" ? (
          <div role="group" aria-label={labels.weekdaysLegend} className="flex flex-wrap gap-1">
            {WEEKDAYS.map((code) => {
              const on = rule.byDay.some((d) => d.weekday === code)
              const isLast = on && rule.byDay.length === 1
              return (
                <button
                  key={code}
                  type="button"
                  aria-pressed={on}
                  // The last checked weekday is refused, not removed, and says why rather than
                  // looking inert: `aria-disabled` keeps the tab stop and the announcement.
                  aria-disabled={isLast || undefined}
                  aria-describedby={isLast ? id("weekday-floor") : undefined}
                  onClick={() => {
                    if (isLast) return
                    commit(toggleWeekday(rule, code))
                  }}
                  className={cn(
                    "h-8 min-w-10 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    isLast && "cursor-not-allowed",
                  )}
                >
                  {labels.weekdaysShort[code]}
                </button>
              )
            })}
            <span id={id("weekday-floor")} className="sr-only">
              At least one day has to stay selected.
            </span>
          </div>
        ) : null}

        {rule.freq === "YEARLY" ? (
          <div className={cn("flex flex-wrap items-center gap-2", classNames?.row)}>
            <label htmlFor={id("month")} className="text-muted-foreground">
              {labels.monthLabel}
            </label>
            <select
              id={id("month")}
              value={rule.byMonth[0] ?? 1}
              className={cn(SELECT_CLASS, classNames?.control)}
              onChange={(event) => commit({ ...rule, byMonth: [Number(event.target.value)] })}
            >
              {labels.months.map((label, index) => (
                <option key={label} value={index + 1}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {rule.freq === "MONTHLY" || rule.freq === "YEARLY" ? (
          <div role="radiogroup" aria-label={labels.monthlyLegend} className="flex flex-col gap-2">
            {(
              [
                ["dayOfMonth", labels.modeDayOfMonth],
                ["nthWeekday", labels.modeNthWeekday],
                ["lastDay", labels.modeLastDay],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={id("mode")}
                    checked={mode === key}
                    onChange={() => commit(setMonthlyMode(rule, key, seed))}
                    className="size-4 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span className={mode === key ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                </label>

                {key === "dayOfMonth" && mode === "dayOfMonth" ? (
                  <input
                    type="number"
                    min={1}
                    max={31}
                    step={1}
                    inputMode="numeric"
                    aria-label={labels.dayOfMonthLabel}
                    value={rule.byMonthDay.find((d) => d > 0) ?? 1}
                    className={cn(NUMBER_CLASS, classNames?.control)}
                    onChange={(event) => {
                      const n = Number(event.target.value)
                      if (!Number.isFinite(n)) return
                      commit({ ...rule, byMonthDay: [Math.min(31, Math.max(1, Math.floor(n)))], byDay: [] })
                    }}
                  />
                ) : null}

                {key === "nthWeekday" && mode === "nthWeekday" ? (
                  <>
                    <select
                      aria-label={labels.positionLabel}
                      value={rule.byDay[0]?.ordinal ?? 1}
                      className={cn(SELECT_CLASS, classNames?.control)}
                      onChange={(event) =>
                        commit({
                          ...rule,
                          byMonthDay: [],
                          byDay: [
                            {
                              weekday: rule.byDay[0]?.weekday ?? "MO",
                              ordinal: Number(event.target.value),
                            },
                          ],
                        })
                      }
                    >
                      {([1, 2, 3, 4, 5, -1] as const).map((ordinal) => (
                        <option key={ordinal} value={ordinal}>
                          {positionWord(ordinal, labels)}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={labels.weekdayLabel}
                      value={rule.byDay[0]?.weekday ?? "MO"}
                      className={cn(SELECT_CLASS, classNames?.control)}
                      onChange={(event) =>
                        commit({
                          ...rule,
                          byMonthDay: [],
                          byDay: [
                            {
                              weekday: event.target.value as Weekday,
                              ordinal: rule.byDay[0]?.ordinal ?? 1,
                            },
                          ],
                        })
                      }
                    >
                      {WEEKDAYS.map((code) => (
                        <option key={code} value={code}>
                          {labels.weekdays[code]}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        <div role="radiogroup" aria-label={labels.endingLegend} className="flex flex-col gap-2">
          {(
            [
              ["never", labels.endingNever],
              ["count", labels.endingCount],
              ["until", labels.endingUntil],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name={id("ending")}
                  checked={ending === key}
                  onChange={() =>
                    commit(setEnding(rule, key, key === "count" ? (rule.count ?? 10) : (rule.until ?? seed)))
                  }
                  className="size-4 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className={ending === key ? "text-foreground" : "text-muted-foreground"}>{label}</span>
              </label>
              {key === "count" && ending === "count" ? (
                <input
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  aria-label={labels.countLabel}
                  aria-invalid={issues.some((i) => i.field === "count") || undefined}
                  value={rule.count ?? 1}
                  className={cn(NUMBER_CLASS, classNames?.control)}
                  onChange={(event) => commit(setEnding(rule, "count", Number(event.target.value)))}
                />
              ) : null}
              {key === "until" && ending === "until" ? (
                <input
                  type="date"
                  aria-label={labels.untilLabel}
                  aria-invalid={issues.some((i) => i.field === "until") || undefined}
                  value={rule.until ?? ""}
                  className={cn(SELECT_CLASS, classNames?.control)}
                  onChange={(event) => commit(setEnding(rule, "until", event.target.value))}
                />
              ) : null}
            </div>
          ))}
        </div>
      </fieldset>

      {skip && skip.months.length ? (
        <p className={cn("text-xs text-muted-foreground", classNames?.notice)}>
          {labels.skipNotice(skip, labels.months)}
        </p>
      ) : null}

      {/* An unsynchronised start date is the other silent one: the rule is valid, the preview is
          populated, and the day the person typed into the start field is simply not in it. */}
      {preview && seed && preview.days.length && !preview.startIsOccurrence ? (
        <p className={cn("text-xs text-muted-foreground", classNames?.notice)}>
          {labels.unsyncedNotice(seed)}
        </p>
      ) : null}

      {issues.length ? (
        <ul className="flex flex-col gap-1 text-xs text-destructive">
          {issues.map((issue) => (
            <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <div className={cn("flex flex-col gap-1 rounded-md bg-muted/50 p-2 text-xs", classNames?.summary)}>
        <span className="text-muted-foreground">{labels.summaryLabel}</span>
        <strong className="font-medium text-foreground">{sentence}</strong>
        {preview && preview.days.length ? (
          <>
            <span className="mt-1 text-muted-foreground">{labels.previewLabel}</span>
            <span className="font-mono text-foreground">
              {preview.days.map((day) => labels.formatDate(day)).join(" · ")}
              {preview.complete ? "" : ` ${labels.previewMore}`}
            </span>
          </>
        ) : null}
      </div>

      {/* Permanently mounted, so a change is announced rather than the region arriving with its own
          text — a live region inserted along with its message is often not read at all. */}
      <span className="sr-only" role="status" aria-live="polite">
        {dropped.length ? `${labels.droppedNotice(dropped)} ` : ""}
        {sentence}
      </span>

      {name ? <input type="hidden" name={name} value={rrule} /> : null}
    </div>
  )
}
