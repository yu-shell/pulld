"use client"

import * as React from "react"
import { GripVertical } from "lucide-react"

import { cn } from "@/lib/utils"

export interface SortableListItem {
  /** Stable across reorders — it keys the row, so React moves the node instead of rebuilding it. */
  id: string
  /** Plain text used for the handle's accessible name and for the drag announcements. */
  label: string
}

/** Every string a screen reader hears. Override to translate or to reword. */
export interface SortableListLabels {
  /** Accessible name of a row's drag handle. */
  handle: (label: string) => string
  /** Read once when the handle takes focus, via aria-describedby. */
  instructions: string
  grabbed: (label: string, position: number, total: number) => string
  moved: (label: string, position: number, total: number) => string
  dropped: (label: string, position: number, total: number) => string
  cancelled: (label: string) => string
}

const defaultLabels: SortableListLabels = {
  handle: (label) => `Reorder ${label}`,
  instructions:
    "Press space or enter to pick the item up, arrow keys to move it, space or enter to drop it, escape to cancel.",
  grabbed: (label, position, total) => `Picked up ${label}. Position ${position} of ${total}.`,
  moved: (label, position, total) => `${label} is now at position ${position} of ${total}.`,
  dropped: (label, position, total) => `Dropped ${label} at position ${position} of ${total}.`,
  cancelled: (label) => `Reordering cancelled. ${label} is back where it started.`,
}

export interface SortableListRenderState {
  index: number
  /** The row is being dragged with a pointer right now. */
  dragging: boolean
  /** The row has been picked up with the keyboard and is waiting to be dropped. */
  grabbed: boolean
}

interface SortableListProps<T extends SortableListItem> {
  /** The current order. This component is controlled: it never reorders `items` itself. */
  items: T[]
  /** Receives the whole array in its new order — persist it and pass it back as `items`. */
  onReorder: (items: T[]) => void
  /** Row body to the right of the handle. Defaults to `item.label`. */
  renderItem?: (item: T, state: SortableListRenderState) => React.ReactNode
  labels?: Partial<SortableListLabels>
  className?: string
  /** Applied to every row, so the default card look can be replaced wholesale. */
  itemClassName?: string
  /** Name the list (or point `aria-labelledby` at a visible heading). */
  "aria-label"?: string
  "aria-labelledby"?: string
}

interface RowRect {
  top: number
  height: number
}

interface DragState {
  id: string
  /** Index the row started at. */
  from: number
  /** Index it would land on if dropped now. */
  to: number
  pointerId: number
  startY: number
  dy: number
  /** Row geometry measured once at drag start, so moving rows don't feed back into the math. */
  rects: RowRect[]
  /**
   * How far a displaced row travels: the space the dragged row vacates, which is its own
   * height plus one gap — the same for every displaced row however tall *they* are, because
   * they only ever close up over the one row that left.
   */
  shift: number
}

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/**
 * A list whose rows can be reordered by dragging the grip handle — or entirely from the
 * keyboard: Tab to the list, arrow keys to walk it, Space to pick a row up, arrows to move
 * it, Space to drop, Escape to put it back. Every step is announced through a live region.
 *
 * Controlled by design: pass `items` and persist what `onReorder` hands back. Rows keep the
 * caller's own objects, so `onReorder` returns them unchanged apart from their order.
 *
 * Dragging is plain pointer events — no dnd-kit, no HTML5 drag-and-drop (whose drag image
 * and dragover semantics are the usual source of touch-device bugs). Rows are measured once
 * when a drag starts and displaced with transforms, so rows of different heights land where
 * they look like they will.
 */
export function SortableList<T extends SortableListItem>({
  items,
  onReorder,
  renderItem,
  labels: labelOverrides,
  className,
  itemClassName,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: SortableListProps<T>) {
  const labels = { ...defaultLabels, ...labelOverrides }

  const instructionsId = React.useId()
  const listRef = React.useRef<HTMLUListElement>(null)
  const handleRefs = React.useRef(new Map<string, HTMLButtonElement>())

  const [announcement, setAnnouncement] = React.useState("")
  const [drag, setDrag] = React.useState<DragState | null>(null)
  const [grabbedId, setGrabbedId] = React.useState<string | null>(null)
  const [focusedId, setFocusedId] = React.useState<string | null>(null)

  /** The order at the moment of the keyboard pick-up, so Escape can restore it. */
  const grabOrigin = React.useRef<T[] | null>(null)
  /** A row whose handle should keep focus once a reorder that ends the interaction commits. */
  const refocusId = React.useRef<string | null>(null)

  // One tab stop for the whole list (roving tabindex). Falling back to the first row keeps
  // the list reachable before anything is focused, and re-resolves when the focused row is
  // removed by the parent.
  const activeId = React.useMemo(() => {
    const ids = new Set(items.map((i) => i.id))
    if (focusedId && ids.has(focusedId)) return focusedId
    return items[0]?.id ?? null
  }, [items, focusedId])

  // Any reorder re-renders the list with the row in a new slot, and React moves the row's DOM
  // node to get there. Pull focus back onto the handle afterwards so keystrokes keep landing
  // on the row the user is carrying — and so the row stays reachable after the final drop —
  // whatever the browser decides to do with focus while the node is moving.
  React.useLayoutEffect(() => {
    const id = grabbedId ?? refocusId.current
    refocusId.current = null
    if (id) handleRefs.current.get(id)?.focus()
  }, [grabbedId, items])

  function focusHandle(id: string) {
    setFocusedId(id)
    handleRefs.current.get(id)?.focus()
  }

  function endGrab() {
    grabOrigin.current = null
    setGrabbedId(null)
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    // A pointer drag owns the list while it lasts; Escape abandons it.
    if (drag) {
      if (e.key === "Escape") {
        e.preventDefault()
        setDrag(null)
      }
      return
    }

    const item = items[index]
    const total = items.length
    const isGrabbed = grabbedId === item.id

    switch (e.key) {
      case " ":
      case "Enter":
        // Space on a button would also fire click; preventDefault keeps the pick-up from
        // being undone by the click that follows it.
        e.preventDefault()
        if (isGrabbed) {
          endGrab()
          setAnnouncement(labels.dropped(item.label, index + 1, total))
        } else {
          grabOrigin.current = items
          setGrabbedId(item.id)
          setAnnouncement(labels.grabbed(item.label, index + 1, total))
        }
        break

      case "Escape": {
        if (!isGrabbed) break
        e.preventDefault()
        const origin = grabOrigin.current
        endGrab()
        if (origin) {
          refocusId.current = item.id
          onReorder(origin)
        }
        setAnnouncement(labels.cancelled(item.label))
        break
      }

      case "ArrowUp":
      case "ArrowDown":
      case "Home":
      case "End": {
        e.preventDefault()
        const next =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? total - 1
              : index + (e.key === "ArrowDown" ? 1 : -1)
        if (next < 0 || next >= total || next === index) break
        if (isGrabbed) {
          onReorder(move(items, index, next))
          setAnnouncement(labels.moved(item.label, next + 1, total))
        } else {
          focusHandle(items[next].id)
        }
        break
      }
    }
  }

  function handleBlur() {
    if (!grabbedId) return
    // Moving a focused node can fire blur in some browsers even though focus comes straight
    // back to it. Wait a frame and only end the grab if focus really left the list —
    // otherwise every keyboard move would drop the row it just picked up.
    requestAnimationFrame(() => {
      const root = listRef.current
      if (!root || root.contains(document.activeElement)) return
      endGrab()
    })
  }

  function handlePointerDown(e: React.PointerEvent<HTMLButtonElement>, index: number) {
    if (e.pointerType === "mouse" && e.button !== 0) return
    const root = listRef.current
    if (!root) return

    const rows = Array.from(root.querySelectorAll<HTMLLIElement>(":scope > [data-sortable-row]"))
    if (rows.length !== items.length) return
    const rects = rows.map((row) => {
      const box = row.getBoundingClientRect()
      return { top: box.top, height: box.height }
    })

    // Read the row spacing off the page rather than assuming the default gap, so a caller
    // who restyles the rows through `className` still gets rows that line up.
    const gap = rects.length > 1 ? rects[1].top - rects[0].top - rects[0].height : 0

    const handle = e.currentTarget
    // Stops the press from selecting text or scrolling the page; focus is then set by hand,
    // because preventDefault also suppresses the focus the press would have given us.
    e.preventDefault()
    handle.setPointerCapture(e.pointerId)
    handle.focus()
    setFocusedId(items[index].id)
    endGrab()
    setDrag({
      id: items[index].id,
      from: index,
      to: index,
      pointerId: e.pointerId,
      startY: e.clientY,
      dy: 0,
      rects,
      shift: rects[index].height + gap,
    })
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const { rects, from } = drag
    const first = rects[0]
    const last = rects[rects.length - 1]
    const restingCenter = rects[from].top + rects[from].height / 2

    // Two bounds, and the drag gets whichever is looser. The row should not be draggable off
    // into the page, but it also has to be able to *reach* the end slots — and since the slot
    // is picked from the row's midpoint, a row taller than the end row would have its midpoint
    // stop short of that row's midpoint while its edge was already flush with the list.
    const dy = Math.max(
      Math.min(first.top - rects[from].top, first.top + first.height / 2 - restingCenter),
      Math.min(
        Math.max(
          last.top + last.height - (rects[from].top + rects[from].height),
          last.top + last.height / 2 - restingCenter
        ),
        e.clientY - drag.startY
      )
    )

    // Land on whichever slot the row's own midpoint has reached, comparing against the
    // midpoints as they were before anything moved. The comparison includes equality so the
    // clamped extremes above count as arriving; at rest a neighbour's midpoint is always
    // strictly past this one's, so that costs no spurious swap.
    const center = restingCenter + dy
    let to = from
    while (to < rects.length - 1 && center >= rects[to + 1].top + rects[to + 1].height / 2) to++
    while (to > 0 && center <= rects[to - 1].top + rects[to - 1].height / 2) to--

    if (dy === drag.dy && to === drag.to) return
    setDrag({ ...drag, dy, to })
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    const { from, to } = drag
    setDrag(null)
    if (from === to) return
    refocusId.current = drag.id
    onReorder(move(items, from, to))
    setAnnouncement(labels.dropped(items[from].label, to + 1, items.length))
  }

  function handlePointerCancel(e: React.PointerEvent) {
    if (!drag || e.pointerId !== drag.pointerId) return
    setDrag(null)
  }

  /**
   * Where a row sits during a drag. The dragged row follows the pointer; every row the drag
   * has passed closes up over the space the dragged row left, which puts each of them exactly
   * where it will be once the drop commits — so only the dragged row itself has to snap.
   */
  function transformFor(index: number): string | undefined {
    if (!drag) return undefined
    const { from, to, dy, rects, shift } = drag
    // The snapshot is only valid for the list that was measured; if the parent adds or
    // removes rows mid-drag, leave everything where it is rather than displace by stale sizes.
    if (rects.length !== items.length) return undefined
    if (index === from) return `translateY(${dy}px)`
    if (to > from && index > from && index <= to) return `translateY(${-shift}px)`
    if (to < from && index >= to && index < from) return `translateY(${shift}px)`
    return undefined
  }

  return (
    <div>
      <ul
        ref={listRef}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        className={cn("flex flex-col gap-1", className)}
      >
        {items.map((item, index) => {
          const dragging = drag?.id === item.id
          const grabbed = grabbedId === item.id

          return (
            <li
              key={item.id}
              data-sortable-row=""
              style={{ transform: transformFor(index), zIndex: dragging ? 1 : undefined }}
              className={cn(
                "relative flex items-center gap-2 rounded-md border bg-card px-2 py-2 text-sm text-card-foreground",
                // Only the rows getting out of the way animate, and only while a drag is in
                // progress: on drop the transforms and this class are removed in the same
                // render as the reorder, so nothing slides back through its old slot.
                drag && !dragging && "transition-transform duration-150",
                dragging && "shadow-lg",
                (dragging || grabbed) && "border-ring",
                itemClassName
              )}
            >
              <button
                type="button"
                ref={(el) => {
                  if (el) handleRefs.current.set(item.id, el)
                  else handleRefs.current.delete(item.id)
                }}
                aria-label={labels.handle(item.label)}
                aria-roledescription="sortable item"
                aria-describedby={instructionsId}
                aria-pressed={grabbed}
                tabIndex={activeId === item.id ? 0 : -1}
                onKeyDown={(e) => handleKeyDown(e, index)}
                onPointerDown={(e) => handlePointerDown(e, index)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onFocus={() => setFocusedId(item.id)}
                onBlur={handleBlur}
                // touch-none keeps a touch drag from scrolling the page instead of the row.
                className={cn(
                  "-ml-0.5 flex h-7 w-6 shrink-0 touch-none items-center justify-center rounded text-muted-foreground",
                  "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  dragging ? "cursor-grabbing" : "cursor-grab"
                )}
              >
                <GripVertical className="h-4 w-4" aria-hidden="true" />
              </button>

              <div className="min-w-0 flex-1">
                {renderItem ? renderItem(item, { index, dragging, grabbed }) : item.label}
              </div>
            </li>
          )
        })}
      </ul>

      <div id={instructionsId} className="sr-only">
        {labels.instructions}
      </div>
      {/* Assertive, so a fast run of arrow presses reports where the row is now rather than
          queueing up every position it passed through. */}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
