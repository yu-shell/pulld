// The edge fade everyone writes first reads `scrollLeft` and listens for `scroll`, and it is wrong
// in three ways that a screenshot of your own laptop will never show. The cases below are written to
// fail against the versions that look right:
//
//   - `scrollLeft === 0` meaning "nothing behind us", which is true in LTR and false in RTL, where
//     the CSSOM puts 0 at the right-hand end — so a fresh Arabic table is faded on the wrong side,
//   - `hidden > 0` meaning "still more to come", which fractional layout never quite reaches, so the
//     end fade stays painted over the last column forever,
//   - one mask layer per axis with the default `mask-composite`, which unions rather than
//     intersects and so fades nothing but the four corners of a box that scrolls both ways,
//   - and a mask left on a box that fits, which costs a stacking context to fade nothing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { readScrollEdges, scrollShadowMask, NO_SCROLL_EDGES, ScrollShadow } = loadComponent(
  join(ROOT, "registry", "ui", "scroll-shadow.tsx")
)

// A box 600 wide holding 1000 of content, with nothing to scroll vertically.
const wide = (scrollLeft, { rtl = false } = {}) => ({
  scrollLeft,
  scrollTop: 0,
  scrollWidth: 1000,
  clientWidth: 600,
  scrollHeight: 300,
  clientHeight: 300,
  rtl,
})

// A box 300 tall holding 900 of content, with nothing to scroll horizontally.
const tall = (scrollTop) => ({
  scrollLeft: 0,
  scrollTop,
  scrollWidth: 600,
  clientWidth: 600,
  scrollHeight: 900,
  clientHeight: 300,
  rtl: false,
})

// --- what overflows, and which way ---------------------------------------------------------------

test("a box that fits reports no edges and nothing scrollable", () => {
  const edges = readScrollEdges({
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth: 600,
    clientWidth: 600,
    scrollHeight: 300,
    clientHeight: 300,
    rtl: false,
  })
  assert.deepEqual(edges, NO_SCROLL_EDGES)
})

test("left to right: the fade is on the right at the start, on both sides in the middle", () => {
  assert.deepEqual(readScrollEdges(wide(0)), {
    top: false,
    right: true,
    bottom: false,
    left: false,
    scrollableX: true,
    scrollableY: false,
  })

  const middle = readScrollEdges(wide(200))
  assert.equal(middle.left, true)
  assert.equal(middle.right, true)
})

test("left to right: the right fade is gone at the end, fractional layout and all", () => {
  assert.equal(readScrollEdges(wide(400)).right, false)
  // scrollWidth and clientWidth are rounded integers while scrollLeft is not, so "fully scrolled"
  // routinely lands a fraction of a pixel short. A `> 0` test keeps the fade up permanently here.
  assert.equal(readScrollEdges(wide(399.6)).right, false)
  assert.equal(readScrollEdges(wide(399.6)).left, true)
})

test("right to left: scrollLeft 0 is the right-hand end, so the fade goes on the left", () => {
  // The initial position of an RTL scroller. Read as an LTR offset this says "at the start, nothing
  // hidden on the left" — the exact opposite of the truth, on first paint, before any interaction.
  const initial = readScrollEdges(wide(0, { rtl: true }))
  assert.equal(initial.left, true)
  assert.equal(initial.right, false)

  // Scrolled all the way to the left-hand end: scrollLeft runs down to -(scrollWidth - clientWidth).
  const end = readScrollEdges(wide(-400, { rtl: true }))
  assert.equal(end.left, false)
  assert.equal(end.right, true)

  const middle = readScrollEdges(wide(-200, { rtl: true }))
  assert.equal(middle.left, true)
  assert.equal(middle.right, true)
})

test("overscroll past an end does not put the fade back", () => {
  // The rubber band at the end of a trackpad flick reports a position beyond the range for a few
  // frames; a subtraction alone would make that read as content hidden on the far side.
  assert.equal(readScrollEdges(wide(-30)).left, false)
  assert.equal(readScrollEdges(wide(430)).right, false)
})

test("vertical works the same way, and each axis is judged on its own", () => {
  assert.deepEqual(readScrollEdges(tall(0)), {
    top: false,
    right: false,
    bottom: true,
    left: false,
    scrollableX: false,
    scrollableY: true,
  })
  assert.equal(readScrollEdges(tall(300)).top, true)
  assert.equal(readScrollEdges(tall(600)).bottom, false)
})

test("an overflow smaller than the threshold is not an overflow", () => {
  const hair = { ...wide(0), scrollWidth: 600.5 }
  assert.equal(readScrollEdges(hair).scrollableX, false)
  assert.equal(readScrollEdges(hair).right, false)
  // And the threshold is a knob, for a caller who wants a coarser one.
  assert.equal(readScrollEdges({ ...wide(0), scrollWidth: 610 }, 20).scrollableX, false)
})

// --- the mask ------------------------------------------------------------------------------------

const edgesOf = (partial) => ({ ...NO_SCROLL_EDGES, ...partial })

test("a box with nothing hidden gets no mask at all", () => {
  // Not an all-opaque mask: masking makes the element a stacking context and costs a layer, and a
  // box that fits should pay for neither.
  assert.deepEqual(scrollShadowMask(NO_SCROLL_EDGES), {})
})

test("only the sides with more content behind them are soft", () => {
  const right = scrollShadowMask(edgesOf({ scrollableX: true, right: true }))
  assert.equal(
    right.maskImage,
    "linear-gradient(to right, #000 0, #000 calc(100% - 32px), transparent 100%)"
  )
  assert.equal(right.maskComposite, undefined)

  const left = scrollShadowMask(edgesOf({ scrollableX: true, left: true }))
  assert.equal(left.maskImage, "linear-gradient(to right, transparent 0, #000 32px, #000 100%)")

  const both = scrollShadowMask(edgesOf({ scrollableX: true, left: true, right: true }), {
    size: 48,
  })
  assert.equal(
    both.maskImage,
    "linear-gradient(to right, transparent 0, #000 48px, #000 calc(100% - 48px), transparent 100%)"
  )
})

test("both axes intersect rather than add", () => {
  const mask = scrollShadowMask(
    edgesOf({ scrollableX: true, scrollableY: true, right: true, bottom: true })
  )
  const layers = mask.maskImage.split(", linear-gradient")
  assert.equal(layers.length, 2)
  assert.match(mask.maskImage, /linear-gradient\(to right,/)
  assert.match(mask.maskImage, /linear-gradient\(to bottom,/)
  // The default is `add`: two layers each opaque down their own middle would union into an almost
  // entirely opaque mask, fading the corners and nothing else.
  assert.equal(mask.maskComposite, "intersect")
})

test("orientation ignores the axis it was not asked about", () => {
  const scrollsBothWays = edgesOf({
    scrollableX: true,
    scrollableY: true,
    right: true,
    bottom: true,
  })

  const horizontal = scrollShadowMask(scrollsBothWays, { orientation: "horizontal" })
  assert.match(horizontal.maskImage, /^linear-gradient\(to right,/)
  assert.equal(horizontal.maskComposite, undefined)

  const vertical = scrollShadowMask(scrollsBothWays, { orientation: "vertical" })
  assert.match(vertical.maskImage, /^linear-gradient\(to bottom,/)

  // And an axis that scrolls the other way contributes nothing rather than an empty layer.
  assert.deepEqual(
    scrollShadowMask(edgesOf({ scrollableY: true, bottom: true }), { orientation: "horizontal" }),
    {}
  )
})

// --- what the server sends -----------------------------------------------------------------------

const partsOf = (view) => {
  const divs = byTag(walk(view.tree), "div")
  return { wrapper: divs[0].props, viewport: divs[1].props }
}

test("before anything has been measured it is an inert box", () => {
  // The harness has no layout, so this is the server's answer and the first client render: nothing
  // is known about overflow yet. A fade or a tab stop here would have to be taken back on hydration
  // for every box that turned out to fit.
  const view = render(ScrollShadow, { "aria-label": "Releases", children: "rows" })
  const { wrapper, viewport } = partsOf(view)

  assert.deepEqual(viewport.style, {})
  assert.equal(viewport.tabIndex, undefined)
  assert.equal(viewport.role, undefined)
  assert.equal(wrapper["data-scrollable"], undefined)
  assert.equal(wrapper["data-more-right"], undefined)
  view.unmount()
})

test("the label and the scroll classes go on the box that scrolls, not the wrapper", () => {
  const view = render(ScrollShadow, {
    orientation: "horizontal",
    className: "rounded-lg border",
    viewportClassName: "max-h-72",
    "aria-label": "Releases",
    children: "rows",
  })
  const { wrapper, viewport } = partsOf(view)

  assert.equal(viewport["aria-label"], "Releases")
  assert.equal(wrapper["aria-label"], undefined)
  assert.match(wrapper.className, /rounded-lg border/)
  assert.match(viewport.className, /max-h-72/)
  // The unused axis is hidden, not left visible: CSS would promote it back to auto and hand the
  // box a vertical scrollbar the first time a cell wrapped.
  assert.match(viewport.className, /overflow-x-auto overflow-y-hidden/)
  // Inherited, so a radius on the wrapper clips the content instead of square corners showing
  // through a rounded card.
  assert.match(viewport.className, /rounded-\[inherit\]/)
  view.unmount()
})

test("orientation picks the overflow pair", () => {
  for (const [orientation, expected] of [
    ["vertical", "overflow-y-auto overflow-x-hidden"],
    ["both", "overflow-auto"],
  ]) {
    const view = render(ScrollShadow, { orientation, children: "rows" })
    assert.match(partsOf(view).viewport.className, new RegExp(expected.replace(/-/g, "\\-")))
    view.unmount()
  }
})
