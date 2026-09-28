"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Which element scrolls, and therefore what `top` is measured from.
 *
 * `position: sticky` is always relative to the nearest *scrollport* — the closest ancestor that
 * scrolls — and never to the window unless the window is that ancestor. Nearly every "the header
 * will not stick" report is this and nothing else, so the mode is a decision this component makes
 * out loud rather than a side effect of a class somebody happened to add.
 */
export type StickyTableMode = "page" | "container"

/** How many leading columns can be pinned. Past this the class names stop being literal — see below. */
export const MAX_STICKY_COLUMNS = 3

/**
 * The stacking order of the three kinds of pinned cell.
 *
 * A sticky cell creates its own stacking context, so these compete directly and a tie is broken by
 * document order — which puts the *body* on top, because it comes later. That is the corner bug in
 * one sentence: scroll sideways and the first column slides over the header instead of under it.
 * Exported because a table with its own layered cell (a selection checkbox, a row menu) has to pick
 * a number that lands between them rather than guessing.
 */
export const STICKY_Z = {
  /** A pinned column in `<tbody>`. Above ordinary cells, below the header. */
  column: 10,
  /** A header cell that is not in a pinned column. */
  header: 20,
  /** The corner: a header cell that is *also* in a pinned column, pinned on both axes. */
  corner: 30,
} as const

/** A CSS length from a number of pixels or a string written out. `0` is a length, not a missing value. */
export function cssLength(value: number | string | undefined | null, fallback = "0px"): string {
  if (value === undefined || value === null || value === "") return fallback
  return typeof value === "number" ? `${value}px` : value
}

/**
 * Whether this wrapper scrolls or the page does.
 *
 * Giving a height is what makes an element scroll, so a height is exactly what the choice turns on.
 */
export function resolveStickyMode(maxHeight?: number | string | null): StickyTableMode {
  return maxHeight === undefined || maxHeight === null || maxHeight === "" ? "page" : "container"
}

/**
 * Where each pinned column comes to rest, given the widths of the columns before it.
 *
 * The first is always at 0 and every one after it starts where the previous ended, which is the part
 * that cannot be written as a static class: a second pinned column needs the *measured* width of the
 * first. Pinning them all at `left: 0` is what gets written instead, and it stacks the columns on
 * top of each other the moment the table scrolls sideways — three columns in the space of one, the
 * two underneath still painting their text through.
 *
 * Widths that are not usable numbers count as zero rather than poisoning every offset after them
 * with `NaN`, which would resolve to `left: NaNpx` and drop the pinning silently.
 */
export function cumulativeOffsets(widths: readonly number[]): number[] {
  const out: number[] = []
  let sum = 0
  for (const width of widths) {
    out.push(sum)
    sum += Number.isFinite(width) && width > 0 ? width : 0
  }
  return out
}

/** The CSS custom properties the class names below read. Written here so the tree is the contract. */
export function stickyTableVars(offset: number | string | undefined, columns: number): React.CSSProperties {
  const vars: Record<string, string> = { "--sticky-table-top": cssLength(offset) }
  // Seeded at 0 so the first paint pins the columns at the left edge rather than at `left: auto`,
  // which is not pinned at all. The measured values replace these after layout.
  for (let i = 0; i < columns; i++) vars[`--sticky-table-left-${i}`] = "0px"
  return vars as React.CSSProperties
}

/**
 * What makes the header cells stick.
 *
 * Written as descendant rules on the wrapper rather than as props on a cell, so this works on the
 * `<table>` you already have — official shadcn/ui's `<Table>`, a hand-written one, one produced by a
 * data-table library — without touching a single `<th>`.
 *
 * Three of these five lines are load-bearing and each of them is a bug that ships:
 *
 * **`bg-background`.** A `<th>` has no background of its own, and a transparent sticky header does
 * not stay in front of the rows — it stays in *place* while they pass through it, so the heading and
 * whatever row is underneath are painted over each other. It looks like a rendering fault rather
 * than a missing colour, which is why it survives review.
 *
 * **The line is a pseudo-element, not a border.** Tailwind's preflight sets `border-collapse:
 * collapse` on every `<table>` — v3 and v4 both — and in the collapsed model a border belongs to the
 * table's grid rather than to the cell that declared it. The cell is what sticks; the grid is not,
 * so `border-b` on a sticky `<th>` scrolls away with the rows and leaves the header with no bottom
 * edge at all. An `::after` box belongs to the cell and travels with it.
 *
 * The obvious repair for that — switch the table to `border-separate` so the borders belong to the
 * cells — is the one thing this must not do, and it is worth being explicit about because it is what
 * the search results tell you to do. In the separated model borders on rows are *ignored*, and
 * shadcn's `TableRow` puts its `border-b` on the `<tr>`: flipping the table would silently erase
 * every divider in the body to fix one line in the header.
 *
 * **`top` is a variable.** A fixed app header covers the table header otherwise — the pinning works,
 * it just parks underneath the toolbar — and the height of that toolbar is not knowable from here.
 */
const HEADER_CELLS = [
  "[&_thead_th]:sticky [&_thead_th]:top-[var(--sticky-table-top)] [&_thead_th]:z-20",
  "[&_thead_th]:bg-background",
  "[&_thead_th]:after:absolute [&_thead_th]:after:inset-x-0 [&_thead_th]:after:bottom-0",
  "[&_thead_th]:after:h-px [&_thead_th]:after:bg-border [&_thead_th]:after:content-['']",
  "[&_thead_th]:after:pointer-events-none",
].join(" ")

/**
 * What pins the *n*th column, one literal string per index.
 *
 * A loop building `` `[&_tr>*:nth-child(${i})]:sticky` `` would be the shorter way to write this and
 * it produces nothing: Tailwind reads source files as text, so a class name that only exists once
 * the component runs is never compiled and the column is never pinned. Every one of them has to be
 * spelled out, which is also what caps this at three.
 *
 * Specificity does the rest of the work. The corner rule below is written through `thead` so it
 * scores above both of these, and the ladder in {@link STICKY_Z} lands the right way up without any
 * of the three having to know about the others.
 */
const COLUMN_CELLS: readonly string[] = [
  "[&_tr>*:nth-child(1)]:sticky [&_tr>*:nth-child(1)]:left-[var(--sticky-table-left-0)] [&_tr>*:nth-child(1)]:z-10 [&_tr>*:nth-child(1)]:bg-background",
  "[&_tr>*:nth-child(2)]:sticky [&_tr>*:nth-child(2)]:left-[var(--sticky-table-left-1)] [&_tr>*:nth-child(2)]:z-10 [&_tr>*:nth-child(2)]:bg-background",
  "[&_tr>*:nth-child(3)]:sticky [&_tr>*:nth-child(3)]:left-[var(--sticky-table-left-2)] [&_tr>*:nth-child(3)]:z-10 [&_tr>*:nth-child(3)]:bg-background",
]

/** The corner cells: pinned on both axes, and above everything else so nothing slides over them. */
const CORNER_CELLS: readonly string[] = [
  "[&_thead_tr>*:nth-child(1)]:z-30",
  "[&_thead_tr>*:nth-child(2)]:z-30",
  "[&_thead_tr>*:nth-child(3)]:z-30",
]

/** Clamps a requested column count to what there are literal class names for. */
export function resolveStickyColumns(count: number | undefined): number {
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.min(Math.floor(count as number), MAX_STICKY_COLUMNS))
}

/**
 * Whether the pinned columns need measuring at all.
 *
 * Only from the second one: the first rests at 0, which is a constant and already seeded, so a table
 * with one pinned column — most of them — never observes anything. From the second the offset is the
 * measured width of the column before it and there is no static answer.
 *
 * Named and exported rather than left as `columns < 2` inside the effect because it is the whole
 * contract of that effect, and a threshold buried in a condition is invisible to anything that
 * cannot run layout: off by one, a two-column table silently stops measuring and its second column
 * goes back to resting on top of the first.
 */
export function needsMeasurement(columns: number): boolean {
  return columns >= 2
}

/**
 * Keeps `--sticky-table-left-*` in step with the real widths of the pinned columns.
 *
 * Widths are read from the first row rather than from the header, because a `<th>` may be narrower
 * than the cells beneath it and the column's width is whatever the widest cell made it.
 */
function useStickyColumnOffsets(
  ref: React.RefObject<HTMLDivElement | null>,
  columns: number
): void {
  React.useEffect(() => {
    const root = ref.current
    if (!root || !needsMeasurement(columns)) return

    const measure = () => {
      const row = root.querySelector("tr")
      if (!row) return
      const cells = Array.from(row.children).slice(0, columns) as HTMLElement[]
      const offsets = cumulativeOffsets(cells.map((cell) => cell.getBoundingClientRect().width))
      for (let i = 0; i < offsets.length; i++) {
        root.style.setProperty(`--sticky-table-left-${i}`, `${offsets[i]}px`)
      }
    }

    measure()

    // A column's width changes without anything being added or removed: a window resize, a sidebar
    // opening, a long cell arriving from the next page of data, a font finally loading. Observing
    // the cells themselves rather than the table catches the last two, which are the ones that
    // happen after the component has stopped being looked at.
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    const row = root.querySelector("tr")
    if (row) for (const cell of Array.from(row.children).slice(0, columns)) observer.observe(cell)
    return () => observer.disconnect()
  }, [ref, columns])
}

export interface StickyTableHeaderProps extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * How far below the top of the scrollport the header rests. Defaults to `0`.
   *
   * This is where a fixed app header's height goes. Without it the table header pins correctly and
   * pins itself underneath the toolbar, so it is invisible for the whole of the scroll.
   */
  offset?: number | string
  /**
   * Makes this wrapper the scrolling element, capped at this height, instead of letting the page
   * scroll. Anything CSS accepts — `420`, `"60vh"`, `"calc(100dvh-12rem)"`.
   *
   * Prefer it. A wrapper that scrolls is a scrollport this component owns, so the header sticks
   * regardless of what the page around it does, and it is the only arrangement in which a table can
   * scroll sideways and keep a pinned header at the same time.
   */
  maxHeight?: number | string
  /** How many leading columns stay put when scrolling sideways. 0 (default) to 3. */
  stickyColumns?: number
  /** Pin the header row. Defaults to `true`; turn it off to pin only columns. */
  stickyHeader?: boolean
}

/**
 * Keeps a table's header row — and optionally its first columns — in place while the rows scroll.
 *
 * ```tsx
 * <StickyTableHeader maxHeight="60vh">
 *   <table className="w-full text-sm">
 *     <thead>
 *       <tr>
 *         <th className="px-4 py-3 text-left font-medium">Name</th>
 *         <th className="px-4 py-3 text-left font-medium">Status</th>
 *       </tr>
 *     </thead>
 *     <tbody>{rows.map(…)}</tbody>
 *   </table>
 * </StickyTableHeader>
 * ```
 *
 * Your `<table>` stays yours: this wraps it and styles its cells from the outside, so it drops onto
 * a table that already exists — with `<SortHeader>` in the cells, a checkbox column, whatever — and
 * changes no markup.
 *
 * **Which element scrolls is the whole component.** A sticky cell is pinned to its nearest scrolling
 * ancestor, so the question is never "did I write `sticky top-0`" but "what is the scrollport". Give
 * `maxHeight` and this wrapper becomes it, which is the arrangement that always works.
 *
 * Leave `maxHeight` off and the page is the scrollport — in which case nothing between this wrapper
 * and the `<table>` may scroll, and the usual reason one does is official shadcn/ui's own `<Table>`:
 * it renders `<div class="relative w-full overflow-x-auto">` around the table, and a box with
 * `overflow-x: auto` computes to `overflow-y: auto` as well, so that div is a scrollport on both
 * axes. The header then pins to a box that never scrolls vertically, which looks exactly like
 * sticky not working. Either render the bare `<table>` in page mode, or pass `maxHeight` and let
 * this wrapper do the scrolling.
 *
 * With `stickyColumns`, the corner cells are pinned on both axes and lifted above both — see
 * {@link STICKY_Z} for why that has to be said out loud.
 *
 * One header row is supported. A second row of grouping headers would need its own offset, measured
 * from the height of the first, and pinning both at the same `top` would stack them.
 *
 * To recolour the pinned cells — a header on a card rather than on the page background — pass the
 * class with `!`, as in `className="[&_thead_th]:!bg-card"`: the rules here are descendant rules and
 * outrank a plain utility on the cell itself.
 */
export function StickyTableHeader({
  offset = 0,
  maxHeight,
  stickyColumns = 0,
  stickyHeader = true,
  className,
  style,
  children,
  ...props
}: StickyTableHeaderProps) {
  const mode = resolveStickyMode(maxHeight)
  const columns = resolveStickyColumns(stickyColumns)
  const ref = React.useRef<HTMLDivElement | null>(null)
  useStickyColumnOffsets(ref, columns)

  return (
    <div
      ref={ref}
      className={cn(
        "relative",
        // Only in container mode. In page mode this must not create a scrollport of its own — that
        // would make it the very ancestor the docs above warn about, and the header would pin to a
        // box that never moves.
        mode === "container" && "overflow-auto",
        stickyHeader && HEADER_CELLS,
        COLUMN_CELLS.slice(0, columns).join(" "),
        stickyHeader && CORNER_CELLS.slice(0, columns).join(" "),
        className
      )}
      style={{
        ...stickyTableVars(offset, columns),
        ...(mode === "container" ? { maxHeight: cssLength(maxHeight) } : null),
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  )
}
