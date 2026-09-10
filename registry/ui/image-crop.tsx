"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** The size of the source image, in the image's own pixels. */
export interface ImageSize {
  width: number
  height: number
}

/**
 * The part of the image that is kept, in the source image's own pixels.
 *
 * Not fractions of the frame and not screen pixels. Every real bug in a cropper is these two
 * systems being mixed up: somebody drags a 320px-wide preview of an 8000px photo, and a factor
 * applied in the wrong direction saves a picture a dot off the frame they were looking at — or,
 * applied twice, a corner of the photo nobody chose. Keeping the value in source pixels means it
 * survives a resize, a phone with a different screen and a round trip through a database, and it
 * is exactly the rectangle a server-side resize would be handed.
 */
export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** How big the exported image should be. See {@link outputSize} for what each combination means. */
export interface CropOutputOptions {
  /** Exact output width in pixels. The height follows the crop's shape unless it is given too. */
  width?: number
  /** Exact output height in pixels. */
  height?: number
  /** Cap on the longest side when neither is given (default 2048). See {@link outputSize}. */
  maxSize?: number
}

/** Output options plus the encoding, for the calls that produce a file rather than a canvas. */
export interface CropEncodeOptions extends CropOutputOptions {
  /** MIME type, e.g. `"image/jpeg"` or `"image/webp"` (default `"image/png"`). */
  type?: string
  /** Quality for lossy types, 0–1. */
  quality?: number
}

export interface ImageCropProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange" | "defaultValue" | "children"> {
  /**
   * The image to crop: a URL, or the `File`/`Blob` that came straight out of a file input.
   *
   * A `Blob` is the better one to pass when you have it. It saves you the object URL — this makes
   * one and revokes it when the source changes or it unmounts, which is the leak every upload
   * screen has — and it is the form the exporter can ask about orientation, which is the whole of
   * the note about photographs that arrive lying on their side.
   */
  src: string | Blob
  /** Alt text for the image being cropped. Describe the picture, not the act of cropping. */
  alt?: string
  /** Width divided by height of the crop frame (default 1, a square). */
  aspect?: number
  /** Draw the frame as a circle. The crop is still the rectangle; see the note on the component. */
  shape?: "rect" | "round"
  /** Draw thirds guides over the frame while it is being moved (default true). */
  grid?: boolean
  /** Controlled crop rectangle, in source pixels. Pair with `onChange`. */
  value?: CropRect
  /** Starting crop for an uncontrolled component. Defaults to the whole image at this aspect. */
  defaultValue?: CropRect
  /** Called on every frame of a drag, pinch, wheel or key press. */
  onChange?: (crop: CropRect) => void
  /**
   * Called once a gesture finishes — pointer up, key press, slider release, wheel settled.
   *
   * This is the one to re-encode a preview in. `onChange` fires per pointer frame, and drawing an
   * 8000px source into a canvas sixty times a second is how a cropper turns a phone into a heater.
   */
  onChangeEnd?: (crop: CropRect) => void
  /** Called when the image has loaded, with its natural size. */
  onImageLoad?: (size: ImageSize) => void
  /** How far in the image can be zoomed, as a multiple of "fills the frame" (default 8). */
  maxZoom?: number
  /** Default sizing and encoding for the export methods on the ref. */
  output?: CropEncodeOptions
  /** Passed to the underlying `<img>`. Needed to export a cross-origin image; see the note. */
  crossOrigin?: "anonymous" | "use-credentials"
  /** Show the zoom slider under the frame (default true). The position sliders stay either way. */
  controls?: boolean
  /** Freezes the frame and dims it. */
  disabled?: boolean
  /** Labels for the controls and the announcements, for translation. */
  labels?: Partial<typeof DEFAULT_LABELS>
  /** Classes for the frame itself, e.g. to give it a fixed width. */
  frameClassName?: string
}

/** What the imperative ref exposes, for the submit handler that has to produce the file. */
export interface ImageCropHandle {
  /** The current crop rectangle, in source pixels, or `null` before the image loads. */
  getCrop: () => CropRect | null
  /** Moves the crop. The rectangle is clamped and snapped to the aspect, exactly as a drag is. */
  setCrop: (crop: CropRect) => void
  /** Back to the whole image at this aspect. */
  reset: () => void
  /** The natural size of the loaded image, or `null` before it loads. */
  getImageSize: () => ImageSize | null
  /** The cropped image on a canvas. Rejects if the image has not loaded. */
  toCanvas: (options?: CropOutputOptions) => Promise<HTMLCanvasElement>
  /** The cropped image as a file. `null` only if the browser declines to encode it. */
  toBlob: (options?: CropEncodeOptions) => Promise<Blob | null>
  /** The cropped image as a data URL. */
  toDataURL: (options?: CropEncodeOptions) => Promise<string>
}

const DEFAULT_LABELS = {
  /** Names the frame for assistive technology. */
  frame: "Crop image",
  /** Read after the name, so the gestures are announced rather than having to be discovered. */
  hint: "Drag to move the image. Pinch or scroll to zoom. Arrow keys nudge, plus and minus zoom.",
  zoom: "Zoom",
  horizontal: "Horizontal position",
  vertical: "Vertical position",
  /** Announced after a keyboard nudge or the end of a drag. */
  position: (zoom: number, across: number, down: number) =>
    `Zoom ${zoom}x, ${across}% across, ${down}% down.`,
}

const DEFAULT_ASPECT = 1
const DEFAULT_MAX_ZOOM = 8
/** Longest side of an export that did not ask for a size. See {@link outputSize}. */
export const DEFAULT_MAX_OUTPUT = 2048
/** Fraction of the crop an arrow key moves, plain and with Shift held. */
const NUDGE = 0.02
const NUDGE_FAST = 0.1
/** Multiplier per press of + or -. */
const KEY_ZOOM = 1.2

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max)

/**
 * The largest rectangle of `aspect` that fits inside the image, centred. Zoom 1.
 *
 * `Math.min` twice rather than once and a division: the second side computed from the first can
 * land a floating-point hair outside the image, and the clamp that follows would then shift the
 * crop off centre for a reason invisible in the numbers.
 */
export function coverCrop(image: ImageSize, aspect: number = DEFAULT_ASPECT): CropRect {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : DEFAULT_ASPECT
  const width = Math.min(image.width, image.height * ratio)
  const height = Math.min(image.height, width / ratio)
  return { x: (image.width - width) / 2, y: (image.height - height) / 2, width, height }
}

/**
 * Snaps a rectangle to the aspect and pushes it back inside the image.
 *
 * The height is derived from the width rather than trusted, which is what makes the frame the
 * authority on shape: an avatar frame is square, so a crop that is not square is not one the user
 * can have seen. The position is then clamped to the image, and that is the rule that prevents the
 * one output nobody accepts — an avatar with a transparent wedge down one side, because the frame
 * was allowed to hang over the edge of the photo.
 */
export function clampCrop(
  crop: CropRect,
  image: ImageSize,
  aspect: number = DEFAULT_ASPECT,
  minSize = 1
): CropRect {
  const cover = coverCrop(image, aspect)
  const ratio = cover.height > 0 ? cover.width / cover.height : DEFAULT_ASPECT
  let width = clamp(crop.width, Math.min(minSize, cover.width), cover.width)
  let height = width / ratio
  if (height > cover.height) {
    height = cover.height
    width = height * ratio
  }
  return {
    x: clamp(crop.x, 0, Math.max(image.width - width, 0)),
    y: clamp(crop.y, 0, Math.max(image.height - height, 0)),
    width,
    height,
  }
}

/** How far in the crop is: 1 fits the whole image to the frame, 4 shows a quarter of its width. */
export function cropZoom(crop: CropRect, image: ImageSize, aspect: number = DEFAULT_ASPECT): number {
  const cover = coverCrop(image, aspect)
  return crop.width > 0 ? cover.width / crop.width : 1
}

/**
 * Re-zooms a crop, keeping one point of the image where it already is on screen.
 *
 * `focal` is in source pixels — the point under the cursor, or between two fingers. Without it a
 * zoom is anchored to the middle of the frame, which is right for a slider and wrong for a wheel:
 * scrolling in on somebody's face and watching it slide out of the frame is the difference between
 * a cropper that feels direct and one that has to be fought.
 */
export function zoomCropTo(
  crop: CropRect,
  image: ImageSize,
  aspect: number = DEFAULT_ASPECT,
  zoom: number,
  focal?: { x: number; y: number }
): CropRect {
  const cover = coverCrop(image, aspect)
  const ratio = cover.height > 0 ? cover.width / cover.height : DEFAULT_ASPECT
  const next = Math.max(Number.isFinite(zoom) ? zoom : 1, 1)
  const width = cover.width / next
  const height = width / ratio
  const point = focal ?? { x: crop.x + crop.width / 2, y: crop.y + crop.height / 2 }
  // Where the focal point sits inside the crop now, as a fraction — so it sits there afterwards.
  const fx = crop.width > 0 ? (point.x - crop.x) / crop.width : 0.5
  const fy = crop.height > 0 ? (point.y - crop.y) / crop.height : 0.5
  return clampCrop({ x: point.x - fx * width, y: point.y - fy * height, width, height }, image, aspect)
}

/**
 * The pixel size of the export, and the reason this component owns the export at all.
 *
 * The obvious way to cut a rectangle out of a picture is to make a canvas the size of the source,
 * draw the whole thing, and read the rectangle back. A phone photo is 8000x6000, so that canvas is
 * 48 megapixels — 192 MB of RGBA before a single pixel is drawn on it — and the destination is a
 * 256px avatar. iOS Safari does not throw there; it drops the backing store and hands back a blank
 * image, or kills the tab. So the canvas is made at the size of the *output* and the crop is
 * scaled into it in one `drawImage`, which never allocates more than the picture actually wanted.
 *
 * Which means the size has to be decided before any pixels exist:
 * - `width` and `height` — exactly that, whatever shape the crop is (the caller has a slot to fill).
 * - one of them — the other follows the crop, so nothing is squashed.
 * - neither — the crop's own pixels, scaled down so the longest side is at most `maxSize`. A crop
 *   is never enlarged past its source: upscaling here makes a bigger file out of the same detail.
 */
export function outputSize(crop: CropRect, options: CropOutputOptions = {}): ImageSize {
  const { width, height, maxSize = DEFAULT_MAX_OUTPUT } = options
  const ratio = crop.height > 0 ? crop.width / crop.height : 1
  const px = (n: number) => Math.max(1, Math.round(n))

  if (width !== undefined && height !== undefined) return { width: px(width), height: px(height) }
  if (width !== undefined) return { width: px(width), height: px(width / ratio) }
  if (height !== undefined) return { width: px(height * ratio), height: px(height) }

  const longest = Math.max(crop.width, crop.height)
  const scale = maxSize > 0 && longest > maxSize ? maxSize / longest : 1
  return { width: px(crop.width * scale), height: px(crop.height * scale) }
}

/**
 * Something drawable whose pixels are laid out the way the preview showed them.
 *
 * This is the EXIF trap, and it produces the bug report everybody recognises: the preview was the
 * right way up and the saved avatar is lying on its side. A photo from a phone is usually stored
 * in the sensor's orientation with a tag saying which way to turn it; browsers have applied that
 * tag to `<img>` for years, and `drawImage` of the same file has not always agreed — so the
 * picture rotates somewhere between the box somebody cropped and the canvas it was cut into.
 *
 * `createImageBitmap(blob, { imageOrientation: "from-image" })` is the one line that settles it,
 * because it says out loud which of the two behaviours is wanted instead of inheriting whichever
 * this browser has. The result is then *checked against the preview* rather than trusted: if the
 * bitmap and the `<img>` disagree about which side is the long one, this browser did not turn the
 * element, and exporting the bitmap would save a picture that was never on screen. The element
 * wins in that case — being faithful to what the user chose beats being upright.
 */
async function drawableFor(img: HTMLImageElement, blob: Blob | null): Promise<CanvasImageSource> {
  if (blob && typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" })
      if (bitmap.width === img.naturalWidth && bitmap.height === img.naturalHeight) return bitmap
      bitmap.close?.()
    } catch {
      // A source this browser will not decode that way (an SVG, or a Blob already released). The
      // element holds a decoded copy regardless, and that copy is the one on screen.
    }
  }
  return img
}

/** Cuts `crop` out of the image and draws it, scaled, onto a canvas of the output size. */
async function cropToCanvas(
  img: HTMLImageElement,
  blob: Blob | null,
  crop: CropRect,
  options: CropOutputOptions
): Promise<HTMLCanvasElement> {
  const out = outputSize(crop, options)
  const canvas = document.createElement("canvas")
  canvas.width = out.width
  canvas.height = out.height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("image-crop: this browser returned no 2D canvas context")

  // A crop is nearly always drawn smaller than it was, and the default resampling makes a
  // downscale of that size crunchy in exactly the place people look at — a face.
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"

  const source = await drawableFor(img, blob)
  ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, out.width, out.height)
  if (source !== img) (source as ImageBitmap).close?.()
  return canvas
}

// A real range input, left to render natively. `appearance-none` is the usual reflex here and it
// is a trap without a full set of ::-webkit-slider-thumb rules — which a single-file registry
// component cannot ship — so the thumb simply disappears in WebKit. `accent-color` themes the
// native control from the same token instead, and keeps the platform's own keyboard behaviour.
const SLIDER_CLASS =
  "min-w-0 flex-1 cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"

const ROW_CLASS = "flex items-center gap-3 text-xs text-muted-foreground"

/**
 * Fit a photograph to a frame: drag it about, pinch or scroll to zoom, then take the rectangle.
 *
 * ```tsx
 * const cropper = React.useRef<ImageCropHandle>(null)
 *
 * <ImageCrop
 *   src={file}                                        // the File straight from the input
 *   alt="Your profile photo"
 *   shape="round"
 *   output={{ width: 512, type: "image/webp", quality: 0.9 }}
 *   ref={cropper}
 * />
 * <Button onClick={async () => upload(await cropper.current!.toBlob())}>Save</Button>
 * ```
 *
 * The frame *is* the crop: the image lies behind a window of the right shape and is moved under
 * it, rather than a marquee being dragged around on top of a picture. That is the interaction an
 * avatar, cover or thumbnail step wants — the output shape is fixed and the only question is which
 * part of the photo goes in it — and it is why `aspect` is a prop and there are no resize handles.
 * Free-form selection with eight handles is a different component doing a different job.
 *
 * `shape="round"` rounds the frame, not the output. The exported image is the rectangle, because
 * an avatar is displayed round by the page that shows it, at whatever size it shows it: baking the
 * circle in means a transparent PNG that grows black corners the first time it lands somewhere
 * that flattens it, and a JPEG that cannot be round at all.
 *
 * Keyboard and assistive technology reach all of it. The frame takes focus and answers the arrow
 * keys (Shift for a longer step) and + / -, and under it are real range inputs: zoom, and a
 * horizontal and vertical position that announce themselves as percentages. The position pair is
 * hidden until something inside it has focus — a screen reader reaches them regardless, and a
 * sighted keyboard user sees them appear the moment they tab in rather than looking at two sliders
 * duplicating the arrow keys they already have. A cropper that answers only to a drag is a step in
 * a sign-up form that a whole class of people cannot finish.
 *
 * One thing it cannot do for you: exporting a cross-origin image taints the canvas, and `toBlob`
 * then throws a `SecurityError`. Pass `crossOrigin="anonymous"` and serve the image with CORS
 * headers, or hand this component the `Blob` you already have.
 */
export const ImageCrop = React.forwardRef<ImageCropHandle, ImageCropProps>(function ImageCrop(
  {
    className,
    src,
    alt = "",
    aspect = DEFAULT_ASPECT,
    shape = "rect",
    grid = true,
    value: valueProp,
    defaultValue,
    onChange,
    onChangeEnd,
    onImageLoad,
    maxZoom = DEFAULT_MAX_ZOOM,
    output,
    crossOrigin,
    controls = true,
    disabled = false,
    labels,
    frameClassName,
    ...props
  },
  ref
) {
  const text = { ...DEFAULT_LABELS, ...labels }
  const reactId = React.useId()
  const hintId = `${reactId}-hint`

  const frameRef = React.useRef<HTMLDivElement | null>(null)
  const imgRef = React.useRef<HTMLImageElement | null>(null)

  const [image, setImage] = React.useState<ImageSize | null>(null)
  const [frame, setFrame] = React.useState<ImageSize>({ width: 0, height: 0 })
  const [uncontrolled, setUncontrolled] = React.useState<CropRect | null>(defaultValue ?? null)
  const [interacting, setInteracting] = React.useState(false)
  const [announcement, setAnnouncement] = React.useState("")

  const topZoom = Math.max(maxZoom, 1)
  const isControlled = valueProp !== undefined
  const raw = isControlled ? valueProp : uncontrolled
  // Nothing is a valid crop until the image's own size is known, and every move needs it clamped,
  // so the rectangle is normalised once here rather than at each of the seven places it changes.
  const crop = image ? clampCrop(raw ?? coverCrop(image, aspect), image, aspect) : null

  // A Blob source needs a URL, and needs it taken away again. An upload screen that makes one per
  // selected file and never revokes it holds every image the user tried onto the heap for the life
  // of the page, which on a photo picker is the largest leak the page has.
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (typeof src === "string") {
      setObjectUrl(null)
      return
    }
    const url = URL.createObjectURL(src)
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [src])
  const href = typeof src === "string" ? src : objectUrl
  const blob = typeof src === "string" ? null : src

  const commit = React.useCallback(
    (next: CropRect, end = false) => {
      if (!isControlled) setUncontrolled(next)
      onChange?.(next)
      if (end) onChangeEnd?.(next)
    },
    [isControlled, onChange, onChangeEnd]
  )

  // CSS pixels per source pixel. The larger of the two, so a frame whose measured size is a
  // rounding hair off the aspect is covered in both directions: half a pixel of photo spills out
  // of the window, where the other way round leaves a hairline of background down one edge.
  const cssPerPixel =
    crop && crop.width > 0 && crop.height > 0
      ? Math.max(frame.width / crop.width, frame.height / crop.height)
      : 0

  // Handlers reach the current geometry through a ref. A pointermove during a drag is bound once,
  // and would otherwise be closing over the crop as it was when the gesture began.
  const live = React.useRef({ crop, image, aspect, topZoom, disabled })
  React.useEffect(() => {
    live.current = { crop, image, aspect, topZoom, disabled }
  })

  const notifyLoad = React.useRef(onImageLoad)
  notifyLoad.current = onImageLoad

  /**
   * Records the natural size, once per image.
   *
   * Stable, and guarded by the size it last reported, because it is also called from the `<img>`
   * ref callback — an inline callback there is detached and reattached on every render, so an
   * unguarded `setImage` with a fresh object would re-render, reattach, and never stop.
   */
  const reported = React.useRef("")
  const handleLoad = React.useCallback((node: HTMLImageElement) => {
    const size = { width: node.naturalWidth, height: node.naturalHeight }
    if (!size.width || !size.height) return
    const key = `${size.width}x${size.height}`
    if (reported.current === key) return
    reported.current = key
    setImage(size)
    notifyLoad.current?.(size)
  }, [])

  const attachImage = React.useCallback(
    (node: HTMLImageElement | null) => {
      imgRef.current = node
      // A cached image can already be complete before React attaches onLoad, in which case the
      // event never fires and the cropper sits blank until something else re-renders it.
      if (node?.complete && node.naturalWidth) handleLoad(node)
    },
    [handleLoad]
  )

  // A new source is a new picture, so the old rectangle describes pixels that are gone. Tied to
  // the source actually changing: on mount there is nothing to discard, and discarding anyway
  // would throw away `defaultValue` — and the first `href` of a Blob arrives one render late, so
  // an appearing URL is the same non-event as the first one.
  const previousHref = React.useRef(href)
  React.useEffect(() => {
    const previous = previousHref.current
    previousHref.current = href
    if (previous === href || previous === null) return
    reported.current = ""
    setImage(null)
    if (!isControlled) setUncontrolled(null)
  }, [href, isControlled])

  // The frame's width comes from the page and its height from the aspect. Observed rather than
  // measured once: this sits in dialogs and sidebars, which change width without the window doing
  // anything, and a stale frame width is a wrong scale factor — which is the defect that saves a
  // picture offset from the one on screen.
  React.useEffect(() => {
    const node = frameRef.current
    if (!node) return
    const measure = () => {
      const box = node.getBoundingClientRect?.()
      const next = { width: box?.width ?? 0, height: box?.height ?? 0 }
      // Bailing out on an unchanged size is not a micro-optimisation here: a ResizeObserver fires
      // on every tick of a window being dragged wider, and a fresh object each time would re-render
      // the whole cropper for each one — during the gesture where it can least afford it.
      setFrame((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const announce = React.useCallback(
    (next: CropRect, size: ImageSize) => {
      const pct = (n: number, span: number) => (span > 0.5 ? Math.round((n / span) * 100) : 50)
      setAnnouncement(
        text.position(
          Math.round(cropZoom(next, size, live.current.aspect) * 10) / 10,
          pct(next.x, size.width - next.width),
          pct(next.y, size.height - next.height)
        )
      )
    },
    [text]
  )

  /** The frame as it is right now. Measured rather than read from state, so a drag mid-resize is
   * still cutting the picture that is on screen. */
  const frameBox = () => {
    const box = frameRef.current?.getBoundingClientRect?.()
    return { left: box?.left ?? 0, top: box?.top ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 }
  }

  /** CSS pixels per source pixel for a given crop, against the live frame. */
  const scaleFor = (from: CropRect, box: ReturnType<typeof frameBox>) =>
    Math.max(from.width > 0 ? box.width / from.width : 0, from.height > 0 ? box.height / from.height : 0)

  /** Where a client point lands in the source image, given the crop it is measured against. */
  const sourceAt = (from: CropRect, clientX: number, clientY: number) => {
    const box = frameBox()
    const k = scaleFor(from, box)
    return k > 0
      ? { x: from.x + (clientX - box.left) / k, y: from.y + (clientY - box.top) / k }
      : { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  }

  /** The pointers currently down on the frame, and the geometry the gesture started from. */
  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const gesture = React.useRef<{
    crop: CropRect
    zoom: number
    mid: { x: number; y: number }
    distance: number
  } | null>(null)

  const midpoint = () => {
    const list = [...pointers.current.values()]
    if (list.length === 0) return { x: 0, y: 0 }
    const sum = list.reduce((a, p) => ({ x: a.x + p.x, y: a.y + p.y }), { x: 0, y: 0 })
    return { x: sum.x / list.length, y: sum.y / list.length }
  }

  const spread = () => {
    const list = [...pointers.current.values()]
    return list.length < 2 ? 0 : Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
  }

  const beginGesture = () => {
    const current = live.current.crop
    const size = live.current.image
    if (!current || !size) {
      gesture.current = null
      return
    }
    gesture.current = {
      crop: current,
      zoom: cropZoom(current, size, live.current.aspect),
      mid: midpoint(),
      distance: spread(),
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (live.current.disabled || !live.current.crop) return
    if (event.pointerType === "mouse" && event.button !== 0) return
    // Without capture the drag ends the moment the hand leaves the frame, which on a cropper is
    // every drag that pushes the picture as far as it goes.
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    // Every change in how many fingers are down restarts the gesture from where the picture is
    // now. Without that, the second finger landing makes the image jump by the distance between
    // the first finger and the new midpoint.
    beginGesture()
    setInteracting(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    const start = gesture.current
    const size = live.current.image
    if (!start || !size) return
    event.preventDefault()
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    const box = frameBox()
    const mid = midpoint()

    if (pointers.current.size >= 2 && start.distance > 0) {
      const zoom = clamp((start.zoom * spread()) / start.distance, 1, live.current.topZoom)
      // The point that was between the fingers when the pinch began, in the picture. It has to end
      // up under where the fingers are *now*, and that is both halves of a pinch: the ratio sets
      // the size, then the rectangle is placed so one point of the photo has not moved on the glass.
      const focal = sourceAt(start.crop, start.mid.x, start.mid.y)
      const zoomed = zoomCropTo(start.crop, size, live.current.aspect, zoom, focal)
      const k = scaleFor(zoomed, box)
      commit(
        clampCrop(
          k > 0
            ? { ...zoomed, x: focal.x - (mid.x - box.left) / k, y: focal.y - (mid.y - box.top) / k }
            : zoomed,
          size,
          live.current.aspect
        )
      )
      return
    }

    // Measured from where the gesture started rather than from the previous event: accumulated
    // per-event deltas drift, and a crop resting against an edge would eat the movement that
    // should come back the moment the finger turns around.
    const k = scaleFor(start.crop, box)
    if (k <= 0) return
    commit(
      clampCrop(
        {
          ...start.crop,
          x: start.crop.x - (mid.x - start.mid.x) / k,
          y: start.crop.y - (mid.y - start.mid.y) / k,
        },
        size,
        live.current.aspect
      )
    )
  }

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return
    // Asked first: releasing a capture that pointercancel has already taken back throws.
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (pointers.current.size > 0) {
      beginGesture()
      return
    }
    gesture.current = null
    setInteracting(false)
    const current = live.current.crop
    const size = live.current.image
    if (current && size) {
      onChangeEnd?.(current)
      announce(current, size)
    }
  }

  // Wheel zoom is bound by hand because React delivers wheel through a passive listener on the
  // root, where preventDefault does nothing at all — the page would scroll behind the cropper
  // while the cropper zoomed. Non-passive, and only over the frame.
  const settle = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => {
    const node = frameRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      const current = live.current.crop
      const size = live.current.image
      if (live.current.disabled || !current || !size) return
      event.preventDefault()
      // deltaMode 1 counts lines and 2 counts pages. A Firefox mouse wheel reports 3 lines where
      // a trackpad reports pixels, so reading the number as pixels zooms by a thousandth there.
      const box = frameBox()
      const perUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height || 400 : 1
      const zoom = clamp(
        cropZoom(current, size, live.current.aspect) * Math.exp(-event.deltaY * perUnit * 0.002),
        1,
        live.current.topZoom
      )
      const next = zoomCropTo(
        current,
        size,
        live.current.aspect,
        zoom,
        sourceAt(current, event.clientX, event.clientY)
      )
      commit(next)
      // A wheel has no end event, so the settled crop is reported once the pushing stops.
      if (settle.current) clearTimeout(settle.current)
      settle.current = setTimeout(() => {
        const settled = live.current.crop
        if (settled) onChangeEnd?.(settled)
      }, 200)
    }
    node.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      node.removeEventListener("wheel", onWheel)
      if (settle.current) clearTimeout(settle.current)
    }
  }, [commit, onChangeEnd])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = live.current.crop
    const size = live.current.image
    if (disabled || !current || !size) return
    const step = event.shiftKey ? NUDGE_FAST : NUDGE
    let next: CropRect | null = null

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const by = current.width * step * (event.key === "ArrowLeft" ? -1 : 1)
      next = clampCrop({ ...current, x: current.x + by }, size, aspect)
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const by = current.height * step * (event.key === "ArrowUp" ? -1 : 1)
      next = clampCrop({ ...current, y: current.y + by }, size, aspect)
    } else if (event.key === "+" || event.key === "=") {
      next = zoomCropTo(current, size, aspect, cropZoom(current, size, aspect) * KEY_ZOOM)
    } else if (event.key === "-" || event.key === "_") {
      next = zoomCropTo(current, size, aspect, cropZoom(current, size, aspect) / KEY_ZOOM)
    }

    if (!next) return
    // Only once a key is one this handles: otherwise Tab could not leave the frame, and a page
    // that scrolls would stop scrolling for every key anybody pressed inside it.
    event.preventDefault()
    const zoomed = clampCrop(
      cropZoom(next, size, aspect) > topZoom ? zoomCropTo(next, size, aspect, topZoom) : next,
      size,
      aspect
    )
    commit(zoomed, true)
    announce(zoomed, size)
  }

  /** Reports the crop that a slider has finished moving. Sliders have no gesture end of their own. */
  const endSlider = () => {
    const current = live.current.crop
    const size = live.current.image
    if (current && size) {
      onChangeEnd?.(current)
      announce(current, size)
    }
  }

  const setZoom = (zoom: number) => {
    const current = live.current.crop
    const size = live.current.image
    if (!current || !size) return
    commit(zoomCropTo(current, size, aspect, clamp(zoom, 1, topZoom)))
  }

  /** A position slider works in percent of the travel available, so it reads the same at any zoom. */
  const setPosition = (axis: "x" | "y", percent: number) => {
    const current = live.current.crop
    const size = live.current.image
    if (!current || !size) return
    const span = axis === "x" ? size.width - current.width : size.height - current.height
    commit(clampCrop({ ...current, [axis]: (span * percent) / 100 }, size, aspect))
  }

  const handle: ImageCropHandle = {
    getCrop: () => live.current.crop,
    setCrop: (next) => {
      const size = live.current.image
      if (!size) return
      const clamped = clampCrop(next, size, aspect)
      commit(
        cropZoom(clamped, size, aspect) > topZoom
          ? zoomCropTo(clamped, size, aspect, topZoom)
          : clamped,
        true
      )
    },
    reset: () => {
      const size = live.current.image
      if (size) commit(coverCrop(size, aspect), true)
    },
    getImageSize: () => live.current.image,
    toCanvas: async (options) => {
      const node = imgRef.current
      const current = live.current.crop
      if (!node || !current) throw new Error("image-crop: the image has not loaded yet")
      return cropToCanvas(node, blob, current, { ...output, ...options })
    },
    toBlob: async (options) => {
      const merged = { ...output, ...options }
      const canvas = await handle.toCanvas(merged)
      return new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, merged.type ?? "image/png", merged.quality)
      )
    },
    toDataURL: async (options) => {
      const merged = { ...output, ...options }
      const canvas = await handle.toCanvas(merged)
      return canvas.toDataURL(merged.type ?? "image/png", merged.quality)
    },
  }
  React.useImperativeHandle(ref, () => handle)

  const zoom = crop && image ? clamp(cropZoom(crop, image, aspect), 1, topZoom) : 1
  const spanX = crop && image ? image.width - crop.width : 0
  const spanY = crop && image ? image.height - crop.height : 0
  const percent = (n: number, span: number) => (span > 0.5 ? Math.round((n / span) * 100) : 0)

  return (
    <div className={cn("flex w-full flex-col gap-3 text-foreground", className)} {...props}>
      <div
        ref={frameRef}
        role="group"
        aria-label={text.frame}
        aria-describedby={hintId}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onKeyDown={handleKeyDown}
        style={{ aspectRatio: `${aspect}` }}
        className={cn(
          // touch-action none, or the first drag on a phone scrolls the page while the browser
          // works out what the gesture was, and the start of the pan is swallowed either way.
          "relative w-full touch-none select-none overflow-hidden border border-border bg-muted",
          shape === "round" ? "rounded-full" : "rounded-md",
          disabled ? "cursor-not-allowed opacity-60" : "cursor-grab active:cursor-grabbing",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          frameClassName
        )}
      >
        {href ? (
          // A plain <img>, deliberately. A framework's image component wants a known path it can
          // re-encode at build time, and half the sources here are Blob URLs for a file chosen a
          // second ago — while the cropper needs this element's own naturalWidth and the exact
          // pixels the export will read back.
          <img
            ref={attachImage}
            src={href}
            alt={alt}
            crossOrigin={crossOrigin}
            // The browser's own image drag starts on the first pointer move and hands the file to
            // whatever is underneath, instead of panning.
            draggable={false}
            onLoad={(event) => handleLoad(event.currentTarget)}
            className="pointer-events-none absolute left-0 top-0 max-w-none"
            style={
              crop && image && cssPerPixel > 0
                ? {
                    width: image.width * cssPerPixel,
                    height: image.height * cssPerPixel,
                    transform: `translate(${-crop.x * cssPerPixel}px, ${-crop.y * cssPerPixel}px)`,
                  }
                : { visibility: "hidden" }
            }
          />
        ) : null}

        {grid && interacting ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            {/*
              The one fixed colour in the component, and it is fixed on purpose: what these lines
              lie on is a photograph, not a themed surface. A border token is picked to sit against
              the page's own background, so in dark mode it disappears into any bright picture and
              in light mode into any dark one — where a translucent white reads as a guide over
              both, which is why every camera app draws it this way.
            */}
            <div className="absolute inset-y-0 left-1/3 w-px bg-white/40" />
            <div className="absolute inset-y-0 left-2/3 w-px bg-white/40" />
            <div className="absolute inset-x-0 top-1/3 h-px bg-white/40" />
            <div className="absolute inset-x-0 top-2/3 h-px bg-white/40" />
          </div>
        ) : null}
      </div>

      {controls ? (
        <label className={ROW_CLASS}>
          <span className="shrink-0">{text.zoom}</span>
          <input
            type="range"
            min={1}
            max={topZoom}
            step={0.01}
            value={zoom}
            disabled={disabled || !image}
            onChange={(event) => setZoom(Number(event.target.value))}
            onPointerUp={endSlider}
            onKeyUp={endSlider}
            className={SLIDER_CLASS}
          />
        </label>
      ) : null}

      {/*
        The two axes as real sliders, hidden until something in here has focus. A screen reader
        reaches them regardless — they are in the accessibility tree, labelled, and announce a
        percentage as they move — while a sighted keyboard user has the arrow keys on the frame and
        sees these appear only on tabbing into them. Visually hiding a focusable control is
        otherwise a trap, which is the whole reason the group unhides itself on focus-within.
      */}
      <div className="sr-only flex-col gap-2 focus-within:not-sr-only focus-within:flex">
        <label className={ROW_CLASS}>
          <span className="shrink-0">{text.horizontal}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent(crop?.x ?? 0, spanX)}
            disabled={disabled || !image || spanX <= 0.5}
            onChange={(event) => setPosition("x", Number(event.target.value))}
            onPointerUp={endSlider}
            onKeyUp={endSlider}
            className={SLIDER_CLASS}
          />
        </label>
        <label className={ROW_CLASS}>
          <span className="shrink-0">{text.vertical}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={percent(crop?.y ?? 0, spanY)}
            disabled={disabled || !image || spanY <= 0.5}
            onChange={(event) => setPosition("y", Number(event.target.value))}
            onPointerUp={endSlider}
            onKeyUp={endSlider}
            className={SLIDER_CLASS}
          />
        </label>
      </div>

      <span id={hintId} className="sr-only">
        {text.hint}
      </span>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
})
