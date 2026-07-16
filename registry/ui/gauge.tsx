import * as React from "react"

import { cn } from "@/lib/utils"

interface GaugeSegment {
  /**
   * Inclusive upper bound (in value units on the min..max scale) that this
   * color applies up to. List segments in ascending order of upTo.
   */
  upTo: number
  /**
   * Tailwind/shadcn text color class for the arc when the value falls in this
   * segment, e.g. "text-primary", "text-amber-500", "text-destructive".
   */
  className: string
}

interface GaugeProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Current value, clamped to min..max. */
  value?: number
  /** Value at the left end of the dial (default 0). */
  min?: number
  /** Value at the right end of the dial (default 100). */
  max?: number
  /** Width of the dial in pixels; height is roughly half of this (default 160). */
  size?: number
  /** Arc thickness in pixels (default 12). */
  strokeWidth?: number
  /**
   * Threshold color zones. The arc uses the first segment whose `upTo` is >=
   * the current value, so pass them in ascending order — e.g.
   * `[{ upTo: 60, className: "text-primary" }, { upTo: 85, className: "text-amber-500" }, { upTo: 100, className: "text-destructive" }]`.
   * Omit for a single-color dial (text-primary).
   */
  segments?: GaugeSegment[]
  /** Render the value in the center of the dial (default true). */
  showValue?: boolean
  /** Format the displayed value (default rounds to an integer). */
  formatValue?: (value: number) => React.ReactNode
  /** Small caption under the number, e.g. "CPU load" or "°C". */
  label?: React.ReactNode
  /** Custom center content — overrides showValue and label. */
  children?: React.ReactNode
  /** Accessible name, e.g. "Server load". */
  "aria-label"?: string
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export const Gauge = React.forwardRef<HTMLDivElement, GaugeProps>(
  function Gauge(
    {
      className,
      value = 0,
      min = 0,
      max = 100,
      size = 160,
      strokeWidth = 12,
      segments,
      showValue = true,
      formatValue,
      label,
      children,
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) {
    const clamped = clamp(value, min, max)
    const fraction = max <= min ? 0 : (clamped - min) / (max - min)

    const radius = (size - strokeWidth) / 2
    const cx = size / 2
    const cy = radius + strokeWidth / 2
    const height = cy + strokeWidth / 2
    // A semicircle from the left end, over the top, to the right end.
    const arc = `M ${strokeWidth / 2} ${cy} A ${radius} ${radius} 0 0 1 ${
      size - strokeWidth / 2
    } ${cy}`
    const arcLength = Math.PI * radius
    const dashOffset = arcLength * (1 - fraction)

    // First segment whose ceiling the value falls under; else the last one.
    const activeClass =
      segments?.find((s) => clamped <= s.upTo)?.className ??
      segments?.[segments.length - 1]?.className ??
      "text-primary"

    const showCenter = children != null || showValue || label != null

    return (
      <div
        ref={ref}
        role="meter"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={clamped}
        aria-label={ariaLabel}
        className={cn("relative inline-flex shrink-0", className)}
        style={{ width: size, height }}
        {...props}
      >
        <svg
          width={size}
          height={height}
          viewBox={`0 0 ${size} ${height}`}
          aria-hidden="true"
        >
          <path
            className="text-muted-foreground/20"
            d={arc}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          <path
            className={cn(
              activeClass,
              "transition-[stroke-dashoffset] duration-300 ease-out"
            )}
            d={arc}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={arcLength}
            strokeDashoffset={dashOffset}
          />
        </svg>
        {showCenter ? (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-0.5 pb-[6%]">
            {children ??
              (showValue ? (
                <span className="text-xl font-semibold tabular-nums leading-none text-foreground">
                  {formatValue ? formatValue(clamped) : Math.round(clamped)}
                </span>
              ) : null)}
            {children == null && label != null ? (
              <span className="text-xs text-muted-foreground">{label}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }
)
