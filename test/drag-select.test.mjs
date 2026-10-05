// The rubber-band selection everyone writes first stores the press position from `clientX`, draws a
// div between it and the current `clientX`, and intersects that against `getBoundingClientRect()`
// on every row. It demos perfectly in a list that fits on screen and starts lying the moment one
// does not. The cases below are written to fail against it:
//
//   - a rectangle kept in viewport coordinates, so scrolling the list slides the selection off the
//     rows it was drawn around,
//   - an absolutely positioned marquee placed from a border-box measurement, which sits a
//     border-width away from the pointer,
//   - a press on a row taken over by the container, so a reorder handle inside a selectable list
//     can never be grabbed,
//   - a marquee that appears on the first pixel of movement, so every click on the background is a
//     one-pixel drag and nothing can be clicked to clear,
//   - a drag that always replaces, so Shift and Cmd throw away the selection they were meant to add
//     to,
//   - edges that do not scroll, which makes everything below the fold unselectable,
//   - an auto-scroll that scrolls without re-deriving the rectangle, so the container moves and the
//     selection stops growing,
//   - a cancelled or escaped drag left standing at whatever it happened to cover,
//   - disabled rows swept up with the rest and silently dropped by the action that follows,
//   - and `select-none` left on the container for good, so the list's own text can never be copied.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  DRAG_SELECT_ITEM_ATTR,
  DRAG_SELECT_THRESHOLD,
  DRAG_SELECT_EDGE,
  DRAG_SELECT_SPEED,
  dragSelectItem,
  toContentPoint,
  toContentBox,
  boxBetween,
  boxesOverlap,
  dragSelectMode,
  applyDragSelection,
  boxHits,
  edgeScrollDelta,
  beginDragSelect,
  advanceDragSelect,
  DragSelect,
} = loadComponent(join(ROOT, "registry", "ui", "drag-select.tsx"))

// --- the two coordinate systems --------------------------------------------

const FRAME = { left: 100, top: 50, borderLeft: 1, borderTop: 1, scrollLeft: 0, scrollTop: 0 }

test("a viewport point becomes a content point by removing the frame and adding the scroll", () => {
  assert.deepEqual(toContentPoint({ x: 120, y: 70 }, FRAME), { x: 19, y: 19 })
  // The same pixel of the screen, after the list has been scrolled 300px down: a different row is
  // under it, and the content coordinate says so. A rectangle stored in viewport coordinates would
  // report the same point for both and select whatever had slid into place.
  assert.deepEqual(toContentPoint({ x: 120, y: 70 }, { ...FRAME, scrollTop: 300 }), { x: 19, y: 319 })
})

test("the border is removed as well as the offset, because an absolute child is placed from the padding box", () => {
  const thick = { ...FRAME, borderLeft: 8, borderTop: 8 }
  assert.deepEqual(toContentPoint({ x: 120, y: 70 }, thick), { x: 12, y: 12 })
})

test("an element's box converts origin-only — scrolling moves a row, it does not resize it", () => {
  const box = toContentBox({ left: 110, top: 60, width: 64, height: 20 }, { ...FRAME, scrollTop: 40 })
  assert.deepEqual(box, { left: 9, top: 49, width: 64, height: 20 })
})

// --- the rectangle ---------------------------------------------------------

test("a drag up and to the left is still a rectangle", () => {
  assert.deepEqual(boxBetween({ x: 80, y: 90 }, { x: 20, y: 10 }), {
    left: 20,
    top: 10,
    width: 60,
    height: 80,
  })
})

test("an edge that is merely touched is not covered, but a line drawn through a row is", () => {
  const row = { left: 0, top: 0, width: 50, height: 20 }
  // Flush against the row's right edge. Inclusive bounds here would select the row next to the one
  // the rectangle is actually over, which is the off-by-one everybody notices and nobody can
  // reproduce on purpose.
  assert.equal(boxesOverlap(row, { left: 50, top: 0, width: 10, height: 20 }), false)
  assert.equal(boxesOverlap(row, { left: 0, top: 20, width: 50, height: 10 }), false)
  // A perfectly horizontal drag has a zero-height rectangle, and it is a real gesture — dragging
  // along a row of tiles. It selects what it passes through.
  assert.equal(boxesOverlap(row, { left: 10, top: 5, width: 30, height: 0 }), true)
  // A zero-width drag down the gutter at x=0 is outside the row rather than through it: the line
  // coincides with the row's own edge, which is the touching case above.
  assert.equal(boxesOverlap(row, { left: 0, top: 0, width: 0, height: 20 }), false)
  assert.equal(boxesOverlap(row, { left: 10, top: 5, width: 1, height: 1 }), true)
  // Fully inside counts: a small row swallowed by a big rectangle is selected.
  assert.equal(boxesOverlap(row, { left: -10, top: -10, width: 200, height: 200 }), true)
})

test("hits keep the order the items were given in", () => {
  const items = [
    { id: "a", box: { left: 0, top: 0, width: 10, height: 10 } },
    { id: "b", box: { left: 0, top: 20, width: 10, height: 10 } },
    { id: "c", box: { left: 0, top: 40, width: 10, height: 10 } },
  ]
  assert.deepEqual(boxHits(items, { left: 0, top: 15, width: 10, height: 40 }), ["b", "c"])
})

// --- what a modifier means -------------------------------------------------

test("alt subtracts, shift and the platform modifier add, a bare drag replaces", () => {
  assert.equal(dragSelectMode({}), "replace")
  assert.equal(dragSelectMode({ shiftKey: true }), "add")
  assert.equal(dragSelectMode({ metaKey: true }), "add")
  assert.equal(dragSelectMode({ ctrlKey: true }), "add")
  assert.equal(dragSelectMode({ altKey: true }), "subtract")
  // Alt wins a combination: removing is the more specific intent, and a drag that both added and
  // removed would have to pick one anyway.
  assert.equal(dragSelectMode({ altKey: true, shiftKey: true }), "subtract")
})

test("adding keeps the existing order and does not duplicate what is already there", () => {
  assert.deepEqual(applyDragSelection(["b", "a"], ["a", "c"], "add"), ["b", "a", "c"])
  assert.deepEqual(applyDragSelection(["b", "a"], ["a", "c"], "replace"), ["a", "c"])
  assert.deepEqual(applyDragSelection(["b", "a", "c"], ["a", "c"], "subtract"), ["b"])
  assert.deepEqual(applyDragSelection([], ["a"], "subtract"), [])
})

// --- the edges -------------------------------------------------------------

const BOUNDS = { left: 100, top: 50, width: 200, height: 200 }

test("nothing scrolls while the pointer is away from the edges", () => {
  assert.deepEqual(edgeScrollDelta({ x: 200, y: 150 }, BOUNDS), { dx: 0, dy: 0 })
})

test("the speed tapers across the band instead of switching on at full tilt", () => {
  const entering = edgeScrollDelta({ x: 200, y: 50 + DRAG_SELECT_EDGE - 1 }, BOUNDS)
  const pinned = edgeScrollDelta({ x: 200, y: 50 }, BOUNDS)
  assert.ok(entering.dy < 0 && pinned.dy < 0)
  assert.ok(Math.abs(entering.dy) < Math.abs(pinned.dy))
  assert.equal(pinned.dy, -DRAG_SELECT_SPEED)
})

test("past the edge is not faster than at it, so leaving the window does not bolt", () => {
  assert.equal(edgeScrollDelta({ x: 200, y: -400 }, BOUNDS).dy, -DRAG_SELECT_SPEED)
  assert.equal(edgeScrollDelta({ x: 200, y: 900 }, BOUNDS).dy, DRAG_SELECT_SPEED)
})

test("the band is capped at half the container, so a short list does not scroll from its middle", () => {
  const short = { left: 0, top: 0, width: 200, height: 40 }
  assert.equal(edgeScrollDelta({ x: 100, y: 20 }, short).dy, 0)
  assert.ok(edgeScrollDelta({ x: 100, y: 1 }, short).dy < 0)
})

test("an edge of zero turns auto-scroll off rather than dividing by it", () => {
  assert.deepEqual(edgeScrollDelta({ x: 100, y: 50 }, BOUNDS, 0), { dx: 0, dy: 0 })
})

// --- the threshold ---------------------------------------------------------

test("a session is not a marquee until the pointer has travelled, and then it stays one", () => {
  const session = beginDragSelect({
    pointerId: 1,
    viewport: { x: 0, y: 0 },
    content: { x: 0, y: 0 },
    base: [],
    mode: "replace",
  })
  assert.equal(session.active, false)
  const nudged = advanceDragSelect(session, {
    viewport: { x: 1, y: 1 },
    content: { x: DRAG_SELECT_THRESHOLD - 1, y: 0 },
  })
  assert.equal(nudged.active, false)
  const armed = advanceDragSelect(nudged, {
    viewport: { x: 9, y: 0 },
    content: { x: DRAG_SELECT_THRESHOLD, y: 0 },
  })
  assert.equal(armed.active, true)
  // Back where it started, and still a drag: a marquee the user has already seen does not vanish
  // because the pointer came home.
  assert.equal(advanceDragSelect(armed, { viewport: { x: 0, y: 0 }, content: { x: 0, y: 0 } }).active, true)
})

// --- the component ---------------------------------------------------------

/**
 * One rendered DragSelect over a fake scroll container, with the geometry a browser would supply.
 *
 * Items are declared in *content* coordinates and their viewport rectangles are computed from the
 * current scroll on every read, which is the whole point: a test that handed out fixed viewport
 * rectangles could not tell a correct implementation from one that ignores scrolling.
 */
function stage({ items, value, selected = [], threshold, edge, speed, allowTouch, scrollTop = 0 } = {}) {
  const rows =
    items ??
    [
      { id: "a", left: 0, top: 0, width: 60, height: 20 },
      { id: "b", left: 0, top: 40, width: 60, height: 20 },
      { id: "c", left: 0, top: 300, width: 60, height: 20 },
    ]
  const bounds = { left: 100, top: 50, width: 200, height: 200 }
  const keyListeners = []
  const frames = []
  const changes = []

  globalThis.window = {
    addEventListener: (type, fn) => type === "keydown" && keyListeners.push(fn),
    removeEventListener: (type, fn) => {
      const at = keyListeners.indexOf(fn)
      if (at >= 0) keyListeners.splice(at, 1)
    },
  }
  globalThis.requestAnimationFrame = (fn) => {
    const handle = { fn, cancelled: false }
    frames.push(handle)
    return handle
  }
  globalThis.cancelAnimationFrame = (handle) => {
    if (handle) handle.cancelled = true
  }

  const fakeItem = (row) => ({
    getAttribute: (name) => {
      if (name === DRAG_SELECT_ITEM_ATTR) return row.id
      if (name === "aria-disabled") return row.disabled ? "true" : null
      return null
    },
    getBoundingClientRect: () => ({
      left: row.left + bounds.left + 1 - container.scrollLeft,
      top: row.top + bounds.top + 1 - container.scrollTop,
      width: row.width,
      height: row.height,
    }),
    closest: (selector) => (selector.includes(DRAG_SELECT_ITEM_ATTR) ? fakeItem(row) : null),
  })

  const result = render(DragSelect, {
    children: null,
    value,
    defaultValue: value === undefined ? selected : undefined,
    onChange: (next) => changes.push(next),
    threshold,
    edge,
    speed,
    allowTouch,
  })

  const container = result.nodes[0]
  // A real scroll container clamps: `scrollTop += 14` at the bottom of the content is a no-op, and
  // it never goes negative. The fake clamps too, because an implementation that leans on an
  // unclamped offset would otherwise pass here and drift off the content in a browser.
  const extent = (axis, size) =>
    Math.max(0, Math.max(...rows.map((row) => row[axis] + row[size])) - bounds[size])
  const scroll = { left: 0, top: scrollTop }
  const limit = { left: extent("left", "width"), top: extent("top", "height") }
  const clamped = (key) => ({
    get: () => scroll[key],
    set: (next) => {
      scroll[key] = Math.max(0, Math.min(limit[key], next))
    },
    configurable: true,
  })
  Object.defineProperties(container, { scrollLeft: clamped("left"), scrollTop: clamped("top") })
  Object.assign(container, {
    clientLeft: 1,
    clientTop: 1,
    getBoundingClientRect: () => ({ ...bounds }),
    querySelectorAll: () => rows.map(fakeItem),
    setPointerCapture: () => {},
    hasPointerCapture: () => true,
    releasePointerCapture: () => {},
  })

  /** A viewport coordinate for a point given in content coordinates. */
  const at = (x, y) => ({
    clientX: x + bounds.left + 1 - container.scrollLeft,
    clientY: y + bounds.top + 1 - container.scrollTop,
  })

  const fire = (name, event) => {
    result.tree.props[name]({
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      preventDefault: () => {},
      target: { closest: () => null },
      ...event,
    })
    result.rerender()
  }

  return {
    result,
    container,
    changes,
    bounds,
    /** The marquee element, or null when none is drawn. */
    get marquee() {
      return walk(result.tree).find((node) => node.props?.["aria-hidden"] === "true") ?? null
    },
    get latest() {
      return changes.at(-1)
    },
    down: (x, y, event) => fire("onPointerDown", { ...at(x, y), ...event }),
    /** Viewport-absolute press, for the edge cases where the content point is not the subject. */
    downAt: (clientX, clientY, event) => fire("onPointerDown", { clientX, clientY, ...event }),
    move: (x, y, event) => fire("onPointerMove", { ...at(x, y), ...event }),
    moveAt: (clientX, clientY, event) => fire("onPointerMove", { clientX, clientY, ...event }),
    up: (event) => fire("onPointerUp", event),
    cancel: (event) => fire("onPointerCancel", event),
    escape: () => {
      for (const fn of [...keyListeners]) fn({ key: "Escape", preventDefault: () => {} })
      result.rerender()
    },
    /** Runs the frames the component has queued, the way a browser would, once. */
    tick: () => {
      const due = frames.filter((handle) => !handle.cancelled)
      frames.length = 0
      for (const handle of due) handle.fn()
      result.rerender()
    },
    get pendingFrames() {
      return frames.filter((handle) => !handle.cancelled).length
    },
  }
}

test("no marquee is drawn until the press has become a drag", () => {
  const s = stage()
  assert.equal(s.marquee, null)
  s.down(10, 10)
  assert.equal(s.marquee, null)
  s.move(10 + DRAG_SELECT_THRESHOLD - 1, 10)
  assert.equal(s.marquee, null)
  assert.deepEqual(s.changes, [])
})

test("the marquee is placed in content coordinates, which is where an absolute child is placed from", () => {
  const s = stage()
  s.down(10, 10)
  s.move(70, 90)
  const marquee = s.marquee
  assert.ok(marquee)
  assert.deepEqual(marquee.props.style, { left: 10, top: 10, width: 60, height: 80 })
  assert.match(marquee.props.className, /pointer-events-none/)
  assert.match(marquee.props.className, /absolute/)
})

test("the rows the rectangle covers are selected, and the ones it misses are not", () => {
  const s = stage()
  s.down(0, 0)
  s.move(30, 45)
  assert.deepEqual(s.latest, ["a", "b"])
  // Shrinking back over one row deselects the other: the selection follows the rectangle rather
  // than accumulating everything the pointer has passed.
  s.move(30, 10)
  assert.deepEqual(s.latest, ["a"])
})

test("the selection keeps up when the list is scrolled under a still pointer", () => {
  // The viewport-coordinates bug in one case. The pointer is held at the bottom edge; auto-scroll
  // brings the row at content y=300 into view; the rectangle has to grow to reach it even though no
  // pointermove ever arrives.
  const s = stage()
  s.down(0, 0)
  s.moveAt(s.bounds.left + s.bounds.width / 2, s.bounds.top + s.bounds.height - 1)
  assert.deepEqual(s.latest, ["a", "b"])
  const before = s.container.scrollTop
  for (let i = 0; i < 40; i += 1) s.tick()
  assert.ok(s.container.scrollTop > before, "the container should have scrolled itself")
  assert.deepEqual(s.latest, ["a", "b", "c"])
})

test("a press that lands on a row is left to the row, so a drag handle inside the list still works", () => {
  const s = stage()
  s.down(0, 0, { target: { closest: (selector) => (selector.includes(DRAG_SELECT_ITEM_ATTR) ? {} : null) } })
  s.move(60, 60)
  assert.equal(s.marquee, null)
  assert.deepEqual(s.changes, [])
})

test("a press inside an opted-out region is left alone too", () => {
  const s = stage()
  s.down(0, 0, { target: { closest: (selector) => (selector.includes("data-drag-select-ignore") ? {} : null) } })
  s.move(60, 60)
  assert.equal(s.marquee, null)
})

test("a right-click does not draw a rectangle, and neither does a finger by default", () => {
  const right = stage()
  right.down(0, 0, { button: 2 })
  right.move(60, 60)
  assert.equal(right.marquee, null)

  const finger = stage()
  finger.down(0, 0, { pointerType: "touch" })
  finger.move(60, 60)
  assert.equal(finger.marquee, null, "a touch drag from empty space is how the list is panned")

  const allowed = stage({ allowTouch: true })
  allowed.down(0, 0, { pointerType: "touch" })
  allowed.move(60, 60)
  assert.ok(allowed.marquee)
})

test("a click on the background clears the selection; a modified click builds on it", () => {
  const plain = stage({ selected: ["a", "b"] })
  plain.down(150, 150)
  plain.up()
  assert.deepEqual(plain.latest, [])

  const held = stage({ selected: ["a", "b"] })
  held.down(150, 150, { shiftKey: true })
  held.up()
  assert.deepEqual(held.changes, [], "nothing was dragged and nothing should have been thrown away")
})

test("shift adds to what was already selected and alt takes away from it", () => {
  const added = stage({ selected: ["c"] })
  added.down(0, 0, { shiftKey: true })
  added.move(30, 45)
  assert.deepEqual(added.latest, ["c", "a", "b"])

  const removed = stage({ selected: ["a", "b", "c"] })
  removed.down(0, 0, { altKey: true })
  removed.move(30, 45)
  assert.deepEqual(removed.latest, ["c"])
})

test("a row marked aria-disabled is never swept up", () => {
  const s = stage({
    items: [
      { id: "a", left: 0, top: 0, width: 60, height: 20 },
      { id: "locked", left: 0, top: 40, width: 60, height: 20, disabled: true },
    ],
  })
  s.down(0, 0)
  s.move(30, 45)
  assert.deepEqual(s.latest, ["a"])
})

test("Escape puts the selection back and takes the rectangle down", () => {
  const s = stage({ selected: ["c"] })
  s.down(0, 0)
  s.move(30, 45)
  assert.deepEqual(s.latest, ["a", "b"])
  s.escape()
  assert.deepEqual(s.latest, ["c"])
  assert.equal(s.marquee, null)
})

test("a cancelled pointer never released onto anything, so the selection goes back", () => {
  const s = stage({ selected: ["c"] })
  s.down(0, 0)
  s.move(30, 45)
  s.cancel()
  assert.deepEqual(s.latest, ["c"])
  assert.equal(s.marquee, null)
})

test("a pointer that is not the one being tracked is ignored", () => {
  const s = stage()
  s.down(0, 0)
  s.move(30, 45, { pointerId: 7 })
  assert.equal(s.marquee, null)
  assert.deepEqual(s.changes, [])
})

test("text stays selectable except while a rectangle is up", () => {
  const s = stage()
  assert.doesNotMatch(s.result.tree.props.className, /select-none/)
  s.down(0, 0)
  s.move(30, 45)
  assert.match(s.result.tree.props.className, /select-none/)
  s.up()
  assert.doesNotMatch(s.result.tree.props.className, /select-none/)
})

test("the container claims no ARIA role of its own — it is the consumer's list", () => {
  const s = stage()
  assert.equal(s.result.tree.props.role, undefined)
  assert.equal(s.result.tree.props["aria-label"], undefined)
})

test("releasing stops the frame loop, and so does unmounting mid-drag", () => {
  const released = stage()
  released.down(0, 0)
  released.moveAt(released.bounds.left + released.bounds.width / 2, released.bounds.top + released.bounds.height - 1)
  released.up()
  released.tick()
  assert.equal(released.pendingFrames, 0)

  const torn = stage()
  torn.down(0, 0)
  torn.moveAt(torn.bounds.left + torn.bounds.width / 2, torn.bounds.top + torn.bounds.height - 1)
  assert.ok(torn.pendingFrames > 0)
  torn.result.unmount()
  assert.equal(torn.pendingFrames, 0)
})

test("the item helper writes the attribute the container looks for", () => {
  assert.deepEqual(dragSelectItem("file-1"), { [DRAG_SELECT_ITEM_ATTR]: "file-1" })
})
