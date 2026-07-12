import * as React from "react"

import { cn } from "@/lib/utils"

interface ProgressRingProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Current progress from 0 to max. Ignored when indeterminate. */
  value?: number
  /** Value that counts as full (default 100). */
  max?: number
  /** Diameter of the ring in pixels (default 48). */
  size?: number
  /** Ring thickness in pixels (default 4). */
  strokeWidth?: number
  /** Spin an unfilled arc when the total isn't known yet, e.g. an upload with no length. */
  indeterminate?: boolean
  /** Render the rounded percentage in the middle (default false). */
  showValue?: boolean
  /** Custom content for the middle — an icon or short label. Overrides showValue. */
  children?: React.ReactNode
  /** Accessible name, e.g. "Upload progress". */
  "aria-label"?: string
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

export const ProgressRing = React.forwardRef<HTMLDivElement, ProgressRingProps>(
  function ProgressRing(
    {
      className,
      value = 0,
      max = 100,
      size = 48,
      strokeWidth = 4,
      indeterminate = false,
      showValue = false,
      children,
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) {
    const pct = clamp(max <= 0 ? 0 : (value / max) * 100, 0, 100)
    const radius = (size - strokeWidth) / 2
    const circumference = 2 * Math.PI * radius
    // A fixed quarter arc reads as motion while the total is unknown.
    const dashOffset = indeterminate
      ? circumference * 0.75
      : circumference * (1 - pct / 100)

    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        aria-label={ariaLabel}
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center",
          className
        )}
        style={{ width: size, height: size }}
        {...props}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className={cn(indeterminate && "animate-spin")}
          aria-hidden="true"
        >
          <circle
            className="text-muted-foreground/20"
            stroke="currentColor"
            fill="none"
            strokeWidth={strokeWidth}
            cx={size / 2}
            cy={size / 2}
            r={radius}
          />
          <circle
            className={cn(
              "text-primary",
              !indeterminate && "transition-[stroke-dashoffset] duration-300 ease-out"
            )}
            stroke="currentColor"
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            // Start the arc at 12 o'clock instead of 3 o'clock.
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        {(children ?? (showValue && !indeterminate)) ? (
          <span className="absolute inset-0 flex items-center justify-center text-xs font-medium tabular-nums text-foreground">
            {children ?? `${Math.round(pct)}%`}
          </span>
        ) : null}
      </div>
    )
  }
)
