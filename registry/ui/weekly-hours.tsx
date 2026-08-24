"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { TimeInput } from "@/registry/ui/time-input"

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat"

/** One span on a 24-hour clock. Either side is "" while it is still being typed. */
export interface DayHours {
  /** Opening time as "HH:mm", or "" while incomplete. */
  open: string
  /** Closing time as "HH:mm", or "" while incomplete. */
  close: string
}

/**
 * A whole week. `null` is a closed day, and it is deliberately not `{ open: "00:00", close: "00:00" }`:
 * those two have to stay different values or "closed on Sunday" and "open around the clock on Sunday"
 * collapse into the same row, which is the bug this component exists to make impossible.
 */
export type WeeklyHoursValue = Record<Weekday, DayHours | null>

// Indexed by `Date.getUTCDay()`, which is what makes the Intl lookups below line up.
const DAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const FALLBACK_NAMES: Record<Weekday, string> = {
  sun: "Sunday",
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
}

const MINUTES_PER_DAY = 1440

// `getWeekInfo()` is the method ECMA-402 settled on; Safari shipped the same data as a `weekInfo`
// getter first and still answers to it. Reading only one of the two puts half the browsers on the
// fallback, which is how a component ends up showing an American reader a Monday-first week.
type WeekInfoLike = { firstDay?: number }
type LocaleWithWeekInfo = Intl.Locale & {
  getWeekInfo?: () => WeekInfoLike
  weekInfo?: WeekInfoLike
}

/**
 * Which day this locale starts its week on. Sunday in en-US, Monday in de-DE and ja-JP, Saturday in
 * ar-EG — a hardcoded order is wrong for most of the world, and the order is not cosmetic: people
 * read the first row as "the start of the week" and fill the grid from there.
 */
function resolveWeekStart(locale: string | undefined): Weekday {
  try {
    const tag = locale ?? new Intl.DateTimeFormat().resolvedOptions().locale
    const loc = new Intl.Locale(tag) as LocaleWithWeekInfo
    const info = typeof loc.getWeekInfo === "function" ? loc.getWeekInfo() : loc.weekInfo
    const firstDay = info?.firstDay
    // ECMA-402 numbers the days 1 = Monday … 7 = Sunday, so the modulo lands Sunday back on 0.
    if (typeof firstDay === "number" && Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 7) {
      return DAYS[firstDay % 7]
    }
  } catch {
    // Intl.Locale missing, or the tag is malformed.
  }
  // ISO 8601's Monday is the one defensible guess when the runtime will not say.
  return "mon"
}

/**
 * The weekday names as this locale writes them. 2026-01-04 is a Sunday, so adding the index of DAYS
 * to it walks the week in the same order the array is written. Read in UTC, because formatting a
 * midnight date in a zone west of UTC hands back the day before.
 */
function resolveDayNames(locale: string | undefined): Record<Weekday, string> {
  let fmt: Intl.DateTimeFormat | null = null
  try {
    fmt = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" })
  } catch {
    fmt = null
  }
  const out = {} as Record<Weekday, string>
  DAYS.forEach((day, i) => {
    let name = FALLBACK_NAMES[day]
    if (fmt) {
      try {
        name = fmt.format(new Date(Date.UTC(2026, 0, 4 + i)))
      } catch {
        name = FALLBACK_NAMES[day]
      }
    }
    out[day] = name
  })
  return out
}

/** The week in reading order, starting from `start`. */
function orderFrom(start: Weekday): Weekday[] {
  const at = DAYS.indexOf(start)
  const from = at === -1 ? 1 : at
  return DAYS.map((_, i) => DAYS[(from + i) % DAYS.length])
}

// Accepts what a server is likely to send as well as what this component emits: "9:00" as well as
// "09:00", and "17:30:00" as well as "17:30". Seconds are dropped rather than kept — opening hours
// are not kept to the second, and passing them on would only make the two sides of a comparison
// disagree about width.
const TIME_PATTERN = /^(\d{1,2}):(\d{2})(?::\d{2})?$/

function normalizeTime(text: unknown): string {
  if (typeof text !== "string") return ""
  const m = TIME_PATTERN.exec(text.trim())
  if (m === null) return ""
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (minute > 59) return ""
  // "24:00" is how a lot of stored data writes the end of the day. It is midnight, and the wrap rule
  // below turns 09:00–24:00 into the fifteen hours it should be rather than throwing the value away.
  if (hour === 24 && minute === 0) return "00:00"
  if (hour > 23) return ""
  return `${String(hour).padStart(2, "0")}:${m[2]}`
}

function normalizeDay(input: unknown): DayHours | null {
  if (input === null || typeof input !== "object") return null
  const day = input as Partial<DayHours>
  return { open: normalizeTime(day.open), close: normalizeTime(day.close) }
}

/** Fills in the days the caller left out. A missing day is a closed day, not an empty open one. */
function normalizeWeek(input: Partial<WeeklyHoursValue> | undefined): WeeklyHoursValue {
  const out = {} as WeeklyHoursValue
  for (const day of DAYS) out[day] = normalizeDay(input?.[day])
  return out
}

function toMinutes(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text)
  return m === null ? null : Number(m[1]) * 60 + Number(m[2])
}

export type DaySpan =
  /** Open, but nothing typed yet. */
  | { kind: "empty" }
  /** Open with one side filled in — the one state that is actually wrong. */
  | { kind: "partial" }
  /** Opening and closing time are equal, which is the whole day. */
  | { kind: "allDay"; minutes: number }
  /** Closes after midnight: the late bar, the night shift. */
  | { kind: "overnight"; minutes: number }
  | { kind: "range"; minutes: number }

/**
 * Reads one day's two times as a span.
 *
 * A closing time earlier than the opening time is not an error, it is the night: 22:00–02:00 is a
 * bar that shuts at two in the morning, and comparing the two strings naively marks every late
 * business invalid. This is the same rule `time-input` applies to `min`/`max`, lifted from the
 * inside of one field to the pair of them.
 */
export function readDaySpan(hours: DayHours): DaySpan {
  const open = toMinutes(hours.open)
  const close = toMinutes(hours.close)
  if (open === null && close === null) return { kind: "empty" }
  if (open === null || close === null) return { kind: "partial" }
  const minutes = (close - open + MINUTES_PER_DAY) % MINUTES_PER_DAY
  if (minutes === 0) return { kind: "allDay", minutes: MINUTES_PER_DAY }
  return close < open ? { kind: "overnight", minutes } : { kind: "range", minutes }
}

/**
 * The days that are open but only half filled in — what to check before saving. Days that are
 * closed, and days whose span merely runs past midnight, are not listed: neither is a mistake.
 */
export function incompleteDays(value: Partial<WeeklyHoursValue> | undefined): Weekday[] {
  const week = normalizeWeek(value)
  return DAYS.filter((day) => {
    const hours = week[day]
    return hours !== null && readDaySpan(hours).kind === "partial"
  })
}

function formatSpan(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) return `${rest}m`
  if (rest === 0) return `${hours}h`
  return `${hours}h ${rest}m`
}

// Only the weekday names come from Intl. These are interface copy rather than data — there is one of
// each, they sit next to the fields they describe, and this is a file you own and edit, so a
// translation prop would be one more thing to thread through for something a find-and-replace does.
function hintFor(span: DaySpan): string {
  switch (span.kind) {
    case "empty":
      return ""
    case "partial":
      return "Needs an opening and a closing time"
    case "allDay":
      return "Open 24 hours"
    case "overnight":
      return `${formatSpan(span.minutes)}, closes the next day`
    case "range":
      return formatSpan(span.minutes)
  }
}

interface WeeklyHoursProps {
  /** Controlled value. Days you leave out are closed. */
  value?: Partial<WeeklyHoursValue>
  /** Initial value when uncontrolled, same shape as `value`. */
  defaultValue?: Partial<WeeklyHoursValue>
  /**
   * Fires with the whole week on every edit, always with all seven days present.
   * Store what it hands you verbatim — a half-typed day arrives as `{ open: "", close: "17:00" }`,
   * and dropping the incomplete side would take the keystrokes with it.
   */
  onChange?: (value: WeeklyHoursValue) => void
  /** Day the week starts on. Left unset, the locale decides (Sunday in en-US, Monday in de-DE). */
  weekStartsOn?: Weekday
  /** BCP-47 locale for the day names, the week start and the clock the fields show. */
  locale?: string
  /** Force a 12- or 24-hour clock in the time fields. Left unset, the locale decides. */
  hour12?: boolean
  /** Arrow-key increment on the minute segments, in minutes. */
  minuteStep?: number
  /** Hours a day is given when it is switched on and has none yet. */
  defaultDayHours?: DayHours
  /** Disable every control. */
  disabled?: boolean
  /**
   * When set, a hidden input of this name carries the week as JSON so it submits with a native form.
   * JSON rather than one field per day because `null` has to survive the trip: a flat encoding has
   * no way to tell a closed day from a day whose fields were left empty.
   */
  name?: string
  /** Accessible label for the whole editor (default "Opening hours"). */
  "aria-label"?: string
  className?: string
}

export function WeeklyHours({
  value,
  defaultValue,
  onChange,
  weekStartsOn,
  locale,
  hour12,
  minuteStep = 1,
  defaultDayHours = { open: "09:00", close: "17:00" },
  disabled,
  name,
  className,
  "aria-label": ariaLabel = "Opening hours",
}: WeeklyHoursProps) {
  const isControlled = value !== undefined
  const [inner, setInner] = React.useState<WeeklyHoursValue>(() => normalizeWeek(defaultValue))

  // Read straight from the prop when controlled rather than mirroring it into state. Everything on
  // screen is in the value — an open day with nothing typed is `{ open: "", close: "" }`, which is a
  // different value from `null` — so there is no on-screen state left over to lose, and no effect
  // needed to keep a copy in step.
  const week = isControlled ? normalizeWeek(value) : inner

  // What each day had before it was switched off, so switching it back on returns the hours the
  // person typed instead of the default. Not part of the value: it is a memory, not something shown.
  const remembered = React.useRef<Partial<Record<Weekday, DayHours>>>({})

  const dayNames = React.useMemo(() => resolveDayNames(locale), [locale])
  const order = React.useMemo(
    () => orderFrom(weekStartsOn ?? resolveWeekStart(locale)),
    [weekStartsOn, locale]
  )

  const reactId = React.useId()
  const hintId = (day: Weekday) => `${reactId}-${day}-hint`
  const labelId = (day: Weekday) => `${reactId}-${day}-label`

  function emit(next: WeeklyHoursValue) {
    if (!isControlled) setInner(next)
    onChange?.(next)
  }

  function setDay(day: Weekday, hours: DayHours | null) {
    emit({ ...week, [day]: hours })
  }

  function toggleDay(day: Weekday, open: boolean) {
    if (!open) {
      const current = week[day]
      // Only worth remembering if something was typed; an empty row is not a loss to restore.
      if (current !== null && (current.open !== "" || current.close !== "")) {
        remembered.current[day] = current
      }
      setDay(day, null)
      return
    }
    setDay(day, remembered.current[day] ?? { ...defaultDayHours })
  }

  function applyToAll(source: Weekday) {
    const hours = week[source]
    if (hours === null) return
    const next = {} as WeeklyHoursValue
    for (const day of DAYS) next[day] = { ...hours }
    emit(next)
  }

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("w-full text-sm", disabled && "opacity-50", className)}
    >
      {order.map((day) => {
        const hours = week[day]
        const isOpen = hours !== null
        const span = hours === null ? null : readDaySpan(hours)
        const hint = span === null ? "" : hintFor(span)
        const complete =
          span !== null && (span.kind === "range" || span.kind === "overnight" || span.kind === "allDay")

        return (
          <div
            key={day}
            role="group"
            aria-labelledby={labelId(day)}
            aria-describedby={hint === "" ? undefined : hintId(day)}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border py-2 last:border-b-0"
          >
            <div className="flex w-36 shrink-0 items-center gap-2">
              <input
                type="checkbox"
                checked={isOpen}
                disabled={disabled}
                // The day name is right there, so the control says what checking it does rather than
                // repeating the name on its own and leaving a reader to guess what "Monday" means.
                aria-label={`Open on ${dayNames[day]}`}
                onChange={(e) => toggleDay(day, e.target.checked)}
                className={cn(
                  "h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-primary",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed"
                )}
              />
              <span id={labelId(day)} className={cn(!isOpen && "text-muted-foreground")}>
                {dayNames[day]}
              </span>
            </div>

            {hours !== null ? (
              <div className="flex items-center gap-2">
                <TimeInput
                  value={hours.open}
                  onChange={(next) => setDay(day, { ...hours, open: next })}
                  locale={locale}
                  hour12={hour12}
                  minuteStep={minuteStep}
                  disabled={disabled}
                  aria-label={`${dayNames[day]} opening time`}
                />
                <span aria-hidden="true" className="text-muted-foreground">
                  –
                </span>
                <TimeInput
                  value={hours.close}
                  onChange={(next) => setDay(day, { ...hours, close: next })}
                  locale={locale}
                  hour12={hour12}
                  minuteStep={minuteStep}
                  disabled={disabled}
                  aria-label={`${dayNames[day]} closing time`}
                />
              </div>
            ) : (
              <span className="text-muted-foreground">Closed</span>
            )}

            <span
              id={hintId(day)}
              className={cn(
                "text-xs tabular-nums",
                span?.kind === "partial" ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {hint}
            </span>

            {isOpen ? (
              <button
                type="button"
                disabled={disabled || !complete}
                onClick={() => applyToAll(day)}
                // The visible text opens the accessible name, so "click apply to all" reaches this
                // button by voice while a screen reader still hears which day is being copied.
                aria-label={`Apply to all days, using ${dayNames[day]}'s hours`}
                className={cn(
                  "ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-0"
                )}
              >
                Apply to all
              </button>
            ) : null}
          </div>
        )
      })}
      {name ? <input type="hidden" name={name} value={JSON.stringify(week)} /> : null}
    </div>
  )
}
