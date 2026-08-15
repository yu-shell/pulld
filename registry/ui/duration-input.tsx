"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Why a text field and not a number box beside a unit <select>: people already
 * know how to write a duration — 90m, 1h30m, 1:30, 500ms — and the two-control
 * version makes them translate it on the way in and every later reader
 * translate it back on the way out. The price of accepting what they type is a
 * parser that is exactly right about the two things that bite:
 *
 *   - `m` vs `ms`. The scanner takes the whole run of letters before looking
 *     anything up, so "5m" and "5ms" can never be confused by a prefix match.
 *   - what `1:30` means. Two colon fields are read as mm:ss and three as
 *     hh:mm:ss, the way stopwatches and media players write them.
 *
 * Neither reading is left to be guessed at: the field echoes the duration back
 * in words underneath ("1 minute 30 seconds"), and on blur it rewrites what was
 * typed into its canonical short form, so `1:30` visibly becomes `1m 30s`.
 */

/** The units this field understands. Months and years are refused — see `parseDuration`. */
export type DurationUnit = "ms" | "s" | "m" | "h" | "d" | "w"

const MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

const UNIT_ALIASES: Record<string, DurationUnit> = {
  ms: "ms",
  msec: "ms",
  msecs: "ms",
  millisecond: "ms",
  milliseconds: "ms",
  s: "s",
  sec: "s",
  secs: "s",
  second: "s",
  seconds: "s",
  m: "m",
  min: "m",
  mins: "m",
  minute: "m",
  minutes: "m",
  h: "h",
  hr: "h",
  hrs: "h",
  hour: "h",
  hours: "h",
  d: "d",
  day: "d",
  days: "d",
  w: "w",
  week: "w",
  weeks: "w",
}

/**
 * Named and refused rather than quietly given a length. A month is 28–31 days
 * and a year 365 or 366, so "1mo" can only be answered by a calendar and a
 * start date, neither of which a duration has. Note that this also settles the
 * usual `m`/`M` argument: parsing is case-insensitive and `M` is minutes,
 * because months are not on the menu at all.
 */
const CALENDAR_UNITS = new Set([
  "mo",
  "mos",
  "month",
  "months",
  "y",
  "yr",
  "yrs",
  "year",
  "years",
])

/** Why a string was rejected. Stable codes so the text can be translated. */
export type DurationErrorCode =
  | "invalid"
  | "missing-unit"
  | "unknown-unit"
  | "calendar-unit"
  | "duplicate-unit"
  | "negative"
  | "clock-field"
  | "too-large"

/** Every message the field can show, including the two range failures it adds itself. */
export type DurationMessageCode = DurationErrorCode | "below-min" | "above-max"

export type DurationParseResult =
  /** `ms` is null for an empty string: nothing entered is not the same as a bad entry. */
  | { ok: true; ms: number | null }
  | { ok: false; code: DurationErrorCode }

const SCALE: { unit: DurationUnit; word: string }[] = [
  { unit: "w", word: "week" },
  { unit: "d", word: "day" },
  { unit: "h", word: "hour" },
  { unit: "m", word: "minute" },
  { unit: "s", word: "second" },
  { unit: "ms", word: "millisecond" },
]

// Rounds to whole milliseconds — "1.5h" is exact, "0.4ms" is not — and refuses
// anything past the safe-integer range, where further arithmetic on the value
// would silently stop being exact.
function toMilliseconds(ms: number): DurationParseResult {
  const rounded = Math.round(ms)
  if (!Number.isSafeInteger(rounded)) return { ok: false, code: "too-large" }
  return { ok: true, ms: rounded }
}

// mm:ss or hh:mm:ss. The leading field is free to run past 59 the way a
// stopwatch does ("90:00" is ninety minutes); every field after a colon is a
// clock field, so one or two digits and under 60.
function parseClock(text: string): DurationParseResult {
  const fields = text.split(":")
  if (fields.length > 3) return { ok: false, code: "clock-field" }
  if (!/^\d+$/.test(fields[0])) return { ok: false, code: "clock-field" }
  for (const field of fields.slice(1)) {
    if (!/^\d{1,2}$/.test(field) || Number(field) > 59)
      return { ok: false, code: "clock-field" }
  }
  const n = fields.map(Number)
  return toMilliseconds(
    fields.length === 2
      ? n[0] * MS.m + n[1] * MS.s
      : n[0] * MS.h + n[1] * MS.m + n[2] * MS.s
  )
}

function parseUnitForm(
  text: string,
  defaultUnit: DurationUnit
): DurationParseResult {
  // Sticky, so every character has to be accounted for by some token: a stray
  // "1h x" fails at the "x" instead of being read as "1h".
  const token = /\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*,?/y
  const parts: { value: number; unit: string }[] = []
  while (token.lastIndex < text.length) {
    const match = token.exec(text)
    if (!match) return { ok: false, code: "invalid" }
    parts.push({ value: Number(match[1]), unit: match[2] })
  }

  const seen = new Set<DurationUnit>()
  let ms = 0
  for (const part of parts) {
    let unit: DurationUnit
    if (part.unit === "") {
      // A bare number is only an answer when it is the whole input; in "1h 30"
      // the 30 is a slip, and guessing at it is how a timeout ends up 1800×
      // wrong.
      if (parts.length > 1) return { ok: false, code: "missing-unit" }
      unit = defaultUnit
    } else if (CALENDAR_UNITS.has(part.unit)) {
      return { ok: false, code: "calendar-unit" }
    } else {
      const resolved = UNIT_ALIASES[part.unit]
      if (!resolved) return { ok: false, code: "unknown-unit" }
      unit = resolved
    }
    // "1m 30m" is a typo far more often than it is a deliberate sum, and the
    // sum would be accepted in silence.
    if (seen.has(unit)) return { ok: false, code: "duplicate-unit" }
    seen.add(unit)
    ms += part.value * MS[unit]
  }
  return toMilliseconds(ms)
}

/**
 * Reads a typed duration into milliseconds.
 *
 * Accepts unit form ("90m", "1h30m", "1h 30m", "2d 4h 15m", "1.5h", "500ms"),
 * clock form ("1:30" = mm:ss, "1:30:00" = hh:mm:ss) and a bare number, which is
 * read in `defaultUnit`. Case and spacing are free; the long spellings
 * ("minutes", "hrs") work too.
 */
export function parseDuration(
  input: string,
  options: { defaultUnit?: DurationUnit } = {}
): DurationParseResult {
  const { defaultUnit = "m" } = options
  const text = input.trim().toLowerCase()
  if (text === "") return { ok: true, ms: null }
  if (text.startsWith("-")) return { ok: false, code: "negative" }
  if (text.includes(":")) return parseClock(text)
  return parseUnitForm(text, defaultUnit)
}

/**
 * Writes milliseconds back out, either in words ("1 hour 30 minutes") or in the
 * short form the field normalizes to ("1h 30m"). Exact — every remainder is
 * carried down to the next unit — so it can be shown beside the value it
 * describes without the two disagreeing. A negative or non-finite input is
 * treated as zero rather than throwing: one bad number should not take the
 * layout with it.
 */
export function formatDuration(
  ms: number,
  style: "long" | "short" = "long"
): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (total === 0) return style === "long" ? "0 seconds" : "0s"
  const out: string[] = []
  let rest = total
  for (const step of SCALE) {
    const count = Math.floor(rest / MS[step.unit])
    if (count === 0) continue
    rest -= count * MS[step.unit]
    out.push(
      style === "long"
        ? `${count} ${step.word}${count === 1 ? "" : "s"}`
        : `${count}${step.unit}`
    )
  }
  return out.join(" ")
}

/** Default copy, keyed by code so a caller can replace any single line. */
export const durationMessages: Record<DurationMessageCode, string> = {
  invalid: "Enter a duration like 1h 30m.",
  "missing-unit": "Every part needs a unit — try 1h 30m.",
  "unknown-unit": "Unknown unit. Use ms, s, m, h, d or w.",
  "calendar-unit": "Months and years vary in length — use days or weeks.",
  "duplicate-unit": "Each unit can only be given once.",
  negative: "A duration cannot be negative.",
  "clock-field": "Use mm:ss or hh:mm:ss, with 00–59 after each colon.",
  "too-large": "That duration is too large.",
  "below-min": "Minimum is {value}.",
  "above-max": "Maximum is {value}.",
}

// Out-of-range values keep their parsed `ms` so the hint can talk about what was
// actually entered; whether they are handed to the caller is decided below.
function evaluate(
  text: string,
  options: { defaultUnit: DurationUnit; minMs?: number; maxMs?: number }
): { ms: number | null; code?: DurationMessageCode } {
  const parsed = parseDuration(text, { defaultUnit: options.defaultUnit })
  if (!parsed.ok) return { ms: null, code: parsed.code }
  if (parsed.ms === null) return { ms: null }
  if (options.minMs !== undefined && parsed.ms < options.minMs)
    return { ms: parsed.ms, code: "below-min" }
  if (options.maxMs !== undefined && parsed.ms > options.maxMs)
    return { ms: parsed.ms, code: "above-max" }
  return { ms: parsed.ms }
}

export interface DurationInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "type"
  > {
  /** Controlled duration in milliseconds. `null` clears the field. */
  valueMs?: number | null
  /** Initial duration in milliseconds, for uncontrolled use. */
  defaultValueMs?: number | null
  /**
   * Fires with the duration in milliseconds. `null` while the field is empty
   * *or* while what is typed is unusable, so a value handed over here never has
   * to be validated again.
   */
  onValueChange?: (ms: number | null) => void
  /** How to read a bare number with no unit (default "m", so "30" is 30 minutes). */
  defaultUnit?: DurationUnit
  /** Shortest allowed duration in milliseconds; below it the field goes invalid. */
  minMs?: number
  /** Longest allowed duration in milliseconds; above it the field goes invalid. */
  maxMs?: number
  /** Show the echo/error line under the field (default true). */
  showHint?: boolean
  /** Replace any default message. "{value}" in below-min/above-max is the bound, in words. */
  messages?: Partial<Record<DurationMessageCode, string>>
  /** Class for the wrapper; `className` goes to the input itself. */
  containerClassName?: string
}

export const DurationInput = React.forwardRef<
  HTMLInputElement,
  DurationInputProps
>(function DurationInput(
  {
    className,
    containerClassName,
    valueMs,
    defaultValueMs,
    onValueChange,
    defaultUnit = "m",
    minMs,
    maxMs,
    showHint = true,
    messages,
    id,
    name,
    disabled,
    placeholder = "1h 30m",
    onBlur,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  ref
) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId
  const hintId = `${inputId}-hint`

  const isControlled = valueMs !== undefined
  // What was typed is the state; the number is derived from it. Keeping the
  // text means an unparseable entry survives a blur — the reader can see and
  // fix what they wrote instead of watching it disappear.
  const [text, setText] = React.useState(() => {
    const seed = isControlled ? valueMs : defaultValueMs
    return seed === null || seed === undefined ? "" : formatDuration(seed, "short")
  })

  const evaluated = evaluate(text, { defaultUnit, minMs, maxMs })
  const invalid = evaluated.code !== undefined
  const committed = invalid ? null : evaluated.ms

  // What the parent was last told, so the effect below can tell a genuinely new
  // controlled value from the echo of our own emit — without this, every
  // keystroke would be overwritten by the value it just produced.
  const lastEmitted = React.useRef<number | null>(committed)

  React.useEffect(() => {
    if (!isControlled) return
    const next = valueMs ?? null
    if (next === lastEmitted.current) return
    lastEmitted.current = next
    setText(next === null ? "" : formatDuration(next, "short"))
  }, [isControlled, valueMs])

  function commit(next: string) {
    setText(next)
    const result = evaluate(next, { defaultUnit, minMs, maxMs })
    const ms = result.code === undefined ? result.ms : null
    if (ms !== lastEmitted.current) {
      lastEmitted.current = ms
      onValueChange?.(ms)
    }
  }

  // Normalizing on blur is what makes the colon rule visible: "1:30" is rewritten
  // to "1m 30s". It only ever restates the same number, so nothing is emitted.
  function handleBlur(event: React.FocusEvent<HTMLInputElement>) {
    if (!invalid && evaluated.ms !== null) {
      const canonical = formatDuration(evaluated.ms, "short")
      if (canonical !== text) setText(canonical)
    }
    onBlur?.(event)
  }

  const say = (code: DurationMessageCode) =>
    messages?.[code] ?? durationMessages[code]

  let hint = ""
  if (evaluated.code === "below-min")
    hint = say("below-min").replace("{value}", formatDuration(minMs ?? 0))
  else if (evaluated.code === "above-max")
    hint = say("above-max").replace("{value}", formatDuration(maxMs ?? 0))
  else if (evaluated.code) hint = say(evaluated.code)
  else if (evaluated.ms !== null) hint = formatDuration(evaluated.ms)

  const describedBy =
    [ariaDescribedBy, showHint ? hintId : null].filter(Boolean).join(" ") ||
    undefined

  return (
    <div className={cn("flex flex-col gap-1.5", containerClassName)}>
      <input
        ref={ref}
        id={inputId}
        type="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(event) => commit(event.target.value)}
        onBlur={handleBlur}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
          "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          invalid && "border-destructive focus-visible:ring-destructive",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
      {/* A form gets the milliseconds, not the prose: "1h 30m" is for the person. */}
      {name ? (
        <input
          type="hidden"
          name={name}
          disabled={disabled}
          value={committed === null ? "" : String(committed)}
        />
      ) : null}
      {/* Describes the field and announces itself. One element does both because
          the two would otherwise read the same sentence twice; it re-announces
          only when the text really changes, not on every keystroke. */}
      {showHint ? (
        <p
          id={hintId}
          aria-live="polite"
          className={cn(
            "min-h-4 text-xs",
            invalid ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  )
})
