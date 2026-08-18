"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * What a value is drawn as. The four JSON scalars and the two containers, plus the
 * JS-only values that `JSON.parse` output never holds but a live object from your own
 * app does — they are listed so that passing such an object shows `undefined` or a
 * function marker rather than silently drawing it as an empty `{}`. `circular` marks a
 * reference back to an ancestor, the one shape that would otherwise never stop
 * unfolding.
 */
type JsonKind =
  | "object"
  | "array"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "bigint"
  | "function"
  | "symbol"
  | "circular"

/**
 * One line on screen. `value` rows are the data; a `more` row is the "… 900 more"
 * footer standing in for the entries held back by `maxItemsPerNode`, and is a row of its
 * own so the keyboard can reach it and ask for the next page.
 */
type JsonRow =
  | {
      type: "value"
      /** Accessor path from the root, e.g. `$.items[0].id`. Unique — it keys the row. */
      path: string
      /** Object key or array index this row sits under; null on the root. */
      key: string | number | null
      kind: JsonKind
      value: unknown
      depth: number
      expandable: boolean
      expanded: boolean
      /** Entry count for a container; 0 for scalars. */
      size: number
      pos: number
      setsize: number
    }
  | {
      type: "more"
      path: string
      /** The container these hidden entries belong to. */
      parentPath: string
      depth: number
      hidden: number
      pos: number
      setsize: number
    }

interface JsonViewerProps {
  /** Anything `JSON.parse` can return. Parse the response body yourself and pass the value. */
  data: unknown
  /**
   * How deep the tree is open on first paint. 0 hides everything under the root row,
   * 1 (the default) shows the root's own entries, `Infinity` opens the whole document.
   */
  defaultExpandedDepth?: number
  /** Name drawn on the root row, e.g. "response". Omitted, the root shows only its type. */
  rootLabel?: string
  /**
   * Entries drawn per container before the rest are held behind a "… N more" row.
   * Guards against a 50,000-element array trying to mount 50,000 rows.
   */
  maxItemsPerNode?: number
  /** Strings longer than this are elided on screen; the full text stays in the title. */
  maxStringLength?: number
  /** Fires on click or Enter/Space with the row's accessor path and its live value. */
  onSelect?: (entry: { path: string; value: unknown }) => void
  /** Indent per level, in pixels. */
  indent?: number
  className?: string
  /** Accessible name for the tree (or wire `aria-labelledby` to a visible heading). */
  "aria-label"?: string
  "aria-labelledby"?: string
}

/** Keys that can be written as `.key`; everything else has to go in brackets. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Extend a path by one step, producing something you can paste into code.
 *
 * The quoting is not cosmetic: it is what keeps two different documents from landing on
 * the same string. `{ "a": { "b": 1 } }` yields `$.a.b` while `{ "a.b": 1 }` yields
 * `$["a.b"]`, so a path never names two rows and toggling one can never open the other.
 * Joining with dots and no quoting collapses those two cases into a single key.
 */
function jsonPath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`
}

function describeKind(value: unknown): JsonKind {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  switch (typeof value) {
    case "string":
      return "string"
    case "number":
      return "number"
    case "boolean":
      return "boolean"
    case "undefined":
      return "undefined"
    case "bigint":
      return "bigint"
    case "function":
      return "function"
    case "symbol":
      return "symbol"
    default:
      return "object"
  }
}

/**
 * The children of a container, in document order.
 *
 * Arrays are walked by index rather than with `map`, so that a sparse array — which
 * `JSON.parse` cannot produce but a live array can — yields `undefined` for its holes
 * instead of dropping them and misnumbering every entry after.
 */
function entriesOf(value: unknown, kind: JsonKind): Array<[string | number, unknown]> {
  if (kind === "array") {
    const arr = value as unknown[]
    const out: Array<[string | number, unknown]> = []
    for (let i = 0; i < arr.length; i++) out.push([i, arr[i]])
    return out
  }
  if (kind === "object") return Object.entries(value as Record<string, unknown>)
  return []
}

/**
 * Walk the document into the flat list of rows currently on screen.
 *
 * Only expanded containers are descended into, so the cost tracks what is actually
 * visible rather than the size of the document. Cycles are caught with a set of the
 * containers on the current path: a value pointing back at one of its own ancestors is
 * drawn as `[Circular]` and not followed, which is what stops a `defaultExpandedDepth`
 * of `Infinity` from running forever on an object that references itself.
 */
function flattenJson(options: {
  data: unknown
  isExpanded: (path: string, depth: number) => boolean
  limitFor: (path: string) => number
}): JsonRow[] {
  const { data, isExpanded, limitFor } = options
  const rows: JsonRow[] = []
  const ancestors = new Set<object>()

  const walk = (
    key: string | number | null,
    value: unknown,
    path: string,
    depth: number,
    pos: number,
    setsize: number
  ) => {
    const container = typeof value === "object" && value !== null
    const kind: JsonKind = container && ancestors.has(value) ? "circular" : describeKind(value)
    const entries = kind === "circular" ? [] : entriesOf(value, kind)
    // An empty object or array is a leaf: there is nothing behind the arrow, so it reads
    // as `{}` on one line instead of offering a disclosure that reveals nothing.
    const expandable = entries.length > 0
    const expanded = expandable && isExpanded(path, depth)

    rows.push({
      type: "value",
      path,
      key,
      kind,
      value,
      depth,
      expandable,
      expanded,
      size: entries.length,
      pos,
      setsize,
    })
    if (!expanded) return

    ancestors.add(value as object)
    const shown = Math.min(entries.length, limitFor(path))
    const hidden = entries.length - shown
    const childCount = shown + (hidden > 0 ? 1 : 0)
    for (let i = 0; i < shown; i++) {
      const [childKey, childValue] = entries[i]
      walk(childKey, childValue, jsonPath(path, childKey), depth + 1, i + 1, childCount)
    }
    if (hidden > 0) {
      rows.push({
        type: "more",
        // Every path `jsonPath` builds ends in an identifier or a bracket, and a key
        // holding a space is bracket-quoted, so no data row can ever be named this.
        path: `${path} more`,
        parentPath: path,
        depth: depth + 1,
        hidden,
        pos: childCount,
        setsize: childCount,
      })
    }
    ancestors.delete(value as object)
  }

  walk(null, data, "$", 0, 1, 1)
  return rows
}

/**
 * Group thousands without `toLocaleString`, whose output follows the runtime's locale.
 * On a server-rendered page that means a count can be formatted one way in Node and
 * another in the browser, which React reports as a hydration mismatch.
 */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function countLabel(kind: JsonKind, size: number): string {
  const noun = kind === "array" ? "item" : "key"
  return `${groupDigits(size)} ${noun}${size === 1 ? "" : "s"}`
}

/** How a scalar is written on its row. Containers are drawn by the component itself. */
function formatScalar(value: unknown, kind: JsonKind, maxStringLength: number): string {
  switch (kind) {
    case "string": {
      const text = value as string
      // Quote through JSON.stringify so a newline or a quote inside the string is escaped
      // rather than breaking the row apart. When the string is too long the ellipsis goes
      // inside the closing quote, so what is on screen still reads as a string.
      if (text.length <= maxStringLength) return JSON.stringify(text)
      return `${JSON.stringify(text.slice(0, maxStringLength)).slice(0, -1)}…"`
    }
    case "number":
      // String(-0) is "0", which quietly turns one JSON number into a different one.
      return Object.is(value, -0) ? "-0" : String(value)
    case "bigint":
      return `${String(value)}n`
    case "boolean":
      return String(value)
    case "null":
      return "null"
    case "undefined":
      return "undefined"
    case "function":
      return "function"
    case "symbol":
      return String(value)
    case "circular":
      return "[Circular]"
    default:
      return ""
  }
}

const SCALAR_TONE: Partial<Record<JsonKind, string>> = {
  string: "text-emerald-600 dark:text-emerald-400",
  number: "text-blue-600 dark:text-blue-400",
  bigint: "text-blue-600 dark:text-blue-400",
  boolean: "text-violet-600 dark:text-violet-400",
}

/**
 * A JSON value you can actually read: collapsible, typed and colour-coded, with big
 * collections paged instead of dumped.
 *
 * Hand it whatever `JSON.parse` gave you — an API response, a log line's payload, a
 * config file, a webhook body — and it renders the whole document. Objects and arrays
 * open and close, scalars are coloured by type, every container says how many entries it
 * holds, and an array of 40,000 elements draws the first hundred behind a "… 39,900
 * more" row rather than trying to mount all of them.
 *
 * It is the ARIA tree pattern, so the whole viewer is a single Tab stop: Up/Down walk
 * the rows actually on screen, Right opens a container and then steps into it, Left
 * closes it or jumps out to the parent, Home/End hit the ends, and Enter/Space toggle a
 * row (or ask a "… N more" row for its next page). `onSelect` hands back the row's
 * accessor path — `$.items[0].id`, ready to paste into code — together with its live
 * value, which is the hook for a copy button or a "filter to this" action.
 *
 * Open state is held as the difference from `defaultExpandedDepth` rather than as a set
 * of open paths, so replacing `data` with the next response leaves the view opened to
 * the same depth instead of collapsing to a single unreadable root row.
 */
export function JsonViewer({
  data,
  defaultExpandedDepth = 1,
  rootLabel,
  maxItemsPerNode = 100,
  maxStringLength = 120,
  onSelect,
  indent = 14,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: JsonViewerProps) {
  // Paths whose open state differs from what `defaultExpandedDepth` would give them.
  // Storing the deviation rather than the open set is what lets a new `data` prop keep
  // the reader's depth: a set of literal paths would no longer match anything in it.
  const [toggled, setToggled] = React.useState<Set<string>>(() => new Set())
  // Containers the reader has asked to see more of, and how many entries to draw.
  const [revealed, setRevealed] = React.useState<Map<string, number>>(() => new Map())
  const [focusPath, setFocusPath] = React.useState<string | null>(null)

  const rowRefs = React.useRef(new Map<string, HTMLLIElement>())

  const rows = React.useMemo(
    () =>
      flattenJson({
        data,
        isExpanded: (path, depth) => (depth < defaultExpandedDepth) !== toggled.has(path),
        limitFor: (path) => revealed.get(path) ?? maxItemsPerNode,
      }),
    [data, defaultExpandedDepth, toggled, revealed, maxItemsPerNode]
  )

  // The one row carrying tabIndex={0}. Falling back to the first row keeps the tree
  // reachable by Tab before anything has been focused, and re-resolves when the row that
  // had focus was collapsed out of existence.
  const activePath = React.useMemo(() => {
    if (focusPath && rows.some((r) => r.path === focusPath)) return focusPath
    return rows[0]?.path ?? null
  }, [rows, focusPath])

  function focusRow(path: string) {
    setFocusPath(path)
    rowRefs.current.get(path)?.focus()
  }

  function setExpanded(index: number, next: boolean) {
    const row = rows[index]
    if (row.type !== "value" || !row.expandable || row.expanded === next) return

    if (!next) {
      // Closing a container unmounts its rows. If focus is inside, take it back to the
      // row being closed, or it lands on <body> and drops the reader out of the tree.
      // Descendants are found by position rather than by path prefix, because `$.a` is a
      // prefix of the unrelated `$.ab`.
      for (let i = index + 1; i < rows.length && rows[i].depth > row.depth; i++) {
        if (rows[i].path === activePath) {
          focusRow(row.path)
          break
        }
      }
    }

    const base = row.depth < defaultExpandedDepth
    setToggled((prev) => {
      const nextSet = new Set(prev)
      if (next === base) nextSet.delete(row.path)
      else nextSet.add(row.path)
      return nextSet
    })
  }

  function revealMore(parentPath: string) {
    setRevealed((prev) => {
      const next = new Map(prev)
      next.set(parentPath, (prev.get(parentPath) ?? maxItemsPerNode) + maxItemsPerNode)
      return next
    })
  }

  /** What a click, or Enter/Space, does to a row. */
  function activate(index: number) {
    const row = rows[index]
    focusRow(row.path)
    if (row.type === "more") {
      revealMore(row.parentPath)
      return
    }
    if (row.expandable) setExpanded(index, !row.expanded)
    onSelect?.({ path: row.path, value: row.value })
  }

  function moveTo(index: number) {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))]
    if (row) focusRow(row.path)
  }

  function moveToParent(index: number) {
    const depth = rows[index].depth
    for (let i = index - 1; i >= 0; i--) {
      if (rows[i].depth < depth) {
        focusRow(rows[i].path)
        return
      }
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const index = rows.findIndex((r) => r.path === activePath)
    if (index < 0) return
    const row = rows[index]
    const open = row.type === "value" && row.expandable && row.expanded

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveTo(index + 1)
        break
      case "ArrowUp":
        event.preventDefault()
        moveTo(index - 1)
        break
      case "Home":
        event.preventDefault()
        moveTo(0)
        break
      case "End":
        event.preventDefault()
        moveTo(rows.length - 1)
        break
      case "ArrowRight":
        event.preventDefault()
        // Right opens a closed container and, on one already open, steps into it.
        if (row.type === "value" && row.expandable && !row.expanded) setExpanded(index, true)
        else moveTo(index + 1)
        break
      case "ArrowLeft":
        event.preventDefault()
        if (open) setExpanded(index, false)
        else moveToParent(index)
        break
      case "Enter":
      case " ":
        event.preventDefault()
        activate(index)
        break
      default:
    }
  }

  return (
    <ul
      role="tree"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      onKeyDown={handleKeyDown}
      className={cn("font-mono text-sm leading-relaxed", className)}
    >
      {rows.map((row, index) => (
        <li
          key={row.path}
          ref={(el) => {
            if (el) rowRefs.current.set(row.path, el)
            else rowRefs.current.delete(row.path)
          }}
          role="treeitem"
          aria-expanded={row.type === "value" && row.expandable ? row.expanded : undefined}
          aria-level={row.depth + 1}
          aria-posinset={row.pos}
          aria-setsize={row.setsize}
          tabIndex={activePath === row.path ? 0 : -1}
          onClick={() => activate(index)}
          style={{ paddingLeft: row.depth * indent + 4 }}
          className={cn(
            "flex cursor-pointer select-none items-center gap-1 rounded-sm py-0.5 pr-2",
            "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          )}
        >
          {row.type === "value" && row.expandable ? (
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                row.expanded && "rotate-90"
              )}
              aria-hidden="true"
            />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}

          {row.type === "more" ? (
            <span className="text-muted-foreground underline decoration-dotted underline-offset-2">
              … {groupDigits(row.hidden)} more
            </span>
          ) : (
            <>
              {(row.key !== null || rootLabel !== undefined) && (
                <>
                  <span className="text-foreground">
                    {row.key === null ? rootLabel : String(row.key)}
                  </span>
                  <span className="text-muted-foreground">:</span>
                </>
              )}

              {row.kind === "object" || row.kind === "array" ? (
                <>
                  <span className="text-muted-foreground">
                    {row.size === 0
                      ? row.kind === "array"
                        ? "[]"
                        : "{}"
                      : row.expanded
                        ? row.kind === "array"
                          ? "["
                          : "{"
                        : row.kind === "array"
                          ? "[ … ]"
                          : "{ … }"}
                  </span>
                  {row.size > 0 && (
                    <span className="ml-1 text-xs text-muted-foreground/70">
                      {countLabel(row.kind, row.size)}
                    </span>
                  )}
                </>
              ) : (
                <span
                  // The full string stays reachable on hover once the row elides it.
                  title={
                    row.kind === "string" && (row.value as string).length > maxStringLength
                      ? (row.value as string)
                      : undefined
                  }
                  className={cn(
                    // min-w-0 is what lets `truncate` work here: a flex child defaults to
                    // min-width:auto and refuses to shrink, so without it a long value
                    // pushes the row wider instead of ending in an ellipsis.
                    "min-w-0 truncate",
                    SCALAR_TONE[row.kind] ?? "text-muted-foreground",
                    (row.kind === "circular" || row.kind === "function") && "italic"
                  )}
                >
                  {formatScalar(row.value, row.kind, maxStringLength)}
                </span>
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
