import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Tailwind only emits classes it can find written out in your source, so a span can never
 * be assembled from a prop: `col-span-${n}` compiles to nothing and the cell silently
 * renders one column wide — the single reason hand-rolled bento grids look broken in
 * production but fine in dev. Every class this component can produce is therefore a
 * literal string in one of the three maps below.
 */
const GRID_COLUMNS = {
  2: "grid-cols-1 md:grid-cols-2",
  3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
} as const

/**
 * Spans step up with the grid, which is why each one lists two breakpoints. Every layout
 * above is two columns wide at `md` and only reaches three or four at `lg`, so a bare
 * `md:col-span-3` would ask for more columns than exist at that tier — and CSS Grid does
 * not clamp an over-wide span, it *adds* the missing columns to the implicit grid
 * (CSS Grid §8.5). Those extra tracks are `auto`, so the first cell that lands in one is
 * sized by its own content: measured in Chrome, a `md:col-span-3` cell in a two-column
 * grid collapsed the two real `1fr` columns from 448px to 95px and gave the phantom third
 * 403px. Capping each tier at the track count it actually has keeps the span inside the
 * explicit grid, so the cell fills the row instead of inventing a column.
 */
const COL_SPAN = {
  1: "",
  2: "md:col-span-2",
  3: "md:col-span-2 lg:col-span-3",
  4: "md:col-span-2 lg:col-span-4",
} as const

const ROW_SPAN = {
  1: "",
  2: "md:row-span-2",
  3: "md:row-span-3",
} as const

interface BentoGridProps extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * Track count at the widest breakpoint. The grid always starts at one column on
   * phones and steps up from there, so this is the ceiling, not a fixed value.
   */
  columns?: keyof typeof GRID_COLUMNS
}

/**
 * The asymmetric "bento" grid used for feature sections and marketing pages: a set of
 * panels on a shared grid where a few cells are deliberately wider or taller than the
 * rest. Wrap the cells in `BentoGridItem` and give the ones that matter a `colSpan` or
 * `rowSpan`.
 *
 * Rows are sized `minmax(11rem, auto)` so equal-height cells line up and a `rowSpan={2}`
 * cell is visibly twice as tall; override `auto-rows-*` through `className` for a denser
 * or airier rhythm.
 *
 * It is a layout only — it renders no card content of its own, so the cells can hold
 * copy, an image, a chart or a `feature-card`. No state, no effects and no `"use client"`,
 * so it renders as a server component.
 */
export function BentoGrid({ columns = 3, className, ...props }: BentoGridProps) {
  return (
    <div
      className={cn(
        "grid auto-rows-[minmax(11rem,auto)] gap-4",
        GRID_COLUMNS[columns],
        className
      )}
      {...props}
    />
  )
}

interface BentoGridItemProps extends React.ComponentPropsWithoutRef<"div"> {
  /**
   * How many columns the cell covers, at the widest breakpoint. Every layout is two
   * columns at `md`, so a cell asking for three or four spans the full row there and
   * widens to its real span at `lg`. Keep it within the grid's own `columns`: a span
   * larger than that has no tier where it fits, and CSS Grid answers an over-wide span by
   * adding columns rather than by clamping it.
   */
  colSpan?: keyof typeof COL_SPAN
  /** How many rows the cell covers from the `md` breakpoint up. */
  rowSpan?: keyof typeof ROW_SPAN
}

/**
 * One cell of a `BentoGrid`: a panel surface plus the span controls that make the layout
 * asymmetric. Below `md` every cell is full width and the spans are inert, because a
 * bento layout on a phone is just a stack.
 *
 * Spans move cells around the grid but never around the document — the grid does not use
 * `grid-auto-flow: dense`, which would let a later cell backfill an earlier gap and leave
 * a screen reader and the Tab order reading the section in a different order than the eye
 * sees it.
 *
 * The cell carries no semantics of its own: it is a `div`, not a list item, so your own
 * headings keep the outline. Wrap the grid in a `<section aria-labelledby>` to name the
 * section.
 */
export function BentoGridItem({
  colSpan = 1,
  rowSpan = 1,
  className,
  ...props
}: BentoGridItemProps) {
  return (
    <div
      className={cn(
        "flex flex-col justify-between overflow-hidden rounded-xl border bg-card p-6 text-card-foreground",
        COL_SPAN[colSpan],
        ROW_SPAN[rowSpan],
        className
      )}
      {...props}
    />
  )
}
