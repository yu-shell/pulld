// A parent checkbox that reflects its children is the component everybody has written and nobody
// has written correctly, because every one of the wrong versions looks right on screen. The cases
// below are each written against a version that got one of these wrong:
//
//   - drawing the third state as a dash in CSS while `aria-checked` still says "false", so the row
//     is visibly part-selected and announced as empty,
//   - rolling up in one direction only: a parent that fills in when its children are ticked but
//     does nothing when pressed, or one that writes its children and then goes stale when a child
//     is pressed on its own,
//   - stopping the recursion at depth two, which is invisible until somebody nests a third level,
//   - deciding what a press does from the state on screen, which leaves a parent held at "mixed"
//     by one disabled row unable to ever clear itself,
//   - writing disabled leaves anyway, so a locked permission is granted by pressing its group,
//   - dropping ids that are not in the tree, which silently discards selections made on another
//     page of a filtered or paginated list,
//   - storing a parent's state alongside its children's, giving two sources of truth that disagree
//     the moment either side is touched,
//   - and marking a locked row with the `disabled` attribute, which takes it out of the tab order
//     so nobody using the keyboard can find out it is there.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { collectLeafIds, nodeCheckState, toggleCheckboxNode, NestedCheckbox } = loadComponent(
  join(ROOT, "registry", "ui", "nested-checkbox.tsx"),
  {
    stubs: {
      "lucide-react": {
        Check: function Check(props) {
          return { type: "svg", props: { "data-icon": "check", ...props } }
        },
        Minus: function Minus(props) {
          return { type: "svg", props: { "data-icon": "minus", ...props } }
        },
      },
    },
  }
)

// Two groups, one of which holds a leaf that cannot be changed — the shape that breaks the
// implementations which decide a press from the state on screen.
const scopes = () => [
  {
    id: "repo",
    label: "Repositories",
    children: [
      { id: "repo:read", label: "Read" },
      { id: "repo:write", label: "Write" },
    ],
  },
  {
    id: "billing",
    label: "Billing",
    children: [
      { id: "billing:view", label: "View invoices" },
      { id: "billing:pay", label: "Pay", disabled: true },
    ],
  },
]

// Three levels, because an implementation that recurses once looks finished on two.
const deep = () => [
  {
    id: "a",
    label: "A",
    children: [
      { id: "a1", label: "A1", children: [{ id: "a1x", label: "A1x" }, { id: "a1y", label: "A1y" }] },
      { id: "a2", label: "A2" },
    ],
  },
]

// --- the value space ------------------------------------------------------------------------------

test("the value is leaf ids in document order — group ids are never part of it", () => {
  assert.deepEqual(collectLeafIds(scopes()), [
    "repo:read",
    "repo:write",
    "billing:view",
    "billing:pay",
  ])
})

test("a node with an empty children array is a leaf, not an empty group", () => {
  const tree = [{ id: "g", label: "G", children: [] }]
  assert.deepEqual(collectLeafIds(tree), ["g"])
  assert.equal(nodeCheckState(tree[0], ["g"]), "checked")
})

test("leaves are collected from every depth", () => {
  assert.deepEqual(collectLeafIds(deep()), ["a1x", "a1y", "a2"])
})

// --- the roll-up upward ---------------------------------------------------------------------------

test("a group is unchecked, mixed, then checked as its children fill in", () => {
  const [repo] = scopes()
  assert.equal(nodeCheckState(repo, []), "unchecked")
  assert.equal(nodeCheckState(repo, ["repo:read"]), "mixed")
  assert.equal(nodeCheckState(repo, ["repo:read", "repo:write"]), "checked")
})

test("the roll-up reaches three levels deep", () => {
  const [a] = deep()
  // Only one grandchild on: the middle group is mixed, and so is the root. An implementation
  // that recurses once reports the root unchecked here, because `a1` is not in the value.
  assert.equal(nodeCheckState(a, ["a1x"]), "mixed")
  assert.equal(nodeCheckState(a, ["a1x", "a1y"]), "mixed")
  assert.equal(nodeCheckState(a, ["a1x", "a1y", "a2"]), "checked")
  // The middle group in isolation, so a failure above says which level broke.
  assert.equal(nodeCheckState(a.children[0], ["a1x", "a1y"]), "checked")
})

test("a disabled leaf still counts in what its group displays", () => {
  const [, billing] = scopes()
  // Everything that can be turned on is on, and the group still says "mixed" — because that is
  // the truth about the subtree. A group claiming "all of it" over a visibly empty row would be
  // lying about what is going to be submitted.
  assert.equal(nodeCheckState(billing, ["billing:view"]), "mixed")
  assert.equal(nodeCheckState(billing, ["billing:view", "billing:pay"]), "checked")
})

// --- the roll-up downward -------------------------------------------------------------------------

test("pressing a group turns on every leaf it is allowed to change", () => {
  assert.deepEqual(toggleCheckboxNode(scopes(), "repo", []), ["repo:read", "repo:write"])
})

test("pressing a group leaves a disabled leaf alone", () => {
  assert.deepEqual(toggleCheckboxNode(scopes(), "billing", []), ["billing:view"])
})

test("a group held at mixed by a disabled row can still be cleared", () => {
  // The trap. `billing` never reads "checked" while `billing:pay` is off, so an implementation
  // that branches on the displayed state reads every press as "turn it all on" and the group can
  // be pressed forever without changing. The direction comes from the togglable leaves instead.
  const after = toggleCheckboxNode(scopes(), "billing", ["billing:view"])
  assert.deepEqual(after, [])
})

test("a disabled leaf that is already on is not cleared by pressing its group", () => {
  const value = ["billing:view", "billing:pay"]
  // Every togglable leaf is on, so this press clears — but only what it may touch.
  assert.deepEqual(toggleCheckboxNode(scopes(), "billing", value), ["billing:pay"])
})

test("the press writes the grandchildren three levels down", () => {
  assert.deepEqual(toggleCheckboxNode(deep(), "a", []), ["a1x", "a1y", "a2"])
  assert.deepEqual(toggleCheckboxNode(deep(), "a1", []), ["a1x", "a1y"])
})

test("pressing a leaf toggles only itself", () => {
  assert.deepEqual(toggleCheckboxNode(scopes(), "repo:read", []), ["repo:read"])
  assert.deepEqual(toggleCheckboxNode(scopes(), "repo:read", ["repo:read", "repo:write"]), [
    "repo:write",
  ])
})

// --- what a press must not do ---------------------------------------------------------------------

test("pressing a disabled leaf changes nothing", () => {
  const value = ["billing:view"]
  assert.equal(toggleCheckboxNode(scopes(), "billing:pay", value), value)
})

test("disabling a group makes everything under it untouchable", () => {
  const tree = [
    {
      id: "admin",
      label: "Admin",
      disabled: true,
      children: [{ id: "admin:read", label: "Read" }, { id: "admin:write", label: "Write" }],
    },
  ]
  // Both the group and a child reached directly: inherited disablement has to survive the lookup,
  // not just the render.
  assert.equal(toggleCheckboxNode(tree, "admin", []).length, 0)
  assert.equal(toggleCheckboxNode(tree, "admin:read", []).length, 0)
})

test("an unknown id changes nothing", () => {
  const value = ["repo:read"]
  assert.equal(toggleCheckboxNode(scopes(), "nope", value), value)
})

test("ids the tree does not contain are carried through", () => {
  // A filtered, paginated or lazily loaded tree shows a slice of the selection. Rebuilding the
  // value from what is on screen is how the other pages' choices get thrown away.
  const value = ["from:another:page", "repo:read"]
  const after = toggleCheckboxNode(scopes(), "repo", value)
  assert.deepEqual(after, ["from:another:page", "repo:read", "repo:write"])
  assert.deepEqual(toggleCheckboxNode(scopes(), "repo", after), ["from:another:page"])
})

test("the array keeps the order it came in and appends in tree order", () => {
  const after = toggleCheckboxNode(scopes(), "repo", ["billing:view"])
  assert.deepEqual(after, ["billing:view", "repo:read", "repo:write"])
})

// --- the rendered tree ----------------------------------------------------------------------------

const boxes = (instance) => byRole(walk(instance.tree), "checkbox")
const checkedAttr = (instance) => boxes(instance).map((b) => b.props["aria-checked"])

test("the third state is aria-checked=\"mixed\", not a dash with aria-checked=\"false\"", () => {
  const instance = render(NestedCheckbox, { data: scopes(), value: ["repo:read"] })
  // Order is document order: repo, read, write, billing, view, pay.
  assert.deepEqual(checkedAttr(instance), ["mixed", true, false, false, false, false])
  const mixedRow = boxes(instance)[0]
  // And the dash is drawn too — but as a consequence of the state, not instead of it.
  assert.ok(walk(mixedRow).some((n) => n.props?.["data-icon"] === "minus"))
})

test("a fully checked group renders aria-checked=\"true\" and a tick", () => {
  const instance = render(NestedCheckbox, {
    data: scopes(),
    value: ["repo:read", "repo:write"],
  })
  assert.deepEqual(checkedAttr(instance).slice(0, 3), [true, true, true])
  assert.ok(walk(boxes(instance)[0]).some((n) => n.props?.["data-icon"] === "check"))
})

test("pressing a group checks its children on screen", () => {
  const instance = render(NestedCheckbox, { data: scopes() })
  boxes(instance)[0].props.onClick()
  instance.rerender()
  assert.deepEqual(checkedAttr(instance).slice(0, 3), [true, true, true])
})

test("pressing one child leaves the group mixed rather than stale", () => {
  const instance = render(NestedCheckbox, { data: scopes() })
  boxes(instance)[1].props.onClick()
  instance.rerender()
  assert.deepEqual(checkedAttr(instance).slice(0, 3), ["mixed", true, false])
})

test("onChange is handed the next leaf ids and the node that was pressed", () => {
  const calls = []
  const instance = render(NestedCheckbox, {
    data: scopes(),
    onChange: (ids, node) => calls.push([ids, node.id]),
  })
  boxes(instance)[0].props.onClick()
  assert.deepEqual(calls, [[["repo:read", "repo:write"], "repo"]])
})

test("controlled: the tree follows the value prop and not the press", () => {
  const instance = render(NestedCheckbox, { data: scopes(), value: [] })
  boxes(instance)[0].props.onClick()
  instance.rerender()
  // Nothing moved, because the owner of the state has not said so yet.
  assert.deepEqual(checkedAttr(instance), [false, false, false, false, false, false])
  instance.update({ data: scopes(), value: ["repo:read", "repo:write"] })
  assert.deepEqual(checkedAttr(instance).slice(0, 3), [true, true, true])
})

test("a subtree is a group named by the row above it", () => {
  const instance = render(NestedCheckbox, { data: scopes() })
  const nodes = walk(instance.tree)
  const groups = nodes.filter((n) => n.type === "ul" && n.props?.role === "group")
  assert.equal(groups.length, 2)
  const labelIds = nodes
    .filter((n) => n.type === "span" && typeof n.props?.id === "string")
    .map((n) => n.props.id)
  for (const group of groups) {
    // The name has to resolve: aria-labelledby pointing at nothing leaves the group unnamed.
    assert.ok(labelIds.includes(group.props["aria-labelledby"]))
  }
})

test("a locked row is aria-disabled and stays in the tab order", () => {
  const instance = render(NestedCheckbox, { data: scopes() })
  const pay = boxes(instance)[5]
  assert.equal(pay.props["aria-disabled"], true)
  // The `disabled` attribute would make it unfocusable, so nobody tabbing through could find out
  // the permission exists and is locked.
  assert.equal(pay.props.disabled, undefined)
  // It is still a real button, so it has to refuse the press itself.
  pay.props.onClick()
  instance.rerender()
  assert.deepEqual(checkedAttr(instance), [false, false, false, false, false, false])
})

test("a group with nothing togglable beneath it reports itself inert", () => {
  const instance = render(NestedCheckbox, {
    data: [
      {
        id: "locked",
        label: "Locked",
        children: [{ id: "locked:a", label: "A", disabled: true }],
      },
    ],
  })
  assert.equal(boxes(instance)[0].props["aria-disabled"], true)
})

test("the disabled prop inerts every row without touching the value", () => {
  const instance = render(NestedCheckbox, {
    data: scopes(),
    value: ["repo:read"],
    disabled: true,
  })
  assert.deepEqual(
    boxes(instance).map((b) => b.props["aria-disabled"]),
    [true, true, true, true, true, true]
  )
  // Still shows what is selected — disabled is not empty.
  assert.deepEqual(checkedAttr(instance).slice(0, 3), ["mixed", true, false])
})

// --- naming and submission ------------------------------------------------------------------------

test("a description is wired with aria-describedby instead of joining the name", () => {
  const instance = render(NestedCheckbox, {
    data: [{ id: "x", label: "Full access", description: "Read and write everything." }],
  })
  const nodes = walk(instance.tree)
  const box = byRole(nodes, "checkbox")[0]
  const paragraph = nodes.find((n) => n.type === "p")
  assert.equal(box.props["aria-describedby"], paragraph.props.id)
  // The sentence sits outside the checkbox, so name-from-contents is the label alone.
  assert.ok(!walk(box).some((n) => n.type === "p"))
})

test("no aria-describedby is emitted for a row without a description", () => {
  const instance = render(NestedCheckbox, { data: scopes() })
  for (const box of boxes(instance)) {
    assert.equal(box.props["aria-describedby"], undefined)
  }
})

test("name submits one hidden input per checked id", () => {
  const instance = render(NestedCheckbox, {
    data: scopes(),
    value: ["repo:read", "billing:view"],
    name: "scopes",
  })
  const inputs = byTag(walk(instance.tree), "input")
  assert.deepEqual(
    inputs.map((i) => [i.props.type, i.props.name, i.props.value]),
    [
      ["hidden", "scopes", "repo:read"],
      ["hidden", "scopes", "billing:view"],
    ]
  )
})

test("without a name nothing hidden is rendered", () => {
  const instance = render(NestedCheckbox, { data: scopes(), value: ["repo:read"] })
  assert.equal(byTag(walk(instance.tree), "input").length, 0)
})
