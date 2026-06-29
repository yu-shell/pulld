"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { CopyButton } from "@/registry/ui/copy-button"

interface CopyFieldProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "readOnly" | "type"
  > {
  /** The value shown in the read-only field and copied to the clipboard. */
  value: string
  /** Accessible label for the field. Defaults to "Copyable value". */
  label?: string
  /** How long (ms) the copy button stays in its "copied" state. */
  timeout?: number
}

/**
 * Read-only field that displays a value with a copy button docked at its right
 * edge. Focusing or clicking the field selects the whole value so it can also
 * be copied manually. Use it for API keys, invite/share links, IDs, webhook
 * URLs, or any value a user reads once and copies. Composes copy-button.
 */
export const CopyField = React.forwardRef<HTMLInputElement, CopyFieldProps>(
  function CopyField(
    { value, label = "Copyable value", timeout, className, onFocus, onClick, ...props },
    ref
  ) {
    function selectAll(
      event:
        | React.FocusEvent<HTMLInputElement>
        | React.MouseEvent<HTMLInputElement>
    ) {
      event.currentTarget.select()
    }

    return (
      <div className="relative">
        <input
          ref={ref}
          type="text"
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => {
            selectAll(event)
            onFocus?.(event)
          }}
          onClick={(event) => {
            selectAll(event)
            onClick?.(event)
          }}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent py-1 pl-3 pr-10 font-mono text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            className
          )}
          {...props}
        />
        <CopyButton
          value={value}
          timeout={timeout}
          className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 border-0"
        />
      </div>
    )
  }
)
