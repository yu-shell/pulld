"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

type SegmentName = "year" | "month" | "day"

type Part = { type: SegmentName } | { type: "literal"; value: string }

interface DateInputProps {
  /** Controlled value as an ISO date string ("YYYY-MM-DD"), or "" while the date is incomplete. */
  value?: string
  /** Initial value when uncontrolled. */
  defaultValue?: string
  /** Fires with an ISO "YYYY-MM-DD" string, or "" while any segment is still empty. */
  onChange?: (value: string) => void
  /** Earliest valid date, ISO "YYYY-MM-DD". Typing is never blocked; out-of-range dates are flagged with aria-invalid. */
  min?: string
  /** Latest valid date, ISO "YYYY-MM-DD". */
  max?: string
  /** BCP-47 locale deciding segment order and the spoken month name. Defaults to the runtime's. */
  locale?: string
  /** Disable every segment. */
  disabled?: boolean
  /** Accessible label for the field group (default "Date"). */
  "aria-label"?: string
  /** When set, a hidden input mirrors the ISO value so it submits with a native form. */
  name?: string
  className?: string
}

type Fields = { year: number | null; month: number | null; day: number | null }

const EMPTY_FIELDS: Fields = { year: null, month: null, day: null }
const EMPTY_BUF: Record<SegmentName, string> = { year: "", month: "", day: "" }
const LABELS: Record<SegmentName, string> = {
  year: "Year",
  month: "Month",
  day: "Day",
}
const PLACEHOLDERS: Record<SegmentName, string> = {
  year: "yyyy",
  month: "mm",
  day: "dd",
}

const FALLBACK_PARTS: Part[] = [
  { type: "year" },
  { type: "literal", value: "-" },
  { type: "month" },
  { type: "literal", value: "-" },
  { type: "day" },
]

// Ask Intl for the segment order rather than hardcoding month/day/year: most of the world writes
// D/M/Y and ja/ko write Y/M/D, so a hardcoded order makes "03/04" mean the wrong day half the time.
function buildParts(locale: string | undefined): Part[] {
  try {
    // The calendar is pinned to Gregorian because everything else here is: the leap rule, the month
    // lengths, and the ISO output. Left to the locale, th-TH would hand back the Buddhist year 2569
    // and ja-JP-u-ca-japanese the era-relative year 8, and either would be emitted verbatim as a
    // Gregorian year. The resolved calendar is re-checked because a runtime too old to know the
    // option would silently ignore it.
    const fmt = new Intl.DateTimeFormat(locale, {
      calendar: "gregory",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    })
    if (fmt.resolvedOptions().calendar !== "gregory") return FALLBACK_PARTS
    const parts = fmt.formatToParts(new Date(Date.UTC(2026, 2, 14)))
    const out: Part[] = []
    for (const p of parts) {
      if (p.type === "year" || p.type === "month" || p.type === "day") {
        out.push({ type: p.type })
      } else if (p.type === "literal") {
        out.push({ type: "literal", value: p.value })
      }
    }
    // Unreachable as written: pinning the calendar above means all three fields are always emitted
    // (it is what stops -u-ca-chinese from returning relatedYear instead of year). Kept as a last
    // resort only because rendering a field that is silently missing a segment is worse than
    // falling back, and the mutation run confirms nothing else depends on it.
    const named = new Set(out.filter((p) => p.type !== "literal").map((p) => p.type))
    if (named.size === 3) return out
  } catch {
    // Intl missing, or the locale tag is malformed.
  }
  return FALLBACK_PARTS
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// Arithmetic instead of `new Date(y, m, 0)`: Date maps years 0-99 onto 1900-1999, so year 0042 would
// report February from 1942. An unknown year is treated as leap so a typed 29 survives until the
// year arrives and clampDay can settle it.
function daysInMonth(year: number | null, month: number | null) {
  if (month === null) return 31
  if (month === 2) return year === null || isLeapYear(year) ? 29 : 28
  return MONTH_LENGTHS[month - 1]
}

function setField(f: Fields, seg: SegmentName, value: number | null): Fields {
  if (seg === "year") return { ...f, year: value }
  if (seg === "month") return { ...f, month: value }
  return { ...f, day: value }
}

// Feb 29 with the year changed to a non-leap one, or Jan 31 with the month switched to February:
// the day has to be pulled back. Skipping this is the classic bug where the field accepts a date
// that does not exist and `new Date(2025, 1, 31)` silently reports March 3.
function clampDay(f: Fields): Fields {
  if (f.day === null) return f
  const max = daysInMonth(f.year, f.month)
  return f.day > max ? { ...f, day: max } : f
}

// One typed digit. `advance` reports that no further digit could extend this segment, which is what
// makes "3" jump straight to the next segment while "1" waits for a possible 10/11/12. When the
// pair would be out of range ("3" then "9" in a 31-day month) the digit starts a new number instead
// of being dropped, so no keystroke is ever lost.
function typeDigit(buf: string, digit: string, max: number, width: 2 | 4) {
  if (width === 4) {
    const next = buf + digit
    const done = next.length === 4
    // The buffer is cleared on the fourth digit, so retyping a year starts a fresh number rather
    // than rolling digits through the old one (typing 1999 over 2026 would read 0261, 2619, 6199).
    // That also bounds the buffer at three characters, which is why nothing here has to trim it.
    return { buf: done ? "" : next, value: done ? Number(next) : null, advance: done }
  }
  const combined = Number(buf + digit)
  if (buf !== "" && combined >= 1 && combined <= max) {
    return { buf: "", value: combined, advance: true }
  }
  const d = Number(digit)
  if (d === 0) return { buf: "0", value: null, advance: false }
  if (d * 10 > max) return { buf: "", value: d, advance: true }
  return { buf: String(d), value: d, advance: false }
}

// Arrows wrap month and day (December steps to January) but clamp the year, because a year that
// wraps from 9999 to 1 is never what the reader meant.
function stepSegment(
  f: Fields,
  seg: SegmentName,
  delta: number,
  today: Fields
): Fields {
  const cur = f[seg]
  // The first press on an empty segment seeds from today instead of jumping to 1, which is what
  // makes the arrows usable for dates near now.
  if (cur === null) return clampDay(setField(f, seg, today[seg]))
  if (seg === "year") {
    return clampDay(setField(f, "year", Math.min(9999, Math.max(1, cur + delta))))
  }
  const max = seg === "month" ? 12 : daysInMonth(f.year, f.month)
  let next = cur + delta
  if (next > max) next = 1
  else if (next < 1) next = max
  return clampDay(setField(f, seg, next))
}

const pad = (n: number, width: number) => String(n).padStart(width, "0")

function toISO(f: Fields) {
  if (f.year === null || f.month === null || f.day === null) return ""
  if (f.year < 1) return ""
  return `${pad(f.year, 4)}-${pad(f.month, 2)}-${pad(f.day, 2)}`
}

// Accepts a plain "YYYY-MM-DD" only. A full ISO timestamp is rejected rather than guessed at,
// because parsing one would apply a time zone and can land on the wrong calendar day.
function fromISO(iso: string | undefined): Fields {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso ?? "").trim())
  if (!m) return EMPTY_FIELDS
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12) return EMPTY_FIELDS
  if (day < 1 || day > daysInMonth(year, month)) return EMPTY_FIELDS
  return { year, month, day }
}

// A pasted date arrives either as ISO or written the way the field displays it. The ISO shape is
// ruled out first, because "2026-03-14" dropped into a month/day/year field would otherwise be read
// positionally as month 20. Returns null when the text is not a date, so the paste is ignored
// rather than half-applied.
function parsePasted(text: string, order: SegmentName[]): Fields | null {
  const iso = fromISO(text)
  if (iso.day !== null) return iso
  const groups = text.match(/\d+/g)
  if (!groups || groups.length !== 3) return null
  let out: Fields = { year: null, month: null, day: null }
  order.forEach((seg, i) => {
    out = setField(out, seg, Number(groups[i]))
  })
  if (out.year === null || out.month === null || out.day === null) return null
  if (out.year < 1 || out.year > 9999) return null
  if (out.month < 1 || out.month > 12) return null
  if (out.day < 1 || out.day > daysInMonth(out.year, out.month)) return null
  return out
}

// ISO dates are zero-padded to a fixed width, so lexicographic order is chronological order and no
// Date object (or time zone) needs to be involved.
function outOfRange(iso: string, min: string | undefined, max: string | undefined) {
  if (iso === "") return false
  const bound = /^\d{4}-\d{2}-\d{2}$/
  if (min && bound.test(min) && iso < min) return true
  if (max && bound.test(max) && iso > max) return true
  return false
}

export const DateInput = React.forwardRef<HTMLInputElement, DateInputProps>(
  function DateInput(
    {
      value,
      defaultValue,
      onChange,
      min,
      max,
      locale,
      disabled,
      name,
      className,
      "aria-label": ariaLabel = "Date",
    },
    forwardedRef
  ) {
    const isControlled = value !== undefined
    const [fields, setFields] = React.useState<Fields>(() =>
      fromISO(isControlled ? value : defaultValue)
    )
    const [buf, setBuf] = React.useState<Record<SegmentName, string>>(EMPTY_BUF)

    const parts = React.useMemo(() => buildParts(locale), [locale])
    const order = React.useMemo(
      () =>
        parts
          .filter((p): p is { type: SegmentName } => p.type !== "literal")
          .map((p) => p.type),
      [parts]
    )

    const segRefs = React.useRef<Record<SegmentName, HTMLInputElement | null>>({
      year: null,
      month: null,
      day: null,
    })

    // Forward the first segment in reading order so callers can focus the field from a shortcut.
    React.useImperativeHandle(
      forwardedRef,
      () => segRefs.current[order[0]] as HTMLInputElement,
      [order]
    )

    const fieldsRef = React.useRef(fields)
    fieldsRef.current = fields

    // Re-seed from the prop only when it disagrees with what is on screen. A controlled parent
    // stores "" for an incomplete date, and echoing that back blindly would erase the half-typed
    // segments on every keystroke.
    React.useEffect(() => {
      if (!isControlled) return
      if ((value ?? "") !== toISO(fieldsRef.current)) {
        setFields(fromISO(value))
        setBuf(EMPTY_BUF)
      }
    }, [isControlled, value])

    const monthName = React.useMemo(() => {
      try {
        const fmt = new Intl.DateTimeFormat(locale, {
          month: "long",
          timeZone: "UTC",
        })
        return (m: number) => fmt.format(new Date(Date.UTC(2000, m - 1, 1)))
      } catch {
        return (m: number) => String(m)
      }
    }, [locale])

    const iso = toISO(fields)
    const invalid = outOfRange(iso, min, max)

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
    // half-typed date has no value to flow back through the prop: a parent holding "" for an
    // incomplete date would drop every keystroke but the last, and the field could never be filled
    // in at all. The effect above is what keeps the parent authoritative — as soon as the segments
    // read as a complete date that disagrees with the prop, they are pulled back to it.
    function commit(next: Fields) {
      setFields(next)
      onChange?.(toISO(next))
    }

    function input(seg: SegmentName, digit: string) {
      const width = seg === "year" ? 4 : 2
      const segMax =
        seg === "year" ? 9999 : seg === "month" ? 12 : daysInMonth(fields.year, fields.month)
      const r = typeDigit(buf[seg], digit, segMax, width)
      setBufFor(seg, r.buf)
      commit(clampDay(setField(fields, seg, r.value)))
      if (r.advance) focusRelative(seg, 1)
    }

    function handleKeyDown(seg: SegmentName, e: React.KeyboardEvent<HTMLInputElement>) {
      if (disabled) return
      switch (e.key) {
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault()
          // `new Date()` is read here in the handler and never during render: seeding "today" while
          // rendering would disagree between the server and the client and break hydration.
          const now = new Date()
          const today: Fields = {
            year: now.getFullYear(),
            month: now.getMonth() + 1,
            day: now.getDate(),
          }
          setBufFor(seg, "")
          commit(stepSegment(fields, seg, e.key === "ArrowUp" ? 1 : -1, today))
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
          if (buf[seg] !== "" || fields[seg] !== null) {
            setBufFor(seg, "")
            commit(setField(fields, seg, null))
          } else if (e.key === "Backspace") {
            focusRelative(seg, -1)
          }
          break
        }
        default:
          if (/^\d$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault()
            input(seg, e.key)
          }
      }
    }

    // Virtual keyboards often report key="Unidentified" on keydown, so the typed character is read
    // from the input event instead. Desktop never reaches here because keydown already consumed it.
    // Only the first digit is taken: `input` reads the current state from this render, so applying
    // several in a row would have each one overwrite the last. Multi-character text is a paste, and
    // onPaste handles it in one commit.
    function handleBeforeInput(seg: SegmentName, e: React.FormEvent<HTMLInputElement>) {
      if (disabled) return
      e.preventDefault()
      const data = (e.nativeEvent as InputEvent).data
      if (!data) return
      const digit = Array.from(data).find((ch) => ch >= "0" && ch <= "9")
      if (digit) input(seg, digit)
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      e.preventDefault()
      if (disabled) return
      const parsed = parsePasted(e.clipboardData.getData("text"), order)
      if (!parsed) return
      setBuf(EMPTY_BUF)
      commit(parsed)
      focusIndex(order.length - 1)
    }

    function display(seg: SegmentName) {
      if (buf[seg] !== "") return buf[seg]
      const v = fields[seg]
      if (v === null) return PLACEHOLDERS[seg]
      return pad(v, seg === "year" ? 4 : 2)
    }

    function valueText(seg: SegmentName) {
      const v = fields[seg]
      if (v === null) return "Empty"
      // A bare spinbutton would have the reader hear the month as "3"; the name is what identifies it.
      return seg === "month" ? monthName(v) : String(v)
    }

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
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              role="spinbutton"
              disabled={disabled}
              aria-label={LABELS[p.type]}
              aria-valuenow={fields[p.type] ?? undefined}
              aria-valuemin={1}
              aria-valuemax={
                p.type === "year"
                  ? 9999
                  : p.type === "month"
                    ? 12
                    : daysInMonth(fields.year, fields.month)
              }
              aria-valuetext={valueText(p.type)}
              aria-invalid={invalid || undefined}
              value={display(p.type)}
              // Every mutation goes through onKeyDown/onBeforeInput. This keeps React from warning
              // about a controlled input with no change handler, and anything an exotic IME slips
              // past both is discarded by the next render.
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
                fields[p.type] === null && "text-muted-foreground"
              )}
              style={{ width: p.type === "year" ? "4ch" : "2ch" }}
            />
          )
        )}
        {/* Disabled too, or the field still posts its value from a control the reader was
            not allowed to touch — a native date input barred from submission does not. */}
        {name ? (
          <input type="hidden" name={name} value={iso} disabled={disabled} />
        ) : null}
      </div>
    )
  }
)
