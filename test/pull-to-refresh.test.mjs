// The pull-to-refresh everyone writes first reads `clientY` in React's `onTouchMove`, compares
// `scrollTop` to 0 on every move, and calls the loader when the finger lifts past a threshold. It
// looks finished on a phone, in the one direction it was tried. The cases below are written to fail
// against it:
//
//   - React attaches `onTouchMove` passively, so its `preventDefault` is dropped and the browser
//     overscrolls — or runs its own pull-to-refresh — behind the indicator,
//   - a negative `scrollTop`, which is iOS saying it is already sliding the content down, read as
//     "even more at the top than zero" and pulled a second time on top of the bounce,
//   - `scrollTop === 0` asked on every move, so a list still gliding to a halt under a steadying
//     finger turns into a pull nobody asked for,
//   - a two-finger pinch and a sideways swipe on a row both opening the indicator,
//   - a scroll upward that becomes a pull the instant the finger drifts back down past its origin,
//   - raw finger travel used as the offset, so the list can be dragged to the bottom of the screen,
//   - a touch-only refresh, which to a keyboard or a screen reader is no refresh at all,
//   - `disabled` on the button, which drops focus out of the list the moment it is pressed,
//   - and a rejected loader, which leaves the spinner turning for the rest of the session.
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
  DEFAULT_PULL_THRESHOLD,
  SCROLL_TOP_EPSILON,
  SETTLE_MS,
  AXIS_SLOP,
  resistedDistance,
  canBeginPull,
  hasScrolledAway,
  decideAxis,
  beginGesture,
  advanceGesture,
  isArmed,
  PullToRefresh,
} = loadComponent(join(ROOT, "registry", "ui", "pull-to-refresh.tsx"), {
  stubs: {
    "lucide-react": {
      ArrowDown: icon("arrow-down"),
      Loader2: icon("loader"),
      RefreshCw: icon("refresh"),
    },
  },
})

const OPTS = { threshold: 64, maxDistance: 128 }

// --- the resistance curve --------------------------------------------------

test("the pull is one-to-one up to the threshold, so the arming point is where the label says", () => {
  // Anything else and "release to refresh" appears at a distance the person cannot predict: they
  // have moved 64px and the indicator claims 41, or 90.
  for (const raw of [0, 1, 20, 63, 64]) {
    assert.equal(resistedDistance(raw, 64, 128), raw)
  }
})

test("past the threshold it tapers and never reaches maxDistance, however far the finger goes", () => {
  const far = resistedDistance(100000, 64, 128)
  assert.ok(far < 128, `expected under the 128 ceiling, got ${far}`)
  assert.ok(far > 127, `expected to approach the ceiling, got ${far}`)
  // Monotonic the whole way: a curve that doubles back makes the list twitch upward mid-pull.
  let previous = -1
  for (let raw = 0; raw <= 600; raw += 7) {
    const d = resistedDistance(raw, 64, 128)
    assert.ok(d > previous, `not increasing at raw=${raw}: ${d} after ${previous}`)
    assert.ok(d <= 128, `over the ceiling at raw=${raw}: ${d}`)
    previous = d
  }
})

test("an upward or absent distance is zero rather than a negative transform", () => {
  assert.equal(resistedDistance(-40, 64, 128), 0)
  assert.equal(resistedDistance(0, 64, 128), 0)
  // NaN is what a clientY read off a touch that has already ended gives, and `translateY(NaNpx)` is
  // dropped by the browser without a word — the list simply stops following the finger.
  assert.equal(resistedDistance(NaN, 64, 128), 0)
})

test("a maxDistance at or below the threshold pins the pull at the threshold", () => {
  assert.equal(resistedDistance(500, 64, 64), 64)
  assert.equal(resistedDistance(500, 64, 10), 64)
})

// --- when a pull may begin -------------------------------------------------

test("a negative scrollTop refuses the pull: the browser is already bouncing the content down", () => {
  // The bug this pins is a sign error in disguise. `scrollTop <= 0` reads iOS's rubber-band as
  // "at the top, or better", and the translate then lands on top of a slide the browser is already
  // performing, so one pull moves the list twice as far as the finger.
  assert.equal(canBeginPull(-1, Infinity), false)
  assert.equal(canBeginPull(-40, Infinity), false)
})

test("content above the fold refuses the pull", () => {
  assert.equal(canBeginPull(200, Infinity), false)
  assert.equal(canBeginPull(SCROLL_TOP_EPSILON, Infinity), false)
})

test("a sub-pixel scroll position still counts as the top", () => {
  // Browser zoom and fractional device pixel ratios park a scroller at 0.5. Comparing against zero
  // exactly is how a list refuses to refresh at some zoom levels and not others.
  assert.equal(canBeginPull(0, Infinity), true)
  assert.equal(canBeginPull(0.5, Infinity), true)
  assert.equal(canBeginPull(-0.5, Infinity), true)
})

test("a list still gliding refuses the pull, however close to the top it is", () => {
  // The misfire the scroll position cannot catch: momentum carries the list to the top, the finger
  // comes down to stop it, and `scrollTop === 0` is delighted to call that a pull.
  assert.equal(canBeginPull(0, 0), false)
  assert.equal(canBeginPull(0, SETTLE_MS - 1), false)
  assert.equal(canBeginPull(0, SETTLE_MS), true)
})

test("a scroller that has never scrolled is at rest", () => {
  // The first gesture after mount has no previous scroll to be measured against, and must not be
  // refused for it.
  assert.equal(canBeginPull(0, Infinity), true)
})

test("only downward scrolling takes a pull away, never a scroll position granting one", () => {
  assert.equal(hasScrolledAway(200), true)
  assert.equal(hasScrolledAway(0), false)
  // Negative is the bounce again. It must not end a pull in progress either, or every iOS pull dies
  // on its first frame.
  assert.equal(hasScrolledAway(-30), false)
})

// --- which way the finger went --------------------------------------------

test("the axis stays undecided inside the slop, so a tap is not a direction", () => {
  assert.equal(decideAxis(0, 0), "undecided")
  assert.equal(decideAxis(AXIS_SLOP - 1, AXIS_SLOP - 1), "undecided")
})

test("a sideways drag is horizontal and a tie goes to horizontal", () => {
  assert.equal(decideAxis(40, 3), "horizontal")
  // A carousel or a swipeable row inside the list owns the diagonal. Refusing the pull costs one
  // more try; stealing the swipe breaks the thing under the finger.
  assert.equal(decideAxis(40, 40), "horizontal")
})

test("a downward drag past the slop is vertical", () => {
  assert.equal(decideAxis(2, 40), "vertical")
})

// --- the gesture ----------------------------------------------------------

const move = (over) => ({
  x: 50,
  y: 100,
  scrollTop: 0,
  touchCount: 1,
  cancelable: true,
  ...over,
})

const pull = (dy, over) => {
  const start = beginGesture(50, 100)
  return advanceGesture(start, move({ y: 100 + dy, ...over }), OPTS)
}

test("a plain downward pull is claimed and shows the resisted distance", () => {
  const { gesture, claim } = pull(40)
  assert.equal(claim, true, "the event has to be claimed or the browser overscrolls behind it")
  assert.equal(gesture.distance, 40)
  assert.equal(gesture.axis, "vertical")
  assert.equal(gesture.abandoned, false)
})

test("a second finger abandons the gesture instead of pulling", () => {
  // A pinch-zoom starting inside the list otherwise drags the indicator open as the fingers spread.
  const { gesture, claim } = pull(40, { touchCount: 2 })
  assert.equal(gesture.abandoned, true)
  assert.equal(gesture.distance, 0)
  assert.equal(claim, false)
})

test("a sideways swipe abandons the gesture instead of pulling", () => {
  const { gesture, claim } = pull(10, { x: 140 })
  assert.equal(gesture.abandoned, true)
  assert.equal(claim, false)
})

test("the scroller moving down under the finger abandons the pull", () => {
  const { gesture, claim } = pull(40, { scrollTop: 300 })
  assert.equal(gesture.abandoned, true)
  assert.equal(claim, false)
})

test("a non-cancelable move abandons the pull rather than warning on every frame", () => {
  // `cancelable: false` is the browser saying the sequence is a scroll now. `preventDefault` there
  // does nothing but log, and drawing the indicator anyway puts it on top of an overscroll that
  // cannot be stopped.
  const { gesture, claim } = pull(40, { cancelable: false })
  assert.equal(gesture.abandoned, true)
  assert.equal(claim, false)
})

test("an upward drag abandons the gesture, and drifting back down does not revive it", () => {
  // The sequence this pins: at the top, the finger goes up 50px to scroll into the list, then comes
  // back down 120px. Held at zero instead of abandoned, that second half is indistinguishable from a
  // fresh pull, and the list refreshes in the middle of a scroll.
  const start = beginGesture(50, 100)
  const up = advanceGesture(start, move({ y: 50 }), OPTS)
  assert.equal(up.gesture.abandoned, true)
  assert.equal(up.claim, false)

  const backDown = advanceGesture(up.gesture, move({ y: 170 }), OPTS)
  assert.equal(backDown.gesture.abandoned, true, "an abandoned gesture stays abandoned")
  assert.equal(backDown.gesture.distance, 0)
  assert.equal(backDown.claim, false)
})

test("a move inside the slop decides nothing and abandons nothing", () => {
  // The distinction that makes a slow pull possible at all: undecided is not the same as refused, so
  // the very next move in the same sequence still gets to become a pull.
  const start = beginGesture(50, 100)
  const tiny = advanceGesture(start, move({ y: 103 }), OPTS)
  assert.equal(tiny.gesture.axis, "undecided")
  assert.equal(tiny.gesture.abandoned, false)
  assert.equal(tiny.claim, false)

  const then = advanceGesture(tiny.gesture, move({ y: 160 }), OPTS)
  assert.equal(then.claim, true)
  assert.equal(then.gesture.distance, 60)
})

test("an axis once decided is not re-decided, so a pull can curve without dying", () => {
  // A thumb pulling down describes an arc: by 200px of travel it has usually drifted further
  // sideways than the slop. Re-deciding the axis every move calls that a swipe and drops the pull
  // half way through.
  const start = beginGesture(50, 100)
  const first = advanceGesture(start, move({ y: 160 }), OPTS)
  assert.equal(first.gesture.axis, "vertical")

  const curved = advanceGesture(first.gesture, move({ x: 300, y: 260 }), OPTS)
  assert.equal(curved.gesture.abandoned, false)
  assert.equal(curved.claim, true)
  assert.ok(curved.gesture.distance > 64)
})

test("releasing short of the threshold is not armed, and at it is", () => {
  assert.equal(isArmed(63, 64), false)
  assert.equal(isArmed(64, 64), true)
  assert.equal(isArmed(200, 64), true)
})

// --- the component --------------------------------------------------------

const findScroller = (tree) =>
  byTag(walk(tree), "div").find((n) =>
    String(n.props?.className ?? "").includes("overscroll-y-contain")
  )

const findButton = (tree) => byTag(walk(tree), "button")[0]

const findStatus = (tree) =>
  walk(tree).find((n) => n.props?.role === "status" && n.props?.["aria-live"] === "polite")

const mount = (props = {}) => {
  const instance = render(PullToRefresh, {
    onRefresh: () => {},
    children: { type: "ul", props: {} },
    ...props,
  })
  return instance
}

/** The `touchmove` listener the component attached by hand, plus the options it used. */
const touchmoveRegistration = (instance) => {
  for (const node of instance.nodes) {
    const call = node.calls.find(
      (c) => c.name === "addEventListener" && c.args[0] === "touchmove"
    )
    if (call) return { listener: call.args[1], options: call.args[2], node }
  }
  return null
}

test("touchmove is registered by hand with passive: false, not through a React prop", () => {
  // The single most consequential line in the component. React adds `onTouchMove` passively, and a
  // passive listener's `preventDefault` is ignored with a console warning — so the indicator comes
  // down while the browser scrolls, or runs its own pull-to-refresh, behind it.
  const instance = mount()
  const registration = touchmoveRegistration(instance)
  assert.ok(registration, "no touchmove listener was registered on the scroller")
  assert.equal(typeof registration.listener, "function")
  assert.deepEqual(registration.options, { passive: false })

  // And it is not also a React prop, which would deliver every move twice.
  assert.equal(findScroller(instance.tree).props.onTouchMove, undefined)
  instance.unmount()
})

test("touchstart, touchend and touchcancel stay React props: none of them prevents anything", () => {
  const instance = mount()
  const scroller = findScroller(instance.tree)
  assert.equal(typeof scroller.props.onTouchStart, "function")
  assert.equal(typeof scroller.props.onTouchEnd, "function")
  assert.equal(
    typeof scroller.props.onTouchCancel,
    "function",
    "a call or a system gesture cancels the touch, and without this the list stays hanging open"
  )
  instance.unmount()
})

test("the scroller contains its overscroll rather than leaving it to the consumer", () => {
  // `contain` and not `none`: it has to stop the gesture reaching Chrome's own pull-to-refresh and
  // stop the scroll chaining to the page, while leaving the bounce that says "this is the end".
  const instance = mount()
  const className = String(findScroller(instance.tree).props.className)
  assert.ok(className.includes("overscroll-y-contain"), className)
  assert.ok(!className.includes("overscroll-y-none"), className)
  instance.unmount()
})

test("there is a button and a live region, because the gesture is touch-only", () => {
  const instance = mount()
  const button = findButton(instance.tree)
  assert.ok(button, "a list whose only way to reload is a pull cannot be reloaded by a keyboard")
  assert.equal(button.props.type, "button")
  assert.ok(findStatus(instance.tree), "a pull that announces nothing is silent to a screen reader")
  instance.unmount()
})

test("the live region is in the tree before it has anything to say", () => {
  // A region inserted at the same moment as its text is commonly announced late or not at all.
  const instance = mount()
  const status = findStatus(instance.tree)
  assert.ok(status)
  assert.equal(status.props.children, "")
  instance.unmount()
})

test("pressing the button refreshes", async () => {
  let calls = 0
  const instance = mount({ onRefresh: () => { calls += 1 } })
  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(calls, 1)
  instance.unmount()
})

test("the button is aria-disabled while refreshing, never disabled", async () => {
  // `disabled` takes focus off the button the instant it is pressed, which drops the keyboard user
  // out of the list they were refreshing.
  let release
  const instance = mount({ onRefresh: () => new Promise((r) => { release = r }) })
  findButton(instance.tree).props.onClick()
  instance.rerender()

  const button = findButton(instance.tree)
  assert.equal(button.props["aria-disabled"], true)
  assert.notEqual(button.props.disabled, true)
  assert.equal(findScroller(instance.tree).props["aria-busy"], true)
  assert.equal(findStatus(instance.tree).props.children, "Refreshing…")

  release()
  await Promise.resolve()
  await Promise.resolve()
  instance.rerender()
  assert.equal(findStatus(instance.tree).props.children, "List updated.")
  assert.equal(findButton(instance.tree).props["aria-disabled"], false)
  instance.unmount()
})

test("a second press while one refresh is in flight does not start another", async () => {
  let calls = 0
  let release
  const instance = mount({
    onRefresh: () => {
      calls += 1
      return new Promise((r) => { release = r })
    },
  })
  findButton(instance.tree).props.onClick()
  instance.rerender()
  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(calls, 1)
  release()
  await Promise.resolve()
  instance.unmount()
})

test("a rejected refresh announces the failure and lets the next one through", async () => {
  // Left unhandled this is the spinner that turns for the rest of the session.
  let calls = 0
  let fail
  const instance = mount({
    onRefresh: () => {
      calls += 1
      return new Promise((_, reject) => { fail = reject })
    },
  })
  findButton(instance.tree).props.onClick()
  instance.rerender()
  fail(new Error("offline"))
  await Promise.resolve()
  await Promise.resolve()
  instance.rerender()

  assert.equal(findStatus(instance.tree).props.children, "Couldn't refresh.")
  assert.equal(findScroller(instance.tree).props["aria-busy"], undefined)

  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(calls, 2, "a failed refresh must not wedge the component")
  instance.unmount()
})

test("a loader that throws synchronously is a failure, not a permanent busy state", async () => {
  let calls = 0
  const instance = mount({
    onRefresh: () => {
      calls += 1
      throw new Error("no network")
    },
  })
  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(findStatus(instance.tree).props.children, "Couldn't refresh.")

  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(calls, 2)
  instance.unmount()
})

test("disabled turns the gesture off as well as the button", () => {
  let calls = 0
  const instance = mount({ disabled: true, onRefresh: () => { calls += 1 } })
  assert.equal(findButton(instance.tree).props["aria-disabled"], true)
  findButton(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(calls, 0)

  // And the gesture: a disabled list that still refreshes when pulled is worse than one that never
  // looked disabled at all.
  const scroller = findScroller(instance.tree)
  scroller.props.onTouchStart({ touches: [{ clientX: 50, clientY: 100 }] })
  const { listener } = touchmoveRegistration(instance)
  listener({ touches: [{ clientX: 50, clientY: 300 }], cancelable: true, preventDefault() {} })
  instance.rerender()
  scroller.props.onTouchEnd()
  instance.rerender()
  assert.equal(calls, 0)
  instance.unmount()
})

test("hideButton removes the button for callers who supply their own control", () => {
  const instance = mount({ hideButton: true })
  assert.equal(findButton(instance.tree), undefined)
  // The `hidden` attribute would not have done this: `[hidden]` is a user-agent rule and any
  // `display` from a class beats it, so the button stays on screen while claiming to be gone.
  assert.ok(findStatus(instance.tree), "the live region is not the button's to take away")
  instance.unmount()
})

test("a full gesture past the threshold refreshes and claims its moves", () => {
  let calls = 0
  const instance = mount({ onRefresh: () => { calls += 1 } })
  const scroller = findScroller(instance.tree)
  const { listener } = touchmoveRegistration(instance)

  scroller.props.onTouchStart({ touches: [{ clientX: 50, clientY: 100 }] })
  let prevented = 0
  listener({
    touches: [{ clientX: 50, clientY: 100 + DEFAULT_PULL_THRESHOLD + 20 }],
    cancelable: true,
    preventDefault() { prevented += 1 },
  })
  instance.rerender()
  assert.equal(prevented, 1, "the move has to be claimed or the browser overscrolls behind it")

  scroller.props.onTouchEnd()
  instance.rerender()
  assert.equal(calls, 1)
  instance.unmount()
})

test("a gesture released short of the threshold does not refresh", () => {
  let calls = 0
  const instance = mount({ onRefresh: () => { calls += 1 } })
  const scroller = findScroller(instance.tree)
  const { listener } = touchmoveRegistration(instance)

  scroller.props.onTouchStart({ touches: [{ clientX: 50, clientY: 100 }] })
  listener({
    touches: [{ clientX: 50, clientY: 100 + DEFAULT_PULL_THRESHOLD - 5 }],
    cancelable: true,
    preventDefault() {},
  })
  instance.rerender()
  scroller.props.onTouchEnd()
  instance.rerender()
  assert.equal(calls, 0)
  instance.unmount()
})

test("touchcancel drops the pull without refreshing", () => {
  // A phone call, or the system's own edge gesture, ends the touch with no touchend. Without this
  // the indicator stays open forever and the next pull starts from a list already hanging down.
  let calls = 0
  const instance = mount({ onRefresh: () => { calls += 1 } })
  const scroller = findScroller(instance.tree)
  const { listener } = touchmoveRegistration(instance)

  scroller.props.onTouchStart({ touches: [{ clientX: 50, clientY: 100 }] })
  listener({
    touches: [{ clientX: 50, clientY: 400 }],
    cancelable: true,
    preventDefault() {},
  })
  instance.rerender()
  scroller.props.onTouchCancel()
  instance.rerender()
  assert.equal(calls, 0)
  instance.unmount()
})

test("a two-finger touch never starts a gesture", () => {
  let calls = 0
  const instance = mount({ onRefresh: () => { calls += 1 } })
  const scroller = findScroller(instance.tree)
  const { listener } = touchmoveRegistration(instance)

  scroller.props.onTouchStart({
    touches: [{ clientX: 50, clientY: 100 }, { clientX: 90, clientY: 140 }],
  })
  listener({
    touches: [{ clientX: 50, clientY: 400 }],
    cancelable: true,
    preventDefault() {},
  })
  instance.rerender()
  scroller.props.onTouchEnd()
  instance.rerender()
  assert.equal(calls, 0)
  instance.unmount()
})

/**
 * Every string in a node's children, at any depth.
 *
 * `walk` cannot answer this: it collects elements, and a bare string child is not one — so reaching
 * for it here returns an empty list and any assertion about wording passes or fails for the wrong
 * reason.
 */
const textOf = (node, out = []) => {
  if (typeof node === "string") {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node && typeof node === "object") return textOf(node.props?.children, out)
  return out
}

test("labels are overridable for translation", () => {
  const instance = mount({ labels: { refresh: "更新" } })
  const text = textOf(findButton(instance.tree))
  assert.ok(text.includes("更新"), JSON.stringify(text))
  instance.unmount()
})

test("the indicator says what releasing will do, and changes at the threshold", () => {
  // The three states the person reads off the gap they have opened. Collapsing them to one label
  // ("Loading…") leaves no way to know whether letting go now would do anything.
  const instance = mount()
  const scroller = findScroller(instance.tree)
  const { listener } = touchmoveRegistration(instance)
  const drag = (dy) => {
    listener({
      touches: [{ clientX: 50, clientY: 100 + dy }],
      cancelable: true,
      preventDefault() {},
    })
    instance.rerender()
  }

  scroller.props.onTouchStart({ touches: [{ clientX: 50, clientY: 100 }] })
  drag(DEFAULT_PULL_THRESHOLD - 20)
  assert.ok(textOf(instance.tree).includes("Pull to refresh"))
  drag(DEFAULT_PULL_THRESHOLD + 20)
  assert.ok(textOf(instance.tree).includes("Release to refresh"))
  instance.unmount()
})

test("the threshold and ceiling are the documented defaults", () => {
  assert.equal(DEFAULT_PULL_THRESHOLD, 64)
  assert.equal(SCROLL_TOP_EPSILON, 1)
  assert.equal(AXIS_SLOP, 8)
})
