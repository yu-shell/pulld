// The scrolling tab strip everybody writes first calls `scrollIntoView` on the selected tab, which
// scrolls every scrollable ancestor including the document — so selecting a tab partway down a long
// page jumps the page. The cases below are written to fail against that version and against the
// near-misses around it:
//
//   - `scrollIntoView` instead of scrolling the strip by its own coordinates, which is the whole
//     behaviour and is asserted as both halves: that `scrollTo` is called with a computed offset,
//     and that `scrollIntoView` is never called at all,
//   - `scrollLeft` read and written as if it counted up from the left in an RTL strip, where it is
//     0 at the right-hand end and runs negative going left, so every offset lands on the wrong
//     side of the strip,
//   - the border box used as the scrolling window instead of the scrollport, which parks the
//     selected tab a border's width under an arrow button,
//   - a re-centre on every measurement rather than only when the selected tab changes, which drags
//     a user who scrolled by hand back to where the component wanted them,
//   - "nearest" implemented as "always move", so a tab already comfortably in view is re-parked and
//     the tabs shift out from under the pointer,
//   - no gutter, so the selected tab is flush against the edge and half-covered by the chevron
//     painted over it,
//   - a target that is not clamped, so the strip is asked to scroll past its own end,
//   - arrows laid out beside the strip rather than painted over it, which makes the window narrower
//     exactly when they appear and leaves a strip that fits one width but not the other with no
//     stable answer,
//   - and arrows exposed as real controls, which offers a screen reader a "scroll right" it has no
//     way to aim.
//
// The harness has no layout, so measurements are supplied: a stand-in viewport is given the rects
// and scroll numbers a browser would report, and the arithmetic that consumes them is also asserted
// directly as a pure function. What it can see of scrolling is the call, not the motion — "the strip
// asked to be scrolled to 208" is assertable here, and whether the browser animated there belongs
// to a browser.
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

// The real scroll-shadow, loaded rather than stubbed. The edge detection — including the RTL sign
// rule and the fact that it answers before anybody has scrolled — is imported from it, and a stub
// would turn the one assertion that the composition works into an assertion about the copy, leaving
// the registryDependencies entry as decoration.
const scrollShadow = loadComponent(join(ROOT, "registry", "ui", "scroll-shadow.tsx"))

const {
  nextTabScroll,
  scrollLeftForOffset,
  readTabVisibility,
  TAB_SCROLL_EPSILON,
  DEFAULT_ACTIVE_TAB_SELECTOR,
  TabScroller,
} = loadComponent(join(ROOT, "registry", "ui", "tab-scroller.tsx"), {
  stubs: {
    "lucide-react": { ChevronLeft: icon("chevron-left"), ChevronRight: icon("chevron-right") },
    "@/registry/ui/scroll-shadow": scrollShadow,
  },
})

// --- the arithmetic -------------------------------------------------------
// A strip 300 wide scrolled to 100, with a 32px gutter, unless a case says otherwise.
const visibility = (over = {}) => ({
  leadingGap: 100,
  trailingGap: 100,
  scrolled: 100,
  maxScroll: 700,
  ...over,
})

test("a tab already in view with room on both sides is left exactly where it is", () => {
  const v = visibility()
  assert.equal(nextTabScroll(v), v.scrolled)
})

test("a tab off the leading end is brought to the leading gutter", () => {
  // 60px before the window's start. Scrolling back by 60 puts its edge on the window's; another 32
  // puts it on the gutter.
  const v = visibility({ leadingGap: -60, trailingGap: 400 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 100 - 60 - 32)
})

test("a tab off the trailing end is brought to the trailing gutter", () => {
  const v = visibility({ leadingGap: 400, trailingGap: -45 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 100 + 32 + 45)
})

test("a tab inside the window but hugging the leading edge is nudged off it", () => {
  // Visible — a positive gap — but under the arrow button painted over that end.
  const v = visibility({ leadingGap: 6, trailingGap: 400 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 100 - 26)
})

test("a gutter of zero leaves a tab flush against the edge alone", () => {
  const v = visibility({ leadingGap: 0, trailingGap: 400 })
  assert.equal(nextTabScroll(v, { gutter: 0 }), v.scrolled)
})

test("the target is clamped to the start of the strip", () => {
  // Wants to go 60 before the window and 32 further for the gutter, from a strip scrolled only 10.
  const v = visibility({ leadingGap: -60, trailingGap: 400, scrolled: 10 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 0)
})

test("the target is clamped to the end of the strip", () => {
  const v = visibility({ leadingGap: 400, trailingGap: -200, scrolled: 600, maxScroll: 700 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 700)
})

test("a strip with nowhere to go is not asked to move toward the end", () => {
  // maxScroll of exactly 0 — the content fits to the pixel — with a tab reported past the trailing
  // edge. The upper clamp is the only thing stopping a scroll to somewhere that does not exist.
  const v = visibility({ leadingGap: 400, trailingGap: -50, scrolled: 0, maxScroll: 0 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 0)
})

test("a strip that does not overflow is never scrolled anywhere but zero", () => {
  // maxScroll goes negative when the content is narrower than the window, and a limit below zero
  // would clamp the target above it.
  const v = visibility({ leadingGap: -10, trailingGap: 10, scrolled: 0, maxScroll: -40 })
  assert.equal(nextTabScroll(v), 0)
})

test("a tab wider than the window is aligned by its leading edge", () => {
  // Both gaps negative: the two gutters cannot both be honoured, and the start of the label wins.
  const v = visibility({ leadingGap: -20, trailingGap: -300 })
  assert.equal(nextTabScroll(v, { gutter: 32 }), 100 - 20 - 32)
})

test("centring equalises the two gaps", () => {
  const v = visibility({ leadingGap: 200, trailingGap: 40 })
  const target = nextTabScroll(v, { align: "center" })
  assert.equal(target, 180)
  // Having moved forward by 80, the gaps are 120 and 120.
  assert.equal(v.leadingGap - (target - v.scrolled), v.trailingGap + (target - v.scrolled))
})

test("centring a tab already centred asks for no movement", () => {
  assert.equal(nextTabScroll(visibility(), { align: "center" }), 100)
})

test("centring is clamped at the ends like nearest is", () => {
  const first = visibility({ leadingGap: 20, trailingGap: 600, scrolled: 0 })
  assert.equal(nextTabScroll(first, { align: "center" }), 0)
  const last = visibility({ leadingGap: 600, trailingGap: 20, scrolled: 700, maxScroll: 700 })
  assert.equal(nextTabScroll(last, { align: "center" }), 700)
})

test("a logical offset becomes scrollLeft, negated only in RTL", () => {
  assert.equal(scrollLeftForOffset(240, false), 240)
  assert.equal(scrollLeftForOffset(240, true), -240)
  // Zero is the initial position in both directions and must not acquire a sign.
  assert.equal(scrollLeftForOffset(0, true), 0)
})

// --- reading the DOM ------------------------------------------------------
// A strip whose border box starts at x=50 with a 1px border, a 300px scrollport, scrolled 100.
const viewportStub = (over = {}) => ({
  getBoundingClientRect: () => ({ left: 50, right: 352 }),
  clientLeft: 1,
  clientWidth: 300,
  scrollWidth: 1000,
  scrollLeft: 100,
  ...over,
})

const tabStub = (left, right) => ({ getBoundingClientRect: () => ({ left, right }) })

test("the scrolling window is the scrollport, not the border box", () => {
  // The window runs 51..351. A tab at 151..211 therefore has 100 before it and 140 after.
  const v = readTabVisibility(viewportStub(), tabStub(151, 211), false)
  assert.equal(v.leadingGap, 100)
  assert.equal(v.trailingGap, 140)
  assert.equal(v.scrolled, 100)
  assert.equal(v.maxScroll, 700)
})

test("in RTL the gaps swap ends and the scroll offset loses its sign", () => {
  // Same geometry, read right-to-left: the window's inline start is its right edge, 351. A tab at
  // 151..211 has 351-211=140 before it and 151-51=100 after.
  const v = readTabVisibility(viewportStub({ scrollLeft: -100 }), tabStub(151, 211), true)
  assert.equal(v.leadingGap, 140)
  assert.equal(v.trailingGap, 100)
  // scrollLeft is negative going left from the right-hand end; the distance travelled is positive.
  assert.equal(v.scrolled, 100)
})

test("a tab starting before the window reports a negative leading gap", () => {
  const v = readTabVisibility(viewportStub(), tabStub(20, 90), false)
  assert.equal(v.leadingGap, -31)
})

// --- the component --------------------------------------------------------
// Gives the stand-in viewport a layout and a selected tab, then re-runs the effects against it.
// The component reads the DOM rather than taking the current tab as a prop, so a test of the scroll
// path has to supply both.
const withLayout = (node, { tab, reducedMotion = false, ...layout }) => {
  Object.assign(node, viewportStub(layout))
  node.querySelector = (selector) => (selector === DEFAULT_ACTIVE_TAB_SELECTOR ? tab : null)
  // scroll-shadow waits on this document's fonts, so it has to stay present and null.
  node.ownerDocument = {
    fonts: null,
    defaultView: { matchMedia: () => ({ matches: reducedMotion }) },
  }
}

test("the strip scrolls itself by its own coordinates and never calls scrollIntoView", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  // A tab 60px before the window's start, in a strip scrolled to 100.
  withLayout(viewport, { tab: tabStub(-9, 51) })
  view.rerender()

  const scrolls = viewport.calls.filter((c) => c.name === "scrollTo")
  assert.equal(scrolls.length, 1)
  // 100 - 60 - 32: back to the window's edge, then off the gutter.
  assert.deepEqual(scrolls[0].args[0], { left: 8, behavior: "auto" })
  assert.equal(
    viewport.calls.filter((c) => c.name === "scrollIntoView").length,
    0,
    "scrollIntoView scrolls every ancestor including the document"
  )
  view.unmount()
})

test("the first positioning is instant and later ones animate", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes

  withLayout(viewport, { tab: tabStub(-9, 51) })
  view.rerender()
  // A different tab, off the other end this time, so the selection has genuinely changed.
  withLayout(viewport, { tab: tabStub(400, 460) })
  view.rerender()

  const scrolls = viewport.calls.filter((c) => c.name === "scrollTo")
  assert.equal(scrolls.length, 2)
  assert.equal(scrolls[0].args[0].behavior, "auto", "a strip arriving already scrolled must not animate")
  assert.equal(scrolls[1].args[0].behavior, "smooth")
  view.unmount()
})

test("the strip is not re-scrolled while the selected tab stays the same", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  const tab = tabStub(-9, 51)

  withLayout(viewport, { tab })
  view.rerender()
  // Same tab object, and the strip has since been scrolled by hand to somewhere else entirely.
  withLayout(viewport, { tab, scrollLeft: 640 })
  view.rerender()

  assert.equal(
    viewport.calls.filter((c) => c.name === "scrollTo").length,
    1,
    "re-asserting the position on every measurement drags the user back"
  )
  view.unmount()
})

test("a target the strip is already at is not asked for", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  // Comfortably inside the window: 100 before it and 140 after, both past the gutter.
  withLayout(viewport, { tab: tabStub(151, 211) })
  view.rerender()
  assert.equal(viewport.calls.filter((c) => c.name === "scrollTo").length, 0)
  view.unmount()
})

test("a sub-pixel difference is not worth a scroll", () => {
  // An animated scroll is itself a stream of scroll events; asking again mid-flight never settles.
  assert.ok(TAB_SCROLL_EPSILON > 0)
  const v = visibility({ leadingGap: 32 - TAB_SCROLL_EPSILON / 2, trailingGap: 400 })
  assert.ok(Math.abs(nextTabScroll(v, { gutter: 32 }) - v.scrolled) <= TAB_SCROLL_EPSILON)
})

test("a difference of exactly one epsilon is still not worth a scroll", () => {
  // The boundary itself, which is where a `<` and a `<=` part company. A tab this far off the
  // gutter is a rounding artifact of fractional layout, not a tab out of place.
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  // Window starts at 51, so a tab at 51 + 32 - 0.5 is exactly one epsilon inside the gutter.
  withLayout(viewport, { tab: tabStub(51 + 32 - TAB_SCROLL_EPSILON, 300) })
  view.rerender()
  assert.equal(viewport.calls.filter((c) => c.name === "scrollTo").length, 0)
  view.unmount()
})

test("an RTL strip is scrolled to a negative scrollLeft", () => {
  const view = render(TabScroller, { children: null }, { direction: "rtl" })
  const [viewport] = view.nodes
  // Read right-to-left the window runs 351 back to 51, so a tab at 351..411 sits 60px past its
  // inline start — far enough to move, near enough that the target is not clamped to zero.
  withLayout(viewport, { tab: tabStub(351, 411), scrollLeft: -100 })
  view.rerender()

  const [scroll] = viewport.calls.filter((c) => c.name === "scrollTo")
  assert.ok(scroll, "an RTL strip must still be scrolled")
  assert.equal(scroll.args[0].left, -8, "scrollLeft runs negative from the right-hand end")
  view.unmount()
})

test("no arrow is painted while the strip does not overflow", () => {
  // Nothing has been measured, which is also the server's answer, and an arrow pointing at content
  // that may not exist is worse than none.
  const view = render(TabScroller, { children: null })
  assert.equal(byTag(walk(view.tree), "button").length, 0)
  view.unmount()
})

test("the arrows appear from the real scroll-shadow edge detection, physically placed", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  // Overflowing with content hidden at both ends: scrolled 100 of a possible 700.
  withLayout(viewport, { tab: tabStub(151, 211) })
  view.rerender()

  const buttons = byTag(walk(view.tree), "button")
  assert.equal(buttons.length, 2)
  const classes = buttons.map((b) => b.props.className)
  assert.ok(
    classes.some((c) => c.includes("left-0")) && classes.some((c) => c.includes("right-0")),
    "the insets are physical because the edges that show the buttons are"
  )
  assert.ok(
    classes.every((c) => c.includes("absolute")),
    "arrows in the layout make the window narrower exactly when they appear"
  )
  view.unmount()
})

test("the arrows are not controls a keyboard or screen reader is offered", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  withLayout(viewport, { tab: tabStub(151, 211) })
  view.rerender()

  for (const button of byTag(walk(view.tree), "button")) {
    assert.equal(button.props["aria-hidden"], "true")
    assert.equal(button.props.tabIndex, -1)
    assert.equal(button.props.type, "button")
  }
  view.unmount()
})

test("an arrow travels a screenful less a sliver, in physical pixels", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  withLayout(viewport, { tab: tabStub(151, 211) })
  view.rerender()

  const buttons = byTag(walk(view.tree), "button")
  const arrow = (side) => buttons.find((b) => b.props.className.includes(`${side}-0`))

  arrow("left").props.onClick()
  arrow("right").props.onClick()
  const by = viewport.calls.filter((c) => c.name === "scrollBy").map((c) => c.args[0])
  // 80% of the 300px window, each way. Both ends are asserted because the direction is the whole
  // content of these two handlers, and checking one of a symmetric pair is how a sign error
  // survives: the left button travelling right is a bug the left button's own test cannot see.
  assert.deepEqual(by, [
    { left: -240, behavior: "smooth" },
    { left: 240, behavior: "smooth" },
  ])
  view.unmount()
})

test("an explicit step of zero is honoured rather than replaced by the default", () => {
  // `scrollStep ?? default` and `scrollStep || default` differ on exactly this value, and zero is
  // the one a caller passes to pin the arrows in place.
  const view = render(TabScroller, { children: null, scrollStep: 0 })
  const [viewport] = view.nodes
  withLayout(viewport, { tab: tabStub(151, 211) })
  view.rerender()

  byTag(walk(view.tree), "button")
    .find((b) => b.props.className.includes("right-0"))
    .props.onClick()
  const [by] = viewport.calls.filter((c) => c.name === "scrollBy")
  assert.equal(by.args[0].left, 0)
  view.unmount()
})

test("prefers-reduced-motion turns off the animation on both paths", () => {
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  // Already positioned once, so a second move would ordinarily animate.
  withLayout(viewport, { tab: tabStub(151, 211), reducedMotion: true })
  view.rerender()
  withLayout(viewport, { tab: tabStub(-9, 51), reducedMotion: true })
  view.rerender()

  const scrolls = viewport.calls.filter((c) => c.name === "scrollTo")
  assert.equal(scrolls.at(-1).args[0].behavior, "auto")

  byTag(walk(view.tree), "button")
    .find((b) => b.props.className.includes("right-0"))
    .props.onClick()
  const [by] = viewport.calls.filter((c) => c.name === "scrollBy")
  assert.equal(by.args[0].behavior, "auto", "an arrow must not animate either")
  view.unmount()
})

test("an environment with no matchMedia is treated as motion allowed", () => {
  // The fallback behind `?? false`. A browser too old for matchMedia, or a document with no window
  // behind it, must not be read as "the user asked for reduced motion" — that would silently drop
  // the animation for everybody rather than for the people who asked.
  const view = render(TabScroller, { children: null })
  const [viewport] = view.nodes
  const strip = (tab) => {
    Object.assign(viewport, viewportStub())
    viewport.querySelector = () => tab
    viewport.ownerDocument = { fonts: null }
    view.rerender()
  }
  strip(tabStub(-9, 51))
  strip(tabStub(400, 460))

  const scrolls = viewport.calls.filter((c) => c.name === "scrollTo")
  assert.equal(scrolls.at(-1).args[0].behavior, "smooth")
  view.unmount()
})

test("the strip imposes no tab role of its own", () => {
  // The tablist and its arrow keys belong to whatever built the tabs; a second tablist here would
  // both lie about the structure and collide with the keys that move the selection.
  const view = render(TabScroller, { children: null })
  const roles = walk(view.tree)
    .map((n) => n.props?.role)
    .filter(Boolean)
  assert.deepEqual(roles, [])
  view.unmount()
})

test("the selector finds the selected tab under both conventions", () => {
  // Radix — and so official shadcn/ui's TabsTrigger — marks the active tab with data-state, while a
  // hand-rolled strip and the ARIA practices use aria-selected.
  assert.match(DEFAULT_ACTIVE_TAB_SELECTOR, /aria-selected="true"/)
  assert.match(DEFAULT_ACTIVE_TAB_SELECTOR, /data-state="active"/)
})
