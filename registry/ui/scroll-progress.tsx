"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface ScrollProgressState {
  /**
   * How far through the tracked content the reader has got, from 0 to 1.
   *
   * When there is nothing to scroll this is 1, not 0: everything there is to read is
   * already on screen, so the reader has reached the end of it. Reporting 0 there is the
   * more common choice and it is the wrong one — it leaves a permanently empty bar on
   * every short page, which reads as a broken component rather than a finished article.
   * Use `scrollable` to hide the indicator instead, if that suits the design better.
   */
  progress: number
  /**
   * Whether the tracked content is longer than the viewport. False before the first
   * measurement too, since nothing is known about the page until then.
   */
  scrollable: boolean
}

export interface ScrollProgressProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * The element to track, when progress should mean "through this article" rather than
   * "down this page". Without it the whole scrolling page is tracked, which is the usual
   * choice — but on a page that continues into related posts, a comment thread or a tall
   * footer, a whole-page bar is still short of the end when the article has been read.
   * Point this at the article and the bar fills exactly as the last line arrives.
   *
   * This is also the answer for an app shell whose inner `<main>` scrolls while the window
   * does not: the page itself never moves there, so only a tracked element gives the bar
   * something to follow.
   */
  target?: React.RefObject<HTMLElement | null>
  /** Classes for the filled part, e.g. "bg-emerald-500" or "rounded-r-full". */
  indicatorClassName?: string
}

// useLayoutEffect resolves the first measurement before paint, so the bar is never briefly
// empty on a page restored mid-scroll; it warns during SSR, so fall back on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

// The server cannot know a scroll position, and the first client render has to match what it
// sent. An empty bar is the honest starting point — and the layout effect above replaces it
// before anything is painted.
const INITIAL: ScrollProgressState = { progress: 0, scrollable: false }

/**
 * The scrollable ancestor of a tracked element, or null when the page itself is what moves.
 *
 * An app shell that scrolls an inner `<main>` instead of the window is common in docs sites
 * and dashboards — exactly where a reading indicator goes — and measuring a tracked element
 * against the window would leave the bar frozen in precisely those layouts. This is only
 * consulted for a `target`: without one there is no element to walk up from, which is why
 * whole-page mode reports on the page and an app shell has to name its article.
 */
function findScroller(el: Element | null): Element | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
  }
  return null
}

function clamp01(n: number): number {
  // NaN fails both comparisons and would otherwise escape as a width of "NaN%". It only
  // arises from a zero-sized measurement, where 0 is the right answer anyway.
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Progress is quantised before it reaches state, so a scroll that moves the bar by less than
 * a hundredth of a percent — under a fifth of a pixel on a 1920px screen — does not re-render
 * the tree that consumes this hook.
 */
function quantise(n: number): number {
  return Math.round(n * 10000) / 10000
}

function read(targetEl: Element | null, scroller: Element | null): ScrollProgressState {
  const viewport = scroller ?? document.scrollingElement ?? document.documentElement
  const viewportHeight = viewport.clientHeight

  if (targetEl) {
    const rect = targetEl.getBoundingClientRect()
    // Distances are measured from the top of whatever is scrolling. For the page that is the
    // viewport; for a nested scroller it is that box, which may sit well down the screen.
    const top = scroller ? rect.top - scroller.getBoundingClientRect().top : rect.top
    // The element starts being read when its top reaches the top of the viewport and is
    // finished when its bottom reaches the bottom, so this is the distance between those.
    const travel = rect.height - viewportHeight
    if (travel <= 0) return { progress: 1, scrollable: false }
    return { progress: quantise(clamp01(-top / travel)), scrollable: true }
  }

  const travel = viewport.scrollHeight - viewportHeight
  if (travel <= 0) return { progress: 1, scrollable: false }
  return { progress: quantise(clamp01(viewport.scrollTop / travel)), scrollable: true }
}

/**
 * How far the reader has scrolled through the page, or through `target`, as a number from
 * 0 to 1. Exported for indicators this component does not draw — a percentage in a header,
 * a circular ring, a chapter marker — so they read the same number rather than a second
 * implementation of it that disagrees at the edges.
 */
export function useScrollProgress(
  target?: React.RefObject<HTMLElement | null>
): ScrollProgressState {
  const [state, setState] = React.useState<ScrollProgressState>(INITIAL)

  // Walking the ancestors with getComputedStyle is far too much to redo on every frame of a
  // scroll, so the answer is kept until the element it was derived from is replaced.
  const scrollerRef = React.useRef<Element | null>(null)
  const scrollerSourceRef = React.useRef<Element | null>(null)

  const measure = React.useCallback(() => {
    const targetEl = target?.current ?? null
    if (targetEl !== scrollerSourceRef.current) {
      scrollerSourceRef.current = targetEl
      scrollerRef.current = findScroller(targetEl)
    }
    const next = read(targetEl, scrollerRef.current)
    // Scrolling fires far more often than the bar changes — a trackpad flick at the top of a
    // long page moves it by nothing at all for the first frames. Returning the previous
    // object keeps React from re-rendering for a value that did not move.
    setState((prev) =>
      prev.progress === next.progress && prev.scrollable === next.scrollable ? prev : next
    )
  }, [target])

  useIsomorphicLayoutEffect(measure, [measure])

  React.useEffect(() => {
    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }

    // Capture, because a scroll event does not bubble: one listener on the window then covers
    // the page and any nested scroller inside it. Passive, because this never calls
    // preventDefault and saying so keeps it off the critical path of the scroll itself.
    const scrollOptions = { capture: true, passive: true } as const
    window.addEventListener("scroll", schedule, scrollOptions)
    window.addEventListener("resize", schedule)

    // Content that grows after first paint — an image finishing decoding, a lazily loaded
    // section, an accordion opening — changes how far there is left to scroll without firing
    // either of the events above, and the bar would keep reporting the old total.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(schedule)
      observer.observe(document.documentElement)
      const targetEl = target?.current
      if (targetEl) observer.observe(targetEl)
    }

    // A web font swapping in reflows the text without resizing the root element.
    let cancelled = false
    if (document.fonts) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }

    return () => {
      cancelled = true
      window.removeEventListener("scroll", schedule, scrollOptions)
      window.removeEventListener("resize", schedule)
      observer?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [measure, target])

  return state
}

/**
 * A bar that fills as the reader scrolls — the reading indicator across the top of an
 * article. Give it `className="fixed inset-x-0 top-0 z-50"` for that placement, or drop it
 * under a sticky header as an ordinary block.
 *
 * Decorative on purpose. The scrollbar already tells assistive technology where the reader is,
 * and a `role="progressbar"` whose value changes on every frame of a scroll is announced as a
 * stream of numbers over whatever is being read. Screen reader users lose nothing here, so the
 * element is hidden from them rather than made noisy — spread `aria-hidden={false}` with a role
 * and value of your own if your case genuinely differs.
 */
export const ScrollProgress = React.forwardRef<HTMLDivElement, ScrollProgressProps>(
  function ScrollProgress({ className, target, indicatorClassName, ...props }, ref) {
    const { progress } = useScrollProgress(target)

    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn("relative h-1 w-full overflow-hidden bg-muted", className)}
        {...props}
      >
        {/*
          Width rather than a scaleX transform: a transform would stretch any radius the
          caller puts on this element, and the fill is positioned absolutely, so resizing it
          lays out nothing but itself.

          No transition, either. The width is already following the scroll frame by frame, and
          animating a value that changes every frame only makes the bar lag behind the page it
          is reporting on.
        */}
        <div
          className={cn("absolute inset-y-0 left-0 bg-primary", indicatorClassName)}
          style={{ width: `${progress * 100}%` }}
        />
      </div>
    )
  }
)
