"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface MiddleTruncateProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children"> {
  /** The full string. This is what is announced, copied, and found by find-in-page. */
  text: string
  /** Share of the surviving characters kept on the left, 0–1. Defaults to 0.5. */
  ratio?: number
  /** Marker placed between the two halves. Defaults to "…". */
  ellipsis?: string
}

// useLayoutEffect measures before paint, so the full string is never briefly visible before
// collapsing to its truncated form. It warns during SSR, where there is nothing to measure.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

// Sub-pixel slack. Text widths and content-box widths are both fractional, and a string that
// fills its box exactly can report a few hundredths of a pixel of overflow. Kept well under a
// pixel on purpose: over-generous slack shaves the last glyph, which is the whole point of the
// component.
const WIDTH_TOLERANCE = 0.5

// The probe is absolutely positioned, so it takes part in no layout and contributes nothing to
// the parent's width; `visibility: hidden` keeps it off screen while still being measurable
// (`display: none` would report zero). It inherits font, weight, letter-spacing and
// text-transform from the root, so it measures the text exactly as the visible span renders it.
const PROBE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  visibility: "hidden",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  width: "auto",
  maxWidth: "none",
  userSelect: "none",
}

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> }
type SegmenterConstructor = new (
  locales: undefined,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter

/**
 * Split into user-perceived characters rather than UTF-16 code units.
 *
 * Slicing a raw string cuts through surrogate pairs and combining marks, so an emoji, a flag,
 * or an accented letter landing on the cut turns into a replacement glyph. A truncation
 * component cannot shrug that off the way ordinary code can: the cut point moves every time
 * the container resizes, so the corruption appears and disappears at arbitrary widths.
 */
function toGraphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
  if (typeof Segmenter === "function") {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (entry) => entry.segment
    )
  }
  // Older engines: iterating a string yields code points, which keeps surrogate pairs whole
  // even though it still splits combining marks.
  return Array.from(text)
}

/**
 * The finite check is the part that matters: `Math.round(kept * NaN)` is NaN, which makes every
 * candidate collapse to a bare ellipsis, so a box with room for twenty characters would render
 * "…x" — a component that quietly does nothing.
 *
 * The 0–1 clamp only keeps the value inside its documented range; out-of-range ratios are
 * already absorbed downstream, where the head is clamped against the number of survivors.
 */
function normalizeRatio(ratio: number | undefined): number {
  const value = Number(ratio)
  if (!Number.isFinite(value)) return 0.5
  return Math.min(Math.max(value, 0), 1)
}

/**
 * Build the candidate that keeps `kept` graphemes, split either side of the ellipsis.
 *
 * Both sides are held to at least one grapheme once there is room for two, because "…d1f9c2"
 * and "a3b7e0…" are each just an end-truncation wearing a different hat — the caller asked for
 * this component precisely because both ends carry meaning.
 */
function buildCandidate(
  graphemes: string[],
  kept: number,
  ratio: number,
  ellipsis: string
): string {
  if (kept <= 0) return ellipsis
  // One survivor goes to the tail: extensions, checksums and trailing path segments are the
  // half a reader can least afford to lose.
  if (kept === 1) return ellipsis + graphemes[graphemes.length - 1]

  const head = Math.min(Math.max(Math.round(kept * ratio), 1), kept - 1)
  const tail = kept - head
  return (
    graphemes.slice(0, head).join("") +
    ellipsis +
    graphemes.slice(graphemes.length - tail).join("")
  )
}

/**
 * One line of text with the middle removed so that both ends stay visible, sized to whatever
 * width the container actually gives it. Use it for file names, where CSS truncation eats the
 * extension; and for paths, URLs, S3 and storage keys, git SHAs, wallet and contract addresses,
 * API keys, request and trace IDs, branch names, and any other identifier whose tail is what
 * tells two of them apart.
 *
 * The full string stays in the DOM for screen readers, clipboard and ⌘F; only the visible copy
 * is shortened.
 */
export const MiddleTruncate = React.forwardRef<HTMLSpanElement, MiddleTruncateProps>(
  function MiddleTruncate(
    { text, ratio = 0.5, ellipsis = "…", className, ...props },
    forwardedRef
  ) {
    const rootRef = React.useRef<HTMLSpanElement>(null)
    const probeRef = React.useRef<HTMLSpanElement>(null)
    React.useImperativeHandle(forwardedRef, () => rootRef.current as HTMLSpanElement)

    // null means "show the whole string". The server cannot measure and the first client render
    // has to match it, so every render starts here and the layout effect below narrows it
    // before paint.
    const [truncated, setTruncated] = React.useState<string | null>(null)

    const safeRatio = normalizeRatio(ratio)
    const graphemes = React.useMemo(() => toGraphemes(text), [text])

    const measure = React.useCallback(() => {
      const root = rootRef.current
      const probe = probeRef.current
      if (!root || !probe) return

      // clientWidth includes padding, so a caller adding `px-3` would otherwise get a string
      // measured against a box wider than the one it has to fit in.
      const style = window.getComputedStyle(root)
      const available =
        root.clientWidth -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0)

      // An element inside a closed tab, accordion or unopened dialog measures zero, which is
      // not the same answer as "nothing fits". Keeping the previous string stops the text from
      // collapsing to a lone ellipsis while it is off screen and staying that way.
      if (!(available > 0)) return

      const widthOf = (value: string) => {
        probe.textContent = value
        return probe.getBoundingClientRect().width
      }
      const fits = (value: string) => widthOf(value) - available <= WIDTH_TOLERANCE

      let next: string | null = null
      if (!fits(text)) {
        // Largest number of surviving graphemes that still fits.
        //
        // Binary search is sound here even in a proportional font, where a wider string is not
        // generally a longer one. Because the ratio is clamped to 0–1, both sides grow by at
        // most one grapheme per step and neither ever shrinks, so each candidate is the
        // previous one with a single grapheme inserted at the split — the search never swaps a
        // wide glyph in for a narrow one, and width therefore rises with the count.
        let low = 0
        let high = graphemes.length - 1
        let best = 0
        while (low <= high) {
          const mid = (low + high) >> 1
          if (fits(buildCandidate(graphemes, mid, safeRatio, ellipsis))) {
            best = mid
            low = mid + 1
          } else {
            high = mid - 1
          }
        }
        next = buildCandidate(graphemes, best, safeRatio, ellipsis)
      }

      // Leave nothing behind: a stale probe string would otherwise be picked up by ⌘F and by a
      // select-all copy.
      probe.textContent = ""
      setTruncated(next)
    }, [text, graphemes, safeRatio, ellipsis])

    useIsomorphicLayoutEffect(measure, [measure])

    // The container getting narrower is the whole reason this component exists.
    React.useEffect(() => {
      const root = rootRef.current
      if (!root || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(() => measure())
      observer.observe(root)
      return () => observer.disconnect()
    }, [measure])

    // A web font swapping in changes every glyph width without changing the box, so the resize
    // observer never fires and the cut point would stay wherever the fallback font put it.
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

    return (
      <span
        ref={rootRef}
        // `overflow-hidden` earns its place three times: it clips the full string rendered
        // before the first measurement, it contains the absolutely positioned probe (with
        // `relative`) so it cannot widen an ancestor, and — because a box with a non-visible
        // overflow has an automatic minimum size of zero — it is also what lets this shrink
        // below its text inside a flex row or grid track, with no `min-w-0` needed.
        className={cn("relative block overflow-hidden whitespace-nowrap", className)}
        {...props}
      >
        {truncated === null ? (
          text
        ) : (
          <>
            {/* Hidden from assistive tech: the shortened string is a visual convenience, and an
                address read out as "0x4f2a ellipsis 91bc" is worse than useless. `title` lives
                here rather than on the root so that hovering shows the full value without the
                accessibility tree seeing it twice. `select-none` keeps the shortened copy out of
                the clipboard, so selecting the line yields the full string below, once. */}
            <span aria-hidden="true" className="select-none" title={text}>
              {truncated}
            </span>
            <span className="sr-only">{text}</span>
          </>
        )}
        <span ref={probeRef} aria-hidden="true" style={PROBE_STYLE} />
      </span>
    )
  }
)
