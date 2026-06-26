"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface OtpInputProps {
  /** Number of single-character slots (default 6). */
  length?: number
  /** Controlled value; non-digits are ignored and it is truncated to `length`. */
  value?: string
  /** Initial value when uncontrolled. */
  defaultValue?: string
  /** Fires with the full joined string on every change. */
  onChange?: (value: string) => void
  /** Fires once when the last empty slot is filled (e.g. auto-submit the code). */
  onComplete?: (value: string) => void
  /** Disable every slot. */
  disabled?: boolean
  /** Focus the first slot on mount. */
  autoFocus?: boolean
  /** Accessible label for the slot group (default "Verification code"). */
  "aria-label"?: string
  /** When set, a hidden input mirrors the value so it submits with a native form. */
  name?: string
  className?: string
}

// Keep only digits, cap to `length`, and pad to a fixed-length array so every
// render maps one slot to one input.
function toSlots(value: string | undefined, length: number) {
  const digits = (value ?? "").replace(/\D/g, "").slice(0, length).split("")
  return Array.from({ length }, (_, i) => digits[i] ?? "")
}

export const OtpInput = React.forwardRef<HTMLInputElement, OtpInputProps>(
  function OtpInput(
    {
      length = 6,
      value,
      defaultValue,
      onChange,
      onComplete,
      disabled,
      autoFocus,
      name,
      className,
      "aria-label": ariaLabel = "Verification code",
    },
    forwardedRef
  ) {
    const isControlled = value !== undefined
    const inputsRef = React.useRef<Array<HTMLInputElement | null>>([])
    const [slots, setSlots] = React.useState(() =>
      toSlots(isControlled ? value : defaultValue, length)
    )

    // Forward the first slot so callers can focus the field from a shortcut.
    React.useImperativeHandle(
      forwardedRef,
      () => inputsRef.current[0] as HTMLInputElement
    )

    // Re-sync from the prop when controlled (mirrors number-input).
    React.useEffect(() => {
      if (isControlled) setSlots(toSlots(value, length))
    }, [isControlled, value, length])

    React.useEffect(() => {
      if (autoFocus) inputsRef.current[0]?.focus()
    }, [autoFocus])

    function focusSlot(index: number) {
      const el = inputsRef.current[Math.max(0, Math.min(index, length - 1))]
      el?.focus()
      el?.select()
    }

    // Single commit path: update state when uncontrolled (controlled state
    // flows back through the prop), fire onChange, and fire onComplete only on
    // the transition into a fully filled code.
    function commit(next: string[]) {
      const wasFull = slots.every((s) => s !== "")
      if (!isControlled) setSlots(next)
      const joined = next.join("")
      onChange?.(joined)
      if (!wasFull && next.every((s) => s !== "")) onComplete?.(joined)
    }

    // Spread a multi-digit string across slots starting at `index` (paste and
    // OS one-time-code autofill).
    function fillFrom(index: number, digits: string) {
      const chars = digits.replace(/\D/g, "").split("")
      if (chars.length === 0) return
      const next = [...slots]
      let i = index
      for (const c of chars) {
        if (i >= length) break
        next[i] = c
        i++
      }
      commit(next)
      focusSlot(Math.min(i, length - 1))
    }

    function handleChange(
      index: number,
      e: React.ChangeEvent<HTMLInputElement>
    ) {
      const raw = e.target.value.replace(/\D/g, "")
      if (raw === "") {
        const next = [...slots]
        next[index] = ""
        commit(next)
        return
      }
      // When a slot already holds a digit, the change value is "old+new"; drop
      // the kept prefix so we read just the freshly typed character.
      const prev = slots[index]
      let incoming = raw
      if (prev && incoming.startsWith(prev)) incoming = incoming.slice(prev.length)
      if (incoming === "") return
      if (incoming.length > 1) {
        fillFrom(index, incoming)
        return
      }
      const next = [...slots]
      next[index] = incoming
      commit(next)
      if (index < length - 1) focusSlot(index + 1)
    }

    function handleKeyDown(
      index: number,
      e: React.KeyboardEvent<HTMLInputElement>
    ) {
      switch (e.key) {
        case "Backspace": {
          e.preventDefault()
          const next = [...slots]
          if (next[index] !== "") {
            next[index] = ""
            commit(next)
          } else if (index > 0) {
            next[index - 1] = ""
            commit(next)
            focusSlot(index - 1)
          }
          break
        }
        case "Delete": {
          e.preventDefault()
          const next = [...slots]
          next[index] = ""
          commit(next)
          break
        }
        case "ArrowLeft":
          e.preventDefault()
          focusSlot(index - 1)
          break
        case "ArrowRight":
          e.preventDefault()
          focusSlot(index + 1)
          break
        case "Home":
          e.preventDefault()
          focusSlot(0)
          break
        case "End":
          e.preventDefault()
          focusSlot(length - 1)
          break
      }
    }

    function handlePaste(
      index: number,
      e: React.ClipboardEvent<HTMLInputElement>
    ) {
      e.preventDefault()
      fillFrom(index, e.clipboardData.getData("text"))
    }

    const joined = slots.join("")

    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className={cn("inline-flex items-center gap-2", className)}
      >
        {slots.map((digit, i) => (
          <input
            key={i}
            ref={(el) => {
              inputsRef.current[i] = el
            }}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            disabled={disabled}
            value={digit}
            aria-label={`Digit ${i + 1} of ${length}`}
            onChange={(e) => handleChange(i, e)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            onPaste={(e) => handlePaste(i, e)}
            onFocus={(e) => e.target.select()}
            className={cn(
              "h-10 w-10 rounded-md border border-input bg-transparent text-center text-sm font-medium tabular-nums shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
        ))}
        {name ? <input type="hidden" name={name} value={joined} /> : null}
      </div>
    )
  }
)
