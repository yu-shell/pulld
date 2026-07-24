"use client"

import * as React from "react"
import { Check, CircleAlert, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"
import { TimeAgo } from "@/registry/ui/time-ago"

interface SaveStatusProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Where the background save currently stands. `idle` renders nothing visible. */
  status: "idle" | "saving" | "saved" | "error"
  /** When the last successful save landed. Shown as a live "2 minutes ago" next to "Saved". */
  savedAt?: Date | string | number
  /** Shows a Retry button in the error state. Omit it and no button is rendered. */
  onRetry?: () => void
  /** Text for the in-flight state. */
  savingLabel?: string
  /** Text once the save has landed. */
  savedLabel?: string
  /** Text when the save failed. */
  errorLabel?: string
  /** Label of the retry button. */
  retryLabel?: string
}

/**
 * The small inline "Saving… / Saved 2 minutes ago / Couldn't save" indicator
 * that sits beside an autosaving editor, form, or settings panel.
 *
 * The status text lives in its own always-mounted `role="status"` region, so
 * the first transition is announced (a live region inserted together with its
 * text is not reliably read out) and only the state wording is announced.
 *
 * The timestamp deliberately sits *outside* that region: it re-renders on a
 * timer, and inside a live region that would spontaneously announce "Saved 3
 * minutes ago" every minute with nothing having happened. Same for the Retry
 * button, whose label would otherwise be read on every status change.
 *
 * The region stays `polite` even for failures. `aria-live` is read when the
 * region is registered, so flipping it to `assertive` on error is unreliable —
 * and a failed autosave should not interrupt someone mid-sentence; it stays on
 * screen until it is resolved.
 */
export function SaveStatus({
  status,
  savedAt,
  onRetry,
  savingLabel = "Saving…",
  savedLabel = "Saved",
  errorLabel = "Couldn't save",
  retryLabel = "Retry",
  className,
  ...props
}: SaveStatusProps) {
  const label =
    status === "saving"
      ? savingLabel
      : status === "saved"
        ? savedLabel
        : status === "error"
          ? errorLabel
          : ""

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-sm",
        status === "error" ? "text-destructive" : "text-muted-foreground",
        className
      )}
      {...props}
    >
      <span role="status" className="inline-flex items-center gap-1.5">
        {status === "saving" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : null}
        {status === "saved" ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : null}
        {status === "error" ? (
          <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
        ) : null}
        {label}
      </span>
      {status === "saved" && savedAt !== undefined ? (
        <TimeAgo date={savedAt} className="text-inherit" />
      ) : null}
      {status === "error" && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  )
}
