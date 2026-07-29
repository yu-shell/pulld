"use client"

import * as React from "react"
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react"

import { cn } from "@/lib/utils"

export interface TreeNode {
  /** Unique across the whole tree — it keys the expanded set, the selection and focus. */
  id: string
  label: string
  /**
   * Present (even as an empty array) marks the node as a parent: it gets a disclosure
   * arrow and `aria-expanded`, and an empty folder can still be opened to show that it
   * holds nothing. Leave it undefined for a leaf.
   */
  children?: TreeNode[]
  /** Replaces the default folder/file icon for this row. */
  icon?: React.ReactNode
}

interface TreeViewProps {
  data: TreeNode[]
  /** Controlled set of open parents. Pair with `onExpandedChange` to own the state. */
  expandedIds?: string[]
  /** Parents open on first render when uncontrolled. */
  defaultExpandedIds?: string[]
  onExpandedChange?: (ids: string[]) => void
  /** Controlled selection (single-select). Pair with `onSelect`. */
  selectedId?: string | null
  defaultSelectedId?: string | null
  /** Called with the whole node, so the handler gets the payload and not just an id. */
  onSelect?: (node: TreeNode) => void
  /** Draw the default folder/file icons. Turn off for category or org trees. */
  showIcons?: boolean
  /** Indent per level, in pixels. */
  indent?: number
  className?: string
  /** Accessible name for the tree (or wire `aria-labelledby` to a visible heading). */
  "aria-label"?: string
  "aria-labelledby"?: string
}

interface FlatNode {
  node: TreeNode
  level: number
  parentId: string | null
  expandable: boolean
}

/**
 * A nested list you can walk with the keyboard: file explorers, folder trees, category or
 * org charts, JSON/API schema browsers, nested navigation.
 *
 * Pass a `data` array of `{ id, label, children? }` and it renders the whole hierarchy —
 * a node with a `children` array is a parent, a node without one is a leaf. Works
 * controlled (`expandedIds` / `selectedId` plus handlers) or uncontrolled
 * (`defaultExpandedIds` / `defaultSelectedId`).
 *
 * It implements the ARIA tree pattern rather than a pile of nested collapsibles: one tab
 * stop for the whole tree (roving tabindex), Up/Down through the *visible* rows only,
 * Right to open a parent and then step into it, Left to close it or jump out to the
 * parent, Home/End for the ends, Enter/Space to select, and type-ahead that jumps to the
 * next row starting with what you typed.
 */
export function TreeView({
  data,
  expandedIds,
  defaultExpandedIds,
  onExpandedChange,
  selectedId,
  defaultSelectedId = null,
  onSelect,
  showIcons = true,
  indent = 16,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: TreeViewProps) {
  const expandedControlled = expandedIds !== undefined
  const [internalExpanded, setInternalExpanded] = React.useState<string[]>(
    () => (expandedControlled ? expandedIds : defaultExpandedIds) ?? []
  )
  const expanded = expandedControlled ? (expandedIds as string[]) : internalExpanded

  const selectionControlled = selectedId !== undefined
  const [internalSelected, setInternalSelected] = React.useState<string | null>(
    () => (selectionControlled ? selectedId : defaultSelectedId) ?? null
  )
  const selected = selectionControlled ? (selectedId as string | null) : internalSelected

  const [focusedId, setFocusedId] = React.useState<string | null>(null)

  const id = React.useId()
  const itemRefs = React.useRef(new Map<string, HTMLLIElement>())
  const typeahead = React.useRef({ buffer: "", time: 0 })

  const expandedSet = React.useMemo(() => new Set(expanded), [expanded])

  // Flatten what is on screen into one array. Every keyboard move is then index arithmetic
  // over the *visible* rows, which is what the tree pattern navigates — walking the DOM
  // instead would have to skip closed subtrees by hand.
  const visible = React.useMemo(() => {
    const out: FlatNode[] = []
    const walk = (nodes: TreeNode[], level: number, parentId: string | null) => {
      for (const node of nodes) {
        const expandable = Array.isArray(node.children)
        out.push({ node, level, parentId, expandable })
        if (expandable && expandedSet.has(node.id)) {
          walk(node.children as TreeNode[], level + 1, node.id)
        }
      }
    }
    walk(data, 0, null)
    return out
  }, [data, expandedSet])

  // The single row that carries tabIndex={0}. Falling back through selection to the first
  // row keeps the tree reachable by Tab before anything is focused, and re-resolves focus
  // when the row that had it was collapsed out of the tree.
  const activeId = React.useMemo(() => {
    const ids = new Set(visible.map((v) => v.node.id))
    if (focusedId && ids.has(focusedId)) return focusedId
    if (selected && ids.has(selected)) return selected
    return visible[0]?.node.id ?? null
  }, [visible, focusedId, selected])

  function focusItem(nodeId: string) {
    setFocusedId(nodeId)
    itemRefs.current.get(nodeId)?.focus()
  }

  function commitExpanded(next: string[]) {
    if (!expandedControlled) setInternalExpanded(next)
    onExpandedChange?.(next)
  }

  function expand(nodeId: string) {
    if (expandedSet.has(nodeId)) return
    commitExpanded([...expanded, nodeId])
  }

  function collapse(nodeId: string) {
    if (!expandedSet.has(nodeId)) return
    // Closing a subtree unmounts its rows. If focus is inside, take it back to the node
    // being closed — otherwise the focused element disappears and focus falls to <body>,
    // which drops the user out of the tree mid-keystroke.
    const at = visible.findIndex((v) => v.node.id === nodeId)
    if (at >= 0) {
      const level = visible[at].level
      for (let i = at + 1; i < visible.length && visible[i].level > level; i++) {
        if (visible[i].node.id === activeId) {
          focusItem(nodeId)
          break
        }
      }
    }
    commitExpanded(expanded.filter((v) => v !== nodeId))
  }

  function toggle(nodeId: string) {
    if (expandedSet.has(nodeId)) collapse(nodeId)
    else expand(nodeId)
  }

  function select(node: TreeNode) {
    if (!selectionControlled) setInternalSelected(node.id)
    onSelect?.(node)
  }

  /** What a click on the row (or Enter/Space) does: select, and open a parent. */
  function activate(node: TreeNode) {
    focusItem(node.id)
    select(node)
    if (Array.isArray(node.children)) toggle(node.id)
  }

  function moveTo(index: number) {
    const entry = visible[Math.max(0, Math.min(index, visible.length - 1))]
    if (entry) focusItem(entry.node.id)
  }

  function typeaheadTo(char: string, from: number) {
    const now = Date.now()
    const state = typeahead.current
    state.buffer = now - state.time > 600 ? char : state.buffer + char
    state.time = now
    const query = state.buffer.toLowerCase()
    // A repeated single letter cycles to the next match; a longer buffer keeps matching
    // the row it already landed on, so typing "re" does not skip past "readme".
    const start = state.buffer.length > 1 ? from : from + 1
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[(start + i) % visible.length]
      if (entry.node.label.toLowerCase().startsWith(query)) {
        focusItem(entry.node.id)
        return
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    const index = visible.findIndex((v) => v.node.id === activeId)
    if (index < 0) return
    const current = visible[index]

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        moveTo(index + 1)
        break
      case "ArrowUp":
        e.preventDefault()
        moveTo(index - 1)
        break
      case "ArrowRight": {
        e.preventDefault()
        if (!current.expandable) break
        if (!expandedSet.has(current.node.id)) {
          expand(current.node.id)
          break
        }
        // Step into the subtree only if it actually has a first child: an open but empty
        // folder must not hand focus to the next sibling.
        const next = visible[index + 1]
        if (next && next.level > current.level) moveTo(index + 1)
        break
      }
      case "ArrowLeft":
        e.preventDefault()
        if (current.expandable && expandedSet.has(current.node.id)) collapse(current.node.id)
        else if (current.parentId) focusItem(current.parentId)
        break
      case "Home":
        e.preventDefault()
        moveTo(0)
        break
      case "End":
        e.preventDefault()
        moveTo(visible.length - 1)
        break
      case "Enter":
      case " ":
        e.preventDefault()
        activate(current.node)
        break
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          typeaheadTo(e.key, index)
        }
    }
  }

  // `prefix` builds each label's id from the node's position rather than its `id`, which is
  // free-form: an id holding a space would split aria-labelledby (a space-separated token
  // list) into two dangling references and leave the row with no accessible name at all.
  const renderNodes = (nodes: TreeNode[], level: number, prefix: string) =>
    nodes.map((node, index) => {
      const expandable = Array.isArray(node.children)
      const isExpanded = expandable && expandedSet.has(node.id)
      const isSelected = selected === node.id
      const labelId = `${prefix}-${index}`

      return (
        <li
          key={node.id}
          ref={(el) => {
            if (el) itemRefs.current.set(node.id, el)
            else itemRefs.current.delete(node.id)
          }}
          role="treeitem"
          aria-expanded={expandable ? isExpanded : undefined}
          aria-selected={isSelected}
          aria-level={level + 1}
          aria-posinset={index + 1}
          aria-setsize={nodes.length}
          // Name the row from its own label. A treeitem owns its child group, so a name
          // computed from contents would read the entire subtree as the row's name.
          aria-labelledby={labelId}
          tabIndex={activeId === node.id ? 0 : -1}
          // The focus ring belongs on the row, not on the <li>, which wraps the subtree
          // too — hence the ring is drawn on the li's first child.
          className="focus-visible:outline-none [&:focus-visible>:first-child]:ring-1 [&:focus-visible>:first-child]:ring-ring"
        >
          <div
            onClick={() => activate(node)}
            style={{ paddingLeft: level * indent + 4 }}
            className={cn(
              "flex cursor-pointer select-none items-center gap-1.5 rounded-sm py-1 pr-2 text-sm",
              isSelected
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-accent/50"
            )}
          >
            {expandable ? (
              <ChevronRight
                // Toggling without selecting is the one thing a mouse can do that the
                // keyboard cannot, so the arrow is a hit area rather than a <button>:
                // a treeitem must not contain its own focusable elements.
                onClick={(e) => {
                  e.stopPropagation()
                  focusItem(node.id)
                  toggle(node.id)
                }}
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  isExpanded && "rotate-90"
                )}
                aria-hidden="true"
              />
            ) : (
              <span className="h-4 w-4 shrink-0" aria-hidden="true" />
            )}

            {node.icon !== undefined
              ? node.icon
              : showIcons && (
                  <span className="shrink-0 text-muted-foreground" aria-hidden="true">
                    {expandable ? (
                      isExpanded ? (
                        <FolderOpen className="h-4 w-4" />
                      ) : (
                        <Folder className="h-4 w-4" />
                      )
                    ) : (
                      <File className="h-4 w-4" />
                    )}
                  </span>
                )}

            <span id={labelId} className="truncate">
              {node.label}
            </span>
          </div>

          {isExpanded && (node.children as TreeNode[]).length > 0 && (
            <ul role="group">
              {renderNodes(node.children as TreeNode[], level + 1, labelId)}
            </ul>
          )}
        </li>
      )
    })

  return (
    <ul
      role="tree"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      onKeyDown={handleKeyDown}
      className={cn("text-sm", className)}
    >
      {renderNodes(data, 0, `${id}-n`)}
    </ul>
  )
}
