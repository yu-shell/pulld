"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// Each step is "how many of me make one of the next unit up".
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
]

interface TimeAgoProps
  extends Omit<
    React.ComponentPropsWithoutRef<"time">,
    "dateTime" | "children"
  > {
  /** The moment to describe. Accepts a Date, an ISO string, or epoch milliseconds. */
  date: Date | string | number
  /** Show justNowLabel for anything more recent than this many seconds (default 45). Set 0 to always show seconds. */
  justNowThreshold?: number
  /** Text shown inside the justNowThreshold window (default "just now"). */
  justNowLabel?: string
  /** Force a fixed re-render cadence in ms. By default it adapts: every 15s while under a minute old, every minute under an hour, then hourly. */
  updateInterval?: number
  /** BCP-47 locale(s) for the wording (default: the runtime locale). */
  locale?: Intl.LocalesArgument
  /** Passed to Intl.RelativeTimeFormat — numeric "auto" says "yesterday" instead of "1 day ago". Default "always". */
  numeric?: Intl.RelativeTimeFormatNumeric
  /** "long" (3 minutes ago), "short" (3 min. ago), or "narrow" (3m ago). Default "long". */
  format?: Intl.RelativeTimeFormatStyle
  /** Override the hover tooltip. Defaults to the full localized date and time. */
  title?: string
}

function relativeLabel(
  targetMs: number,
  nowMs: number,
  rtf: Intl.RelativeTimeFormat
) {
  // Negative while the target is in the past, so Intl says "3 minutes ago";
  // positive gives "in 3 minutes".
  let duration = (targetMs - nowMs) / 1000
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit)
    }
    duration /= division.amount
  }
  return rtf.format(Math.round(duration), "year")
}

/**
 * Auto-updating relative timestamp — "3 minutes ago", "in 2 days" — rendered in
 * a semantic <time> element. shadcn/ui ships no time-ago component.
 */
export const TimeAgo = React.forwardRef<HTMLTimeElement, TimeAgoProps>(
  function TimeAgo(
    {
      className,
      date,
      justNowThreshold = 45,
      justNowLabel = "just now",
      updateInterval,
      locale,
      numeric = "always",
      format = "long",
      title,
      ...props
    },
    ref
  ) {
    const target = React.useMemo(() => new Date(date), [date])
    const targetMs = target.getTime()
    const valid = !Number.isNaN(targetMs)

    // Re-render on a timer so the label stays fresh. It starts null so the
    // markup is stable; a fresh Date.now() fills in below (see the note on
    // suppressHydrationWarning) and the effect keeps it ticking after mount.
    const [now, setNow] = React.useState<number | null>(null)

    React.useEffect(() => {
      if (!valid) return
      let timer: ReturnType<typeof setTimeout>
      function tick() {
        const current = Date.now()
        setNow(current)
        const elapsed = Math.abs(current - targetMs)
        const delay =
          updateInterval ??
          (elapsed < 60_000
            ? 15_000
            : elapsed < 3_600_000
              ? 60_000
              : 3_600_000)
        timer = setTimeout(tick, delay)
      }
      tick()
      return () => clearTimeout(timer)
    }, [targetMs, valid, updateInterval])

    const rtf = React.useMemo(
      () => new Intl.RelativeTimeFormat(locale, { numeric, style: format }),
      [locale, numeric, format]
    )

    const label = React.useMemo(() => {
      if (!valid) return ""
      // Fall back to a render-time clock before mount; server and client can
      // land a few seconds apart, which suppressHydrationWarning absorbs.
      const reference = now ?? Date.now()
      if (
        justNowThreshold > 0 &&
        Math.abs(targetMs - reference) < justNowThreshold * 1000
      ) {
        return justNowLabel
      }
      return relativeLabel(targetMs, reference, rtf)
    }, [valid, now, targetMs, justNowThreshold, justNowLabel, rtf])

    if (!valid) return null

    const fullTitle =
      title ??
      new Intl.DateTimeFormat(locale, {
        dateStyle: "full",
        timeStyle: "short",
      }).format(target)

    return (
      <time
        ref={ref}
        dateTime={target.toISOString()}
        title={fullTitle}
        suppressHydrationWarning
        className={cn("text-muted-foreground", className)}
        {...props}
      >
        {label}
      </time>
    )
  }
)
