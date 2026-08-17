"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Why three sliders and not a saturation/value square: the square needs pointer
 * capture and element geometry, which makes it unusable from a keyboard without
 * a second, hidden set of controls. Native range inputs arrive with arrow keys,
 * Home/End, page steps and screen-reader support already attached, and they are
 * the axes people paste into a stylesheet anyway — hue, saturation, lightness is
 * literally CSS `hsl()`.
 *
 * Two things bite every hand-rolled color picker, and both are settled here:
 *
 *   - **Hue has to survive grey.** If the hex string is the state of record,
 *     dragging lightness to 0 destroys the hue — black is #000000 and nothing
 *     else — so dragging back up returns red instead of the blue you started
 *     with. Keeping h/s/l as the state and deriving the hex means black still
 *     remembers it was blue.
 *   - **A pasted hex has to come back out byte-identical.** Rounding the
 *     conversion on the way in makes #123456 drift a digit every time it is
 *     read, so a color quietly changes just by being displayed. The conversion
 *     keeps full precision internally and rounds exactly once, on the way out;
 *     the round trip is exact for all 16,777,216 sRGB colors.
 */

/** What the field reads and writes. `hex` also covers the 8-digit form. */
export type ColorFormat = "hex" | "rgb" | "hsl"

/** Hue 0–360, saturation and lightness 0–100, alpha 0–1. Kept unrounded. */
export interface Hsla {
  h: number
  s: number
  l: number
  a: number
}

/** Channels 0–255, alpha 0–1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Why a string was rejected. Stable codes so the text can be translated. */
export type ColorErrorCode = "invalid" | "named-color"

export type ColorParseResult =
  | { ok: true; color: Hsla }
  | { ok: false; code: ColorErrorCode }

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value

/**
 * Hue is the one axis that wraps rather than clamps — 400° is 40°, the way CSS
 * reads it — so a wrapped hue is not an error, just a different way to say the
 * same angle.
 */
const wrapHue = (value: number) => ((value % 360) + 360) % 360

export function rgbToHsl({ r, g, b, a }: Rgba): Hsla {
  const rn = clamp(r, 0, 255) / 255
  const gn = clamp(g, 0, 255) / 255
  const bn = clamp(b, 0, 255) / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const chroma = max - min
  const l = (max + min) / 2

  // Grey has no hue and no saturation to speak of. Reporting 0 for both is the
  // usual convention; the component keeps whatever hue the slider already held,
  // which is the whole point of storing h/s/l rather than a hex string.
  if (chroma === 0) return { h: 0, s: 0, l: l * 100, a }

  let h: number
  if (max === rn) h = ((gn - bn) / chroma) % 6
  else if (max === gn) h = (bn - rn) / chroma + 2
  else h = (rn - gn) / chroma + 4

  return {
    h: wrapHue(h * 60),
    s: (chroma / (1 - Math.abs(2 * l - 1))) * 100,
    l: l * 100,
    a,
  }
}

export function hslToRgb({ h, s, l, a }: Hsla): Rgba {
  const sn = clamp(s, 0, 100) / 100
  const ln = clamp(l, 0, 100) / 100
  const chroma = (1 - Math.abs(2 * ln - 1)) * sn
  const sector = wrapHue(h) / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  const base = ln - chroma / 2

  let rgb: [number, number, number]
  if (sector < 1) rgb = [chroma, second, 0]
  else if (sector < 2) rgb = [second, chroma, 0]
  else if (sector < 3) rgb = [0, chroma, second]
  else if (sector < 4) rgb = [0, second, chroma]
  else if (sector < 5) rgb = [second, 0, chroma]
  else rgb = [chroma, 0, second]

  // The single rounding step in the whole pipeline.
  return {
    r: Math.round((rgb[0] + base) * 255),
    g: Math.round((rgb[1] + base) * 255),
    b: Math.round((rgb[2] + base) * 255),
    a,
  }
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/

/** A plain number, or a percentage read against `full`. */
function readValue(token: string, full: number): number | null {
  const percent = token.endsWith("%")
  const body = percent ? token.slice(0, -1) : token
  if (!NUMBER.test(body)) return null
  const value = Number(body)
  return percent ? (value / 100) * full : value
}

function readAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1
  const value = readValue(token, 1)
  return value === null ? null : clamp(value, 0, 1)
}

function parseHexBody(body: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(body)) return null
  const short = body.length === 3 || body.length === 4
  const long = body.length === 6 || body.length === 8
  if (!short && !long) return null
  const width = short ? 1 : 2
  const channel = (index: number) => {
    const chunk = body.slice(index * width, index * width + width)
    return parseInt(short ? chunk + chunk : chunk, 16)
  }
  const withAlpha = body.length === 4 || body.length === 8
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: withAlpha ? channel(3) / 255 : 1,
  }
}

/**
 * Splits `rgb(…)` / `hsl(…)` arguments, accepting both the legacy comma form and
 * the modern space form with a slashed alpha.
 */
function splitArguments(
  body: string
): { parts: string[]; alpha?: string } | null {
  const [main, ...afterSlash] = body.split("/")
  if (afterSlash.length > 1) return null
  const parts = main.trim().split(/[\s,]+/).filter(Boolean)
  // An empty alpha ("rgb(1 2 3 /)") needs no check of its own: it fails the
  // number test downstream like any other unreadable alpha.
  if (afterSlash.length === 1) return { parts, alpha: afterSlash[0].trim() }
  if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] }
  return { parts }
}

const FUNCTIONAL = /^(rgba?|hsla?)\((.*)\)$/i

/**
 * Reads a written color into unrounded HSL.
 *
 * Accepts hex in all four widths (`#abc`, `#abcd`, `#aabbcc`, `#aabbccdd`, with
 * or without the `#`), `rgb()`/`rgba()` and `hsl()`/`hsla()` in both the comma
 * and the space-with-slashed-alpha forms, and percentages wherever CSS allows
 * them. Out-of-range channels are clamped and hues wrap, the way a browser reads
 * them — the field then rewrites the entry on blur, so the reading is visible
 * rather than silent.
 *
 * CSS color *names* are refused by name rather than supported, because carrying
 * the 148-entry table into every project that installs this would cost more than
 * a picker whose output is always hex is worth.
 */
export function parseColor(input: string): ColorParseResult {
  // Lowercased once, here: the hex digits, the function name and the bare-word
  // check downstream all depend on it, and `HSL(…)` read as `rgb` is a silent
  // wrong answer rather than a rejection.
  const text = input.trim().toLowerCase()
  const functional = FUNCTIONAL.exec(text)
  if (!functional) {
    // Hex is tried before the bare-word check, because "abc" and "fff" are hex
    // that happens to be spelled with letters. No CSS colour name is made
    // entirely of a–f at one of the four hex widths, so nothing is shadowed.
    const rgb = parseHexBody(text.startsWith("#") ? text.slice(1) : text)
    if (rgb) return { ok: true, color: rgbToHsl(rgb) }
    if (/^[a-z]+$/.test(text)) return { ok: false, code: "named-color" }
    return { ok: false, code: "invalid" }
  }

  const kind = functional[1].startsWith("hsl") ? "hsl" : "rgb"
  const split = splitArguments(functional[2])
  if (!split || split.parts.length !== 3) return { ok: false, code: "invalid" }
  const alpha = readAlpha(split.alpha)
  if (alpha === null) return { ok: false, code: "invalid" }

  if (kind === "rgb") {
    const channels = split.parts.map((part) => readValue(part, 255))
    if (channels.some((value) => value === null))
      return { ok: false, code: "invalid" }
    const [r, g, b] = channels as number[]
    return { ok: true, color: rgbToHsl({ r, g, b, a: alpha }) }
  }

  // `deg` is the only angle unit accepted; turns and radians are rare enough in
  // pasted color that supporting them buys less than the extra surface costs.
  const hueToken = split.parts[0].endsWith("deg")
    ? split.parts[0].slice(0, -3)
    : split.parts[0]
  const h = readValue(hueToken, 360)
  const s = readValue(split.parts[1], 100)
  const l = readValue(split.parts[2], 100)
  if (h === null || s === null || l === null)
    return { ok: false, code: "invalid" }
  return {
    ok: true,
    color: { h: wrapHue(h), s: clamp(s, 0, 100), l: clamp(l, 0, 100), a: alpha },
  }
}

const hexPair = (value: number) => value.toString(16).padStart(2, "0")

/** Two decimals is enough to name every alpha a slider or an 8-digit hex can hold. */
const roundAlpha = (a: number) => Math.round(clamp(a, 0, 1) * 100) / 100

/**
 * Writes a color back out. Alpha is included only when the color actually has
 * some — an opaque color reads as `#3b82f6`, not `#3b82f6ff`.
 */
export function formatColor(color: Hsla, format: ColorFormat = "hex"): string {
  const alpha = roundAlpha(color.a)

  if (format === "hsl") {
    const h = Math.round(wrapHue(color.h))
    const s = Math.round(clamp(color.s, 0, 100))
    const l = Math.round(clamp(color.l, 0, 100))
    return alpha < 1
      ? `hsl(${h} ${s}% ${l}% / ${alpha})`
      : `hsl(${h} ${s}% ${l}%)`
  }

  const { r, g, b } = hslToRgb(color)
  if (format === "rgb")
    return alpha < 1 ? `rgb(${r} ${g} ${b} / ${alpha})` : `rgb(${r} ${g} ${b})`

  // Hex decides on the byte it is about to write, not on the two-decimal alpha:
  // rounding first would call 254/255 opaque and drop the channel that was asked
  // for, so an 8-digit hex would stop surviving a round trip near the top of the
  // range.
  const byte = Math.round(clamp(color.a, 0, 1) * 255)
  return byte < 255
    ? `#${hexPair(r)}${hexPair(g)}${hexPair(b)}${hexPair(byte)}`
    : `#${hexPair(r)}${hexPair(g)}${hexPair(b)}`
}

/** A CSS color for the swatch and the slider tracks, alpha included. */
const toCss = (color: Hsla) => formatColor(color, "rgb")

/** Default copy, keyed by code so a caller can replace any single line. */
export const colorMessages: Record<ColorErrorCode, string> = {
  invalid: "Enter a color like #3b82f6, rgb(59 130 246) or hsl(217 91% 60%).",
  "named-color": "Color names are not supported — use a hex, rgb() or hsl() value.",
}

/** Slider and group labels, separated out so they can be translated. */
export const colorLabels = {
  hue: "Hue",
  saturation: "Saturation",
  lightness: "Lightness",
  alpha: "Alpha",
  swatches: "Preset colors",
}

export type ColorLabels = typeof colorLabels

const FALLBACK: Hsla = { h: 217, s: 91, l: 60, a: 1 }

function seedColor(value: string | null | undefined): Hsla {
  if (value === null || value === undefined) return FALLBACK
  const parsed = parseColor(value)
  return parsed.ok ? parsed.color : FALLBACK
}

interface ChannelSliderProps {
  label: string
  value: number
  max: number
  step: number
  /** Rendered into `aria-valuetext`, because "210" alone does not say degrees. */
  unit: string
  track: string
  disabled?: boolean
  onValueChange: (value: number) => void
}

function ChannelSlider({
  label,
  value,
  max,
  step,
  unit,
  track,
  disabled,
  onValueChange,
}: ChannelSliderProps) {
  const shown = step < 1 ? Math.round(value * 100) / 100 : Math.round(value)
  return (
    <input
      type="range"
      min={0}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={`${unit === "%" || unit === "°" ? shown : shown}${unit}`}
      onChange={(event) => onValueChange(Number(event.target.value))}
      style={{ backgroundImage: track }}
      className={cn(
        "h-3 w-full cursor-pointer appearance-none rounded-full border border-input bg-cover bg-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "[&::-webkit-slider-runnable-track]:h-3 [&::-webkit-slider-runnable-track]:rounded-full",
        "[&::-moz-range-track]:h-3 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-transparent",
        "[&::-webkit-slider-thumb]:-mt-0.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:shadow",
        "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-foreground [&::-moz-range-thumb]:shadow"
      )}
    />
  )
}

export interface ColorPickerProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "defaultValue" | "color"
  > {
  /** Controlled color, in any notation `parseColor` accepts. */
  value?: string | null
  /** Initial color, for uncontrolled use. Defaults to a mid blue. */
  defaultValue?: string | null
  /**
   * Fires with the color written in `format`. `null` while what is typed cannot
   * be read, so a value handed over here never has to be validated again.
   */
  onValueChange?: (value: string | null) => void
  /** Notation the field normalizes to and reports in (default "hex"). */
  format?: ColorFormat
  /** Show the alpha slider and keep alpha in the output (default false). */
  alpha?: boolean
  /** Shortcut colors shown under the sliders. Entries that cannot be read are skipped. */
  swatches?: string[]
  /** Posts the color through a hidden input under this name. */
  name?: string
  disabled?: boolean
  /** Show the error line under the field (default true). */
  showHint?: boolean
  /** Replace any default message. */
  messages?: Partial<Record<ColorErrorCode, string>>
  /** Replace any slider or group label. */
  labels?: Partial<ColorLabels>
  /** Class for the text input; `className` goes to the wrapper. */
  inputClassName?: string
}

export const ColorPicker = React.forwardRef<HTMLDivElement, ColorPickerProps>(
  function ColorPicker(
    {
      className,
      inputClassName,
      value,
      defaultValue,
      onValueChange,
      format = "hex",
      alpha = false,
      swatches,
      name,
      disabled,
      showHint = true,
      messages,
      labels,
      id,
      ...props
    },
    ref
  ) {
    const generatedId = React.useId()
    const inputId = id ?? generatedId
    const hintId = `${inputId}-hint`

    const isControlled = value !== undefined

    // Every color arriving from outside passes through here, so the field can
    // never end up holding an alpha it has no slider to change: without the
    // alpha slider, a seeded or pasted `#11223344` is a color the reader can see
    // but not edit, and the picker would go on reporting it.
    const settle = React.useCallback(
      (next: Hsla): Hsla => (alpha ? next : { ...next, a: 1 }),
      [alpha]
    )

    const [color, setColor] = React.useState<Hsla>(() =>
      settle(seedColor(isControlled ? value : defaultValue))
    )
    // The text is held separately from the color because an unreadable entry has
    // to stay on screen — the reader needs to see and fix what they wrote — while
    // the sliders go on showing the last color that could actually be read.
    const [text, setText] = React.useState(() =>
      formatColor(settle(seedColor(isControlled ? value : defaultValue)), format)
    )

    const parsed = parseColor(text)
    const invalid = !parsed.ok && text.trim() !== ""
    const committed = parsed.ok ? formatColor(settle(parsed.color), format) : null

    // What the parent was last told. Comparison is on the written form, not the
    // numbers, so a parent that echoes our own "#3b82f6" back — or writes it as
    // "#3B82F6" — is recognised as an echo and does not reset the sliders.
    const lastEmitted = React.useRef<string | null>(committed)

    React.useEffect(() => {
      if (!isControlled) return
      const incoming = value === null || value === undefined ? null : value
      const canonical =
        incoming === null
          ? null
          : (() => {
              const result = parseColor(incoming)
              return result.ok ? formatColor(result.color, format) : incoming
            })()
      if (canonical === lastEmitted.current) return
      lastEmitted.current = canonical
      const next = settle(seedColor(incoming))
      setColor(next)
      setText(canonical === null ? "" : formatColor(next, format))
    }, [isControlled, value, format, settle])

    function emit(next: string | null) {
      if (next === lastEmitted.current) return
      lastEmitted.current = next
      onValueChange?.(next)
    }

    // No `settle` here: a slider only ever adjusts the color already in state,
    // which was settled on the way in, and the alpha slider is not rendered at
    // all when alpha is off.
    function commitColor(next: Hsla) {
      setColor(next)
      const written = formatColor(next, format)
      setText(written)
      emit(written)
    }

    function commitText(next: string) {
      setText(next)
      const result = parseColor(next)
      if (!result.ok) return emit(null)
      const settled = settle(result.color)
      setColor(settled)
      emit(formatColor(settled, format))
    }

    // Blur is where the reading becomes visible: "#ABC" is rewritten as
    // "#aabbcc", "rgb(300 0 0)" as "rgb(255 0 0)", and an alpha dropped for want
    // of the alpha slider is seen to be gone. An empty box is refilled, because
    // the sliders beside it are still showing a color and the two should not
    // disagree.
    function handleBlur() {
      if (parsed.ok || text.trim() === "") {
        const written = formatColor(parsed.ok ? settle(parsed.color) : color, format)
        if (written !== text) setText(written)
        emit(written)
      }
    }

    const say = (code: ColorErrorCode) => messages?.[code] ?? colorMessages[code]
    const label = (key: keyof ColorLabels) => labels?.[key] ?? colorLabels[key]

    const hint = !parsed.ok && invalid ? say(parsed.code) : ""

    const opaque = { ...color, a: 1 }
    const tracks = {
      hue: `linear-gradient(to right, ${[0, 60, 120, 180, 240, 300, 360]
        .map((h) => toCss({ ...opaque, h }))
        .join(", ")})`,
      saturation: `linear-gradient(to right, ${toCss({ ...opaque, s: 0 })}, ${toCss({ ...opaque, s: 100 })})`,
      lightness: `linear-gradient(to right, ${toCss({ ...opaque, l: 0 })}, ${toCss({ ...opaque, l: 50 })}, ${toCss({ ...opaque, l: 100 })})`,
      alpha: `linear-gradient(to right, ${toCss({ ...color, a: 0 })}, ${toCss(opaque)})`,
    }

    const usableSwatches = (swatches ?? []).flatMap((entry) => {
      const result = parseColor(entry)
      return result.ok ? [{ entry, written: formatColor(result.color, format) }] : []
    })

    return (
      <div
        ref={ref}
        className={cn("flex w-full max-w-xs flex-col gap-3", className)}
        {...props}
      >
        <div className="flex items-center gap-2">
          {/* Decorative: the value it stands for is in the text box beside it,
              spelled out. The checker showing through a translucent color is
              drawn from the theme's own foreground, so it follows dark mode. */}
          <span
            aria-hidden="true"
            className="relative size-9 shrink-0 overflow-hidden rounded-md border border-input text-muted-foreground/25"
            style={{
              backgroundImage:
                "conic-gradient(from 90deg, currentColor 25%, transparent 0 50%, currentColor 0 75%, transparent 0)",
              backgroundSize: "8px 8px",
            }}
          >
            <span
              className="absolute inset-0"
              style={{ backgroundColor: toCss(color) }}
            />
          </span>
          <input
            id={inputId}
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            value={text}
            onChange={(event) => commitText(event.target.value)}
            onBlur={handleBlur}
            aria-invalid={invalid || undefined}
            aria-describedby={showHint ? hintId : undefined}
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-sm transition-colors",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              invalid && "border-destructive focus-visible:ring-destructive",
              "disabled:cursor-not-allowed disabled:opacity-50",
              inputClassName
            )}
          />
        </div>

        <div className="flex flex-col gap-2">
          <ChannelSlider
            label={label("hue")}
            value={color.h}
            max={360}
            step={1}
            unit="°"
            track={tracks.hue}
            disabled={disabled}
            onValueChange={(h) => commitColor({ ...color, h })}
          />
          <ChannelSlider
            label={label("saturation")}
            value={color.s}
            max={100}
            step={1}
            unit="%"
            track={tracks.saturation}
            disabled={disabled}
            onValueChange={(s) => commitColor({ ...color, s })}
          />
          <ChannelSlider
            label={label("lightness")}
            value={color.l}
            max={100}
            step={1}
            unit="%"
            track={tracks.lightness}
            disabled={disabled}
            onValueChange={(l) => commitColor({ ...color, l })}
          />
          {alpha ? (
            <ChannelSlider
              label={label("alpha")}
              value={color.a}
              max={1}
              step={0.01}
              unit=""
              track={tracks.alpha}
              disabled={disabled}
              onValueChange={(a) => commitColor({ ...color, a })}
            />
          ) : null}
        </div>

        {usableSwatches.length > 0 ? (
          <div role="group" aria-label={label("swatches")} className="flex flex-wrap gap-1.5">
            {usableSwatches.map((swatch) => {
              const current = swatch.written === committed
              return (
                <button
                  key={swatch.entry}
                  type="button"
                  disabled={disabled}
                  aria-label={swatch.written}
                  // Marks which preset is showing without claiming it is a
                  // toggle that can be pressed off again.
                  aria-current={current || undefined}
                  onClick={() => commitText(swatch.written)}
                  style={{ backgroundColor: swatch.written }}
                  className={cn(
                    "size-6 rounded-md border border-input shadow-sm transition-transform",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    current && "ring-2 ring-ring ring-offset-2 ring-offset-background"
                  )}
                />
              )
            })}
          </div>
        ) : null}

        {/* A form gets the color, and gets nothing at all when what is in the
            box cannot be read — an aria-invalid field that still posts a value
            is the worst of both. */}
        {name ? (
          <input
            type="hidden"
            name={name}
            disabled={disabled}
            value={committed ?? ""}
          />
        ) : null}

        {showHint ? (
          <p
            id={hintId}
            aria-live="polite"
            className={cn("min-h-4 text-xs", invalid ? "text-destructive" : "text-muted-foreground")}
          >
            {hint}
          </p>
        ) : null}
      </div>
    )
  }
)
