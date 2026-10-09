"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The `colSpan` a detail cell gets when the real column count is not known yet.
 *
 * Deliberately far larger than any real table, and deliberately not `1`. The instinct, when the
 * count is unknown, is to pick a small safe-looking number — and small is the one direction that
 * breaks the table. Measured in Chrome on a 400px three-column table whose detail cell holds a long
 * stack trace, with the correct span as the baseline:
 *
 * | detail `colSpan` | column widths          | table width |
 * | ---------------- | ---------------------- | ----------- |
 * | 3 (correct)      | 105.7 / 210.8 / 106.1  | 423.6       |
 * | 9 (over-claim)   | 105.7 / 210.8 / 106.1  | 423.6       |
 * | 2 (under by one) | 141.1 / 281.5 /  26.6  | 450.2       |
 * | 1                | 422.6 /  52.8 /  26.6  | 502.9       |
 *
 * An over-claim is not merely survivable, it is *identical* to the correct span down to the
 * hundredth of a pixel: the surplus becomes a phantom zero-width column that takes no space and
 * draws nothing. An under-claim charges the detail cell's content width to the columns it does
 * reach, and the columns it does not reach collapse — 100px to 26.6px here. So the failure shows up
 * in the column you never touched, as a heading squeezed down to nothing, which is why it gets
 * investigated as a bug in that column.
 *
 * HTML clamps `colspan` to 1000, so this is the largest value that means "all of them".
 */
export const DETAIL_COLSPAN_WHEN_UNKNOWN = 1000

/**
 * The `colSpan` for a detail cell, given what is known about the table's width.
 *
 * Separate from the components so the rule can be asserted on its own, and so a table that renders
 * its own detail row can still get the rule right.
 */
export function resolveDetailColSpan(columnCount: number | null | undefined): number {
  if (typeof columnCount !== "number" || !Number.isFinite(columnCount)) {
    return DETAIL_COLSPAN_WHEN_UNKNOWN
  }
  // Rounded up rather than down, and floored at 1: a fractional or zero count can only come from a
  // table mid-measurement, and rounding that *down* is the under-claim this whole function exists
  // to avoid.
  return Math.max(1, Math.ceil(columnCount))
}

/** Marks a cell as a detail cell, so {@link countTableColumns} does not count its span. */
export const DETAIL_CELL_ATTRIBUTE = "data-table-row-detail"

/**
 * How many columns a table actually has, or `null` if it cannot be told.
 *
 * The widest row wins, rather than the header row. A header that is missing the narrow chevron
 * column — the single most common way to build this, because the column is added to the body and
 * forgotten in the `<thead>` — would otherwise report one column too few, and one too few is
 * exactly the direction that breaks (see {@link DETAIL_COLSPAN_WHEN_UNKNOWN}).
 *
 * Detail cells are skipped. They are the cells carrying an over-claimed span, so counting them
 * would feed the fallback back into the measurement and pin the answer at 1000 forever.
 *
 * `rowSpan` is not modelled: a cell spanning three rows occupies a column in each of them, and
 * reconstructing that needs the whole grid rather than a per-row sum. Tables built that way should
 * pass `colSpan` explicitly.
 */
export function countTableColumns(table: HTMLTableElement | null | undefined): number | null {
  if (!table || !table.rows) return null
  let widest = 0
  for (const row of Array.from(table.rows)) {
    let span = 0
    for (const cell of Array.from(row.cells)) {
      if (cell.hasAttribute(DETAIL_CELL_ATTRIBUTE)) continue
      // `colSpan` is 1 when the attribute is absent, and the DOM already clamps it.
      span += cell.colSpan || 1
    }
    if (span > widest) widest = span
  }
  return widest > 0 ? widest : null
}

/**
 * The column count of the table enclosing `ref`, measured on demand.
 *
 * `measure` is called from the press that opens a row rather than from an effect after it, which is
 * the whole reason this is a function and not a `useEffect`. At press time the table is already on
 * the page and can simply be read, so the detail row's *first* render carries the true span — there
 * is no first paint at the fallback and no correction afterwards. An effect would reverse that
 * order, and the one frame in between is the frame in which the columns jump.
 */
export function useTableColumnCount<T extends HTMLElement>(
  ref: React.RefObject<T | null>
): { columnCount: number | null; measure: () => number | null } {
  const [columnCount, setColumnCount] = React.useState<number | null>(null)

  const measure = React.useCallback(() => {
    const node = ref.current
    // `closest` rather than a second ref the caller has to thread through the table: the element is
    // inside the table by construction, so the table is always findable from it.
    const table = node?.closest?.("table") as HTMLTableElement | null | undefined
    const next = countTableColumns(table)
    if (next !== null) setColumnCount(next)
    return next
  }, [ref])

  return { columnCount, measure }
}

export interface UseRowExpansionOptions {
  /** Controlled set of open row ids. Pair with `onExpandedChange`. */
  expandedIds?: readonly string[]
  defaultExpandedIds?: readonly string[]
  onExpandedChange?: (ids: string[]) => void
  /**
   * Whether more than one row may be open at once. Defaults to `true`.
   *
   * `false` is right when the detail is tall or expensive — a chart, a log tail, a fetch per row —
   * and wrong for a table people open several rows of to compare them.
   */
  multiple?: boolean
}

export interface UseRowExpansionResult {
  expandedIds: readonly string[]
  isExpanded: (id: string) => boolean
  toggle: (id: string) => void
  expand: (id: string) => void
  collapse: (id: string) => void
  collapseAll: () => void
}

/**
 * Which rows are open, for a table that has more than one expandable row.
 *
 * Held for the table rather than per row on purpose. A `useState(false)` inside each row is the
 * shorter version and it cannot answer any of the questions a table actually asks: close the others
 * when this one opens, collapse everything when the rows are replaced by the next page or a new
 * filter, or persist what was open across a refetch. Rows keyed by id also survive re-ordering,
 * which per-row state does not — sort the table and the open panel stays with the row index rather
 * than with the row.
 *
 * ```tsx
 * const rows = useRowExpansion({ multiple: false })
 * // …and when the filter changes:
 * React.useEffect(() => rows.collapseAll(), [query])
 * ```
 */
export function useRowExpansion({
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  multiple = true,
}: UseRowExpansionOptions = {}): UseRowExpansionResult {
  const controlled = expandedIds !== undefined
  const [internal, setInternal] = React.useState<readonly string[]>(
    () => (controlled ? expandedIds : defaultExpandedIds) ?? []
  )
  const current = controlled ? expandedIds : internal

  // Always written, controlled or not, and the controlled prop always wins on read. Guarding the
  // write with `if (!controlled)` is the version that looks tidier and strands a component whose
  // parent passes `expandedIds` one render and drops it the next — the internal copy is then still
  // whatever it was before the parent took over, so the rows silently revert.
  const commit = React.useCallback(
    (next: string[]) => {
      setInternal(next)
      onExpandedChange?.(next)
    },
    [onExpandedChange]
  )

  const isExpanded = React.useCallback((id: string) => current.includes(id), [current])

  const expand = React.useCallback(
    (id: string) => {
      if (current.includes(id)) return
      commit(multiple ? [...current, id] : [id])
    },
    [commit, current, multiple]
  )

  const collapse = React.useCallback(
    (id: string) => {
      if (!current.includes(id)) return
      commit(current.filter((open) => open !== id))
    },
    [commit, current]
  )

  const toggle = React.useCallback(
    (id: string) => {
      if (current.includes(id)) collapse(id)
      else expand(id)
    },
    [collapse, current, expand]
  )

  const collapseAll = React.useCallback(() => {
    if (current.length === 0) return
    commit([])
  }, [commit, current])

  return { expandedIds: current, isExpanded, toggle, expand, collapse, collapseAll }
}

export interface RowExpanderLabels {
  /** Accessible name while the row is closed. */
  expand: (label: string) => string
  /** Accessible name while the row is open. */
  collapse: (label: string) => string
}

export const defaultRowExpanderLabels: RowExpanderLabels = {
  expand: (label) => `Show details for ${label}`,
  collapse: (label) => `Hide details for ${label}`,
}

export interface TableRowExpanderTriggerProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "aria-expanded" | "aria-controls" | "children"> {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /**
   * What this row *is* — the order number, the filename, the person's name.
   *
   * Required, and it is the prop that decides whether this component is usable by anyone not
   * looking at the screen. The control is a chevron, so it has no text of its own; left to itself a
   * table of forty of them is forty identical announcements of the word "button", with the row they
   * belong to knowable only by exploring the grid. The row's own name is already on screen one cell
   * away, so this costs the caller nothing and is the difference between "button" and "Show details
   * for invoice INV-2048, collapsed".
   */
  label: string
  /** The `id` of the detail cell this opens, for `aria-controls`. */
  controls?: string
  labels?: Partial<RowExpanderLabels>
}

/**
 * The chevron that opens one row.
 *
 * Exported separately because the cell it belongs in is often not an empty one — the trigger may
 * have to sit beside the row's own link, or at the end of the row, or wrap the first cell's text.
 * {@link TableRowExpander} renders one of these for the common case.
 *
 * **`aria-expanded` belongs here, not on the `<tr>`.** ARIA does allow it on a row, so this is not
 * a validity question, and the attribute is not the point — the point is that nothing else in the
 * table is the control. A row is not operable: it takes no focus, answers no key, and offers a
 * screen reader no hint that pressing it would do anything. Putting the state on it describes a
 * thing the user cannot press. official shadcn/ui settles it from the other direction: its
 * `TableRow` ships `has-aria-expanded:bg-muted/50`, which the registry's own compiled stylesheet
 * expands to `:has([aria-expanded=true])` — a *descendant* match. Put the attribute on the row
 * itself and that selector cannot see it, so the open row quietly loses the one piece of styling
 * official ships for this pattern. Put it on a button inside and the highlight arrives for free.
 */
export function TableRowExpanderTrigger({
  expanded,
  onExpandedChange,
  label,
  controls,
  labels: labelOverrides,
  className,
  onClick,
  disabled,
  ...props
}: TableRowExpanderTriggerProps) {
  const labels = React.useMemo(
    () => ({ ...defaultRowExpanderLabels, ...labelOverrides }),
    [labelOverrides]
  )

  return (
    <button
      type="button"
      aria-expanded={expanded}
      // Only while open. `aria-controls` must point at an element that exists, and the detail cell
      // is not rendered while the row is closed — a dangling reference is worse than none, because
      // the assistive technology offers a jump that lands nowhere.
      aria-controls={expanded ? controls : undefined}
      aria-label={expanded ? labels.collapse(label) : labels.expand(label)}
      disabled={disabled}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        onExpandedChange(!expanded)
      }}
      {...props}
    >
      <ChevronRight
        // Decorative: the button's name already says "Show"/"Hide", and `aria-expanded` already
        // says which way round it is. Reading the arrow as well adds a third telling of the same
        // fact to every row in the table.
        aria-hidden="true"
        className={cn(
          "size-4 transition-transform duration-200 motion-reduce:transition-none",
          expanded && "rotate-90"
        )}
      />
    </button>
  )
}

export interface TableRowExpanderDetailProps
  extends Omit<React.ComponentPropsWithoutRef<"tr">, "children"> {
  children: React.ReactNode
  /**
   * The table's column count. Leave unset only when it cannot be known — see
   * {@link DETAIL_COLSPAN_WHEN_UNKNOWN} for what the fallback does and why it is safe.
   */
  colSpan?: number | null
  /** `id` for the cell, so a trigger's `aria-controls` can point at it. */
  cellId?: string
  /** Classes for the `<td>`. */
  cellClassName?: string
  /** Classes for the panel inside the `<td>` — the element a collapse animation belongs on. */
  panelClassName?: string
}

/**
 * The detail row: one `<tr>`, one `<td>` across the whole table, and a panel inside it.
 *
 * **The panel is not decoration.** A row cannot be collapsed, so the panel is the only place an
 * open/close animation can live. Measured in Chrome, asking each candidate to be zero-tall with
 * `height: 0; overflow: hidden` around two lines of text:
 *
 * | element                     | height when asked to be 0 |
 * | --------------------------- | ------------------------- |
 * | `<tr>`                      | 33px                      |
 * | `<td>`                      | 33px                      |
 * | a `<div>` inside the `<td>` | 0px                       |
 *
 * `height` on a table row is a minimum rather than a size, and `overflow` does not apply to
 * `table-row` or `table-cell` at all — the computed style on that `<tr>` reads back `height: 33px`
 * and `overflow: hidden` together, the second simply having no effect. So the transition everyone
 * writes first is attached to the one element in the tree that cannot honour it, and it does not
 * fail loudly: the row appears instantly, and the CSS sits there looking correct.
 *
 * The panel carries `data-state="open"`, which is the attribute official shadcn/ui's own collapsing
 * components key their animations off, so a project that has installed `accordion` already has the
 * keyframes:
 *
 * ```tsx
 * <TableRowExpander panelClassName="data-[state=open]:animate-accordion-down" … />
 * ```
 *
 * For a collapse that animates to the content's own height without measuring it in JavaScript, the
 * panel is also where `grid-template-rows: 0fr → 1fr` works — the one transition that interpolates
 * to `auto`. It collapses to 0px here and cannot anywhere in the table around it.
 */
export function TableRowExpanderDetail({
  children,
  colSpan,
  cellId,
  className,
  cellClassName,
  panelClassName,
  ...props
}: TableRowExpanderDetailProps) {
  return (
    <tr
      // Not `aria-hidden`, not `role="presentation"`: the row is a real row and saying otherwise
      // breaks the grid the table exposes. What keeps it from being mistaken for data is that the
      // trigger points at it with `aria-controls` and announces its own state.
      data-state="open"
      className={cn("border-b bg-muted/30", className)}
      {...props}
    >
      <td
        id={cellId}
        colSpan={resolveDetailColSpan(colSpan)}
        // Read by countTableColumns, which must not count this cell's span as a column. Written as a
        // literal rather than through DETAIL_CELL_ATTRIBUTE because a computed key in a JSX spread
        // is not checked against the element's attributes — the one place a typo here would go
        // unnoticed is the place where the counter stops skipping this cell and pins itself at 1000.
        data-table-row-detail=""
        className={cn("p-0 align-top", cellClassName)}
      >
        <div data-state="open" className={cn("px-4 py-3", panelClassName)}>
          {children}
        </div>
      </td>
    </tr>
  )
}

export interface TableRowExpanderProps
  extends Omit<React.ComponentPropsWithoutRef<"tbody">, "children"> {
  /** The row's own cells. The trigger's cell is added by this component unless `trigger` is `"none"`. */
  children: React.ReactNode
  /** What goes under the row once it is open. Rendered only while open. */
  detail: React.ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  /** What this row is, for the trigger's accessible name. See {@link TableRowExpanderTriggerProps.label}. */
  label: string
  /** Where the chevron goes, or `"none"` to place a {@link TableRowExpanderTrigger} yourself. */
  trigger?: "start" | "end" | "none"
  /**
   * The table's column count. Left unset it is measured from the real table at press time, which is
   * what a table with a variable number of columns needs.
   */
  colSpan?: number | null
  disabled?: boolean
  labels?: Partial<RowExpanderLabels>
  /** Classes for the data `<tr>`. */
  rowClassName?: string
  /** Classes for the detail `<tr>`. */
  detailClassName?: string
  /** Classes for the panel inside the detail cell — where an animation belongs. */
  panelClassName?: string
}

/**
 * One row of a table, plus the detail panel that opens beneath it.
 *
 * ```tsx
 * const rows = useRowExpansion()
 *
 * <table className="w-full">
 *   <thead>
 *     <tr>
 *       <th className="w-8" />
 *       <th>Order</th><th>Customer</th><th className="text-right">Total</th>
 *     </tr>
 *   </thead>
 *   {orders.map((order) => (
 *     <TableRowExpander
 *       key={order.id}
 *       label={`order ${order.number}`}
 *       expanded={rows.isExpanded(order.id)}
 *       onExpandedChange={() => rows.toggle(order.id)}
 *       detail={<OrderLines order={order} />}
 *     >
 *       <td>{order.number}</td>
 *       <td>{order.customer}</td>
 *       <td className="text-right">{order.total}</td>
 *     </TableRowExpander>
 *   ))}
 * </table>
 * ```
 *
 * **It is a `<tbody>`, one per row, and that is the feature.** A table may hold any number of
 * `<tbody>` elements, and grouping each row with its own detail is what keeps the detail row from
 * being counted as data by everything that counts rows. Striping is the visible case. With both
 * rows in one shared `<tbody>`, `tbody tr:nth-child(even)` does not merely shift by one — measured
 * in Chrome on three rows with two open, the stripe lands on *both detail rows and no data row at
 * all*, which reads as a table that has lost its stripes and grown two shaded panels. Grouped, the
 * same table stripes correctly with `tbody:nth-of-type(even) tr`, and the pair shades together.
 * The same correction applies to anything else keyed on position — "3 of 12" counters, a roving
 * tabindex walking rows with Up and Down, and the row-selection checkbox that shift-click extends
 * a range of.
 *
 * Both rows stay in the caller's own table, so this drops into one that already exists — official
 * shadcn/ui's `<Table>`, a hand-written `<table>`, or one whose columns are being dragged wider by
 * `column-resizer`. It renders nothing while closed: a row that is present but empty is not cheaper
 * than one that is absent, and it leaves a hairline under every row in the table.
 */
export function TableRowExpander({
  children,
  detail,
  expanded,
  onExpandedChange,
  label,
  trigger = "start",
  colSpan,
  disabled,
  labels,
  className,
  rowClassName,
  detailClassName,
  panelClassName,
  ...props
}: TableRowExpanderProps) {
  const bodyRef = React.useRef<HTMLTableSectionElement | null>(null)
  const { columnCount, measure } = useTableColumnCount(bodyRef)
  const reactId = React.useId()
  const detailId = `${reactId}-detail`
  const triggerId = `${reactId}-trigger`

  const handleExpandedChange = React.useCallback(
    (next: boolean) => {
      // Measured here rather than in an effect: the table is on the page now, so the detail row's
      // first render already has the real span. See useTableColumnCount.
      if (next) measure()
      onExpandedChange(next)
    },
    [measure, onExpandedChange]
  )

  // Built unconditionally and placed conditionally below. A `trigger === "none" ? null : …` guard
  // here as well would be dead: an unplaced element is never rendered, so the two conditions can
  // only ever agree, and the second one is just a branch nothing can take.
  const triggerCell = (
    <td className="w-8 p-0 text-center align-middle">
      <TableRowExpanderTrigger
        id={triggerId}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
        label={label}
        controls={detailId}
        disabled={disabled}
        labels={labels}
      />
    </td>
  )

  return (
    <tbody ref={bodyRef} className={className} {...props}>
      <tr
        data-state={expanded ? "open" : "closed"}
        className={cn("border-b transition-colors hover:bg-muted/50", rowClassName)}
      >
        {trigger === "start" && triggerCell}
        {children}
        {trigger === "end" && triggerCell}
      </tr>
      {expanded && (
        <TableRowExpanderDetail
          cellId={detailId}
          // The caller's explicit count wins; otherwise what was measured at press time; otherwise
          // the over-claim, which is what a row rendered open on the first paint gets.
          colSpan={colSpan ?? columnCount}
          className={detailClassName}
          panelClassName={panelClassName}
        >
          {detail}
        </TableRowExpanderDetail>
      )}
    </tbody>
  )
}
