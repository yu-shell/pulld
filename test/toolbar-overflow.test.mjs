// The priority+ toolbar everyone writes first measures its own row, hides what sticks out, and is
// then asked again by its own ResizeObserver — the hidden controls measure zero, so the row fits, so
// they come back, so it overflows. The cases below are written to fail against that version and
// against the near-misses around it:
//
//   - a toolbar that pays for the overflow trigger even when nothing overflows, so a row whose
//     controls fit exactly loses its last one to a button that was never needed,
//   - and the opposite: a trigger added after the decision, so the row overflows by exactly the
//     width of the thing meant to prevent it,
//   - `k` items plus a trigger counted as `k - 1` gaps instead of `k`, which is the same bug one gap
//     wide,
//   - a folded control that was holding the row's only tab stop, so Tab skips the whole toolbar —
//     which happens whether or not anybody has focus there,
//   - the overcorrection: focus pulled to the trigger because a window was resized, taking it from
//     whatever the person was doing elsewhere on the page,
//   - arrow keys that wrap in the row (the menu's rule, in the wrong place) and a horizontal arrow
//     inside the open menu falling through to move the row underneath it,
//   - controls that shrink instead of overflowing, so nothing ever folds and the component silently
//     does nothing,
//   - a row measured while it is inside a closed tab, where everything measures zero and the whole
//     toolbar collapses to a lone trigger and stays that way,
//   - and `aria-disabled` written as `disabled`, which takes a control out of the arrow walk so the
//     walk goes 1, 2, 4 and the control appears not to exist.
//
// What the harness can see of focus is the call, not the caret: "the toolbar asked this node to take
// focus" is asserted here, and whether the browser honoured it belongs to a browser. It has no
// layout either, so the measurement is supplied — `applyLayout` below is the only place widths come
// from, and the arithmetic that consumes them is asserted directly as a function.
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

// The real split-button, loaded rather than stubbed. The overflow menu's wrap rule is imported from
// it, and a stub would turn the one assertion that the composition works into an assertion about the
// copy — the registryDependencies entry would then be decoration.
const splitButton = loadComponent(join(ROOT, "registry", "ui", "split-button.tsx"), {
  stubs: { "lucide-react": { ChevronDown: icon("chevron") } },
})

const {
  TOOLBAR_MORE,
  fitToolbarItems,
  nextToolbarStop,
  rescueToolbarStop,
  defaultToolbarOverflowLabels,
  ToolbarOverflow,
} = loadComponent(join(ROOT, "registry", "ui", "toolbar-overflow.tsx"), {
  stubs: {
    "lucide-react": { MoreHorizontal: icon("more") },
    "@/registry/ui/split-button": splitButton,
  },
})

// The pointerdown registration is the only handle on "closes on an outside press, and does not take
// focus back when it does", so it is captured rather than swallowed.
const pointerListeners = []
globalThis.document = {
  activeElement: null,
  addEventListener: (type, handler, capture) => {
    if (type === "pointerdown") pointerListeners.push({ handler, capture })
  },
  // Matched on the capture flag as well as the handler, the way the DOM does: a listener added in
  // the capture phase and removed without the flag is never removed at all, and a stub that ignored
  // the flag would report that leak as clean.
  removeEventListener: (type, handler, capture) => {
    if (type !== "pointerdown") return
    const at = pointerListeners.findIndex(
      (entry) => entry.handler === handler && Boolean(entry.capture) === Boolean(capture)
    )
    if (at >= 0) pointerListeners.splice(at, 1)
  },
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}

const box = (width) => ({ getBoundingClientRect: () => ({ width }) })

const ITEMS = [
  { label: "Bold", onSelect: () => {} },
  { label: "Italic", onSelect: () => {} },
  { label: "Link", onSelect: () => {} },
  { label: "Quote", onSelect: () => {} },
]

function ui(props = {}, options = {}) {
  pointerListeners.length = 0
  const instance = render(
    ToolbarOverflow,
    { label: "Formatting", items: ITEMS, ...props },
    options
  )
  const api = {
    instance,
    get tree() {
      return instance.tree
    },
    /** The outer positioning box — what the menu hangs off. */
    root: () => instance.tree.props.ref.current,
    /** The toolbar itself: the element that clips, measures and carries role="toolbar". */
    rowEl: () => byRole(walk(instance.tree), "toolbar")[0],
    rowNode: () => api.rowEl()?.props?.ref?.current,
    probe: () =>
      walk(instance.tree).find((n) => n.props?.style?.position === "absolute"),
    probeNode: () => api.probe()?.props?.ref?.current,
    /** Every button the person can reach in the row — the controls and, if there is one, the trigger. */
    rowControls: () =>
      byTag(walk(instance.tree), "button").filter(
        (b) => !b.props["aria-hidden"] && b.props.role !== "menuitem"
      ),
    trigger: () =>
      byTag(walk(instance.tree), "button").find(
        (b) => b.props["aria-haspopup"] === "menu" && !b.props["aria-hidden"]
      ),
    rowItems: () => api.rowControls().filter((b) => b.props["aria-haspopup"] !== "menu"),
    probeControls: () =>
      byTag(walk(instance.tree), "button").filter((b) => b.props["aria-hidden"] === "true"),
    menu: () => byRole(walk(instance.tree), "menu")[0],
    menuItems: () => byRole(walk(instance.tree), "menuitem"),
    /** The one position in the row holding tabIndex 0, with the trigger counted as the last stop. */
    tabStop: () => api.rowControls().findIndex((b) => b.props.tabIndex === 0),
    tabStops: () => api.rowControls().map((b) => b.props.tabIndex),
    focusCalls: (node) => (node?.props?.ref?.current?.calls ?? []).filter((c) => c.name === "focus"),
    pressRow(key) {
      let prevented = false
      api.rowEl().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    pressTrigger(key) {
      let prevented = false
      api.trigger().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    pressMenu(key) {
      let prevented = false
      api.menu().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    openMenu() {
      api.trigger().props.onClick()
      instance.rerender()
      return api
    },
    pressOutside() {
      for (const entry of [...pointerListeners]) entry.handler({ target: {} })
      instance.rerender()
      return api
    },
  }
  return api
}

/**
 * Hands the component a layout, which the harness otherwise has none of.
 *
 * The widths go on the probe, which is where the component reads them, and the container width on
 * the root. `getComputedStyle` is replaced rather than extended because `render` installs its own
 * (answering `direction` alone) at the start of every pass, and the direction has to survive.
 */
function applyLayout(
  api,
  {
    available,
    gap = 0,
    widths,
    moreWidth = 20,
    direction = "ltr",
    padding = 0,
    paddingLeft = padding,
    paddingRight = padding,
  }
) {
  const row = api.rowNode()
  const probe = api.probeNode()
  row.clientWidth = available
  probe.children = [...widths.map(box), box(moreWidth)]
  // Answers per node rather than globally, so a test can give the row a direction the outer box does
  // not have — which is what `dir="rtl"` passed to this component actually does, since `...props`
  // land on the row.
  const rowDirection = api.rowDirection ?? direction
  globalThis.getComputedStyle = (node) => ({
    direction: node === row ? rowDirection : direction,
    paddingLeft: `${paddingLeft}px`,
    paddingRight: `${paddingRight}px`,
    columnGap: `${gap}px`,
  })
  api.instance.rerender()
  return api
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object") return textOf(node.props?.children)
  return ""
}

// --- the arithmetic ------------------------------------------------------------------------------

test("everything fits, so nothing is charged for a trigger that is not there", () => {
  // The row is exactly full. Charging for the trigger here folds the last control to make room for a
  // button whose only job would have been to hold it.
  assert.equal(fitToolbarItems([30, 30, 30], 90, 0, 20), 3)
})

test("one pixel too many folds, and the trigger is paid for from that moment", () => {
  // 3 items need 91 and there are 90. With the trigger at 20 the budget for controls is 70, so two
  // fit (60) and the third does not.
  assert.equal(fitToolbarItems([30, 30, 31], 90, 0, 20), 2)
})

test("a trigger charged only after the row overflows is the whole difference between two answers", () => {
  const widths = [40, 40]
  assert.equal(fitToolbarItems(widths, 80, 0, 30), 2, "fits exactly: no trigger, both stay")
  assert.equal(fitToolbarItems(widths, 79, 0, 30), 1, "one short: trigger appears and takes 30")
})

test("k controls beside a trigger have k gaps, not k minus one", () => {
  // Three 20s with a gap of 10 need 80 and there are 75, so something folds. One control plus the
  // trigger is 20 + 10 + 20 = 50; two is 20 + 10 + 20 + 10 + 20 = 80, which does not fit in 75.
  // Counting one gap fewer makes that 70 and wrongly keeps two.
  assert.equal(fitToolbarItems([20, 20, 20], 75, 10, 20), 1)
})

test("the gap in front of the trigger is counted even for a single control", () => {
  // One control (20) plus the gap in front of the trigger (10) plus the trigger (20) is 50, so one
  // control survives at 55 and none at 49. An implementation that counts the gaps *between*
  // controls and forgets the one before the trigger makes that 40 and wrongly keeps a control at 49.
  assert.equal(fitToolbarItems([20, 30], 55, 10, 20), 1)
  assert.equal(fitToolbarItems([20, 30], 49, 10, 20), 0)
  // Two controls and one gap is also 50, which is why a row at exactly 50 keeps both and needs no
  // trigger: one control plus a trigger is never cheaper than two controls here.
  assert.equal(fitToolbarItems([20, 20], 50, 10, 20), 2)
})

test("a row too narrow for anything keeps the trigger alone", () => {
  assert.equal(fitToolbarItems([50, 50], 10, 0, 20), 0)
})

test("an overflowing row never reports every control as visible", () => {
  // Returning the full count while a trigger is rendered is the state that cannot be drawn: the row
  // would be charged for a button it says it does not need.
  for (let available = 0; available < 200; available++) {
    const kept = fitToolbarItems([30, 40, 50], available, 6, 24)
    const fits = 30 + 40 + 50 + 6 * 2 <= available + 0.5
    if (!fits) assert.ok(kept < 3, `kept ${kept} of 3 at ${available}px without room for all`)
  }
})

test("half a pixel of overflow is not overflow", () => {
  // Fractional element widths are ordinary; a row that fills its box exactly can report a few
  // hundredths over. Shaving a control for that is the bug the tolerance exists for.
  assert.equal(fitToolbarItems([30.2, 30.2, 30.2], 90.3, 0, 20), 3)
  // And the slack stays well under a pixel, so a control that genuinely does not fit still folds.
  assert.equal(fitToolbarItems([30, 30, 31], 90.4, 0, 20), 2)
})

test("more room never shows fewer controls", () => {
  // The property that makes a resize feel like a resize. A fold rule that is not monotonic flickers
  // under a drag even when every individual answer looks reasonable.
  const widths = [17, 44, 9, 61, 23, 38]
  let last = -1
  for (let available = 0; available <= 400; available += 1) {
    const kept = fitToolbarItems(widths, available, 7, 26)
    assert.ok(kept >= last, `${kept} at ${available}px after ${last} at ${available - 1}px`)
    last = kept
  }
})

test("no controls at all is no controls, not a crash", () => {
  assert.equal(fitToolbarItems([], 100, 4, 20), 0)
})

test("a measurement that never happened degrades to zero rather than to NaN", () => {
  // Every one of these arrives from a getBoundingClientRect or a parseFloat, and a NaN here would
  // make every comparison false and silently keep the whole row.
  assert.equal(fitToolbarItems([30, 30], NaN, 0, 20), 0)
  assert.equal(fitToolbarItems([30, 30], -100, 0, 20), 0)
  assert.equal(fitToolbarItems([NaN, NaN], 100, 0, 20), 2, "zero-width controls all fit")
  assert.equal(fitToolbarItems([30, 30, 30], 70, NaN, 20), 1, "a gap of NaN is no gap")
  assert.equal(fitToolbarItems([30, 30, 30], 70, 0, NaN), 2, "a trigger of NaN costs nothing")
})

// --- the row's keyboard -------------------------------------------------------------------------

test("a horizontal arrow walks one control at a time", () => {
  assert.equal(nextToolbarStop(4, false, 0, 1), 1)
  assert.equal(nextToolbarStop(4, false, 2, 1), 3)
  assert.equal(nextToolbarStop(4, false, 2, -1), 1)
})

test("the row clamps at both ends where the menu under it wraps", () => {
  assert.equal(nextToolbarStop(3, false, 2, 1), 2, "Right on the last control stays")
  assert.equal(nextToolbarStop(3, false, 0, -1), 0, "Left on the first control stays")
  // The contrast, and the composition: the menu's rule is split-button's own function, imported.
  assert.equal(splitButton.nextMenuIndex(3, 2, 1), 0)
  assert.equal(splitButton.nextMenuIndex(3, 0, -1), 2)
})

test("the trigger is the stop after the last visible control, in both directions", () => {
  assert.equal(nextToolbarStop(2, true, 1, 1), TOOLBAR_MORE)
  assert.equal(nextToolbarStop(2, true, TOOLBAR_MORE, -1), 1)
  assert.equal(nextToolbarStop(2, true, TOOLBAR_MORE, 1), TOOLBAR_MORE, "and it is the end")
})

test("End is the trigger when there is one and the last control when there is not", () => {
  assert.equal(nextToolbarStop(2, true, TOOLBAR_MORE, 0), TOOLBAR_MORE)
  assert.equal(nextToolbarStop(4, false, TOOLBAR_MORE, 0), 3)
})

test("Home is the first control, or the trigger when the row holds none", () => {
  assert.equal(nextToolbarStop(4, false, 0, 0), 0)
  assert.equal(nextToolbarStop(0, true, 0, 0), TOOLBAR_MORE)
})

test("a stop that no longer exists is clamped rather than trusted", () => {
  // `active` is state and the row re-measures underneath it, so a position past the end is ordinary.
  assert.equal(nextToolbarStop(2, true, 9, 1), TOOLBAR_MORE)
  assert.equal(nextToolbarStop(2, false, 9, 0), 1)
  assert.equal(nextToolbarStop(NaN, false, 0, 1), TOOLBAR_MORE, "no stops at all")
  assert.equal(nextToolbarStop(3, false, NaN, 1), 1)
})

// --- the tab stop -------------------------------------------------------------------------------

test("a stop on a control that is still in the row is left alone", () => {
  assert.equal(rescueToolbarStop(1, 3, 4), 1)
  assert.equal(rescueToolbarStop(0, 4, 4), 0)
})

test("a stop on a folded control moves to the trigger", () => {
  // Otherwise no element in the row carries tabIndex 0 and Tab skips the whole toolbar.
  assert.equal(rescueToolbarStop(3, 2, 4), TOOLBAR_MORE)
  assert.equal(rescueToolbarStop(2, 2, 4), TOOLBAR_MORE, "the first folded position counts as folded")
})

test("a stop on a trigger that has gone moves to the last control in the row", () => {
  assert.equal(rescueToolbarStop(TOOLBAR_MORE, 4, 4), 3)
  assert.equal(rescueToolbarStop(TOOLBAR_MORE, 2, 4), TOOLBAR_MORE, "still folded: the trigger stays")
})

test("an empty toolbar has no control to rescue", () => {
  assert.equal(rescueToolbarStop(0, 0, 0), TOOLBAR_MORE)
})

// --- the shape it renders -----------------------------------------------------------------------

test("it is a named toolbar, and says which way its arrows go", () => {
  const api = ui()
  const row = api.rowEl()
  assert.equal(row.props["aria-label"], "Formatting")
  assert.equal(row.props["aria-orientation"], "horizontal")
  assert.equal(api.tree.props.role, undefined, "the outer box is a wrapper, not a second toolbar")
  assert.equal(byRole(walk(api.tree), "toolbar").length, 1)
})

test("no controls renders nothing at all", () => {
  // A toolbar with an empty row is not an empty toolbar to announce; it is nothing.
  assert.equal(render(ToolbarOverflow, { label: "Formatting", items: [] }).tree, null)
})

test("before anything has been measured the whole row is there and no trigger is", () => {
  // The server cannot measure and the first client render has to match it. A trigger rendered here
  // would be a button that opens an empty menu.
  const api = ui()
  assert.equal(api.rowItems().length, 4)
  assert.equal(api.trigger(), undefined)
})

test("the row cannot be widened by what is in it", () => {
  // Together these are what stops the measurement feeding back into itself: the width comes from
  // the parent, and a row one pixel too wide is clipped rather than pushing the container out.
  const classes = ui().rowEl().props.className
  assert.match(classes, /\bw-full\b/)
  assert.match(classes, /\boverflow-hidden\b/)
  assert.match(classes, /\brelative\b/, "the probe is positioned against the row")
  assert.match(classes, /\bp-1\b/, "and padding, so a focus ring is not cut off by that clipping")
})

test("the menu hangs off a box that does not clip, and the row is the one that does", () => {
  // Measured in Chrome rather than reasoned about: a panel at `top-full` inside its own clipping
  // containing block is painted only where the two overlap, which for this panel is nowhere.
  const api = folded()
  api.openMenu()
  const outer = api.tree
  assert.match(outer.props.className, /\brelative\b/, "the menu's containing block")
  assert.doesNotMatch(outer.props.className, /\boverflow-hidden\b/, "and it must not clip")
  const children = outer.props.children.flat().filter(Boolean)
  assert.equal(children[0], api.rowEl(), "the row comes first")
  assert.equal(
    children.includes(api.menu()),
    true,
    "and the menu is its sibling rather than inside it"
  )
  assert.equal(
    walk(api.rowEl()).includes(api.menu()),
    false,
    "nothing of the menu is inside the clipping row"
  )
  // The probe is the opposite case: it stays inside the clipping row, because an out-of-flow element
  // still contributes scrollable overflow and being clipped is what keeps the page from scrolling.
  assert.equal(walk(api.rowEl()).includes(api.probe()), true)
})

test("a caller's className lands on the toolbar row", () => {
  // Which is also where the gap is read from, so `gap-2` in className and the arithmetic cannot
  // disagree.
  const api = ui({ className: "gap-2 border" })
  assert.match(api.rowEl().props.className, /\bgap-2\b/)
  assert.match(api.rowEl().props.className, /\bborder\b/)
})

test("a control may not shrink", () => {
  // The class is the behaviour here. A flex item that may shrink does, so without this the browser
  // squeezes the controls into slivers, the row never overflows, and nothing ever folds.
  for (const control of ui().rowControls()) {
    assert.match(control.props.className, /\bshrink-0\b/)
  }
})

test("the measuring copy carries every control and the trigger, and is not an interface", () => {
  const api = ui()
  const probed = api.probeControls()
  assert.equal(probed.length, ITEMS.length + 1, "four controls and the trigger")
  for (const node of probed) {
    assert.equal(node.props["aria-hidden"], "true", "not announced")
    assert.equal(node.props.tabIndex, -1, "not in the tab order")
    assert.equal(node.props.onClick, undefined, "inert to a press")
    assert.equal(node.props.type, "button", "and never a submit inside a form")
  }
  const style = api.probe().props.style
  assert.equal(style.position, "absolute", "takes part in no layout")
  assert.equal(style.visibility, "hidden", "and is still measurable, which display:none is not")
})

test("the measuring copy is the same element type as the control it stands for", () => {
  // A UA stylesheet gives `button` its own font, padding and border. Measuring a `span` instead is a
  // width taken from a different box, which is worse than no measurement.
  for (const node of ui().probeControls()) assert.equal(node.type, "button")
})

// --- folding ------------------------------------------------------------------------------------

test("a row too narrow folds its tail and grows a trigger", () => {
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  // 120 needed, 100 available, so the trigger is charged: 80 for controls, two fit.
  assert.deepEqual(api.rowItems().map((b) => textOf(b)), ["Bold", "Italic"])
  assert.ok(api.trigger(), "and the trigger is there")
})

test("what folded is what the menu holds, in the order it was in", () => {
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  assert.deepEqual(api.menuItems().map((b) => textOf(b)), ["Link", "Quote"])
})

test("the gap comes from the row's own styles, so a gap utility is honoured", () => {
  // Spacing is said once, in className, rather than twice — once there and once as a prop that can
  // disagree with it.
  const narrow = ui()
  applyLayout(narrow, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(narrow.rowItems().length, 2)
  const spaced = ui()
  applyLayout(spaced, { available: 100, gap: 12, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(spaced.rowItems().length, 1, "the same widths fold further once the gaps are real")
})

test("padding on either side is not room for a control", () => {
  // clientWidth is content plus padding, so a caller adding `pl-8` to the row would otherwise have it
  // measured against a box wider than the one the controls have to fit in. Asserted one side at a
  // time and asymmetrically on purpose: with the same value on both, dropping either one alone still
  // leaves enough off the total that the answer does not move, and the test passes for the wrong
  // reason.
  const bare = ui()
  applyLayout(bare, { available: 140, padding: 0, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(bare.rowItems().length, 4, "140 holds all four 30s with no trigger needed")
  const left = ui()
  applyLayout(left, {
    available: 140,
    paddingLeft: 30,
    gap: 0,
    widths: [30, 30, 30, 30],
    moreWidth: 20,
  })
  assert.equal(left.rowItems().length, 3, "110 of content holds three and the trigger")
  const right = ui()
  applyLayout(right, {
    available: 140,
    paddingRight: 30,
    gap: 0,
    widths: [30, 30, 30, 30],
    moreWidth: 20,
  })
  assert.equal(right.rowItems().length, 3)
})

test("a row that measures zero keeps the answer it had", () => {
  // Inside a closed tab, an unopened dialog or a collapsed accordion everything measures zero, which
  // is not "nothing fits". Folding to a lone trigger there and staying that way once shown is the
  // failure this guards.
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.rowItems().length, 2)
  applyLayout(api, { available: 0, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.rowItems().length, 2, "unchanged rather than collapsed")
})

test("the row widening gives the controls back and takes the trigger away", () => {
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.ok(api.trigger())
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.rowItems().length, 4)
  assert.equal(api.trigger(), undefined)
})

test("how many controls are in the row is reported once per change", () => {
  const seen = []
  const api = ui({ onVisibleCountChange: (n) => seen.push(n) })
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.instance.rerender()
  api.instance.rerender()
  assert.deepEqual(seen, [2], "not once per render")
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.deepEqual(seen, [2, 4])
})

// --- the roving tab stop ------------------------------------------------------------------------

test("the row is one tab stop, wherever the fold happens to be", () => {
  const api = ui()
  assert.deepEqual(api.tabStops(), [0, -1, -1, -1])
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.tabStops().filter((t) => t === 0).length, 1)
  applyLayout(api, { available: 10, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.tabStops().filter((t) => t === 0).length, 1, "even with nothing but the trigger")
})

test("a control folded away hands its tab stop to the trigger", () => {
  // The failure with no visible symptom: with the stop on a control that is now in the menu, no
  // element in the row has tabIndex 0 and Tab skips the toolbar entirely.
  const api = ui()
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.rowItems()[3].props.onFocus()
  api.instance.rerender()
  assert.equal(api.tabStop(), 3)
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  const controls = api.rowControls()
  assert.equal(controls[controls.length - 1].props["aria-haspopup"], "menu")
  assert.equal(api.tabStop(), controls.length - 1, "the trigger holds it")
})

test("a resize does not take focus from somewhere else on the page", () => {
  // The tab stop moves whether or not anybody is here; focus is only *called* when focus was already
  // inside. A window being dragged narrower is not a reason to pull it out of a text field.
  const api = ui()
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.rowItems()[3].props.onFocus()
  api.instance.rerender()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.focusCalls(api.trigger()).length, 0, "nothing was focused")
})

test("a control folded while it holds focus moves focus to the trigger", () => {
  const api = ui()
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.rowItems()[3].props.onFocus()
  api.instance.rerender()
  // Focus is in the row now: the row, specifically, contains the active element. Asked of the row
  // rather than the outer box so that focus sitting in an open menu does not count as being here.
  api.rowNode().contains = () => true
  globalThis.document.activeElement = {}
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.focusCalls(api.trigger()).length, 1)
  globalThis.document.activeElement = null
})

test("the trigger going away hands its tab stop back to the last control", () => {
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.trigger().props.onFocus()
  api.instance.rerender()
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.tabStop(), 3, "the position the trigger occupied")
})

test("arrow keys move the stop and ask the control to take focus", () => {
  const api = ui()
  assert.ok(api.pressRow("ArrowRight"), "prevented, so a scroll container does not scroll too")
  assert.equal(api.tabStop(), 1)
  assert.equal(api.focusCalls(api.rowItems()[1]).length, 1)
  api.pressRow("ArrowLeft")
  assert.equal(api.tabStop(), 0)
})

test("Right and Left swap on a right-to-left page", () => {
  const api = ui({}, { direction: "rtl" })
  applyLayout(api, {
    available: 400,
    gap: 0,
    widths: [30, 30, 30, 30],
    moreWidth: 20,
    direction: "rtl",
  })
  api.pressRow("ArrowLeft")
  assert.equal(api.tabStop(), 1, "Left is forward when the row runs the other way")
  api.pressRow("ArrowRight")
  assert.equal(api.tabStop(), 0)
})

test("Home and End reach the ends of the row, trigger included", () => {
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.ok(api.pressRow("End"))
  assert.equal(api.tabStop(), api.rowControls().length - 1)
  assert.equal(api.focusCalls(api.trigger()).length, 1)
  assert.ok(api.pressRow("Home"))
  assert.equal(api.tabStop(), 0)
})

// --- the trigger and its menu -------------------------------------------------------------------

function folded(extra = {}) {
  const api = ui(extra)
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  return api
}

test("the trigger says what it opens, and only while it is open", () => {
  const api = folded()
  assert.equal(api.trigger().props["aria-haspopup"], "menu")
  assert.equal(api.trigger().props["aria-expanded"], false)
  assert.equal(api.trigger().props["aria-controls"], undefined, "nothing to point at yet")
  api.openMenu()
  assert.equal(api.trigger().props["aria-expanded"], true)
  assert.equal(api.trigger().props["aria-controls"], api.menu().props.id)
  assert.equal(api.menu().props["aria-labelledby"], api.trigger().props.id, "named by its trigger")
})

test("the trigger's name carries the count and the toolbar it belongs to", () => {
  // Two toolbars on a page both announcing "More" tell a screen-reader user only that there are two
  // of something.
  assert.equal(folded().trigger().props["aria-label"], "2 more Formatting actions")
  assert.equal(defaultToolbarOverflowLabels.more(3, "Table"), "3 more Table actions")
  const api = ui({ labels: { more: (n) => `さらに ${n} 件` } })
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.trigger().props["aria-label"], "さらに 2 件")
})

test("Down on the trigger opens the menu at its first item and Up at its last", () => {
  const down = folded()
  assert.ok(down.pressTrigger("ArrowDown"), "prevented: the page must not scroll, and the row must not move")
  assert.equal(down.menuItems().findIndex((b) => b.props.tabIndex === 0), 0)
  const up = folded()
  up.pressTrigger("ArrowUp")
  assert.equal(up.menuItems().findIndex((b) => b.props.tabIndex === 0), 1)
})

test("the menu's arrows wrap, which is split-button's rule and not the row's", () => {
  const api = folded()
  api.pressTrigger("ArrowDown")
  assert.ok(api.pressMenu("ArrowDown"))
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 1)
  api.pressMenu("ArrowDown")
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 0, "round to the top")
})

test("a horizontal arrow inside the menu is swallowed and never reaches the row", () => {
  // Letting it bubble moves the row's tab stop under a menu the person is still reading, and Escape
  // then returns focus to a control they never left.
  const api = folded()
  api.pressTrigger("ArrowDown")
  const before = api.tabStop()
  assert.ok(api.pressMenu("ArrowRight"), "prevented, so the row's handler sees it as handled")
  assert.equal(api.tabStop(), before)
})

test("Escape closes the menu and gives focus back to the trigger", () => {
  // A menu that unmounts while it still holds focus drops focus to <body>, and from there the next
  // Tab starts at the top of the page.
  const api = folded()
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  assert.ok(api.pressMenu("Escape"))
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
})

test("Tab leaves, but not from a node that is being removed", () => {
  const api = folded()
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  assert.equal(api.pressMenu("Tab"), false, "not prevented: Tab means leave")
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1, "focus moved first, then the menu went")
})

test("choosing an item closes the menu before the handler runs", () => {
  // A handler that opens a dialog would otherwise have focus pulled out from under it.
  const order = []
  const api = ui({
    items: [
      ...ITEMS.slice(0, 2),
      { label: "Link", onSelect: () => order.push("handler") },
      ITEMS[3],
    ],
  })
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  const trigger = api.trigger()
  api.menuItems()[0].props.onClick()
  api.instance.rerender()
  assert.deepEqual(order, ["handler"])
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(trigger).length, 1, "and focus came back to the trigger")
})

test("an outside press closes the menu and leaves focus where the person put it", () => {
  const api = folded()
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  api.pressOutside()
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before, "they have already chosen where to be")
})

test("the listener that closes it is removed with the flag it was added with", () => {
  // Asserted through unmount rather than through closing the menu: a pass in this harness is not a
  // commit, so it keeps cleanups for unmount instead of running them between passes. What this does
  // establish is the part that goes wrong in a browser — the stub only removes on a matching capture
  // flag, so a listener added in the capture phase and removed without it would still be here.
  const api = folded()
  api.openMenu()
  assert.equal(pointerListeners.length, 1)
  assert.ok(pointerListeners[0].capture, "capture, so it beats a focus move")
  api.instance.unmount()
  assert.equal(pointerListeners.length, 0)
})

test("a menu whose trigger has gone closes itself", () => {
  // The row widened, everything fits, and there is nothing left to press to dismiss it.
  const api = folded()
  api.openMenu()
  assert.ok(api.menu())
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.menu(), undefined)
})

test("the hidden set shrinking under an open menu does not leave the stop past the end", () => {
  // Shrunk to exactly the position the stop is on, which is the case that separates "past the end"
  // from "at the end": four hidden items with the stop on the last one, then three. A clamp written
  // as `>` instead of `>=` leaves the stop on position 3 of a three-item menu, and the menu then has
  // no tab stop at all.
  const api = ui()
  applyLayout(api, { available: 40, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  api.pressMenu("End")
  assert.equal(api.menuItems().length, 4, "nothing fits, so everything is in the menu")
  assert.deepEqual(api.menuItems().map((b) => b.props.tabIndex), [-1, -1, -1, 0])
  applyLayout(api, { available: 60, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.deepEqual(
    api.menuItems().map((b) => b.props.tabIndex),
    [-1, -1, 0],
    "the stop came back to the last item rather than pointing past it"
  )
  // And nothing was asked to take focus at a position the menu no longer has.
  assert.equal(api.focusCalls(api.menuItems()[2]).length >= 1, true)
})

// --- unavailable controls -----------------------------------------------------------------------

test("an unavailable control is aria-disabled, never disabled", () => {
  // `disabled` takes a button out of the focus order, so arrowing a row of four whose third is
  // unavailable walks 1, 2, 4 — and the person learns that the control does not exist rather than
  // that it is unavailable right now.
  const items = [ITEMS[0], { label: "Italic", onSelect: () => {}, disabled: true }, ITEMS[2]]
  const api = ui({ items })
  const control = api.rowItems()[1]
  assert.equal(control.props["aria-disabled"], true)
  assert.equal(control.props.disabled, undefined)
  api.pressRow("ArrowRight")
  assert.equal(api.tabStop(), 1, "and it keeps its place in the walk")
})

test("an unavailable control does nothing when pressed, in the row or in the menu", () => {
  let ran = 0
  const items = [
    ITEMS[0],
    { label: "Italic", onSelect: () => ran++, disabled: true },
    { label: "Link", onSelect: () => ran++, disabled: true },
    ITEMS[3],
  ]
  const row = ui({ items })
  row.rowItems()[1].props.onClick()
  assert.equal(ran, 0)
  const api = ui({ items })
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  assert.equal(api.menuItems()[0].props["aria-disabled"], true)
  api.menuItems()[0].props.onClick()
  api.instance.rerender()
  assert.equal(ran, 0)
  assert.ok(api.menu(), "and the menu stays open rather than closing on a dead press")
})

// --- icon-only controls -------------------------------------------------------------------------

test("a control shown as an icon keeps its name, and gets a tooltip with it", () => {
  const items = [{ label: "Bold", onSelect: () => {}, icon: "B", hideLabel: true }, ITEMS[1]]
  const api = ui({ items })
  const control = api.rowItems()[0]
  assert.equal(control.props["aria-label"], "Bold")
  assert.equal(control.props.title, "Bold")
  assert.equal(textOf(control), "B", "no visible text")
  assert.equal(api.rowItems()[1].props["aria-label"], undefined, "a labelled control needs neither")
})

test("the menu always shows the words, whatever the row does", () => {
  // A row of icons folded into a menu of icons is a menu of unlabelled squares.
  const items = [
    ITEMS[0],
    ITEMS[1],
    { label: "Link", onSelect: () => {}, icon: "L", hideLabel: true },
    { label: "Quote", onSelect: () => {}, icon: "Q", hideLabel: true },
  ]
  const api = ui({ items })
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  assert.deepEqual(api.menuItems().map((b) => textOf(b)), ["LLink", "QQuote"])
})

test("every decorative icon is hidden from the accessibility tree", () => {
  // Asserted per place rather than by looking for any one aria-hidden node anywhere: the probe
  // carries a copy of the trigger, whose own icon is hidden too, so "something on this page is
  // hidden" is true even when the control's wrapper has stopped hiding its icon.
  const items = [
    { label: "Bold", onSelect: () => {}, icon: "B" },
    ITEMS[1],
    { label: "Link", onSelect: () => {}, icon: "L" },
    ITEMS[3],
  ]
  const api = ui({ items })
  const iconWrapperOf = (control) =>
    (Array.isArray(control.props.children) ? control.props.children : [control.props.children]).find(
      (child) => child && typeof child === "object" && child.props?.["aria-hidden"] === "true"
    )
  assert.ok(iconWrapperOf(api.rowItems()[0]), "the control's icon")
  assert.equal(api.probe().props["aria-hidden"], "true", "and the whole measuring copy")
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  const chevron = walk(api.trigger()).find((n) => n.props?.["data-icon"] === "more")
  assert.equal(chevron.props["aria-hidden"], "true", "the trigger's own icon")
  api.openMenu()
  assert.ok(iconWrapperOf(api.menuItems()[0]), "and a folded control's icon in the menu")
})

// --- the caller's own handlers ------------------------------------------------------------------

test("opening and closing is reported once per change", () => {
  const seen = []
  const api = folded({ onOpenChange: (open) => seen.push(open) })
  api.openMenu()
  api.instance.rerender()
  assert.deepEqual(seen, [true])
  api.pressMenu("Escape")
  assert.deepEqual(seen, [true, false])
})

test("a caller's own props and key handler reach the row, not the wrapper", () => {
  const keys = []
  const api = ui({ onKeyDown: (event) => keys.push(event.key), id: "fmt" })
  assert.equal(api.rowEl().props.id, "fmt")
  assert.equal(api.tree.props.id, undefined)
  api.pressRow("ArrowRight")
  assert.deepEqual(keys, ["ArrowRight"])
  assert.equal(api.tabStop(), 1)
})

// --- cases the mutation pass asked for ----------------------------------------------------------
//
// Everything below was written because `scripts/mutate.mjs` changed a token and the suite above
// stayed green. Each one is a rule the component really has, that nothing happened to assert.

test("a toolbar of one control keeps it, or folds it", () => {
  // The count check at the top reads `=== 0`, and a toolbar of one is where `=== 1` would be wrong:
  // a single control would fold into a menu of one with nothing in the row.
  assert.equal(fitToolbarItems([30], 100, 0, 20), 1)
  assert.equal(fitToolbarItems([30], 10, 0, 20), 0)
})

test("exactly half a pixel over is still inside the tolerance, on both comparisons", () => {
  // The two boundaries, hit exactly rather than approached. Both are `<=` and `>` against the same
  // half pixel, and both read as arbitrary until the pixel lands on them.
  assert.equal(fitToolbarItems([30, 30, 30], 89.5, 0, 20), 3, "90 needed, 89.5 there: all stay")
  assert.equal(fitToolbarItems([30, 30, 30], 89.4, 0, 20), 2, "a tenth further and one folds")
  assert.equal(fitToolbarItems([30, 30, 30], 49.5, 0, 20), 1, "50 needed for one and the trigger")
  assert.equal(fitToolbarItems([30, 30, 30], 49.4, 0, 20), 0)
})

test("a negative measurement is no measurement", () => {
  // Widths, gaps and the trigger all arrive from a getBoundingClientRect or a parseFloat. A negative
  // one is not a smaller box, it is a reading that means nothing — and taken at face value it is
  // *credit*, room that does not exist, which is the direction that overflows rather than folds.
  // Each of these is a case where believing the negative changes the answer.
  assert.equal(
    fitToolbarItems([-50, 30, 30], 50, 0, 20),
    2,
    "believing -50 makes the row 60 wide and keeps all three"
  )
  assert.equal(fitToolbarItems([30, 30, 30], 70, -40, 20), 1, "a negative gap is no gap")
  assert.equal(
    fitToolbarItems([30, 30, 30], 50, 0, -40),
    1,
    "believing a -40 trigger pays for a second control"
  )
})

test("a gap narrower than a pixel is still a gap", () => {
  // Fractional gaps are ordinary — a rem-based spacing scale against a non-integer root size
  // produces them — and four of them add up to more than a control's worth of slack across a long
  // toolbar. Dropping them because they are under a pixel is the same mistake as dropping a
  // sub-pixel width.
  assert.equal(fitToolbarItems([20, 20, 20, 20], 80.9, 0.5, 20), 2)
  assert.equal(fitToolbarItems([20, 20, 20, 20], 81, 0.5, 20), 4, "81.5 needed, and half a pixel of slack")
})

test("a row of one control has a stop, and it is not the trigger", () => {
  assert.equal(nextToolbarStop(1, false, 0, 1), 0)
  assert.equal(nextToolbarStop(1, false, 0, -1), 0)
})

test("a key that produced no movement moves nothing", () => {
  assert.equal(nextToolbarStop(3, false, 0, NaN), 0)
  assert.equal(nextToolbarStop(3, false, 2, NaN), 2)
})

test("Left from a trigger that has just gone lands before the last control, not on it", () => {
  // The frame between the row widening and the rescue effect running. "The end" is the last control,
  // so Left from there is the one before it — the position the person would have expected had the
  // trigger still been there to step off.
  assert.equal(nextToolbarStop(4, false, TOOLBAR_MORE, -1), 2)
  assert.equal(nextToolbarStop(4, true, TOOLBAR_MORE, -1), 3, "with a trigger, Left is the last one")
})

test("a stop that was never a number, and one past the end of an unfolded row", () => {
  assert.equal(rescueToolbarStop(NaN, 2, 4), 0, "nothing to go on: the first control")
  assert.equal(rescueToolbarStop(9, 4, 4), 3, "nothing folded, so the stop is a control, clamped")
})

test("the measuring copy is laid out to report natural widths", () => {
  // Each of these is load-bearing, and together they are the measurement premise: out of flow so it
  // adds nothing to the row, on one line and unconstrained so what it reports is the width the
  // control wants rather than the width it was given.
  const style = ui().probe().props.style
  assert.equal(style.display, "flex")
  assert.equal(style.whiteSpace, "nowrap", "one line, so nothing wraps and shortens itself")
  assert.equal(style.width, "auto")
  assert.equal(style.maxWidth, "none", "not clipped by an ancestor's max-width")
  assert.equal(style.pointerEvents, "none", "and inert to a press even while visible to a measurement")
})

test("one folded control is enough to grow a trigger", () => {
  // `hidden.length > 0`, not `> 1`. With `> 1` a toolbar one control too wide has nowhere to put it:
  // the control is dropped from the row and there is no menu to find it in.
  const api = ui()
  applyLayout(api, { available: 110, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.rowItems().length, 3)
  assert.ok(api.trigger(), "the fourth went somewhere, so there is something to open")
  api.openMenu()
  assert.deepEqual(api.menuItems().map((b) => textOf(b)), ["Quote"])
})

test("no control is ever a positive tab stop", () => {
  // A roving tabindex is one 0 and the rest -1. A 1 is both a second stop in the row and a positive
  // tabindex, which jumps ahead of everything else on the page.
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  for (const node of byTag(walk(api.tree), "button")) {
    assert.ok(node.props.tabIndex === 0 || node.props.tabIndex === -1, `tabIndex ${node.props.tabIndex}`)
  }
})

test("every button this renders is a button and not a submit", () => {
  // All of them live inside a form sooner or later — a formatting toolbar over a comment box is the
  // ordinary case — and a `<button>` in a form defaults to submitting it.
  const api = ui()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  for (const node of byTag(walk(api.tree), "button")) assert.equal(node.props.type, "button")
})

test("a click opens the menu on its first item", () => {
  const api = folded()
  api.openMenu()
  assert.deepEqual(api.menuItems().map((b) => b.props.tabIndex), [0, -1])
  assert.equal(api.focusCalls(api.menuItems()[0]).length, 1, "and asks it to take focus")
})

test("the open menu carries the state attribute the animation utilities key off", () => {
  // `menuClassName="data-[state=open]:animate-in"` is how this composes with a project that has
  // installed any of official's collapsing components.
  const api = folded()
  api.openMenu()
  assert.equal(api.menu().props["data-state"], "open")
})

test("the menu lines up with the end of the toolbar unless asked otherwise", () => {
  const end = folded()
  end.openMenu()
  assert.match(end.menu().props.className, /\bend-0\b/, "the default, under the trigger")
  const start = ui({ align: "start" })
  applyLayout(start, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  start.openMenu()
  assert.match(start.menu().props.className, /\bstart-0\b/)
})

test("Escape on the trigger closes the menu too, and gives focus back", () => {
  // The trigger keeps its own Escape, as `split-button`'s arrow does: focus can be put back on it by
  // a caller, or left there by a press, and Escape has to mean the same thing wherever it is pressed.
  const api = folded()
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  assert.ok(api.pressTrigger("Escape"))
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
  assert.equal(api.pressTrigger("Escape"), false, "and does nothing once there is nothing to close")
})

test("Up in the menu walks backwards and wraps", () => {
  // Three hidden items, not two: with two, one step forward and one step back land on the same
  // position, so an Up that walks the wrong way is indistinguishable from one that walks the right
  // way.
  const api = ui()
  applyLayout(api, { available: 60, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  assert.equal(api.menuItems().length, 3)
  assert.ok(api.pressMenu("ArrowUp"))
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 2, "round to the bottom")
  api.pressMenu("ArrowUp")
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 1, "and backwards from there")
})

test("Home and End reach the ends of the menu", () => {
  const api = folded()
  api.openMenu()
  assert.ok(api.pressMenu("End"))
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 1)
  assert.ok(api.pressMenu("Home"))
  assert.equal(api.menuItems().findIndex((b) => b.props.tabIndex === 0), 0)
})

test("both horizontal arrows are swallowed by the menu", () => {
  const api = folded()
  api.openMenu()
  const before = api.tabStop()
  assert.ok(api.pressMenu("ArrowLeft"))
  assert.equal(api.tabStop(), before)
  assert.ok(api.pressMenu("ArrowRight"))
  assert.equal(api.tabStop(), before)
})

test("a menu closed because its trigger went does not chase the trigger with focus", () => {
  // The same rule as the resize rescue, in the one place it is easy to get backwards: there is no
  // trigger left to focus, and the row widening was not something the person asked for.
  const api = folded()
  api.openMenu()
  const trigger = api.trigger()
  const before = api.focusCalls(trigger).length
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(trigger).length, before)
})

test("clicking the trigger shut puts focus back on it", () => {
  // A press has already put focus here, so this is usually a no-op. It is written down because the
  // case where it is not — a caller's programmatic click while focus is on a menu item — unmounts
  // the menu while it still holds focus, and focus drops to `<body>`.
  const api = folded()
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  api.trigger().props.onClick()
  api.instance.rerender()
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
})

test("a re-measure while the menu is open does not pull focus out of the menu", () => {
  // The rescue asks the *row* whether it holds focus, not the whole component. Focus sitting on a
  // menu item is inside the component and not in the row, and a resize that yanked it back to the
  // trigger would close nothing, explain nothing, and drop somebody out of the list they were
  // reading. The tab stop still moves, because that failure is not about focus at all.
  const api = ui()
  applyLayout(api, { available: 400, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.rowItems()[3].props.onFocus()
  api.instance.rerender()
  applyLayout(api, { available: 100, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  api.openMenu()
  // Focus is in the menu: the row does not contain the active element, the outer box would.
  api.rowNode().contains = () => false
  api.root().contains = () => true
  globalThis.document.activeElement = {}
  const trigger = api.trigger()
  const before = api.focusCalls(trigger).length
  applyLayout(api, { available: 60, gap: 0, widths: [30, 30, 30, 30], moreWidth: 20 })
  assert.equal(api.focusCalls(trigger).length, before, "focus stayed in the menu")
  const controls = api.rowControls()
  assert.equal(api.tabStop(), controls.length - 1, "and the tab stop is still somewhere in the row")
  globalThis.document.activeElement = null
})

test("the writing direction is read from the row, where a caller's dir would land", () => {
  // `...props` reach the row, so `dir="rtl"` on this component sets it on the row and not on the
  // outer positioning box. Reading the box instead answers with the page's direction, and the arrows
  // then run the wrong way on exactly the page that asked for them to run the other way.
  const api = ui()
  api.rowDirection = "rtl"
  applyLayout(api, {
    available: 400,
    gap: 0,
    widths: [30, 30, 30, 30],
    moreWidth: 20,
    direction: "ltr",
  })
  api.pressRow("ArrowLeft")
  assert.equal(api.tabStop(), 1, "Left is forward because the row is rtl, whatever the page is")
})
