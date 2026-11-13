"use client"

import * as React from "react"
import { Check, Lock, Minus } from "lucide-react"

import { cn } from "@/lib/utils"
import { StickyTableHeader } from "@/registry/ui/sticky-table-header"

/** One row: a role, a group, an API token — whatever the permissions are being handed to. */
export interface PermissionRole {
  /** Unique among rows. Free-form: it is never concatenated into an id or a token list. */
  key: string
  label: React.ReactNode
  /**
   * Row keys this role is granted everything from. Transitive — a role inheriting a role that
   * inherits a third gets all three — and safe against a cycle or a self-reference, both of which
   * are easy to write in a config and neither of which may deadlock a cell (see
   * {@link inheritedRoleKeys}).
   *
   * What is inherited is the parent's *effective* set, not the grants ticked on its row: "Admin
   * inherits Editor" has to mean "Admin can do everything Editor can do", and Editor's own
   * inheritance and requirements are part of that.
   */
  inherits?: string[]
  /** Fixed: no cell in this row can be changed. The Owner row that always holds everything. */
  locked?: boolean
  /** Secondary line under the label. Announced after the name, via `aria-describedby`. */
  description?: React.ReactNode
}

/** One column: a permission, a scope, a capability. */
export interface PermissionAction {
  /** Unique among columns. Free-form, for the same reason as {@link PermissionRole.key}. */
  key: string
  label: React.ReactNode
  /**
   * Action keys that holding this one implies — `write` requires `read`. Transitive, and safe
   * against cycles and self-reference (see {@link expandRequiredActions}).
   *
   * These are *derived*, never written into the value. Granting `write` does not tick `read`; it
   * makes `read` granted, shown as such, and refused to a press that would clear it.
   */
  requires?: string[]
  /** Fixed: this action cannot be changed for any role. */
  locked?: boolean
  /** Secondary line under the column label. */
  description?: React.ReactNode
}

/**
 * The value: for each role key, the action keys **explicitly** ticked on that row.
 *
 * Derived grants are never in here — not the ones a requirement implies, not the ones inheritance
 * brings. The one-line alternative is to write the closure into the value instead, and it is wrong
 * in both directions. Forwards: untick `write` and `read` stays ticked with nothing on screen
 * saying why it is still there, because by then it is indistinguishable from a grant somebody made
 * on purpose. Backwards: the day a deploy says `write` also requires `list`, nobody who already
 * has `write` gets `list`, because their stored value was closed over the old graph — so the
 * matrix disagrees with whatever the server computes at check time, which is the thing actually
 * being enforced.
 *
 * Keeping only explicit grants also means there is no cascade to implement. "Can you untick the
 * `read` that `write` pulled in" is a question that only exists once the closure is in the value;
 * here `read` is not in the value, so there is nothing to untick and nothing to unwind.
 */
export type PermissionGrants = Record<string, string[]>

/** Why a press on a cell is refused. `null` when it is not. */
export type PermissionBlock = "locked" | "derived"

/** What one cell is, and why. */
export interface PermissionCellState {
  roleKey: string
  actionKey: string
  /** Ticked on this row in the value. */
  explicit: boolean
  /**
   * Other actions on this row that imply this one. Each is a *root cause* — explicitly granted or
   * inherited — never another requirement, which is what keeps a `requires` cycle from pinning two
   * cells against each other so that neither can be cleared.
   */
  requiredBy: string[]
  /** Direct parents of this role whose effective set holds this action. */
  inheritedFrom: string[]
  /** What the server would enforce: `explicit || requiredBy.length > 0 || inheritedFrom.length > 0`. */
  granted: boolean
  /** Whether a press may change this cell. */
  togglable: boolean
  /** Why a press is refused, or `null`. */
  blocked: PermissionBlock | null
}

/** A row's, a column's or the whole grid's summary — what the select-all above it shows and does. */
export interface PermissionAggregate {
  /**
   * What the select-all displays, counted over **every** cell in scope — derived and locked ones
   * included. A scope claiming "all of it" while a cell nobody can see the reason for sits
   * underneath would be lying about what is going to be enforced.
   */
  state: "checked" | "unchecked" | "mixed"
  /** How many cells a press may change. Zero means the control says so instead of looking live. */
  togglable: number
  /**
   * What a press would do, decided **only** from the togglable cells.
   *
   * This is the split `nested-checkbox` had to make for the same reason, one dimension up: read the
   * direction off the displayed state and a row held at `"mixed"` by a single inherited cell is
   * never `"checked"`, so every press reads as "grant the rest" and the row can be pressed forever
   * without changing.
   */
  pressWould: "grant" | "revoke"
}

/** One cell, named by its two keys rather than by a joined string, since keys are free-form. */
export interface PermissionCellRef {
  roleKey: string
  actionKey: string
}

/** What a press did, handed to `onGrantsChange` beside the next value. */
export interface PermissionMatrixChange {
  kind: "cell" | "role" | "action" | "all"
  /** Set for `"cell"` and `"role"`. */
  roleKey?: string
  /** Set for `"cell"` and `"action"`. */
  actionKey?: string
  /** Cells that gained an explicit grant. */
  granted: PermissionCellRef[]
  /** Cells that lost one. */
  revoked: PermissionCellRef[]
  /**
   * The subset of `revoked` that is **still granted** afterwards, because a requirement or
   * inheritance holds it. These are the presses where the checkbox does not clear, which reads as
   * a broken control unless something says so — the component announces it, and this is here so a
   * caller can too.
   */
  stillGranted: PermissionCellRef[]
}

const asArray = (value: readonly string[] | undefined): readonly string[] =>
  Array.isArray(value) ? value : []

/**
 * Every action implied by `keys`, including `keys` themselves, in `columns` order.
 *
 * Cycle-safe, and that is two separate requirements rather than one. Terminating is the easy half:
 * a visited set does it. The half that bites is that **a cycle must not report a key as requiring
 * itself.** Seed the frontier with `a`, follow `a → b → a`, and a naive walk adds `a` to the set of
 * things `a` requires; the cell is then permanently "required by itself", which makes it derived,
 * which refuses every press, and the grant can never be removed by anyone. The same holds for the
 * one-line version of the mistake, `requires: ["self"]`. So requirements are collected from the
 * *successors* of the frontier and the origins are added back at the end — a key appears here
 * because it was asked for or because something else needs it, never because of itself.
 *
 * Unknown keys are ignored rather than thrown on: a `requires` entry naming a column this deploy
 * no longer renders is a stale config, not a crash.
 */
export function expandRequiredActions(
  columns: readonly PermissionAction[],
  keys: Iterable<string>
): string[] {
  const byKey = new Map(columns.map((column) => [column.key, column]))
  const origins = [...new Set(keys)]
  const implied = new Set<string>()
  const seen = new Set<string>()
  let frontier = origins.filter((key) => byKey.has(key))

  while (frontier.length > 0) {
    const next: string[] = []
    for (const key of frontier) {
      if (seen.has(key)) continue
      seen.add(key)
      for (const required of asArray(byKey.get(key)?.requires)) {
        if (!byKey.has(required)) continue
        if (!implied.has(required)) {
          implied.add(required)
          next.push(required)
        }
      }
    }
    frontier = next
  }

  // Order by the column list so the result is stable regardless of how `keys` arrived, with keys
  // the matrix does not render kept at the end rather than dropped — the server may know actions
  // this screen does not.
  const all = new Set([...origins, ...implied])
  const ordered = columns.filter((column) => all.has(column.key)).map((column) => column.key)
  const unknown = origins.filter((key) => !byKey.has(key))
  return [...ordered, ...unknown]
}

/**
 * Every role `roleKey` inherits from, transitively, excluding itself — in `rows` order.
 *
 * Self-exclusion is load-bearing for the same reason as in {@link expandRequiredActions}: a role
 * that reaches itself through a cycle would hold every one of its own grants "by inheritance",
 * which makes each of them derived and each press on them refused. A role cannot be its own parent
 * here even if the config says so.
 */
export function inheritedRoleKeys(
  rows: readonly PermissionRole[],
  roleKey: string
): string[] {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const ancestors = new Set<string>()
  const seen = new Set<string>()
  let frontier = [roleKey]

  while (frontier.length > 0) {
    const next: string[] = []
    for (const key of frontier) {
      if (seen.has(key)) continue
      seen.add(key)
      for (const parent of asArray(byKey.get(key)?.inherits)) {
        if (!byKey.has(parent) || parent === roleKey) continue
        if (!ancestors.has(parent)) {
          ancestors.add(parent)
          next.push(parent)
        }
      }
    }
    frontier = next
  }

  return rows.filter((row) => ancestors.has(row.key)).map((row) => row.key)
}

/** The explicit grants on one row, de-duplicated, in the order they arrived. */
function explicitFor(grants: PermissionGrants | undefined, roleKey: string): string[] {
  const list = grants?.[roleKey]
  return Array.isArray(list) ? [...new Set(list)] : []
}

/**
 * Everything `roleKey` can actually do: its own grants, everything its parents can do, and the
 * closure of what all of that requires.
 *
 * This is the function a server route wants, and it is exported so the answer on the screen and the
 * answer in the authorization check come from one place. Keys the matrix does not render are kept.
 */
export function effectivePermissions(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  roleKey: string
): string[] {
  const own = explicitFor(grants, roleKey)
  const inherited = inheritedRoleKeys(rows, roleKey).flatMap((parent) =>
    explicitFor(grants, parent)
  )
  return expandRequiredActions(columns, [...own, ...inherited])
}

function aggregate(cells: readonly PermissionCellState[]): PermissionAggregate {
  let granted = 0
  let togglable = 0
  let togglableGranted = 0
  for (const cell of cells) {
    if (cell.granted) granted++
    if (cell.togglable) {
      togglable++
      if (cell.explicit) togglableGranted++
    }
  }
  const state =
    cells.length === 0 || granted === 0
      ? "unchecked"
      : granted === cells.length
        ? "checked"
        : "mixed"
  // Among togglable cells `granted` and `explicit` coincide — a cell that is granted without being
  // explicit is derived, and derived cells are not togglable — so `explicit` is the honest field to
  // count here, and it says what the press is going to write.
  return {
    state,
    togglable,
    pressWould: togglable > 0 && togglableGranted === togglable ? "revoke" : "grant",
  }
}

/** Options shared by {@link resolvePermissionMatrix} and the component. */
export interface ResolvePermissionMatrixOptions {
  /** Locks every cell. */
  disabled?: boolean
}

/** Every cell, plus the summary each select-all needs. */
export interface ResolvedPermissionMatrix {
  cells: PermissionCellState[]
  /** Keyed by `roleKey`, then `actionKey`. */
  cell: (roleKey: string, actionKey: string) => PermissionCellState | undefined
  /** Keyed by `roleKey`. */
  roles: Map<string, PermissionAggregate>
  /** Keyed by `actionKey`. */
  actions: Map<string, PermissionAggregate>
  all: PermissionAggregate
}

/**
 * Resolves the whole grid in one pass over the rows: the state of every cell and the three kinds of
 * summary, from the rows, the columns and the explicit grants.
 *
 * Exported because a server-rendered table, a read-only audit view or a test wants the resolved
 * grid without mounting anything.
 */
export function resolvePermissionMatrix(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  { disabled = false }: ResolvePermissionMatrixOptions = {}
): ResolvedPermissionMatrix {
  const byActionKey = new Map(columns.map((column) => [column.key, column]))

  // One effective set per row, memoised, so a chain of inheriting roles costs one pass rather than
  // one pass per descendant.
  const effective = new Map<string, Set<string>>()
  for (const row of rows) {
    effective.set(row.key, new Set(effectivePermissions(rows, columns, grants, row.key)))
  }

  const cells: PermissionCellState[] = []
  const index = new Map<string, Map<string, PermissionCellState>>()

  for (const row of rows) {
    const explicit = new Set(explicitFor(grants, row.key))
    const parents = asArray(row.inherits).filter(
      (parent) => parent !== row.key && effective.has(parent)
    )

    // The root causes on this row are the grants ticked on it, and requirements are followed *from*
    // these and never from each other — which is what breaks a `requires` cycle into something a
    // person can still untick.
    //
    // Inherited actions are deliberately not roots. An effective set is already closed under
    // `requires`, so anything an inherited action implies is inherited in its own right and
    // `inheritedFrom` has it covered; adding it here would only put a second clause on the same
    // sentence — "Required by Edit. Inherited from Editor." — about one grant with one place to go
    // and change it.
    const requiredBy = new Map<string, string[]>()
    for (const root of explicit) {
      if (!byActionKey.has(root)) continue
      for (const implied of expandRequiredActions(columns, [root])) {
        if (implied === root) continue
        const list = requiredBy.get(implied)
        if (list) list.push(root)
        else requiredBy.set(implied, [root])
      }
    }

    const perAction = new Map<string, PermissionCellState>()
    for (const column of columns) {
      const inheritedFrom = parents.filter((parent) =>
        (effective.get(parent) as Set<string>).has(column.key)
      )
      const isExplicit = explicit.has(column.key)
      const requirements = requiredBy.get(column.key) ?? []
      const granted = isExplicit || requirements.length > 0 || inheritedFrom.length > 0
      const locked = disabled || row.locked === true || column.locked === true
      // A derived cell has nothing explicit to remove, so the press has no meaning; a derived cell
      // that is *also* explicit does, and stays pressable — the press clears the explicit grant and
      // the cell goes on being granted, which is the one case the live region has to narrate.
      const blocked: PermissionBlock | null = locked
        ? "locked"
        : !isExplicit && granted
          ? "derived"
          : null

      const cell: PermissionCellState = {
        roleKey: row.key,
        actionKey: column.key,
        explicit: isExplicit,
        requiredBy: requirements,
        inheritedFrom,
        granted,
        togglable: blocked === null,
        blocked,
      }
      cells.push(cell)
      perAction.set(column.key, cell)
    }
    index.set(row.key, perAction)
  }

  const roles = new Map<string, PermissionAggregate>()
  for (const row of rows) {
    roles.set(row.key, aggregate(columns.map((column) => index.get(row.key)?.get(column.key) as PermissionCellState)))
  }
  const actions = new Map<string, PermissionAggregate>()
  for (const column of columns) {
    actions.set(
      column.key,
      aggregate(rows.map((row) => index.get(row.key)?.get(column.key) as PermissionCellState))
    )
  }

  return {
    cells,
    cell: (roleKey, actionKey) => index.get(roleKey)?.get(actionKey),
    roles,
    actions,
    all: aggregate(cells),
  }
}

/** Replaces one row's explicit grants, keeping every other row — including rows not rendered. */
function withRow(
  grants: PermissionGrants | undefined,
  roleKey: string,
  next: string[]
): PermissionGrants {
  const out: PermissionGrants = { ...(grants ?? {}) }
  if (next.length > 0) out[roleKey] = next
  else delete out[roleKey]
  return out
}

/**
 * The next value after pressing one cell, and what that did.
 *
 * A refused press returns the value it was handed, by identity, so a caller can tell a no-op from a
 * change without comparing contents.
 */
export function togglePermissionCell(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  roleKey: string,
  actionKey: string,
  options: ResolvePermissionMatrixOptions = {}
): { grants: PermissionGrants; change: PermissionMatrixChange } | null {
  const resolved = resolvePermissionMatrix(rows, columns, grants, options)
  const cell = resolved.cell(roleKey, actionKey)
  if (!cell || !cell.togglable) return null

  const current = explicitFor(grants, roleKey)
  const nextRow = cell.explicit
    ? current.filter((key) => key !== actionKey)
    : [...current, actionKey]
  const next = withRow(grants, roleKey, nextRow)

  const ref: PermissionCellRef = { roleKey, actionKey }
  const after = resolvePermissionMatrix(rows, columns, next, options).cell(roleKey, actionKey)
  return {
    grants: next,
    change: {
      kind: "cell",
      roleKey,
      actionKey,
      granted: cell.explicit ? [] : [ref],
      revoked: cell.explicit ? [ref] : [],
      stillGranted: cell.explicit && after?.granted ? [ref] : [],
    },
  }
}

/** The next value after pressing a select-all over `scope`'s cells. */
function toggleScope(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  scope: readonly PermissionCellState[],
  summary: PermissionAggregate,
  kind: PermissionMatrixChange["kind"],
  named: { roleKey?: string; actionKey?: string },
  options: ResolvePermissionMatrixOptions
): { grants: PermissionGrants; change: PermissionMatrixChange } | null {
  const togglable = scope.filter((cell) => cell.togglable)
  if (togglable.length === 0) return null

  const grant = summary.pressWould === "grant"
  const byRole = new Map<string, Set<string>>()
  for (const cell of togglable) {
    if (cell.explicit === grant) continue
    const set = byRole.get(cell.roleKey) ?? new Set<string>()
    set.add(cell.actionKey)
    byRole.set(cell.roleKey, set)
  }
  if (byRole.size === 0) return null

  let next: PermissionGrants = { ...(grants ?? {}) }
  for (const [roleKey, keys] of byRole) {
    const current = explicitFor(grants, roleKey)
    next = withRow(
      next,
      roleKey,
      grant
        ? [...current, ...columns.filter((c) => keys.has(c.key)).map((c) => c.key)]
        : current.filter((key) => !keys.has(key))
    )
  }

  const touched: PermissionCellRef[] = []
  for (const [roleKey, keys] of byRole) {
    for (const actionKey of keys) touched.push({ roleKey, actionKey })
  }
  const after = resolvePermissionMatrix(rows, columns, next, options)
  return {
    grants: next,
    change: {
      kind,
      ...named,
      granted: grant ? touched : [],
      revoked: grant ? [] : touched,
      stillGranted: grant
        ? []
        : touched.filter((ref) => after.cell(ref.roleKey, ref.actionKey)?.granted === true),
    },
  }
}

/** The next value after pressing a row's select-all. */
export function togglePermissionRole(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  roleKey: string,
  options: ResolvePermissionMatrixOptions = {}
) {
  const resolved = resolvePermissionMatrix(rows, columns, grants, options)
  const summary = resolved.roles.get(roleKey)
  if (!summary) return null
  const scope = resolved.cells.filter((cell) => cell.roleKey === roleKey)
  return toggleScope(rows, columns, grants, scope, summary, "role", { roleKey }, options)
}

/** The next value after pressing a column's select-all. */
export function togglePermissionAction(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  actionKey: string,
  options: ResolvePermissionMatrixOptions = {}
) {
  const resolved = resolvePermissionMatrix(rows, columns, grants, options)
  const summary = resolved.actions.get(actionKey)
  if (!summary) return null
  const scope = resolved.cells.filter((cell) => cell.actionKey === actionKey)
  return toggleScope(rows, columns, grants, scope, summary, "action", { actionKey }, options)
}

/** The next value after pressing the corner select-all. */
export function togglePermissionMatrix(
  rows: readonly PermissionRole[],
  columns: readonly PermissionAction[],
  grants: PermissionGrants | undefined,
  options: ResolvePermissionMatrixOptions = {}
) {
  const resolved = resolvePermissionMatrix(rows, columns, grants, options)
  return toggleScope(rows, columns, grants, resolved.cells, resolved.all, "all", {}, options)
}

/** A position in the grid. Row and column `0` are the select-all header line and column. */
export interface MatrixFocus {
  row: number
  col: number
}

/**
 * Where an arrow, Home or End moves focus inside the grid.
 *
 * Clamped rather than wrapped, which is what the ARIA grid pattern specifies: at the rightmost cell
 * a press of Right End does nothing, instead of teleporting to the other side of a table that may be
 * wider than the screen. `Home`/`End` work along the row and take the modifier to mean the grid, so
 * the two corners are one chord away in a grid of any size.
 *
 * Exported because it is the part of a roving tabindex that is wrong in most implementations — off
 * the end, over the header line, or along the wrong axis — and it is pure, so it can be asserted
 * without a DOM.
 */
export function nextMatrixFocus(
  current: MatrixFocus,
  key: string,
  options: { rows: number; cols: number; ctrl?: boolean }
): MatrixFocus | null {
  const lastRow = options.rows
  const lastCol = options.cols
  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max))
  const at = (row: number, col: number): MatrixFocus | null => {
    const next = { row: clamp(row, lastRow), col: clamp(col, lastCol) }
    return next.row === current.row && next.col === current.col ? null : next
  }

  switch (key) {
    case "ArrowUp":
      return at(current.row - 1, current.col)
    case "ArrowDown":
      return at(current.row + 1, current.col)
    case "ArrowLeft":
      return at(current.row, current.col - 1)
    case "ArrowRight":
      return at(current.row, current.col + 1)
    case "Home":
      return options.ctrl ? at(0, 0) : at(current.row, 0)
    case "End":
      return options.ctrl ? at(lastRow, lastCol) : at(current.row, lastCol)
    default:
      return null
  }
}

/** Every string a reader sees or hears. Override to translate or to reword. */
export interface PermissionMatrixLabels {
  /** Names the grid when no `aria-label` is given, and used as the table's caption. */
  caption: string
  /** The corner select-all. */
  all: string
  /** A row's select-all. */
  allForRole: (role: string) => string
  /** A column's select-all. */
  actionForAllRoles: (action: string) => string
  /** Each cell's accessible name. Role first, so it reads as a sentence about the role. */
  cell: (role: string, action: string) => string
  /** Why a cell is granted although nothing is ticked on it. */
  requiredBy: (actions: string) => string
  /** Why a cell is granted although nothing is ticked on it, by inheritance. */
  inheritedFrom: (roles: string) => string
  /** Why a cell cannot be changed at all. */
  locked: string
  /** Announced after a cell is granted. */
  granted: (role: string, action: string) => string
  /** Announced after a cell is revoked and is no longer granted. */
  revoked: (role: string, action: string) => string
  /**
   * Announced after a cell is revoked and is **still granted** — the press where the tick does not
   * go away. Without this the control reads as broken.
   */
  revokedStillGranted: (role: string, action: string, reason: string) => string
  /** Announced when a press is refused, with the reason. */
  refused: (reason: string) => string
  /** Announced after a select-all granted cells. */
  bulkGranted: (count: number, scope: string) => string
  /** Announced after a select-all revoked cells, with how many are still granted. */
  bulkRevoked: (count: number, scope: string, stillGranted: number) => string
  /** Announced when a select-all had nothing it was allowed to change. */
  bulkNothing: (scope: string) => string
  /** Joins several reasons into one sentence. */
  joinReasons: (reasons: string[]) => string
}

export const defaultPermissionMatrixLabels: PermissionMatrixLabels = {
  caption: "Permissions by role",
  all: "All permissions for all roles",
  allForRole: (role) => `All permissions for ${role}`,
  actionForAllRoles: (action) => `${action} for all roles`,
  cell: (role, action) => `${role}: ${action}`,
  requiredBy: (actions) => `Required by ${actions}`,
  inheritedFrom: (roles) => `Inherited from ${roles}`,
  locked: "Fixed, cannot be changed",
  granted: (role, action) => `${action} granted to ${role}.`,
  revoked: (role, action) => `${action} removed from ${role}.`,
  revokedStillGranted: (role, action, reason) =>
    `${action} is no longer set on ${role} directly, and is still granted. ${reason}.`,
  refused: (reason) => `Cannot be changed. ${reason}.`,
  bulkGranted: (count, scope) => `${count} granted. ${scope}.`,
  bulkRevoked: (count, scope, stillGranted) =>
    stillGranted > 0
      ? `${count} removed. ${stillGranted} still granted by inheritance or a requirement. ${scope}.`
      : `${count} removed. ${scope}.`,
  bulkNothing: (scope) => `Nothing can be changed. ${scope}.`,
  joinReasons: (reasons) => reasons.join(". "),
}

/**
 * The sentence that says why a cell is the way it is, or `null` when there is nothing to say.
 *
 * Exported so a read-only view of the same data can explain itself with the same words.
 */
export function permissionCellReason(
  cell: PermissionCellState,
  names: { role: (key: string) => string; action: (key: string) => string },
  labels: PermissionMatrixLabels = defaultPermissionMatrixLabels
): string | null {
  const reasons: string[] = []
  if (cell.blocked === "locked") reasons.push(labels.locked)
  if (cell.requiredBy.length > 0) {
    reasons.push(labels.requiredBy(cell.requiredBy.map(names.action).join(", ")))
  }
  if (cell.inheritedFrom.length > 0) {
    reasons.push(labels.inheritedFrom(cell.inheritedFrom.map(names.role).join(", ")))
  }
  return reasons.length > 0 ? labels.joinReasons(reasons) : null
}

/**
 * The right edge of the pinned role column, which cannot be a border.
 *
 * Tailwind's preflight puts `border-collapse: collapse` on every `<table>`, and in the collapsed
 * model a border belongs to the table's grid rather than to the cell that declared it. The cell is
 * what `position: sticky` moves; the grid is not. So a `border-r` on the role column stays at the
 * table's own left edge and slides away underneath the pinned cell the moment anything is scrolled
 * sideways, leaving the column floating over the permission cells with no line down its side.
 *
 * `sticky-table-header` documents this for the header's bottom edge and fixes it there with an
 * `::after`, which travels because it belongs to the cell. This is the same bug on the other axis,
 * and outside what that component can fix: it pins the cells, and what needs this line is the role
 * column's own trailing edge.
 *
 * **Only this one line, and that was measured rather than assumed.** The row separators looked like
 * they had to go the same way — `border-t` on a `<tr>` is a collapsed border too, so the pinned
 * cell's opaque background ought to hide it. In a browser it does not, and both halves of the
 * reason matter: a row separator is horizontal and spans the whole row, so scrolling never carries
 * it out from under the column the way it carries the vertical edge, and collapsed borders are
 * painted above cell backgrounds rather than beneath them. Drawing them here as well would have
 * been a second line on top of the real one, invisible until a theme gave the two different
 * colours. Row separators stay ordinary `border-t` on the `<tr>`.
 *
 * `::before` rather than `::after` because the corner cell is a `thead th` and already carries
 * `sticky-table-header`'s `::after`.
 */
const PINNED_COLUMN_EDGES = [
  "[&_tbody_th]:before:absolute [&_tbody_th]:before:inset-y-0 [&_tbody_th]:before:right-0",
  "[&_tbody_th]:before:w-px [&_tbody_th]:before:bg-border [&_tbody_th]:before:content-['']",
  "[&_thead_th:first-child]:before:absolute [&_thead_th:first-child]:before:inset-y-0",
  "[&_thead_th:first-child]:before:right-0 [&_thead_th:first-child]:before:w-px",
  "[&_thead_th:first-child]:before:bg-border [&_thead_th:first-child]:before:content-['']",
].join(" ")

export interface PermissionMatrixProps {
  /** The rows. */
  roles: readonly PermissionRole[]
  /** The columns. */
  actions: readonly PermissionAction[]
  /** Controlled explicit grants. Pair with `onGrantsChange`. */
  grants?: PermissionGrants
  /** Explicit grants on first render when uncontrolled. */
  defaultGrants?: PermissionGrants
  /** Handed the next value and what the press did. */
  onGrantsChange?: (next: PermissionGrants, change: PermissionMatrixChange) => void
  /** Locks every cell. */
  disabled?: boolean
  /** Show the row select-all in the first column. Defaults to `true`. */
  roleSelectAll?: boolean
  /** Show the column select-all in the header. Defaults to `true`. */
  actionSelectAll?: boolean
  /** Show the corner select-all. Defaults to `true`. */
  selectAll?: boolean
  /**
   * Makes the component the scrolling box, capped here, so the header row and the role column both
   * stay put. Passed through to `sticky-table-header`, which is the only arrangement in which a
   * table scrolls sideways and keeps a pinned header — see its notes on what owns the scrollport.
   */
  maxHeight?: number | string
  /** Distance from the top of the scrollport to pin the header at. For a fixed app bar. */
  offset?: number | string
  /** Announce changes through a live region. Defaults to `true`. */
  announce?: boolean
  labels?: Partial<PermissionMatrixLabels>
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}

/** Flattens a label to the string an accessible name and an announcement need. */
function labelText(label: React.ReactNode, fallback: string): string {
  if (typeof label === "string") return label
  if (typeof label === "number") return String(label)
  return fallback
}

/**
 * The role × permission grid: a table of checkboxes where the rows are roles and the columns are
 * the things they may do.
 *
 * Reach for it on an admin screen's role editor, a team's permission settings, the scope list on an
 * API token, or a sharing dialog that has outgrown three radio buttons.
 *
 * ```tsx
 * <PermissionMatrix
 *   roles={[
 *     { key: "viewer", label: "Viewer" },
 *     { key: "editor", label: "Editor", inherits: ["viewer"] },
 *     { key: "owner", label: "Owner", inherits: ["editor"], locked: true },
 *   ]}
 *   actions={[
 *     { key: "read", label: "View" },
 *     { key: "write", label: "Edit", requires: ["read"] },
 *     { key: "delete", label: "Delete", requires: ["write"] },
 *   ]}
 *   grants={grants}
 *   onGrantsChange={setGrants}
 * />
 * ```
 *
 * **The value is the explicit grants and nothing else.** A cell can be granted four ways — ticked
 * here, implied by another action on the row, inherited from a parent role, or some combination —
 * and only the first is stored. See {@link PermissionGrants} for why writing the closure into the
 * value is wrong in both directions, and {@link effectivePermissions} for the set a server enforces.
 *
 * **A derived cell is `aria-checked="true"` and `aria-disabled`.** It is granted, so saying
 * otherwise would be a lie about what is enforced; there is nothing explicit on it to remove, so
 * the press is refused and the refusal names what is holding it — `aria-disabled` rather than
 * `disabled` so the cell stays focusable and somebody on a keyboard can find out that the grant
 * exists and where it comes from.
 *
 * **One tab stop, arrow keys inside.** A table of checkboxes where every cell is a tab stop costs
 * eight roles times ten permissions equals eighty presses of Tab to get past, which is why this is
 * `role="grid"` with a roving tabindex: Tab reaches the grid, the arrows move within it, Home and
 * End run along the row, and with the modifier they go to the corners. The select-alls are cells in
 * the same grid — the header line and the first column — so there is one way to move and no
 * separate tab stops hiding above the table.
 *
 * **The header row and the role column pin on scroll**, by composing `sticky-table-header`: a
 * matrix of any size scrolls in both directions and a cell in the middle of it is meaningless
 * without both of its names on screen.
 */
export function PermissionMatrix({
  roles,
  actions,
  grants,
  defaultGrants,
  onGrantsChange,
  disabled = false,
  roleSelectAll = true,
  actionSelectAll = true,
  selectAll = true,
  maxHeight,
  offset = 0,
  announce = true,
  labels: labelOverrides,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: PermissionMatrixProps) {
  const labels = React.useMemo(
    () => ({ ...defaultPermissionMatrixLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const controlled = grants !== undefined
  const [internal, setInternal] = React.useState<PermissionGrants>(
    () => (controlled ? (grants as PermissionGrants) : defaultGrants) ?? {}
  )
  const value = controlled ? (grants as PermissionGrants) : internal

  const reactId = React.useId()
  const resolved = React.useMemo(
    () => resolvePermissionMatrix(roles, actions, value, { disabled }),
    [roles, actions, value, disabled]
  )

  const roleName = React.useCallback(
    (key: string) => {
      const row = roles.find((candidate) => candidate.key === key)
      return row ? labelText(row.label, key) : key
    },
    [roles]
  )
  const actionName = React.useCallback(
    (key: string) => {
      const column = actions.find((candidate) => candidate.key === key)
      return column ? labelText(column.label, key) : key
    },
    [actions]
  )
  const names = React.useMemo(
    () => ({ role: roleName, action: actionName }),
    [roleName, actionName]
  )

  const [announcement, setAnnouncement] = React.useState("")
  React.useEffect(() => {
    if (!announcement) return
    const timer = setTimeout(() => setAnnouncement(""), 1600)
    return () => clearTimeout(timer)
  }, [announcement])
  const say = React.useCallback(
    (message: string) => {
      if (!announce) return
      // Setting a live region to the text it already holds is not a change, so the second identical
      // refusal in a row would be silent. A zero-width space makes it a different string and leaves
      // the sentence looking and sounding the same — the trick `column-visibility` uses, for the
      // same reason.
      setAnnouncement((current) => (current === message ? `${message}​` : message))
    },
    [announce]
  )

  const commit = React.useCallback(
    (result: { grants: PermissionGrants; change: PermissionMatrixChange } | null) => {
      if (!result) return false
      if (!controlled) setInternal(result.grants)
      onGrantsChange?.(result.grants, result.change)
      return true
    },
    [controlled, onGrantsChange]
  )

  // Row and column 0 are the select-all line and the role column, so the grid is one larger than
  // the matrix on both axes and every interactive thing in the table is reachable the same way.
  const [focus, setFocus] = React.useState<MatrixFocus>({ row: 1, col: 1 })
  const cellRefs = React.useRef(new Map<string, { focus?: () => void }>())
  const moving = React.useRef(false)
  const posKey = (row: number, col: number) => `${row}:${col}`

  React.useEffect(() => {
    if (!moving.current) return
    moving.current = false
    cellRefs.current.get(posKey(focus.row, focus.col))?.focus?.()
  }, [focus])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTableElement>) => {
    const next = nextMatrixFocus(focus, event.key, {
      rows: roles.length,
      cols: actions.length,
      ctrl: event.ctrlKey || event.metaKey,
    })
    if (!next) return
    event.preventDefault()
    moving.current = true
    setFocus(next)
  }

  const register = (row: number, col: number) => (node: { focus?: () => void } | null) => {
    if (node) cellRefs.current.set(posKey(row, col), node)
    else cellRefs.current.delete(posKey(row, col))
  }

  const scopeAll = labels.all

  function pressCell(roleKey: string, actionKey: string) {
    const cell = resolved.cell(roleKey, actionKey)
    if (!cell) return
    if (!cell.togglable) {
      const reason = permissionCellReason(cell, names, labels)
      if (reason) say(labels.refused(reason))
      return
    }
    const result = togglePermissionCell(roles, actions, value, roleKey, actionKey, { disabled })
    if (!commit(result) || !result) return
    const role = roleName(roleKey)
    const action = actionName(actionKey)
    if (result.change.granted.length > 0) {
      say(labels.granted(role, action))
      return
    }
    if (result.change.stillGranted.length > 0) {
      const after = resolvePermissionMatrix(roles, actions, result.grants, { disabled }).cell(
        roleKey,
        actionKey
      )
      const reason = after ? permissionCellReason(after, names, labels) : null
      say(labels.revokedStillGranted(role, action, reason ?? ""))
      return
    }
    say(labels.revoked(role, action))
  }

  function pressScope(
    result: { grants: PermissionGrants; change: PermissionMatrixChange } | null,
    summary: PermissionAggregate | undefined,
    scopeLabel: string
  ) {
    if (!result || summary?.togglable === 0) {
      say(labels.bulkNothing(scopeLabel))
      return
    }
    if (!commit(result)) {
      say(labels.bulkNothing(scopeLabel))
      return
    }
    if (result.change.granted.length > 0) {
      say(labels.bulkGranted(result.change.granted.length, scopeLabel))
    } else {
      say(
        labels.bulkRevoked(
          result.change.revoked.length,
          scopeLabel,
          result.change.stillGranted.length
        )
      )
    }
  }

  const ariaChecked = (state: PermissionAggregate["state"]) =>
    state === "mixed" ? ("mixed" as const) : state === "checked"

  return (
    <div className={cn("text-foreground", className)}>
      <StickyTableHeader
        maxHeight={maxHeight}
        offset={offset}
        stickyColumns={1}
        className={PINNED_COLUMN_EDGES}
      >
        <table
          role="grid"
          aria-label={ariaLabelledby ? undefined : (ariaLabel ?? labels.caption)}
          aria-labelledby={ariaLabelledby}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
          className="w-full border-collapse text-sm"
        >
          <caption className="sr-only">{labels.caption}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                role="columnheader"
                className="bg-background px-3 py-2 text-left align-bottom font-medium"
              >
                {selectAll ? (
                  <CheckboxCell
                    ref={register(0, 0)}
                    label={scopeAll}
                    state={ariaChecked(resolved.all.state)}
                    inert={resolved.all.togglable === 0}
                    tabIndex={focus.row === 0 && focus.col === 0 ? 0 : -1}
                    onFocus={() => setFocus({ row: 0, col: 0 })}
                    onPress={() =>
                      pressScope(
                        togglePermissionMatrix(roles, actions, value, { disabled }),
                        resolved.all,
                        scopeAll
                      )
                    }
                  />
                ) : (
                  <span className="sr-only">{labels.caption}</span>
                )}
              </th>
              {actions.map((column, columnIndex) => {
                const summary = resolved.actions.get(column.key)
                const labelId = `${reactId}-a${columnIndex}`
                const descId = `${labelId}-d`
                const scopeLabel = labels.actionForAllRoles(actionName(column.key))
                return (
                  <th
                    key={column.key}
                    scope="col"
                    role="columnheader"
                    className="bg-background px-3 py-2 align-bottom font-medium"
                  >
                    <div className="flex flex-col items-center gap-1.5">
                      <span id={labelId} className="text-xs leading-tight">
                        {column.label}
                      </span>
                      {column.description && (
                        <span id={descId} className="text-[11px] text-muted-foreground">
                          {column.description}
                        </span>
                      )}
                      {actionSelectAll && summary && (
                        <CheckboxCell
                          ref={register(0, columnIndex + 1)}
                          label={scopeLabel}
                          describedBy={column.description ? descId : undefined}
                          state={ariaChecked(summary.state)}
                          inert={summary.togglable === 0}
                          tabIndex={focus.row === 0 && focus.col === columnIndex + 1 ? 0 : -1}
                          onFocus={() => setFocus({ row: 0, col: columnIndex + 1 })}
                          onPress={() =>
                            pressScope(
                              togglePermissionAction(roles, actions, value, column.key, {
                                disabled,
                              }),
                              summary,
                              scopeLabel
                            )
                          }
                        />
                      )}
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {roles.map((row, rowIndex) => {
              const summary = resolved.roles.get(row.key)
              const labelId = `${reactId}-r${rowIndex}`
              const descId = `${labelId}-d`
              const scopeLabel = labels.allForRole(roleName(row.key))
              return (
                <tr key={row.key} className="border-t border-border">
                  <th
                    scope="row"
                    role="rowheader"
                    className="bg-background px-3 py-2 text-left font-normal"
                  >
                    <div className="flex items-center gap-2">
                      {roleSelectAll && summary && (
                        <CheckboxCell
                          ref={register(rowIndex + 1, 0)}
                          label={scopeLabel}
                          state={ariaChecked(summary.state)}
                          inert={summary.togglable === 0}
                          tabIndex={focus.row === rowIndex + 1 && focus.col === 0 ? 0 : -1}
                          onFocus={() => setFocus({ row: rowIndex + 1, col: 0 })}
                          onPress={() =>
                            pressScope(
                              togglePermissionRole(roles, actions, value, row.key, { disabled }),
                              summary,
                              scopeLabel
                            )
                          }
                        />
                      )}
                      <span>
                        <span id={labelId} className="font-medium">
                          {row.label}
                        </span>
                        {row.description && (
                          <span
                            id={descId}
                            className="block text-xs text-muted-foreground"
                          >
                            {row.description}
                          </span>
                        )}
                      </span>
                    </div>
                  </th>
                  {actions.map((column, columnIndex) => {
                    const cell = resolved.cell(row.key, column.key) as PermissionCellState
                    const reason = permissionCellReason(cell, names, labels)
                    const reasonId = `${reactId}-c${rowIndex}-${columnIndex}`
                    return (
                      <td key={column.key} role="gridcell" className="px-3 py-2 text-center">
                        <CheckboxCell
                          ref={register(rowIndex + 1, columnIndex + 1)}
                          // Named by both of its headers rather than by a string of its own, so the
                          // two names come from the rendered labels and translate with them. Role
                          // first: "Editor, Delete" is a sentence about the role, which is the
                          // question being answered one cell at a time.
                          labelledBy={`${labelId} ${`${reactId}-a${columnIndex}`}`}
                          describedBy={reason ? reasonId : undefined}
                          state={cell.granted}
                          derived={cell.granted && !cell.explicit}
                          locked={cell.blocked === "locked"}
                          inert={!cell.togglable}
                          tabIndex={
                            focus.row === rowIndex + 1 && focus.col === columnIndex + 1 ? 0 : -1
                          }
                          onFocus={() => setFocus({ row: rowIndex + 1, col: columnIndex + 1 })}
                          onPress={() => pressCell(row.key, column.key)}
                        />
                        {reason && (
                          <span id={reasonId} className="sr-only">
                            {reason}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </StickyTableHeader>
      {/*
        Mounted at all times rather than rendered with the message: a live region inserted together
        with its text is not an update to a region that was already being watched, and the first
        announcement is the one that goes missing.
      */}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}

interface CheckboxCellProps {
  label?: string
  labelledBy?: string
  describedBy?: string
  state: boolean | "mixed"
  /** Granted, but by something other than this cell — drawn differently so the tick is readable. */
  derived?: boolean
  locked?: boolean
  /** A press cannot change anything here. */
  inert?: boolean
  tabIndex: number
  onFocus: () => void
  onPress: () => void
}

/**
 * One pressable cell: the cells, the row and column select-alls and the corner are all this.
 *
 * `role="checkbox"` on a button rather than an `<input type="checkbox">`, for the reason
 * `nested-checkbox` is built the same way: the third state is the value `aria-checked="mixed"`, and
 * `indeterminate` is a DOM property with no HTML attribute behind it, so React cannot express it in
 * JSX and it has to be written to the node through a ref after mount. Everything that reads markup
 * instead of a live DOM — the server render, the first paint, a snapshot, a crawler — then sees
 * `aria-checked="false"` on a control that is part-selected. Here the state is an attribute and the
 * markup is true at every moment.
 */
const CheckboxCell = React.forwardRef<HTMLButtonElement, CheckboxCellProps>(
  function CheckboxCell(
    { label, labelledBy, describedBy, state, derived, locked, inert, tabIndex, onFocus, onPress },
    ref
  ) {
    const on = state === true || state === "mixed"
    return (
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={state === "mixed" ? "mixed" : state}
        // aria-disabled, not the `disabled` attribute: a refused cell stays focusable, so somebody
        // moving through the grid can still find out that the grant exists and what is holding it.
        // `disabled` would take it out of the grid and leave no way to ask.
        aria-disabled={inert || undefined}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={tabIndex}
        onFocus={onFocus}
        onClick={onPress}
        className={cn(
          "group inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          !on && "border-input bg-background",
          on && !derived && "border-primary bg-primary text-primary-foreground",
          // A derived tick is drawn as an outline rather than a filled box, so "granted here" and
          // "granted somewhere else" are told apart without reading the tooltip — the distinction
          // core 2 of this component is about, and the thing a screen reader gets from
          // aria-describedby instead.
          on && derived && "border-primary bg-primary/15 text-primary",
          inert ? "cursor-not-allowed" : "cursor-pointer hover:border-primary"
        )}
      >
        {locked ? (
          <Lock className="h-3 w-3" aria-hidden="true" />
        ) : state === "mixed" ? (
          <Minus className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
        ) : on ? (
          <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
        ) : null}
      </button>
    )
  }
)
