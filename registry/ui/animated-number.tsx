"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/**
 * How many decimals are derived from the values themselves before giving up.
 *
 * A number arriving from arithmetic rather than from a person carries the float's whole tail —
 * `String(0.1 + 0.2)` is "0.30000000000000004" — and pinning seventeen decimals because of it
 * would be worse than pinning none. Past this, pass `format` and say what the number is.
 */
const MAX_DERIVED_DECIMALS = 4

/** Powers of ten considered when working out how wide the number can get. */
const MAX_DECADE = 21

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

const clock = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now()

/**
 * Read live rather than held in state, because state is a render behind.
 *
 * The first client render has to agree with the server's HTML, so a reduced-motion flag kept in
 * state is necessarily `false` on that render and only becomes true in a passive effect — after
 * the paint. Anything deciding "animate or jump" from that flag animates one frame for somebody
 * who asked not to see it. The media query itself has no such delay.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(REDUCED_MOTION).matches
}

function decimalsOf(n: number): number {
  if (!Number.isFinite(n)) return 0
  // Rounded to the cap first and then trimmed, so a float's tail is read as the one decimal the
  // caller meant: 0.1 + 0.2 is seventeen decimals as a string and one decimal as a number.
  const text = Math.abs(n).toFixed(MAX_DERIVED_DECIMALS).replace(/0+$/, "")
  const point = text.indexOf(".")
  if (point === -1) return 0
  return text.length - point - 1
}

/**
 * Pins the number of decimals when the caller has not, so the digits after the point stop moving.
 *
 * Counting to 1234.5 passes through 1203.8817 and 1229.44, and `Intl.NumberFormat`'s default is up
 * to three decimals — so the default renders "1,203.882", then "1,229.44", then "1,234.5", and the
 * number changes length three times on its way to a value whose length never changes. Deriving one
 * decimal from the target and holding it there is the whole fix.
 *
 * Left alone when the caller has said anything about digits themselves, and for the styles that
 * already answer the question: currency pins decimals per currency, percent defaults to none
 * (and its digits belong to the percentage, not to the fraction it came from), and compact
 * notation's "1.2K" is a deliberate single decimal that pinning zero would flatten to "1K".
 */
function resolveFormat(
  format: Intl.NumberFormatOptions | undefined,
  from: number,
  to: number
): Intl.NumberFormatOptions {
  const given = format ?? {}
  if (
    given.minimumFractionDigits !== undefined ||
    given.maximumFractionDigits !== undefined ||
    given.minimumSignificantDigits !== undefined ||
    given.maximumSignificantDigits !== undefined ||
    given.style === "currency" ||
    given.style === "percent" ||
    (given.notation !== undefined && given.notation !== "standard")
  ) {
    return given
  }
  const digits = Math.max(decimalsOf(from), decimalsOf(to))
  return { ...given, minimumFractionDigits: digits, maximumFractionDigits: digits }
}

/**
 * The values along the path where the formatted width can change.
 *
 * Only the integer digit count moves it, and that moves at each power of ten and at the all-nines
 * value just below one, so those are the only interior points worth formatting. The endpoints are
 * not enough on their own: counting 0 to 1000 under compact notation ends at "1K" but passes
 * through "999", which is wider than where it finishes.
 */
function widthCandidates(from: number, to: number): number[] {
  const lo = Math.min(from, to)
  const hi = Math.max(from, to)
  const out = [lo, hi]
  for (let k = 0; k <= MAX_DECADE; k++) {
    const decade = 10 ** k
    for (const candidate of [decade, decade - 1, -decade, -(decade - 1)]) {
      if (candidate > lo && candidate < hi) out.push(candidate)
    }
  }
  return out
}

/**
 * The widest string these values format to, scored by digit count and then by total length.
 *
 * Digits are what `tabular-nums` makes equal and what therefore dominates the width; a group
 * separator or a currency symbol is narrower than a digit, so "1,000" is wider than "999" on four
 * digits against three even though both strings are measured in characters. Counting with the
 * Unicode decimal property rather than `\d` keeps this true in a locale whose numbering system is
 * not Latin.
 */
function widestOf(formatter: Intl.NumberFormat, values: number[]): string {
  let widest = ""
  let bestDigits = -1
  let bestLength = -1
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const text = formatter.format(value)
    const digits = (text.match(/\p{Nd}/gu) ?? []).length
    if (digits > bestDigits || (digits === bestDigits && text.length > bestLength)) {
      widest = text
      bestDigits = digits
      bestLength = text.length
    }
  }
  return widest
}

/**
 * `useLayoutEffect` on the client, `useEffect` on the server, where the layout variant does nothing
 * and says so in a warning. Running before the paint is what keeps the final value out of the
 * first frame: the server's HTML carries the real number, and the client replaces it with the
 * starting value without ever showing it.
 */
const useBeforePaint =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export interface UseAnimatedNumberOptions {
  /** Where the number should end up. Changing it counts from wherever the last run got to. */
  value: number
  /** Where the first run starts (default 0). Ignored afterwards. */
  from?: number
  /** Milliseconds for one run (default 800). Zero or less means no animation at all. */
  duration?: number
  /** Progress curve, from (0, 0) to (1, 1). Default is ease-out cubic. */
  easing?: (t: number) => number
  /** Passed straight to `Intl.NumberFormat`, so the caller owns locale and currency. */
  locale?: string | string[]
  format?: Intl.NumberFormatOptions
  /** Hold until the element has been scrolled into view, then count once (default false). */
  startOnView?: boolean
  /** How much of the element has to be visible for `startOnView` (default 0). */
  threshold?: number
  /** Count on the first render (default true). With false, the first value simply appears. */
  animateOnMount?: boolean
  /** Fired once per target, when the number arrives at it. */
  onComplete?: () => void
}

export interface AnimatedNumberState<T extends HTMLElement = HTMLElement> {
  /** The number as it stands this frame, interpolated and not yet formatted. */
  value: number
  /** `value` through `Intl.NumberFormat` — what to show. */
  text: string
  /** The target through the same formatter — what to tell a screen reader. */
  finalText: string
  /** The widest string this run can produce. Render it invisibly to hold the width open. */
  reserveText: string
  isAnimating: boolean
  /** Attach to the element that has to come into view before `startOnView` starts counting. */
  ref: React.RefObject<T | null>
}

/**
 * The counting itself, for a number that has to live inside markup of your own.
 *
 * Returns the formatted frame, the formatted target, and the widest string the run can produce;
 * the component below is these three in a stacked grid, and nothing else.
 */
export function useAnimatedNumber<T extends HTMLElement = HTMLElement>({
  value,
  from = 0,
  duration = 800,
  easing = easeOutCubic,
  locale,
  format,
  startOnView = false,
  threshold = 0,
  animateOnMount = true,
  onComplete,
}: UseAnimatedNumberOptions): AnimatedNumberState<T> {
  const ref = React.useRef<T | null>(null)

  const resolvedFormat = resolveFormat(format, from, value)
  // Keyed on what the options say rather than on the object they arrived in: `format={{ ... }}` is
  // a new object every render, so keying on its identity rebuilds the formatter every frame and
  // re-runs everything downstream of it.
  const formatKey = JSON.stringify([locale ?? null, resolvedFormat])
  const formatter = React.useMemo(
    () => new Intl.NumberFormat(locale, resolvedFormat),
    [formatKey] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const [display, setDisplay] = React.useState<number | null>(null)
  const [started, setStarted] = React.useState(!startOnView)
  // Bumped when the reduced-motion preference changes, purely so the run below re-evaluates it.
  const [motionEpoch, setMotionEpoch] = React.useState(0)

  // What is on screen this instant. A ref rather than state because the next run reads it to know
  // where to count from, and it has to be right during the effect that starts that run — not one
  // render later.
  const currentRef = React.useRef<number | null>(null)
  // Which target onComplete has already fired for, so re-running the effect for any other reason
  // cannot report the same arrival twice.
  const firedForRef = React.useRef<number | null>(null)
  const hasRunRef = React.useRef(false)
  const hasPrimedRef = React.useRef(false)

  const onCompleteRef = React.useRef(onComplete)
  const easingRef = React.useRef(easing)
  React.useEffect(() => {
    onCompleteRef.current = onComplete
    // Held in a ref and deliberately not a dependency of the run below. `easing={(t) => t}` is a
    // new function on every render, and an animation that restarts whenever its easing changes
    // identity restarts on every frame it causes — it would approach the target and never reach it.
    easingRef.current = easing
  })

  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(REDUCED_MOTION)
    if (typeof query.addEventListener !== "function") return
    const onChange = () => setMotionEpoch((epoch) => epoch + 1)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  React.useEffect(() => {
    if (!startOnView) {
      setStarted(true)
      return
    }
    const element = ref.current
    // No element to watch, or an environment without the observer: count rather than sit at the
    // starting value forever.
    if (!element || typeof IntersectionObserver !== "function") {
      setStarted(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setStarted(true)
          observer.disconnect()
        }
      },
      { threshold }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [startOnView, threshold])

  // Move to the starting value before the first paint. Rendering `display ?? value` means the
  // server's HTML and the first client render both carry the real number — which is what a crawler,
  // a feed reader and a page with JavaScript turned off should get — and this replaces it with the
  // starting value in the same commit, so the number is never painted twice.
  useBeforePaint(() => {
    // Guarded by a ref rather than by the empty dependency list alone, because "once" has to mean
    // once however the effect is run again: StrictMode mounts, unmounts and remounts every effect
    // in development, and a second priming would drag a number that had already counted back to
    // the bottom and count it again.
    if (hasPrimedRef.current) return
    hasPrimedRef.current = true
    if (!animateOnMount && !startOnView) return
    if (!Number.isFinite(value) || !Number.isFinite(from) || from === value) return
    if (prefersReducedMotion()) return
    currentRef.current = from
    setDisplay(from)
    // Mount only: this is about the first paint, and `from` is ignored after the first run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useBeforePaint(() => {
    if (!started) return

    const arrive = () => {
      currentRef.current = value
      setDisplay(value)
      if (firedForRef.current !== value) {
        firedForRef.current = value
        onCompleteRef.current?.()
      }
    }

    const isFirstRun = !hasRunRef.current
    hasRunRef.current = true

    // Not a number to count towards. Show it as it is — `Intl.NumberFormat` renders NaN as "NaN" —
    // rather than interpolating towards it and never arriving.
    if (!Number.isFinite(value)) {
      currentRef.current = value
      setDisplay(value)
      return
    }
    if (isFirstRun && !animateOnMount && !startOnView) {
      arrive()
      return
    }
    if (
      prefersReducedMotion() ||
      duration <= 0 ||
      typeof requestAnimationFrame !== "function"
    ) {
      arrive()
      return
    }

    const start = currentRef.current ?? from
    if (!Number.isFinite(start) || start === value) {
      arrive()
      return
    }

    const began = clock()
    let frame: number | null = requestAnimationFrame(step)

    function step() {
      const elapsed = clock() - began
      if (elapsed >= duration) {
        frame = null
        arrive()
        return
      }
      const eased = easingRef.current(elapsed / duration)
      currentRef.current = start + (value - start) * eased
      setDisplay(currentRef.current)
      frame = requestAnimationFrame(step)
    }

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [value, started, duration, from, animateOnMount, startOnView, motionEpoch])

  const current = display ?? value
  // Measured over the declared journey rather than over where the number is this instant. Reading
  // the live value here would re-measure every frame, and counting *down* then narrows the range
  // frame by frame — the box would shrink under the number it is holding open, which is the exact
  // shift this component exists to prevent. Pinned to the endpoints, the width changes only when
  // the target does.
  const reserveText = React.useMemo(
    () =>
      widestOf(
        formatter,
        widthCandidates(Number.isFinite(from) ? from : value, value)
      ),
    [formatter, from, value]
  )

  return {
    value: current,
    text: formatter.format(current),
    finalText: formatter.format(value),
    reserveText,
    isAnimating: display !== null && display !== value,
    ref,
  }
}

export interface AnimatedNumberProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children">,
    UseAnimatedNumberOptions {
  /** Which edge the number sits against inside the width held open for it (default "start"). */
  align?: "start" | "end"
}

/**
 * A number that counts to its value instead of appearing at it — dashboard KPIs, a pricing page's
 * savings figure, a results or vote count, a stat card's figure.
 *
 * The reason to install one rather than write a `requestAnimationFrame` loop is that the obvious
 * version makes the line it sits on move. Interpolating towards 12,480 renders 1,204 and then
 * 11,593 and then 12,480, and in a proportional font the digits are not the same width, so the
 * number changes width every frame and drags the label beside it along; then the group separator
 * arrives at 1,000 and it jumps again. `tabular-nums` fixes the digits, and the widest value the
 * run can produce is rendered invisibly underneath to hold the rest of the width open from the
 * first frame.
 *
 * It interpolates the number and formats each frame, rather than interpolating the formatted
 * string, so a currency symbol and group separators survive the trip; `prefers-reduced-motion`
 * means the value simply appears; a target that changes mid-count is picked up from wherever the
 * number currently is rather than restarting at zero; and only the final value is exposed to a
 * screen reader, because sixty announcements a second is not a reading of a number.
 */
export const AnimatedNumber = React.forwardRef<HTMLSpanElement, AnimatedNumberProps>(
  function AnimatedNumber(
    {
      className,
      value,
      from,
      duration,
      easing,
      locale,
      format,
      startOnView,
      threshold,
      animateOnMount,
      onComplete,
      align = "start",
      ...props
    },
    forwardedRef
  ) {
    const { text, finalText, reserveText, ref } = useAnimatedNumber<HTMLSpanElement>({
      value,
      from,
      duration,
      easing,
      locale,
      format,
      startOnView,
      threshold,
      animateOnMount,
      onComplete,
    })

    React.useImperativeHandle(forwardedRef, () => ref.current as HTMLSpanElement, [ref])

    return (
      <span
        ref={ref}
        className={cn("inline-grid tabular-nums", className)}
        {...props}
      >
        {/* Holds the width open. `invisible` keeps it out of the accessibility tree as well as out
            of the picture, so it is the live value's sibling rather than a second number. */}
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          {reserveText}
        </span>
        <span
          aria-hidden="true"
          className={cn(
            "col-start-1 row-start-1",
            align === "end" ? "justify-self-end" : "justify-self-start"
          )}
        >
          {text}
        </span>
        <span className="sr-only">{finalText}</span>
      </span>
    )
  }
)
