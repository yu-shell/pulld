"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** A point in the frame's own coordinates: CSS pixels from the inside of its top-left corner. */
export interface ZoomPoint {
  x: number
  y: number
}

/** A box in CSS pixels. */
export interface ZoomSize {
  width: number
  height: number
}

/**
 * Where the content sits, as `translate(x, y) scale(scale)` with the origin pinned to the frame's
 * top-left: a point `p` of the unzoomed content is drawn at `p * scale + (x, y)`.
 *
 * The origin is the corner rather than the centre on purpose. With a centred origin the same
 * translation means a different thing at every zoom level, and every calculation below would have
 * to carry the frame's size around to say where anything is.
 */
export interface ZoomTransform {
  scale: number
  x: number
  y: number
}

export const DEFAULT_MIN_SCALE = 1
export const DEFAULT_MAX_SCALE = 8

/** Unzoomed, unpanned: the content exactly covering the frame. */
export const IDENTITY_TRANSFORM: ZoomTransform = { scale: 1, x: 0, y: 0 }

/** What one press of a zoom button, or of `+` / `-`, multiplies the scale by. */
const DEFAULT_ZOOM_STEP = 1.5
/** How far one arrow key slides the content, in CSS pixels. */
const DEFAULT_PAN_STEP = 40
/** What a double click zooms to when the content is sitting at its minimum. */
const DOUBLE_CLICK_STEP = 2.5

/**
 * Wheel deltas do not arrive in one unit. Chrome and Safari report pixels, Firefox reports lines,
 * and a wheel bound to page scrolling reports pages. Reading `deltaY` without `deltaMode` is the
 * bug that makes a zoom feel right in Chrome and roughly sixteen times too slow in Firefox.
 */
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 400

/**
 * No single event may move more than this many pixels' worth of zoom. Some devices and some
 * browsers emit one enormous delta for a flick, which without a cap jumps from 1x to the maximum
 * in a single notch and looks like a glitch rather than a zoom.
 */
const MAX_WHEEL_PIXELS = 120

/** Chosen so one ordinary mouse notch (about 100px) is a ~1.4x step. */
const WHEEL_SPEED = 0.0035

/** Scales closer than this are the same scale, for deciding whether anything actually moved. */
const EPSILON = 1e-6

/**
 * The wheel delta in pixels, whatever unit the browser reported it in, capped both ways.
 *
 * Non-finite deltas come back as zero rather than propagating: a NaN here would reach `Math.exp`,
 * come back NaN, and settle into the transform as a scale that no later clamp can recover from.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number = 0): number {
  if (!Number.isFinite(deltaY)) return 0
  const unit = deltaMode === 1 ? PIXELS_PER_LINE : deltaMode === 2 ? PIXELS_PER_PAGE : 1
  const pixels = deltaY * unit
  if (pixels > MAX_WHEEL_PIXELS) return MAX_WHEEL_PIXELS
  if (pixels < -MAX_WHEEL_PIXELS) return -MAX_WHEEL_PIXELS
  return pixels
}

/**
 * What to multiply the scale by for one wheel event.
 *
 * Exponential rather than linear, because zoom is multiplicative: `exp(-d)` and `exp(d)` are
 * reciprocals, so rolling the wheel back the same distance lands on the scale you started from.
 * The obvious `1 - delta * k` does not have that property — scroll in and back out and the picture
 * ends up slightly smaller every time, which over a minute of fiddling is very noticeable and
 * impossible to attribute to anything.
 */
export function wheelScaleFactor(deltaY: number, deltaMode: number = 0): number {
  return Math.exp(-normalizeWheelDelta(deltaY, deltaMode) * WHEEL_SPEED)
}

export function clampScale(
  scale: number,
  minScale: number = DEFAULT_MIN_SCALE,
  maxScale: number = DEFAULT_MAX_SCALE
): number {
  // An infinity is a real request — "as far in as it will go" — and the comparisons below land it
  // on the limit it was heading for. NaN is not: it fails both comparisons and would reach the
  // style as "scale(NaN)", which browsers drop, leaving a frame that has quietly stopped
  // responding to the wheel. The coercion is what catches a value that is not a number at all,
  // since Number.isNaN alone answers false for undefined and lets it through to the same place.
  if (Number.isNaN(Number(scale))) return minScale
  return scale < minScale ? minScale : scale > maxScale ? maxScale : scale
}

/** Which point of the unzoomed content is drawn under `point`. The inverse of the transform. */
export function contentPointAt(transform: ZoomTransform, point: ZoomPoint): ZoomPoint {
  if (!Number.isFinite(transform.scale) || transform.scale <= 0) return { x: 0, y: 0 }
  return {
    x: (point.x - transform.x) / transform.scale,
    y: (point.y - transform.y) / transform.scale,
  }
}

/**
 * Zoom to `requestedScale` while leaving whatever is under `point` exactly where it is.
 *
 * This is the one piece of arithmetic in the component, and the thing every naive zoom gets wrong.
 * Applying `scale()` about the centre of the frame is a one-line change that looks correct on a
 * photo of the sky and is useless on anything you would actually want to zoom: the detail you
 * pointed at slides toward the edge as you go in, faster the further from the middle it started,
 * so reading a label on a diagram becomes a game of zoom-then-drag-it-back.
 *
 * Keeping it still is just solving for the new translation. The content point under the cursor is
 * `p = (point - t) / s`; it stays under the cursor when `p * s' + t' = point`, so
 * `t' = point - (point - t) * s'/s`.
 *
 * The scale is clamped *before* the translation is solved. That ordering is why this is one
 * function and not a `clampScale` the caller remembers to apply afterwards: clamp second and every
 * wheel notch past the maximum still shifts the picture sideways, because the translation answers
 * a zoom level the content never reached. Here it cannot be got wrong from outside.
 */
export function zoomAt(
  transform: ZoomTransform,
  point: ZoomPoint,
  requestedScale: number,
  minScale: number = DEFAULT_MIN_SCALE,
  maxScale: number = DEFAULT_MAX_SCALE
): ZoomTransform {
  const scale = clampScale(requestedScale, minScale, maxScale)
  if (!Number.isFinite(transform.scale) || transform.scale <= 0) return { scale, x: 0, y: 0 }
  const ratio = scale / transform.scale
  return {
    scale,
    x: point.x - (point.x - transform.x) * ratio,
    y: point.y - (point.y - transform.y) * ratio,
  }
}

/**
 * One axis of the pan limit: the content may not be dragged away from the frame it fills.
 *
 * `extent` is the frame, `natural` the content's unzoomed length along the same axis. Drawn
 * smaller than the frame it is centred rather than clamped, because there is no inside to slide
 * to — and leaving it where the arithmetic put it lets a zoomed-out picture sit in a corner with
 * a wedge of background beside it.
 */
function clampAxis(offset: number, extent: number, natural: number, scale: number): number {
  const drawn = natural * scale
  const centred = (extent - drawn) / 2
  if (!Number.isFinite(drawn) || !Number.isFinite(offset)) return Number.isFinite(centred) ? centred : 0
  if (drawn <= extent) return centred
  const min = extent - drawn
  return offset > 0 ? 0 : offset < min ? min : offset
}

/**
 * Keep the content covering the frame.
 *
 * `content` is the content's size *before* zoom. It is passed separately rather than assumed equal
 * to the frame, because a caller who gives the frame its own height gets letterboxing, and reading
 * the limit off the frame in that case lets the picture be dragged until it is half off screen.
 */
export function clampPan(
  transform: ZoomTransform,
  viewport: ZoomSize,
  content: ZoomSize = viewport
): ZoomTransform {
  return {
    scale: transform.scale,
    x: clampAxis(transform.x, viewport.width, content.width, transform.scale),
    y: clampAxis(transform.y, viewport.height, content.height, transform.scale),
  }
}

function sameTransform(a: ZoomTransform, b: ZoomTransform): boolean {
  return (
    Math.abs(a.scale - b.scale) < EPSILON &&
    Math.abs(a.x - b.x) < EPSILON &&
    Math.abs(a.y - b.y) < EPSILON
  )
}

function distance(a: ZoomPoint, b: ZoomPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function midpoint(a: ZoomPoint, b: ZoomPoint): ZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

export interface ImageZoomProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange" | "children"> {
  /**
   * What to zoom — usually an `<img>`, but any single box works (a `next/image`, an `<svg>` chart,
   * a map tile, a `<canvas>`). It is laid out in normal flow at full width, so it is what gives the
   * frame its height and there is no aspect ratio to declare. Transforms do not affect layout, so
   * the frame keeps that height however far in you zoom.
   */
  children: React.ReactNode
  /** How far out the content can go, as a multiple of its fitted size (default 1 — no zooming out). */
  minScale?: number
  /** How far in the content can go (default 8). */
  maxScale?: number
  /** What one button press, or one `+` / `-`, multiplies the scale by (default 1.5). */
  zoomStep?: number
  /** How far one arrow key slides the content, in pixels (default 40). */
  panStep?: number
  /** Where the content starts. Ignored once `transform` is passed. */
  defaultTransform?: ZoomTransform
  /** The transform for a controlled component. Clamped on the way in. */
  transform?: ZoomTransform
  /** Called with the clamped transform whenever it changes. */
  onTransformChange?: (transform: ZoomTransform) => void
  /** Show the zoom in / out / reset buttons and the percentage (default true). */
  showControls?: boolean
  /** Classes for the controls cluster, e.g. "bottom-2 top-auto". */
  controlsClassName?: string
  /** Accessible name for the frame, e.g. "Floor plan, scroll to zoom". */
  "aria-label"?: string
}

const ICON = {
  in: "M12 9v6M9 12h6",
  out: "M9 12h6",
  reset: "M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3",
}

/**
 * A frame that zooms what is inside it with the wheel, a trackpad pinch or a double click, and
 * lets you drag it around once it no longer fits.
 *
 * ```tsx
 * <ImageZoom aria-label="Site plan, scroll to zoom">
 *   <img src="/site-plan.png" alt="Site plan of the north building" />
 * </ImageZoom>
 * ```
 *
 * Everything the pointer can do has a keyboard equivalent, because none of the gestures have one
 * on their own: the frame is a tab stop, `+` and `-` zoom about its centre, the arrow keys pan,
 * and `0` resets. The buttons do the same and are the reliable way in on a phone, where the first
 * pinch may still belong to the browser (see the note on `touch-action` below).
 */
export const ImageZoom = React.forwardRef<HTMLDivElement, ImageZoomProps>(function ImageZoom(
  {
    className,
    style,
    children,
    minScale = DEFAULT_MIN_SCALE,
    maxScale = DEFAULT_MAX_SCALE,
    zoomStep = DEFAULT_ZOOM_STEP,
    panStep = DEFAULT_PAN_STEP,
    defaultTransform,
    transform: transformProp,
    onTransformChange,
    showControls = true,
    controlsClassName,
    "aria-label": ariaLabel = "Zoomable image",
    ...props
  },
  ref
) {
  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  React.useImperativeHandle(ref, () => frameRef.current as HTMLDivElement, [])

  const resting = React.useMemo<ZoomTransform>(
    () => ({ scale: clampScale(minScale, minScale, maxScale), x: 0, y: 0 }),
    [minScale, maxScale]
  )

  const [uncontrolled, setUncontrolled] = React.useState<ZoomTransform>(
    () => defaultTransform ?? resting
  )
  const isControlled = transformProp !== undefined
  const raw = isControlled ? transformProp : uncontrolled
  const transform: ZoomTransform = {
    scale: clampScale(raw.scale, minScale, maxScale),
    x: Number.isFinite(raw.x) ? raw.x : 0,
    y: Number.isFinite(raw.y) ? raw.y : 0,
  }

  /**
   * The frame and the unzoomed content, in CSS pixels.
   *
   * `clientWidth` rather than the bounding rect, because that is the box the content is laid out
   * in — the rect includes the border, and measuring the limit a border too wide lets the picture
   * be dragged a pixel past the edge at every zoom level. `offsetWidth` on the content for the
   * same reason it is used at all: it is a layout value, so it reports the unzoomed size while a
   * bounding rect would report the zoomed one and fold the answer back into its own question.
   *
   * Zero before the first layout, which is also the server's answer; every caller below treats a
   * zero frame as "nothing to clamp against yet" rather than as a real limit.
   */
  const measure = React.useCallback(() => {
    const frame = frameRef.current
    const content = contentRef.current
    return {
      viewport: { width: frame?.clientWidth ?? 0, height: frame?.clientHeight ?? 0 },
      content: { width: content?.offsetWidth ?? 0, height: content?.offsetHeight ?? 0 },
    }
  }, [])

  const commit = React.useCallback(
    (next: ZoomTransform) => {
      const { viewport, content } = measure()
      const value = clampPan(
        { ...next, scale: clampScale(next.scale, minScale, maxScale) },
        viewport,
        content.width > 0 && content.height > 0 ? content : viewport
      )
      if (!isControlled) setUncontrolled(value)
      onTransformChange?.(value)
      return value
    },
    [isControlled, maxScale, measure, minScale, onTransformChange]
  )

  /** Where a pointer event landed, inside the frame's own box. */
  const pointFrom = React.useCallback((event: { clientX: number; clientY: number }): ZoomPoint => {
    const frame = frameRef.current
    const box = frame?.getBoundingClientRect?.()
    // clientX minus the box rather than offsetX: once a drag is captured the pointer keeps
    // reporting after it leaves the frame, and offsetX is then measured against whatever it is
    // over instead. clientLeft takes off the border, so the origin matches the content's.
    return {
      x: event.clientX - (box?.left ?? 0) - (frame?.clientLeft ?? 0),
      y: event.clientY - (box?.top ?? 0) - (frame?.clientTop ?? 0),
    }
  }, [])

  const centre = React.useCallback((): ZoomPoint => {
    const { viewport } = measure()
    return { x: viewport.width / 2, y: viewport.height / 2 }
  }, [measure])

  const zoomBy = React.useCallback(
    (factor: number, at?: ZoomPoint) =>
      commit(zoomAt(transform, at ?? centre(), transform.scale * factor, minScale, maxScale)),
    [centre, commit, maxScale, minScale, transform]
  )

  const canZoomIn = transform.scale < maxScale - EPSILON
  const canZoomOut = transform.scale > minScale + EPSILON
  const isReset = sameTransform(transform, resting)

  /**
   * The wheel listener is attached by hand, with `passive: false`.
   *
   * React attaches its own `onWheel` passively in several browsers, and a passive listener's
   * `preventDefault` is ignored with a console warning — so the frame zooms *and* the page scrolls
   * out from under it. There is no prop that fixes that; the listener has to be registered here.
   *
   * It is registered once. The handler it calls is kept in a ref and replaced every render, so the
   * listener always runs against the current transform without the frame re-subscribing on every
   * notch of the wheel.
   */
  const wheelHandler = React.useRef<(event: WheelEvent) => void>(() => {})
  React.useEffect(() => {
    wheelHandler.current = (event: WheelEvent) => {
      // A trackpad pinch arrives here as a wheel event with ctrlKey set — it is not a separate
      // gesture, and a component that only listens for touch events pinches on a phone and does
      // nothing at all on a laptop. Both paths want the same thing, so both take this one.
      const next = zoomAt(
        transform,
        pointFrom(event),
        transform.scale * wheelScaleFactor(event.deltaY, event.deltaMode),
        minScale,
        maxScale
      )
      // Claim the gesture only when it was used. At rest, a wheel that would zoom further out
      // changes nothing, so the event is left alone and the page scrolls on past — which is what
      // stops a full-width frame from being a hole you cannot scroll through on the way down.
      if (sameTransform(next, transform)) return
      event.preventDefault()
      commit(next)
    }
  })
  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame?.addEventListener) return
    const listener = (event: WheelEvent) => wheelHandler.current(event)
    frame.addEventListener("wheel", listener, { passive: false })
    return () => frame.removeEventListener("wheel", listener)
  }, [])

  /**
   * Re-clamp when the frame changes size. Without this, a phone rotated while zoomed in keeps the
   * offsets it worked out for the old width and the picture stays stuck off to one side — the
   * limits are only ever recomputed on the next gesture, and there may not be one.
   */
  const reclamp = React.useRef<() => void>(() => {})
  React.useEffect(() => {
    reclamp.current = () => commit(transform)
  })
  React.useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => reclamp.current())
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  const pointers = React.useRef(new Map<number, ZoomPoint>())
  const pinch = React.useRef<{ distance: number; centre: ZoomPoint } | null>(null)
  const [dragging, setDragging] = React.useState(false)

  const twoPointers = (): [ZoomPoint, ZoomPoint] | null => {
    const points = [...pointers.current.values()]
    return points.length >= 2 ? [points[0], points[1]] : null
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    pointers.current.set(event.pointerId, pointFrom(event))
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const pair = twoPointers()
    if (pair) {
      pinch.current = { distance: distance(pair[0], pair[1]), centre: midpoint(pair[0], pair[1]) }
      setDragging(false)
    } else if (canZoomOut) {
      setDragging(true)
    }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const previous = pointers.current.get(event.pointerId) as ZoomPoint
    const current = pointFrom(event)
    pointers.current.set(event.pointerId, current)

    const pair = twoPointers()
    if (pair && pinch.current) {
      const spread = distance(pair[0], pair[1])
      const anchor = midpoint(pair[0], pair[1])
      if (spread <= 0 || pinch.current.distance <= 0) return
      // Measured against the last frame rather than the start of the gesture, so the two fingers
      // can also slide the picture while they are pinching: the scale comes from how far apart
      // they are now, and the pan from how far their midpoint has travelled since. The previous
      // midpoint has to be read before the ref is replaced — overwrite it first and the pan term
      // is always zero, which looks like a pinch that works but refuses to be moved.
      const previousCentre = pinch.current.centre
      const zoomed = zoomAt(
        transform,
        anchor,
        transform.scale * (spread / pinch.current.distance),
        minScale,
        maxScale
      )
      pinch.current = { distance: spread, centre: anchor }
      commit({
        ...zoomed,
        x: zoomed.x + (anchor.x - previousCentre.x),
        y: zoomed.y + (anchor.y - previousCentre.y),
      })
      return
    }

    if (!dragging) return
    commit({
      ...transform,
      x: transform.x + (current.x - previous.x),
      y: transform.y + (current.y - previous.y),
    })
  }

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    event.currentTarget.releasePointerCapture?.(event.pointerId)
    // The pinch is not cleared here on purpose. It is read only while two pointers are down, and
    // the second pointer's own `pointerdown` always rewrites it first, so a value left behind by a
    // finished gesture can never be reached — clearing it would be a line no test could hold.
    if (pointers.current.size === 0) setDragging(false)
  }

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isReset) zoomBy(DOUBLE_CLICK_STEP, pointFrom(event))
    else commit(resting)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const pan: Record<string, ZoomPoint | undefined> = {
      ArrowLeft: { x: panStep, y: 0 },
      ArrowRight: { x: -panStep, y: 0 },
      ArrowUp: { x: 0, y: panStep },
      ArrowDown: { x: 0, y: -panStep },
    }
    // The arrows move the *view*, so the content slides the other way — pressing Right looks at
    // what is to the right, the way it works in every map and every image viewer.
    const nudge = pan[event.key]
    if (nudge) {
      if (!canZoomOut) return
      event.preventDefault()
      commit({ ...transform, x: transform.x + nudge.x, y: transform.y + nudge.y })
      return
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault()
      zoomBy(zoomStep)
      return
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault()
      zoomBy(1 / zoomStep)
      return
    }
    if (event.key === "0") {
      event.preventDefault()
      commit(resting)
    }
  }

  const button = (
    label: string,
    path: string,
    enabled: boolean,
    onPress: () => void
  ) => (
    <button
      type="button"
      aria-label={label}
      aria-disabled={!enabled}
      onClick={() => {
        if (enabled) onPress()
      }}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        enabled ? "hover:bg-accent hover:text-accent-foreground" : "cursor-not-allowed opacity-50"
      )}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    </button>
  )

  return (
    <div
      {...props}
      ref={frameRef}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative isolate select-none overflow-hidden rounded-md border border-border bg-muted/20",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        canZoomOut ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in",
        className
      )}
      style={{
        ...style,
        // pan-y while the content fits, so a vertical swipe still scrolls the page and a
        // full-width frame is not a trap on a phone. `none` once it does not, because from then on
        // every touch in here is a pan or a pinch and the browser must not take them first. The
        // cost is that the very first pinch at rest may be claimed by the browser instead — which
        // is why the buttons and the double tap exist, and why they are never disabled on touch.
        touchAction: canZoomOut ? "none" : "pan-y",
      }}
    >
      {/*
        In flow and full width, so the untransformed content is what gives the frame its height —
        no aspect ratio to declare and no reflow when the image loads. The transform is painted
        only, so the frame keeps that height at every zoom level.
      */}
      <div
        ref={contentRef}
        className="origin-top-left [&>*]:block [&>*]:h-auto [&>*]:w-full"
        style={{
          transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
        }}
      >
        {children}
      </div>

      {showControls ? (
        <div
          className={cn("absolute right-2 top-2 z-10 flex items-center gap-1", controlsClassName)}
          // The buttons sit on the picture, which is also the drag surface. Without this a click
          // on "zoom in" starts a drag underneath it and the picture lurches as the button is
          // pressed; the buttons put their own pointer events back on.
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {/*
            Announced politely rather than hidden, so a screen reader user pressing + hears where
            they got to. It is the same text sighted users read, so there is no second copy to
            drift out of step with this one.
          */}
          <span
            aria-live="polite"
            aria-atomic="true"
            className="rounded-md border border-border bg-background/90 px-1.5 py-0.5 text-xs font-medium tabular-nums text-muted-foreground shadow-sm backdrop-blur-sm"
          >
            {Math.round(transform.scale * 100)}%
          </span>
          {button("Zoom out", ICON.out, canZoomOut, () => zoomBy(1 / zoomStep))}
          {button("Zoom in", ICON.in, canZoomIn, () => zoomBy(zoomStep))}
          {button("Reset zoom", ICON.reset, !isReset, () => commit(resting))}
        </div>
      ) : null}
    </div>
  )
})
