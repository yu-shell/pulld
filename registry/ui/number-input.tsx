"use client"

import * as React from "react"
import { Minus, Plus } from "lucide-react"

import { cn } from "@/lib/utils"

interface NumberInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "type"> {
  /** Smallest allowed value; the − button stops here and it sets the input's min. */
  min?: number
  /** Largest allowed value; the + button stops here and it sets the input's max. */
  max?: number
  /** Amount added or removed per step (default 1). Decimal steps are supported. */
  step?: number
}

// Count a step's decimals so repeated 0.1-style nudges don't drift
// (0.1 + 0.2 -> 0.30000000000000004).
function decimalPlaces(n: number) {
  const s = String(n)
  const dot = s.indexOf(".")
  return dot === -1 ? 0 : s.length - dot - 1
}

// Write through the prototype's value setter so React's onChange fires for both
// controlled and uncontrolled inputs (mirrors the search-input pattern).
function setNativeValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event("input", { bubbles: true }))
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  function NumberInput(
    {
      className,
      min,
      max,
      step = 1,
      disabled,
      value,
      defaultValue,
      onChange,
      ...props
    },
    forwardedRef
  ) {
    const innerRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(
      forwardedRef,
      () => innerRef.current as HTMLInputElement
    )

    const isControlled = value !== undefined
    const [current, setCurrent] = React.useState(() =>
      String((isControlled ? value : defaultValue) ?? "")
    )

    // Keep the bound buttons in sync when the value is controlled.
    React.useEffect(() => {
      if (isControlled) setCurrent(String(value ?? ""))
    }, [isControlled, value])

    function nudge(direction: 1 | -1) {
      const input = innerRef.current
      if (!input || disabled) return
      const parsed = Number(current)
      const base = current !== "" && Number.isFinite(parsed) ? parsed : 0
      let next = base + direction * step
      if (min !== undefined && next < min) next = min
      if (max !== undefined && next > max) next = max
      const places = decimalPlaces(step)
      setNativeValue(input, places > 0 ? next.toFixed(places) : String(next))
      input.focus()
    }

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      setCurrent(e.target.value)
      onChange?.(e)
    }

    const numeric = current === "" ? null : Number(current)
    const valid = numeric !== null && Number.isFinite(numeric)
    const atMin = valid && min !== undefined && (numeric as number) <= min
    const atMax = valid && max !== undefined && (numeric as number) >= max

    // Only one of value/defaultValue ever reaches the input so React never warns
    // about switching between controlled and uncontrolled.
    const controlledProps = isControlled ? { value } : { defaultValue }

    return (
      <div
        className={cn(
          "inline-flex h-9 items-center rounded-md border border-input bg-transparent shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        <button
          type="button"
          onClick={() => nudge(-1)}
          disabled={disabled || atMin}
          aria-label="Decrease"
          tabIndex={-1}
          className="inline-flex h-full w-9 shrink-0 items-center justify-center rounded-l-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <input
          ref={innerRef}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={handleChange}
          className="h-full w-14 min-w-0 border-x border-input bg-transparent px-2 text-center text-sm tabular-nums outline-none [appearance:textfield] placeholder:text-muted-foreground disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          {...controlledProps}
          {...props}
        />
        <button
          type="button"
          onClick={() => nudge(1)}
          disabled={disabled || atMax}
          aria-label="Increase"
          tabIndex={-1}
          className="inline-flex h-full w-9 shrink-0 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    )
  }
)
