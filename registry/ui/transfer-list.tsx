"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Search } from "lucide-react"

import { cn } from "@/lib/utils"

/** One row, on whichever side it currently sits. */
export interface TransferListItem {
  value: string
  label: string
  /**
   * Held where it is: shown, readable, focusable, and never moved.
   *
   * Usually the point is that somebody needs to know the thing exists and is locked — a permission
   * that comes with a role, a column the report always includes, a recipient the policy requires.
   * What a locked row must never do is get moved by a control that claims to be moving something
   * else, which is why every count and every move in this component goes through
   * {@link movableValues} and {@link transferValues} rather than over the rendered rows: "Move all
   * 10" moves ten, not the twelve that are on screen.
   */
  disabled?: boolean
}

/** Which side an item is on, and which way a move goes. */
export type TransferSide = "available" | "chosen"

/** What changed, handed to `onChange` beside the new array. */
export interface TransferChange {
  /** The side the items landed on. */
  to: TransferSide
  /** The values that moved. */
  values: string[]
}

/**
 * Splits every item into the two sides, both in the order `items` arrived in.
 *
 * This is the whole answer to the third thing that goes wrong, and it is a decision about where
 * order lives rather than a detail of rendering. The obvious implementation keeps two arrays and
 * pushes onto the destination — and then moving an item right and immediately left again puts it at
 * the bottom of the list it came from. Nothing broke, no value was lost, and the person has still
 * been punished for changing their mind: the row they were looking at is now somewhere else, the
 * rows either side of it are different, and if they were working down a long list they have lost
 * their place in it. Do it twice and the left-hand list is in an order nobody chose.
 *
 * So neither side stores an order. Both are `items` filtered, which makes the canonical order the
 * one the caller wrote — alphabetical, grouped, by frequency, whatever they sorted it by — and makes
 * a move reversible in the only sense that matters to somebody using it: everything goes back where
 * it was. Undo is free because there is nothing to undo.
 *
 * The cost is deliberate and worth being explicit about: the chosen side cannot be ordered by the
 * person. If the order of the chosen set is itself the thing being decided — the column order of a
 * table, the sequence of steps in a pipeline, the priority of a list of rules — then this is the
 * wrong control and `sortable-list` is the right one, or this one feeding it. A transfer list
 * answers *which*, not *in what order*.
 *
 * Exported because it is the rule worth asserting on its own, and because it is useful headless:
 * rendering the two sides somewhere else, or reading them in a submit handler, should not require
 * mounting anything.
 */
export function transferListSides<T extends TransferListItem>(
  items: readonly T[],
  chosen: readonly string[]
): { available: T[]; chosen: T[] } {
  const picked = new Set(chosen)
  const available: T[] = []
  const taken: T[] = []
  for (const item of items) (picked.has(item.value) ? taken : available).push(item)
  return { available, chosen: taken }
}

/**
 * The next chosen array after a move, in `items` order, carrying through values it does not know.
 *
 * Two rules live here, and the second one is the one that only shows up in production.
 *
 * The emitted order is `items` order, for the reason {@link transferListSides} gives: a `value`
 * array whose order depends on the sequence of presses is an array that changes when nothing about
 * the choice changed, and anything downstream that compares it — a dirty-form check, a `useEffect`
 * dependency, an optimistic cache, a PATCH body diffed against the server's copy — sees a change
 * and acts on it. Derived from `items` instead, the same choice is always the same array.
 *
 * And a value in `chosen` that no `item` claims is carried through untouched rather than dropped.
 * Rebuilding the array from what is on screen is the obvious implementation and it quietly discards
 * choices: the moment `items` is a page of a longer list, a filtered query from a server, or
 * anything still loading, a move on page two deletes every selection made on page one. Nothing
 * reports it — `onChange` fires with a shorter array that looks deliberate. The carried values keep
 * their relative order and sit at the front, where they are stable; a locked item named in `moving`
 * is ignored, so the lock is enforced in one place rather than at each of the four call sites.
 */
export function transferValues(
  items: readonly TransferListItem[],
  chosen: readonly string[],
  moving: readonly string[],
  to: TransferSide
): string[] {
  const known = new Set(items.map((item) => item.value))
  const picked = new Set(chosen)
  const move = new Set(moving)
  const next: string[] = chosen.filter((value) => !known.has(value))
  for (const item of items) {
    const isMoving = move.has(item.value) && !item.disabled
    const stays = to === "chosen" ? picked.has(item.value) || isMoving : picked.has(item.value) && !isMoving
    if (stays) next.push(item.value)
  }
  return next
}

/**
 * The values on this side that a move may actually take.
 *
 * Every count in this component is this function's length, which is the only way the move buttons
 * can be named truthfully — see {@link TransferListLabels.moveAll}. Call it with the rows already
 * narrowed to one side and one filter; it only takes the lock off the table.
 */
export function movableValues(items: readonly TransferListItem[]): string[] {
  const values: string[] = []
  for (const item of items) if (!item.disabled) values.push(item.value)
  return values
}

/**
 * Where the cursor goes on the side that just got shorter.
 *
 * `count` is how many rows that side was showing *before* the move, `removed` their positions, `at`
 * where the cursor was standing. The answer is a position rather than a row because the row under
 * the cursor may be the one that is no longer there — the same problem every list in this registry
 * has when it loses the thing under the cursor, and the registry answers it the same way each time:
 * `repeatable-fields` re-focuses the row that took the vacated slot, `sortable-list` re-focuses the
 * handle it moved, `split-button` restores to the half that opened the menu.
 *
 * It is worth separating this from the failure the pattern is famous for, because they look alike
 * and only one of them is a dropped focus. Press "move the selection" until a side is empty and the
 * button you are pressing is the control that can no longer do anything: given the `disabled`
 * attribute it stops being focusable while it holds focus, the browser drops focus to `<body>`, and
 * the next Tab starts again at the top of the document with a screen reader saying nothing at all.
 * That one is fixed by not using the attribute — every unavailable control here is `aria-disabled`,
 * so it keeps its tab stop and the focus it already had, and announces itself as unavailable.
 *
 * This function is the other half, which survives that fix. Moving from inside a list — Enter on a
 * selection, a double-click — leaves DOM focus on the listbox, where the thing that says "you are
 * here" is `aria-activedescendant` pointing at an option's id. The options that moved are gone from
 * this side, so the id resolves to nothing: the listbox still has focus, the ring is still drawn
 * around it, and a screen reader has nothing to read. There is no error and nothing to see, and the
 * keyboard user's position in the list is simply lost.
 *
 * The rule is one subtraction, and writing it as two rules is how it goes wrong. Rows that moved
 * were taken from somewhere, so every removed row above the cursor shifts it up by one: the new
 * position is `at` minus however many of the removed positions were above it, clamped to the end.
 * That single formula answers both of the cases people reach for separately:
 *
 *   - **the row under the cursor moved away** → the subtraction lands on the row that took its slot,
 *     so the cursor stays where it was on screen and the next press takes the next one. Moving six
 *     rows out one at a time is six presses in one place rather than six presses and five hunts for
 *     the row. Rows taken from the end clamp back onto the row that is now last.
 *   - **the row under the cursor stayed** → the subtraction follows it to its new position, which is
 *     the case a rule written only for the first one gets wrong. Move a selection of rows from the
 *     top of the list while standing further down it, and "go to the first vacated slot" yanks the
 *     cursor to the top of a list the person was reading the middle of. Nothing announces it and
 *     nothing moves on screen; the keyboard has simply lost its place for no visible reason.
 *
 * `null` means the side is empty and there is nowhere to stand. The caller leaves its stored index
 * alone: with no options rendered there is no `aria-activedescendant` to be stale, and the index is
 * clamped back onto a row when rows return.
 */
export function nextActiveAfterMove(
  count: number,
  removed: readonly number[],
  at: number
): number | null {
  const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  const positions = new Set<number>()
  for (const position of removed) {
    if (Number.isInteger(position) && position >= 0 && position < total) positions.add(position)
  }
  const remaining = total - positions.size
  if (remaining < 1) return null
  const cursor = Number.isFinite(at) ? Math.max(0, Math.floor(at)) : 0
  let above = 0
  for (const position of positions) if (position < cursor) above += 1
  return Math.min(Math.max(0, cursor - above), remaining - 1)
}

export interface TransferListLabels {
  /** The left-hand side's heading. */
  available: string
  /** The right-hand side's heading. */
  chosen: string
  /**
   * The button that moves what is selected, named by what it will move.
   *
   * An arrow is not a name. `aria-label="→"` is read as "right pointing arrow" or skipped entirely,
   * and the four controls in the middle of this widget then announce as four arrows — which says
   * there are four of them and nothing about what any one does. Worse, two of them are nearly the
   * same gesture with very different consequences: "move the three rows I picked" and "move all
   * four hundred" sit next to each other, and a person who cannot see the icons has no way to tell
   * them apart. So each is named by its effect and its count, and the count is the number that will
   * actually move — `movableValues` of what is selected *and* on screen.
   */
  moveSelected: (count: number, to: string) => string
  /** The button that moves everything on screen. `count` excludes locked rows. */
  moveAll: (count: number, to: string) => string
  /** A side's count, beside its heading. `shown` differs from `total` only while filtered. */
  count: (shown: number, total: number) => string
  /** How much of a side is selected, under its heading. Explains an unavailable move button. */
  selectedCount: (count: number) => string
  /** A side with no rows at all. */
  empty: (side: string) => string
  /** A side whose filter matches nothing. */
  noMatch: (side: string) => string
  /** The accessible name of a side's filter box. */
  search: (side: string) => string
  /**
   * Announced after a move.
   *
   * A move changes two lists at once and is not a change to any field's value, so nothing announces
   * it on its own: without this, the only evidence that pressing the button did anything is that the
   * counts on screen changed. `remaining` is what is left on the side the rows came from, which is
   * the number a person is usually watching.
   */
  moved: (count: number, to: string, from: string, remaining: number) => string
}

/**
 * The labels, built around what the two sides are called.
 *
 * A function of the two headings rather than a constant, because the headings are the two words
 * every other name in this component is built out of. "Available" and "Chosen" are right for a
 * column picker and wrong for most of the screens this ends up on, where the pair is Everyone and
 * Recipients, All permissions and Granted, Inactive and Active, Bench and Line-up. Pass the pair
 * once and every button, every count and every announcement follows — "Move 3 selected to
 * Granted", "Moved 3 to Granted, 9 left in All permissions" — and `labels` still overrides any one
 * of them, which is also how this gets translated.
 */
export function transferListLabels(available = "Available", chosen = "Chosen"): TransferListLabels {
  return {
    available,
    chosen,
    moveSelected: (count, to) =>
      count === 1 ? `Move 1 selected to ${to}` : `Move ${count} selected to ${to}`,
    moveAll: (count, to) => (count === 1 ? `Move 1 to ${to}` : `Move all ${count} to ${to}`),
    count: (shown, total) => (shown === total ? `${total}` : `${shown} of ${total}`),
    selectedCount: (count) => (count === 0 ? "None selected" : `${count} selected`),
    empty: (side) => `${side} is empty`,
    noMatch: (side) => `Nothing in ${side} matches`,
    search: (side) => `Filter ${side}`,
    moved: (count, to, from, remaining) =>
      `Moved ${count} to ${to}. ${remaining} ${remaining === 1 ? "row" : "rows"} left in ${from}.`,
  }
}

export const defaultTransferListLabels: TransferListLabels = transferListLabels()

/** Case-insensitive substring over the label, falling back to the value. */
function matching(items: readonly TransferListItem[], query: string): TransferListItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...items]
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle)
  )
}

/** A stored cursor position made safe for a list that has changed length under it. */
function clampIndex(index: number, length: number): number {
  if (length < 1) return 0
  if (!Number.isFinite(index) || index < 0) return 0
  return Math.min(Math.floor(index), length - 1)
}

export interface TransferListProps
  extends Omit<
    React.ComponentPropsWithoutRef<"div">,
    "children" | "value" | "defaultValue" | "onChange"
  > {
  /**
   * Every row, on either side, in the order both sides are shown in.
   *
   * The canonical order lives here and nowhere else — see {@link transferListSides}. Sort it however
   * the screen wants to read; a row moved and moved back lands where it started.
   */
  items: readonly TransferListItem[]
  /** The values on the chosen side, controlled. Pair with `onChange`. */
  value?: readonly string[]
  /** What an uncontrolled list starts with on the chosen side. */
  defaultValue?: readonly string[]
  /** Told the whole next array and which values went where. */
  onChange?: (next: string[], change: TransferChange) => void
  /** A heading for the pair, wired to the group with `aria-labelledby`. */
  label?: React.ReactNode
  /** A line under the heading, wired to the group with `aria-describedby`. */
  description?: React.ReactNode
  /**
   * A filter box on each side. On by default.
   *
   * On past a dozen rows a transfer list is unusable without one, which is why it is the default
   * here and `searchable={false}` is the short-list case — the same way round as `multi-select`,
   * whose search is on unless `hideSearch` turns it off.
   *
   * A filter narrows its side for every purpose, and that is the whole of the rule: the count beside
   * the heading, the count in each move button's name, and what a press actually moves are all the
   * rows on screen. Nothing you cannot see is ever moved — which is the only way "Move all 12" can
   * be trusted on a list of four hundred. The one thing that outlives a filter is a selection: rows
   * you picked and then filtered away stay picked and come back when you clear it, because losing a
   * deliberate selection to a keystroke in a search box is worse than keeping one that is out of
   * sight, and the counts never claim otherwise.
   */
  searchable?: boolean
  /** Submits the chosen values with an ordinary form POST, as one hidden input per value. */
  name?: string
  /**
   * The id of the form the hidden inputs belong to, when they do not sit inside it.
   *
   * Needed for the same reason `masked-input` needs it: what submits here is the hidden inputs, and
   * a hidden input left without `form` stays with whichever ancestor it happens to be under. A
   * transfer list rendered in a dialog, a portal or a sidebar — anywhere outside the `<form>` it
   * belongs to — then has its values submitted by the wrong form or by none, and nothing reports it.
   */
  form?: string
  /** The whole control unavailable. Both listboxes leave the tab order; no move can be made. */
  disabled?: boolean
  /** The left-hand heading, and the word every name on that side is built from. Default `"Available"`. */
  availableLabel?: string
  /** The right-hand heading. Default `"Chosen"`. */
  chosenLabel?: string
  labels?: Partial<TransferListLabels>
  className?: string
  /** Both listboxes — this is where their height comes from. */
  listClassName?: string
  optionClassName?: string
  /** All four move buttons. */
  buttonClassName?: string
}

/**
 * Two lists side by side and the controls that move rows between them.
 *
 * For every screen whose question is *which of these*, where the answer is long enough that seeing
 * what is in and what is out at the same time beats a dropdown: permissions, scopes and API-token
 * access on an admin screen, assigning roles or groups to a user, picking the members of a team,
 * project or channel, choosing which columns a table or report shows, building the recipient list of
 * an email, notification or invite, selecting which metrics a dashboard plots, which fields an
 * export or integration syncs, which locations, stores or warehouses a rule covers, which tags or
 * categories hang off a post or product, moving players between a squad and a bench, and the
 * "applies to" of any policy, coupon or automation.
 *
 * Both sides are real multi-select listboxes — one tab stop each, arrows to move the cursor, Space
 * to pick, Enter to move what is picked, Home and End, Ctrl/Cmd+A for everything on screen, and a
 * double-click to send one row across on its own. Four buttons in the middle move the selection or
 * everything, in either direction, and each is named by what it will actually move.
 *
 * Five things go wrong in the version everybody writes first, and four of them are invisible to a
 * mouse:
 *
 *   - **Where the cursor goes after a move.** Two different failures wear the same face. Empty a
 *     side with the button you are holding and that button can no longer act: given the `disabled`
 *     attribute it stops being focusable while focused, so the browser drops focus to `<body>` and
 *     the next Tab restarts at the top of the page. Every unavailable control here is
 *     `aria-disabled` instead, so it keeps its tab stop, its focus and its ability to say it is
 *     unavailable. Move from inside a list, though, and focus never left the listbox — what is lost
 *     is `aria-activedescendant`, pointing at an option that is now on the other side. See
 *     {@link nextActiveAfterMove}.
 *   - **The two sides are listboxes, not checkboxes.** `aria-multiselectable` with `aria-selected`
 *     on every option is a list of things of which several are chosen; a column of checkboxes is a
 *     column of independent controls, one tab stop each, announced one at a time with no sense of
 *     how many there are or how much of the list is picked. The pattern also has to be complete to
 *     be worth anything: an `aria-activedescendant` that does not move with the arrows, or options
 *     with no `aria-selected`, is a listbox in name only.
 *   - **The order rows come back in.** Push onto the destination and a row moved right then left
 *     lands at the bottom of the list it came from, so changing your mind rearranges the thing you
 *     were reading. Both sides are `items` filtered — see {@link transferListSides} — and the
 *     emitted array is in that order too, so the same choice is always the same array.
 *   - **The names of the move buttons.** Four arrows announce as four arrows, and two of them are
 *     "move the three I picked" and "move all four hundred". Each is named for its effect and its
 *     true count — see {@link TransferListLabels.moveSelected}.
 *   - **Both empty states.** An empty side is the one place a transfer list has to keep talking: its
 *     listbox stays in the tab order so it can still be found and still be moved into, and it says
 *     whether it is empty or merely filtered to nothing, which are not the same problem.
 *
 * A move is also announced through a polite live region, because it changes two lists at once and no
 * field's value: without it, the only evidence a press did anything is that two numbers on screen
 * changed. Values in `value` that no `item` claims are carried through a move untouched, so a
 * paginated or lazily loaded `items` does not silently drop choices made on another page.
 *
 * Official shadcn/ui has nothing of this kind — `TransferList`, `dualListbox`, `selectedItems` and
 * `aria-multiselectable` are all zero hits across its 62 fetchable components, and so is
 * `role="listbox"`, Radix owning that markup inside `select` and `combobox`. Within this registry,
 * `multi-select` picks from a list inside one field and `nested-checkbox` selects from a hierarchy;
 * both answer *which* without showing the two sets at once, which is the thing this is for.
 */
export function TransferList({
  items,
  value,
  defaultValue,
  onChange,
  label,
  description,
  searchable = true,
  name,
  form,
  disabled,
  availableLabel,
  chosenLabel,
  labels: labelOverrides,
  className,
  listClassName,
  optionClassName,
  buttonClassName,
  ...props
}: TransferListProps) {
  const labels = React.useMemo(
    () => ({ ...transferListLabels(availableLabel, chosenLabel), ...labelOverrides }),
    [availableLabel, chosenLabel, labelOverrides]
  )
  const baseId = React.useId()
  const labelId = `${baseId}-label`
  const descriptionId = `${baseId}-description`

  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<string[]>(() => [...(defaultValue ?? [])])
  const chosenValues: readonly string[] = controlled ? value : internal

  /**
   * One selection across both sides, intersected with a side when it is used.
   *
   * Not two sets, and not a flag on each item: a row can only be on one side at a time, so which
   * side a selected value belongs to is already known from `value` and does not need storing beside
   * it. Two stores would be two things to keep in step every time a row moves, `items` changes, or a
   * caller rewrites `value` from the outside — and the one that drifts is the one that decides what
   * a button moves. Moved values are dropped from it, so a row does not arrive on the far side
   * already picked, pre-arming the button that would send it straight back.
   */
  const [selected, setSelected] = React.useState<readonly string[]>([])
  const [query, setQuery] = React.useState<Record<TransferSide, string>>({
    available: "",
    chosen: "",
  })
  const [active, setActive] = React.useState<Record<TransferSide, number>>({
    available: 0,
    chosen: 0,
  })
  const [message, setMessage] = React.useState("")

  const listRefs = {
    available: React.useRef<HTMLDivElement | null>(null),
    chosen: React.useRef<HTMLDivElement | null>(null),
  }

  const sides = React.useMemo(() => transferListSides(items, chosenValues), [items, chosenValues])
  const visible: Record<TransferSide, TransferListItem[]> = React.useMemo(
    () => ({
      available: matching(sides.available, query.available),
      chosen: matching(sides.chosen, query.chosen),
    }),
    [sides, query]
  )
  const selectedSet = React.useMemo(() => new Set(selected), [selected])

  // Clamped at render rather than when the lists change: the stored index is a cursor, and every
  // filter keystroke, every move and every change to `items` from outside can leave it past the end.
  // Clamping here means there is one place it can be wrong, instead of one place per cause.
  const activeIndex: Record<TransferSide, number> = {
    available: clampIndex(active.available, visible.available.length),
    chosen: clampIndex(active.chosen, visible.chosen.length),
  }

  /** What a press on each button moves — and, through its count, what each button is called. */
  const selectedMovable: Record<TransferSide, string[]> = {
    available: movableValues(visible.available.filter((item) => selectedSet.has(item.value))),
    chosen: movableValues(visible.chosen.filter((item) => selectedSet.has(item.value))),
  }
  const allMovable: Record<TransferSide, string[]> = {
    available: movableValues(visible.available),
    chosen: movableValues(visible.chosen),
  }

  /**
   * Keeps the cursor visible when the keyboard moves it.
   *
   * Gated on a ref set by the key handler, so arriving at a page with this on it does not scroll
   * anything: an effect keyed on the active index alone runs on mount, and would pull the viewport
   * to a list the person has not touched. Found by `data-active` rather than by the option's id,
   * because `useId` returns a value with colons in it — `#:r1:-available-opt-0` is not a selector
   * and `querySelector` throws on it rather than returning null.
   */
  const scrollWanted = React.useRef(false)
  const scrollSide = React.useRef<TransferSide>("available")
  React.useEffect(() => {
    if (!scrollWanted.current) return
    scrollWanted.current = false
    const list = listRefs[scrollSide.current].current
    const option = list?.querySelector?.('[data-active="true"]') as HTMLElement | null
    option?.scrollIntoView?.({ block: "nearest" })
  }, [activeIndex.available, activeIndex.chosen])

  const commit = (next: string[], change: TransferChange) => {
    if (!controlled) setInternal(next)
    onChange?.(next, change)
  }

  function move(from: TransferSide, values: readonly string[]) {
    if (disabled || values.length === 0) return
    const to: TransferSide = from === "available" ? "chosen" : "available"
    const moving = new Set(values)
    commit(transferValues(items, chosenValues, values, to), { to, values: [...values] })
    setSelected((prev) => prev.filter((value) => !moving.has(value)))
    // Positions in the rendered list, which is what `aria-activedescendant` indexes into — not
    // positions in `items`, and not in the unfiltered side.
    const source = visible[from]
    const removed: number[] = []
    source.forEach((item, index) => {
      if (moving.has(item.value)) removed.push(index)
    })
    const at = nextActiveAfterMove(source.length, removed, activeIndex[from])
    if (at !== null) setActive((prev) => ({ ...prev, [from]: at }))
    setMessage(
      labels.moved(values.length, labels[to], labels[from], sides[from].length - values.length)
    )
  }

  function toggle(side: TransferSide, item: TransferListItem) {
    if (disabled || item.disabled) return
    setSelected((prev) =>
      prev.includes(item.value) ? prev.filter((value) => value !== item.value) : [...prev, item.value]
    )
  }

  function moveCursor(side: TransferSide, index: number) {
    scrollSide.current = side
    scrollWanted.current = true
    setActive((prev) => ({ ...prev, [side]: index }))
  }

  function onKeyDown(side: TransferSide, event: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return
    const rows = visible[side]
    const at = activeIndex[side]
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return
      event.preventDefault()
      const next = clampIndex(at + (event.key === "ArrowDown" ? 1 : -1), rows.length)
      moveCursor(side, next)
      // Shift extends by adding, never by removing. A true anchored range has to deselect on the way
      // back, which needs an anchor that survives every click, filter keystroke and move in between —
      // and when it does not survive, the thing it silently throws away is a selection somebody made
      // on purpose. Additive is predictable and loses nothing; Space is how a row comes back off.
      if (event.shiftKey) {
        const item = rows[next]
        if (item && !item.disabled) {
          setSelected((prev) => (prev.includes(item.value) ? prev : [...prev, item.value]))
        }
      }
      return
    }
    if (event.key === "Home" || event.key === "End") {
      if (rows.length === 0) return
      event.preventDefault()
      moveCursor(side, event.key === "Home" ? 0 : rows.length - 1)
      return
    }
    if (event.key === " ") {
      if (rows.length === 0) return
      // Or the page scrolls under the list, which is the one key press a listbox must not let through.
      event.preventDefault()
      const item = rows[at]
      if (item) toggle(side, item)
      return
    }
    if (event.key === "Enter") {
      if (rows.length === 0) return
      event.preventDefault()
      const picked = selectedMovable[side]
      if (picked.length > 0) {
        move(side, picked)
        return
      }
      // Nothing picked: Enter moves the row under the cursor, so a one-row move is one key press
      // rather than Space-then-Enter.
      const item = rows[at]
      if (item && !item.disabled) move(side, [item.value])
      return
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A")) {
      if (rows.length === 0) return
      event.preventDefault()
      const all = allMovable[side]
      setSelected((prev) => [...prev, ...all.filter((value) => !prev.includes(value))])
    }
  }

  function moveButton(from: TransferSide, scope: "selected" | "all") {
    const to: TransferSide = from === "available" ? "chosen" : "available"
    const values = scope === "selected" ? selectedMovable[from] : allMovable[from]
    const can = !disabled && values.length > 0
    const Icon =
      scope === "all"
        ? to === "chosen"
          ? ChevronsRight
          : ChevronsLeft
        : to === "chosen"
          ? ChevronRight
          : ChevronLeft
    return (
      <button
        type="button"
        aria-label={
          scope === "selected"
            ? labels.moveSelected(values.length, labels[to])
            : labels.moveAll(values.length, labels[to])
        }
        // aria-disabled, never the attribute: this is the control most likely to be holding focus at
        // the moment it becomes unavailable — emptying a side is what makes it unavailable — and the
        // attribute would drop that focus to `<body>`. `pointer-events-none` stops the press; the
        // handler checks too, because a keyboard press is not a pointer event.
        aria-disabled={!can || undefined}
        aria-controls={`${baseId}-${from}-list ${baseId}-${to}-list`}
        // When it cannot act, point at the count on screen that says why.
        aria-describedby={!can && scope === "selected" ? `${baseId}-${from}-count` : undefined}
        onClick={() => move(from, values)}
        className={cn(
          "inline-flex size-8 flex-none items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          can
            ? "hover:bg-accent hover:text-accent-foreground"
            : "pointer-events-none opacity-50",
          buttonClassName
        )}
      >
        {/* Stacked on a narrow screen the destination is below or above, not beside: the icons turn
            with the layout so they keep pointing at it. Decorative either way — the name is the name. */}
        <Icon aria-hidden="true" className="size-4 rotate-90 sm:rotate-0" />
      </button>
    )
  }

  function renderSide(side: TransferSide) {
    const rows = visible[side]
    const sideName = labels[side]
    const headingId = `${baseId}-${side}-heading`
    const listId = `${baseId}-${side}-list`
    const countId = `${baseId}-${side}-count`
    const emptyId = `${baseId}-${side}-empty`
    const at = activeIndex[side]
    const filtered = query[side].trim().length > 0
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span id={headingId} className="text-sm font-medium">
            {sideName}
          </span>
          {/* Shown rather than total while filtered, so "12" never sits over three visible rows. */}
          <span className="text-xs tabular-nums text-muted-foreground">
            {labels.count(rows.length, sides[side].length)}
          </span>
        </div>

        {searchable ? (
          <div className="relative mb-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={query[side]}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value
                setQuery((prev) => ({ ...prev, [side]: next }))
              }}
              aria-label={labels.search(sideName)}
              aria-controls={listId}
              className={cn(
                "h-8 w-full rounded-md border border-input bg-background pl-7 pr-2 text-sm",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50"
              )}
            />
          </div>
        ) : null}

        <div
          ref={listRefs[side]}
          id={listId}
          role="listbox"
          aria-multiselectable="true"
          aria-labelledby={headingId}
          aria-describedby={rows.length === 0 ? emptyId : countId}
          aria-disabled={disabled || undefined}
          // Kept in the tab order while empty — on purpose. A side that drops out when it empties is
          // a side that cannot be found again by keyboard, and the empty one is exactly where
          // somebody is about to move rows to.
          tabIndex={disabled ? -1 : 0}
          aria-activedescendant={rows.length > 0 ? `${baseId}-${side}-opt-${at}` : undefined}
          onKeyDown={(event) => onKeyDown(side, event)}
          className={cn(
            "h-48 overflow-y-auto rounded-md border border-input bg-background p-1",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            disabled && "opacity-50",
            listClassName
          )}
        >
          {rows.length === 0 ? (
            // Not an option, so it stays out of the listbox's owned children — and the two reasons a
            // side can be empty are different problems, so they do not share a sentence.
            <p id={emptyId} role="presentation" className="px-2 py-4 text-center text-sm text-muted-foreground">
              {filtered ? labels.noMatch(sideName) : labels.empty(sideName)}
            </p>
          ) : null}
          {rows.map((item, index) => {
            const isSelected = selectedSet.has(item.value)
            return (
              <div
                key={item.value}
                id={`${baseId}-${side}-opt-${index}`}
                role="option"
                // Always present, true or false: in a multiselectable listbox the absence of
                // aria-selected means "not selectable", which is a different list than this one.
                aria-selected={isSelected}
                aria-disabled={item.disabled || undefined}
                data-active={index === at ? "true" : undefined}
                // Focus belongs to the listbox, not to the row: this is the activedescendant pattern,
                // and a click that left focus where it was would leave the arrow keys dead.
                onPointerDown={(event) => {
                  event.preventDefault()
                  listRefs[side].current?.focus?.()
                }}
                onClick={() => {
                  moveCursor(side, index)
                  toggle(side, item)
                }}
                // The row under the pointer, never the selection — a double-click is a gesture about
                // one row, and the two clicks inside it cancel out on the way through `toggle`.
                onDoubleClick={() => {
                  if (!item.disabled) move(side, [item.value])
                }}
                className={cn(
                  "flex cursor-pointer select-none items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm",
                  isSelected && "bg-accent text-accent-foreground",
                  index === at && "ring-1 ring-inset ring-ring",
                  item.disabled && "cursor-not-allowed opacity-50",
                  optionClassName
                )}
              >
                <span className="truncate">{item.label}</span>
              </div>
            )
          })}
        </div>

        <p id={countId} className="mt-1 text-xs text-muted-foreground">
          {labels.selectedCount(selectedMovable[side].length)}
        </p>
      </div>
    )
  }

  const describedBy =
    [props["aria-describedby"], description ? descriptionId : null].filter(Boolean).join(" ") ||
    undefined
  const labelledBy =
    [props["aria-labelledby"], label ? labelId : null].filter(Boolean).join(" ") || undefined

  return (
    // Spread first, so a caller's aria-describedby is merged above rather than quietly replacing the
    // description this renders.
    <div {...props} role="group" aria-labelledby={labelledBy} aria-describedby={describedBy} className={cn("min-w-0", className)}>
      {label ? (
        <p id={labelId} className="mb-1 text-base font-medium">
          {label}
        </p>
      ) : null}
      {description ? (
        <p id={descriptionId} className="mb-3 text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {renderSide("available")}
        <div className="flex flex-row items-center justify-center gap-1 sm:flex-col">
          {moveButton("available", "selected")}
          {moveButton("available", "all")}
          {moveButton("chosen", "all")}
          {moveButton("chosen", "selected")}
        </div>
        {renderSide("chosen")}
      </div>

      {/*
        `disabled` is mirrored onto these, because what submits is the hidden inputs and not anything
        on screen. The browser leaves a disabled control out of the form data; a hidden input that
        was never told it is disabled is not left out — so a transfer list greyed out precisely
        because its values are not being collected submits them anyway, and the handler receives a
        set of columns, permissions or recipients the person could not have chosen. The same bug was
        found in `masked-input`, which is where the wording comes from.
      */}
      {name
        ? chosenValues.map((chosenValue) => (
            <input
              key={chosenValue}
              type="hidden"
              name={name}
              value={chosenValue}
              disabled={disabled}
              form={form}
            />
          ))
        : null}

      {/* A move changes two lists and no field's value, so nothing else here announces it. */}
      <div aria-live="polite" className="sr-only">
        {message}
      </div>
    </div>
  )
}
