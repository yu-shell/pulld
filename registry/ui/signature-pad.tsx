"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** One sampled point of a stroke, in CSS pixels from the top-left of the drawing box. */
export interface SignaturePoint {
  x: number
  y: number
}

/** One continuous press-drag-release. A tap that never moved is a stroke of one point. */
export type SignatureStroke = SignaturePoint[]

/**
 * What was signed, in the two forms a signature can take here.
 *
 * The drawn form carries the box it was drawn in. The strokes are CSS pixels, not fractions, so
 * without the box they cannot be laid out again — and a signature is stored to be shown later, in
 * a receipt, a PDF or an audit screen that is never the width of the pad it was drawn on.
 */
export type SignatureValue =
  | { type: "drawn"; strokes: SignatureStroke[]; width: number; height: number }
  | { type: "typed"; name: string }

/** The geometry of one stroke: a dot, or a start point and the curve segments after it. */
export type StrokeGeometry =
  | { kind: "dot"; x: number; y: number }
  | { kind: "path"; start: SignaturePoint; segments: SignatureSegment[] }

/** A quadratic segment: control point `c`, end point `x`/`y`. */
export interface SignatureSegment {
  cx: number
  cy: number
  x: number
  y: number
}

export interface SignaturePadProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange" | "defaultValue"> {
  /** Accessible name for the whole control, e.g. "Signature". Rendered as its label. */
  label?: React.ReactNode
  /** Height of the drawing box in CSS pixels (default 160). The width is fluid. */
  height?: number
  /** Signature for a controlled component. Pass `null` for "not signed yet". */
  value?: SignatureValue | null
  /** Starting signature for an uncontrolled component. */
  defaultValue?: SignatureValue | null
  /** Called when a stroke finishes, when the typed name changes, and on undo and clear. */
  onChange?: (value: SignatureValue | null) => void
  /** Ink colour. Any CSS colour; defaults to the theme's foreground. */
  penColor?: string
  /** Ink width in CSS pixels (default 2). */
  penWidth?: number
  /**
   * Ceiling on the device pixel ratio the backing store is drawn at (default 3).
   *
   * A 4x phone would otherwise allocate sixteen pixels of memory per CSS pixel to render a line
   * nobody can see the difference in.
   */
  maxPixelRatio?: number
  /** Turns off drawing and typing, and dims the box. */
  disabled?: boolean
  /**
   * Whether to offer the typed-name field (default true).
   *
   * Turning it off leaves the signature reachable by pointer only. See the note on the component.
   */
  allowTyped?: boolean
  /**
   * Submits the signature with a plain HTML form under this name, as an `image/svg+xml` data URL
   * for a drawn signature and as the plain text for a typed one.
   */
  name?: string
  /** Marks the field required, both for the form and for assistive technology. */
  required?: boolean
  /** Instruction under the box. Defaults to a sentence naming all three input devices. */
  hint?: React.ReactNode
  /** Label for the typed-name field. */
  typedLabel?: React.ReactNode
  /** Text between the two ways of signing. */
  dividerLabel?: React.ReactNode
  /** Labels for the two buttons and the announcements, for translation. */
  labels?: Partial<typeof DEFAULT_LABELS>
  /** Classes for the drawing box itself. */
  canvasClassName?: string
}

/** What the imperative ref exposes, for a submit handler that needs the image. */
export interface SignaturePadHandle {
  /** Removes every stroke and the typed name. */
  clear: () => void
  /** Removes the last stroke. Does nothing to a typed name. */
  undo: () => void
  /** Whether nothing has been signed. */
  isEmpty: () => boolean
  /** The current value, the same object `onChange` last reported. */
  getValue: () => SignatureValue | null
  /** The signature as an SVG document, or `null` when empty. */
  toSVG: (options?: SignatureExportOptions) => string | null
  /** The signature as a raster data URL, or `null` when empty. Browser only. */
  toDataURL: (options?: SignatureRasterOptions) => string | null
}

export interface SignatureExportOptions {
  /** Ink colour. Defaults to the pen colour in use. */
  penColor?: string
  /** Ink width. Defaults to the pen width in use. */
  penWidth?: number
  /**
   * Colour painted behind the ink. Defaults to none — see the note on `toDataURL` about what
   * a transparent signature does when it lands somewhere dark.
   */
  backgroundColor?: string
  /** Crops to the ink plus this much padding, instead of keeping the whole box. */
  trim?: boolean | number
}

export interface SignatureRasterOptions extends SignatureExportOptions {
  /** MIME type, e.g. `"image/jpeg"` (default `"image/png"`). */
  type?: string
  /** Quality for lossy types, 0–1. */
  quality?: number
  /** Pixels per CSS pixel in the output (default 2). */
  scale?: number
}

const DEFAULT_LABELS = {
  clear: "Clear",
  undo: "Undo",
  /** Announced once when a stroke or a name lands, not on every sample. */
  signed: "Signature captured.",
  signedAs: (name: string) => `Signed as ${name}.`,
  cleared: "Signature cleared.",
}

const DEFAULT_HEIGHT = 160
const DEFAULT_PEN_WIDTH = 2
const DEFAULT_MAX_PIXEL_RATIO = 3
const TRIM_PADDING = 8

/**
 * The font a typed name is drawn in. A typed signature that renders in the page's body font reads
 * as a form field someone forgot to style rather than as a mark someone made, so the fallbacks run
 * through the script faces the three desktop platforms ship before giving up on `cursive`.
 */
const SCRIPT_FONT =
  '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", cursive'

const midpoint = (a: SignaturePoint, b: SignaturePoint): SignaturePoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
})

/**
 * The curve through one stroke's sampled points.
 *
 * A stroke is a list of places a pointer was seen, and joining them with straight lines is what
 * makes a fast signature come out as a polygon — the corners are not in the hand, they are in the
 * sampling. Each sampled point becomes the control point of a quadratic instead, and the curve
 * passes through the midpoints between them, so the drawn line is tangent to the path the hand
 * took and has no corners of its own.
 *
 * The last segment is a quadratic whose control point is its own end, which is a straight line —
 * so the stroke reaches the final sample exactly rather than stopping half a sample short of where
 * the pen came up. One shape for every segment keeps this function, the incremental drawing during
 * a stroke and the SVG export provably in agreement: all three consume this list.
 */
export function strokeGeometry(points: SignatureStroke): StrokeGeometry | null {
  if (!points || points.length === 0) return null
  if (points.length === 1) return { kind: "dot", x: points[0].x, y: points[0].y }

  const segments: SignatureSegment[] = []
  for (let i = 1; i < points.length - 1; i++) {
    const end = midpoint(points[i], points[i + 1])
    segments.push({ cx: points[i].x, cy: points[i].y, x: end.x, y: end.y })
  }
  const last = points[points.length - 1]
  segments.push({ cx: last.x, cy: last.y, x: last.x, y: last.y })
  return { kind: "path", start: points[0], segments }
}

/** Trims trailing zeros off a rounded number so the SVG path stays short. */
const num = (n: number): string => String(Math.round(n * 100) / 100)

/** The `d` attribute for one stroke, or `null` for a stroke that is a dot or is empty. */
export function strokePathData(points: SignatureStroke): string | null {
  const geometry = strokeGeometry(points)
  if (!geometry || geometry.kind !== "path") return null
  let d = `M${num(geometry.start.x)} ${num(geometry.start.y)}`
  for (const s of geometry.segments) d += `Q${num(s.cx)} ${num(s.cy)} ${num(s.x)} ${num(s.y)}`
  return d
}

/** Whether anything has actually been signed. A blank or whitespace-only name has not. */
export function isSignatureEmpty(value: SignatureValue | null | undefined): boolean {
  if (!value) return true
  if (value.type === "typed") return value.name.trim().length === 0
  return value.strokes.every((stroke) => stroke.length === 0)
}

/**
 * The box the ink occupies, in the coordinates of the drawing box, or `null` when there is none.
 *
 * A quadratic Bézier stays inside the triangle of its own start, control and end points, so taking
 * the extremes of those three is a true bound without solving for the curve at all — which is the
 * only reason a smoothed stroke can be trimmed cheaply. Half the pen width is added on every side
 * because the line is drawn centred on the path, and a round cap puts that much ink past the final
 * point too. Without that the trimmed export clips exactly half the outermost stroke, which on a
 * signature is the flourish somebody looks at to recognise it.
 */
export function signatureBounds(
  strokes: SignatureStroke[],
  penWidth: number = DEFAULT_PEN_WIDTH
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const include = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }

  for (const stroke of strokes) {
    const geometry = strokeGeometry(stroke)
    if (!geometry) continue
    if (geometry.kind === "dot") {
      include(geometry.x, geometry.y)
      continue
    }
    include(geometry.start.x, geometry.start.y)
    for (const s of geometry.segments) {
      include(s.cx, s.cy)
      include(s.x, s.y)
    }
  }

  if (minX === Infinity) return null
  const pad = Math.max(penWidth, 0) / 2
  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  }
}

/**
 * Escapes text for an XML attribute or text node.
 *
 * The typed name reaches the SVG as text and the colours reach it as attributes, and all three are
 * strings somebody else supplied. A name with an ampersand in it is enough to make the document
 * fail to parse, and a name that closes its own tag is worse than that — an SVG is a document, and
 * the one place a signature ends up is a page that renders it back.
 */
const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  )

/**
 * The signature as a standalone SVG document, or `null` when nothing is signed.
 *
 * SVG rather than a PNG is the default here because a signature is stored small and shown large:
 * printed onto a contract, scaled into a PDF, zoomed by somebody checking it. A raster of a 160px
 * box has one resolution forever, and it is the resolution of the pad it was drawn on.
 */
export function signatureToSvg(
  value: SignatureValue | null | undefined,
  {
    width = 320,
    height = DEFAULT_HEIGHT,
    penColor = "#000000",
    penWidth = DEFAULT_PEN_WIDTH,
    backgroundColor,
    trim = false,
  }: SignatureExportOptions & { width?: number; height?: number } = {}
): string | null {
  if (isSignatureEmpty(value) || !value) return null

  const open = (w: number, h: number, viewBox: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="${viewBox}">` +
    (backgroundColor
      ? `<rect width="100%" height="100%" fill="${escapeXml(backgroundColor)}"/>`
      : "")

  if (value.type === "typed") {
    const name = value.name.trim()
    // Sized off the box rather than measured: this function has no text metrics, and a signature
    // that renders slightly small is a better failure than one that needs a DOM to exist at all.
    const size = Math.min(height * 0.42, (width * 1.6) / Math.max(name.length, 1))
    return (
      open(width, height, `0 0 ${num(width)} ${num(height)}`) +
      `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"` +
      ` font-family="${escapeXml(SCRIPT_FONT)}" font-size="${num(size)}"` +
      ` fill="${escapeXml(penColor)}">${escapeXml(name)}</text></svg>`
    )
  }

  const box = trim === false ? null : signatureBounds(value.strokes, penWidth)
  const pad = typeof trim === "number" ? trim : TRIM_PADDING
  const viewBox = box
    ? `${num(box.x - pad)} ${num(box.y - pad)} ${num(box.width + pad * 2)} ${num(box.height + pad * 2)}`
    : `0 0 ${num(value.width)} ${num(value.height)}`
  const outW = box ? box.width + pad * 2 : value.width
  const outH = box ? box.height + pad * 2 : value.height

  let body = ""
  for (const stroke of value.strokes) {
    const geometry = strokeGeometry(stroke)
    if (!geometry) continue
    if (geometry.kind === "dot") {
      body += `<circle cx="${num(geometry.x)}" cy="${num(geometry.y)}" r="${num(penWidth / 2)}" fill="${escapeXml(penColor)}"/>`
    } else {
      body += `<path d="${strokePathData(stroke)}" fill="none" stroke="${escapeXml(penColor)}" stroke-width="${num(penWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`
    }
  }
  return open(outW, outH, viewBox) + body + "</svg>"
}

/**
 * The backing-store size for a box of `width` x `height` CSS pixels.
 *
 * A canvas has two sizes, and this is the one nearly every signature pad gets wrong. The CSS size
 * is how big the element is; the `width`/`height` attributes are how many pixels are actually
 * drawn, and they default to 300x150 regardless. Left alone, a 2x or 3x screen renders the box at
 * a third of its own resolution and then scales it up — and the thing that suffers most is a thin
 * line, which is the entire content here. A signature is identified by the weight and wobble of
 * its strokes, so blurring it is not a cosmetic loss.
 */
export function backingSize(
  width: number,
  height: number,
  pixelRatio: number,
  maxPixelRatio: number = DEFAULT_MAX_PIXEL_RATIO
): { width: number; height: number; ratio: number } {
  const ratio = Math.min(Math.max(Number.isFinite(pixelRatio) ? pixelRatio : 1, 1), maxPixelRatio)
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    ratio,
  }
}

const EMPTY_STROKES: SignatureStroke[] = []

const BUTTON_CLASS =
  "inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"

/** Paints one stroke onto a 2D context that is already scaled to CSS pixels. */
function paintStroke(ctx: CanvasRenderingContext2D, stroke: SignatureStroke, penWidth: number) {
  const geometry = strokeGeometry(stroke)
  if (!geometry) return
  if (geometry.kind === "dot") {
    ctx.beginPath()
    ctx.arc(geometry.x, geometry.y, penWidth / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.beginPath()
  ctx.moveTo(geometry.start.x, geometry.start.y)
  for (const s of geometry.segments) ctx.quadraticCurveTo(s.cx, s.cy, s.x, s.y)
  ctx.stroke()
}

/**
 * A place to sign: draw with a finger, mouse or pen, or type your name instead.
 *
 * ```tsx
 * const pad = React.useRef<SignaturePadHandle>(null)
 *
 * <SignaturePad
 *   label="Sign to confirm delivery"
 *   name="signature"
 *   required
 *   onChange={setSignature}
 *   ref={pad}
 * />
 * ```
 *
 * The typed field is not a convenience, and it is why this is a component rather than a canvas
 * with a listener on it. A canvas is a blank to a screen reader — there is nothing inside it to
 * read, and no `aria-label` changes that, because the label describes the box and the task is to
 * make a mark in it. Drawing is a pointer gesture, so a signature pad that only draws is a form
 * nobody using a keyboard, a switch or a screen reader can complete. Typing a full name is the
 * equivalent already recognised in practice and in law, so it is offered beside the box rather
 * than bolted on, and either one produces a value and an image. `allowTyped={false}` removes it,
 * and removes the only path some people have through the form; do it knowingly.
 */
export const SignaturePad = React.forwardRef<SignaturePadHandle, SignaturePadProps>(
  function SignaturePad(
    {
      className,
      label,
      height = DEFAULT_HEIGHT,
      value: valueProp,
      defaultValue = null,
      onChange,
      penColor,
      penWidth = DEFAULT_PEN_WIDTH,
      maxPixelRatio = DEFAULT_MAX_PIXEL_RATIO,
      disabled = false,
      allowTyped = true,
      name,
      required = false,
      hint,
      typedLabel = "Or type your full name to sign",
      dividerLabel = "or",
      labels,
      canvasClassName,
      ...props
    },
    ref
  ) {
    const text = { ...DEFAULT_LABELS, ...labels }
    const reactId = React.useId()
    const labelId = `${reactId}-label`
    const hintId = `${reactId}-hint`
    const typedId = `${reactId}-typed`

    const [uncontrolled, setUncontrolled] = React.useState<SignatureValue | null>(defaultValue)
    const isControlled = valueProp !== undefined
    const value = isControlled ? valueProp : uncontrolled

    const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
    const boxRef = React.useRef<HTMLDivElement | null>(null)
    /** The stroke being drawn right now, and where the last curve segment ended. */
    const drawing = React.useRef<{ pointerId: number; points: SignatureStroke; from: SignaturePoint } | null>(null)
    /** The resolved ink colour, read from the theme once the box is mounted. */
    const [inkColor, setInkColor] = React.useState(penColor)
    const [announcement, setAnnouncement] = React.useState("")

    const strokes = value?.type === "drawn" ? value.strokes : EMPTY_STROKES
    const typedName = value?.type === "typed" ? value.name : ""
    // Not "currentColor": a canvas context takes a colour, not a keyword from the cascade, and
    // assigning one it cannot parse is silently ignored — leaving whatever was set before.
    const ink = penColor ?? inkColor ?? "#000000"

    const commit = React.useCallback(
      (next: SignatureValue | null) => {
        if (!isControlled) setUncontrolled(next)
        onChange?.(next)
      },
      [isControlled, onChange]
    )

    // The pen colour defaults to whatever the theme paints text in, which means resolving a CSS
    // custom property to something the canvas can use: a context takes a colour string and knows
    // nothing about the cascade, so `--foreground` handed to `strokeStyle` is simply ignored and
    // the ink comes out black — invisible in dark mode, which is exactly where nobody tests it.
    React.useEffect(() => {
      if (penColor || !boxRef.current) return
      const resolved = getComputedStyle(boxRef.current).color
      if (resolved) setInkColor(resolved)
    }, [penColor])

    /**
     * Repaints everything. Called on mount, on resize, and after undo and clear — anything that
     * invalidates the pixels rather than adding to them. A stroke in progress does not come
     * through here; it draws only its newest segment, so a long signature costs the same per
     * sample as a short one.
     */
    const repaint = React.useCallback(() => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext?.("2d")
      if (!canvas || !ctx) return

      const box = canvas.getBoundingClientRect?.()
      const cssWidth = box?.width || 0
      const cssHeight = box?.height || height
      const backing = backingSize(cssWidth, cssHeight, globalThis.devicePixelRatio ?? 1, maxPixelRatio)

      // Assigning either attribute resets the whole context — transform, colours, and the pixels —
      // so it is done only when the size really changed. Writing the same number every frame would
      // otherwise erase the stroke being drawn.
      if (canvas.width !== backing.width || canvas.height !== backing.height) {
        canvas.width = backing.width
        canvas.height = backing.height
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }

      // setTransform, not scale: scale multiplies into whatever transform is already there, so a
      // pad that survives two resizes ends up drawing at 4x and the signature walks off the box.
      ctx.setTransform(backing.ratio, 0, 0, backing.ratio, 0, 0)
      ctx.lineWidth = penWidth
      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.strokeStyle = ink
      ctx.fillStyle = ink

      if (typedName.trim()) {
        const size = Math.min(cssHeight * 0.42, 64)
        ctx.font = `${size}px ${SCRIPT_FONT}`
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        ctx.fillText(typedName.trim(), cssWidth / 2, cssHeight / 2, Math.max(cssWidth - 24, 1))
        return
      }
      for (const stroke of strokes) paintStroke(ctx, stroke, penWidth)
    }, [height, ink, maxPixelRatio, penWidth, strokes, typedName])

    // Repaint whenever the value or the pen changes, and whenever the box is resized. The resize is
    // observed rather than listened for on the window, because the box also changes width when a
    // sidebar opens, a tab it lives in becomes visible, or a container query fires — none of which
    // is a window resize, and all of which would otherwise leave a stretched-looking signature.
    React.useEffect(() => {
      repaint()
      const node = canvasRef.current
      if (!node || typeof ResizeObserver === "undefined") return
      const observer = new ResizeObserver(() => repaint())
      observer.observe(node)
      return () => observer.disconnect()
    }, [repaint])

    /** Where a pointer event landed, in the box's own CSS pixels. */
    const pointFrom = (event: { clientX: number; clientY: number }): SignaturePoint => {
      const box = canvasRef.current?.getBoundingClientRect?.()
      // clientX minus the box, not offsetX: once the pointer is captured it keeps reporting after
      // it leaves the element, and offsetX is then measured against whatever it is over instead.
      return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
    }

    const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (disabled) return
      // A right-click or a two-finger press is not a stroke, and a stroke started by one never
      // gets a matching pointerup.
      if (event.pointerType === "mouse" && event.button !== 0) return
      // A second finger landing mid-stroke is a palm or a page being pinched, not a second
      // signature. Without this the stroke in progress is dropped on the floor — overwritten
      // before it was ever committed, so it vanishes at the next repaint.
      if (drawing.current) return
      // Without capture the stroke ends the moment the hand crosses the edge of the box, which is
      // where the descender of a signature usually goes. With it, the events keep arriving here
      // until the pointer comes up, wherever that happens to be.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      const point = pointFrom(event)
      drawing.current = { pointerId: event.pointerId, points: [point], from: point }
      setAnnouncement("")
    }

    const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const active = drawing.current
      if (!active || active.pointerId !== event.pointerId) return
      event.preventDefault()

      // One pointermove is delivered per frame, but the pointer was sampled many times inside that
      // frame and the browser keeps the ones it skipped. A quick signature is where the difference
      // shows: at 60Hz a fast flick is four or five points and comes out as a zigzag, while the
      // coalesced list holds the twenty the digitiser actually saw. Safari has returned an empty
      // list here, so the event itself is the fallback rather than the assumption.
      const native = event.nativeEvent
      const coalesced =
        typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : []
      const samples = coalesced.length > 0 ? coalesced : [native]

      const ctx = canvasRef.current?.getContext?.("2d")
      for (const sample of samples) {
        const point = pointFrom(sample)
        const previous = active.points[active.points.length - 1]
        active.points.push(point)
        if (!ctx) continue
        // The newest segment only: control at the sample just gone, ending at the midpoint between
        // it and this one — the same curve `strokeGeometry` produces for the finished stroke.
        const to = midpoint(previous, point)
        ctx.beginPath()
        ctx.moveTo(active.from.x, active.from.y)
        ctx.quadraticCurveTo(previous.x, previous.y, to.x, to.y)
        ctx.stroke()
        active.from = to
      }
    }

    const endStroke = (event: React.PointerEvent<HTMLCanvasElement>) => {
      const active = drawing.current
      if (!active || active.pointerId !== event.pointerId) return
      drawing.current = null
      // Asked first, because releasing a capture that is already gone throws rather than no-oping —
      // and pointercancel, which is one of the two ways a stroke ends here, has already released it.
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      const box = canvasRef.current?.getBoundingClientRect?.()
      commit({
        type: "drawn",
        strokes: [...strokes, active.points],
        width: box?.width || 0,
        height: box?.height || height,
      })
      setAnnouncement(text.signed)
    }

    const setStrokes = (next: SignatureStroke[]) => {
      const box = canvasRef.current?.getBoundingClientRect?.()
      commit(
        next.length === 0
          ? null
          : { type: "drawn", strokes: next, width: box?.width || 0, height: box?.height || height }
      )
    }

    const handle: SignaturePadHandle = {
      clear: () => {
        commit(null)
        setAnnouncement(text.cleared)
      },
      undo: () => {
        if (value?.type !== "drawn" || value.strokes.length === 0) return
        setStrokes(value.strokes.slice(0, -1))
      },
      isEmpty: () => isSignatureEmpty(value),
      getValue: () => value ?? null,
      toSVG: (options) => {
        const box = canvasRef.current?.getBoundingClientRect?.()
        return signatureToSvg(value, {
          width: value?.type === "drawn" ? value.width : box?.width || 0,
          height: value?.type === "drawn" ? value.height : box?.height || height,
          penColor: ink,
          penWidth,
          ...options,
        })
      },
      toDataURL: (options) => rasterise(value, { penColor: ink, penWidth, height }, options),
    }
    React.useImperativeHandle(ref, () => handle)

    const empty = isSignatureEmpty(value)
    const svg = React.useMemo(
      () =>
        name && value?.type === "drawn"
          ? signatureToSvg(value, {
              width: value.width,
              height: value.height,
              penColor: ink,
              penWidth,
            })
          : null,
      [ink, name, penWidth, value]
    )

    return (
      <div
        ref={boxRef}
        role="group"
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={hintId}
        aria-required={required || undefined}
        className={cn("flex w-full flex-col gap-2 text-foreground", className)}
        {...props}
      >
        {label ? (
          <span id={labelId} className="text-sm font-medium">
            {label}
            {required ? (
              <span aria-hidden="true" className="ml-0.5 text-destructive">
                *
              </span>
            ) : null}
          </span>
        ) : null}

        <div
          className={cn(
            "relative overflow-hidden rounded-md border border-border bg-background",
            disabled && "pointer-events-none opacity-60",
            canvasClassName
          )}
          style={{ height }}
        >
          {/*
            Hidden from assistive technology on purpose. There is nothing to read inside a canvas,
            and announcing it as an image or a named region would promise a control that cannot be
            operated without a pointer. The typed field below is the path that is announced, and
            the two are described together by the group's label.
          */}
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className={cn(
              "h-full w-full touch-none",
              // touch-action: none, or the first downward stroke on a phone scrolls the page
              // instead of drawing — the browser waits to see whether a touch is a gesture, and
              // the delay eats the beginning of the signature even when it decides it was not.
              disabled ? "cursor-not-allowed" : "cursor-crosshair"
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endStroke}
            // Capture makes cancel rare, but a system gesture or a palm rejection still fires it,
            // and a stroke left open would swallow the next one.
            onPointerCancel={endStroke}
          />
          {empty ? (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-3 text-center text-xs text-muted-foreground"
            >
              ✕ — — — — —
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2">
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint ?? "Draw your signature above with a mouse, finger or stylus."}
          </p>
          <div className="flex shrink-0 gap-1">
            <button
              type="button"
              disabled={disabled || value?.type !== "drawn" || strokes.length === 0}
              onClick={handle.undo}
              className={BUTTON_CLASS}
            >
              {text.undo}
            </button>
            <button
              type="button"
              disabled={disabled || empty}
              onClick={handle.clear}
              className={BUTTON_CLASS}
            >
              {text.clear}
            </button>
          </div>
        </div>

        {allowTyped ? (
          <>
            <div aria-hidden="true" className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {dividerLabel}
              <span className="h-px flex-1 bg-border" />
            </div>
            <div className="flex flex-col gap-1">
              <label htmlFor={typedId} className="text-xs font-medium text-muted-foreground">
                {typedLabel}
              </label>
              <input
                id={typedId}
                type="text"
                autoComplete="name"
                disabled={disabled}
                value={typedName}
                required={required && empty && !disabled}
                aria-describedby={hintId}
                onChange={(event) => {
                  const next = event.currentTarget.value
                  // Typing replaces a drawing rather than joining it: there is one signature, and
                  // a value that held both would leave the consumer to decide which one was meant.
                  commit(next.trim() ? { type: "typed", name: next } : null)
                  setAnnouncement(next.trim() ? text.signedAs(next.trim()) : text.cleared)
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              />
            </div>
          </>
        ) : null}

        {/*
          The value a plain form posts. A drawn signature goes as an SVG data URL and a typed one as
          the name, so a server that only ever receives `signature` gets something it can store
          either way.

          `required` deliberately does not live here. A hidden input is barred from constraint
          validation outright — the attribute parses, the browser ignores it, and the form submits
          unsigned — so it goes on the typed field instead, and only while nothing has been signed:
          draw, and the requirement lifts without ever having asked for a name. With
          `allowTyped={false}` there is no field left to carry it, so nothing enforces it natively
          and the submit handler has to; `aria-required` on the group states the requirement either
          way.
        */}
        {name ? (
          <input
            type="hidden"
            name={name}
            value={
              value?.type === "typed"
                ? value.name
                : svg
                  ? `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
                  : ""
            }
          />
        ) : null}

        {/*
          Announced on the transitions that matter — a stroke landing, a name being typed, the pad
          being cleared — and never per sample. A live region wired to every pointermove reads
          numbers over the top of whatever else is being said, which is the failure char-counter
          documents; the same restraint applies to a surface that emits sixty events a second.
        */}
        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
      </div>
    )
  }
)

/**
 * Rasterises a signature through an offscreen canvas. Returns `null` outside a browser, and when
 * nothing is signed.
 *
 * The default is a transparent background, and that is the one export choice worth stating out
 * loud: a transparent PNG of black ink is invisible the moment it lands on anything dark, which is
 * every dark-mode receipt screen and half of the PDF viewers. Pass `backgroundColor: "#fff"` when
 * the image is going somewhere you do not control.
 */
function rasterise(
  value: SignatureValue | null | undefined,
  defaults: { penColor: string; penWidth: number; height: number },
  options: SignatureRasterOptions = {}
): string | null {
  if (isSignatureEmpty(value) || !value) return null
  if (typeof document === "undefined") return null

  const {
    type = "image/png",
    quality,
    scale = 2,
    penColor = defaults.penColor,
    penWidth = defaults.penWidth,
    backgroundColor,
    trim = false,
  } = options

  const width = value.type === "drawn" ? value.width : 320
  const height = value.type === "drawn" ? value.height : defaults.height
  const box = value.type === "drawn" && trim !== false ? signatureBounds(value.strokes, penWidth) : null
  const pad = typeof trim === "number" ? trim : TRIM_PADDING
  const outW = box ? box.width + pad * 2 : width
  const outH = box ? box.height + pad * 2 : height

  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(outW * scale))
  canvas.height = Math.max(1, Math.round(outH * scale))
  const ctx = canvas.getContext("2d")
  if (!ctx) return null

  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  if (backgroundColor) {
    ctx.fillStyle = backgroundColor
    ctx.fillRect(0, 0, outW, outH)
  }
  if (box) ctx.translate(-(box.x - pad), -(box.y - pad))

  ctx.lineWidth = penWidth
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.strokeStyle = penColor
  ctx.fillStyle = penColor

  if (value.type === "typed") {
    const size = Math.min(outH * 0.42, 64)
    ctx.font = `${size}px ${SCRIPT_FONT}`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(value.name.trim(), outW / 2, outH / 2, Math.max(outW - 24, 1))
  } else {
    for (const stroke of value.strokes) paintStroke(ctx, stroke, penWidth)
  }
  return canvas.toDataURL(type, quality)
}
