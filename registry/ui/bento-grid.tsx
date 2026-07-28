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

const COL_SPAN = {
  1: "",
  2: "md:col-span-2",
  3: "md:col-span-3",
  4: "md:col-span-4",
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
   * How many columns the cell covers from the `md` breakpoint up. A span wider than the
   * grid at the current breakpoint is clamped by CSS Grid, so `colSpan={3}` simply fills
   * the row on a two-column tablet layout.
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
