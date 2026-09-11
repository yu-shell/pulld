"use client"

import * as React from "react"
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Which way a column is sorted.
 *
 * These are deliberately the words `aria-sort` itself takes, rather than the `"asc"` / `"desc"` a
 * hand-rolled table usually carries around. The state you store and the attribute the browser
 * exposes are then the same value, so there is no mapping step to write backwards — and a mapping
 * step written backwards is silent: the table re-orders correctly, the arrow points the right way,
 * and only the screen reader is told the opposite of what happened.
 */
export type SortDirection = "ascending" | "descending"

/** The one sorted column, or `null` for "the table's own order". */
export interface SortState {
  column: string
  direction: SortDirection
}

/** What `aria-sort` should say for a given column. `"none"` means sortable but not sorted. */
export type AriaSort = SortDirection | "none"

export interface SortCycleOptions {
  /**
   * The direction the first press produces. Defaults to `"ascending"`.
   *
   * Worth setting per column rather than leaving alone. Ascending is right for a name, an email, a
   * status; it is the wrong guess for every column whose interesting end is the top — a date, a
   * file size, a count, a score, an amount — where the first press is meant to answer "newest",
   * "biggest", "worst", and ascending answers it with the oldest and smallest instead, so everyone
   * presses twice, every time.
   */
  firstDirection?: SortDirection
  /**
   * Whether a third press clears the sort. Defaults to `true`.
   *
   * Turn it off for a table that must always be sorted by something — a leaderboard, a queue — so
   * the cycle is just the two directions.
   */
  clearable?: boolean
}

const OPPOSITE: Record<SortDirection, SortDirection> = {
  ascending: "descending",
  descending: "ascending",
}

/**
 * The state after pressing `column`'s header, given the state before it.
 *
 * **Three states, shown as two.** The reflex is to flip between ascending and descending, and it
 * quietly removes something: once a column has been touched, the order the table arrived in — which
 * is almost always the meaningful one, newest first, or a rank the server computed — cannot be got
 * back. There is no third press that returns it, no button that says "stop sorting", and reloading
 * the page is the only way out, which is why people do that. So the cycle here is first direction,
 * opposite, gone, and "gone" hands `null` back: sort by nothing and render the rows as they came.
 */
export function nextSortState(
  current: SortState | null,
  column: string,
  { firstDirection = "ascending", clearable = true }: SortCycleOptions = {}
): SortState | null {
  if (!current || current.column !== column) return { column, direction: firstDirection }
  if (current.direction === firstDirection) {
    return { column, direction: OPPOSITE[firstDirection] }
  }
  return clearable ? null : { column, direction: firstDirection }
}

/**
 * What `aria-sort` should be for `column`, derived from the single sort state.
 *
 * Deriving it is the whole point, and the reason this component takes the table's sort state rather
 * than a per-header `sorted` flag. `aria-sort` does not mean "this column can be sorted" — it means
 * "this is how the table is ordered right now", so it may be `ascending` or `descending` on exactly
 * one header at a time and `none` on the rest. Held as a flag per header, the failure is always the
 * same shape: pressing a second column sets the new one and forgets to unset the old, and a screen
 * reader is then told two different columns are each sorting the table. It reads as a table that
 * cannot be trusted, and nothing on screen looks wrong.
 */
export function ariaSortFor(state: SortState | null, column: string): AriaSort {
  return state?.column === column ? state.direction : "none"
}

/**
 * Whether a value is an empty cell rather than a value that happens to be small.
 *
 * `null`, `undefined`, `""`, `NaN` and an invalid `Date` — the five ways a missing cell arrives from
 * an API — as against `0` and `false`, which are values and sort as values.
 */
export function isBlankValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true
  if (typeof value === "number") return Number.isNaN(value)
  if (value instanceof Date) return Number.isNaN(value.getTime())
  return false
}

// Built once: constructing a Collator costs far more than a comparison does, and a sort calls the
// comparator O(n log n) times. `undefined` locale means the runtime's own, which is what a table of
// user-facing text wants.
const collatorCache = new Map<string, Intl.Collator>()

/**
 * The collator used for text, cached per locale.
 *
 * `numeric` so that `Item 2` comes before `Item 10` rather than after it — an id, an invoice number,
 * a version or a row label that arrives as a string is otherwise ordered by digit, which looks like
 * the sort is simply broken. `sensitivity: "base"` so that case and accents do not split a column
 * into runs: a plain `sort()` puts every capitalised word above every lowercase one, and drops
 * `Ångström` and `Öberg` below `Zulu` where nobody looks for them.
 */
export function sortCollator(locale?: string): Intl.Collator {
  const key = locale ?? ""
  let collator = collatorCache.get(key)
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" })
    collatorCache.set(key, collator)
  }
  return collator
}

function toComparable(value: unknown): number | string {
  if (typeof value === "number") return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "boolean") return value ? 1 : 0
  if (value instanceof Date) return value.getTime()
  return String(value)
}

/**
 * Compares two cell values in ascending order, with blanks after everything.
 *
 * Exported because the comparison and the header have to agree about what the order *is*, and the
 * server that paginates the same table has to agree with both.
 */
export function compareValues(a: unknown, b: unknown, collator = sortCollator()): number {
  const aBlank = isBlankValue(a)
  const bBlank = isBlankValue(b)
  if (aBlank || bBlank) return aBlank && bBlank ? 0 : aBlank ? 1 : -1
  const left = toComparable(a)
  const right = toComparable(b)
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0
  }
  // A column holding both numbers and text is a data problem rather than a sorting one; numbers
  // first is at least a stable answer to it.
  if (typeof left === "number") return -1
  if (typeof right === "number") return 1
  return collator.compare(left, right)
}

export interface SortRowsOptions {
  collator?: Intl.Collator
  locale?: string
}

/**
 * Returns `rows` in `state`'s order. Never mutates, and always hands back a new array.
 *
 * Two things here are the reason this is not three lines at the call site.
 *
 * **Descending is not ascending reversed.** Reversing is the obvious implementation and it moves
 * two things it should not. Blank cells, which belong at the bottom in both directions — an empty
 * "Last seen" is not the most recent one — jump to the top the moment the arrow flips, so half the
 * screen is empty rows. And rows that tie, having been left in their original order on the way up,
 * come back scrambled on the way down: a name column sorted descending shows the same three
 * "Pending" rows in a different order than ascending did, and to the person reading it the table
 * looks like it is shuffling rows at random. Negating the comparison instead, and pinning blanks
 * outside it, keeps both still.
 *
 * **Sort the source, not the screen.** `Array.prototype.sort` is stable, which is a good property
 * and also a trap: sorting the array you last displayed means the previous sort survives inside
 * every group of ties, so the result depends on the order of presses rather than on the state, and
 * pressing Name then Status then Name again gives a different table than pressing Name alone. Keep
 * the rows the server sent and run this over them each time.
 */
export function sortRows<T>(
  rows: readonly T[],
  state: SortState | null,
  getValue: (row: T, column: string) => unknown,
  { collator, locale }: SortRowsOptions = {}
): T[] {
  const out = rows.slice()
  if (!state) return out
  const compare = collator ?? sortCollator(locale)
  const sign = state.direction === "descending" ? -1 : 1
  return out.sort((a, b) => {
    const left = getValue(a, state.column)
    const right = getValue(b, state.column)
    const leftBlank = isBlankValue(left)
    const rightBlank = isBlankValue(right)
    if (leftBlank || rightBlank) {
      return leftBlank && rightBlank ? 0 : leftBlank ? 1 : -1
    }
    return sign * compareValues(left, right, compare)
  })
}

export interface SortHeaderLabels {
  /** Spoken after a press. `direction` is `null` when the press cleared the sort. */
  announce: (column: string, direction: SortDirection | null) => string
}

export const defaultSortHeaderLabels: SortHeaderLabels = {
  announce: (column, direction) =>
    direction === null
      ? `Sorting by ${column} cleared. Table is back to its default order.`
      : `Table sorted by ${column}, ${direction}.`,
}

export interface UseSortHeaderOptions extends SortCycleOptions {
  /** This header's column key. Matched against `sort.column`. */
  column: string
  /** The table's current sort, or `null`. The same value goes to every header. */
  sort: SortState | null
  onSortChange: (next: SortState | null) => void
  /** Column name for announcements. Defaults to `column`. */
  label?: string
  /** Accept presses but do nothing, e.g. while rows are loading. */
  disabled?: boolean
  /** Announce the new order after a press. Defaults to `true`. */
  announce?: boolean
  labels?: Partial<SortHeaderLabels>
}

export interface UseSortHeaderResult {
  /** `"ascending"`, `"descending"` or `"none"` — this column's share of the table's state. */
  ariaSort: AriaSort
  /** Whether this is the column the table is sorted by. */
  active: boolean
  /** This column's direction, or `null` when it is not the sorted one. */
  direction: SortDirection | null
  /** What the next press would produce, without making it happen. */
  next: SortState | null
  /** Non-empty for a moment after a press. Belongs in a polite live region. */
  announcement: string
  /** Spread onto the `<th>`. The cell, not the button, is what may carry `aria-sort`. */
  headerProps: { scope: "col"; "aria-sort": AriaSort }
  /** Spread onto the `<button>` inside it. */
  buttonProps: {
    type: "button"
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
    "aria-disabled"?: true
  }
}

/**
 * The header's behaviour without its markup — for a column laid out as a grid of `div`s, a header
 * that already has a filter menu in it, or a table component whose `<th>` is not yours to render.
 */
export function useSortHeader({
  column,
  sort,
  onSortChange,
  label,
  firstDirection = "ascending",
  clearable = true,
  disabled = false,
  announce = true,
  labels: labelOverrides,
}: UseSortHeaderOptions): UseSortHeaderResult {
  const ariaSort = ariaSortFor(sort, column)
  const active = ariaSort !== "none"
  const direction = active ? (ariaSort as SortDirection) : null
  const next = nextSortState(sort, column, { firstDirection, clearable })

  const labels = React.useMemo(
    () => ({ ...defaultSortHeaderLabels, ...labelOverrides }),
    [labelOverrides]
  )

  const [announcement, setAnnouncement] = React.useState("")
  // Set by this header's own click, read by the effect below. Announcing from a state change alone
  // would make every other header speak too — pressing Status takes Name from ascending to none,
  // and Name has no business saying anything about a press that was not on it.
  const pressed = React.useRef(false)
  const lastAriaSort = React.useRef(ariaSort)

  React.useEffect(() => {
    if (lastAriaSort.current === ariaSort) return
    lastAriaSort.current = ariaSort
    if (!pressed.current) return
    pressed.current = false
    if (announce) setAnnouncement(labels.announce(label ?? column, direction))
  }, [ariaSort, direction, announce, labels, label, column])

  // Cleared again shortly after, because the live region sits inside the header cell: left there,
  // the sentence becomes part of the cell's own content, and the next reader to land on the column
  // hears "Name, ascending, Table sorted by Name, ascending".
  React.useEffect(() => {
    if (!announcement) return
    const timer = setTimeout(() => setAnnouncement(""), 1000)
    return () => clearTimeout(timer)
  }, [announcement])

  const handleClick = React.useCallback(() => {
    if (disabled) return
    pressed.current = true
    onSortChange(next)
  }, [disabled, next, onSortChange])

  return {
    ariaSort,
    active,
    direction,
    next,
    announcement,
    headerProps: { scope: "col", "aria-sort": ariaSort },
    buttonProps: {
      type: "button",
      onClick: handleClick,
      ...(disabled ? { "aria-disabled": true as const } : {}),
    },
  }
}

export interface SortHeaderProps
  extends Omit<
      React.ComponentPropsWithoutRef<"th">,
      // `scope` and `aria-sort` are this component's to set. `align` is the deprecated presentational
      // HTML attribute, taken over here for the prop below — it has no business in a Tailwind table,
      // and its values are the physical "left"/"right" rather than the two ends of the column.
      "onChange" | "scope" | "aria-sort" | "align"
    >,
    SortCycleOptions {
  column: string
  sort: SortState | null
  onSortChange: (next: SortState | null) => void
  /** The visible heading. */
  children: React.ReactNode
  /** Column name used in announcements, when `children` is not plain text. */
  label?: string
  /** Right-align, for a column of numbers. Puts the indicator on the label's left. */
  align?: "start" | "end"
  /** Take presses but ignore them — while rows are loading, say. Keeps its place in the tab order. */
  disabled?: boolean
  announce?: boolean
  labels?: Partial<SortHeaderLabels>
  /** Classes for the button, which is what carries the cell's padding. */
  buttonClassName?: string
}

/** The plain-text of `children`, for announcements, or `null` if it is not plain text. */
function textOf(children: React.ReactNode): string | null {
  if (typeof children === "string") return children
  if (typeof children === "number") return String(children)
  if (Array.isArray(children)) {
    const parts = children.map(textOf)
    return parts.every((part) => part !== null) ? parts.join("") : null
  }
  return null
}

/**
 * One sortable column heading: a `<th>` with a button across it, an arrow, and the `aria-sort` the
 * table's state says it should have.
 *
 * ```tsx
 * const [sort, setSort] = React.useState<SortState | null>({ column: "created", direction: "descending" })
 * const rows = React.useMemo(
 *   () => sortRows(people, sort, (person, column) => person[column as keyof Person]),
 *   [people, sort]
 * )
 *
 * <table>
 *   <thead>
 *     <tr>
 *       <SortHeader column="name" sort={sort} onSortChange={setSort}>Name</SortHeader>
 *       <SortHeader column="created" sort={sort} onSortChange={setSort} firstDirection="descending">
 *         Created
 *       </SortHeader>
 *       <SortHeader column="size" sort={sort} onSortChange={setSort} align="end">Size</SortHeader>
 *     </tr>
 *   </thead>
 *   <tbody>{rows.map(…)}</tbody>
 * </table>
 * ```
 *
 * It is one column, on purpose: the `<table>`, the rows and where the sorting happens all stay
 * yours, so this drops into a table you already have, and works the same whether the sort is done
 * in the browser with {@link sortRows} or handed to a server that returns the next page.
 *
 * **The heading is a button, not a clickable cell.** Putting `onClick` on the `<th>` is the version
 * that gets written, and it produces a table that can be sorted with a mouse and by nobody else:
 * there is nothing to tab to, nothing that answers Enter or Space, and a screen reader announcing
 * the cell gives no hint that pressing it would do anything, because a `<th>` is not interactive
 * and saying so is not something ARIA can bolt on afterwards. A real `<button>` filling the cell
 * gets the keyboard, the focus ring and the announcement for free — and it has to fill the cell,
 * or the hit area is the width of the word while the thing that looks pressable is the column.
 *
 * **`aria-sort` goes on the cell, and on one cell.** Not on the button: `aria-sort` is defined for
 * `columnheader`, and a `role="button"` inside is a different element that does not carry it, so the
 * attribute is simply dropped — it validates, it reads as done, and it announces nothing. And
 * because the whole table's state comes in as one value, the other headers cannot be left claiming
 * a sort they no longer have.
 */
export function SortHeader({
  column,
  sort,
  onSortChange,
  children,
  label,
  align = "start",
  firstDirection = "ascending",
  clearable = true,
  disabled = false,
  announce = true,
  labels,
  className,
  buttonClassName,
  ...props
}: SortHeaderProps) {
  const header = useSortHeader({
    column,
    sort,
    onSortChange,
    label: label ?? textOf(children) ?? column,
    firstDirection,
    clearable,
    disabled,
    announce,
    labels,
  })
  const { active, direction, announcement, headerProps, buttonProps } = header

  const Indicator = direction === "ascending" ? ChevronUp : direction === "descending" ? ChevronDown : ChevronsUpDown

  const indicator = (
    <Indicator
      // Decorative: the direction is already on the cell as `aria-sort`, and reading the arrow as
      // well gives "ascending" twice in a row from one heading.
      aria-hidden="true"
      className={cn(
        "h-4 w-4 shrink-0 transition-opacity",
        // Shown even when the column is not the sorted one, and shown at rest rather than on hover.
        // The pair of arrows is the only thing saying the column can be sorted at all, and a hover
        // state does not exist on a phone — where a heading that reveals nothing and does something
        // when tapped is worse than a heading that looks plain.
        active ? "opacity-100" : "opacity-40 group-hover:opacity-70"
      )}
    />
  )

  return (
    <th
      // No padding of its own: the button carries it, so the whole cell is the hit area.
      className={cn("p-0 align-middle", className)}
      {...headerProps}
      {...props}
    >
      <button
        className={cn(
          "group flex w-full items-center gap-1.5 px-4 py-3 text-sm font-medium transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          active ? "text-foreground" : "text-muted-foreground",
          // Added rather than overridden: two `hover:text-*` classes on one element are decided by
          // their order in the stylesheet, not in this string, so a disabled heading written as an
          // override would still light up under the pointer on whichever build put it second.
          !active && !disabled && "hover:text-foreground",
          align === "end" ? "justify-end text-right" : "justify-start text-left",
          disabled && "cursor-default opacity-60",
          buttonClassName
        )}
        {...buttonProps}
      >
        {align === "end" && indicator}
        <span className="truncate">{children}</span>
        {align === "start" && indicator}
      </button>
      {/* Polite, and emptied again a moment later — see useSortHeader. A sorted table says nothing
          on its own: the rows below have been replaced, the focus has not moved, and `aria-sort`
          changing on an element is not an event any screen reader announces. */}
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </th>
  )
}
