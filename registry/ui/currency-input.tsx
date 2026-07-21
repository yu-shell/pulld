"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface CurrencyInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "type"
  > {
  /** Controlled amount in major units (1234.5 → "$1,234.50"). `null` clears it. */
  value?: number | null
  /** Initial amount for uncontrolled use. */
  defaultValue?: number | null
  /** Fires with the parsed number as the user types and on blur; `null` when empty. */
  onValueChange?: (value: number | null) => void
  /** ISO 4217 currency code driving the symbol and decimal places (default "USD"). */
  currency?: string
  /** BCP 47 locale driving grouping and symbol placement (default "en-US"). */
  locale?: string
  /** Allow negative amounts (default false). */
  allowNegative?: boolean
}

export const CurrencyInput = React.forwardRef<
  HTMLInputElement,
  CurrencyInputProps
>(function CurrencyInput(
  {
    className,
    value,
    defaultValue,
    onValueChange,
    currency = "USD",
    locale = "en-US",
    allowNegative = false,
    disabled,
    onFocus,
    onBlur,
    ...props
  },
  forwardedRef
) {
  const innerRef = React.useRef<HTMLInputElement>(null)
  React.useImperativeHandle(
    forwardedRef,
    () => innerRef.current as HTMLInputElement
  )

  const formatter = React.useMemo(
    () => new Intl.NumberFormat(locale, { style: "currency", currency }),
    [locale, currency]
  )
  // Decimals this currency uses (USD → 2, JPY → 0), used to round on blur.
  const fractionDigits = React.useMemo(
    () => formatter.resolvedOptions().maximumFractionDigits ?? 2,
    [formatter]
  )

  const isControlled = value !== undefined
  const [internal, setInternal] = React.useState<number | null>(
    () => defaultValue ?? null
  )
  const numericValue = isControlled ? value ?? null : internal

  const [focused, setFocused] = React.useState(false)
  const [editing, setEditing] = React.useState("")

  // Keep only digits, a single decimal point, and an optional leading minus so
  // the raw editing string is always a parseable number-in-progress.
  function sanitize(raw: string) {
    let out = ""
    let seenDot = false
    for (const ch of raw) {
      if (ch >= "0" && ch <= "9") out += ch
      else if (ch === "." && !seenDot) {
        out += "."
        seenDot = true
      } else if (ch === "-" && allowNegative && out === "") out += "-"
    }
    return out
  }

  // "" / "-" / "." / "-." are in-progress, not a number yet → null.
  function parse(str: string): number | null {
    if (str === "" || str === "-" || str === "." || str === "-.") return null
    const n = Number(str)
    return Number.isFinite(n) ? n : null
  }

  // Round to the currency's precision and drop float noise (0.1+0.2) before it
  // seeds the raw editing string.
  function toEditString(n: number) {
    const factor = 10 ** fractionDigits
    return String(Math.round(n * factor) / factor)
  }

  // Show the grouped, symbol-prefixed amount when idle and the raw number while
  // editing, so the cursor never fights the separators.
  const display = focused
    ? editing
    : numericValue === null
      ? ""
      : formatter.format(numericValue)

  function handleFocus(e: React.FocusEvent<HTMLInputElement>) {
    setFocused(true)
    setEditing(numericValue === null ? "" : toEditString(numericValue))
    onFocus?.(e)
    // Select the whole amount so the next keystroke replaces it, as money
    // fields usually do.
    requestAnimationFrame(() => innerRef.current?.select())
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = sanitize(e.target.value)
    setEditing(next)
    const parsed = parse(next)
    if (!isControlled) setInternal(parsed)
    onValueChange?.(parsed)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    setFocused(false)
    const typed = parse(editing)
    let committed = typed
    if (committed !== null) {
      const factor = 10 ** fractionDigits
      committed = Math.round(committed * factor) / factor
    }
    if (!isControlled) setInternal(committed)
    // Re-emit only when rounding actually changed the value the parent last saw.
    if (committed !== typed) onValueChange?.(committed)
    onBlur?.(e)
  }

  return (
    <input
      ref={innerRef}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      disabled={disabled}
      value={display}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={cn(
        "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm tabular-nums shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
})
