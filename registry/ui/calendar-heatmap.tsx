import * as React from "react"

import { cn } from "@/lib/utils"

export interface CalendarHeatmapDay {
  /** Calendar day as YYYY-MM-DD. Any other shape, and any impossible date, is ignored. */
  date: string
  /** How much happened that day. Missing, negative and non-finite values count as none. */
  count?: number
}

/** One rendered square. Passed to `formatLabel` so a caller can write its own description. */
export interface CalendarHeatmapCell {
  /** YYYY-MM-DD. */
  date: string
  /** Total for the day — duplicate rows in `data` are summed. */
  count: number
  /** 0 for a day with nothing, then 1–4 by intensity. */
  level: number
  year: number
  /** 0–11, so it indexes `monthLabels` directly. */
  month: number
  /** Day of the month, 1–31. */
  day: number
  /** 0 = Sunday, matching the default order of `weekdayLabels`. */
  weekday: number
}

interface CalendarHeatmapProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Days to plot. Sparse is fine — a day with no row is drawn as a day with nothing. */
  data: CalendarHeatmapDay[]
  /** First day to draw, YYYY-MM-DD. Defaults to 364 days before `end`, i.e. a trailing year. */
  start?: string
  /** Last day to draw, YYYY-MM-DD. Defaults to the latest date in `data`. */
  end?: string
  /** Day each column starts on: 0 = Sunday (default), 1 = Monday. */
  weekStart?: number
  /** Three ascending cut points for levels 1–4. Defaults to quartiles of the days that have any. */
  thresholds?: number[]
  /** Square size in pixels (default 11). The gap between squares scales with it. */
  cellSize?: number
  /** Noun for the accessible description, used verbatim: "12 commits on …" (default "activity"). */
  unit?: string
  /** Draw the Less–More colour key (default true). It is decorative; every square is labelled. */
  showLegend?: boolean
  /** Text of that key (default ["Less", "More"]). */
  legendLabels?: [string, string]
  /** Month names, January first. The header shows the first three characters of each. */
  monthLabels?: string[]
  /** Weekday names, Sunday first. The row headers show the first three characters of each. */
  weekdayLabels?: string[]
  /** Overrides the accessible description of a square — for other languages or plural rules. */
  formatLabel?: (cell: CalendarHeatmapCell) => string
  /** Describes the whole grid to a screen reader. */
  caption?: string
}

const MS_PER_DAY = 86400000

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

/**
 * Level 0 is `muted` rather than transparent so the grid keeps its shape on any background, and
 * 1–4 are one opacity ramp of `primary` — the intensity *is* the meaning here, so a ramp of the
 * theme's own colour says it without inventing a palette the theme has not agreed to. The hairline
 * ring keeps level 1 distinguishable from level 0 in themes where a light primary at 25% lands
 * close to muted.
 */
const LEVEL_CLASS = [
  "bg-muted",
  "bg-primary/25",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
]

/**
 * Days are held as integers — days since 1970-01-01 UTC — and never as `Date` objects, because
 * every interesting operation here (which weekday, which column, how many days between) is
 * integer arithmetic that a local-time `Date` gets wrong. `new Date("2026-08-10")` is parsed as
 * UTC midnight, so `.getDay()` west of Greenwich reports the day before and the whole grid shifts
 * by one column. Nothing below reads a local-time field, and nothing reads the clock, so the
 * server and the browser render identical markup.
 */
function toEpochDay(iso: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso))
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const ms = Date.UTC(year, month - 1, day)
  const back = new Date(ms)
  // Date.UTC rolls nonsense forward — Feb 30 becomes March 2, and a two-digit year becomes 19xx.
  // Comparing the round trip is what turns those back into "not a date" instead of a silent shift.
  // Year and month settle it between them: with the day pinned to two digits by the pattern above,
  // an out-of-range day always rolls into a different month (0 goes back a month, 32+ goes on to
  // the next), so a third comparison against getUTCDate can never decide a case these two do not.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return null
  return Math.floor(ms / MS_PER_DAY)
}

function fromEpochDay(epochDay: number) {
  const d = new Date(epochDay * MS_PER_DAY)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
  }
}

const pad = (n: number, width: number) => String(n).padStart(width, "0")

function toIso(epochDay: number) {
  const { year, month, day } = fromEpochDay(epochDay)
  return `${pad(year, 4)}-${pad(month + 1, 2)}-${pad(day, 2)}`
}

/** 1970-01-01 was a Thursday, so +4 rotates the epoch onto a Sunday-indexed week. */
const weekdayOf = (epochDay: number) => (((epochDay + 4) % 7) + 7) % 7

/** How far into its column a day sits, once the column is allowed to start on any weekday. */
const rowOf = (epochDay: number, weekStart: number) =>
  (((weekdayOf(epochDay) - weekStart) % 7) + 7) % 7

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0

/**
 * Quartiles by nearest rank over the days that have anything, which is what keeps a single busy
 * day from flattening the rest: scaling linearly against the maximum puts everything below a
 * one-off spike into level 1. Ties collapse the cut points on purpose — a month where every day
 * is a 1 is one flat colour rather than a gradient invented out of nothing.
 */
function quartiles(counts: number[]) {
  const sorted = [...counts].sort((a, b) => a - b)
  const n = sorted.length
  if (!n) return []
  return [1, 2, 3].map((k) => sorted[Math.min(n - 1, Math.ceil((k * n) / 4) - 1)])
}

const levelOf = (count: number, thresholds: number[]) =>
  count > 0 ? 1 + thresholds.filter((t) => count > t).length : 0

/** Runs of columns belonging to the same month, which is what the header spans. */
function monthRuns(columnStarts: number[], firstDay: number) {
  const runs: { month: number; span: number }[] = []
  for (const columnStart of columnStarts) {
    // Label a column by the month its first *in-range* day falls in. Using the column's own start
    // would label the leading column by the previous month whenever the range opens mid-week.
    const { month } = fromEpochDay(Math.max(columnStart, firstDay))
    const last = runs[runs.length - 1]
    if (last && last.month === month) last.span += 1
    else runs.push({ month, span: 1 })
  }
  return runs
}

export const CalendarHeatmap = React.forwardRef<
  HTMLDivElement,
  CalendarHeatmapProps
>(function CalendarHeatmap(
  {
    className,
    data,
    start,
    end,
    weekStart = 0,
    thresholds,
    cellSize = 11,
    unit = "activity",
    showLegend = true,
    legendLabels = ["Less", "More"],
    monthLabels = MONTHS,
    weekdayLabels = WEEKDAYS,
    formatLabel,
    caption = "Activity by day",
    ...props
  },
  ref
) {
  // `data` arrives from a JS call site where the prop types no longer hold, so every row is
  // re-checked rather than trusted. Duplicates are summed: two rows for one day is what a caller
  // gets from grouping by hour, or from concatenating two sources, and dropping one of them would
  // silently under-report.
  const totals = new Map<number, number>()
  for (const row of Array.isArray(data) ? data : []) {
    const epochDay = row ? toEpochDay(row.date) : null
    if (epochDay === null) continue
    const count = isCount(row.count) ? row.count : 0
    totals.set(epochDay, (totals.get(epochDay) ?? 0) + count)
  }

  const explicitEnd = end === undefined ? null : toEpochDay(end)
  // Folded rather than spread into Math.max: `Math.max(...keys)` passes one argument per day, and
  // a caller plotting several years of per-hour rows would hand it enough of them to overflow the
  // call stack — a crash on the size of the input, not on anything wrong with it.
  let latest: number | null = null
  for (const epochDay of totals.keys()) {
    if (latest === null || epochDay > latest) latest = epochDay
  }
  const lastDay = explicitEnd ?? latest
  const explicitStart = start === undefined ? null : toEpochDay(start)
  // 364 days before the end is 52 whole weeks, so the default window is the 53 columns a trailing
  // year needs. The window is anchored to the data rather than to the clock: reading `Date.now()`
  // would make the same props render differently on the server and in the browser across midnight.
  const firstDay = explicitStart ?? (lastDay === null ? null : lastDay - 364)

  if (firstDay === null || lastDay === null) return null
  // A reversed range is a caller mistake with an obvious intent, so it is read the way round it
  // was meant rather than rendered as nothing.
  const from = Math.min(firstDay, lastDay)
  const to = Math.max(firstDay, lastDay)

  // Any weekday index is meaningful once folded into 0–6, so a 7 or a -1 is honoured rather than
  // rejected; a NaN has no meaning to fold, and left alone it would poison every column start and
  // silently render seven empty rows.
  const rowStart = Number.isFinite(weekStart)
    ? ((Math.trunc(weekStart) % 7) + 7) % 7
    : 0

  const inRange: number[] = []
  for (const [epochDay, count] of totals) {
    if (epochDay >= from && epochDay <= to && count > 0) inRange.push(count)
  }
  const cuts = (
    Array.isArray(thresholds)
      ? thresholds.filter(
          (t): t is number => typeof t === "number" && Number.isFinite(t)
        )
      : quartiles(inRange)
  )
    .slice(0, 3)
    .sort((a, b) => a - b)

  const columnStarts: number[] = []
  for (
    let columnStart = from - rowOf(from, rowStart);
    columnStart <= to;
    columnStart += 7
  ) {
    columnStarts.push(columnStart)
  }

  const cellFor = (epochDay: number): CalendarHeatmapCell => {
    const count = totals.get(epochDay) ?? 0
    const { year, month, day } = fromEpochDay(epochDay)
    return {
      date: toIso(epochDay),
      count,
      level: levelOf(count, cuts),
      year,
      month,
      day,
      weekday: weekdayOf(epochDay),
    }
  }

  const describe = (cell: CalendarHeatmapCell) => {
    if (formatLabel) return formatLabel(cell)
    const month = monthLabels[cell.month] ?? MONTHS[cell.month]
    const weekday = weekdayLabels[cell.weekday] ?? WEEKDAYS[cell.weekday]
    const when = `${weekday}, ${month} ${cell.day}, ${cell.year}`
    return cell.count === 0
      ? `No ${unit} on ${when}`
      : `${cell.count} ${unit} on ${when}`
  }

  // The gap has to grow with the squares or a large heatmap reads as one solid block. A quarter of
  // the square, floored at 2px, keeps the proportion the small default already has.
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 11
  const gap = Math.max(2, Math.round(size / 4))
  const swatch = { width: `${size}px`, height: `${size}px` }
  const runs = monthRuns(columnStarts, from)

  return (
    <div
      ref={ref}
      className={cn("inline-flex flex-col gap-2 text-muted-foreground", className)}
      {...props}
    >
      {/* A region that scrolls has to be reachable by keyboard, or a year of data is simply
          unavailable to anyone not using a mouse — which is why this carries tabIndex and a
          focus ring rather than being a bare overflow container. */}
      <div
        tabIndex={0}
        role="group"
        aria-label={caption}
        className="max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <table
          className="border-separate text-[10px] leading-none"
          style={{ borderSpacing: `${gap}px` }}
        >
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {/* Sits above the weekday column; there is nothing to say about it. */}
              <th className="sr-only" scope="col">
                {weekdayLabels[rowStart] ?? WEEKDAYS[rowStart]}
              </th>
              {runs.map((run, i) => {
                const label = monthLabels[run.month] ?? MONTHS[run.month]
                return (
                  <th
                    key={`${run.month}-${i}`}
                    scope="col"
                    colSpan={run.span}
                    className="p-0 text-left font-normal"
                  >
                    {/* A one- or two-column run has no room for the name and would collide with
                        its neighbour, so it is dropped from the picture but kept for the reader. */}
                    <span className={run.span >= 3 ? undefined : "sr-only"}>
                      {label.slice(0, 3)}
                    </span>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5, 6].map((row) => {
              const weekday = (rowStart + row) % 7
              const name = weekdayLabels[weekday] ?? WEEKDAYS[weekday]
              return (
                <tr key={row}>
                  <th
                    scope="row"
                    className="p-0 pr-1 text-right align-middle font-normal"
                  >
                    {/* Every other row is named in the picture — seven stacked labels at this
                        size is illegible — but all seven name their row to a screen reader. */}
                    <span className={row % 2 === 1 ? undefined : "sr-only"}>
                      {name.slice(0, 3)}
                    </span>
                  </th>
                  {columnStarts.map((columnStart) => {
                    const epochDay = columnStart + row
                    if (epochDay < from || epochDay > to) {
                      // Padding at the two ends of the range: a day that is not in the window is
                      // not a day with nothing, and must not be drawn or announced as one.
                      return <td key={columnStart} className="p-0" />
                    }
                    const cell = cellFor(epochDay)
                    const label = describe(cell)
                    return (
                      <td key={columnStart} className="p-0">
                        <span className="sr-only">{label}</span>
                        <span
                          aria-hidden="true"
                          title={label}
                          style={swatch}
                          className={cn(
                            "block rounded-[2px] ring-1 ring-inset ring-foreground/5",
                            LEVEL_CLASS[cell.level]
                          )}
                        />
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {showLegend ? (
        // Hidden from assistive technology in full: it explains a colour ramp, and the counts it
        // stands for are already on every square. Announcing five unlabelled swatches after 365
        // labelled ones is noise, not information.
        <div
          aria-hidden="true"
          className="flex items-center gap-1 self-end text-[11px]"
        >
          <span>{legendLabels[0]}</span>
          {LEVEL_CLASS.map((tone, level) => (
            <span
              key={level}
              style={swatch}
              className={cn(
                "block rounded-[2px] ring-1 ring-inset ring-foreground/5",
                tone
              )}
            />
          ))}
          <span>{legendLabels[1]}</span>
        </div>
      ) : null}
    </div>
  )
})
CalendarHeatmap.displayName = "CalendarHeatmap"
