// The transfer list everybody writes first is two `useState` arrays and four buttons that `push` and
// `filter`. It works on the screen it was built on and is wrong in five ways, and the cases below
// are written to fail against it:
//
//   - rows pushed onto the destination, so moving one right and back again drops it at the bottom of
//     the list it came from and rearranges the list the person was reading,
//   - `disabled` on the move buttons, which stops being focusable while holding focus the moment a
//     side empties — the browser then drops focus to `<body>` and the next Tab restarts at the top
//     of the document,
//   - `aria-activedescendant` left pointing at an option that is now on the other side, so a move
//     made from inside a list loses the keyboard's place in it silently,
//   - four buttons named "→", "⇉", "⇇", "←", where two of them are "move the three I picked" and
//     "move all four hundred",
//   - a side that empties and goes quiet: no message, and a listbox dropped out of the tab order so
//     the empty side — the one about to be moved into — cannot be reached by keyboard again.
//
// What the harness can see of focus is the call, not the caret: "the component asked this node to
// take focus" is what is asserted here. The scroll-into-view effect is deliberately not asserted —
// its `querySelector` answers null here, there being no layout — and that is why the keyboard cases
// below assert the `aria-activedescendant` the effect reads rather than the scroll it asks for.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

const {
  transferListSides,
  transferValues,
  movableValues,
  nextActiveAfterMove,
  transferListLabels,
  defaultTransferListLabels,
  TransferList,
} = loadComponent(join(ROOT, "registry", "ui", "transfer-list.tsx"), {
  stubs: {
    "lucide-react": {
      ChevronLeft: icon("chevron-left"),
      ChevronRight: icon("chevron-right"),
      ChevronsLeft: icon("chevrons-left"),
      ChevronsRight: icon("chevrons-right"),
      Search: icon("search"),
    },
  },
})

const ITEMS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Bravo" },
  { value: "c", label: "Charlie" },
]

const mount = (props = {}) => render(TransferList, { items: ITEMS, ...props })

// The two listboxes and their options are told apart by the ids the component mints, rather than by
// their position in the tree: a layout change should not silently point a test at the other side.
const listbox = (tree, side) =>
  byRole(walk(tree), "listbox").find((n) => n.props.id === `harness-id-${side}-list`)
const options = (tree, side) =>
  byRole(walk(tree), "option").filter((n) =>
    String(n.props.id).startsWith(`harness-id-${side}-opt-`)
  )
const labelsOf = (tree, side) => options(tree, side).map((n) => n.props.children.props.children)
const searchBox = (tree, side) => {
  const inputs = byTag(walk(tree), "input").filter((n) => n.props.type === "text")
  return side === "available" ? inputs[0] : inputs[1]
}
const liveRegion = (tree) => walk(tree).find((n) => n.props?.["aria-live"] === "polite")

// In document order: move-selected-right, move-all-right, move-all-left, move-selected-left. The
// order is asserted in "the four move buttons are named by what they will move", so every other case
// reading them by name is reading a checked index.
const buttons = (tree) => {
  const all = byTag(walk(tree), "button")
  return { rightSelected: all[0], rightAll: all[1], leftAll: all[2], leftSelected: all[3], all }
}

const press = (node, key, modifiers = {}) => {
  let prevented = false
  node.props.onKeyDown({
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: () => {
      prevented = true
    },
    ...modifiers,
  })
  return () => prevented
}

// --- the order rows come back in -------------------------------------------

test("both sides are the item order, so a row moved back lands where it started", () => {
  const sides = transferListSides(ITEMS, ["b"])
  assert.deepEqual(
    sides.available.map((i) => i.value),
    ["a", "c"]
  )
  assert.deepEqual(
    sides.chosen.map((i) => i.value),
    ["b"]
  )

  // Out and back: the naive version answers ["a", "c", "b"] here, having pushed it onto the end.
  const back = transferValues(ITEMS, ["b"], ["b"], "available")
  assert.deepEqual(back, [])
  assert.deepEqual(
    transferListSides(ITEMS, back).available.map((i) => i.value),
    ["a", "b", "c"]
  )
})

test("the emitted array is in item order however the moving values arrive", () => {
  assert.deepEqual(transferValues(ITEMS, [], ["c", "a"], "chosen"), ["a", "c"])
  assert.deepEqual(transferValues(ITEMS, ["c"], ["a"], "chosen"), ["a", "c"])
  // Same choice, same array — whichever order the two presses happened in.
  assert.deepEqual(
    transferValues(ITEMS, ["a"], ["c"], "chosen"),
    transferValues(ITEMS, ["c"], ["a"], "chosen")
  )
})

test("a chosen value no item claims survives a move instead of being dropped", () => {
  // `items` is a page of a longer list; "z" was chosen on another page.
  const next = transferValues(ITEMS, ["z", "a"], ["b"], "chosen")
  assert.deepEqual(next, ["z", "a", "b"])
  // And it is not quietly deleted by a move in the other direction either.
  assert.deepEqual(transferValues(ITEMS, ["z", "a"], ["a"], "available"), ["z"])
})

test("a locked row named in a move is ignored, in one place rather than four", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }, ITEMS[2]]
  assert.deepEqual(transferValues(items, [], ["a", "b", "c"], "chosen"), ["a", "c"])
  // And it cannot be taken off the chosen side either, having got there some other way.
  assert.deepEqual(transferValues(items, ["b"], ["b"], "available"), ["b"])
})

test("movableValues is the count every button name is built on", () => {
  assert.deepEqual(movableValues(ITEMS), ["a", "b", "c"])
  assert.deepEqual(movableValues([ITEMS[0], { value: "b", label: "B", disabled: true }]), ["a"])
  assert.deepEqual(movableValues([]), [])
})

// --- where the cursor goes on the side that got shorter ---------------------

test("the row under the cursor moved away: the cursor takes the vacated slot", () => {
  assert.equal(nextActiveAfterMove(5, [1], 1), 1)
  assert.equal(nextActiveAfterMove(5, [0], 0), 0)
  assert.equal(nextActiveAfterMove(8, [1, 3], 1), 1)
})

test("rows taken from the end clamp the cursor onto the row that is now last", () => {
  assert.equal(nextActiveAfterMove(5, [4], 4), 3)
  assert.equal(nextActiveAfterMove(5, [3, 4], 3), 2)
  assert.equal(nextActiveAfterMove(3, [1, 2], 1), 0)
})

test("the row under the cursor stayed: the cursor follows it rather than jumping", () => {
  // Standing on row 3 of 5 and moving rows 0 and 1 out. The row under the cursor is now row 1, and
  // "go to the first vacated slot" would yank the cursor to the top of a list being read in the
  // middle.
  assert.equal(nextActiveAfterMove(5, [0, 1], 3), 1)
  assert.equal(nextActiveAfterMove(5, [4], 0), 0)
  assert.equal(nextActiveAfterMove(8, [1, 3], 6), 4)
  // A move that takes nothing leaves the cursor exactly where it was.
  assert.equal(nextActiveAfterMove(5, [], 2), 2)
})

test("nothing to stand on answers null rather than a position that does not exist", () => {
  assert.equal(nextActiveAfterMove(3, [0, 1, 2], 1), null)
  assert.equal(nextActiveAfterMove(1, [0], 0), null)
  assert.equal(nextActiveAfterMove(0, [], 0), null)
})

test("positions that cannot be in the list are not counted as removals", () => {
  // The boundary is the one that matters: a position equal to the length is past the end, and
  // counting it would both shorten `remaining` and shift the cursor up a row that never went.
  assert.equal(nextActiveAfterMove(3, [3], 0), 0)
  assert.equal(nextActiveAfterMove(3, [3], 2), 2)
  assert.equal(nextActiveAfterMove(3, [7], 1), 1)
  assert.equal(nextActiveAfterMove(3, [-1], 1), 1)
  assert.equal(nextActiveAfterMove(3, [1.5], 1), 1)
  // A repeated position is one row, not two: counted twice, `remaining` would be short and the
  // cursor would be clamped to a row above the one that took the slot.
  assert.equal(nextActiveAfterMove(3, [1, 1], 1), 1)
  // A cursor that was already past the end is clamped rather than trusted.
  assert.equal(nextActiveAfterMove(3, [0], 9), 1)
})

// --- the two sides are listboxes -------------------------------------------

test("each side is a multi-select listbox with one tab stop", () => {
  const { tree } = mount({ defaultValue: ["c"] })
  for (const side of ["available", "chosen"]) {
    const list = listbox(tree, side)
    assert.ok(list, `${side} should be a listbox`)
    assert.equal(list.props["aria-multiselectable"], "true")
    assert.equal(list.props.tabIndex, 0)
    assert.equal(list.props["aria-labelledby"], `harness-id-${side}-heading`)
  }
  assert.deepEqual(labelsOf(tree, "available"), ["Alpha", "Bravo"])
  assert.deepEqual(labelsOf(tree, "chosen"), ["Charlie"])
})

test("every option carries aria-selected, true or false", () => {
  const { tree } = mount()
  const list = options(tree, "available")
  assert.equal(list.length, 3)
  for (const option of list) {
    assert.equal(typeof option.props["aria-selected"], "boolean", "absent means not selectable")
  }
  assert.deepEqual(
    list.map((o) => o.props["aria-selected"]),
    [false, false, false]
  )
})

test("aria-activedescendant names the option the arrows are standing on", () => {
  const instance = mount()
  const list = listbox(instance.tree, "available")
  assert.equal(list.props["aria-activedescendant"], "harness-id-available-opt-0")

  press(list, "ArrowDown")
  let tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-1"
  )
  assert.equal(options(tree, "available")[1].props["data-active"], "true")

  press(listbox(tree, "available"), "End")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-2"
  )

  // The cursor does not walk off either end.
  press(listbox(tree, "available"), "ArrowDown")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-2"
  )
})

test("an empty side has no active option to point at", () => {
  const { tree } = mount({ defaultValue: [] })
  assert.equal(listbox(tree, "chosen").props["aria-activedescendant"], undefined)
})

test("the arrow keys are claimed, so the page does not scroll under the list", () => {
  const instance = mount()
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", " ", "Enter"]) {
    const list = listbox(instance.tree, "available")
    const wasPrevented = press(list, key)
    assert.equal(wasPrevented(), true, `${key} should be handled by the listbox`)
    instance.rerender()
  }
})

test("clicking a row asks the listbox for focus, which is what makes the arrows work", () => {
  const instance = mount()
  const option = options(instance.tree, "available")[1]
  option.props.onPointerDown({ preventDefault: () => {} })
  const [availableNode] = instance.nodes
  assert.deepEqual(
    availableNode.calls.map((c) => c.name),
    ["focus"]
  )
})

// --- the names of the move buttons -----------------------------------------

test("the four move buttons are named by what they will move", () => {
  const { tree } = mount({ defaultValue: ["c"] })
  const { rightSelected, rightAll, leftAll, leftSelected } = buttons(tree)
  assert.equal(rightSelected.props["aria-label"], "Move 0 selected to Chosen")
  assert.equal(rightAll.props["aria-label"], "Move all 2 to Chosen")
  assert.equal(leftAll.props["aria-label"], "Move 1 to Available")
  assert.equal(leftSelected.props["aria-label"], "Move 0 selected to Available")
  for (const button of buttons(tree).all) {
    const name = button.props["aria-label"]
    assert.ok(name && name.length > 2, "an arrow is not a name")
    assert.ok(!/[→←⇉⇇]/.test(name))
  }
})

test("a move-all button counts what will move, not what is on screen", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }, ITEMS[2]]
  const { tree } = mount({ items })
  assert.equal(labelsOf(tree, "available").length, 3)
  assert.equal(buttons(tree).rightAll.props["aria-label"], "Move all 2 to Chosen")
})

test("the selected count in the name follows the selection", () => {
  const instance = mount()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 1 selected to Chosen")

  options(tree, "available")[2].props.onClick()
  tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 2 selected to Chosen")

  // Clicking a selected row takes it back off.
  options(tree, "available")[0].props.onClick()
  tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 1 selected to Chosen")
})

test("a locked row cannot be selected, so no count can promise it", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }]
  const instance = mount({ items })
  options(instance.tree, "available")[1].props.onClick()
  const tree = instance.rerender()
  assert.equal(options(tree, "available")[1].props["aria-selected"], false)
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 0 selected to Chosen")
})

// --- an unavailable control keeps its focus --------------------------------

test("a move button that cannot act is aria-disabled, never disabled", () => {
  const { tree } = mount()
  const { rightSelected, leftAll } = buttons(tree)
  // Nothing is selected and the chosen side is empty: two of the four cannot act.
  for (const button of [rightSelected, leftAll]) {
    assert.equal(button.props["aria-disabled"], true)
    assert.equal(button.props.disabled, undefined, "the attribute would drop focus to <body>")
  }
  // And it says why, by pointing at the count on screen.
  assert.equal(rightSelected.props["aria-describedby"], "harness-id-available-count")
})

test("emptying a side with the button you are holding does not take the button away", () => {
  const instance = mount()
  buttons(instance.tree).rightAll.props.onClick()
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), [])
  assert.deepEqual(labelsOf(tree, "chosen"), ["Alpha", "Bravo", "Charlie"])

  const { rightAll, rightSelected } = buttons(tree)
  for (const button of [rightAll, rightSelected]) {
    assert.equal(button.props["aria-disabled"], true)
    assert.equal(button.props.disabled, undefined)
  }
  // The emptied side is still reachable, and still says what it is.
  assert.equal(listbox(tree, "available").props.tabIndex, 0)
})

test("a button that can act says nothing about being unavailable", () => {
  const { tree } = mount({ defaultValue: ["c"] })
  const { rightAll, leftAll } = buttons(tree)
  for (const button of [rightAll, leftAll]) {
    assert.equal(button.props["aria-disabled"], undefined)
    assert.equal(button.props["aria-describedby"], undefined)
  }
})

test("the whole control disabled leaves both listboxes out of the tab order", () => {
  const { tree } = mount({ defaultValue: ["c"], disabled: true })
  for (const side of ["available", "chosen"]) {
    assert.equal(listbox(tree, side).props.tabIndex, -1)
    assert.equal(listbox(tree, side).props["aria-disabled"], true)
  }
  for (const button of buttons(tree).all) {
    assert.equal(button.props["aria-disabled"], true)
  }
})

test("a disabled control refuses the move a stray press would make", () => {
  const onChange = []
  const instance = mount({
    defaultValue: ["c"],
    disabled: true,
    onChange: (next) => onChange.push(next),
  })
  buttons(instance.tree).rightAll.props.onClick()
  options(instance.tree, "available")[0].props.onDoubleClick()
  press(listbox(instance.tree, "available"), "Enter")
  assert.deepEqual(onChange, [])
})

// --- moving ----------------------------------------------------------------

test("a double-click moves the row under the pointer, not the selection", () => {
  const instance = mount()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  assert.equal(options(tree, "available")[0].props["aria-selected"], true)

  options(tree, "available")[2].props.onDoubleClick()
  tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "chosen"), ["Charlie"])
  assert.deepEqual(labelsOf(tree, "available"), ["Alpha", "Bravo"])
  // Alpha is still picked and still on the left.
  assert.equal(options(tree, "available")[0].props["aria-selected"], true)
})

test("a locked row refuses a double-click", () => {
  const items = [{ value: "a", label: "Alpha", disabled: true }, ITEMS[1]]
  const instance = mount({ items })
  options(instance.tree, "available")[0].props.onDoubleClick()
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "chosen"), [])
})

test("Enter moves what is selected, and the cursor stays where it was", () => {
  const instance = mount()
  // Pick Bravo, the middle row, with the keyboard only.
  press(listbox(instance.tree, "available"), "ArrowDown")
  let tree = instance.rerender()
  press(listbox(tree, "available"), " ")
  tree = instance.rerender()
  assert.equal(options(tree, "available")[1].props["aria-selected"], true)

  press(listbox(tree, "available"), "Enter")
  tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), ["Alpha", "Charlie"])
  assert.deepEqual(labelsOf(tree, "chosen"), ["Bravo"])
  // The row that took Bravo's slot — not <body>, and not an id that is now on the other side.
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-1"
  )
  assert.equal(labelsOf(tree, "available")[1], "Charlie")
})

test("Enter with nothing selected moves the row under the cursor", () => {
  const instance = mount()
  press(listbox(instance.tree, "available"), "Enter")
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "chosen"), ["Alpha"])
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-0"
  )
  assert.equal(labelsOf(tree, "available")[0], "Bravo")
})

test("the last row moved out leaves the cursor nowhere rather than out of range", () => {
  const instance = mount({ items: [ITEMS[0]] })
  press(listbox(instance.tree, "available"), "Enter")
  let tree = instance.rerender()
  assert.equal(listbox(tree, "available").props["aria-activedescendant"], undefined)

  // And when a row comes back, the stored cursor is clamped onto it rather than left past the end.
  buttons(tree).leftAll.props.onClick()
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-0"
  )
})

test("a moved row does not arrive already selected", () => {
  const instance = mount()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  buttons(tree).rightSelected.props.onClick()
  tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "chosen"), ["Alpha"])
  assert.equal(options(tree, "chosen")[0].props["aria-selected"], false)
  // So the button that would send it straight back is not pre-armed.
  assert.equal(buttons(tree).leftSelected.props["aria-disabled"], true)
})

test("Shift+Arrow adds to the selection and never takes anything out of it", () => {
  const instance = mount()
  press(listbox(instance.tree, "available"), " ")
  let tree = instance.rerender()
  press(listbox(tree, "available"), "ArrowDown", { shiftKey: true })
  tree = instance.rerender()
  assert.deepEqual(
    options(tree, "available").map((o) => o.props["aria-selected"]),
    [true, true, false]
  )
  // Back the way it came: the run is still selected rather than being peeled off.
  press(listbox(tree, "available"), "ArrowUp", { shiftKey: true })
  tree = instance.rerender()
  assert.deepEqual(
    options(tree, "available").map((o) => o.props["aria-selected"]),
    [true, true, false]
  )
})

test("Ctrl+A and Cmd+A pick everything on screen that can move", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }, ITEMS[2]]
  const instance = mount({ items })
  press(listbox(instance.tree, "available"), "a", { ctrlKey: true })
  let tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 2 selected to Chosen")
  assert.deepEqual(
    options(tree, "available").map((o) => o.props["aria-selected"]),
    [true, false, true]
  )

  const other = mount({ items })
  press(listbox(other.tree, "available"), "A", { metaKey: true })
  tree = other.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 2 selected to Chosen")
})

test("a plain letter is left to the page", () => {
  const instance = mount()
  const wasPrevented = press(listbox(instance.tree, "available"), "a")
  assert.equal(wasPrevented(), false)
})

// --- both empty states -----------------------------------------------------

test("an empty side says so, and is described by it", () => {
  const { tree } = mount()
  const list = listbox(tree, "chosen")
  assert.equal(list.props["aria-describedby"], "harness-id-chosen-empty")
  const empty = walk(tree).find((n) => n.props?.id === "harness-id-chosen-empty")
  assert.equal(empty.props.children, "Chosen is empty")
  assert.equal(empty.props.role, "presentation", "not one of the listbox's options")
})

test("filtered to nothing is a different problem from empty, and says so", () => {
  const instance = mount()
  searchBox(instance.tree, "available").props.onChange({ target: { value: "zzz" } })
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), [])
  const empty = walk(tree).find((n) => n.props?.id === "harness-id-available-empty")
  assert.equal(empty.props.children, "Nothing in Available matches")
  assert.equal(listbox(tree, "available").props.tabIndex, 0)
})

test("a side that has rows is described by its selected count instead", () => {
  const { tree } = mount()
  assert.equal(listbox(tree, "available").props["aria-describedby"], "harness-id-available-count")
  const count = walk(tree).find((n) => n.props?.id === "harness-id-available-count")
  assert.equal(count.props.children, "None selected")
})

// --- filtering -------------------------------------------------------------

test("a filter narrows the side for every purpose, so nothing unseen is moved", () => {
  const onChange = []
  const instance = mount({ onChange: (next) => onChange.push(next) })
  searchBox(instance.tree, "available").props.onChange({ target: { value: "r" } })
  let tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), ["Bravo", "Charlie"])
  assert.equal(buttons(tree).rightAll.props["aria-label"], "Move all 2 to Chosen")

  buttons(tree).rightAll.props.onClick()
  tree = instance.rerender()
  assert.deepEqual(onChange, [["b", "c"]])
  // Alpha was never on screen and did not move.
  assert.deepEqual(transferListSides(ITEMS, onChange[0]).available.map((i) => i.value), ["a"])
})

test("the count beside a heading is what is shown, not what the side holds", () => {
  const instance = mount()
  const shownCount = (tree, side) => {
    const heading = walk(tree).find((n) => n.props?.id === `harness-id-${side}-heading`)
    const row = walk(tree).find((n) => Array.isArray(n.props?.children) && n.props.children.includes(heading))
    return row.props.children.filter((c) => c !== heading)[0].props.children
  }
  assert.equal(shownCount(instance.tree, "available"), "3")
  searchBox(instance.tree, "available").props.onChange({ target: { value: "r" } })
  const tree = instance.rerender()
  assert.equal(shownCount(tree, "available"), "2 of 3")
})

test("a selection filtered out of sight is kept, and not counted while it is hidden", () => {
  const instance = mount()
  options(instance.tree, "available")[1].props.onClick()
  let tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 1 selected to Chosen")

  searchBox(tree, "available").props.onChange({ target: { value: "alpha" } })
  tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), ["Alpha"])
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 0 selected to Chosen")

  searchBox(tree, "available").props.onChange({ target: { value: "" } })
  tree = instance.rerender()
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 1 selected to Chosen")
  assert.equal(options(tree, "available")[1].props["aria-selected"], true)
})

test("the filter matches the value as well as the label", () => {
  const instance = mount({ items: [{ value: "sku-9", label: "Widget" }] })
  searchBox(instance.tree, "available").props.onChange({ target: { value: "SKU" } })
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), ["Widget"])
})

test("searchable={false} leaves the filter boxes out", () => {
  const { tree } = mount({ searchable: false })
  assert.equal(byTag(walk(tree), "input").filter((n) => n.props.type === "text").length, 0)
})

// --- announcing ------------------------------------------------------------

test("a move is announced, because it changes two lists and no field", () => {
  const instance = mount()
  assert.equal(liveRegion(instance.tree).props.children, "")

  buttons(instance.tree).rightSelected.props.onClick()
  let tree = instance.rerender()
  assert.equal(liveRegion(tree).props.children, "", "a press that moves nothing says nothing")

  options(tree, "available")[0].props.onClick()
  tree = instance.rerender()
  buttons(tree).rightSelected.props.onClick()
  tree = instance.rerender()
  assert.equal(liveRegion(tree).props.children, "Moved 1 to Chosen. 2 rows left in Available.")

  buttons(tree).rightAll.props.onClick()
  tree = instance.rerender()
  assert.equal(liveRegion(tree).props.children, "Moved 2 to Chosen. 0 rows left in Available.")
})

test("the announcement counts one row as one row", () => {
  const instance = mount({ items: [ITEMS[0], ITEMS[1]] })
  buttons(instance.tree).rightSelected.props.onClick()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  buttons(tree).rightSelected.props.onClick()
  tree = instance.rerender()
  assert.equal(liveRegion(tree).props.children, "Moved 1 to Chosen. 1 row left in Available.")
})

// --- labels ----------------------------------------------------------------

test("one pair of headings moves every name in the component", () => {
  const { tree } = mount({
    availableLabel: "All permissions",
    chosenLabel: "Granted",
    defaultValue: ["c"],
  })
  assert.equal(buttons(tree).rightAll.props["aria-label"], "Move all 2 to Granted")
  assert.equal(buttons(tree).leftSelected.props["aria-label"], "Move 0 selected to All permissions")
  assert.equal(searchBox(tree, "chosen").props["aria-label"], "Filter Granted")
  const empty = walk(tree).find((n) => n.props?.id === "harness-id-available-heading")
  assert.equal(empty.props.children, "All permissions")
})

test("labels overrides one name without rewriting the rest", () => {
  const { tree } = mount({ labels: { moveAll: (count) => `Take all ${count}` } })
  assert.equal(buttons(tree).rightAll.props["aria-label"], "Take all 3")
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 0 selected to Chosen")
})

test("the default labels are the ones a reader of the registry sees", () => {
  assert.equal(defaultTransferListLabels.available, "Available")
  assert.equal(defaultTransferListLabels.chosen, "Chosen")
  assert.equal(defaultTransferListLabels.moveSelected(1, "Chosen"), "Move 1 selected to Chosen")
  assert.equal(defaultTransferListLabels.moveSelected(3, "Chosen"), "Move 3 selected to Chosen")
  assert.equal(defaultTransferListLabels.moveAll(1, "Chosen"), "Move 1 to Chosen")
  assert.equal(defaultTransferListLabels.count(3, 3), "3")
  assert.equal(defaultTransferListLabels.count(2, 3), "2 of 3")
  assert.equal(defaultTransferListLabels.selectedCount(0), "None selected")
  assert.equal(transferListLabels("Left", "Right").moveAll(2, "Right"), "Move all 2 to Right")
})

// --- the shell -------------------------------------------------------------

test("controlled means the prop decides, and onChange is told what to set it to", () => {
  const seen = []
  const instance = render(TransferList, {
    items: ITEMS,
    value: ["c"],
    onChange: (next, change) => seen.push([next, change]),
  })
  buttons(instance.tree).rightAll.props.onClick()
  const tree = instance.rerender()
  assert.deepEqual(seen, [[["a", "b", "c"], { to: "chosen", values: ["a", "b"] }]])
  // Nothing moved on screen, the prop not having changed.
  assert.deepEqual(labelsOf(tree, "chosen"), ["Charlie"])

  instance.update({ items: ITEMS, value: ["a", "b", "c"] })
  assert.deepEqual(labelsOf(instance.tree, "chosen"), ["Alpha", "Bravo", "Charlie"])
  assert.deepEqual(labelsOf(instance.tree, "available"), [])
})

test("a caller's aria-describedby is merged with the description, not swallowed by it", () => {
  const { tree } = mount({ description: "Pick the columns", "aria-describedby": "outside-hint" })
  const group = byRole(walk(tree), "group")[0]
  assert.equal(group.props["aria-describedby"], "outside-hint harness-id-description")
  assert.equal(group.props["aria-labelledby"], undefined)
})

test("a label names the group", () => {
  const { tree } = mount({ label: "Columns" })
  const group = byRole(walk(tree), "group")[0]
  assert.equal(group.props["aria-labelledby"], "harness-id-label")
  const heading = walk(tree).find((n) => n.props?.id === "harness-id-label")
  assert.equal(heading.props.children, "Columns")
})

test("name submits the chosen values as one hidden input each", () => {
  const instance = mount({ defaultValue: ["c"], name: "columns" })
  const hidden = (tree) => byTag(walk(tree), "input").filter((n) => n.props.type === "hidden")
  assert.deepEqual(
    hidden(instance.tree).map((n) => [n.props.name, n.props.value]),
    [["columns", "c"]]
  )
  buttons(instance.tree).rightAll.props.onClick()
  const tree = instance.rerender()
  assert.deepEqual(
    hidden(tree).map((n) => n.props.value),
    ["a", "b", "c"]
  )
})

test("the hidden inputs are told the control is disabled, and which form they belong to", () => {
  // What submits is the hidden inputs: a disabled control is left out of the form data by the
  // browser, and one that was never told it is disabled is not left out.
  const { tree } = mount({ defaultValue: ["c"], name: "columns", disabled: true, form: "settings" })
  const hidden = byTag(walk(tree), "input").filter((n) => n.props.type === "hidden")
  assert.equal(hidden.length, 1)
  assert.equal(hidden[0].props.disabled, true)
  assert.equal(hidden[0].props.form, "settings")
})

test("no hidden inputs without a name", () => {
  const { tree } = mount({ defaultValue: ["c"] })
  assert.equal(byTag(walk(tree), "input").filter((n) => n.props.type === "hidden").length, 0)
})

test("the icons are decorative; the buttons carry the names", () => {
  const { tree } = mount()
  for (const svg of walk(tree).filter((n) => n.type === "svg")) {
    assert.equal(svg.props["aria-hidden"], "true")
  }
})

// --- cases the mutation pass asked for ------------------------------------
// Every one of these is a rule the source states and nothing above was checking: run
// `node scripts/mutate.mjs registry/ui/transfer-list.tsx test/transfer-list.test.mjs` and each
// corresponds to a mutant that survived.

test("the cursor moves up as well as down", () => {
  const instance = mount()
  press(listbox(instance.tree, "available"), "End")
  let tree = instance.rerender()
  press(listbox(tree, "available"), "ArrowUp")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-1"
  )
  // And does not walk off the top either.
  press(listbox(tree, "available"), "ArrowUp")
  tree = instance.rerender()
  press(listbox(tree, "available"), "ArrowUp")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-0"
  )
})

test("Home goes to the first row, End to the last", () => {
  const instance = mount()
  press(listbox(instance.tree, "available"), "End")
  let tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-2"
  )
  press(listbox(tree, "available"), "Home")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-0"
  )
})

test("a one-row list still claims the keys a listbox owns", () => {
  const instance = mount({ items: [ITEMS[0]] })
  for (const [key, modifiers] of [
    ["ArrowDown", {}],
    ["ArrowUp", {}],
    ["Home", {}],
    ["End", {}],
    [" ", {}],
    ["a", { ctrlKey: true }],
  ]) {
    const wasPrevented = press(listbox(instance.tree, "available"), key, modifiers)
    assert.equal(wasPrevented(), true, `${key} should be handled on a list of one`)
    instance.rerender()
  }
})

test("Shift+Arrow onto a locked row leaves it locked", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }]
  const instance = mount({ items })
  press(listbox(instance.tree, "available"), "ArrowDown", { shiftKey: true })
  const tree = instance.rerender()
  assert.equal(options(tree, "available")[1].props["aria-selected"], false)
  assert.equal(buttons(tree).rightSelected.props["aria-label"], "Move 0 selected to Chosen")
})

test("Enter on a locked row moves nothing", () => {
  const items = [{ value: "a", label: "Alpha", disabled: true }, ITEMS[1]]
  const onChange = []
  const instance = mount({ items, onChange: (next) => onChange.push(next) })
  press(listbox(instance.tree, "available"), "Enter")
  const tree = instance.rerender()
  assert.deepEqual(onChange, [])
  assert.deepEqual(labelsOf(tree, "chosen"), [])
})

test("Enter moves the selection even when the cursor is standing somewhere else", () => {
  const items = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
    { value: "c", label: "Charlie" },
    { value: "d", label: "Delta" },
    { value: "e", label: "Echo" },
  ]
  const instance = mount({ items })
  // Pick the top two rows, then walk the cursor down to the fourth.
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  options(tree, "available")[1].props.onClick()
  tree = instance.rerender()
  press(listbox(tree, "available"), "End")
  tree = instance.rerender()
  press(listbox(tree, "available"), "ArrowUp")
  tree = instance.rerender()
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-3"
  )

  press(listbox(tree, "available"), "Enter")
  tree = instance.rerender()
  // The selection moved, not the row under the cursor.
  assert.deepEqual(labelsOf(tree, "chosen"), ["Alpha", "Bravo"])
  // And the cursor followed the row it was standing on — Delta, now the second of three.
  assert.equal(
    listbox(tree, "available").props["aria-activedescendant"],
    "harness-id-available-opt-1"
  )
  assert.equal(labelsOf(tree, "available")[1], "Delta")
})

test("taking a row out of the selection leaves the rest of it alone", () => {
  const instance = mount()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  options(tree, "available")[1].props.onClick()
  tree = instance.rerender()
  options(tree, "available")[2].props.onClick()
  tree = instance.rerender()
  options(tree, "available")[1].props.onClick()
  tree = instance.rerender()
  assert.deepEqual(
    options(tree, "available").map((o) => o.props["aria-selected"]),
    [true, false, true]
  )
})

test("each side's cursor starts on its own first row", () => {
  const { tree } = mount({ defaultValue: ["b", "c"] })
  assert.equal(
    listbox(tree, "chosen").props["aria-activedescendant"],
    "harness-id-chosen-opt-0"
  )
  assert.equal(options(tree, "chosen")[0].props["data-active"], "true")
  assert.equal(options(tree, "chosen")[1].props["data-active"], undefined)
})

test("the move buttons are type=button, so they cannot submit the form around them", () => {
  const { tree } = mount()
  for (const button of buttons(tree).all) {
    assert.equal(button.props.type, "button")
  }
})

test("a locked row says it is locked", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }]
  const { tree } = mount({ items })
  assert.equal(options(tree, "available")[0].props["aria-disabled"], undefined)
  assert.equal(options(tree, "available")[1].props["aria-disabled"], true)
})

test("the selected rows and the cursor are visible, not only announced", () => {
  const instance = mount()
  options(instance.tree, "available")[1].props.onClick()
  const tree = instance.rerender()
  const [first, second] = options(tree, "available")
  assert.match(second.props.className, /bg-accent/)
  assert.doesNotMatch(first.props.className, /bg-accent/)
  // The cursor followed the click, and is drawn as a ring rather than as the selection.
  assert.match(second.props.className, /ring-ring/)
  assert.doesNotMatch(first.props.className, /ring-ring/)
})

test("a locked row is drawn as unavailable", () => {
  const items = [ITEMS[0], { value: "b", label: "Bravo", disabled: true }]
  const { tree } = mount({ items })
  assert.match(options(tree, "available")[1].props.className, /cursor-not-allowed/)
  assert.doesNotMatch(options(tree, "available")[0].props.className, /cursor-not-allowed/)
})

test("an enabled listbox is not drawn as a disabled one", () => {
  const { tree } = mount()
  assert.doesNotMatch(listbox(tree, "available").props.className, /opacity-50/)
  const off = mount({ disabled: true }).tree
  assert.match(listbox(off, "available").props.className, /opacity-50/)
})

test("each move button's icon points the way it moves", () => {
  const { tree } = mount({ defaultValue: ["c"] })
  const iconOf = (button) => walk(button.props.children).find((n) => n.type === "svg").props["data-icon"]
  const { rightSelected, rightAll, leftAll, leftSelected } = buttons(tree)
  assert.equal(iconOf(rightSelected), "chevron-right")
  assert.equal(iconOf(rightAll), "chevrons-right")
  assert.equal(iconOf(leftAll), "chevrons-left")
  assert.equal(iconOf(leftSelected), "chevron-left")
})

test("a selected-scope button that can act says nothing about being unavailable", () => {
  const instance = mount({ defaultValue: ["c"] })
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  options(tree, "chosen")[0].props.onClick()
  tree = instance.rerender()
  const { rightSelected, leftSelected } = buttons(tree)
  for (const button of [rightSelected, leftSelected]) {
    assert.equal(button.props["aria-disabled"], undefined)
    assert.equal(button.props["aria-describedby"], undefined)
  }
})

test("a move to the other side is announced by that side's name", () => {
  const instance = mount({ defaultValue: ["b", "c"] })
  buttons(instance.tree).leftAll.props.onClick()
  const tree = instance.rerender()
  assert.equal(liveRegion(tree).props.children, "Moved 2 to Available. 0 rows left in Chosen.")
})

test("a one-character filter that matches nothing is still a filter, not an empty side", () => {
  const instance = mount()
  searchBox(instance.tree, "available").props.onChange({ target: { value: "q" } })
  const tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "available"), [])
  const empty = walk(tree).find((n) => n.props?.id === "harness-id-available-empty")
  assert.equal(empty.props.children, "Nothing in Available matches")
})

test("a caller's aria-labelledby is merged with the label, not swallowed by it", () => {
  const { tree } = mount({ label: "Columns", "aria-labelledby": "outside-heading" })
  const group = byRole(walk(tree), "group")[0]
  assert.equal(group.props["aria-labelledby"], "outside-heading harness-id-label")
})

test("Enter moves a selection of one, which is not the row under the cursor", () => {
  // The likeliest shape of the case above, and the one where "move the selection" and "move the row
  // under the cursor" are easiest to confuse: exactly one row picked, the cursor somewhere else.
  const instance = mount()
  options(instance.tree, "available")[0].props.onClick()
  let tree = instance.rerender()
  press(listbox(tree, "available"), "End")
  tree = instance.rerender()

  press(listbox(tree, "available"), "Enter")
  tree = instance.rerender()
  assert.deepEqual(labelsOf(tree, "chosen"), ["Alpha"])
  assert.deepEqual(labelsOf(tree, "available"), ["Bravo", "Charlie"])
})
