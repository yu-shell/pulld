"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * How far the finger has to move before the gesture commits to an axis, in CSS pixels.
 *
 * Small enough that the row starts following the finger almost at once, large enough that the
 * first two or three samples of a flick — which are noisy, and often perfectly diagonal — do not
 * get to decide.
 */
export const AXIS_SLOP = 8

/** Fraction of the panel that has to be showing for a release to snap open (default half). */
export const DEFAULT_OPEN_RATIO = 0.5

/**
 * Speed at which a release counts as a flick rather than a drag, in CSS pixels per millisecond.
 *
 * A flick is the gesture people actually make once they know the row swipes: a short, fast throw
 * that never travels half the panel's width. Judged on distance alone it snaps shut, and the row
 * feels like it is refusing to open.
 */
export const FLICK_VELOCITY = 0.35

/**
 * Width assumed per action when the panel has not been measured, in CSS pixels.
 *
 * Only ever used before layout — on the server, and on the very first client render — where
 * `offsetWidth` is 0 and a snap point of 0 would mean the row could not open at all.
 */
export const DEFAULT_ACTION_WIDTH = 72

/** Which physical side of the row the panel sits on, once the writing direction is resolved. */
export function panelSide(side: "start" | "end", rtl: boolean): "left" | "right" {
  // `side` is logical, so "end" is the right in an English list and the left in an Arabic one. The
  // panel is positioned with `inset-inline-*`, which the browser resolves on its own; this exists
  // because the row is moved with `translateX`, and there is no logical transform to move it with.
  return (side === "end") !== rtl ? "right" : "left"
}

/**
 * The sign that turns physical finger travel into "how far open", for the configured side.
 *
 * Revealing a panel on the right means dragging left, so a negative `dx` is positive progress.
 * Getting this from a hard-coded `-dx` is the RTL bug: on an Arabic page the panel is on the left,
 * the finger goes right to open it, and a component that only knows how to subtract opens the row
 * when it is swiped shut and refuses when it is swiped open.
 */
export function openingSign(side: "start" | "end", rtl: boolean): 1 | -1 {
  return panelSide(side, rtl) === "right" ? -1 : 1
}

/** Which way a gesture has turned out to be going. */
export type SwipeAxis = "undecided" | "horizontal" | "vertical"

/**
 * Decides the axis once the finger has left the slop circle.
 *
 * Ties go to vertical — the opposite of the same decision in a pull-to-refresh, and for the same
 * reason read from the other side. Here the component *is* the row inside the list, so the thing it
 * can wreck is the list's scrolling: claim a drag that was really a scroll and the list stops moving
 * under the finger, which makes the page feel broken rather than merely unhelpful. Refusing a swipe
 * costs one more try. A drag that is exactly as sideways as it is downward is far more likely to be
 * a thumb starting a scroll — thumbs travel in arcs — than a deliberate sideways pull.
 */
export function decideAxis(dx: number, dy: number, slop: number = AXIS_SLOP): SwipeAxis {
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (ax < slop && ay < slop) return "undecided"
  return ax > ay ? "horizontal" : "vertical"
}

/**
 * How far the row can travel: the measured panel width, or an estimate before layout exists.
 *
 * `measured` is 0 on the server and on the first client render, and a component that took that
 * literally would ship a row that cannot be opened until something else happens to re-render it.
 * With no actions the answer is 0 on purpose — there is nothing to reveal, so the gesture is dead
 * rather than dragging the row off to show bare background.
 */
export function revealWidth(
  measured: number,
  actionCount: number,
  perAction: number = DEFAULT_ACTION_WIDTH
): number {
  if (measured > 0) return measured
  return Math.max(0, actionCount) * Math.max(0, perAction)
}

/**
 * Clamps live finger travel to what there is to show.
 *
 * Deliberately a hard stop rather than the tapering overshoot a pull-to-refresh wants. The panel's
 * width *is* the whole of what exists behind the row: a drag past it would slide the row off the
 * top of nothing, exposing the background of the list, and a rubber band that reveals no further
 * information is motion for its own sake. Stopping exactly where the last action ends also tells
 * the person something true — that they have seen all of them.
 */
export function clampOffset(raw: number, reveal: number): number {
  // Written as a pair of comparisons rather than `Math.min(Math.max(...))` so that a NaN — which is
  // what a `clientX` read from a touch that has already ended gives — collapses to 0 instead of
  // propagating into `translateX(NaNpx)`, which browsers drop silently along with the whole
  // transform, leaving the row wherever it happened to be.
  if (!(raw > 0)) return 0
  if (raw > reveal) return reveal
  return raw
}

/** What to do with the row when the finger lifts. */
export function shouldOpen(
  offset: number,
  velocity: number,
  reveal: number,
  {
    openRatio = DEFAULT_OPEN_RATIO,
    flickVelocity = FLICK_VELOCITY,
  }: { openRatio?: number; flickVelocity?: number } = {}
): boolean {
  if (!(reveal > 0)) return false
  // Speed is asked first, in both directions. A fast throw outward opens a row the finger never
  // took half way, and a fast throw back closes one that is still more than half open — which is
  // exactly what someone flicking a row shut is asking for, and what a distance-only test refuses.
  if (velocity >= flickVelocity) return true
  if (velocity <= -flickVelocity) return false
  return offset >= reveal * openRatio
}

/** One touch sequence, from the finger landing to it lifting. */
export interface SwipeGesture {
  originX: number
  originY: number
  /**
   * How far open the row already was when the finger landed.
   *
   * Without it a second drag on a row that is already showing its actions starts from 0 and the row
   * jumps shut under the finger before it begins to move.
   */
  baseOffset: number
  /** Fixed for the whole gesture: re-reading the writing direction mid-drag could invert it. */
  sign: 1 | -1
  axis: SwipeAxis
  /** Revealed pixels, unsigned, clamped to the panel width. */
  offset: number
  /** Pixels per millisecond, positive towards open. */
  velocity: number
  lastX: number
  lastAt: number
  /** Once true, nothing later in this same touch sequence can swipe. */
  abandoned: boolean
}

export function beginSwipe(
  x: number,
  y: number,
  at: number,
  baseOffset: number,
  sign: 1 | -1
): SwipeGesture {
  return {
    originX: x,
    originY: y,
    baseOffset,
    sign,
    axis: "undecided",
    offset: baseOffset,
    velocity: 0,
    lastX: x,
    lastAt: at,
    abandoned: false,
  }
}

/** What `advanceSwipe` needs from a `touchmove`. */
export interface SwipeMove {
  x: number
  y: number
  /** `event.timeStamp` or `Date.now()`; only differences are used. */
  at: number
  /** `event.touches.length`. A second finger means a pinch, not a swipe. */
  touchCount: number
  /**
   * `event.cancelable`. False once the browser has committed this sequence to scrolling, after
   * which `preventDefault` does nothing but log a warning.
   */
  cancelable: boolean
}

export interface SwipeMoveResult {
  gesture: SwipeGesture
  /** True when the caller has to call `preventDefault()` on this event. */
  claim: boolean
}

/**
 * Gives the gesture up, leaving the row where it already was.
 *
 * Returning to `baseOffset` rather than to 0 is the point: a row whose actions are showing has to
 * stay showing while the person scrolls the list past it. Snapping it shut on the first vertical
 * drag is the bug where the row someone just opened disappears as they reach for its buttons.
 */
const abandon = (gesture: SwipeGesture): SwipeMoveResult => ({
  gesture: { ...gesture, offset: gesture.baseOffset, abandoned: true },
  claim: false,
})

/**
 * Folds one `touchmove` into the gesture, and says whether the event has to be claimed.
 *
 * Every `abandon` here is a gesture this component deliberately declines, and each one is a way the
 * short version misbehaves: a pinch-zoom that drags the row sideways, a scroll that opens every row
 * it passes under, and a drag the browser has already taken charge of.
 */
export function advanceSwipe(
  gesture: SwipeGesture,
  move: SwipeMove,
  { reveal, slop = AXIS_SLOP }: { reveal: number; slop?: number }
): SwipeMoveResult {
  if (gesture.abandoned) return { gesture, claim: false }
  if (move.touchCount > 1) return abandon(gesture)

  const dx = move.x - gesture.originX
  const dy = move.y - gesture.originY

  let axis = gesture.axis
  if (axis === "undecided") {
    axis = decideAxis(dx, dy, slop)
    // Still inside the slop: nothing decided, nothing claimed, and nothing abandoned — the same
    // sequence gets to try again on the next move. Abandoning here would kill every swipe that
    // starts slowly.
    if (axis === "undecided") return { gesture, claim: false }
    if (axis === "vertical") return abandon(gesture)
  }

  // The browser decides whether a touch sequence belongs to the page or to us, and once it has
  // chosen the page this flag is how it says so. Carrying on would slide the row sideways on top of
  // a scroll that cannot be stopped.
  if (!move.cancelable) return abandon(gesture)

  // Held over from the previous sample when two moves share a timestamp — which happens on every
  // engine that coalesces them — because 0/0 would otherwise wipe out a flick's speed on its last
  // sample, the one release reads.
  const dt = move.at - gesture.lastAt
  const velocity = dt > 0 ? (gesture.sign * (move.x - gesture.lastX)) / dt : gesture.velocity

  return {
    gesture: {
      ...gesture,
      axis,
      offset: clampOffset(gesture.baseOffset + gesture.sign * dx, reveal),
      velocity,
      lastX: move.x,
      lastAt: move.at,
    },
    claim: true,
  }
}

/** One thing a row can have done to it. */
export interface SwipeAction {
  /** Stable across renders; used as the React key. */
  id: string
  /** The visible text, and the accessible name when the action is icon-only. */
  label: string
  onSelect: () => void
  /** Drawn before the label and hidden from assistive technology, since the label is right there. */
  icon?: React.ReactNode
  /** `destructive` uses the theme's destructive tokens. */
  variant?: "default" | "destructive"
  /** Keeps the panel open after this action runs, for one that does not remove the row. */
  keepOpen?: boolean
  /** Renders the label as an `sr-only` name, for an icon-only button. */
  iconOnly?: boolean
}

/** Every string a user reads or hears. Override to translate or to reword. */
export interface SwipeActionsLabels {
  /** Accessible name of the always-present disclosure button. */
  toggle: string
  /** Accessible name of the group the actions sit in. */
  group: string
}

const defaultLabels: SwipeActionsLabels = {
  toggle: "Row actions",
  group: "Row actions",
}

export interface SwipeActionsProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "children" | "onTouchStart" | "onTouchEnd" | "onTouchCancel"
  > {
  /** The actions revealed behind the row, in the order they appear. An empty list disables the gesture. */
  actions: SwipeAction[]
  /** The row itself — whatever the list shows when nothing is revealed. */
  children: React.ReactNode
  /**
   * Which edge the actions come from, logically: `end` is the right of an English list and the left
   * of an Arabic one (default `end`).
   */
  side?: "start" | "end"
  /** Controlled state. Leave it out and the row manages its own. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Turns the gesture and the disclosure button off, leaving the row inert. */
  disabled?: boolean
  /**
   * Drop the disclosure button.
   *
   * Only pass this alongside your own control wired to `open`/`onOpenChange`. The gesture is touch
   * only: to a keyboard, a switch, a screen reader or a desktop mouse, actions that exist solely
   * behind a swipe do not exist at all.
   */
  hideToggle?: boolean
  /** Width assumed per action before the panel has been measured (default 72px). */
  actionWidth?: number
  /** Fraction of the panel that has to be showing for a release to open it (default 0.5). */
  openRatio?: number
  /** Classes for the moving row. Its background has to be opaque; the default supplies one. */
  rowClassName?: string
  labels?: Partial<SwipeActionsLabels>
}

/**
 * A list row that slides sideways to reveal its actions, with a button that reveals the same ones.
 *
 * The gesture is an accelerator, never the only way in — which is the half that is normally missing,
 * because a swipe looks finished on the phone it was built on.
 */
export const SwipeActions = React.forwardRef<HTMLDivElement, SwipeActionsProps>(
  function SwipeActions(
    {
      actions,
      children,
      side = "end",
      open: openProp,
      onOpenChange,
      disabled = false,
      hideToggle = false,
      actionWidth = DEFAULT_ACTION_WIDTH,
      openRatio = DEFAULT_OPEN_RATIO,
      rowClassName,
      labels,
      className,
      style,
      ...props
    },
    ref
  ) {
    const text = { ...defaultLabels, ...labels }
    const panelId = React.useId()

    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const panelRef = React.useRef<HTMLDivElement | null>(null)
    const toggleRef = React.useRef<HTMLButtonElement | null>(null)

    /**
     * How far the row is translated, in physical pixels, signed.
     *
     * The single rendered number, and deliberately physical rather than a logical offset plus a
     * direction read during render. `getComputedStyle` does not exist on the server, so resolving
     * the writing direction while rendering would put a transform in the client's first tree that is
     * absent from the server's HTML — and React discards the whole tree over that rather than
     * reconciling it. The direction is read at event time instead, when there is certainly a node.
     */
    const [shift, setShift] = React.useState(0)
    /** True only while a finger is down and swiping, which is when the transform must not animate. */
    const [dragging, setDragging] = React.useState(false)

    const gestureRef = React.useRef<SwipeGesture | null>(null)
    /**
     * Set when a gesture claimed the touch, and read by the capture-phase click handler.
     *
     * A touch that ends after moving still synthesises a click, so without this the row's own
     * `onClick` — opening the message that was being swiped — fires on every swipe.
     */
    const swipedRef = React.useRef(false)

    const openState = shift !== 0
    const isControlled = openProp !== undefined

    const currentSign = React.useCallback((): 1 | -1 => {
      const node = rootRef.current
      // No node and no `getComputedStyle` is the server, where nothing is being dragged; LTR is the
      // right guess because it is also what the CSS `inset-inline-end` will have resolved to in the
      // markup that was sent.
      const rtl =
        node && typeof getComputedStyle === "function"
          ? getComputedStyle(node as unknown as Element)?.direction === "rtl"
          : false
      return openingSign(side, rtl)
    }, [side])

    const measureReveal = React.useCallback(() => {
      const measured = panelRef.current?.offsetWidth
      return revealWidth(typeof measured === "number" ? measured : 0, actions.length, actionWidth)
    }, [actionWidth, actions.length])

    /**
     * Moves the row, and reports the change once — only when the row crosses between shut and open,
     * not on every pixel of a drag.
     */
    /**
     * The last open/shut state handed to `onOpenChange`.
     *
     * Kept separately from `shift` because the two do not change together: every pixel of a drag
     * moves the row, and none of them is a change of state. Reporting straight off `shift` would
     * announce a row as open the moment a finger nudged it three pixels, and announce it shut again
     * when the same nudge snapped back — a controlled parent would see a pair of events for a
     * gesture that did nothing. It is a ref rather than state because nothing renders from it, and
     * because comparing inside a `setShift` updater would fire the callback twice in StrictMode,
     * which runs updaters twice on purpose.
     */
    const reportedOpen = React.useRef(false)
    const report = React.useCallback(
      (open: boolean) => {
        if (reportedOpen.current === open) return
        reportedOpen.current = open
        onOpenChange?.(open)
      },
      [onOpenChange]
    )

    /** Moves the row, and reports only a crossing between shut and open. */
    const applyShift = React.useCallback(
      (next: number) => {
        setShift(next)
        report(next !== 0)
      },
      [report]
    )

    const close = React.useCallback(() => applyShift(0), [applyShift])

    const openPanel = React.useCallback(() => {
      const reveal = measureReveal()
      if (!(reveal > 0)) return
      applyShift(reveal * currentSign())
    }, [applyShift, currentSign, measureReveal])

    /**
     * Follows the controlled prop, in one direction only.
     *
     * A layout effect rather than a render-time comparison because it measures: reading
     * `offsetWidth` during render is a layout flush in the middle of one, and the measurement it
     * would take on the first pass is 0 anyway.
     */
    const lastOpenProp = React.useRef<boolean | undefined>(undefined)
    React.useLayoutEffect(() => {
      if (openProp === undefined) return
      if (openProp === lastOpenProp.current) return
      lastOpenProp.current = openProp
      reportedOpen.current = openProp
      if (openProp === openState) return
      const reveal = measureReveal()
      setShift(openProp && reveal > 0 ? reveal * currentSign() : 0)
    }, [currentSign, measureReveal, openProp, openState])

    const runAction = React.useCallback(
      (action: SwipeAction) => {
        if (!action.keepOpen) {
          close()
          // The actions are about to be hidden, and hiding the element that has focus drops the
          // focus ring on the document body — which for a keyboard user means losing their place in
          // a long list. The disclosure button is in the same row and is the way back in.
          toggleRef.current?.focus?.()
        }
        action.onSelect()
      },
      [close]
    )

    const onTouchStart = React.useCallback(
      (event: React.TouchEvent<HTMLDivElement>) => {
        gestureRef.current = null
        swipedRef.current = false
        if (disabled || actions.length === 0) return
        if (event.touches.length !== 1) return
        const touch = event.touches[0]
        gestureRef.current = beginSwipe(
          touch.clientX,
          touch.clientY,
          event.timeStamp,
          Math.abs(shift),
          currentSign()
        )
      },
      [actions.length, currentSign, disabled, shift]
    )

    const onTouchEnd = React.useCallback(() => {
      const gesture = gestureRef.current
      gestureRef.current = null
      setDragging(false)
      if (!gesture || gesture.abandoned) return
      const reveal = measureReveal()
      const open = shouldOpen(gesture.offset, gesture.velocity, reveal, { openRatio })
      applyShift(open ? reveal * gesture.sign : 0)
    }, [applyShift, measureReveal, openRatio])

    /**
     * The touch was taken away — an incoming call, the system's own edge gesture, a finger sliding
     * off the digitiser. Deliberately *not* the same handler as `onTouchEnd`: the row is far enough
     * across to snap open at that moment, and sharing one handler reveals actions the person never
     * released onto. It closes instead, and leaves nothing half way.
     */
    const onTouchCancel = React.useCallback(() => {
      const gesture = gestureRef.current
      gestureRef.current = null
      setDragging(false)
      if (!gesture) return
      applyShift(gesture.baseOffset * gesture.sign)
    }, [applyShift])

    /**
     * `touchmove` is attached by hand, with `passive: false`.
     *
     * React registers its own `onTouchMove` passively, and `preventDefault` on a passive listener is
     * dropped with a console warning — so the row would slide sideways *and* the list would scroll
     * behind it. No prop changes that. `touchstart`, `touchend` and `touchcancel` stay React props
     * precisely because none of them ever has to prevent anything.
     *
     * Registered once, against a handler kept in a ref and replaced each render, so a swipe does not
     * re-subscribe the row sixty times a second.
     */
    const moveHandler = React.useRef<(event: TouchEvent) => void>(() => {})
    React.useEffect(() => {
      moveHandler.current = (event: TouchEvent) => {
        const gesture = gestureRef.current
        if (!gesture) return
        const touch = event.touches[0]
        const { gesture: next, claim } = advanceSwipe(
          gesture,
          {
            x: touch?.clientX ?? gesture.lastX,
            y: touch?.clientY ?? gesture.originY,
            at: event.timeStamp,
            touchCount: event.touches.length,
            cancelable: event.cancelable,
          },
          { reveal: measureReveal() }
        )
        gestureRef.current = next
        if (claim) {
          event.preventDefault()
          swipedRef.current = true
        }
        setDragging(claim)
        setShift(next.offset * next.sign)
      }
    })
    React.useEffect(() => {
      const node = rootRef.current
      if (!node?.addEventListener) return
      const listener = (event: TouchEvent) => moveHandler.current(event)
      node.addEventListener("touchmove", listener, { passive: false })
      return () => node.removeEventListener("touchmove", listener)
    }, [])

    /**
     * A pointer going down anywhere else closes the row.
     *
     * Without it the actions stay out until something happens to the row itself, and a list read
     * with a thumb ends up with rows hanging open behind the one being used. `pointerdown` rather
     * than `click` so the row is already shut by the time the tap lands on whatever it was aimed at.
     */
    React.useEffect(() => {
      if (!openState) return
      if (typeof document === "undefined" || !document.addEventListener) return
      const listener = (event: Event) => {
        const node = rootRef.current
        if (node?.contains?.(event.target as Node)) return
        close()
      }
      document.addEventListener("pointerdown", listener, true)
      return () => document.removeEventListener("pointerdown", listener, true)
    }, [close, openState])

    const onKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== "Escape" || !openState) return
        // Stopped here so one Escape does not also close the dialog or drawer the list is inside.
        event.stopPropagation()
        close()
        toggleRef.current?.focus?.()
      },
      [close, openState]
    )

    /**
     * Hands the caller's ref the same node, instead of merging the two into one callback ref.
     *
     * This component needs an object ref of its own — `touchmove` is registered on this node by
     * hand, and a callback ref leaves nothing to register it against — and a row in a long list is
     * not the place to spend a second wrapper element on the difference. Cleared on unmount so a
     * caller holding the ref is not left pointing at a detached node.
     */
    React.useLayoutEffect(() => {
      if (typeof ref === "function") {
        ref(rootRef.current)
        return () => ref(null)
      }
      if (ref) {
        const holder = ref
        holder.current = rootRef.current
        return () => {
          holder.current = null
        }
      }
    }, [ref])

    const onClickCapture = React.useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (!swipedRef.current) return
        swipedRef.current = false
        // The click synthesised at the end of a swipe. Swallowed in the capture phase so it never
        // reaches the row's own handler, whatever that is: the person was moving the row, not
        // choosing it.
        event.preventDefault()
        event.stopPropagation()
      },
      []
    )

    const gestureEnabled = !disabled && actions.length > 0

    return (
      <div
        ref={rootRef}
        onTouchStart={gestureEnabled ? onTouchStart : undefined}
        onTouchEnd={gestureEnabled ? onTouchEnd : undefined}
        onTouchCancel={gestureEnabled ? onTouchCancel : undefined}
        onKeyDown={onKeyDown}
        onClickCapture={onClickCapture}
        className={cn("relative overflow-hidden", className)}
        // `pan-y` hands vertical scrolling back to the browser while keeping the horizontal
        // direction for this row, so an ancestor that scrolls sideways — a carousel, a wide table —
        // does not slide under the gesture. It is also why the `preventDefault` above has something
        // to prevent: with the default `auto` the browser would have started scrolling and marked
        // the sequence non-cancelable before the axis was even decided.
        style={{ touchAction: gestureEnabled ? "pan-y" : undefined, ...style }}
        {...props}
      >
        {/*
          Behind the row, on the logical side, and laid out by the browser rather than by a
          direction read in JavaScript: `inset-inline-end` is the right in English and the left in
          Arabic without this component having to know which.

          `aria-hidden` and `tabIndex={-1}` while shut, because a button that is completely covered
          by the row is one a keyboard can focus and nobody can see — a focus ring vanishing into a
          list is worse than no keyboard support at all. The `inert` attribute would say this more
          precisely and is deliberately not used: its typings landed in React 19, and a consumer on
          18 would have a component that does not compile. `pointer-events-none` covers the rest of
          what `inert` would have done.
        */}
        <div
          ref={panelRef}
          id={panelId}
          role="group"
          aria-label={text.group}
          aria-hidden={openState ? undefined : true}
          className={cn(
            "absolute inset-y-0 flex items-stretch",
            !openState && "pointer-events-none"
          )}
          style={side === "end" ? { insetInlineEnd: 0 } : { insetInlineStart: 0 }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              tabIndex={openState ? undefined : -1}
              onClick={() => runAction(action)}
              className={cn(
                "inline-flex min-w-[4.5rem] flex-col items-center justify-center gap-1 px-3",
                "text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                action.variant === "destructive"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              )}
            >
              {action.icon ? (
                <span aria-hidden="true" className="[&_svg]:size-4">
                  {action.icon}
                </span>
              ) : null}
              <span className={cn(action.iconOnly && "sr-only")}>{action.label}</span>
            </button>
          ))}
        </div>

        <div
          style={{ transform: shift !== 0 ? `translateX(${shift}px)` : undefined }}
          className={cn(
            // Opaque on purpose: the panel is directly underneath, and a transparent row shows the
            // actions through itself while claiming to be shut.
            "relative flex items-center gap-2 bg-background",
            // Animated on release, never during the drag: a transition while the finger is moving
            // makes the row trail behind it.
            !dragging && "transition-transform duration-200 motion-reduce:transition-none",
            rowClassName
          )}
        >
          <div className="min-w-0 flex-1">{children}</div>
          {/*
            Left out rather than hidden when `hideToggle` is set, because the `hidden` attribute
            would not have hidden it: `[hidden]` is a user-agent rule and any `display` from a class
            beats it, so the button would have stayed on screen while claiming to be gone.

            `aria-disabled`, not `disabled`: a disabled button loses focus the moment it is pressed,
            which drops the keyboard user out of the list they were working through.
          */}
          {hideToggle || actions.length === 0 ? null : (
            <button
              ref={toggleRef}
              type="button"
              aria-label={text.toggle}
              aria-expanded={openState}
              aria-controls={panelId}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (disabled) return
                if (openState) close()
                else openPanel()
              }}
              className={cn(
                "mr-1 inline-flex size-8 flex-none items-center justify-center rounded-md",
                "text-muted-foreground transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-accent hover:text-accent-foreground"
              )}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    )
  }
)
