"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"
import { useScrollEdges } from "@/registry/ui/scroll-shadow"

/** Where a tab is parked once it has been brought into view. */
export type TabScrollerAlign = "nearest" | "center"

/**
 * How far the strip is scrolled, and where the tab sits relative to the visible window.
 *
 * Everything here is **logical**: `leadingGap` is the room between the inline start of the window
 * and the inline start of the tab, whichever way the text runs, so the arithmetic below never has
 * to know about writing direction. {@link readTabVisibility} resolves the direction once, on the
 * way in, and {@link scrollLeftForOffset} puts the sign back on the way out.
 */
export interface TabVisibility {
  /** Room between the window's inline start and the tab's. Negative when the tab starts off-window. */
  leadingGap: number
  /** Room between the tab's inline end and the window's. Negative when the tab runs past the end. */
  trailingGap: number
  /** How far the strip is already scrolled from its inline start. Never negative. */
  scrolled: number
  /** `scrollWidth - clientWidth` — the furthest the strip can be scrolled. */
  maxScroll: number
}

export interface TabScrollOptions {
  align?: TabScrollerAlign
  /** Pixels kept between the tab and the edge of the window. See {@link DEFAULT_GUTTER}. */
  gutter?: number
}

/**
 * How much room is kept between the brought-into-view tab and the edge of the window.
 *
 * Not zero, for two reasons that both show up as "the selected tab looks wrong". A tab flush
 * against the edge reads as cut off — there is no way to tell a tab that ends at the window's edge
 * from one that continues past it — and the arrow buttons are painted *over* the ends of the strip,
 * so a tab parked at the edge sits underneath one and is half-covered by a chevron. 32 is the width
 * of those buttons.
 */
const DEFAULT_GUTTER = 32

/** Fraction of the window an arrow button travels: a screenful, less a sliver kept for context. */
const ARROW_STEP_RATIO = 0.8

/**
 * Sub-pixel difference between where the strip is and where it should be that is not worth a scroll.
 *
 * Layout is fractional and `scrollLeft` is not reliably so, so the target computed from a set of
 * rects is routinely a quarter of a pixel from where the strip already is. Without this the
 * component asks for a scroll on every measurement, and because an animated scroll is itself a
 * stream of scroll events, each one arriving while the last is still running, a smooth scroll to
 * the place you are already in never finishes.
 */
export const TAB_SCROLL_EPSILON = 0.5

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/**
 * Where the strip should be scrolled to so that `visibility`'s tab is in view, as a logical offset.
 *
 * Pure, because every interesting case here is a set of numbers rather than a click: a tab that
 * starts before the window, one that runs past it, one wider than the window itself, one already
 * comfortably in view, and the two ends where the answer has to be clamped rather than honoured.
 *
 * `"nearest"` moves as little as possible — the tab that is off the leading end comes to the
 * leading gutter, the tab off the trailing end comes to the trailing gutter, and a tab already in
 * view with room on both sides is left exactly where it is. That last case is the one that makes
 * the difference between a strip that follows you and a strip that fidgets: re-centring a tab that
 * is already perfectly readable moves the other tabs out from under the pointer.
 *
 * `"center"` always moves, which is the right default for a strip of many short tabs where the
 * selected one should be somewhere predictable rather than wherever it happened to land.
 *
 * A tab wider than the window cannot satisfy both gutters, and the leading edge wins: the start of
 * a label is worth more than its end.
 */
export function nextTabScroll(
  visibility: TabVisibility,
  { align = "nearest", gutter = DEFAULT_GUTTER }: TabScrollOptions = {}
): number {
  const { leadingGap, trailingGap, scrolled, maxScroll } = visibility
  const limit = Math.max(0, maxScroll)

  if (align === "center") {
    // Scrolling forward by d takes d off the leading gap and adds it to the trailing one, so the
    // two are equal at exactly half their difference.
    return clamp(scrolled + (leadingGap - trailingGap) / 2, 0, limit)
  }

  if (leadingGap < gutter) return clamp(scrolled + leadingGap - gutter, 0, limit)
  if (trailingGap < gutter) return clamp(scrolled + gutter - trailingGap, 0, limit)
  return scrolled
}

/**
 * A logical scroll offset as the `scrollLeft` the CSSOM wants.
 *
 * In an LTR box the two are the same number. In an RTL box `scrollLeft` is 0 at the *initial*
 * position — the right-hand end — and runs negative going left, so the logical distance travelled
 * from the inline start is the negation. This is the same rule `scroll-shadow` documents for
 * reading the edges, kept in one function here so the component never writes the sign by hand.
 */
export function scrollLeftForOffset(offset: number, rtl: boolean): number {
  // Zero is the initial position either way round, and negating it produces `-0` — which scrolls
  // the same but is a different number, so it leaks into anything that compares offsets or writes
  // one down.
  if (!rtl || offset === 0) return offset
  return -offset
}

/**
 * Where `tab` sits inside `viewport`'s scrolling window, in logical units.
 *
 * The window is the **scrollport** rather than the border box: `clientLeft` is subtracted off and
 * `clientWidth` used for the far edge, so a strip with a border is not reported as a window a
 * border's width too wide, which would park every tab a pixel or two under an arrow.
 */
export function readTabVisibility(
  viewport: HTMLElement,
  tab: HTMLElement,
  rtl: boolean
): TabVisibility {
  const box = viewport.getBoundingClientRect()
  const tabBox = tab.getBoundingClientRect()
  const windowStart = box.left + viewport.clientLeft
  const windowEnd = windowStart + viewport.clientWidth

  return {
    leadingGap: rtl ? windowEnd - tabBox.right : tabBox.left - windowStart,
    trailingGap: rtl ? tabBox.left - windowStart : windowEnd - tabBox.right,
    scrolled: rtl ? -viewport.scrollLeft : viewport.scrollLeft,
    maxScroll: viewport.scrollWidth - viewport.clientWidth,
  }
}

/**
 * The selected tab, under either of the two conventions a tab strip can be built with.
 *
 * `aria-selected` is what the ARIA practices put on the selected tab, and what a hand-rolled strip
 * will have. `data-state="active"` is what Radix — and therefore official shadcn/ui's `TabsTrigger`
 * — puts there. Matching both is why this component needs no prop telling it which tab is current
 * and no control over the tab state itself: it reads the same attribute a screen reader does.
 */
export const DEFAULT_ACTIVE_TAB_SELECTOR =
  '[role="tab"][aria-selected="true"], [role="tab"][data-state="active"], [data-state="active"]'

export interface TabScrollerProps extends React.ComponentPropsWithoutRef<"div"> {
  /** How the selected tab is found. Defaults to {@link DEFAULT_ACTIVE_TAB_SELECTOR}. */
  activeSelector?: string
  /** Where a tab is parked once brought into view. Defaults to `"nearest"`. */
  align?: TabScrollerAlign
  /** Pixels kept between the tab and the window's edge. Defaults to 32. */
  gutter?: number
  /** Show the overlaid arrow buttons while there is more in that direction. Defaults to true. */
  arrows?: boolean
  /** Pixels an arrow travels. Defaults to 80% of the window. */
  scrollStep?: number
  /** Ref to the scrolling element — the one to call `scrollTo` on. */
  viewportRef?: React.Ref<HTMLDivElement>
  /** Classes for the scrolling element: padding, `gap-2`, `scroll-smooth`. */
  viewportClassName?: string
  /** Classes for both arrow buttons. */
  arrowClassName?: string
}

/**
 * A horizontally scrolling strip for a row of tabs that does not fit, which keeps the selected tab
 * in view and puts an arrow at each end while there is more that way.
 *
 * ```tsx
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabScroller>
 *     <TabsList className="w-max">
 *       <TabsTrigger value="overview">Overview</TabsTrigger>
 *       …twenty more…
 *     </TabsList>
 *   </TabScroller>
 *   <TabsContent value="overview">…</TabsContent>
 * </Tabs>
 * ```
 *
 * **It wraps a tab strip rather than being one.** No `role` is imposed on the children and no tab
 * state is owned here, because the strip's own library already owns both: Radix's `TabsList` is the
 * `tablist`, its triggers are the tabs, and its Left/Right keys move the selection. That division
 * is the answer to the one thing that makes a scrolling tab strip different from a scrolling row of
 * anything else — **a `tablist` has already spent the arrow keys.** Binding Left/Right here to
 * scroll the strip would collide with the keys that move the selection, and the collision resolves
 * the wrong way round: the keyboard user who presses Right wants the next tab, and scrolling the
 * strip underneath them while the selection stays put is the one outcome nobody asked for. So this
 * component binds no keys at all. Keyboard users move the selection, and the selection brings
 * itself into view — which is the same motion, driven by the input that was already there.
 *
 * **Which is why it watches the DOM instead of taking a prop.** The selected tab is found with a
 * selector covering `aria-selected="true"` and `data-state="active"`, and a `MutationObserver`
 * re-reads it when either attribute changes anywhere inside. Nothing has to tell this component
 * what the current tab is, nothing has to be lifted, and it works the same under Radix, under a
 * hand-rolled strip, and under a router that decides the tab from the URL.
 *
 * **What it does not do is call `scrollIntoView`.** That is the obvious implementation and it is
 * wrong in a way that is invisible in development: `scrollIntoView` scrolls *every* scrollable
 * ancestor to reveal the element, the document included. On a short page, where the strip is near
 * the top and nothing else scrolls, it looks perfect. On a real page — a strip of tabs partway down
 * a long settings screen, inside a dialog, inside a horizontally scrolling layout — selecting a tab
 * scrolls the page vertically to bring the strip into view and jumps the content the user was
 * reading. `block: "nearest"` reduces how far it goes but does not stop it: "nearest" is still a
 * scroll when the element is not fully visible, and it still applies to each ancestor in turn.
 *
 * Measured in Chrome rather than argued about: on a strip 1,200px down a tall page,
 * `scrollIntoView({ block: "nearest", inline: "nearest" })` on the fifth tab took the document from
 * `scrollY` 0 to **1,201**, and parked the tab hard against the edge at `scrollLeft` 300 with no
 * gutter. The same tab through this component's arithmetic moved the strip to `scrollLeft` 332 and
 * left `scrollY` at 0 — the predicted offset was 332 and the actual was 332, with 32px of gutter
 * left past the tab exactly as asked. The only way to move one box and nothing else is to compute
 * the offset and set it on that box, which is what {@link nextTabScroll} and
 * {@link readTabVisibility} are for.
 *
 * **The arrows are painted over the strip, not laid out beside it**, and that is load-bearing
 * rather than cosmetic. Arrows that take part in layout make the window narrower exactly when they
 * appear, and the window's width is the input that decided whether they were needed — so a strip
 * whose tabs fit the full width but not the width-minus-two-buttons has no stable answer, and the
 * version everybody writes first oscillates or settles on whichever state it happened to start in.
 * Overlaying them means the window is the same width whether they are showing or not, so the
 * measurement cannot be disturbed by its own result — measured on this pair, an absolutely
 * positioned button left the scrollport at 300px, and the same button as a flex sibling changed it. They are `aria-hidden` and not tab stops: the
 * scrolling they do is reachable without them, since moving the selection scrolls the strip, and a
 * screen reader offered "scroll tabs right" has no way to know how far it went or when to stop.
 * They are a pointer affordance, standing in for the scrollbar this hides.
 *
 * Which end has more is {@link useScrollEdges} from `scroll-shadow`, imported rather than written
 * again — the hook's own documentation names arrow buttons on a tab strip as the reason it is
 * exported. It brings with it the two things a hand-rolled version of this gets wrong: that an RTL
 * box reports `scrollLeft === 0` while half its tabs are hidden off to the left, and that a `scroll`
 * listener alone leaves the arrows missing on arrival, which is the moment they are needed — a
 * strip that arrives from a fetch already too wide, or inside a panel that was `display: none` until
 * its accordion opened, has overflowed without anybody scrolling.
 *
 * The first positioning is instant and the rest are smooth, so a strip whose twelfth tab is
 * selected on arrival does not animate past the first eleven on load, and `prefers-reduced-motion`
 * turns the animation off entirely. The strip is only re-scrolled when the selected tab actually
 * changes, never on any other mutation, so a user who scrolls the strip by hand to look at
 * something is not dragged back. A resize is the one exception: it can carry the selected tab out
 * of the window, and the tab being visible is the invariant worth re-asserting.
 *
 * Honest limits: the server cannot measure, so an SSR'd strip renders scrolled to its start with no
 * arrows until hydration, and a strip whose selected tab is off-window is correct one frame later
 * rather than in the HTML. The scrollbar is hidden — the arrows and the fade of
 * `scroll-shadow` are the affordances in its place — so pass `viewportClassName` to put it back if
 * a design wants it.
 */
export const TabScroller = React.forwardRef<HTMLDivElement, TabScrollerProps>(
  function TabScroller(
    {
      activeSelector = DEFAULT_ACTIVE_TAB_SELECTOR,
      align = "nearest",
      gutter = DEFAULT_GUTTER,
      arrows = true,
      scrollStep,
      viewportRef,
      viewportClassName,
      arrowClassName,
      className,
      children,
      ...props
    },
    ref
  ) {
    const innerRef = React.useRef<HTMLDivElement>(null)
    React.useImperativeHandle(viewportRef, () => innerRef.current as HTMLDivElement)

    const edges = useScrollEdges(innerRef)

    // The tab the strip was last scrolled for. Comparing against it is what keeps this from
    // fighting the user: every other mutation inside a tab strip — a badge count changing, a label
    // being translated, a tab being added — would otherwise re-assert the scroll position and undo
    // a scroll somebody made by hand a moment ago.
    const lastActive = React.useRef<Element | null>(null)
    // Whether anything has been positioned yet, so the first one can be instant.
    const positioned = React.useRef(false)

    const scrollToTab = React.useCallback(
      (tab: HTMLElement, instant: boolean) => {
        const viewport = innerRef.current
        if (!viewport) return

        const rtl = getComputedStyle(viewport).direction === "rtl"
        const visibility = readTabVisibility(viewport, tab, rtl)
        const target = nextTabScroll(visibility, { align, gutter })
        if (Math.abs(target - visibility.scrolled) <= TAB_SCROLL_EPSILON) return

        const reduced =
          viewport.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches ?? false

        viewport.scrollTo({
          left: scrollLeftForOffset(target, rtl),
          behavior: instant || reduced ? "auto" : "smooth",
        })
      },
      [align, gutter]
    )

    React.useEffect(() => {
      const viewport = innerRef.current
      if (!viewport) return

      let frame: number | null = null

      // `force` is the resize path: the selected tab has not changed, but the window it had to fit
      // in has, so the comparison against `lastActive` is deliberately skipped.
      const sync = (force: boolean) => {
        const active = viewport.querySelector<HTMLElement>(activeSelector)
        if (!active) return
        if (!force && active === lastActive.current) return
        lastActive.current = active
        const instant = !positioned.current
        positioned.current = true
        scrollToTab(active, instant)
      }

      const schedule = (force: boolean) => {
        if (frame !== null) cancelAnimationFrame(frame)
        // One frame later, so a selection change that also re-renders the strip is measured against
        // the layout it produced rather than the one it replaced.
        frame = requestAnimationFrame(() => {
          frame = null
          sync(force)
        })
      }

      sync(false)

      let observer: MutationObserver | null = null
      if (typeof MutationObserver !== "undefined") {
        observer = new MutationObserver(() => schedule(false))
        observer.observe(viewport, {
          subtree: true,
          attributes: true,
          // Only the two attributes that can mean "this is the selected tab now". Watching every
          // attribute would wake this on each class change, and Radix changes classes on hover.
          attributeFilter: ["aria-selected", "data-state"],
          // A tab strip whose tabs arrive from a fetch has no selected tab to find on mount.
          childList: true,
        })
      }

      let resizeObserver: ResizeObserver | null = null
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => schedule(true))
        resizeObserver.observe(viewport)
      }

      return () => {
        if (frame !== null) cancelAnimationFrame(frame)
        observer?.disconnect()
        resizeObserver?.disconnect()
      }
    }, [activeSelector, scrollToTab])

    const nudge = (direction: 1 | -1) => {
      const viewport = innerRef.current
      if (!viewport) return
      const step = scrollStep ?? Math.max(1, viewport.clientWidth * ARROW_STEP_RATIO)
      const reduced =
        viewport.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
          .matches ?? false
      // `scrollBy` is physical in both writing directions — left is left — which is what these
      // buttons mean, so neither the sign nor the chevrons need mirroring for an RTL strip.
      viewport.scrollBy({ left: direction * step, behavior: reduced ? "auto" : "smooth" })
    }

    const arrowBase =
      "absolute inset-y-0 z-10 flex w-8 items-center justify-center bg-background text-muted-foreground transition-opacity hover:text-foreground"

    return (
      <div
        ref={ref}
        // Not `overflow-hidden`: the arrows are absolutely positioned children and clipping here
        // would be fine for them, but a popover opened from a tab would be clipped too, and the
        // scrolling child already clips what it scrolls.
        className={cn("relative min-w-0", className)}
        data-more-left={edges.left ? "" : undefined}
        data-more-right={edges.right ? "" : undefined}
        {...props}
      >
        <div
          ref={innerRef}
          className={cn(
            "min-w-0 overflow-x-auto overflow-y-hidden",
            // The scrollbar is replaced by the arrows. A horizontal scrollbar under a row of tabs
            // is a second control for the same job that also changes the strip's height on the
            // platforms that reserve room for it.
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            viewportClassName
          )}
        >
          {children}
        </div>

        {arrows && edges.left && (
          <button
            type="button"
            // See {@link TabScroller}: a redundant pointer affordance for a scroll that the tab
            // selection already performs, so exposing it would add a control a keyboard user
            // cannot usefully aim.
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => nudge(-1)}
            // Physical `left-0`, not logical `start-0`. Everything about these buttons is physical
            // — the edge that decides whether to show one (`edges.left`), the direction `scrollBy`
            // travels, and the chevron glyph — so a logical inset would put the left-pointing
            // button on the right of an RTL strip, showing it for content hidden at the other end.
            className={cn(arrowBase, "left-0", arrowClassName)}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
        )}

        {arrows && edges.right && (
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => nudge(1)}
            className={cn(arrowBase, "right-0", arrowClassName)}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>
    )
  }
)
