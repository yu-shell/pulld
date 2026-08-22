"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type SegmentName = "hour" | "minute" | "second" | "dayPeriod"

type Part = { type: SegmentName } | { type: "literal"; value: string }

// The four cycles CLDR actually uses, and they differ in more than twelve versus twenty-four:
// midnight is "0 AM" in h11, "12 AM" in h12, "00" in h23 and "24" in h24. A field that only knows
// h12 and h23 shows a ja-JP reader "0 AM" and turns a typed 24:00 into nothing.
type HourCycle = "h11" | "h12" | "h23" | "h24"

// `hourCycle` on the resolved options is newer than the ES2020 lib a lot of projects still target,
// so it is read through a local widening. Requiring a lib bump would make this component fail to
// compile in a perfectly ordinary consumer project.
type ResolvedTimeOptions = Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string }

interface TimeInputProps {
  /** Controlled value as a 24-hour clock string — "HH:mm", or "HH:mm:ss" with `withSeconds`. "" while incomplete. */
  value?: string
  /** Initial value when uncontrolled, same shape as `value`. */
  defaultValue?: string
  /** Fires with the 24-hour string, or "" while any segment is still empty. */
  onChange?: (value: string) => void
  /** Add a seconds segment, and emit "HH:mm:ss". */
  withSeconds?: boolean
  /** Earliest valid time. Typing is never blocked; times outside the range are flagged with aria-invalid. */
  min?: string
  /** Latest valid time. When `max` is earlier than `min` the range wraps past midnight, so 22:00–06:00 means the night. */
  max?: string
  /** Arrow-key increment on the minute segment, in minutes. Off-step minutes round toward the arrow. */
  minuteStep?: number
  /** BCP-47 locale deciding segment order, the separators and the AM/PM wording. Defaults to the runtime's. */
  locale?: string
  /** Force a 12- or 24-hour clock. Left unset, the locale decides. */
  hour12?: boolean
  /** Disable every segment. */
  disabled?: boolean
  /** Accessible label for the field group (default "Time"). */
  "aria-label"?: string
  /** When set, a hidden input mirrors the 24-hour value so it submits with a native form. */
  name?: string
  className?: string
}

type Fields = {
  hour: number | null
  minute: number | null
  second: number | null
  /** 0 = AM, 1 = PM. Kept alongside the hour so the period can be picked before the hour is typed. */
  period: 0 | 1 | null
}

const EMPTY_FIELDS: Fields = { hour: null, minute: null, second: null, period: null }
const EMPTY_BUF: Record<SegmentName, string> = { hour: "", minute: "", second: "", dayPeriod: "" }

const LABELS: Record<SegmentName, string> = {
  hour: "Hour",
  minute: "Minute",
  second: "Second",
  dayPeriod: "AM/PM",
}
const PLACEHOLDERS: Record<SegmentName, string> = {
  hour: "hh",
  minute: "mm",
  second: "ss",
  dayPeriod: "--",
}

const HOUR_RANGE: Record<HourCycle, { min: number; max: number }> = {
  h11: { min: 0, max: 11 },
  h12: { min: 1, max: 12 },
  h23: { min: 0, max: 23 },
  h24: { min: 1, max: 24 },
}

const is12Hour = (cycle: HourCycle) => cycle === "h11" || cycle === "h12"

// Ask the runtime which clock this locale writes rather than assuming one: en-US is on twelve hours
// and en-GB, de-DE and ja-JP are on twenty-four, so a hardcoded choice is wrong for most readers.
// An explicit `hour12` still goes through Intl, because "twelve hours" means h11 in ja-JP and h12 in
// en-US and only the locale knows which.
function resolveCycle(locale: string | undefined, hour12: boolean | undefined): HourCycle {
  try {
    const opts = hour12 === undefined ? { hour: "numeric" as const } : { hour: "numeric" as const, hour12 }
    const resolved = new Intl.DateTimeFormat(locale, opts).resolvedOptions() as ResolvedTimeOptions
    const cycle = resolved.hourCycle
    if (cycle === "h11" || cycle === "h12" || cycle === "h23" || cycle === "h24") return cycle
    // Older runtimes report hour12 without hourCycle.
    if (typeof resolved.hour12 === "boolean") return resolved.hour12 ? "h12" : "h23"
  } catch {
    // Intl missing, or the locale tag is malformed.
  }
  return hour12 ? "h12" : "h23"
}

function fallbackParts(cycle: HourCycle, withSeconds: boolean): Part[] {
  const out: Part[] = [{ type: "hour" }, { type: "literal", value: ":" }, { type: "minute" }]
  if (withSeconds) out.push({ type: "literal", value: ":" }, { type: "second" })
  if (is12Hour(cycle)) out.push({ type: "literal", value: " " }, { type: "dayPeriod" })
  return out
}

// Segment order and separators come from Intl too. ko-KR puts the day period *before* the hour and
// ja-JP writes it with no space after it, neither of which a hand-built layout gets right.
function buildParts(locale: string | undefined, cycle: HourCycle, withSeconds: boolean): Part[] {
  try {
    const fmt = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" as const } : null),
      hourCycle: cycle,
      timeZone: "UTC",
    })
    // A runtime too old to know `hourCycle` ignores it silently and lays the segments out for the
    // other clock, so the resolved value is checked instead of trusted.
    if ((fmt.resolvedOptions() as ResolvedTimeOptions).hourCycle !== cycle) {
      return fallbackParts(cycle, withSeconds)
    }
    const out: Part[] = []
    for (const p of fmt.formatToParts(new Date(Date.UTC(2026, 0, 2, 13, 5, 7)))) {
      if (p.type === "hour" || p.type === "minute" || p.type === "second" || p.type === "dayPeriod") {
        out.push({ type: p.type })
      } else if (p.type === "literal") {
        out.push({ type: "literal", value: p.value })
      }
    }
    const named = new Set(out.filter((p) => p.type !== "literal").map((p) => p.type))
    const wanted = 2 + (withSeconds ? 1 : 0) + (is12Hour(cycle) ? 1 : 0)
    if (named.size === wanted) return out
  } catch {
    // Intl missing, or the locale tag is malformed.
  }
  return fallbackParts(cycle, withSeconds)
}

// The AM and PM wording as this locale writes it — "AM", "午前", "오전", "ص". Only the two names are
// taken from Intl; the digits are rendered here, because ar-EG would otherwise hand back
// Arabic-Indic numerals that cannot be typed back into the field.
function dayPeriodNames(locale: string | undefined, cycle: HourCycle): [string, string] {
  const read = (hour: number, fallback: string) => {
    try {
      const parts = new Intl.DateTimeFormat(locale, {
        hour: "numeric",
        hourCycle: cycle,
        timeZone: "UTC",
      }).formatToParts(new Date(Date.UTC(2026, 0, 2, hour)))
      return parts.find((p) => p.type === "dayPeriod")?.value ?? fallback
    } catch {
      return fallback
    }
  }
  return [read(9, "AM"), read(21, "PM")]
}

function toDisplayHour(hour: number, cycle: HourCycle) {
  if (cycle === "h23") return hour
  if (cycle === "h24") return hour === 0 ? 24 : hour
  const wrapped = hour % 12
  return cycle === "h12" ? (wrapped === 0 ? 12 : wrapped) : wrapped
}

// The off-by-twelve that hand-rolled 12-hour fields are famous for: 12 AM is midnight and 12 PM is
// noon, so the displayed 12 has to fall to 0 before the PM half is added.
function fromDisplayHour(display: number, period: 0 | 1 | null, cycle: HourCycle) {
  if (cycle === "h23") return display
  if (cycle === "h24") return display === 24 ? 0 : display
  const base = cycle === "h12" ? display % 12 : display
  return base + (period === 1 ? 12 : 0)
}

// The hour is deliberately not settable here. It has to travel through `withHour` so the day period
// moves with it, and leaving it out of this signature makes that a compile error rather than a
// convention someone has to remember.
function setField(f: Fields, seg: Exclude<SegmentName, "hour">, value: number | null): Fields {
  if (seg === "minute") return { ...f, minute: value }
  if (seg === "second") return { ...f, second: value }
  return withPeriod(f, value === null ? null : value === 1 ? 1 : 0)
}

// Setting the period moves the hour with it, and setting the hour re-derives the period, so the two
// can never disagree about whether 13:00 is showing PM.
function withPeriod(f: Fields, period: 0 | 1 | null): Fields {
  if (f.hour === null || period === null) return { ...f, period }
  const hour = (f.hour % 12) + (period === 1 ? 12 : 0)
  return { ...f, hour, period }
}

function withHour(f: Fields, hour: number | null): Fields {
  if (hour === null) return { ...f, hour: null }
  return { ...f, hour, period: hour >= 12 ? 1 : 0 }
}

const pad = (n: number) => String(n).padStart(2, "0")

function toValue(f: Fields, withSeconds: boolean) {
  const { hour, minute, second } = f
  if (hour === null || minute === null) return ""
  const hm = `${pad(hour)}:${pad(minute)}`
  if (!withSeconds) return hm
  return second === null ? "" : `${hm}:${pad(second)}`
}

// Accepts "HH:mm" and "HH:mm:ss" — the same shape a native time input produces. A full timestamp is
// rejected rather than guessed at, because reading one applies a time zone and can shift the clock.
function parseValue(text: string | undefined): Fields {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((text ?? "").trim())
  if (!m) return EMPTY_FIELDS
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = m[3] === undefined ? null : Number(m[3])
  if (hour > 23 || minute > 59 || (second !== null && second > 59)) return EMPTY_FIELDS
  return { hour, minute, second, period: hour >= 12 ? 1 : 0 }
}

// One typed digit. `advance` reports that no further digit could extend this segment, which is what
// makes "5" jump straight to the minute on a 24-hour clock while "1" waits for a possible 10-19.
// `min` is what lets midnight be typed: on h23 a lone "0" is already hour zero, while on h12 it has
// to wait for the digit that turns it into 01-09. A pair that would be out of range starts a new
// number instead of being dropped, so no keystroke is ever lost.
function typeDigit(buf: string, digit: string, min: number, max: number) {
  const combined = Number(buf + digit)
  if (buf !== "" && combined >= min && combined <= max) {
    return { buf: "", value: combined, advance: true }
  }
  const d = Number(digit)
  if (d < min) return { buf: digit, value: null, advance: false }
  if (d * 10 > max) return { buf: "", value: d, advance: true }
  return { buf: digit, value: d, advance: false }
}

function wrap(value: number, min: number, max: number) {
  const span = max - min + 1
  return ((((value - min) % span) + span) % span) + min
}

// Arrows wrap every segment, because unlike a year there is nothing past the end of a clock. The
// hour steps inside the displayed twelve and leaves AM/PM alone, which is what the native control
// does: 11 → 12 → 1 without silently jumping the reader half a day.
function stepSegment(
  f: Fields,
  seg: SegmentName,
  delta: number,
  cycle: HourCycle,
  minuteStep: number,
  now: Fields
): Fields {
  if (seg === "dayPeriod") {
    const cur = f.period ?? now.period ?? 0
    return withPeriod(f, f.period === null ? cur : cur === 1 ? 0 : 1)
  }
  const cur = f[seg]
  // The first press on an empty segment seeds from the current time rather than jumping to zero,
  // which is what makes the arrows usable for a time near now.
  if (cur === null) {
    if (seg === "hour") return withHour(f, now.hour)
    return setField(f, seg, now[seg])
  }
  if (seg === "hour") {
    const range = HOUR_RANGE[cycle]
    const next = wrap(toDisplayHour(cur, cycle) + delta, range.min, range.max)
    return { ...f, hour: fromDisplayHour(next, f.period, cycle) }
  }
  if (seg === "second") return setField(f, seg, wrap(cur + delta, 0, 59))
  // An off-step minute rounds toward the arrow first, so 07 with a 15-minute step gives 15 going up
  // and 00 going down instead of 22 and 52.
  const step = Math.max(1, Math.floor(minuteStep))
  const rounded = delta > 0 ? Math.ceil(cur / step) * step : Math.floor(cur / step) * step
  const next = rounded === cur ? cur + delta * step : rounded
  return setField(f, seg, wrap(next, 0, 59))
}

// Bounds are padded to a common width so a "09:30" value can be compared with a "09:30:00" bound.
function normalizeBound(text: string | undefined) {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((text ?? "").trim())
  if (!m) return null
  if (Number(m[1]) > 23 || Number(m[2]) > 59 || (m[3] !== undefined && Number(m[3]) > 59)) return null
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`
}

// Zero-padded clock strings sort chronologically, so no Date (and no time zone) has to be involved.
// A max earlier than min is a range that wraps past midnight — the HTML rule for time inputs, and
// the only way to express quiet hours or a night shift as a single field.
function outOfRange(value: string, min: string | undefined, max: string | undefined) {
  if (value === "") return false
  const v = normalizeBound(value)
  if (v === null) return false
  const lo = normalizeBound(min)
  const hi = normalizeBound(max)
  if (lo !== null && hi !== null && lo > hi) return v < lo && v > hi
  if (lo !== null && v < lo) return true
  if (hi !== null && v > hi) return true
  return false
}

// A pasted time arrives either as a 24-hour string or written the way the field displays it, so the
// day period is read from the text — in this locale's wording as well as in English — rather than
// assumed. Returns null when the text is not a time, so the paste is ignored rather than half
// applied.
function parsePasted(
  text: string,
  withSeconds: boolean,
  names: [string, string]
): Fields | null {
  const trimmed = text.trim()
  const m = /(\d{1,2})\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?/.exec(trimmed)
  if (!m) return null
  const lower = trimmed.toLowerCase()
  const before = lower.slice(0, m.index)
  const after = lower.slice(m.index + m[0].length)
  const near = `${before} ${after}`
  const has = (name: string) => name.trim() !== "" && near.includes(name.toLowerCase())
  const pm = has(names[1]) || /\bp\.?m\.?/.test(near)
  const am = has(names[0]) || /\ba\.?m\.?/.test(near)

  let hour = Number(m[1])
  const minute = Number(m[2])
  const second = m[3] === undefined ? null : Number(m[3])
  if (minute > 59 || (second !== null && second > 59)) return null
  if (am || pm) {
    // Always read with h12 meaning, even on an h11 locale: a person writes "12:30 PM" for half past
    // noon whichever clock their locale renders, and h11 arithmetic would turn that into hour 24.
    if (hour > 12) return null
    hour = fromDisplayHour(hour, pm ? 1 : 0, "h12")
  } else if (hour === 24 && minute === 0 && (second ?? 0) === 0) {
    hour = 0
  }
  if (hour > 23) return null
  return {
    hour,
    minute,
    // A time written without seconds is a time at the top of the minute, not an unreadable one.
    second: withSeconds ? (second ?? 0) : second,
    period: hour >= 12 ? 1 : 0,
  }
}

export const TimeInput = React.forwardRef<HTMLInputElement, TimeInputProps>(function TimeInput(
  {
    value,
    defaultValue,
    onChange,
    withSeconds = false,
    min,
    max,
    minuteStep = 1,
    locale,
    hour12,
    disabled,
    name,
    className,
    "aria-label": ariaLabel = "Time",
  },
  forwardedRef
) {
  const isControlled = value !== undefined
  const [fields, setFields] = React.useState<Fields>(() =>
    parseValue(isControlled ? value : defaultValue)
  )
  const [buf, setBuf] = React.useState<Record<SegmentName, string>>(EMPTY_BUF)

  const cycle = React.useMemo(() => resolveCycle(locale, hour12), [locale, hour12])
  const parts = React.useMemo(
    () => buildParts(locale, cycle, withSeconds),
    [locale, cycle, withSeconds]
  )
  const periodNames = React.useMemo(() => dayPeriodNames(locale, cycle), [locale, cycle])
  const order = React.useMemo(
    () => parts.filter((p): p is { type: SegmentName } => p.type !== "literal").map((p) => p.type),
    [parts]
  )

  const segRefs = React.useRef<Record<SegmentName, HTMLInputElement | null>>({
    hour: null,
    minute: null,
    second: null,
    dayPeriod: null,
  })

  // Forward the first segment in reading order so callers can focus the field from a shortcut.
  React.useImperativeHandle(forwardedRef, () => segRefs.current[order[0]] as HTMLInputElement, [order])

  const fieldsRef = React.useRef(fields)
  fieldsRef.current = fields

  // Re-seed from the prop only when it disagrees with what is on screen. A controlled parent stores
  // "" for an incomplete time, and echoing that back blindly would erase the half-typed segments on
  // every keystroke.
  React.useEffect(() => {
    if (!isControlled) return
    if ((value ?? "") !== toValue(fieldsRef.current, withSeconds)) {
      setFields(parseValue(value))
      setBuf(EMPTY_BUF)
    }
  }, [isControlled, value, withSeconds])

  const current = toValue(fields, withSeconds)
  const invalid = outOfRange(current, min, max)

  function rangeFor(seg: SegmentName) {
    if (seg === "hour") return HOUR_RANGE[cycle]
    if (seg === "dayPeriod") return { min: 0, max: 1 }
    return { min: 0, max: 59 }
  }

  function displayValue(seg: SegmentName) {
    if (seg === "dayPeriod") return fields.period
    if (seg === "hour") return fields.hour === null ? null : toDisplayHour(fields.hour, cycle)
    return fields[seg]
  }

  function setBufFor(seg: SegmentName, next: string) {
    setBuf((b) => ({ ...b, [seg]: next }))
  }

  function focusIndex(i: number) {
    const seg = order[Math.max(0, Math.min(i, order.length - 1))]
    const el = segRefs.current[seg]
    el?.focus()
    el?.select()
  }

  function focusRelative(seg: SegmentName, delta: number) {
    focusIndex(order.indexOf(seg) + delta)
  }

  // Single commit path. The segments stay local state even when the value is controlled, because a
  // half-typed time has no value to flow back through the prop: a parent holding "" for an
  // incomplete time would drop every keystroke but the last, and the field would never fill in. The
  // effect above is what keeps the parent authoritative — as soon as the segments read as a complete
  // time that disagrees with the prop, they are pulled back to it.
  function commit(next: Fields) {
    setFields(next)
    onChange?.(toValue(next, withSeconds))
  }

  function input(seg: SegmentName, digit: string) {
    const range = rangeFor(seg)
    const r = typeDigit(buf[seg], digit, range.min, range.max)
    setBufFor(seg, r.buf)
    if (seg === "hour") {
      commit(withHour(fields, r.value === null ? null : fromDisplayHour(r.value, fields.period, cycle)))
    } else {
      commit(setField(fields, seg, r.value))
    }
    if (r.advance) focusRelative(seg, 1)
  }

  // The day period answers to the first letter of either the English or the localised name, so an
  // en-US reader types A or P and a ja-JP reader can still drive it from the arrows.
  function typePeriod(key: string) {
    const k = key.toLowerCase()
    const first = (s: string) => s.trim().toLowerCase().slice(0, 1)
    const want = (name: string, ascii: string) =>
      k === ascii || (first(name) !== "" && k === first(name))
    const period = want(periodNames[0], "a") ? 0 : want(periodNames[1], "p") ? 1 : null
    if (period === null) return false
    // Typing the period it is already on is a keystroke, not a change: emitting here would churn a
    // controlled parent on every repeat press.
    if (fields.period !== period) commit(withPeriod(fields, period))
    return true
  }

  function handleKeyDown(seg: SegmentName, e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    switch (e.key) {
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault()
        // `new Date()` is read here in the handler and never during render: seeding "now" while
        // rendering would disagree between the server and the client and break hydration.
        const d = new Date()
        const now: Fields = {
          hour: d.getHours(),
          minute: d.getMinutes(),
          second: d.getSeconds(),
          period: d.getHours() >= 12 ? 1 : 0,
        }
        setBufFor(seg, "")
        commit(stepSegment(fields, seg, e.key === "ArrowUp" ? 1 : -1, cycle, minuteStep, now))
        break
      }
      case "ArrowLeft":
        e.preventDefault()
        focusRelative(seg, -1)
        break
      case "ArrowRight":
        e.preventDefault()
        focusRelative(seg, 1)
        break
      case "Home":
        e.preventDefault()
        focusIndex(0)
        break
      case "End":
        e.preventDefault()
        focusIndex(order.length - 1)
        break
      case "Backspace":
      case "Delete": {
        e.preventDefault()
        const filled = seg === "hour" ? fields.hour !== null : displayValue(seg) !== null
        if (buf[seg] !== "" || filled) {
          setBufFor(seg, "")
          commit(seg === "hour" ? withHour(fields, null) : setField(fields, seg, null))
        } else if (e.key === "Backspace") {
          focusRelative(seg, -1)
        }
        break
      }
      default: {
        if (e.metaKey || e.ctrlKey || e.altKey) return
        if (seg === "dayPeriod") {
          if (typePeriod(e.key)) e.preventDefault()
          return
        }
        if (/^\d$/.test(e.key)) {
          e.preventDefault()
          input(seg, e.key)
        }
      }
    }
  }

  // Virtual keyboards often report key="Unidentified" on keydown, so the typed character is read
  // from the input event instead. Desktop never reaches here because keydown already consumed it.
  // Only the first digit is taken: `input` reads the state of this render, so applying several in a
  // row would have each one overwrite the last. Multi-character text is a paste, and onPaste handles
  // it in one commit.
  function handleBeforeInput(seg: SegmentName, e: React.FormEvent<HTMLInputElement>) {
    if (disabled) return
    e.preventDefault()
    const data = (e.nativeEvent as InputEvent).data
    if (!data) return
    if (seg === "dayPeriod") {
      for (const ch of Array.from(data)) if (typePeriod(ch)) return
      return
    }
    const digit = Array.from(data).find((ch) => ch >= "0" && ch <= "9")
    if (digit) input(seg, digit)
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault()
    if (disabled) return
    const parsed = parsePasted(e.clipboardData.getData("text"), withSeconds, periodNames)
    if (!parsed) return
    setBuf(EMPTY_BUF)
    commit(parsed)
    focusIndex(order.length - 1)
  }

  function display(seg: SegmentName) {
    if (buf[seg] !== "") return buf[seg]
    const v = displayValue(seg)
    if (v === null) return PLACEHOLDERS[seg]
    return seg === "dayPeriod" ? periodNames[v] : pad(v)
  }

  function valueText(seg: SegmentName) {
    const v = displayValue(seg)
    if (v === null) return "Empty"
    // A bare spinbutton would have the reader hear the period as "1"; the name is what identifies it.
    return seg === "dayPeriod" ? periodNames[v] : String(v)
  }

  // The period is as wide as the longer of the two names so the field does not resize when it flips.
  const periodWidth = Math.max(2, periodNames[0].trim().length, periodNames[1].trim().length)

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex h-9 items-center rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-sm transition-colors",
        "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
        invalid && "border-destructive focus-within:ring-destructive",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {parts.map((p, i) =>
        p.type === "literal" ? (
          <span key={i} aria-hidden="true" className="text-muted-foreground">
            {p.value}
          </span>
        ) : (
          <input
            key={i}
            ref={(el) => {
              segRefs.current[p.type] = el
            }}
            type="text"
            inputMode={p.type === "dayPeriod" ? "text" : "numeric"}
            autoComplete="off"
            spellCheck={false}
            role="spinbutton"
            disabled={disabled}
            aria-label={LABELS[p.type]}
            aria-valuenow={displayValue(p.type) ?? undefined}
            aria-valuemin={rangeFor(p.type).min}
            aria-valuemax={rangeFor(p.type).max}
            aria-valuetext={valueText(p.type)}
            aria-invalid={invalid || undefined}
            value={display(p.type)}
            // Every mutation goes through onKeyDown/onBeforeInput. This keeps React from warning
            // about a controlled input with no change handler, and anything an exotic IME slips past
            // both is discarded by the next render.
            onChange={() => {}}
            onKeyDown={(e) => handleKeyDown(p.type, e)}
            onBeforeInput={(e) => handleBeforeInput(p.type, e)}
            onPaste={handlePaste}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={() => setBufFor(p.type, "")}
            className={cn(
              "rounded-sm bg-transparent text-center tabular-nums caret-transparent outline-none",
              "focus:bg-accent focus:text-accent-foreground",
              "disabled:cursor-not-allowed",
              displayValue(p.type) === null && "text-muted-foreground"
            )}
            style={{ width: p.type === "dayPeriod" ? `${periodWidth}ch` : "2ch" }}
          />
        )
      )}
      {name ? <input type="hidden" name={name} value={current} /> : null}
    </div>
  )
})
