// A sticky table header is four lines of CSS and every one of them has a way of being quietly wrong.
// The cases below are written to fail against the version that looks right on the author's screen:
//
//   - `border-b` on the pinned `<th>`, which vanishes the moment it sticks, because Tailwind's
//     preflight puts every table in the collapsed model and a collapsed border belongs to the grid
//     rather than to the cell that sticks,
//   - the repair for that — flipping the table to `border-separate` — which erases every divider in
//     the body instead, since the separated model ignores borders on a `<tr>` and shadcn's
//     `TableRow` puts its `border-b` exactly there,
//   - a wrapper that scrolls in page mode, which becomes the scrollport the header pins to and so
//     stops it moving at all,
//   - pinned columns all resting at `left: 0`, stacked on top of each other,
//   - and a corner cell left to document order, which puts the body column over the header.
//
// Layout is not observable here (see _react-harness.mjs), so these assert the decisions the tree
// encodes — which rules are emitted, which variables they read, which of them is absent — and leave
// "the header is at y=0 after scrolling" to a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  cssLength,
  resolveStickyMode,
  cumulativeOffsets,
  resolveStickyColumns,
  needsMeasurement,
  stickyTableVars,
  STICKY_Z,
  MAX_STICKY_COLUMNS,
  StickyTableHeader,
} = loadComponent(join(ROOT, "registry", "ui", "sticky-table-header.tsx"))

const table = { type: "table", props: { children: null } }
const renderWrapper = (props = {}) => render(StickyTableHeader, { children: table, ...props }).tree
const classesOf = (props) => renderWrapper(props).props.className
const styleOf = (props) => renderWrapper(props).props.style

// --- lengths -------------------------------------------------------------------------------------

test("a number is pixels and a string is passed through untouched", () => {
  assert.equal(cssLength(64), "64px")
  assert.equal(cssLength("60vh"), "60vh")
  assert.equal(cssLength("calc(100dvh - 12rem)"), "calc(100dvh - 12rem)")
})

// `0` is the default offset and the single most common one. Written with a falsy check it becomes
// the fallback, which is the same string here — and stops being the same the moment a caller passes
// a fallback of their own.
test("zero is a length, not a missing value", () => {
  assert.equal(cssLength(0), "0px")
  assert.equal(cssLength(0, "9px"), "0px")
})

test("undefined, null and empty string take the fallback", () => {
  assert.equal(cssLength(undefined, "7px"), "7px")
  assert.equal(cssLength(null, "7px"), "7px")
  assert.equal(cssLength("", "7px"), "7px")
})

// --- which element scrolls -----------------------------------------------------------------------

test("a height means this wrapper scrolls; no height means the page does", () => {
  assert.equal(resolveStickyMode(undefined), "page")
  assert.equal(resolveStickyMode(null), "page")
  assert.equal(resolveStickyMode(""), "page")
  assert.equal(resolveStickyMode(420), "container")
  assert.equal(resolveStickyMode("60vh"), "container")
})

// A height of 0 is a legitimate (if useless) container, and more to the point it is not the absence
// of a height. Written as `maxHeight ? …` it reads as page mode and the caller gets no scrollport.
test("a zero height is still a container", () => {
  assert.equal(resolveStickyMode(0), "container")
})

test("container mode scrolls and carries the height", () => {
  assert.match(classesOf({ maxHeight: 420 }), /overflow-auto/)
  assert.equal(styleOf({ maxHeight: 420 }).maxHeight, "420px")
  assert.equal(styleOf({ maxHeight: "60vh" }).maxHeight, "60vh")
})

// The bug this component exists to avoid. An `overflow` on the wrapper makes *it* the scrollport, so
// a header asked to pin to the page pins to a box that never scrolls and never moves again. It also
// has to be absent rather than merely unset: `overflow-x-auto` computes `overflow-y: auto` too, so
// there is no "only sideways" version of this that leaves page scrolling intact.
test("page mode creates no scrollport of its own", () => {
  const className = classesOf({})
  assert.doesNotMatch(className, /overflow-/)
  assert.equal(styleOf({}).maxHeight, undefined)
})

// --- the header rules ----------------------------------------------------------------------------

test("header cells are pinned, lifted and opaque", () => {
  const className = classesOf({})
  assert.match(className, /\[&_thead_th\]:sticky/)
  assert.match(className, /\[&_thead_th\]:top-\[var\(--sticky-table-top\)\]/)
  assert.match(className, /\[&_thead_th\]:z-20/)
  // Without a background the rows pass *through* the header rather than under it.
  assert.match(className, /\[&_thead_th\]:bg-background/)
})

// The line under the header is drawn by a pseudo-element because a collapsed border does not travel
// with the cell that sticks. `border-b` here is the version that looks correct until you scroll.
test("the header's bottom edge is a pseudo-element, never a border", () => {
  const className = classesOf({})
  assert.match(className, /\[&_thead_th\]:after:h-px/)
  assert.match(className, /\[&_thead_th\]:after:bg-border/)
  assert.match(className, /\[&_thead_th\]:after:content-\[''\]/)
  assert.doesNotMatch(className, /\[&_thead_th\]:border-b/)
})

// The pseudo-element is positioned against the cell, which is only a containing block because the
// cell is sticky. Absent these it is laid out in flow and appears as a stray line inside the text.
test("the pseudo-element is pinned to the bottom edge of the cell", () => {
  const className = classesOf({})
  assert.match(className, /\[&_thead_th\]:after:absolute/)
  assert.match(className, /\[&_thead_th\]:after:inset-x-0/)
  assert.match(className, /\[&_thead_th\]:after:bottom-0/)
})

// The repair the search results suggest, and the one that must never appear: in the separated model
// borders on a `<tr>` are ignored, and shadcn's `TableRow` is where the body's dividers live. This
// would trade one missing line in the header for every missing line in the table.
test("the table is never flipped out of the collapsed border model", () => {
  const className = classesOf({ maxHeight: 420, stickyColumns: 2 })
  assert.doesNotMatch(className, /border-separate/)
  assert.doesNotMatch(className, /border-collapse/)
  assert.doesNotMatch(className, /border-spacing/)
})

test("the header can be turned off while columns stay pinned", () => {
  const className = classesOf({ stickyHeader: false, stickyColumns: 1 })
  assert.doesNotMatch(className, /\[&_thead_th\]:sticky/)
  assert.match(className, /\[&_tr>\*:nth-child\(1\)\]:sticky/)
  // No header to be in front of, so no corner to lift.
  assert.doesNotMatch(className, /\[&_thead_tr>\*:nth-child\(1\)\]:z-30/)
})

// --- the offset ----------------------------------------------------------------------------------

test("the resting place is published as a variable the rules read", () => {
  assert.equal(styleOf({}) ["--sticky-table-top"], "0px")
  assert.equal(styleOf({ offset: 64 })["--sticky-table-top"], "64px")
  assert.equal(styleOf({ offset: "4rem" })["--sticky-table-top"], "4rem")
})

test("vars carry one seed per pinned column and none otherwise", () => {
  assert.deepEqual(stickyTableVars(0, 0), { "--sticky-table-top": "0px" })
  assert.deepEqual(stickyTableVars(8, 2), {
    "--sticky-table-top": "8px",
    "--sticky-table-left-0": "0px",
    "--sticky-table-left-1": "0px",
  })
})

// Seeded rather than left unset: an unresolved `var()` in `left` falls back to `auto`, which is not
// pinned at all, so the first paint of every pinned column would be unpinned.
test("column offsets are seeded so the first paint is already pinned", () => {
  assert.equal(styleOf({ stickyColumns: 1 })["--sticky-table-left-0"], "0px")
})

// --- pinned columns ------------------------------------------------------------------------------

test("each pinned column reads its own offset variable", () => {
  const className = classesOf({ stickyColumns: 3 })
  for (const i of [1, 2, 3]) {
    assert.match(className, new RegExp(`\\[&_tr>\\*:nth-child\\(${i}\\)\\]:sticky`))
    assert.match(
      className,
      new RegExp(`\\[&_tr>\\*:nth-child\\(${i}\\)\\]:left-\\[var\\(--sticky-table-left-${i - 1}\\)\\]`)
    )
  }
})

// Same failure as a transparent header, on the other axis: a pinned column with no background of
// its own does not stay in front of the cells to its right, it stays in place while they pass
// through it, so the first column and whatever column is under it are painted over each other.
test("pinned columns are opaque too", () => {
  const className = classesOf({ stickyColumns: 2 })
  assert.match(className, /\[&_tr>\*:nth-child\(1\)\]:bg-background/)
  assert.match(className, /\[&_tr>\*:nth-child\(2\)\]:bg-background/)
})

test("no columns are pinned unless asked for", () => {
  assert.doesNotMatch(classesOf({}), /nth-child/)
})

test("only the requested leading columns are pinned", () => {
  const className = classesOf({ stickyColumns: 1 })
  assert.match(className, /\[&_tr>\*:nth-child\(1\)\]:sticky/)
  assert.doesNotMatch(className, /\[&_tr>\*:nth-child\(2\)\]/)
})

// Every class name has to exist as literal text for Tailwind to compile it, so there are only three.
// A request for more has to be clamped rather than generated, or it resolves to a class that was
// never built and the column is silently not pinned.
test("a request beyond the literal class names is clamped, not generated", () => {
  assert.equal(resolveStickyColumns(99), MAX_STICKY_COLUMNS)
  const pinned = new Set(
    [...classesOf({ stickyColumns: 99 }).matchAll(/nth-child\((\d+)\)/g)].map((m) => m[1])
  )
  assert.deepEqual([...pinned].sort(), ["1", "2", "3"])
})

test("nonsense column counts fall back to none", () => {
  assert.equal(resolveStickyColumns(undefined), 0)
  assert.equal(resolveStickyColumns(NaN), 0)
  assert.equal(resolveStickyColumns(Infinity), 0)
  assert.equal(resolveStickyColumns(-2), 0)
  assert.equal(resolveStickyColumns(1.7), 1)
})

// --- the corner ----------------------------------------------------------------------------------

// Two sticky cells with the same z-index are resolved by document order, and the body comes after
// the header — so the first column slides *over* the heading as soon as the table moves sideways.
test("the corner outranks both the header and the pinned column", () => {
  assert.ok(STICKY_Z.corner > STICKY_Z.header)
  assert.ok(STICKY_Z.header > STICKY_Z.column)
})

test("the corner cells are lifted above the rest", () => {
  const className = classesOf({ stickyColumns: 2 })
  assert.match(className, /\[&_thead_tr>\*:nth-child\(1\)\]:z-30/)
  assert.match(className, /\[&_thead_tr>\*:nth-child\(2\)\]:z-30/)
  assert.doesNotMatch(className, /\[&_thead_tr>\*:nth-child\(3\)\]/)
})

// STICKY_Z documents the ladder and the class names carry it, and the two are written out
// separately — Tailwind needs literals, so `z-${STICKY_Z.header}` cannot appear in the component.
// That leaves them free to drift: renumber one and the other still reads as correct, while the test
// above goes on comparing three numbers that no longer describe any rule. This is the seam, so it is
// asserted from the exported constant rather than from another copy of the digits.
test("the documented ladder is the one the rules actually emit", () => {
  const className = classesOf({ stickyColumns: 1 })
  assert.match(className, new RegExp(`\\[&_thead_th\\]:z-${STICKY_Z.header}(\\s|$)`))
  assert.match(className, new RegExp(`\\[&_tr>\\*:nth-child\\(1\\)\\]:z-${STICKY_Z.column}(\\s|$)`))
  assert.match(className, new RegExp(`\\[&_thead_tr>\\*:nth-child\\(1\\)\\]:z-${STICKY_Z.corner}(\\s|$)`))
})

// The rules only land the right way up if the selectors score in the same order as the numbers:
// the corner rule is written through `thead` so it outranks the column rule, which carries a
// pseudo-class and so outranks the header rule. Dropping `thead` from the corner rule would leave
// two equally specific z-index declarations and hand the result to stylesheet order.
test("the corner rule is more specific than the column rule it overrides", () => {
  const className = classesOf({ stickyColumns: 1 })
  assert.match(className, /\[&_thead_tr>\*:nth-child\(1\)\]:z-30/)
  assert.match(className, /\[&_tr>\*:nth-child\(1\)\]:z-10/)
})

// --- the wrapper ---------------------------------------------------------------------------------

// The pinned cells are positioned against this box, and a `<th>`'s pseudo-element needs it too.
test("the wrapper is a containing block", () => {
  assert.match(classesOf({}), /(^|\s)relative(\s|$)/)
})

test("the table is rendered untouched", () => {
  const tree = renderWrapper({ maxHeight: 420 })
  assert.equal(tree.type, "div")
  assert.equal(tree.props.children, table)
})

test("caller classes and styles come last so they can win", () => {
  const tree = renderWrapper({ className: "rounded-md", maxHeight: 420, style: { maxHeight: "50vh" } })
  assert.match(tree.props.className, /rounded-md$/)
  assert.equal(tree.props.style.maxHeight, "50vh")
})

test("unknown props reach the wrapper", () => {
  const tree = renderWrapper({ "aria-label": "Invoices", id: "invoices" })
  assert.equal(tree.props["aria-label"], "Invoices")
  assert.equal(tree.props.id, "invoices")
})

// --- measured offsets ----------------------------------------------------------------------------

test("offsets start where the previous column ended", () => {
  assert.deepEqual(cumulativeOffsets([48, 160, 90]), [0, 48, 208])
})

test("a single column rests at the left edge", () => {
  assert.deepEqual(cumulativeOffsets([200]), [0])
  assert.deepEqual(cumulativeOffsets([]), [])
})

// A column that has not been laid out yet reports 0, and a detached one can report NaN. Added
// straight in, one of those poisons every offset after it — `left: NaNpx` is dropped by the parser,
// which un-pins the column rather than mis-placing it, so nothing on screen points at the cause.
test("unmeasurable widths count as zero instead of poisoning the rest", () => {
  assert.deepEqual(cumulativeOffsets([NaN, 100, 50]), [0, 0, 100])
  assert.deepEqual(cumulativeOffsets([48, Infinity, 50]), [0, 48, 48])
  assert.deepEqual(cumulativeOffsets([48, -10, 50]), [0, 48, 48])
})

// Layout cannot be observed here, so the effect's own threshold is asserted as a named contract
// instead. One pinned column rests at a constant 0; from the second the offset is the measured width
// of the one before it, and a table that stops measuring at two puts its second column back on top
// of its first.
test("measuring starts at the second pinned column", () => {
  assert.equal(needsMeasurement(0), false)
  assert.equal(needsMeasurement(1), false)
  assert.equal(needsMeasurement(2), true)
  assert.equal(needsMeasurement(3), true)
})

// The harness has no layout, so a measurement taken here reads as "not measured yet" — which is also
// what the server renders. What is worth pinning is that it does not throw on the way through.
test("mounting without a DOM to measure is not an error", () => {
  const instance = render(StickyTableHeader, { children: table, maxHeight: 420, stickyColumns: 3 })
  assert.equal(instance.tree.type, "div")
  instance.unmount()
})
