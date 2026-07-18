"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** The remaining time, already broken into whole units. `total` is milliseconds left (clamped at 0). */
export interface CountdownParts {
  days: number
  hours: number
  minutes: number
  seconds: number
  /** Milliseconds remaining, never negative. */
  total: number
  /** True once the target time has been reached. */
  isComplete: boolean
}

interface CountdownProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The moment to count down to. Accepts a Date, an ISO string, or epoch milliseconds. */
  to: Date | string | number
  /** Fired once, when the timer reaches zero. */
  onComplete?: () => void
  /** Tick cadence in ms (default 1000). Use 100 for a smoother seconds display, 60000 to only track minutes. */
  interval?: number
  /** Always render the days segment even when zero (default false — days appear only once there is at least a day left). */
  showDays?: boolean
  /** Render prop for full control: receives the live CountdownParts and returns your own markup. */
  children?: (parts: CountdownParts) => React.ReactNode
  /** What to show once complete when using the default rendering (default "00:00:00" style zeros). */
  completedLabel?: React.ReactNode
}

const MS = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 }

function partsFrom(targetMs: number, nowMs: number): CountdownParts {
  const total = Math.max(0, targetMs - nowMs)
  return {
    days: Math.floor(total / MS.day),
    hours: Math.floor((total % MS.day) / MS.hour),
    minutes: Math.floor((total % MS.hour) / MS.minute),
    seconds: Math.floor((total % MS.minute) / MS.second),
    total,
    isComplete: total <= 0,
  }
}

const pad = (n: number) => String(n).padStart(2, "0")

/** Build a spoken sentence for screen readers — "2 days, 14 hours, 33 minutes, 7 seconds remaining". */
function spoken(p: CountdownParts): string {
  if (p.isComplete) return "Time's up"
  const unit = (n: number, label: string) =>
    `${n} ${label}${n === 1 ? "" : "s"}`
  const bits: string[] = []
  if (p.days) bits.push(unit(p.days, "day"))
  if (p.days || p.hours) bits.push(unit(p.hours, "hour"))
  bits.push(unit(p.minutes, "minute"), unit(p.seconds, "second"))
  return `${bits.join(", ")} remaining`
}

/**
 * A live countdown to a future moment — launches, sale/offer deadlines, OTP
 * resend cooldowns, auction or event start/end. It re-renders on a timer,
 * fires onComplete once at zero, and never goes negative. shadcn/ui ships no
 * countdown/timer component; this is the future-facing counterpart to a
 * relative "time ago" label.
 */
export const Countdown = React.forwardRef<HTMLDivElement, CountdownProps>(
  function Countdown(
    {
      className,
      to,
      onComplete,
      interval = 1000,
      showDays = false,
      children,
      completedLabel,
      ...props
    },
    ref
  ) {
    const target = React.useMemo(() => new Date(to), [to])
    const targetMs = target.getTime()
    const valid = !Number.isNaN(targetMs)

    // Starts null so server and first client render agree; the effect fills in
    // a real clock after mount (suppressHydrationWarning absorbs the swap).
    const [now, setNow] = React.useState<number | null>(null)

    // Keep the latest onComplete without re-arming the interval each render.
    const onCompleteRef = React.useRef(onComplete)
    React.useEffect(() => {
      onCompleteRef.current = onComplete
    })

    React.useEffect(() => {
      if (!valid) return
      const completedRef = { current: false }
      const fireIfDone = (current: number) => {
        if (!completedRef.current && current >= targetMs) {
          completedRef.current = true
          onCompleteRef.current?.()
          return true
        }
        return false
      }

      setNow(Date.now())
      if (fireIfDone(Date.now())) return

      const id = setInterval(() => {
        const current = Date.now()
        setNow(current)
        if (fireIfDone(current)) clearInterval(id)
      }, Math.max(50, interval))
      return () => clearInterval(id)
    }, [targetMs, valid, interval])

    if (!valid) return null

    // Before mount, fall back to a render-time clock so SSR output is sensible.
    const parts = partsFrom(targetMs, now ?? Date.now())

    return (
      <div
        ref={ref}
        role="timer"
        aria-atomic="true"
        suppressHydrationWarning
        className={cn(
          "inline-flex items-center gap-2 tabular-nums",
          className
        )}
        {...props}
      >
        <span className="sr-only">{spoken(parts)}</span>
        <span aria-hidden="true" className="contents">
          {children
            ? children(parts)
            : parts.isComplete && completedLabel != null
              ? completedLabel
              : renderSegments(parts, showDays)}
        </span>
      </div>
    )
  }
)

const SEGMENT_CLASS =
  "flex min-w-[2.5rem] flex-col items-center rounded-md border bg-card px-2 py-1.5 leading-none"

function Segment({ value, label }: { value: number; label: string }) {
  return (
    <span className={SEGMENT_CLASS}>
      <span className="text-xl font-semibold text-foreground">{pad(value)}</span>
      <span className="mt-1 text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
    </span>
  )
}

function renderSegments(parts: CountdownParts, showDays: boolean) {
  const segments: { value: number; label: string }[] = []
  if (showDays || parts.days > 0) {
    segments.push({ value: parts.days, label: "days" })
  }
  segments.push(
    { value: parts.hours, label: "hrs" },
    { value: parts.minutes, label: "min" },
    { value: parts.seconds, label: "sec" }
  )
  return (
    <span className="inline-flex items-center gap-1.5">
      {segments.map((s) => (
        <Segment key={s.label} value={s.value} label={s.label} />
      ))}
    </span>
  )
}
