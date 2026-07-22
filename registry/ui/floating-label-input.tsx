"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface FloatingLabelInputProps
  extends Omit<React.ComponentPropsWithoutRef<"input">, "placeholder"> {
  /**
   * The label text. It sits inside the field like a placeholder while the
   * input is empty and unfocused, then shrinks and floats up onto the top
   * border once the field is focused or has a value. It doubles as the
   * accessible `<label>` (associated via `htmlFor`), so a separate label is
   * not needed.
   */
  label: string
  /** Marks the field invalid: destructive border/ring/label and `aria-invalid`. */
  error?: boolean
  /** Class for the wrapping element (the input itself takes `className`). */
  containerClassName?: string
}

/**
 * A text input whose label animates from a resting placeholder position into a
 * floating label on the field's top border when the input is focused or filled
 * (the Material "outlined" pattern). shadcn/ui ships no floating-label field —
 * this packages one that stays a real, accessible input.
 *
 * The float is driven purely by CSS `:placeholder-shown`/`:focus` on the peer
 * input (no JS state), so it works for controlled or uncontrolled inputs, for
 * autofill, and before hydration. The label is a genuine `<label htmlFor>`; the
 * `id` defaults to a stable `React.useId()` value so the association always
 * holds. The ref is forwarded to the underlying `<input>`, and every native
 * input prop (`type`, `name`, `value`/`onChange`, `disabled`, `required`,
 * `autoComplete`, …) works unchanged. Styled with shadcn tokens for automatic
 * light/dark theming; zero dependencies beyond your `cn` util.
 */
export const FloatingLabelInput = React.forwardRef<
  HTMLInputElement,
  FloatingLabelInputProps
>(function FloatingLabelInput(
  { label, error = false, id, className, containerClassName, disabled, ...props },
  ref
) {
  const generatedId = React.useId()
  const inputId = id ?? generatedId

  return (
    <div className={cn("relative", containerClassName)}>
      <input
        id={inputId}
        ref={ref}
        // A non-empty placeholder is required for `:placeholder-shown` to
        // track emptiness; the space is invisible and the label stands in for it.
        placeholder=" "
        disabled={disabled}
        aria-invalid={error || undefined}
        className={cn(
          "peer h-11 w-full rounded-md border bg-transparent px-3 text-sm text-foreground shadow-sm transition-colors placeholder:text-transparent focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
          error
            ? "border-destructive focus-visible:border-destructive focus-visible:ring-destructive/40"
            : "border-input focus-visible:border-ring focus-visible:ring-ring",
          className
        )}
        {...props}
      />
      <label
        htmlFor={inputId}
        className={cn(
          // Resting state: centered like a placeholder.
          "pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 bg-background px-1 text-sm text-muted-foreground transition-all",
          // Floated state (focused OR has a value): small, on the top border.
          "peer-focus:top-0 peer-focus:-translate-y-1/2 peer-focus:text-xs peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:-translate-y-1/2 peer-[:not(:placeholder-shown)]:text-xs",
          error
            ? "peer-focus:text-destructive"
            : "peer-focus:text-foreground",
          "peer-disabled:opacity-50"
        )}
      >
        {label}
      </label>
    </div>
  )
})
