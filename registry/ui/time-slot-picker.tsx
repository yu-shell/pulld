"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One offered slot, as the server hands it over.
 *
 * This component never generates slots. Availability is the server's answer to "what is still free",
 * it depends on other people's bookings, and a component that invented a 9-to-5 grid of half hours
 * would be offering times nobody can have. So `slots` is required and the component only ever
 * arranges, labels and selects what it is given.
 */
export interface TimeSlot {
  /**
   * Stable identity, and what the value is made of. Defaults to the start instant in ISO form, which
   * is unique as long as two slots do not start at the same moment — pass your own id when they can
   * (two rooms, two practitioners, the same half hour).
   */
  id?: string
  /**
   * When the slot starts. A `Date`, epoch milliseconds, or an ISO 8601 string.
   *
   * Carry the offset — `"2026-11-20T09:00:00Z"` or `"2026-11-20T09:00:00+09:00"`. A string without
   * one does not name a moment, and the two offset-less forms are not even read the same way by
   * `Date.parse`: a date-time such as `"2026-11-20T09:00"` is read in the *machine's* zone, while a
   * date alone, `"2026-11-20"`, is read as UTC. Both are accepted here and both are read in this
   * component's `timeZone` instead, so the picker shows the same times on every machine — and both
   * are reported by `slotIssues` so the shape can be fixed at the source rather than relied on.
   */
  start: string | number | Date
  /** When it ends. Same forms as `start`. Takes precedence over `durationMinutes`. */
  end?: string | number | Date
  /** How long it runs, when the end is not spelled out. */
  durationMinutes?: number
  /** Already booked. The slot is still shown and still reachable, so a person can see it existed. */
  taken?: boolean
  /** Short extra text on the slot — "2 left", "Online only", a price. */
  note?: string
  /**
   * Why this slot cannot be taken, in your own words. Shown and announced in place of the built-in
   * reason, so "Held for members until Friday" reaches the person who needs it.
   */
  reason?: string
}

/** Why a slot refuses to be selected. `""` when it is free to take. */
export type SlotBlock = "" | "taken" | "past" | "lead"

/** A slot after parsing, with every label this component will show already computed. */
export interface ResolvedSlot {
  id: string
  /** Start as epoch milliseconds — the one representation that is the same everywhere. */
  start: number
  /** End as epoch milliseconds, or `null` when the caller only gave a start. */
  end: number | null
  /** Length in minutes, or `null` when there is no end to measure to. */
  durationMinutes: number | null
  /** The calendar day this slot starts on, `"YYYY-MM-DD"`, read in the display zone. */
  dayKey: string
  /** The start time as the locale writes it. */
  startLabel: string
  /** The end time as the locale writes it, or `""` with no end. */
  endLabel: string
  /** Shown on the slot: the start alone, or the range when the day mixes lengths. */
  label: string
  /**
   * The zone abbreviation, set only when two slots on the same day would otherwise read alike —
   * which happens for real when the clocks go back and 1:30 comes round twice.
   */
  zoneLabel: string
  /** The end falls on the next calendar day in the display zone. */
  endsNextDay: boolean
  taken: boolean
  /** Starts in the past, measured against the `now` you passed — never against the clock. */
  past: boolean
  /** Starts too soon to be bookable, by `minLeadMinutes`. */
  tooSoon: boolean
  block: SlotBlock
  /** `true` when it can be taken: nothing blocks it. */
  selectable: boolean
  /** Why it is blocked, ready to show — the caller's `reason` when they gave one. */
  reason: string
  note: string
}

/** Why a day has nothing to offer, which is not one message but four. */
export type DayState = "available" | "fullyBooked" | "past" | "empty"

export interface ResolvedDay {
  /** `"YYYY-MM-DD"` in the display zone. */
  key: string
  /** The day as the locale writes it. */
  label: string
  /** The slots to show, in time order. Past ones are left out when `hidePastSlots` is on. */
  slots: ResolvedSlot[]
  /** How many of them can be taken. */
  available: number
  /** How many the caller offered for this day, including any the view is hiding. */
  offered: number
  state: DayState
}

export interface SlotIssue {
  kind:
    | "unparsable-start"
    | "unparsable-end"
    | "no-offset"
    | "backwards"
    | "duplicate-id"
    | "overlap"
    | "bad-day"
    | "lead-without-now"
  /** The slot id, the day string, or `""` for an issue about the call as a whole. */
  subject: string
  message: string
}

export interface ResolvedTimeSlots {
  /** The zone the times are shown in — the one asked for, or the runtime's if that was unusable. */
  timeZone: string
  /** That zone in words, for the caption: "Japan Standard Time". */
  zoneName: string
  days: ResolvedDay[]
  /** Every shown slot id in reading order — what the arrow keys walk. */
  order: string[]
  byId: Record<string, ResolvedSlot>
  /** How many slots can be taken across every day. */
  available: number
}

export interface TimeSlotPickerLabels {
  /** Accessible name for the list of times. */
  list: string
  /** The caption under the picker. Gets the zone in words and the IANA id. */
  timeZoneNote: (zoneName: string, timeZone: string) => string
  /** A day the caller listed with no slots on it at all. */
  dayEmpty: string
  /** A day whose slots are all taken. */
  dayFullyBooked: string
  /** A day whose slots have all been and gone. */
  dayPast: string
  /** Nothing to offer anywhere. */
  nothingAvailable: string
  taken: string
  past: string
  tooSoon: string
  /** The range in an accessible name: start, this word, end. */
  to: string
  endsNextDay: string
  announceSelected: (slot: string) => string
  announceCleared: (slot: string) => string
  announceRefused: (slot: string, reason: string) => string
  announceMax: (max: number) => string
  /** The notice shown when a chosen slot is no longer on offer. */
  lost: (slots: string[]) => string
}

export const defaultTimeSlotPickerLabels: TimeSlotPickerLabels = {
  list: "Available times",
  timeZoneNote: (zoneName, timeZone) => `Times shown in ${zoneName} (${timeZone})`,
  dayEmpty: "No times available",
  dayFullyBooked: "Fully booked",
  dayPast: "These times have passed",
  nothingAvailable: "No times are available.",
  taken: "Already taken",
  past: "This time has passed",
  tooSoon: "Too soon to book",
  to: "to",
  endsNextDay: "ends the next day",
  announceSelected: (slot) => `${slot} selected`,
  announceCleared: (slot) => `${slot} cleared`,
  announceRefused: (slot, reason) => `${slot} cannot be selected: ${reason}`,
  announceMax: (max) => `You can choose at most ${max}`,
  lost: (slots) =>
    slots.length === 1
      ? `${slots[0]} is no longer available. Please choose another time.`
      : `${slots.join(", ")} are no longer available. Please choose other times.`,
}

// A locale fixed to the Gregorian calendar and Latin digits, used for every machine-readable date
// this file builds. Reading the parts under the caller's own locale looks right and is wrong in a
// way nothing downstream can recover from: `th-TH` answers 2569 for 2026, `ja-JP-u-ca-japanese`
// answers 8, `ar-EG` answers ٢٠٢٦, and `fa-IR` answers 1405-08-29 — a different day of a different
// month. The day key has to be the same string for the same day everywhere, because it is what
// groups the slots and what the caller writes in `days`.
const KEY_LOCALE = "en-US-u-ca-gregory-nu-latn"

const MS_PER_MINUTE = 60_000
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** An ISO 8601 date-time that names a moment: it carries `Z` or a numeric offset. */
const ZONED = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i
/** An ISO 8601 date, or date and time, with no zone on it — a wall clock, not a moment. */
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/

function partsOf(fmt: Intl.DateTimeFormat, ms: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of fmt.formatToParts(new Date(ms))) {
    if (part.type !== "literal") out[part.type] = part.value
  }
  return out
}

/**
 * Whether this runtime will accept the zone. An unknown IANA name makes `Intl.DateTimeFormat` throw
 * a `RangeError`, and a picker is not the place to find that out — a typo in a prop would take the
 * whole page down rather than show the times in the wrong zone.
 */
function usableZone(timeZone: string | undefined): string | null {
  if (timeZone === undefined || timeZone === "") return null
  try {
    new Intl.DateTimeFormat(KEY_LOCALE, { timeZone })
    return timeZone
  } catch {
    return null
  }
}

function runtimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * How far the zone is from UTC at that moment, in milliseconds.
 *
 * Read the instant's wall clock in the zone, then read those same fields back as though they were
 * UTC: the difference between the two is the offset. It is the only way to get at an offset for an
 * arbitrary zone and an arbitrary date, and it has to be per-instant rather than per-zone because
 * the answer changes twice a year in most of the world.
 */
function zoneOffsetMs(timeZone: string, ms: number): number {
  const fmt = new Intl.DateTimeFormat(KEY_LOCALE, {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const p = partsOf(fmt, ms)
  // Some runtimes have answered "24" for midnight under `hour12: false`. Current ones answer "00",
  // but a stray 24 here would move a slot a whole day, so it is folded rather than trusted.
  const hour = p.hour === "24" ? 0 : Number(p.hour)
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second)
  )
  return asUtc - ms
}

/**
 * The moment a wall clock names in a zone.
 *
 * Subtracting the offset once is not enough: the offset has to be the one in force at the *answer*,
 * not at the guess, or every slot on the far side of a clock change lands an hour out. One
 * correction pass settles that, because the two offsets differ by at most the size of the jump.
 *
 * The two days a year that have no single answer are resolved rather than refused — an hour that
 * comes round twice takes the first of the two, an hour that never happens takes the instant the
 * clock skipped to. Either way the same input always gives the same output, which is what a server
 * rendering this and a browser hydrating it need from each other.
 */
function instantFromWall(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second)
  const once = wall - zoneOffsetMs(timeZone, wall)
  return wall - zoneOffsetMs(timeZone, once)
}

interface ParsedInstant {
  ms: number
  /** The input named a wall clock with no zone, so the display zone was used to place it. */
  assumed: boolean
}

function parseInstant(input: string | number | Date | undefined, timeZone: string): ParsedInstant | null {
  if (input === undefined || input === null) return null
  if (input instanceof Date) {
    const ms = input.getTime()
    return Number.isFinite(ms) ? { ms, assumed: false } : null
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? { ms: input, assumed: false } : null
  }
  if (typeof input !== "string") return null
  const text = input.trim()
  if (text === "") return null
  if (ZONED.test(text)) {
    const ms = Date.parse(text)
    return Number.isFinite(ms) ? { ms, assumed: false } : null
  }
  const wall = WALL.exec(text)
  if (wall !== null) {
    const month = Number(wall[2])
    const day = Number(wall[3])
    const hour = wall[4] === undefined ? 0 : Number(wall[4])
    const minute = wall[5] === undefined ? 0 : Number(wall[5])
    const second = wall[6] === undefined ? 0 : Number(wall[6])
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null
    }
    return { ms: instantFromWall(timeZone, Number(wall[1]), month, day, hour, minute, second), assumed: true }
  }
  // Anything else — "Nov 20 2026 9am", a locale string — is handed to the engine, which is allowed
  // to read it however it likes. Accepted so a caller is not stuck, with no claim about the zone.
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? { ms, assumed: true } : null
}

function dayKeyOf(timeZone: string, ms: number): string {
  const fmt = new Intl.DateTimeFormat(KEY_LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const p = partsOf(fmt, ms)
  return `${p.year}-${p.month}-${p.day}`
}

function makeTimeFormat(
  locale: string | undefined,
  timeZone: string,
  hour12: boolean | undefined,
  extra?: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { timeZone, hour: "numeric", minute: "2-digit", ...extra }
  if (hour12 !== undefined) options.hour12 = hour12
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    return new Intl.DateTimeFormat(undefined, options)
  }
}

function makeFormat(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(locale, options)
  } catch {
    return new Intl.DateTimeFormat(undefined, options)
  }
}

function zoneWord(
  locale: string | undefined,
  timeZone: string,
  style: "long" | "short",
  ms: number
): string {
  const fmt = makeFormat(locale, { timeZone, timeZoneName: style, hour: "numeric" })
  const found = fmt.formatToParts(new Date(ms)).find((part) => part.type === "timeZoneName")
  return found === undefined ? timeZone : found.value
}

export interface ResolveTimeSlotsOptions {
  slots: TimeSlot[]
  /**
   * Days to show even when they have no slots, as `"YYYY-MM-DD"` in the display zone.
   *
   * Without this a day with nothing free cannot be shown at all — no slot means nothing to derive a
   * day from, and inventing one would be inventing the calendar. Days carrying slots are always
   * shown whether or not they are listed here, because quietly dropping a bookable time is worse
   * than showing a day the caller did not ask for.
   */
  days?: string[]
  /** IANA zone the times are shown in. Defaults to the runtime's, and says which in the caption. */
  timeZone?: string
  locale?: string
  hour12?: boolean
  /**
   * The moment "now" is measured from. Left out, nothing is past and nothing is too soon.
   *
   * It is a prop and not a clock reading on purpose: a component that reads `Date.now()` renders
   * differently on the server and in the browser a moment later, which is a hydration mismatch, and
   * it can never be tested twice with the same answer.
   */
  now?: string | number | Date
  /** Minutes of notice required. A slot starting inside the window is shown but cannot be taken. */
  minLeadMinutes?: number
  /** Leave slots that have already started out of the list. On by default. */
  hidePastSlots?: boolean
  /** Length to use for a slot that gives neither `end` nor `durationMinutes`. */
  defaultDurationMinutes?: number
  /** Formatting for the day headings. */
  dayFormat?: Intl.DateTimeFormatOptions
  labels?: Partial<TimeSlotPickerLabels>
}

/**
 * Arranges the offered slots into days with every label worked out.
 *
 * Exported because a confirmation screen, an email or a server route wants the same labels in the
 * same zone without mounting a picker, and because the awkward parts — which day a slot belongs to,
 * which two slots read alike — are then assertable on their own.
 */
export function resolveTimeSlots(options: ResolveTimeSlotsOptions): ResolvedTimeSlots {
  const {
    slots,
    days: requestedDays,
    locale,
    hour12,
    minLeadMinutes = 0,
    hidePastSlots = true,
    defaultDurationMinutes,
    dayFormat,
  } = options
  const labels = { ...defaultTimeSlotPickerLabels, ...options.labels }
  const timeZone = usableZone(options.timeZone) ?? runtimeZone()

  const nowParsed = parseInstant(options.now, timeZone)
  const now = nowParsed === null ? null : nowParsed.ms
  const leadUntil = now === null ? null : now + Math.max(0, minLeadMinutes) * MS_PER_MINUTE

  const timeFmt = makeTimeFormat(locale, timeZone, hour12)
  const dayFmt = makeFormat(locale, {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    ...dayFormat,
  })

  // Parse first, sort by the instant, and only then group. Sorting the input strings instead would
  // put "2026-11-20T23:00+09:00" after "2026-11-20T15:00Z" — the same moment written two ways.
  const parsed: ResolvedSlot[] = []
  const seen = new Set<string>()
  // Guarded rather than trusted: the types say this is an array, and this function is also called
  // straight from whatever a fetch handed back, where "no slots" arrives as undefined about as often
  // as it arrives as [].
  for (const slot of Array.isArray(slots) ? slots : []) {
    const start = parseInstant(slot.start, timeZone)
    if (start === null) continue
    const endParsed =
      slot.end !== undefined
        ? parseInstant(slot.end, timeZone)
        : slot.durationMinutes !== undefined && Number.isFinite(slot.durationMinutes)
          ? { ms: start.ms + slot.durationMinutes * MS_PER_MINUTE, assumed: false }
          : defaultDurationMinutes !== undefined && Number.isFinite(defaultDurationMinutes)
            ? { ms: start.ms + defaultDurationMinutes * MS_PER_MINUTE, assumed: false }
            : null
    // An end at or before the start is not a range; it is bad data. Dropped to a start-only slot so
    // the label reads "9:00" rather than "9:00 to 8:30", and reported by `slotIssues`.
    const end = endParsed !== null && endParsed.ms > start.ms ? endParsed.ms : null

    const id = slot.id !== undefined && slot.id !== "" ? slot.id : new Date(start.ms).toISOString()
    // The first of two slots sharing an id wins. Keeping both would give the value an entry that
    // selects two things at once, and nothing downstream could tell them apart.
    if (seen.has(id)) continue
    seen.add(id)

    const taken = slot.taken === true
    const past = now !== null && start.ms < now
    const tooSoon = !past && leadUntil !== null && start.ms < leadUntil
    const block: SlotBlock = taken ? "taken" : past ? "past" : tooSoon ? "lead" : ""
    const builtInReason =
      block === "taken" ? labels.taken : block === "past" ? labels.past : block === "lead" ? labels.tooSoon : ""

    parsed.push({
      id,
      start: start.ms,
      end,
      durationMinutes: end === null ? null : Math.round((end - start.ms) / MS_PER_MINUTE),
      dayKey: dayKeyOf(timeZone, start.ms),
      startLabel: timeFmt.format(new Date(start.ms)),
      endLabel: end === null ? "" : timeFmt.format(new Date(end)),
      label: "",
      zoneLabel: "",
      // Measured from the last moment inside the slot rather than from the end itself, because a
      // slot runs up to its end and not through it: 23:30–00:00 is the last half hour of the day,
      // and reading the boundary itself would file every slot that ends at midnight under tomorrow.
      endsNextDay: end !== null && dayKeyOf(timeZone, end - 1) !== dayKeyOf(timeZone, start.ms),
      taken,
      past,
      tooSoon,
      block,
      selectable: block === "",
      reason: slot.reason !== undefined && slot.reason !== "" ? slot.reason : builtInReason,
      note: slot.note ?? "",
    })
  }
  parsed.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const byDay = new Map<string, ResolvedSlot[]>()
  for (const key of requestedDays ?? []) {
    if (DAY_PATTERN.test(key)) byDay.set(key, [])
  }
  for (const slot of parsed) {
    const bucket = byDay.get(slot.dayKey)
    if (bucket === undefined) byDay.set(slot.dayKey, [slot])
    else bucket.push(slot)
  }

  const days: ResolvedDay[] = []
  const order: string[] = []
  const byId: Record<string, ResolvedSlot> = {}
  let available = 0

  for (const key of Array.from(byDay.keys()).sort()) {
    const offered = byDay.get(key) ?? []
    const shown = hidePastSlots ? offered.filter((slot) => !slot.past) : offered.slice()

    // The range is shown on every slot of a day that mixes lengths, and only then. With one length
    // the start time says everything and the range is noise; with two, a start alone hides the
    // difference between the half hour and the hour that begin at the same minute.
    const lengths = new Set(shown.map((slot) => slot.durationMinutes))
    const showRange = lengths.size > 1

    // Two slots can read exactly alike, and not as a curiosity: when the clocks go back, 1:30 comes
    // round twice, and both halves of that hour are ordinary bookable slots. Measured rather than
    // assumed — en-US formats 05:30Z and 06:30Z on 2026-11-01 as "1:30 AM" both times. The zone
    // abbreviation goes on the ones that collide, so the pair differ, and not on the rest.
    const labelCount = new Map<string, number>()
    for (const slot of shown) {
      labelCount.set(slot.startLabel, (labelCount.get(slot.startLabel) ?? 0) + 1)
    }

    const daySlots = shown.map((slot) => {
      const collides = (labelCount.get(slot.startLabel) ?? 0) > 1
      const resolved: ResolvedSlot = {
        ...slot,
        zoneLabel: collides ? zoneWord(locale, timeZone, "short", slot.start) : "",
        label: showRange && slot.endLabel !== "" ? `${slot.startLabel} – ${slot.endLabel}` : slot.startLabel,
      }
      byId[resolved.id] = resolved
      order.push(resolved.id)
      return resolved
    })

    const dayAvailable = daySlots.filter((slot) => slot.selectable).length
    available += dayAvailable

    const state: DayState =
      offered.length === 0
        ? "empty"
        : dayAvailable > 0
          ? "available"
          : offered.every((slot) => slot.past)
            ? "past"
            : "fullyBooked"

    const [year, month, day] = key.split("-").map(Number)
    days.push({
      key,
      // Noon rather than midnight: the label is formatted in the display zone, and midnight is the
      // one time of day a zone shift can move to the day before.
      label: dayFmt.format(new Date(Date.UTC(year, month - 1, day, 12))),
      slots: daySlots,
      available: dayAvailable,
      offered: offered.length,
      state,
    })
  }

  return {
    timeZone,
    zoneName: zoneWord(locale, timeZone, "long", parsed.length > 0 ? parsed[0].start : Date.UTC(2026, 0, 1)),
    days,
    order,
    byId,
    available,
  }
}

/**
 * What is wrong with the data, named rather than guessed around.
 *
 * None of these stops the picker rendering. They are here because every one of them is a mistake at
 * the source that looks like a mistake in the component — a slot an hour out, a slot that cannot be
 * selected, two slots that select together — and the only cheap way to find that out is to ask.
 */
export function slotIssues(
  slots: TimeSlot[],
  options: { timeZone?: string; now?: string | number | Date; minLeadMinutes?: number } = {}
): SlotIssue[] {
  const timeZone = usableZone(options.timeZone) ?? runtimeZone()
  const issues: SlotIssue[] = []
  const seen = new Set<string>()
  const spans: { id: string; start: number; end: number }[] = []

  if (options.minLeadMinutes !== undefined && options.minLeadMinutes > 0 && options.now === undefined) {
    issues.push({
      kind: "lead-without-now",
      subject: "",
      message: "minLeadMinutes needs `now` to measure from, so no slot is being held back.",
    })
  }

  for (const slot of Array.isArray(slots) ? slots : []) {
    const start = parseInstant(slot.start, timeZone)
    const label = slot.id !== undefined && slot.id !== "" ? slot.id : String(slot.start)
    if (start === null) {
      issues.push({
        kind: "unparsable-start",
        subject: label,
        message: `Cannot read ${JSON.stringify(slot.start)} as a time, so this slot is not shown.`,
      })
      continue
    }
    const id = slot.id !== undefined && slot.id !== "" ? slot.id : new Date(start.ms).toISOString()
    if (seen.has(id)) {
      issues.push({
        kind: "duplicate-id",
        subject: id,
        message: "Two slots share this id, so only the first is shown. Give them ids of their own.",
      })
      continue
    }
    seen.add(id)

    if (start.assumed) {
      issues.push({
        kind: "no-offset",
        subject: id,
        message: `${JSON.stringify(slot.start)} carries no UTC offset, so it is being read in ${timeZone}.`,
      })
    }

    let end: number | null = null
    if (slot.end !== undefined) {
      const parsedEnd = parseInstant(slot.end, timeZone)
      if (parsedEnd === null) {
        issues.push({
          kind: "unparsable-end",
          subject: id,
          message: `Cannot read ${JSON.stringify(slot.end)} as a time, so this slot has no end.`,
        })
      } else {
        end = parsedEnd.ms
        if (parsedEnd.assumed) {
          issues.push({
            kind: "no-offset",
            subject: id,
            message: `${JSON.stringify(slot.end)} carries no UTC offset, so it is being read in ${timeZone}.`,
          })
        }
        if (parsedEnd.ms <= start.ms) {
          issues.push({
            kind: "backwards",
            subject: id,
            message: "The end is at or before the start, so this slot is shown as a start time only.",
          })
        }
      }
    } else if (slot.durationMinutes !== undefined) {
      if (!Number.isFinite(slot.durationMinutes) || slot.durationMinutes <= 0) {
        issues.push({
          kind: "backwards",
          subject: id,
          message: "durationMinutes is not a positive number, so this slot is shown as a start time only.",
        })
      } else {
        end = start.ms + slot.durationMinutes * MS_PER_MINUTE
      }
    }

    if (end !== null && slot.taken !== true) spans.push({ id, start: start.ms, end })
  }

  // Only among slots somebody could actually take: a free slot overlapping a booked one is how a
  // calendar offers the hour either side of an appointment, and flagging that would be noise.
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    const previous = spans[i - 1]
    const current = spans[i]
    if (current.start < previous.end) {
      issues.push({
        kind: "overlap",
        subject: current.id,
        message: `Overlaps ${previous.id}, so both can be taken for the same time.`,
      })
    }
  }

  return issues
}

export interface SlotReconciliation {
  /** The selection with everything unavailable taken out — what is safe to submit. */
  value: string[]
  /** The ids that went, in the order they were given. */
  lost: string[]
}

/**
 * Drops the parts of a selection the latest slots no longer support.
 *
 * This is the whole reason a picker needs anything beyond a list of buttons. A slot is free when the
 * page renders and taken a moment later by somebody else, and the choice already on screen is then
 * a choice of something that does not exist. Keeping it ticked posts a booking that will be refused;
 * clearing it quietly loses the person's answer with nothing said. So it comes out of the value and
 * is handed back under `lost`, for the caller to say out loud.
 */
export function reconcileSlotSelection(
  selected: readonly string[],
  resolved: ResolvedTimeSlots
): SlotReconciliation {
  const value: string[] = []
  const lost: string[] = []
  const kept = new Set<string>()
  for (const id of selected) {
    if (kept.has(id)) continue
    kept.add(id)
    const slot = resolved.byId[id]
    if (slot !== undefined && slot.selectable) value.push(id)
    else lost.push(id)
  }
  return { value, lost }
}

/** Why a press changed nothing. */
export type SlotRefusal = "missing" | "taken" | "past" | "lead" | "max"

export interface SlotToggle {
  value: string[]
  added: string[]
  removed: string[]
  refused: SlotRefusal | null
}

/**
 * The next selection after a press, and nothing else.
 *
 * Deselecting is always allowed, including for a slot that has since been taken: refusing to let go
 * of something unavailable would strand the person on it.
 */
export function toggleSlotSelection(
  selected: readonly string[],
  id: string,
  options: { resolved: ResolvedTimeSlots; multiple?: boolean; max?: number }
): SlotToggle {
  const { resolved, multiple = false, max } = options
  const current = reconcileSlotSelection(selected, resolved).value
  const unchanged = { value: current, added: [], removed: [] }

  if (current.indexOf(id) !== -1) {
    return { value: current.filter((other) => other !== id), added: [], removed: [id], refused: null }
  }

  const slot = resolved.byId[id]
  if (slot === undefined) return { ...unchanged, refused: "missing" }
  if (slot.taken) return { ...unchanged, refused: "taken" }
  if (slot.past) return { ...unchanged, refused: "past" }
  if (slot.tooSoon) return { ...unchanged, refused: "lead" }

  if (!multiple) {
    return { value: [id], added: [id], removed: current.filter((other) => other !== id), refused: null }
  }
  if (max !== undefined && current.length >= max) return { ...unchanged, refused: "max" }

  // Kept in the order the slots are offered rather than the order they were pressed, so the value
  // reads as a schedule and two people picking the same three times produce the same value.
  const next = current.concat(id)
  const rank = new Map(resolved.order.map((other, index) => [other, index]))
  next.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
  return { value: next, added: [id], removed: [], refused: null }
}

/** The first slot anybody could take, for a "next available" link. `null` when there is none. */
export function nextAvailableSlot(resolved: ResolvedTimeSlots): ResolvedSlot | null {
  for (const id of resolved.order) {
    const slot = resolved.byId[id]
    if (slot !== undefined && slot.selectable) return slot
  }
  return null
}

/**
 * Where the focus goes for a key press, or `null` when it stays put.
 *
 * Left and right walk the slots in time order and run on into the next day, because that is how the
 * list reads; up and down jump a whole day, because that is the other thing somebody wants from a
 * list of days. Movement clamps at both ends rather than wrapping — a wrap from the last slot of the
 * month back to the first looks like the list reset itself.
 *
 * Slots nobody can take are walked onto rather than skipped. A reader who cannot reach the 9:00
 * somebody else has booked has no way to find out it was ever there, and "nothing at 9" and "9 is
 * gone" are different answers to the only question being asked.
 */
export function nextSlotFocus(
  resolved: ResolvedTimeSlots,
  current: string | null,
  key: string
): string | null {
  const { order } = resolved
  if (order.length === 0) return null
  const at = current === null ? -1 : order.indexOf(current)
  const step = (to: number): string | null => {
    const clamped = Math.max(0, Math.min(to, order.length - 1))
    return order[clamped] === current ? null : order[clamped]
  }
  const dayStep = (delta: number): string | null => {
    const from = at === -1 ? 0 : at
    const slot = resolved.byId[order[from]]
    if (slot === undefined) return null
    const index = resolved.days.findIndex((day) => day.key === slot.dayKey)
    for (let i = index + delta; i >= 0 && i < resolved.days.length; i += delta) {
      const day = resolved.days[i]
      if (day.slots.length > 0) return day.slots[0].id
    }
    return null
  }

  switch (key) {
    case "ArrowRight":
      return step(at + 1)
    case "ArrowLeft":
      return at === -1 ? step(0) : step(at - 1)
    case "ArrowDown":
      return dayStep(1)
    case "ArrowUp":
      return dayStep(-1)
    case "Home":
      return step(0)
    case "End":
      return step(order.length - 1)
    default:
      return null
  }
}

export interface TimeSlotPickerProps extends ResolveTimeSlotsOptions {
  /** Controlled selection, as slot ids. Holds at most one id unless `multiple` is set. */
  value?: string[]
  /** Starting selection when uncontrolled. */
  defaultValue?: string[]
  /** Fires with the next selection and the slots that moved. Never fires for a refused press. */
  onValueChange?: (value: string[], change: { added: ResolvedSlot[]; removed: ResolvedSlot[] }) => void
  /** Let more than one slot be chosen. */
  multiple?: boolean
  /** Most slots that may be chosen at once. Further presses are refused and said out loud. */
  max?: number
  /**
   * Fires with the ids that had to be dropped because the slots behind them are no longer on offer.
   * Use it to clear the ids from your own copy of the value, or to put the person back on the step
   * where they choose.
   */
  onLostSelection?: (lost: string[]) => void
  /** Hide the "times shown in …" caption. The zone is still used; it just stops being stated. */
  showTimeZone?: boolean
  /** Turn off the live region that announces each selection. */
  announce?: boolean
  disabled?: boolean
  /** Posts the chosen ids as hidden inputs of this name, so a plain form or server action gets them. */
  name?: string
  "aria-label"?: string
  className?: string
  classNames?: {
    day?: string
    dayLabel?: string
    slots?: string
    slot?: string
    note?: string
    caption?: string
    notice?: string
  }
}

/**
 * Choose from the times somebody else has said are free.
 *
 * The component holds two things that a list of buttons cannot. One is the zone: every slot is an
 * instant, the display zone is stated on screen, and which calendar day a slot belongs to is worked
 * out in that zone — a 23:30 UTC slot is tomorrow in Tokyo, and grouping by the UTC date puts it
 * under the wrong heading. The other is that availability goes stale while it is being read, so the
 * selection is reconciled against the latest slots on every render and anything that has gone is
 * taken out of the value, named in a notice, and left out of what a form would post.
 */
export function TimeSlotPicker({
  slots,
  days,
  value,
  defaultValue,
  onValueChange,
  multiple = false,
  max,
  onLostSelection,
  timeZone,
  locale,
  hour12,
  now,
  minLeadMinutes = 0,
  hidePastSlots = true,
  defaultDurationMinutes,
  dayFormat,
  labels: labelOverrides,
  showTimeZone = true,
  announce = true,
  disabled = false,
  name,
  className,
  classNames,
  "aria-label": ariaLabel,
}: TimeSlotPickerProps) {
  const labels = React.useMemo(
    () => ({ ...defaultTimeSlotPickerLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const isControlled = value !== undefined
  const [inner, setInner] = React.useState<string[]>(() => (defaultValue ?? []).slice())
  const selected = isControlled ? value : inner

  const resolved = React.useMemo(
    () =>
      resolveTimeSlots({
        slots,
        days,
        timeZone,
        locale,
        hour12,
        now,
        minLeadMinutes,
        hidePastSlots,
        defaultDurationMinutes,
        dayFormat,
        labels,
      }),
    [
      slots,
      days,
      timeZone,
      locale,
      hour12,
      now,
      minLeadMinutes,
      hidePastSlots,
      defaultDurationMinutes,
      dayFormat,
      labels,
    ]
  )

  const { value: usable, lost } = reconcileSlotSelection(selected, resolved)
  const usableSet = new Set(usable)

  const reactId = React.useId()
  const [message, setMessage] = React.useState("")
  const [focusId, setFocusId] = React.useState<string | null>(null)
  const nodes = React.useRef(new Map<string, { focus?: () => void }>())

  // One tab stop. Which slot it lands on is derived rather than stored, so a slot that disappears
  // between renders cannot leave the list with no reachable stop: the chosen one, else the first
  // that can be taken, else the first there is.
  const activeId = (() => {
    if (focusId !== null && resolved.byId[focusId] !== undefined) return focusId
    if (usable.length > 0) return usable[0]
    const next = nextAvailableSlot(resolved)
    if (next !== null) return next.id
    return resolved.order.length > 0 ? resolved.order[0] : null
  })()

  // Said once per change, not once per render. Without the guard this fires on every pass, and a
  // caller clearing its own value from it would be told again about what it just cleared.
  const toldAbout = React.useRef<string | null>(null)
  const lostKey = lost.join("\u0000")
  React.useEffect(() => {
    if (toldAbout.current === lostKey) return
    toldAbout.current = lostKey
    if (lost.length > 0) onLostSelection?.(lost)
  })

  const fullLabel = (slot: ResolvedSlot): string => {
    const day = resolved.days.find((each) => each.key === slot.dayKey)
    const time = slot.endLabel === "" ? slot.startLabel : `${slot.startLabel} ${labels.to} ${slot.endLabel}`
    return day === undefined ? time : `${day.label}, ${time}`
  }

  const lostLabels = lost.map((id) => {
    const slot = resolved.byId[id]
    return slot === undefined ? id : fullLabel(slot)
  })

  function press(slot: ResolvedSlot) {
    if (disabled) return
    const result = toggleSlotSelection(selected, slot.id, { resolved, multiple, max })
    if (result.refused !== null) {
      setMessage(
        result.refused === "max" && max !== undefined
          ? labels.announceMax(max)
          : labels.announceRefused(fullLabel(slot), slot.reason)
      )
      return
    }
    if (!isControlled) setInner(result.value)
    setMessage(
      result.added.length > 0 ? labels.announceSelected(fullLabel(slot)) : labels.announceCleared(fullLabel(slot))
    )
    onValueChange?.(result.value, {
      added: result.added.map((id) => resolved.byId[id]).filter((each): each is ResolvedSlot => each !== undefined),
      removed: result.removed
        .map((id) => resolved.byId[id])
        .filter((each): each is ResolvedSlot => each !== undefined),
    })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      const slot = activeId === null ? undefined : resolved.byId[activeId]
      if (slot !== undefined) {
        // Space scrolls the page by default, and these are divs rather than buttons, so neither key
        // activates on its own.
        event.preventDefault()
        press(slot)
      }
      return
    }
    const next = nextSlotFocus(resolved, activeId, event.key)
    if (next === null) return
    event.preventDefault()
    setFocusId(next)
    nodes.current.get(next)?.focus?.()
  }

  const dayLabelId = (key: string) => `${reactId}-${key}`
  const reasonId = (id: string) => `${reactId}-why-${id}`

  return (
    <div className={cn("w-full text-sm", className)}>
      {showTimeZone ? (
        <p className={cn("mb-2 text-xs text-muted-foreground", classNames?.caption)}>
          {labels.timeZoneNote(resolved.zoneName, resolved.timeZone)}
        </p>
      ) : null}

      <div
        role="listbox"
        aria-multiselectable={multiple ? true : undefined}
        aria-label={ariaLabel ?? labels.list}
        aria-disabled={disabled ? true : undefined}
        onKeyDown={onKeyDown}
        className={cn("space-y-4", disabled && "opacity-50")}
      >
        {resolved.days.length === 0 ? (
          <p className="text-muted-foreground">{labels.nothingAvailable}</p>
        ) : null}

        {resolved.days.map((day) => (
          <div key={day.key} role="group" aria-labelledby={dayLabelId(day.key)} className={classNames?.day}>
            <h3
              id={dayLabelId(day.key)}
              className={cn("mb-2 font-medium text-foreground", classNames?.dayLabel)}
            >
              {day.label}
            </h3>

            {/* Said whenever there is nothing to take, and not only when there is nothing to show.
                A day holding six struck-through slots and no sentence is the same silent blank as an
                empty one: the reader has to work along every slot to find out that the answer is no.
                It also keeps the three sentences reachable — written as the alternative to the grid,
                "fully booked" could never appear at all, because a booked slot is still on screen
                and the only way to empty a day's grid is for its times to have passed. */}
            {day.state === "available" ? null : (
              <p className="mb-2 text-muted-foreground">
                {day.state === "fullyBooked"
                  ? labels.dayFullyBooked
                  : day.state === "past"
                    ? labels.dayPast
                    : labels.dayEmpty}
              </p>
            )}

            {day.slots.length === 0 ? null : (
              <div
                className={cn(
                  "grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4",
                  classNames?.slots
                )}
              >
                {day.slots.map((slot) => {
                  const isSelected = usableSet.has(slot.id)
                  const blocked = !slot.selectable
                  // The day is not repeated here: the slot sits in a group named by the day
                  // heading, which is what a reader is told on the way in. It *is* repeated in the
                  // announcements and the notice below, which are read with no group around them —
                  // "9:00 AM selected" on its own does not say which day was just taken.
                  const slotName =
                    (slot.endLabel === ""
                      ? slot.startLabel
                      : `${slot.startLabel} ${labels.to} ${slot.endLabel}`) +
                    (slot.zoneLabel === "" ? "" : ` ${slot.zoneLabel}`) +
                    (slot.endsNextDay ? `, ${labels.endsNextDay}` : "")
                  return (
                    <div
                      key={slot.id}
                      ref={(node) => {
                        if (node === null) nodes.current.delete(slot.id)
                        else nodes.current.set(slot.id, node)
                      }}
                      role="option"
                      aria-selected={isSelected}
                      // `aria-disabled` rather than the `disabled` attribute, and rather than
                      // leaving the slot out: a taken slot is the answer to "what about 9:00", and
                      // it can only be that answer if it is still reachable and still says why.
                      aria-disabled={blocked || disabled ? true : undefined}
                      aria-describedby={slot.reason === "" ? undefined : reasonId(slot.id)}
                      aria-label={slotName}
                      tabIndex={slot.id === activeId ? 0 : -1}
                      onClick={() => press(slot)}
                      className={cn(
                        "flex cursor-pointer select-none flex-col items-center rounded-md border px-3 py-2 text-center tabular-nums transition-colors",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        isSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-input bg-background hover:bg-accent hover:text-accent-foreground",
                        blocked &&
                          !isSelected &&
                          "cursor-not-allowed border-dashed text-muted-foreground line-through hover:bg-background hover:text-muted-foreground",
                        disabled && "cursor-not-allowed",
                        classNames?.slot
                      )}
                    >
                      <span>
                        {slot.label}
                        {slot.zoneLabel === "" ? null : (
                          <span className="ml-1 text-xs font-normal opacity-70">{slot.zoneLabel}</span>
                        )}
                      </span>
                      {slot.note === "" ? null : (
                        <span className={cn("text-xs opacity-70", classNames?.note)}>{slot.note}</span>
                      )}
                      {slot.reason === "" ? null : (
                        <span id={reasonId(slot.id)} className="sr-only">
                          {slot.reason}
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Mounted whether or not anything was lost, so the sentence that appears in it is a change to
          a live region and gets read, rather than a new region nobody is watching. */}
      <p
        role="status"
        className={cn(
          "mt-2 text-sm text-destructive",
          lostLabels.length === 0 && "sr-only",
          classNames?.notice
        )}
      >
        {lostLabels.length === 0 ? "" : labels.lost(lostLabels)}
      </p>

      {announce ? (
        <span role="status" aria-live="polite" className="sr-only">
          {message}
        </span>
      ) : null}

      {name !== undefined
        ? // Only what survived reconciliation. The point of the whole exercise is that the form does
          // not post a slot somebody else already has.
          usable.map((id) => <input key={id} type="hidden" name={name} value={id} />)
        : null}
    </div>
  )
}
