"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** Which axis the fades are drawn on. The other one is never faded, even if it scrolls. */
export type ScrollShadowOrientation = "horizontal" | "vertical" | "both"

/**
 * Everything about a scroller's position that the edges are derived from, in one plain object so
 * the derivation is a pure function you can test without a browser.
 */
export interface ScrollMetrics {
  scrollLeft: number
  scrollTop: number
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
  /**
   * Whether the element is laid out right-to-left, which changes what `scrollLeft` means.
   *
   * In an LTR box `scrollLeft` runs from 0 at the left to `scrollWidth - clientWidth` at the right.
   * In an RTL box the CSSOM spec puts 0 at the *initial* position — the right-hand end — and runs
   * negative going left, so a fresh RTL table reports `scrollLeft === 0` while half its columns are
   * hidden off to the left. Every implementation that treats `scrollLeft === 0` as "nothing behind
   * us" therefore draws the fade on the wrong side of an Arabic or Hebrew page, and does it on first
   * paint, when nobody is looking for it.
   */
  rtl: boolean
}

/** Which sides have content beyond the visible box, and whether each axis scrolls at all. */
export interface ScrollEdges {
  top: boolean
  right: boolean
  bottom: boolean
  left: boolean
  scrollableX: boolean
  scrollableY: boolean
}

/**
 * What the server renders and what a scroller reports before it has been measured.
 *
 * Nothing is known about overflow until an element exists and has been laid out, and the honest
 * answer to "is there more to the right?" before then is "no fade", not a guess — a fade painted on
 * the server would have to be unpainted on hydration on every box that turned out to fit.
 */
export const NO_SCROLL_EDGES: ScrollEdges = {
  top: false,
  right: false,
  bottom: false,
  left: false,
  scrollableX: false,
  scrollableY: false,
}

/**
 * How many pixels of hidden content still counts as "at the end".
 *
 * Not zero, and this is the bug that outlives every rewrite. Layout is fractional — a flex gap of
 * 0.5px, a browser at 110% zoom, a `min-w-0` column that resolves to 240.5 — while `scrollWidth`
 * and `clientWidth` are rounded integers. Scroll a table fully to the right and
 * `scrollWidth - clientWidth - scrollLeft` lands on 0.4 rather than 0, so a `> 0` test leaves the
 * end fade painted forever, over the last column, on exactly the screens the author does not have.
 */
const DEFAULT_THRESHOLD = 1

/** Default length of a fade, in pixels. Long enough to read as a soft edge, short enough to hide little. */
const DEFAULT_SIZE = 32

/**
 * Which sides of a scroller have content past the edge.
 *
 * Pure, so the RTL and sub-pixel cases can be asserted directly rather than reasoned about.
 * Distances are physical — `left` means "there is content off the left of the screen" — because
 * that is what a fade is drawn against; the writing direction is resolved here, once.
 */
export function readScrollEdges(
  metrics: ScrollMetrics,
  threshold: number = DEFAULT_THRESHOLD
): ScrollEdges {
  const maxX = metrics.scrollWidth - metrics.clientWidth
  const maxY = metrics.scrollHeight - metrics.clientHeight
  const scrollableX = maxX > threshold
  const scrollableY = maxY > threshold

  // In RTL, scrollLeft is 0 at the right-hand end and -maxX at the left, so the two distances swap
  // and one of them needs the sign flipped. Overscroll — the rubber band at the end of a trackpad
  // flick on macOS and iOS — pushes these negative for a few frames, which the comparison absorbs.
  const hiddenLeft = metrics.rtl ? maxX + metrics.scrollLeft : metrics.scrollLeft
  const hiddenRight = metrics.rtl ? -metrics.scrollLeft : maxX - metrics.scrollLeft

  return {
    top: scrollableY && metrics.scrollTop > threshold,
    right: scrollableX && hiddenRight > threshold,
    bottom: scrollableY && maxY - metrics.scrollTop > threshold,
    left: scrollableX && hiddenLeft > threshold,
    scrollableX,
    scrollableY,
  }
}

function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.scrollableX === b.scrollableX &&
    a.scrollableY === b.scrollableY
  )
}

function readMetrics(el: HTMLElement): ScrollMetrics {
  const scrollWidth = el.scrollWidth
  const clientWidth = el.clientWidth
  return {
    scrollLeft: el.scrollLeft,
    scrollTop: el.scrollTop,
    scrollWidth,
    clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    // Only asked when it can change the answer. getComputedStyle flushes style, and the common case
    // by far is a vertical scroller with no horizontal overflow at all, which never needs to know.
    rtl: scrollWidth > clientWidth && getComputedStyle(el).direction === "rtl",
  }
}

// Resolves the first measurement before paint, so a box that is already overflowing is never shown
// for one frame without its fades. It warns during SSR, so fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export interface UseScrollEdgesOptions {
  /** Pixels of hidden content that still count as "at the end". Defaults to 1. See {@link DEFAULT_THRESHOLD}. */
  threshold?: number
}

/**
 * Which sides of `ref` have more content, kept correct as the box, its contents and the scroll
 * position change. Exported so an indicator this component does not draw — arrow buttons on a tab
 * strip, a "more →" caption, a shadow of your own — reads the same measurement.
 *
 * The reason this is not four lines around a `scroll` listener is that **the scroll event is the
 * one signal that is never missing when the fade is missing.** A table that arrives from a fetch
 * already too wide, a sidebar opening and squeezing the page, a filter that adds a column, a
 * details row expanding: in every one of those the content starts out overflowing and nobody has
 * scrolled yet, so a scroll-only implementation shows nothing at the exact moment the user needs
 * telling that there is more. It looks fine in development, where you scroll the thing you just
 * built, and it is wrong on arrival for everybody else.
 *
 * So the position is re-read from five other places as well, each covering a way content or the box
 * can change without a scroll: the box being resized (which also covers it starting out
 * `display: none` inside a closed tab panel, since becoming visible is a resize from zero), a
 * child's own size changing, nodes being added or removed anywhere inside, an image or iframe
 * finishing loading, and a web font swapping in and re-flowing the text. All of them funnel through
 * one requestAnimationFrame, so a burst of mutations costs a single measurement, and state only
 * changes when one of the six booleans does — a scroll from one end of a long table to the other
 * re-renders twice, not once a frame.
 */
export function useScrollEdges(
  ref: React.RefObject<HTMLElement | null>,
  { threshold = DEFAULT_THRESHOLD }: UseScrollEdgesOptions = {}
): ScrollEdges {
  const [edges, setEdges] = React.useState<ScrollEdges>(NO_SCROLL_EDGES)

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = readScrollEdges(readMetrics(el), threshold)
    setEdges((prev) => (sameEdges(prev, next) ? prev : next))
  }, [ref, threshold])

  useIsomorphicLayoutEffect(measure, [measure])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    let frame: number | null = null
    const schedule = () => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        measure()
      })
    }

    // Passive: this never calls preventDefault, and saying so keeps it off the critical path of the
    // scroll itself. Listened for on the element rather than the window because a scroll event does
    // not bubble.
    el.addEventListener("scroll", schedule, { passive: true })

    // An image or iframe that finishes loading changes how wide the content is without touching the
    // DOM and often without resizing any child that is being watched. `load` does not bubble but it
    // does capture, so one listener covers every one of them, however deep.
    el.addEventListener("load", schedule, true)

    let resizeObserver: ResizeObserver | null = null
    let mutationObserver: MutationObserver | null = null
    const observedChildren = new Set<Element>()

    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(schedule)
      // The box itself: a window resize, a sidebar opening, a flex sibling growing, or the panel
      // this lives in being shown for the first time.
      resizeObserver.observe(el)

      // And the contents, which is the half a container-only observer misses: a row of chips whose
      // labels change, a table whose columns re-measure, a cell that wraps to two lines. Direct
      // children are watched rather than the whole subtree because a deep node growing pushes its
      // ancestors wider, and the outermost one of those is a direct child. The set is kept in step
      // with the DOM so a list that swaps its rows does not accumulate observations on nodes that
      // are gone.
      const syncChildren = () => {
        const current = new Set<Element>(el.children)
        for (const node of observedChildren) {
          if (!current.has(node)) {
            resizeObserver?.unobserve(node)
            observedChildren.delete(node)
          }
        }
        for (const node of current) {
          if (!observedChildren.has(node)) {
            resizeObserver?.observe(node)
            observedChildren.add(node)
          }
        }
      }
      syncChildren()

      if (typeof MutationObserver !== "undefined") {
        mutationObserver = new MutationObserver(() => {
          syncChildren()
          schedule()
        })
        // characterData as well as childList: text replaced in place — a cell going from "3" to
        // "3,481,002" — widens a table without adding a single node.
        mutationObserver.observe(el, { childList: true, subtree: true, characterData: true })
      }
    }

    // A web font swapping in re-flows every line without resizing anything that is being watched.
    // Asked of the element's own document rather than the global one, so a scroller portalled into
    // an iframe or a popped-out window waits for the fonts that will actually lay it out.
    let cancelled = false
    const fonts = el.ownerDocument.fonts
    if (fonts) {
      fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }

    return () => {
      cancelled = true
      el.removeEventListener("scroll", schedule)
      el.removeEventListener("load", schedule, true)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [ref, measure])

  return edges
}

/**
 * One axis of the fade, as a mask image.
 *
 * `#000` is opaque and `transparent` is not, which under the default alpha mask mode means shown
 * and hidden — the colour itself never appears, which is the whole point of masking rather than
 * overlaying: nothing here has to know what is behind the scroller.
 *
 * A side with nothing hidden past it gets a hard opaque stop instead of a fade, so the mask is only
 * ever soft where there is genuinely something more to see.
 */
function fadeGradient(to: "right" | "bottom", start: number, end: number): string {
  const stops: string[] = []
  stops.push(start > 0 ? `transparent 0, #000 ${start}px` : "#000 0")
  stops.push(end > 0 ? `#000 calc(100% - ${end}px), transparent 100%` : "#000 100%")
  return `linear-gradient(to ${to}, ${stops.join(", ")})`
}

export interface ScrollShadowMaskOptions {
  orientation?: ScrollShadowOrientation
  /** Length of each fade in pixels. Defaults to 32. */
  size?: number
}

/**
 * The mask that fades whichever edges have more content behind them, as inline style.
 *
 * Exported for the same reason as the hook: so a scroller you lay out yourself can take the fade
 * without taking this component's markup.
 *
 * Two things are deliberate. It returns an empty object when nothing is hidden, rather than a
 * fully opaque mask — a mask makes the element a stacking context and costs a composited layer,
 * and a box that fits should pay neither. And when both axes need fading the two gradients are
 * combined with `mask-composite: intersect`, because the default is `add`: two layers that are each
 * opaque down their own middle would union into an almost entirely opaque mask, fading nothing but
 * the four corners — a bug that only appears in the one case where both axes scroll.
 */
export function scrollShadowMask(
  edges: ScrollEdges,
  { orientation = "both", size = DEFAULT_SIZE }: ScrollShadowMaskOptions = {}
): React.CSSProperties {
  const layers: string[] = []
  if (orientation !== "vertical" && (edges.left || edges.right)) {
    layers.push(fadeGradient("right", edges.left ? size : 0, edges.right ? size : 0))
  }
  if (orientation !== "horizontal" && (edges.top || edges.bottom)) {
    layers.push(fadeGradient("bottom", edges.top ? size : 0, edges.bottom ? size : 0))
  }
  if (layers.length === 0) return {}
  const maskImage = layers.join(", ")
  return layers.length > 1 ? { maskImage, maskComposite: "intersect" } : { maskImage }
}

const OVERFLOW_CLASS: Record<ScrollShadowOrientation, string> = {
  // The unused axis is hidden rather than left visible: CSS promotes `visible` to `auto` as soon as
  // the other axis is not visible, so a horizontal scroller written as `overflow-x-auto` alone ends
  // up with a vertical scrollbar the first time a cell wraps.
  horizontal: "overflow-x-auto overflow-y-hidden",
  vertical: "overflow-y-auto overflow-x-hidden",
  both: "overflow-auto",
}

export interface ScrollShadowProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onScroll"> {
  /** Which axis to fade. Defaults to `"both"`, which fades whichever axis turns out to scroll. */
  orientation?: ScrollShadowOrientation
  /** Length of each fade in pixels. Defaults to 32. */
  size?: number
  /** Pixels of hidden content that still count as "at the end". Defaults to 1. */
  threshold?: number
  /**
   * Give the scrolling box a tab stop while it overflows. Defaults to true; pass false only if you
   * are providing keyboard access another way. See {@link ScrollShadow} on why this is not static.
   */
  focusable?: boolean
  /** Ref to the scrolling element itself — the one to call `scrollTo` on. */
  viewportRef?: React.Ref<HTMLDivElement>
  /** Classes for the scrolling element: `max-h-72`, padding, `scroll-smooth`. */
  viewportClassName?: string
  /** Fires when a side gains or loses hidden content — for arrow buttons, or a "more" caption. */
  onEdgesChange?: (edges: ScrollEdges) => void
  /** Scroll handler, attached to the scrolling element rather than the wrapper. */
  onViewportScroll?: React.UIEventHandler<HTMLDivElement>
}

/**
 * A scrolling box whose edges fade out while there is more content past them, and stop fading the
 * moment there is not.
 *
 * ```tsx
 * <ScrollShadow orientation="horizontal" aria-label="Releases">
 *   <table className="w-max">…</table>
 * </ScrollShadow>
 *
 * <ScrollShadow orientation="vertical" viewportClassName="max-h-72 p-4" className="rounded-lg border">
 *   <p>…long terms and conditions…</p>
 * </ScrollShadow>
 * ```
 *
 * **The thing being solved is that `overflow: auto` will not tell you whether it is overflowing.**
 * A scrollable box looks exactly like a box that ends there, and the browser gives no hook for the
 * difference — no `:overflowing` selector, no event, nothing in CSS. So a cut-off table reads as a
 * complete table, and people file bugs about missing columns that were there the whole time. The
 * only way to know is to measure `scrollWidth` against `clientWidth` and keep re-measuring, which
 * is what {@link useScrollEdges} does and why this is a component rather than three utility
 * classes. The version everyone writes first listens for `scroll` alone, and that is precisely
 * backwards: it means the fade is missing until you scroll, and the state where the fade earns its
 * keep is the one before anyone has touched it.
 *
 * The fade is a **mask on the content**, not a gradient overlaid on top of it. An overlay has to be
 * painted in the page's background colour to look like a fade, so it has to be told what that
 * colour is — and it is then wrong inside a card, wrong on a striped table, wrong over an image,
 * and wrong in dark mode the day someone adds it, because the gradient stop was hardcoded once and
 * nobody re-checked. Masking makes the content itself fall away, which is correct on every
 * background without being told about any of them. Two consequences worth knowing: the scroller
 * becomes a stacking context while a fade is showing, and a popover rendered inside it will be
 * clipped — though `overflow: auto` was already clipping it, so portal it out as usual.
 *
 * **It takes a tab stop only while it actually scrolls.** A `div` with `overflow: auto` and no
 * focusable content inside cannot be reached, and therefore cannot be scrolled, without a mouse —
 * a plain table of text or a wide code block is simply unreachable by keyboard, which is what axe
 * reports as `scrollable-region-focusable`. The usual fix is a permanent `tabIndex={0}`, which buys
 * that at the price of a dead tab stop on every one of these boxes that fits. Since the overflow is
 * already being measured, the stop can exist exactly when it is useful. Pass `aria-label` and the
 * box is announced as a named region as well, so a screen reader user is told what they have
 * arrived in rather than landing on an anonymous group.
 *
 * The focus ring is drawn on the wrapper, outside the mask — a ring on the masked element would
 * fade out along with the content at the very edges it is meant to trace, which is a focus
 * indicator that disappears exactly when the box is scrollable.
 */
export const ScrollShadow = React.forwardRef<HTMLDivElement, ScrollShadowProps>(
  function ScrollShadow(
    {
      orientation = "both",
      size = DEFAULT_SIZE,
      threshold = DEFAULT_THRESHOLD,
      focusable = true,
      viewportRef,
      viewportClassName,
      onEdgesChange,
      onViewportScroll,
      className,
      children,
      role,
      tabIndex,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      ...props
    },
    ref
  ) {
    const innerRef = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(viewportRef, () => innerRef.current as HTMLDivElement)

    const edges = useScrollEdges(innerRef, { threshold })

    // A ref, so a caller passing an inline arrow does not re-run the effect on every render.
    const onEdgesChangeRef = React.useRef(onEdgesChange)
    React.useEffect(() => {
      onEdgesChangeRef.current = onEdgesChange
    })
    React.useEffect(() => {
      onEdgesChangeRef.current?.(edges)
    }, [edges])

    // Focus is tracked here rather than with a `has-[:focus-visible]` variant on the wrapper,
    // because `:has()` cannot tell the box's own focus from a link's inside it, and ringing the
    // whole region every time someone tabs through a row of buttons is worse than no ring at all.
    const [focusRing, setFocusRing] = React.useState(false)

    const scrollable = edges.scrollableX || edges.scrollableY
    const keyboardScrollable = focusable && scrollable
    const named = Boolean(ariaLabel || ariaLabelledBy)

    return (
      <div
        ref={ref}
        className={cn(
          // A column flex box rather than a plain block, so that a height put on the wrapper
          // reaches the scroller: a `max-h-72` on a block wrapper caps nothing, the content spills
          // out of it in full, and the box the author asked to scroll simply does not. Shrinking to
          // zero in both axes is what lets it be dropped into a flex row or a grid cell without
          // the widest table cell dictating the width of the whole page.
          "relative flex min-h-0 min-w-0 flex-col",
          focusRing && "ring-2 ring-ring ring-offset-2 ring-offset-background",
          className
        )}
        // Left for CSS to hang off — a shadow of your own, an arrow button that hides at the end.
        data-more-top={edges.top ? "" : undefined}
        data-more-right={edges.right ? "" : undefined}
        data-more-bottom={edges.bottom ? "" : undefined}
        data-more-left={edges.left ? "" : undefined}
        data-scrollable={scrollable ? "" : undefined}
        {...props}
      >
        <div
          ref={innerRef}
          // Inherited so that a border radius put on the wrapper clips the content too, instead of
          // square corners of table showing through a rounded card.
          className={cn(
            "min-h-0 min-w-0 rounded-[inherit] focus-visible:outline-none",
            OVERFLOW_CLASS[orientation],
            viewportClassName
          )}
          style={scrollShadowMask(edges, { orientation, size })}
          tabIndex={tabIndex ?? (keyboardScrollable ? 0 : undefined)}
          // An unnamed `region` is not exposed as a landmark and only adds noise, and a landmark
          // for a box that currently fits is noise of a second kind, so both conditions are asked.
          role={role ?? (named && keyboardScrollable ? "region" : undefined)}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-describedby={ariaDescribedBy}
          onScroll={onViewportScroll}
          onFocus={(event) => {
            // Only the box itself, not a button inside it that bubbled its focus up here.
            if (event.target !== event.currentTarget) return
            setFocusRing(event.currentTarget.matches(":focus-visible"))
          }}
          onBlur={(event) => {
            if (event.target !== event.currentTarget) return
            setFocusRing(false)
          }}
        >
          {children}
        </div>
      </div>
    )
  }
)
