"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Pixels of hidden text that are too few to be worth a tooltip.
 *
 * Both numbers in the comparison are rounded integers, and measuring a box through its text's
 * natural width in tenths of a pixel shows that they round together: across a sweep from one pixel
 * under to one pixel over, **every box at least as wide as its text reported an overflow of
 * exactly 0**. So the usual sub-pixel worry does not apply to this axis, and a `> 0` test raises no
 * false positives of its own.
 *
 * What the sweep does show is the other end: a box 0.2px too narrow reports an overflow of 1,
 * because the rounding has to go somewhere. A fifth of a pixel off the end of the last glyph is not
 * something anybody can see, and interrupting a table with a tooltip over it is worse than letting
 * it clip. One pixel of slack is where those two meet.
 */
const DEFAULT_THRESHOLD = 1

/** What the element reports about itself, and which axis the clipping happens on. */
export interface OverflowMetrics {
  scrollWidth: number
  clientWidth: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Whether the text is actually clipped.
 *
 * `lines` picks the axis, and it has to, because the two kinds of clipping are invisible to each
 * other's measurement. A single line ellipsised with `text-overflow` overflows horizontally and
 * not at all vertically; a paragraph cut off by `-webkit-line-clamp` is the exact reverse —
 * measured, a two-line clamp reported **0 pixels of horizontal overflow and 51 of vertical**. A
 * component that only ever compares widths therefore says "not truncated" about every clamped
 * paragraph it is ever given, and does it silently.
 */
export function isOverflowing(
  metrics: OverflowMetrics,
  { lines = 1, threshold = DEFAULT_THRESHOLD }: { lines?: number; threshold?: number } = {}
): boolean {
  return lines > 1
    ? metrics.scrollHeight - metrics.clientHeight > threshold
    : metrics.scrollWidth - metrics.clientWidth > threshold
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export interface UseIsOverflowingOptions {
  /** 1 for a single ellipsised line (the default), more for a `-webkit-line-clamp` paragraph. */
  lines?: number
  /** Pixels of hidden text that still count as fitting. Defaults to 1. */
  threshold?: number
  /** Re-measure when this changes, for content that is not a plain string. */
  deps?: React.DependencyList
}

/**
 * Whether `ref`'s text is clipped right now, kept correct as the box and the fonts change.
 *
 * Exported because the answer is useful without a tooltip attached to it — a "show full" button, a
 * row that expands, an icon in the corner of a cell.
 *
 * Two of the three re-measurements are the reason this is not one line in a render:
 *
 * **Fonts arrive after the first measurement and change the answer.** A box sized for the fallback
 * face reports that its text fits; when the real face swaps in, the same box is 8 pixels over
 * (measured, at a boundary chosen to be near the edge). Nothing fires a resize on the cell and
 * nothing re-renders the tree, so a component that measured once on mount is wrong from then on,
 * and wrong in the direction where it says a clipped cell is fine. `document.fonts.ready` settles
 * once per page and is cheap to wait for.
 *
 * **A resize changes the answer with no event attached.** Dragging a sidebar or a column narrower
 * flips a cell from fitting to clipped, measured, and the only notification of it is a
 * ResizeObserver on the cell.
 *
 * The third is the ordinary one: the text itself changing, which React already tells us about, so
 * the measurement runs on every render. Reading `scrollWidth` forces layout but changes nothing,
 * and nothing this component does to the element afterwards — a tab stop, a tooltip positioned out
 * of flow — alters its size, so there is no loop to damp.
 */
export function useIsOverflowing(
  ref: React.RefObject<HTMLElement | null>,
  { lines = 1, threshold = DEFAULT_THRESHOLD, deps = [] }: UseIsOverflowingOptions = {}
): boolean {
  const [overflowing, setOverflowing] = React.useState(false)

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    setOverflowing(isOverflowing(el, { lines, threshold }))
  }, [ref, lines, threshold])

  // Every render, because the text is the thing most likely to have changed and it is the one
  // change no observer reports as a size change of this element.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useIsomorphicLayoutEffect(measure, [measure, ...deps])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver(measure)
    observer.observe(el)

    // A face that has already loaded resolves this immediately, so the common case costs one
    // microtask. `cancelled` rather than an AbortController because the only thing to undo is the
    // callback, and a component unmounted between the two would otherwise set state after the fact.
    let cancelled = false
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    fonts?.ready.then(() => {
      if (!cancelled) measure()
    })

    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [ref, measure])

  return overflowing
}

export interface OverflowTooltipProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The text. Clipped by CSS, shown in full in the tooltip. */
  children: React.ReactNode
  /**
   * The full text, when `children` is not a plain string.
   *
   * Only needed for mixed content — a highlighted match, a badge next to a name. With a string
   * child this is the string.
   */
  label?: string
  /** 1 for a single ellipsised line (the default), more for a clamped paragraph. */
  lines?: number
  /** Pixels of hidden text that still count as fitting. Defaults to 1. */
  threshold?: number
  /** Which side of the text the tooltip sits on. Defaults to "top". */
  side?: "top" | "bottom"
  /** How long the pointer has to rest before the tooltip opens, in ms. Focus opens it at once. */
  delay?: number
  /** Never open, and never take a tab stop. For a cell whose full text is already shown elsewhere. */
  disabled?: boolean
  /** Told when the text starts or stops being clipped. */
  onOverflowChange?: (overflowing: boolean) => void
  tooltipClassName?: string
}

/**
 * Text that shows its full self in a tooltip **only when it is actually cut off**.
 *
 * For the places where a string has to fit a box somebody else sized: a table cell, a file or
 * project name in a sidebar, a tab, a breadcrumb, a card title, an email subject, a chip in a row
 * of chips. Give it the width to fit in — from the table layout, a `max-w-*`, a flex parent — and
 * it clips with an ellipsis and reveals the rest on hover and on focus.
 *
 * The rule it exists to enforce is the negative one. **Showing a tooltip over text that was never
 * clipped is the more expensive mistake**, and it is what every `title={name}` on every cell does:
 * a tooltip on everything is a page that flickers boxes at you as the pointer crosses it, and a
 * tab stop on everything is a table a keyboard cannot get past. So the tooltip, the tab stop and
 * the hover handlers all exist exactly when the text is clipped, and the component is an ordinary
 * `<span>` the rest of the time.
 *
 * It does not use the `title` attribute, which is the other thing people reach for. `title` is
 * slow, cannot be styled or dismissed, does not appear on touch at all — and, because CSS clipping
 * is visual only, it is a **second copy of text a screen reader already has**, which it then reads
 * twice. That is also why the tooltip here is `aria-hidden`: nothing is hidden from assistive
 * technology in the first place, since the text node is complete whatever the paint does with it.
 * What is hidden is hidden from eyes, so the remedy is for eyes, and the tab stop is there for the
 * sighted keyboard user who cannot hover.
 *
 * The tooltip is positioned inside the wrapper rather than portalled, so it is clipped by an
 * ancestor with `overflow: hidden` — which a scrolling table has. Put the scroll container on a
 * parent that the tooltip is allowed to escape, or use `side="bottom"` in the top row.
 */
export const OverflowTooltip = React.forwardRef<HTMLSpanElement, OverflowTooltipProps>(
  function OverflowTooltip(
    {
      children,
      label,
      lines = 1,
      threshold = DEFAULT_THRESHOLD,
      side = "top",
      delay = 300,
      disabled = false,
      onOverflowChange,
      className,
      tooltipClassName,
      // Pulled out rather than left in `props`, because these five are load-bearing here: spread
      // after the component's own, a caller's handler replaces the one that opens the tooltip and
      // the component quietly stops working; spread before, the caller's never runs. Both are
      // called.
      onPointerEnter,
      onPointerLeave,
      onFocus,
      onBlur,
      onKeyDown,
      ...props
    },
    ref
  ) {
    const textRef = React.useRef<HTMLSpanElement>(null)
    const overflowing = useIsOverflowing(textRef, { lines, threshold, deps: [children] })
    const active = overflowing && !disabled
    const [open, setOpen] = React.useState(false)
    const timer = React.useRef<number | null>(null)
    const id = React.useId()

    const onOverflowChangeRef = React.useRef(onOverflowChange)
    onOverflowChangeRef.current = onOverflowChange
    // Guarded on the last value reported rather than on the dependency array alone, so the caller
    // is told once per change even when the effect itself runs twice — which it does under strict
    // mode in development, and which is how a parent that re-renders on this callback turns a
    // measurement into a loop.
    const reported = React.useRef<boolean | null>(null)
    React.useEffect(() => {
      if (reported.current === overflowing) return
      reported.current = overflowing
      onOverflowChangeRef.current?.(overflowing)
    }, [overflowing])

    const cancel = React.useCallback(() => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }, [])

    // A tooltip left open by text that stopped being clipped — the column was widened while the
    // pointer rested on it — has nothing left to say.
    React.useEffect(() => {
      if (!active && open) setOpen(false)
    }, [active, open])

    React.useEffect(() => cancel, [cancel])

    const openLater = () => {
      if (!active) return
      cancel()
      timer.current = window.setTimeout(() => setOpen(true), delay)
    }
    const close = () => {
      cancel()
      setOpen(false)
    }

    // An empty or blank label is "nothing to show" rather than an empty box: a caller computing
    // the full text from data has one for every row where the data is missing.
    const candidate = label ?? (typeof children === "string" ? children : undefined)
    const full = candidate && candidate.trim() !== "" ? candidate : undefined

    return (
      <span
        ref={ref}
        className={cn("relative inline-block max-w-full align-bottom", className)}
        onPointerEnter={(event) => {
          openLater()
          onPointerEnter?.(event)
        }}
        onPointerLeave={(event) => {
          close()
          onPointerLeave?.(event)
        }}
        // Focus opens immediately: a keyboard user has already committed to this element by
        // arriving at it, and a delay there reads as the component being broken.
        onFocus={(event) => {
          if (active) setOpen(true)
          onFocus?.(event)
        }}
        onBlur={(event) => {
          close()
          onBlur?.(event)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            // Stopped here so Escape does not also close the dialog or the menu this sits in —
            // dismissing the thing on top is the whole of what the key was pressed for.
            event.stopPropagation()
            close()
          }
          onKeyDown?.(event)
        }}
        {...props}
      >
        <span
          ref={textRef}
          // The tab stop exists exactly while it is useful. A permanent one would put every cell
          // of a table into the tab order to buy the handful that are clipped.
          tabIndex={active ? 0 : undefined}
          className={cn(
            "block rounded-sm",
            lines > 1 ? "overflow-hidden" : "truncate",
            active &&
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          )}
          style={
            lines > 1
              ? // No Tailwind class is emitted for an arbitrary clamp count, and `line-clamp-N`
                // only exists for the few N that are generated — a prop that takes a number has to
                // set it here or quietly do nothing for N the build never saw.
                {
                  display: "-webkit-box",
                  WebkitBoxOrient: "vertical",
                  WebkitLineClamp: lines,
                }
              : undefined
          }
        >
          {children}
        </span>

        {active && open && full !== undefined ? (
          <span
            id={id}
            role="tooltip"
            // The text is already complete in the accessibility tree — CSS clipped the paint, not
            // the DOM — so announcing this too would be the same sentence twice. See the note on
            // the component.
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-0 z-50 w-max max-w-xs rounded-md border border-border",
              "bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
              side === "top" ? "bottom-full mb-1" : "top-full mt-1",
              tooltipClassName
            )}
          >
            {full}
          </span>
        ) : null}
      </span>
    )
  }
)
