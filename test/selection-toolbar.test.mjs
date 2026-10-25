// The naive version of this component is "on mouseup, if getSelection().toString() is not empty,
// show a box at getBoundingClientRect()", and every case below is written to pass against the
// shipped implementation and fail against a version that looks right:
//
//   - opened from `mouseup`, which never happens for a selection made with Shift and the arrow
//     keys, so the toolbar does not exist for keyboard users,
//   - opened on "the selection has text", which is true for text selected inside an <input> —
//     where the document selection is collapsed and has no rects at all, so the toolbar opens
//     with nowhere to point,
//   - positioned on the selection's bounding box, which for a multi-line selection is the width
//     of the column rather than of anything highlighted,
//   - a `selectionchange` handler behind a debounce, which the browser's own coalescing already
//     makes unnecessary and which only makes the toolbar trail the highlight,
//   - a scroll listener on the window in the bubble phase, which hears the document scrolling and
//     not the pane the selection is actually in,
//   - holding the live Range rather than a clone, which keeps moving while the drag continues,
//   - reading the selected text inside the click handler, which is too late once an action has
//     focused a field,
//   - re-measuring on every commit and writing an equal-but-new placement back to state, which
//     re-renders forever,
//   - one tab stop per button, which adds five of them to every paragraph of an article.
//
// The browser facts these rest on were measured in the preview browser (Chromium 152) rather than
// recalled; the figures are in the component's own comments.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// --- the page this renders into ----------------------------------------------------------------
const VIEWPORT = { width: 1000, height: 800 }
let listeners = []
let timersAsked = 0
let selection = null

// `removeEventListener` matches on the capture flag as the DOM does: removing a capture listener
// without passing `true` removes nothing, and the listener is still there on the next selection.
const record = (target) => ({
  addEventListener: (type, fn, options) => listeners.push({ target, type, fn, options }),
  removeEventListener: (type, fn, options) => {
    const at = listeners.findIndex(
      (entry) =>
        entry.target === target &&
        entry.type === type &&
        entry.fn === fn &&
        Boolean(entry.options) === Boolean(options)
    )
    if (at !== -1) listeners.splice(at, 1)
  },
})

const visualViewport = record("visualViewport")
globalThis.window = {
  innerWidth: VIEWPORT.width,
  innerHeight: VIEWPORT.height,
  visualViewport,
  // Counted, never run. A debounce would have to come through here, and "nobody asked for a
  // timer" is the assertion that a debounce was not quietly reintroduced.
  setTimeout: () => {
    timersAsked += 1
    return 0
  },
  clearTimeout: () => {},
  ...record("window"),
}
globalThis.document = {
  getSelection: () => selection,
  ...record("document"),
}

const { SelectionToolbar, placeToolbar, samePlacement, selectionIsPresentable } = loadComponent(
  join(ROOT, "registry", "ui", "selection-toolbar.tsx")
)

/** The newest listener registered for a type — the one belonging to the latest render pass. */
const latest = (target, type) => {
  const found = listeners.filter((entry) => entry.target === target && entry.type === type)
  return found[found.length - 1]
}

const rect = (top, left, width, height = 18) => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
})

/** A range whose clone is distinguishable, so "did it clone?" is assertable. */
const makeRange = (rects, container = "ARTICLE") => {
  const range = {
    commonAncestorContainer: container,
    getClientRects: () => rects,
    cloneRange() {
      return { ...range, cloned: true }
    },
  }
  return range
}

const makeSelection = ({ text, collapsed = false, rects = [rect(200, 100, 60)], container }) => ({
  rangeCount: 1,
  isCollapsed: collapsed,
  toString: () => text,
  getRangeAt: (index) => {
    // The DOM throws IndexSizeError for anything past `rangeCount`; a toolbar reading the second
    // range of a one-range selection is not a toolbar that works.
    if (index !== 0) throw new RangeError(`no range at ${index}`)
    return makeRange(rects, container)
  },
})

/** Fires one `selectionchange` and settles the tree, as a commit would. */
const selectText = (view, next) => {
  selection = next
  latest("document", "selectionchange").fn()
  view.rerender()
}

const toolbar = (view) => byRole(walk(view.tree), "toolbar")[0] ?? null
const buttons = (view) => byTag(walk(view.tree), "button")

const ACTIONS = [
  { id: "quote", label: "Quote", onSelect: () => {} },
  { id: "copy", label: "Copy", onSelect: () => {} },
  { id: "share", label: "Share", onSelect: () => {} },
]

const mount = (props = {}) => {
  listeners = []
  timersAsked = 0
  selection = null
  return render(SelectionToolbar, { actions: ACTIONS, ...props })
}

// --- placement, without a DOM ------------------------------------------------------------------

test("nothing to point at places nothing", () => {
  assert.equal(
    placeToolbar({
      rects: [],
      width: 120,
      height: 32,
      viewportWidth: 1000,
      viewportHeight: 800,
      gap: 8,
      margin: 8,
    }),
    null
  )
})

test("a multi-line selection is centred on its first line, not on the column", () => {
  // The measured case: 60 characters of a 260px column gave a first line running 29 -> 284.9 and
  // a second running 29 -> 153. A backward selection starting mid-line gave a first line running
  // 101.8 -> 284.9 whose union with the second still started at 29.
  const place = (rects) =>
    placeToolbar({
      rects,
      width: 100,
      height: 32,
      viewportWidth: 1000,
      viewportHeight: 800,
      gap: 8,
      margin: 8,
    })

  // The measured horizontal geometry, moved down the page so that the preferred side is the one
  // under test: at the top of the viewport it would flip below, which is a different anchor.
  const firstLine = rect(332, 101.8, 183.1)
  const secondLine = rect(356, 29, 8.9)
  const got = place([firstLine, secondLine])
  assert.equal(got.side, "above")

  // Centre of the first line (101.8 + 183.1/2 = 193.35), less half the toolbar.
  assert.ok(Math.abs(got.left - 143.35) < 0.001, `centred on the first line, got ${got.left}`)
  // The union's centre is (29 + 284.9) / 2 = 156.95 — 36px to the left, over text the reader can
  // see is not selected.
  assert.ok(Math.abs(got.left - 106.95) > 1, "not centred on the union of the lines")
})

test("above is preferred, and the gap is measured from the first line's top", () => {
  const got = placeToolbar({
    rects: [rect(200, 100, 60), rect(224, 100, 40)],
    width: 100,
    height: 32,
    viewportWidth: 1000,
    viewportHeight: 800,
    gap: 8,
    margin: 8,
  })
  assert.equal(got.side, "above")
  assert.equal(got.top, 200 - 8 - 32)
})

test("no room above flips it under the last line", () => {
  const rects = [rect(20, 100, 60), rect(44, 100, 40)]
  const got = placeToolbar({
    rects,
    width: 100,
    height: 32,
    viewportWidth: 1000,
    viewportHeight: 800,
    gap: 8,
    margin: 8,
  })
  assert.equal(got.side, "below")
  // Under the *last* line (bottom 62), not the first.
  assert.equal(got.top, 62 + 8)
  // And anchored horizontally to that same last line.
  assert.equal(got.left, 100 + 20 - 50)
})

test("the flip happens exactly when the toolbar would cross the margin", () => {
  const at = (top) =>
    placeToolbar({
      rects: [rect(top, 100, 60)],
      width: 100,
      height: 32,
      viewportWidth: 1000,
      viewportHeight: 800,
      gap: 8,
      margin: 8,
    }).side
  // top - gap - height >= margin  ->  top >= 48
  assert.equal(at(48), "above")
  assert.equal(at(47), "below")
})

test("it is kept inside the viewport at both edges", () => {
  const leftFor = (left) =>
    placeToolbar({
      rects: [rect(200, left, 10)],
      width: 100,
      height: 32,
      viewportWidth: 1000,
      viewportHeight: 800,
      gap: 8,
      margin: 8,
    }).left

  assert.equal(leftFor(0), 8, "a selection at the left edge does not push the toolbar off it")
  assert.equal(leftFor(995), 1000 - 100 - 8, "nor at the right edge")
  assert.equal(leftFor(500), 455, "and it is left alone in the middle")
})

test("a toolbar wider than the viewport lands on the near edge, not the far one", () => {
  // The clamp's bounds cross over here; without the guard the result is the high bound, which is
  // negative — the toolbar leaves the screen to the left in exactly the narrow viewport where it
  // is most needed.
  const got = placeToolbar({
    rects: [rect(200, 10, 40)],
    width: 400,
    height: 32,
    viewportWidth: 320,
    viewportHeight: 800,
    gap: 8,
    margin: 8,
  })
  assert.equal(got.left, 8)
})

test("a selection taller than the viewport is clamped rather than dropped", () => {
  const got = placeToolbar({
    rects: [rect(-200, 100, 60), rect(900, 100, 60)],
    width: 100,
    height: 32,
    viewportWidth: 1000,
    viewportHeight: 800,
    gap: 8,
    margin: 8,
  })
  assert.equal(got.side, "below")
  assert.equal(got.top, 800 - 32 - 8)
})

test("samePlacement compares what is rendered, and nulls are not equal to placements", () => {
  const a = { left: 10, top: 20, side: "above" }
  assert.equal(samePlacement(a, { ...a }), true)
  assert.equal(samePlacement(a, { ...a, left: 11 }), false)
  assert.equal(samePlacement(a, { ...a, side: "below" }), false)
  assert.equal(samePlacement(null, null), true)
  assert.equal(samePlacement(a, null), false)
  assert.equal(samePlacement(null, a), false)
})

// --- the predicate -----------------------------------------------------------------------------

test("a selection inside an input is not presentable, however much text it reports", () => {
  // Measured: focusing an <input> and selecting its first five characters left the *document*
  // selection reporting that text, collapsed, with zero client rects.
  assert.equal(selectionIsPresentable({ collapsed: true, rectCount: 0 }), false)
  // And the half-measures either way round.
  assert.equal(selectionIsPresentable({ collapsed: true, rectCount: 2 }), false)
  assert.equal(selectionIsPresentable({ collapsed: false, rectCount: 0 }), false)
  assert.equal(selectionIsPresentable({ collapsed: false, rectCount: 1 }), true)
})

// --- the component -----------------------------------------------------------------------------

test("it renders nothing until something is selected", () => {
  const view = mount()
  assert.equal(toolbar(view), null)
  assert.equal(walk(view.tree).length, 0)
})

test("it opens on selectionchange — not on mouseup, which a keyboard selection never fires", () => {
  const view = mount()
  assert.equal(latest("document", "mouseup"), undefined, "nothing may hang off mouseup")
  assert.ok(latest("document", "selectionchange"), "the selection is watched on the document")

  selectText(view, makeSelection({ text: "Alpha bravo" }))
  assert.ok(toolbar(view), "the toolbar is up after one selectionchange")
  view.unmount()
})

test("opening is not debounced", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha bravo" }))
  assert.ok(toolbar(view))
  assert.equal(timersAsked, 0, "the browser already coalesces selectionchange; a timer only lags")
  view.unmount()
})

test("text selected inside a field does not open it", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "focus", collapsed: true, rects: [] }))
  assert.equal(toolbar(view), null)
  view.unmount()
})

test("collapsing the selection closes it, with no listener of its own", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha bravo" }))
  assert.ok(toolbar(view))

  // What the mousedown beginning the next drag produces.
  selectText(view, makeSelection({ text: "", collapsed: true, rects: [] }))
  assert.equal(toolbar(view), null)
  view.unmount()
})

test("an empty selection object closes it rather than throwing", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha bravo" }))
  selection = { rangeCount: 0, isCollapsed: true, toString: () => "", getRangeAt: () => null }
  latest("document", "selectionchange").fn()
  view.rerender()
  assert.equal(toolbar(view), null)
  view.unmount()
})

test("a rootRef keeps it to selections inside that element", () => {
  const rootRef = { current: { contains: (node) => node === "ARTICLE" } }
  const view = mount({ rootRef })

  selectText(view, makeSelection({ text: "in the nav", container: "NAV" }))
  assert.equal(toolbar(view), null, "a selection outside the root is not served")

  selectText(view, makeSelection({ text: "in the article", container: "ARTICLE" }))
  assert.ok(toolbar(view), "one inside it is")
  view.unmount()
})

test("disabled attaches nothing at all", () => {
  const view = mount({ disabled: true })
  assert.equal(latest("document", "selectionchange"), undefined)
  assert.equal(toolbar(view), null)
})

test("it is placed, and says which side it took", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha", rects: [rect(200, 100, 60)] }))
  const props = toolbar(view).props
  assert.equal(props.style.position, "fixed")
  assert.equal(props.style.visibility, "visible")
  assert.equal(props["data-side"], "above")
  // Measured with a zero-size toolbar (the harness has no layout): centred on the rect.
  assert.equal(props.style.left, 130)
  view.unmount()
})

test("settling does not loop when nothing has moved", () => {
  // `render` throws "a state update is looping" if an equal-but-new placement is written back on
  // every commit, which is what re-measuring without an identity bail-out does.
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  assert.doesNotThrow(() => view.rerender())
  assert.doesNotThrow(() => view.rerender())
  view.unmount()
})

test("it follows a selection inside a scrolling pane, which only a capture listener hears", () => {
  const view = mount()
  let top = 200
  selection = {
    rangeCount: 1,
    isCollapsed: false,
    toString: () => "Alpha",
    getRangeAt: () => ({
      commonAncestorContainer: "ARTICLE",
      getClientRects: () => [rect(top, 100, 60)],
      cloneRange() {
        return { ...this, cloned: true, getClientRects: () => [rect(top, 100, 60)] }
      },
    }),
  }
  latest("document", "selectionchange").fn()
  view.rerender()
  assert.equal(toolbar(view).props.style.top, 200 - 8 - 0)

  const onScroll = latest("window", "scroll")
  assert.equal(onScroll.options, true, "a bubble-phase listener never hears a nested scroller")

  top = 140
  onScroll.fn()
  view.rerender()
  assert.equal(toolbar(view).props.style.top, 140 - 8 - 0, "the rect is re-read, not remembered")
  view.unmount()
})

test("pinch-zoom moves it too", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  assert.ok(latest("visualViewport", "resize"), "the visual viewport is watched")
  assert.ok(latest("visualViewport", "scroll"))
  view.unmount()
})

test("the text it hands an action is the text it opened on", () => {
  const seen = []
  const view = mount({
    actions: [{ id: "quote", label: "Quote", onSelect: (s) => seen.push(s) }],
  })
  selectText(view, makeSelection({ text: "Alpha bravo charlie" }))

  // What an action that focuses a field would leave behind: the document selection is gone.
  buttons(view)[0].props.onClick()
  selection = makeSelection({ text: "", collapsed: true, rects: [] })

  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, "Alpha bravo charlie")
  assert.equal(seen[0].range.cloned, true, "the range is a clone, not the one still being dragged")
  view.unmount()
})

test("an action closes the toolbar unless it asks to stay", () => {
  const closing = mount({ actions: [{ id: "a", label: "A", onSelect: () => {} }] })
  selectText(closing, makeSelection({ text: "Alpha" }))
  buttons(closing)[0].props.onClick()
  closing.rerender()
  assert.equal(toolbar(closing), null)
  closing.unmount()

  const staying = mount({
    actions: [{ id: "a", label: "A", keepOpen: true, onSelect: () => {} }],
  })
  selectText(staying, makeSelection({ text: "Alpha" }))
  buttons(staying)[0].props.onClick()
  staying.rerender()
  assert.ok(toolbar(staying), "a toggle stays up")
  staying.unmount()
})

test("mousedown is prevented, which is what keeps the caret in the editor", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  let prevented = false
  toolbar(view).props.onMouseDown({
    defaultPrevented: false,
    preventDefault: () => {
      prevented = true
    },
  })
  assert.equal(prevented, true)
  view.unmount()
})

test("a consumer's own mousedown handler still runs, and may take the decision", () => {
  const calls = []
  const view = mount({ onMouseDown: () => calls.push("consumer") })
  selectText(view, makeSelection({ text: "Alpha" }))
  let prevented = false
  toolbar(view).props.onMouseDown({
    defaultPrevented: true,
    preventDefault: () => {
      prevented = true
    },
  })
  assert.deepEqual(calls, ["consumer"])
  assert.equal(prevented, false, "already prevented by the consumer; not prevented twice")
  view.unmount()
})

test("Escape closes it", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  latest("document", "keydown").fn({ key: "Escape" })
  view.rerender()
  assert.equal(toolbar(view), null)
  view.unmount()
})

test("a key that is not Escape leaves it alone", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  latest("document", "keydown").fn({ key: "a" })
  view.rerender()
  assert.ok(toolbar(view))
  view.unmount()
})

test("the whole toolbar is one tab stop", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  const stops = buttons(view).map((b) => b.props.tabIndex)
  assert.deepEqual(stops, [0, -1, -1])
  view.unmount()
})

test("arrows move between the buttons and wrap at both ends", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  const press = (key) => {
    toolbar(view).props.onKeyDown({ key, defaultPrevented: false, preventDefault: () => {} })
    view.rerender()
  }
  const focused = () => buttons(view).findIndex((b) => b.props.tabIndex === 0)

  press("ArrowRight")
  assert.equal(focused(), 1)
  press("ArrowLeft")
  assert.equal(focused(), 0)
  press("ArrowLeft")
  assert.equal(focused(), 2, "left from the first wraps to the last")
  press("ArrowRight")
  assert.equal(focused(), 0, "right from the last wraps to the first")
  press("End")
  assert.equal(focused(), 2)
  press("Home")
  assert.equal(focused(), 0)
  view.unmount()
})

test("reopening starts from the first action again", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  toolbar(view).props.onKeyDown({
    key: "ArrowRight",
    defaultPrevented: false,
    preventDefault: () => {},
  })
  view.rerender()
  assert.equal(
    buttons(view).findIndex((b) => b.props.tabIndex === 0),
    1
  )

  selectText(view, makeSelection({ text: "", collapsed: true, rects: [] }))
  selectText(view, makeSelection({ text: "Bravo" }))
  assert.equal(
    buttons(view).findIndex((b) => b.props.tabIndex === 0),
    0
  )
  view.unmount()
})

test("it is a labelled toolbar, and an icon-only action keeps a name", () => {
  const view = mount({
    actions: [{ id: "quote", label: "Quote", icon: "Q", iconOnly: true, onSelect: () => {} }],
  })
  selectText(view, makeSelection({ text: "Alpha" }))
  const props = toolbar(view).props
  assert.equal(props.role, "toolbar")
  assert.equal(props["aria-label"], "Selection actions")
  assert.equal(props["aria-orientation"], "horizontal")

  const button = buttons(view)[0]
  assert.equal(button.props["aria-label"], "Quote")
  assert.equal(button.props.type, "button")
  // The icon is decoration once the button is named by its label.
  const icon = walk(view.tree).find((n) => n.props?.["aria-hidden"] === "true")
  assert.ok(icon, "a decorative icon is hidden from the accessibility tree")
  view.unmount()
})

test("a labelled text action is not given a redundant aria-label", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  assert.equal(buttons(view)[0].props["aria-label"], undefined)
  view.unmount()
})

test("no actions, no toolbar", () => {
  const view = mount({ actions: [] })
  selectText(view, makeSelection({ text: "Alpha" }))
  assert.equal(toolbar(view), null)
  view.unmount()
})

test("everything it subscribed to is handed back on unmount", () => {
  // Every type, not a sample of two: a cleanup that removes four of five listeners leaves a
  // component measuring a selection that no longer exists, and the one left behind is whichever
  // name was mistyped. Removal here matches the capture flag too, so `true` on the way in and
  // nothing on the way out counts as still attached.
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))

  const subscribed = new Set(listeners.map((entry) => `${entry.target}/${entry.type}`))
  assert.deepEqual(
    [...subscribed].sort(),
    [
      "document/keydown",
      "document/selectionchange",
      "visualViewport/resize",
      "visualViewport/scroll",
      "window/resize",
      "window/scroll",
    ],
    "the set of things a toolbar watches, so an addition has to be deliberate"
  )

  view.unmount()
  assert.deepEqual(listeners, [], "an unmounted toolbar leaves nothing attached to anything")
})

test("a closed toolbar is still watching, and opens again", () => {
  // That closing also drops the viewport listeners is not assertable here: the harness runs effect
  // cleanups on unmount only, never between passes, so a listener React would have removed when
  // the effect re-ran is still in the list. Asserting its absence would be a test of the harness.
  // What is assertable is that closing does not stop the component watching for the next one.
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  selectText(view, makeSelection({ text: "", collapsed: true, rects: [] }))
  assert.equal(toolbar(view), null)

  selectText(view, makeSelection({ text: "Bravo" }))
  assert.ok(toolbar(view), "the next selection opens it again")
  assert.equal(toolbar(view).props.style.visibility, "visible")
  view.unmount()
})

test("the viewport is watched for resize as well as scroll", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  assert.ok(latest("window", "resize"), "a window the user narrows moves the text under it")
  view.unmount()
})

test("the default margin keeps it off the viewport edge", () => {
  // No `margin` prop: a default of zero lets the toolbar sit flush against the edge of the screen,
  // which on a phone is under the rounded corner.
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha", rects: [rect(200, 0, 10)] }))
  assert.equal(toolbar(view).props.style.left, 8)
  view.unmount()
})

test("a keydown the consumer has already handled is left alone", () => {
  const view = mount()
  selectText(view, makeSelection({ text: "Alpha" }))
  toolbar(view).props.onKeyDown({
    key: "ArrowRight",
    defaultPrevented: true,
    preventDefault: () => assert.fail("an already-handled key must not be taken over"),
  })
  view.rerender()
  assert.equal(
    buttons(view).findIndex((b) => b.props.tabIndex === 0),
    0,
    "the roving tab stop did not move"
  )
  view.unmount()
})

test("a one-action toolbar still owns its arrow keys", () => {
  const view = mount({ actions: [{ id: "a", label: "A", onSelect: () => {} }] })
  selectText(view, makeSelection({ text: "Alpha" }))
  let prevented = false
  toolbar(view).props.onKeyDown({
    key: "ArrowRight",
    defaultPrevented: false,
    preventDefault: () => {
      prevented = true
    },
  })
  // Otherwise the arrow falls through to the page and scrolls the article out from under the
  // selection the toolbar is pointing at.
  assert.equal(prevented, true)
  view.unmount()
})
