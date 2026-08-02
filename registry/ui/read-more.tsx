"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface ReadMoreProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Lines to show while collapsed. Anything below 1 is treated as 1. Defaults to 3. */
  lines?: number
  /** Label on the control that expands the text. Defaults to "Show more". */
  moreLabel?: string
  /** Label on the control that collapses it again. Defaults to "Show less". */
  lessLabel?: string
  /** Start expanded. Uncontrolled use only. */
  defaultExpanded?: boolean
  /** Controlled expansion — pair with onExpandedChange. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}

// useLayoutEffect measures before paint so the toggle never flashes in or out, but it warns
// during SSR — fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * A clamp of 0 hides the text completely and a fractional or NaN clamp means nothing to
 * -webkit-line-clamp, so a caller passing something odd gets the smallest sane clamp rather
 * than an empty box with a "Show more" under it.
 */
function normalizeLines(lines: number | undefined): number {
  const n = Number(lines)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
}

/**
 * Whether the clamped text is taller than the box showing it.
 *
 * A hidden element — inside a closed tab, accordion, or an unopened dialog — measures 0×0,
 * which is not the same answer as "it fits". Keeping the previous answer stops the toggle
 * from being dropped while the text is off screen and never coming back.
 *
 * The 1px tolerance absorbs sub-pixel line heights, which otherwise report a few tenths of a
 * pixel of overflow on text that visually fits exactly.
 */
function decideOverflow(
  previous: boolean,
  scrollHeight: number,
  clientHeight: number
): boolean {
  if (clientHeight <= 0) return previous
  return scrollHeight - clientHeight > 1
}

// Written as inline style rather than Tailwind's line-clamp-N: the clamp is a runtime number,
// and `line-clamp-${lines}` is invisible to Tailwind's scanner, so it survives dev and
// silently disappears from the production build.
//
// The clamp is passed as a string on purpose. React appends "px" to numeric style values
// unless the property is on its unitless list, and `-webkit-line-clamp: 3px` is invalid: the
// clamp would stop applying, the box would then report no overflow, and the toggle would
// vanish along with it — a component that quietly does nothing. A string cannot be given a unit.
function clampStyle(lines: number): React.CSSProperties {
  return {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: String(lines),
    overflow: "hidden",
  }
}

const CLAMP_CSS_PROPERTIES = [
  "display",
  "-webkit-box-orient",
  "-webkit-line-clamp",
  "overflow",
] as const

/**
 * Long text clamped to a few lines, with a Show more / Show less toggle that only appears
 * when the text actually overflows. Use it for product and listing descriptions, comments
 * and reviews, bios, release notes, log or error detail, and AI answers — anywhere the text
 * is usually short but occasionally long enough to push the rest of the page away.
 *
 * The whole text stays in the DOM and is only clipped visually, so screen readers read all
 * of it either way and the browser can still find it with ⌘F.
 */
export const ReadMore = React.forwardRef<HTMLDivElement, ReadMoreProps>(
  function ReadMore(
    {
      className,
      children,
      lines = 3,
      moreLabel = "Show more",
      lessLabel = "Show less",
      defaultExpanded = false,
      expanded,
      onExpandedChange,
      ...props
    },
    forwardedRef
  ) {
    const rootRef = React.useRef<HTMLDivElement>(null)
    const textRef = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(forwardedRef, () => rootRef.current as HTMLDivElement)

    const textId = React.useId()
    const lineCount = normalizeLines(lines)

    const [uncontrolled, setUncontrolled] = React.useState(defaultExpanded)
    const isControlled = expanded !== undefined
    const isExpanded = isControlled ? expanded : uncontrolled

    // False until measured. The server cannot measure, and the first client render has to
    // match what the server sent, so the toggle is added by the layout effect below —
    // before paint, so it is never visibly missing.
    const [overflowing, setOverflowing] = React.useState(false)

    const measure = React.useCallback(() => {
      const el = textRef.current
      if (!el) return

      // While expanded there is no clamp to measure against, so put one on just long enough
      // to read the two heights. This runs inside a layout effect (or a ResizeObserver
      // callback), so the styles are gone again before anything is painted.
      const needsTemporaryClamp = isExpanded
      if (needsTemporaryClamp) {
        el.style.setProperty("display", "-webkit-box")
        el.style.setProperty("-webkit-box-orient", "vertical")
        el.style.setProperty("-webkit-line-clamp", String(lineCount))
        el.style.setProperty("overflow", "hidden")
      }

      const { scrollHeight, clientHeight } = el

      // Safe to remove rather than restore: React only writes these four while collapsed,
      // and this branch runs only while expanded.
      if (needsTemporaryClamp) {
        for (const property of CLAMP_CSS_PROPERTIES) el.style.removeProperty(property)
      }

      setOverflowing((previous) => decideOverflow(previous, scrollHeight, clientHeight))
    }, [isExpanded, lineCount])

    // Re-measure on mount and whenever the text or the clamp changes.
    useIsomorphicLayoutEffect(measure, [measure, children])

    // A narrower column rewraps the text, which changes how many lines it needs.
    React.useEffect(() => {
      const el = textRef.current
      if (!el || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(() => measure())
      observer.observe(el)
      return () => observer.disconnect()
    }, [measure])

    // A web font swapping in changes the line count without changing the box: while clamped,
    // the height is `lines × line-height`, which Tailwind pins, so the resize observer above
    // never fires and the answer would stay stale at whatever the fallback font needed.
    React.useEffect(() => {
      if (typeof document === "undefined" || !document.fonts) return
      let cancelled = false
      document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
      return () => {
        cancelled = true
      }
    }, [measure])

    const changeExpanded = React.useCallback(
      (next: boolean) => {
        if (!isControlled) setUncontrolled(next)
        onExpandedChange?.(next)
      },
      [isControlled, onExpandedChange]
    )

    // Collapsing removes height above the fold, so a reader who expanded, scrolled down and
    // collapsed again would be dropped somewhere further down the page. Pull the block back
    // into view instead — but only when it has actually scrolled off the top.
    const restoreScrollRef = React.useRef(false)
    useIsomorphicLayoutEffect(() => {
      if (!restoreScrollRef.current) return
      restoreScrollRef.current = false
      const el = rootRef.current
      if (!el || isExpanded) return
      if (el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start" })
    }, [isExpanded])

    function handleToggle() {
      if (isExpanded) restoreScrollRef.current = true
      changeExpanded(!isExpanded)
    }

    function handleFocusCapture(event: React.FocusEvent<HTMLDivElement>) {
      // Clipped is not hidden: a link in the part nobody can see is still in the tab order,
      // and the browser scrolls the clipped box to chase it. Reveal the text instead.
      if (isExpanded || event.target === event.currentTarget) return
      changeExpanded(true)
    }

    function handleScroll(event: React.UIEvent<HTMLDivElement>) {
      // Belt and braces for the same problem: a controlled caller may decline to expand, and
      // a clamp scrolled down by even a few pixels shows the text sheared mid-line.
      event.currentTarget.scrollTop = 0
    }

    return (
      <div ref={rootRef} className={cn("space-y-1", className)} {...props}>
        <div
          id={textId}
          ref={textRef}
          style={isExpanded ? undefined : clampStyle(lineCount)}
          onFocusCapture={handleFocusCapture}
          onScroll={handleScroll}
        >
          {children}
        </div>
        {overflowing ? (
          <button
            type="button"
            onClick={handleToggle}
            aria-expanded={isExpanded}
            aria-controls={textId}
            className="rounded-sm text-sm font-medium underline underline-offset-4 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {isExpanded ? lessLabel : moreLabel}
          </button>
        ) : null}
      </div>
    )
  }
)
