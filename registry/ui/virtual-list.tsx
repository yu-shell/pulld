"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export type ScrollAlign = "auto" | "start" | "center" | "end"

export interface VirtualListHandle {
  /** Bring a row into view. `auto` (the default) only moves if the row is off-screen. */
  scrollToIndex: (index: number, align?: ScrollAlign) => void
  /** Jump to a pixel offset — the other half of restoring a saved scroll position. */
  scrollToOffset: (offset: number) => void
  /** The current pixel offset, to save before the list unmounts. */
  getScrollOffset: () => number
}

/**
 * The top edge of every row, plus one last entry holding the total height: `offsets[i]` is where
 * row `i` starts and `offsets[count]` is how tall the whole list is. Everything else here is
 * arithmetic on this one array.
 */
function buildOffsets(count: number, heightAt: (index: number) => number): number[] {
  const offsets = new Array<number>(count + 1)
  offsets[0] = 0
  for (let i = 0; i < count; i++) {
    const height = heightAt(i)
    offsets[i + 1] = offsets[i] + (Number.isFinite(height) && height > 0 ? height : 0)
  }
  return offsets
}

/**
 * The first row whose bottom edge is past `offset` — the row the viewport starts inside. Rows that
 * measured zero are skipped rather than returned, since nothing of them is on screen. Past the end
 * of the list this clamps to the last row.
 */
function findRowAt(offsets: number[], offset: number): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid + 1] > offset) high = mid
    else low = mid + 1
  }
  return low
}

/** How many rows start above `offset` — the exclusive end of the range that has come into view. */
function countRowsStartingBefore(offsets: number[], offset: number): number {
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const mid = (low + high) >> 1
    if (offsets[mid] >= offset) high = mid
    else low = mid + 1
  }
  return low
}

/**
 * The half-open range of rows to mount. Every row touching the viewport is inside it, plus
 * `overscan` rows on each side so a scroll of a few pixels doesn't have to mount anything.
 */
function computeWindow(
  offsets: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number
): { start: number; end: number } {
  const count = offsets.length - 1
  if (count <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, Math.min(scrollTop, offsets[count]))
  const first = findRowAt(offsets, top)
  const past = countRowsStartingBefore(offsets, top + Math.max(0, viewportHeight))
  return {
    start: Math.max(0, first - overscan),
    // `first + 1` keeps one row mounted before the height of the box is known, which is the state
    // of the world on the very first paint.
    end: Math.min(count, Math.max(past, first + 1) + overscan),
  }
}

/** Where to scroll so that `index` sits at the requested edge, clamped to the scrollable range. */
function offsetForIndex(
  offsets: number[],
  index: number,
  viewportHeight: number,
  align: ScrollAlign,
  currentOffset: number
): number {
  const count = offsets.length - 1
  if (count <= 0) return 0
  // A row that isn't a real number would otherwise turn the scroll offset into NaN.
  if (!Number.isFinite(index)) return Math.max(0, Math.min(currentOffset, offsets[count]))
  const row = Math.max(0, Math.min(Math.trunc(index), count - 1))
  const top = offsets[row]
  const bottom = offsets[row + 1]
  const limit = Math.max(0, offsets[count] - viewportHeight)

  let next = currentOffset
  if (align === "start") next = top
  else if (align === "end") next = bottom - viewportHeight
  else if (align === "center") next = top - (viewportHeight - (bottom - top)) / 2
  else if (top < currentOffset) next = top
  else if (bottom > currentOffset + viewportHeight) next = bottom - viewportHeight

  return Math.max(0, Math.min(next, limit))
}

export interface VirtualListProps {
  /** How many rows the list has in total — not how many are on screen. */
  count: number
  /** Renders one row. Called only for the rows that are actually mounted. */
  children: (index: number) => React.ReactNode
  /**
   * A stable key per row. Measurements, the focused row and the scroll anchor are all tracked by
   * this, so passing one keeps the view still when rows are prepended (older chat messages) rather
   * than only appended. Defaults to the index.
   */
  itemKey?: (index: number) => React.Key
  /** Height to assume for rows that have not been measured yet. */
  estimateItemHeight?: number
  /** Extra rows mounted above and below the viewport. */
  overscan?: number
  /** Scroll offset to start at — the restore half of a saved position. */
  defaultScrollOffset?: number
  /** Called with the pixel offset on every scroll, e.g. to save it. */
  onScroll?: (offset: number) => void
  /** Rendered in place of the rows when `count` is 0. */
  empty?: React.ReactNode
  /** Applies to the scroll container. Set the height here (the default is `h-72`). */
  className?: string
  /** Applies to the wrapper around each row. Rows need padding rather than margin — see below. */
  itemClassName?: string
  /** Swap to `listbox`/`option` (or `grid`/`row`) if the rows are selectable rather than static. */
  role?: string
  itemRole?: string
  /** Name the list. It is a focusable scroll region, so it should have one. */
  "aria-label"?: string
  "aria-labelledby"?: string
}

/**
 * A long list that only puts the visible rows in the DOM: admin tables, log and audit viewers,
 * chat history, a select with thousands of options. Give it `count` and a function that renders
 * row `i`, and thirty nodes stand in for five thousand.
 *
 * Rows may be any height and are measured as they mount, so nothing has to be declared up front.
 * Four things that windowing usually breaks are handled here:
 *
 * - **Focus survives.** The row holding focus stays mounted even after it scrolls out of the
 *   window, so tabbing or arrowing through a list doesn't dump the user back at `<body>`.
 * - **Screen readers get the real count.** Each row carries `aria-posinset`/`aria-setsize`, so it
 *   reads "item 4,213 of 5,000" instead of the handful that happen to be mounted.
 * - **The view doesn't jump.** Measuring a row above the viewport, or prepending rows, shifts
 *   everything below it; the scroll offset is corrected in the same frame against a row-keyed
 *   anchor, before the browser paints.
 * - **Positions can be restored**, via `defaultScrollOffset` and the imperative handle.
 *
 * Rows are positioned absolutely: give them padding or a fixed height, never a vertical margin
 * (a margin sits outside the measured box, so it would not be counted). The list scrolls
 * vertically only. Browser find-in-page and Ctrl+F reach mounted rows only — that is inherent to
 * windowing, so don't reach for this on a page whose whole point is being searchable.
 */
export const VirtualList = React.forwardRef<VirtualListHandle, VirtualListProps>(
  function VirtualList(
    {
      count,
      children,
      itemKey,
      estimateItemHeight = 48,
      overscan = 4,
      defaultScrollOffset = 0,
      onScroll,
      empty,
      className,
      itemClassName,
      role = "list",
      itemRole = "listitem",
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledby,
    },
    ref
  ) {
    const scrollerRef = React.useRef<HTMLDivElement>(null)
    const observerRef = React.useRef<ResizeObserver | null>(null)
    /** Measured heights by row key. A ref, not state: `measureTick` is the render signal. */
    const heightsRef = React.useRef(new Map<string, number>())
    const observedRef = React.useRef(new Set<Element>())
    /** The row the viewport is sitting on, and how far into it — see `rememberAnchor`. */
    const anchorRef = React.useRef<{ key: string; delta: number } | null>(null)

    const [scrollTop, setScrollTop] = React.useState(0)
    const [viewportHeight, setViewportHeight] = React.useState(0)
    const [measureTick, setMeasureTick] = React.useState(0)
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null)

    const { keys, offsets, indexByKey } = React.useMemo(() => {
      const keys = new Array<string>(count)
      const indexByKey = new Map<string, number>()
      for (let i = 0; i < count; i++) {
        const key = String(itemKey ? itemKey(i) : i)
        keys[i] = key
        indexByKey.set(key, i)
      }
      const heights = heightsRef.current
      // Measurements are kept for rows that scrolled out, because they are very likely to come
      // back. Rows that are swapped out wholesale instead — a new filter, a new query — never do,
      // so once the cache is well ahead of the list it is dropped back to what the list can address.
      if (heights.size > count * 2 + 256) {
        for (const key of heights.keys()) if (!indexByKey.has(key)) heights.delete(key)
      }
      const offsets = buildOffsets(count, (i) => heights.get(keys[i]) ?? estimateItemHeight)
      return { keys, offsets, indexByKey }
      // measureTick is the signal that heightsRef changed underneath this memo.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [count, itemKey, estimateItemHeight, measureTick])

    /**
     * Remember which row the viewport is on. Keyed by row rather than by index or by pixels,
     * because all three of the things that move the list — a row above being measured, rows being
     * prepended, a row being removed — change what a given pixel offset or index points at.
     */
    function rememberAnchor(offset: number) {
      if (count === 0) {
        anchorRef.current = null
        return
      }
      const index = findRowAt(offsets, Math.max(0, offset))
      anchorRef.current = { key: keys[index], delta: offset - offsets[index] }
    }

    function scrollTo(offset: number) {
      const scroller = scrollerRef.current
      if (!scroller) return
      scroller.scrollTop = offset
      // The browser's own scroll event lands a frame later; setting this now keeps the mounted
      // window and the anchor in step with the position that was just written.
      setScrollTop(offset)
      rememberAnchor(offset)
    }

    React.useImperativeHandle(
      ref,
      () => ({
        scrollToIndex(index, align = "auto") {
          const scroller = scrollerRef.current
          if (!scroller) return
          scrollTo(offsetForIndex(offsets, index, scroller.clientHeight, align, scroller.scrollTop))
        },
        scrollToOffset(offset) {
          const scroller = scrollerRef.current
          if (!scroller) return
          scrollTo(Math.max(0, Math.min(offset, Math.max(0, offsets[count] - scroller.clientHeight))))
        },
        getScrollOffset() {
          return scrollerRef.current?.scrollTop ?? 0
        },
      }),
      // scrollTo and rememberAnchor close over exactly these.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [offsets, keys, count]
    )

    // One observer for the scroll box and every mounted row. Rows are watched rather than measured
    // once, so a row that grows later (an image finishing, a details row opening) is accounted for
    // instead of leaving a gap.
    React.useLayoutEffect(() => {
      const scroller = scrollerRef.current
      if (!scroller) return
      setViewportHeight(scroller.clientHeight)

      const observer = new ResizeObserver((entries) => {
        const heights = heightsRef.current
        let changed = false
        for (const entry of entries) {
          if (entry.target === scroller) {
            setViewportHeight(scroller.clientHeight)
            continue
          }
          const key = (entry.target as HTMLElement).dataset.virtualKey
          if (key === undefined) continue
          const box = entry.borderBoxSize?.[0]
          const height = box ? box.blockSize : entry.target.getBoundingClientRect().height
          const previous = heights.get(key)
          // Sub-pixel noise would otherwise bounce between two heights forever: each render
          // re-measures, disagrees by a rounding error and asks for another one.
          if (previous !== undefined && Math.abs(previous - height) < 0.5) continue
          heights.set(key, height)
          changed = true
        }
        if (changed) setMeasureTick((tick) => tick + 1)
      })

      observerRef.current = observer
      observer.observe(scroller)
      return () => {
        observer.disconnect()
        observerRef.current = null
        observedRef.current.clear()
      }
    }, [])

    // Runs after every render: watch the rows that just mounted, stop watching the ones that left.
    // Re-observing an element that is already watched would fire a fresh measurement each render,
    // so the set of watched rows is reconciled rather than rebuilt.
    React.useLayoutEffect(() => {
      const observer = observerRef.current
      const scroller = scrollerRef.current
      if (!observer || !scroller) return
      const observed = observedRef.current
      const rows = new Set<Element>(scroller.querySelectorAll("[data-virtual-key]"))
      for (const element of observed) {
        if (rows.has(element)) continue
        observer.unobserve(element)
        observed.delete(element)
      }
      for (const element of rows) {
        if (observed.has(element)) continue
        observer.observe(element)
        observed.add(element)
      }
    })

    // Scroll anchoring. When the heights above the viewport change — a row was measured for real,
    // or rows were prepended — everything below shifts by that difference and the list appears to
    // jump under the pointer. Putting the anchor row back where it was, in a layout effect, means
    // the correction happens before the browser paints, so there is nothing to see.
    React.useLayoutEffect(() => {
      const scroller = scrollerRef.current
      const anchor = anchorRef.current
      if (!scroller || !anchor) return
      const index = indexByKey.get(anchor.key)
      if (index === undefined) return
      const limit = Math.max(0, offsets[count] - scroller.clientHeight)
      const next = Math.max(0, Math.min(offsets[index] + anchor.delta, limit))
      if (Math.abs(next - scroller.scrollTop) < 0.5) return
      scroller.scrollTop = next
      setScrollTop(next)
    }, [offsets, indexByKey, count])

    React.useLayoutEffect(() => {
      if (!defaultScrollOffset) return
      // Only the estimate is known this early, so a restored offset is approximate until the rows
      // above it have been measured — at which point the anchor set here holds the view steady.
      scrollTo(defaultScrollOffset)
      // Mount only: this is a default, not a controlled value.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    function handleScroll(event: React.UIEvent<HTMLDivElement>) {
      const offset = event.currentTarget.scrollTop
      setScrollTop(offset)
      rememberAnchor(offset)
      onScroll?.(offset)
    }

    // Focus lands on something inside a row: remember which row, so the window below keeps it
    // mounted. Tracked by key so that prepending rows doesn't move the pin onto a different row.
    function handleFocus(event: React.FocusEvent<HTMLDivElement>) {
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-virtual-key]")
      setFocusedKey(row?.dataset.virtualKey ?? null)
    }

    function handleBlur(event: React.FocusEvent<HTMLDivElement>) {
      // Moving between two rows keeps the pin — the matching focus event replaces it.
      if (event.currentTarget.contains(event.relatedTarget)) return
      setFocusedKey(null)
    }

    const { start, end } = computeWindow(offsets, scrollTop, viewportHeight, overscan)
    const pinned = focusedKey === null ? undefined : indexByKey.get(focusedKey)
    const mounted: number[] = []
    // Kept in index order so that reading order, and the order rows are tabbed through, still
    // match what is on screen when the pinned row sits outside the window.
    if (pinned !== undefined && pinned < start) mounted.push(pinned)
    for (let i = start; i < end; i++) mounted.push(i)
    if (pinned !== undefined && pinned >= end) mounted.push(pinned)

    return (
      <div
        ref={scrollerRef}
        role={role}
        // A scroll region has to be reachable by keyboard, and this one owns its own scrollbar.
        tabIndex={0}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        onScroll={handleScroll}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={{
          // The browser's own scroll anchoring picks its own anchor and would pull against the
          // correction above, which knows which row the viewport was actually on.
          overflowAnchor: "none",
          // Reserve the scrollbar's width even when it isn't showing. Without this, a list that
          // measures out near the height of its box can flip the scrollbar on, narrowing the rows,
          // which re-wraps their text, which changes the height that decided the scrollbar.
          scrollbarGutter: "stable",
        }}
        className={cn(
          "relative h-72 overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        )}
      >
        {count === 0 ? (
          empty
        ) : (
          // Holds the full height so the scrollbar reflects the whole list. Explicitly
          // presentational: a plain div between the list and its items would break the ownership
          // the two roles rely on, and the rows would stop being read as a list.
          <div role="presentation" style={{ position: "relative", height: offsets[count] }}>
            {mounted.map((index) => (
              <div
                key={keys[index]}
                data-virtual-key={keys[index]}
                role={itemRole}
                // The whole point of announcing position: only a window of rows exists, so without
                // these a screen reader counts the mounted handful instead of the real list.
                aria-setsize={count}
                aria-posinset={index + 1}
                style={{ position: "absolute", top: offsets[index], left: 0, right: 0 }}
                className={itemClassName}
              >
                {children(index)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }
)
