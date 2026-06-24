"use client"

import * as React from "react"
import { Search, X } from "lucide-react"

import { cn } from "@/lib/utils"

interface SearchInputProps extends React.ComponentPropsWithoutRef<"input"> {
  /** Called after the clear (✕) button empties the field. */
  onClear?: () => void
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(
    { className, onClear, onChange, value, defaultValue, disabled, ...props },
    forwardedRef
  ) {
    const innerRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(
      forwardedRef,
      () => innerRef.current as HTMLInputElement
    )

    const isControlled = value !== undefined
    const [hasValue, setHasValue] = React.useState(
      () => String((isControlled ? value : defaultValue) ?? "").length > 0
    )

    // Keep the clear button's visibility in sync when the value is controlled.
    React.useEffect(() => {
      if (isControlled) setHasValue(String(value ?? "").length > 0)
    }, [isControlled, value])

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      setHasValue(e.target.value.length > 0)
      onChange?.(e)
    }

    function handleClear() {
      const input = innerRef.current
      if (input) {
        // Use the prototype's value setter so React's onChange fires for both
        // controlled and uncontrolled inputs (lets list/table filtering update),
        // then refocus so the user can keep typing.
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value"
        )?.set
        setter?.call(input, "")
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.focus()
      }
      setHasValue(false)
      onClear?.()
    }

    // Only one of value/defaultValue is ever passed to the input so React never
    // warns about switching between controlled and uncontrolled.
    const controlledProps = isControlled ? { value } : { defaultValue }

    return (
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          ref={innerRef}
          type="search"
          disabled={disabled}
          onChange={handleChange}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent py-1 pl-8 pr-9 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-search-cancel-button]:appearance-none",
            className
          )}
          {...controlledProps}
          {...props}
        />
        {hasValue && !disabled ? (
          <button
            type="button"
            onClick={handleClear}
            aria-label="Clear search"
            tabIndex={-1}
            className="absolute right-1 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    )
  }
)
