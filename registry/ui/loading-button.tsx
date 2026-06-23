import * as React from "react"

import { cn } from "@/lib/utils"
import { Spinner } from "@/registry/ui/spinner"

interface LoadingButtonProps extends React.ComponentPropsWithoutRef<"button"> {
  /** When true, shows a spinner and disables the button. */
  loading?: boolean
  /** Optional label shown in place of children while loading. */
  loadingText?: string
}

export function LoadingButton({
  loading = false,
  loadingText,
  children,
  disabled,
  className,
  ...props
}: LoadingButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      {loading ? <Spinner className="text-current" label={loadingText ?? "Loading"} /> : null}
      {loading && loadingText ? loadingText : children}
    </button>
  )
}
