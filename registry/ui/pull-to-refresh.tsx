"use client"

import * as React from "react"
import { ArrowDown, Loader2, RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"

/** How far the finger has to travel before releasing refreshes, in CSS pixels. */
export const DEFAULT_PULL_THRESHOLD = 64

/**
 * How far past the threshold the indicator can still be dragged, as a multiple of the threshold.
 * The pull tapers towards this and never reaches it, so the list cannot be dragged off the screen.
 */
export const DEFAULT_MAX_DISTANCE_RATIO = 2

/**
 * "At the top" is a window rather than `scrollTop === 0`.
 *
 * Browser zoom and fractional device pixel ratios both put a scroller at 0.5, and a list that will
 * not refresh at certain zoom levels is the bug that comes out of comparing against zero exactly.
 */
export const SCROLL_TOP_EPSILON = 1

/**
 * How long the scroller has to have been still before a touch may start a pull, in milliseconds.
 *
 * This is the guard against the gesture that has no business being a pull: a flick that is still
 * gliding to a stop, with a finger put back down to arrest it. Momentum fires `scroll` the whole
 * way, so "when did this last move" answers the question that `scrollTop` cannot.
 */
export const SETTLE_MS = 120

/** How far the finger has to move before the gesture commits to an axis, in CSS pixels. */
export const AXIS_SLOP = 8

/**
 * The distance the indicator shows for `raw` pixels of finger travel.
 *
 * One-to-one up to the threshold, because that is the only point in the gesture where the number
 * means something to the person making it: the indicator has to reach "release to refresh" exactly
 * when the finger has gone as far as the label implies. Past it the pull tapers — every further
 * pixel gives less than the one before — so the list cannot be dragged an arbitrary distance down
 * the screen, and the gesture feels like it is pulling against something rather than sliding.
 *
 * The taper is `extra / (extra + room)`: smooth, monotonic, asymptotic to `maxDistance` without
 * ever reaching it, and no exponential to reason about.
 */
export function resistedDistance(
  raw: number,
  threshold: number,
  maxDistance: number
): number {
  // Written as `raw > 0` rather than `raw <= 0` so a NaN — a clientY read from a touch that has
  // already ended is the way one gets here — collapses to zero instead of propagating through the
  // arithmetic and into a `translateY(NaNpx)` that silently drops the transform.
  if (!(raw > 0)) return 0
  if (raw <= threshold) return raw
  const room = Math.max(0, maxDistance - threshold)
  if (room === 0) return threshold
  const extra = raw - threshold
  return threshold + (room * extra) / (extra + room)
}

/**
 * Whether a touch landing now may begin a pull: the scroller is at the top **and at rest**.
 *
 * Both halves matter, and the obvious `scrollTop === 0` has neither.
 *
 * A negative `scrollTop` is not "even more at the top than zero" — it is the tell that the browser
 * is part-way through a rubber-band bounce and is already sliding the content down itself. Adding a
 * translate on top of that counts one pull twice and the list leaps away from the finger. iOS
 * reports it; other engines hold at 0 through the same bounce, which is why the second half of the
 * test cannot be a scroll position at all. `msSinceScroll` covers both: a bounce that moves the
 * content fires `scroll` whether or not the number it reports goes below zero.
 *
 * What is left over, honestly: an engine that neither reports a negative `scrollTop` nor fires
 * `scroll` during its bounce is indistinguishable from one at rest here, and a pull started then
 * will double up with the bounce. The threshold is what keeps that from becoming a refresh — a
 * finger put down to stop a list is not travelling 64 further pixels.
 */
export function canBeginPull(scrollTop: number, msSinceScroll: number): boolean {
  if (scrollTop <= -SCROLL_TOP_EPSILON) return false
  if (scrollTop >= SCROLL_TOP_EPSILON) return false
  return msSinceScroll >= SETTLE_MS
}

/**
 * Whether a pull in progress has to be given up because the scroller moved down under it.
 *
 * Asked on every move — but only ever to take the pull away, never to grant one. That asymmetry is
 * the whole of it: an implementation that instead asks "is `scrollTop` 0?" on each move hands out
 * pulls in the middle of scrolls, because a list gliding to a halt passes through 0 with the finger
 * already resting on it. Whether a gesture is allowed to pull at all is settled once, at touchstart,
 * by `canBeginPull`.
 */
export function hasScrolledAway(scrollTop: number): boolean {
  return scrollTop > SCROLL_TOP_EPSILON
}

/** Which way a gesture has turned out to be going. */
export type PullAxis = "undecided" | "vertical" | "horizontal"

/**
 * Decides the axis once the finger has left the slop circle.
 *
 * Ties go to horizontal on purpose. A drag that is exactly as sideways as it is downward is far
 * more likely to be someone starting on a carousel or a swipeable row inside the list than someone
 * pulling the list itself, and refusing the pull costs them one more try while stealing the swipe
 * breaks the thing they were touching.
 */
export function decideAxis(dx: number, dy: number, slop: number = AXIS_SLOP): PullAxis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < slop && ay < slop) return "undecided"
  return ay > ax ? "vertical" : "horizontal"
}

/** One touch sequence, from the finger landing to it lifting. */
export interface PullGesture {
  originX: number
  originY: number
  axis: PullAxis
  /** Resisted pixels the indicator is currently showing. */
  distance: number
  /** Once true, nothing later in this same touch sequence can pull. */
  abandoned: boolean
}

export function beginGesture(x: number, y: number): PullGesture {
  return { originX: x, originY: y, axis: "undecided", distance: 0, abandoned: false }
}

/** What `advanceGesture` needs from a `touchmove`. */
export interface PullMove {
  x: number
  y: number
  scrollTop: number
  /** `event.touches.length`. A second finger means a pinch, not a pull. */
  touchCount: number
  /**
   * `event.cancelable`. False once the browser has committed this sequence to scrolling, after
   * which `preventDefault` does nothing but log a warning.
   */
  cancelable: boolean
}

export interface PullMoveResult {
  gesture: PullGesture
  /** True when the caller has to call `preventDefault()` on this event. */
  claim: boolean
}

const abandoned = (gesture: PullGesture): PullMoveResult => ({
  gesture: { ...gesture, distance: 0, abandoned: true },
  claim: false,
})

/**
 * Folds one `touchmove` into the gesture, and says whether the event has to be claimed.
 *
 * Every `return abandoned(...)` here is a gesture this component deliberately does not treat as a
 * pull, and each one is a way the three-line version misbehaves: a pinch-zoom that opens the
 * indicator, a horizontal swipe on a row inside the list that refreshes it, a scroll upward that
 * becomes a pull the moment the finger crosses back down over where it started, and a pull drawn on
 * top of a native overscroll the browser has already taken charge of.
 */
export function advanceGesture(
  gesture: PullGesture,
  move: PullMove,
  { threshold, maxDistance }: { threshold: number; maxDistance: number }
): PullMoveResult {
  if (gesture.abandoned) return { gesture, claim: false }
  if (move.touchCount > 1) return abandoned(gesture)
  if (hasScrolledAway(move.scrollTop)) return abandoned(gesture)

  const dx = move.x - gesture.originX
  const dy = move.y - gesture.originY

  let axis = gesture.axis
  if (axis === "undecided") {
    axis = decideAxis(dx, dy)
    // Still inside the slop: nothing decided, nothing claimed, and crucially nothing abandoned —
    // the same sequence gets to try again on the next move.
    if (axis === "undecided") return { gesture, claim: false }
    if (axis === "horizontal") return abandoned(gesture)
  }

  // Back at or above where the finger landed. The list is being scrolled, so the pull is over —
  // given up rather than held at zero, because holding it at zero lets a scroll turn into a pull
  // the instant the finger wanders back down, which is the same bug as testing the scroll position
  // on every move.
  if (dy <= 0) return abandoned(gesture)

  // The browser decides whether a touch sequence still belongs to the page or to us, and once it
  // has chosen the page this flag is how it says so. Carrying on would draw an indicator over the
  // top of a native overscroll that cannot be stopped.
  if (!move.cancelable) return abandoned(gesture)

  return {
    gesture: { ...gesture, axis, distance: resistedDistance(dy, threshold, maxDistance) },
    claim: true,
  }
}

/** Whether releasing at this distance refreshes. */
export function isArmed(distance: number, threshold: number): boolean {
  return distance >= threshold
}

/** Every string a user reads or hears. Override to translate or to reword. */
export interface PullToRefreshLabels {
  /** The visible button, and its accessible name. */
  refresh: string
  /** In the indicator while the finger is still short of the threshold. */
  pull: string
  /** In the indicator once releasing would refresh. */
  release: string
  /** In the indicator and announced while a refresh is in flight. */
  refreshing: string
  /** Announced once a refresh finishes — the only feedback a screen-reader user gets. */
  refreshed: string
  /** Announced when `onRefresh` rejects. */
  error: string
}

const defaultLabels: PullToRefreshLabels = {
  refresh: "Refresh",
  pull: "Pull to refresh",
  release: "Release to refresh",
  refreshing: "Refreshing…",
  refreshed: "List updated.",
  error: "Couldn't refresh.",
}

export interface PullToRefreshProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onTouchStart" | "onTouchEnd" | "onTouchCancel" | "children"
  > {
  /**
   * Reload the list. Return the promise and the indicator stays up until it settles; a rejection is
   * caught here and announced rather than leaving the spinner running forever.
   *
   * Called at most once at a time. A second pull, or the button, while one is in flight does
   * nothing — so this does not have to be idempotent.
   */
  onRefresh: () => void | Promise<unknown>
  /**
   * The list. It is laid out inside the scroller this renders, so give that scroller a height with
   * `scrollClassName` (`h-dvh`, `h-96`, `flex-1`) — without one it grows to fit and never scrolls,
   * and a box that never scrolls is never at its top.
   */
  children: React.ReactNode
  /** Finger travel that arms the refresh, in CSS pixels (default 64). */
  threshold?: number
  /** How far the pull can taper to, in CSS pixels (default `threshold * 2`). */
  maxDistance?: number
  /** Turns the gesture off and puts the button into `aria-disabled`. */
  disabled?: boolean
  /**
   * Drop the button.
   *
   * Only pass this alongside your own control wired to the same `onRefresh`. The gesture is touch
   * only: to a keyboard, a switch, a screen reader or a desktop mouse, a list whose sole way to
   * reload is a pull cannot be reloaded at all.
   */
  hideButton?: boolean
  /** Classes for the scrolling box. Its height belongs here. */
  scrollClassName?: string
  labels?: Partial<PullToRefreshLabels>
}

/**
 * A list that reloads when it is pulled down from the top, with a button that always does the same
 * job.
 *
 * The scroller is this component's own element so that `overscroll-behavior-y: contain` is not
 * something a consumer has to remember: without it Chrome on Android runs its own pull-to-refresh
 * over the top of this one and the page shows two spinners for one gesture.
 */
export const PullToRefresh = React.forwardRef<HTMLDivElement, PullToRefreshProps>(
  function PullToRefresh(
    {
      onRefresh,
      children,
      threshold = DEFAULT_PULL_THRESHOLD,
      maxDistance,
      disabled = false,
      hideButton = false,
      scrollClassName,
      labels,
      className,
      ...props
    },
    ref
  ) {
    const text = { ...defaultLabels, ...labels }
    const ceiling = maxDistance ?? threshold * DEFAULT_MAX_DISTANCE_RATIO

    const scrollRef = React.useRef<HTMLDivElement | null>(null)
    const [distance, setDistance] = React.useState(0)
    const [refreshing, setRefreshing] = React.useState(false)
    const [message, setMessage] = React.useState("")
    /** True only while a finger is down and pulling, which is when the transform must not animate. */
    const [dragging, setDragging] = React.useState(false)

    const gestureRef = React.useRef<PullGesture | null>(null)
    /** Guards re-entry: one refresh at a time, whether it came from the gesture or the button. */
    const busyRef = React.useRef(false)
    const mountedRef = React.useRef(true)
    React.useEffect(
      () => () => {
        mountedRef.current = false
      },
      []
    )

    /**
     * When the scroller last moved. `canBeginPull` reads it to tell a list at rest from one still
     * gliding; see the note there for why a scroll position cannot answer that on its own.
     *
     * Kept in a ref and stamped from the event, so a scroll costs nothing but an assignment — a
     * momentum scroll fires this every frame, and re-rendering the list on each one would be worse
     * than the bug it is here to prevent.
     */
    const lastScrollAtRef = React.useRef(-Infinity)
    const onScroll = React.useCallback(() => {
      lastScrollAtRef.current = Date.now()
    }, [])

    const run = React.useCallback(() => {
      if (busyRef.current || disabled) return
      busyRef.current = true
      setRefreshing(true)
      setMessage(text.refreshing)
      const settle = (announcement: string) => {
        busyRef.current = false
        if (!mountedRef.current) return
        setRefreshing(false)
        setDistance(0)
        setMessage(announcement)
      }
      try {
        const result = onRefresh()
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          Promise.resolve(result).then(
            () => settle(text.refreshed),
            () => settle(text.error)
          )
          return
        }
      } catch {
        // A loader that throws synchronously is the same failure as one that rejects, and leaving
        // `busyRef` set here would wedge the component for good.
        settle(text.error)
        return
      }
      // Nothing to wait on. The refresh has already happened as far as this component can tell.
      settle(text.refreshed)
    }, [disabled, onRefresh, text.error, text.refreshed, text.refreshing])

    /**
     * The finger lifted. This is the only path that may refresh.
     */
    const onTouchEnd = React.useCallback(() => {
      const gesture = gestureRef.current
      gestureRef.current = null
      setDragging(false)
      if (gesture && !gesture.abandoned && isArmed(gesture.distance, threshold)) {
        run()
        return
      }
      setDistance(0)
    }, [run, threshold])

    /**
     * The touch was taken away — an incoming call, the system's own edge gesture, a finger sliding
     * off the digitiser. Deliberately *not* the same handler as `onTouchEnd`: the list is far enough
     * down to be armed at that moment, and sharing one handler refreshes on an interruption the
     * person never released. It has to close without refreshing, and without leaving the indicator
     * hanging open, since no `touchend` is coming.
     */
    const onTouchCancel = React.useCallback(() => {
      gestureRef.current = null
      setDragging(false)
      setDistance(0)
    }, [])

    const onTouchStart = React.useCallback(
      (event: React.TouchEvent<HTMLDivElement>) => {
        gestureRef.current = null
        if (disabled || busyRef.current) return
        if (event.touches.length !== 1) return
        const scroller = scrollRef.current
        const scrollTop = scroller?.scrollTop ?? 0
        if (!canBeginPull(scrollTop, Date.now() - lastScrollAtRef.current)) return
        const touch = event.touches[0]
        gestureRef.current = beginGesture(touch.clientX, touch.clientY)
      },
      [disabled]
    )

    /**
     * `touchmove` is attached by hand, with `passive: false`.
     *
     * React registers its own `onTouchMove` passively, and `preventDefault` on a passive listener is
     * dropped with a console warning — so the indicator would come down *and* the browser would
     * overscroll behind it. No prop changes that; the listener has to be added here. `touchstart`,
     * `touchend` and `touchcancel` stay React props precisely because none of them ever has to
     * prevent anything.
     *
     * Registered once, against a handler kept in a ref and replaced each render, so a pull does not
     * re-subscribe the scroller sixty times a second.
     */
    const moveHandler = React.useRef<(event: TouchEvent) => void>(() => {})
    React.useEffect(() => {
      moveHandler.current = (event: TouchEvent) => {
        const gesture = gestureRef.current
        if (!gesture) return
        const touch = event.touches[0]
        const { gesture: next, claim } = advanceGesture(
          gesture,
          {
            x: touch?.clientX ?? gesture.originX,
            y: touch?.clientY ?? gesture.originY,
            scrollTop: scrollRef.current?.scrollTop ?? 0,
            touchCount: event.touches.length,
            cancelable: event.cancelable,
          },
          { threshold, maxDistance: ceiling }
        )
        gestureRef.current = next
        if (claim) event.preventDefault()
        setDragging(claim)
        setDistance(next.distance)
      }
    })
    React.useEffect(() => {
      const scroller = scrollRef.current
      if (!scroller?.addEventListener) return
      const listener = (event: TouchEvent) => moveHandler.current(event)
      scroller.addEventListener("touchmove", listener, { passive: false })
      return () => scroller.removeEventListener("touchmove", listener)
    }, [])

    const armed = isArmed(distance, threshold)
    // Held open at the threshold while the request is out, so the spinner has somewhere to sit
    // instead of the list snapping shut over it the instant the finger lifts.
    const offset = refreshing ? threshold : distance
    const progress = Math.min(1, threshold > 0 ? distance / threshold : 0)

    return (
      <div ref={ref} className={cn("flex flex-col", className)} {...props}>
        <div className="flex items-center justify-between gap-2 px-1 pb-1">
          {/*
            Left out rather than hidden, because the `hidden` attribute would not have hidden it:
            `[hidden]` is a user-agent rule and any `display` coming from a class beats it, so the
            button would have stayed on screen while claiming to be gone.

            `aria-disabled`, not `disabled`: a disabled button loses focus the moment it is pressed,
            which drops the keyboard user out of the list they were refreshing. This one keeps focus
            and simply does nothing.
          */}
          {hideButton ? null : (
            <button
              type="button"
              onClick={run}
              aria-disabled={refreshing || disabled}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5",
                "text-sm font-medium text-foreground shadow-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                refreshing || disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <RefreshCw
                className={cn("size-4", refreshing && "animate-spin")}
                aria-hidden="true"
              />
              {text.refresh}
            </button>
          )}
          {/*
            The live region is the whole of the accessible feedback: the indicator below is a
            drawing of a finger's position, which is nothing at all to a screen reader. It is
            rendered unconditionally so the region exists in the DOM before it has anything to say —
            one inserted at the same moment as its text is commonly announced late or not at all.
          */}
          <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
            {message}
          </span>
        </div>

        <div
          ref={scrollRef}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchCancel}
          onScroll={onScroll}
          aria-busy={refreshing || undefined}
          className={cn(
            // `contain`, not `none`: it stops the gesture reaching the browser's own
            // pull-to-refresh and stops the scroll chaining to the page behind, while leaving the
            // rubber-band bounce that tells people they have reached the end.
            "relative overflow-y-auto overscroll-y-contain",
            scrollClassName
          )}
        >
          <div
            style={{ transform: offset > 0 ? `translateY(${offset}px)` : undefined }}
            className={cn(
              "relative",
              // Animated on release, never during the drag: a transition while the finger is moving
              // makes the list trail behind it.
              !dragging && "transition-transform duration-200 motion-reduce:transition-none"
            )}
          >
            {/*
              Sits directly above the content and is clipped by the scroller until the transform
              reveals it. `aria-hidden` because everything it conveys is already in the live region
              and in the button's spinner.
            */}
            <div
              aria-hidden="true"
              className="absolute inset-x-0 bottom-full flex flex-col items-center justify-end gap-1 pb-2"
              style={{ height: Math.max(threshold, offset) }}
            >
              {refreshing ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : (
                <ArrowDown
                  className="size-5 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none"
                  style={{ transform: `rotate(${armed ? 180 : 0}deg)`, opacity: progress }}
                />
              )}
              <span className="text-xs text-muted-foreground" style={{ opacity: progress }}>
                {refreshing ? text.refreshing : armed ? text.release : text.pull}
              </span>
            </div>
            {children}
          </div>
        </div>
      </div>
    )
  }
)
