"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, Check, Columns3, Lock, RotateCcw } from "lucide-react"

import { cn } from "@/lib/utils"

/** One column the table could render. */
export interface ColumnDef {
  /** Stable identifier. It is what gets persisted, so it outlives the label. */
  key: string
  /** What the menu shows, and what announcements name. */
  label: string
  /**
   * Always shown, never moved.
   *
   * For the columns that are not really data: the leading checkbox, the row-actions column at the
   * end, the name column a row is identified by. Hiding one of those leaves a table of values with
   * no way to tell which row is which and no way to act on any of them, and — the part that makes
   * it worth a flag rather than a convention — no way back, because the control that would bring it
   * back is in the column that just disappeared.
   */
  locked?: boolean
}

/**
 * What the person chose: the order to render columns in, and which of them are hidden.
 *
 * Two plain arrays rather than a `Set` and a `Map`, because this value's whole purpose is to leave
 * the component — into `localStorage`, into a query string, into a `user_preferences` row — and
 * `JSON.stringify(new Set())` is `{}`. A preference that silently serialises to nothing is the
 * failure this shape exists to prevent.
 *
 * Both fields are tolerated empty or partial: `{ hidden: ["email"] }` is a complete, valid
 * preference meaning "default order, email hidden". {@link resolveColumnPreference} fills the rest
 * in from the column definitions, which is where every decision about a stale preference is made.
 */
export interface ColumnPreference {
  order: string[]
  hidden: string[]
}

/** A fresh preference meaning "whatever the column definitions say". Also what Reset emits. */
export function defaultColumnPreference(): ColumnPreference {
  return { order: [], hidden: [] }
}

export interface ResolveColumnOptions {
  /**
   * How many columns must stay visible. Defaults to `1`.
   *
   * Clamped to the number of columns there are, so a `minVisible` larger than the table cannot
   * make the floor unreachable.
   */
  minVisible?: number
}

export interface ResolvedColumns {
  /** Every defined key, in the order the table should render them. */
  order: string[]
  /** The hidden keys. A subset of `order`, and never a locked key. */
  hidden: string[]
  /** The columns to render, in order — the one list a table actually needs. */
  visible: ColumnDef[]
  /**
   * Defined keys the saved preference had never heard of, in definition order.
   *
   * **Measured against `order`, and empty when the preference had none**, which is the distinction
   * that makes this usable rather than noise. `order` is the only field that enumerates the columns
   * a preference knew; `hidden` lists a subset and says nothing about the rest. So on a first visit
   * — and for a caller that stores only `{ hidden }`, which is a perfectly good way to use this —
   * nothing is reported, instead of every column being announced as new on every single load. It is
   * non-empty only when a preference that spelled out *which* columns there were met a table that
   * has more: a deploy that added one.
   */
  added: string[]
  /** Keys the saved preference carried that no longer exist, in the order it carried them. */
  dropped: string[]
  /** Keys the preference hid that had to be shown again to keep `minVisible` met. */
  revealed: string[]
}

function dedupeColumns(columns: readonly ColumnDef[]): ColumnDef[] {
  const out: ColumnDef[] = []
  const seen = new Set<string>()
  for (const column of columns) {
    if (typeof column.key !== "string" || column.key === "" || seen.has(column.key)) continue
    seen.add(column.key)
    out.push(column)
  }
  return out
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/**
 * Turns a stored preference and the table's current columns into one answer the table can render.
 *
 * This is the whole component in one function, and the reason it is exported: a table that renders
 * its columns on the server, or paginates through an API, needs the resolved order without ever
 * mounting a menu.
 *
 * **A stored preference is always out of date, and the defaults decide what that costs.** It was
 * written by an older deploy against an older set of columns, or typed into a URL by hand, and the
 * four ways it can disagree with the table each have an obvious-looking answer that is wrong:
 *
 *   - **A column the preference has never seen is shown, not hidden.** Treating the stored list as
 *     the allow-list is the one-line version, and it is the expensive bug in this component:
 *     everyone who ever opened the menu has a stored preference, so a column added next week is
 *     invisible to exactly the established users, and visible only to people who have never used
 *     the product. Nobody reports it — they cannot see it — and the team shipping the column sees
 *     it on their own fresh profile and concludes it works.
 *   - **It is shown in its defined position, not appended.** The definition is where the author
 *     said a column belongs, and appending puts a new "Status" column after the actions column at
 *     the far right, past the horizontal scroll. Each new key is anchored after the nearest column
 *     before it that the preference did know, so it lands among its neighbours.
 *   - **A key that no longer exists is dropped rather than carried.** Carried, it leaves a gap in
 *     the order that the next reorder shuffles around invisibly, and a hidden-set entry that
 *     resurrects a column if the key is ever reused.
 *   - **A locked column is pulled back to its defined position and un-hidden.** `locked` is a
 *     property of this deploy's table, not of the stored preference: a column that was ordinary
 *     when the preference was written and is load-bearing now would otherwise stay hidden for the
 *     people who hid it, which is precisely the group whose table is missing the column that makes
 *     it readable.
 *
 * Then the floor is applied last, over the result of all four — because each of them can take the
 * visible count below `minVisible` on its own, and a table of zero columns renders as a strip of
 * nothing with no control left to undo it.
 */
export function resolveColumnPreference(
  columns: readonly ColumnDef[],
  saved?: Partial<ColumnPreference> | null,
  { minVisible = 1 }: ResolveColumnOptions = {}
): ResolvedColumns {
  const defined = dedupeColumns(columns)
  const byKey = new Map(defined.map((column) => [column.key, column]))
  const locked = new Set(defined.filter((column) => column.locked).map((column) => column.key))

  const savedOrder = asArray(saved?.order)
  const savedHidden = asArray(saved?.hidden)
  // "Known to the preference" spans both fields — a key it hid is a key it has heard of — but only
  // `order` *enumerates*, so only a preference that has one can make a column new by omission.
  const known = new Set([...savedOrder, ...savedHidden])
  const enumerated = savedOrder.length > 0

  const merged: string[] = []
  for (const key of savedOrder) {
    if (byKey.has(key) && !merged.includes(key)) merged.push(key)
  }

  const added: string[] = []
  for (let i = 0; i < defined.length; i++) {
    const key = defined[i].key
    if (merged.includes(key)) continue
    if (!known.has(key)) added.push(key)
    // Anchored after the nearest preceding column that is already placed. Walking definition order
    // means an earlier new key is placed before this one reaches it, so a run of new columns keeps
    // its own order instead of reversing.
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const previous = merged.indexOf(defined[j].key)
      if (previous !== -1) {
        at = previous + 1
        break
      }
    }
    merged.splice(at, 0, key)
  }

  // Locked keys take the index they hold in the definition; the movable ones fill what is left, in
  // the order the preference asked for. Because `merged` holds exactly the defined keys, the two
  // sets fit together with no gaps left over.
  const movable = merged.filter((key) => !locked.has(key))
  const order: string[] = []
  let next = 0
  for (const column of defined) {
    if (locked.has(column.key)) order.push(column.key)
    else order.push(movable[next++])
  }

  const hiddenSet = new Set(savedHidden.filter((key) => byKey.has(key) && !locked.has(key)))

  const revealed: string[] = []
  const floor = Math.max(0, Math.min(Math.floor(minVisible) || 0, defined.length))
  for (const key of order) {
    if (defined.length - hiddenSet.size >= floor) break
    if (!hiddenSet.delete(key)) continue
    revealed.push(key)
  }

  const dropped: string[] = []
  for (const key of [...savedOrder, ...savedHidden]) {
    if (!byKey.has(key) && !dropped.includes(key)) dropped.push(key)
  }

  const visible: ColumnDef[] = []
  for (const key of order) {
    const column = byKey.get(key)
    if (column && !hiddenSet.has(key)) visible.push(column)
  }

  return {
    order,
    hidden: order.filter((key) => hiddenSet.has(key)),
    visible,
    added: enumerated ? added : [],
    dropped,
    revealed,
  }
}

/**
 * The index `from` would swap with when moved one step in `direction`, or `-1`.
 *
 * Shared by {@link moveColumn} and the hook's `canMove`, rather than written twice: a greyed-out
 * button whose rule has drifted from the rule the press follows is the one bug in a reorder control
 * that nobody sees in review — the button looks pressable and does nothing, or looks dead and works.
 */
function swapTarget(
  order: readonly string[],
  hidden: ReadonlySet<string>,
  locked: ReadonlySet<string>,
  from: number,
  direction: -1 | 1
): number {
  for (let i = from + direction; i >= 0 && i < order.length; i += direction) {
    const candidate = order[i]
    if (locked.has(candidate)) return -1
    if (!hidden.has(candidate)) return i
  }
  return -1
}

/** Why a column cannot be hidden, or `null` when it can. */
export type HideBlockedReason = "locked" | "minimum"

/**
 * Whether hiding `key` is refused, and why.
 *
 * Two reasons, and they want different words on screen: `"locked"` is permanent and about that one
 * column, `"minimum"` is temporary and about the table — it lifts the moment another column is
 * shown. Rendered as the same greyed-out checkbox, the second one reads as "this column is special
 * too", and the way out of it is never found.
 */
export function hideBlockedReason(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  key: string,
  options: ResolveColumnOptions = {}
): HideBlockedReason | null {
  const defined = dedupeColumns(columns)
  const column = defined.find((candidate) => candidate.key === key)
  if (!column) return null
  if (column.locked) return "locked"
  const resolved = resolveColumnPreference(defined, preference, options)
  if (resolved.hidden.includes(key)) return null
  const floor = Math.max(0, Math.min(Math.floor(options.minVisible ?? 1) || 0, defined.length))
  return resolved.visible.length - 1 < floor ? "minimum" : null
}

/**
 * Shows or hides one column. Returns the next preference, or `null` when nothing would change —
 * the column is already in that state, it is locked, it does not exist, or hiding it would take the
 * table below its floor.
 *
 * `null` rather than the same object or a thrown error: a refusal is an ordinary outcome here
 * (clicking the last visible column's checkbox is a thing people do on purpose, to find out whether
 * they can), and it is the caller's cue to say why instead of writing a preference that resolves
 * back to what it already was.
 *
 * The preference it returns carries the **resolved** order, not the stored one. That is deliberate:
 * the first time anybody touches this menu, the carry-over decisions above — where a new column
 * landed, which stale keys went — stop being recomputed on every load and become the choice.
 */
export function setColumnVisible(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  key: string,
  visible: boolean,
  options: ResolveColumnOptions = {}
): ColumnPreference | null {
  const defined = dedupeColumns(columns)
  const column = defined.find((candidate) => candidate.key === key)
  if (!column || column.locked) return null

  const resolved = resolveColumnPreference(defined, preference, options)
  const isHidden = resolved.hidden.includes(key)
  // Already in the state being asked for.
  if (visible === !isHidden) return null
  if (!visible && hideBlockedReason(defined, preference, key, options) !== null) return null

  const hidden = visible
    ? resolved.hidden.filter((entry) => entry !== key)
    : [...resolved.hidden, key]
  return { order: resolved.order, hidden: resolved.order.filter((entry) => hidden.includes(entry)) }
}

/** Flips one column. Same refusals as {@link setColumnVisible}. */
export function toggleColumnVisibility(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  key: string,
  options: ResolveColumnOptions = {}
): ColumnPreference | null {
  const resolved = resolveColumnPreference(columns, preference, options)
  return setColumnVisible(columns, preference, key, resolved.hidden.includes(key), options)
}

/** Un-hides everything, keeping the order. `null` when nothing is hidden. */
export function showAllColumns(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  options: ResolveColumnOptions = {}
): ColumnPreference | null {
  const resolved = resolveColumnPreference(columns, preference, options)
  if (resolved.hidden.length === 0) return null
  return { order: resolved.order, hidden: [] }
}

/**
 * Moves one column one step towards the start (`-1`) or the end (`1`). `null` when it cannot go —
 * it is locked, or there is nothing on that side to swap with.
 *
 * **The step is over the columns you can see, not over the array.** Swapping with the literal
 * neighbour is the shorter implementation and it produces a control that does nothing: with Email
 * hidden between Name and Created, pressing "move down" on Name trades Name for a column that is
 * not on screen, so the table is identical and the button looks broken. Press it twice and Name
 * finally moves, which is worse — it reads as a control that needs two presses sometimes.
 *
 * Hidden columns keep their index through the swap, so un-hiding one later puts it back between the
 * same two neighbours rather than at whichever end the moves pushed it to. Locked columns are not
 * passed over, they are not passed through: they hold their defined position, and a movable column
 * on the far side of one is not reachable by moving — which is the point of pinning the row-actions
 * column to the end.
 */
export function moveColumn(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  key: string,
  direction: -1 | 1,
  options: ResolveColumnOptions = {}
): ColumnPreference | null {
  const defined = dedupeColumns(columns)
  const column = defined.find((candidate) => candidate.key === key)
  if (!column || column.locked) return null

  const resolved = resolveColumnPreference(defined, preference, options)
  const locked = new Set(defined.filter((entry) => entry.locked).map((entry) => entry.key))
  const hidden = new Set(resolved.hidden)
  const from = resolved.order.indexOf(key)
  if (from === -1) return null

  const to = swapTarget(resolved.order, hidden, locked, from, direction)
  if (to === -1) return null

  const order = resolved.order.slice()
  order[from] = resolved.order[to]
  order[to] = key
  return { order, hidden: order.filter((entry) => hidden.has(entry)) }
}

/** Whether `preference` resolves to exactly what no preference at all would resolve to. */
export function isDefaultColumnPreference(
  columns: readonly ColumnDef[],
  preference: Partial<ColumnPreference> | null | undefined,
  options: ResolveColumnOptions = {}
): boolean {
  const resolved = resolveColumnPreference(columns, preference, options)
  const base = resolveColumnPreference(columns, null, options)
  return (
    resolved.hidden.length === 0 &&
    base.hidden.length === 0 &&
    resolved.order.length === base.order.length &&
    resolved.order.every((key, index) => key === base.order[index])
  )
}

// `~` escapes, so a key may contain the two characters the format itself uses. Keys are developer
// chosen and usually look like `created_at`, but they are also sometimes a JSON path or a header
// straight out of a CSV, and a preference that drops a column whose name has a comma in it is a
// column nobody can get back from the menu.
function encodeKey(key: string): string {
  const escaped = key.replace(/~/g, "~~").replace(/,/g, "~c")
  return escaped.startsWith("-") ? `~-${escaped.slice(1)}` : escaped
}

function decodeKey(token: string): string {
  let out = ""
  for (let i = 0; i < token.length; i++) {
    const char = token[i]
    if (char !== "~") {
      out += char
      continue
    }
    const following = token[i + 1]
    if (following === "~") out += "~"
    else if (following === "c") out += ","
    else if (following === "-") out += "-"
    else {
      // A stray tilde: kept, rather than eating the character after it. This string may have been
      // typed by hand, and swallowing a letter would quietly rename the column.
      out += "~"
      continue
    }
    i++
  }
  return out
}

/**
 * The preference as one short string, for a query parameter or a `localStorage` value:
 * `"name,-email,created"`, where a leading `-` means hidden.
 *
 * Short on purpose. `JSON.stringify` works and is three times the length once a URL has
 * percent-encoded the braces and quotes, which matters when this is one of several parameters a
 * shared link carries.
 */
export function serializeColumnPreference(preference: Partial<ColumnPreference>): string {
  const order = asArray(preference.order)
  const hidden = asArray(preference.hidden)
  const hiddenSet = new Set(hidden)
  const parts: string[] = []
  const written = new Set<string>()
  for (const key of order) {
    if (written.has(key)) continue
    written.add(key)
    parts.push((hiddenSet.has(key) ? "-" : "") + encodeKey(key))
  }
  // A hidden key that the order never mentioned still has to survive the round trip, or
  // `{ hidden: ["email"] }` — a complete preference — serialises to the empty string.
  for (const key of hidden) {
    if (written.has(key)) continue
    written.add(key)
    parts.push(`-${encodeKey(key)}`)
  }
  return parts.join(",")
}

/**
 * Reads back what {@link serializeColumnPreference} wrote. Never throws.
 *
 * This value arrives from a URL, which means it arrives from anyone. Garbage in it resolves to
 * garbage keys, which {@link resolveColumnPreference} drops as not existing — so the worst a
 * hand-edited link can do is show the default table.
 *
 * The round trip is over the *resolved* preference rather than the literal object: a hidden key
 * that was not in `order` comes back inside `order`, which is the same table.
 */
export function parseColumnPreference(text: string | null | undefined): ColumnPreference {
  const order: string[] = []
  const hidden: string[] = []
  const seen = new Set<string>()
  for (const token of String(text ?? "").split(",")) {
    if (token === "") continue
    const isHidden = token.startsWith("-")
    const key = decodeKey(isHidden ? token.slice(1) : token)
    if (key === "" || seen.has(key)) continue
    seen.add(key)
    order.push(key)
    if (isHidden) hidden.push(key)
  }
  return { order, hidden }
}

/** Every string a screen reader or a reader of the panel sees. Override to translate or reword. */
export interface ColumnVisibilityLabels {
  /** The trigger's accessible name. */
  trigger: (visible: number, total: number) => string
  /** Visible text on the trigger. */
  triggerText: string
  /** The panel's heading, which also names the group of checkboxes. */
  heading: string
  /** Announced after a column is shown. */
  shown: (label: string, visible: number, total: number) => string
  /** Announced after a column is hidden. */
  concealed: (label: string, visible: number, total: number) => string
  /** Announced after a move. `position` counts every column, hidden ones included. */
  moved: (label: string, position: number, total: number) => string
  /** Announced when the floor refuses a press, and shown in the panel while it is reached. */
  minimum: (minVisible: number) => string
  /** Why a locked column has no checkbox. Read by screen readers only. */
  locked: string
  showAll: string
  reset: string
  /** Announced after Show all. */
  shownAll: (total: number) => string
  /** Announced after Reset. */
  didReset: string
  moveUp: (label: string) => string
  moveDown: (label: string) => string
}

export const defaultColumnVisibilityLabels: ColumnVisibilityLabels = {
  trigger: (visible, total) => `Columns, ${visible} of ${total} shown`,
  triggerText: "Columns",
  heading: "Columns",
  shown: (label, visible, total) => `${label} shown. ${visible} of ${total} columns shown.`,
  concealed: (label, visible, total) => `${label} hidden. ${visible} of ${total} columns shown.`,
  moved: (label, position, total) => `${label} moved to position ${position} of ${total}.`,
  minimum: (minVisible) =>
    minVisible === 1
      ? "At least one column has to stay visible."
      : `At least ${minVisible} columns have to stay visible.`,
  locked: "Always shown",
  showAll: "Show all",
  reset: "Reset",
  shownAll: (total) => `All ${total} columns shown.`,
  didReset: "Columns reset to their default order, all shown.",
  moveUp: (label) => `Move ${label} earlier`,
  moveDown: (label) => `Move ${label} later`,
}

export interface UseColumnVisibilityOptions extends ResolveColumnOptions {
  columns: readonly ColumnDef[]
  /** The stored preference. `null`, `undefined` or a partial object are all fine. */
  preference?: Partial<ColumnPreference> | null
  /** Receives the next preference. Persist it and pass it back — this hook stores nothing. */
  onPreferenceChange: (next: ColumnPreference) => void
  labels?: Partial<ColumnVisibilityLabels>
  /** Announce changes through a live region. Defaults to `true`. */
  announce?: boolean
}

export interface UseColumnVisibilityResult extends ResolvedColumns {
  /** The deduplicated column definitions, in render order. */
  columns: ColumnDef[]
  visibleCount: number
  total: number
  /** True when the preference resolves to the definitions' own order with nothing hidden. */
  isDefault: boolean
  /** True while the visible count sits on `minVisible`, so hiding anything more is refused. */
  atMinimum: boolean
  /**
   * `minVisible` as it actually applies: floored to an integer and clamped to the number of
   * columns there are, so a panel of your own shows the same number the refusal enforces.
   */
  minVisible: number
  /** Non-empty for a moment after a change. Belongs in a polite live region. */
  announcement: string
  hideBlocked: (key: string) => HideBlockedReason | null
  canMove: (key: string, direction: -1 | 1) => boolean
  setVisible: (key: string, visible: boolean) => void
  toggle: (key: string) => void
  move: (key: string, direction: -1 | 1) => void
  showAll: () => void
  reset: () => void
}

/**
 * The column preference without the menu — for a panel of your own, a drawer on a phone, or a
 * server-rendered table that only needs {@link ResolvedColumns}.
 */
export function useColumnVisibility({
  columns,
  preference,
  onPreferenceChange,
  minVisible = 1,
  labels: labelOverrides,
  announce = true,
}: UseColumnVisibilityOptions): UseColumnVisibilityResult {
  const labels = React.useMemo(
    () => ({ ...defaultColumnVisibilityLabels, ...labelOverrides }),
    [labelOverrides]
  )

  const defined = React.useMemo(() => dedupeColumns(columns), [columns])
  const options = React.useMemo(() => ({ minVisible }), [minVisible])
  const resolved = React.useMemo(
    () => resolveColumnPreference(defined, preference, options),
    [defined, preference, options]
  )

  const [announcement, setAnnouncement] = React.useState("")

  // Cleared again shortly after. The region lives inside the panel, which is where the controls
  // are, so a sentence left in it becomes part of what the next row reads out — "Email, checkbox,
  // checked, Name hidden, 3 of 4 columns shown".
  React.useEffect(() => {
    if (!announcement) return
    const timer = setTimeout(() => setAnnouncement(""), 1200)
    return () => clearTimeout(timer)
  }, [announcement])

  const say = React.useCallback(
    (message: string) => {
      if (!announce) return
      // A repeat of the same sentence is not a change to the region's content and is not read out,
      // so the second refusal in a row would be silent. The zero-width space makes it different
      // text without making it different words.
      setAnnouncement((current) => (current === message ? `${message}​` : message))
    },
    [announce]
  )

  const labelOf = React.useCallback(
    (key: string) => defined.find((column) => column.key === key)?.label ?? key,
    [defined]
  )

  const total = defined.length
  const floor = Math.max(0, Math.min(Math.floor(minVisible) || 0, total))

  const hideBlocked = React.useCallback(
    (key: string) => hideBlockedReason(defined, preference, key, options),
    [defined, preference, options]
  )

  // Derived from the state already resolved above, through the same scan the press uses, rather
  // than by calling `moveColumn` — which would re-resolve the whole preference twice for every row
  // on every render just to find out whether an arrow should look pressable.
  const lockedKeys = React.useMemo(
    () => new Set(defined.filter((column) => column.locked).map((column) => column.key)),
    [defined]
  )
  const hiddenKeys = React.useMemo(() => new Set(resolved.hidden), [resolved.hidden])

  const canMove = React.useCallback(
    (key: string, direction: -1 | 1) => {
      if (lockedKeys.has(key)) return false
      const from = resolved.order.indexOf(key)
      if (from === -1) return false
      return swapTarget(resolved.order, hiddenKeys, lockedKeys, from, direction) !== -1
    },
    [resolved.order, hiddenKeys, lockedKeys]
  )

  const setVisible = React.useCallback(
    (key: string, visible: boolean) => {
      const next = setColumnVisible(defined, preference, key, visible, options)
      if (!next) {
        if (!visible && hideBlockedReason(defined, preference, key, options) === "minimum") {
          say(labels.minimum(floor))
        }
        return
      }
      onPreferenceChange(next)
      const count = next.order.length - next.hidden.length
      say(
        visible
          ? labels.shown(labelOf(key), count, next.order.length)
          : labels.concealed(labelOf(key), count, next.order.length)
      )
    },
    [defined, preference, options, onPreferenceChange, say, labels, labelOf, floor]
  )

  const toggle = React.useCallback(
    (key: string) => setVisible(key, resolved.hidden.includes(key)),
    [setVisible, resolved.hidden]
  )

  const move = React.useCallback(
    (key: string, direction: -1 | 1) => {
      const next = moveColumn(defined, preference, key, direction, options)
      if (!next) return
      onPreferenceChange(next)
      say(labels.moved(labelOf(key), next.order.indexOf(key) + 1, next.order.length))
    },
    [defined, preference, options, onPreferenceChange, say, labels, labelOf]
  )

  const showAll = React.useCallback(() => {
    const next = showAllColumns(defined, preference, options)
    if (!next) return
    onPreferenceChange(next)
    say(labels.shownAll(next.order.length))
  }, [defined, preference, options, onPreferenceChange, say, labels])

  const reset = React.useCallback(() => {
    if (isDefaultColumnPreference(defined, preference, options)) return
    onPreferenceChange(defaultColumnPreference())
    say(labels.didReset)
  }, [defined, preference, options, onPreferenceChange, say, labels])

  return {
    ...resolved,
    columns: defined,
    visibleCount: resolved.visible.length,
    total,
    isDefault: isDefaultColumnPreference(defined, preference, options),
    // `floor > 0` is load-bearing rather than defensive. `atMinimum` means "hiding anything more is
    // refused", and with a floor of zero nothing is ever refused — but a bare `length <= floor` is
    // also true when a caller who opted out of the floor has hidden every column, and the panel
    // then explains a restriction that does not exist, in the sentence "At least 0 columns have to
    // stay visible."
    atMinimum: floor > 0 && resolved.visible.length <= floor,
    minVisible: floor,
    announcement,
    hideBlocked,
    canMove,
    setVisible,
    toggle,
    move,
    showAll,
    reset,
  }
}

export interface ColumnVisibilityProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange">,
    ResolveColumnOptions {
  columns: readonly ColumnDef[]
  preference?: Partial<ColumnPreference> | null
  onPreferenceChange: (next: ColumnPreference) => void
  /** Show the move controls. Defaults to `true`. */
  reorderable?: boolean
  labels?: Partial<ColumnVisibilityLabels>
  announce?: boolean
  /** Which edge the panel hangs from. Defaults to `"end"`, where a toolbar button usually sits. */
  align?: "start" | "end"
  disabled?: boolean
  triggerClassName?: string
  panelClassName?: string
}

/**
 * The "Columns" control for a table you already have: a button that opens a short panel of
 * checkboxes, one per column, with move controls to reorder them.
 *
 * ```tsx
 * const [preference, setPreference] = React.useState<ColumnPreference>(() =>
 *   parseColumnPreference(localStorage.getItem("orders.columns"))
 * )
 * const { visible } = resolveColumnPreference(COLUMNS, preference)
 *
 * <ColumnVisibility
 *   columns={COLUMNS}
 *   preference={preference}
 *   onPreferenceChange={(next) => {
 *     setPreference(next)
 *     localStorage.setItem("orders.columns", serializeColumnPreference(next))
 *   }}
 * />
 *
 * <table>
 *   <thead>
 *     <tr>{visible.map((column) => <th key={column.key}>{column.label}</th>)}</tr>
 *   </thead>
 *   <tbody>
 *     {rows.map((row) => (
 *       <tr key={row.id}>{visible.map((column) => <td key={column.key}>{row[column.key]}</td>)}</tr>
 *     ))}
 *   </tbody>
 * </table>
 * ```
 *
 * **Where the preference is kept is not this component's business.** It takes a value and emits the
 * next one; `localStorage`, a query parameter, a column on the user row — all of them are the same
 * two lines above, and the one that is right depends on whether the choice should follow the person
 * to another browser or follow the link to a colleague. A component that picked for you would have
 * picked `localStorage`, which is the one that cannot do either.
 *
 * **It is a disclosure, not a menu.** `role="menu"` is the reflex for a button that opens a list,
 * and it is wrong twice here: a menu item is one actionable thing, while every row in this panel
 * holds a checkbox and two move buttons, and a menu owns the arrow keys that those buttons need to
 * be reachable with. So the panel is a plain group of real checkboxes, Tab walks it, and nothing
 * has to be re-implemented with `aria-activedescendant` to behave like what it already is.
 *
 * **A column it will not let you hide stays a checkbox you can press.** Setting `disabled` on it is
 * tidier to look at and takes the column out of the tab order, out of the accessibility tree's
 * reach for most screen-reader cursors, and leaves no way to find out *why* — which matters because
 * the usual reason is the floor, and the floor lifts as soon as another column comes back. Here the
 * checkbox keeps its focus and its name, the press is refused, and the refusal is said out loud.
 */
export function ColumnVisibility({
  columns,
  preference,
  onPreferenceChange,
  minVisible = 1,
  reorderable = true,
  labels: labelOverrides,
  announce = true,
  align = "end",
  disabled = false,
  className,
  triggerClassName,
  panelClassName,
  ...props
}: ColumnVisibilityProps) {
  const state = useColumnVisibility({
    columns,
    preference,
    onPreferenceChange,
    minVisible,
    labels: labelOverrides,
    announce,
  })
  const labels = { ...defaultColumnVisibilityLabels, ...labelOverrides }

  const [open, setOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const baseId = React.useId()
  const panelId = `${baseId}-panel`
  const headingId = `${baseId}-heading`
  const minimumId = `${baseId}-minimum`

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Capture, so an outside press closes the panel before the thing underneath takes focus.
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open])

  const byKey = React.useMemo(
    () => new Map(state.columns.map((column) => [column.key, column])),
    [state.columns]
  )
  const hiddenSet = React.useMemo(() => new Set(state.hidden), [state.hidden])

  return (
    <div
      ref={rootRef}
      className={cn("relative inline-block", className)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault()
          close(true)
        }
      }}
      onBlur={(event) => {
        // Only when focus actually landed somewhere else on the page. `relatedTarget` is null when
        // it went to the browser's own UI or the window lost focus, and closing then would shut the
        // panel every time somebody switched to another window to check a value.
        const next = event.relatedTarget as Node | null
        if (open && next && !rootRef.current?.contains(next)) setOpen(false)
      }}
      {...props}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={labels.trigger(state.visibleCount, state.total)}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return
          setOpen((current) => !current)
        }}
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm font-medium shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          disabled ? "cursor-default opacity-50" : "hover:bg-accent hover:text-accent-foreground",
          triggerClassName
        )}
      >
        <Columns3 aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span>{labels.triggerText}</span>
        {/* Decorative: the trigger's accessible name already carries both numbers as words, and
            reading the badge as well gives "3 of 5 shown, 3/5". */}
        <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">
          {state.visibleCount}/{state.total}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-labelledby={headingId}
          className={cn(
            "absolute z-50 mt-1 w-60 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
            align === "end" ? "right-0" : "left-0",
            panelClassName
          )}
        >
          <p id={headingId} className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            {labels.heading}
          </p>
          <ul className="max-h-72 overflow-y-auto">
            {state.order.map((key) => {
              const column = byKey.get(key)
              if (!column) return null

              if (column.locked) {
                return (
                  <li
                    key={key}
                    className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
                  >
                    <Check aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate">{column.label}</span>
                    <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                    <span className="sr-only">{labels.locked}</span>
                  </li>
                )
              }

              const isHidden = hiddenSet.has(key)
              const blocked = state.hideBlocked(key)

              return (
                // Keyed by the column, never by the index: a reorder then moves this row's existing
                // node rather than rewriting the row in place, so the move button keeps the focus
                // that is on it and a second press lands on the same column. Keyed by index, focus
                // stays at that position and the next press moves whatever column arrived there.
                <li key={key} className="flex items-center gap-1 rounded-sm px-1 hover:bg-accent/50">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-1 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={!isHidden}
                      // Not `disabled`: see the note on the component. The press is refused in the
                      // handler instead, and the reason is announced.
                      aria-disabled={blocked === "minimum" || undefined}
                      aria-describedby={blocked === "minimum" ? minimumId : undefined}
                      onChange={(event) => state.setVisible(key, event.target.checked)}
                      className="size-4 shrink-0 cursor-pointer rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <span className="truncate">{column.label}</span>
                  </label>
                  {reorderable && (
                    <span className="flex shrink-0 items-center">
                      {([-1, 1] as const).map((direction) => {
                        const Icon = direction === -1 ? ArrowUp : ArrowDown
                        const can = state.canMove(key, direction)
                        return (
                          <button
                            key={direction}
                            type="button"
                            aria-label={
                              direction === -1
                                ? labels.moveUp(column.label)
                                : labels.moveDown(column.label)
                            }
                            // `aria-disabled` again, for the same reason the checkbox uses it: the
                            // top row's "earlier" button becoming unfocusable means tabbing through
                            // the panel lands on a different control for every row, and the one
                            // under your finger a moment ago has moved.
                            aria-disabled={!can || undefined}
                            onClick={() => state.move(key, direction)}
                            className={cn(
                              "rounded-sm p-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              can
                                ? "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                                : "cursor-default text-muted-foreground/30"
                            )}
                          >
                            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                          </button>
                        )
                      })}
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          {state.atMinimum && (
            <p id={minimumId} className="px-2 py-1.5 text-xs text-muted-foreground">
              {labels.minimum(state.minVisible)}
            </p>
          )}

          {(state.hidden.length > 0 || !state.isDefault) && (
            <div className="mt-1 flex items-center gap-1 border-t border-border pt-1">
              {state.hidden.length > 0 && (
                <button
                  type="button"
                  onClick={state.showAll}
                  className="flex-1 rounded-sm px-2 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {labels.showAll}
                </button>
              )}
              {!state.isDefault && (
                <button
                  type="button"
                  onClick={state.reset}
                  className="flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <RotateCcw aria-hidden="true" className="h-3 w-3" />
                  {labels.reset}
                </button>
              )}
            </div>
          )}

          {/* Polite, and emptied again a moment later — see useColumnVisibility. Hiding a column
              replaces part of the table behind the panel and moves no focus, so without this the
              only feedback is a checkbox that changed shape. */}
          <span className="sr-only" role="status" aria-live="polite">
            {state.announcement}
          </span>
        </div>
      )}
    </div>
  )
}
