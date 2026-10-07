"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The narrowest a column may be dragged. 48px holds a sort arrow and two characters.
 *
 * A minimum is not a nicety. Dragged to zero a column stops rendering its own edge, which is the
 * thing you grab to get it back — so the column is gone and there is no gesture that returns it.
 */
export const DEFAULT_MIN_COLUMN_WIDTH = 48

/**
 * The widest a column may be dragged, unless a wider one is asked for.
 *
 * This exists for `aria-valuemax` rather than for taste. A `separator` acting as a splitter is a
 * value widget, and ARIA says an absent `aria-valuemax` is 100 — so a handle reporting
 * `aria-valuenow="240"` with no maximum is telling a screen reader the column is at 240 on a scale
 * that ends at 100, and what gets announced is a nonsense percentage. Any honest number is better
 * than none; this one is "wider than any screen a table is read on".
 */
export const DEFAULT_MAX_COLUMN_WIDTH = 960

/** Width change per arrow key press. */
export const DEFAULT_KEY_STEP = 16

/** Width change per Page Up / Page Down. */
export const DEFAULT_KEY_STEP_LARGE = 64

/**
 * The grab area's width in pixels, centred on the column's edge.
 *
 * A 1px border is the thing you are aiming at and roughly nobody can hit it; the pointer target has
 * to be several pixels wide while still *looking* like the border, which is why the handle is a
 * transparent strip with a thin visible line inside it rather than a styled border.
 */
export const DEFAULT_HANDLE_WIDTH = 9

/** Column widths in pixels, keyed by column id. A column missing from it has not been resized. */
export type ColumnWidthMap = Readonly<Record<string, number>>

export interface ColumnWidthBounds {
  min?: number
  max?: number
}

/**
 * `width` clamped into `[min, max]`, with anything unusable replaced by `min`.
 *
 * The `NaN` arm is the one that matters. A width is arithmetic on a pointer coordinate, and one
 * `undefined` anywhere in that sum produces `NaN`, which compares false against both bounds and so
 * survives every `if (w < min)` guard written the obvious way. It then reaches the DOM as
 * `width: NaNpx`, which is not a length, so the declaration is dropped — and a `<col>` with no width
 * under a fixed layout is the one case that collapses the column to nothing (see
 * {@link resolveColumnWidths}). The failure is a column that vanishes, a long way from the
 * arithmetic that caused it.
 */
export function clampColumnWidth(
  width: number,
  { min = DEFAULT_MIN_COLUMN_WIDTH, max = DEFAULT_MAX_COLUMN_WIDTH }: ColumnWidthBounds = {}
): number {
  const low = Number.isFinite(min) ? min : DEFAULT_MIN_COLUMN_WIDTH
  const high = Number.isFinite(max) ? Math.max(low, max) : Number.POSITIVE_INFINITY
  // Only a value that is not a number, or is NaN, is unusable. The infinities are not: they have an
  // order, so they clamp to the bound they are heading for, and sending +Infinity to the *minimum*
  // — which `!Number.isFinite` does — is the one wrong answer available.
  if (typeof width !== "number" || Number.isNaN(width)) return low
  return Math.min(high, Math.max(low, width))
}

export interface ResolveColumnWidthsOptions extends ColumnWidthBounds {
  /** Width for a column with no entry in the map. Defaults to 160. */
  defaultWidth?: number
}

/**
 * Every column's width, in `columns` order, with no gaps.
 *
 * **Every column has to be given a width, not just the resized ones.** Under `table-layout: fixed`
 * on a table with a definite width, a `<col>` carrying no width of its own is handed whatever is
 * left over after the sized ones — and because this component sets the table's width to exactly the
 * sum of the sized columns, what is left over is zero. Measured: three columns, two at 120px and
 * one left unsized, produce used widths of `[120, 120, 0]`. The unsized column does not fall back
 * to its content or to some share of the table; it disappears, and it is a column nobody ever
 * touched, so the drag that triggered it looks unrelated.
 *
 * That is also why this returns a dense array rather than the sparse map it is given: the map is
 * the *user's* choices and is meant to be sparse, and the gap between the two is exactly where that
 * bug lives.
 */
export function resolveColumnWidths(
  columns: readonly string[],
  widths: ColumnWidthMap | undefined,
  { defaultWidth = 160, min, max }: ResolveColumnWidthsOptions = {}
): number[] {
  const fallback = clampColumnWidth(defaultWidth, { min, max })
  return columns.map((column) => {
    const stored = widths?.[column]
    return stored === undefined ? fallback : clampColumnWidth(stored, { min, max })
  })
}

/**
 * The width the `<table>` itself must carry: the sum of its columns.
 *
 * **This is the whole component, and it is not what "use `table-layout: fixed` and a `<colgroup>`"
 * suggests.** Both of those are necessary and neither is sufficient. Measured, in a 600px scroll
 * container, asking for three 120px columns:
 *
 * - `table-layout: fixed` with `width: auto` — used widths `[140, 243, 120]`, identical to what the
 *   automatic algorithm produces. A fixed layout needs a *definite* width to be a layout at all;
 *   without one the property is inert and the content sizes the columns, so the first thing anyone
 *   checks ("is `table-layout: fixed` set?") can be yes while nothing about it is in effect.
 *   `width: max-content` behaves the same way — it is not definite either.
 * - `table-layout: fixed` with `width: 100%` — used widths `[200, 200, 200]`. Now the property is
 *   live, and the 240px the three columns did not ask for is shared out between them. Drag one
 *   column and every column moves; the one you dragged does not land where you left it. This is the
 *   arrangement shadcn/ui's own `<Table>` puts you in, because it renders `w-full`.
 * - `table-layout: fixed` with `width: 360px` — used widths `[120, 120, 120]`. Exactly as asked.
 *
 * So the column widths are the used widths only when their sum *is* the table's width, which means
 * the table's width is not a style someone picks; it is a value this component computes and keeps
 * in step with every drag. Hand it out through {@link UseColumnResizerResult.tableProps} and do not
 * leave `w-full` on the element.
 */
export function tableWidthFor(widths: readonly number[]): number {
  let total = 0
  for (const width of widths) total += Number.isFinite(width) ? width : 0
  return total
}

/**
 * Where each column starts, measured from the table's left edge.
 *
 * Used to place the drag guide, which has to stand on a column boundary rather than under the
 * pointer: the pointer is wherever the hand is, and a line that follows it exactly says the column
 * edge is somewhere it is not once the width has been clamped at either end.
 */
export function columnOffsets(widths: readonly number[]): number[] {
  const out: number[] = []
  let sum = 0
  for (const width of widths) {
    out.push(sum)
    sum += Number.isFinite(width) ? width : 0
  }
  return out
}

/** `widths` with one column set to `width`, clamped. Never mutates. */
export function resizeColumnWidth(
  widths: ColumnWidthMap | undefined,
  column: string,
  width: number,
  bounds: ColumnWidthBounds = {}
): ColumnWidthMap {
  return { ...(widths ?? {}), [column]: clampColumnWidth(width, bounds) }
}

export interface DragWidthOptions extends ColumnWidthBounds {
  /** Whether the table reads right-to-left, which mirrors the gesture. */
  rtl?: boolean
}

/**
 * The width a drag has reached: the width it started at, plus how far the pointer has travelled.
 *
 * Computed from the *start* of the gesture rather than from the previous move, because the two are
 * not the same once the width is clamped. Accumulating per-move deltas means a drag that pushes 200
 * pixels past the minimum has to be dragged 200 pixels back before the column widens again — the
 * hand moves and nothing happens, which reads as the handle having been dropped. Re-deriving from
 * the origin makes the clamp a floor the column rests on instead of a debt it has to repay.
 *
 * **In a right-to-left table the gesture is mirrored.** The handle sits on the column's left edge
 * there, so dragging left makes the column wider. Getting this wrong does not look like a direction
 * bug; it looks like the handle resizing the neighbouring column.
 */
export function columnWidthFromDrag(
  startWidth: number,
  startX: number,
  x: number,
  { rtl = false, min, max }: DragWidthOptions = {}
): number {
  const travelled = x - startX
  return clampColumnWidth(startWidth + (rtl ? -travelled : travelled), { min, max })
}

export interface KeyboardWidthOptions extends DragWidthOptions {
  step?: number
  largeStep?: number
}

/**
 * The width a key press asks for, or `null` for a key this handle does not claim.
 *
 * **Without this the feature is mouse-only, and nothing on screen says so.** The handle is visible,
 * it has a focus ring, a screen reader announces a separator with a value — and then no key changes
 * it. Returning `null` rather than the current width is what lets the caller leave the event alone:
 * a handle that swallows every key takes Tab with it and traps focus between the columns.
 *
 * `Home` and `End` go to the bounds rather than scrolling the table, which is what those keys mean
 * on a value widget.
 */
export function keyboardColumnWidth(
  key: string,
  current: number,
  {
    step = DEFAULT_KEY_STEP,
    largeStep = DEFAULT_KEY_STEP_LARGE,
    rtl = false,
    min = DEFAULT_MIN_COLUMN_WIDTH,
    max = DEFAULT_MAX_COLUMN_WIDTH,
  }: KeyboardWidthOptions = {}
): number | null {
  const bounds = { min, max }
  const grow = rtl ? "ArrowLeft" : "ArrowRight"
  const shrink = rtl ? "ArrowRight" : "ArrowLeft"
  switch (key) {
    case grow:
      return clampColumnWidth(current + step, bounds)
    case shrink:
      return clampColumnWidth(current - step, bounds)
    case "PageUp":
      return clampColumnWidth(current + largeStep, bounds)
    case "PageDown":
      return clampColumnWidth(current - largeStep, bounds)
    case "Home":
      return clampColumnWidth(min, bounds)
    case "End":
      return clampColumnWidth(max, bounds)
    default:
      return null
  }
}

export interface AutoFitOptions extends ColumnWidthBounds {
  /** Added to the widest cell so the text is not flush against the column edge. Defaults to 24. */
  padding?: number
}

/**
 * The width that would show every cell in a column in full, or `null` if nothing could be measured.
 *
 * `scrollWidth` is the right ruler and the only one available: under a fixed layout the cell is
 * already as narrow as the column, so its *own* box says nothing about its content, while
 * `scrollWidth` is the content's width whether or not it is being clipped. Rounded up, because a
 * fraction down is a clipped last glyph.
 *
 * `null` for an empty column rather than a number, so the caller can leave the width alone instead
 * of snapping it to the minimum — a column of empty cells is almost always a column still loading.
 */
export function autoFitColumnWidth(
  cells: readonly { scrollWidth?: number }[],
  { padding = 24, min, max }: AutoFitOptions = {}
): number | null {
  let widest = 0
  for (const cell of cells) {
    const width = cell?.scrollWidth
    if (typeof width === "number" && Number.isFinite(width)) widest = Math.max(widest, width)
  }
  if (widest <= 0) return null
  return clampColumnWidth(Math.ceil(widest + padding), { min, max })
}

/**
 * Whether `node` sits in a right-to-left table.
 *
 * Read from the element at the moment of the gesture rather than kept in state, because direction is
 * inherited and can change under the component — an `<html dir>` toggle, a single column of Arabic
 * in an otherwise English page — and a cached answer silently resizes the wrong way afterwards.
 * Asked of the node itself, not of `document`, for the same reason: `dir` is per-subtree.
 */
export function isRtlElement(node: Element | null | undefined): boolean {
  if (!node || typeof getComputedStyle !== "function") return false
  return getComputedStyle(node).direction === "rtl"
}

/** A drag in progress. */
export interface ColumnResizeSession {
  column: string
  /** Pointer x at the moment of the press. */
  startX: number
  /** The column's width at the moment of the press — the origin every move is measured from. */
  startWidth: number
  /** The width the drag has reached. */
  width: number
  pointerId: number
}

export function beginColumnResize(init: {
  column: string
  startX: number
  startWidth: number
  pointerId?: number
}): ColumnResizeSession {
  return {
    column: init.column,
    startX: init.startX,
    startWidth: init.startWidth,
    width: init.startWidth,
    pointerId: init.pointerId ?? -1,
  }
}

/** `session` advanced to pointer x. Never mutates. */
export function advanceColumnResize(
  session: ColumnResizeSession,
  x: number,
  options: DragWidthOptions = {}
): ColumnResizeSession {
  return {
    ...session,
    width: columnWidthFromDrag(session.startWidth, session.startX, x, options),
  }
}

/** How the table behaves while the pointer is down. */
export type ColumnResizePreview = "guide" | "live"

export interface ColumnResizerLabels {
  /** The handle's accessible name. */
  handle: (column: string) => string
  /** Spoken value. Pixels, said as a word — "240" alone is read as a quantity of nothing. */
  value: (width: number) => string
}

export const defaultColumnResizerLabels: ColumnResizerLabels = {
  handle: (column) => `Resize ${column} column`,
  value: (width) => `${Math.round(width)} pixels`,
}

export interface UseColumnResizerOptions extends ColumnWidthBounds {
  /** Column ids, in the order the table renders them. */
  columns: readonly string[]
  /** Controlled widths. Pair with `onWidthsChange`. */
  widths?: ColumnWidthMap
  /** Starting widths when uncontrolled. */
  defaultWidths?: ColumnWidthMap
  /**
   * Called once per gesture, with the whole map.
   *
   * Once, not per pointer move: a column width is a preference worth storing, and a listener that
   * writes to `localStorage` or to a server is not something to run sixty times a second. During
   * the drag the preview is applied to the DOM directly and no state changes at all — see
   * {@link ColumnResizePreview}.
   */
  onWidthsChange?: (widths: ColumnWidthMap) => void
  /** Width for a column with no stored entry. Defaults to 160. */
  defaultWidth?: number
  /** What moves while the pointer is down. Defaults to `"guide"`. */
  preview?: ColumnResizePreview
  step?: number
  largeStep?: number
  /** Double-click a handle to fit the column to its contents. Defaults to `true`. */
  autoFit?: boolean
  labels?: Partial<ColumnResizerLabels>
}

export interface ColumnResizeHandleAttributes {
  role: "separator"
  tabIndex: 0
  "aria-orientation": "vertical"
  "aria-label": string
  "aria-valuenow": number
  "aria-valuemin": number
  "aria-valuemax": number
  "aria-valuetext": string
  "data-resizing"?: "true"
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void
  onLostPointerCapture: (event: React.PointerEvent<HTMLElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
  onDoubleClick: (event: React.MouseEvent<HTMLElement>) => void
}

export interface UseColumnResizerResult {
  columns: readonly string[]
  /** Every column's width, in order — dense, clamped, never `NaN`. */
  widths: number[]
  /** The width the `<table>` must carry. See {@link tableWidthFor}. */
  totalWidth: number
  /** The column being dragged, or `null`. */
  resizing: string | null
  /** Spread on the scroll wrapper. Makes it the guide's containing block and the scrollport. */
  wrapperProps: {
    ref: React.RefObject<HTMLDivElement | null>
    "data-resizing"?: "true"
  }
  /**
   * Spread on the `<table>`. Carries `table-layout: fixed` and the computed width.
   *
   * Deliberately not applied from the wrapper with a descendant rule, the way a wrapper component
   * would normally style the table it is given. The width here is the single value the whole
   * component rests on, it has to beat whatever `w-full` is already on the element, and a
   * class-based override that a consumer's Tailwind build never generates fails by leaving the
   * table at `width: auto` — where `table-layout: fixed` goes quiet and the columns silently size
   * themselves to their content again. An inline style cannot not be generated.
   */
  tableProps: {
    ref: React.RefObject<HTMLTableElement | null>
    style: React.CSSProperties
  }
  /** Spread on the `<col>` for `column`. */
  colProps: (column: string) => { ref: (node: HTMLTableColElement | null) => void; style: React.CSSProperties }
  /** Spread on the handle inside `column`'s `<th>`. */
  handleProps: (column: string) => ColumnResizeHandleAttributes
  /** Spread on the guide line. Rendered inside the wrapper, not inside a cell. */
  guideProps: { ref: React.RefObject<HTMLDivElement | null>; hidden: boolean; style: React.CSSProperties }
  /** Set a column's width directly — a "reset widths" button, or a width restored from storage. */
  setColumnWidth: (column: string, width: number) => void
}

/**
 * The behaviour of a resizable column set, without any of its markup.
 *
 * Holds the widths, the drag, the keyboard and the measurements; renders nothing. {@link ColumnResizer},
 * {@link ColumnWidths} and {@link ColumnResizeHandle} are thin wrappers over what this returns, and
 * exist so the common case is not twenty lines of prop spreading.
 */
export function useColumnResizer({
  columns,
  widths: controlledWidths,
  defaultWidths,
  onWidthsChange,
  defaultWidth = 160,
  min = DEFAULT_MIN_COLUMN_WIDTH,
  max = DEFAULT_MAX_COLUMN_WIDTH,
  preview = "guide",
  step = DEFAULT_KEY_STEP,
  largeStep = DEFAULT_KEY_STEP_LARGE,
  autoFit = true,
  labels: labelOverrides,
}: UseColumnResizerOptions): UseColumnResizerResult {
  const isControlled = controlledWidths !== undefined
  const [ownWidths, setOwnWidths] = React.useState<ColumnWidthMap>(defaultWidths ?? {})
  const widthMap = isControlled ? controlledWidths : ownWidths

  const bounds = React.useMemo(() => ({ min, max }), [min, max])
  const resolved = React.useMemo(
    () => resolveColumnWidths(columns, widthMap, { defaultWidth, min, max }),
    [columns, widthMap, defaultWidth, min, max]
  )
  const totalWidth = tableWidthFor(resolved)

  const labels = React.useMemo(
    () => ({ ...defaultColumnResizerLabels, ...labelOverrides }),
    [labelOverrides]
  )

  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  const tableRef = React.useRef<HTMLTableElement | null>(null)
  const guideRef = React.useRef<HTMLDivElement | null>(null)
  const colRefs = React.useRef(new Map<string, HTMLTableColElement | null>())

  // One render when the drag starts and one when it ends. Not the width: see `session` below.
  const [resizing, setResizing] = React.useState<string | null>(null)
  // The live width lives in a ref, which is the point. A table is the one component where the
  // obvious implementation — width in state, re-render per pointer move — is visibly too slow: each
  // move re-renders every row and then makes the browser lay the whole table out again, and at
  // twenty columns the line stops keeping up with the hand. Refs let the drag write one style
  // property on one element per move and leave React out of it until the pointer is released.
  const session = React.useRef<ColumnResizeSession | null>(null)
  // Where the table's left edge sits inside the wrapper's scrollable content, read once per gesture.
  // The guide is positioned against the wrapper, so anything between the two — padding, a border, a
  // toolbar — is an offset the boundary would otherwise be drawn without.
  const originRef = React.useRef(0)
  const rtlRef = React.useRef(false)

  const commit = React.useCallback(
    (column: string, width: number) => {
      const next = resizeColumnWidth(widthMap, column, width, bounds)
      if (!isControlled) setOwnWidths(next)
      onWidthsChange?.(next)
    },
    [widthMap, bounds, isControlled, onWidthsChange]
  )

  const setColumnWidth = React.useCallback(
    (column: string, width: number) => commit(column, width),
    [commit]
  )

  /** Moves the guide, or the column itself, without telling React. */
  const paint = React.useCallback(
    (current: ColumnResizeSession) => {
      const index = columns.indexOf(current.column)
      if (index < 0) return
      if (preview === "live") {
        const col = colRefs.current.get(current.column)
        if (col?.style) col.style.width = `${current.width}px`
        // The table's width has to move with it, or the sum stops matching and the browser goes back
        // to sharing the difference out across every column — the drag would pull its neighbours
        // along with it. See tableWidthFor.
        const table = tableRef.current
        if (table?.style) {
          const widthsNow = resolved.slice()
          widthsNow[index] = current.width
          table.style.width = `${tableWidthFor(widthsNow)}px`
        }
        return
      }
      const guide = guideRef.current
      if (!guide?.style) return
      const boundary = columnOffsets(resolved)[index] + current.width
      guide.style.left = `${originRef.current + boundary}px`
    },
    [columns, preview, resolved]
  )

  const finish = React.useCallback(
    (cancelled: boolean) => {
      const current = session.current
      session.current = null
      setResizing(null)
      if (!current) return
      if (preview === "live") {
        // Hand the element back to React. Left as it is, the inline width written during the drag
        // outranks the one the next render puts there, so a parent that clamps or rejects the new
        // width would be overruled by the leftovers of the gesture that proposed it.
        const col = colRefs.current.get(current.column)
        if (col?.style) col.style.removeProperty("width")
        const table = tableRef.current
        if (table?.style) table.style.removeProperty("width")
      }
      if (!cancelled && current.width !== current.startWidth) commit(current.column, current.width)
    },
    [commit, preview]
  )

  const handleProps = React.useCallback(
    (column: string): ColumnResizeHandleAttributes => {
      const index = columns.indexOf(column)
      const width = index < 0 ? defaultWidth : resolved[index]
      return {
        role: "separator",
        tabIndex: 0,
        "aria-orientation": "vertical",
        "aria-label": labels.handle(column),
        "aria-valuenow": Math.round(width),
        "aria-valuemin": Math.round(min),
        "aria-valuemax": Math.round(max),
        "aria-valuetext": labels.value(width),
        ...(resizing === column ? { "data-resizing": "true" as const } : {}),
        onPointerDown: (event) => {
          // Secondary buttons open menus and must not start a gesture that only ends on pointerup.
          if (event.button !== 0) return
          // The press belongs to the handle, not to the header it sits in: the <th> underneath is a
          // sort button in most tables, and without this a resize also sorts the column on release.
          event.preventDefault()
          event.stopPropagation()
          const node = event.currentTarget
          rtlRef.current = isRtlElement(node)
          const wrapper = wrapperRef.current
          const table = tableRef.current
          originRef.current =
            wrapper?.getBoundingClientRect && table?.getBoundingClientRect
              ? table.getBoundingClientRect().left -
                wrapper.getBoundingClientRect().left +
                (wrapper.scrollLeft ?? 0)
              : 0
          const next = beginColumnResize({
            column,
            startX: event.clientX,
            startWidth: width,
            pointerId: event.pointerId,
          })
          session.current = next
          // Capture, so the gesture survives the pointer leaving a 9px-wide strip — which it does
          // immediately, because widening the column moves the handle out from under the finger.
          // Without it the drag ends on the first move and the column jumps back.
          node?.setPointerCapture?.(event.pointerId)
          setResizing(column)
          paint(next)
        },
        onPointerMove: (event) => {
          const current = session.current
          if (!current || current.pointerId !== event.pointerId) return
          const next = advanceColumnResize(current, event.clientX, {
            ...bounds,
            rtl: rtlRef.current,
          })
          session.current = next
          paint(next)
        },
        onPointerUp: (event) => {
          const current = session.current
          if (!current || current.pointerId !== event.pointerId) return
          // Advanced to the release coordinate before finishing, rather than trusting the last move
          // to have been the last word. Pointer moves are coalesced and the final one before a
          // release is routinely dropped, so a drag that ends with a quick flick commits the width
          // from some pixels back — a column that does not land where it was let go, every time the
          // gesture is fast.
          session.current = advanceColumnResize(current, event.clientX, {
            ...bounds,
            rtl: rtlRef.current,
          })
          finish(false)
        },
        // A cancelled pointer is not a release. The OS takes the pointer away for a phone call, an
        // edge gesture, a palm on the trackpad — and at that moment the finger is wherever it had
        // got to, so treating cancel as "dropped here" commits a width nobody chose.
        onPointerCancel: () => finish(true),
        onLostPointerCapture: () => {
          if (session.current) finish(false)
        },
        onKeyDown: (event) => {
          if (event.key === "Escape" && session.current) {
            finish(true)
            return
          }
          const next = keyboardColumnWidth(event.key, width, {
            step,
            largeStep,
            // Read here, not from the ref the pointer path fills: that ref is only ever written by a
            // drag, so on an RTL table every arrow key ran the wrong way until someone had dragged a
            // column once — and then came right, which is worse than being consistently wrong.
            rtl: isRtlElement(event.currentTarget),
            min,
            max,
          })
          // null means a key this handle does not claim — Tab above all, which has to keep working
          // or focus is stuck on a column border.
          if (next === null) return
          event.preventDefault()
          if (next !== width) commit(column, next)
        },
        onDoubleClick: () => {
          if (!autoFit) return
          const table = tableRef.current
          if (!table?.querySelectorAll) return
          const position = columns.indexOf(column) + 1
          if (position <= 0) return
          const cells = Array.from(table.querySelectorAll(`tr > *:nth-child(${position})`))
          const fitted = autoFitColumnWidth(cells, { min, max })
          if (fitted !== null) commit(column, fitted)
        },
      }
    },
    [
      columns, resolved, defaultWidth, labels, min, max, resizing, bounds,
      paint, finish, commit, step, largeStep, autoFit,
    ]
  )

  const colProps = React.useCallback(
    (column: string) => {
      const index = columns.indexOf(column)
      return {
        ref: (node: HTMLTableColElement | null) => {
          if (node) colRefs.current.set(column, node)
          else colRefs.current.delete(column)
        },
        style: { width: `${index < 0 ? defaultWidth : resolved[index]}px` },
      }
    },
    [columns, resolved, defaultWidth]
  )

  return {
    columns,
    widths: resolved,
    totalWidth,
    resizing,
    wrapperProps: {
      ref: wrapperRef,
      ...(resizing ? { "data-resizing": "true" as const } : {}),
    },
    tableProps: {
      ref: tableRef,
      style: { tableLayout: "fixed", width: `${totalWidth}px` },
    },
    colProps,
    handleProps,
    guideProps: {
      ref: guideRef,
      hidden: resizing === null,
      style: { left: 0 },
    },
    setColumnWidth,
  }
}

const ColumnResizerContext = React.createContext<UseColumnResizerResult | null>(null)

/** The resizer from the nearest {@link ColumnResizer}, or `null` outside one. */
export function useColumnResizerContext(): UseColumnResizerResult | null {
  return React.useContext(ColumnResizerContext)
}

function useResizer(explicit?: UseColumnResizerResult): UseColumnResizerResult {
  const fromContext = useColumnResizerContext()
  const resizer = explicit ?? fromContext
  if (!resizer) {
    throw new Error(
      "ColumnWidths and ColumnResizeHandle need a <ColumnResizer> above them, or a `resizer` prop."
    )
  }
  return resizer
}

export interface ColumnResizerProps extends React.ComponentPropsWithoutRef<"div"> {
  resizer: UseColumnResizerResult
  /** Let the table scroll sideways when the columns outgrow the space. Defaults to `true`. */
  scrollable?: boolean
  /** Classes for the guide line. */
  guideClassName?: string
}

/**
 * The scroll container around a resizable table, and the guide line that moves during a drag.
 *
 * ```tsx
 * const COLUMNS = ["name", "status", "amount"] as const
 * const [widths, setWidths] = React.useState({ name: 220, status: 140, amount: 120 })
 * const resizer = useColumnResizer({ columns: COLUMNS, widths, onWidthsChange: setWidths })
 *
 * <ColumnResizer resizer={resizer}>
 *   <table {...resizer.tableProps} className="text-sm">
 *     <ColumnWidths />
 *     <thead>
 *       <tr className="border-b">
 *         {COLUMNS.map((column) => (
 *           <th key={column} className="relative px-3 py-2 text-left font-medium">
 *             <span className="block truncate capitalize">{column}</span>
 *             <ColumnResizeHandle column={column} />
 *           </th>
 *         ))}
 *       </tr>
 *     </thead>
 *     <tbody>
 *       {rows.map((row) => (
 *         <tr key={row.id} className="border-b">
 *           {COLUMNS.map((column) => (
 *             <td key={column} className="truncate px-3 py-2">{row[column]}</td>
 *           ))}
 *         </tr>
 *       ))}
 *     </tbody>
 *   </table>
 * </ColumnResizer>
 * ```
 *
 * **Why the guide is here and not in the `<th>`.** It has to run the full height of the table, so it
 * is absolutely positioned against this wrapper. Put the same element inside the header cell and it
 * resolves against *that* instead the moment the cell is given `position: relative` — which the
 * handle needs — and the line becomes a 20-pixel tick in the header rather than a boundary through
 * the rows. Measured both ways: against the wrapper it spans the table and is clipped by the scroll
 * box; a `position: fixed` line escapes the scroll box altogether and paints down the page.
 *
 * **`truncate` on the cells is not decoration.** A fixed layout gives the column the width it was
 * told and lets the content overflow, so a long cell prints across its neighbour until something
 * clips it.
 *
 * Composes with the other two pieces that go in a `<th>`: `sort-header` for the heading itself and
 * `sticky-table-header` for pinning, each of which leaves the markup alone in the same way.
 */
export function ColumnResizer({
  resizer,
  scrollable = true,
  className,
  guideClassName,
  children,
  ...props
}: ColumnResizerProps) {
  const { wrapperProps, guideProps } = resizer
  return (
    <ColumnResizerContext.Provider value={resizer}>
      <div
        className={cn(
          // `relative` is the guide's containing block, and `w-fit` keeps the wrapper from
          // stretching past a table narrower than the page.
          "relative w-fit max-w-full",
          scrollable && "overflow-x-auto",
          // While dragging, the cursor belongs to the whole surface rather than to the 9px strip the
          // pointer has already left, and selecting text mid-drag turns the gesture into a highlight.
          resizer.resizing && "cursor-col-resize select-none",
          className
        )}
        {...wrapperProps}
        {...props}
      >
        {children}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-primary",
            guideClassName
          )}
          {...guideProps}
        />
      </div>
    </ColumnResizerContext.Provider>
  )
}

export interface ColumnWidthsProps extends React.ComponentPropsWithoutRef<"colgroup"> {
  resizer?: UseColumnResizerResult
}

/**
 * The `<colgroup>` that carries the widths. Place it as the first child of the `<table>`.
 *
 * The widths go on `<col>` elements rather than on the `<th>`s because one column is one `<col>` and
 * several cells: written on the header cell, the width is a claim about that cell which every other
 * cell in the column is free to contradict, and under the automatic layout they do.
 *
 * Inline styles, not classes — a width computed at runtime has no class to be compiled from, which
 * is the trap in building one as `` `w-[${width}px]` ``: Tailwind reads source files as text, finds
 * no such class, and emits nothing.
 */
export function ColumnWidths({ resizer: explicit, ...props }: ColumnWidthsProps) {
  const resizer = useResizer(explicit)
  return (
    <colgroup {...props}>
      {resizer.columns.map((column) => (
        <col key={column} {...resizer.colProps(column)} />
      ))}
    </colgroup>
  )
}

export interface ColumnResizeHandleProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    // Every key the handle itself sets. Spreading the caller's props last would otherwise let one
    // stray `onKeyDown` replace the arrow-key support with nothing, and the component would still
    // look right — a separator with a value that no key moves.
    | "role"
    | "children"
    | "tabIndex"
    | "aria-orientation"
    | "aria-label"
    | "aria-valuenow"
    | "aria-valuemin"
    | "aria-valuemax"
    | "aria-valuetext"
    | "onPointerDown"
    | "onPointerMove"
    | "onPointerUp"
    | "onPointerCancel"
    | "onLostPointerCapture"
    | "onKeyDown"
    | "onDoubleClick"
  > {
  column: string
  resizer?: UseColumnResizerResult
  /** Hide the thin line until the handle is hovered or focused. Defaults to `false`. */
  subtle?: boolean
}

/**
 * The grab strip on a column's trailing edge. Goes inside the `<th>`, which needs `relative`.
 *
 * Wider than it looks on purpose — {@link DEFAULT_HANDLE_WIDTH} of transparent strip around a 1px
 * line — because the line is what you aim at and a 1px target is not one. It is a
 * `role="separator"` with a value and arrow keys rather than a `<div onMouseDown>`, so the column
 * can be resized without a pointer at all; the version without that is a feature a keyboard user
 * cannot see is missing.
 *
 * `touch-none` matters on a phone: the browser claims a horizontal drag for panning before any
 * pointer handler runs, so without it the gesture scrolls the table instead of resizing it.
 */
export function ColumnResizeHandle({
  column,
  resizer: explicit,
  subtle = false,
  className,
  style,
  ...props
}: ColumnResizeHandleProps) {
  const resizer = useResizer(explicit)
  const handle = resizer.handleProps(column)
  const active = resizer.resizing === column
  // The strip straddles the boundary it represents — except on the last column, where that boundary
  // is the table's own right edge. Half a handle hanging past it is half a handle of content, and
  // the scroll container around the table duly offers four pixels of horizontal scroll on a table
  // that fits perfectly: a scrollbar that appears for nothing, which reads as a layout bug.
  // Measured at 4px of overflow before this, 0 after.
  const last = resizer.columns[resizer.columns.length - 1] === column
  return (
    <div
      className={cn(
        "group absolute top-0 right-0 bottom-0 z-10 flex cursor-col-resize touch-none items-stretch justify-center",
        "focus-visible:outline-none",
        className
      )}
      style={{
        width: DEFAULT_HANDLE_WIDTH,
        ...(last ? null : { transform: "translateX(50%)" }),
        ...style,
      }}
      {...props}
      {...handle}
    >
      {/* The line, inset so it reads as the column's edge rather than as a bar of its own. The ring
          is drawn on this child because the strip is transparent and a focus ring around nothing is
          hard to find — and it has to be visible on focus, which is the only way a keyboard user
          knows which of twenty borders the arrow keys are about to move. */}
      <span
        aria-hidden="true"
        className={cn(
          "my-1 w-px rounded-full bg-border transition-colors",
          "group-hover:bg-primary",
          // Thicker, recoloured *and* ringed on focus. One of the three on its own is too quiet for
          // a control whose whole body is transparent: the user has to be able to tell which of
          // twenty identical column borders the arrow keys are now about to move.
          "group-focus-visible:w-0.5 group-focus-visible:bg-primary group-focus-visible:ring-1 group-focus-visible:ring-ring",
          subtle && "bg-transparent group-hover:bg-primary",
          active && "bg-primary w-0.5"
        )}
      />
    </div>
  )
}
