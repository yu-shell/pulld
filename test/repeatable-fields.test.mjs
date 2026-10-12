// The repeatable field set everyone writes first is `rows.map((row, i) => <Row key={i} />)` with an
// "Add" button and an `onClick={() => setRows(rows.filter((_, j) => j !== i))}`. It is right on the
// screen it was built on and wrong in five ways, and the cases below are written to fail against it:
//
//   - keyed by position, so removing a row makes the row below it inherit the removed row's DOM
//     nodes — the famous one, and the one that looks like the deleted row ate its neighbour,
//   - focus left on the add button after adding, so the new row's first field is one Tab per field
//     in every row above it,
//   - focus dropped to `<body>` after removing, because the button that was pressed is gone,
//   - n remove buttons all called "Remove", which tell a screen-reader user how many rows there are
//     and nothing about which button takes which,
//   - a floor and a ceiling enforced by hiding the control or by the `disabled` attribute, either of
//     which takes it out of the tab order rather than saying it is unavailable.
//
// What the harness can see of focus is the call, not the caret: "the component asked this node to
// take focus" is what is asserted here, and whether the browser honoured it belongs to a browser.
// The row nodes are reached through the `ref` the tree hands each row — React 19 keeps `ref` in
// props, and the harness fills a ref the component left null with a stand-in that logs the
// imperative calls made on it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  nextFocusAfterRemove,
  alignRowKeys,
  repeatableFieldsLabels,
  defaultRepeatableFieldsLabels,
  REPEATABLE_FIELD_SELECTOR,
  RepeatableFields,
} = loadComponent(join(ROOT, "registry", "ui", "repeatable-fields.tsx"), {
  stubs: {
    "lucide-react": {
      Plus: function Plus(props) {
        return { type: "svg", props: { "data-icon": "plus", ...props } }
      },
      Trash2: function Trash2(props) {
        return { type: "svg", props: { "data-icon": "trash", ...props } }
      },
    },
  },
})

// One row's fields, as the caller would write them. Returns a plain element object because this file
// has no JSX; the harness treats it the way React does.
const renderRow = ({ row, index, rowId, update }) => ({
  type: "input",
  props: {
    id: `${rowId}-value`,
    "data-index": index,
    value: row.value,
    onChange: (next) => update({ value: next }),
  },
})

const rows = (...values) => values.map((value) => ({ value }))

const mount = (props, options) =>
  render(
    RepeatableFields,
    { newRow: () => ({ value: "" }), children: renderRow, noun: "variable", ...props },
    options
  )

const groups = (tree) => byRole(walk(tree), "group")
const buttons = (tree) => byTag(walk(tree), "button")
const named = (tree, label) =>
  buttons(tree).find((node) => node.props?.["aria-label"] === label) ?? null
const addButton = (tree) => buttons(tree).find((node) => !node.props?.["aria-label"]) ?? null
const liveRegion = (tree) =>
  walk(tree).find((node) => node.props?.["aria-live"] === "polite") ?? null
const press = (node) => node.props.onClick()

// --- nextFocusAfterRemove ---------------------------------------------------

test("nextFocusAfterRemove: a row that moved up takes focus, so the cursor stays put", () => {
  // Three rows, the middle one goes: the row that was third is now second, and it is under the
  // cursor. Pressing remove three times then walks the list down in one place.
  assert.deepEqual(nextFocusAfterRemove(3, 1), { kind: "row", index: 1 })
  assert.deepEqual(nextFocusAfterRemove(6, 0), { kind: "row", index: 0 })
})

test("nextFocusAfterRemove: removing the last row falls back to the one above it", () => {
  assert.deepEqual(nextFocusAfterRemove(3, 2), { kind: "row", index: 1 })
  assert.deepEqual(nextFocusAfterRemove(2, 1), { kind: "row", index: 0 })
})

test("nextFocusAfterRemove: the add button is the only thing left when the list empties", () => {
  assert.deepEqual(nextFocusAfterRemove(1, 0), { kind: "add" })
  // A count that cannot be right should still answer something focusable rather than a row index
  // the focus effect would look up and find nothing at.
  assert.deepEqual(nextFocusAfterRemove(0, 0), { kind: "add" })
  assert.deepEqual(nextFocusAfterRemove(Number.NaN, 2), { kind: "add" })
})

test("nextFocusAfterRemove: a position past either end is clamped into the list", () => {
  assert.deepEqual(nextFocusAfterRemove(3, 9), { kind: "row", index: 1 })
  assert.deepEqual(nextFocusAfterRemove(3, -4), { kind: "row", index: 0 })
})

// --- alignRowKeys -----------------------------------------------------------

test("alignRowKeys: a surviving row keeps its key when one above it is filtered out", () => {
  // The headline bug, as a pure function: the caller removed the middle row itself (a "clear
  // invalid rows" button, say), and the row below it must not inherit the removed row's key.
  const a = { v: "a" }
  const b = { v: "b" }
  const c = { v: "c" }
  const keys = alignRowKeys([a, b, c], [], [], counter())
  assert.deepEqual(alignRowKeys([a, c], [a, b, c], keys, counter(100)), [keys[0], keys[2]])
})

test("alignRowKeys: a reorder carries each key with its row", () => {
  const a = { v: "a" }
  const b = { v: "b" }
  const keys = alignRowKeys([a, b], [], [], counter())
  assert.deepEqual(alignRowKeys([b, a], [a, b], keys, counter(100)), [keys[1], keys[0]])
})

test("alignRowKeys: an appended row gets a fresh key and the rest are untouched", () => {
  const a = { v: "a" }
  const b = { v: "b" }
  const keys = alignRowKeys([a], [], [], counter())
  assert.deepEqual(alignRowKeys([a, b], [a], keys, counter(100)), [keys[0], "k100"])
})

test("alignRowKeys: nothing changed returns the same array, which is what stops a render loop", () => {
  // The guard behind reconciling during render: a caller who builds `value` inline passes a new
  // array every render, and the component only sets state when this returns something new.
  const a = { v: "a" }
  const keys = alignRowKeys([a], [], [], counter())
  assert.equal(alignRowKeys([a], [a], keys, counter(100)), keys)
})

test("alignRowKeys: rows rebuilt from scratch all count as new, because nothing pairs them up", () => {
  const a = { v: "a" }
  const keys = alignRowKeys([a], [], [], counter())
  const rebuilt = [{ v: "a" }]
  assert.deepEqual(alignRowKeys(rebuilt, [a], keys, counter(100)), ["k100"])
})

test("alignRowKeys: two rows that are the same object are not given the same key", () => {
  // `newRow` returning one shared object is a caller error the component documents, but it must not
  // turn into two rows React considers the same row.
  const same = { v: "x" }
  const keys = alignRowKeys([same, same], [], [], counter())
  assert.equal(new Set(keys).size, 2)
})

function counter(from = 0) {
  let n = from
  return () => `k${n++}`
}

// --- labels -----------------------------------------------------------------

test("labels: every accessible name is built from the noun, so one prop moves all of them", () => {
  const labels = repeatableFieldsLabels("recipient")
  assert.equal(labels.add, "Add another recipient")
  assert.equal(labels.remove(2, 3), "Remove recipient 2 of 3")
  assert.equal(labels.row(2, 3), "Recipient 2 of 3")
  assert.equal(defaultRepeatableFieldsLabels.remove(1, 1), "Remove row 1 of 1")
})

test("labels: the removal announcement says what is left, and names the empty case", () => {
  const labels = repeatableFieldsLabels("variable")
  assert.equal(labels.removed(2, 1), "Removed variable 2, 1 remaining")
  assert.equal(labels.removed(1, 0), "Removed the last variable")
})

// --- the rendered set -------------------------------------------------------

test("each remove button is named by the row it removes, not 'Remove' three times", () => {
  const { tree } = mount({ defaultValue: rows("A", "B", "C") })
  const labels = buttons(tree)
    .map((node) => node.props?.["aria-label"])
    .filter(Boolean)
  assert.deepEqual(labels, [
    "Remove variable 1 of 3",
    "Remove variable 2 of 3",
    "Remove variable 3 of 3",
  ])
})

test("each row is a named group, so entering one says which row it is", () => {
  const { tree } = mount({ defaultValue: rows("A", "B") })
  assert.deepEqual(
    groups(tree).map((node) => node.props["aria-label"]),
    ["Variable 1 of 2", "Variable 2 of 2"]
  )
})

test("the remove button comes after the row's fields, so the focus selector finds a field first", () => {
  // Document order is what `querySelector` answers with, and REPEATABLE_FIELD_SELECTOR matches a
  // button too. Rendered first, the remove button would be where focus lands on a fresh row.
  const { tree } = mount({ defaultValue: rows("A") })
  const inRow = walk(groups(tree)[0])
  const field = inRow.findIndex((node) => node.type === "input")
  const remove = inRow.findIndex((node) => node.type === "button")
  assert.ok(field >= 0 && remove >= 0)
  assert.ok(field < remove, "the field should precede the remove button in the tree")
  assert.match(REPEATABLE_FIELD_SELECTOR, /input/)
})

test("a row keeps its key when the row above it is removed", () => {
  // The bug this component exists for. Keyed by position, the third row would be handed the second
  // row's key — and with it the second row's DOM nodes, so the value typed into row 3 appears in
  // row 2 and the row that was deleted looks like it ate its neighbour.
  const set = mount({ defaultValue: rows("A", "B", "C") })
  const before = groups(set.tree).map((node) => node.key)
  assert.equal(new Set(before).size, 3, "three rows, three distinct keys")

  press(named(set.tree, "Remove variable 2 of 3"))
  set.rerender()

  const after = groups(set.tree).map((node) => node.key)
  assert.deepEqual(after, [before[0], before[2]])
  assert.ok(!after.includes(before[1]), "the removed row's key is not reused")
})

test("an added row gets a key that was never used before", () => {
  const set = mount({ defaultValue: rows("A") })
  const first = groups(set.tree).map((node) => node.key)
  press(named(set.tree, "Remove variable 1 of 1"))
  set.rerender()
  press(addButton(set.tree))
  set.rerender()
  const next = groups(set.tree).map((node) => node.key)
  assert.equal(next.length, 1)
  assert.ok(!first.includes(next[0]), "a key is not recycled after its row is gone")
})

test("adding asks the new row for focus, rather than leaving it on the add button", () => {
  const set = mount({ defaultValue: rows("A") })
  press(addButton(set.tree))
  set.rerender()

  const rowNodes = groups(set.tree).map((node) => node.props.ref.current)
  assert.equal(rowNodes.length, 2)
  assert.deepEqual(
    rowNodes[1].calls.map((call) => call.name),
    ["focus"]
  )
  assert.deepEqual(rowNodes[0].calls, [], "the row that was already there is left alone")
})

test("removing asks the row that moved up for focus, so focus is not dropped to the body", () => {
  const set = mount({ defaultValue: rows("A", "B", "C") })
  press(named(set.tree, "Remove variable 2 of 3"))
  set.rerender()

  const rowNodes = groups(set.tree).map((node) => node.props.ref.current)
  assert.equal(rowNodes.length, 2)
  // Position 1 is where the removed row was, now held by the row that was third.
  assert.ok(
    rowNodes[1].calls.some((call) => call.name === "focus"),
    "the row now in the vacated slot should be asked to take focus"
  )
})

test("removing the only row asks the add button for focus, the one control still on screen", () => {
  const set = mount({ defaultValue: rows("A") })
  press(named(set.tree, "Remove variable 1 of 1"))
  set.rerender()

  assert.equal(groups(set.tree).length, 0)
  // The add button's ref is a useRef the component left null, so it arrives in `nodes`.
  const focused = set.nodes.filter((node) => node.calls.some((call) => call.name === "focus"))
  assert.equal(focused.length, 1, "exactly one node was asked to take focus")
})

test("focus is asked for once and not again on an unrelated re-render", () => {
  const set = mount({ defaultValue: rows("A") })
  press(addButton(set.tree))
  set.rerender()
  const node = groups(set.tree)[1].props.ref.current
  assert.equal(node.calls.length, 1)

  // A parent re-rendering with new props must not pull focus back into the list.
  set.update({
    newRow: () => ({ value: "" }),
    children: renderRow,
    noun: "variable",
    defaultValue: rows("A"),
    legend: "Variables",
  })
  assert.equal(node.calls.length, 1, "the spent focus request was cleared")
})

test("adding and removing are announced, because no field's value changed", () => {
  const set = mount({ defaultValue: rows("A") })
  press(addButton(set.tree))
  set.rerender()
  assert.equal(liveRegion(set.tree).props.children, "Added variable 2 of 2")

  press(named(set.tree, "Remove variable 1 of 2"))
  set.rerender()
  assert.equal(liveRegion(set.tree).props.children, "Removed variable 1, 1 remaining")
})

test("at the floor the remove button stays, aria-disabled, and does nothing when pressed", () => {
  const set = mount({ defaultValue: rows("A"), min: 1 })
  const button = named(set.tree, "Remove variable 1 of 1")
  assert.ok(button, "the button is still rendered rather than hidden")
  assert.equal(button.props["aria-disabled"], true)
  assert.equal(button.props.disabled, undefined, "not the disabled attribute — it keeps its tab stop")

  press(button)
  set.rerender()
  assert.equal(groups(set.tree).length, 1, "the floor held")
})

test("the floor explains itself on screen, and the button points at the explanation", () => {
  const { tree } = mount({ defaultValue: rows("A"), min: 1 })
  const button = named(tree, "Remove variable 1 of 1")
  const hintId = button.props["aria-describedby"]
  assert.ok(hintId)
  const hint = walk(tree).find((node) => node.props?.id === hintId)
  assert.equal(hint.props.children, "At least one variable is required")
})

test("at the ceiling the add button is aria-disabled and adds nothing", () => {
  const set = mount({ defaultValue: rows("A", "B"), max: 2 })
  const button = addButton(set.tree)
  assert.equal(button.props["aria-disabled"], true)
  const hint = walk(set.tree).find((node) => node.props?.id === button.props["aria-describedby"])
  assert.equal(hint.props.children, "Maximum of 2")

  press(button)
  set.rerender()
  assert.equal(groups(set.tree).length, 2, "the ceiling held")
})

test("controlled: onChange is handed the whole next array and what changed", () => {
  const seen = []
  const set = mount({
    value: rows("A", "B"),
    onChange: (next, change) => seen.push([next.map((row) => row.value), change]),
  })

  press(named(set.tree, "Remove variable 1 of 2"))
  assert.deepEqual(seen.at(-1), [["B"], { type: "remove", index: 0 }])

  press(addButton(set.tree))
  assert.deepEqual(seen.at(-1), [["A", "B", ""], { type: "add", index: 2 }])
})

test("controlled: the rows on screen are the caller's, not a copy that drifted", () => {
  const set = mount({ value: rows("A", "B"), onChange: () => {} })
  // The caller ignored the change, so nothing moves — the component does not keep its own list
  // alongside the prop.
  press(named(set.tree, "Remove variable 1 of 2"))
  set.rerender()
  assert.equal(groups(set.tree).length, 2)

  set.update({
    newRow: () => ({ value: "" }),
    children: renderRow,
    noun: "variable",
    value: rows("B"),
    onChange: () => {},
  })
  assert.deepEqual(
    groups(set.tree).map((node) => node.props["aria-label"]),
    ["Variable 1 of 1"]
  )
})

test("controlled: a fresh array of the same rows every render does not loop", () => {
  // `value={items.map(toRow)}` is an ordinary thing to write, and reconciling keys during render
  // would otherwise set state on every render forever. The harness throws if it cannot settle.
  const set = mount({ value: rows("A", "B"), onChange: () => {} })
  for (let i = 0; i < 3; i++) {
    set.update({
      newRow: () => ({ value: "" }),
      children: renderRow,
      noun: "variable",
      value: rows("A", "B"),
      onChange: () => {},
    })
  }
  assert.equal(groups(set.tree).length, 2)
})

test("a row's update reaches the caller as a whole new array", () => {
  const seen = []
  const set = mount({ value: rows("A", "B"), onChange: (next, change) => seen.push([next, change]) })
  const field = walk(set.tree).find((node) => node.type === "input")
  field.props.onChange("typed")
  assert.deepEqual(seen.at(-1)[0].map((row) => row.value), ["typed", "B"])
  assert.deepEqual(seen.at(-1)[1], { type: "update", index: 0 })
})

test("the row id is stable and unique, so a label in row 2 points at row 2's input", () => {
  const set = mount({ defaultValue: rows("A", "B") })
  const ids = walk(set.tree)
    .filter((node) => node.type === "input")
    .map((node) => node.props.id)
  assert.equal(new Set(ids).size, 2)

  press(named(set.tree, "Remove variable 1 of 2"))
  set.rerender()
  const after = walk(set.tree)
    .filter((node) => node.type === "input")
    .map((node) => node.props.id)
  assert.deepEqual(after, [ids[1]], "the surviving row's field keeps the id it had")
})

test("disabled puts the whole set out of reach through the fieldset itself", () => {
  const { tree } = mount({ defaultValue: rows("A"), disabled: true })
  const fieldset = byTag(walk(tree), "fieldset")[0]
  assert.equal(fieldset.props.disabled, true)
  // The browser disables every control inside a disabled fieldset, the caller's fields included, so
  // nothing has to be threaded down to them.
  assert.equal(named(tree, "Remove variable 1 of 1").props["aria-disabled"], true)
})

test("an empty set says so instead of showing a bare button", () => {
  const { tree } = mount({ defaultValue: [], emptyMessage: "No variables yet" })
  assert.ok(
    walk(tree).some((node) => node.props?.children === "No variables yet"),
    "the empty message is rendered"
  )
  assert.equal(groups(tree).length, 0)
  assert.ok(addButton(tree), "and the way out is still there")
})

test("the legend and description are the real elements, wired to the group", () => {
  const { tree } = mount({
    defaultValue: rows("A"),
    legend: "Environment variables",
    description: "Injected at build time.",
  })
  const nodes = walk(tree)
  assert.equal(byTag(nodes, "legend")[0].props.children, "Environment variables")
  const fieldset = byTag(nodes, "fieldset")[0]
  const described = nodes.find((node) => node.props?.id === fieldset.props["aria-describedby"])
  assert.equal(described.props.children, "Injected at build time.")
})

// --- cases added after mutation testing ------------------------------------
// `node scripts/mutate.mjs registry/ui/repeatable-fields.tsx test/repeatable-fields.test.mjs` left
// survivors that were real holes rather than equivalent mutants. Each case below is the one that
// kills one, and the two `type="button"` cases are the pair that matter most: this component exists
// to live inside a <form>, where a button without an explicit type submits it.

test("both buttons are type=button, so neither submits the form the set is sitting in", () => {
  // A <button> in a form defaults to type="submit". An add button that inherited that default posts
  // a half-filled form the moment somebody adds a second row, and a remove button posts it on the
  // way to deleting one — the single most expensive way this component could be wrong.
  const { tree } = mount({ defaultValue: rows("A") })
  assert.equal(addButton(tree).props.type, "button")
  assert.equal(named(tree, "Remove variable 1 of 1").props.type, "button")
})

test("a row is not a tab stop — it is focusable only as the fallback focus target", () => {
  // tabIndex={-1}, never a positive value: rows in the tab order would put every row ahead of the
  // fields inside it, and a positive tabindex jumps the whole document's order.
  const { tree } = mount({ defaultValue: rows("A", "B") })
  for (const row of groups(tree)) assert.equal(row.props.tabIndex, -1)
})

test("the icons are hidden from screen readers, which read the buttons' labels instead", () => {
  const { tree } = mount({ defaultValue: rows("A") })
  const icons = walk(tree).filter((node) => node.props?.["data-icon"])
  assert.deepEqual(
    icons.map((node) => node.props["data-icon"]),
    ["trash", "plus"]
  )
  for (const icon of icons) assert.equal(icon.props["aria-hidden"], "true")
})

test("below the ceiling the add button is live and no limit is shown", () => {
  const set = mount({ defaultValue: rows("A"), max: 3 })
  const button = addButton(set.tree)
  assert.equal(button.props["aria-disabled"], undefined)
  assert.equal(button.props["aria-describedby"], undefined, "no hint to point at yet")
  assert.ok(
    !walk(set.tree).some((node) => node.props?.children === "Maximum of 3"),
    "the limit is only shown once it has been reached"
  )

  press(button)
  set.rerender()
  assert.equal(groups(set.tree).length, 2)
})

test("above the floor the remove buttons are live and point at no hint", () => {
  const set = mount({ defaultValue: rows("A", "B"), min: 1 })
  const button = named(set.tree, "Remove variable 1 of 2")
  assert.equal(button.props["aria-disabled"], undefined)
  // A describedby naming an element that is not rendered is a dangling reference, which a screen
  // reader resolves to nothing at all.
  assert.equal(button.props["aria-describedby"], undefined)

  press(button)
  set.rerender()
  assert.equal(groups(set.tree).length, 1, "the floor is one row away, not here")
})

test("removing the first row asks the row that replaced it for focus", () => {
  // The most common removal, and the one an off-by-one in the focus bounds silently skips.
  assert.deepEqual(nextFocusAfterRemove(2, 0), { kind: "row", index: 0 })

  const set = mount({ defaultValue: rows("A", "B", "C") })
  press(named(set.tree, "Remove variable 1 of 3"))
  set.rerender()
  assert.ok(
    groups(set.tree)[0].props.ref.current.calls.some((call) => call.name === "focus"),
    "position 0 is now held by the row that was second, and it should take focus"
  )
})

test("alignRowKeys: a replaced row never inherits the key of the row it replaced", () => {
  // Reusing a departed row's key is the same failure as keying by position, arrived at from the
  // other direction: React would match the new row to the old row's DOM nodes.
  const a = { v: "a" }
  const b = { v: "b" }
  const c = { v: "c" }
  const keys = alignRowKeys([a, b], [], [], counter())
  const next = alignRowKeys([a, c], [a, b], keys, counter(100))
  assert.deepEqual(next, [keys[0], "k100"])
  assert.ok(!next.includes(keys[1]), "the key of the row that went is not handed to its replacement")
})

test("the empty message is not shown while there are rows", () => {
  const { tree } = mount({ defaultValue: rows("A"), emptyMessage: "No variables yet" })
  assert.ok(!walk(tree).some((node) => node.props?.children === "No variables yet"))
})

test("a caller's own aria-describedby survives alongside the description", () => {
  const { tree } = mount({
    defaultValue: rows("A"),
    description: "Injected at build time.",
    "aria-describedby": "outside-hint",
  })
  const described = byTag(walk(tree), "fieldset")[0].props["aria-describedby"].split(" ")
  assert.ok(described.includes("outside-hint"), "the caller's id is kept")
  assert.equal(described.length, 2, "and the component's own description is added to it")
})

test("alignRowKeys: two rows that are the same object do not both claim one previous key", () => {
  // `claimed` is why this is a consuming match. Without it the second of two identical-identity rows
  // matches the same previous row as the first, both get its key, and React is handed two rows it
  // considers the same row.
  const same = { v: "x" }
  const keys = alignRowKeys([same], [], [], counter())
  const next = alignRowKeys([same, same], [same], keys, counter(100))
  assert.equal(new Set(next).size, 2, "distinct keys")
  assert.deepEqual(next, [keys[0], "k100"])
})

test("the default noun is 'row', so the set is usable without naming what it repeats", () => {
  const { tree } = render(RepeatableFields, {
    newRow: () => ({ value: "" }),
    children: renderRow,
    defaultValue: rows("A"),
  })
  assert.equal(addButton(tree).props.children.at(-1), "Add another row")
  assert.ok(named(tree, "Remove row 1 of 1"))
  assert.equal(groups(tree)[0].props["aria-label"], "Row 1 of 1")
})

test("no floor notice is shown when there is no floor to be at", () => {
  // `atMin` is true for an empty set under the default min of 0, so a condition that does not also
  // require a real floor prints "At least 0 required" on an ordinary empty list.
  const { tree } = mount({ defaultValue: [], emptyMessage: "No variables yet" })
  const text = walk(tree)
    .map((node) => node.props?.children)
    .filter((child) => typeof child === "string")
  assert.ok(
    !text.some((line) => line.startsWith("At least")),
    `no floor notice expected, got: ${text.join(" | ")}`
  )
})

test("no floor notice is shown while the set is above its floor", () => {
  const { tree } = mount({ defaultValue: rows("A", "B"), min: 1 })
  assert.ok(
    !walk(tree).some((node) => node.props?.children === "At least one variable is required"),
    "the notice belongs to the floor, not to every set that has one"
  )
})
