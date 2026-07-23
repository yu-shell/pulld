"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface BulkActionBarProps extends React.ComponentPropsWithoutRef<"div"> {
  /** How many rows/items are currently selected. The bar hides itself at 0. */
  count: number
  /** Singular noun for the selected things, e.g. "row", "file", "invoice". */
  itemName?: string
  /** Plural noun. Defaults to `itemName` + "s"; set it for irregular plurals. */
  itemNamePlural?: string
  /** Clears the selection. Also wired to Escape and the trailing button. */
  onClear?: () => void
  /** Label of the clear button. */
  clearLabel?: string
  /** `floating` pins the bar above the page bottom; `inline` sits in the flow. */
  variant?: "floating" | "inline"
  /** Accessible name of the bar's landmark region. */
  label?: string
}

/**
 * The action bar that appears once rows are selected in a table or list: it
 * shows how many are selected, hosts the bulk actions (delete, export, assign)
 * as children, and offers a way back out of selection mode.
 *
 * The count is announced to screen readers from a live region that stays
 * mounted even at 0 — a live region inserted together with its text is not
 * reliably announced, so hiding the whole bar would swallow the first update.
 *
 * It is a labelled `region` rather than a `toolbar`: an ARIA toolbar is
 * expected to implement roving-tabindex arrow navigation, and claiming the role
 * without it reads worse to assistive tech than plain tab order.
 */
export function BulkActionBar({
  count,
  itemName = "item",
  itemNamePlural,
  onClear,
  clearLabel = "Clear",
  variant = "floating",
  label = "Bulk actions",
  className,
  children,
  ...props
}: BulkActionBarProps) {
  const noun = count === 1 ? itemName : (itemNamePlural ?? `${itemName}s`)
  const summary = `${count} ${noun} selected`

  React.useEffect(() => {
    const clear = onClear
    if (count <= 0 || !clear) return
    const onKeyDown = (event: KeyboardEvent) => {
      // Skip handled presses so Escape can still close a dialog or dismiss a
      // combobox opened from one of the actions without wiping the selection.
      if (event.key !== "Escape" || event.defaultPrevented) return
      clear()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [count, onClear])

  return (
    <>
      <span aria-live="polite" className="sr-only">
        {count > 0 ? summary : ""}
      </span>
      {count > 0 ? (
        <div
          role="region"
          aria-label={label}
          className={cn(
            "flex items-center gap-3 border bg-background text-foreground",
            variant === "floating"
              ? "fixed inset-x-0 bottom-6 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-lg px-3 py-2 shadow-lg"
              : "w-full rounded-md px-3 py-2",
            className
          )}
          {...props}
        >
          <span aria-hidden="true" className="text-sm font-medium tabular-nums">
            {summary}
          </span>
          <div className="flex flex-wrap items-center gap-2">{children}</div>
          {onClear ? (
            <button
              type="button"
              onClick={onClear}
              className="ml-auto inline-flex h-8 shrink-0 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {clearLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}
