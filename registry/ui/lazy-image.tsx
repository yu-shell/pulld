"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** What the image is doing right now. */
export type LazyImageStatus = "loading" | "loaded" | "error"

/**
 * The shape this reads off a real `<img>`. Declared as the two properties rather than as
 * `HTMLImageElement` so the decision below can be tested with an object literal.
 */
export interface ImageReadout {
  complete?: boolean
  naturalWidth?: number
}

/**
 * What an element is saying about its image, or `null` for "nothing yet".
 *
 * This exists because `onLoad` alone is not enough, and the usual framing of why is wrong. The
 * claim is normally that a cached image never fires `load`; measured in Chromium, a listener
 * attached in the same tick *after* `src` is assigned still receives it, which is what React does
 * when it renders the element itself. The case that genuinely misses the event is a listener
 * attached a macrotask or more late — a 60ms delay was enough to miss it here — and that is exactly
 * what hydration is: the server sent `<img src>`, the browser fetched and decoded it while the
 * bundle was still parsing, and React attaches `onLoad` to an element that finished long ago. The
 * placeholder then stays forever on precisely the images that were fastest.
 *
 * So the element is asked directly, and `complete` on its own is not the question either:
 *
 *   - `complete` is also true after a failed load (measured: a 404 leaves `complete === true` and
 *     `naturalWidth === 0`), so reading it alone reports a broken image as a loaded one;
 *   - `complete` is true for an element with no `src` at all, and for one with `src=""`, both with
 *     `naturalWidth === 0` — which is why `src` has to be part of this decision rather than
 *     something the caller is trusted to have checked. Without that guard every image renders
 *     "error" for one commit before it is even asked to fetch anything.
 *
 * `naturalWidth` is therefore the signal and `complete` only says whether the answer is in yet.
 */
export function readImageStatus(
  node: ImageReadout | null | undefined,
  src: string | undefined
): "loaded" | "error" | null {
  if (!node || !src) return null
  if (!node.complete) return null
  return (node.naturalWidth ?? 0) > 0 ? "loaded" : "error"
}

/**
 * The source to try after `current` failed, or `null` when there is nothing left to try.
 *
 * The one-line version of a fallback — `onError={() => setSrc(fallback)}` — is the known way to
 * hang a page, and the reason is that the error does not stop coming: measured, swapping `src` from
 * one 404 to another fires `error` a second time, so a handler that answers every error by
 * assigning the fallback is a loop as soon as the fallback is itself missing. Comparing against
 * `current` makes the swap one-way; the second failure finds nothing left and settles on "error".
 */
export function nextSourceAfterError(
  current: string | undefined,
  fallbackSrc: string | undefined
): string | null {
  if (!fallbackSrc) return null
  if (current === fallbackSrc) return null
  return fallbackSrc
}

/**
 * The `aspect-ratio` to hold the box at, as a CSS value, or `undefined` when nothing was declared.
 *
 * Which form of ratio is used is the whole difference between reserving space and only appearing
 * to. Measured in a 300px column, with `width: 100%; height: auto`:
 *
 *   - no `width`/`height` attributes: the box is 300x0 until the bytes arrive and 300x225 after —
 *     a 225px shift of everything below it, which is the ordinary CLS complaint;
 *   - `width="120" height="90"` attributes: 300x225 from the first frame, before `src` is even
 *     set. The attributes work. But the style they compute to is `aspect-ratio: auto 120 / 90`,
 *     and `auto` means "prefer the real ratio once it is known" — so when the declared ratio is
 *     wrong, the box still moves, just later: declaring 120x90 for a file that turned out to be
 *     64x64 reshaped the box from 300x225 to 300x300 on arrival;
 *   - an explicit `aspect-ratio: 4 / 3` in the style: 300x225 before the fetch and 300x225 after
 *     that same 1:1 file landed. The box does not move at all.
 *
 * So this emits the explicit form. The cost is that a mismatched image is then drawn into a box of
 * the wrong shape, and the default `object-fit: fill` stretches it — which is the grain of truth in
 * "applying aspect-ratio distorts the picture". It distorts only because nothing said how to fit;
 * `fit` below answers that, and the pair together is the only combination measured to shift
 * nothing and stretch nothing.
 */
export function reserveRatio(
  width: number | string | undefined,
  height: number | string | undefined,
  ratio: number | string | undefined
): string | undefined {
  if (ratio !== undefined) return typeof ratio === "number" ? `${ratio}` : ratio
  const w = typeof width === "string" ? Number(width) : width
  const h = typeof height === "string" ? Number(height) : height
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return undefined
  return `${w} / ${h}`
}

export interface UseLazyImageOptions {
  /** The image to show. Changing it starts over: back to `loading`, and the fallback is rearmed. */
  src?: string
  /** Shown instead if `src` fails. Tried once, never retried. */
  fallbackSrc?: string
  /** Called whenever the status changes, including the first time it settles. */
  onStatusChange?: (status: LazyImageStatus) => void
}

export interface LazyImageLoad {
  status: LazyImageStatus
  /** The source to render right now — `src`, or `fallbackSrc` once `src` has failed. */
  currentSrc: string | undefined
  /** Attach to the `<img>`. The status is read off the element, not only from its events. */
  ref: React.RefObject<HTMLImageElement | null>
  onLoad: React.ReactEventHandler<HTMLImageElement>
  onError: React.ReactEventHandler<HTMLImageElement>
}

// useLayoutEffect reads the element before paint, so an image that was already complete at mount
// never shows a frame of placeholder — but it warns during SSR, where there is no element to read.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * The loading lifecycle on its own, for an `<img>` you would rather write yourself.
 *
 * Everything that makes this more than a `useState` is in `readImageStatus` and
 * `nextSourceAfterError` above; this wires them to an element and to prop changes.
 */
export function useLazyImage({
  src,
  fallbackSrc,
  onStatusChange,
}: UseLazyImageOptions = {}): LazyImageLoad {
  const ref = React.useRef<HTMLImageElement | null>(null)

  // `source` is the one being attempted; `startedFrom` remembers which `src` prop that attempt
  // belongs to. Comparing them during render is how a new `src` resets everything without an
  // effect — an effect would leave one commit showing the old image's "loaded" state under the new
  // URL, which is the flash of the previous picture that a gallery shows when you page through it.
  const [state, setState] = React.useState<{
    startedFrom: string | undefined
    source: string | undefined
    status: LazyImageStatus
  }>({ startedFrom: src, source: src, status: "loading" })

  let current = state
  if (state.startedFrom !== src) {
    current = { startedFrom: src, source: src, status: "loading" }
    setState(current)
  }

  // Held in a ref so changing the callback does not re-run the effect below, and so the effect
  // does not need it in its dependencies to call the current one.
  const onStatusChangeRef = React.useRef(onStatusChange)
  useIsomorphicLayoutEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  const settle = React.useCallback((status: LazyImageStatus, source: string | undefined) => {
    setState((previous) => {
      if (previous.source !== source || previous.status === status) return previous
      return { ...previous, status }
    })
  }, [])

  const fail = React.useCallback(
    (source: string | undefined) => {
      setState((previous) => {
        if (previous.source !== source) return previous
        const next = nextSourceAfterError(previous.source, fallbackSrc)
        // Returning the same object rather than an equal one matters: a broken element keeps
        // reporting `naturalWidth === 0`, so this is asked again on every commit, and a fresh
        // object each time is a fresh render each time. React bails out on identity alone.
        if (next === null) {
          return previous.status === "error" ? previous : { ...previous, status: "error" }
        }
        return { ...previous, source: next, status: "loading" }
      })
    },
    [fallbackSrc]
  )

  // The element is asked on every commit, not only on mount: a `src` change puts the status back to
  // `loading`, and the new URL may be in the list of available images already, in which case there
  // is no event coming for it either (same reason as hydration — the answer is there before anyone
  // asks). Reading it here settles both cases through one path.
  useIsomorphicLayoutEffect(() => {
    const answer = readImageStatus(ref.current, current.source)
    if (answer === "loaded") settle("loaded", current.source)
    else if (answer === "error") fail(current.source)
  }, [current.source, current.status, settle, fail])

  const previousStatus = React.useRef<LazyImageStatus | null>(null)
  useIsomorphicLayoutEffect(() => {
    if (previousStatus.current === current.status) return
    previousStatus.current = current.status
    onStatusChangeRef.current?.(current.status)
  }, [current.status])

  const onLoad = React.useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      // Trust the element over the event: `load` also fires for an image that decoded to nothing in
      // some error paths, and `naturalWidth` is the only thing that separates the two.
      const answer = readImageStatus(event.currentTarget, current.source)
      if (answer === "error") fail(current.source)
      else settle("loaded", current.source)
    },
    [current.source, settle, fail]
  )

  const onError = React.useCallback(() => fail(current.source), [current.source, fail])

  return { status: current.status, currentSrc: current.source, ref, onLoad, onError }
}

export interface LazyImageProps
  extends Omit<React.ComponentPropsWithoutRef<"img">, "onLoad" | "onError" | "alt">,
    UseLazyImageOptions {
  /**
   * Required rather than optional, unlike on a bare `<img>`. Pass `alt=""` for decoration — that
   * is a decision, and an empty string records it; a missing attribute only records that nobody
   * thought about it, and a screen reader then reads the URL aloud.
   */
  alt: string
  /**
   * How the picture fills the box that was reserved for it. `cover` by default because the box is
   * pinned to the declared ratio (see `reserveRatio`), so anything whose real ratio differs would
   * otherwise be stretched to fit.
   */
  fit?: "cover" | "contain" | "fill" | "none" | "scale-down"
  /**
   * An explicit ratio for the reserved box — `16 / 9`, `"4 / 3"`, or a number. Only needed when
   * `width` and `height` are not given, or when the box should not match the file.
   */
  ratio?: number | string
  /**
   * A tiny inline image (a data URI, a few hundred bytes) drawn in the reserved box while the real
   * one is in flight. The low-resolution original is what makes it look soft; no filter is applied,
   * so nothing has to be undone once the real image is on top of it.
   */
  placeholder?: string
  /**
   * Load immediately instead of when it comes near the viewport. Set it on the image that is
   * already on screen when the page opens: deferring that one costs a round trip in the middle of
   * the largest paint, and native laziness really does defer — measured 5,000px below the fold, the
   * element was still `complete === false` after 1.5s with no scrolling.
   */
  eager?: boolean
}

/**
 * An `<img>` that holds its place in the layout from the first frame and defers its own fetch,
 * so a long page of pictures neither pushes itself around as they arrive nor fetches all of them
 * at once.
 *
 * It stays one element. There is no wrapper, no `position: relative` parent, and no second node for
 * the placeholder — the reserved ratio, the skeleton and the low-resolution preview are all the
 * image's own style, which is what keeps it a drop-in for the `<img>` it replaces: every selector,
 * grid placement and margin that already pointed at that element still points at it.
 *
 * What it does not do: pick a `srcset` for you, host or generate the low-resolution preview, or
 * decode off the main thread. Those belong to whatever produces the images. Within pulld,
 * `image-zoom` takes over once an image is on screen and worth examining, `image-comparison` puts
 * two of them side by side, and `avatar-stack` handles the small round case with its own fallbacks.
 *
 * Nothing here needs official shadcn's `aspect-ratio`, and the two are not alternatives: that one
 * is a Radix box that imposes a ratio on whatever is inside it, and knows nothing about loading,
 * caching or failure. This is the image itself.
 */
export function LazyImage({
  src,
  fallbackSrc,
  onStatusChange,
  alt,
  fit = "cover",
  ratio,
  placeholder,
  eager = false,
  width,
  height,
  className,
  style,
  ...props
}: LazyImageProps) {
  const { status, currentSrc, ref, onLoad, onError } = useLazyImage({
    src,
    fallbackSrc,
    onStatusChange,
  })
  const aspectRatio = reserveRatio(width, height, ratio)
  const loading = status === "loading"

  return (
    <img
      ref={ref}
      src={currentSrc}
      alt={alt}
      width={width}
      height={height}
      // Set as attributes rather than toggled later: both are read when the element is inserted,
      // and an element that has already begun loading cannot be made lazy afterwards.
      loading={eager ? "eager" : "lazy"}
      // `async` only for the deferred ones, so a decode cannot hold up a frame the reader is
      // already looking at. The eager one is left at the browser's own default: `sync` would be the
      // tempting symmetry, and it can delay the first paint it is meant to improve, which is not
      // something measured here and so not something to assert in a default.
      decoding={eager ? undefined : "async"}
      fetchPriority={eager ? "high" : undefined}
      // Announced as busy only while something is genuinely on its way. A broken image is not busy;
      // it is an image whose `alt` is now the whole of it, which is what a browser shows anyway.
      aria-busy={loading || undefined}
      onLoad={onLoad}
      onError={onError}
      className={cn(
        "block max-w-full",
        fit === "cover" && "object-cover",
        fit === "contain" && "object-contain",
        fit === "fill" && "object-fill",
        fit === "none" && "object-none",
        fit === "scale-down" && "object-scale-down",
        // The skeleton is the element's own background, so it is covered by the picture the moment
        // there is one and needs no removal — except that a transparent PNG would keep showing it,
        // which is why it is dropped on `loaded` as well as never drawn under a preview.
        loading && !placeholder && "animate-pulse bg-muted",
        status === "error" && "bg-muted text-muted-foreground text-sm",
        className
      )}
      style={{
        aspectRatio,
        backgroundImage: loading && placeholder ? `url(${JSON.stringify(placeholder)})` : undefined,
        backgroundSize: loading && placeholder ? "cover" : undefined,
        backgroundPosition: loading && placeholder ? "center" : undefined,
        ...style,
      }}
      {...props}
    />
  )
}
