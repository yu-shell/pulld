"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Where focus goes after a row is removed.
 *
 * `count` is how many rows there were *before* the removal, `removed` the position that went. The
 * answer is a position rather than an element because the element the person was standing on is the
 * one that no longer exists: a browser does not move focus when the node holding it is removed, it
 * drops focus to `<body>`, and from there the next Tab starts again at the top of the page and a
 * screen reader says nothing at all. Every other component in this registry that removes the thing
 * under the cursor has the same rule — `split-button` restores to the half that opened the menu,
 * `sortable-list` re-focuses the handle it just moved — and this is that rule for a list that got
 * shorter.
 *
 * Three cases, and the middle one is the only one people get right by accident:
 *
 *   - rows remain and a row took the vacated slot → that row, so the cursor stays where it was on
 *     screen and the next press removes the next one. Walking a list of six down to one is then six
 *     presses in one place rather than six presses and five hunts for the button.
 *   - the last row went, so nothing moved up → the row now last, which is the one above it.
 *   - nothing is left → the add button, the only control still on screen.
 *
 * Exported because it is the part worth asserting on its own: the same decision in a browser is
 * three lines of DOM calls, and a test of those can only say that *something* was focused.
 */
export type RepeatableFocusTarget = { kind: "row"; index: number } | { kind: "add" }

export function nextFocusAfterRemove(count: number, removed: number): RepeatableFocusTarget {
  const total = Number.isFinite(count) ? Math.floor(count) : 0
  const at = Number.isFinite(removed) ? Math.floor(removed) : 0
  const remaining = total - 1
  if (remaining < 1) return { kind: "add" }
  // Clamped on both sides: `removed` arrives from a handler on a row that is already gone, and a
  // position past the end would point the focus effect at a ref holding nothing.
  if (at < 0) return { kind: "row", index: 0 }
  if (at >= remaining) return { kind: "row", index: remaining - 1 }
  return { kind: "row", index: at }
}

/**
 * Keeps one key per row across changes the component did not make, matching rows by identity.
 *
 * This is the whole of the bug the pattern is famous for, and it is worth being precise about what
 * the bug *is*, because the usual summary — "don't use the index as a key" — describes the fix and
 * not the failure. React uses the key to decide which previously rendered row a row corresponds to.
 * Keyed by position, deleting the second of three rows means the row that was third is now second,
 * so React matches it to the second row's DOM nodes and keeps them: the `<input>` elements are
 * reused in place, and an input's text is DOM state, not something React re-renders. The value the
 * person typed in row 3 is then sitting in row 2's box. Nothing throws and nothing looks broken —
 * the row count is right, every box has text in it — and what the person sees is **the row they
 * deleted having eaten the row below it**. Uncontrolled inputs lose the value outright; controlled
 * ones recover on the next render, but the caret, the selection, the scroll position, the validation
 * state and anything a `ref` is holding do not.
 *
 * So identity has to come from somewhere that is not the position, and the component mints it rather
 * than asking for it. Requiring an `id` on each row — which is what `sortable-list` does, and right
 * for it — would be wrong here: these rows are form values, they get submitted, and a synthetic id
 * the caller has to add on the way in and strip on the way out is the kind of chore that gets
 * skipped. `react-hook-form`'s `useFieldArray` keeps its `id` outside the field values for exactly
 * this reason.
 *
 * Minted keys then have to survive the caller replacing the array, which is the case this function
 * exists for. Matching is by object identity, consuming each previous row as it is claimed, because
 * the ordinary ways a caller rewrites a list — `rows.filter(...)`, a reorder, an append — all
 * preserve the identity of the rows they keep. A row that matches nothing is new and gets a fresh
 * key. The one thing that defeats it is a caller that rebuilds every row object on every render
 * (`rows.map((r) => ({ ...r }))`), and nothing could have helped there: every row is new by then, so
 * the information needed to pair them up no longer exists.
 *
 * Returns `prevKeys` itself when nothing changed, which is not an optimisation but the thing that
 * stops the render-time reconcile below from looping forever on a caller who passes a freshly built
 * array of the same rows every render.
 */
export function alignRowKeys<T>(
  rows: readonly T[],
  prevRows: readonly T[],
  prevKeys: readonly string[],
  mint: () => string
): readonly string[] {
  const claimed = new Array<boolean>(prevRows.length).fill(false)
  const next: string[] = []
  let changed = rows.length !== prevKeys.length
  for (let i = 0; i < rows.length; i++) {
    let found = -1
    for (let j = 0; j < prevRows.length; j++) {
      if (!claimed[j] && prevRows[j] === rows[i]) {
        found = j
        break
      }
    }
    if (found >= 0 && found < prevKeys.length) {
      claimed[found] = true
      next.push(prevKeys[found])
      if (prevKeys[found] !== prevKeys[i]) changed = true
    } else {
      next.push(mint())
      changed = true
    }
  }
  return changed ? next : prevKeys
}

/**
 * The selector for "the field a person would start typing in".
 *
 * Read with `querySelector`, so it answers with the first match in document order — which is why the
 * remove button is rendered *after* the row's fields rather than before them. Put it first and the
 * row a person just added would open with focus on the button that deletes it.
 *
 * `:not([disabled])` matters on each entry rather than once: a row whose first field is conditionally
 * unavailable should hand focus to the second, and a disabled element cannot take focus anyway, so
 * matching one means asking for a focus that silently does not happen.
 */
export const REPEATABLE_FIELD_SELECTOR =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), button:not([disabled]), [href], ' +
  '[contenteditable="true"], [tabindex]:not([tabindex="-1"])'

export interface RepeatableFieldsLabels {
  /** The add button's visible text, and its accessible name. */
  add: string
  /**
   * A row's remove button, named by the row it removes.
   *
   * `(position, total)` rather than a fixed string because n rows means n remove buttons, and a
   * screen reader reading them out gives "Remove, Remove, Remove" — which says how many there are
   * and nothing about which is which. Naming them "Remove row 2 of 3" is the difference between a
   * list you can edit without looking and one you cannot.
   */
  remove: (position: number, total: number) => string
  /** A row's own accessible name, announced on entering it. */
  row: (position: number, total: number) => string
  /** Announced after a row is added. `total` counts the new row. */
  added: (position: number, total: number) => string
  /** Announced after a row is removed. `total` is what is left. */
  removed: (position: number, total: number) => string
  /** Shown and announced when no more rows may be added. */
  atMax: (max: number) => string
  /** Shown and announced when no more rows may be removed. */
  atMin: (min: number) => string
}

/**
 * The labels, built around what one row is called.
 *
 * A function of `noun` rather than a constant because the accessible names are the whole
 * accessibility story of this component and "row" is almost never the word: the thing being repeated
 * is a variable, a recipient, a line item, a phone number. One prop moves every name at once —
 * "Add another variable", "Remove variable 2 of 3" — and `labels` still overrides any of them
 * individually, which is also how this gets translated.
 */
export function repeatableFieldsLabels(noun = "row"): RepeatableFieldsLabels {
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  return {
    add: `Add another ${noun}`,
    remove: (position, total) => `Remove ${noun} ${position} of ${total}`,
    row: (position, total) => `${Noun} ${position} of ${total}`,
    added: (position, total) => `Added ${noun} ${position} of ${total}`,
    removed: (position, total) =>
      total > 0 ? `Removed ${noun} ${position}, ${total} remaining` : `Removed the last ${noun}`,
    atMax: (max) => `Maximum of ${max}`,
    atMin: (min) => (min === 1 ? `At least one ${noun} is required` : `At least ${min} required`),
  }
}

export const defaultRepeatableFieldsLabels: RepeatableFieldsLabels = repeatableFieldsLabels()

/** What changed, handed to `onChange` beside the new array. */
export type RepeatableChange =
  | { type: "add"; index: number }
  | { type: "remove"; index: number }
  | { type: "update"; index: number }

export interface RepeatableRowRenderArgs<T> {
  /** This row's value. */
  row: T
  /** Its position, from 0. */
  index: number
  /** How many rows there are. */
  total: number
  /**
   * A stable, unique id for this row — the same string for as long as the row exists, and never
   * reused.
   *
   * It is the component's row key, handed over because a row of fields needs per-row DOM ids of its
   * own: `<label htmlFor={`${rowId}-key`}>` is how a label in row 2 points at the input in row 2
   * rather than at row 1's. Built from `useId`, so it is stable across server and client renders.
   */
  rowId: string
  /** Replace this row's value. */
  update: (next: T) => void
  /** Remove this row. A no-op at `min`. */
  remove: () => void
  /** Whether removing is allowed right now — `false` at `min`, or when the set is disabled. */
  canRemove: boolean
}

export interface RepeatableFieldsProps<T>
  extends Omit<
    React.ComponentPropsWithoutRef<"fieldset">,
    "children" | "value" | "defaultValue" | "onChange"
  > {
  /** The rows, controlled. Pair with `onChange`. */
  value?: readonly T[]
  /** The rows a new, uncontrolled set starts with. */
  defaultValue?: readonly T[]
  /** Told the whole new array, and which row changed. */
  onChange?: (next: T[], change: RepeatableChange) => void
  /**
   * Makes a blank row.
   *
   * Called once per press of the add button. Return a fresh object each time — returning one shared
   * object makes every row the same object, and then editing any of them edits all of them.
   */
  newRow: () => T
  /** Renders one row's fields. The remove button is added after whatever this returns. */
  children: (args: RepeatableRowRenderArgs<T>) => React.ReactNode
  /** The set's visible heading, in a real `<legend>`. */
  legend?: React.ReactNode
  /** A line under the legend, wired to the group with `aria-describedby`. */
  description?: React.ReactNode
  /** Shown in place of the rows when there are none. */
  emptyMessage?: React.ReactNode
  /**
   * The fewest rows that may remain. Gates the remove button; it does not add rows to reach the
   * floor — pass a `defaultValue` of the length you want to start at.
   */
  min?: number
  /** The most rows that may be added. */
  max?: number
  /**
   * The whole set unavailable.
   *
   * Goes on the `<fieldset>`, so the browser disables every control inside it — the caller's fields
   * included, without them having to thread a prop down.
   */
  disabled?: boolean
  /** What one row is called, used to build every accessible name. Default `"row"`. */
  noun?: string
  /** Overrides `labels.add` alone, which is the one most often reworded. */
  addLabel?: React.ReactNode
  labels?: Partial<RepeatableFieldsLabels>
  className?: string
  rowClassName?: string
  addButtonClassName?: string
  removeButtonClassName?: string
}

/**
 * A set of identical field rows, with "add another" and a remove button on each.
 *
 * For every form that takes a list rather than a value: work history and education, the line items
 * of an invoice or quote, environment variables and their values, several emails, phone numbers or
 * addresses on a contact, the headers or query parameters of an API request, a product's variants,
 * the options of a question being written, team members being invited, redirect URIs, webhook
 * endpoints, ingredients in a recipe, authors on a paper.
 *
 * The caller renders the fields; this owns the list. Which means it owns the five things that go
 * wrong, every one of which is invisible to a pointer and obvious to a keyboard:
 *
 *   - **Focus after adding.** A new row whose fields nobody is standing in is a row the person has
 *     to go and find: focus stays on the add button, and the way to the new row is one Tab per field
 *     in every row above it. Focus moves to the new row's first field here, so adding and typing are
 *     one gesture — see {@link REPEATABLE_FIELD_SELECTOR} for how the field is found, and why the
 *     remove button is rendered last.
 *   - **Focus after removing.** The button that was just pressed no longer exists, and a browser
 *     drops focus to `<body>` rather than moving it. See {@link nextFocusAfterRemove}.
 *   - **Row identity.** Keyed by position, deleting a row makes the row below it appear to inherit
 *     its values. See {@link alignRowKeys}; this mints a key per row and keeps it.
 *   - **Naming the remove buttons.** n of them called "Remove" say nothing about which row they
 *     take. See {@link RepeatableFieldsLabels.remove}.
 *   - **The floor and the ceiling.** `min` and `max` are `aria-disabled` rather than the `disabled`
 *     attribute, so the control keeps its place in the tab order and a person arriving at it is told
 *     it is unavailable — rather than finding that the button has silently gone, or worse, that it is
 *     there and does nothing. The reason is on screen too, wired up with `aria-describedby`.
 *
 * Adding and removing are also announced through a polite live region, because neither is a change
 * to any field's value: without it the only evidence a row appeared is that focus moved, which says
 * where you are and not what happened.
 *
 * The outer element is a real `<fieldset>` with a real `<legend>`. Official shadcn/ui's `field`
 * ships `FieldSet`, `FieldLegend` and `FieldGroup` and they are exactly this shell — a styled
 * `<fieldset>`, a styled `<legend>`, a flex column — with no notion of a row being added or taken
 * away (`add` and `remove` are zero hits in its source). So the shell is the part that already
 * exists, and it is deliberately not a dependency: it is nine lines of flexbox, and this component
 * is the behaviour that goes inside it. A project that has installed `field` can hand this
 * component's `className` the same classes and the two sit side by side.
 */
export function RepeatableFields<T>({
  value,
  defaultValue,
  onChange,
  newRow,
  children,
  legend,
  description,
  emptyMessage,
  min = 0,
  max,
  disabled,
  noun = "row",
  addLabel,
  labels: labelOverrides,
  className,
  rowClassName,
  addButtonClassName,
  removeButtonClassName,
  ...props
}: RepeatableFieldsProps<T>) {
  const labels = React.useMemo(
    () => ({ ...repeatableFieldsLabels(noun), ...labelOverrides }),
    [noun, labelOverrides]
  )
  const baseId = React.useId()
  const descriptionId = `${baseId}-description`
  const maxHintId = `${baseId}-max`
  const minHintId = `${baseId}-min`

  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<T[]>(() => [...(defaultValue ?? [])])
  const rows: readonly T[] = controlled ? value : internal

  // Monotonic, so a key is never reused even after the row that had it is gone: React matching a new
  // row to a removed row's nodes is the same bug as matching it by position.
  const keySeed = React.useRef(0)
  const mint = React.useCallback(() => `${baseId}-r${keySeed.current++}`, [baseId])

  /**
   * One key per row, reconciled during render rather than in an effect.
   *
   * An effect runs after the commit, so the render in which a row first appears would have no key
   * for it — and the only thing available to key it by at that moment is its position, which is the
   * bug. Adjusting state during render is React's own answer for state that has to agree with props
   * (it re-renders immediately, before anything is shown), and the guard is `alignRowKeys` returning
   * its input unchanged: without that, a caller passing a freshly built array every render would set
   * state on every render forever.
   *
   * The previous rows live in a ref rather than in state for the same reason — it is a note of what
   * was last seen, not something the UI is derived from, and putting it in state would make every
   * new array reference a re-render whether or not any key changed.
   */
  const [keys, setKeys] = React.useState<readonly string[]>(() => rows.map(() => mint()))
  const seenRows = React.useRef(rows)
  let rowKeys = keys
  if (seenRows.current !== rows) {
    rowKeys = alignRowKeys(rows, seenRows.current, keys, mint)
    seenRows.current = rows
    if (rowKeys !== keys) setKeys(rowKeys)
  }

  const total = rows.length
  const atMax = max !== undefined && total >= max
  const atMin = total <= min
  const canAdd = !disabled && !atMax
  const canRemove = !disabled && !atMin

  const [message, setMessage] = React.useState("")

  const rowRefs = React.useRef<Array<React.RefObject<HTMLDivElement | null>>>([])
  const rowRef = (index: number) => {
    while (rowRefs.current.length <= index) {
      rowRefs.current.push(React.createRef<HTMLDivElement>())
    }
    return rowRefs.current[index]
  }
  const addRef = React.useRef<HTMLButtonElement | null>(null)

  /**
   * Where focus is owed, if anywhere.
   *
   * State rather than a call inside the click handler, because the row to focus does not exist yet
   * when the handler runs: adding sets the array and the row is rendered by the commit that follows.
   * Cleared as soon as it is spent, so an unrelated re-render — a parent's state, a validation
   * message arriving — does not pull focus back into the list.
   */
  const [pendingFocus, setPendingFocus] = React.useState<RepeatableFocusTarget | null>(null)

  React.useEffect(() => {
    if (!pendingFocus) return
    setPendingFocus(null)
    if (pendingFocus.kind === "add") {
      addRef.current?.focus?.()
      return
    }
    // Bounded by the live count: `value` is a prop and can shrink again before this runs, and a ref
    // past the end holds nothing.
    if (pendingFocus.index < 0 || pendingFocus.index >= total) return
    const node = rowRefs.current[pendingFocus.index]?.current
    if (!node) return
    // The row's own first field, else the row itself — which is why the row carries tabIndex={-1}.
    // A row whose fields are all disabled, or which renders no field at all, still has somewhere for
    // focus to land, and landing on the row announces which row it is.
    const field = node.querySelector?.(REPEATABLE_FIELD_SELECTOR) as HTMLElement | null
    ;(field ?? node).focus?.()
  }, [pendingFocus, total])

  const commit = (next: T[], change: RepeatableChange) => {
    if (!controlled) setInternal(next)
    onChange?.(next, change)
  }

  function add() {
    if (!canAdd) return
    const next = [...rows, newRow()]
    commit(next, { type: "add", index: next.length - 1 })
    setPendingFocus({ kind: "row", index: next.length - 1 })
    setMessage(labels.added(next.length, next.length))
  }

  function remove(index: number) {
    if (!canRemove) return
    const next = rows.filter((_, i) => i !== index)
    commit(next, { type: "remove", index })
    setPendingFocus(nextFocusAfterRemove(total, index))
    setMessage(labels.removed(index + 1, next.length))
  }

  function update(index: number, row: T) {
    const next = rows.map((current, i) => (i === index ? row : current))
    commit(next, { type: "update", index })
  }

  const describedBy =
    [props["aria-describedby"], description ? descriptionId : null].filter(Boolean).join(" ") ||
    undefined

  return (
    <fieldset
      {...props}
      disabled={disabled}
      aria-describedby={describedBy}
      // min-w-0 because a fieldset's default min-width is its content, which makes a long row stretch
      // the whole form instead of scrolling or wrapping inside it.
      className={cn("min-w-0", className)}
    >
      {legend ? <legend className="mb-1 text-base font-medium">{legend}</legend> : null}
      {description ? (
        <p id={descriptionId} className="mb-3 text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}

      {total === 0 && emptyMessage ? (
        <p className="mb-3 rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      ) : null}

      {total > 0 ? (
        <div className="space-y-2">
          {rows.map((row, index) => (
            <div
              // Minted, never the position — see alignRowKeys.
              key={rowKeys[index]}
              ref={rowRef(index)}
              role="group"
              aria-label={labels.row(index + 1, total)}
              // Focusable only on purpose, as the fallback target of the focus effect above.
              tabIndex={-1}
              // A ring rather than a bare `outline-none`: this is the one element here that can hold
              // focus without being in the tab order, so suppressing the outline unconditionally
              // would leave a sighted keyboard user looking at a row with nothing to say focus is on
              // it. Scoped to focus-visible so a pointer press on the row does not light it up.
              className={cn(
                "flex items-start gap-2 rounded-md",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                rowClassName
              )}
            >
              <div className="min-w-0 flex-1">
                {children({
                  row,
                  index,
                  total,
                  rowId: rowKeys[index],
                  update: (next) => update(index, next),
                  remove: () => remove(index),
                  canRemove,
                })}
              </div>
              <button
                type="button"
                // aria-disabled, not disabled: at the floor the button keeps its tab stop and
                // announces itself as unavailable, rather than vanishing from under the cursor or
                // sitting there looking live. `pointer-events-none` stops the press; the handler
                // checks too, because a keyboard press does not go through pointer events.
                aria-disabled={!canRemove || undefined}
                aria-label={labels.remove(index + 1, total)}
                aria-describedby={atMin && min > 0 ? minHintId : undefined}
                onClick={() => remove(index)}
                className={cn(
                  "inline-flex size-9 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-50",
                  canRemove
                    ? "hover:bg-destructive/10 hover:text-destructive"
                    : "pointer-events-none opacity-50",
                  removeButtonClassName
                )}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-3">
        <button
          ref={addRef}
          type="button"
          aria-disabled={!canAdd || undefined}
          aria-describedby={atMax ? maxHintId : undefined}
          onClick={add}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:pointer-events-none disabled:opacity-50",
            canAdd
              ? "hover:bg-accent hover:text-accent-foreground"
              : "pointer-events-none opacity-50",
            addButtonClassName
          )}
        >
          <Plus aria-hidden="true" className="size-4" />
          {addLabel ?? labels.add}
        </button>
        {atMax && max !== undefined ? (
          <p id={maxHintId} className="text-sm text-muted-foreground">
            {labels.atMax(max)}
          </p>
        ) : null}
        {atMin && min > 0 ? (
          <p id={minHintId} className="text-sm text-muted-foreground">
            {labels.atMin(min)}
          </p>
        ) : null}
      </div>

      {/* Adding and removing change no field's value, so nothing else here is announced at all. */}
      <div aria-live="polite" className="sr-only">
        {message}
      </div>
    </fieldset>
  )
}
