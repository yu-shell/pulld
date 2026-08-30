import * as React from "react"

import { cn } from "@/lib/utils"

type ChangeType = "equal" | "insert" | "delete"

interface Op {
  type: ChangeType
  /** 1-based line number in `before`, or 0 for an inserted line that has none. */
  a: number
  /** 1-based line number in `after`, or 0 for a deleted line that has none. */
  b: number
  text: string
}

type Row = Op | { type: "gap"; count: number }

/**
 * A diff of two texts is a diff of their lines, so how the text is cut into
 * lines decides the whole result. `\r\n` is folded into `\n` rather than kept,
 * because a file that changed line endings would otherwise report every single
 * line as rewritten — technically true and useless to look at.
 *
 * A trailing newline yields a final empty element that is an artefact of the
 * split rather than a line anyone wrote, so one of them is dropped. Two
 * trailing newlines mean there really is a blank last line, and that one stays.
 */
function splitLines(text: string): string[] {
  const source = String(text ?? "")
  // An empty text has no lines at all. Splitting it yields [""], which is a blank line that
  // nobody wrote, and the diff then reports it as removed the first time a field is filled in
  // — so an empty-to-filled change, which is most of what an admin panel shows a diff of,
  // came out as "1 line added, 1 line removed" with a phantom "Removed line:" row.
  if (source === "") return []
  const lines = source.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/**
 * The LCS table is the one part of this component that can grow without bound:
 * it holds one cell per pair of lines, so two 5,000-line files would ask for 25
 * million of them. Past this many cells the diff degrades to "everything was
 * replaced" instead of allocating hundreds of megabytes inside a render.
 *
 * A million cells is roughly a 1,000-line file against another, which covers
 * the config files, records and generated documents this is pointed at, and
 * costs 4MB in the typed array below.
 */
const MAX_CELLS = 1_000_000

/**
 * Longest common subsequence over lines, with the two cheap wins applied first:
 * a shared prefix and a shared suffix are equal by inspection, so they never
 * enter the table. This is what keeps the usual case — a large document with a
 * small edit in the middle — linear instead of quadratic.
 */
function diffLines(before: string[], after: string[]): Op[] {
  const ops: Op[] = []

  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) {
    ops.push({ type: "equal", a: start + 1, b: start + 1, text: before[start] })
    start++
  }

  let endA = before.length
  let endB = after.length
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--
    endB--
  }

  const midA = before.slice(start, endA)
  const midB = after.slice(start, endB)
  const n = midA.length
  const m = midB.length

  const tail: Op[] = []
  for (let k = endA; k < before.length; k++) {
    tail.push({ type: "equal", a: k + 1, b: k - endA + endB + 1, text: before[k] })
  }

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) {
    // One side is empty, or the table would be too large to build: report the
    // middle as wholly removed and wholly added. Still a correct diff, just a
    // coarser one than the table would have produced.
    for (let i = 0; i < n; i++) ops.push({ type: "delete", a: start + i + 1, b: 0, text: midA[i] })
    for (let j = 0; j < m; j++) ops.push({ type: "insert", a: 0, b: start + j + 1, text: midB[j] })
    return ops.concat(tail)
  }

  // dp[i][j] = length of the LCS of midA[i:] and midB[j:]. Suffix-indexed so the
  // walk below runs forward, which is the order the rows are rendered in.
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        midA[i] === midB[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (midA[i] === midB[j]) {
      ops.push({ type: "equal", a: start + i + 1, b: start + j + 1, text: midA[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      // Ties go to the deletion so that a replaced block reads as its removed
      // lines followed by its added ones, which is what the split view pairs up.
      ops.push({ type: "delete", a: start + i + 1, b: 0, text: midA[i] })
      i++
    } else {
      ops.push({ type: "insert", a: 0, b: start + j + 1, text: midB[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: "delete", a: start + i + 1, b: 0, text: midA[i] })
    i++
  }
  while (j < m) {
    ops.push({ type: "insert", a: 0, b: start + j + 1, text: midB[j] })
    j++
  }

  return ops.concat(tail)
}

/**
 * Unchanged lines far from any edit are noise, so only `context` of them either
 * side of a change survive; the rest collapse into a single counted gap.
 *
 * The neighbourhoods are marked before anything is collapsed, so two edits close
 * enough for their context to touch keep the lines between them and read as one
 * hunk. Collapsing each edit separately instead would cut a gap of "1 unchanged
 * line" into the middle of a change that a reader wants to see whole.
 */
function collapse(ops: Op[], context: number): Row[] {
  // How far each line is from the nearest change, in two passes.
  //
  // Walking a window outwards from every change instead would be quadratic when `context` is
  // large — a whole-file deletion with a generous context is exactly the shape that hurts — and
  // guarding that with "show everything if context >= line count" quietly changes the answer for
  // a text with no changes at all. Distances have neither problem, and they give `Infinity` its
  // literal meaning: with nothing changed every line is infinitely far away, which only an
  // infinite context takes in.
  const pad = Number.isFinite(context) ? Math.max(0, Math.floor(context)) : context
  const n = ops.length
  const dist = new Array<number>(n).fill(Infinity)

  let d = Infinity
  for (let i = 0; i < n; i++) {
    if (ops[i].type !== "equal") d = 0
    else if (d !== Infinity) d++
    dist[i] = d
  }
  d = Infinity
  for (let i = n - 1; i >= 0; i--) {
    if (ops[i].type !== "equal") d = 0
    else if (d !== Infinity) d++
    if (d < dist[i]) dist[i] = d
  }

  const rows: Row[] = []
  let hidden = 0
  for (let i = 0; i < n; i++) {
    if (dist[i] <= pad) {
      if (hidden > 0) {
        rows.push({ type: "gap", count: hidden })
        hidden = 0
      }
      rows.push(ops[i])
    } else {
      hidden++
    }
  }
  if (hidden > 0) rows.push({ type: "gap", count: hidden })
  return rows
}

interface Pair {
  left: Op | null
  right: Op | null
}

/**
 * Side-by-side pairing. Deletions and insertions accumulate until the run ends,
 * then line up index by index so a rewritten line sits opposite the line it
 * replaced; whichever side is shorter is padded with blanks.
 */
function pairRows(rows: Row[]): Array<Pair | { type: "gap"; count: number }> {
  const out: Array<Pair | { type: "gap"; count: number }> = []
  let dels: Op[] = []
  let inss: Op[] = []

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, inss.length); i++) {
      out.push({ left: dels[i] ?? null, right: inss[i] ?? null })
    }
    dels = []
    inss = []
  }

  for (const row of rows) {
    if (row.type === "delete") dels.push(row)
    else if (row.type === "insert") inss.push(row)
    else {
      flush()
      if (row.type === "gap") out.push(row)
      else out.push({ left: row, right: row })
    }
  }
  flush()
  return out
}

/** Colour is not the only carrier of meaning here — see the sign column below. */
const TONE: Record<ChangeType, string> = {
  equal: "",
  // shadcn/ui ships no "success" token, so an addition borrows the same emerald
  // pair used elsewhere in this registry, with an explicit dark-mode value.
  insert: "bg-emerald-500/10",
  delete: "bg-destructive/10",
}

const SIGN_TONE: Record<ChangeType, string> = {
  equal: "text-muted-foreground/50",
  insert: "text-emerald-600 dark:text-emerald-400",
  delete: "text-destructive",
}

const SIGN: Record<ChangeType, string> = { equal: " ", insert: "+", delete: "-" }

/** Spoken before the line itself, so the change is not carried by colour alone. */
const SPOKEN: Record<ChangeType, string> = {
  equal: "",
  insert: "Added line: ",
  delete: "Removed line: ",
}

interface DiffViewProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The original text. */
  before: string
  /** The changed text. */
  after: string
  /** `unified` stacks one column; `split` shows before and after side by side. */
  view?: "unified" | "split"
  /**
   * Unchanged lines to keep either side of a change. `Infinity` shows the whole
   * text. Collapsed runs are summarised, not expandable — this component holds
   * no state; pass `Infinity` when the reader needs everything.
   */
  context?: number
  /** Show the before/after line-number gutters. */
  lineNumbers?: boolean
  /** Column headers, used by the split view and the accessible summary. */
  beforeLabel?: string
  afterLabel?: string
  /** Rendered in place of the table when the two texts are identical. */
  emptyMessage?: React.ReactNode
  /** Accessible name for the table. */
  label?: string
}

/**
 * Line-level diff of two texts.
 *
 * Deliberately free of hooks and state, so it renders in a server component
 * with no client JavaScript — the common case is showing a change that was
 * already fetched on the server. The cost is that the diff recomputes on every
 * render: memoise `before`/`after` upstream if they change on a hot path.
 */
export function DiffView({
  before,
  after,
  view = "unified",
  context = 3,
  lineNumbers = true,
  beforeLabel = "Before",
  afterLabel = "After",
  emptyMessage = "No changes.",
  label = "Differences",
  className,
  ...props
}: DiffViewProps) {
  const ops = diffLines(splitLines(before), splitLines(after))
  const added = ops.reduce((n, o) => n + (o.type === "insert" ? 1 : 0), 0)
  const removed = ops.reduce((n, o) => n + (o.type === "delete" ? 1 : 0), 0)

  if (added === 0 && removed === 0) {
    return (
      <div
        className={cn(
          "rounded-md border bg-muted/30 p-4 text-center text-sm text-muted-foreground",
          className
        )}
        {...props}
      >
        {emptyMessage}
      </div>
    )
  }

  const rows = collapse(ops, context)
  const summary = `${label}: ${added} line${added === 1 ? "" : "s"} added, ${removed} line${
    removed === 1 ? "" : "s"
  } removed.`

  const gutter =
    "w-[1%] select-none whitespace-nowrap px-2 text-right align-top text-xs tabular-nums text-muted-foreground/70"
  const cell = "whitespace-pre-wrap break-words px-2 align-top"

  return (
    <div
      className={cn("overflow-hidden rounded-md border font-mono text-sm", className)}
      {...props}
    >
      <table className="w-full border-collapse">
        <caption className="sr-only">{summary}</caption>
        {view === "split" ? (
          <SplitBody
            rows={rows}
            lineNumbers={lineNumbers}
            beforeLabel={beforeLabel}
            afterLabel={afterLabel}
            gutter={gutter}
            cell={cell}
          />
        ) : (
          <UnifiedBody rows={rows} lineNumbers={lineNumbers} gutter={gutter} cell={cell} />
        )}
      </table>
    </div>
  )
}

/**
 * The collapsed-run marker. `colSpan` is deliberately generous: it only has to
 * cover the widest row the table can produce, and an over-wide span is ignored.
 */
function Gap({ count }: { count: number }) {
  return (
    <tr className="bg-muted/40 text-muted-foreground">
      <td colSpan={6} className="px-2 py-1 text-center text-xs">
        ⋯ {count} unchanged line{count === 1 ? "" : "s"}
      </td>
    </tr>
  )
}

function UnifiedBody({
  rows,
  lineNumbers,
  gutter,
  cell,
}: {
  rows: Row[]
  lineNumbers: boolean
  gutter: string
  cell: string
}) {
  return (
    <tbody>
      {rows.map((row, i) =>
        row.type === "gap" ? (
          <Gap key={`gap-${i}`} count={row.count} />
        ) : (
          <tr key={`${row.type}-${row.a}-${row.b}-${i}`} className={TONE[row.type]}>
            {lineNumbers && (
              <>
                <td className={gutter} aria-hidden="true">
                  {row.a || ""}
                </td>
                <td className={gutter} aria-hidden="true">
                  {row.b || ""}
                </td>
              </>
            )}
            <td
              className={cn("w-[1%] select-none px-1 text-center align-top", SIGN_TONE[row.type])}
              aria-hidden="true"
            >
              {SIGN[row.type]}
            </td>
            <td className={cell}>
              <span className="sr-only">{SPOKEN[row.type]}</span>
              {row.text || " "}
            </td>
          </tr>
        )
      )}
    </tbody>
  )
}

function SplitBody({
  rows,
  lineNumbers,
  beforeLabel,
  afterLabel,
  gutter,
  cell,
}: {
  rows: Row[]
  lineNumbers: boolean
  beforeLabel: string
  afterLabel: string
  gutter: string
  cell: string
}) {
  const pairs = pairRows(rows)
  return (
    <>
      <thead>
        <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
          <th scope="col" colSpan={lineNumbers ? 2 : 1} className="px-2 py-1 text-left font-medium">
            {beforeLabel}
          </th>
          <th scope="col" colSpan={lineNumbers ? 2 : 1} className="px-2 py-1 text-left font-medium">
            {afterLabel}
          </th>
        </tr>
      </thead>
      <tbody>
        {pairs.map((row, i) =>
          "type" in row && row.type === "gap" ? (
            <Gap key={`gap-${i}`} count={row.count} />
          ) : (
            <tr key={`pair-${i}`}>
              <Side op={(row as Pair).left} lineNumbers={lineNumbers} gutter={gutter} cell={cell} />
              <Side
                op={(row as Pair).right}
                lineNumbers={lineNumbers}
                gutter={gutter}
                cell={cell}
                divider
              />
            </tr>
          )
        )}
      </tbody>
    </>
  )
}

/**
 * One half of a split row. A `null` op is the padding opposite a run of a
 * different length; it is empty rather than absent so the two columns stay in
 * step, and it is hidden from assistive technology because there is no line
 * there to read.
 */
function Side({
  op,
  lineNumbers,
  gutter,
  cell,
  divider,
}: {
  op: Op | null
  lineNumbers: boolean
  gutter: string
  cell: string
  divider?: boolean
}) {
  const tone = op ? TONE[op.type] : "bg-muted/20"
  const edge = divider ? "border-l" : ""
  if (!op) {
    return (
      <td className={cn(cell, tone, edge)} colSpan={lineNumbers ? 2 : 1} aria-hidden="true">
        {" "}
      </td>
    )
  }
  return (
    <>
      {lineNumbers && (
        <td className={cn(gutter, tone, edge)} aria-hidden="true">
          {(op.type === "insert" ? op.b : op.a) || ""}
        </td>
      )}
      <td className={cn(cell, tone, !lineNumbers && edge)}>
        <span className="sr-only">{SPOKEN[op.type]}</span>
        <span className={cn("select-none pr-1", SIGN_TONE[op.type])} aria-hidden="true">
          {SIGN[op.type]}
        </span>
        {op.text || " "}
      </td>
    </>
  )
}
