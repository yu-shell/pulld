"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { DateInput } from "@/registry/ui/date-input"

/**
 * A calendar day as "YYYY-MM-DD" — no time, no zone, no instant.
 *
 * Zero-padded to a fixed width, so `<` on two of these is chronological order and no `Date` (and
 * therefore no time zone) has to be involved in a comparison.
 */
export type PlainDate = string

/** The year/month/day of a calendar day, with **month 1–12** as it is written. */
export interface CalendarDay {
  year: number
  month: number
  day: number
}

/**
 * A resolved span, **half-open**: `start` is included and `end` is not.
 *
 * The inclusive alternative is the reason so many dashboards quietly lose the last few moments of
 * the final day. Written inclusively, the end of "today" has to be the last instant of today, and
 * every implementation picks a different one — 23:59:59, or 23:59:59.999, each of which drops
 * whatever happened in the remaining second or millisecond. Half-open has no such instant to pick:
 * the range ends where the next day begins, and `start <= row && row < end` is the whole rule.
 *
 * So `end` is the day **after** the last one you want. A single day is `{ start: "2026-09-23",
 * end: "2026-09-24" }`. To show the span to a human, use the last *included* day — see
 * `lastIncludedDay`, and note that this component's own summary line uses it, because telling a
 * reader their range ends on the 24th when the 24th is excluded is simply false.
 */
export interface ResolvedRange {
  start: PlainDate
  end: PlainDate
}

/** One option in the row: a stable id, the text on the button, and the span it means today. */
export interface DateRangePresetDef {
  /**
   * Goes in the value and therefore in the URL, so keep it short and URL-safe: letters, digits and
   * dashes. It must not look like a custom range (see `parseDateRange`).
   */
  id: string
  /** The text on the button. Supply translated strings here; nothing is localised for you. */
  label: string
  /** Given today as a calendar day, the half-open span the preset means. */
  resolve: (today: CalendarDay) => ResolvedRange
}

/** What a value string turned out to be. */
export type ParsedDateRange =
  | { kind: "preset"; preset: string }
  | { kind: "custom"; from: PlainDate; to: PlainDate }

/**
 * Years are shifted by this much before any arithmetic and shifted back after.
 *
 * Two problems, one fix. `Date.UTC(50, 0, 1)` is the year **1950** — the two-digit-year rule from
 * the original `Date` constructor applies to `Date.UTC` as well — and the obvious workaround
 * (build it, then `setUTCFullYear`) is wrong here, because setting the year *after* normalisation
 * loses a year that normalising rolled over: month 0 of 2026 is December **2025**, and re-stamping
 * the year afterwards makes it December 2026.
 *
 * Adding a constant first sidesteps both: the arithmetic happens far away from the two-digit
 * window, and the rollover is already folded into the year that comes back. It has to be a
 * multiple of 400 so the Gregorian leap-year pattern is identical before and after the shift,
 * which keeps 29 February exactly where it was.
 */
const YEAR_SHIFT = 4000

/** Anchored, so "2026-09-23T00:00:00Z" is rejected rather than half-read as a day. */
const PLAIN_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** "2026-09-01..2026-09-30" — both days as written, both included. */
const CUSTOM_RANGE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/

/** A preset id: URL-safe, and shaped so it can never be confused with a custom range. */
const PRESET_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9-]*$/

const pad = (value: number, width: number) => String(value).padStart(width, "0")

/**
 * Rolls out-of-range month and day components into a real calendar day.
 *
 * This is what makes the preset table below readable: "the first of last month" can be written as
 * `{ year, month: month - 1, day: 1 }` and January's month 0 becomes December of the previous year
 * on its own, with no branch for the year boundary — the branch nobody writes a test for and
 * everybody gets wrong every January.
 */
function normalizeDay(day: CalendarDay): CalendarDay {
  const at = new Date(Date.UTC(day.year + YEAR_SHIFT, day.month - 1, day.day))
  return {
    year: at.getUTCFullYear() - YEAR_SHIFT,
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
  }
}

/**
 * `{ year, month, day }` for a "YYYY-MM-DD" string, or null when it is not one.
 *
 * Impossible dates are rejected rather than rolled: "2026-02-30" normalises to 2 March, which no
 * longer matches what was written, and that mismatch is the whole check — cheaper than a table of
 * month lengths and correct about leap years for free. Compared as one round-tripped string rather
 * than field by field, because a field-by-field test reads as three checks when it is only ever
 * one: a day that overflows its month always moves the month too, so the day clause could never
 * fire on its own and would sit there looking load-bearing.
 */
export function toCalendarDay(date: PlainDate): CalendarDay | null {
  const parsed = PLAIN_DATE_PATTERN.exec(date)
  if (!parsed) return null
  const candidate = {
    year: Number(parsed[1]),
    month: Number(parsed[2]),
    day: Number(parsed[3]),
  }
  if (toPlainDate(candidate) !== date) return null
  return candidate
}

/** "YYYY-MM-DD" for a calendar day, rolling any out-of-range components first. */
export function toPlainDate(day: CalendarDay): PlainDate {
  const normalized = normalizeDay(day)
  return `${pad(normalized.year, 4)}-${pad(normalized.month, 2)}-${pad(normalized.day, 2)}`
}

/** The day `days` later (or earlier, for a negative count), crossing months and years. */
export function shiftDay(day: CalendarDay, days: number): CalendarDay {
  return normalizeDay({ ...day, day: day.day + days })
}

/**
 * The last day a half-open range actually includes — what to show a reader.
 *
 * `{ start: "2026-09-17", end: "2026-09-24" }` covers the 17th through the **23rd**, and printing
 * the raw `end` would tell them otherwise.
 */
export function lastIncludedDay(range: ResolvedRange): PlainDate {
  const end = toCalendarDay(range.end)
  return end ? toPlainDate(shiftDay(end, -1)) : range.end
}

/**
 * Today's date in a given time zone, as a plain day.
 *
 * "Today" is not a property of the moment, it is a property of where you are standing: at 22:00 in
 * Los Angeles it is already tomorrow in Berlin. So a range picker has to be told, or it silently
 * picks the zone of whichever machine happened to evaluate it — and a dashboard where the browser
 * says one day and the server that aggregates the rows says another is off by a day at the edges
 * for everyone who works late.
 *
 * Throws `RangeError` for a time zone the runtime does not know, exactly as `Intl` does. That is
 * the right failure: a mistyped IANA name is a bug in the calling code, and a silent fall back to
 * the machine's own zone would hide it behind numbers that merely look a little wrong.
 *
 * The calendar is pinned to Gregorian rather than left to the locale, since every piece of
 * arithmetic in this file is Gregorian; without the `-u-ca-gregory` a locale whose default
 * calendar is not (ar-SA, fa-IR) would hand back a year from a different era entirely.
 */
export function todayIn(timeZone?: string, now: Date = new Date()): PlainDate {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${read("year").padStart(4, "0")}-${read("month")}-${read("day")}`
}

const span = (start: CalendarDay, end: CalendarDay): ResolvedRange => ({
  start: toPlainDate(start),
  end: toPlainDate(end),
})

/**
 * The options offered when none are supplied — and the place the "does it include today?"
 * question is answered out loud.
 *
 * Every one of these windows **includes today**, so "Last 7 days" on the 23rd is the 17th through
 * the 23rd. That is one of two live conventions and the other is defensible: ending the window
 * yesterday means the figure stops moving while people are looking at it, which is what a
 * finance team usually wants. Neither is a default worth hiding, so it is written here as
 * ordinary data you can replace rather than buried in the component:
 *
 * ```tsx
 * const throughYesterday = DEFAULT_PRESETS.map((preset) =>
 *   preset.id === "last7d"
 *     ? { ...preset, resolve: (t) => ({ start: toPlainDate(shiftDay(t, -7)), end: toPlainDate(t) }) }
 *     : preset
 * )
 * ```
 *
 * There is deliberately no "this week": the first day of the week is Sunday, Monday or Saturday
 * depending on where you are, and a component that quietly assumes one would be wrong for a large
 * part of the world without ever saying so. Add it with the week start your product has already
 * decided on, the same way as above.
 */
export const DEFAULT_PRESETS: readonly DateRangePresetDef[] = [
  { id: "today", label: "Today", resolve: (t) => span(t, shiftDay(t, 1)) },
  { id: "yesterday", label: "Yesterday", resolve: (t) => span(shiftDay(t, -1), t) },
  { id: "last7d", label: "Last 7 days", resolve: (t) => span(shiftDay(t, -6), shiftDay(t, 1)) },
  { id: "last30d", label: "Last 30 days", resolve: (t) => span(shiftDay(t, -29), shiftDay(t, 1)) },
  { id: "last90d", label: "Last 90 days", resolve: (t) => span(shiftDay(t, -89), shiftDay(t, 1)) },
  {
    id: "mtd",
    label: "Month to date",
    resolve: (t) => span({ ...t, day: 1 }, shiftDay(t, 1)),
  },
  {
    id: "lastMonth",
    label: "Last month",
    // month - 1 is month 0 every January, which normalizeDay turns into the previous December.
    resolve: (t) => span({ year: t.year, month: t.month - 1, day: 1 }, { ...t, day: 1 }),
  },
  {
    id: "ytd",
    label: "Year to date",
    resolve: (t) => span({ year: t.year, month: 1, day: 1 }, shiftDay(t, 1)),
  },
]

/**
 * What a value string is, without deciding what it means.
 *
 * Returns null for anything malformed, for an impossible date, and for a custom range written
 * backwards — a value arriving from a URL is a string a stranger can edit, and "start after end"
 * is a range no query should be built from. Callers treat null as "nothing selected" and fall
 * back to their own default rather than showing a person somebody else's broken link.
 *
 * Whether a preset id is one that *exists* is deliberately not checked here: that depends on the
 * preset list, which is `resolveDateRange`'s business.
 */
export function parseDateRange(value: string): ParsedDateRange | null {
  const custom = CUSTOM_RANGE_PATTERN.exec(value)
  if (custom) {
    const from = custom[1]
    const to = custom[2]
    if (!toCalendarDay(from) || !toCalendarDay(to)) return null
    if (from > to) return null
    return { kind: "custom", from, to }
  }
  if (PRESET_ID_PATTERN.test(value)) return { kind: "preset", preset: value }
  return null
}

/**
 * The half-open span a value means **today**, or null if it means nothing.
 *
 * This is the function the whole component exists to make necessary. A relative range is an
 * expression, not a pair of dates, and the difference only shows up later: fold "last 7 days" into
 * "2026-09-17..2026-09-23" at the moment it is clicked and you have written down an answer to a
 * question nobody asked again. Share that URL and the recipient sees your week, not theirs. Open
 * the same bookmark tomorrow and the numbers have not moved — the single most common "the
 * dashboard is broken" report there is, and nothing about it looks broken, because the page is
 * faithfully showing the stale week it was told to.
 *
 * So the value stays `"last7d"` all the way into the URL and the saved view, and this runs at the
 * moment the data is fetched, against the `today` the caller supplies:
 *
 * ```ts
 * const range = resolveDateRange(searchParams.get("period") ?? "last7d", {
 *   today: todayIn("America/New_York"),
 * })
 * // → { start: "2026-09-17", end: "2026-09-24" }  — end excluded
 * ```
 *
 * `today` is required rather than defaulted for the reason spelled out on `todayIn`: which day it
 * is depends on a zone, and the one the server happens to run in is rarely the one the numbers are
 * supposed to be in. Making it an argument forces that choice to be made once, visibly, instead of
 * differing between the browser and the job that aggregates the rows.
 */
export function resolveDateRange(
  value: string,
  options: { today: PlainDate; presets?: readonly DateRangePresetDef[] }
): ResolvedRange | null {
  const parsed = parseDateRange(value)
  if (!parsed) return null
  if (parsed.kind === "custom") {
    const to = toCalendarDay(parsed.to)
    if (!to) return null
    // The string carries the last day the person means; the range excludes its end, so the day
    // after is what goes out. Without this, every custom range is silently one day short.
    return { start: parsed.from, end: toPlainDate(shiftDay(to, 1)) }
  }
  const today = toCalendarDay(options.today)
  if (!today) return null
  const preset = (options.presets ?? DEFAULT_PRESETS).find((p) => p.id === parsed.preset)
  return preset ? preset.resolve(today) : null
}

/**
 * The span in words — "Sep 17 – 23, 2026" — or "" when the value resolves to nothing.
 *
 * Always reads the last *included* day, never the excluded end.
 */
export function formatDateRange(
  value: string,
  options: { today: PlainDate; presets?: readonly DateRangePresetDef[]; locale?: string }
): string {
  const range = resolveDateRange(value, options)
  if (!range) return ""
  const start = toCalendarDay(range.start)
  const last = toCalendarDay(lastIncludedDay(range))
  if (!start || !last) return ""

  // Built as UTC and formatted as UTC — the pair is what makes this safe. Either half on its own
  // is the classic off-by-one-day: a UTC instant formatted in the reader's zone shows the previous
  // evening for anyone west of Greenwich.
  // Both components are already known to be in range here (they came back from toCalendarDay), so
  // nothing can roll over and the year can safely be stamped on afterwards — which is what keeps a
  // year under 100 out of the two-digit window that would otherwise read 50 as 1950.
  const asDate = (day: CalendarDay) => {
    const at = new Date(Date.UTC(2000, day.month - 1, day.day))
    at.setUTCFullYear(day.year)
    return at
  }
  const formatter = new Intl.DateTimeFormat(options.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
  if (range.start === lastIncludedDay(range)) return formatter.format(asDate(start))

  // formatRange collapses the parts the two dates share ("Sep 17 – 23, 2026") and puts the dash
  // where the locale wants it. It is cast rather than called directly because this registry
  // targets lib ES2020, where it is not in the type surface yet, and feature-detected because a
  // runtime that predates it should still render a readable range rather than crash.
  const withRange = formatter as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string
  }
  if (typeof withRange.formatRange === "function") {
    return withRange.formatRange(asDate(start), asDate(last))
  }
  return `${formatter.format(asDate(start))} – ${formatter.format(asDate(last))}`
}

export interface DateRangePresetProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "value" | "defaultValue" | "children"
  > {
  /**
   * Controlled value: a preset id ("last7d") or a custom range ("2026-09-01..2026-09-30").
   *
   * This string is the whole state. Put it in the URL as it stands — `?period=last7d` — and read
   * it back with `resolveDateRange` at the moment you query.
   */
  value?: string
  /** Starting value for an uncontrolled picker. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the new value string. Not called while a custom range is half-typed. */
  onValueChange?: (value: string) => void
  /** The options to offer. Defaults to `DEFAULT_PRESETS`; see its note on windows and week starts. */
  presets?: readonly DateRangePresetDef[]
  /**
   * Which day is "today", as "YYYY-MM-DD".
   *
   * Pass it and the component stops reading the clock, which is what makes a server render
   * deterministic. Leave it out and it is resolved after mount from `timeZone`, so the server's
   * output and the browser's first paint cannot disagree about the date.
   *
   * It is read once per render rather than watched: a page left open across midnight keeps showing
   * yesterday's dates in the summary line until something re-renders it. The *value* is unaffected
   * — that is the point of keeping it relative — so the data stays correct as long as you resolve
   * at query time. If the label itself has to tick over, own `today` in state and update it.
   */
  today?: PlainDate
  /** IANA zone deciding which day is today, e.g. "America/New_York". Defaults to the runtime's. */
  timeZone?: string
  /** BCP-47 tag for the summary line and the custom fields. Defaults to the browser's own locale. */
  locale?: string
  /** Earliest day the custom fields accept, as "YYYY-MM-DD". Presets are not clamped. */
  min?: PlainDate
  /** Latest day the custom fields accept, as "YYYY-MM-DD". Presets are not clamped. */
  max?: PlainDate
  /** Drops the custom option, leaving only the presets. */
  allowCustom?: boolean
  /** Disables every control. */
  disabled?: boolean
  /** Submits the value with a surrounding form, through a hidden input. */
  name?: string
  /** Accessible name of the option row. */
  label?: string
  /** Text on the option that reveals the two date fields. */
  customLabel?: string
  /** Label on the first date field. */
  fromLabel?: string
  /** Label on the second date field. */
  toLabel?: string
  /** Shown when the second date is earlier than the first. */
  invalidRangeMessage?: string
}

/**
 * A row of range presets — Today, Last 7 days, Month to date — with a custom range behind the last
 * option.
 *
 * ```tsx
 * const [period, setPeriod] = React.useState("last7d")
 *
 * return <DateRangePreset value={period} onValueChange={setPeriod} />
 * // period is "last7d", not a pair of dates. Resolve it where you fetch:
 * // const { start, end } = resolveDateRange(period, { today: todayIn() })!
 * ```
 *
 * The value stays an expression so a shared link and a reopened bookmark mean the same thing
 * tomorrow that they meant today; see `resolveDateRange`.
 */
export const DateRangePreset = React.forwardRef<HTMLDivElement, DateRangePresetProps>(
  function DateRangePreset(
    {
      className,
      value: valueProp,
      defaultValue = "",
      onValueChange,
      presets = DEFAULT_PRESETS,
      today: todayProp,
      timeZone,
      locale,
      min,
      max,
      allowCustom = true,
      disabled,
      name,
      label = "Date range",
      customLabel = "Custom",
      fromLabel = "From",
      toLabel = "To",
      invalidRangeMessage = "The end date is before the start date.",
      ...props
    },
    ref
  ) {
    const summaryId = React.useId()

    /**
     * Guards the one thing here that comes from the machine rather than from props: which day it
     * is. Until mount the summary line is blank rather than wrong, because the server's clock and
     * zone are not the reader's. Passing `today` skips the swap entirely.
     */
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => {
      setMounted(true)
    }, [])

    const isControlled = valueProp !== undefined
    const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue)
    const value = isControlled ? valueProp : uncontrolledValue

    const today = todayProp ?? (mounted ? todayIn(timeZone) : null)
    const parsed = parseDateRange(value)

    /**
     * Whether the custom fields are showing.
     *
     * Kept apart from the value because the two genuinely differ for a while: the moment the custom
     * option is chosen there is no custom range yet, and the old value has to stay in force —
     * reporting "" or a half-typed date to the parent would blank out the dashboard behind the
     * picker while somebody is still reaching for the second field.
     */
    const [customOpened, setCustomOpened] = React.useState(false)
    const isCustom = allowCustom && (parsed?.kind === "custom" || customOpened)

    const [draft, setDraft] = React.useState(() => ({
      from: parsed?.kind === "custom" ? parsed.from : "",
      to: parsed?.kind === "custom" ? parsed.to : "",
    }))

    const options = React.useMemo(
      () => [
        ...presets.map((preset) => ({ id: preset.id, label: preset.label, custom: false })),
        ...(allowCustom ? [{ id: "\u0000custom", label: customLabel, custom: true }] : []),
      ],
      [presets, allowCustom, customLabel]
    )

    const selectedPreset = parsed?.kind === "preset" ? parsed.preset : null
    const checkedIndex = isCustom
      ? options.length - 1
      : options.findIndex((option) => !option.custom && option.id === selectedPreset)

    const [focusedIndex, setFocusedIndex] = React.useState(() =>
      checkedIndex >= 0 ? checkedIndex : 0
    )

    /**
     * A value set from outside takes the row with it — including back out of the custom fields,
     * which `customOpened` would otherwise pin open after a parent reset the range to a preset.
     *
     * Written as an adjustment during render rather than an effect so the row paints correctly in
     * the same commit as the new value, with no frame showing the old selection.
     */
    const [lastValue, setLastValue] = React.useState(value)
    if (value !== lastValue) {
      setLastValue(value)
      const next = parseDateRange(value)
      if (next?.kind === "custom") {
        setDraft({ from: next.from, to: next.to })
      } else if (next) {
        setCustomOpened(false)
      }
    }

    const emit = (next: string) => {
      if (!isControlled) setUncontrolledValue(next)
      onValueChange?.(next)
    }

    const groupRef = React.useRef<HTMLDivElement>(null)
    const optionRefs = React.useRef<Array<HTMLButtonElement | null>>([])
    // Set only by keyboard navigation, so the row never steals focus on mount or on a parent's
    // unrelated re-render — it moves focus when, and only when, the user asked it to.
    const focusPending = React.useRef(false)

    React.useEffect(() => {
      if (!focusPending.current) return
      focusPending.current = false
      optionRefs.current[focusedIndex]?.focus()
    }, [focusedIndex])

    const choose = (index: number) => {
      const option = options[index]
      if (!option) return
      setFocusedIndex(index)
      if (option.custom) {
        setCustomOpened(true)
        // Seed the fields from the range being looked at right now, so "custom" starts as the
        // dates on screen and is edited from there rather than from two empty boxes.
        if (draft.from === "" && draft.to === "" && today) {
          const current = resolveDateRange(value, { today, presets })
          if (current) setDraft({ from: current.start, to: lastIncludedDay(current) })
        }
        return
      }
      setCustomOpened(false)
      emit(option.id)
    }

    /**
     * Takes an edit to one of the date fields and emits only once the pair is a range.
     *
     * `parseDateRange` is the single gate rather than a second set of checks written out here: the
     * string it accepts is exactly the string the URL will carry, so a range this refuses to emit
     * is one no link could have carried either.
     */
    const commit = (next: { from: string; to: string }) => {
      setDraft(next)
      // An unfinished field makes a candidate like "..2026-01-01", which parseDateRange refuses
      // along with everything else it refuses — so there is no separate check for it here.
      const candidate = `${next.from}..${next.to}`
      if (!parseDateRange(candidate)) return
      emit(candidate)
    }

    const moveFocusTo = (index: number) => {
      const wrapped = (index + options.length) % options.length
      focusPending.current = true
      choose(wrapped)
    }

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      // The row is laid out with the writing direction, so on an RTL page the option to the right
      // of the focused one is the *previous* one. Read at event time, where there is a real element
      // and no render to keep deterministic.
      const rtl = groupRef.current
        ? getComputedStyle(groupRef.current).direction === "rtl"
        : false
      const inline = rtl ? -1 : 1
      switch (event.key) {
        case "ArrowRight":
          moveFocusTo(focusedIndex + inline)
          break
        case "ArrowLeft":
          moveFocusTo(focusedIndex - inline)
          break
        case "ArrowDown":
          moveFocusTo(focusedIndex + 1)
          break
        case "ArrowUp":
          moveFocusTo(focusedIndex - 1)
          break
        case "Home":
          moveFocusTo(0)
          break
        case "End":
          moveFocusTo(options.length - 1)
          break
        default:
          return
      }
      event.preventDefault()
    }

    const backwards = isCustom && draft.from !== "" && draft.to !== "" && draft.from > draft.to
    const summary = backwards
      ? invalidRangeMessage
      : today
        ? formatDateRange(value, { today, presets, locale })
        : ""

    return (
      <div ref={ref} className={cn("w-full space-y-3", className)} {...props}>
        <div
          ref={groupRef}
          role="radiogroup"
          aria-label={label}
          aria-describedby={summaryId}
          onKeyDown={handleKeyDown}
          className="flex flex-wrap gap-1"
        >
          {options.map((option, index) => (
            <button
              key={option.id}
              ref={(node) => {
                optionRefs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={index === checkedIndex}
              // Roving tabindex: one stop for the whole row, then the arrow keys inside it, which
              // is what a radio group owes the keyboard. Nine tab stops is what this replaces.
              tabIndex={index === focusedIndex ? 0 : -1}
              disabled={disabled}
              onClick={() => choose(index)}
              onFocus={() => setFocusedIndex(index)}
              className={cn(
                "inline-flex h-8 items-center justify-center rounded-md border px-3 text-sm font-normal transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:pointer-events-none disabled:opacity-50",
                index === checkedIndex
                  ? "border-primary bg-primary font-medium text-primary-foreground hover:bg-primary/90"
                  : "border-input bg-transparent hover:bg-accent hover:text-accent-foreground"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        {isCustom ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{fromLabel}</div>
              <DateInput
                aria-label={fromLabel}
                value={draft.from}
                onChange={(from) => commit({ ...draft, from })}
                min={min}
                max={max}
                locale={locale}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{toLabel}</div>
              <DateInput
                aria-label={toLabel}
                value={draft.to}
                onChange={(to) => commit({ ...draft, to })}
                min={min}
                max={max}
                locale={locale}
                disabled={disabled}
              />
            </div>
          </div>
        ) : null}

        {/*
          Permanently mounted, and never wrapped in a condition or given `hidden`. A live region
          has to be in the accessibility tree *before* the text it will announce arrives; one that
          appears along with its message is a region nobody was listening to, which reads exactly
          like silence. Empty is fine — present is the part that matters.
        */}
        <p
          id={summaryId}
          role="status"
          aria-live="polite"
          className={cn(
            "min-h-5 text-sm tabular-nums",
            backwards ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {summary}
        </p>

        {/* Lets the picker post with a plain form or a server action, with no state plumbing. */}
        {name ? <input type="hidden" name={name} value={value} /> : null}
      </div>
    )
  }
)
