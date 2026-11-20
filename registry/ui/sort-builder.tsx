"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"

/* ---------------------------------------------------------------- the model

   A sort is an *ordered list* of keys, and the order is the whole meaning: "status, then newest
   first" and "newest first, then status" are different reports. That is why this is a list with
   move-up/move-down rather than a set of toggles, and why the list — not a comparator, not a
   sorted array — is what the component holds and what a caller saves.
*/

export type SortDirection = "asc" | "desc"

/**
 * Where the rows with no value for a key go.
 *
 * Held separately from `direction` and deliberately *not* flipped by it. SQL engines disagree
 * about this (PostgreSQL treats null as the largest value, so ascending puts blanks last and
 * descending puts them first; MySQL treats it as the smallest and does the opposite), which means
 * a person who reverses a sort watches every empty row jump from one end to the other. Reversing
 * "oldest first" into "newest first" is a statement about the rows that have a date; it is not a
 * request to move the ones that do not.
 */
export type SortNulls = "first" | "last"

/**
 * What kind of value a key holds, which decides how two of them are compared.
 *
 * Short on purpose, like `filter-builder`'s `FilterFieldKind`: the only question a comparison asks
 * is which of the four comparisons to run, and `varchar` / `text` / `uuid` all answer "text".
 */
export type SortValueKind = "text" | "number" | "date" | "boolean"

export interface SortField<Row = Record<string, unknown>> {
  /** Sent to the server, written into the URL. Stable; not shown to anyone. */
  name: string
  /** Shown in the key menu. Falls back to `name`. */
  label?: string
  /** Defaults to `"text"`, the kind with the fewest assumptions baked in. */
  kind?: SortValueKind
  /** Where this key's blanks go when a term does not say. Defaults to `"last"`. */
  nulls?: SortNulls
  /**
   * Text only: compare embedded digit runs as numbers, so `item9` precedes `item10`.
   *
   * Off by default because it is not free of surprises — it also makes `1.5` precede `1.10`, which
   * is right for version strings and wrong for decimals written as text.
   */
  numeric?: boolean
  /**
   * Pulls the comparable value out of a row. Defaults to reading `row[name]`.
   *
   * Worth setting whenever the thing shown and the thing compared differ: a column rendering
   * `user.displayName` sorts on a nested value that `row["user"]` cannot reach, and a column
   * showing "3 days ago" has to sort on the timestamp rather than on that sentence.
   */
  accessor?: (row: Row) => unknown
}

export interface SortTerm {
  id: string
  /** A `SortField["name"]`, or `""` for a row whose key has not been chosen yet. */
  field: string
  direction: SortDirection
  /** Overrides the field's own `nulls`. `undefined` means "whatever the field says". */
  nulls?: SortNulls
}

let idCounter = 0

/**
 * Mints a term id.
 *
 * Exactly the reason `filter-builder` has one: keying a row by its index makes the row below move
 * up into the state of the row that was removed, and in a list whose order *is* the meaning, that
 * shows a direction against a key nobody chose. Module-level so two builders cannot collide.
 */
export function createSortId(): string {
  idCounter += 1
  return `sb-${idCounter}`
}

export function sortFieldKind<Row>(field: SortField<Row> | undefined): SortValueKind {
  return field?.kind ?? "text"
}

export function sortFieldLabel<Row>(field: SortField<Row> | undefined): string {
  if (!field) return ""
  return field.label ?? field.name
}

export function findSortField<Row>(
  fields: readonly SortField<Row>[],
  name: string
): SortField<Row> | undefined {
  return fields.find((candidate) => candidate.name === name)
}

/** The direction a key starts at: the one a person means when they first reach for it. */
export function defaultDirection(kind: SortValueKind): SortDirection {
  // Dates descend. "Sort by created" means the newest, every time — a list of records opened at
  // the oldest row is the one case where the obvious default is the opposite of ascending.
  return kind === "date" ? "desc" : "asc"
}

export function effectiveNulls<Row>(
  term: SortTerm,
  field: SortField<Row> | undefined
): SortNulls {
  return term.nulls ?? field?.nulls ?? "last"
}

export function createSortTerm<Row>(
  field: SortField<Row> | undefined,
  generateId: () => string = createSortId
): SortTerm {
  return {
    id: generateId(),
    field: field?.name ?? "",
    direction: defaultDirection(sortFieldKind(field)),
  }
}

/* --------------------------------------------------- one key, at most one term

   The invariant that gives the component its shape. A second term on a key already in the list
   can never change the order — by the time it is consulted, every pair it could have separated
   has already been separated by the earlier one — so it is not a refinement, it is a row that
   looks like it does something and does nothing.
*/

/** The fields a term may choose: the unused ones, plus the one it already holds. */
export function availableSortFields<Row>(
  fields: readonly SortField<Row>[],
  terms: readonly SortTerm[],
  exceptId?: string
): SortField<Row>[] {
  const taken = new Set(
    terms.filter((term) => term.id !== exceptId && term.field !== "").map((term) => term.field)
  )
  return fields.filter((field) => !taken.has(field.name))
}

export function canAddSortTerm<Row>(
  fields: readonly SortField<Row>[],
  terms: readonly SortTerm[],
  maxTerms?: number
): boolean {
  if (maxTerms !== undefined && terms.length >= maxTerms) return false
  return availableSortFields(fields, terms).length > 0
}

/**
 * Drops repeats of a key, keeping the first.
 *
 * The editor cannot produce one; a URL can — hand-edited, concatenated by something, carried over
 * from a version of the fields where the duplicate was two different keys. The first occurrence is
 * kept because it is the one that decides the order.
 */
export function dedupeSortTerms(terms: readonly SortTerm[]): SortTerm[] {
  const seen = new Set<string>()
  const kept: SortTerm[] = []
  for (const term of terms) {
    if (term.field !== "" && seen.has(term.field)) continue
    if (term.field !== "") seen.add(term.field)
    kept.push(term)
  }
  return kept
}

export function moveSortTerm(terms: readonly SortTerm[], from: number, to: number): SortTerm[] {
  if (from === to || from < 0 || to < 0 || from >= terms.length || to >= terms.length) {
    return [...terms]
  }
  const next = [...terms]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/* ------------------------------------------------------------- reading values */

function readProperty(row: unknown, name: string): unknown {
  if (row === null || typeof row !== "object") return undefined
  return (row as Record<string, unknown>)[name]
}

export function readSortValue<Row>(row: Row, field: SortField<Row>): unknown {
  return field.accessor ? field.accessor(row) : readProperty(row, field.name)
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "string") {
    const trimmed = value.trim()
    // `Number("")` is 0, which would file every blank cell under zero.
    return trimmed === "" ? Number.NaN : Number(trimmed)
  }
  return Number.NaN
}

function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === "number") return value
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed === "" ? Number.NaN : Date.parse(trimmed)
  }
  return Number.NaN
}

/**
 * Whether a value is simply absent.
 *
 * An empty string counts. A blank cell and a missing field are the same thing to the person
 * reading the table, and filing one under "" while the other goes to the end splits the blanks
 * into two groups for a reason nobody can see.
 */
export function isMissingValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "number") return Number.isNaN(value)
  if (typeof value === "string") return value.trim() === ""
  if (value instanceof Date) return Number.isNaN(value.getTime())
  return false
}

/**
 * Whether a value is absent *for this kind of comparison*.
 *
 * The kind-aware half exists to close a hole that is silent rather than loud. A comparator that
 * returns `NaN` does not throw and does not sort: `[3, 1, 2].sort(() => NaN)` answers `[3, 1, 2]`
 * — measured — so one unparseable date in a column leaves the whole table in the order it arrived,
 * with no error anywhere and the sort control showing a direction. Classifying "not a date" as
 * absent, here, is what keeps `compareSortValues` from ever being handed a value it can only
 * answer `NaN` about.
 */
export function isMissingForKind(value: unknown, kind: SortValueKind): boolean {
  if (isMissingValue(value)) return true
  switch (kind) {
    case "number":
      return Number.isNaN(toNumber(value))
    case "date":
      return Number.isNaN(toTime(value))
    default:
      return false
  }
}

/* ----------------------------------------------------------- comparing values */

export type SortSensitivity = "base" | "accent" | "case" | "variant"

export interface SortCompareOptions {
  /** Passed to `Intl.Collator`. `undefined` uses the runtime's default locale. */
  locale?: string
  /** Defaults to `"variant"`, the collator's own default: accents and case both count. */
  sensitivity?: SortSensitivity
}

const collators = new Map<string, Intl.Collator>()

/**
 * A collator per distinct configuration, built once.
 *
 * Not the usual "constructing one is expensive" advice, which measured the other way round here:
 * with no options at all, `a.localeCompare(b)` sorted 2,000 strings twenty times in 5.8ms against
 * a cached collator's 15.1ms. The reason to hold one is what happens as soon as options are
 * involved, which for this component is always — `a.localeCompare(b, locale, options)` re-resolves
 * the collator on every single comparison and took **671.7ms** for the same work, 14.9x the cached
 * collator's 45.1ms, in the same range as constructing a fresh `Intl.Collator` per comparison
 * (641.1ms). All four figures are medians of ten interleaved runs on node v26.
 */
export function collatorFor(
  locale: string | undefined,
  numeric: boolean,
  sensitivity: SortSensitivity
): Intl.Collator {
  const key = `${locale ?? ""}|${numeric}|${sensitivity}`
  const found = collators.get(key)
  if (found) return found
  const made = new Intl.Collator(locale, { numeric, sensitivity })
  collators.set(key, made)
  return made
}

/**
 * Compares two values of one kind, ascending. Never returns `NaN`.
 *
 * Callers must have ruled out `isMissingForKind` on both sides first; `sortComparator` does.
 */
export function compareSortValues(
  a: unknown,
  b: unknown,
  kind: SortValueKind,
  options: SortCompareOptions & { numeric?: boolean } = {}
): number {
  switch (kind) {
    case "number":
      return numberOrder(toNumber(a), toNumber(b))
    case "date":
      return numberOrder(toTime(a), toTime(b))
    case "boolean":
      // false before true, the order the two words are in.
      return numberOrder(booleanRank(a), booleanRank(b))
    default: {
      // Text goes through a collator, never through `<`. Measured with plain `<`:
      // ["Banana","Zebra","apple","Ähre","Öl","ångström"] — every lowercase word after every
      // uppercase one, and every accented word after both, because that is codepoint order and
      // not an alphabet. The same six through `Intl.Collator("en")`:
      // ["Ähre","ångström","apple","Banana","Öl","Zebra"].
      const collator = collatorFor(
        options.locale,
        options.numeric ?? false,
        options.sensitivity ?? "variant"
      )
      return collator.compare(String(a), String(b))
    }
  }
}

/**
 * Which side of a boolean key a value falls on.
 *
 * `value === true` would be the whole function if rows came from the same place the type did. A
 * boolean over the wire is a `1`, a `0`, `"true"` or `"false"` as often as it is a boolean, and
 * ranking all four of those as "not true" would answer 0 for every pair — a column that silently
 * does not sort, which is the failure this file spends `isMissingForKind` avoiding elsewhere.
 */
function booleanRank(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return value === 0 ? 0 : 1
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase()
    if (lowered === "false" || lowered === "0") return 0
    if (lowered === "true" || lowered === "1") return 1
  }
  return value ? 1 : 0
}

function numberOrder(a: number, b: number): number {
  // Written as comparisons rather than `a - b`: subtraction answers `NaN` for `Infinity - Infinity`,
  // and a `NaN` from a comparator is the silent no-op described on `isMissingForKind`.
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/** Compares two values of unknown kind — used for the tie-break, which has no declared field. */
function compareUnknown(a: unknown, b: unknown, options: SortCompareOptions): number {
  const aMissing = isMissingValue(a)
  const bMissing = isMissingValue(b)
  if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1
  if (typeof a === "number" && typeof b === "number") return numberOrder(a, b)
  return compareSortValues(a, b, "text", { ...options, numeric: true })
}

/* --------------------------------------------------------------- the comparator */

export interface SortRunOptions<Row> extends SortCompareOptions {
  /**
   * The last key, always ascending, applied after every term: a row id, a slug, anything unique.
   *
   * This is not about `Array.prototype.sort` being unstable. It is stable, and required to be
   * since ES2019 — measured on node v26: twelve rows sorted by `i % 3` keep their input order
   * inside each group. The problem is what that guarantee is a guarantee *about*. Stability
   * preserves the order the array arrived in, and the order an array of rows arrives in is not a
   * property of the rows: two fetches of the same three equal-ranked records, `[3,1,2]` and
   * `[1,2,3]`, sorted with the same comparator, measured as `[3,1,2]` and `[1,2,3]` — a list that
   * reshuffles itself on refresh while the sort control says nothing changed. Without a tie-break
   * the view is only as deterministic as whatever produced the input.
   */
  tieBreak?: string | ((row: Row) => unknown)
}

/**
 * The comparator for a list of terms.
 *
 * Terms naming a field that no longer exists are skipped rather than guessed at — see
 * `buildSortQuery`, which reports them — because a URL outliving a column should drop that key,
 * not reorder the table by a value it cannot read.
 */
export function sortComparator<Row>(
  terms: readonly SortTerm[],
  fields: readonly SortField<Row>[],
  options: SortRunOptions<Row> = {}
): (a: Row, b: Row) => number {
  const compiled = terms
    .map((term) => {
      const field = term.field === "" ? undefined : findSortField(fields, term.field)
      if (!field) return null
      return {
        field,
        kind: sortFieldKind(field),
        sign: term.direction === "desc" ? -1 : 1,
        missingSign: effectiveNulls(term, field) === "first" ? -1 : 1,
        numeric: field.numeric ?? false,
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  const tieBreak = options.tieBreak
  const readTieBreak =
    typeof tieBreak === "function"
      ? tieBreak
      : typeof tieBreak === "string"
        ? (row: Row) => readProperty(row, tieBreak)
        : null

  return (a: Row, b: Row) => {
    for (const entry of compiled) {
      const left = readSortValue(a, entry.field)
      const right = readSortValue(b, entry.field)
      const leftMissing = isMissingForKind(left, entry.kind)
      const rightMissing = isMissingForKind(right, entry.kind)
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) continue
        // Not multiplied by `sign`. Reversing the direction reverses the rows that have a value;
        // it does not move the ones that do not. See `SortNulls`.
        return leftMissing ? entry.missingSign : -entry.missingSign
      }
      const order = compareSortValues(left, right, entry.kind, {
        locale: options.locale,
        sensitivity: options.sensitivity,
        numeric: entry.numeric,
      })
      if (order !== 0) return order * entry.sign
    }
    if (readTieBreak) {
      const order = compareUnknown(readTieBreak(a), readTieBreak(b), options)
      if (order !== 0) return order
    }
    return 0
  }
}

/** Sorts a copy. The input is never touched: it is usually props or a fetch result. */
export function sortRows<Row>(
  rows: readonly Row[],
  terms: readonly SortTerm[],
  fields: readonly SortField<Row>[],
  options: SortRunOptions<Row> = {}
): Row[] {
  return [...rows].sort(sortComparator(terms, fields, options))
}

/* --------------------------------------------------------- output: server JSON */

export interface SortQueryTerm {
  field: string
  direction: SortDirection
  /** Resolved, never `undefined`: a server cannot look up the field's default. */
  nulls: SortNulls
}

export type SortTermIssue = "no_field" | "unknown_field" | "duplicate_field"

export interface SortDropped {
  id: string
  field: string
  issue: SortTermIssue
}

/**
 * The order to send, and every term left out of it.
 *
 * The second half for the same reason `filter-builder` returns its dropped rows: a builder that
 * quietly skips what it cannot use produces a list whose order does not match the editor above it,
 * and that reads as the sort being broken rather than as a row nobody finished.
 *
 * `null` means there is nothing to sort by, which is not the same as an empty result — a caller
 * handed `null` should fall back to its own default order.
 */
export function buildSortQuery<Row>(
  terms: readonly SortTerm[],
  fields: readonly SortField<Row>[]
): { query: SortQueryTerm[] | null; dropped: SortDropped[] } {
  const dropped: SortDropped[] = []
  const query: SortQueryTerm[] = []
  const seen = new Set<string>()
  for (const term of terms) {
    if (term.field === "") {
      dropped.push({ id: term.id, field: "", issue: "no_field" })
      continue
    }
    const field = findSortField(fields, term.field)
    if (!field) {
      dropped.push({ id: term.id, field: term.field, issue: "unknown_field" })
      continue
    }
    if (seen.has(term.field)) {
      dropped.push({ id: term.id, field: term.field, issue: "duplicate_field" })
      continue
    }
    seen.add(term.field)
    query.push({
      field: term.field,
      direction: term.direction,
      nulls: effectiveNulls(term, field),
    })
  }
  return { query: query.length > 0 ? query : null, dropped }
}

/* ---------------------------------------------------------- output: URL string

   `?sort=-created,name` — a leading `-` for descending, comma between keys, in priority order.
   The form JSON:API specifies, which is the point: it is the one encoding of a sort that servers
   already read, so the shared link, the bookmark and the bug report all carry something the
   backend can act on rather than a blob it has to be taught.

   Two characters are structural and both can occur in a key, so they are escaped rather than
   trusted — a field literally named `a,b`, or one starting with `-`, round-trips.

   What this form cannot carry is the nulls position, and that is a deliberate loss rather than an
   oversight: a suffix for it would be read by no server on earth, and inventing one would turn the
   one widely-understood sort encoding into a private one. `buildSortQuery` is the lossless output;
   a term parsed back from a URL falls back to its field's own `nulls`.
*/

export function escapeSortSegment(text: string): string {
  return text.replace(/[\\,]/g, (match) => `\\${match}`).replace(/^-/, "\\-")
}

export function toSortParam(terms: readonly SortTerm[]): string {
  return terms
    .filter((term) => term.field !== "")
    .map((term) => `${term.direction === "desc" ? "-" : ""}${escapeSortSegment(term.field)}`)
    .join(",")
}

/**
 * Reads what `toSortParam` wrote, with fresh ids.
 *
 * `null` for anything it cannot read, rather than the half it could. A URL is the one input here
 * that arrives from outside, and half an order applied silently is worse than an order that did
 * not load: the rows are in *some* sequence either way, and only one of the two tells the person
 * that what they shared is not what they are looking at.
 */
export function parseSortParam(
  text: string,
  generateId: () => string = createSortId
): SortTerm[] | null {
  if (text === "") return []
  const terms: SortTerm[] = []
  let field = ""
  let direction: SortDirection = "asc"
  let atSegmentStart = true
  let i = 0

  const endSegment = (): boolean => {
    if (field === "") return false
    terms.push({ id: generateId(), field, direction })
    field = ""
    direction = "asc"
    atSegmentStart = true
    return true
  }

  while (i < text.length) {
    const char = text[i]
    if (char === "\\") {
      // A trailing backslash escapes nothing, which means the string was cut short.
      if (i + 1 >= text.length) return null
      field += text[i + 1]
      atSegmentStart = false
      i += 2
      continue
    }
    if (char === ",") {
      if (!endSegment()) return null
      i += 1
      continue
    }
    if (char === "-" && atSegmentStart) {
      direction = "desc"
      atSegmentStart = false
      i += 1
      continue
    }
    field += char
    atSegmentStart = false
    i += 1
  }
  if (!endSegment()) return null
  return terms
}

/* ------------------------------------------------------------ output: a sentence */

/** The words for a direction, which depend on what is being ordered. */
export function directionLabel(kind: SortValueKind, direction: SortDirection): string {
  switch (kind) {
    case "number":
      return direction === "asc" ? "smallest first" : "largest first"
    case "date":
      return direction === "asc" ? "oldest first" : "newest first"
    case "boolean":
      return direction === "asc" ? "no first" : "yes first"
    default:
      return direction === "asc" ? "A → Z" : "Z → A"
  }
}

/**
 * The order in words, for a live region, a summary line or a chip.
 *
 * Built from the same terms the editor draws, so it cannot drift from them, and it uses the field
 * labels — which is what makes "Status A → Z, then Created newest first" read as a sentence rather
 * than as `status asc, created desc`.
 */
export function describeSort<Row>(
  terms: readonly SortTerm[],
  fields: readonly SortField<Row>[],
  labels: Pick<SortBuilderLabels, "empty" | "then" | "blanksFirst" | "blanksLast"> = {
    empty: defaultSortBuilderLabels.empty,
    then: defaultSortBuilderLabels.then,
    blanksFirst: defaultSortBuilderLabels.blanksFirst,
    blanksLast: defaultSortBuilderLabels.blanksLast,
  },
  options: { nulls?: boolean } = {}
): string {
  const parts: string[] = []
  for (const term of terms) {
    if (term.field === "") continue
    const field = findSortField(fields, term.field)
    if (!field) continue
    const kind = sortFieldKind(field)
    let part = `${sortFieldLabel(field)} ${directionLabel(kind, term.direction)}`
    if (options.nulls) {
      const nulls = effectiveNulls(term, field)
      part += ` (${nulls === "first" ? labels.blanksFirst : labels.blanksLast})`
    }
    parts.push(part)
  }
  if (parts.length === 0) return labels.empty
  return parts.join(`, ${labels.then} `)
}

/* ----------------------------------------------------------------- the editor */

export interface SortBuilderLabels {
  sortBy: string
  then: string
  addSort: string
  allKeysUsed: string
  empty: string
  blanksFirst: string
  blanksLast: string
  chooseKey: string
  key: (position: number) => string
  direction: (position: number) => string
  nulls: (position: number) => string
  moveUp: (position: number) => string
  moveDown: (position: number) => string
  remove: (position: number) => string
  added: (position: number) => string
  removed: (position: number, left: number) => string
  moved: (field: string, position: number, total: number) => string
}

export const defaultSortBuilderLabels: SortBuilderLabels = {
  sortBy: "Sort by",
  then: "then",
  addSort: "Add sort",
  allKeysUsed: "Every key is already in the list.",
  empty: "No sort order yet.",
  blanksFirst: "blanks first",
  blanksLast: "blanks last",
  chooseKey: "Choose a key",
  key: (position) => `Sort key ${position}`,
  direction: (position) => `Direction for sort key ${position}`,
  nulls: (position) => `Where blanks go for sort key ${position}`,
  moveUp: (position) => `Move sort key ${position} earlier`,
  moveDown: (position) => `Move sort key ${position} later`,
  remove: (position) => `Remove sort key ${position}`,
  added: (position) => `Sort key ${position} added`,
  removed: (position, left) =>
    `Sort key ${position} removed, ${left} ${left === 1 ? "key" : "keys"} left`,
  moved: (field, position, total) => `${field} moved to position ${position} of ${total}`,
}

export type SortChange =
  | { type: "add"; id: string }
  | { type: "remove"; id: string }
  | { type: "update"; id: string }
  | { type: "move"; id: string }

export interface SortBuilderProps<Row = Record<string, unknown>>
  extends Omit<
    React.ComponentPropsWithoutRef<"fieldset">,
    "children" | "onChange" | "defaultValue"
  > {
  /** The keys a sort can be built on. The first unused one is what a new row starts with. */
  fields: readonly SortField<Row>[]
  /** Controlled list. Pair with `onChange`. */
  value?: readonly SortTerm[]
  /** Starting list when uncontrolled. */
  defaultValue?: readonly SortTerm[]
  onChange?: (next: SortTerm[], change: SortChange) => void
  /** Optional cap. There is already an implicit one: a key cannot be used twice. */
  maxTerms?: number
  /**
   * Draw the blanks-first/blanks-last control on each row.
   *
   * Off by default. It is the right answer for a report or an export, where someone is deciding
   * what the output looks like, and it is noise on a list page where the rows with no value are
   * not the point.
   */
  showNulls?: boolean
  legend?: React.ReactNode
  labels?: Partial<SortBuilderLabels>
  disabled?: boolean
  generateId?: () => string
}

const SELECT_CLASS =
  "h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

const ICON_BUTTON_CLASS =
  "inline-flex size-9 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

const REMOVE_BUTTON_CLASS =
  "inline-flex size-9 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

const GHOST_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

export function SortBuilder<Row = Record<string, unknown>>({
  fields,
  value,
  defaultValue,
  onChange,
  maxTerms,
  showNulls = false,
  legend,
  labels: labelOverrides,
  disabled,
  generateId = createSortId,
  className,
  ...props
}: SortBuilderProps<Row>) {
  const labels = React.useMemo(
    () => ({ ...defaultSortBuilderLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<SortTerm[]>(() => [...(defaultValue ?? [])])
  const terms = controlled ? value : internal
  const [message, setMessage] = React.useState("")

  const commit = (next: SortTerm[], change: SortChange) => {
    if (!controlled) setInternal(next)
    onChange?.(next, change)
  }

  const canAdd = canAddSortTerm(fields, terms, maxTerms)

  const addTerm = () => {
    if (!canAdd) return
    const term = createSortTerm(availableSortFields(fields, terms)[0], generateId)
    commit([...terms, term], { type: "add", id: term.id })
    setMessage(labels.added(terms.length + 1))
  }

  const removeTerm = (index: number) => {
    const term = terms[index]
    const next = terms.filter((_, at) => at !== index)
    commit(next, { type: "remove", id: term.id })
    setMessage(labels.removed(index + 1, next.length))
  }

  const updateTerm = (index: number, patch: Partial<SortTerm>) => {
    const term = terms[index]
    const next = terms.map((current, at) => (at === index ? { ...current, ...patch } : current))
    commit(next, { type: "update", id: term.id })
  }

  const changeField = (index: number, name: string) => {
    const term = terms[index]
    const field = findSortField(fields, name)
    // The direction is re-defaulted rather than carried: "newest first" moved onto a text key
    // would sit there as Z → A, which is not what the person who picked a date meant by it.
    const previousKind = sortFieldKind(findSortField(fields, term.field))
    const nextKind = sortFieldKind(field)
    const direction =
      previousKind === nextKind ? term.direction : defaultDirection(nextKind)
    // The nulls override is dropped with the key it was chosen for: it was a statement about that
    // column's blanks, and the new key's own default is a better guess than the old key's override.
    updateTerm(index, { field: name, direction, nulls: undefined })
  }

  const move = (index: number, to: number) => {
    if (to < 0 || to >= terms.length) return
    const term = terms[index]
    const next = moveSortTerm(terms, index, to)
    commit(next, { type: "move", id: term.id })
    const field = findSortField(fields, term.field)
    setMessage(
      labels.moved(sortFieldLabel(field) || term.field || labels.chooseKey, to + 1, next.length)
    )
  }

  return (
    <fieldset
      className={cn("flex min-w-0 flex-col gap-2", className)}
      disabled={disabled}
      {...props}
    >
      {legend ? <legend className="mb-1 text-sm font-medium">{legend}</legend> : null}

      {terms.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        // An ordered list, because the position of a row is its meaning and not its styling: the
        // list conveys "2 of 3" to a screen reader without the component saying it, and the number
        // beside each row is the same fact for everyone else.
        <ol className="flex min-w-0 flex-col gap-2">
          {terms.map((term, index) => {
            const field = findSortField(fields, term.field)
            const kind = sortFieldKind(field)
            const position = index + 1
            const options = availableSortFields(fields, terms, term.id)
            const unknownField = term.field !== "" && !field
            return (
              <li key={term.id} className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="w-14 flex-none text-sm text-muted-foreground">
                  {index === 0 ? labels.sortBy : labels.then}
                </span>

                <select
                  aria-label={labels.key(position)}
                  aria-invalid={unknownField || undefined}
                  disabled={disabled}
                  className={cn(
                    SELECT_CLASS,
                    "flex-1",
                    unknownField && "border-destructive focus-visible:ring-destructive"
                  )}
                  value={term.field}
                  onChange={(event) => changeField(index, event.target.value)}
                >
                  {term.field === "" ? <option value="">{labels.chooseKey}</option> : null}
                  {/* A key the fields no longer offer is kept as an option rather than silently
                      re-pointed at something else: a select whose value is absent from its options
                      shows the first one, so the row would read as a key nobody chose. */}
                  {unknownField ? <option value={term.field}>{term.field}</option> : null}
                  {options.map((candidate) => (
                    <option key={candidate.name} value={candidate.name}>
                      {sortFieldLabel(candidate)}
                    </option>
                  ))}
                </select>

                <select
                  aria-label={labels.direction(position)}
                  disabled={disabled}
                  className={cn(SELECT_CLASS, "flex-none")}
                  value={term.direction}
                  onChange={(event) =>
                    updateTerm(index, { direction: event.target.value as SortDirection })
                  }
                >
                  <option value="asc">{directionLabel(kind, "asc")}</option>
                  <option value="desc">{directionLabel(kind, "desc")}</option>
                </select>

                {showNulls ? (
                  <select
                    aria-label={labels.nulls(position)}
                    disabled={disabled}
                    className={cn(SELECT_CLASS, "flex-none")}
                    value={effectiveNulls(term, field)}
                    onChange={(event) =>
                      updateTerm(index, { nulls: event.target.value as SortNulls })
                    }
                  >
                    <option value="first">{labels.blanksFirst}</option>
                    <option value="last">{labels.blanksLast}</option>
                  </select>
                ) : null}

                {/* `aria-disabled` rather than `disabled`, the answer `column-visibility` already
                    settled for the same two buttons: the first row's "earlier" button becoming
                    unfocusable shifts the tab order for every row, and a key moved to the end with
                    the keyboard takes the focus down with its own button — the press lands, the
                    control vanishes from the tab order, and focus falls to the document. */}
                <button
                  type="button"
                  aria-label={labels.moveUp(position)}
                  aria-disabled={index === 0 || undefined}
                  disabled={disabled}
                  onClick={() => move(index, index - 1)}
                  className={cn(ICON_BUTTON_CLASS, index === 0 && "pointer-events-none opacity-50")}
                >
                  <ArrowUp className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={labels.moveDown(position)}
                  aria-disabled={index === terms.length - 1 || undefined}
                  disabled={disabled}
                  onClick={() => move(index, index + 1)}
                  className={cn(
                    ICON_BUTTON_CLASS,
                    index === terms.length - 1 && "pointer-events-none opacity-50"
                  )}
                >
                  <ArrowDown className="size-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={labels.remove(position)}
                  disabled={disabled}
                  onClick={() => removeTerm(index)}
                  className={REMOVE_BUTTON_CLASS}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ol>
      )}

      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          aria-disabled={!canAdd || undefined}
          disabled={disabled}
          onClick={addTerm}
          className={cn(GHOST_BUTTON_CLASS, !canAdd && "pointer-events-none opacity-50")}
        >
          <Plus className="size-4" aria-hidden="true" />
          {labels.addSort}
        </button>
        {!canAdd && terms.length > 0 ? (
          <p className="text-sm text-muted-foreground">{labels.allKeysUsed}</p>
        ) : null}
      </div>

      {/* Polite: adding, removing and reordering change no value, and a run of move presses should
          report where the key landed rather than every position it passed through. */}
      <div aria-live="polite" className="sr-only">
        {message}
      </div>
    </fieldset>
  )
}
