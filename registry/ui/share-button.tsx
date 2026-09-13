"use client"

import * as React from "react"
import { Check, Share2 } from "lucide-react"

import { cn } from "@/lib/utils"

/** What actually happened when the button was pressed. */
type ShareOutcome = "shared" | "copied" | "cancelled" | "failed"

interface ShareButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children"> {
  /** The URL to share. Defaults to the current page URL, read when pressed. */
  url?: string
  /** Title passed to the share sheet. The native `title` attribute is untouched. */
  shareTitle?: string
  /** Body text passed to the share sheet, shown by some targets beside the URL. */
  shareText?: string
  /** Label shown while the button is at rest. */
  children?: React.ReactNode
  /** How long (ms) the result state stays before resetting. */
  timeout?: number
  /** Called with the outcome, after the share sheet closes or the copy resolves. */
  onShare?: (outcome: ShareOutcome) => void
}

export function ShareButton({
  url,
  shareTitle,
  shareText,
  children = "Share",
  timeout = 2000,
  onShare,
  onClick,
  className,
  ...props
}: ShareButtonProps) {
  const [status, setStatus] = React.useState<"idle" | ShareOutcome>("idle")

  React.useEffect(() => {
    if (status === "idle") return
    const id = window.setTimeout(() => setStatus("idle"), timeout)
    return () => window.clearTimeout(id)
  }, [status, timeout])

  async function copy(href: string) {
    try {
      await navigator.clipboard.writeText(href)
      setStatus("copied")
      onShare?.("copied")
    } catch {
      setStatus("failed")
      onShare?.("failed")
    }
  }

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return

    const href = url ?? window.location.href
    const data: ShareData = { url: href }
    if (shareTitle) data.title = shareTitle
    if (shareText) data.text = shareText

    // Called with no `await` ahead of it: `navigator.share` only resolves while
    // the click is still the active user gesture, so anything awaited first
    // (building the URL, hitting an API) makes it reject with NotAllowedError.
    if (
      typeof navigator.share === "function" &&
      (typeof navigator.canShare !== "function" || navigator.canShare(data))
    ) {
      navigator.share(data).then(
        () => {
          setStatus("shared")
          onShare?.("shared")
        },
        (error: unknown) => {
          // Dismissing the sheet rejects with AbortError. That is not a failure
          // and must not show one: the user closed it on purpose.
          if (error instanceof Error && error.name === "AbortError") {
            onShare?.("cancelled")
            return
          }
          void copy(href)
        }
      )
      return
    }

    void copy(href)
  }

  const message =
    status === "shared"
      ? "Shared"
      : status === "copied"
        ? "Link copied"
        : status === "failed"
          ? "Could not share"
          : null

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      {/* The icon never depends on feature detection, so the server and the
          first client render agree and nothing has to hydrate twice. */}
      {status === "shared" || status === "copied" ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Share2 className="h-4 w-4" aria-hidden="true" />
      )}
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
      <span aria-hidden={message ? true : undefined}>{message ?? children}</span>
    </button>
  )
}
