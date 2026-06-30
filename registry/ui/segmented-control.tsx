"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface SegmentedControlOption {
  /** Stable value reported through onValueChange and compared against value. */
  value: string
  /** Visible label; falls back to the value when omitted. */
  label?: React.ReactNode
  /** Disable just this segment while leaving the rest usable. */
  disabled?: boolean
}

interface SegmentedControlProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "defaultValue"
  > {
  /** The 2–4 mutually exclusive choices, rendered left to right. */
  options: SegmentedControlOption[]
  /** Controlled selected value. Pair with onValueChange. */
  value?: string
  /** Initial selection when uncontrolled (defaults to the first option). */
  defaultValue?: string
  /** Fires with the new value whenever the selection changes. */
  onValueChange?: (value: string) => void
  /** Disable the whole control. */
  disabled?: boolean
  /** Accessible name for the group, e.g. "View" or "Time range". */
  "aria-label"?: string
}

export const SegmentedControl = React.forwardRef<
  HTMLDivElement,
  SegmentedControlProps
>(function SegmentedControl(
  {
    className,
    options,
    value,
    defaultValue,
    onValueChange,
    disabled,
    "aria-label": ariaLabel,
    ...props
  },
  ref
) {
  const isControlled = value !== undefined
  const [internal, setInternal] = React.useState(
    () => defaultValue ?? options[0]?.value
  )
  const selected = isControlled ? value : internal

  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  function select(next: string) {
    if (!isControlled) setInternal(next)
    if (next !== selected) onValueChange?.(next)
    const idx = options.findIndex((o) => o.value === next)
    refs.current[idx]?.focus()
  }

  // Next enabled segment in a direction, wrapping around the ends.
  function step(start: number, dir: 1 | -1) {
    const count = options.length
    for (let i = 1; i <= count; i++) {
      const idx = (((start + dir * i) % count) + count) % count
      if (!options[idx]?.disabled) return idx
    }
    return start
  }

  // First enabled segment scanning from one end (Home/End).
  function edge(dir: 1 | -1) {
    const count = options.length
    for (let i = 0; i < count; i++) {
      const idx = dir === 1 ? i : count - 1 - i
      if (!options[idx]?.disabled) return idx
    }
    return 0
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const start = options.findIndex((o) => o.value === selected)
    let idx: number
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        idx = step(start, 1)
        break
      case "ArrowLeft":
      case "ArrowUp":
        idx = step(start, -1)
        break
      case "Home":
        idx = edge(1)
        break
      case "End":
        idx = edge(-1)
        break
      default:
        return
    }
    e.preventDefault()
    select(options[idx].value)
  }

  // Roving tabindex: the selected segment is tabbable, unless it's disabled, in
  // which case fall back to the first enabled one so the group stays reachable.
  const selectedIdx = options.findIndex((o) => o.value === selected)
  const rovingIdx =
    selectedIdx >= 0 && !options[selectedIdx]?.disabled
      ? selectedIdx
      : edge(1)

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      {...props}
      onKeyDown={disabled ? undefined : handleKeyDown}
      className={cn(
        "inline-flex h-9 items-center gap-1 rounded-md bg-muted p-1 text-muted-foreground",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      {options.map((option, i) => {
        const isSelected = option.value === selected
        const isDisabled = disabled || option.disabled
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={isDisabled}
            tabIndex={!disabled && i === rovingIdx ? 0 : -1}
            onClick={() => select(option.value)}
            className={cn(
              "inline-flex h-7 items-center justify-center whitespace-nowrap rounded-sm px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
              isSelected
                ? "bg-background text-foreground shadow-sm"
                : "hover:text-foreground"
            )}
          >
            {option.label ?? option.value}
          </button>
        )
      })}
    </div>
  )
})
