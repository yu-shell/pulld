"use client"

import * as React from "react"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

export interface CheckboxNode {
  /**
   * Unique across the whole tree. Leaf ids are the component's value — they are what
   * `onChange` hands back and what a `name` submits.
   */
  id: string
  label: React.ReactNode
  /**
   * A node with at least one child is a group: its state is computed from the children
   * and never stored. A node with no children — including `children: []` — is a leaf and
   * is checkable in its own right, because a group holding nothing has no selection to
   * roll up. (`tree-view` draws this line differently: there an empty `children` array is
   * an empty folder, because it still has a disclosure arrow to open.)
   */
  children?: CheckboxNode[]
  /** Disables this row and, if it is a group, everything beneath it. */
  disabled?: boolean
  /**
   * Secondary line under the label — the sentence a permission or a notification setting
   * needs. Rendered outside the checkbox and wired up with `aria-describedby`, so it is
   * announced after the name instead of becoming part of it.
   */
  description?: React.ReactNode
}

/** `"mixed"` is the third state: some of the subtree is on, not all of it. */
export type CheckState = "checked" | "unchecked" | "mixed"

interface NestedCheckboxProps {
  data: CheckboxNode[]
  /** Controlled set of checked leaf ids. Pair with `onChange` to own the state. */
  value?: string[]
  /** Checked leaf ids on first render when uncontrolled. */
  defaultValue?: string[]
  /** Handed the next set of checked leaf ids, and the node that was clicked. */
  onChange?: (checkedIds: string[], toggled: CheckboxNode) => void
  /** Disables every row. */
  disabled?: boolean
  /**
   * Submits the checked ids with a plain form POST: one hidden input per id, all under
   * this name. Only needed for a form that posts itself — `onChange` is the usual route.
   */
  name?: string
  /** Indent per level, in pixels. */
  indent?: number
  className?: string
  /** Accessible name for the whole group (or wire `aria-labelledby` to a visible heading). */
  "aria-label"?: string
  "aria-labelledby"?: string
}

const isGroup = (node: CheckboxNode) => (node.children?.length ?? 0) > 0

/**
 * Every leaf id in the tree, in document order.
 *
 * Leaf ids are the whole value space: a check-all is `onChange(collectLeafIds(data))`, and
 * a group id never appears in a value because a group's state is derived rather than held.
 */
export function collectLeafIds(nodes: CheckboxNode[]): string[] {
  const out: string[] = []
  const walk = (list: CheckboxNode[]) => {
    for (const node of list) {
      if (isGroup(node)) walk(node.children as CheckboxNode[])
      else out.push(node.id)
    }
  }
  walk(nodes)
  return out
}

/**
 * The state of every node in the tree, keyed by id — one post-order pass, so a deep tree
 * costs one walk rather than one walk per row.
 *
 * A group is `"checked"` when all of its children are, `"unchecked"` when none of them is,
 * and `"mixed"` otherwise. Disabled children are counted: what a group displays is the
 * truth about its subtree, and a group that said "all of it" while a visibly unchecked row
 * sat underneath would be lying about what is going to be submitted. The consequence is
 * deliberate — a leaf that is disabled *and* off holds its ancestors at mixed permanently,
 * because that is what the selection is. What a *click* on a group changes is the separate
 * question, and `toggleCheckboxNode` answers it differently.
 */
function buildStates(
  nodes: CheckboxNode[],
  checked: Set<string>,
  into: Map<string, CheckState> = new Map()
): Map<string, CheckState> {
  for (const node of nodes) {
    if (!isGroup(node)) {
      into.set(node.id, checked.has(node.id) ? "checked" : "unchecked")
      continue
    }
    const children = node.children as CheckboxNode[]
    buildStates(children, checked, into)
    let on = 0
    let off = 0
    for (const child of children) {
      const state = into.get(child.id)
      if (state === "checked") on++
      else if (state === "unchecked") off++
    }
    into.set(
      node.id,
      on === children.length ? "checked" : off === children.length ? "unchecked" : "mixed"
    )
  }
  return into
}

/**
 * The state one node shows for a given selection — `"mixed"` when part of its subtree is on.
 *
 * Useful outside the component for the payload question: a server that wants the group id
 * when a whole branch is on can ask `nodeCheckState(group, value) === "checked"`.
 */
export function nodeCheckState(node: CheckboxNode, checkedIds: Iterable<string>): CheckState {
  return buildStates([node], new Set(checkedIds)).get(node.id) as CheckState
}

/**
 * How many leaves each node can actually change, keyed by id — the same single pass as
 * `buildStates`, for the same reason: asking each row to walk its own subtree turns one
 * render of a deep tree into a walk per row.
 *
 * A count of zero means a press cannot do anything: the row is disabled, an ancestor is,
 * or every leaf beneath it is. Disabling a group disables its whole subtree, so the three
 * collapse into this one number.
 */
function buildTogglableCounts(
  nodes: CheckboxNode[],
  inheritedDisabled: boolean,
  into: Map<string, number> = new Map()
): Map<string, number> {
  for (const node of nodes) {
    const nodeDisabled = inheritedDisabled || node.disabled === true
    if (!isGroup(node)) {
      into.set(node.id, nodeDisabled ? 0 : 1)
      continue
    }
    const children = node.children as CheckboxNode[]
    buildTogglableCounts(children, nodeDisabled, into)
    let total = 0
    for (const child of children) total += into.get(child.id) ?? 0
    into.set(node.id, total)
  }
  return into
}

/** Descendant leaf ids of `node` that a click is allowed to change, in document order. */
function togglableLeaves(node: CheckboxNode, inheritedDisabled: boolean): string[] {
  const disabled = inheritedDisabled || node.disabled === true
  if (!isGroup(node)) return disabled ? [] : [node.id]
  const out: string[] = []
  for (const child of node.children as CheckboxNode[]) {
    out.push(...togglableLeaves(child, disabled))
  }
  return out
}

function findNode(
  nodes: CheckboxNode[],
  id: string,
  inheritedDisabled = false
): { node: CheckboxNode; inheritedDisabled: boolean } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, inheritedDisabled }
    if (isGroup(node)) {
      const hit = findNode(
        node.children as CheckboxNode[],
        id,
        inheritedDisabled || node.disabled === true
      )
      if (hit) return hit
    }
  }
  return null
}

/**
 * The next value after clicking `id` — the roll-up, downward.
 *
 * Both directions have to exist or the thing is visibly broken: a group's *display* comes
 * up from its children (`buildStates`), and a click on a group goes back down and writes
 * every leaf beneath it. Implement only the first and pressing a group does nothing;
 * only the second and a group goes stale the moment a child is pressed.
 *
 * Which way it writes is decided by the togglable leaves, not by the state on screen. A
 * group showing `"mixed"` purely because one disabled leaf is off would otherwise never be
 * able to clear itself: it is not `"checked"`, so every press would read as "turn it all
 * on", and the group could be pressed forever without anything changing.
 *
 * Ids the tree does not contain are carried through untouched, so a tree that is filtered,
 * paginated or lazily loaded does not quietly drop the selections it cannot currently see.
 */
export function toggleCheckboxNode(
  nodes: CheckboxNode[],
  id: string,
  checkedIds: string[]
): string[] {
  const hit = findNode(nodes, id)
  if (!hit) return checkedIds
  const leaves = togglableLeaves(hit.node, hit.inheritedDisabled)
  if (leaves.length === 0) return checkedIds

  const before = new Set(checkedIds)
  const allOn = leaves.every((leafId) => before.has(leafId))
  const next = new Set(before)
  for (const leafId of leaves) {
    if (allOn) next.delete(leafId)
    else next.add(leafId)
  }

  // Keep the caller's order for what survives and append what was added in tree order, so
  // the array is stable across presses instead of reshuffling on every change.
  const kept = [...new Set(checkedIds)].filter((leafId) => next.has(leafId))
  const added = leaves.filter((leafId) => !before.has(leafId) && next.has(leafId))
  return [...kept, ...added]
}

/**
 * A checkbox list with parents and children that agree with each other: tick every child
 * and the parent fills in, tick the parent and the whole branch follows, tick some and the
 * parent shows the third state. Permissions, roles and scopes; category and facet filters;
 * which columns or fields an export includes; notification settings per channel; per-item
 * consent on a privacy screen; picking files and folders.
 *
 * Pass a `data` array of `{ id, label, children?, disabled?, description? }` — a node with
 * children is a group, a node without one is a leaf. The value is the set of checked *leaf*
 * ids, controlled (`value` + `onChange`) or uncontrolled (`defaultValue`); group ids are
 * never stored, because a group whose state is both derived and saved is two sources of
 * truth waiting to disagree.
 *
 * The third state is a value, `aria-checked="mixed"`, and not a dash drawn in CSS. Each row
 * is therefore a `role="checkbox"` button rather than an `<input type="checkbox">`:
 * `indeterminate` is a DOM property with no HTML attribute behind it, so React has no way
 * to express it in JSX and it has to be assigned to the node through a ref after mount.
 * Everything that reads markup instead of a live DOM — the server render, the first paint,
 * a snapshot test, a crawler — then sees `aria-checked="false"` on a row that is actually
 * part-selected, which is the bug where the dash is on screen and a screen reader says
 * "not checked". Here the state is an attribute, so it is true at every moment.
 *
 * Each checkbox is its own tab stop, the way a list of checkboxes in a form is, and Space
 * toggles. Distinct from `tree-view`, which is the ARIA tree pattern — one tab stop, arrow
 * keys, rows that open and close. That one is for hierarchy you *navigate*; this is for
 * hierarchy you *select*.
 */
export function NestedCheckbox({
  data,
  value,
  defaultValue,
  onChange,
  disabled = false,
  name,
  indent = 24,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: NestedCheckboxProps) {
  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<string[]>(
    () => (controlled ? value : defaultValue) ?? []
  )
  const checked = controlled ? (value as string[]) : internal

  const reactId = React.useId()
  const states = React.useMemo(() => buildStates(data, new Set(checked)), [data, checked])
  const togglable = React.useMemo(
    () => buildTogglableCounts(data, disabled),
    [data, disabled]
  )

  function toggle(node: CheckboxNode, rowDisabled: boolean) {
    if (rowDisabled) return
    const next = toggleCheckboxNode(data, node.id, checked)
    if (next === checked) return
    if (!controlled) setInternal(next)
    onChange?.(next, node)
  }

  // Label ids are built from each row's position, not from `node.id`, which is free-form:
  // an id holding a space would split the space-separated token list that aria-describedby
  // and the group's aria-labelledby are made of, leaving dangling references behind.
  const renderNodes = (
    nodes: CheckboxNode[],
    level: number,
    prefix: string,
    inheritedDisabled: boolean
  ) =>
    nodes.map((node, index) => {
      const group = isGroup(node)
      const rowDisabled = inheritedDisabled || disabled || node.disabled === true
      const state = states.get(node.id) ?? "unchecked"
      const labelId = `${prefix}-${index}`
      const descId = `${labelId}-d`
      // A row with nothing togglable underneath it cannot be changed by a press, so it says
      // so rather than looking live and doing nothing when pressed.
      const inert = (togglable.get(node.id) ?? 0) === 0

      return (
        <li key={node.id}>
          <div style={{ paddingLeft: level * indent }} className="py-0.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={state === "mixed" ? "mixed" : state === "checked"}
              // aria-disabled, not the `disabled` attribute: a disabled row stays focusable,
              // so somebody tabbing through can still find out that the permission exists
              // and is locked. `disabled` would take it out of the tab order and hide it.
              aria-disabled={inert || undefined}
              aria-describedby={node.description ? descId : undefined}
              onClick={() => toggle(node, inert)}
              className={cn(
                "group flex items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                inert ? "cursor-not-allowed opacity-50" : "cursor-pointer"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border shadow-sm transition-colors",
                  state === "unchecked"
                    ? "border-input bg-background"
                    : "border-primary bg-primary text-primary-foreground",
                  !inert && state === "unchecked" && "group-hover:border-primary"
                )}
              >
                {state === "checked" ? (
                  <Check className="h-3.5 w-3.5" strokeWidth={3} />
                ) : state === "mixed" ? (
                  <Minus className="h-3.5 w-3.5" strokeWidth={3} />
                ) : null}
              </span>
              <span id={labelId} className={cn("text-sm", group && "font-medium")}>
                {node.label}
              </span>
            </button>

            {node.description && (
              <p
                id={descId}
                // Aligned under the label rather than under the box: the width of the box
                // plus the gap, which is independent of `indent`.
                style={{ paddingLeft: 24 }}
                className="text-xs text-muted-foreground"
              >
                {node.description}
              </p>
            )}
          </div>

          {group && (
            // Named by the row above it, so a screen reader entering the subtree says which
            // group these rows belong to instead of reading them as a flat list.
            <ul role="group" aria-labelledby={labelId}>
              {renderNodes(
                node.children as CheckboxNode[],
                level + 1,
                labelId,
                rowDisabled
              )}
            </ul>
          )}
        </li>
      )
    })

  return (
    <div className={cn("text-foreground", className)}>
      <ul aria-label={ariaLabel} aria-labelledby={ariaLabelledby}>
        {renderNodes(data, 0, `${reactId}-n`, false)}
      </ul>
      {name &&
        checked.map((id) => <input key={id} type="hidden" name={name} value={id} />)}
    </div>
  )
}
