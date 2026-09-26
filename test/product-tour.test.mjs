// product-tour points at the real screen, and everything that makes it hard is that the screen does
// not hold still. The cases below are written to fail against the versions that go wrong:
//
//   - a target measured once when the step opened, so the spotlight sits where the element used to
//     be after a panel slid open, a font swapped in, or React replaced the node.
//   - a spotlight kept at the last known rectangle when the element has gone, which lights up a
//     patch of empty page — and its cousin, a `display: none` element whose rectangle is all zeros
//     and whose spotlight is therefore a bright square in the top-left corner.
//   - a surround built out of rectangles that overlap, which shows as a darker band down the seam,
//     or that leave a gap, through which the page is still clickable.
//   - a card placed on the side it was asked for whether or not it fits, which is how the "Next"
//     button ends up off the bottom of a laptop window.
//   - `aria-modal="true"` on a step that has just told the person to click something outside the
//     card — a claim that makes a screen reader hide the very control the step is about.
//   - a focus trap on that same step, which has the same effect for a keyboard.
//   - and a resume position that no longer exists, from a tour rewritten since it was saved.
//
// What the harness can see of focus is the call, not the caret: "the card asked to take focus" is
// asserted here, and whether the browser honoured it belongs to a browser. The measuring loop is
// driven by re-rendering rather than by frames, which is the same thing from the component's side —
// a frame is a re-measure — and the one thing asserted about the loop itself is that it asked for
// another frame instead of measuring once.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// --- a page, small enough to reason about -----------------------------------------------------

const VIEWPORT = { width: 1024, height: 768 }

/** One element the tour can point at, recording what the tour asked of it. */
function element({ rect = { top: 100, left: 200, width: 120, height: 40 }, stops = [] } = {}) {
  const node = {
    isConnected: true,
    calls: [],
    getBoundingClientRect: () => rect,
    getClientRects: () => [rect],
    querySelectorAll: () => stops,
    matches: () => false,
    hasAttribute: () => false,
    getAttribute: () => null,
    scrollIntoView(options) {
      node.calls.push({ name: "scrollIntoView", args: [options] })
    },
    focus() {
      node.calls.push({ name: "focus", args: [] })
    },
    setRect(next) {
      node.getBoundingClientRect = () => next
    },
  }
  return node
}

/** A control inside a target, for the tab-scope cases. */
const control = (name) => {
  const node = element()
  node.name = name
  node.matches = () => true
  return node
}

const selectors = new Map()
const timers = []
let frames = 0
let reducedMotion = false

// Set before the component is loaded, because the module decides between useLayoutEffect and
// useEffect at load time from `typeof window` — so this is also what makes the browser branch the one
// under test.
globalThis.window = {
  innerWidth: VIEWPORT.width,
  innerHeight: VIEWPORT.height,
  matchMedia: () => ({ matches: reducedMotion }),
  setTimeout(fn, ms) {
    timers.push({ fn, ms, cancelled: false })
    return timers.length
  },
  clearTimeout(id) {
    const timer = timers[id - 1]
    if (timer) timer.cancelled = true
  },
}
const listeners = []
globalThis.document = {
  activeElement: null,
  querySelector: (selector) => selectors.get(selector) ?? null,
  addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
  removeEventListener: (type, fn) => {
    const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
    if (at !== -1) listeners.splice(at, 1)
  },
}
// Returns 0 so the component's `if (frame)` guard skips cancelling; nothing is ever delivered
// through it. Counted only to pin that the component asked for another measurement.
globalThis.requestAnimationFrame = () => {
  frames += 1
  return 0
}
globalThis.cancelAnimationFrame = () => {}

const { loadComponent, render, walk, byTag } = await import("./_react-harness.mjs")

const { ProductTour, spotlight, placeBubble, tabbablesIn } = loadComponent(
  join(ROOT, "registry", "ui", "product-tour.tsx"),
  {
    stubs: {
      "lucide-react": {
        X: function X(props) {
          return { type: "svg", props: { "data-icon": "x", ...props } }
        },
      },
    },
  }
)

/** Everything a test needs to reach in the rendered overlay. */
function overlay(instance) {
  const nodes = walk(instance.tree)
  const buttons = byTag(nodes, "button")
  const classOf = (node) => String(node.props?.className ?? "")
  return {
    nodes,
    card: nodes.find((node) => node.props?.role === "dialog"),
    dim: nodes.filter((node) => classOf(node).includes("bg-black/50")),
    ring: nodes.find((node) => node.props?.["data-tour-spotlight"] !== undefined),
    blocker: nodes.find((node) => node.props?.["data-tour-blocker"] !== undefined),
    heading: byTag(nodes, "h2")[0],
    buttons,
    back: buttons.find((button) => button.props.children === "Back"),
    next: buttons.find((button) => button.props.children === "Next"),
    done: buttons.find((button) => button.props.children === "Done"),
    skip: buttons.find((button) => button.props["aria-label"] === "Skip the tour"),
  }
}

const rectOf = (node) => {
  const style = node.props.style
  return {
    top: parseInt(style.top, 10),
    left: parseInt(style.left, 10),
    width: parseInt(style.width, 10),
    height: parseInt(style.height, 10),
  }
}

/**
 * Presses a key the way the page would: through the capture-phase document listener.
 *
 * Not through a prop on the card, because that is the bug — on an interactive step focus leaves the
 * card on the first Tab, and a handler that lives on the card stops being reached at exactly the
 * moment the scope is supposed to start working.
 */
const press = (key, extra = {}) => {
  const keydown = listeners.filter((entry) => entry.type === "keydown")
  assert.ok(keydown.length > 0, "nothing is listening for keys")
  assert.equal(keydown.at(-1).capture, true, "a bubble-phase listener never sees the page's own keys")
  let prevented = false
  keydown.at(-1).fn({ key, preventDefault: () => (prevented = true), ...extra })
  return prevented
}

const focusCalls = (instance) =>
  instance.nodes.flatMap((node) => node.calls.filter((call) => call.name === "focus"))

/**
 * Teaches the card's stand-in node to answer with the controls a browser would find inside it.
 *
 * The harness gives a component's null ref a stand-in with no `querySelectorAll` — deliberately, it
 * has no DOM to search — so without this the card contributes no tab stops and the scope under test
 * would be half of itself.
 */
function cardStops(instance, stops) {
  const card = instance.nodes[0]
  card.querySelectorAll = () => stops
  card.matches = () => false
  return stops
}

function reset() {
  listeners.length = 0
  selectors.clear()
  timers.length = 0
  frames = 0
  reducedMotion = false
  globalThis.document.activeElement = null
}

const STEPS = [
  { id: "welcome", title: "Welcome", content: "The short version." },
  { id: "search", target: "#search", title: "Find anything", content: "Type here." },
  { id: "new", target: "#new", title: "Start something", content: "Press this.", interactive: true },
]

/** Mounts the tour with a target already in the page, and settles the measuring loop. */
function mount(props = {}, targets = {}) {
  reset()
  for (const [selector, node] of Object.entries(targets)) selectors.set(selector, node)
  return render(ProductTour, { steps: STEPS, defaultOpen: true, ...props })
}

// --- the surround tiles the viewport, exactly -------------------------------------------------

/** Total area of a list of rectangles, and whether any two of them overlap. */
function coverage(rects) {
  let area = 0
  let overlap = false
  for (let i = 0; i < rects.length; i++) {
    area += rects[i].width * rects[i].height
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      const wide = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
      const tall = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
      if (wide > 0 && tall > 0) overlap = true
    }
  }
  return { area, overlap }
}

test("the dimmed pieces cover the viewport minus the hole, with no overlap and no gap", () => {
  const { hole, dim } = spotlight({ top: 100, left: 200, width: 120, height: 40 }, VIEWPORT, 6)
  const { area, overlap } = coverage(dim)
  assert.equal(overlap, false, "two translucent pieces meeting would show as a darker band")
  assert.equal(
    area + hole.width * hole.height,
    VIEWPORT.width * VIEWPORT.height,
    "a gap in the surround is a hole in the overlay the page is still clickable through"
  )
})

test("a target hanging off the edge still tiles the viewport", () => {
  // Half of it is past the right edge and above the top one. The surround has to be built from the
  // clamped hole, or the pieces come out with negative sizes and the arithmetic stops holding.
  const { hole, dim } = spotlight({ top: -20, left: 960, width: 120, height: 40 }, VIEWPORT, 6)
  assert.deepEqual(hole, { top: 0, left: 954, width: 70, height: 26 })
  const { area, overlap } = coverage(dim)
  assert.equal(overlap, false)
  assert.equal(area + hole.width * hole.height, VIEWPORT.width * VIEWPORT.height)
})

test("a display:none target is no hole, not a hole in the corner", () => {
  // getBoundingClientRect on a hidden element answers all zeros, and a spotlight drawn there lights
  // up the top-left corner of the page with total confidence.
  const { hole, dim } = spotlight({ top: 0, left: 0, width: 0, height: 0 }, VIEWPORT)
  assert.equal(hole, null)
  assert.deepEqual(dim, [{ top: 0, left: 0, width: 1024, height: 768 }])
})

test("a target scrolled entirely out of view is no hole", () => {
  const { hole, dim } = spotlight({ top: 2000, left: 200, width: 120, height: 40 }, VIEWPORT)
  assert.equal(hole, null)
  assert.equal(dim.length, 1)
})

test("padding grows the hole on every side", () => {
  const tight = spotlight({ top: 100, left: 200, width: 120, height: 40 }, VIEWPORT, 0).hole
  const loose = spotlight({ top: 100, left: 200, width: 120, height: 40 }, VIEWPORT, 10).hole
  assert.deepEqual(tight, { top: 100, left: 200, width: 120, height: 40 })
  assert.deepEqual(loose, { top: 90, left: 190, width: 140, height: 60 })
})

// --- placement ---------------------------------------------------------------------------------

const CARD = { width: 320, height: 160 }

test("a requested side is used when the card fits there", () => {
  const hole = { top: 300, left: 400, width: 100, height: 40 }
  const placed = placeBubble({ hole, bubble: CARD, viewport: VIEWPORT, placement: "right" })
  assert.equal(placed.placement, "right")
  assert.equal(placed.left, 510)
})

test("a requested side the card does not fit on is abandoned", () => {
  // 30px from the top of the window, and the card is 160 tall: obeying "top" would put it off the
  // screen, with its buttons on the wrong side of the edge.
  const hole = { top: 30, left: 400, width: 100, height: 40 }
  const placed = placeBubble({ hole, bubble: CARD, viewport: VIEWPORT, placement: "top" })
  assert.equal(placed.placement, "bottom")
  assert.equal(placed.top, 80)
})

test("the cross axis is clamped into the viewport rather than centred blindly", () => {
  // Centring a 320px card on a target 40px from the left edge hangs 120px of it outside the window.
  const hole = { top: 300, left: 20, width: 40, height: 40 }
  const placed = placeBubble({ hole, bubble: CARD, viewport: VIEWPORT, placement: "bottom" })
  assert.equal(placed.placement, "bottom")
  assert.equal(placed.left, 8)
})

test("a target too large for any side still gets a card inside the viewport, and no arrow", () => {
  const hole = { top: 0, left: 0, width: 1024, height: 768 }
  const placed = placeBubble({ hole, bubble: CARD, viewport: VIEWPORT })
  assert.ok(placed.left >= 8 && placed.left + CARD.width <= VIEWPORT.width - 8)
  assert.ok(placed.top >= 8 && placed.top + CARD.height <= VIEWPORT.height - 8)
  assert.equal(placed.arrow, null, "an arrow would point at what the card is sitting on")
})

test("a card on the roomiest side that still does not fit is pulled back inside the window", () => {
  // A tall panel taking two thirds of the width: no side fits a 320px card, and the roomiest is the
  // right, with 306px. Unclamped, the card starts at 710 and its last 6px — including the edge of
  // the Next button — are past the right edge of the window.
  const hole = { top: 0, left: 0, width: 700, height: 768 }
  const placed = placeBubble({ hole, bubble: CARD, viewport: VIEWPORT })
  assert.equal(placed.placement, "right")
  assert.equal(placed.left + CARD.width, VIEWPORT.width - 8)
})

test("no hole means a centred card and nothing to point at", () => {
  const placed = placeBubble({ hole: null, bubble: CARD, viewport: VIEWPORT })
  assert.equal(placed.placement, "center")
  assert.equal(placed.left, (1024 - 320) / 2)
  assert.equal(placed.top, (768 - 160) / 2)
  assert.equal(placed.arrow, null)
})

test("the arrow tracks the target's centre, held clear of the card's corners", () => {
  const centred = placeBubble({
    hole: { top: 300, left: 400, width: 100, height: 40 },
    bubble: CARD,
    viewport: VIEWPORT,
    placement: "bottom",
  })
  // Card centred on the hole, so the arrow lands in the middle of the card.
  assert.equal(centred.arrow, CARD.width / 2)

  const auto = placeBubble({
    hole: { top: 300, left: 400, width: 100, height: 40 },
    bubble: CARD,
    viewport: VIEWPORT,
  })
  assert.equal(auto.placement, "bottom")
  assert.equal(auto.arrow, CARD.width / 2, "a card placed by auto still points at its target")

  const cornered = placeBubble({
    hole: { top: 300, left: 10, width: 20, height: 40 },
    bubble: CARD,
    viewport: VIEWPORT,
    placement: "bottom",
  })
  // The target's centre is 12px into a card that starts at the margin; the arrow is held at the
  // inset so it does not grow out of the rounded corner.
  assert.equal(cornered.arrow, 16)
})

// --- the target is resolved every measurement, not captured ------------------------------------

test("a target that moves takes the spotlight with it", () => {
  const search = element({ rect: { top: 100, left: 200, width: 120, height: 40 } })
  const instance = mount({ defaultStepId: "search" }, { "#search": search })
  assert.deepEqual(rectOf(overlay(instance).ring), { top: 94, left: 194, width: 132, height: 52 })

  // A panel sliding open, a font swapping in, an image finishing: the element is in the same place
  // in the DOM and somewhere else on the screen, and nothing fired an event about it.
  search.setRect({ top: 420, left: 640, width: 120, height: 40 })
  instance.rerender()
  assert.deepEqual(rectOf(overlay(instance).ring), { top: 414, left: 634, width: 132, height: 52 })
})

test("the loop asks for another frame rather than measuring once", () => {
  mount({ defaultStepId: "search" }, { "#search": element() })
  assert.ok(frames > 0, "one measurement per step is what leaves a spotlight behind")
})

test("a target that leaves the document takes the spotlight with it", () => {
  const search = element()
  const instance = mount({ defaultStepId: "search" }, { "#search": search })
  assert.ok(overlay(instance).ring)

  // The panel closed. A version holding the last rectangle lights up a patch of empty page.
  selectors.delete("#search")
  instance.rerender()
  const after = overlay(instance)
  assert.equal(after.ring, undefined)
  assert.equal(after.dim.length, 1, "with nothing lit, the whole viewport is dimmed")
  assert.equal(after.card.props["data-placement"], "center")
})

test("an element handed in directly is dropped once it is detached", () => {
  // The other half of the same rule: a node React has unmounted still answers
  // getBoundingClientRect, with the rectangle it had on the way out.
  const node = element()
  const instance = render(ProductTour, {
    steps: [{ id: "one", target: node, title: "One", content: "…" }],
    defaultOpen: true,
  })
  assert.ok(overlay(instance).ring)
  node.isConnected = false
  instance.rerender()
  assert.equal(overlay(instance).ring, undefined)
})

test("a target with no box at all is not lit", () => {
  // What a collapsed sidebar item, or anything inside `display: none`, answers: a rectangle of
  // zeros. Drawn as a hole it is a bright square in the top-left corner of the page.
  const hidden = element({ rect: { top: 0, left: 0, width: 0, height: 0 } })
  const instance = mount({ defaultStepId: "search" }, { "#search": hidden })
  const view = overlay(instance)
  assert.equal(view.ring, undefined)
  assert.equal(view.dim.length, 1)
})

test("a step with no target is a centred card with no spotlight", () => {
  const instance = mount()
  const view = overlay(instance)
  assert.equal(view.ring, undefined)
  assert.equal(view.blocker, undefined)
  assert.equal(view.card.props["data-placement"], "center")
})

// --- interactive or not ------------------------------------------------------------------------

test("a step that only points at its target blocks the hole and claims modality", () => {
  const instance = mount({ defaultStepId: "search" }, { "#search": element() })
  const view = overlay(instance)
  assert.ok(view.blocker, "an unblocked hole lets a person press a control the tour has not reached")
  assert.deepEqual(rectOf(view.blocker), rectOf(view.ring))
  assert.equal(view.card.props["aria-modal"], true)
})

test("a step that asks for an action leaves the hole live and drops aria-modal", () => {
  const instance = mount({ defaultStepId: "new" }, { "#new": element() })
  const view = overlay(instance)
  assert.equal(view.blocker, undefined)
  assert.equal(
    view.card.props["aria-modal"],
    undefined,
    'aria-modal="true" hides the control the step just asked the person to press'
  )
  assert.ok(view.ring, "the target is still lit: only the blocker goes")
})

test("an interactive step with nothing lit is treated as modal", () => {
  // Its target has not arrived, so there is no hole to reach through; a card that dropped
  // aria-modal here would be claiming a way out that does not exist.
  const instance = mount({ defaultStepId: "new" })
  const view = overlay(instance)
  assert.equal(view.ring, undefined)
  assert.equal(view.card.props["aria-modal"], true)
})

// --- focus and the tab scope -------------------------------------------------------------------

test("focus moves to the card on every step", () => {
  const instance = mount()
  const before = focusCalls(instance).length
  assert.ok(before > 0, "a card nobody focused is a step a screen reader was never told about")

  overlay(instance).next.props.onClick()
  instance.rerender()
  assert.ok(focusCalls(instance).length > before)
  // What this cannot distinguish is a focus effect keyed on `[open]` instead of `[open, index]`: the
  // harness runs every effect on every settling pass, so a dependency array has no observable
  // consequence here. That the card is focused at all is what is pinned; that it happens again at
  // each step is a browser's to demonstrate.
})

test("the card's own tab order is Back, Next, Skip", () => {
  const instance = mount({ defaultStepId: "search" }, { "#search": element() })
  const labels = overlay(instance).buttons.map(
    (button) => button.props["aria-label"] ?? button.props.children
  )
  // The × is last in the DOM although it is drawn in the corner: the way out of a tour should not be
  // the first thing a keyboard lands on.
  assert.deepEqual(labels, ["Back", "Next", "Skip the tour"])
})

test("Tab is confined to the card when the target is inert", () => {
  const stop = control("target-button")
  const search = element({ stops: [stop] })
  const instance = mount({ defaultStepId: "search" }, { "#search": search })
  const [cardFirst] = cardStops(instance, [control("card-back"), control("card-next")])
  const view = overlay(instance)

  assert.equal(press("Tab"), true, "the order has to be this one, not the document's")
  // Focus started on the card itself, so forward Tab enters at the card's first stop — and the
  // target's button is not in the scope at all.
  assert.equal(cardFirst.calls.filter((call) => call.name === "focus").length, 1)
  assert.equal(stop.calls.filter((call) => call.name === "focus").length, 0)
})

test("Tab reaches the target's controls first on an interactive step", () => {
  const first = control("first")
  const second = control("second")
  const target = element({ stops: [first, second] })
  const instance = mount({ defaultStepId: "new" }, { "#new": target })
  cardStops(instance, [control("card-next")])
  const view = overlay(instance)

  press("Tab")
  assert.equal(
    first.calls.filter((call) => call.name === "focus").length,
    1,
    "the thing the step just asked for should not be several stops past a button called Next"
  )

  globalThis.document.activeElement = first
  press("Tab")
  assert.equal(second.calls.filter((call) => call.name === "focus").length, 1)
})

test("Tab keeps working once focus has left the card for the target", () => {
  const first = control("first")
  const second = control("second")
  const target = element({ stops: [first, second] })
  const instance = mount({ defaultStepId: "new" }, { "#new": target })
  cardStops(instance, [control("card-next")])

  // Focus is on the target's own control, which is outside the card's subtree. A handler attached to
  // the card stops being reached here, and every Tab from now on belongs to the page behind.
  globalThis.document.activeElement = first
  assert.equal(press("Tab"), true, "the scope has to be a scope, not just a first move")
  assert.equal(second.calls.filter((call) => call.name === "focus").length, 1)
})

test("Escape works from the target's controls too", () => {
  const stop = control("target-button")
  const finishes = []
  mount(
    { defaultStepId: "new", onFinish: (f) => finishes.push(f) },
    { "#new": element({ stops: [stop] }) }
  )
  globalThis.document.activeElement = stop
  assert.equal(press("Escape"), true)
  assert.deepEqual(finishes, [{ reason: "dismissed", stepId: "new", index: 2 }])
})

test("the listener goes away with the tour", () => {
  const instance = mount()
  assert.ok(listeners.some((entry) => entry.type === "keydown"))
  instance.unmount()
  assert.deepEqual(
    listeners.filter((entry) => entry.type === "keydown"),
    [],
    "a closed tour listening to the page's typing is a keyboard nobody can use"
  )
})

test("Shift+Tab from the card enters the scope at its last stop", () => {
  const stop = control("target-button")
  const instance = mount({ defaultStepId: "new" }, { "#new": element({ stops: [stop] }) })
  const cards = cardStops(instance, [control("card-next"), control("card-skip")])
  const view = overlay(instance)
  // Going backwards, the scope is entered at its end — the card's last control — and not at the
  // target's, which is where going forwards enters it.
  press("Tab", { shiftKey: true })
  assert.equal(cards[1].calls.filter((call) => call.name === "focus").length, 1)
  assert.equal(stop.calls.filter((call) => call.name === "focus").length, 0)
})

test("tabbablesIn counts a target that is itself the control", () => {
  // A step pointing at one button: a scope built only out of descendants leaves nothing to tab to.
  const button = control("the-button")
  assert.deepEqual(tabbablesIn(button), [button])
})

test("tabbablesIn skips what a browser skips", () => {
  const hidden = control("hidden")
  hidden.getClientRects = () => []
  const inert = control("inert")
  inert.hasAttribute = (name) => name === "inert"
  const masked = control("aria-hidden")
  masked.getAttribute = (name) => (name === "aria-hidden" ? "true" : null)
  const real = control("real")
  const root = element({ stops: [hidden, inert, masked, real] })
  assert.deepEqual(tabbablesIn(root), [real])
})

// --- getting through the tour ------------------------------------------------------------------

test("Back appears only once there is somewhere to go back to", () => {
  const instance = mount()
  assert.equal(overlay(instance).back, undefined)
  overlay(instance).next.props.onClick()
  instance.rerender()
  assert.ok(overlay(instance).back)
})

test("the last step ends the tour as completed, naming the step it ended on", () => {
  const finishes = []
  const opens = []
  const instance = mount({ defaultStepId: "new", onFinish: (f) => finishes.push(f), onOpenChange: (o) => opens.push(o) })
  const view = overlay(instance)
  assert.ok(view.done, "the last step's button says it is the last")
  view.done.props.onClick()
  assert.deepEqual(finishes, [{ reason: "completed", stepId: "new", index: 2 }])
  assert.deepEqual(opens, [false])
})

test("Escape and the × both end the tour as dismissed, from wherever the person got to", () => {
  const finishes = []
  const instance = mount({ defaultStepId: "search", onFinish: (f) => finishes.push(f) }, { "#search": element() })
  assert.equal(press("Escape"), true)
  assert.deepEqual(finishes, [{ reason: "dismissed", stepId: "search", index: 1 }])

  const second = mount({ defaultStepId: "search", onFinish: (f) => finishes.push(f) }, { "#search": element() })
  overlay(second).skip.props.onClick()
  assert.equal(finishes[1].reason, "dismissed")
  assert.equal(finishes[1].stepId, "search")
})

test("Escape after advancing reports the step the person is actually on", () => {
  // The listener is attached once per opening, so what it calls has to be this render's handler and
  // not the one from the render that attached it. Captured instead, the tour reports step 1 however
  // far someone got — and a resume position taken from that puts them back at the beginning.
  const finishes = []
  const instance = mount({ onFinish: (f) => finishes.push(f) })
  overlay(instance).next.props.onClick()
  instance.rerender()
  assert.equal(overlay(instance).heading.props.children, "Find anything")

  press("Escape")
  assert.deepEqual(finishes, [{ reason: "dismissed", stepId: "search", index: 1 }])
})

test("closeOnEscape={false} leaves Escape to the page", () => {
  const finishes = []
  const instance = mount({ closeOnEscape: false, onFinish: (f) => finishes.push(f) })
  assert.equal(press("Escape"), false)
  assert.deepEqual(finishes, [])
})

test("a controlled stepId decides the step, and changes are reported by id", () => {
  const changes = []
  const instance = render(ProductTour, {
    steps: STEPS,
    open: true,
    stepId: "welcome",
    onStepChange: (id, at) => changes.push([id, at]),
  })
  assert.equal(overlay(instance).heading.props.children, "Welcome")
  overlay(instance).next.props.onClick()
  assert.deepEqual(changes, [["search", 1]])

  // Nothing moved on its own: the parent owns the step.
  instance.rerender()
  assert.equal(overlay(instance).heading.props.children, "Welcome")
  instance.update({ steps: STEPS, open: true, stepId: "search" })
  assert.equal(overlay(instance).heading.props.children, "Find anything")
})

test("the progress line counts from one, and can be turned off", () => {
  const instance = mount({ defaultStepId: "search" }, { "#search": element() })
  const texts = overlay(instance).nodes.map((node) => node.props?.children)
  assert.ok(texts.includes("2 of 3"))

  const quiet = mount({ progressLabel: () => "" })
  const quietTexts = overlay(quiet).nodes.map((node) => node.props?.children)
  assert.ok(!quietTexts.some((text) => typeof text === "string" && text.includes(" of ")))
})

test("no steps means no overlay", () => {
  const instance = render(ProductTour, { steps: [], defaultOpen: true })
  assert.equal(instance.tree, null)
})

// --- resume ------------------------------------------------------------------------------------

test("defaultStepId starts the tour where the person left it", () => {
  const instance = mount({ defaultStepId: "search" }, { "#search": element() })
  assert.equal(overlay(instance).heading.props.children, "Find anything")
})

test("a saved step that no longer exists starts the tour over, not blank", () => {
  // The one way this happens is a position saved before the tour was rewritten. Showing nothing is
  // the version where a rename silently switches the tour off for everyone mid-rollout.
  const instance = mount({ defaultStepId: "a-step-that-was-renamed" })
  assert.equal(overlay(instance).heading.props.children, "Welcome")
})

test("a tour that lost steps since the position was taken lands on its last one", () => {
  // Not the same case as an unknown id: the index is a real number that is now past the end, which is
  // what a shortened tour does to a position already in state.
  const instance = render(ProductTour, { steps: STEPS, open: true, defaultStepId: "new" })
  assert.equal(overlay(instance).heading.props.children, "Start something")
  instance.update({ steps: STEPS.slice(0, 2), open: true, defaultStepId: "new" })
  assert.equal(overlay(instance).heading.props.children, "Find anything")
})

test("reopening an uncontrolled tour rewinds to the resume point", () => {
  const instance = render(ProductTour, { steps: STEPS, open: true, defaultStepId: "welcome" })
  overlay(instance).next.props.onClick()
  instance.rerender()
  assert.equal(overlay(instance).heading.props.children, "Find anything")

  instance.update({ steps: STEPS, open: false, defaultStepId: "welcome" })
  instance.update({ steps: STEPS, open: true, defaultStepId: "welcome" })
  assert.equal(
    overlay(instance).heading.props.children,
    "Welcome",
    "last run's state is not the resume point the caller asked for"
  )
})

// --- a target that never comes -----------------------------------------------------------------

const pending = () => timers.filter((timer) => !timer.cancelled)

test("a missing target is reported only after the wait, and names its step", () => {
  const missing = []
  mount({ defaultStepId: "search", onTargetMissing: (step, at) => missing.push([step.id, at]) })
  assert.deepEqual(missing, [], "absent for a moment is the ordinary case, not a fault")
  assert.ok(pending().length > 0)
  assert.equal(pending()[0].ms, 4000, "a wait of nothing reports every code-split panel as broken")

  // The effect is re-run once per settling pass, so several identical timers are outstanding; what
  // matters is what the first one says.
  pending()[0].fn()
  assert.deepEqual(missing[0], ["search", 1])
})

test("a target that arrives in time is never reported", () => {
  const missing = []
  const instance = mount(
    { defaultStepId: "search", onTargetMissing: (step) => missing.push(step.id) },
    { "#search": element() }
  )
  // In a browser the cleanup cancels the wait as soon as a rectangle arrives; the harness runs no
  // cleanup between settling passes, so the timer set before the first measurement is still sitting
  // there. Firing it is therefore the stronger test: a wait that goes off has to re-establish that
  // the target is still missing before it reports, or a tour can report a step that is on screen and
  // working.
  for (const timer of pending()) timer.fn()
  assert.deepEqual(missing, [])

  instance.unmount()
  assert.deepEqual(pending(), [], "unmounting leaves no timer behind")
})

test("a target that is in the page but has no box counts as missing", () => {
  // The decision this pins: an element that exists and cannot be seen is not something a tour can
  // point at, so it is reported like an absent one rather than treated as found. It is what a step
  // aimed at a collapsed panel, a closed `details`, or a `display: none` menu item looks like.
  const missing = []
  mount(
    { defaultStepId: "search", onTargetMissing: (step) => missing.push(step.id) },
    { "#search": element({ rect: { top: 0, left: 0, width: 0, height: 0 } }) }
  )
  assert.ok(pending().length > 0, "a zero-sized element is not a found target")
  pending()[0].fn()
  assert.deepEqual(missing, ["search"])
})

test("the length of the wait is the caller's", () => {
  mount({ defaultStepId: "search", targetTimeout: 1500, onTargetMissing: () => {} })
  assert.equal(pending()[0].ms, 1500)
})

test("a step with no target waits for nothing", () => {
  mount({ onTargetMissing: () => {} })
  assert.deepEqual(pending(), [])
})

// --- scrolling the target into view -------------------------------------------------------------

const scrolls = (node) => node.calls.filter((call) => call.name === "scrollIntoView")

test("a target below the fold is scrolled into view, once", () => {
  const search = element({ rect: { top: 2000, left: 200, width: 120, height: 40 } })
  const instance = mount({ defaultStepId: "search" }, { "#search": search })
  assert.equal(scrolls(search).length, 1)
  assert.equal(scrolls(search)[0].args[0].block, "center")

  // Re-measuring does not re-scroll: on an interactive step the person may have scrolled on purpose.
  instance.rerender()
  assert.equal(scrolls(search).length, 1)
})

test("a target already on screen is left alone", () => {
  const search = element({ rect: { top: 100, left: 200, width: 120, height: 40 } })
  mount({ defaultStepId: "search" }, { "#search": search })
  assert.deepEqual(scrolls(search), [])
})

test("reduced motion gets an instant scroll", () => {
  reducedMotion = true
  const search = element({ rect: { top: 2000, left: 200, width: 120, height: 40 } })
  reset()
  reducedMotion = true
  selectors.set("#search", search)
  render(ProductTour, { steps: STEPS, defaultOpen: true, defaultStepId: "search" })
  assert.equal(scrolls(search)[0].args[0].behavior, "auto")
})

test("scrollTargetIntoView={false} never scrolls", () => {
  const search = element({ rect: { top: 2000, left: 200, width: 120, height: 40 } })
  mount({ defaultStepId: "search", scrollTargetIntoView: false }, { "#search": search })
  assert.deepEqual(scrolls(search), [])
})

// --- naming ------------------------------------------------------------------------------------

test("the card is named by its title, or by the tour when a step has none", () => {
  const titled = mount({ defaultStepId: "search" }, { "#search": element() })
  const card = overlay(titled).card
  assert.ok(card.props["aria-labelledby"])
  assert.equal(card.props["aria-label"], undefined)
  // The harness answers every useId with the same string, so what is assertable is that the card
  // points at an id some node in the tree actually carries — not that the two ids differ.
  const describedBy = card.props["aria-describedby"]
  assert.equal(typeof describedBy, "string")
  assert.ok(describedBy.length > 0)
  const described = overlay(titled).nodes.filter((node) => node.props?.id === describedBy)
  assert.ok(described.length >= 1, "aria-describedby has to point at something that exists")

  const bare = render(ProductTour, {
    steps: [{ id: "one", content: "Just text." }],
    defaultOpen: true,
    label: "Welcome tour",
  })
  const bareCard = overlay(bare).card
  assert.equal(bareCard.props["aria-labelledby"], undefined)
  assert.equal(bareCard.props["aria-label"], "Welcome tour")
})

test("every decorative layer is hidden from the accessibility tree", () => {
  const instance = mount({ defaultStepId: "search" }, { "#search": element() })
  const view = overlay(instance)
  for (const node of [...view.dim, view.ring, view.blocker]) {
    assert.equal(node.props["aria-hidden"], "true")
  }
})
