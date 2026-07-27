"use client"

import * as React from "react"
import { Check, CircleAlert, File as FileIcon, RotateCw, X } from "lucide-react"

import { cn } from "@/lib/utils"

/** One row of the queue. `id` is what removals, retries and announcements key off. */
export interface UploadItem {
  id: string
  /** File name shown in the row. Long names are truncated with a title tooltip. */
  name: string
  /** Size in bytes. Omit it when you don't know it and the row just hides the size. */
  size?: number
  status: "pending" | "uploading" | "done" | "error"
  /** Percentage 0–100 while uploading. Omit it for an indeterminate bar. */
  progress?: number
  /** Failure reason shown in place of the meta line, e.g. "File is too large". */
  error?: string
}

interface UploadListProps extends React.ComponentPropsWithoutRef<"div"> {
  /** The queue. Render it straight from your own upload state — an empty list renders nothing. */
  items: UploadItem[]
  /** Shows a remove button on every row. Omit it and no button is rendered. */
  onRemove?: (item: UploadItem) => void
  /** Shows a retry button on failed rows. Omit it and no button is rendered. */
  onRetry?: (item: UploadItem) => void
  /** Text for a queued row that hasn't started. */
  pendingLabel?: string
  /** Text for a finished row. */
  doneLabel?: string
  /** Fallback text for a failed row with no `error` message. */
  errorLabel?: string
  /** Accessible name of the retry button (the file name is appended). */
  retryLabel?: string
  /** Accessible name of the remove button (the file name is appended). */
  removeLabel?: string
}

const UNITS = ["B", "KB", "MB", "GB", "TB"]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return ""
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

function clampPct(n: number) {
  return Math.min(100, Math.max(0, Math.round(n)))
}

/**
 * The list of files under a dropzone or file picker: one row each with its
 * name, size, upload progress, and a way to remove it or retry a failure.
 *
 * It is a presentation component on purpose — it never uploads anything. You
 * own the requests (and therefore the cancellation, concurrency and retry
 * policy) and hand it the current queue; a component that owned the transfer
 * would have to guess your endpoint, auth and progress source.
 *
 * Accessibility notes, since this is where a queue usually goes wrong:
 *
 * - Progress lives in a `role="progressbar"`, which is *not* a live region, so
 *   a file crawling from 1% to 100% doesn't narrate every tick.
 * - Terminal transitions are what a user actually needs to hear, so the
 *   always-mounted `role="status"` region announces only rows that just landed
 *   on done or error — batched into one message per change, never per percent.
 * - The first render is treated as the starting state rather than a set of
 *   transitions; a list that mounts with finished rows stays quiet.
 * - Row buttons carry the file name in their accessible name, because a column
 *   of buttons all called "Remove" is unusable out of visual context.
 */
export function UploadList({
  items,
  onRemove,
  onRetry,
  pendingLabel = "Waiting",
  doneLabel = "Uploaded",
  errorLabel = "Upload failed",
  retryLabel = "Retry",
  removeLabel = "Remove",
  className,
  ...props
}: UploadListProps) {
  const [announce, setAnnounce] = React.useState("")
  const seen = React.useRef(new Map<string, UploadItem["status"]>())
  const mounted = React.useRef(false)

  React.useEffect(() => {
    const before = seen.current
    seen.current = new Map(items.map((item) => [item.id, item.status]))
    if (!mounted.current) {
      mounted.current = true
      return
    }

    const done: string[] = []
    const failed: string[] = []
    for (const item of items) {
      if (before.get(item.id) === item.status) continue
      if (item.status === "done") done.push(item.name)
      else if (item.status === "error") failed.push(item.name)
    }
    if (!done.length && !failed.length) return

    const parts: string[] = []
    if (done.length) {
      parts.push(
        done.length === 1 ? `${done[0]} uploaded` : `${done.length} files uploaded`
      )
    }
    if (failed.length) {
      parts.push(
        failed.length === 1
          ? `${failed[0]} failed to upload`
          : `${failed.length} files failed to upload`
      )
    }
    setAnnounce(parts.join(", "))
  }, [items])

  if (!items.length) return null

  return (
    <div className={cn("w-full", className)} {...props}>
      <ul className="divide-y rounded-lg border">
        {items.map((item) => {
          const indeterminate = item.progress === undefined
          const pct = item.progress === undefined ? 0 : clampPct(item.progress)
          const size = item.size === undefined ? "" : formatBytes(item.size)
          const meta =
            item.status === "error"
              ? item.error || errorLabel
              : item.status === "done"
                ? doneLabel
                : item.status === "pending"
                  ? pendingLabel
                  : indeterminate
                    ? null
                    : `${pct}%`

          return (
            <li key={item.id} className="flex items-start gap-3 px-3 py-2.5">
              {item.status === "done" ? (
                <Check
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : item.status === "error" ? (
                <CircleAlert
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
              ) : (
                <FileIcon
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground" title={item.name}>
                  {item.name}
                </div>
                <div
                  className={cn(
                    "mt-0.5 flex items-center gap-1.5 text-xs",
                    item.status === "error"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {size ? <span className="tabular-nums">{size}</span> : null}
                  {size && meta ? <span aria-hidden="true">·</span> : null}
                  {meta ? <span className="tabular-nums">{meta}</span> : null}
                </div>

                {item.status === "uploading" ? (
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={indeterminate ? undefined : pct}
                    aria-label={`Uploading ${item.name}`}
                    className="mt-2 h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20"
                  >
                    <div
                      className={cn(
                        "h-full rounded-full bg-primary",
                        indeterminate
                          ? // No total to fill toward, so a pulsing partial bar
                            // reads as work-in-progress without a custom keyframe.
                            "w-1/3 animate-pulse"
                          : "transition-[width] duration-300 ease-out"
                      )}
                      style={indeterminate ? undefined : { width: `${pct}%` }}
                    />
                  </div>
                ) : null}
              </div>

              <div className="flex shrink-0 items-center gap-1">
                {item.status === "error" && onRetry ? (
                  <button
                    type="button"
                    onClick={() => onRetry(item)}
                    aria-label={`${retryLabel} ${item.name}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <RotateCw className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    onClick={() => onRemove(item)}
                    aria-label={`${removeLabel} ${item.name}`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      <span role="status" className="sr-only">
        {announce}
      </span>
    </div>
  )
}
