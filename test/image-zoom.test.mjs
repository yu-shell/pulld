// A zoom frame is judged on one thing: whether the detail you aimed at is the detail you get. Every
// case below is written to fail against a version that looks fine in a browser for about a second:
//
//   - `scale()` about the centre of the frame, which is the one-line version everybody writes and
//     which pushes whatever you pointed at toward the edge, faster the further out it started,
//   - clamping the scale after solving the translation instead of before, so every wheel notch past
//     the maximum slides the picture sideways while the zoom level does not move at all,
//   - reading `deltaY` without `deltaMode`, which is correct in Chrome and sixteen times too slow
//     in Firefox and only ever noticed by somebody who has both open,
//   - a linear `1 - delta * k` zoom step, where scrolling in and back out lands lower than it
//     started and the picture creeps smaller all afternoon,
//   - binding the wheel through React's `onWheel`, which several browsers attach passively — the
//     preventDefault is dropped and the frame zooms while the page scrolls out from under it,
//   - taking the pan limit from the frame rather than from the content, which lets a letterboxed
//     picture be dragged half off screen,
//   - and a pinch that reads its own midpoint after overwriting it, which zooms but refuses to be
//     moved while zooming.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  clampScale,
  clampPan,
  zoomAt,
  contentPointAt,
  wheelScaleFactor,
  normalizeWheelDelta,
  IDENTITY_TRANSFORM,
  ImageZoom,
} = loadComponent(join(ROOT, "registry", "ui", "image-zoom.tsx"))

const close = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`)

/** A 400x300 frame with content that exactly fills it. */
const FRAME = { width: 400, height: 300 }

// --- the anchor: what is under the pointer stays under the pointer ------------------------------

test("zooming in leaves the content point under the cursor exactly where it was", () => {
  // A corner, an edge and the middle. The centre-origin version passes only the last of these,
  // which is why a demo on a centred subject never reveals it.
  for (const point of [
    { x: 0, y: 0 },
    { x: 400, y: 300 },
    { x: 380, y: 20 },
    { x: 200, y: 150 },
  ]) {
    let transform = IDENTITY_TRANSFORM
    const before = contentPointAt(transform, point)
    for (const scale of [1.2, 2, 3.7, 8]) {
      transform = zoomAt(transform, point, scale, 1, 8)
      const after = contentPointAt(transform, point)
      close(after.x, before.x, 1e-9)
      close(after.y, before.y, 1e-9)
    }
  }
})

test("zooming out from a panned position also holds its anchor", () => {
  const panned = { scale: 4, x: -600, y: -450 }
  const point = { x: 90, y: 240 }
  const before = contentPointAt(panned, point)
  const after = contentPointAt(zoomAt(panned, point, 1.5, 1, 8), point)
  close(after.x, before.x)
  close(after.y, before.y)
})

test("the translation is solved about the pointer, not about the middle of the frame", () => {
  // Doubling about the top-left corner cannot move the content at all; doubling about the centre
  // of a 400x300 frame would put it at (-200, -150). The numbers are spelled out so a formula that
  // is merely self-consistent — and wrong — cannot pass by agreeing with its own inverse.
  const corner = zoomAt(IDENTITY_TRANSFORM, { x: 0, y: 0 }, 2, 1, 8)
  assert.deepEqual(corner, { scale: 2, x: 0, y: 0 })

  const middle = zoomAt(IDENTITY_TRANSFORM, { x: 200, y: 150 }, 2, 1, 8)
  assert.deepEqual(middle, { scale: 2, x: -200, y: -150 })

  const right = zoomAt(IDENTITY_TRANSFORM, { x: 400, y: 300 }, 3, 1, 8)
  assert.deepEqual(right, { scale: 3, x: -800, y: -600 })
})

test("a zoom request past the maximum moves nothing at all", () => {
  // The clamp-after-solving bug lives here and nowhere else: the scale is already pinned at 8, so
  // the only way the picture can move is if the translation was computed for the scale that was
  // asked for rather than the one that was applied.
  const atMax = { scale: 8, x: -1000, y: -700 }
  assert.deepEqual(zoomAt(atMax, { x: 30, y: 250 }, 12, 1, 8), atMax)
  assert.deepEqual(zoomAt(atMax, { x: 30, y: 250 }, 1e6, 1, 8), atMax)
})

test("a zoom request past the minimum moves nothing at all", () => {
  const atMin = { scale: 1, x: 0, y: 0 }
  assert.deepEqual(zoomAt(atMin, { x: 380, y: 10 }, 0.2, 1, 8), atMin)
})

test("a degenerate starting scale cannot put NaN into the transform", () => {
  for (const broken of [
    { scale: 0, x: 0, y: 0 },
    { scale: Number.NaN, x: 0, y: 0 },
    { scale: Number.POSITIVE_INFINITY, x: 0, y: 0 },
  ]) {
    const next = zoomAt(broken, { x: 100, y: 100 }, 2, 1, 8)
    assert.ok(Number.isFinite(next.scale) && Number.isFinite(next.x) && Number.isFinite(next.y))
  }
  const point = contentPointAt({ scale: 0, x: 0, y: 0 }, { x: 5, y: 5 })
  assert.deepEqual(point, { x: 0, y: 0 })
})

// --- the scale limits ---------------------------------------------------------------------------

test("clampScale holds both ends and rescues a non-number", () => {
  assert.equal(clampScale(0.1, 1, 8), 1)
  assert.equal(clampScale(99, 1, 8), 8)
  assert.equal(clampScale(3, 1, 8), 3)
  // NaN fails every comparison, so a clamp written as two ifs lets it straight through and the
  // frame stops responding with nothing in the console to say why.
  assert.equal(clampScale(Number.NaN, 1, 8), 1)
  assert.equal(clampScale(Number.POSITIVE_INFINITY, 1, 8), 8)
})

// --- wheel units --------------------------------------------------------------------------------

test("a line of wheel delta is sixteen pixels, and a page is four hundred", () => {
  // Firefox reports deltaMode 1. Ignoring it is not a crash, it is a zoom that feels broken in one
  // browser and perfect in the one the developer had open.
  assert.equal(normalizeWheelDelta(3, 1), 48)
  assert.equal(normalizeWheelDelta(-3, 1), -48)
  assert.equal(normalizeWheelDelta(0.25, 2), 100)
  assert.equal(normalizeWheelDelta(100, 0), 100)
  close(wheelScaleFactor(3, 1), wheelScaleFactor(48, 0))
})

test("scrolling back the same distance returns to the scale it started from", () => {
  // The property a linear step does not have. Without it every in-and-out round trip loses a
  // little, and a minute of fiddling leaves the picture visibly smaller than it began.
  for (const delta of [20, 100, -60]) {
    close(wheelScaleFactor(delta) * wheelScaleFactor(-delta), 1, 1e-12)
  }
  let transform = IDENTITY_TRANSFORM
  const point = { x: 120, y: 60 }
  transform = zoomAt(transform, point, transform.scale * wheelScaleFactor(-100), 1, 8)
  transform = zoomAt(transform, point, transform.scale * wheelScaleFactor(100), 1, 8)
  close(transform.scale, 1, 1e-12)
  close(transform.x, 0, 1e-9)
  close(transform.y, 0, 1e-9)
})

test("one enormous wheel event is capped instead of jumping to the limit", () => {
  assert.equal(normalizeWheelDelta(100000, 0), 120)
  assert.equal(normalizeWheelDelta(-100000, 0), -120)
  assert.equal(normalizeWheelDelta(50, 2), 120, "a page-mode flick is capped too")
  close(wheelScaleFactor(100000), wheelScaleFactor(120))
})

test("a non-finite wheel delta changes nothing rather than poisoning the scale", () => {
  assert.equal(normalizeWheelDelta(Number.NaN, 0), 0)
  assert.equal(wheelScaleFactor(Number.NaN, 0), 1)
  assert.equal(wheelScaleFactor(undefined, 0), 1)
})

// --- the pan limits -------------------------------------------------------------------------

test("zoomed in, neither edge of the content can be dragged inside the frame", () => {
  const zoomed = { scale: 2, x: 0, y: 0 }
  // 400 wide at 2x is 800 drawn, so x may run from -400 (right edge flush) to 0 (left edge flush).
  assert.deepEqual(clampPan({ ...zoomed, x: 50, y: 30 }, FRAME), { scale: 2, x: 0, y: 0 })
  assert.deepEqual(clampPan({ ...zoomed, x: -900, y: -700 }, FRAME), { scale: 2, x: -400, y: -300 })
  assert.deepEqual(clampPan({ ...zoomed, x: -120, y: -80 }, FRAME), { scale: 2, x: -120, y: -80 })
})

test("content smaller than the frame is centred, not pinned to a corner", () => {
  // Reachable whenever minScale is below 1. Clamping to [extent - drawn, 0] here would let a
  // zoomed-out picture sit in the top-left with a wedge of background beside it.
  const out = clampPan({ scale: 0.5, x: 999, y: -999 }, FRAME)
  assert.deepEqual(out, { scale: 0.5, x: 100, y: 75 })
})

test("the pan limit comes from the content's own size, not from the frame's", () => {
  // A caller who gives the frame its own height gets letterboxing: 400x300 frame, content only
  // 400x150. Measuring against the frame would allow x and y to run to -400/-300 at 2x, which is
  // the picture dragged half out of the box.
  const letterboxed = { width: 400, height: 150 }
  const out = clampPan({ scale: 2, x: -999, y: -999 }, FRAME, letterboxed)
  assert.equal(out.x, -400)
  assert.equal(out.y, 0, "300 tall drawn in a 300 frame has nowhere to go, so it is centred")
})

test("a non-finite offset is recovered instead of being written into the style", () => {
  const out = clampPan({ scale: 2, x: Number.NaN, y: 10 }, FRAME)
  assert.ok(Number.isFinite(out.x))
  assert.equal(out.y, 0)
})

// --- the component --------------------------------------------------------------------------

const frameOf = (result) => byRole(walk(result.tree), "group")[0]
const contentOf = (result) =>
  walk(result.tree).find((node) => typeof node.props?.style?.transform === "string")
const buttonNamed = (result, label) =>
  byTag(walk(result.tree), "button").find((node) => node.props["aria-label"] === label)
const percentOf = (result) =>
  walk(result.tree).find((node) => node.props?.["aria-live"] === "polite").props.children[0]

const child = () => ({ type: "img", props: { src: "/plan.png", alt: "Site plan" } })

function keyEvent(key) {
  const event = { key, altKey: false, ctrlKey: false, metaKey: false, prevented: false }
  event.preventDefault = () => {
    event.prevented = true
  }
  return event
}

test("the frame is a labelled tab stop, because none of the gestures have a keyboard form", () => {
  const result = render(ImageZoom, { children: child(), "aria-label": "Site plan" })
  const frame = frameOf(result)
  assert.equal(frame.props.tabIndex, 0)
  assert.equal(frame.props["aria-label"], "Site plan")
  assert.equal(contentOf(result).props.style.transform, "translate(0px, 0px) scale(1)")
  result.unmount()
})

test("the wheel is bound by hand with passive false, not through React", () => {
  const result = render(ImageZoom, { children: child() })

  assert.equal(
    frameOf(result).props.onWheel,
    undefined,
    "React attaches onWheel passively in several browsers, so its preventDefault is dropped"
  )

  const [frameNode] = result.nodes
  const added = frameNode.calls.filter(
    (call) => call.name === "addEventListener" && call.args[0] === "wheel"
  )
  assert.equal(added.length, 1, "the frame subscribed to the wheel more than once, or not at all")
  assert.equal(
    added[0].args[2]?.passive,
    false,
    "a passive wheel listener cannot preventDefault — the page scrolls while the frame zooms"
  )

  result.unmount()
  assert.equal(
    frameNode.calls.filter((c) => c.name === "removeEventListener" && c.args[0] === "wheel").length,
    1,
    "the wheel listener outlived the component"
  )
})

test("at rest only zooming in is offered", () => {
  const result = render(ImageZoom, { children: child() })
  assert.equal(percentOf(result), 100)
  assert.equal(buttonNamed(result, "Zoom in").props["aria-disabled"], false)
  // aria-disabled rather than disabled: a real `disabled` drops the button out of the tab order
  // the moment you reach the limit, moving focus somewhere else mid-interaction.
  assert.equal(buttonNamed(result, "Zoom out").props["aria-disabled"], true)
  assert.equal(buttonNamed(result, "Reset zoom").props["aria-disabled"], true)
  result.unmount()
})

test("the zoom buttons step by the multiplier and stop at the limits", () => {
  const result = render(ImageZoom, { children: child(), zoomStep: 2, maxScale: 4 })

  buttonNamed(result, "Zoom in").props.onClick()
  result.rerender()
  assert.equal(percentOf(result), 200)

  buttonNamed(result, "Zoom in").props.onClick()
  result.rerender()
  assert.equal(percentOf(result), 400)
  assert.equal(buttonNamed(result, "Zoom in").props["aria-disabled"], true)

  // A button that says it is disabled has to act disabled too; aria-disabled alone still fires.
  buttonNamed(result, "Zoom in").props.onClick()
  result.rerender()
  assert.equal(percentOf(result), 400)

  buttonNamed(result, "Reset zoom").props.onClick()
  result.rerender()
  assert.equal(percentOf(result), 100)
  result.unmount()
})

test("a control that says it is disabled does not report a change either", () => {
  const seen = []
  const result = render(ImageZoom, {
    children: child(),
    onTransformChange: (next) => seen.push(next),
  })
  // At rest, zooming out and resetting are both no-ops once the scale is clamped — so the picture
  // stays put whether or not the handler guards itself, and that is exactly why this is the test
  // worth having. What the clamp does not swallow is the notification: without the guard, every
  // prod at a dead button hands a controlled parent a "new" transform to re-render and store.
  buttonNamed(result, "Zoom out").props.onClick()
  buttonNamed(result, "Reset zoom").props.onClick()
  result.rerender()
  assert.deepEqual(seen, [], "a disabled control told its parent something had changed")
  result.unmount()
})

test("the keyboard reaches everything the wheel does", () => {
  const result = render(ImageZoom, { children: child(), zoomStep: 2 })

  const plus = keyEvent("+")
  frameOf(result).props.onKeyDown(plus)
  result.rerender()
  assert.equal(percentOf(result), 200)
  assert.ok(plus.prevented, "the page scrolled or the character was typed as well")

  frameOf(result).props.onKeyDown(keyEvent("-"))
  result.rerender()
  assert.equal(percentOf(result), 100)

  frameOf(result).props.onKeyDown(keyEvent("="))
  result.rerender()
  assert.equal(percentOf(result), 200, "= is + without the shift key, and is the same request")

  frameOf(result).props.onKeyDown(keyEvent("0"))
  result.rerender()
  assert.equal(percentOf(result), 100)
  result.unmount()
})

test("a shortcut the browser owns is left to the browser", () => {
  const result = render(ImageZoom, { children: child() })
  const event = keyEvent("+")
  event.ctrlKey = true
  frameOf(result).props.onKeyDown(event)
  result.rerender()
  assert.equal(percentOf(result), 100, "ctrl+plus is the browser's own zoom, not this component's")
  assert.ok(!event.prevented)
  result.unmount()
})

test("the arrow keys only claim the page's scrolling when there is something to pan", () => {
  const resting = render(ImageZoom, { children: child() })
  const idle = keyEvent("ArrowDown")
  frameOf(resting).props.onKeyDown(idle)
  assert.ok(
    !idle.prevented,
    "a frame with nothing to pan swallowed the arrow key and froze the page"
  )
  resting.unmount()

  const zoomed = render(ImageZoom, {
    children: child(),
    transform: { scale: 3, x: 0, y: 0 },
    onTransformChange: () => {},
  })
  const active = keyEvent("ArrowDown")
  frameOf(zoomed).props.onKeyDown(active)
  assert.ok(active.prevented)
  zoomed.unmount()
})

test("touch-action lets the page scroll until the content no longer fits", () => {
  const resting = render(ImageZoom, { children: child() })
  assert.equal(
    frameOf(resting).props.style.touchAction,
    "pan-y",
    "a full-width frame at rest is a hole you cannot scroll through on a phone"
  )
  resting.unmount()

  const zoomed = render(ImageZoom, {
    children: child(),
    transform: { scale: 2, x: 0, y: 0 },
    onTransformChange: () => {},
  })
  assert.equal(frameOf(zoomed).props.style.touchAction, "none")
  zoomed.unmount()
})

test("a controlled frame reports the change and waits to be told", () => {
  const seen = []
  const result = render(ImageZoom, {
    children: child(),
    transform: { scale: 1, x: 0, y: 0 },
    onTransformChange: (next) => seen.push(next),
    zoomStep: 2,
  })

  buttonNamed(result, "Zoom in").props.onClick()
  result.rerender()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].scale, 2)
  assert.equal(percentOf(result), 100, "a controlled frame moved itself instead of asking")

  result.update({
    children: child(),
    transform: seen[0],
    onTransformChange: (next) => seen.push(next),
    zoomStep: 2,
  })
  assert.equal(percentOf(result), 200)
  result.unmount()
})

test("a controlled scale outside the limits is clamped on the way in", () => {
  const result = render(ImageZoom, {
    children: child(),
    transform: { scale: 50, x: 0, y: 0 },
    onTransformChange: () => {},
    maxScale: 4,
  })
  assert.equal(percentOf(result), 400)
  result.unmount()
})

test("the percentage is announced, and the glyphs are not", () => {
  const result = render(ImageZoom, { children: child() })
  const live = walk(result.tree).find((node) => node.props?.["aria-live"] === "polite")
  assert.equal(live.props["aria-atomic"], "true")
  for (const svg of byTag(walk(result.tree), "svg")) {
    assert.equal(svg.props["aria-hidden"], "true", "a decorative glyph is being read out")
  }
  result.unmount()
})

test("the controls can be left out without taking the keyboard with them", () => {
  const result = render(ImageZoom, { children: child(), showControls: false })
  assert.equal(byTag(walk(result.tree), "button").length, 0)
  frameOf(result).props.onKeyDown(keyEvent("+"))
  result.rerender()
  assert.equal(contentOf(result).props.style.transform, "translate(0px, 0px) scale(1.5)")
  result.unmount()
})

const touch = (id, x, y) => ({
  pointerId: id,
  pointerType: "touch",
  clientX: x,
  clientY: y,
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
})

test("two fingers zoom by how far apart they are now, not by how far apart they started", () => {
  const result = render(ImageZoom, { children: child() })
  const frame = () => frameOf(result)

  frame().props.onPointerDown(touch(1, 100, 100))
  frame().props.onPointerDown(touch(2, 200, 100))
  result.rerender()

  frame().props.onPointerMove(touch(2, 300, 100))
  result.rerender()
  assert.equal(percentOf(result), 200, "100px apart became 200px apart, so 1x becomes 2x")

  // The second move is what separates "measured against the last frame" from "measured against the
  // start of the gesture". 200 to 300 is another half again, so 2x becomes 3x; a version that kept
  // comparing with the original 100px would read the spread as 3x and land on 6x instead.
  frame().props.onPointerMove(touch(2, 400, 100))
  result.rerender()
  assert.equal(percentOf(result), 300)

  frame().props.onPointerUp(touch(2, 400, 100))
  frame().props.onPointerUp(touch(1, 100, 100))
  result.rerender()

  // With the fingers lifted there is no pinch left to continue, so a stray move changes nothing.
  frame().props.onPointerMove(touch(2, 800, 100))
  result.rerender()
  assert.equal(percentOf(result), 300)
  result.unmount()
})

test("the controls do not start a drag through the picture underneath them", () => {
  const result = render(ImageZoom, { children: child() })
  const cluster = walk(result.tree).find(
    (node) => node.props?.onPointerDown && node.props?.className?.includes("absolute")
  )
  let stopped = false
  cluster.props.onPointerDown({ stopPropagation: () => (stopped = true) })
  assert.ok(stopped, "pressing a zoom button also grabbed the picture behind it")
  result.unmount()
})
