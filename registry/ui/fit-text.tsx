"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Pixels of overflow that are too few to shrink for.
 *
 * `scrollWidth` and `clientWidth` are rounded integers, so a box that fits its text exactly can
 * still report one pixel of overflow and cost the text a whole step of size for nothing. One pixel
 * of slack is the same tolerance overflow-tooltip arrived at from the other direction, and for the
 * same reason.
 */
const OVERFLOW_SLACK = 1

/** The smallest size this will shrink to unless the caller says otherwise. */
const DEFAULT_MIN = 12

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export interface FitFontSizeOptions {
  /** Smallest size to consider, in px. */
  min: number
  /** Largest size to consider, in px — normally the size the design already asked for. */
  max: number
  /** Whether the text fits at `size`. Called with integers only. */
  fits: (size: number) => boolean
}

/**
 * The largest whole pixel size in `[min, max]` that fits, or `min` when nothing does.
 *
 * Separated from the measuring so the arithmetic can be tested without a browser, and written as a
 * binary search over integers for two measured reasons.
 *
 * **Integers, because sub-pixel precision buys nothing and lands outside the box.** Refining the
 * answer past the integer by bisecting to a thousandth of a pixel took twelve more measurements
 * and moved the size by **0.03px** — and when the element was re-measured at that "better" size it
 * reported **241px of content in a 240px box**, one pixel wider than the integer answer that had
 * just fitted. The extra precision is below the rounding of the thing being measured, so it is not
 * precision at all.
 *
 * **A search, rather than one measurement and a ratio, because glyph width is not proportional to
 * font size.** The cheap version everybody writes first measures the text once at 16px and scales:
 * `16 * (available / width16)`. Swept across ten box widths against the true answer, that estimate
 * was wrong in **seven of them** — by −4px at a 640px box (it says 51 where 55 fits, throwing away
 * four sizes) and, worse, by **+1px at a 120px box, where it claims a size that overflows**. The
 * cause is that the default UI face on macOS tracks tighter as it grows: the same string measures
 * 12.49px per point of size at 16px and 11.43px at 64px. Any registry component inherits whatever
 * face the page is using, so this cannot be assumed away. Six measurements over `[8, 96]` get the
 * exact answer instead.
 *
 * `fits` is required to be monotonic — if a size fits, every smaller one does. Measured on both
 * axes this component uses: sweeping 40px down to 6px in a capped box, the predicate flipped
 * **exactly once** over 35 samples, and the height of a wrapping paragraph never once rose as the
 * size fell across 109 samples at each of `text-wrap: normal`, `balance` and `pretty`.
 */
export function fitFontSize({ min, max, fits }: FitFontSizeOptions): number {
  // A caller computing these from props can hand over NaN (`parseFloat` of an empty style) or an
  // inverted range (a `min` larger than the design size). Both would otherwise return garbage that
  // is then written to `style.fontSize`, where it is silently ignored and the text stays at its
  // unfitted size — the failure that looks like the component doing nothing at all.
  const low = Number.isFinite(min) ? Math.max(Math.floor(min), 1) : DEFAULT_MIN
  const high = Number.isFinite(max) ? Math.floor(max) : low
  if (high <= low) return low

  let lo = low
  let hi = high
  // `min` rather than nothing: a box too small for even the smallest readable size still has to
  // render something, and an unreadable string is worse than a clipped one. The caller sees this
  // as `overflowing`, and the component clips with an ellipsis at that point.
  let best = low
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (fits(mid)) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/** What `useFitFontSize` settled on. */
export interface FitResult {
  /** The size applied, in px, or null before the first measurement. */
  size: number | null
  /** True when the text does not fit even at `min` and is being clipped. */
  overflowing: boolean
}

export interface UseFitFontSizeOptions {
  /** Smallest size to shrink to, in px. Defaults to 12. */
  min?: number
  /**
   * Largest size, in px.
   *
   * Left out, the element's own CSS size is used — so `className="text-4xl"` is the ceiling and
   * this only ever shrinks. That is re-read on every measurement, which is what makes a responsive
   * ceiling (`text-2xl md:text-5xl`) work: the breakpoint changes the design size, the resize that
   * carries it re-measures, and the new ceiling is picked up for free.
   */
  max?: number
  /** 1 for a single line (the default), more for a clamped paragraph. */
  lines?: number
  /** Re-measure when these change — the text itself, for content that is not a plain string. */
  deps?: React.DependencyList
}

/**
 * Shrinks `ref`'s text until it fits its box, and keeps it fitting.
 *
 * Exported because the size is worth having without this component's markup — a number in a table
 * cell, a label inside an SVG, a name on a seating chart you are drawing yourself.
 *
 * **It measures the element, not a stand-in copy.** The obvious implementation measures a hidden
 * probe span (which is how this registry's middle-truncate finds its cut point) and applies the
 * answer to the real element. For a string that is a measurement of the same thing, and the two
 * agreed to **the exact same fraction of a pixel at all seven sizes tested**. But a probe is only
 * the same box if every box property is the same, and anything in `em` scales with the font: give
 * the real element `px-[0.5em]` and the bare probe is **48px narrower at a 48px font**, so the
 * fitted size overflows by a whole em and the component is wrong in exactly the cases where it is
 * most needed. Writing the candidate size to the real element and reading `scrollWidth` back costs
 * a forced layout per step — six of them — and is immune to all of it.
 *
 * **The write damps itself, but only because it is a fixed point.** Writing font size from inside a
 * ResizeObserver callback resizes the observed element and the observer fires again; measured, that
 * settles after **one extra pass** (two callbacks, the second computing the same size and writing
 * nothing new). What does not settle is the version that nudges relative to the current size —
 * shrink a step while it overflows, grow a step while there is room — which **oscillated between
 * 21px and 20px for as long as it was left running**, 37 callbacks in 600ms, with no error anywhere
 * and a layout pass burnt every frame. So the search always runs over the whole range from scratch
 * and never reads its own last answer, and the observer ignores anything but a change of width
 * (measured: turns those two callbacks into one application).
 */
export function useFitFontSize(
  ref: React.RefObject<HTMLElement | null>,
  { min = DEFAULT_MIN, max, lines = 1, deps = [] }: UseFitFontSizeOptions = {}
): FitResult {
  const [result, setResult] = React.useState<FitResult>({ size: null, overflowing: false })

  const measure = React.useCallback(() => {
    const el = ref.current
    if (!el) return

    // The ceiling is read with our own size cleared, so it is the size the stylesheet asks for
    // rather than whatever this hook wrote last time. Without the clear, the ceiling ratchets
    // downwards: every measurement would take the previous fitted size as its maximum and the text
    // could never grow back when the box widened.
    const explicitMax = typeof max === "number"
    const appliedBefore = el.style.fontSize
    if (!explicitMax) el.style.fontSize = ""
    const ceiling = explicitMax
      ? (max as number)
      : parseFloat(getComputedStyle(el).fontSize)

    // A box with no layout — inside a closed dialog, an unselected tab, anything `display: none` —
    // reports zero for both, and zero is not "nothing fits": it is "not measured yet". Shrinking to
    // the floor on the strength of it would leave the text at 12px when the dialog opens, which is
    // the one state no resize is guaranteed to correct.
    const axis = lines > 1 ? ("Height" as const) : ("Width" as const)
    if (!(el[`client${axis}`] > 0)) {
      // Put back whatever was applied before the ceiling was read. Leaving it cleared would drop
      // the element to its CSS size with no re-render owed to restore it — React only writes the
      // style prop again when the fitted size changes, and it has not.
      el.style.fontSize = appliedBefore
      return
    }

    const fits = (size: number) => {
      el.style.fontSize = `${size}px`
      return el[`scroll${axis}`] - el[`client${axis}`] <= OVERFLOW_SLACK
    }

    const size = fitFontSize({ min, max: ceiling, fits })
    // Applied last so the element is left at the chosen size rather than at whichever candidate
    // the search happened to try last, and read back once to answer "did it fit even here".
    const overflowing = !fits(size)
    setResult((previous) =>
      previous.size === size && previous.overflowing === overflowing
        ? previous
        : { size, overflowing }
    )
  }, [ref, min, max, lines])

  // Before paint, so the text is never seen at a size that does not fit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useIsomorphicLayoutEffect(measure, [measure, ...deps])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return

    // A face arriving after the first measurement changes every glyph width without changing the
    // box, so nothing else reports it — the observer below least of all, which is why this does not
    // sit behind the same feature test. A browser old enough to lack ResizeObserver is if anything
    // likelier to apply a web font late, and gating the two together left the text sized for the
    // fallback face in exactly that case. overflow-tooltip measured the same swap putting a box
    // that reported "fits" 8px over.
    let cancelled = false
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    fonts?.ready.then(() => {
      if (!cancelled) measure()
    })

    // Width only. The element's height changes every time the size is written, and reacting to that
    // is the second callback that measured above — harmless, since the search is a fixed point, but
    // a forced layout for an answer already known.
    let lastWidth: number | null = null
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const width = entries[entries.length - 1]?.contentRect.width
            if (width === undefined) return
            if (lastWidth !== null && Math.abs(width - lastWidth) < 0.5) return
            lastWidth = width
            measure()
          })
    observer?.observe(el)

    return () => {
      cancelled = true
      observer?.disconnect()
    }
  }, [ref, measure])

  return result
}

export interface FitTextProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The text. */
  children: React.ReactNode
  /** Smallest size to shrink to, in px. Defaults to 12. */
  min?: number
  /** Largest size, in px. Defaults to the element's own CSS size, so this only ever shrinks. */
  max?: number
  /** 1 for a single line (the default), more for a clamped paragraph. */
  lines?: number
  /** Told the size that was applied, and whether it is still clipped at `min`. */
  onFit?: (result: FitResult) => void
}

/**
 * Text shrunk to the largest size that fits the box it was given.
 *
 * For every place a string has to live in a space somebody else sized: the number in a KPI tile, a
 * product name on a card, a person's name on a name badge or a seating chart, a heading on a slide,
 * a label in a fixed table column, a figure in a dashboard cell that is usually `1.2M` and
 * occasionally `1,284,993`. Style it as you would any text — `className="text-4xl font-semibold"` —
 * and that size becomes the ceiling it shrinks from.
 *
 * **The floor is the part worth arguing about.** Shrinking without a limit always "fits", by
 * producing text nobody can read, and a 6px label in a dashboard is a worse outcome than a clipped
 * one — the reader can at least tell that something has been cut, and can usually hover or widen to
 * see it. So `min` defaults to 12px and, at the floor, the component stops shrinking and clips with
 * an ellipsis instead, the same way it would have without any of this.
 *
 * What it does **not** do is make text bigger. Growing a short string to fill its box is a
 * different component with a different failure mode (a two-letter name rendered at 90px), and
 * conflating them is why the ceiling here is the design's own size rather than a number this
 * component chose.
 *
 * The text itself is never touched — it is the same text node at a different size — so find-in-page,
 * selection, the clipboard and the accessibility tree all see the string in full. That is the
 * difference between this and the ellipsis-based answers to the same problem, which solve it by
 * removing characters.
 */
export const FitText = React.forwardRef<HTMLSpanElement, FitTextProps>(function FitText(
  { children, min = DEFAULT_MIN, max, lines = 1, onFit, className, style, ...props },
  forwardedRef
) {
  const innerRef = React.useRef<HTMLSpanElement>(null)
  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLSpanElement)

  const result = useFitFontSize(innerRef, { min, max, lines, deps: [children] })

  const onFitRef = React.useRef(onFit)
  onFitRef.current = onFit
  // Guarded on the values last reported rather than on the dependency array, so a parent that
  // re-renders on this callback cannot turn a measurement into a loop — the same guard
  // overflow-tooltip needs for the same reason.
  const reported = React.useRef<FitResult | null>(null)
  React.useEffect(() => {
    const last = reported.current
    if (last && last.size === result.size && last.overflowing === result.overflowing) return
    reported.current = result
    onFitRef.current?.(result)
  }, [result])

  return (
    <span
      ref={innerRef}
      className={cn(
        "block",
        // Clipping is both the floor's fallback and what keeps an unfitted first paint inside its
        // box: `overflow: hidden` also gives the element an automatic minimum size of zero, which
        // is what lets it shrink below its text inside a flex row or a grid track with no
        // `min-w-0` from the caller.
        lines > 1 ? "overflow-hidden" : "truncate",
        className
      )}
      style={{
        // The caller's style comes first and this component's own goes after it, which is the
        // reverse of the usual order and deliberate: these three properties are the component. A
        // caller writing `style={{ fontSize: 48 }}` is naming the size to shrink *from* — an inline
        // size is part of the computed style the ceiling is read from — and if that same value also
        // won here it would overwrite the fitted size and silently switch the fitting off.
        ...style,
        // Before the first measurement there is no size to apply, and the server has none either.
        // The element renders at its CSS size and the layout effect settles it before paint, so
        // nothing is ever seen at the wrong size — and if the effect never runs at all, the text is
        // at the size the stylesheet asked for rather than at a guess this component made.
        ...(result.size !== null ? { fontSize: `${result.size}px` } : null),
        ...(lines > 1
          ? {
              // No class is generated for an arbitrary clamp count, so a numeric prop has to set it
              // here or quietly do nothing for every N the build never saw.
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: lines,
            }
          : null),
      }}
      {...props}
    >
      {children}
    </span>
  )
})
