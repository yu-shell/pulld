// The swipe-to-reveal everyone writes first subtracts a clientX in React's `onTouchMove`, translates
// the row by the difference, and snaps open past half. It looks finished on the phone it was built
// on, swiped in the one direction that was tried. The cases below are written to fail against it:
//
//   - React attaches `onTouchMove` passively, so its `preventDefault` is dropped and the list
//     scrolls vertically while the row slides sideways,
//   - a hard-coded `-dx`, which on an RTL page opens the row when it is swiped shut,
//   - a diagonal drag claimed as a swipe, so a thumb arcing down the list stops it scrolling,
//   - a vertical drag that snaps a already-open row shut, taking the buttons away as they are
//     reached for,
//   - a short fast flick judged on distance alone, which refuses to open,
//   - a second drag on an open row starting from zero, so the row jumps shut under the finger,
//   - a touchcancel sharing the release handler, revealing actions nobody released onto,
//   - buttons left in the tab order behind a closed row, so a focus ring vanishes into the list,
//   - a swipe that ends by firing the row's own click, opening the message being swiped,
//   - and a gesture-only component, which to a keyboard or a screen reader has no actions at all.
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
  AXIS_SLOP,
  DEFAULT_ACTION_WIDTH,
  FLICK_VELOCITY,
  panelSide,
  openingSign,
  decideAxis,
  revealWidth,
  clampOffset,
  shouldOpen,
  beginSwipe,
  advanceSwipe,
  SwipeActions,
} = loadComponent(join(ROOT, "registry", "ui", "swipe-actions.tsx"), {
  stubs: { "lucide-react": { MoreHorizontal: icon("more") } },
})

// --- which way is open -----------------------------------------------------

test("the panel sits at the logical end, which is the right in LTR and the left in RTL", () => {
  assert.equal(panelSide("end", false), "right")
  assert.equal(panelSide("end", true), "left")
  assert.equal(panelSide("start", false), "left")
  assert.equal(panelSide("start", true), "right")
})

test("the opening direction flips in RTL, so a swipe is not inverted on an Arabic page", () => {
  // The whole of the RTL bug in one assertion: with a hard-coded `-dx` both of these are -1, and on
  // the RTL page the row opens when it is swiped closed and closes when it is swiped open.
  assert.equal(openingSign("end", false), -1)
  assert.equal(openingSign("end", true), 1)
  assert.equal(openingSign("start", false), 1)
  assert.equal(openingSign("start", true), -1)
})

// --- telling a swipe from a scroll -----------------------------------------

test("nothing is decided inside the slop circle", () => {
  assert.equal(decideAxis(0, 0), "undecided")
  assert.equal(decideAxis(AXIS_SLOP - 1, AXIS_SLOP - 1), "undecided")
})

test("a tie goes to vertical, so a thumb arcing down the list still scrolls it", () => {
  // The opposite of the same tie-break in pull-to-refresh, and deliberately so: there the risk is
  // stealing a row's swipe, here it is stealing the list's scroll. A list that will not scroll reads
  // as broken; a swipe that needs a second try reads as a miss.
  assert.equal(decideAxis(12, 12), "vertical")
  assert.equal(decideAxis(-12, 12), "vertical")
  assert.equal(decideAxis(12, 13), "vertical")
  assert.equal(decideAxis(13, 12), "horizontal")
})

// --- how far the row may go ------------------------------------------------

test("the reveal falls back to an estimate before layout, so the row can open on first paint", () => {
  // `offsetWidth` is 0 on the server and on the first client render. Taken literally it is a row
  // that cannot be opened until something else happens to re-render it.
  assert.equal(revealWidth(0, 3, 72), 216)
  assert.equal(revealWidth(184, 3, 72), 184, "a real measurement wins")
})

test("with no actions there is nothing to reveal and the gesture is dead", () => {
  assert.equal(revealWidth(0, 0, 72), 0)
  assert.equal(shouldOpen(500, 10, 0), false, "and no release can open it")
})

test("the row stops exactly where the last action ends", () => {
  assert.equal(clampOffset(50, 180), 50)
  assert.equal(clampOffset(400, 180), 180)
  assert.equal(clampOffset(-30, 180), 0, "swiping the other way does not push the row off")
})

test("a NaN offset collapses to zero instead of erasing the transform", () => {
  // A clientX read from a touch that has already ended gives NaN, and `translateX(NaNpx)` is
  // dropped silently along with the whole transform — leaving the row wherever it happened to be.
  assert.equal(clampOffset(NaN, 180), 0)
})

// --- where a release lands -------------------------------------------------

test("distance decides an ordinary drag", () => {
  assert.equal(shouldOpen(100, 0, 180), true)
  assert.equal(shouldOpen(80, 0, 180), false)
  assert.equal(shouldOpen(90, 0, 180), true, "exactly half is open")
})

test("a short fast flick opens, which distance alone refuses", () => {
  // The gesture people actually make once they know the row swipes: a quick throw that never
  // travels half the panel. Judged on distance it snaps shut and the row feels like it is refusing.
  assert.equal(shouldOpen(30, FLICK_VELOCITY, 180), true)
})

test("a fast flick back closes a row that is more than half open", () => {
  assert.equal(shouldOpen(150, -FLICK_VELOCITY, 180), false)
})

// --- the gesture -----------------------------------------------------------

const move = (x, y, at, over = {}) => ({
  x,
  y,
  at,
  touchCount: 1,
  cancelable: true,
  ...over,
})

test("a vertical drag gives the gesture up and leaves an open row open", () => {
  // The bug this is written against: the row someone just opened snaps shut as they scroll the list
  // to reach its buttons. Abandoning has to return the row to where it was, not to zero.
  const gesture = beginSwipe(200, 100, 0, 180, -1)
  const { gesture: next, claim } = advanceSwipe(gesture, move(200, 160, 50), { reveal: 180 })
  assert.equal(next.abandoned, true)
  assert.equal(claim, false, "and the list is left to scroll")
  assert.equal(next.offset, 180, "still open")
})

test("a second finger gives the gesture up — a pinch is not a swipe", () => {
  const gesture = beginSwipe(200, 100, 0, 0, -1)
  const { gesture: next } = advanceSwipe(gesture, move(160, 100, 50, { touchCount: 2 }), {
    reveal: 180,
  })
  assert.equal(next.abandoned, true)
})

test("a move the browser has already committed to scrolling is given up", () => {
  // `cancelable` false is the browser saying the sequence belongs to the page now. Carrying on
  // slides the row sideways on top of a scroll that cannot be stopped.
  const gesture = beginSwipe(200, 100, 0, 0, -1)
  const { gesture: next, claim } = advanceSwipe(
    gesture,
    move(160, 100, 50, { cancelable: false }),
    { reveal: 180 }
  )
  assert.equal(next.abandoned, true)
  assert.equal(claim, false)
})

test("an axis once decided is never re-decided, so the arc of a thumb does not kill the swipe", () => {
  let gesture = beginSwipe(200, 100, 0, 0, -1)
  gesture = advanceSwipe(gesture, move(180, 102, 20), { reveal: 180 }).gesture
  assert.equal(gesture.axis, "horizontal")
  // Now mostly downward — which, asked fresh, would be vertical.
  const { gesture: next, claim } = advanceSwipe(gesture, move(170, 200, 60), { reveal: 180 })
  assert.equal(next.axis, "horizontal")
  assert.equal(claim, true)
  assert.equal(next.offset, 30)
})

test("a slow start is not given up — the same sequence gets to try again", () => {
  const gesture = beginSwipe(200, 100, 0, 0, -1)
  const { gesture: next, claim } = advanceSwipe(gesture, move(198, 101, 10), { reveal: 180 })
  assert.equal(next.axis, "undecided")
  assert.equal(next.abandoned, false, "abandoning here would kill every swipe that starts slowly")
  assert.equal(claim, false)
})

test("a drag on an open row continues from where it was instead of jumping shut", () => {
  const gesture = beginSwipe(200, 100, 0, 180, -1)
  const { gesture: next } = advanceSwipe(gesture, move(180, 100, 30), { reveal: 300 })
  assert.equal(next.offset, 200, "180 already open plus 20 of travel")
})

test("in RTL the same finger travel opens rather than closes", () => {
  const rtl = beginSwipe(200, 100, 0, 0, openingSign("end", true))
  const { gesture: next } = advanceSwipe(rtl, move(240, 100, 30), { reveal: 180 })
  assert.equal(next.offset, 40, "rightward travel is progress when the panel is on the left")
})

test("velocity is held over when two samples share a timestamp", () => {
  // Engines coalesce moves, and 0/0 on the last sample before release would wipe out a flick's speed
  // — the one number the release reads.
  let gesture = beginSwipe(200, 100, 0, 0, -1)
  gesture = advanceSwipe(gesture, move(180, 100, 40), { reveal: 180 }).gesture
  assert.ok(gesture.velocity > 0)
  const carried = gesture.velocity
  const { gesture: next } = advanceSwipe(gesture, move(175, 100, 40), { reveal: 180 })
  assert.equal(next.velocity, carried)
})

// --- the component ---------------------------------------------------------

const ACTIONS = [
  { id: "archive", label: "Archive" },
  { id: "delete", label: "Delete", variant: "destructive" },
]

const mount = (props = {}, options) =>
  render(SwipeActions, { actions: ACTIONS, children: "Design review", ...props }, options)

const buttons = (result) => byTag(walk(result.tree), "button")
const toggleOf = (result) =>
  buttons(result).find((b) => b.props["aria-expanded"] !== undefined)
const actionsOf = (result) =>
  buttons(result).filter((b) => b.props["aria-expanded"] === undefined)

test("there is a real control for the actions, because a swipe is not one to a keyboard", () => {
  const result = mount()
  const toggle = toggleOf(result)
  assert.ok(toggle, "a gesture-only row has no actions at all for a keyboard or a screen reader")
  assert.equal(toggle.props["aria-expanded"], false)
  assert.ok(toggle.props["aria-controls"], "and it names the panel it opens")
})

test("while shut the actions are out of the tab order and out of the accessible tree", () => {
  // They are completely covered by the row, so a keyboard that can focus them puts a focus ring on
  // nothing — which in a long list is worse than no keyboard support at all.
  const result = mount()
  const panel = walk(result.tree).find((n) => n.props?.role === "group")
  assert.equal(panel.props["aria-hidden"], true)
  assert.match(panel.props.className, /pointer-events-none/)
  for (const action of actionsOf(result)) assert.equal(action.props.tabIndex, -1)
})

test("the toggle opens the panel, which then takes focus and the row moves", () => {
  const result = mount()
  toggleOf(result).props.onClick()
  result.rerender()

  const panel = walk(result.tree).find((n) => n.props?.role === "group")
  assert.equal(panel.props["aria-hidden"], undefined)
  assert.equal(toggleOf(result).props["aria-expanded"], true)
  for (const action of actionsOf(result)) assert.equal(action.props.tabIndex, undefined)

  const row = walk(result.tree).find((n) => n.props?.style?.transform)
  // Two actions, unmeasured in the harness, so the estimate is used — and the row goes left, which
  // is what revealing a panel at the LTR end means.
  assert.equal(row.props.style.transform, `translateX(${-2 * DEFAULT_ACTION_WIDTH}px)`)
})

test("in RTL the toggle moves the row the other way", () => {
  const result = mount({}, { direction: "rtl" })
  toggleOf(result).props.onClick()
  result.rerender()
  const row = walk(result.tree).find((n) => n.props?.style?.transform)
  assert.equal(row.props.style.transform, `translateX(${2 * DEFAULT_ACTION_WIDTH}px)`)
})

test("touchmove is registered by hand with passive: false", () => {
  // React registers `onTouchMove` passively and drops its `preventDefault` with a console warning,
  // so the row would slide sideways while the list scrolled behind it. No prop changes that.
  const result = mount()
  const registered = result.nodes
    .flatMap((node) => node.calls)
    .filter((call) => call.name === "addEventListener" && call.args[0] === "touchmove")
  assert.equal(registered.length, 1)
  assert.deepEqual(registered[0].args[2], { passive: false })
})

test("selecting an action closes the row and asks for focus back on the toggle", () => {
  // Hiding the element that has focus drops the ring on the document body, which in a long list
  // means losing your place.
  let selected = null
  const result = mount({
    actions: [{ id: "archive", label: "Archive", onSelect: () => (selected = "archive") }],
  })
  toggleOf(result).props.onClick()
  result.rerender()
  actionsOf(result)[0].props.onClick()
  result.rerender()

  assert.equal(selected, "archive")
  assert.equal(toggleOf(result).props["aria-expanded"], false)
  const focused = result.nodes.some((node) => node.calls.some((call) => call.name === "focus"))
  assert.equal(focused, true)
})

test("an action marked keepOpen leaves the panel showing", () => {
  const result = mount({
    actions: [{ id: "flag", label: "Flag", keepOpen: true, onSelect: () => {} }],
  })
  toggleOf(result).props.onClick()
  result.rerender()
  actionsOf(result)[0].props.onClick()
  result.rerender()
  assert.equal(toggleOf(result).props["aria-expanded"], true)
})

test("open and shut are reported once each, not on every pixel of a drag", () => {
  const seen = []
  const result = mount({ onOpenChange: (open) => seen.push(open) })
  toggleOf(result).props.onClick()
  result.rerender()
  toggleOf(result).props.onClick()
  result.rerender()
  assert.deepEqual(seen, [true, false])
})

test("Escape closes an open row and stops there, rather than closing what the list is inside", () => {
  const result = mount()
  toggleOf(result).props.onClick()
  result.rerender()

  let propagated = true
  result.tree.props.onKeyDown({ key: "Escape", stopPropagation: () => (propagated = false) })
  result.rerender()
  assert.equal(toggleOf(result).props["aria-expanded"], false)
  assert.equal(propagated, false)
})

test("hideToggle leaves the button out rather than hiding it", () => {
  // `[hidden]` is a user-agent rule and any `display` from a class beats it, so a hidden button
  // stays on screen while claiming to be gone.
  const result = mount({ hideToggle: true })
  assert.equal(toggleOf(result), undefined)
  assert.equal(actionsOf(result).length, 2, "the actions themselves are still there")
})

test("with no actions there is no toggle and no touch-action to claim", () => {
  const result = mount({ actions: [] })
  assert.equal(toggleOf(result), undefined)
  assert.equal(result.tree.props.style.touchAction, undefined)
  assert.equal(result.tree.props.onTouchStart, undefined)
})

test("disabled turns the gesture off and leaves the button focusable", () => {
  // `aria-disabled` rather than `disabled`: a disabled button loses focus the moment it is pressed,
  // dropping the keyboard user out of the list they were working through.
  const result = mount({ disabled: true })
  assert.equal(result.tree.props.onTouchStart, undefined)
  const toggle = toggleOf(result)
  assert.equal(toggle.props["aria-disabled"], true)
  assert.equal(toggle.props.disabled, undefined)
  toggle.props.onClick()
  result.rerender()
  assert.equal(toggleOf(result).props["aria-expanded"], false, "and it does nothing")
})

test("the controlled prop drives the row", () => {
  const result = mount({ open: false })
  assert.equal(toggleOf(result).props["aria-expanded"], false)
  result.update({ actions: ACTIONS, children: "Design review", open: true })
  assert.equal(toggleOf(result).props["aria-expanded"], true)
})

test("the row's own click is swallowed after a swipe, not passed on as a choice", () => {
  // A touch that ends after moving still synthesises a click, so without this the row's onClick —
  // opening the message that was being swiped — fires on every swipe.
  const result = mount()
  const root = result.tree
  root.props.onTouchStart({ touches: [{ clientX: 200, clientY: 100 }], timeStamp: 0 })

  // The hand-registered listener is what a real browser would call; reach it the same way.
  const listener = result.nodes
    .flatMap((node) => node.calls)
    .find((call) => call.name === "addEventListener" && call.args[0] === "touchmove").args[1]
  listener({
    touches: [{ clientX: 160, clientY: 100 }],
    timeStamp: 30,
    cancelable: true,
    preventDefault: () => {},
  })

  let reached = true
  root.props.onClickCapture({
    preventDefault: () => {},
    stopPropagation: () => (reached = false),
  })
  assert.equal(reached, false)

  // And the next ordinary tap is not swallowed too.
  let second = true
  root.props.onClickCapture({
    preventDefault: () => {},
    stopPropagation: () => (second = false),
  })
  assert.equal(second, true)
})

test("a touchcancel puts the row back instead of revealing actions nobody released onto", () => {
  // An incoming call or the system's own edge gesture arrives at the moment the row is far enough
  // across to snap open. Sharing the release handler would open it.
  const result = mount()
  const root = result.tree
  root.props.onTouchStart({ touches: [{ clientX: 200, clientY: 100 }], timeStamp: 0 })
  const listener = result.nodes
    .flatMap((node) => node.calls)
    .find((call) => call.name === "addEventListener" && call.args[0] === "touchmove").args[1]
  listener({
    touches: [{ clientX: 60, clientY: 100 }],
    timeStamp: 30,
    cancelable: true,
    preventDefault: () => {},
  })
  result.rerender()
  assert.equal(toggleOf(result).props["aria-expanded"], true, "mid-drag the panel is showing")

  root.props.onTouchCancel()
  result.rerender()
  assert.equal(toggleOf(result).props["aria-expanded"], false)
})
