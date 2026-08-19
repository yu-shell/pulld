"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface ImageComparisonProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange"> {
  /**
   * What the left of the divider shows — usually an `<img>`, but anything that fills a box
   * works (a `next/image`, a `<video>`, a canvas, a styled div).
   *
   * This one is laid out in normal flow, so it is what gives the component its height. Pass
   * the image whose aspect ratio the pair should be read at; the other is stretched to match.
   */
  before: React.ReactNode
  /** What the right of the divider shows. Overlaid on `before` and clipped to fit its box. */
  after: React.ReactNode
  /** Caption pinned to the top-left corner, e.g. "Original". Hidden once its side is closed. */
  beforeLabel?: React.ReactNode
  /** Caption pinned to the top-right corner, e.g. "Restored". Hidden once its side is closed. */
  afterLabel?: React.ReactNode
  /**
   * Where the divider starts, as a percentage of the width from the left (default 50).
   * Ignored once `position` is passed.
   */
  defaultPosition?: number
  /** Divider position for a controlled component. Values outside 0–100 are clamped. */
  position?: number
  /** Called with the new position on every drag frame and every key press. */
  onPositionChange?: (position: number) => void
  /**
   * How far one arrow key moves the divider, in percent (default 1). Page Up and Page Down
   * move ten of these; Home and End jump to the ends. Dragging is unaffected — a pointer is
   * continuous and stepping it would only make it stutter.
   */
  keyboardStep?: number
  /** Accessible name for the divider, e.g. "Compare original and restored". */
  "aria-label"?: string
  /** Classes for the divider line and its knob, e.g. "bg-primary". */
  handleClassName?: string
}

const DEFAULT_POSITION = 50

/**
 * Arrow keys move by one step; Page Up/Down by ten. Up and Right increase, per WAI-ARIA.
 *
 * Typed as possibly undefined so that the lookup below has to be checked: with a plain
 * `Record<string, number>` every key on the keyboard would come back typed as a number.
 */
const KEY_STEPS: Record<string, number | undefined> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  PageUp: 10,
  PageDown: -10,
}

function clampPosition(n: number): number {
  // NaN fails both comparisons and would otherwise reach clip-path as "NaN%", which most
  // browsers drop — leaving the after image uncut and the comparison silently broken.
  if (!Number.isFinite(n)) return DEFAULT_POSITION
  return n < 0 ? 0 : n > 100 ? 100 : n
}

/**
 * The next position on the step's own grid, in the direction of travel.
 *
 * Stepping by addition alone would carry the fractional part of a drag forever: let go at
 * 37.42 and the arrow key takes you to 38.42, 39.42, and Page Up to 47.42. Snapping to the
 * grid instead means a keyboard user always lands on whole numbers they can predict, while
 * a press never moves less than the step or skips a stop.
 */
function stepFrom(position: number, step: number): number {
  const size = Math.abs(step)
  const grid = step > 0 ? Math.floor(position / size) : Math.ceil(position / size)
  return (grid + Math.sign(step)) * size
}

/**
 * A before/after slider: two images stacked in the same box with a divider you drag across
 * them. The left of the divider shows `before`, the right shows `after`.
 *
 * ```tsx
 * <ImageComparison
 *   className="aspect-video"
 *   before={<img src="/before.jpg" alt="The kitchen before the remodel" />}
 *   after={<img src="/after.jpg" alt="The kitchen after the remodel" />}
 *   beforeLabel="Before"
 *   afterLabel="After"
 * />
 * ```
 *
 * Both images stay in the accessibility tree — clipping is a visual effect, not a hiding
 * one — so a screen reader reads both alt texts and gets the comparison the sighted reader
 * is dragging for. Write the two alts as a pair that describes the difference, and give the
 * divider an `aria-label` naming what is being compared.
 */
export const ImageComparison = React.forwardRef<HTMLDivElement, ImageComparisonProps>(
  function ImageComparison(
    {
      className,
      before,
      after,
      beforeLabel,
      afterLabel,
      defaultPosition = DEFAULT_POSITION,
      position: positionProp,
      onPositionChange,
      keyboardStep = 1,
      handleClassName,
      "aria-label": ariaLabel = "Comparison slider",
      ...props
    },
    ref
  ) {
    const [uncontrolled, setUncontrolled] = React.useState(() =>
      clampPosition(defaultPosition)
    )
    const isControlled = positionProp !== undefined
    const position = clampPosition(isControlled ? positionProp : uncontrolled)

    const commit = React.useCallback(
      (next: number) => {
        const value = clampPosition(next)
        if (!isControlled) setUncontrolled(value)
        onPositionChange?.(value)
      },
      [isControlled, onPositionChange]
    )

    const step = Number.isFinite(keyboardStep) && keyboardStep > 0 ? keyboardStep : 1

    const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return

      if (event.key === "Home" || event.key === "End") {
        event.preventDefault()
        commit(event.key === "Home" ? 0 : 100)
        return
      }

      const multiple = KEY_STEPS[event.key]
      if (multiple === undefined) return
      event.preventDefault()
      commit(stepFrom(position, multiple * step))
    }

    return (
      <div
        ref={ref}
        className={cn(
          "relative isolate select-none overflow-hidden rounded-md border border-border",
          className
        )}
        {...props}
      >
        {/*
          In flow, so the pair is as tall as this image renders — no aspect ratio to declare
          and no reflow when it loads. Give the wrapper a class instead of asking callers to
          style their own <img>: the component owns the box, and an image that keeps its
          intrinsic width would break the overlay's alignment with it.
        */}
        <div className="[&>*]:block [&>*]:h-auto [&>*]:w-full">{before}</div>

        {/*
          clip-path rather than a width-constrained wrapper with overflow hidden: the image
          keeps the full box as its layout size, so the visible sliver is the right-hand part
          of the same picture rather than a copy squeezed into a narrow column. object-cover
          absorbs a mismatch in aspect ratio, which is the honest failure — cropping the edges
          of one photo, instead of stretching it into disagreement with the other.
        */}
        <div
          className="absolute inset-0 [&>*]:h-full [&>*]:w-full [&>*]:object-cover"
          style={{ clipPath: `inset(0 0 0 ${position}%)` }}
        >
          {after}
        </div>

        {/*
          A real range input covering the whole picture, rather than pointer maths on the
          container. Dragging from anywhere, click-to-jump, pointer capture that survives the
          cursor leaving the box, touch, arrow keys, and a value announced by screen readers
          all come from the platform, and none of them is what a hand-rolled version gets
          right — those usually ship a mousedown/mousemove pair, which strands the divider
          when the pointer leaves and cannot be operated from the keyboard at all.

          - step="any" so a drag is continuous; keys are handled above, where a countable step
            is what a keyboard wants.
          - The thumb is one pixel wide, because a range maps the pointer onto the track minus
            the thumb's width. A default thumb is about 16px, which would leave the drawn
            divider drifting up to 8px away from the finger near the edges.
          - touch-action: pan-y, so a vertical swipe over the picture still scrolls the page.
            The input covers everything, so the alternative is an image you cannot scroll past
            on a phone.
          - dir="ltr", because value 0 has to mean the left edge whatever the page direction:
            the divider is a place on a picture, not a position in a line of text.
          - Transparent, not hidden: opacity keeps it focusable and operable while the visible
            handle below is drawn to the theme, and peer-focus-visible moves the focus ring
            onto that handle.
        */}
        <input
          type="range"
          min={0}
          max={100}
          step="any"
          value={position}
          onChange={(event) => commit(event.currentTarget.valueAsNumber)}
          onKeyDown={handleKeyDown}
          dir="ltr"
          aria-label={ariaLabel}
          aria-valuetext={`${Math.round(position)}%`}
          className={cn(
            "peer absolute inset-0 z-10 m-0 h-full w-full cursor-ew-resize touch-pan-y appearance-none bg-transparent p-0 opacity-0",
            "[&::-webkit-slider-thumb]:h-full [&::-webkit-slider-thumb]:w-px [&::-webkit-slider-thumb]:appearance-none",
            "[&::-moz-range-thumb]:h-full [&::-moz-range-thumb]:w-px [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:border-0"
          )}
        />

        {/*
          The line and the knob are siblings of the input rather than one nested pair, because
          peer variants reach siblings only — a knob inside the line would never see focus.
        */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-background shadow-sm peer-focus-visible:bg-ring",
            handleClassName
          )}
          style={{ left: `${position}%` }}
        />
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 z-20 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
            handleClassName
          )}
          style={{ left: `${position}%` }}
        >
          {/* Inline, so the component costs no icon dependency for its one glyph. */}
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m14 7 5 5-5 5M10 7l-5 5 5 5" />
          </svg>
        </div>

        {/*
          A caption for a side with no width left is a caption sitting on the other picture,
          so each one goes when its side closes. Hidden from assistive technology either way:
          they name the two images, which have alt text of their own, and the divider is
          already announced with a name and a percentage.
        */}
        {beforeLabel != null ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute left-2 top-2 z-20 rounded-sm bg-background/80 px-1.5 py-0.5 text-xs font-medium text-foreground backdrop-blur-sm transition-opacity",
              position <= 0 && "opacity-0"
            )}
          >
            {beforeLabel}
          </span>
        ) : null}
        {afterLabel != null ? (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute right-2 top-2 z-20 rounded-sm bg-background/80 px-1.5 py-0.5 text-xs font-medium text-foreground backdrop-blur-sm transition-opacity",
              position >= 100 && "opacity-0"
            )}
          >
            {afterLabel}
          </span>
        ) : null}
      </div>
    )
  }
)
