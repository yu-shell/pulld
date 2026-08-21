"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const MONTHS_IN_YEAR = 12

/**
 * The locale the month names are formatted in before hydration.
 *
 * The runtime's own locale is a property of the machine, so the server's and the browser's can
 * disagree — and month names are the one thing on this component that would then differ between
 * the two renders. Both sides therefore start from the same constant and the real locale swaps in
 * on mount. Passing `locale` skips the swap entirely and is the fix if the first paint matters.
 */
const HYDRATION_LOCALE = "en-US"

/** "2026-08". Anchored so a stray day part ("2026-08-01") is rejected rather than half-read. */
const MONTH_VALUE_PATTERN = /^(\d{4,})-(0[1-9]|1[0-2])$/

/** A single ordering key for a calendar month, so `min`/`max` compare with `<` instead of strings. */
function ordinalOf(year: number, monthIndex: number): number {
  return year * MONTHS_IN_YEAR + monthIndex
}

/**
 * The years a `YYYY-MM` string can actually hold.
 *
 * Navigation is unbounded unless `min`/`max` say otherwise, so without these the arrows walk past
 * year zero and `valueOf` starts emitting things like "00-1-12" — a string this component's own
 * parser rejects, handed to the caller as though it were a month. The far end is the same story
 * one digit up.
 */
const FIRST_ORDINAL = ordinalOf(0, 0)
const LAST_ORDINAL = ordinalOf(9999, MONTHS_IN_YEAR - 1)

function valueOf(year: number, monthIndex: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}`
}

/**
 * The calendar month a `Date` falls in, read from its **local** fields — the month the person
 * looking at that date would name.
 *
 * `toISOString().slice(0, 7)` is the tempting one-liner and it is wrong for half the planet: it
 * reads UTC, so 23:00 on 31 August in Berlin comes back as September.
 */
export function toMonthValue(date: Date): string {
  return valueOf(date.getFullYear(), date.getMonth())
}

/**
 * `{ year, month }` with **month 1–12** as written in the string, or null when the string is not a
 * month value.
 *
 * There is deliberately no `Date` accessor here. A month is a calendar span, not an instant, and
 * anything that hands back a `Date` has quietly chosen a day and a time zone on the caller's
 * behalf — the bug that makes a billing period start on the last day of the previous month for
 * everyone west of UTC. Build the instant where you know the zone: `new Date(year, month - 1, 1)`.
 */
export function parseMonthValue(value: string): { year: number; month: number } | null {
  const parsed = MONTH_VALUE_PATTERN.exec(value)
  if (!parsed) return null
  return { year: Number(parsed[1]), month: Number(parsed[2]) }
}

function ordinalFromValue(value: string | undefined): number | null {
  if (!value) return null
  const parsed = parseMonthValue(value)
  return parsed ? ordinalOf(parsed.year, parsed.month - 1) : null
}

/**
 * The first of a month, as UTC, safe for years under 100.
 *
 * `new Date(Date.UTC(50, 0, 1))` is the year **1950**: the two-digit-year rule from the original
 * Date constructor still applies to `Date.UTC`. Setting the year afterwards is the documented way
 * out, and it is the difference between a year-99 archive picker being right and being off by
 * nineteen centuries without saying so.
 */
function firstOfMonthUTC(year: number, monthIndex: number): Date {
  const at = new Date(Date.UTC(2000, monthIndex, 1))
  at.setUTCFullYear(year)
  return at
}

export interface MonthPickerProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "value" | "defaultValue" | "children"
  > {
  /** Controlled month as `YYYY-MM`, e.g. "2026-08". Pair with `onValueChange`. */
  value?: string
  /** Starting month for an uncontrolled picker. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen `YYYY-MM`. Never called for a month outside `min`/`max`. */
  onValueChange?: (value: string) => void
  /** Controlled year on display. Pair with `onYearChange` — see the note on that prop. */
  year?: number
  /**
   * Year the grid opens on when nothing is selected. Also the way to make a server render
   * deterministic: without any of `value`, `defaultValue` or `year`, the opening year comes from
   * the machine's clock, which server and browser can disagree about on New Year's Eve.
   */
  defaultYear?: number
  /**
   * Called with the year the grid moved to. **Required if you pass `year`**: arrow keys leave the
   * displayed year at its edges, and a controlled year that is never updated pins them inside it.
   */
  onYearChange?: (year: number) => void
  /** Earliest selectable month as `YYYY-MM`, inclusive. Also stops the year arrows. */
  min?: string
  /** Latest selectable month as `YYYY-MM`, inclusive. Also stops the year arrows. */
  max?: string
  /**
   * Disables individual months on top of `min`/`max` — closed accounting periods, months with no
   * data. Called with `YYYY-MM`. Unlike `min`/`max` it does not stop the year arrows, since holes
   * can be scattered and a year of them is still worth being able to look at.
   */
  isMonthDisabled?: (value: string) => boolean
  /** BCP-47 tag for the month names, e.g. "ja-JP". Defaults to the browser's own locale. */
  locale?: string
  /** How month names are written. Default "short" ("Aug"); "long" gives "August". */
  monthFormat?: "short" | "long" | "narrow"
  /** Months per row. 12 divides by all three, so no row is ever short. Default 3. */
  columns?: 2 | 3 | 4
  /** Submits the value with a surrounding form, through a hidden input. */
  name?: string
  /** Accessible name of the back arrow. */
  previousYearLabel?: string
  /** Accessible name of the forward arrow. */
  nextYearLabel?: string
}

/**
 * A year of months as a grid — pick the month itself, not a day inside it.
 *
 * ```tsx
 * const [month, setMonth] = React.useState("2026-08")
 *
 * return <MonthPicker value={month} onValueChange={setMonth} max={toMonthValue(new Date())} />
 * ```
 *
 * The value is a plain `YYYY-MM` string: sortable, comparable, free of any day or time zone, and
 * the same thing an API means by `?period=2026-08`.
 */
export const MonthPicker = React.forwardRef<HTMLDivElement, MonthPickerProps>(function MonthPicker(
  {
    className,
    value: valueProp,
    defaultValue,
    onValueChange,
    year: yearProp,
    defaultYear,
    onYearChange,
    min,
    max,
    isMonthDisabled,
    locale,
    monthFormat = "short",
    columns = 3,
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
   * month names are formatted in, and which month is "this" one. Both are rendered as their
   * neutral form until mount, so the server's output and the browser's first render agree.
   */
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isValueControlled = valueProp !== undefined
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue ?? "")
  const value = isValueControlled ? valueProp : uncontrolledValue

  const isYearControlled = yearProp !== undefined
  const [uncontrolledYear, setUncontrolledYear] = React.useState(() => {
    const selected = parseMonthValue(valueProp ?? defaultValue ?? "")
    if (selected) return selected.year
    if (defaultYear !== undefined) return defaultYear
    return new Date().getFullYear()
  })
  const displayYear = isYearControlled ? yearProp : uncontrolledYear

  const [focusedIndex, setFocusedIndex] = React.useState(() => {
    const selected = parseMonthValue(valueProp ?? defaultValue ?? "")
    return selected ? selected.month - 1 : 0
  })

  /**
   * A selection made from outside pulls the grid to it. Without this a parent that sets the value
   * to a month in another year leaves the grid where it was, showing twelve unselected cells with
   * no hint that the choice landed somewhere off screen.
   *
   * Written as an adjustment during render rather than an effect so the corrected year paints in
   * the same commit as the new value, with no frame showing the old one.
   */
  const [lastValue, setLastValue] = React.useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    const selected = parseMonthValue(value)
    if (selected) {
      setFocusedIndex(selected.month - 1)
      if (!isYearControlled && selected.year !== uncontrolledYear) {
        setUncontrolledYear(selected.year)
      }
    }
  }

  const labelLocale = locale ?? (mounted ? undefined : HYDRATION_LOCALE)
  const months = React.useMemo(() => {
    const short = new Intl.DateTimeFormat(labelLocale, { month: monthFormat, timeZone: "UTC" })
    // The visible label can be an abbreviation, and "Aug" on its own stops meaning anything once
    // the year arrows have moved. Every cell therefore carries the month spelled out with its
    // year, which is also what makes the grid usable when the caption is off screen.
    const full = new Intl.DateTimeFormat(labelLocale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    })
    return Array.from({ length: MONTHS_IN_YEAR }, (_, index) => {
      const at = firstOfMonthUTC(displayYear, index)
      return { text: short.format(at), label: full.format(at) }
    })
  }, [labelLocale, monthFormat, displayYear])

  const currentOrdinal = React.useMemo(() => {
    if (!mounted) return null
    const now = new Date()
    return ordinalOf(now.getFullYear(), now.getMonth())
  }, [mounted])

  const minOrdinal = ordinalFromValue(min)
  const maxOrdinal = ordinalFromValue(max)
  const selectedOrdinal = ordinalFromValue(value)

  const outOfRange = (ordinal: number) =>
    (minOrdinal !== null && ordinal < minOrdinal) || (maxOrdinal !== null && ordinal > maxOrdinal)

  const disabledAt = (index: number) => {
    const ordinal = ordinalOf(displayYear, index)
    if (outOfRange(ordinal)) return true
    return isMonthDisabled ? isMonthDisabled(valueOf(displayYear, index)) : false
  }

  const canGoBack =
    ordinalOf(displayYear - 1, MONTHS_IN_YEAR - 1) >= FIRST_ORDINAL &&
    (minOrdinal === null || ordinalOf(displayYear - 1, MONTHS_IN_YEAR - 1) >= minOrdinal)
  const canGoForward =
    ordinalOf(displayYear + 1, 0) <= LAST_ORDINAL &&
    (maxOrdinal === null || ordinalOf(displayYear + 1, 0) <= maxOrdinal)

  const gridRef = React.useRef<HTMLDivElement>(null)
  const cellsRef = React.useRef<Array<HTMLButtonElement | null>>([])
  // Set only by keyboard navigation, so the grid never steals focus on mount or on a parent's
  // unrelated re-render — it moves focus when, and only when, the user asked it to.
  const focusPending = React.useRef(false)

  React.useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    cellsRef.current[focusedIndex]?.focus()
  }, [focusedIndex, displayYear])

  const changeYear = (next: number) => {
    if (!isYearControlled) setUncontrolledYear(next)
    onYearChange?.(next)
  }

  const select = (index: number) => {
    if (disabledAt(index)) return
    const next = valueOf(displayYear, index)
    setFocusedIndex(index)
    if (!isValueControlled) setUncontrolledValue(next)
    onValueChange?.(next)
  }

  /** Walks the calendar, not the grid: a step off either edge lands in the neighbouring year. */
  const moveFocusTo = (ordinal: number) => {
    let target = Math.min(Math.max(ordinal, FIRST_ORDINAL), LAST_ORDINAL)
    if (minOrdinal !== null && target < minOrdinal) target = minOrdinal
    if (maxOrdinal !== null && target > maxOrdinal) target = maxOrdinal
    const nextYear = Math.floor(target / MONTHS_IN_YEAR)
    focusPending.current = true
    setFocusedIndex(target - nextYear * MONTHS_IN_YEAR)
    if (nextYear !== displayYear) changeYear(nextYear)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The rows are laid out with the writing direction, so on an RTL page the cell to the right of
    // the focused one is the *earlier* month. Read at event time, where there is a real element and
    // no render to keep deterministic.
    const rtl = gridRef.current
      ? getComputedStyle(gridRef.current).direction === "rtl"
      : false
    const inline = rtl ? -1 : 1
    const current = ordinalOf(displayYear, focusedIndex)
    let target: number
    switch (event.key) {
      case "ArrowRight":
        target = current + inline
        break
      case "ArrowLeft":
        target = current - inline
        break
      case "ArrowDown":
        target = current + columns
        break
      case "ArrowUp":
        target = current - columns
        break
      // Rows here are a layout choice — two, three or four across — and mean nothing on a calendar,
      // so Home and End go to the ends of the *year* rather than of the row as they would in a
      // grid of data.
      case "Home":
        target = ordinalOf(displayYear, 0)
        break
      case "End":
        target = ordinalOf(displayYear, MONTHS_IN_YEAR - 1)
        break
      case "PageUp":
        target = current - MONTHS_IN_YEAR
        break
      case "PageDown":
        target = current + MONTHS_IN_YEAR
        break
      default:
        return
    }
    event.preventDefault()
    moveFocusTo(target)
  }

  const rows: number[][] = []
  for (let start = 0; start < MONTHS_IN_YEAR; start += columns) {
    rows.push(Array.from({ length: columns }, (_, offset) => start + offset))
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
          <div key={row[0]} role="row" className="flex gap-1">
            {row.map((index) => {
              const ordinal = ordinalOf(displayYear, index)
              const isSelected = selectedOrdinal === ordinal
              const isCurrent = currentOrdinal === ordinal
              const isDisabled = disabledAt(index)
              return (
                <div key={index} role="gridcell" aria-selected={isSelected} className="flex-1">
                  <button
                    ref={(node) => {
                      cellsRef.current[index] = node
                    }}
                    type="button"
                    // Roving tabindex: one stop for the whole grid, then the arrow keys inside it.
                    // Twelve tab stops per year is the thing this replaces.
                    tabIndex={index === focusedIndex ? 0 : -1}
                    aria-label={months[index].label}
                    // `aria-disabled` rather than `disabled`, so an unavailable month can still be
                    // reached and read. A month the arrow keys skip over silently is a month the
                    // user cannot tell exists.
                    aria-disabled={isDisabled || undefined}
                    aria-current={isCurrent ? "date" : undefined}
                    onClick={() => select(index)}
                    onFocus={() => setFocusedIndex(index)}
                    className={cn(
                      "inline-flex h-9 w-full items-center justify-center rounded-md px-1 text-sm font-normal transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isDisabled
                        ? "cursor-default text-muted-foreground opacity-50"
                        : "hover:bg-accent hover:text-accent-foreground",
                      isCurrent && !isSelected && "bg-accent/60 font-medium text-accent-foreground",
                      isSelected &&
                        "bg-primary font-medium text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                    )}
                  >
                    {months[index].text}
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
