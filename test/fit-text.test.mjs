// Shrinking text to fit its box is written the same wrong way almost every time, and the cases
// below are written to fail against that version rather than to describe this one:
//
//   - measure the string once and scale (`16 * available / width16`), which assumes glyph width is
//     proportional to font size. It is not — the same string measures 12.49px per point of size at
//     16px and 11.43px at 64px — so the estimate throws away sizes that fit and, with a face that
//     tracks the other way, names one that overflows,
//   - bisect to a fraction of a pixel, which is precision below the rounding of `scrollWidth` and
//     lands outside the box it just verified,
//   - nudge relative to the current size (shrink while it overflows, grow while there is room),
//     which has no fixed point and oscillates between two sizes forever inside a ResizeObserver,
//   - read the ceiling without clearing the size already applied, which ratchets: every measurement
//     takes the last fitted size as its maximum and the text can never grow back when the box
//     widens,
//   - and treat a box that has not been laid out — a closed dialog, an unselected tab — as "nothing
//     fits", which leaves the text at the 12px floor on the one state no resize comes to correct.
//
// What the harness can and cannot see matters here more than usual. It has no layout, so every
// measurement a component takes reads as "not measured yet" unless the test supplies the numbers
// itself: the hook takes the ref, so a test can hand it a node whose `scrollWidth` answers from a
// measured width model (`fullscreen-button` builds its target the same way), and `FitText` holds
// its own ref, so layout is defined onto the stand-in the harness filled and the tree re-rendered.
// Nothing here asserts that a glyph is any particular number of pixels wide; the model only has to
// be non-proportional and monotonic, which is what the component relies on and what was measured.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { FitText, fitFontSize, useFitFontSize } = loadComponent(
  join(ROOT, "registry", "ui", "fit-text.tsx")
)

// --- the width model ----------------------------------------------------------------------------

// Pixels of advance per point of font size, interpolated between the two sizes measured on the
// default UI face: 12.49 at 16px, 11.43 at 64px. The point is only that it is *not* a constant —
// a model with one number per string would make the ratio shortcut correct and the search pointless.
const perPoint = (size) => 12.49 + ((size - 16) * (11.43 - 12.49)) / (64 - 16)

/** Width of the test string at `size`, rounded the way `scrollWidth` rounds. */
const widthAt = (size) => Math.round(size * perPoint(size))

/** The answer by exhaustive search, which is what the binary search has to agree with. */
function byScan(available, min, max) {
  let best = min
  for (let size = min; size <= max; size++) if (widthAt(size) - available <= 1) best = size
  return best
}

/** What the one-measurement-and-a-ratio version everybody writes first would say. */
const byRatio = (available, min, max) =>
  Math.min(max, Math.max(min, Math.floor(16 * (available / widthAt(16)))))

/**
 * A predicate that throws once it has been asked an absurd number of times.
 *
 * A bisection that does not narrow its range — `mid - 1` written as `mid + 1`, a step of 0 — does
 * not return a wrong answer, it never returns at all. Without a cap the whole suite hangs and the
 * run has to be killed, which reads as "no failures" for as long as anyone is willing to wait; the
 * oscillation this component was written to avoid fails exactly this way. The limit is far above
 * the seven a bisection over [8, 96] needs, so nothing legitimate reaches it.
 */
const bounded = (fits, limit = 64) => {
  let asked = 0
  return (size) => {
    if (++asked > limit) throw new Error(`the search did not converge: ${asked} measurements`)
    return fits(size)
  }
}

// --- nodes with layout --------------------------------------------------------------------------

/**
 * Gives `node` the two measurements the component reads, on one axis.
 *
 * `client` is the box, `scroll` is the content at whatever size is currently applied — which is the
 * whole mechanism: the component writes a candidate to the real element and reads the consequence
 * back, so the node has to answer as a function of its own style rather than from a table.
 */
function layout(node, { box, cssSize = 48, axis = "Width" } = {}) {
  let current = box
  node.cssSize = cssSize
  node.reads = []
  Object.defineProperty(node, `client${axis}`, { get: () => current, configurable: true })
  Object.defineProperty(node, `scroll${axis}`, {
    configurable: true,
    get() {
      const size = parseFloat(node.style.fontSize) || cssSize
      node.reads.push(size)
      // The same cap as `bounded`, at the other end: inside the hook the predicate is the
      // component's own closure, so a search that does not converge cannot be stopped by the test
      // that called it. Left uncapped the file does not fail, it stops — and a suite that never
      // finishes reads as a suite with no failures for as long as anyone waits.
      if (node.reads.length > 400) throw new Error("measured the element without converging")
      return widthAt(size)
    },
  })
  node.resize = (next) => {
    current = next
  }
  return node
}

const makeNode = (options) => layout({ style: { fontSize: "" } }, options)

function Probe({ nodeRef, options }) {
  return { type: "span", props: { result: useFitFontSize(nodeRef, options) } }
}

/**
 * Renders the hook over `node` and settles it with `getComputedStyle` answering `cssSize`.
 *
 * Two passes rather than one because `render` installs its own `getComputedStyle` before the first
 * one and only `render` does — so the stub that reports a font size has to go in afterwards, and
 * the tree be settled again, for the ceiling to be read from anything but NaN. Tests that pass an
 * explicit `max` never reach it and could skip this, but they go through the same door so that a
 * ceiling appearing where none was expected shows up as a failure rather than as a coincidence.
 */
function mount(node, options = {}) {
  const ui = render(Probe, { nodeRef: { current: node }, options })
  globalThis.getComputedStyle = (el) => ({ direction: "ltr", fontSize: `${el.cssSize ?? 16}px` })
  ui.rerender()
  return ui
}

const resultOf = (ui) => ui.tree.props.result

/** Installs a recording ResizeObserver, and returns the instances built in creation order. */
function stubResizeObserver() {
  const instances = []
  globalThis.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback
      this.observed = []
      this.disconnected = false
      instances.push(this)
    }
    observe(el) {
      this.observed.push(el)
    }
    disconnect() {
      this.disconnected = true
    }
  }
  return instances
}

const withoutGlobals = (...names) => {
  for (const name of names) delete globalThis[name]
}

// --- the arithmetic -----------------------------------------------------------------------------

test("fitFontSize returns the largest whole size that fits", () => {
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded((size) => size <= 30) }), 30)
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded((size) => size <= 12) }), 12)
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded(() => true) }), 96)
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded(() => false) }), 12)
})

test("fitFontSize agrees with an exhaustive scan at every box width", () => {
  // The search and the scan are two implementations of the same question, so any off-by-one in the
  // bisection — `mid - 1` for `mid`, `<=` for `<`, keeping the wrong half — separates them
  // somewhere in here. A single width would not: a wrong search is still right about half the time.
  const disagreements = []
  for (let box = 40; box <= 1200; box += 7) {
    const searched = fitFontSize({
      min: 12,
      max: 96,
      fits: bounded((size) => widthAt(size) - box <= 1),
    })
    const scanned = byScan(box, 12, 96)
    if (searched !== scanned) disagreements.push({ box, searched, scanned })
  }
  assert.deepEqual(disagreements, [])
})

test("the size it returns fits, and one more pixel does not", () => {
  // The two halves of "largest that fits", asserted separately so a search that is conservative by
  // a step (correct, but throwing away a size the box had room for) is not mistaken for a pass.
  // From a width the floor itself fits: below that the answer is `min` and it overflows by design,
  // which is the case the overflowing test covers rather than this one.
  assert.ok(widthAt(12) <= 160)
  for (let box = 160; box <= 900; box += 13) {
    const size = fitFontSize({ min: 12, max: 96, fits: bounded((s) => widthAt(s) - box <= 1) })
    assert.ok(widthAt(size) - box <= 1, `${size}px overflows a ${box}px box`)
    if (size < 96) {
      assert.ok(widthAt(size + 1) - box > 1, `${size + 1}px would also have fitted a ${box}px box`)
    }
  }
})

test("the ratio shortcut it replaces gets a smaller answer than the box allows", () => {
  // Not a test of the component so much as of the reason it is a search: with glyph width
  // non-proportional, scaling from one measurement at 16px is wrong at most widths, and every one
  // of those is a size the text could have been and was not. The direction depends on the face —
  // this model tracks tighter as it grows, so the estimate is short; a face that tracks looser
  // overshoots and overflows, which is the same bug costing more.
  const wrong = []
  for (let box = 60; box <= 900; box += 10) {
    if (byRatio(box, 12, 96) !== byScan(box, 12, 96)) wrong.push(box)
  }
  assert.ok(wrong.length > 20, `the ratio estimate was wrong at only ${wrong.length} widths`)
  assert.equal(byRatio(260, 12, 96), 20)
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded((s) => widthAt(s) - 260 <= 1) }), 21)
})

test("one pixel of reported overflow still counts as fitting", () => {
  // `scrollWidth` and `clientWidth` are rounded integers, so a box whose text fits it exactly can
  // report a pixel of overflow anyway. Without the slack that pixel costs a whole step of size, and
  // it costs it on the most ordinary case there is: text sized to its box.
  const exactlyOneOver = (size) => (size <= 40 ? 0 : 2)
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded((s) => exactlyOneOver(s) <= 1) }), 40)

  const node = makeNode({ box: 240 })
  const fitted = byScan(240, 12, 96)
  // The same tolerance through the hook: a box one pixel narrower than the content at the fitted
  // size must still settle on that size rather than stepping down.
  node.resize(widthAt(fitted) - 1)
  const ui = mount(node, { min: 12, max: 96 })
  assert.equal(resultOf(ui).size, fitted)
  assert.equal(resultOf(ui).overflowing, false)
})

test("a range with one candidate is not measured at all", () => {
  // The early return is not a micro-optimisation: `fits` forces a layout every time it is called,
  // and a caller whose min and max have met has already said what the size is.
  let asked = 0
  assert.equal(
    fitFontSize({
      min: 20,
      max: 20,
      fits: () => {
        asked++
        return true
      },
    }),
    20
  )
  assert.equal(asked, 0, "measured a range it had no choice about")
})

test("fitFontSize falls to min when nothing fits, never below it", () => {
  assert.equal(fitFontSize({ min: 12, max: 96, fits: bounded(() => false) }), 12)
  assert.equal(fitFontSize({ min: 1, max: 96, fits: bounded(() => false) }), 1)
  // A floor of zero or less is not a size anything can render at; the smallest it will name is 1.
  assert.equal(fitFontSize({ min: 0, max: 96, fits: bounded(() => false) }), 1)
  assert.equal(fitFontSize({ min: -40, max: 96, fits: bounded(() => false) }), 1)
})

test("fitFontSize never answers outside the range it was given", () => {
  for (const [min, max] of [
    [12, 96],
    [8, 9],
    [20, 20],
    [1, 400],
  ]) {
    for (const fits of [() => true, () => false, (s) => s % 2 === 0, (s) => s < (min + max) / 2]) {
      const size = fitFontSize({ min, max, fits: bounded(fits) })
      assert.ok(size >= min && size <= max, `${size} is outside [${min}, ${max}]`)
    }
  }
})

test("a NaN or inverted range answers with the floor rather than with garbage", () => {
  // `parseFloat` of an empty computed style is NaN, and a caller can easily name a `min` above the
  // design size. Either one, carried through the arithmetic, produces a value that `style.fontSize`
  // ignores silently — the failure that looks like the component doing nothing at all.
  assert.equal(fitFontSize({ min: NaN, max: 40, fits: bounded((s) => s <= 20) }), 20)
  assert.equal(fitFontSize({ min: NaN, max: 40, fits: bounded(() => false) }), 12)
  assert.equal(fitFontSize({ min: 16, max: NaN, fits: bounded(() => true) }), 16)
  assert.equal(fitFontSize({ min: 20, max: 16, fits: bounded(() => true) }), 20)
  assert.ok(Number.isInteger(fitFontSize({ min: 12.7, max: 40.9, fits: bounded(() => true) })))
})

test("fits is asked about whole pixels only, a logarithmic number of times", () => {
  const asked = []
  const size = fitFontSize({
    min: 8,
    max: 96,
    fits: (candidate) => {
      asked.push(candidate)
      // Asserted after the call returns, which a search that does not narrow never does.
      if (asked.length > 64) throw new Error(`the search did not converge: ${asked.length}`)
      return candidate <= 55
    },
  })
  assert.equal(size, 55)
  assert.ok(
    asked.every(Number.isInteger),
    `fits was asked about a fraction of a pixel: ${asked.join(", ")}`
  )
  // 89 candidates, so a scan would be ~55 forced layouts and a bisection is 7. The bound is what
  // separates a search from a loop that happens to return the same number.
  assert.ok(asked.length <= 8, `took ${asked.length} measurements, expected a bisection`)
  assert.equal(new Set(asked).size, asked.length, "measured the same size twice")
})

// --- measuring ----------------------------------------------------------------------------------

test("the hook settles on the fitting size and applies it to the element", () => {
  const node = makeNode({ box: 240 })
  const ui = mount(node, { min: 12, max: 96 })

  assert.deepEqual(resultOf(ui), { size: byScan(240, 12, 96), overflowing: false })
  // Applied to the element and not only reported, because the element is what the reader sees, and
  // left at the chosen size rather than at whichever candidate the search tried last.
  assert.equal(node.style.fontSize, `${byScan(240, 12, 96)}px`)
})

test("a box with no layout is not measured, and keeps the size already applied", () => {
  // Zero is "not measured yet", not "nothing fits" — a closed dialog, an unselected tab, anything
  // `display: none`. Shrinking on the strength of it leaves 12px text for when the dialog opens.
  const node = makeNode({ box: 0 })
  node.style.fontSize = "33px"
  const ui = mount(node, { min: 12, max: 96 })

  assert.deepEqual(resultOf(ui), { size: null, overflowing: false })
  // And the size it found on arrival is put back. Clearing it to read the ceiling and returning
  // without restoring drops the element to its CSS size with no re-render owed to correct it.
  assert.equal(node.style.fontSize, "33px")

  // "Not measured" is exactly zero. A box of one pixel has been laid out and is merely hopeless,
  // which is a different answer — the floor, clipping, and said so — from "ask me again later".
  const sliver = makeNode({ box: 1 })
  assert.deepEqual(resultOf(mount(sliver, { min: 12, max: 96 })), { size: 12, overflowing: true })
})

test("the ceiling is the stylesheet's size, re-read every time, so the text grows back", () => {
  // The ratchet: read the ceiling without clearing what was applied last and every measurement
  // caps itself at the previous answer. Narrow the box, widen it again, and the text stays small
  // forever — which is also how a responsive ceiling (`text-2xl md:text-5xl`) is picked up at all.
  const node = makeNode({ box: 240, cssSize: 30 })
  const ui = mount(node, { min: 12 })
  assert.equal(resultOf(ui).size, byScan(240, 12, 30))

  node.resize(1000)
  ui.rerender()
  assert.equal(resultOf(ui).size, 30, "did not grow back to the size the stylesheet asks for")

  node.resize(120)
  ui.rerender()
  assert.equal(resultOf(ui).size, byScan(120, 12, 30))

  node.resize(1000)
  ui.rerender()
  assert.equal(resultOf(ui).size, 30)
})

test("an explicit max is the ceiling, and the computed style is never consulted", () => {
  const node = makeNode({ box: 1000, cssSize: 30 })
  const ui = render(Probe, { nodeRef: { current: node }, options: { min: 12, max: 20 } })
  globalThis.getComputedStyle = () => {
    throw new Error("read the computed style although max was given")
  }
  ui.rerender()

  assert.equal(resultOf(ui).size, 20)
  globalThis.getComputedStyle = () => ({ direction: "ltr" })
})

test("text that does not fit even at min reports overflowing and sits at min", () => {
  const node = makeNode({ box: 40 })
  const ui = mount(node, { min: 12, max: 96 })

  // Not "keep shrinking until it fits": a 6px label is a worse outcome than a clipped one, so the
  // floor holds and the component says it is clipping rather than pretending to have fitted.
  assert.deepEqual(resultOf(ui), { size: 12, overflowing: true })
  assert.equal(node.style.fontSize, "12px")
})

test("more than one line measures height instead of width", () => {
  const tall = makeNode({ box: 300, axis: "Height" })
  assert.equal(resultOf(mount(tall, { min: 12, max: 96, lines: 3 })).size, byScan(300, 12, 96))

  // And the width is then not what is consulted: a node with width but no height is a box that has
  // not been laid out on the axis being asked about.
  const wide = makeNode({ box: 300, axis: "Width" })
  assert.deepEqual(resultOf(mount(wide, { min: 12, max: 96, lines: 3 })), {
    size: null,
    overflowing: false,
  })
})

test("it observes its own box, ignores sub-pixel jitter, and re-measures on a real change", () => {
  const observers = stubResizeObserver()
  const node = makeNode({ box: 240 })
  const ui = mount(node, { min: 12, max: 96 })

  assert.ok(observers.length > 0, "nothing was observed")
  // The last one is the live observer: a pass here is not a commit, so the harness re-runs the
  // effect without running the previous cleanup, and the earlier instances are that artifact.
  const observer = observers.at(-1)
  assert.equal(observer.observed[0], node, "observed something other than the element")

  // The first callback always measures — a browser delivers one on `observe` and there is no width
  // to compare it against yet — so the jitter is only a second callback, after a baseline exists.
  observer.callback([{ contentRect: { width: 240 } }])
  // Blanked, because a re-measure of an unchanged box arrives at the same number — without this,
  // "it did not re-measure" and "it re-measured" look identical.
  node.style.fontSize = ""
  observer.callback([{ contentRect: { width: 240.2 } }])
  assert.equal(node.style.fontSize, "", "re-measured for a fifth of a pixel")

  // Half a pixel is the boundary and it is on the measuring side: the guard skips what is strictly
  // under 0.5, so a change of exactly that much is a change.
  node.resize(240.5)
  observer.callback([{ contentRect: { width: 240.5 } }])
  assert.equal(node.style.fontSize, `${byScan(240.5, 12, 96)}px`, "ignored a half-pixel change")

  node.style.fontSize = ""
  node.resize(600)
  observer.callback([{ contentRect: { width: 600 } }])
  assert.equal(node.style.fontSize, `${byScan(600, 12, 96)}px`)

  ui.unmount()
  assert.ok(
    observers.every((each) => each.disconnected),
    "an observer was left running after unmount"
  )
  withoutGlobals("ResizeObserver")
})

test("a font arriving after the first measurement re-measures, with or without ResizeObserver", async () => {
  // A face swapping in changes every glyph width without changing the box, so no observer reports
  // it. Gating the wait on ResizeObserver — which it was — left the text sized for the fallback
  // face in the browsers least likely to have one and most likely to apply a font late.
  for (const withObserver of [true, false]) {
    const observers = withObserver ? stubResizeObserver() : []
    globalThis.document = { fonts: { ready: Promise.resolve() } }
    const node = makeNode({ box: 240 })
    const ui = mount(node, { min: 12, max: 96 })

    node.style.fontSize = ""
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(
      node.style.fontSize,
      `${byScan(240, 12, 96)}px`,
      `no re-measure on font load (ResizeObserver present: ${withObserver})`
    )

    ui.unmount()
    void observers
    withoutGlobals("document", ...(withObserver ? ["ResizeObserver"] : []))
  }
})

test("a font arriving after unmount measures nothing", async () => {
  let release
  globalThis.document = { fonts: { ready: new Promise((resolve) => (release = resolve)) } }
  const node = makeNode({ box: 240 })
  const ui = mount(node, { min: 12, max: 96 })

  ui.unmount()
  node.style.fontSize = ""
  release()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(node.style.fontSize, "", "measured an element it had already let go of")
  withoutGlobals("document")
})

// --- the markup ---------------------------------------------------------------------------------

test("one line truncates, several clamp to the number asked for", () => {
  const single = render(FitText, { children: "Hello" }).tree
  assert.match(single.props.className, /\btruncate\b/)
  assert.equal(single.props.style.WebkitLineClamp, undefined)

  const clamped = render(FitText, { children: "Hello", lines: 3 }).tree
  assert.match(clamped.props.className, /\boverflow-hidden\b/)
  assert.doesNotMatch(clamped.props.className, /\btruncate\b/)
  // Inline rather than a class, because no class is generated for an arbitrary clamp count and a
  // numeric prop would otherwise do nothing at all for every N the build never saw.
  assert.equal(clamped.props.style.WebkitLineClamp, 3)
  assert.equal(clamped.props.style.display, "-webkit-box")
  assert.equal(clamped.props.style.WebkitBoxOrient, "vertical")
})

test("before the first measurement no size is written at all", () => {
  // The server has no size to apply either, and a guess here is a flash of the wrong one. Nothing
  // applied means the element renders at the size the stylesheet asked for.
  const tree = render(FitText, { children: "Hello" }).tree
  assert.equal(tree.props.style.fontSize, undefined)
  assert.match(tree.props.className, /\bblock\b/)
})

test("the fitted size wins over a size the caller wrote inline, and nothing else does", () => {
  const ui = render(FitText, {
    children: "Hello",
    style: { fontSize: 48, color: "red", letterSpacing: "0.01em" },
  })
  assert.equal(ui.tree.props.style.fontSize, 48, "nothing is overridden before a measurement")

  layout(ui.nodes[0], { box: 240, cssSize: 48 })
  globalThis.getComputedStyle = (el) => ({ direction: "ltr", fontSize: `${el.cssSize ?? 16}px` })
  ui.rerender()

  // A caller writing `style={{ fontSize: 48 }}` is naming the size to shrink *from* — it is part of
  // the computed style the ceiling is read from — so letting it win here would overwrite the fitted
  // size and switch the fitting off without a word.
  assert.equal(ui.tree.props.style.fontSize, `${byScan(240, 12, 48)}px`)
  assert.equal(ui.tree.props.style.color, "red")
  assert.equal(ui.tree.props.style.letterSpacing, "0.01em")
})

test("the caller's class names and props are kept", () => {
  const tree = render(FitText, {
    children: "Hello",
    className: "text-4xl font-semibold",
    id: "kpi",
    "aria-label": "Revenue",
    title: "1,284,993",
  }).tree

  assert.match(tree.props.className, /text-4xl font-semibold/)
  assert.match(tree.props.className, /\bblock\b/)
  assert.equal(tree.props.id, "kpi")
  assert.equal(tree.props["aria-label"], "Revenue")
  assert.equal(tree.props.title, "1,284,993")
  // The text itself is never touched — same node, different size — which is what leaves
  // find-in-page, selection and the accessibility tree the whole string.
  assert.equal(tree.props.children, "Hello")
})

test("onFit is told each distinct result once, not every pass", () => {
  // A parent that re-renders on this callback would otherwise turn a measurement into a loop.
  const reported = []
  const ui = render(FitText, { children: "Hello", onFit: (result) => reported.push(result) })
  assert.deepEqual(reported, [{ size: null, overflowing: false }])

  layout(ui.nodes[0], { box: 240, cssSize: 48 })
  globalThis.getComputedStyle = (el) => ({ direction: "ltr", fontSize: `${el.cssSize ?? 16}px` })
  ui.rerender()
  const settled = reported.length
  assert.equal(settled, 2)
  assert.deepEqual(reported.at(-1), { size: byScan(240, 12, 48), overflowing: false })

  ui.rerender()
  ui.rerender()
  assert.equal(reported.length, settled, "reported a result that had not changed")
})
