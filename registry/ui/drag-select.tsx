"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The attribute that marks a selectable thing, and the id it carries.
 *
 * It is an attribute rather than a wrapper component on purpose: the rows, cards and tiles being
 * selected already exist, written however the app writes them, and a marquee should not require
 * them to be re-parented to work.
 */
export const DRAG_SELECT_ITEM_ATTR = "data-drag-select-item"

/** Spread onto a selectable element: `<li {...dragSelectItem(file.id)}>`. */
export function dragSelectItem(id: string) {
  return { [DRAG_SELECT_ITEM_ATTR]: id }
}

export interface DragSelectPoint {
  x: number
  y: number
}

export interface DragSelectBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Everything needed to turn a viewport coordinate into a content coordinate, read off the scroll
 * container in one go.
 *
 * `borderLeft`/`borderTop` are the container's `clientLeft`/`clientTop`. They are here because the
 * two coordinate systems being reconciled do not share an origin: `getBoundingClientRect()` is
 * measured from the border box, while an absolutely positioned child — which is what the marquee
 * is — is placed from the padding box. Leave the border out and the box sits a border-width away
 * from the pointer, which looks like nothing at all on the usual 1px border and like a bug at 4px.
 */
export interface DragSelectFrame {
  left: number
  top: number
  borderLeft: number
  borderTop: number
  scrollLeft: number
  scrollTop: number
}

/** How a press combines with the selection that already exists. */
export type DragSelectMode = "replace" | "add" | "subtract"

export interface DragSelectSession {
  pointerId: number
  /** Where the press landed, in content coordinates. Fixed for the life of the session. */
  anchor: DragSelectPoint
  /** Where the pointer is now, in content coordinates. */
  point: DragSelectPoint
  /**
   * Where the pointer is now in viewport coordinates, kept because an auto-scroll frame has to
   * recompute the content point when no pointer event has arrived: the finger is still, the
   * content underneath it is not.
   */
  viewport: DragSelectPoint
  /** The selection as it stood when the press landed — what `subtract` subtracts from. */
  base: string[]
  mode: DragSelectMode
  /** False until the pointer has travelled past the threshold; no box is drawn before that. */
  active: boolean
}

/** Pointer travel, in pixels, before a press becomes a marquee rather than a click. */
export const DRAG_SELECT_THRESHOLD = 4

/** How close to the container's edge the pointer has to get before the container scrolls itself. */
export const DRAG_SELECT_EDGE = 32

/** Pixels per frame at the very edge, tapering to zero at the start of the edge band. */
export const DRAG_SELECT_SPEED = 14

/**
 * A viewport point in the container's content coordinates.
 *
 * This conversion is the whole first half of the component. The marquee is drawn in content
 * coordinates and hit-tested in content coordinates, so that scrolling moves the rectangle with
 * the items instead of out from under them — add the scroll offset in one place and not the other
 * and the selection jumps the moment the list is flicked down.
 */
export function toContentPoint(point: DragSelectPoint, frame: DragSelectFrame): DragSelectPoint {
  return {
    x: point.x - frame.left - frame.borderLeft + frame.scrollLeft,
    y: point.y - frame.top - frame.borderTop + frame.scrollTop,
  }
}

/**
 * An element's viewport rectangle in the container's content coordinates.
 *
 * Width and height carry over untouched: scrolling moves an element, it does not resize it.
 */
export function toContentBox(
  rect: { left: number; top: number; width: number; height: number },
  frame: DragSelectFrame
): DragSelectBox {
  const origin = toContentPoint({ x: rect.left, y: rect.top }, frame)
  return { left: origin.x, top: origin.y, width: rect.width, height: rect.height }
}

/** The rectangle between two corners, in either order — a drag up and left is still a rectangle. */
export function boxBetween(a: DragSelectPoint, b: DragSelectPoint): DragSelectBox {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/**
 * Whether two boxes overlap, with touching edges not counting as overlap.
 *
 * Exclusive bounds are the difference between a rectangle dragged up to a row and one that has
 * taken it: at the moment the marquee's edge is flush with the row's, inclusive bounds select the
 * row the rectangle is visibly *not* over, which is an off-by-one nobody can reproduce on purpose.
 *
 * The consequence for a degenerate rectangle is the right one rather than a special case. A
 * perfectly horizontal drag has zero height and is a real gesture — dragging along a row of tiles
 * — and it selects what the line passes through; a drag straight down a gutter that coincides with
 * the items' own edge is touching them, not crossing them, and selects nothing. Neither depends on
 * the path the pointer took, because the selection is recomputed from the current rectangle on
 * every move rather than accumulated.
 */
export function boxesOverlap(a: DragSelectBox, b: DragSelectBox): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  )
}

/**
 * Which modifier means what, read off the press that starts the drag.
 *
 * Shift and the platform's own multi-select modifier both add, because a marquee has no "extend
 * from the last one" to be different about — in a rectangle, extending and adding are the same
 * gesture. Alt removes, which is how a file manager lets you cut a hole in a selection without
 * starting over.
 */
export function dragSelectMode(event: {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): DragSelectMode {
  if (event.altKey) return "subtract"
  if (event.shiftKey || event.metaKey || event.ctrlKey) return "add"
  return "replace"
}

/**
 * The selection a box produces, given what was selected before it was drawn.
 *
 * `base` order is preserved and hits are appended in the order they were found, so a selection that
 * is shown back to the user — or sent as a payload — does not reshuffle itself on every move of the
 * pointer.
 */
export function applyDragSelection(
  base: readonly string[],
  hits: readonly string[],
  mode: DragSelectMode
): string[] {
  if (mode === "replace") return [...hits]
  if (mode === "subtract") {
    const drop = new Set(hits)
    return base.filter((id) => !drop.has(id))
  }
  const seen = new Set(base)
  return [...base, ...hits.filter((id) => !seen.has(id))]
}

/** The ids whose boxes the marquee is over, in the order they were given. */
export function boxHits(
  items: readonly { id: string; box: DragSelectBox }[],
  box: DragSelectBox
): string[] {
  return items.filter((item) => boxesOverlap(item.box, box)).map((item) => item.id)
}

/**
 * How far the container should scroll itself this frame, from where the pointer is inside it.
 *
 * Without this the component is quietly mouse-and-visible-area only: drag to the bottom of a
 * scrolling list and the rows below the fold can never be reached, because the list only scrolls
 * for a wheel it is not being given. The speed tapers across the edge band instead of switching on
 * at full tilt, so arriving near the edge nudges and pinning against it runs.
 *
 * `bounds` is the container's own viewport rectangle and `point` the pointer in viewport
 * coordinates — both outside the content system, because the question "is the finger near the edge
 * of the window onto the list" is about the window, not about the list.
 */
export function edgeScrollDelta(
  point: DragSelectPoint,
  bounds: { left: number; top: number; width: number; height: number },
  edge = DRAG_SELECT_EDGE,
  speed = DRAG_SELECT_SPEED
): { dx: number; dy: number } {
  const axis = (position: number, start: number, length: number) => {
    // A band wider than half the container would overlap its own opposite number and scroll both
    // ways at once in the middle; clamping keeps a short list from scrolling while the pointer sits
    // still in the centre of it.
    const band = Math.min(edge, length / 2)
    if (band <= 0) return 0
    const fromStart = position - start
    const fromEnd = start + length - position
    if (fromStart < band) return -speed * Math.min(1, (band - Math.max(fromStart, 0)) / band)
    if (fromEnd < band) return speed * Math.min(1, (band - Math.max(fromEnd, 0)) / band)
    return 0
  }
  return {
    dx: axis(point.x, bounds.left, bounds.width),
    dy: axis(point.y, bounds.top, bounds.height),
  }
}

/** Starts a session, not yet a marquee: `active` stays false until the threshold is crossed. */
export function beginDragSelect(init: {
  pointerId: number
  viewport: DragSelectPoint
  content: DragSelectPoint
  base: readonly string[]
  mode: DragSelectMode
}): DragSelectSession {
  return {
    pointerId: init.pointerId,
    anchor: init.content,
    point: init.content,
    viewport: init.viewport,
    base: [...init.base],
    mode: init.mode,
    active: false,
  }
}

/**
 * Moves a session to a new pointer position, arming it once it has travelled far enough.
 *
 * The threshold is measured from the anchor rather than between consecutive moves, and once armed
 * the session stays armed: a marquee that disarmed itself whenever the pointer came back near where
 * it started would release a selection the user has already seen.
 */
export function advanceDragSelect(
  session: DragSelectSession,
  next: { viewport: DragSelectPoint; content: DragSelectPoint },
  threshold = DRAG_SELECT_THRESHOLD
): DragSelectSession {
  const travelled =
    Math.abs(next.content.x - session.anchor.x) >= threshold ||
    Math.abs(next.content.y - session.anchor.y) >= threshold
  return {
    ...session,
    point: next.content,
    viewport: next.viewport,
    active: session.active || travelled,
  }
}

interface DragSelectProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange"> {
  /**
   * The list, grid or canvas being selected over. Mark the selectable elements with
   * `{...dragSelectItem(id)}`; anything else inside is empty space a drag may start from.
   */
  children: React.ReactNode
  /** Controlled set of selected ids. Pair with `onChange` to own the state. */
  value?: string[]
  /** Selected ids on first render when uncontrolled. */
  defaultValue?: string[]
  /** Handed the next set of selected ids — during the drag as well as at the end of it. */
  onChange?: (ids: string[]) => void
  /** Told when a marquee appears and disappears, for a cursor or a hint in the surrounding UI. */
  onDraggingChange?: (dragging: boolean) => void
  /** Turns the marquee off without unmounting it, so the list stays scrollable and clickable. */
  disabled?: boolean
  /** Pointer travel before a press becomes a drag rather than a click. */
  threshold?: number
  /** Width of the band at each edge inside which the container scrolls itself. 0 turns it off. */
  edge?: number
  /** Pixels per frame of auto-scroll at the very edge. */
  speed?: number
  /**
   * Lets a finger draw a marquee too. Off by default: on a touch screen a drag from empty space is
   * how the list is panned, and taking that over leaves a list that cannot be scrolled.
   */
  allowTouch?: boolean
  /** Styles the marquee rectangle. */
  marqueeClassName?: string
}

/**
 * Rubber-band selection: drag from the empty space around a list, a grid or a board, and everything
 * the rectangle touches is selected.
 *
 * It owns the scroll container, because the rectangle only makes sense relative to something that
 * scrolls, and auto-scrolling at the edges is half of what makes it usable. Selection state is
 * ordinary React state — controlled with `value` plus `onChange` or uncontrolled with
 * `defaultValue` — which is the point: the marquee is one way into the same selection the
 * consumer's own checkboxes, clicks and keyboard shortcuts write to, never the only way in.
 *
 * Pair it with `bulk-action-bar` for what happens after, and note that it deliberately does not
 * handle presses that land *on* an item: those stay with the item, which is what keeps a
 * `sortable-list` row draggable inside a selectable list.
 */
export function DragSelect({
  children,
  value,
  defaultValue = [],
  onChange,
  onDraggingChange,
  disabled = false,
  threshold = DRAG_SELECT_THRESHOLD,
  edge = DRAG_SELECT_EDGE,
  speed = DRAG_SELECT_SPEED,
  allowTouch = false,
  marqueeClassName,
  className,
  ...props
}: DragSelectProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [uncontrolled, setUncontrolled] = React.useState<string[]>(defaultValue)
  const selected = value ?? uncontrolled
  const [session, setSession] = React.useState<DragSelectSession | null>(null)

  // The live selection is read from a ref inside the pointer handlers rather than from the render
  // they were created in. A drag emits several changes per second and the handler that computes the
  // next one must see the last — a stale closure here is the classic "only the first move sticks".
  const selectedRef = React.useRef(selected)
  selectedRef.current = selected

  const commit = (next: string[]) => {
    if (value === undefined) setUncontrolled(next)
    onChange?.(next)
  }
  // Reached through a ref by the one listener that outlives the render it was created in, so that
  // Escape calls this render's `onChange` and not the one that was current when the drag started.
  const commitRef = React.useRef(commit)
  commitRef.current = commit

  const frameOf = (node: HTMLElement): DragSelectFrame => {
    const rect = node.getBoundingClientRect()
    return {
      left: rect.left,
      top: rect.top,
      borderLeft: node.clientLeft,
      borderTop: node.clientTop,
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
    }
  }

  const itemsOf = (node: HTMLElement, frame: DragSelectFrame) => {
    const found = node.querySelectorAll<HTMLElement>(`[${DRAG_SELECT_ITEM_ATTR}]`)
    const items: { id: string; box: DragSelectBox }[] = []
    for (const element of Array.from(found)) {
      const id = element.getAttribute(DRAG_SELECT_ITEM_ATTR)
      // An item that is marked disabled is skipped rather than selected-and-ignored: a bulk action
      // that silently drops part of what the rectangle covered is worse than one that never
      // claimed those rows.
      if (!id || element.getAttribute("aria-disabled") === "true") continue
      items.push({ id, box: toContentBox(element.getBoundingClientRect(), frame) })
    }
    return items
  }

  const applyFor = (next: DragSelectSession) => {
    const node = containerRef.current
    if (!node || !next.active) return
    const frame = frameOf(node)
    const hits = boxHits(itemsOf(node, frame), boxBetween(next.anchor, next.point))
    commit(applyDragSelection(next.base, hits, next.mode))
  }

  // --- auto-scroll ---------------------------------------------------------
  // Driven from a ref'd frame loop rather than from pointermove, because the pointer stops sending
  // moves the instant it is held against the edge — which is exactly when the scrolling has to keep
  // happening. Each frame scrolls, then re-derives the content point from the stored viewport point
  // so the rectangle grows into the newly revealed rows.
  const sessionRef = React.useRef<DragSelectSession | null>(null)
  sessionRef.current = session
  const frameIdRef = React.useRef<number | null>(null)

  const stopAutoScroll = () => {
    if (frameIdRef.current !== null) {
      cancelAnimationFrame(frameIdRef.current)
      frameIdRef.current = null
    }
  }

  const step = () => {
    frameIdRef.current = null
    const node = containerRef.current
    const current = sessionRef.current
    if (!node || !current || !current.active || edge <= 0) return
    const rect = node.getBoundingClientRect()
    const { dx, dy } = edgeScrollDelta(current.viewport, rect, edge, speed)
    if (dx !== 0 || dy !== 0) {
      node.scrollLeft += dx
      node.scrollTop += dy
      const next = advanceDragSelect(
        current,
        { viewport: current.viewport, content: toContentPoint(current.viewport, frameOf(node)) },
        threshold
      )
      sessionRef.current = next
      setSession(next)
      applyFor(next)
    }
    frameIdRef.current = requestAnimationFrame(step)
  }

  const startAutoScroll = () => {
    if (frameIdRef.current === null && edge > 0) frameIdRef.current = requestAnimationFrame(step)
  }

  React.useEffect(() => stopAutoScroll, [])

  const endSession = (node: HTMLElement | null, pointerId: number) => {
    stopAutoScroll()
    setSession(null)
    sessionRef.current = null
    onDraggingChange?.(false)
    if (node?.hasPointerCapture?.(pointerId)) node.releasePointerCapture(pointerId)
  }

  // Escape abandons the drag and puts the selection back as it was. It is on the window because the
  // container is not focused — the press that started the drag was on empty space — and it is
  // bound on whether a drag exists rather than on the session object, which is replaced on every
  // move: re-subscribing a listener a hundred times a second is how a drag turns into jank.
  const pressed = session !== null
  React.useEffect(() => {
    if (!pressed) return
    const onKeyDown = (event: KeyboardEvent) => {
      const current = sessionRef.current
      if (event.key !== "Escape" || !current) return
      event.preventDefault()
      commitRef.current([...current.base])
      endSession(containerRef.current, current.pointerId)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [pressed])

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    props.onPointerDown?.(event)
    if (disabled || session) return
    if (event.pointerType === "mouse" && event.button !== 0) return
    if (event.pointerType === "touch" && !allowTouch) return
    const node = containerRef.current
    if (!node) return

    // Only empty space starts a marquee. A press that lands on an item belongs to the item — its
    // own click, its checkbox, its reorder handle — and stealing it is how a list ends up with a
    // rectangle you cannot avoid drawing. `data-drag-select-ignore` is the escape hatch for the
    // rest: a toolbar, a header, a resizer sitting in the same scroll container.
    const target = event.target as HTMLElement | null
    if (target?.closest?.(`[${DRAG_SELECT_ITEM_ATTR}], [data-drag-select-ignore]`)) return

    // Suppresses the text selection the press would otherwise start; a drag across a list that also
    // highlights every label reads as a broken page rather than as a selection.
    event.preventDefault()
    node.setPointerCapture?.(event.pointerId)
    const frame = frameOf(node)
    const viewport = { x: event.clientX, y: event.clientY }
    setSession(
      beginDragSelect({
        pointerId: event.pointerId,
        viewport,
        content: toContentPoint(viewport, frame),
        base: selectedRef.current,
        mode: dragSelectMode(event),
      })
    )
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    props.onPointerMove?.(event)
    const current = sessionRef.current
    const node = containerRef.current
    if (!current || !node || event.pointerId !== current.pointerId) return
    const viewport = { x: event.clientX, y: event.clientY }
    const next = advanceDragSelect(
      current,
      { viewport, content: toContentPoint(viewport, frameOf(node)) },
      threshold
    )
    const appeared = next.active && !current.active
    sessionRef.current = next
    setSession(next)
    if (appeared) onDraggingChange?.(true)
    applyFor(next)
    startAutoScroll()
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    props.onPointerUp?.(event)
    const current = sessionRef.current
    if (!current || event.pointerId !== current.pointerId) return
    // A press on empty space that never became a drag is a click, and a click on the background
    // clears — unless it was modified, where clearing would throw away the selection the modifier
    // says is being built on.
    if (!current.active && current.mode === "replace" && selectedRef.current.length > 0) commit([])
    endSession(containerRef.current, event.pointerId)
  }

  function handlePointerCancel(event: React.PointerEvent<HTMLDivElement>) {
    props.onPointerCancel?.(event)
    const current = sessionRef.current
    if (!current || event.pointerId !== current.pointerId) return
    // A cancelled pointer never released onto anything, so the selection goes back rather than
    // standing at whatever the rectangle happened to be over when the system took the pointer away.
    commit([...current.base])
    endSession(containerRef.current, event.pointerId)
  }

  const box = session?.active ? boxBetween(session.anchor, session.point) : null

  return (
    <div
      {...props}
      ref={containerRef}
      data-dragging={session?.active ? "" : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      className={cn(
        "relative overflow-auto",
        // Only while a marquee is up, so the list's own text stays selectable the rest of the time.
        session?.active && "select-none",
        className
      )}
    >
      {children}
      {box ? (
        <div
          // Decoration: the selection it describes is announced by whatever the consumer shows for
          // it (`bulk-action-bar` has the live region), and a rectangle read out as it is dragged
          // would be noise. `pointer-events-none` keeps it from becoming the target of its own move.
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute z-10 rounded-[2px] border border-primary bg-primary/15",
            marqueeClassName
          )}
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        />
      ) : null}
    </div>
  )
}
