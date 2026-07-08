"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

const STORAGE_PREFIX = "pulld-announcement:"

interface AnnouncementBarProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "id"> {
  /**
   * Stable id for this announcement. The dismissed state is remembered per id
   * in localStorage, so once a user closes the bar it stays closed on reload.
   * Change the id — or bump `version` — when the message changes to show it again.
   */
  id: string
  /**
   * Bump this when the announcement's content changes so previously-dismissed
   * users see the new message. Any change to the value re-shows the bar.
   */
  version?: string | number
  /** `primary` is a solid accent bar; `default` is a subtle muted bar with a bottom border. */
  variant?: "default" | "primary"
  /** Optional leading icon (decorative; rendered aria-hidden). */
  icon?: React.ReactNode
  /** Optional trailing call-to-action, usually a link or button. */
  action?: React.ReactNode
  /** Set false for a permanent banner (e.g. maintenance) with no close button. */
  dismissible?: boolean
  /** Accessible label for the landmark region. */
  label?: string
  /** Called after the user dismisses the bar. */
  onDismiss?: () => void
}

/**
 * A dismissible top-of-page announcement / notice bar. Persists its dismissed
 * state to localStorage per `id`, so it does not reappear once closed until the
 * `id` or `version` changes. Renders nothing until mounted so server and first
 * client render agree (localStorage is unavailable on the server) — the bar pops
 * in for first-time visitors but never flashes for users who already closed it.
 */
export function AnnouncementBar({
  id,
  version,
  variant = "default",
  icon,
  action,
  dismissible = true,
  label = "Announcement",
  onDismiss,
  className,
  children,
  ...props
}: AnnouncementBarProps) {
  const storageKey = STORAGE_PREFIX + id
  const token = version == null ? "1" : String(version)

  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    if (!dismissible) {
      setVisible(true)
      return
    }
    let dismissed = false
    try {
      dismissed = window.localStorage.getItem(storageKey) === token
    } catch {
      // localStorage can throw (private mode, blocked storage) — show the bar.
    }
    setVisible(!dismissed)
  }, [storageKey, token, dismissible])

  function handleDismiss() {
    setVisible(false)
    try {
      window.localStorage.setItem(storageKey, token)
    } catch {
      // Ignore write failures; the bar simply reappears on the next load.
    }
    onDismiss?.()
  }

  if (!visible) return null

  return (
    <div
      id={id}
      role="region"
      aria-label={label}
      className={cn(
        "flex items-center gap-3 px-4 py-2.5 text-sm",
        variant === "primary"
          ? "bg-primary text-primary-foreground"
          : "border-b bg-muted text-foreground",
        className
      )}
      {...props}
    >
      {icon ? (
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0">{children}</span>
        {action ? <span className="shrink-0 font-medium">{action}</span> : null}
      </div>
      {dismissible ? (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss announcement"
          className={cn(
            "-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2",
            variant === "primary"
              ? "text-primary-foreground/80 hover:bg-primary-foreground/10 hover:text-primary-foreground focus-visible:ring-primary-foreground"
              : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:ring-ring"
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
