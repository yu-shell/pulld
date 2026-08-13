import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One part of the whole. `value` is in whatever unit the caller likes — bytes, requests,
 * dollars, seats — because only the ratios between the parts are ever used.
 */
export interface RatioBarPart {
  /** Name shown in the legend and read out by a screen reader, e.g. "Images". */
  label: React.ReactNode
  /**
   * Size of this part. Negative, NaN and Infinity count as 0 rather than poisoning the
   * whole bar: one bad number out of a database should cost you one slice, not the layout.
   */
  value: number
  /**
   * Tailwind background class for this slice and its legend dot, e.g. "bg-chart-2" or
   * "bg-emerald-500". Defaults to a ramp of the primary colour. Pass your own once you
   * have more than five parts, or when the parts already have colours of their own
   * (languages, plan tiers, log levels).
   */
  className?: string
  /** React key for this part. Falls back to the array index. */
  id?: string
}

export interface RatioBarProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The parts, in the order they should appear from the left. */
  parts: RatioBarPart[]
  /**
   * Capacity, when the parts are "used out of a budget" rather than "all there is" —
   * a disk quota, a plan limit, a sprint's hours. The gap between the parts and the
   * capacity is drawn as empty track and listed as its own legend row. Leave it unset
   * for a plain breakdown, where the parts themselves are the whole. A capacity below
   * what the parts already add up to is ignored, since a bar cannot be more than full.
   */
  total?: number
  /**
   * Legend label for the unused capacity (default "Free"). Pass `null` to draw the gap
   * without listing it. Has no effect unless `total` leaves a gap.
   */
  remainderLabel?: React.ReactNode
  /** Show the legend (default true). When false it is still rendered for screen readers. */
  showLegend?: boolean
  /** Decimal places on the percentages (default 0, capped at 6). */
  precision?: number
  /**
   * Render the raw value next to each percentage, e.g. a byte or currency formatter.
   * Omit to show percentages alone.
   */
  formatValue?: (value: number) => React.ReactNode
  /** Classes for the track, e.g. "h-3" or "rounded-sm". */
  barClassName?: string
  /** Accessible name for the breakdown, e.g. "Storage by file type". */
  "aria-label"?: string
}

/**
 * Steps of the primary colour rather than five different hues: `--primary` exists in every
 * shadcn project and a tint of it cannot leave the theme, while the fixed chart palette
 * (`--chart-1`…`--chart-5`) only exists in projects scaffolded after charts landed. Colour
 * is never the only carrier of meaning here — the legend names every part — so a ramp is
 * enough, and callers with established colours pass `className` per part.
 */
const DEFAULT_COLORS = [
  "bg-primary",
  "bg-primary/75",
  "bg-primary/55",
  "bg-primary/40",
  "bg-primary/25",
]

/** Anything that is not a positive, finite number contributes nothing. */
function usable(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function clampPrecision(precision: number) {
  return Math.min(6, Math.max(0, Math.trunc(precision) || 0))
}

/**
 * Percentages of the total that sum to exactly 100, by largest remainder (Hamilton)
 * apportionment.
 *
 * Rounding each part on its own is the bug this exists to avoid: three equal parts come out
 * as 33% / 33% / 33% and a reader who adds them up finds 99, while 1/3 + 1/3 + 1/3 at one
 * decimal overshoots to 100.2. Here every part is floored first and the leftover points go
 * to the parts that were cut hardest, so the column always totals 100 and no part is off by
 * more than one step.
 *
 * A part worth nothing always gets 0: the points handed out are only ever as many as there
 * are parts with something left over, so a zero can never be rounded up into existence.
 *
 * Exported because the same numbers are usually wanted next to the bar — in a table, a
 * tooltip, a CSV export — and computing them a second way is how the two end up disagreeing.
 */
export function ratioPercents(values: number[], precision = 0): number[] {
  const scale = 10 ** clampPrecision(precision)
  const safe = values.map(usable)
  const total = safe.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return safe.map(() => 0)

  const target = 100 * scale
  const exact = safe.map((value) => (value / total) * target)
  const floors = exact.map((n) => Math.floor(n))
  const units = floors.slice()
  let short = target - floors.reduce((sum, n) => sum + n, 0)

  // Biggest fractional part first. When two parts were cut equally hard the point goes to the
  // bigger one, where it distorts the reading least — half a point on top of 37.5 is a 1%
  // overstatement, the same half point on top of 12.5 is a 4% one. Parts that are equal in
  // both respects fall to the earlier one, because Array#sort has been stable since ES2019;
  // that matters beyond tidiness, since a comparator that resolved ties by chance would let
  // the server and the browser render different numbers.
  const order = exact
    .map((_, i) => i)
    .sort((a, b) => exact[b] - floors[b] - (exact[a] - floors[a]) || exact[b] - exact[a])
  for (let i = 0; i < order.length && short > 0; i++, short--) units[order[i]] += 1

  return units.map((u) => u / scale)
}

/**
 * A percentage that has been rounded to nothing, or up to everything, is a lie about a part
 * that is neither. Those two cases are relabelled rather than re-rounded, so the numbers
 * still sum to 100 while a 0.02% slice reads "<1%" instead of "0%".
 */
function formatPercent(
  percent: number,
  precision: number,
  value: number,
  total: number
) {
  const step = 1 / 10 ** precision
  if (value > 0 && percent === 0) return `<${step.toFixed(precision)}%`
  if (percent === 100 && value < total) return `>${(100 - step).toFixed(precision)}%`
  return `${percent.toFixed(precision)}%`
}

export const RatioBar = React.forwardRef<HTMLDivElement, RatioBarProps>(
  function RatioBar(
    {
      className,
      parts,
      total,
      remainderLabel = "Free",
      showLegend = true,
      precision = 0,
      formatValue,
      barClassName,
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) {
    const decimals = clampPrecision(precision)
    const values = parts.map((part) => usable(part.value))
    const sum = values.reduce((acc, value) => acc + value, 0)
    const capacity =
      typeof total === "number" && Number.isFinite(total) && total > sum ? total : sum
    const gap = capacity - sum

    // The gap is apportioned alongside the parts so that a bar with spare capacity still
    // adds up to 100% including the empty stretch.
    const percents = ratioPercents([...values, gap], decimals)
    const gapPercent = percents[percents.length - 1]

    const colorFor = (part: RatioBarPart, index: number) =>
      part.className ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length]

    const describe = (value: number, percent: number) => {
      const share = formatPercent(percent, decimals, value, capacity)
      return formatValue ? `${formatValue(value)} (${share})` : share
    }

    return (
      <div ref={ref} className={cn("w-full", className)} {...props}>
        {/*
          Decorative: every number and name below is in the list, so a reader that skips
          the bar loses nothing. The slices are sized by the exact share rather than by the
          rounded percentage — a 0.4% slice should stay a visible sliver, not collapse
          because its label rounded down to "<1%".
        */}
        <div
          aria-hidden="true"
          className={cn(
            "flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted",
            barClassName
          )}
        >
          {parts.map((part, index) =>
            values[index] > 0 ? (
              <span
                key={part.id ?? index}
                className={cn("h-full min-w-[2px]", colorFor(part, index))}
                style={{ flexGrow: values[index] / capacity, flexBasis: 0 }}
              />
            ) : null
          )}
          {gap > 0 ? (
            <span
              className="h-full"
              style={{ flexGrow: gap / capacity, flexBasis: 0 }}
            />
          ) : null}
        </div>

        <ul
          aria-label={ariaLabel}
          className={cn(
            showLegend
              ? "mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm"
              : "sr-only"
          )}
        >
          {parts.map((part, index) => (
            <li key={part.id ?? index} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  colorFor(part, index)
                )}
              />
              <span className="text-foreground">{part.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {describe(values[index], percents[index])}
              </span>
            </li>
          ))}
          {gap > 0 && remainderLabel != null ? (
            <li className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full border border-border bg-muted"
              />
              <span className="text-foreground">{remainderLabel}</span>
              <span className="tabular-nums text-muted-foreground">
                {describe(gap, gapPercent)}
              </span>
            </li>
          ) : null}
        </ul>
      </div>
    )
  }
)
