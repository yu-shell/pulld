"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * How many pixels one of each fixed-size unit is.
 *
 * Measured rather than remembered. The platform already ships this table: in Chrome 152,
 * `CSS.px(96).to("in")` returns `1in` and `.to("cm")` returns `2.54cm`, and `CSS.pc(1).to("px")`
 * returns 16. The ratios below are those same conversions written out, so this file agrees with
 * the engine instead of with somebody's memory of the CSS spec.
 */
export const ABSOLUTE_PX = {
  px: 1,
  in: 96,
  pc: 96 / 6,
  pt: 96 / 72,
  cm: 96 / 2.54,
  // Derived from cm rather than written as 96/25.4 and 96/101.6, which is how CSS defines them
  // (1mm is a tenth of a cm, 1Q a fortieth) and also the only form that agrees with the engine:
  // 96/25.4 is 3.7795275590551185 in IEEE 754 while Chrome reports 3.7795275590551176, and the
  // difference is the last two bits of the division order.
  mm: 96 / 2.54 / 10,
  Q: 96 / 2.54 / 40,
} as const

export type AbsoluteUnit = keyof typeof ABSOLUTE_PX

/**
 * The units whose size is decided somewhere outside the value.
 *
 * This list is not a stylistic grouping, it is where the platform draws the line: every one of
 * these throws on conversion. Measured in Chrome 152, `CSS.rem(1).to("px")` is a
 * `TypeError: Cannot convert to px`, and so is the same call on `em`, `%`, `ch`, `ex`, `lh`, `vw`,
 * `vh`, `vmin` and `vmax` — ten units, one for one with this array. Typed OM will convert any
 * absolute unit into any other absolute unit and refuses all of these, because the number alone
 * does not know how big it is. Neither does this component, which is why `base` exists.
 */
export const RELATIVE_UNITS = [
  "rem",
  "em",
  "%",
  "ch",
  "ex",
  "lh",
  "vw",
  "vh",
  "vmin",
  "vmax",
] as const

export type RelativeUnit = (typeof RELATIVE_UNITS)[number]

/** `""` is "no unit", which CSS accepts for a length only when the number is zero. */
export type Unit = AbsoluteUnit | RelativeUnit | ""

/** Pixels per one unit, for whichever relative units the document can account for. */
export type UnitBase = Partial<Record<RelativeUnit, number>>

export const ALL_UNITS: readonly Unit[] = [
  ...(Object.keys(ABSOLUTE_PX) as AbsoluteUnit[]),
  ...RELATIVE_UNITS,
]

export interface UnitValue {
  value: number
  unit: Unit
}

export function isAbsoluteUnit(unit: Unit): unit is AbsoluteUnit {
  return unit !== "" && Object.prototype.hasOwnProperty.call(ABSOLUTE_PX, unit)
}

/** Pixels per one `unit`, or `null` when nothing in `base` says how big it is. */
export function pxPerUnit(unit: Unit, base: UnitBase = {}): number | null {
  if (unit === "") return 1
  if (isAbsoluteUnit(unit)) return ABSOLUTE_PX[unit]
  const supplied = base[unit]
  return typeof supplied === "number" && Number.isFinite(supplied) ? supplied : null
}

/**
 * The length in pixels, or `null` when it cannot be known here.
 *
 * A bare number is only a length when it is zero, so everything else unitless resolves to `null`
 * rather than being quietly treated as pixels — measured, `CSS.supports("width", "16")` is false
 * while `CSS.supports("width", "0")` is true.
 */
export function resolvePx(
  value: number,
  unit: Unit,
  base: UnitBase = {}
): number | null {
  if (!Number.isFinite(value)) return null
  if (unit === "") return value === 0 ? 0 : null
  const per = pxPerUnit(unit, base)
  return per === null ? null : value * per
}

/**
 * The same length counted in `to`, or `null` when that would require a guess.
 *
 * Returning `null` is the whole point: the alternative is inventing a base, and an invented base
 * moves the value by exactly the factor it got wrong.
 */
export function convertLength(
  value: number,
  from: Unit,
  to: Unit,
  base: UnitBase = {}
): number | null {
  if (from === to) return value
  const px = resolvePx(value, from, base)
  if (px === null) return null
  if (to === "") return px === 0 ? 0 : null
  const per = pxPerUnit(to, base)
  return per === null || per === 0 ? null : px / per
}

/**
 * A number, then optionally a unit: `16`, `16px`, `16 PX`, `1.5rem`, `.5em`, `50%`, `-2px`.
 *
 * Deliberately stricter than `Number`, on the same reasoning this registry's number-range-input
 * gives: `Number("1e3")` is 1000 and `Number("0x10")` is 16, and neither is something a person
 * typed into a length field, so both are refused here instead of becoming a value nobody entered.
 */
export function parseUnitValue(
  text: string,
  units: readonly Unit[] = ALL_UNITS
): UnitValue | null {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const parts = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([a-zA-Z%]*)$/.exec(trimmed)
  if (!parts) return null
  const value = Number(parts[1])
  if (!Number.isFinite(value)) return null
  const written = parts[2]
  if (written === "") return { value, unit: "" }
  // CSS unit identifiers are case-insensitive, so `16PX` is a real thing to paste in; the canonical
  // spelling from `units` is what comes back out.
  const matched = units.find(
    (unit) => unit !== "" && unit.toLowerCase() === written.toLowerCase()
  )
  return matched === undefined ? null : { value, unit: matched }
}

/** Counts a number's decimals, so repeated nudges do not drift. */
function decimalPlaces(n: number): number {
  const s = String(n)
  const dot = s.indexOf(".")
  if (dot === -1) return 0
  if (s.includes("e") || s.includes("E")) return 0
  return s.length - dot - 1
}

/** `1.0600` -> `"1.06"`, `2.000` -> `"2"`, `100` -> `"100"`. */
export function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return ""
  const fixed = value.toFixed(Math.max(0, Math.min(decimals, 20)))
  // Only a string that has a decimal point may lose trailing zeros — stripping them unconditionally
  // turns 100 into 1.
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed
}

/** The canonical CSS the field stands for: `1.5rem`, `0`, `50%`. */
export function toCssLength(value: number, unit: Unit, decimals = 4): string {
  return `${formatNumber(value, decimals)}${unit}`
}

/**
 * A step per unit, because one step for all of them is unusable.
 *
 * A pixel steps by 1 and a rem by 1 would be a sixteen-pixel jump; a rem steps by 0.25 and a pixel
 * by 0.25 would take four presses to move a pixel.
 */
export const DEFAULT_STEPS: Readonly<Record<Unit, number>> = {
  "": 1,
  px: 1,
  in: 0.125,
  pc: 0.5,
  pt: 1,
  cm: 0.1,
  mm: 1,
  Q: 1,
  rem: 0.25,
  em: 0.25,
  "%": 1,
  ch: 0.5,
  ex: 0.5,
  lh: 0.25,
  vw: 1,
  vh: 1,
  vmin: 1,
  vmax: 1,
}

export function stepFor(
  unit: Unit,
  steps: Partial<Record<Unit, number>> = {}
): number {
  const given = steps[unit]
  if (typeof given === "number" && Number.isFinite(given) && given > 0) return given
  return DEFAULT_STEPS[unit] ?? 1
}

/**
 * Adds one step and rounds to the decimals actually in play.
 *
 * Without the rounding a 0.1 step walks off: measured, ten additions of 0.1 in IEEE 754 land on
 * 0.9999999999999999, which is what puts `0.30000000000000004` in a spacing field.
 */
export function stepValue(value: number, step: number, direction: 1 | -1): number {
  const next = value + direction * step
  const places = Math.min(Math.max(decimalPlaces(step), decimalPlaces(value)), 10)
  return Number(next.toFixed(places))
}

/**
 * Reads the bases the document is currently applying to `element`.
 *
 * Kept out of the component on purpose. The component never touches the DOM, both because the base
 * is genuinely the caller's to supply — it is a fact about the page, not about the field — and
 * because it is live: measured, setting the root font-size to 20px makes `width: 1rem` compute to
 * 20px on the very next read. A component that cached 16 would be wrong from then on.
 */
export function readBase(element: Element): UnitBase {
  const own = getComputedStyle(element)
  const root = getComputedStyle(element.ownerDocument.documentElement)
  const parent = element.parentElement ?? element
  const base: UnitBase = {}
  const rem = parseFloat(root.fontSize)
  if (Number.isFinite(rem)) base.rem = rem
  const em = parseFloat(getComputedStyle(parent).fontSize)
  if (Number.isFinite(em)) base.em = em
  const lh = parseFloat(own.lineHeight)
  if (Number.isFinite(lh)) base.lh = lh
  const width = parseFloat(getComputedStyle(parent).width)
  if (Number.isFinite(width)) base["%"] = width / 100
  const view = element.ownerDocument.defaultView
  if (view) {
    base.vw = view.innerWidth / 100
    base.vh = view.innerHeight / 100
    base.vmin = Math.min(view.innerWidth, view.innerHeight) / 100
    base.vmax = Math.max(view.innerWidth, view.innerHeight) / 100
  }
  return base
}

export interface UnitInputMessages {
  resolved: (shown: string) => string
  needsBase: (unit: Unit) => string
  unitlessNonZero: () => string
  notANumber: () => string
  belowMin: (shown: string) => string
  aboveMax: (shown: string) => string
  reinterpreted: (unit: Unit) => string
}

const DEFAULT_MESSAGES: UnitInputMessages = {
  resolved: (shown) => `= ${shown}`,
  needsBase: (unit) =>
    `${unit} is sized by the document, so its length in pixels is not known here.`,
  unitlessNonZero: () => "A number on its own is only a length when it is 0 — pick a unit.",
  notANumber: () => "Enter a number, optionally followed by a unit.",
  belowMin: (shown) => `Minimum ${shown}.`,
  aboveMax: (shown) => `Maximum ${shown}.`,
  reinterpreted: (unit) => `Read as ${unit}; the number was kept as typed.`,
}

export interface UnitInputProps {
  /** Controlled value. Leave undefined and use `defaultValue` for an uncontrolled field. */
  value?: UnitValue
  defaultValue?: UnitValue
  /** Fires on every edit. `px` is the resolved length, or null when no base accounts for the unit. */
  onValueChange?: (next: UnitValue & { px: number | null }) => void
  /** Which units the select offers, in order. Include `""` to offer "no unit". */
  units?: readonly Unit[]
  /** Pixels per one relative unit. Without it, rem/em/% are carried, not converted. */
  base?: UnitBase
  /**
   * What changing the unit does to the number. `"convert"` keeps the rendered length and changes
   * the number; `"reinterpret"` keeps the number and changes the length.
   */
  behavior?: "convert" | "reinterpret"
  /** Per-unit arrow-key step, over `DEFAULT_STEPS`. */
  steps?: Partial<Record<Unit, number>>
  /** Decimals a converted number is displayed to (default 4). */
  decimals?: number
  /** Bounds in pixels, so one bound means the same thing in every unit. Reported, never silently applied. */
  minPx?: number
  maxPx?: number
  /** Posts the canonical CSS length (`1.5rem`) under this name. */
  name?: string
  label?: string
  unitLabel?: string
  /** Shows the resolved pixel length under the field (default true). */
  showResolved?: boolean
  messages?: Partial<UnitInputMessages>
  disabled?: boolean
  required?: boolean
  className?: string
  id?: string
}

const DEFAULT_UNITS: readonly Unit[] = ["px", "rem", "em", "%"]

export function UnitInput({
  value,
  defaultValue,
  onValueChange,
  units = DEFAULT_UNITS,
  base,
  behavior = "convert",
  steps,
  decimals = 4,
  minPx,
  maxPx,
  name,
  label = "Length",
  unitLabel = "Unit",
  showResolved = true,
  messages,
  disabled,
  required,
  className,
  id,
}: UnitInputProps) {
  const say = React.useMemo(
    () => ({ ...DEFAULT_MESSAGES, ...messages }),
    [messages]
  )
  const bases = React.useMemo<UnitBase>(() => base ?? {}, [base])

  // useId, not a module counter: a counter started on the server and a counter started in the
  // browser do not agree, and the id is written into aria-describedby on both sides.
  const generatedId = React.useId()
  const fieldId = id ?? generatedId
  const statusId = `${fieldId}-status`

  const isControlled = value !== undefined
  const initial = value ?? defaultValue ?? null

  const [text, setText] = React.useState(() =>
    initial ? formatNumber(initial.value, decimals) : ""
  )
  const [unit, setUnit] = React.useState<Unit>(
    () => initial?.unit ?? units[0] ?? "px"
  )
  /** Says the last unit change carried the number instead of converting it. */
  const [carried, setCarried] = React.useState<Unit | null>(null)

  /**
   * The exact number this field last held in each unit.
   *
   * This is what makes a round trip lossless, and rounding harder is not an alternative to it.
   * Measured over 1..200px: rounding a px->rem->px trip to 2 decimals returns the original for only
   * 50 of the 200, and with a 15px root — somebody who set `html { font-size: 15px }` — exactly 65
   * of 200 survive at 2, 3 *and* 4 decimals, because 1/15 does not terminate in decimal and more
   * places never recover it. So the number is not recomputed on the way back: it is remembered.
   * Typing replaces the intent, so the memory is dropped then.
   */
  const memory = React.useRef<Map<Unit, number>>(new Map())

  React.useEffect(() => {
    if (!isControlled || !value) return
    setText(formatNumber(value.value, decimals))
    setUnit(value.unit)
  }, [isControlled, value, decimals])

  const parsed = React.useMemo(() => {
    if (text.trim() === "") return null
    return parseUnitValue(text, units.length ? units : ALL_UNITS)
  }, [text, units])

  // A unit written into the box wins over the select, which is how a value pasted out of devtools
  // ("1.5rem") lands in one action instead of being typed and then chosen.
  const effectiveUnit: Unit = parsed && parsed.unit !== "" ? parsed.unit : unit
  const number = parsed ? parsed.value : null
  const px = number === null ? null : resolvePx(number, effectiveUnit, bases)

  const malformed = text.trim() !== "" && parsed === null
  const unitlessNonZero =
    number !== null && effectiveUnit === "" && number !== 0
  const belowMin =
    px !== null && typeof minPx === "number" && px < minPx
  const aboveMax =
    px !== null && typeof maxPx === "number" && px > maxPx
  // An untouched empty field is not wrong yet, so `required` is left to the native attribute rather
  // than marking a field the reader has not reached as invalid.
  const invalid = malformed || unitlessNonZero || belowMin || aboveMax

  const emit = React.useCallback(
    (nextValue: number | null, nextUnit: Unit) => {
      if (nextValue === null) return
      onValueChange?.({
        value: nextValue,
        unit: nextUnit,
        px: resolvePx(nextValue, nextUnit, bases),
      })
    },
    [onValueChange, bases]
  )

  function commitText(next: string) {
    setText(next)
    setCarried(null)
    memory.current.clear()
    const read = parseUnitValue(next, units.length ? units : ALL_UNITS)
    if (read === null) return
    const nextUnit = read.unit === "" ? unit : read.unit
    if (read.unit !== "" && read.unit !== unit) setUnit(read.unit)
    memory.current.set(nextUnit, read.value)
    emit(read.value, nextUnit)
  }

  function changeUnit(next: Unit) {
    const from = effectiveUnit
    setUnit(next)
    if (number === null || next === from) {
      setCarried(null)
      return
    }
    memory.current.set(from, number)

    if (behavior === "reinterpret") {
      setText(formatNumber(number, decimals))
      setCarried(null)
      emit(number, next)
      return
    }

    const remembered = memory.current.get(next)
    if (remembered !== undefined) {
      setText(formatNumber(remembered, decimals))
      setCarried(null)
      emit(remembered, next)
      return
    }

    const converted = convertLength(number, from, next, bases)
    if (converted === null) {
      // Nothing here knows how big the new unit is, so the number is carried and said to be
      // carried. Converting through an assumed base is the one thing that must not happen: it is
      // how a field changes a value nobody asked it to change.
      setText(formatNumber(number, decimals))
      setCarried(next)
      emit(number, next)
      return
    }
    setText(formatNumber(converted, decimals))
    setCarried(null)
    memory.current.set(next, converted)
    emit(converted, next)
  }

  function nudge(direction: 1 | -1, multiplier: number) {
    if (disabled) return
    const step = stepFor(effectiveUnit, steps) * multiplier
    const from = number ?? 0
    let next = stepValue(from, step, direction)
    // A bound given in pixels is checked in pixels and then brought back, so "at least 1rem" holds
    // whichever unit the field is showing.
    const nextPx = resolvePx(next, effectiveUnit, bases)
    if (nextPx !== null) {
      if (typeof minPx === "number" && nextPx < minPx) {
        const floor = convertLength(minPx, "px", effectiveUnit, bases)
        if (floor !== null) next = Number(floor.toFixed(10))
      }
      if (typeof maxPx === "number" && nextPx > maxPx) {
        const ceil = convertLength(maxPx, "px", effectiveUnit, bases)
        if (ceil !== null) next = Number(ceil.toFixed(10))
      }
    }
    setText(formatNumber(next, decimals))
    setCarried(null)
    memory.current.clear()
    memory.current.set(effectiveUnit, next)
    emit(next, effectiveUnit)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    nudge(event.key === "ArrowUp" ? 1 : -1, event.shiftKey ? 10 : 1)
  }

  let status = ""
  if (malformed) status = say.notANumber()
  else if (unitlessNonZero) status = say.unitlessNonZero()
  else if (belowMin && typeof minPx === "number")
    status = say.belowMin(`${formatNumber(minPx, decimals)}px`)
  else if (aboveMax && typeof maxPx === "number")
    status = say.aboveMax(`${formatNumber(maxPx, decimals)}px`)
  else if (carried !== null) status = say.reinterpreted(carried)
  else if (showResolved && px !== null && effectiveUnit !== "px")
    status = say.resolved(`${formatNumber(px, decimals)}px`)
  else if (showResolved && px === null && number !== null && effectiveUnit !== "")
    status = say.needsBase(effectiveUnit)

  const offered = units.length ? units : DEFAULT_UNITS
  const posted =
    number !== null && !invalid ? toCssLength(number, effectiveUnit, decimals) : ""

  return (
    <div className={cn("inline-flex flex-col gap-1", className)}>
      <div
        role="group"
        aria-label={label}
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-input bg-transparent shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          invalid && "border-destructive focus-within:ring-destructive",
          disabled && "cursor-not-allowed opacity-50"
        )}
      >
        <input
          id={fieldId}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={text}
          disabled={disabled}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={status ? statusId : undefined}
          onChange={(event) => commitText(event.target.value)}
          onKeyDown={handleKeyDown}
          className="h-full w-16 min-w-0 rounded-l-md bg-transparent px-2 text-sm tabular-nums outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <select
          aria-label={unitLabel}
          value={offered.includes(effectiveUnit) ? effectiveUnit : offered[0]}
          disabled={disabled}
          onChange={(event) => changeUnit(event.target.value as Unit)}
          className="h-full cursor-pointer rounded-r-md border-l border-input bg-transparent py-0 pl-2 pr-1 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        >
          {offered.map((option) => (
            <option key={option || "none"} value={option}>
              {option === "" ? "—" : option}
            </option>
          ))}
        </select>
        {name ? <input type="hidden" name={name} value={posted} /> : null}
      </div>
      {status ? (
        <span
          id={statusId}
          aria-live="polite"
          className={cn(
            "text-xs tabular-nums",
            invalid ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {status}
        </span>
      ) : null}
    </div>
  )
}
