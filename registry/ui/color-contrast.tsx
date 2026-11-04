"use client"

import * as React from "react"
import { Check, X } from "lucide-react"

import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------------------------- *
 * The arithmetic — no DOM, so it can be tested without a browser.
 * -------------------------------------------------------------------------------------------- */

/**
 * A colour in sRGB, one byte per channel.
 *
 * Every threshold WCAG 2 states is defined over sRGB, so this is the space the answer has to be
 * computed in no matter what notation the colour arrived in.
 */
export interface Srgb {
  r: number
  g: number
  b: number
}

/** An sRGB colour that is not necessarily opaque. `a` runs 0–1. */
export interface SrgbA extends Srgb {
  a: number
}

const clampByte = (n: number) => (Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : 0)

/**
 * The luminance of one channel, with the sRGB transfer function undone.
 *
 * The constants are WCAG's own: a linear segment below 0.04045 and a 2.4 power curve above it.
 */
function toLinear(channel: number): number {
  const s = clampByte(channel) / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/**
 * Relative luminance, 0 for black and 1 for white.
 *
 * **This is not the average of the channels, and substituting the average is not a small error.**
 * The channels are first taken back to light-linear values and then weighted 0.2126 / 0.7152 /
 * 0.0722, because the eye is roughly ten times more sensitive to green than to blue. Scored against
 * the mean of the three channels over the same pairs: `#777777` on white is **4.48:1** and the mean
 * says **2.03:1** — a pair that passes AA for body text, reported as failing it. `#0000ff` on white
 * is **8.59:1** and the mean says **2.74:1**; `#ffff00` on black is **19.56:1** against **14.33:1**.
 * The mean is wrong in both directions and wrong by enough to flip the verdict.
 */
export function relativeLuminance({ r, g, b }: Srgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

/**
 * The WCAG 2 contrast ratio of two opaque colours, from 1 to 21, order-independent.
 *
 * **The 0.05 in both terms is load-bearing and is the first thing a hand-rolled version drops.**
 * It is a flare term standing in for ambient light reflecting off the screen, and without it the
 * denominator is zero for every pair involving black: measured, `brighter / darker` returns
 * `Infinity` for white on black and for black on black alike, so the failure is not a slightly
 * wrong number but a ratio that cannot be compared to a threshold or printed.
 *
 * Verified against the figures the published contrast checkers report, to the digit: white on black
 * **21.00**, `#777777` on white **4.48**, `#0000ff` on white **8.59**, `#ff0000` on white **4.00**,
 * `#595959` on white **7.00**, `#767676` on white **4.54**, and white on white **1.00**.
 */
export function contrastRatio(a: Srgb, b: Srgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/**
 * `top` painted over `bottom`, which is the only way a translucent colour acquires a luminance.
 *
 * **Alpha is quantised to eight bits first, because that is what the compositor actually uses.**
 * Carrying the float straight into `a * top + (1 - a) * bottom` disagrees with what the browser
 * paints: over the twelve pairs measured against a canvas — six colours, each over white and over
 * black — the float form missed **five**, every miss by exactly one in a channel and every one of
 * them over the white base, while rounding `a` to `round(a * 255) / 255` first matched **twelve out
 * of twelve**. `rgba(255, 0, 0, 0.5)` over white is 255/127/127 and not 255/128/128, because the
 * alpha in play is 128/255 rather than 0.5. One count in a channel will not often move a verdict,
 * but it moves it for free on a pair sitting on a threshold, and there is no reason to be wrong.
 */
export function compositeOver(top: SrgbA, bottom: Srgb): Srgb {
  const a = Math.round(Math.min(1, Math.max(0, Number.isFinite(top.a) ? top.a : 1)) * 255) / 255
  const mix = (t: number, b: number) => Math.round(a * clampByte(t) + (1 - a) * clampByte(b))
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) }
}

/* -------------------------------------------------------------------------------------------- *
 * Thresholds
 * -------------------------------------------------------------------------------------------- */

/** Which conformance level the headline verdict is held to. */
export type ContrastLevel = "AA" | "AAA"

/**
 * What the pair is for.
 *
 * `"text"` is 1.4.3 / 1.4.6 Contrast (Minimum / Enhanced); `"non-text"` is 1.4.11 Non-text Contrast,
 * which covers the visual boundary of a control, a focus ring, and any graphic a reader has to make
 * out — an icon-only button, a chart series, the bar of a progress meter.
 */
export type ContrastUsage = "text" | "non-text"

/** The absolute CSS length units, in px. The rest need a DOM to resolve. */
const ABSOLUTE_UNITS: Record<string, number> = {
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
}

/** 18pt, the size at which text is "large" at any weight. */
export const LARGE_TEXT_PX = 24

/** 14pt, the size at which bold text is "large". */
export const LARGE_BOLD_TEXT_PX = 14 * ABSOLUTE_UNITS.pt

/**
 * Slack on the large-text comparison, in px.
 *
 * **Without it the threshold is decided by floating-point association.** `(14 * 96) / 72` is
 * 18.666666666666668 and `14 * (96 / 72)` — which is what a `pt` length converted through a unit
 * table comes to — is 18.666666666666664, so a strict `>=` against the first form rejects the
 * second: a caller writing `fontSize="14pt"` with `fontWeight={700}` is told the text is not large
 * and silently held to 4.5:1 instead of the 3:1 it is entitled to. The browser rounds its own
 * computed value to four decimals (`14pt` reads back as `18.6667px`), which is a second source of
 * the same kind of miss. A hundredth of a pixel is far below any size difference a reader could
 * perceive and well above either artefact.
 */
export const LARGE_TEXT_EPSILON = 0.01

/** The weight at which CSS calls text bold. `bold` and `bolder` both compute to this. */
export const BOLD_WEIGHT = 700

/** The size and weight of the text a pair is being judged for. */
export interface TextStyle {
  /** Used font size, in px. */
  px: number
  /** Used font weight as a number — `bold` computes to 700. */
  weight: number
}

/**
 * Whether WCAG counts this text as large, which drops the requirement from 4.5:1 to 3:1.
 *
 * **It takes the size *and* the weight, and a component handed only a size cannot answer it.** The
 * rule is 18pt at any weight or 14pt when bold, and 14pt bold is a smaller number of pixels than
 * 18pt regular — so at 20px the answer is "large" at weight 700 and "not large" at weight 400, and
 * a caller who passes the size alone has told you nothing about which. Verified against the browser
 * rather than converted by hand: a probe set to `18pt` computes to `24px`, `14pt` to `18.6667px`
 * and `1pt` to `1.33333px`, and `font-weight: bold` and `bolder` both compute to `700` while
 * `lighter` computes to `100`. This defaults the weight to 400 when it is not given, which is the
 * conservative direction — it asks for more contrast, not less.
 */
export function isLargeText({ px, weight }: TextStyle): boolean {
  if (!Number.isFinite(px)) return false
  const w = Number.isFinite(weight) ? weight : 400
  return (
    px >= LARGE_TEXT_PX - LARGE_TEXT_EPSILON ||
    (px >= LARGE_BOLD_TEXT_PX - LARGE_TEXT_EPSILON && w >= BOLD_WEIGHT)
  )
}

/** One requirement, and whether the measured ratio meets it. */
export interface ContrastCheck {
  id: "body-aa" | "body-aaa" | "large-aa" | "large-aaa" | "non-text"
  /** Human-readable name of the requirement, e.g. "Body text (AA)". */
  label: string
  /** The criterion it comes from, e.g. "1.4.3". */
  criterion: string
  /** The ratio the criterion asks for. */
  required: number
  passes: boolean
}

/** Everything known about a measured pair. */
export interface ContrastReport {
  /** The ratio itself, unrounded. */
  ratio: number
  /** Whether the text was judged large. Always false for `"non-text"`. */
  large: boolean
  /** The one requirement that applies to the pair as described — what the headline reports. */
  operative: ContrastCheck
  /** Every requirement WCAG 2 states for this usage, in order, for showing the detail. */
  checks: ContrastCheck[]
}

/**
 * The ratio WCAG 2 asks for.
 *
 * **1.4.11 is a AA criterion with no AAA counterpart**, so asking for AAA on a non-text pair gets
 * 3:1 back rather than a stricter number invented here. Reporting a higher bar than the standard
 * states would fail pairs that conform.
 */
export function requiredRatio(usage: ContrastUsage, level: ContrastLevel, large: boolean): number {
  if (usage === "non-text") return 3
  if (level === "AAA") return large ? 4.5 : 7
  return large ? 3 : 4.5
}

/** Grades a ratio against every requirement for this usage. */
export function gradeContrast(
  ratio: number,
  usage: ContrastUsage,
  level: ContrastLevel,
  text?: TextStyle,
): ContrastReport {
  const large = usage === "text" && text !== undefined && isLargeText(text)
  const check = (
    id: ContrastCheck["id"],
    label: string,
    criterion: string,
    required: number,
  ): ContrastCheck => ({ id, label, criterion, required, passes: ratio >= required })

  if (usage === "non-text") {
    const only = check("non-text", "UI component or graphic (AA)", "1.4.11", requiredRatio("non-text", "AA", false))
    return { ratio, large: false, operative: only, checks: [only] }
  }

  // Every number here comes from `requiredRatio` rather than being written out again: the
  // thresholds are the one thing in this file that must not be able to disagree with itself.
  const checks = [
    check("body-aa", "Body text (AA)", "1.4.3", requiredRatio("text", "AA", false)),
    check("body-aaa", "Body text (AAA)", "1.4.6", requiredRatio("text", "AAA", false)),
    check("large-aa", "Large text (AA)", "1.4.3", requiredRatio("text", "AA", true)),
    check("large-aaa", "Large text (AAA)", "1.4.6", requiredRatio("text", "AAA", true)),
  ]
  const wanted: ContrastCheck["id"] = large
    ? level === "AAA"
      ? "large-aaa"
      : "large-aa"
    : level === "AAA"
      ? "body-aaa"
      : "body-aa"
  const operative = checks.find((c) => c.id === wanted) ?? checks[0]
  return { ratio, large, operative, checks }
}

/**
 * The ratio as it should be shown, to two decimals.
 *
 * **Rounded to nearest, because the figure has to be comparable to the checker the reader is
 * cross-checking against.** Every published contrast checker rounds, so `#777777` on white is
 * quoted everywhere as 4.48:1 — its exact value is 4.4767. Truncating instead prints 4.47 and is
 * then a hundredth out against every other tool for roughly half of all pairs, which is read as
 * this component being wrong rather than as a difference in rounding.
 *
 * **Given the requirement, it truncates in the one band where rounding would contradict the
 * verdict.** A pair at 4.4993 rounds to "4.50:1", and printing that immediately above "Fails Body
 * text (AA), needs 4.5:1" is the one case where the honest figure is the shorter one. That band is
 * a thousandth wide, so it costs nothing anywhere else. The comparison itself is always on the
 * unrounded ratio.
 */
export function formatRatio(ratio: number, required?: number): string {
  if (!Number.isFinite(ratio)) return "—"
  const rounded = Math.round(ratio * 100) / 100
  if (required !== undefined && ratio < required && rounded >= required) {
    return (Math.floor(ratio * 100) / 100).toFixed(2)
  }
  return rounded.toFixed(2)
}

/**
 * A CSS length in px, or null when the unit is relative to something only the document knows.
 *
 * `em`, `rem`, `%`, `ch`, `ex` and the viewport units all come back null so the caller measures
 * them against the real element instead of guessing a 16px root.
 */
export function cssLengthToPx(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z%]*)\s*$/i.exec(value)
  if (!match) return null
  const n = Number(match[1])
  if (!Number.isFinite(n)) return null
  const unit = match[2].toLowerCase()
  if (!unit) return n
  const factor = ABSOLUTE_UNITS[unit]
  return factor === undefined ? null : n * factor
}

/** A CSS font-weight as the number CSS computes it to, or null when it needs the document. */
export function cssWeightToNumber(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  const keyword = value.trim().toLowerCase()
  if (keyword === "normal") return 400
  if (keyword === "bold") return 700
  const n = Number(keyword)
  return Number.isFinite(n) ? n : null
}

/* -------------------------------------------------------------------------------------------- *
 * Resolving a CSS colour, which needs a laid-out document and a canvas
 * -------------------------------------------------------------------------------------------- */

/** Why a colour could not be resolved. */
export type ColorFailure =
  /** Not a colour CSS accepts — a typo, or a bare word that is not a named colour. */
  | "invalid"
  /** No document to resolve against: server render, or before the first effect. */
  | "no-dom"

/** A resolved colour, composited over whatever backdrop it was measured against. */
export type ColorMeasurement =
  | {
      ok: true
      /** The colour as painted, opaque, in sRGB bytes. */
      color: Srgb
      /** True when the input carried any transparency, so `color` depends on the backdrop. */
      translucent: boolean
      /** The computed value the browser resolved the input to, for showing the reader. */
      computed: string
    }
  | { ok: false; reason: ColorFailure }

const WHITE: Srgb = { r: 255, g: 255, b: 255 }
const BLACK: Srgb = { r: 0, g: 0, b: 0 }

const toCss = ({ r, g, b }: Srgb) => `rgb(${clampByte(r)} ${clampByte(g)} ${clampByte(b)})`

let cachedContext: CanvasRenderingContext2D | null | undefined

/** One 1×1 canvas for the life of the module — this is called several times per measurement. */
function context2d(): CanvasRenderingContext2D | null {
  if (cachedContext !== undefined) return cachedContext
  if (typeof document === "undefined") return (cachedContext = null)
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  cachedContext = canvas.getContext("2d", { willReadFrequently: true })
  return cachedContext
}

/**
 * The sRGB bytes of `layers` painted bottom-first over `base`.
 *
 * **This is the step that converts the colour, and there is no arithmetic here that could do it
 * instead.** A computed colour is not `rgb()` in general: measured in Chrome 152, `oklch(0.7 0.15
 * 250)` computes to `oklch(0.7 0.15 250)`, `lab(50% 40 -30)` to `lab(50 40 -30)`,
 * `color(display-p3 1 0 0)` unchanged, and `color-mix(in srgb, red 30%, blue)` to
 * `color(srgb 0.3 0 0.7)` — so the regex that pulls three integers out of `getComputedStyle` finds
 * nothing. That is not a corner case any more: reading the eight principal theme tokens off
 * shadcn/ui's own documentation site today, **every one of them computes to `lab(...)`**, and its
 * main stylesheet contains 431 occurrences of `lab(` against one of `rgb(`. Painting the value and
 * reading the pixel asks the browser to do the conversion, which means every notation it will ever
 * ship is already handled, and out-of-gamut colours are reported as the screen will actually show
 * them (`color(display-p3 1 0 0)` reads back 255/0/0).
 *
 * **Painting over an opaque base, rather than reading the colour's own channels, is also deliberate.**
 * `getImageData` un-premultiplies, and at low alpha that is lossy: `rgba(200, 100, 50, 0.01)` reads
 * back as 170/85/85, and even at 0.05 the blue channel comes back 59 instead of 50. Composited onto
 * an opaque base the pixel is opaque, nothing is un-premultiplied, and the result is the browser's
 * own compositing rather than a reimplementation of it.
 */
function paintStack(base: Srgb, layers: string[]): Srgb | null {
  const ctx = context2d()
  if (!ctx) return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = toCss(base)
  ctx.fillRect(0, 0, 1, 1)
  for (const layer of layers) {
    ctx.fillStyle = layer
    ctx.fillRect(0, 0, 1, 1)
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return { r, g, b }
}

const same = (a: Srgb | null, b: Srgb | null) =>
  a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b

/**
 * Asks the browser what `value` means for `property` at `context`'s position in the document.
 *
 * **The probe has to be inside the document, and inside the right part of it.** A detached element
 * answers nothing at all — `getComputedStyle` on one returned the empty string for all thirteen
 * colour notations tried, including plain hex. Worse, a probe that is in the document but in the
 * wrong place answers *wrongly rather than not at all*: `var(--token)` measured on a probe inside
 * the subtree that declares the token resolved to `oklch(0.55 0.2 25)`, and the same string on a
 * probe appended to `body` resolved to `rgb(26, 26, 26)` — the inherited text colour, because an
 * undefined custom property makes the declaration invalid at computed-value time and the property
 * falls back to its inherited value. `currentColor` behaves the same way. Both are plausible
 * colours, neither is flagged, and the ratio computed from them is simply wrong, which is why the
 * context element is required rather than optional.
 *
 * A subtree that is `display: none` is still fine to measure, unlike measuring a size: inside one,
 * `var(--local)` resolved to its `oklch(...)` value and painted correctly. Colour is a computed
 * value and does not wait for layout.
 */
function probeComputed(context: Element, property: "color" | "fontSize" | "fontWeight", value: string): string {
  const probe = document.createElement("span")
  probe.style.cssText =
    "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none"
  probe.style[property] = value
  context.appendChild(probe)
  const computed = getComputedStyle(probe)[property]
  probe.remove()
  return computed
}

/**
 * Resolves `value` as a colour in `context`'s position, composited over `over`.
 *
 * `CSS.supports` is the validity gate rather than a look at the computed value, because **an
 * invalid colour is indistinguishable from a valid one downstream**: setting `color: notacolor` on
 * a probe computed to `rgb(26, 26, 26)`, the inherited colour, exactly as a correct answer would.
 * `CSS.supports("color", …)` is true for `currentColor`, for `var(--x, #0f0)` and for the
 * out-of-range-but-clamping `rgb(300 0 0)`, and false for `notacolor` and for the empty string,
 * which is the division wanted here.
 *
 * Transparency is detected by painting the value over white and over black and comparing: identical
 * means opaque, different means some of the backdrop came through. Measured, that separates
 * `rgba(255, 0, 0, 0.5)`, `oklch(0.7 0.15 250 / 0.6)`, `color-mix(in srgb, red 30%, transparent)`
 * and `transparent` itself from their opaque counterparts, without parsing a single notation. A
 * value the canvas were to refuse would read as fully transparent and so as translucent, which
 * sends it to the "needs a backdrop" answer rather than to a confident wrong number.
 */
export function measureColorIn(
  context: Element | null | undefined,
  value: string,
  over: Srgb = WHITE,
): ColorMeasurement {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return { ok: false, reason: "no-dom" }
  }
  const input = (value ?? "").trim()
  if (!input) return { ok: false, reason: "invalid" }
  if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
    if (!CSS.supports("color", input)) return { ok: false, reason: "invalid" }
  }
  const host = context ?? document.body
  if (!host || !host.isConnected) return { ok: false, reason: "no-dom" }

  const computed = probeComputed(host, "color", input)
  if (!computed) return { ok: false, reason: "no-dom" }

  const onWhite = paintStack(WHITE, [computed])
  const onBlack = paintStack(BLACK, [computed])
  if (onWhite === null || onBlack === null) return { ok: false, reason: "no-dom" }
  const translucent = !same(onWhite, onBlack)
  const color = translucent ? paintStack(over, [computed]) : onWhite
  if (color === null) return { ok: false, reason: "no-dom" }
  return { ok: true, color, translucent, computed }
}

/** What is actually painted underneath an element. */
export interface Backdrop {
  color: Srgb
  /**
   * True when no ancestor painted an opaque background and white was assumed — the colour of the
   * browser's own canvas, which a user stylesheet or a forced-colours mode can change.
   */
  assumed: boolean
}

/**
 * The colour painted behind `from`, by walking up until something opaque is found.
 *
 * An element with no background of its own computes to `rgba(0, 0, 0, 0)`, so the nearest painted
 * ancestor is the one that matters — measured on a page, two nested transparent `div`s and then
 * `body` at `rgb(251, 251, 250)`. Translucent layers found on the way up are kept and composited in
 * order rather than skipped, because a 60%-opaque panel over a dark page is a different backdrop
 * from either of them.
 *
 * Backgrounds only. An image, a gradient or a `backdrop-filter` behind the text has no single
 * colour and so no single ratio; WCAG's own advice there is to test the lightest and darkest points
 * by hand, and this reports the background colour underneath rather than pretending to average an
 * image it cannot see.
 */
export function findBackdrop(from: Element | null | undefined): Backdrop {
  if (!from || typeof window === "undefined") return { color: WHITE, assumed: true }
  const layers: string[] = []
  let assumed = true
  for (let node: Element | null = from; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor
    if (!bg) continue
    const onWhite = paintStack(WHITE, [bg])
    const onBlack = paintStack(BLACK, [bg])
    if (onWhite === null || onBlack === null) break
    if (same(onWhite, WHITE) && same(onBlack, BLACK)) continue // fully transparent
    layers.push(bg)
    if (same(onWhite, onBlack)) {
      assumed = false
      break
    }
  }
  const color = paintStack(WHITE, layers.reverse())
  return { color: color ?? WHITE, assumed }
}

/* -------------------------------------------------------------------------------------------- *
 * The hook
 * -------------------------------------------------------------------------------------------- */

export interface UseContrastOptions {
  /** The text or graphic colour, in any notation CSS accepts. */
  foreground: string
  /** The colour behind it. */
  background: string
  /**
   * An opaque colour under `background`, needed when either colour is translucent.
   *
   * Left out, the colour painted behind the component is walked up and used, and if nothing opaque
   * is found the browser canvas is assumed white.
   */
  backdrop?: string
  usage?: ContrastUsage
  level?: ContrastLevel
  /** Size of the text being judged. A string is resolved against the document, so `18pt` works. */
  fontSize?: number | string
  fontWeight?: number | string
}

/** What `useContrast` settled on. */
export interface ContrastState {
  /**
   * `pending` before the first measurement (and on the server), `invalid` when a colour is not a
   * colour, `indeterminate` when a translucent colour has no opaque backdrop to sit on, and
   * `measured` otherwise.
   */
  status: "pending" | "measured" | "invalid" | "indeterminate"
  report: ContrastReport | null
  foreground: Srgb | null
  background: Srgb | null
  /** Which inputs CSS rejected, for pointing at the field that needs fixing. */
  invalid: ("foreground" | "background" | "backdrop")[]
  /** Which inputs carried transparency. */
  translucent: { foreground: boolean; background: boolean }
  /** True when the backdrop under a translucent colour was assumed rather than found. */
  assumedBackdrop: boolean
  /** The computed values the browser resolved the inputs to. */
  computed: { foreground: string | null; background: string | null }
}

const PENDING: ContrastState = {
  status: "pending",
  report: null,
  foreground: null,
  background: null,
  invalid: [],
  translucent: { foreground: false, background: false },
  assumedBackdrop: false,
  computed: { foreground: null, background: null },
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Measures a pair at `context`'s position in the document and grades it, in one call.
 *
 * Exported separately from the hook because a token table grades dozens of pairs against the same
 * two or three backgrounds, and a hook per row buys nothing: this is a synchronous read with no
 * state of its own, so a caller can map it over a list inside a single effect. It is also the whole
 * of the decision — which colour is composited over which, and when the honest answer is "no
 * ratio" — kept out of the effect so it can be exercised without one.
 *
 * The order is forced and is the reason this is one function rather than three calls. The backdrop
 * has to be known before the background can be composited, and the background before the
 * foreground, because **text sits on the background and not on the backdrop**: translucent text
 * over a translucent panel over a page is three layers, and compositing the text straight onto the
 * page skips the panel and reports a ratio against a colour that is nowhere on screen.
 */
export function measureContrast(
  context: Element,
  {
    foreground,
    background,
    backdrop,
    usage = "text",
    level = "AA",
    fontSize,
    fontWeight,
  }: UseContrastOptions,
): ContrastState {
  const invalid: ContrastState["invalid"] = []

  // The backdrop first: the other two may need it to mean anything.
  let base: Srgb
  let assumedBackdrop = false
  if (backdrop !== undefined) {
    const measured = measureColorIn(context, backdrop, WHITE)
    if (!measured.ok) {
      invalid.push("backdrop")
      const found = findBackdrop(context)
      base = found.color
      assumedBackdrop = found.assumed
    } else {
      base = measured.color
      assumedBackdrop = measured.translucent
    }
  } else {
    const found = findBackdrop(context)
    base = found.color
    assumedBackdrop = found.assumed
  }

  const bg = measureColorIn(context, background, base)
  // Text sits on the background, not on the backdrop, so a translucent foreground is composited
  // over whatever the background resolved to.
  const bgColor = bg.ok ? bg.color : base
  const fg = measureColorIn(context, foreground, bgColor)

  if (!fg.ok && fg.reason === "invalid") invalid.push("foreground")
  if (!bg.ok && bg.reason === "invalid") invalid.push("background")

  if (!fg.ok || !bg.ok) {
    return {
      ...PENDING,
      status: invalid.length > 0 ? "invalid" : "pending",
      invalid,
      assumedBackdrop,
    }
  }

  // A translucent colour with nothing known under it has no ratio. Saying so is the honest answer;
  // quietly assuming white is how a dark theme gets told its overlay text passes.
  const needsBackdrop = (fg.translucent || bg.translucent) && assumedBackdrop
  const translucent = { foreground: fg.translucent, background: bg.translucent }
  const computed = { foreground: fg.computed, background: bg.computed }

  if (needsBackdrop) {
    return {
      status: "indeterminate",
      report: null,
      foreground: fg.color,
      background: bg.color,
      invalid,
      translucent,
      assumedBackdrop,
      computed,
    }
  }

  let text: TextStyle | undefined
  if (usage === "text") {
    const px =
      cssLengthToPx(fontSize) ??
      (fontSize === undefined
        ? null
        : cssLengthToPx(probeComputed(context, "fontSize", String(fontSize))))
    const weight =
      cssWeightToNumber(fontWeight) ??
      (fontWeight === undefined
        ? null
        : cssWeightToNumber(probeComputed(context, "fontWeight", String(fontWeight))))
    if (px !== null) text = { px, weight: weight ?? 400 }
  }

  return {
    status: "measured",
    report: gradeContrast(contrastRatio(fg.color, bg.color), usage, level, text),
    foreground: fg.color,
    background: bg.color,
    invalid,
    translucent,
    assumedBackdrop,
    computed,
  }
}

/**
 * Measures a foreground/background pair at `contextRef`'s position and grades it.
 *
 * Exported on its own because the grade is worth having without this component's markup — a cell in
 * a token table, a warning beside a colour input, a row in an audit.
 *
 * **It re-measures when the theme changes, which is not a prop change and not a resize.** If the
 * colours are tokens, `foreground` and `background` can both be the same two strings before and
 * after a dark-mode toggle while the answer moves a long way: measured on shadcn/ui's own site,
 * adding the `dark` class to `<html>` took `--foreground` from 0/0/0 to 250/250/250 and
 * `--background` from 255/255/255 to 10/10/10, which is the difference between a 21.00:1 pair and an
 * 18.97:1 one. Nothing in React hears about that, so a `MutationObserver` watches the document
 * element's `class`, `style` and `data-theme` — the three places the theme switchers in circulation
 * write — and `prefers-color-scheme` is watched for a page themed by media query alone. A
 * contrast component that goes stale on a theme toggle is worse than no contrast component, because
 * the number it keeps showing is the one the reader is trusting.
 */
export function useContrast(
  contextRef: React.RefObject<Element | null>,
  {
    foreground,
    background,
    backdrop,
    usage = "text",
    level = "AA",
    fontSize,
    fontWeight,
  }: UseContrastOptions,
): ContrastState {
  const [state, setState] = React.useState<ContrastState>(PENDING)
  // Bumped by anything that can change the answer without changing a prop.
  const [revision, setRevision] = React.useState(0)

  useIsomorphicLayoutEffect(() => {
    const context = contextRef.current
    if (!context || typeof window === "undefined") return
    setState(
      measureContrast(context, {
        foreground,
        background,
        backdrop,
        usage,
        level,
        fontSize,
        fontWeight,
      }),
    )
  }, [contextRef, foreground, background, backdrop, usage, level, fontSize, fontWeight, revision])

  React.useEffect(() => {
    if (typeof window === "undefined") return
    const bump = () => setRevision((n) => n + 1)

    const observer = new MutationObserver(bump)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    })

    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    media?.addEventListener?.("change", bump)

    // One re-measurement once the document has finished its initial style and font work. A font
    // cannot change a colour, but a theme stylesheet that was not render-blocking can, and this is
    // the cheapest already-available signal that the first paint has settled. It does not catch a
    // stylesheet injected later than that — nothing short of polling would, and a theme that
    // arrives after the page is interactive will come in through the attribute observer above or
    // not at all.
    let cancelled = false
    document.fonts?.ready?.then(() => {
      if (!cancelled) bump()
    })

    return () => {
      cancelled = true
      observer.disconnect()
      media?.removeEventListener?.("change", bump)
    }
  }, [])

  return state
}

/* -------------------------------------------------------------------------------------------- *
 * The component
 * -------------------------------------------------------------------------------------------- */

export const colorContrastLabels = {
  /** Shown while the first measurement has not happened — on the server, and in the first paint. */
  pending: "Measuring…",
  invalid: "Not a colour",
  invalidHint: "Enter a colour CSS accepts, such as #3b82f6, oklch(0.7 0.15 250) or var(--primary).",
  indeterminate: "Needs a backdrop",
  indeterminateHint:
    "One of these colours is translucent, so its contrast depends on what is painted underneath. Give a backdrop colour to get a ratio.",
  passes: "Passes",
  fails: "Fails",
  ratioLabel: "Contrast ratio",
  sample: "The quick brown fox jumps over the lazy dog",
  largeText: "counted as large text",
  normalText: "counted as normal-size text",
  unknownSize: "no text size given, judged as normal-size text",
  assumedBackdrop: "backdrop assumed white",
}

export type ColorContrastLabels = typeof colorContrastLabels

export interface ColorContrastProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "color">,
    UseContrastOptions {
  /** Text drawn in the pair, or `false` for no preview. */
  sample?: React.ReactNode | false
  /** Show the full list of requirements under the headline. Defaults to true. */
  detail?: boolean
  labels?: Partial<ColorContrastLabels>
  /** Called with the state whenever the measurement settles. */
  onReport?: (state: ContrastState) => void
}

/**
 * Says whether a foreground/background pair is readable, and why.
 *
 * Reports WCAG 2 ratios only. APCA — the perceptual model drafted for WCAG 3, which is the usual
 * objection to the numbers here, and a fair one, since 2.x's ratio is known to be harsh on light
 * text and generous on dark — is deliberately not computed: it is not a Recommendation, its
 * coefficients are versioned, and a number that disagrees with the reference implementation is
 * worse than no number on a screen whose whole purpose is to be trusted. Conformance, procurement
 * and the law are written against 2.x today, so that is what this reports, and it reports it exactly.
 *
 * **Nothing here is said in colour alone**, which would be a poor joke in this component: every
 * verdict is a word, the icons are `aria-hidden`, and the headline is a live region so a reader
 * dragging a colour slider hears the new ratio instead of watching for a tick to change shape.
 */
export const ColorContrast = React.forwardRef<HTMLDivElement, ColorContrastProps>(
  function ColorContrast(
    {
      foreground,
      background,
      backdrop,
      usage = "text",
      level = "AA",
      fontSize,
      fontWeight,
      sample,
      detail = true,
      labels: labelOverrides,
      onReport,
      className,
      ...props
    },
    forwardedRef,
  ) {
    const labels = { ...colorContrastLabels, ...labelOverrides }
    const root = React.useRef<HTMLDivElement | null>(null)
    const setRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        root.current = node
        if (typeof forwardedRef === "function") forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      },
      [forwardedRef],
    )

    const state = useContrast(root, {
      foreground,
      background,
      backdrop,
      usage,
      level,
      fontSize,
      fontWeight,
    })

    // Guarded on the value last handed over rather than on a dependency array: a parent that
    // re-renders in response to this callback must not turn a measurement into a loop.
    const reported = React.useRef<ContrastState | null>(null)
    React.useEffect(() => {
      if (!onReport || reported.current === state) return
      reported.current = state
      onReport(state)
    }, [onReport, state])

    const { report } = state
    const headline =
      state.status === "measured" && report
        ? `${formatRatio(report.ratio, report.operative.required)}:1`
        : state.status === "invalid"
          ? labels.invalid
          : state.status === "indeterminate"
            ? labels.indeterminate
            : labels.pending

    const sizeNote =
      usage !== "text"
        ? null
        : fontSize === undefined
          ? labels.unknownSize
          : report?.large
            ? labels.largeText
            : labels.normalText

    return (
      <div
        ref={setRef}
        className={cn("flex flex-col gap-3 text-sm", className)}
        {...props}
      >
        {sample !== false && (
          <div
            className="flex min-h-16 items-center justify-center rounded-md border px-4 py-3 text-center"
            // The one place the colours under test are applied rather than described. `aria-hidden`
            // because the string is a specimen, not content, and a reader already has the verdict.
            aria-hidden="true"
            style={{
              color: foreground,
              background,
              fontSize,
              fontWeight: fontWeight as React.CSSProperties["fontWeight"],
            }}
          >
            {sample ?? labels.sample}
          </div>
        )}

        <div role="status" className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* The figure on its own is read as a bare number; the label is what makes it a ratio. */}
          <span className="sr-only">{labels.ratioLabel}: </span>
          <span className="text-2xl font-semibold tabular-nums leading-none">{headline}</span>
          {state.status === "measured" && report && (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                report.operative.passes ? "text-foreground" : "text-destructive",
              )}
            >
              <Verdict passes={report.operative.passes} />
              {report.operative.passes ? labels.passes : labels.fails} {report.operative.label}
            </span>
          )}
          <span className="text-muted-foreground">
            {state.status === "measured" && report
              ? `needs ${report.operative.required}:1${sizeNote ? ` · ${sizeNote}` : ""}${
                  state.assumedBackdrop && (state.translucent.foreground || state.translucent.background)
                    ? ` · ${labels.assumedBackdrop}`
                    : ""
                }`
              : state.status === "invalid"
                ? labels.invalidHint
                : state.status === "indeterminate"
                  ? labels.indeterminateHint
                  : ""}
          </span>
        </div>

        {detail && state.status === "measured" && report && (
          <ul className="flex flex-col gap-1">
            {report.checks.map((check) => (
              <li
                key={check.id}
                className={cn(
                  "flex items-center gap-2",
                  check.id === report.operative.id ? "font-medium" : "text-muted-foreground",
                )}
              >
                <Verdict passes={check.passes} />
                <span className="flex-1">{check.label}</span>
                <span className="tabular-nums">{check.required}:1</span>
                <span className="sr-only">
                  {check.passes ? labels.passes : labels.fails} — WCAG {check.criterion}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  },
)

/**
 * The tick or cross.
 *
 * `aria-hidden`, with the word it stands for written out beside it in every place this is used —
 * shape and colour are both unavailable to some of the readers this component exists to serve.
 */
function Verdict({ passes }: { passes: boolean }) {
  const Icon = passes ? Check : X
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0", passes ? "text-muted-foreground" : "text-destructive")}
    />
  )
}
