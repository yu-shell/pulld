"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The locale the dates are formatted in before hydration.
 *
 * The runtime's own locale is a property of the machine, so the server's and the browser's can
 * disagree — and the date hints under each week number are the thing that would then differ between
 * the two renders. Both sides start from this constant and the real locale swaps in on mount.
 * Passing `locale` skips the swap entirely and is the fix if the first paint matters.
 */
const HYDRATION_LOCALE = "en-US"

const MS_PER_DAY = 864e5
const DAYS_PER_WEEK = 7

/**
 * "2026-W07". Anchored, zero-padded, and capped at W53 — the highest week number any year has.
 *
 * W53 passing the pattern is not the same as W53 existing: most years have 52 weeks, so
 * `parseWeekValue` checks the number against the year it was written with. The pattern only rules
 * out the shapes that are never a week.
 */
const WEEK_VALUE_PATTERN = /^(\d{4,})-W(0[1-9]|[1-4]\d|5[0-3])$/

/** The first and last week-year this component will navigate to, matching the 4-digit value shape. */
const FIRST_WEEK_YEAR = 1
const LAST_WEEK_YEAR = 9999

/**
 * The number of whole days from 1970-01-01 to a calendar date, with no zone and no clock.
 *
 * Every piece of week arithmetic below runs on these integers rather than on `Date` objects,
 * because a week is seven calendar days and not 604,800,000 milliseconds: adding that many to a
 * local `Date` lands on the wrong day in the two weeks a year that daylight saving moves, and the
 * bug shows up as an off-by-one week for half the users and for none of the tests.
 *
 * `new Date(Date.UTC(50, 0, 1))` is the year **1950** — the two-digit-year rule from the original
 * `Date` constructor still applies to `Date.UTC` — so the year is set afterwards instead, which is
 * the difference between a year-99 archive picker being right and being off by nineteen centuries
 * without saying so.
 */
function dayNumberOf(year: number, month: number, day: number): number {
  const at = new Date(Date.UTC(2000, month - 1, day))
  at.setUTCFullYear(year)
  return Math.round(at.getTime() / MS_PER_DAY)
}

function civilFromDayNumber(dayNumber: number): { year: number; month: number; day: number } {
  const at = new Date(dayNumber * MS_PER_DAY)
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/** Day of the week with **Monday as 0**, which is the order ISO 8601 counts in. */
function mondayBasedWeekday(dayNumber: number): number {
  // 1970-01-01 was a Thursday, so day number 0 is weekday 3 once Monday is 0.
  return (((dayNumber + 3) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK
}

/**
 * The Monday that opens week 1 of a week-year.
 *
 * ISO 8601 defines week 1 as the week containing the first Thursday of January, which is the same
 * as the week containing 4 January — the form used here because it needs no search. That Monday can
 * fall in December of the previous calendar year, and that is the whole reason a week-year exists
 * as a separate number.
 */
function mondayOfFirstWeek(weekYear: number): number {
  const fourthOfJanuary = dayNumberOf(weekYear, 1, 4)
  return fourthOfJanuary - mondayBasedWeekday(fourthOfJanuary)
}

/**
 * How many weeks a week-year has: **52 or 53**.
 *
 * Derived by measuring the gap to the next week-year rather than by reciting the rule about which
 * weekday 1 January lands on, so there is one fact here instead of two that can disagree. The long
 * years are real and close together — 2020, 2026, 2032 — and a 52-week assumption breaks on every
 * one of them.
 */
export function weeksInWeekYear(weekYear: number): number {
  return (mondayOfFirstWeek(weekYear + 1) - mondayOfFirstWeek(weekYear)) / DAYS_PER_WEEK
}

function weekValueOf(weekYear: number, week: number): string {
  return `${String(weekYear).padStart(4, "0")}-W${String(week).padStart(2, "0")}`
}

/** The ISO week a day number falls in, found through its own Thursday. */
function weekOfDayNumber(dayNumber: number): { weekYear: number; week: number } {
  const monday = dayNumber - mondayBasedWeekday(dayNumber)
  // The week belongs to the year its Thursday is in. Reading the Monday's year instead is the
  // classic one-week error at New Year: 2026-12-28 is a Monday in 2026 and 2027-01-03 is a Sunday
  // in 2027, and both are 2026-W53.
  const weekYear = civilFromDayNumber(monday + 3).year
  return { weekYear, week: (monday - mondayOfFirstWeek(weekYear)) / DAYS_PER_WEEK + 1 }
}

/**
 * The ISO week a `Date` falls in, as "2026-W07", read from its **local** fields — the week the
 * person looking at that date would name.
 *
 * `toISOString()` is the tempting source and it is wrong for half the planet: it reads UTC, so
 * Sunday at 23:00 in Berlin is already Monday in UTC and comes back as the *next* week, which is
 * exactly the moment a weekly timesheet gets filed against the wrong period.
 */
export function toWeekValue(date: Date): string {
  const { weekYear, week } = weekOfDayNumber(
    dayNumberOf(date.getFullYear(), date.getMonth() + 1, date.getDate())
  )
  return weekValueOf(weekYear, week)
}

/**
 * `{ weekYear, week }` with the week numbered from 1, or null when the string is not a week that
 * exists.
 *
 * Rejects W53 in a 52-week year, which is the validation a bare regular expression cannot do and
 * the one that matters: "2025-W53" looks exactly like a week and is nothing, so a picker that
 * accepts it opens on a cell that cannot be selected.
 *
 * Note that `weekYear` is **not** the calendar year of every day in the week — see
 * `weekDates` — and the two must stay separate fields in anything that stores this.
 */
export function parseWeekValue(value: string): { weekYear: number; week: number } | null {
  const parsed = WEEK_VALUE_PATTERN.exec(value)
  if (!parsed) return null
  const weekYear = Number(parsed[1])
  const week = Number(parsed[2])
  if (weekYear < FIRST_WEEK_YEAR || weekYear > LAST_WEEK_YEAR) return null
  if (week > weeksInWeekYear(weekYear)) return null
  return { weekYear, week }
}

function mondayFromValue(value: string | undefined): number | null {
  if (!value) return null
  const parsed = parseWeekValue(value)
  if (!parsed) return null
  return mondayOfFirstWeek(parsed.weekYear) + (parsed.week - 1) * DAYS_PER_WEEK
}

function toDateKey({ year, month, day }: { year: number; month: number; day: number }): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/**
 * The seven days a week covers, as **inclusive** "YYYY-MM-DD" calendar dates: Monday in `start`,
 * Sunday in `end`.
 *
 * This is the one accessor the component hands out, and the type is the reason it is safe to.
 * `month-picker` deliberately has no `Date` accessor because returning an instant means having
 * silently chosen a zone; the same objection applies here, so these come back as calendar dates —
 * zone-free, sortable, and the same thing an API means by `?from=2026-02-09`. Build the instant
 * where you know the zone.
 *
 * The end is inclusive because a week is seven days and half of all range bugs are an argument
 * about the eighth. The two dates frequently sit in different months, and `weekDates("2026-W53")`
 * answers 2026-12-28 to 2027-01-03 — different *years* — which is the shape to test any
 * week-to-dates code against.
 */
export function weekDates(value: string): { start: string; end: string } | null {
  const monday = mondayFromValue(value)
  if (monday === null) return null
  return {
    start: toDateKey(civilFromDayNumber(monday)),
    end: toDateKey(civilFromDayNumber(monday + DAYS_PER_WEEK - 1)),
  }
}

/**
 * The week `by` weeks away, or null if the input is not a week or the result leaves the range.
 *
 * Walking weeks by adding to the week number is the thing this exists to stop: `2026-W53` plus one
 * is not `2026-W54`, and it is not `2027-W00` either. It steps over the Mondays instead, so the
 * year rolls over on its own and the long years need no special case.
 */
export function shiftWeekValue(value: string, by: number): string | null {
  const monday = mondayFromValue(value)
  if (monday === null) return null
  const moved = weekOfDayNumber(monday + by * DAYS_PER_WEEK)
  if (moved.weekYear < FIRST_WEEK_YEAR || moved.weekYear > LAST_WEEK_YEAR) return null
  return weekValueOf(moved.weekYear, moved.week)
}

/**
 * A locale with the calendar and digits pinned to the ones the ISO week is defined on.
 *
 * Not fussiness. Asked to write 9 February 2026, `th-TH` answers 2569, `ja-JP-u-ca-japanese`
 * answers 令和8年, `ar-EG` answers in Arabic-Indic digits and `fa-IR` answers 20 Bahman 1404 — a
 * different day of a different month. Any of those printed under a cell whose value is "2026-W07"
 * makes the label and the value disagree, and the reader has no way to tell which one the form will
 * post. Language and date order still follow the locale; only the calendar is held still.
 *
 * Built through `Intl.Locale` rather than by appending "-u-ca-gregory" to the tag, because a locale
 * that already carries an extension — `ja-JP-u-ca-japanese` is the common one — produces an invalid
 * tag that way and throws. A malformed `locale` prop throws here too, and falls back to the
 * runtime's own rather than taking the page down.
 */
function gregorianLocale(locale: string | undefined): string | undefined {
  try {
    const base = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale)
    return new Intl.Locale(base.baseName, {
      calendar: "gregory",
      numberingSystem: "latn",
    }).toString()
  } catch {
    return undefined
  }
}

/**
 * The reader's word for "week", from CLDR.
 *
 * `Intl.DisplayNames` is cast and tried rather than called plainly because "dateTimeField" is newer
 * than the ES2020 type surface this registry targets, and a runtime without it throws rather than
 * returning nothing. The English fallback is a last resort, not the default — a component that
 * localises its dates and then announces them as "Week 7" is only half translated.
 */
function weekWordIn(locale: string | undefined): string {
  try {
    const DisplayNames = Intl.DisplayNames as unknown as {
      new (locales: string | undefined, options: { type: string }): { of(code: string): string }
    }
    return new DisplayNames(locale, { type: "dateTimeField" }).of("weekOfYear") || "week"
  } catch {
    return "week"
  }
}

/** A `Date` at noon UTC on a calendar date, for handing to `Intl` and nothing else. */
function utcNoonOf(dayNumber: number): Date {
  return new Date(dayNumber * MS_PER_DAY + MS_PER_DAY / 2)
}

function formatDayRange(
  formatter: Intl.DateTimeFormat,
  startDay: number,
  endDay: number
): string {
  // `formatRange` collapses what the two dates share ("Feb 9 – 15, 2026") and puts the dash where
  // the locale wants it. Cast because this registry targets lib ES2020, where it is not in the type
  // surface yet, and feature-detected so a runtime that predates it still renders a readable range
  // instead of crashing.
  const withRange = formatter as Intl.DateTimeFormat & {
    formatRange?: (start: Date, end: Date) => string
  }
  const start = utcNoonOf(startDay)
  const end = utcNoonOf(endDay)
  if (typeof withRange.formatRange === "function") return withRange.formatRange(start, end)
  return `${formatter.format(start)} – ${formatter.format(end)}`
}

export interface WeekPickerProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "value" | "defaultValue" | "children"
  > {
  /** Controlled week as `YYYY-Www`, e.g. "2026-W07". Pair with `onValueChange`. */
  value?: string
  /** Starting week for an uncontrolled picker. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen `YYYY-Www`. Never called for a week outside `min`/`max`. */
  onValueChange?: (value: string) => void
  /** Controlled week-year on display. Pair with `onWeekYearChange` — see the note on that prop. */
  weekYear?: number
  /**
   * Week-year the grid opens on when nothing is selected. Also the way to make a server render
   * deterministic: without any of `value`, `defaultValue` or `weekYear`, the opening year comes
   * from the machine's clock, which the server and the browser can disagree about in the days
   * around New Year — precisely where the week-year is already its least obvious.
   */
  defaultWeekYear?: number
  /**
   * Called with the week-year the grid moved to. **Required if you pass `weekYear`**: the arrow
   * keys leave the displayed year at its edges, and a controlled year that is never updated pins
   * them inside it.
   */
  onWeekYearChange?: (weekYear: number) => void
  /** Earliest selectable week as `YYYY-Www`, inclusive. Also stops the year arrows. */
  min?: string
  /** Latest selectable week as `YYYY-Www`, inclusive. Also stops the year arrows. */
  max?: string
  /**
   * Disables individual weeks on top of `min`/`max` — a closed payroll period, a week with no data.
   * Called with `YYYY-Www`. Unlike `min`/`max` it does not stop the year arrows, since holes can be
   * scattered and a year of them is still worth being able to look at.
   */
  isWeekDisabled?: (value: string) => boolean
  /** BCP-47 tag for the dates, e.g. "ja-JP". Defaults to the browser's own locale. */
  locale?: string
  /** Weeks per row. Default 4. */
  columns?: 3 | 4 | 6
  /**
   * Writes each cell's accessible name. The default is the localised word for "week", the number,
   * and the week's dates — "week 7, Feb 9 – 15, 2026".
   */
  formatWeekLabel?: (info: {
    /** The full value, e.g. "2026-W07". */
    value: string
    /** Week number, from 1. */
    week: number
    /** The week-year, which is not always the calendar year of the dates. */
    weekYear: number
    /** The week's dates, already localised, e.g. "Feb 9 – 15, 2026". */
    dates: string
    /** Inclusive calendar dates as "YYYY-MM-DD". */
    start: string
    end: string
  }) => string
  /** Submits the value with a surrounding form, through a hidden input. */
  name?: string
  /** Accessible name of the back arrow. */
  previousYearLabel?: string
  /** Accessible name of the forward arrow. */
  nextYearLabel?: string
}

const COLUMN_CLASS: Record<3 | 4 | 6, string> = {
  3: "grid-cols-3",
  4: "grid-cols-4",
  6: "grid-cols-6",
}

/**
 * A week-year of ISO weeks as a grid — pick the week itself, not a day inside it.
 *
 * ```tsx
 * const [week, setWeek] = React.useState("2026-W07")
 *
 * return <WeekPicker value={week} onValueChange={setWeek} max={toWeekValue(new Date())} />
 * ```
 *
 * The value is a plain `YYYY-Www` string — the same one `<input type="week">` produces, for an
 * input Firefox and Safari have never shipped. It sorts and compares as it reads, carries no day
 * and no time zone, and `weekDates` turns it into the two calendar dates a query needs.
 */
export const WeekPicker = React.forwardRef<HTMLDivElement, WeekPickerProps>(function WeekPicker(
  {
    className,
    value: valueProp,
    defaultValue,
    onValueChange,
    weekYear: weekYearProp,
    defaultWeekYear,
    onWeekYearChange,
    min,
    max,
    isWeekDisabled,
    locale,
    columns = 4,
    formatWeekLabel,
    name,
    previousYearLabel = "Previous year",
    nextYearLabel = "Next year",
    ...props
  },
  ref
) {
  const captionId = React.useId()

  /**
   * Guards the two things here that come from the machine rather than from props: the locale the
   * dates are written in, and which week is "this" one. Both render as their neutral form until
   * mount, so the server's output and the browser's first render agree.
   */
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isValueControlled = valueProp !== undefined
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "")
  const value = isValueControlled ? valueProp : uncontrolledValue

  const isYearControlled = weekYearProp !== undefined
  const [uncontrolledYear, setUncontrolledYear] = React.useState(() => {
    const selected = parseWeekValue(valueProp ?? defaultValue ?? "")
    if (selected) return selected.weekYear
    if (defaultWeekYear !== undefined) return defaultWeekYear
    // The *week-year* of today, which in the last days of December is already the next one.
    return parseWeekValue(toWeekValue(new Date()))?.weekYear ?? FIRST_WEEK_YEAR
  })
  const displayYear = Math.min(
    Math.max(isYearControlled ? weekYearProp : uncontrolledYear, FIRST_WEEK_YEAR),
    LAST_WEEK_YEAR
  )

  const weekCount = weeksInWeekYear(displayYear)
  const firstMonday = mondayOfFirstWeek(displayYear)

  const [focusedWeek, setFocusedWeek] = React.useState(
    () => parseWeekValue(valueProp ?? defaultValue ?? "")?.week ?? 1
  )

  /**
   * A selection made from outside pulls the grid to it. Without this a parent that sets the value
   * to a week in another year leaves the grid where it was, showing a year of unselected cells with
   * no hint that the choice landed somewhere off screen.
   *
   * Written as an adjustment during render rather than an effect so the corrected year paints in the
   * same commit as the new value, with no frame showing the old one.
   */
  const [lastValue, setLastValue] = React.useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    const selected = parseWeekValue(value)
    if (selected) {
      setFocusedWeek(selected.week)
      if (!isYearControlled && selected.weekYear !== uncontrolledYear) {
        setUncontrolledYear(selected.weekYear)
      }
    }
  }

  // A 53-week year followed by a 52-week one would otherwise leave the focus on a cell that is not
  // rendered, and the grid would have no tab stop at all.
  const safeFocusedWeek = Math.min(focusedWeek, weekCount)

  const labelLocale = locale ?? (mounted ? undefined : HYDRATION_LOCALE)
  const formatted = React.useMemo(() => {
    const pinned = gregorianLocale(labelLocale)
    const word = weekWordIn(pinned)
    // The cell shows where the week starts, because a column of bare numbers answers "which week is
    // this" with another question. The accessible name carries the whole range and the year, since
    // "9" on its own stops meaning anything the moment the arrows have moved.
    const short = new Intl.DateTimeFormat(pinned, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    const full = new Intl.DateTimeFormat(pinned, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    return Array.from({ length: weekCount }, (_, index) => {
      const week = index + 1
      const monday = firstMonday + index * DAYS_PER_WEEK
      const sunday = monday + DAYS_PER_WEEK - 1
      const dates = formatDayRange(full, monday, sunday)
      const start = toDateKey(civilFromDayNumber(monday))
      const end = toDateKey(civilFromDayNumber(sunday))
      // Deliberately not named `value`: that is the *selected* week a few lines up, and a cell
      // carrying the same name for "the week this cell is" is one rename away from a picker that
      // selects whatever it last drew.
      const cellValue = weekValueOf(displayYear, week)
      return {
        week,
        value: cellValue,
        start,
        end,
        startText: short.format(utcNoonOf(monday)),
        label: formatWeekLabel
          ? formatWeekLabel({ value: cellValue, week, weekYear: displayYear, dates, start, end })
          : `${word} ${week}, ${dates}`,
      }
    })
  }, [labelLocale, weekCount, firstMonday, displayYear, formatWeekLabel])

  const currentMonday = React.useMemo(() => {
    if (!mounted) return null
    return mondayFromValue(toWeekValue(new Date()))
  }, [mounted])

  const minMonday = mondayFromValue(min)
  const maxMonday = mondayFromValue(max)
  const selectedMonday = mondayFromValue(value)

  const mondayOfWeek = (week: number) => firstMonday + (week - 1) * DAYS_PER_WEEK

  const outOfRange = (monday: number) =>
    (minMonday !== null && monday < minMonday) || (maxMonday !== null && monday > maxMonday)

  const disabledAt = (week: number) => {
    if (outOfRange(mondayOfWeek(week))) return true
    return isWeekDisabled ? isWeekDisabled(weekValueOf(displayYear, week)) : false
  }

  /**
   * Whether the neighbouring year holds anything selectable.
   *
   * Measured from that year's own last and first Monday rather than from this one's, because the
   * two are not seven days apart when a 53-week year is involved.
   */
  const previousYearLastMonday =
    displayYear > FIRST_WEEK_YEAR
      ? mondayOfFirstWeek(displayYear - 1) + (weeksInWeekYear(displayYear - 1) - 1) * DAYS_PER_WEEK
      : null
  const nextYearFirstMonday =
    displayYear < LAST_WEEK_YEAR ? mondayOfFirstWeek(displayYear + 1) : null

  const canGoBack =
    previousYearLastMonday !== null &&
    (minMonday === null || previousYearLastMonday >= minMonday)
  const canGoForward =
    nextYearFirstMonday !== null && (maxMonday === null || nextYearFirstMonday <= maxMonday)

  const gridRef = React.useRef<HTMLDivElement>(null)
  const cellsRef = React.useRef<Array<HTMLButtonElement | null>>([])
  // Set only by keyboard navigation, so the grid never steals focus on mount or on a parent's
  // unrelated re-render — it moves focus when, and only when, the user asked it to.
  const focusPending = React.useRef(false)

  React.useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    cellsRef.current[safeFocusedWeek - 1]?.focus()
  }, [safeFocusedWeek, displayYear])

  const changeYear = (next: number) => {
    const clamped = Math.min(Math.max(next, FIRST_WEEK_YEAR), LAST_WEEK_YEAR)
    if (!isYearControlled) setUncontrolledYear(clamped)
    onWeekYearChange?.(clamped)
  }

  const select = (week: number) => {
    if (disabledAt(week)) return
    const next = weekValueOf(displayYear, week)
    setFocusedWeek(week)
    if (!isValueControlled) setUncontrolledValue(next)
    onValueChange?.(next)
  }

  /**
   * Walks the calendar rather than the grid: a step off either edge lands in the neighbouring
   * week-year, and the move is made over Mondays so the long years need no special case.
   */
  const moveFocusToMonday = (monday: number) => {
    let target = monday
    if (minMonday !== null && target < minMonday) target = minMonday
    if (maxMonday !== null && target > maxMonday) target = maxMonday
    const moved = weekOfDayNumber(target)
    if (moved.weekYear < FIRST_WEEK_YEAR || moved.weekYear > LAST_WEEK_YEAR) return
    focusPending.current = true
    setFocusedWeek(moved.week)
    if (moved.weekYear !== displayYear) changeYear(moved.weekYear)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The rows run with the writing direction, so on an RTL page the cell to the right of the
    // focused one is the *earlier* week. Read at event time, where there is a real element and no
    // render to keep deterministic.
    const rtl = gridRef.current ? getComputedStyle(gridRef.current).direction === "rtl" : false
    const inline = rtl ? -1 : 1
    const current = mondayOfWeek(safeFocusedWeek)
    let target: number
    switch (event.key) {
      case "ArrowRight":
        target = current + inline * DAYS_PER_WEEK
        break
      case "ArrowLeft":
        target = current - inline * DAYS_PER_WEEK
        break
      case "ArrowDown":
        target = current + columns * DAYS_PER_WEEK
        break
      case "ArrowUp":
        target = current - columns * DAYS_PER_WEEK
        break
      // Rows here are a layout choice — three, four or six across — and mean nothing on a calendar,
      // so Home and End go to the ends of the *year* rather than of the row as they would in a grid
      // of data.
      case "Home":
        target = firstMonday
        break
      case "End":
        target = mondayOfWeek(weekCount)
        break
      // Holds the week number and walks the years, clamped at the end of a 52-week year so W53
      // never lands on a cell that does not exist.
      case "PageUp":
      case "PageDown": {
        const nextYear = displayYear + (event.key === "PageUp" ? -1 : 1)
        if (nextYear < FIRST_WEEK_YEAR || nextYear > LAST_WEEK_YEAR) {
          event.preventDefault()
          return
        }
        const week = Math.min(safeFocusedWeek, weeksInWeekYear(nextYear))
        target = mondayOfFirstWeek(nextYear) + (week - 1) * DAYS_PER_WEEK
        break
      }
      default:
        return
    }
    event.preventDefault()
    moveFocusToMonday(target)
  }

  const rows: Array<Array<(typeof formatted)[number]>> = []
  for (let start = 0; start < formatted.length; start += columns) {
    rows.push(formatted.slice(start, start + columns))
  }

  return (
    <div ref={ref} className={cn("w-full max-w-xs space-y-3", className)} {...props}>
      <div className="flex items-center justify-between gap-2">
        <YearArrow
          direction="back"
          label={previousYearLabel}
          disabled={!canGoBack}
          onClick={() => changeYear(displayYear - 1)}
        />
        {/*
          Live because the arrows change what the grid means without moving focus: a sighted user
          watches the year tick over, and this is the same event reaching everyone else.

          Written as a plain number rather than through `Intl`, because this is the week-year of the
          value — the one the form will post — and a locale on a different calendar would print 2569
          beside a value that says 2026.
        */}
        <div
          id={captionId}
          aria-live="polite"
          className="flex-1 text-center text-sm font-medium tabular-nums"
        >
          {displayYear}
        </div>
        <YearArrow
          direction="forward"
          label={nextYearLabel}
          disabled={!canGoForward}
          onClick={() => changeYear(displayYear + 1)}
        />
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-labelledby={captionId}
        onKeyDown={handleKeyDown}
        className="space-y-1"
      >
        {rows.map((row) => (
          <div key={row[0].week} role="row" className={cn("grid gap-1", COLUMN_CLASS[columns])}>
            {row.map((cell) => {
              const monday = mondayOfWeek(cell.week)
              const isSelected = selectedMonday === monday
              const isCurrent = currentMonday === monday
              const isDisabled = disabledAt(cell.week)
              return (
                <div key={cell.week} role="gridcell" aria-selected={isSelected}>
                  <button
                    ref={(node) => {
                      cellsRef.current[cell.week - 1] = node
                    }}
                    type="button"
                    // Roving tabindex: one stop for the whole grid, then the arrow keys inside it.
                    // Fifty-three tab stops per year is the thing this replaces.
                    tabIndex={cell.week === safeFocusedWeek ? 0 : -1}
                    aria-label={cell.label}
                    // `aria-disabled` rather than `disabled`, so an unavailable week can still be
                    // reached and read. A week the arrow keys skip over silently is a week the user
                    // cannot tell exists.
                    aria-disabled={isDisabled || undefined}
                    aria-current={isCurrent ? "date" : undefined}
                    onClick={() => select(cell.week)}
                    onFocus={() => setFocusedWeek(cell.week)}
                    className={cn(
                      "flex w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isDisabled
                        ? "cursor-default text-muted-foreground opacity-50"
                        : "hover:bg-accent hover:text-accent-foreground",
                      isCurrent && !isSelected && "bg-accent/60 font-medium text-accent-foreground",
                      isSelected &&
                        "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    )}
                  >
                    <span className="text-sm leading-none tabular-nums">{cell.week}</span>
                    {/*
                      Hidden from the reading order because the accessible name above already says
                      the whole range — announcing "Feb 9" after "week 7, Feb 9 – 15, 2026" is the
                      same date twice.
                    */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "text-[10px] leading-none",
                        isSelected ? "opacity-80" : "text-muted-foreground"
                      )}
                    >
                      {cell.startText}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Lets the picker post with a plain form or a server action, with no state plumbing. */}
      {name ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  )
})

function YearArrow({
  direction,
  label,
  disabled,
  onClick,
}: {
  direction: "back" | "forward"
  label: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-40"
      )}
    >
      {/* Inline, so two glyphs cost no icon dependency. */}
      <svg
        className="h-4 w-4 rtl:-scale-x-100"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={direction === "back" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
      </svg>
    </button>
  )
}
