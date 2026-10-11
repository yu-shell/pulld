// The split button everyone writes first is two `<button>`s in a flex row with a `useState(false)`
// and a panel under the arrow. It looks finished in a screenshot and it is wrong in ways that only
// a keyboard or a screen reader can see. The cases below are written to fail against it:
//
//   - an arrow with no accessible name, or a generic one, so two split buttons in a toolbar are
//     "button" and "button",
//   - an arrow that inherits `type="submit"` from the form it is sitting in and posts it,
//   - Down on the default action opening the menu but leaving focus behind it, so the next Down
//     does nothing — and the near-miss where focus goes to the arrow and the first item is skipped,
//   - Escape, Tab and choosing an item unmounting the menu while it still holds focus, which drops
//     focus to `<body>`,
//   - focus restored to the arrow when it was the default action that opened the menu,
//   - arrow keys that clamp at the ends, the listbox rule, which makes a three-item menu a dead end,
//   - a disabled item given the `disabled` attribute, which takes it out of the focus order so the
//     walk goes 1, 2, 4 and the item appears not to exist,
//   - `aria-controls` pointing at a menu that is not rendered,
//   - `disabled` taking the variants down with the default action,
//   - and a seam inherited from a button group, which draws no divider at all between two filled
//     halves.
//
// What the harness can see of focus is the call, not the caret: "the menu asked this node to take
// focus" is asserted here, and whether the browser honoured it belongs to a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { nextMenuIndex, defaultSplitButtonLabels, SplitButton } = loadComponent(
  join(ROOT, "registry", "ui", "split-button.tsx"),
  {
    stubs: {
      "lucide-react": {
        ChevronDown: function ChevronDown(props) {
          return { type: "svg", props: { "data-icon": "chevron", ...props } }
        },
      },
    },
  }
)

// The harness runs effects the way a commit would, so the globals those effects reach for have to
// exist. The pointerdown listener is captured rather than swallowed: closing on an outside press —
// and *not* taking focus back when that happens — is behaviour worth asserting, and the registration
// is the only handle on it.
const pointerListeners = []
globalThis.document = {
  addEventListener: (type, handler, capture) => {
    if (type === "pointerdown") pointerListeners.push({ handler, capture })
  },
  // Matched on the capture flag as well as the handler, the way the DOM does. A listener added in
  // the capture phase and removed without the flag is never removed at all, and a stub that
  // ignored the flag would report that leak as clean.
  removeEventListener: (type, handler, capture) => {
    const at = pointerListeners.findIndex(
      (entry) => entry.handler === handler && Boolean(entry.capture) === Boolean(capture)
    )
    if (type === "pointerdown" && at >= 0) pointerListeners.splice(at, 1)
  },
}

const ACTIONS = (log = []) => [
  { label: "Save as draft", onSelect: () => log.push("draft") },
  { label: "Save and close", onSelect: () => log.push("close") },
  { label: "Save a copy", onSelect: () => log.push("copy") },
]

/** Everything a test needs to reach in a rendered split button. */
function mount(props = {}) {
  // Cleared per mount, and that is not tidiness. The harness keeps hook state in module-level
  // slots, so only the instance rendered last is live — a handler captured from an earlier instance
  // is still callable, and the `setState` inside it writes into *this* instance's slots. Firing the
  // whole list would then close a menu that no press went anywhere near.
  pointerListeners.length = 0
  const log = []
  const instance = render(SplitButton, {
    label: "Save",
    actions: ACTIONS(log),
    onClick: () => log.push("save"),
    ...props,
  })
  const nodes = () => walk(instance.tree)
  const buttons = () => byTag(nodes(), "button")
  const trigger = () => buttons().find((b) => b.props["aria-haspopup"] === "menu")
  const items = () => byRole(nodes(), "menuitem")
  const api = {
    log,
    instance,
    nodes,
    action: () => buttons()[0],
    trigger,
    menu: () => byRole(nodes(), "menu")[0],
    items,
    labels: () => items().map((i) => textOf(i).trim()),
    tabStops: () => items().map((i) => i.props.tabIndex),
    open() {
      trigger().props.onClick()
      instance.rerender()
      return api
    },
    /** A key pressed on the default action — the half that is not the menu's owner. */
    pressAction(key, extra = {}) {
      let prevented = false
      api.action().props.onKeyDown({
        key,
        preventDefault() {
          prevented = true
        },
        get defaultPrevented() {
          return prevented
        },
        ...extra,
      })
      instance.rerender()
      return prevented
    },
    pressTrigger(key) {
      let prevented = false
      trigger().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    pressMenu(key) {
      let prevented = false
      api.menu().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    choose(index) {
      items()[index].props.onClick()
      instance.rerender()
      return api
    },
    /** The press a person makes somewhere else on the page. */
    pressOutside() {
      for (const entry of [...pointerListeners]) entry.handler({ target: {} })
      instance.rerender()
      return api
    },
    /** Which item position holds the menu's single tab stop. */
    activeIndex: () => api.tabStops().indexOf(0),
    focusCalls: (node) => (node?.props?.ref?.current?.calls ?? []).filter((c) => c.name === "focus"),
    /** Focus calls on the two halves, read off the refs the component attached. */
    actionFocusCalls: () => api.focusCalls(api.action()),
    triggerFocusCalls: () => api.focusCalls(trigger()),
  }
  return api
}

/** The text a person would read out of a node, spaces and all. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object") return textOf(node.props?.children)
  return ""
}

// --- the wrap rule --------------------------------------------------------------------------------

test("an arrow key walks one position at a time", () => {
  assert.equal(nextMenuIndex(3, 0, 1), 1)
  assert.equal(nextMenuIndex(3, 1, 1), 2)
  assert.equal(nextMenuIndex(3, 2, -1), 1)
  assert.equal(nextMenuIndex(3, 1, -1), 0)
})

test("a menu wraps at both ends rather than clamping like the listboxes next to it", () => {
  // country-select and multi-select clamp, which is right for 249 rows. Three items clamped make
  // the last item a key that does nothing, which reads as the keyboard having broken.
  assert.equal(nextMenuIndex(3, 2, 1), 0, "Down on the last item is a dead end")
  assert.equal(nextMenuIndex(3, 0, -1), 2, "Up on the first item is a dead end")
})

test("nothing active yet opens at the top going down and at the bottom going up", () => {
  assert.equal(nextMenuIndex(4, -1, 1), 0)
  assert.equal(nextMenuIndex(4, -1, -1), 3)
})

test("a single-item menu stays where it is in both directions", () => {
  assert.equal(nextMenuIndex(1, 0, 1), 0)
  assert.equal(nextMenuIndex(1, 0, -1), 0)
})

test("an empty menu has no position to move to", () => {
  for (const count of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(nextMenuIndex(count, 0, 1), -1)
  }
})

test("a step of nothing opens at the top rather than at the bottom", () => {
  // `step < 0 ? last : first` and `step <= 0 ? last : first` are the same function for the two keys
  // that exist, and opposites for a caller that passes 0. The top is the answer that matches "no
  // direction given".
  assert.equal(nextMenuIndex(3, -1, 0), 0)
})

test("a fractional or non-finite starting point does not produce a fractional position", () => {
  assert.equal(nextMenuIndex(3, 1.7, 1), 2)
  assert.equal(nextMenuIndex(3, 0, NaN), 0)
  assert.equal(nextMenuIndex(3, Infinity, 1), 0)
})

// --- the two halves -------------------------------------------------------------------------------

test("the arrow's accessible name carries the default action, not a generic 'More options'", () => {
  // A toolbar with Save, Export and Deploy split buttons otherwise announces the same three words
  // three times, and nothing says which arrow is which.
  const ui = mount()
  assert.equal(ui.trigger().props["aria-label"], "More Save options")
  assert.notEqual(ui.trigger().props["aria-label"], "More options")
})

test("the arrow's name can be rewritten for another language", () => {
  const ui = mount({ labels: { more: (label) => `${label}の他の操作` } })
  assert.equal(ui.trigger().props["aria-label"], "Saveの他の操作")
  assert.equal(defaultSplitButtonLabels.more("Deploy"), "More Deploy options")
})

test("the chevron is hidden from screen readers, so the name is not told twice", () => {
  const ui = mount()
  const chevron = walk(ui.trigger()).find((n) => n.props?.["data-icon"] === "chevron")
  assert.equal(chevron.props["aria-hidden"], "true")
})

test("the arrow is type=button even when the default action submits a form", () => {
  // The failure this exists for: a split button inside a <form>, where <button> defaults to submit,
  // so going looking for 'Save as draft' posts the form instead of opening the menu.
  const ui = mount({ type: "submit" })
  assert.equal(ui.action().props.type, "submit")
  assert.equal(ui.trigger().props.type, "button")
})

test("both halves default to type=button", () => {
  const ui = mount()
  assert.equal(ui.action().props.type, "button")
  assert.equal(ui.trigger().props.type, "button")
})

test("the default action's label doubles as its text, and children override it", () => {
  assert.equal(textOf(mount().action()).trim(), "Save")
  const withChildren = mount({ children: "Save changes" })
  assert.equal(textOf(withChildren.action()).trim(), "Save changes")
  assert.equal(withChildren.trigger().props["aria-label"], "More Save options")
})

test("an empty action list renders no arrow at all", () => {
  // An arrow that opens an empty panel is a dead end, and the control is then simply a button.
  const ui = mount({ actions: [] })
  assert.equal(ui.trigger(), undefined)
  assert.equal(byTag(ui.nodes(), "button").length, 1)
})

test("the default action keeps all four corners when there is no arrow beside it", () => {
  assert.ok(!mount({ actions: [] }).action().props.className.includes("rounded-e-none"))
  assert.ok(mount().action().props.className.includes("rounded-e-none"))
})

// --- the seam -------------------------------------------------------------------------------------

test("an outlined pair shares one border line instead of stacking two", () => {
  const ui = mount({ variant: "outline" })
  assert.ok(ui.action().props.className.includes("border-e-0"), "two 1px borders make a 2px line")
  assert.ok(ui.trigger().props.className.includes("border-s"))
})

test("a filled pair draws its own divider, because there is no border to remove", () => {
  // official's button-group removes the inner border with `border-l-0`. Of official's own button
  // variants only `outline` has a border, so on a filled pair that rule removes nothing and the two
  // halves butt together as one unbroken block of colour.
  for (const variant of ["primary", "destructive"]) {
    const seam = mount({ variant }).trigger().props.className
    assert.match(seam, /border-s-\w+-foreground\/\d+/, `${variant} has no visible divider`)
  }
  assert.ok(!mount({ variant: "primary" }).action().props.className.includes("border-e-0"))
})

test("the flat corners are logical, so the unit does not come apart on an RTL page", () => {
  const ui = mount()
  assert.ok(ui.action().props.className.includes("rounded-e-none"))
  assert.ok(ui.trigger().props.className.includes("rounded-s-none"))
  for (const half of [ui.action(), ui.trigger()]) {
    assert.ok(
      !/rounded-[lr]-none/.test(half.props.className),
      "a physical radius keeps the flat corner on the English side when dir=rtl"
    )
  }
})

test("whichever half has focus is lifted, so its ring is not painted over by the other", () => {
  const ui = mount()
  for (const half of [ui.action(), ui.trigger()]) {
    assert.ok(half.props.className.includes("focus-visible:z-10"))
    assert.ok(
      half.props.className.includes("focus-visible:relative"),
      "z-index does nothing on a statically positioned element"
    )
  }
})

test("the menu lines up with the end of the control unless told otherwise", () => {
  // Logical, so "end" is the right edge in English and the left one on an RTL page.
  assert.ok(mount().open().menu().props.className.includes("end-0"))
  const started = mount({ align: "start" }).open()
  assert.ok(started.menu().props.className.includes("start-0"))
  assert.ok(!started.menu().props.className.includes("end-0"))
})

test("the panel carries the state attribute an animation keys off", () => {
  assert.equal(mount().open().menu().props["data-state"], "open")
})

test("the chevron turns over only while the menu is open", () => {
  const ui = mount()
  const chevronOf = (node) => walk(node).find((n) => n.props?.["data-icon"] === "chevron")
  assert.ok(!chevronOf(ui.trigger()).props.className.includes("rotate-180"))
  ui.open()
  assert.ok(chevronOf(ui.trigger()).props.className.includes("rotate-180"))
})

test("the outside listener is registered in the capture phase", () => {
  // So it runs before a focus move inside the menu can rearrange what the press is seen to hit.
  const ui = mount().open()
  assert.equal(pointerListeners.length, 1)
  assert.equal(pointerListeners[0].capture, true)
  ui.instance.unmount()
})

test("a falsy child is still the child", () => {
  // `children ?? label` and `children || label` differ on exactly this, and a count of zero is the
  // ordinary way to reach it.
  assert.equal(textOf(mount({ children: 0 }).action()).trim(), "0")
})

// --- the aria wiring ------------------------------------------------------------------------------

test("the arrow owns the menu, and says so", () => {
  const ui = mount()
  assert.equal(ui.trigger().props["aria-haspopup"], "menu")
  assert.equal(ui.trigger().props["aria-expanded"], false)
  ui.open()
  assert.equal(ui.trigger().props["aria-expanded"], true)
})

test("aria-controls is set only while the menu it names exists", () => {
  // A dangling reference offers a jump that lands nowhere.
  const ui = mount()
  assert.equal(ui.trigger().props["aria-controls"], undefined)
  ui.open()
  assert.equal(ui.trigger().props["aria-controls"], ui.menu().props.id)
})

test("the menu is named by the arrow that opened it", () => {
  const ui = mount().open()
  assert.equal(ui.menu().props["aria-labelledby"], ui.trigger().props.id)
  assert.equal(ui.menu().props.role, "menu")
  assert.equal(ui.items().length, 3)
})

test("every item is a real button with a menuitem role", () => {
  const ui = mount().open()
  for (const item of ui.items()) {
    assert.equal(item.type, "button")
    assert.equal(item.props.type, "button")
    assert.equal(item.props.role, "menuitem")
  }
})

// --- opening from the default action --------------------------------------------------------------

test("Down on the default action opens the menu and lands inside it", () => {
  // The two near-misses this pins down: opening with focus left on the default action, where the
  // next Down does nothing because the menu's keys are handled in the menu; and handing focus to
  // the arrow, where the person's next Down walks into the menu and skips the first item.
  const ui = mount()
  assert.equal(ui.pressAction("ArrowDown"), true, "the page scrolls as well as the menu opening")
  assert.equal(ui.items().length, 3)
  assert.equal(ui.activeIndex(), 0)
  assert.equal(ui.focusCalls(ui.items()[0]).length, 1)
  assert.equal(ui.triggerFocusCalls().length, 0, "focus stopped at the arrow")
})

test("Up on the default action opens the menu at the last item", () => {
  const ui = mount()
  ui.pressAction("ArrowUp")
  assert.equal(ui.activeIndex(), 2)
  assert.equal(ui.focusCalls(ui.items()[2]).length, 1)
})

test("Down on the arrow opens at the first item, Up at the last", () => {
  const down = mount()
  down.pressTrigger("ArrowDown")
  assert.equal(down.activeIndex(), 0)
  const up = mount()
  up.pressTrigger("ArrowUp")
  assert.equal(up.activeIndex(), 2)
})

test("a click on the arrow opens the menu with focus on the first item", () => {
  const ui = mount().open()
  assert.equal(ui.activeIndex(), 0)
  assert.equal(ui.focusCalls(ui.items()[0]).length, 1)
})

test("a second click on the arrow closes the menu and gives it focus back", () => {
  const ui = mount().open()
  ui.trigger().props.onClick()
  ui.instance.rerender()
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 1)
})

test("other keys on the default action are left alone", () => {
  const ui = mount()
  assert.equal(ui.pressAction("Enter"), false)
  assert.equal(ui.menu(), undefined)
})

test("the caller's own onKeyDown still runs, and can keep the menu shut", () => {
  const seen = []
  const ui = mount({
    onKeyDown: (event) => {
      seen.push(event.key)
      event.preventDefault()
    },
  })
  ui.pressAction("ArrowDown")
  assert.deepEqual(seen, ["ArrowDown"])
  assert.equal(ui.menu(), undefined, "a caller who handled the key was overruled")
})

// --- walking the menu -----------------------------------------------------------------------------

test("arrow keys inside the menu move the one tab stop and the focus with it", () => {
  const ui = mount().open()
  assert.deepEqual(ui.tabStops(), [0, -1, -1])
  ui.pressMenu("ArrowDown")
  assert.equal(ui.activeIndex(), 1)
  assert.equal(ui.focusCalls(ui.items()[1]).length, 1)
  ui.pressMenu("ArrowUp")
  assert.equal(ui.activeIndex(), 0)
})

test("the menu wraps in use, not only in the arithmetic", () => {
  const ui = mount().open()
  ui.pressMenu("ArrowUp")
  assert.equal(ui.activeIndex(), 2)
  ui.pressMenu("ArrowDown")
  assert.equal(ui.activeIndex(), 0)
})

test("Home and End jump to the ends", () => {
  const ui = mount().open()
  ui.pressMenu("End")
  assert.equal(ui.activeIndex(), 2)
  ui.pressMenu("Home")
  assert.equal(ui.activeIndex(), 0)
})

test("the menu's arrow keys are prevented, so the page behind it does not scroll", () => {
  const ui = mount().open()
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape"]) {
    assert.equal(ui.pressMenu(key), true, `${key} fell through to the page`)
    if (key !== "Escape") continue
  }
})

test("exactly one item is in the page's tab order at a time", () => {
  const ui = mount().open()
  ui.pressMenu("ArrowDown")
  assert.equal(ui.tabStops().filter((stop) => stop === 0).length, 1)
})

// --- closing --------------------------------------------------------------------------------------

test("Escape closes the menu and returns focus to the arrow that opened it", () => {
  const ui = mount().open()
  ui.pressMenu("Escape")
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 1, "focus was left on a menu that no longer exists")
  assert.equal(ui.actionFocusCalls().length, 0)
})

test("Escape returns focus to the default action when that is what opened the menu", () => {
  // The version that always restores to the arrow moves focus to a button the person never pressed.
  const ui = mount()
  ui.pressAction("ArrowDown")
  ui.pressMenu("Escape")
  assert.equal(ui.actionFocusCalls().length, 1)
  assert.equal(ui.triggerFocusCalls().length, 0)
})

test("Tab closes the menu and puts focus on a live element first", () => {
  // Not prevented — Tab means leave — but the browser computes the next stop from the focused
  // element, and the focused element is about to be removed. From a detached one, Tab starts again
  // at the top of the page.
  const ui = mount().open()
  assert.equal(ui.pressMenu("Tab"), false, "Tab was swallowed")
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 1)
})

test("a press somewhere else closes the menu without taking focus back", () => {
  // The exception to the focus restore: the person has already said where they want to be, and
  // pulling focus onto the arrow would undo whatever they just pressed.
  const ui = mount().open()
  ui.pressOutside()
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 0, "focus was yanked back from what was clicked")
  assert.equal(ui.actionFocusCalls().length, 0)
})

test("a press inside the control is not an outside press", () => {
  const ui = mount().open()
  // The stand-in answers `contains` with false for everything; this is the one test that needs the
  // other answer.
  const root = ui.instance.tree.props.ref.current
  root.contains = () => true
  ui.pressOutside()
  assert.ok(ui.menu(), "pressing the menu's own items would close it")
})

test("the document listener is taken down with the control", () => {
  // Asserted at unmount rather than at close: the harness does not run cleanups between passes (a
  // pass is one commit settling, and tearing down mid-settle would undo the work being settled), so
  // the close path's cleanup is a browser's business. What is checkable here is the leak that
  // matters — a control that has gone away still listening on the document.
  const ui = mount().open()
  assert.equal(pointerListeners.length, 1)
  ui.instance.unmount()
  assert.equal(pointerListeners.length, 0, "a removed control is still listening on the document")
})

test("Escape on the arrow closes a menu that is already open", () => {
  const ui = mount().open()
  ui.pressTrigger("Escape")
  assert.equal(ui.menu(), undefined)
})

test("Escape on the arrow of a closed menu is left to the page", () => {
  // A dialog or a drawer around this is usually listening for it.
  const ui = mount()
  assert.equal(ui.pressTrigger("Escape"), false)
})

// --- choosing -------------------------------------------------------------------------------------

test("choosing an item runs it, closes the menu and restores focus", () => {
  const ui = mount().open()
  ui.choose(1)
  assert.deepEqual(ui.log, ["close"])
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 1)
})

test("focus is restored before the item's own handler runs", () => {
  // A handler that opens a dialog moves focus itself; restoring afterwards would pull focus out
  // from under it.
  const order = []
  const ui = mount({
    actions: [{ label: "Save and close", onSelect: () => order.push("handler") }],
  })
  ui.open()
  const trigger = ui.trigger()
  Object.defineProperty(trigger.props.ref.current, "focusOrder", { value: true })
  const calls = trigger.props.ref.current.calls
  const before = calls.length
  ui.items()[0].props.onClick()
  assert.equal(calls.length, before + 1)
  assert.deepEqual(order, ["handler"])
  assert.ok(
    calls.findIndex((call) => call.name === "focus") >= 0,
    "the opener was never asked to take focus back"
  )
})

test("the default action's own click is untouched by any of this", () => {
  const ui = mount()
  ui.action().props.onClick()
  assert.deepEqual(ui.log, ["save"])
})

// --- unavailable ----------------------------------------------------------------------------------

test("a disabled item is aria-disabled, never disabled, so it keeps its place in the walk", () => {
  // `disabled` removes a button from the focus order: the walk would go 1, 2, 4 and the person
  // learns that the item does not exist rather than that it is unavailable right now.
  const ui = mount({
    actions: [
      { label: "Save as draft", onSelect: () => {} },
      { label: "Save and close", onSelect: () => {}, disabled: true },
      { label: "Save a copy", onSelect: () => {} },
    ],
  }).open()
  const [, blocked] = ui.items()
  assert.equal(blocked.props["aria-disabled"], true)
  assert.equal(blocked.props.disabled, undefined)
  ui.pressMenu("ArrowDown")
  assert.equal(ui.activeIndex(), 1, "the unavailable item was skipped")
  assert.equal(ui.focusCalls(ui.items()[1]).length, 1)
})

test("an available item carries no aria-disabled at all", () => {
  assert.equal(mount().open().items()[0].props["aria-disabled"], undefined)
})

test("choosing a disabled item does nothing and leaves the menu open", () => {
  const log = []
  const ui = mount({
    actions: [{ label: "Save and close", onSelect: () => log.push("close"), disabled: true }],
  }).open()
  ui.choose(0)
  assert.deepEqual(log, [])
  assert.ok(ui.menu(), "the menu closed on a press that did nothing")
})

test("actionDisabled stops the default action and leaves the variants available", () => {
  // The combination the pattern exists for: a form that cannot be saved yet but can be saved as a
  // draft.
  const ui = mount({ actionDisabled: true })
  assert.equal(ui.action().props.disabled, true)
  assert.equal(ui.trigger().props.disabled, false)
  ui.open()
  assert.equal(ui.items().length, 3)
})

test("menuDisabled stops the arrow and leaves the default action pressable", () => {
  const ui = mount({ menuDisabled: true })
  assert.equal(ui.action().props.disabled, false)
  assert.equal(ui.trigger().props.disabled, true)
  ui.trigger().props.onClick()
  ui.instance.rerender()
  assert.equal(ui.menu(), undefined)
})

test("disabled stops both halves", () => {
  const ui = mount({ disabled: true })
  assert.equal(ui.action().props.disabled, true)
  assert.equal(ui.trigger().props.disabled, true)
  assert.equal(ui.pressAction("ArrowDown"), false)
  assert.equal(ui.menu(), undefined)
})

test("a menu open when its arrow becomes unavailable closes itself, without moving focus", () => {
  // Otherwise the panel is left on screen with no way to dismiss it: the arrow no longer answers.
  // Focus stays where it is, because nobody pressed anything — and the arrow it would be handed to
  // is disabled, so a browser would refuse it and focus would end up on `<body>` either way.
  const ui = mount().open()
  assert.ok(ui.menu())
  ui.instance.update({ label: "Save", actions: ACTIONS(), menuDisabled: true })
  assert.equal(ui.menu(), undefined)
  assert.equal(ui.triggerFocusCalls().length, 0)
  assert.equal(ui.actionFocusCalls().length, 0)
})

// --- the list changing underneath -----------------------------------------------------------------

test("the active position is clamped when the list shrinks under an open menu", () => {
  const ui = mount().open()
  ui.pressMenu("End")
  assert.equal(ui.activeIndex(), 2)
  const departed = ui.items()[2]
  assert.equal(ui.focusCalls(departed).length, 1)
  ui.instance.update({ label: "Save", actions: ACTIONS().slice(0, 2) })
  assert.equal(ui.items().length, 2)
  assert.equal(ui.activeIndex(), 1, "the tab stop was left past the end of the menu")
  // The focus effect is declared before the clamp, so an unbounded one asks the position that has
  // just gone away — a focus call into a node no longer in the document.
  assert.equal(ui.focusCalls(departed).length, 1, "focus was sent to the item that was removed")
  assert.equal(ui.focusCalls(ui.items()[1]).length, 1)
})

test("the open menu follows the list it was given", () => {
  const ui = mount().open()
  assert.deepEqual(ui.labels(), ["Save as draft", "Save and close", "Save a copy"])
  ui.instance.update({ label: "Save", actions: [{ label: "Only one", onSelect: () => {} }] })
  assert.deepEqual(ui.labels(), ["Only one"])
})

// --- the caller being told ------------------------------------------------------------------------

test("onOpenChange is told once per change, not twice", () => {
  // Reporting from inside the state updater looks identical until strict mode double-invokes it.
  const seen = []
  const ui = mount({ onOpenChange: (open) => seen.push(open) })
  ui.open()
  assert.deepEqual(seen, [true])
  ui.pressMenu("Escape")
  assert.deepEqual(seen, [true, false])
})

test("an item's icon is decoration and is hidden", () => {
  const ui = mount({
    actions: [{ label: "Save as draft", onSelect: () => {}, icon: { type: "svg", props: {} } }],
  }).open()
  const wrapper = walk(ui.items()[0]).find((n) => n.props?.["aria-hidden"] === "true")
  assert.ok(wrapper, "a decorative icon is announced alongside the label")
})

test("items are keyed by id when the labels repeat", () => {
  const ui = mount({
    actions: [
      { id: "a", label: "Export", onSelect: () => {} },
      { id: "b", label: "Export", onSelect: () => {} },
    ],
  }).open()
  assert.deepEqual(
    ui.items().map((item) => item.key),
    ["a", "b"]
  )
})
