// The naive version of this component is a requestAnimationFrame loop that lerps a number into
// state, and nearly everything that makes it usable is in what that loop gets wrong. So the cases
// below are written to pass against the shipped implementation and fail against the versions that
// look right:
//
//   - a loop with no reserved width, so the line the number sits on moves while it counts,
//   - a reserved width taken from the endpoints only, which under compact notation is narrower
//     than the "999" the count passes through,
//   - a reserved width re-measured from the live value every frame, which narrows frame by frame
//     while counting down and so shrinks the box under the number it is holding open,
//   - interpolating the formatted string rather than the number, which eats the currency symbol
//     and the group separators,
//   - `Intl.NumberFormat`'s default fraction digits, which render 1,203.882 then 1,229.44 then
//     1,234.5 on the way to a value whose own length never changes,
//   - decimals derived straight from `String(0.1 + 0.2)`, which pins seventeen of them,
//   - a reduced-motion flag read from state, which is a render behind and so animates one frame
//     for somebody who asked for none,
//   - a reduced-motion preference read once and never subscribed to,
//   - a changed target that restarts the count from zero instead of from where the number is,
//   - the counting digits left in the accessibility tree, so a screen reader reads sixty numbers
//     a second,
//   - an easing function listed as an effect dependency, which restarts the run on every render
//     it causes and therefore never finishes one,
//   - a hook that sits at the starting value forever in a browser with no IntersectionObserver,
//   - a pending frame left running after unmount.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { AnimatedNumber, useAnimatedNumber } = loadComponent(
  join(ROOT, "registry", "ui", "animated-number.tsx")
)

// --- a browser small enough to hold the parts this component touches -------------------------

let frameSeq = 0
let frames = new Map()
let cancelled = []
let nowMs = 0

function installFrames() {
  frameSeq = 0
  frames = new Map()
  cancelled = []
  // Deliberately not zero. A clock that starts at zero makes `now - began` and `now + began` the
  // same arithmetic on the first run, so the sign of the elapsed-time calculation goes untested —
  // which is exactly what a mutation run reported when this started at 0.
  nowMs = 1_000
  globalThis.requestAnimationFrame = (fn) => {
    const id = ++frameSeq
    frames.set(id, fn)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    cancelled.push(id)
    frames.delete(id)
  }
  Object.defineProperty(globalThis, "performance", {
    value: { now: () => nowMs },
    configurable: true,
    writable: true,
  })
}

function removeFrames() {
  delete globalThis.requestAnimationFrame
  delete globalThis.cancelAnimationFrame
}

/** Runs every frame callback that has not been cancelled, the way one tick of the clock would. */
function runFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const fn of pending) fn()
}

/** Advance the clock, deliver the frames, and re-render to see what they did. */
function tick(view, ms) {
  nowMs += ms
  runFrames()
  return view.rerender()
}

function withWindow(window, body) {
  const had = "window" in globalThis
  const previous = globalThis.window
  globalThis.window = window
  try {
    return body()
  } finally {
    if (had) globalThis.window = previous
    else delete globalThis.window
  }
}

/** A matchMedia whose answer can be changed, and which records what subscribed to it. */
function mediaWindow(matches = false) {
  const listeners = new Map()
  const query = {
    get matches() {
      return query._matches
    },
    _matches: matches,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn))
    },
  }
  return {
    window: { matchMedia: () => query },
    query,
    listeners,
    fireChange() {
      for (const fn of listeners.get("change") ?? []) fn()
    },
  }
}

function observerSpy() {
  const made = []
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.observed = []
      this.disconnects = 0
      made.push(this)
    }
    observe(element) {
      this.observed.push(element)
    }
    disconnect() {
      this.disconnects += 1
    }
  }
  return { made, FakeIntersectionObserver }
}

// --- reading the tree -------------------------------------------------------------------------

const spansOf = (tree) => byTag(walk(tree), "span")
const hostOf = (tree) => spansOf(tree)[0]
const classOf = (node) => String(node?.props?.className ?? "")
const sizerOf = (tree) => spansOf(tree).find((s) => classOf(s).includes("invisible"))
const liveOf = (tree) =>
  spansOf(tree).find(
    (s) => s.props?.["aria-hidden"] === "true" && !classOf(s).includes("invisible")
  )
const srOf = (tree) => spansOf(tree).find((s) => classOf(s).includes("sr-only"))
const shown = (tree) => liveOf(tree).props.children
const numberShown = (tree) => Number(String(shown(tree)).replace(/[^0-9.-]/g, ""))
const digitsIn = (text) => (String(text).match(/\p{Nd}/gu) ?? []).length

// --- without a frame clock: the number is simply its value ------------------------------------
// This is the server's answer and a no-JS page's answer, and it is also what any environment
// without requestAnimationFrame gets. It must be the real number, never a zero that counts up
// only where the loop happens to exist.

test("with no frame clock at all, the number is its value rather than the starting point", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 12480 })
  assert.equal(shown(view.tree), "12,480")
  view.unmount()
})

test("the first render carries the real number, so server HTML is not a zero", () => {
  removeFrames()
  // No effects have run at this point in a real commit either: this is the hydrated markup.
  const tree = AnimatedNumber({ value: 4096 }, null)
  assert.equal(shown(tree), "4,096")
  assert.equal(srOf(tree).props.children, "4,096")
})

test("a value that is not a number is shown rather than counted towards", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: Number.NaN })
  assert.equal(shown(view.tree), "NaN")
  assert.equal(frames.size, 0, "nothing should be scheduled towards a target it cannot reach")
  view.unmount()
})

// --- the width held open -----------------------------------------------------------------------

test("the digits are fixed-width and the widest value is rendered invisibly underneath", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 12480 })
  assert.match(classOf(hostOf(view.tree)), /tabular-nums/)
  const sizer = sizerOf(view.tree)
  assert.equal(sizer.props.children, "12,480")
  assert.equal(sizer.props["aria-hidden"], "true")
  // Stacked in one grid cell, so the cell is as wide as the widest and the live value sits in it.
  assert.match(classOf(sizer), /col-start-1/)
  assert.match(classOf(sizer), /row-start-1/)
  assert.match(classOf(liveOf(view.tree)), /col-start-1/)
  assert.match(classOf(liveOf(view.tree)), /row-start-1/)
  view.unmount()
})

test("the reserved width covers a value the count passes through, not just its endpoints", () => {
  removeFrames()
  // 0 to 1000 in compact notation finishes at "1K" but goes through "999", which is wider.
  const view = render(AnimatedNumber, {
    value: 1000,
    format: { notation: "compact" },
  })
  assert.equal(shown(view.tree), "1K")
  // Asserted in digits rather than as a string, because digits are what tabular-nums makes equal:
  // the count passes through three-digit values, so three digits is the width to hold open, and
  // which three-digit value is named is not observable in the rendered width.
  const reserved = String(sizerOf(view.tree).props.children)
  assert.equal(digitsIn(reserved), 3, `three digits wide, got ${reserved}`)
  assert.ok(digitsIn(reserved) > digitsIn("1K"), "wider than where the count finishes")
  view.unmount()
})

test("counting down does not narrow the reserved width as the number falls", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 0, from: 12480, duration: 1000 })
  assert.equal(sizerOf(view.tree).props.children, "12,480")
  const widths = []
  for (let i = 0; i < 4; i++) {
    tick(view, 200)
    widths.push(sizerOf(view.tree).props.children)
  }
  assert.deepEqual(
    widths,
    ["12,480", "12,480", "12,480", "12,480"],
    "the box must not shrink under the number it is holding open"
  )
  view.unmount()
})

test("align=end puts the number against the far edge of the width held open", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 7, align: "end" })
  assert.match(classOf(liveOf(view.tree)), /justify-self-end/)
  const start = render(AnimatedNumber, { value: 7 })
  assert.match(classOf(liveOf(start.tree)), /justify-self-start/)
  view.unmount()
  start.unmount()
})

// --- what is interpolated ----------------------------------------------------------------------

test("the number is interpolated and formatted each frame, so currency survives the trip", () => {
  installFrames()
  const view = render(AnimatedNumber, {
    value: 12480,
    duration: 1000,
    format: { style: "currency", currency: "USD" },
  })
  tick(view, 300)
  const mid = String(shown(view.tree))
  assert.match(mid, /^\$[\d,]+\.\d{2}$/, `a formatted frame, got ${mid}`)
  assert.ok(numberShown(view.tree) > 0 && numberShown(view.tree) < 12480, `mid-count, got ${mid}`)
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(shown(view.tree), "$12,480.00")
  view.unmount()
})

test("decimals are pinned, so the digits after the point do not flicker on the way", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1234.5, duration: 1000 })
  const seen = []
  for (let i = 0; i < 4; i++) {
    tick(view, 200)
    seen.push(String(shown(view.tree)))
  }
  for (const text of seen) {
    assert.match(text, /^[\d,]+\.\d$/, `exactly one decimal every frame, got ${text}`)
  }
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(shown(view.tree), "1,234.5")
  view.unmount()
})

test("a float's tail is not mistaken for the caller's precision", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 0.1 + 0.2 })
  assert.equal(shown(view.tree), "0.3")
  view.unmount()
})

test("a whole number stays whole while it counts", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 500, duration: 1000 })
  tick(view, 300)
  assert.match(String(shown(view.tree)), /^\d+$/, "no decimals appear in a run between integers")
  view.unmount()
})

test("fraction digits the caller asked for are left exactly as given", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 1234.5,
    format: { minimumFractionDigits: 3, maximumFractionDigits: 3 },
  })
  assert.equal(shown(view.tree), "1,234.500")
  view.unmount()
})

test("percent keeps its own default rather than borrowing the fraction's decimals", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 0.42, format: { style: "percent" } })
  assert.equal(shown(view.tree), "42%")
  view.unmount()
})

test("the locale the caller passes is the one used", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 12480.5, locale: "de-DE" })
  assert.equal(shown(view.tree), "12.480,5")
  view.unmount()
})

// --- counting ----------------------------------------------------------------------------------

test("the number counts from the starting value to the target", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1000, from: 0, duration: 1000 })
  assert.equal(numberShown(view.tree), 0, "it begins at the starting value, before the first frame")
  tick(view, 250)
  const quarter = numberShown(view.tree)
  assert.ok(quarter > 0 && quarter < 1000, `moving, got ${quarter}`)
  tick(view, 250)
  assert.ok(numberShown(view.tree) >= quarter, "it moves towards the target, never away")
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(numberShown(view.tree), 1000)
  view.unmount()
})

test("a duration of zero means the value simply appears", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 900, duration: 0 })
  assert.equal(numberShown(view.tree), 900)
  assert.equal(frames.size, 0)
  view.unmount()
})

test("animateOnMount=false shows the first value, then counts when it changes", () => {
  installFrames()
  const view = render(AnimatedNumber, {
    value: 900,
    duration: 1000,
    animateOnMount: false,
  })
  assert.equal(numberShown(view.tree), 900, "the first value is not counted to")
  assert.equal(frames.size, 0)
  view.update({ value: 1800, duration: 1000, animateOnMount: false })
  tick(view, 200)
  const mid = numberShown(view.tree)
  assert.ok(mid > 900 && mid < 1800, `the change is counted, got ${mid}`)
  view.unmount()
})

test("a target that changes mid-count is picked up from where the number is", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 10000, from: 0, duration: 1000 })
  tick(view, 500)
  const before = numberShown(view.tree)
  assert.ok(before > 1000, `halfway up, got ${before}`)

  view.update({ value: 20000, from: 0, duration: 1000 })
  const after = numberShown(view.tree)
  assert.ok(
    after >= before * 0.9,
    `a new target must not restart the count at the bottom: was ${before}, now ${after}`
  )
  nowMs += 3000
  runFrames()
  view.rerender()
  assert.equal(numberShown(view.tree), 20000)
  view.unmount()
})

test("onComplete reports each arrival once", () => {
  installFrames()
  let completions = 0
  const props = { value: 400, duration: 1000, onComplete: () => (completions += 1) }
  const view = render(AnimatedNumber, props)
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(completions, 1)
  // Re-rendering for any other reason is not a second arrival at the same number.
  view.update({ ...props, align: "end" })
  view.rerender()
  assert.equal(completions, 1, "the same target must not be reported twice")

  view.update({ ...props, value: 900 })
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(completions, 2, "a new target that arrives is a new completion")
  view.unmount()
})

test("the easing in force is the one passed most recently", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1000, from: 0, duration: 1000 })
  // An easing that is already finished at every point: the next frame must land on the target,
  // which it can only do if the function is read live rather than captured on the first render.
  view.update({ value: 1000, from: 0, duration: 1000, easing: () => 1 })
  tick(view, 100)
  assert.equal(numberShown(view.tree), 1000)
  view.unmount()
})

// --- reduced motion ----------------------------------------------------------------------------

test("a reduced-motion preference means the value appears and never counts", () => {
  installFrames()
  const media = mediaWindow(true)
  withWindow(media.window, () => {
    const view = render(AnimatedNumber, { value: 12480, from: 0, duration: 1000 })
    assert.equal(numberShown(view.tree), 12480, "it arrives without counting")
    assert.equal(frames.size, 0, "no frame is ever requested")
    view.unmount()
  })
})

test("the reduced-motion preference is subscribed to, not just read once", () => {
  installFrames()
  const media = mediaWindow(false)
  withWindow(media.window, () => {
    const view = render(AnimatedNumber, { value: 12480, from: 0, duration: 1000 })
    assert.ok(
      (media.listeners.get("change") ?? []).length > 0,
      "a change in the preference has to reach a component that is already mounted"
    )
    media.query._matches = true
    media.fireChange()
    view.rerender()
    assert.equal(numberShown(view.tree), 12480, "turning it on mid-count finishes the count")
    view.unmount()
    assert.equal(
      (media.listeners.get("change") ?? []).length,
      0,
      "and the subscription is given back, under the name it was taken out in"
    )
  })
})

test("a browser with no matchMedia still counts rather than throwing", () => {
  installFrames()
  withWindow({}, () => {
    const view = render(AnimatedNumber, { value: 100, from: 0, duration: 1000 })
    tick(view, 500)
    assert.ok(numberShown(view.tree) > 0)
    view.unmount()
  })
})

// --- starting on view --------------------------------------------------------------------------

test("startOnView holds at the starting value until the element is actually seen", () => {
  installFrames()
  const spy = observerSpy()
  globalThis.IntersectionObserver = spy.FakeIntersectionObserver
  try {
    const view = render(AnimatedNumber, {
      value: 500,
      from: 0,
      duration: 1000,
      startOnView: true,
      threshold: 0.5,
    })
    assert.equal(numberShown(view.tree), 0, "nothing counts off-screen")
    assert.equal(frames.size, 0)
    const observer = spy.made[spy.made.length - 1]
    assert.equal(observer.options.threshold, 0.5)
    assert.ok(observer.observed.length > 0, "the host element is the one being watched")

    observer.callback([{ isIntersecting: true }])
    view.rerender()
    tick(view, 300)
    assert.ok(numberShown(view.tree) > 0, "it counts once it has been seen")
    assert.ok(observer.disconnects > 0, "and stops watching, because it only counts once")

    nowMs += 2000
    runFrames()
    view.rerender()
    assert.equal(numberShown(view.tree), 500)
    view.unmount()
  } finally {
    delete globalThis.IntersectionObserver
  }
})

test("an element that is never seen still reads as the real number to a screen reader", () => {
  installFrames()
  const spy = observerSpy()
  globalThis.IntersectionObserver = spy.FakeIntersectionObserver
  try {
    const view = render(AnimatedNumber, { value: 500, from: 0, startOnView: true })
    assert.equal(numberShown(view.tree), 0)
    assert.equal(srOf(view.tree).props.children, "500")
    view.unmount()
  } finally {
    delete globalThis.IntersectionObserver
  }
})

test("startOnView in a browser with no observer counts rather than sitting at zero", () => {
  installFrames()
  delete globalThis.IntersectionObserver
  const view = render(AnimatedNumber, {
    value: 500,
    from: 0,
    duration: 1000,
    startOnView: true,
  })
  tick(view, 400)
  assert.ok(numberShown(view.tree) > 0, "an unsupported observer must not hide the number forever")
  view.unmount()
})

// --- what a screen reader gets -----------------------------------------------------------------

test("only the final value is exposed; the counting digits are hidden from the reader", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 12480, from: 0, duration: 1000 })
  tick(view, 300)
  assert.equal(liveOf(view.tree).props["aria-hidden"], "true")
  assert.equal(sizerOf(view.tree).props["aria-hidden"], "true")
  assert.equal(
    srOf(view.tree).props.children,
    "12,480",
    "the number a reader is told is the one that is true, not the frame it caught"
  )
  assert.equal(srOf(view.tree).props["aria-hidden"], undefined)
  view.unmount()
})

test("the announced value follows the target, formatted the same way", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 12480,
    format: { style: "currency", currency: "EUR" },
    locale: "de-DE",
  })
  assert.equal(srOf(view.tree).props.children, liveOf(view.tree).props.children)
  view.unmount()
})

// --- housekeeping ------------------------------------------------------------------------------

test("unmounting cancels the frame that was still owed", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1000, from: 0, duration: 1000 })
  tick(view, 200)
  assert.ok(frames.size > 0, "a run is in flight")
  view.unmount()
  assert.ok(cancelled.length > 0, "the pending frame is cancelled")
  const before = frameSeq
  runFrames()
  assert.equal(frameSeq, before, "and nothing reschedules itself after the component is gone")
})

test("the caller's class names and attributes land on the host element", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 7,
    className: "text-3xl font-semibold",
    id: "visitors",
  })
  const host = hostOf(view.tree)
  assert.match(classOf(host), /text-3xl/)
  assert.match(classOf(host), /inline-grid/)
  assert.equal(host.props.id, "visitors")
  view.unmount()
})

// --- the defaults themselves -------------------------------------------------------------------

test("counting starts at zero when no starting value is given", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1000, duration: 1000 })
  assert.equal(numberShown(view.tree), 0)
  view.unmount()
})

test("a count with no duration given still counts", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 1000 })
  tick(view, 100)
  const mid = numberShown(view.tree)
  assert.ok(mid > 0 && mid < 1000, `the default duration animates, got ${mid}`)
  view.unmount()
})

test("a sub-millisecond duration is still a duration", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 400, from: 0, duration: 1 })
  assert.ok(frames.size > 0, "only zero or less means no animation at all")
  view.unmount()
})

test("the default is to start counting as soon as any part of the element is in view", () => {
  installFrames()
  const spy = observerSpy()
  globalThis.IntersectionObserver = spy.FakeIntersectionObserver
  try {
    const view = render(AnimatedNumber, { value: 500, startOnView: true })
    assert.equal(spy.made[spy.made.length - 1].options.threshold, 0)
    view.unmount()
  } finally {
    delete globalThis.IntersectionObserver
  }
})

test("a runtime with no performance clock counts on the ordinary one", () => {
  installFrames()
  const hadPerformance = globalThis.performance
  const realDateNow = Date.now
  delete globalThis.performance
  Date.now = () => nowMs
  try {
    const view = render(AnimatedNumber, { value: 1000, from: 0, duration: 1000 })
    tick(view, 250)
    const mid = numberShown(view.tree)
    assert.ok(mid > 0 && mid < 1000, `counting without performance.now, got ${mid}`)
    view.unmount()
  } finally {
    Date.now = realDateNow
    Object.defineProperty(globalThis, "performance", {
      value: hadPerformance,
      configurable: true,
      writable: true,
    })
  }
})

// --- boundaries --------------------------------------------------------------------------------

test("arriving exactly on the duration boundary is an arrival", () => {
  installFrames()
  let completions = 0
  const view = render(AnimatedNumber, {
    value: 400,
    duration: 1000,
    onComplete: () => (completions += 1),
  })
  nowMs += 1000
  runFrames()
  // Asserted before re-rendering on purpose: re-running the effect would reach the arrival by
  // another route (the start and the target have become the same number), and the question here is
  // whether the frame that landed on the boundary counted as having landed.
  assert.equal(completions, 1, "elapsed === duration is done, not one frame short of done")
  view.rerender()
  assert.equal(numberShown(view.tree), 400)
  view.unmount()
})

test("a target that changes while the number sits at exactly zero counts up from the zero", () => {
  installFrames()
  const settled = { value: 0, from: 100, duration: 1000 }
  const view = render(AnimatedNumber, settled)
  nowMs += 2000
  runFrames()
  view.rerender()
  assert.equal(numberShown(view.tree), 0, "it has arrived at zero")

  view.update({ ...settled, value: 500 })
  tick(view, 50)
  const first = numberShown(view.tree)
  assert.ok(
    first < 100,
    `zero is where the number is, so zero is where the next count starts: got ${first}`
  )
  view.unmount()
})

test("a single-digit value still holds a width open", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 5 })
  assert.ok(
    String(sizerOf(view.tree).props.children).length > 0,
    "a one-digit number reserves one digit, not nothing"
  )
  view.unmount()
})

test("a starting value that is not a number neither counts nor invents decimals", () => {
  installFrames()
  const view = render(AnimatedNumber, { value: 100, from: Number.NaN })
  assert.equal(shown(view.tree), "100")
  view.unmount()
})

test("a number too large to carry a decimal point does not acquire one", () => {
  removeFrames()
  const view = render(AnimatedNumber, { value: 1e21 })
  assert.ok(
    !String(shown(view.tree)).includes("."),
    `no decimals are derived from an exponential string, got ${shown(view.tree)}`
  )
  view.unmount()
})

// --- the digit rules the caller sets are left alone ---------------------------------------------

test("a minimum fraction digits on its own is left exactly as given", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 1234.5,
    format: { minimumFractionDigits: 3 },
  })
  assert.equal(shown(view.tree), "1,234.500")
  view.unmount()
})

test("a maximum fraction digits on its own is left exactly as given", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 1234.567,
    format: { maximumFractionDigits: 2 },
  })
  assert.equal(shown(view.tree), "1,234.57")
  view.unmount()
})

test("significant digits are left alone, because fraction digits can outrank them", () => {
  removeFrames()
  // With morePrecision the two rules compete and the wider one wins, so injecting fraction digits
  // here would quietly override what the caller asked for: 1,234.5678 instead of 1,234.568.
  const view = render(AnimatedNumber, {
    value: 1234.5678,
    format: { maximumSignificantDigits: 2, roundingPriority: "morePrecision" },
  })
  assert.equal(shown(view.tree), "1,234.568")
  view.unmount()
})

test("standard notation said out loud still gets its decimals pinned", () => {
  installFrames()
  const view = render(AnimatedNumber, {
    value: 1234.5,
    duration: 1000,
    format: { notation: "standard" },
  })
  tick(view, 200)
  assert.match(
    String(shown(view.tree)),
    /^[\d,]+\.\d$/,
    `naming the default notation is not a reason to stop pinning, got ${shown(view.tree)}`
  )
  view.unmount()
})

test("the reserved width covers the widest point under scientific notation too", () => {
  removeFrames()
  const view = render(AnimatedNumber, {
    value: 1000,
    format: { notation: "scientific" },
  })
  // The count passes through 999, which is "9.99E2" - four digits, where both endpoints are two.
  // Without the interior samples the box would be three characters short of the number it holds.
  const reserved = String(sizerOf(view.tree).props.children)
  assert.ok(
    digitsIn(reserved) >= digitsIn("9.99E2"),
    `at least as wide as the widest point on the path, got ${reserved}`
  )
  view.unmount()
})

test("the hook hands back the frame, the target and the width to hold open", () => {
  installFrames()
  const Probe = (props) => {
    const state = useAnimatedNumber(props)
    return {
      type: "span",
      props: { "data-state": state, children: state.text },
    }
  }
  const view = render(Probe, { value: 1000, from: 0, duration: 1000 })
  tick(view, 250)
  const state = walk(view.tree)[0].props["data-state"]
  assert.equal(state.finalText, "1,000")
  assert.equal(state.reserveText, "1,000")
  assert.ok(state.value > 0 && state.value < 1000, `mid-count, got ${state.value}`)
  assert.equal(state.isAnimating, true)
  assert.equal(state.text, String(state.value.toLocaleString("en-US", { maximumFractionDigits: 0 })))

  nowMs += 2000
  runFrames()
  view.rerender()
  const settled = walk(view.tree)[0].props["data-state"]
  assert.equal(settled.isAnimating, false)
  assert.equal(settled.value, 1000)
  view.unmount()
})
