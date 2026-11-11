// The column picker everyone writes first treats the stored list of visible keys as the allow-list,
// appends anything new to the end, trusts whatever the saved preference says about every column, and
// swaps a column with its literal neighbour in the array. All four look finished on screen, and the
// cases below are written to fail against them:
//
//   - a column added by a later deploy, invisible to exactly the people who have ever opened the
//     menu and visible only to those who never have,
//   - that column appended past the row-actions column at the far right instead of landing where it
//     was defined,
//   - a locked column left hidden, or left where an old preference moved it, because `locked` is a
//     fact about this deploy's table and not about the stored value,
//   - a saved key that no longer exists carried along, leaving a hole the next reorder shuffles,
//   - a table hidden down to zero columns, with the control that would undo it inside one of them,
//   - a "move down" that trades places with a hidden column, so the table does not change and the
//     button looks broken,
//   - and a greyed-out checkbox that refuses the press without saying why, when the reason — the
//     floor — lifts the moment another column comes back.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

const {
  defaultColumnPreference,
  resolveColumnPreference,
  hideBlockedReason,
  setColumnVisible,
  toggleColumnVisibility,
  showAllColumns,
  moveColumn,
  isDefaultColumnPreference,
  serializeColumnPreference,
  parseColumnPreference,
  defaultColumnVisibilityLabels,
  useColumnVisibility,
  ColumnVisibility,
} = loadComponent(join(ROOT, "registry", "ui", "column-visibility.tsx"), {
  stubs: {
    "lucide-react": {
      ArrowDown: icon("arrow-down"),
      ArrowUp: icon("arrow-up"),
      Check: icon("check"),
      Columns3: icon("columns"),
      Lock: icon("lock"),
      RotateCcw: icon("reset"),
    },
  },
})

const pointerListeners = []
globalThis.document = {
  addEventListener: (type, handler, capture) => {
    if (type === "pointerdown") pointerListeners.push({ handler, capture })
  },
  // Matched on the capture flag too, the way the DOM does: a capture listener removed without the
  // flag is never removed, and a stub that ignored it would report that leak as clean.
  removeEventListener: (type, handler, capture) => {
    if (type !== "pointerdown") return
    const at = pointerListeners.findIndex(
      (entry) => entry.handler === handler && Boolean(entry.capture) === Boolean(capture)
    )
    if (at >= 0) pointerListeners.splice(at, 1)
  },
}

const COLUMNS = [
  { key: "select", label: "Select", locked: true },
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "created", label: "Created" },
  { key: "actions", label: "Actions", locked: true },
]

const PLAIN = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "created", label: "Created" },
]

// --- carry-over: a stored preference is always out of date -----------------------------------------

test("a column the saved preference never saw is shown, not hidden", () => {
  // The expensive bug: the stored list read as an allow-list. Everyone who has used the menu has a
  // preference, so a column shipped later is invisible to the established users and visible only to
  // people who have never opened it — and nobody reports a column they cannot see.
  const saved = { order: ["name", "email"], hidden: [] }
  const resolved = resolveColumnPreference(PLAIN, saved)
  assert.equal(resolved.hidden.includes("created"), false)
  assert.deepEqual(
    resolved.visible.map((column) => column.key),
    ["name", "email", "created"]
  )
})

test("the new column lands where it was defined, not appended to the end", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "created", label: "Created" },
    { key: "actions", label: "Actions", locked: true },
  ]
  // The preference was written before `status` existed.
  const resolved = resolveColumnPreference(columns, { order: ["name", "created", "actions"] })
  assert.deepEqual(resolved.order, ["name", "status", "created", "actions"])
})

test("a run of new columns keeps its own definition order", () => {
  const columns = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
    { key: "d", label: "D" },
  ]
  // Anchoring each new key after the nearest placed predecessor is what keeps b, c in that order; a
  // naive "insert after the previous defined column" reverses them.
  assert.deepEqual(resolveColumnPreference(columns, { order: ["a", "d"] }).order, ["a", "b", "c", "d"])
})

test("new columns at the front stay at the front, in order", () => {
  const columns = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
  ]
  assert.deepEqual(resolveColumnPreference(columns, { order: ["c"] }).order, ["a", "b", "c"])
})

test("added is empty on a first visit, when every column is new to an empty preference", () => {
  // Otherwise a component reporting it greets a new user with "3 new columns".
  assert.deepEqual(resolveColumnPreference(PLAIN, null).added, [])
  assert.deepEqual(resolveColumnPreference(PLAIN, {}).added, [])
  assert.deepEqual(resolveColumnPreference(PLAIN, { order: [], hidden: [] }).added, [])
  assert.deepEqual(resolveColumnPreference(PLAIN, { order: ["name"] }).added, ["email", "created"])
})

test("a preference that stores only hidden reports nothing as added, ever", () => {
  // `{ hidden: [...] }` with no order is a complete preference and a common way to store one. Only
  // `order` enumerates the columns a preference knew — `hidden` lists a subset and says nothing
  // about the rest — so measuring newness against both fields makes every unlisted column "new" on
  // every single load. That is the first-visit false positive again, except it never goes away.
  const resolved = resolveColumnPreference(PLAIN, { hidden: ["email"] })
  assert.deepEqual(resolved.added, [])
  assert.deepEqual(resolved.hidden, ["email"])
  assert.deepEqual(resolved.order, ["name", "email", "created"])
})

test("a key the preference hid is a key it has heard of", () => {
  // It has an order, so omission means something — but `legacy` was mentioned, in the other field.
  const columns = [...PLAIN, { key: "legacy", label: "Legacy" }]
  const resolved = resolveColumnPreference(columns, {
    order: ["name", "email", "created"],
    hidden: ["legacy"],
  })
  assert.deepEqual(resolved.added, [])
  assert.deepEqual(resolved.hidden, ["legacy"])
})

test("a key that no longer exists is dropped from the order and from hidden", () => {
  const resolved = resolveColumnPreference(PLAIN, {
    order: ["name", "legacy", "email", "created"],
    hidden: ["legacy", "gone", "email"],
  })
  assert.deepEqual(resolved.order, ["name", "email", "created"])
  assert.deepEqual(resolved.hidden, ["email"])
  assert.deepEqual(resolved.dropped, ["legacy", "gone"])
})

test("a locked column is pulled back to its defined position", () => {
  // `locked` describes this deploy's table. A preference written when the column was ordinary must
  // not be able to park the row-actions column in the middle.
  const resolved = resolveColumnPreference(COLUMNS, {
    order: ["name", "actions", "email", "select", "created"],
  })
  assert.deepEqual(resolved.order, ["select", "name", "email", "created", "actions"])
})

test("a locked column is shown again even when the saved preference hid it", () => {
  const resolved = resolveColumnPreference(COLUMNS, { hidden: ["select", "actions", "email"] })
  assert.deepEqual(resolved.hidden, ["email"])
})

test("the movable columns keep the order the preference asked for, around the pinned ones", () => {
  const resolved = resolveColumnPreference(COLUMNS, { order: ["created", "email", "name"] })
  assert.deepEqual(resolved.order, ["select", "created", "email", "name", "actions"])
})

test("duplicate keys in the definitions are collapsed, first one winning", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "name", label: "Name again" },
    { key: "email", label: "Email" },
  ]
  const resolved = resolveColumnPreference(columns, null)
  assert.deepEqual(resolved.order, ["name", "email"])
  assert.deepEqual(
    resolved.visible.map((column) => column.label),
    ["Name", "Email"]
  )
})

test("columns with an empty or non-string key are skipped rather than rendered nameless", () => {
  const columns = [{ key: "", label: "Nothing" }, { key: "name", label: "Name" }]
  assert.deepEqual(resolveColumnPreference(columns, null).order, ["name"])
})

// --- the floor ------------------------------------------------------------------------------------

test("the floor is applied after the carry-over, not only at the moment of a press", () => {
  // A preference that hid all but one column, meeting a deploy that removed that column.
  const columns = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
  ]
  const resolved = resolveColumnPreference(columns, { hidden: ["a", "b", "c"] })
  assert.equal(resolved.visible.length, 1)
  assert.deepEqual(resolved.revealed, ["a"])
  assert.deepEqual(resolved.hidden, ["b"])
})

test("minVisible reveals in render order and reports exactly what it revealed", () => {
  const resolved = resolveColumnPreference(PLAIN, { hidden: ["name", "email", "created"] }, { minVisible: 2 })
  assert.deepEqual(resolved.revealed, ["name", "email"])
  assert.deepEqual(resolved.hidden, ["created"])
})

test("a minVisible larger than the table clamps instead of making the floor unreachable", () => {
  const resolved = resolveColumnPreference(PLAIN, { hidden: ["name", "email", "created"] }, { minVisible: 99 })
  assert.deepEqual(resolved.hidden, [])
  assert.equal(resolved.visible.length, 3)
})

test("minVisible 0 lets every column go", () => {
  const resolved = resolveColumnPreference(PLAIN, { hidden: ["name", "email", "created"] }, { minVisible: 0 })
  assert.deepEqual(resolved.visible, [])
  assert.deepEqual(resolved.revealed, [])
})

test("locked columns count towards the floor, so they can satisfy it alone", () => {
  const resolved = resolveColumnPreference(COLUMNS, { hidden: ["name", "email", "created"] })
  // select and actions are still there, so nothing had to be revealed.
  assert.deepEqual(resolved.revealed, [])
  assert.deepEqual(
    resolved.visible.map((column) => column.key),
    ["select", "actions"]
  )
})

test("resolving twice changes nothing", () => {
  const once = resolveColumnPreference(COLUMNS, { order: ["created", "name"], hidden: ["email"] })
  const twice = resolveColumnPreference(COLUMNS, once)
  assert.deepEqual(twice.order, once.order)
  assert.deepEqual(twice.hidden, once.hidden)
  assert.deepEqual(twice.added, [])
  assert.deepEqual(twice.dropped, [])
})

test("resolving does not touch the caller's arrays", () => {
  const saved = { order: ["created", "name"], hidden: ["email", "gone"] }
  const order = saved.order.slice()
  const hidden = saved.hidden.slice()
  const resolved = resolveColumnPreference(COLUMNS, saved)
  assert.deepEqual(saved.order, order)
  assert.deepEqual(saved.hidden, hidden)
  // And the result is not aliased to the input either.
  resolved.order.push("mutated")
  assert.deepEqual(saved.order, order)
})

// --- refusals -------------------------------------------------------------------------------------

test("locked and minimum are different refusals, because one of them lifts", () => {
  assert.equal(hideBlockedReason(COLUMNS, null, "select"), "locked")
  assert.equal(hideBlockedReason(COLUMNS, null, "name"), null)

  const downToOne = { hidden: ["email", "created"] }
  assert.equal(hideBlockedReason(PLAIN, downToOne, "name"), "minimum")
  // Shown again, and the refusal is gone — which is why it must not be worded like `locked`.
  assert.equal(hideBlockedReason(PLAIN, { hidden: ["created"] }, "name"), null)
})

test("an already-hidden column is not blocked from being hidden further", () => {
  assert.equal(hideBlockedReason(PLAIN, { hidden: ["email", "created"] }, "email"), null)
})

test("hiding the last visible column is refused", () => {
  assert.equal(setColumnVisible(PLAIN, { hidden: ["email", "created"] }, "name", false), null)
})

test("a press that would change nothing is refused rather than written back", () => {
  assert.equal(setColumnVisible(PLAIN, null, "name", true), null)
  assert.equal(setColumnVisible(PLAIN, { hidden: ["email"] }, "email", false), null)
})

test("a locked column cannot be hidden, and an unknown key cannot be anything", () => {
  assert.equal(setColumnVisible(COLUMNS, null, "select", false), null)
  assert.equal(setColumnVisible(COLUMNS, null, "nope", false), null)
  assert.equal(moveColumn(COLUMNS, null, "select", 1), null)
  assert.equal(moveColumn(COLUMNS, null, "nope", 1), null)
})

test("hiding writes back the resolved order, so the carry-over decisions stop being recomputed", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "created", label: "Created" },
  ]
  const next = setColumnVisible(columns, { order: ["name", "created"] }, "created", false)
  assert.deepEqual(next, { order: ["name", "status", "created"], hidden: ["created"] })
})

test("hidden comes back in render order, not in the order things were pressed", () => {
  let preference = defaultColumnPreference()
  preference = setColumnVisible(PLAIN, preference, "created", false)
  preference = setColumnVisible(PLAIN, preference, "email", false)
  assert.deepEqual(preference.hidden, ["email", "created"])
})

test("toggle flips in both directions", () => {
  const hidden = toggleColumnVisibility(PLAIN, null, "email")
  assert.deepEqual(hidden.hidden, ["email"])
  const shown = toggleColumnVisibility(PLAIN, hidden, "email")
  assert.deepEqual(shown.hidden, [])
})

test("show all keeps the order and refuses when nothing is hidden", () => {
  const reordered = { order: ["created", "email", "name"], hidden: ["email"] }
  const shown = showAllColumns(PLAIN, reordered)
  assert.deepEqual(shown, { order: ["created", "email", "name"], hidden: [] })
  assert.equal(showAllColumns(PLAIN, shown), null)
})

test("the default preference is the one that resolves to the definitions", () => {
  assert.equal(isDefaultColumnPreference(PLAIN, null), true)
  assert.equal(isDefaultColumnPreference(PLAIN, defaultColumnPreference()), true)
  assert.equal(isDefaultColumnPreference(PLAIN, { order: ["name", "email", "created"] }), true)
  assert.equal(isDefaultColumnPreference(PLAIN, { hidden: ["email"] }), false)
  assert.equal(isDefaultColumnPreference(PLAIN, { order: ["email", "name", "created"] }), false)
  // A preference whose only content is a key that no longer exists resolves to the default.
  assert.equal(isDefaultColumnPreference(PLAIN, { order: ["gone"], hidden: ["gone"] }), true)
})

// --- moving ---------------------------------------------------------------------------------------

test("a move steps over a hidden column, so every press changes the table", () => {
  // Swapping with the literal neighbour trades Name for a column nobody can see: the table is
  // identical, and the button reads as broken.
  const next = moveColumn(PLAIN, { hidden: ["email"] }, "name", 1)
  assert.deepEqual(next.order, ["created", "email", "name"])
  assert.deepEqual(
    resolveColumnPreference(PLAIN, next).visible.map((column) => column.key),
    ["created", "name"]
  )
})

test("a hidden column keeps its index through the swap it was skipped in", () => {
  // So un-hiding it later puts it back between the same two neighbours rather than at an end.
  const next = moveColumn(PLAIN, { hidden: ["email"] }, "name", 1)
  assert.equal(next.order.indexOf("email"), 1)
  assert.deepEqual(showAllColumns(PLAIN, next).order, ["created", "email", "name"])
})

test("two hidden columns in the way are both stepped over in one press", () => {
  const columns = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
    { key: "d", label: "D" },
  ]
  const next = moveColumn(columns, { hidden: ["b", "c"] }, "a", 1)
  assert.deepEqual(next.order, ["d", "b", "c", "a"])
})

test("a move is reversible", () => {
  const columns = [
    { key: "a", label: "A" },
    { key: "b", label: "B" },
    { key: "c", label: "C" },
    { key: "d", label: "D" },
  ]
  const saved = { hidden: ["b", "c"] }
  const down = moveColumn(columns, saved, "a", 1)
  const back = moveColumn(columns, down, "a", -1)
  assert.deepEqual(back.order, resolveColumnPreference(columns, saved).order)
  assert.deepEqual(back.hidden, resolveColumnPreference(columns, saved).hidden)
})

test("a locked column is a wall, not a column you can move through", () => {
  // Pinning the row-actions column to the end is only worth anything if nothing can be moved past
  // it — otherwise the last press of "later" puts a data column after it.
  assert.equal(moveColumn(COLUMNS, null, "created", 1), null)
  assert.equal(moveColumn(COLUMNS, null, "name", -1), null)
  const inward = moveColumn(COLUMNS, null, "name", 1)
  assert.deepEqual(inward.order, ["select", "email", "name", "created", "actions"])
})

test("a move with nothing on that side is refused", () => {
  assert.equal(moveColumn(PLAIN, null, "name", -1), null)
  assert.equal(moveColumn(PLAIN, null, "created", 1), null)
  // Nothing visible on that side either: only hidden columns remain.
  assert.equal(moveColumn(PLAIN, { hidden: ["email", "created"] }, "name", 1), null)
})

test("a hidden column can still be moved, swapping with the nearest visible one", () => {
  const next = moveColumn(PLAIN, { hidden: ["email"] }, "email", -1)
  assert.deepEqual(next.order, ["email", "name", "created"])
  assert.deepEqual(next.hidden, ["email"])
})

test("moving writes hidden back in the new render order", () => {
  const next = moveColumn(PLAIN, { hidden: ["name"] }, "name", 1)
  assert.deepEqual(next.order, ["email", "name", "created"])
  assert.deepEqual(next.hidden, ["name"])
})

// --- the string that goes in a URL ----------------------------------------------------------------

test("the preference round-trips through the string, as the table it describes", () => {
  const preference = { order: ["created", "email", "name"], hidden: ["email"] }
  const text = serializeColumnPreference(preference)
  assert.equal(text, "created,-email,name")
  const back = resolveColumnPreference(PLAIN, parseColumnPreference(text))
  const direct = resolveColumnPreference(PLAIN, preference)
  assert.deepEqual(back.order, direct.order)
  assert.deepEqual(back.hidden, direct.hidden)
})

test("a hidden key the order never mentioned survives the round trip", () => {
  // `{ hidden: ["email"] }` is a complete preference; serialising it to "" would lose it.
  assert.equal(serializeColumnPreference({ hidden: ["email"] }), "-email")
  assert.deepEqual(parseColumnPreference("-email"), { order: ["email"], hidden: ["email"] })
})

test("keys holding the format's own characters survive", () => {
  for (const key of ["a,b", "-lead", "~tilde", "a~cb", "~-x", "~~", "-", ","]) {
    const text = serializeColumnPreference({ order: [key], hidden: [] })
    assert.deepEqual(parseColumnPreference(text), { order: [key], hidden: [] }, `visible ${key}`)
    const hiddenText = serializeColumnPreference({ order: [key], hidden: [key] })
    assert.deepEqual(parseColumnPreference(hiddenText), { order: [key], hidden: [key] }, `hidden ${key}`)
  }
})

test("a stray tilde keeps the character after it instead of eating it", () => {
  // This string can be typed by hand, and swallowing a letter would quietly rename the column.
  assert.deepEqual(parseColumnPreference("a~b"), { order: ["a~b"], hidden: [] })
})

test("parsing junk never throws, and resolves to the default table", () => {
  for (const text of ["", null, undefined, ",,,", "-", "-,-", "~", "~~~", "a,,b"]) {
    const parsed = parseColumnPreference(text)
    assert.ok(Array.isArray(parsed.order) && Array.isArray(parsed.hidden), String(text))
    assert.doesNotThrow(() => resolveColumnPreference(PLAIN, parsed), String(text))
  }
  assert.deepEqual(parseColumnPreference(""), { order: [], hidden: [] })
  assert.deepEqual(resolveColumnPreference(PLAIN, parseColumnPreference("nope,-gone")).order, [
    "name",
    "email",
    "created",
  ])
})

test("a repeated key in the string is taken once, the first time", () => {
  assert.deepEqual(parseColumnPreference("name,-name,email"), {
    order: ["name", "email"],
    hidden: [],
  })
})

// --- minVisible 0, which has to reach the refusals and not only the resolver --------------------

test("minVisible 0 lets the last column go through the refusals too", () => {
  // The floor is computed in three places — the resolver, `hideBlockedReason`, the hook — and a
  // `??` written as `||` or a `Math.max(0, …)` written as `Math.max(1, …)` in any one of them turns
  // an opted-in zero back into one, so the component silently keeps a column nobody asked it to.
  const down = { hidden: ["email", "created"] }
  assert.equal(hideBlockedReason(PLAIN, down, "name", { minVisible: 0 }), null)
  const next = setColumnVisible(PLAIN, down, "name", false, { minVisible: 0 })
  assert.deepEqual(next.hidden, ["name", "email", "created"])
  assert.deepEqual(resolveColumnPreference(PLAIN, next, { minVisible: 0 }).visible, [])
  // And the default is still 1 when nothing is passed.
  assert.equal(hideBlockedReason(PLAIN, down, "name"), "minimum")
})

// --- the hook on its own --------------------------------------------------------------------------

const hookState = { last: null }
function HookProbe(props) {
  hookState.last = useColumnVisibility(props)
  return null
}

const renderHook = (props = {}) => {
  const emitted = []
  const instance = render(HookProbe, {
    columns: PLAIN,
    preference: null,
    onPreferenceChange: (next) => emitted.push(next),
    ...props,
  })
  return { instance, emitted, get state() {
    return hookState.last
  } }
}

test("the hook's own defaults hold: a floor of one, and it does announce", () => {
  // The component passes both explicitly, so these defaults are only reachable from here — and the
  // hook is exported for exactly the case where nobody is passing them.
  const hook = renderHook({ preference: { hidden: ["email", "created"] } })
  assert.equal(hook.state.atMinimum, true)
  assert.equal(hook.state.hideBlocked("name"), "minimum")
  hook.state.setVisible("name", false)
  hook.instance.rerender()
  assert.deepEqual(hook.emitted, [])
  assert.equal(hook.state.announcement, defaultColumnVisibilityLabels.minimum(1))
  hook.instance.unmount()
})

test("a floor of zero is not a floor, and the panel does not explain one", () => {
  // `visible.length <= floor` is also true when somebody who opted out of the floor has hidden
  // every column, and the note then reads "At least 0 columns have to stay visible."
  const hook = renderHook({
    minVisible: 0,
    preference: { hidden: ["name", "email", "created"] },
  })
  assert.equal(hook.state.visibleCount, 0)
  assert.equal(hook.state.atMinimum, false)
  assert.equal(hook.state.hideBlocked("name"), null)
  hook.instance.unmount()

  const control = open(
    renderControl({ columns: PLAIN, minVisible: 0, preference: { hidden: ["name", "email", "created"] } })
  )
  const text = nodes(control.instance)
    .map((node) => node.props?.children)
    .filter((child) => typeof child === "string")
  assert.equal(text.some((line) => /At least/.test(line)), false, text.join(" | "))
  control.instance.unmount()
})

test("the effective floor is the one the refusal enforces, clamped", () => {
  const hook = renderHook({ minVisible: 99 })
  assert.equal(hook.state.minVisible, 3)
  assert.equal(hook.state.atMinimum, true)
  hook.instance.unmount()

  const fractional = renderHook({ minVisible: 2.7 })
  assert.equal(fractional.state.minVisible, 2)
  fractional.instance.unmount()
})

test("the panel's note names the same number the refusal enforces", () => {
  const control = open(
    renderControl({ columns: PLAIN, minVisible: 2, preference: { hidden: ["created"] } })
  )
  const note = nodes(control.instance).find(
    (node) => typeof node.props?.children === "string" && /At least/.test(node.props.children)
  )
  assert.equal(note.props.children, defaultColumnVisibilityLabels.minimum(2))
  control.instance.unmount()
})

test("the hook refuses to move a locked column or a key that does not exist", () => {
  const hook = renderHook({ columns: COLUMNS })
  assert.equal(hook.state.canMove("select", 1), false)
  assert.equal(hook.state.canMove("select", -1), false)
  assert.equal(hook.state.canMove("nope", 1), false)
  assert.equal(hook.state.canMove("name", 1), true)
  hook.instance.unmount()
})

test("a refused show says nothing, even about a floor that happens to be reached", () => {
  // The refusal belongs to hiding. Announcing the floor when somebody asked for a column that is
  // already there explains a restriction that had no part in what just happened.
  const hook = renderHook({ preference: { hidden: ["email", "created"] } })
  hook.state.setVisible("name", true)
  hook.instance.rerender()
  assert.deepEqual(hook.emitted, [])
  assert.equal(hook.state.announcement, "")
  hook.instance.unmount()
})

test("the announcement counts the columns that are shown, not all of them", () => {
  const hook = renderHook()
  hook.state.setVisible("email", false)
  hook.instance.rerender()
  assert.equal(hook.state.announcement, "Email hidden. 2 of 3 columns shown.")
  hook.instance.unmount()
})

test("the hook reports the carry-over so a caller can act on it", () => {
  const columns = [...PLAIN, { key: "status", label: "Status" }]
  const hook = renderHook({
    columns,
    preference: { order: ["name", "email", "created", "legacy"], hidden: ["legacy"] },
  })
  assert.deepEqual(hook.state.added, ["status"])
  assert.deepEqual(hook.state.dropped, ["legacy"])
  assert.equal(hook.state.total, 4)
  assert.equal(hook.state.visibleCount, 4)
  hook.instance.unmount()
})

// --- the rendered control -------------------------------------------------------------------------

const renderControl = (props = {}) => {
  const emitted = []
  const instance = render(ColumnVisibility, {
    columns: COLUMNS,
    preference: null,
    onPreferenceChange: (next) => emitted.push(next),
    ...props,
  })
  return { instance, emitted }
}

const nodes = (instance) => walk(instance.tree)
const trigger = (instance) => byTag(nodes(instance), "button")[0]
const checkboxes = (instance) => byTag(nodes(instance), "input")
const open = (control) => {
  trigger(control.instance).props.onClick()
  control.instance.rerender()
  return control
}
const liveRegion = (instance) =>
  nodes(instance).find((node) => node.props?.role === "status" && node.props?.["aria-live"] === "polite")

test("the panel is not in the tree until the trigger is pressed", () => {
  const control = renderControl()
  assert.equal(checkboxes(control.instance).length, 0)
  assert.equal(trigger(control.instance).props["aria-expanded"], false)
  assert.equal(trigger(control.instance).props["aria-controls"], undefined)

  open(control)
  assert.equal(trigger(control.instance).props["aria-expanded"], true)
  assert.ok(trigger(control.instance).props["aria-controls"])
  // One per movable column; the two locked ones have no checkbox to press.
  assert.equal(checkboxes(control.instance).length, 3)
  control.instance.unmount()
})

test("the panel is a group with a name, not a menu", () => {
  // `role="menu"` allows one actionable thing per item and takes the arrow keys the move buttons
  // need; every row here holds a checkbox and two buttons.
  const control = open(renderControl())
  const panel = nodes(control.instance).find((node) => node.props?.role === "group")
  assert.ok(panel, "no group")
  const heading = nodes(control.instance).find((node) => node.props?.id === panel.props["aria-labelledby"])
  assert.ok(heading, "the group's name points at nothing")
  assert.equal(heading.props.children, defaultColumnVisibilityLabels.heading)
  assert.equal(nodes(control.instance).some((node) => node.props?.role === "menu"), false)
  control.instance.unmount()
})

test("the trigger's name carries both counts, and the badge is not read twice", () => {
  const control = renderControl({ preference: { hidden: ["email"] } })
  assert.equal(trigger(control.instance).props["aria-label"], "Columns, 4 of 5 shown")
  const badge = nodes(control.instance).find((node) => node.props?.children?.[1] === "/")
  assert.equal(badge?.props["aria-hidden"], "true")
  control.instance.unmount()
})

test("a locked column shows as always-shown, with no control to press", () => {
  const control = open(renderControl())
  const rows = byTag(nodes(control.instance), "li")
  assert.equal(rows.length, 5)
  const lockRow = rows[0]
  assert.equal(byTag(walk(lockRow), "input").length, 0)
  assert.equal(byTag(walk(lockRow), "button").length, 0)
  const note = walk(lockRow).find((node) => node.props?.className === "sr-only")
  assert.equal(note?.props.children, defaultColumnVisibilityLabels.locked)
  control.instance.unmount()
})

test("rows are in render order, locked ones in their pinned places", () => {
  const control = open(renderControl({ preference: { order: ["created", "email", "name"] } }))
  const labels = byTag(nodes(control.instance), "li").map((row) => {
    const text = walk(row).find((node) => node.props?.className?.includes("truncate"))
    return text?.props.children
  })
  assert.deepEqual(labels, ["Select", "Created", "Email", "Name", "Actions"])
  control.instance.unmount()
})

test("pressing a checkbox emits the next preference", () => {
  const control = open(renderControl())
  checkboxes(control.instance)[1].props.onChange({ target: { checked: false } })
  assert.deepEqual(control.emitted.at(-1), {
    order: ["select", "name", "email", "created", "actions"],
    hidden: ["email"],
  })
  control.instance.unmount()
})

test("the last visible column keeps a pressable checkbox and says why it refuses", () => {
  // `disabled` is the tidier-looking version: it takes the row out of the tab order and leaves no
  // way to find out that the reason lifts as soon as another column comes back.
  const control = open(
    renderControl({ columns: PLAIN, preference: { hidden: ["email", "created"] } })
  )
  const box = checkboxes(control.instance)[0]
  assert.equal(box.props.checked, true)
  assert.equal(box.props["aria-disabled"], true)
  assert.equal(box.props.disabled, undefined)
  assert.equal(typeof box.props.onChange, "function")

  const noteId = box.props["aria-describedby"]
  assert.ok(noteId, "the refusal is not described to a screen reader")
  const note = nodes(control.instance).find((node) => node.props?.id === noteId)
  assert.equal(note?.props.children, defaultColumnVisibilityLabels.minimum(1))

  box.props.onChange({ target: { checked: false } })
  control.instance.rerender()
  assert.deepEqual(control.emitted, [], "a refused press still wrote a preference")
  assert.equal(liveRegion(control.instance)?.props.children, defaultColumnVisibilityLabels.minimum(1))
  control.instance.unmount()
})

test("the same refusal twice is still heard the second time", () => {
  // Writing identical text into a live region is not a change, and is not announced.
  const control = open(
    renderControl({ columns: PLAIN, preference: { hidden: ["email", "created"] } })
  )
  const press = () => {
    checkboxes(control.instance)[0].props.onChange({ target: { checked: false } })
    control.instance.rerender()
    return liveRegion(control.instance)?.props.children
  }
  const first = press()
  const second = press()
  assert.notEqual(second, first)
  assert.match(second, /^At least one column/)
  control.instance.unmount()
})

test("a column that cannot be hidden at all is not described as the floor", () => {
  const control = open(renderControl())
  // Only the movable rows have checkboxes, so none of them is `locked`; the locked rows carry their
  // own note instead and nothing points at the floor note, which is not rendered.
  for (const box of checkboxes(control.instance)) {
    assert.equal(box.props["aria-disabled"], undefined)
    assert.equal(box.props["aria-describedby"], undefined)
  }
  control.instance.unmount()
})

test("the move buttons are greyed by the same rule the press follows", () => {
  const control = open(renderControl({ columns: PLAIN }))
  const rows = byTag(nodes(control.instance), "li")
  const arrows = (row) => byTag(walk(row), "button")
  // First row: nothing earlier. Last row: nothing later. Both still focusable.
  assert.equal(arrows(rows[0])[0].props["aria-disabled"], true)
  assert.equal(arrows(rows[0])[0].props.disabled, undefined)
  assert.equal(arrows(rows[0])[1].props["aria-disabled"], undefined)
  assert.equal(arrows(rows[2])[0].props["aria-disabled"], undefined)
  assert.equal(arrows(rows[2])[1].props["aria-disabled"], true)
  control.instance.unmount()
})

test("the greying agrees with moveColumn for every column and direction", () => {
  // The one bug nobody sees in review: the button's rule drifting from the press's rule.
  const preference = { order: ["created", "email", "name"], hidden: ["email"] }
  const control = open(renderControl({ preference }))
  const rows = byTag(nodes(control.instance), "li")
  const resolved = resolveColumnPreference(COLUMNS, preference)
  for (const row of rows) {
    const arrows = byTag(walk(row), "button")
    if (arrows.length === 0) continue
    const key = resolved.order[rows.indexOf(row)]
    for (const [at, direction] of [[0, -1], [1, 1]]) {
      const greyed = arrows[at].props["aria-disabled"] === true
      const refused = moveColumn(COLUMNS, preference, key, direction) === null
      assert.equal(greyed, refused, `${key} ${direction}`)
    }
  }
  control.instance.unmount()
})

test("a move button emits the swap and announces the new position", () => {
  const control = open(renderControl({ columns: PLAIN }))
  const rows = byTag(nodes(control.instance), "li")
  byTag(walk(rows[0]), "button")[1].props.onClick()
  control.instance.rerender()
  assert.deepEqual(control.emitted.at(-1), { order: ["email", "name", "created"], hidden: [] })
  assert.equal(liveRegion(control.instance)?.props.children, "Name moved to position 2 of 3.")
  control.instance.unmount()
})

test("reorderable false leaves the checkboxes and takes the arrows", () => {
  const control = open(renderControl({ reorderable: false }))
  assert.equal(checkboxes(control.instance).length, 3)
  const rows = byTag(nodes(control.instance), "li")
  assert.equal(rows.every((row) => byTag(walk(row), "button").length === 0), true)
  control.instance.unmount()
})

test("show all and reset appear only when they would do something", () => {
  const plain = open(renderControl({ columns: PLAIN }))
  const footerLabels = (control) =>
    byTag(nodes(control.instance), "button")
      .map((node) => (Array.isArray(node.props.children) ? node.props.children.at(-1) : node.props.children))
      .filter((text) => typeof text === "string")
  assert.equal(footerLabels(plain).includes("Show all"), false)
  assert.equal(footerLabels(plain).includes("Reset"), false)
  plain.instance.unmount()

  const hidden = open(renderControl({ columns: PLAIN, preference: { hidden: ["email"] } }))
  assert.equal(footerLabels(hidden).includes("Show all"), true)
  assert.equal(footerLabels(hidden).includes("Reset"), true)
  hidden.instance.unmount()

  // Reordered but nothing hidden: there is an order to reset, and nothing to show.
  const moved = open(renderControl({ columns: PLAIN, preference: { order: ["email", "name", "created"] } }))
  assert.equal(footerLabels(moved).includes("Show all"), false)
  assert.equal(footerLabels(moved).includes("Reset"), true)
  moved.instance.unmount()
})

test("reset emits the empty preference, not a spelled-out copy of the definitions", () => {
  // The empty one keeps resolving to whatever the definitions say next month.
  const control = open(renderControl({ columns: PLAIN, preference: { hidden: ["email"] } }))
  const reset = byTag(nodes(control.instance), "button").find((node) =>
    Array.isArray(node.props.children) ? node.props.children.at(-1) === "Reset" : false
  )
  reset.props.onClick()
  assert.deepEqual(control.emitted.at(-1), { order: [], hidden: [] })
  control.instance.unmount()
})

test("show all emits every column shown, keeping the order", () => {
  const control = open(
    renderControl({ columns: PLAIN, preference: { order: ["created", "email", "name"], hidden: ["email"] } })
  )
  const showAll = byTag(nodes(control.instance), "button").find(
    (node) => node.props.children === "Show all"
  )
  showAll.props.onClick()
  assert.deepEqual(control.emitted.at(-1), { order: ["created", "email", "name"], hidden: [] })
  control.instance.unmount()
})

test("every icon is hidden from assistive tech", () => {
  const control = open(renderControl({ preference: { hidden: ["email"] } }))
  const icons = nodes(control.instance).filter((node) => node.props?.["data-icon"])
  assert.ok(icons.length >= 4)
  for (const node of icons) assert.equal(node.props["aria-hidden"], "true", node.props["data-icon"])
  control.instance.unmount()
})

test("Escape closes the panel", () => {
  const control = open(renderControl())
  const root = control.instance.tree
  let prevented = false
  root.props.onKeyDown({ key: "Escape", preventDefault: () => (prevented = true) })
  control.instance.rerender()
  assert.equal(prevented, true)
  assert.equal(checkboxes(control.instance).length, 0)
  control.instance.unmount()
})

test("focus leaving the panel closes it, but losing the window does not", () => {
  const control = open(renderControl())
  control.instance.tree.props.onBlur({ relatedTarget: null })
  control.instance.rerender()
  assert.equal(checkboxes(control.instance).length, 3, "closed when the window lost focus")

  control.instance.tree.props.onBlur({ relatedTarget: {} })
  control.instance.rerender()
  assert.equal(checkboxes(control.instance).length, 0)
  control.instance.unmount()
})

test("the outside-press listener is registered in capture and removed with the flag", () => {
  const before = pointerListeners.length
  const control = open(renderControl())
  assert.equal(pointerListeners.length, before + 1)
  assert.equal(Boolean(pointerListeners.at(-1).capture), true)
  control.instance.unmount()
  assert.equal(pointerListeners.length, before)
})

test("a disabled trigger does not open", () => {
  const control = renderControl({ disabled: true })
  assert.equal(trigger(control.instance).props["aria-disabled"], true)
  trigger(control.instance).props.onClick()
  control.instance.rerender()
  assert.equal(checkboxes(control.instance).length, 0)
  control.instance.unmount()
})

test("announce false keeps the live region empty", () => {
  const control = open(renderControl({ columns: PLAIN, announce: false }))
  checkboxes(control.instance)[1].props.onChange({ target: { checked: false } })
  control.instance.rerender()
  assert.equal(liveRegion(control.instance)?.props.children, "")
  control.instance.unmount()
})

test("labels can be replaced one at a time", () => {
  const control = open(
    renderControl({
      columns: PLAIN,
      labels: { heading: "列", concealed: (label) => `${label} を隠した` },
    })
  )
  const heading = nodes(control.instance).find((node) => node.props?.children === "列")
  assert.ok(heading, "the heading was not replaced")
  checkboxes(control.instance)[1].props.onChange({ target: { checked: false } })
  control.instance.rerender()
  assert.equal(liveRegion(control.instance)?.props.children, "Email を隠した")
  control.instance.unmount()
})

test("every button says type=button, and every box is a real checkbox", () => {
  // A button inside a form without `type="button"` submits the form — and a table's toolbar is
  // inside a form more often than anyone expects, because the search box is one.
  const control = open(renderControl({ preference: { hidden: ["email"] } }))
  const buttons = byTag(nodes(control.instance), "button")
  assert.ok(buttons.length >= 8, `only ${buttons.length} buttons`)
  for (const button of buttons) assert.equal(button.props.type, "button")
  for (const box of checkboxes(control.instance)) assert.equal(box.props.type, "checkbox")
  control.instance.unmount()
})

test("the first arrow is up and earlier, the second is down and later", () => {
  const control = open(renderControl({ columns: PLAIN }))
  const row = byTag(nodes(control.instance), "li")[1]
  const arrows = byTag(walk(row), "button")
  const iconOf = (button) => walk(button).find((node) => node.props?.["data-icon"])?.props["data-icon"]
  assert.equal(arrows[0].props["aria-label"], defaultColumnVisibilityLabels.moveUp("Email"))
  assert.equal(iconOf(arrows[0]), "arrow-up")
  assert.equal(arrows[1].props["aria-label"], defaultColumnVisibilityLabels.moveDown("Email"))
  assert.equal(iconOf(arrows[1]), "arrow-down")
  // And they move in the directions they are named for.
  arrows[0].props.onClick()
  assert.deepEqual(control.emitted.at(-1).order, ["email", "name", "created"])
  control.instance.unmount()
})

test("the panel hangs from the end by default, and from the start when asked", () => {
  const panelOf = (control) => nodes(control.instance).find((node) => node.props?.role === "group")
  const byDefault = open(renderControl())
  assert.match(panelOf(byDefault).props.className, /(^|\s)right-0(\s|$)/)
  byDefault.instance.unmount()

  const start = open(renderControl({ align: "start" }))
  assert.match(panelOf(start).props.className, /(^|\s)left-0(\s|$)/)
  start.instance.unmount()
})

test("an outside press closes the panel", () => {
  const control = open(renderControl())
  const listener = pointerListeners.at(-1)
  listener.handler({ target: {} })
  control.instance.rerender()
  assert.equal(checkboxes(control.instance).length, 0)
  control.instance.unmount()
})

test("a key that is not Escape leaves the panel open", () => {
  // Written as `key === "Escape" || open`, every keystroke closes it — including the Space that was
  // meant for the checkbox under the cursor.
  const control = open(renderControl())
  let prevented = false
  control.instance.tree.props.onKeyDown({ key: " ", preventDefault: () => (prevented = true) })
  control.instance.rerender()
  assert.equal(prevented, false)
  assert.equal(checkboxes(control.instance).length, 3)
  control.instance.unmount()
})

test("Escape puts focus back on the trigger", () => {
  // Closing the panel without it drops focus to the body: the next Tab starts from the top of the
  // page, and a screen reader is left on nothing.
  const control = open(renderControl())
  control.instance.tree.props.onKeyDown({ key: "Escape", preventDefault: () => {} })
  control.instance.rerender()
  const focused = control.instance.nodes.filter((node) =>
    node.calls.some((call) => call.name === "focus")
  )
  assert.equal(focused.length, 1, "nothing was focused after Escape")
  control.instance.unmount()
})

test("an outside press does not drag focus back to the trigger", () => {
  // The press landed on something else, which is now taking focus itself; pulling it back here is
  // how a click into the search box next to the table ends up typing nowhere.
  const control = open(renderControl())
  pointerListeners.at(-1).handler({ target: {} })
  control.instance.rerender()
  const focused = control.instance.nodes.filter((node) =>
    node.calls.some((call) => call.name === "focus")
  )
  assert.deepEqual(focused, [])
  control.instance.unmount()
})

test("the footer is absent entirely when it would hold nothing", () => {
  // Rendered unconditionally it is an empty strip with a top border across the bottom of the panel.
  const control = open(renderControl({ columns: PLAIN }))
  const panel = nodes(control.instance).find((node) => node.props?.role === "group")
  const bordered = walk(panel).filter((node) => node.props?.className?.includes("border-t"))
  assert.deepEqual(bordered, [])
  control.instance.unmount()
})

test("the default labels are exactly these words", () => {
  // Pinned as a set rather than compared against themselves: a test that reads the label it is
  // checking out of the same object cannot see the copy change.
  assert.equal(defaultColumnVisibilityLabels.triggerText, "Columns")
  assert.equal(defaultColumnVisibilityLabels.heading, "Columns")
  assert.equal(defaultColumnVisibilityLabels.locked, "Always shown")
  assert.equal(defaultColumnVisibilityLabels.showAll, "Show all")
  assert.equal(defaultColumnVisibilityLabels.reset, "Reset")
  assert.equal(defaultColumnVisibilityLabels.trigger(3, 5), "Columns, 3 of 5 shown")
  assert.equal(defaultColumnVisibilityLabels.minimum(1), "At least one column has to stay visible.")
  assert.equal(defaultColumnVisibilityLabels.minimum(2), "At least 2 columns have to stay visible.")
  assert.equal(defaultColumnVisibilityLabels.moveUp("Name"), "Move Name earlier")
  assert.equal(defaultColumnVisibilityLabels.moveDown("Name"), "Move Name later")
})

test("everything that takes focus shows a focus-visible ring", () => {
  // Including the checkbox: the browser's own outline is the one thing a custom `accent-color` box
  // can lose on some platforms, and a keyboard user walking the panel then has no cursor at all.
  const control = open(renderControl({ preference: { hidden: ["email"] } }))
  const focusable = [
    ...byTag(nodes(control.instance), "button"),
    ...checkboxes(control.instance),
  ]
  for (const node of focusable) {
    assert.match(String(node.props.className), /focus-visible:ring/, String(node.props["aria-label"] ?? node.props.type))
  }
  control.instance.unmount()
})

test("theme-aware classes only, no hardcoded colours", () => {
  const control = open(renderControl())
  for (const node of nodes(control.instance)) {
    const className = node.props?.className
    if (typeof className !== "string") continue
    assert.doesNotMatch(className, /#[0-9a-fA-F]{3,8}\b/, className)
    assert.doesNotMatch(className, /\b(?:bg|text|border)-(?:white|black|gray|slate|zinc)-/, className)
  }
  control.instance.unmount()
})
