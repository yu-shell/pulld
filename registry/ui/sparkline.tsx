import * as React from "react"

import { cn } from "@/lib/utils"

type Datum = number | null | undefined

interface Point {
  x: number
  y: number
}

function isNum(value: Datum): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Dimensions arrive from a JS call site where the prop types no longer apply. A
 * NaN or negative one would reach the viewBox and blank the whole graphic, so a
 * nonsense size falls back to the default rather than rendering nothing.
 */
function sizeOr(n: number, fallback: number) {
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Two decimals is below one device pixel at any size a sparkline is drawn at,
 * and it keeps the `d` attribute short. Rounding also makes the markup byte
 * identical on the server and the client, so hydration never sees a diff.
 */
function fmt(n: number) {
  return String(Math.round(n * 100) / 100)
}

/**
 * Deterministic on purpose: `toLocaleString` / `Intl` resolve against the host
 * locale, so the server and the browser can render different accessible names
 * for the same data and React warns about the mismatch.
 */
function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

/** Min and max in one pass — `Math.min(...values)` overflows the stack on long series. */
function extent(values: number[]) {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return { lo, hi }
}

/**
 * The value range the plot area maps onto. Explicit `min`/`max` win so that a
 * column of sparklines can share one scale — without that, every row is
 * autoscaled to its own extremes and they all look like the same shape.
 */
function resolveDomain(values: number[], min?: number, max?: number) {
  const measured = values.length ? extent(values) : { lo: 0, hi: 0 }
  let lo = isNum(min) ? min : measured.lo
  let hi = isNum(max) ? max : measured.hi
  if (hi < lo) {
    const swap = lo
    lo = hi
    hi = swap
  }
  return { lo, hi }
}

/** True when some finite value has no finite neighbour, so a line can't reach it. */
function hasIsolatedPoint(data: ReadonlyArray<Datum>) {
  for (let i = 0; i < data.length; i++) {
    if (!isNum(data[i])) continue
    if (!isNum(data[i - 1]) && !isNum(data[i + 1])) return true
  }
  return false
}

/**
 * Split the series into runs of consecutive finite values and project each one
 * into the padded plot box. Gaps keep their horizontal slot, so a missing day
 * leaves a hole rather than shifting the rest of the series left.
 */
function buildRuns(
  data: ReadonlyArray<Datum>,
  box: { width: number; height: number; pad: number; lo: number; hi: number }
) {
  const { width, height, pad, lo, hi } = box
  const left = pad
  const right = Math.max(pad, width - pad)
  const top = pad
  const bottom = Math.max(pad, height - pad)
  const span = hi - lo
  const runs: Point[][] = []
  let run: Point[] = []

  for (let i = 0; i < data.length; i++) {
    const value = data[i]
    if (!isNum(value)) {
      if (run.length) runs.push(run)
      run = []
      continue
    }
    // A single point has no span to sit in, so it goes in the middle.
    const t = data.length === 1 ? 0.5 : i / (data.length - 1)
    // A flat series (or a plot box too short to hold the stroke) carries no
    // vertical information; centring it beats dividing by zero and emitting NaN.
    const f = span > 0 ? (clamp(value, lo, hi) - lo) / span : 0.5
    run.push({ x: left + (right - left) * t, y: bottom - (bottom - top) * f })
  }
  if (run.length) runs.push(run)
  return runs
}

function linePath(runs: Point[][]) {
  let d = ""
  for (const run of runs) {
    // Lone points are drawn as dots instead — a one-point subpath draws nothing.
    if (run.length < 2) continue
    d += `M${fmt(run[0].x)},${fmt(run[0].y)}`
    for (let i = 1; i < run.length; i++) d += `L${fmt(run[i].x)},${fmt(run[i].y)}`
  }
  return d
}

function areaPath(runs: Point[][], baseline: number) {
  let d = ""
  for (const run of runs) {
    if (run.length < 2) continue
    d += `M${fmt(run[0].x)},${fmt(baseline)}`
    for (const p of run) d += `L${fmt(p.x)},${fmt(p.y)}`
    d += `L${fmt(run[run.length - 1].x)},${fmt(baseline)}Z`
  }
  return d
}

/**
 * A zero-length subpath with a round cap. A `<circle>` would be squashed into
 * an ellipse, because `preserveAspectRatio="none"` scales x and y differently;
 * this dot is drawn by the stroke, which `vector-effect` keeps circular.
 */
function dotPath(points: Point[]) {
  let d = ""
  for (const p of points) d += `M${fmt(p.x)},${fmt(p.y)}L${fmt(p.x)},${fmt(p.y)}`
  return d
}

/**
 * Everything the component draws, as one pure function of its props. Keeping
 * the geometry out of the render body is what makes the maths testable without
 * a DOM — every trap this component exists to avoid lives in here.
 */
function buildSparkline(opts: {
  data: ReadonlyArray<Datum>
  width: number
  height: number
  strokeWidth: number
  area: boolean
  showLast: boolean
  min?: number
  max?: number
}) {
  const series: ReadonlyArray<Datum> = Array.isArray(opts.data) ? opts.data : []
  const values: number[] = []
  for (const v of series) if (isNum(v)) values.push(v)

  const width = sizeOr(opts.width, 120)
  const height = sizeOr(opts.height, 32)
  const strokeWidth = sizeOr(opts.strokeWidth, 2)

  const { lo, hi } = resolveDomain(values, opts.min, opts.max)
  const dotRadius = Math.max(strokeWidth * 1.5, 1)
  const drawsDots = opts.showLast || hasIsolatedPoint(series)
  // Inset by whatever bleeds furthest, so the round cap on a point sitting at
  // the very top or bottom of the scale is not sliced in half by the viewport.
  const pad = Math.max(strokeWidth / 2, drawsDots ? dotRadius : 0)

  const runs = buildRuns(series, { width, height, pad, lo, hi })
  const lone = runs.filter((run) => run.length === 1).map((run) => run[0])
  const lastRun = runs[runs.length - 1]
  let last = opts.showLast && lastRun ? lastRun[lastRun.length - 1] : undefined
  // When the newest value is itself an isolated point it is already in `lone`,
  // and drawing it twice would put a redundant subpath in the markup.
  if (last && lone.includes(last)) last = undefined

  return {
    values,
    // Normalised sizes travel back out so the viewBox and the rendered stroke
    // agree with the geometry they were measured against.
    width,
    height,
    strokeWidth,
    dotRadius,
    line: linePath(runs),
    fill: opts.area ? areaPath(runs, Math.max(pad, height - pad)) : "",
    dots: dotPath(last ? [...lone, last] : lone),
  }
}

function describeSeries(values: number[], format: (value: number) => string) {
  if (!values.length) return "No data"
  const last = values[values.length - 1]
  if (values.length === 1) return `1 point, ${format(last)}`
  const first = values[0]
  const { lo, hi } = extent(values)
  const direction = last > first ? "up" : last < first ? "down" : "flat"
  return `${values.length} points, ${direction} from ${format(first)} to ${format(
    last
  )}, low ${format(lo)}, high ${format(hi)}`
}

interface SparklineProps
  extends Omit<React.ComponentPropsWithoutRef<"svg">, "children"> {
  /**
   * The series, oldest first. `null` / `undefined` / `NaN` are treated as gaps:
   * they keep their slot on the x axis and break the line instead of being
   * dropped or drawn as zero.
   */
  data: ReadonlyArray<Datum>
  /** Intrinsic width in pixels (default 120). CSS wins, e.g. `className="w-full"`. */
  width?: number
  /** Intrinsic height in pixels (default 32). */
  height?: number
  /**
   * Pin the bottom of the scale. Pass `min`/`max` to every sparkline in a table
   * so their shapes are comparable; values outside the range are clamped.
   */
  min?: number
  /** Pin the top of the scale. */
  max?: number
  /** Line thickness in pixels, unaffected by stretching (default 2). */
  strokeWidth?: number
  /** Fill the area under the line at low opacity (default false). */
  area?: boolean
  /** Mark the most recent value with a dot (default false). */
  showLast?: boolean
  /** Format numbers in the generated accessible name (default: plain, up to 2 decimals). */
  formatValue?: (value: number) => string
}

export const Sparkline = React.forwardRef<SVGSVGElement, SparklineProps>(
  function Sparkline(
    {
      className,
      data,
      width = 120,
      height = 32,
      min,
      max,
      strokeWidth = 2,
      area = false,
      showLast = false,
      formatValue,
      "aria-label": ariaLabel,
      "aria-hidden": ariaHidden,
      ...props
    },
    ref
  ) {
    const {
      values,
      width: w,
      height: h,
      strokeWidth: sw,
      dotRadius,
      line,
      fill,
      dots,
    } = buildSparkline({
      data,
      width,
      height,
      strokeWidth,
      area,
      showLast,
      min,
      max,
    })

    // An explicit aria-hidden means the caller already names this elsewhere
    // (a stat card that reads out the number, say) — don't announce it twice.
    const decorative = ariaHidden !== undefined && ariaHidden !== false && ariaHidden !== "false"

    return (
      <svg
        ref={ref}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        // Sparklines stretch to their container; the default (`meet`) would
        // letterbox the line in the middle of a wide table cell instead.
        preserveAspectRatio="none"
        role={decorative ? undefined : "img"}
        aria-label={
          decorative
            ? undefined
            : ariaLabel ?? describeSeries(values, formatValue ?? formatNumber)
        }
        aria-hidden={ariaHidden}
        // `overflow-visible` is the backstop for the case `pad` can't cover: when
        // CSS squashes the box below its intrinsic height, one user unit of
        // padding renders as less than one pixel of stroke.
        className={cn("overflow-visible text-primary", className)}
        {...props}
      >
        {fill ? (
          <path d={fill} fill="currentColor" fillOpacity={0.15} stroke="none" />
        ) : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
            // Without this the stroke is scaled with the box: stretch a
            // sparkline across a wide cell and it turns into a wedge.
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {dots ? (
          <path
            d={dots}
            fill="none"
            stroke="currentColor"
            strokeWidth={dotRadius * 2}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    )
  }
)
