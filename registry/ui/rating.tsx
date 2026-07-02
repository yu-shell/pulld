"use client"

import * as React from "react"
import { Star } from "lucide-react"

import { cn } from "@/lib/utils"

interface RatingProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "defaultValue" | "children"
  > {
  /** Controlled value from 0 to max. Pair with onValueChange. */
  value?: number
  /** Initial value when uncontrolled (default 0). */
  defaultValue?: number
  /** Fires with the new rating when the user picks one. */
  onValueChange?: (value: number) => void
  /** Number of stars (default 5). */
  max?: number
  /** Let the user pick half stars (keyboard step and the left half of a star). */
  allowHalf?: boolean
  /** Show the stars without letting the user change them — e.g. an average score. */
  readOnly?: boolean
  /** Disable input and dim the control. */
  disabled?: boolean
  /** Star size in pixels (default 20). */
  size?: number
  /** Render a hidden input with this name so the value posts in a native form. */
  name?: string
  /** Accessible name for the control, e.g. "Rate this product". */
  "aria-label"?: string
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

// Drop a trailing ".0" so labels read "4" and "3.5", not "4.0".
function format(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export const Rating = React.forwardRef<HTMLDivElement, RatingProps>(
  function Rating(
    {
      className,
      value,
      defaultValue,
      onValueChange,
      max = 5,
      allowHalf = false,
      readOnly = false,
      disabled = false,
      size = 20,
      name,
      "aria-label": ariaLabel,
      ...props
    },
    ref
  ) {
    const innerRef = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(ref, () => innerRef.current as HTMLDivElement)

    const isControlled = value !== undefined
    const [internal, setInternal] = React.useState(() => defaultValue ?? 0)
    const selected = clamp(isControlled ? (value as number) : internal, 0, max)
    const [hover, setHover] = React.useState<number | null>(null)

    const isSlider = !readOnly // slider semantics even while disabled
    const canInput = !readOnly && !disabled // pointer + keyboard active
    const step = allowHalf ? 0.5 : 1
    // What the stars paint right now: a hover preview wins while pointing.
    const shown = hover ?? selected

    function commit(next: number) {
      const clamped = clamp(next, 0, max)
      if (!isControlled) setInternal(clamped)
      if (clamped !== selected) onValueChange?.(clamped)
      innerRef.current?.focus()
    }

    // Value under the pointer within a given star (1-indexed), honoring allowHalf.
    function valueFromPointer(e: React.MouseEvent<HTMLSpanElement>, index: number) {
      if (!allowHalf) return index
      const { left, width } = e.currentTarget.getBoundingClientRect()
      return e.clientX - left < width / 2 ? index - 0.5 : index
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
      let next = selected
      switch (e.key) {
        case "ArrowRight":
        case "ArrowUp":
          next = selected + step
          break
        case "ArrowLeft":
        case "ArrowDown":
          next = selected - step
          break
        case "Home":
          next = 0
          break
        case "End":
          next = max
          break
        default:
          return
      }
      e.preventDefault()
      commit(next)
    }

    const valueText = `${format(selected)} out of ${max} stars`

    return (
      <div
        ref={innerRef}
        role={isSlider ? "slider" : "img"}
        aria-label={ariaLabel ?? (isSlider ? "Rating" : valueText)}
        aria-valuemin={isSlider ? 0 : undefined}
        aria-valuemax={isSlider ? max : undefined}
        aria-valuenow={isSlider ? selected : undefined}
        aria-valuetext={isSlider ? valueText : undefined}
        aria-disabled={disabled || undefined}
        tabIndex={canInput ? 0 : undefined}
        onKeyDown={canInput ? handleKeyDown : undefined}
        onPointerLeave={canInput ? () => setHover(null) : undefined}
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        {...props}
      >
        {Array.from({ length: max }, (_, i) => {
          const index = i + 1
          // Fraction of this star to fill: 1 = full, 0.5 = left half, 0 = empty.
          const fill = clamp(shown - i, 0, 1)
          return (
            <span
              key={index}
              className={cn("relative inline-flex", canInput && "cursor-pointer")}
              onPointerMove={
                canInput ? (e) => setHover(valueFromPointer(e, index)) : undefined
              }
              onClick={canInput ? (e) => commit(valueFromPointer(e, index)) : undefined}
            >
              <Star
                size={size}
                aria-hidden="true"
                className="fill-transparent text-muted-foreground/40"
              />
              {fill > 0 && (
                <span
                  className="absolute inset-y-0 left-0 overflow-hidden"
                  style={{ width: `${fill * 100}%` }}
                  aria-hidden="true"
                >
                  <Star size={size} className="fill-primary text-primary" />
                </span>
              )}
            </span>
          )
        })}
        {name && !readOnly && (
          <input
            type="hidden"
            name={name}
            value={selected}
            disabled={disabled || undefined}
          />
        )}
      </div>
    )
  }
)
