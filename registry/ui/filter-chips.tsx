"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The filter state, in whichever shape the page already holds it.
 *
 * All three are the same thing written differently, and every one of them is something a list page
 * already has: the query string from `location.search`, the `URLSearchParams` that
 * `useSearchParams()` hands back, or the `router.query` object of a pages-router app. What this
 * component must never be given is a separate array of chips — see `appliedFilters`.
 */
export type FilterQuery =
  | string
  | URLSearchParams
  | Readonly<Record<string, string | readonly string[] | undefined>>

/** One query parameter that counts as a filter, and how it reads to a person. */
export interface FilterFieldDef {
  /** The query parameter this field owns, e.g. "status". */
  key: string
  /** The field's name as a person reads it, e.g. "Status". Supply translated strings here. */
  label: string
  /**
   * Whether a field holding several values shows one chip per value (the default) or a single chip
   * for the whole parameter.
   *
   * This is the decision that changes what the "×" means, and it is a product decision rather than
   * a styling one. With `"value"`, `?status=open&status=pending` is two chips and removing one
   * narrows the filter to the other — which is what a person expects of a faceted list. With
   * `"key"` it is one chip reading "Status: Open, Pending" whose × stops filtering by status at
   * all; that is the right shape for a parameter whose values only make sense together, such as a
   * range ("Price: 20–50") or a single compound value like a date period.
   */
  chip?: "value" | "key"
  /**
   * Turns a raw value into what a person reads — an id into a name, a code into a label.
   *
   * Return `null` to say the value is not a filter at all. That is the escape hatch for the very
   * common `?status=all`: a select whose "All" option writes a value into the URL means the page is
   * technically filtering by something that filters nothing, and a chip reading "Status: All" is
   * noise a person cannot act on. Hidden values still belong to the parameter, so a `"key"` chip's
   * × and "Clear all" remove them along with the rest.
   */
  format?: (value: string) => string | null
  /**
   * Set when several values ride in **one** parameter, e.g. `?status=open,pending` with `","`.
   *
   * Left unset, multiple values mean a repeated parameter (`?status=open&status=pending`), which is
   * what `URLSearchParams` produces natively. Both conventions are everywhere in real APIs, and
   * guessing is not possible: `?tags=a,b` is two tags for one backend and a single tag named "a,b"
   * for another. Values are trimmed when a delimiter is set, since "open, pending" is how a human
   * writes such a list.
   */
  delimiter?: string
}

/** One chip: a filter that is in force right now, and what removing it would take away. */
export interface AppliedFilter {
  /** Stable within a render — used as the React key. */
  id: string
  /** The query parameter this chip came from. */
  key: string
  /** The field's `label`. */
  fieldLabel: string
  /** The raw values this chip stands for: one value, or every value of the parameter for a `"key"` chip. */
  values: readonly string[]
  /** The values as a person reads them, joined with ", " for a `"key"` chip. */
  text: string
  /** True when removing this chip drops the whole parameter rather than one of its values. */
  whole: boolean
}

/**
 * Parameters dropped whenever a filter changes, unless they are declared fields.
 *
 * A page number is not a condition, it is a cursor into the result of the conditions — so the
 * moment the conditions change it means nothing, and keeping it is the reason removing a filter on
 * page 7 so often lands on an empty list with "no results" showing while three chips are still on
 * screen. Extend it rather than replacing it when a page has its own cursor:
 * `resetKeys={[...DEFAULT_RESET_KEYS, "cursor"]}`.
 */
export const DEFAULT_RESET_KEYS: readonly string[] = ["page"]

/**
 * A private, mutable copy of whatever shape the caller keeps its filters in.
 *
 * Copied rather than used in place for two reasons: the object belongs to the caller and a
 * component that mutates it would change state behind the caller's back without a re-render, and
 * the `ReadonlyURLSearchParams` a framework hands out throws on the mutating methods anyway. The
 * string round-trip is also what makes a wrapper or subclass from another realm work, where
 * `instanceof` would not.
 */
export function toSearchParams(query: FilterQuery): URLSearchParams {
  if (typeof query === "string") return new URLSearchParams(query)
  if (typeof (query as URLSearchParams).toString === "function" && "getAll" in query) {
    return new URLSearchParams((query as URLSearchParams).toString())
  }
  const params = new URLSearchParams()
  const record = query as Readonly<Record<string, string | readonly string[] | undefined>>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (value === undefined) continue
    if (Array.isArray(value)) {
      // Appended one at a time on purpose: handing an array straight to URLSearchParams joins it
      // with a comma, which silently turns two repeated values into one comma-containing value.
      for (const one of value) params.append(key, one)
    } else {
      params.append(key, value as string)
    }
  }
  return params
}

/** The values a field holds, in the order they appear, deduplicated and without empties. */
function valuesOf(params: URLSearchParams, field: FilterFieldDef): string[] {
  const delimiter = field.delimiter
  const raw = params.getAll(field.key)
  const parts = delimiter
    ? raw.flatMap((entry) => entry.split(delimiter).map((value) => value.trim()))
    : raw
  const seen = new Set<string>()
  const values: string[] = []
  for (const value of parts) {
    // An empty value is what a reset select writes (`?status=`), and it filters nothing.
    // A repeat is the same condition said twice — `status in (open, open)` is `status in (open)` —
    // so it is one chip, and removing it removes every copy.
    if (value === "" || seen.has(value)) continue
    seen.add(value)
    values.push(value)
  }
  return values
}

/**
 * The chips a query deserves — derived, every time, from the query itself.
 *
 * This function is the component's whole reason for existing, and it is exported because the rule
 * it enforces is one a page can break outside the component too. The failure it rules out is
 * keeping a second array of "active filters" for display: the array and the URL then drift the
 * moment anything else touches the query — a browser Back, a saved view, a link, a reset button,
 * another control on the same page — and what a person sees is a pill for a condition that is no
 * longer applied, or no pill for one that is. That is the commonest way an admin list goes wrong,
 * and nothing about it looks wrong: the chips render, the count renders, they simply disagree.
 *
 * Chips follow the order of `fields`, not the order of the query string, because parameter order is
 * incidental — a router that rebuilds the URL may reorder it, and chips that reshuffle between
 * navigations read as a different set of filters. Within one field, values keep the order they
 * appear in.
 */
export function appliedFilters(
  query: FilterQuery,
  fields: readonly FilterFieldDef[]
): AppliedFilter[] {
  const params = toSearchParams(query)
  const chips: AppliedFilter[] = []
  for (const field of fields) {
    const values = valuesOf(params, field)
    if (values.length === 0) continue
    const shown: Array<{ value: string; text: string }> = []
    for (const value of values) {
      const text = field.format ? field.format(value) : value
      if (text === null || text === "") continue
      shown.push({ value, text })
    }
    if (shown.length === 0) continue
    if (field.chip === "key") {
      chips.push({
        id: field.key,
        key: field.key,
        fieldLabel: field.label,
        // Every value the parameter holds, including any the format hid, because this chip stands
        // for the parameter rather than for the text on it — a caller reading `values` to build its
        // own query needs the ones it cannot see as much as the ones it can. What makes the ×
        // complete is `whole` below, not this list.
        values,
        text: shown.map((entry) => entry.text).join(", "),
        whole: true,
      })
      continue
    }
    for (const entry of shown) {
      chips.push({
        id: `${field.key}=${entry.value}`,
        key: field.key,
        fieldLabel: field.label,
        values: [entry.value],
        text: entry.text,
        whole: false,
      })
    }
  }
  return chips
}

/** Drops the reset parameters, then serialises — the last step of every change made here. */
function serialize(
  params: URLSearchParams,
  fields: readonly FilterFieldDef[],
  resetKeys: readonly string[]
): string {
  const owned = new Set(fields.map((field) => field.key))
  for (const key of resetKeys) {
    // A declared field wins over the reset list: a chip that vanished on the next click would be
    // worse than a stale cursor, and a caller listing the same key in both places is contradicting
    // themselves.
    if (!owned.has(key)) params.delete(key)
  }
  return params.toString()
}

/**
 * The query with one chip's filter taken out, as a query string with no leading "?".
 *
 * Everything the component was not told about survives — the sort order, the tab, the search term
 * that is not a declared field. That is why this rebuilds the parameters rather than assembling a
 * fresh query from the fields: `router.push("?" + something)` built from the filters alone is how
 * removing one chip also throws away the column someone had sorted by.
 */
export function removeFilter(
  query: FilterQuery,
  fields: readonly FilterFieldDef[],
  filter: AppliedFilter,
  options: { resetKeys?: readonly string[] } = {}
): string {
  const field = fields.find((candidate) => candidate.key === filter.key)
  const delimiter = field?.delimiter
  const target = filter.values[0]
  const params = toSearchParams(query)
  const next = new URLSearchParams()
  for (const [key, value] of params.entries()) {
    if (key !== filter.key) {
      next.append(key, value)
      continue
    }
    if (filter.whole) continue
    if (delimiter) {
      const kept = value
        .split(delimiter)
        .map((part) => part.trim())
        .filter((part) => part !== "" && part !== target)
      if (kept.length > 0) next.append(key, kept.join(delimiter))
      continue
    }
    if (value !== target) next.append(key, value)
  }
  return serialize(next, fields, options.resetKeys ?? DEFAULT_RESET_KEYS)
}

/**
 * The query with every declared filter taken out, as a query string with no leading "?".
 *
 * Only declared fields go. Anything else in the query is not this component's to remove.
 */
export function clearFilters(
  query: FilterQuery,
  fields: readonly FilterFieldDef[],
  options: { resetKeys?: readonly string[] } = {}
): string {
  const owned = new Set(fields.map((field) => field.key))
  const params = toSearchParams(query)
  const next = new URLSearchParams()
  for (const [key, value] of params.entries()) {
    if (!owned.has(key)) next.append(key, value)
  }
  return serialize(next, fields, options.resetKeys ?? DEFAULT_RESET_KEYS)
}

/** Where focus should land once the tree this was set in has been replaced. */
type FocusIntent =
  | { kind: "chip"; index: number; from: string }
  | { kind: "undo"; from: string }
  | { kind: "row"; from: string }

export interface FilterChipsProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "onChange" | "value" | "defaultValue" | "children"
  > {
  /** Which query parameters are filters, and how each one reads. Chips appear in this order. */
  fields: readonly FilterFieldDef[]
  /**
   * Controlled filter state — the query the page is showing right now.
   *
   * Pass the same thing the list itself is filtered by and nothing can drift: `useSearchParams()`
   * in an app-router page, `router.query` in a pages-router one, `location.search` otherwise.
   */
  value?: FilterQuery
  /** Starting query for an uncontrolled row. Ignored once `value` is passed. */
  defaultValue?: FilterQuery
  /**
   * Called with the next query string — no leading "?" — whenever a filter is removed, cleared or
   * restored.
   *
   * `router.push("?" + next)` and `setSearchParams(next)` both take it as it stands. It is a string
   * rather than a `URLSearchParams` so that comparing it to the current query is a comparison
   * rather than a walk, and so nothing can mutate it after the fact.
   */
  onValueChange?: (query: string) => void
  /** Parameters dropped whenever a filter changes. Defaults to `DEFAULT_RESET_KEYS` (the page number). */
  resetKeys?: readonly string[]
  /**
   * How many rows the current filters match, if the page knows.
   *
   * Announced, not displayed — the page shows the list, the announcement is for the person who
   * cannot see that it changed. Leave it out and only the removal itself is announced. It is read
   * at announce time, so a count that arrives after the fetch updates the announcement when it
   * lands; the trade is that a background refresh during the same interaction can re-announce.
   */
  resultCount?: number
  /**
   * Turns a count into the announced phrase — it ends the announcement, so punctuate it as the end
   * of a sentence. Keep the formatting plain: the default deliberately does not run the number
   * through `toLocaleString`, because the runtime's own locale differs between the server render and
   * the browser's and the two would not match.
   */
  countLabel?: (count: number) => string
  /** Accessible name of the chip list. */
  label?: string
  /** Visible text of a chip. Defaults to the field label and the value, styled as two parts. */
  chipLabel?: (filter: AppliedFilter) => string
  /** Accessible name of a chip's remove button — it has to name the condition, not just "remove". */
  removeLabel?: (filter: AppliedFilter) => string
  /** Announced after a removal. */
  removedMessage?: (filter: AppliedFilter) => string
  /** Text of the clear-all control. */
  clearAllLabel?: string
  /** Announced after clearing. */
  clearedMessage?: string
  /**
   * How many chips have to be applied before clear-all appears. `Infinity` never shows it.
   *
   * Two is the default because "Clear all" beside a single chip offers a second button for the job
   * the × next to it already does. `0` means "whenever any filter is applied" — an enabled control
   * for clearing nothing is never shown.
   */
  clearAllFrom?: number
  /**
   * Whether clearing offers an undo. On by default, because clearing is the one irreversible
   * action here: a × takes away one condition a person can see and retype, while clear-all takes
   * away several at once and the screen no longer says what they were.
   *
   * The offer is a button in the row rather than a toast, and it does not time out — an undo that
   * disappears on its own is one a keyboard or screen-reader user cannot reach in time. It goes
   * away when the next thing happens: another change here, or any change to the query from
   * elsewhere, which is the point at which restoring the old filters would no longer match what is
   * on screen.
   */
  allowUndo?: boolean
  /** Text of the undo control. */
  undoLabel?: string
  /** Announced after an undo. */
  restoredMessage?: string
  /** Disables every control in the row. */
  disabled?: boolean
}

// Ends with a stop because this is spoken, not shown: it finishes the sentence the removal started,
// and a screen reader reads the punctuation as a pause rather than running the next phrase into it.
const defaultCountLabel = (count: number) => `${count} ${count === 1 ? "result" : "results"}.`

/**
 * The row of "filters in force" above a list or table, with a × on each and a way to clear them
 * all.
 *
 * ```tsx
 * const params = useSearchParams()
 * const router = useRouter()
 *
 * const fields = [
 *   { key: "status", label: "Status", format: (v) => (v === "all" ? null : STATUS[v]) },
 *   { key: "owner", label: "Owner", format: (v) => people[v]?.name ?? v },
 *   { key: "period", label: "Period", chip: "key" as const },
 *   { key: "q", label: "Search" },
 * ]
 *
 * <FilterChips
 *   fields={fields}
 *   value={params}
 *   resultCount={rows.length}
 *   onValueChange={(next) => router.push(`/orders?${next}`)}
 * />
 * ```
 *
 * It holds no filter state of its own: the chips are derived from the query on every render, so the
 * row cannot disagree with the list it sits above. Composes with `date-range-preset`, which keeps
 * its period in the same query string (`?period=last7d`) — declare that parameter as a `"key"`
 * field and the chip removes the period the same way any other filter comes off.
 */
export const FilterChips = React.forwardRef<HTMLDivElement, FilterChipsProps>(
  function FilterChips(
    {
      className,
      fields,
      value: valueProp,
      defaultValue = "",
      onValueChange,
      resetKeys = DEFAULT_RESET_KEYS,
      resultCount,
      countLabel = defaultCountLabel,
      label = "Applied filters",
      chipLabel,
      removeLabel = (filter) => `Remove ${filter.fieldLabel} filter: ${filter.text}`,
      removedMessage = (filter) => `Removed ${filter.fieldLabel}: ${filter.text}.`,
      clearAllLabel = "Clear all",
      clearedMessage = "All filters cleared.",
      clearAllFrom = 2,
      allowUndo = true,
      undoLabel = "Undo",
      restoredMessage = "Filters restored.",
      disabled,
      ...props
    },
    ref
  ) {
    const isControlled = valueProp !== undefined
    const [uncontrolledQuery, setUncontrolledQuery] = React.useState(() =>
      toSearchParams(defaultValue).toString()
    )
    const query = isControlled ? toSearchParams(valueProp).toString() : uncontrolledQuery

    const chips = React.useMemo(() => appliedFilters(query, fields), [query, fields])

    /** What was just done, for the live region. Empty until the person does something. */
    const [action, setAction] = React.useState("")
    /** The query clear-all replaced, for undo. Null when there is nothing to put back. */
    const [undoTo, setUndoTo] = React.useState<string | null>(null)

    // The last query this component asked for. Anything else arriving is somebody else's change.
    const emitted = React.useRef<string | null>(null)
    const focusIntent = React.useRef<FocusIntent | null>(null)

    /**
     * Drops what this row was saying about the filters when the filters changed from outside it.
     *
     * A Back button, a link, a saved view or another control on the page can all change the query,
     * and at that moment the undo snapshot describes a state nobody is looking at, the last
     * announcement is about a filter that may be gone, and a queued focus move points into a row
     * that has been rebuilt for a different reason. Written as an adjustment during render rather
     * than in an effect so the row never paints with any of the three still in force.
     */
    const [lastQuery, setLastQuery] = React.useState(query)
    if (query !== lastQuery) {
      setLastQuery(query)
      if (query !== emitted.current) {
        setUndoTo(null)
        setAction("")
        focusIntent.current = null
      }
    }

    const rowRef = React.useRef<HTMLDivElement>(null)
    const removeRefs = React.useRef<Array<React.RefObject<HTMLButtonElement | null>>>([])
    const clearRef = React.useRef<HTMLButtonElement>(null)
    const undoRef = React.useRef<HTMLButtonElement>(null)

    /**
     * One stable ref object per position in the row — by position, not by chip.
     *
     * Position is what focus is about: remove the second of three chips and focus belongs on
     * whatever is second now. Object refs rather than inline callbacks so the nodes are not
     * detached and re-attached on every render of the list.
     */
    const removeRef = (index: number) => {
      while (removeRefs.current.length <= index) {
        removeRefs.current.push(React.createRef<HTMLButtonElement>())
      }
      return removeRefs.current[index]
    }

    // Forwarded through the handle so the row can keep its own ref on the same node: it is the
    // fallback focus target, and a caller's ref would otherwise have to be merged by hand.
    React.useImperativeHandle(ref, () => rowRef.current as HTMLDivElement)

    /**
     * Puts focus somewhere sensible once the row has been rebuilt without the chip that had it.
     *
     * The button the person pressed is gone from the document, and a browser does not move focus
     * when the focused element is removed — it drops to `<body>`, which for a keyboard user means
     * tabbing starts again from the top of the page, and for a screen-reader user means nothing
     * says what happened. So focus goes to the chip that took the removed one's place, or to the
     * last chip when the end of the row was removed, and to the row itself when nothing is left.
     *
     * Gated on the query having actually changed, because in controlled use the parent may re-render
     * this row before it applies the new query — for a route change it usually does — and focusing
     * position 1 in a row that still holds the old chips would put focus on the very button that is
     * about to be removed. No dependency array: the intent is set by a person's click and this has
     * to be the first commit after it that shows the result.
     */
    React.useEffect(() => {
      const intent = focusIntent.current
      if (!intent || intent.from === query) return
      focusIntent.current = null
      if (intent.kind === "undo") {
        ;(undoRef.current ?? rowRef.current)?.focus()
        return
      }
      if (intent.kind === "chip" && chips.length > 0) {
        // Clamped by the chip count rather than by which refs are attached: a ref for a position
        // the row no longer has may still be holding its old node this early in the commit.
        const at = Math.min(intent.index, chips.length - 1)
        const target = removeRefs.current[at]?.current ?? clearRef.current ?? rowRef.current
        target?.focus()
        return
      }
      rowRef.current?.focus()
    })

    const emit = (next: string) => {
      emitted.current = next
      if (!isControlled) setUncontrolledQuery(next)
      onValueChange?.(next)
    }

    const handleRemove = (filter: AppliedFilter, index: number) => {
      focusIntent.current = { kind: "chip", index, from: query }
      setUndoTo(null)
      setAction(removedMessage(filter))
      emit(removeFilter(query, fields, filter, { resetKeys }))
    }

    const handleClearAll = () => {
      focusIntent.current = allowUndo ? { kind: "undo", from: query } : { kind: "row", from: query }
      // The snapshot is the query as it stands, reset parameters and all, so undo is a true inverse:
      // clearing from page 7 and undoing puts page 7 back rather than dropping the reader at page 1.
      setUndoTo(allowUndo ? query : null)
      setAction(clearedMessage)
      emit(clearFilters(query, fields, { resetKeys }))
    }

    const handleUndo = () => {
      if (undoTo === null) return
      focusIntent.current = { kind: "chip", index: 0, from: query }
      setAction(restoredMessage)
      setUndoTo(null)
      emit(undoTo)
    }

    const countText = resultCount === undefined ? "" : countLabel(resultCount)
    // Only ever the outcome of something done here. A region that also reported counts it was not
    // asked about would narrate every keystroke in the page's own search box.
    const announcement = action === "" ? "" : [action, countText].filter(Boolean).join(" ")

    // Gated on the row being empty as well as on there being a snapshot, so a controlled parent that
    // has not applied the clear yet never shows an undo beside the chips it is about to remove.
    const showUndo = allowUndo && undoTo !== null && chips.length === 0
    const showClearAll = chips.length > 0 && chips.length >= clearAllFrom

    return (
      <div
        ref={rowRef}
        // Focusable only from code: where focus goes when the last chip is removed and there is no
        // neighbour left to take it. The browser's own ring is left alone rather than suppressed,
        // so a keyboard user sees where they landed and a mouse user sees nothing.
        tabIndex={-1}
        className={cn("flex flex-wrap items-center gap-2", className)}
        {...props}
      >
        {chips.length > 0 ? (
          // role="list" is written out because Tailwind's preflight removes the list style, and
          // Safari drops the list role from a list that has none — taking "list, 3 items" with it.
          <ul role="list" aria-label={label} className="flex flex-wrap items-center gap-1.5">
            {chips.map((filter, index) => (
              <li key={filter.id} data-filter-key={filter.key} className="inline-flex max-w-full">
                <span className="inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-input bg-background pl-2.5 pr-1 text-xs">
                  <span className="min-w-0 max-w-[14rem] truncate" title={filter.text}>
                    {chipLabel ? (
                      chipLabel(filter)
                    ) : (
                      <>
                        <span className="text-muted-foreground">{filter.fieldLabel}:</span>{" "}
                        <span className="font-medium text-foreground">{filter.text}</span>
                      </>
                    )}
                  </span>
                  <button
                    ref={removeRef(index)}
                    type="button"
                    // The visible text says which condition; this says what pressing it does to
                    // that condition. A bare "Remove" or an unlabelled × is read as "button".
                    aria-label={removeLabel(filter)}
                    disabled={disabled}
                    onClick={() => handleRemove(filter, index)}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        {showClearAll ? (
          <button
            ref={clearRef}
            type="button"
            disabled={disabled}
            onClick={handleClearAll}
            className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {clearAllLabel}
          </button>
        ) : null}

        {showUndo ? (
          <button
            ref={undoRef}
            type="button"
            disabled={disabled}
            onClick={handleUndo}
            className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-foreground underline underline-offset-4 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {undoLabel}
          </button>
        ) : null}

        {/*
          Mounted whether or not there are chips, and never given `hidden` or wrapped in a
          condition. A live region has to be in the accessibility tree before the text it will
          announce arrives; one that appears together with its message is a region nobody was
          listening to, which reads exactly like silence — and the message that matters most here is
          the one about the last chip going away, i.e. the one that arrives as the row empties.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>
    )
  }
)
