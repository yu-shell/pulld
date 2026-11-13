// A role × permission grid is the component where every shortcut is invisible until somebody is
// already relying on it. The cases below are each written against a version that got one of these
// wrong:
//
//   - closing the requirement graph over its own origin, so a `requires` cycle — or the one-line
//     `requires: ["self"]` — reports a cell as required by itself, which makes it derived, which
//     refuses every press, which means the grant can never be removed by anyone,
//   - following requirements from other requirements instead of from root causes, which pins two
//     cells in a cycle against each other for the same reason,
//   - inheriting a parent's *ticked* grants rather than its effective set, so a grandparent's
//     permissions stop one level short,
//   - writing the requirement closure into the value, which leaves `read` ticked with nothing
//     saying why after `write` goes, and never grants `list` to anyone when a deploy says `write`
//     requires it,
//   - deciding what a select-all press does from the state on screen, so a row held at "mixed" by a
//     single inherited cell reads as "grant the rest" forever and can never be cleared,
//   - reporting a revoked cell as revoked when a requirement still holds it, so the tick does not
//     go away and the control reads as broken,
//   - dropping grants for roles the matrix is not currently rendering,
//   - marking a refused cell with the `disabled` attribute, which takes it out of the grid so
//     nobody can find out the grant exists or where it comes from,
//   - and letting every cell be its own tab stop, which is eighty presses of Tab to get past an
//     eight-by-ten matrix.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

// The real sticky-table-header, loaded rather than stubbed, for the reason terms-scroll-gate loads
// the real scroll-shadow: a stub would turn the assertion that the composition works into an
// assertion about a copy, and the registryDependencies entry would then be decoration.
const stickyTableHeader = loadComponent(join(ROOT, "registry", "ui", "sticky-table-header.tsx"))

const {
  PermissionMatrix,
  resolvePermissionMatrix,
  effectivePermissions,
  expandRequiredActions,
  inheritedRoleKeys,
  togglePermissionCell,
  togglePermissionRole,
  togglePermissionAction,
  togglePermissionMatrix,
  nextMatrixFocus,
  permissionCellReason,
  defaultPermissionMatrixLabels,
} = loadComponent(join(ROOT, "registry", "ui", "permission-matrix.tsx"), {
  stubs: {
    "lucide-react": { Check: icon("check"), Lock: icon("lock"), Minus: icon("minus") },
    "@/registry/ui/sticky-table-header": stickyTableHeader,
  },
})

// read ← write ← delete, so a grant of delete reaches read through two hops.
const ACTIONS = [
  { key: "read", label: "View" },
  { key: "write", label: "Edit", requires: ["read"] },
  { key: "delete", label: "Delete", requires: ["write"] },
  { key: "billing", label: "Billing" },
]

// viewer ← editor ← owner, so owner reaches viewer's grants through two hops.
const ROLES = [
  { key: "viewer", label: "Viewer" },
  { key: "editor", label: "Editor", inherits: ["viewer"] },
  { key: "owner", label: "Owner", inherits: ["editor"] },
]

const cellAt = (rows, columns, grants, roleKey, actionKey) =>
  resolvePermissionMatrix(rows, columns, grants).cell(roleKey, actionKey)

// ---------------------------------------------------------------------------- closures

test("a requirement cycle never reports a cell as requiring itself", () => {
  const columns = [
    { key: "a", label: "A", requires: ["b"] },
    { key: "b", label: "B", requires: ["a"] },
  ]
  // The closure of {a} contains a (it was asked for) and b (a needs it) — but a is there because it
  // was an origin, not because it requires itself, which is what the cell state has to distinguish.
  assert.deepEqual(expandRequiredActions(columns, ["a"]), ["a", "b"])

  const grants = { r: ["a"] }
  const rows = [{ key: "r", label: "R" }]
  const a = cellAt(rows, columns, grants, "r", "a")
  const b = cellAt(rows, columns, grants, "r", "b")

  assert.deepEqual(a.requiredBy, [], "a is held by nothing: b is granted only because of a")
  assert.equal(a.togglable, true, "the only explicit grant in the cycle must stay removable")
  assert.deepEqual(b.requiredBy, ["a"])
  assert.equal(b.togglable, false)
})

test("an action that requires itself does not lock itself", () => {
  const columns = [{ key: "a", label: "A", requires: ["a"] }]
  const rows = [{ key: "r", label: "R" }]
  const a = cellAt(rows, columns, { r: ["a"] }, "r", "a")
  assert.deepEqual(a.requiredBy, [])
  assert.equal(a.togglable, true)
})

test("both explicit cells in a requirement cycle can be cleared, one after the other", () => {
  const columns = [
    { key: "a", label: "A", requires: ["b"] },
    { key: "b", label: "B", requires: ["a"] },
  ]
  const rows = [{ key: "r", label: "R" }]
  let grants = { r: ["a", "b"] }

  const first = togglePermissionCell(rows, columns, grants, "r", "a")
  assert.ok(first, "an explicit grant stays pressable even while something else requires it")
  grants = first.grants
  assert.deepEqual(first.change.stillGranted, [{ roleKey: "r", actionKey: "a" }])
  assert.equal(cellAt(rows, columns, grants, "r", "a").granted, true, "still held by b")

  const second = togglePermissionCell(rows, columns, grants, "r", "b")
  assert.ok(second, "b is the last root cause and is still explicit, so it is pressable")
  grants = second.grants
  assert.equal(cellAt(rows, columns, grants, "r", "a").granted, false)
  assert.equal(cellAt(rows, columns, grants, "r", "b").granted, false, "the cycle lets go")
})

test("a role that inherits itself does not hold its own grants by inheritance", () => {
  const rows = [{ key: "r", label: "R", inherits: ["r"] }]
  assert.deepEqual(inheritedRoleKeys(rows, "r"), [])
  const cell = cellAt(rows, ACTIONS, { r: ["read"] }, "r", "read")
  assert.deepEqual(cell.inheritedFrom, [])
  assert.equal(cell.togglable, true)
})

test("an inheritance cycle terminates and excludes the role itself", () => {
  const rows = [
    { key: "a", label: "A", inherits: ["b"] },
    { key: "b", label: "B", inherits: ["a"] },
  ]
  assert.deepEqual(inheritedRoleKeys(rows, "a"), ["b"])
  const cell = cellAt(rows, ACTIONS, { a: ["read"] }, "a", "read")
  assert.equal(cell.togglable, true, "a's own grant is not inherited from a")
})

test("unknown keys in requires and inherits are ignored rather than thrown on", () => {
  const columns = [{ key: "a", label: "A", requires: ["gone"] }]
  const rows = [{ key: "r", label: "R", inherits: ["removed"] }]
  assert.deepEqual(expandRequiredActions(columns, ["a"]), ["a"])
  assert.deepEqual(inheritedRoleKeys(rows, "r"), [])
  assert.equal(cellAt(rows, columns, { r: ["a"] }, "r", "a").granted, true)
})

test("expandRequiredActions orders by the column list and keeps unrecognised origins at the end", () => {
  // Asked for in the opposite order to the columns, so a result that merely echoed the input would
  // come back reversed.
  assert.deepEqual(expandRequiredActions(ACTIONS, ["delete", "billing"]), [
    "read",
    "write",
    "delete",
    "billing",
  ])
  assert.deepEqual(expandRequiredActions(ACTIONS, ["legacy"]), ["legacy"])
})

// ---------------------------------------------------------------------------- derivation

test("a transitive requirement is attributed to the root cause, not to the hop before it", () => {
  const grants = { viewer: ["delete"] }
  const read = cellAt(ROLES, ACTIONS, grants, "viewer", "read")
  assert.equal(read.granted, true)
  assert.deepEqual(read.requiredBy, ["delete"], "write is not a root cause: nothing ticked it")
  assert.equal(read.explicit, false, "the closure is never written into the value")
  assert.deepEqual(grants, { viewer: ["delete"] }, "and the value handed in is not mutated")
})

test("inheritance passes on a parent's effective set, not the grants ticked on its row", () => {
  // read is ticked on viewer; editor inherits viewer; owner inherits editor and never touches viewer.
  const grants = { viewer: ["read"] }
  const owner = cellAt(ROLES, ACTIONS, grants, "owner", "read")
  assert.equal(owner.granted, true, "a grandparent's grant has to reach the grandchild")
  assert.deepEqual(owner.inheritedFrom, ["editor"], "attributed to the parent it came through")
  assert.equal(owner.togglable, false)
})

test("inheritance carries what the parent's own requirements implied", () => {
  const grants = { viewer: ["write"] }
  const owner = cellAt(ROLES, ACTIONS, grants, "owner", "read")
  assert.equal(owner.granted, true, "viewer's write implies read, and owner inherits the result")
})

test("granted agrees with effectivePermissions for every cell in the grid", () => {
  const grants = { viewer: ["read"], editor: ["write"], owner: ["billing", "ghost"] }
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, grants)
  for (const row of ROLES) {
    const effective = new Set(effectivePermissions(ROLES, ACTIONS, grants, row.key))
    for (const column of ACTIONS) {
      assert.equal(
        resolved.cell(row.key, column.key).granted,
        effective.has(column.key),
        `${row.key} × ${column.key}: the screen and the authorization check must not disagree`
      )
    }
  }
  assert.ok(
    effectivePermissions(ROLES, ACTIONS, grants, "owner").includes("ghost"),
    "an action this screen does not render is still enforced and must be reported"
  )
})

// ---------------------------------------------------------------------------- pressing a cell

test("a derived cell refuses the press and says what is holding it", () => {
  const grants = { viewer: ["write"] }
  const read = cellAt(ROLES, ACTIONS, grants, "viewer", "read")
  assert.equal(read.togglable, false)
  assert.equal(read.blocked, "derived")
  assert.equal(togglePermissionCell(ROLES, ACTIONS, grants, "viewer", "read"), null)

  const reason = permissionCellReason(read, {
    role: (key) => key,
    action: (key) => key,
  })
  assert.match(reason, /write/, "the reason names the action, so the way out is on screen")
})

test("an explicit cell that is also derived stays pressable, and the tick does not go away", () => {
  // read ticked first, then write — a reachable order, and the only one that produces this state.
  const grants = { viewer: ["read", "write"] }
  const before = cellAt(ROLES, ACTIONS, grants, "viewer", "read")
  assert.equal(before.explicit, true)
  assert.deepEqual(before.requiredBy, ["write"])
  assert.equal(before.togglable, true)

  const result = togglePermissionCell(ROLES, ACTIONS, grants, "viewer", "read")
  assert.deepEqual(result.grants, { viewer: ["write"] }, "the explicit grant is gone from the value")
  assert.deepEqual(result.change.revoked, [{ roleKey: "viewer", actionKey: "read" }])
  assert.deepEqual(
    result.change.stillGranted,
    [{ roleKey: "viewer", actionKey: "read" }],
    "reporting this as a plain revoke is what makes the control read as broken"
  )
  assert.equal(cellAt(ROLES, ACTIONS, result.grants, "viewer", "read").granted, true)
})

test("a locked row and a locked column both refuse, and disabled locks the grid", () => {
  const rows = [{ key: "owner", label: "Owner", locked: true }, { key: "r", label: "R" }]
  const columns = [{ key: "a", label: "A" }, { key: "b", label: "B", locked: true }]
  assert.equal(cellAt(rows, columns, {}, "owner", "a").blocked, "locked")
  assert.equal(cellAt(rows, columns, {}, "r", "b").blocked, "locked")
  assert.equal(cellAt(rows, columns, {}, "r", "a").blocked, null)
  assert.equal(togglePermissionCell(rows, columns, {}, "owner", "a"), null)

  const off = resolvePermissionMatrix(rows, columns, {}, { disabled: true })
  assert.ok(off.cells.every((cell) => cell.blocked === "locked"))
})

test("grants for roles and actions the matrix is not rendering survive a press", () => {
  const grants = { viewer: ["read"], "role-on-another-page": ["read"], editor: ["retired-action"] }
  const result = togglePermissionCell(ROLES, ACTIONS, grants, "owner", "billing")
  assert.deepEqual(result.grants["role-on-another-page"], ["read"])
  assert.deepEqual(
    result.grants.editor,
    ["retired-action"],
    "a filtered or paginated matrix must not quietly discard what it cannot currently see"
  )
})

test("a row with no explicit grants is removed from the value rather than left empty", () => {
  const grants = { viewer: ["read"] }
  const result = togglePermissionCell(ROLES, ACTIONS, grants, "viewer", "read")
  assert.equal("viewer" in result.grants, false)
})

// ---------------------------------------------------------------------------- select-all

test("a row's display counts every cell and its press counts only the ones it may change", () => {
  // owner inherits everything viewer has, so owner's read is granted and refused. Its row therefore
  // shows "mixed" while every cell it can actually change is off.
  const grants = { viewer: ["read"] }
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, grants)
  const owner = resolved.roles.get("owner")
  assert.equal(owner.state, "mixed", "the summary tells the truth about what is enforced")
  assert.equal(owner.togglable, 3, "read is derived; the other three are free")
  assert.equal(
    owner.pressWould,
    "grant",
    "read off the displayed state and this row could never be cleared"
  )
})

test("a row held at mixed by an inherited cell clears on the first press", () => {
  const grants = { viewer: ["read"], owner: ["write", "delete", "billing"] }
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, grants)
  assert.equal(resolved.roles.get("owner").state, "checked")
  assert.equal(resolved.roles.get("owner").pressWould, "revoke")

  const result = togglePermissionRole(ROLES, ACTIONS, grants, "owner")
  assert.equal("owner" in result.grants, false, "one press, and the row's own grants are gone")
  assert.equal(result.change.revoked.length, 3)
  assert.deepEqual(
    result.change.stillGranted,
    [],
    "none of the three was held by anything else"
  )
})

test("a select-all with nothing it may change returns null rather than a silent no-op", () => {
  const rows = [{ key: "owner", label: "Owner", locked: true }]
  assert.equal(togglePermissionRole(rows, ACTIONS, {}, "owner"), null)
  assert.equal(resolvePermissionMatrix(rows, ACTIONS, {}).roles.get("owner").togglable, 0)
})

test("a column's select-all writes down the column and skips the cells it may not touch", () => {
  const grants = { viewer: ["write"] }
  // viewer's read is derived (write requires it); editor's and owner's are inherited.
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, grants)
  assert.equal(resolved.actions.get("read").togglable, 0)
  assert.equal(togglePermissionAction(ROLES, ACTIONS, grants, "read"), null)

  const billing = togglePermissionAction(ROLES, ACTIONS, grants, "billing")
  assert.equal(billing.change.granted.length, 3)
  assert.deepEqual(billing.grants.viewer, ["write", "billing"])
})

test("the corner select-all grants every free cell, then revokes exactly those", () => {
  const granted = togglePermissionMatrix(ROLES, ACTIONS, {})
  assert.equal(granted.change.granted.length, ROLES.length * ACTIONS.length)
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, granted.grants)
  assert.equal(resolved.all.state, "checked")
  assert.equal(resolved.all.pressWould, "revoke")

  const cleared = togglePermissionMatrix(ROLES, ACTIONS, granted.grants)
  assert.deepEqual(cleared.grants, {})
  assert.equal(
    resolvePermissionMatrix(ROLES, ACTIONS, cleared.grants).all.state,
    "unchecked"
  )
})

test("a revoking select-all reports the cells something outside the press still holds", () => {
  // Two columns, so every togglable cell in editor's row is explicit and the press is a revoke —
  // with four, two of them off, the row is mixed and the press grants instead. Editor's read is
  // both ticked here and inherited from viewer, which is what survives the press.
  const columns = [
    { key: "read", label: "View" },
    { key: "write", label: "Edit", requires: ["read"] },
  ]
  const grants = { viewer: ["read"], editor: ["read", "write"] }
  const summary = resolvePermissionMatrix(ROLES, columns, grants).roles.get("editor")
  assert.equal(summary.pressWould, "revoke")

  const result = togglePermissionRole(ROLES, columns, grants, "editor")
  assert.equal(result.change.revoked.length, 2)
  assert.deepEqual(
    result.change.stillGranted,
    [{ roleKey: "editor", actionKey: "read" }],
    "viewer still grants read, so that tick does not go away and something has to say so"
  )
  assert.deepEqual(result.grants.viewer, ["read"], "and viewer's own row is untouched")
})

test("a row kept off 'checked' by a locked column still clears on the first press", () => {
  // The row can never display "checked" — the locked column is off and stays off — so a press
  // direction read off the displayed state would say "grant" forever and the row would be stuck.
  const columns = [
    { key: "read", label: "View" },
    { key: "audit", label: "Audit", locked: true },
  ]
  const rows = [{ key: "r", label: "R" }]
  const grants = { r: ["read"] }
  const summary = resolvePermissionMatrix(rows, columns, grants).roles.get("r")
  assert.equal(summary.state, "mixed")
  assert.equal(summary.togglable, 1)
  assert.equal(summary.pressWould, "revoke")

  const result = togglePermissionRole(rows, columns, grants, "r")
  assert.deepEqual(result.grants, {}, "one press clears what the row actually controls")
})

test("granting a cell writes that key and not the closure behind it", () => {
  const result = togglePermissionCell(ROLES, ACTIONS, {}, "viewer", "delete")
  assert.deepEqual(
    result.grants,
    { viewer: ["delete"] },
    "read and write are implied, and implied is not the same as chosen"
  )
  assert.deepEqual(result.change.granted, [{ roleKey: "viewer", actionKey: "delete" }])
  const resolved = resolvePermissionMatrix(ROLES, ACTIONS, result.grants)
  assert.equal(resolved.cell("viewer", "read").granted, true, "and read is granted all the same")
  assert.equal(resolved.cell("viewer", "read").explicit, false)

  // The other half of the same decision: pressing delete again takes read back with it, because
  // read was never stored and nothing else holds it.
  const off = togglePermissionCell(ROLES, ACTIONS, result.grants, "viewer", "delete")
  assert.deepEqual(off.grants, {})
  assert.equal(
    resolvePermissionMatrix(ROLES, ACTIONS, off.grants).cell("viewer", "read").granted,
    false
  )
})

test("effectivePermissions is transitive on its own, not only inside the grid", () => {
  // This is the function an authorization check calls with one role and no component around it, so
  // the chain has to close here rather than in the loop that resolves the rows one parent at a time.
  assert.deepEqual(
    effectivePermissions(ROLES, ACTIONS, { viewer: ["read"] }, "owner"),
    ["read"],
    "owner inherits editor inherits viewer"
  )
  assert.deepEqual(
    effectivePermissions(ROLES, ACTIONS, { viewer: ["delete"] }, "owner"),
    ["read", "write", "delete"],
    "and the requirement closure runs over what was inherited"
  )
  assert.deepEqual(effectivePermissions(ROLES, ACTIONS, { owner: ["read"] }, "viewer"), [])
})

// ---------------------------------------------------------------------------- keyboard

test("arrow keys clamp at every edge instead of wrapping", () => {
  const dims = { rows: 3, cols: 4 }
  assert.deepEqual(nextMatrixFocus({ row: 1, col: 1 }, "ArrowRight", dims), { row: 1, col: 2 })
  assert.deepEqual(nextMatrixFocus({ row: 1, col: 1 }, "ArrowDown", dims), { row: 2, col: 1 })
  assert.equal(nextMatrixFocus({ row: 0, col: 0 }, "ArrowUp", dims), null, "no wrap off the top")
  assert.equal(nextMatrixFocus({ row: 0, col: 0 }, "ArrowLeft", dims), null)
  assert.equal(nextMatrixFocus({ row: 3, col: 4 }, "ArrowDown", dims), null, "no wrap off the end")
  assert.equal(nextMatrixFocus({ row: 3, col: 4 }, "ArrowRight", dims), null)
})

test("row 0 and column 0 are reachable, because the select-alls live there", () => {
  const dims = { rows: 3, cols: 4 }
  assert.deepEqual(nextMatrixFocus({ row: 1, col: 1 }, "ArrowUp", dims), { row: 0, col: 1 })
  assert.deepEqual(nextMatrixFocus({ row: 1, col: 1 }, "ArrowLeft", dims), { row: 1, col: 0 })
})

test("Home and End run along the row, and take the modifier to mean the grid", () => {
  const dims = { rows: 3, cols: 4 }
  assert.deepEqual(nextMatrixFocus({ row: 2, col: 3 }, "Home", dims), { row: 2, col: 0 })
  assert.deepEqual(nextMatrixFocus({ row: 2, col: 1 }, "End", dims), { row: 2, col: 4 })
  assert.deepEqual(
    nextMatrixFocus({ row: 2, col: 3 }, "Home", { ...dims, ctrl: true }),
    { row: 0, col: 0 }
  )
  assert.deepEqual(
    nextMatrixFocus({ row: 2, col: 3 }, "End", { ...dims, ctrl: true }),
    { row: 3, col: 4 }
  )
})

test("a key that moves nothing returns null, so the press is not swallowed", () => {
  const dims = { rows: 3, cols: 4 }
  assert.equal(nextMatrixFocus({ row: 2, col: 0 }, "Home", dims), null)
  assert.equal(nextMatrixFocus({ row: 0, col: 0 }, "Home", { ...dims, ctrl: true }), null)
  assert.equal(nextMatrixFocus({ row: 1, col: 1 }, " ", dims), null)
  assert.equal(nextMatrixFocus({ row: 1, col: 1 }, "Tab", dims), null)
})

// ---------------------------------------------------------------------------- markup

const mount = (props) =>
  render(PermissionMatrix, { roles: ROLES, actions: ACTIONS, ...props })

test("every cell is named by both of its headers, role first", () => {
  const instance = mount({ grants: {} })
  const nodes = walk(instance.tree)
  const roleLabel = nodes.find((n) => n.props?.children === "Viewer")
  const actionLabel = nodes.find((n) => n.props?.children === "Delete")
  assert.ok(roleLabel?.props?.id && actionLabel?.props?.id)

  const named = byRole(nodes, "checkbox").filter(
    (n) => n.props["aria-labelledby"] === `${roleLabel.props.id} ${actionLabel.props.id}`
  )
  assert.equal(named.length, 1, "one cell carries exactly this pair of names")
  assert.equal(
    named[0].props["aria-labelledby"].indexOf(roleLabel.props.id),
    0,
    "role first: the cell answers a question about the role"
  )
})

test("a derived cell is announced as checked and refused, not as unchecked", () => {
  const nodes = walk(mount({ grants: { viewer: ["write"] } }).tree)
  const roleLabel = nodes.find((n) => n.props?.children === "Viewer")
  const readLabel = nodes.find((n) => n.props?.children === "View")
  const cell = byRole(nodes, "checkbox").find(
    (n) => n.props["aria-labelledby"] === `${roleLabel.props.id} ${readLabel.props.id}`
  )
  assert.equal(cell.props["aria-checked"], true, "it is granted; saying otherwise would be a lie")
  assert.equal(cell.props["aria-disabled"], true)
  assert.equal(cell.props.disabled, undefined, "disabled would take it out of the grid")
  assert.ok(cell.props["aria-describedby"], "and the reason is wired up")
})

test("the grid has one tab stop, and it moves with the focused cell", () => {
  const nodes = walk(mount({ grants: {} }).tree)
  const boxes = byRole(nodes, "checkbox")
  assert.equal(
    boxes.length,
    (ROLES.length + 1) * (ACTIONS.length + 1),
    "every cell, every select-all, and the corner"
  )
  assert.equal(
    boxes.filter((n) => n.props.tabIndex === 0).length,
    1,
    "eighty tab stops is the thing role=grid exists to avoid"
  )
  const table = byRole(nodes, "grid")
  assert.equal(table.length, 1)
  assert.equal(byTag(nodes, "caption").length, 1, "and it has a caption naming it")
})

test("the live region is mounted before it has anything to say", () => {
  const nodes = walk(mount({ grants: {} }).tree)
  const live = nodes.filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(live.length, 1)
  assert.equal(
    live[0].props.children,
    "",
    "a region inserted together with its text is not an update, and the first message is lost"
  )
})

test("an uncontrolled grid keeps its own value, and a controlled one does not move on its own", () => {
  const seen = []
  const uncontrolled = render(PermissionMatrix, {
    roles: ROLES,
    actions: ACTIONS,
    defaultGrants: { viewer: ["read"] },
    onGrantsChange: (next, change) => seen.push([next, change]),
  })
  const nodes = walk(uncontrolled.tree)
  const roleLabel = nodes.find((n) => n.props?.children === "Viewer")
  const billingLabel = nodes.find((n) => n.props?.children === "Billing")
  const cell = byRole(nodes, "checkbox").find(
    (n) => n.props["aria-labelledby"] === `${roleLabel.props.id} ${billingLabel.props.id}`
  )
  assert.equal(cell.props["aria-checked"], false)

  cell.props.onClick()
  uncontrolled.rerender()
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0][0], { viewer: ["read", "billing"] })
  assert.equal(seen[0][1].kind, "cell")

  const after = walk(uncontrolled.tree)
  const roleAfter = after.find((n) => n.props?.children === "Viewer")
  const billingAfter = after.find((n) => n.props?.children === "Billing")
  assert.equal(
    byRole(after, "checkbox").find(
      (n) => n.props["aria-labelledby"] === `${roleAfter.props.id} ${billingAfter.props.id}`
    ).props["aria-checked"],
    true
  )
})

test("labels are replaceable one at a time", () => {
  const nodes = walk(
    mount({ grants: {}, labels: { allForRole: (role) => `Tout pour ${role}` } }).tree
  )
  const box = byRole(nodes, "checkbox").find(
    (n) => n.props["aria-label"] === "Tout pour Viewer"
  )
  assert.ok(box, "the override is used")
  assert.ok(
    byRole(nodes, "checkbox").some(
      (n) => n.props["aria-label"] === defaultPermissionMatrixLabels.all
    ),
    "and the ones not overridden keep their defaults"
  )
})

test("the composition with sticky-table-header is real: the role column is pinned", () => {
  const nodes = walk(mount({ grants: {}, maxHeight: 400 }).tree)
  const pinned = nodes.find(
    (n) => typeof n.props?.className === "string" && n.props.className.includes("nth-child(1)")
  )
  assert.ok(pinned, "sticky-table-header's own column rules are in the rendered tree")
  assert.ok(
    pinned.props.className.includes("[&_tbody_th]:before:"),
    "and this component's pinned-column edge travels with it"
  )
})
