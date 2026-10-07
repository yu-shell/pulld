// The column resizer everyone writes first puts `style.width` on the `<th>` from a pointermove and
// stores the width in React state. It looks finished and is wrong in five separate ways, every one
// of which was measured in a browser before these cases were written (Chromium, a 600px scroll
// container, three columns asked to be 120px each):
//
//   - `table-layout: fixed` with `width: auto` gives `[140, 243, 120]` — the automatic algorithm's
//     own answer. A fixed layout needs a definite width to be in effect at all, so the property can
//     be set and doing nothing. `width: max-content` is not definite either, and behaves the same.
//   - `table-layout: fixed` with `width: 100%` gives `[200, 200, 200]`: the space the columns did
//     not ask for is shared out between them, so dragging one column moves all of them. This is
//     where shadcn/ui's own `<Table>` puts you, because it renders `w-full`.
//   - `table-layout: fixed` with `width: 360px` — the sum — gives `[120, 120, 120]`. Only when the
//     table's width *is* the sum are the asked-for widths the used widths.
//   - adding `min-width: 100%` to that, which is the natural way to make a narrow table fill its
//     container, puts it straight back to `[199.66, 199.66, 199.69]`.
//   - and a `<col>` left unsized among sized ones does not fall back to its content; it is handed
//     what is left over, which is nothing, and measures `0`.
//
// So the cases below are written to fail against: widths that do not sum to the table width, a
// sparse width map reaching the colgroup, a drag accumulated per move rather than measured from its
// origin, a handle with no keyboard, a handle that swallows Tab, a cancelled pointer committed as a
// drop, and a right-to-left table resized the wrong way.
//
// `resizer` is passed explicitly to ColumnWidths and ColumnResizeHandle throughout. Both read it
// from context when it is absent, and `useContext` is the one hook the harness does not substitute.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as React from "react"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  DEFAULT_MIN_COLUMN_WIDTH,
  DEFAULT_MAX_COLUMN_WIDTH,
  DEFAULT_KEY_STEP,
  DEFAULT_KEY_STEP_LARGE,
  clampColumnWidth,
  resolveColumnWidths,
  tableWidthFor,
  columnOffsets,
  resizeColumnWidth,
  columnWidthFromDrag,
  keyboardColumnWidth,
  autoFitColumnWidth,
  isRtlElement,
  beginColumnResize,
  advanceColumnResize,
  useColumnResizer,
  ColumnResizer,
  ColumnWidths,
  ColumnResizeHandle,
  defaultColumnResizerLabels,
} = loadComponent(join(ROOT, "registry", "ui", "column-resizer.tsx"))

const COLUMNS = ["name", "status", "amount"]

// --- clamping ---------------------------------------------------------------

test("a width is held inside its bounds", () => {
  assert.equal(clampColumnWidth(160, { min: 48, max: 960 }), 160)
  assert.equal(clampColumnWidth(10, { min: 48, max: 960 }), 48)
  assert.equal(clampColumnWidth(5000, { min: 48, max: 960 }), 960)
})

test("an unusable width becomes the minimum rather than reaching the DOM as NaNpx", () => {
  // The arm that matters. A width is arithmetic on a pointer coordinate, so one undefined anywhere
  // in that sum is NaN — and NaN compares false against both bounds, so it survives every
  // `if (w < min)` guard written the obvious way. It then resolves to `width: NaNpx`, which is not a
  // length, so the declaration is dropped, and a `<col>` with no width under a fixed layout is the
  // one case that collapses the column to zero.
  assert.equal(clampColumnWidth(NaN, { min: 48 }), 48)
  assert.equal(clampColumnWidth(Infinity, { min: 48, max: 960 }), 960)
  assert.equal(clampColumnWidth(-Infinity, { min: 48 }), 48)
  assert.equal(clampColumnWidth(undefined, { min: 48 }), 48)
})

test("bounds given the wrong way round do not invert the clamp", () => {
  // min wins, rather than Math.min(max, Math.max(min, w)) producing a width below the floor.
  assert.equal(clampColumnWidth(500, { min: 200, max: 100 }), 200)
})

test("a non-finite bound falls back instead of poisoning the result", () => {
  assert.equal(clampColumnWidth(300, { min: NaN, max: NaN }), 300)
  assert.equal(clampColumnWidth(5000, { min: 48, max: NaN }), 5000)
})

// --- every column has to be sized ------------------------------------------

test("resolving widths fills in the columns nobody has resized", () => {
  const widths = resolveColumnWidths(COLUMNS, { name: 220 }, { defaultWidth: 160 })
  // Not [220] and not [220, undefined, undefined]: a sparse map is what the *user's* choices look
  // like, and an unsized <col> among sized ones measures 0 in a browser. The gap between the map
  // and the array is exactly where that bug lives.
  assert.deepEqual(widths, [220, 160, 160])
})

test("resolving widths clamps what was stored, including a width stored before the bounds changed", () => {
  assert.deepEqual(
    resolveColumnWidths(COLUMNS, { name: 10, status: 4000, amount: NaN }, { min: 48, max: 960 }),
    [48, 960, 48]
  )
})

test("resolving widths is dense even when the map is empty or absent", () => {
  assert.deepEqual(resolveColumnWidths(COLUMNS, undefined, { defaultWidth: 120 }), [120, 120, 120])
  assert.deepEqual(resolveColumnWidths(COLUMNS, {}, { defaultWidth: 120 }), [120, 120, 120])
  assert.deepEqual(resolveColumnWidths([], { name: 220 }), [])
})

test("a stored width for a column that is no longer rendered is ignored, not appended", () => {
  // Columns get hidden and reordered; the map outlives them on purpose, so that unhiding a column
  // restores its width. What it must not do is add a fourth <col> to a three-column table.
  assert.deepEqual(resolveColumnWidths(COLUMNS, { gone: 400, name: 200 }, { defaultWidth: 100 }), [
    200, 100, 100,
  ])
})

test("the default width is itself clamped", () => {
  assert.deepEqual(resolveColumnWidths(["a"], {}, { defaultWidth: 4, min: 48 }), [48])
})

// --- the table's width is the sum ------------------------------------------

test("the table width is the sum of the columns", () => {
  assert.equal(tableWidthFor([120, 120, 120]), 360)
  assert.equal(tableWidthFor([]), 0)
})

test("the sum survives a non-finite entry instead of becoming NaN", () => {
  // `width: NaNpx` is dropped by the parser, which leaves the table at `auto` — where
  // `table-layout: fixed` goes quiet and every column silently sizes itself to its content again.
  assert.equal(tableWidthFor([120, NaN, 120]), 240)
})

test("the resolved widths and the table width agree, which is the whole contract", () => {
  const widths = resolveColumnWidths(COLUMNS, { name: 220, status: 140 }, { defaultWidth: 160 })
  assert.equal(tableWidthFor(widths), 220 + 140 + 160)
})

// --- offsets ----------------------------------------------------------------

test("each column starts where the previous one ended", () => {
  assert.deepEqual(columnOffsets([120, 200, 80]), [0, 120, 320])
  assert.deepEqual(columnOffsets([]), [])
})

test("an offset is not poisoned by a non-finite width before it", () => {
  assert.deepEqual(columnOffsets([120, NaN, 80]), [0, 120, 120])
})

// --- the map is never mutated ----------------------------------------------

test("resizing returns a new map and leaves the old one alone", () => {
  const before = { name: 220, status: 140 }
  const after = resizeColumnWidth(before, "status", 300)
  assert.deepEqual(before, { name: 220, status: 140 })
  assert.deepEqual(after, { name: 220, status: 300 })
  assert.notEqual(before, after)
})

test("resizing clamps and works from no map at all", () => {
  assert.deepEqual(resizeColumnWidth(undefined, "name", 10, { min: 48 }), { name: 48 })
})

// --- the drag is measured from its origin ----------------------------------

test("a drag width is the starting width plus the distance travelled", () => {
  assert.equal(columnWidthFromDrag(160, 100, 140), 200)
  assert.equal(columnWidthFromDrag(160, 100, 60), 120)
})

test("a drag pushed past the minimum widens again as soon as it comes back", () => {
  // The property that separates measuring from the origin from accumulating per move. Dragged 500px
  // past the floor and then back to 100px short of the start, the column is 60px wide — not stuck at
  // the minimum waiting for 500px of travel to be repaid, and not 448px from the deltas being
  // summed after the clamp. The accumulating version feels like the handle has been dropped.
  const start = 160
  assert.equal(columnWidthFromDrag(start, 0, -500, { min: 48 }), 48)
  assert.equal(columnWidthFromDrag(start, 0, -100, { min: 48 }), 60)
  assert.equal(columnWidthFromDrag(start, 0, 0, { min: 48 }), 160)
})

test("a drag is clamped at both ends, not just the floor", () => {
  assert.equal(columnWidthFromDrag(160, 0, 5000, { min: 48, max: 960 }), 960)
  assert.equal(columnWidthFromDrag(160, 0, -5000, { min: 48, max: 960 }), 48)
})

test("a right-to-left table mirrors the gesture", () => {
  // The handle is on the column's left edge there, so dragging left widens it. Getting this wrong
  // does not look like a direction bug — it looks like the handle resizing its neighbour.
  assert.equal(columnWidthFromDrag(160, 100, 140, { rtl: true }), 120)
  assert.equal(columnWidthFromDrag(160, 100, 60, { rtl: true }), 200)
})

test("a session advances without being mutated", () => {
  const session = beginColumnResize({ column: "name", startX: 100, startWidth: 160, pointerId: 7 })
  assert.equal(session.width, 160)
  const next = advanceColumnResize(session, 220)
  assert.equal(session.width, 160)
  assert.equal(next.width, 280)
  assert.equal(next.startWidth, 160)
  assert.equal(next.pointerId, 7)
  // Advancing twice from the same session is the same as advancing once to the same place.
  assert.equal(advanceColumnResize(next, 220).width, 280)
})

// --- the keyboard -----------------------------------------------------------

test("arrow keys move the width by one step", () => {
  assert.equal(keyboardColumnWidth("ArrowRight", 160), 160 + DEFAULT_KEY_STEP)
  assert.equal(keyboardColumnWidth("ArrowLeft", 160), 160 - DEFAULT_KEY_STEP)
})

test("page keys move it by the large step and both are clamped", () => {
  assert.equal(keyboardColumnWidth("PageUp", 160), 160 + DEFAULT_KEY_STEP_LARGE)
  assert.equal(keyboardColumnWidth("PageDown", 160), 160 - DEFAULT_KEY_STEP_LARGE)
  assert.equal(keyboardColumnWidth("PageDown", 60, { min: 48 }), 48)
  assert.equal(keyboardColumnWidth("PageUp", 940, { max: 960 }), 960)
})

test("Home and End go to the bounds", () => {
  assert.equal(keyboardColumnWidth("Home", 400, { min: 48, max: 960 }), 48)
  assert.equal(keyboardColumnWidth("End", 400, { min: 48, max: 960 }), 960)
})

test("a key the handle does not claim returns null rather than the current width", () => {
  // Null is what lets the caller leave the event alone. A handle that answers every key with a
  // number takes Tab with it, and focus is then trapped on a column border — which is how an
  // accessibility feature becomes the thing that breaks the page.
  assert.equal(keyboardColumnWidth("Tab", 160), null)
  assert.equal(keyboardColumnWidth("Enter", 160), null)
  assert.equal(keyboardColumnWidth(" ", 160), null)
  assert.equal(keyboardColumnWidth("ArrowUp", 160), null)
  assert.equal(keyboardColumnWidth("a", 160), null)
})

test("the arrow keys are mirrored in a right-to-left table too", () => {
  assert.equal(keyboardColumnWidth("ArrowLeft", 160, { rtl: true }), 160 + DEFAULT_KEY_STEP)
  assert.equal(keyboardColumnWidth("ArrowRight", 160, { rtl: true }), 160 - DEFAULT_KEY_STEP)
  // Home and End are the bounds, not directions, so they do not mirror.
  assert.equal(keyboardColumnWidth("Home", 400, { rtl: true, min: 48 }), 48)
})

// --- auto fit ---------------------------------------------------------------

test("auto fit takes the widest cell's content and rounds up", () => {
  // scrollWidth is the only usable ruler: under a fixed layout the cell is already as narrow as the
  // column, so its own box says nothing about its content. Rounded up, because a fraction down is a
  // clipped last glyph.
  assert.equal(autoFitColumnWidth([{ scrollWidth: 100 }, { scrollWidth: 180.2 }], { padding: 24 }), 205)
})

test("auto fit on an empty column returns null instead of snapping to the minimum", () => {
  // A column of empty cells is almost always a column still loading, and collapsing it is a worse
  // answer than leaving it alone.
  assert.equal(autoFitColumnWidth([], { padding: 24 }), null)
  assert.equal(autoFitColumnWidth([{ scrollWidth: 0 }, { scrollWidth: 0 }]), null)
  assert.equal(autoFitColumnWidth([{}, {}]), null)
  assert.equal(autoFitColumnWidth([{ scrollWidth: NaN }]), null)
})

test("auto fit is clamped like any other width", () => {
  assert.equal(autoFitColumnWidth([{ scrollWidth: 5000 }], { max: 960 }), 960)
  assert.equal(autoFitColumnWidth([{ scrollWidth: 2 }], { min: 48, padding: 0 }), 48)
})

// --- direction is read from the element -------------------------------------

test("direction is read from the element, and absent globals do not throw", () => {
  const saved = globalThis.getComputedStyle
  globalThis.getComputedStyle = () => ({ direction: "rtl" })
  assert.equal(isRtlElement({}), true)
  globalThis.getComputedStyle = () => ({ direction: "ltr" })
  assert.equal(isRtlElement({}), false)
  assert.equal(isRtlElement(null), false)
  delete globalThis.getComputedStyle
  assert.equal(isRtlElement({}), false)
  globalThis.getComputedStyle = saved
})

test("the spoken value carries its unit", () => {
  // "240" on its own is read out as a quantity of nothing.
  assert.equal(defaultColumnResizerLabels.value(240.4), "240 pixels")
  assert.match(defaultColumnResizerLabels.handle("amount"), /amount/)
})

// --- rendered, and dragged --------------------------------------------------

/** A table wired the way the doc comment says to wire one, so the hook can be driven. */
function mount(options = {}, renderOptions = {}) {
  let resizer = null
  const Harness = (props) => {
    resizer = useColumnResizer({ columns: COLUMNS, ...props })
    return React.createElement(
      ColumnResizer,
      { resizer },
      React.createElement(
        "table",
        resizer.tableProps,
        React.createElement(ColumnWidths, { resizer }),
        React.createElement(
          "thead",
          null,
          React.createElement(
            "tr",
            null,
            ...COLUMNS.map((column) =>
              React.createElement(
                "th",
                { key: column, className: "relative" },
                column,
                React.createElement(ColumnResizeHandle, { key: `h-${column}`, column, resizer })
              )
            )
          )
        )
      )
    )
  }
  const instance = render(Harness, options, renderOptions)
  return {
    instance,
    get resizer() {
      return resizer
    },
    handles: () => walk(instance.tree).filter((n) => n.props?.role === "separator"),
    cols: () => walk(instance.tree).filter((n) => n.type === "col"),
    table: () => walk(instance.tree).find((n) => n.type === "table"),
    guide: () => walk(instance.tree).find((n) => n.props?.["aria-hidden"] === "true" && "hidden" in (n.props ?? {})),
  }
}

const pointer = (overrides = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: 0,
  preventDefault() {},
  stopPropagation() {},
  currentTarget: { setPointerCapture() {}, releasePointerCapture() {} },
  ...overrides,
})

test("the table carries a fixed layout and a width equal to the sum of its columns", () => {
  const ui = mount({ defaultWidths: { name: 220, status: 140, amount: 120 } })
  const style = ui.table().props.style
  assert.equal(style.tableLayout, "fixed")
  // Not 100%, and not absent. Both of those were measured giving the wrong columns.
  assert.equal(style.width, "480px")
  assert.equal(ui.resizer.totalWidth, 480)
})

test("the colgroup has one sized col per column, in order", () => {
  const ui = mount({ defaultWidths: { name: 220 }, defaultWidth: 160 })
  assert.deepEqual(
    ui.cols().map((c) => c.props.style.width),
    ["220px", "160px", "160px"]
  )
})

test("each handle is a separator with a value a screen reader can read", () => {
  const ui = mount({ defaultWidths: { name: 220 }, min: 48, max: 960 })
  const [first] = ui.handles()
  assert.equal(first.props.role, "separator")
  assert.equal(first.props.tabIndex, 0)
  assert.equal(first.props["aria-orientation"], "vertical")
  assert.equal(first.props["aria-valuenow"], 220)
  assert.equal(first.props["aria-valuemin"], 48)
  // Present, and truthful. An absent aria-valuemax is 100 per ARIA, so a handle reporting
  // valuenow=220 with no maximum announces a nonsense percentage.
  assert.equal(first.props["aria-valuemax"], 960)
  assert.equal(first.props["aria-valuetext"], "220 pixels")
  assert.match(first.props["aria-label"], /name/)
  assert.equal(ui.handles().length, COLUMNS.length)
})

test("the last column's handle stays inside the table", () => {
  const ui = mount({ defaultWidths: { name: 220, status: 140, amount: 120 } })
  const handles = ui.handles()
  // Every other handle straddles the boundary it represents, so the grab area is centred on the
  // line. The last one cannot: that boundary is the table's own right edge, and half a handle past
  // it is content, so the scroll container offers four pixels of horizontal scroll on a table that
  // fits exactly — a scrollbar that appears for nothing.
  assert.equal(handles[0].props.style.transform, "translateX(50%)")
  assert.equal(handles[1].props.style.transform, "translateX(50%)")
  assert.equal(handles[2].props.style.transform, undefined)
})

test("the guide is hidden until a drag starts, and is not inside a cell", () => {
  const ui = mount()
  assert.equal(ui.guide().props.hidden, true)
  // It is a child of the wrapper, not of the <th>. Inside a cell given `position: relative` — which
  // the handle needs — an absolute line resolves against that cell and becomes a tick in the header
  // instead of a boundary through the rows.
  const cellIds = new Set(walk(ui.instance.tree).filter((n) => n.type === "th"))
  const insideCell = walk(ui.instance.tree).some(
    (n) => cellIds.has(n) && walk(n.props?.children ?? null).some((c) => c.props?.hidden === true)
  )
  assert.equal(insideCell, false)
})

test("a drag commits once, on release, with the width it was dropped at", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220, status: 140, amount: 120 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props

  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  assert.equal(ui.resizer.resizing, "name")
  // Nothing is committed while the pointer is down: a width is a stored preference, and a listener
  // that writes to localStorage or a server has no business running sixty times a second.
  handle().onPointerMove(pointer({ clientX: 340 }))
  handle().onPointerMove(pointer({ clientX: 380 }))
  assert.equal(changes.length, 0)

  handle().onPointerUp(pointer({ clientX: 380 }))
  ui.instance.rerender()
  assert.equal(changes.length, 1)
  assert.deepEqual(changes[0], { name: 300, status: 140, amount: 120 })
  assert.equal(ui.resizer.resizing, null)
  assert.equal(ui.resizer.totalWidth, 560)
})

test("a move from another pointer is ignored while one is captured", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220, status: 140, amount: 120 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300, pointerId: 1 }))
  ui.instance.rerender()
  // A second finger landing on the table must not drive the drag the first one owns.
  handle().onPointerMove(pointer({ clientX: 900, pointerId: 2 }))
  handle().onPointerUp(pointer({ clientX: 340, pointerId: 1 }))
  ui.instance.rerender()
  assert.deepEqual(changes[0], { name: 260, status: 140, amount: 120 })
})

test("a second finger's release does not end the first one's drag", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300, pointerId: 1 }))
  ui.instance.rerender()
  // Lifting an unrelated finger — or a stylus, or a second touch the table never asked for — is not
  // the end of this gesture, and taking it as one drops the drag mid-stroke at whatever coordinate
  // the other pointer happened to be at.
  handle().onPointerUp(pointer({ clientX: 900, pointerId: 2 }))
  ui.instance.rerender()
  assert.equal(ui.resizer.resizing, "name")
  assert.equal(changes.length, 0)

  handle().onPointerUp(pointer({ clientX: 340, pointerId: 1 }))
  ui.instance.rerender()
  assert.deepEqual(changes, [{ name: 260 }])
})

test("a cancelled pointer is not a drop", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerMove(pointer({ clientX: 500 }))
  // The OS takes the pointer away for a phone call, an edge gesture, a palm on the trackpad — and at
  // that moment the finger is wherever it had got to, so treating cancel as a release commits a
  // width nobody chose.
  handle().onPointerCancel(pointer({ clientX: 500 }))
  ui.instance.rerender()
  assert.equal(changes.length, 0)
  assert.equal(ui.resizer.resizing, null)
  assert.equal(ui.resizer.widths[0], 220)
})

test("Escape during a drag abandons it", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerMove(pointer({ clientX: 500 }))
  handle().onKeyDown({ key: "Escape", preventDefault() {}, currentTarget: {} })
  ui.instance.rerender()
  assert.equal(changes.length, 0)
  assert.equal(ui.resizer.resizing, null)
})

test("a drag that ends where it began commits nothing", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerUp(pointer({ clientX: 300 }))
  ui.instance.rerender()
  // A plain click on the handle is a zero-length drag. Writing the unchanged width back would make
  // every click a change event, and a parent persisting those would save on every stray click.
  assert.equal(changes.length, 0)
})

test("a secondary button does not start a drag", () => {
  const ui = mount({ defaultWidths: { name: 220 } })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300, button: 2 }))
  ui.instance.rerender()
  // Right-clicking opens a menu; a gesture that only ends on pointerup would then never end.
  assert.equal(ui.resizer.resizing, null)
})

test("the press is kept from the header underneath it", () => {
  const ui = mount({ defaultWidths: { name: 220 } })
  let defaulted = false
  let stopped = false
  ui.handles()[0].props.onPointerDown(
    pointer({ clientX: 300, preventDefault: () => (defaulted = true), stopPropagation: () => (stopped = true) })
  )
  // The <th> under the handle is a sort button in most tables. Without both of these, every resize
  // also sorts the column on release.
  assert.equal(defaulted, true)
  assert.equal(stopped, true)
})

test("the pointer is captured, or the drag ends on the first move", () => {
  const ui = mount({ defaultWidths: { name: 220 } })
  const captured = []
  ui.handles()[0].props.onPointerDown(
    pointer({ clientX: 300, pointerId: 9, currentTarget: { setPointerCapture: (id) => captured.push(id) } })
  )
  // Widening the column moves the handle out from under the finger immediately — the strip is nine
  // pixels wide — so without capture the very first move leaves the element and the column snaps
  // back.
  assert.deepEqual(captured, [9])
})

test("losing the capture finishes the drag rather than leaving it running", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerMove(pointer({ clientX: 360 }))
  handle().onLostPointerCapture(pointer({ clientX: 360 }))
  ui.instance.rerender()
  assert.equal(ui.resizer.resizing, null)
  assert.deepEqual(changes[0], { name: 280 })
})

test("a rogue pointer's move cannot be the width that gets committed", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300, pointerId: 1 }))
  ui.instance.rerender()
  // A second finger lands and the OS then takes the capture away, so there is no legitimate move or
  // release afterwards to re-derive the width from. Measuring every move from the gesture's origin
  // hides this in the ordinary case — the next real event corrects it — which is exactly why the
  // pointer id has to be checked rather than relied upon to come out in the wash.
  handle().onPointerMove(pointer({ clientX: 900, pointerId: 2 }))
  handle().onLostPointerCapture(pointer({ pointerId: 2 }))
  ui.instance.rerender()
  assert.equal(changes.length, 0)
  assert.equal(ui.resizer.widths[0], 220)
})

test("an arrow key resizes without any pointer, and is clamped", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, min: 48, max: 960, onWidthsChange: (w) => changes.push(w) })
  const key = (k) => {
    let prevented = false
    ui.handles()[0].props.onKeyDown({ key: k, preventDefault: () => (prevented = true), currentTarget: {} })
    ui.instance.rerender()
    return prevented
  }
  assert.equal(key("ArrowRight"), true)
  assert.deepEqual(changes.at(-1), { name: 220 + DEFAULT_KEY_STEP })
  assert.equal(key("ArrowLeft"), true)
  assert.deepEqual(changes.at(-1), { name: 220 })
  assert.equal(key("End"), true)
  assert.deepEqual(changes.at(-1), { name: 960 })
})

test("Tab is left alone so focus can leave the handle", () => {
  const ui = mount({ defaultWidths: { name: 220 } })
  let prevented = false
  ui.handles()[0].props.onKeyDown({ key: "Tab", preventDefault: () => (prevented = true), currentTarget: {} })
  assert.equal(prevented, false)
})

test("an arrow key already at the bound fires no change", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 48 }, min: 48, onWidthsChange: (w) => changes.push(w) })
  ui.handles()[0].props.onKeyDown({ key: "ArrowLeft", preventDefault() {}, currentTarget: {} })
  ui.instance.rerender()
  assert.equal(changes.length, 0)
})

test("an arrow key on a right-to-left table runs the other way, before any drag has happened", () => {
  const changes = []
  const ui = mount(
    { defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) },
    { direction: "rtl" }
  )
  // The regression this pins: direction used to be read only in the pointer handler and cached, so
  // the arrow keys ran left-to-right on an RTL table until somebody had dragged a column once — and
  // came right afterwards, which is worse than being consistently wrong.
  ui.handles()[0].props.onKeyDown({ key: "ArrowLeft", preventDefault() {}, currentTarget: {} })
  ui.instance.rerender()
  assert.deepEqual(changes.at(-1), { name: 220 + DEFAULT_KEY_STEP })
})

test("a controlled resizer does not move itself", () => {
  const changes = []
  const ui = mount({ widths: { name: 220, status: 140, amount: 120 }, onWidthsChange: (w) => changes.push(w) })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerMove(pointer({ clientX: 400 }))
  handle().onPointerUp(pointer({ clientX: 400 }))
  ui.instance.rerender()
  // The parent owns the value: it is told, and the column stays where it was until it says so. A
  // component that also writes its own copy shows a width the parent rejected.
  assert.deepEqual(changes[0], { name: 320, status: 140, amount: 120 })
  assert.equal(ui.resizer.widths[0], 220)
  assert.equal(ui.table().props.style.width, "480px")

  ui.instance.update({ widths: changes[0], onWidthsChange: (w) => changes.push(w) })
  assert.equal(ui.resizer.widths[0], 320)
  assert.equal(ui.table().props.style.width, "580px")
})

test("an uncontrolled resizer keeps its own widths", () => {
  const ui = mount({ defaultWidths: { name: 220, status: 140, amount: 120 } })
  const handle = () => ui.handles()[0].props
  handle().onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  handle().onPointerUp(pointer({ clientX: 360 }))
  ui.instance.rerender()
  assert.equal(ui.resizer.widths[0], 280)
  assert.equal(ui.table().props.style.width, "540px")
})

test("setColumnWidth is the door for a reset button or a width restored from storage", () => {
  const changes = []
  const ui = mount({ defaultWidths: { name: 220 }, onWidthsChange: (w) => changes.push(w) })
  ui.resizer.setColumnWidth("name", 4000)
  ui.instance.rerender()
  // Clamped on the way in, like every other path. Restoring a width saved under different bounds is
  // exactly how an out-of-range number gets in.
  assert.deepEqual(changes.at(-1), { name: 960 })
})

test("the handle marks itself while it is the one being dragged", () => {
  const ui = mount({ defaultWidths: { name: 220 } })
  assert.equal(ui.handles()[0].props["data-resizing"], undefined)
  ui.handles()[0].props.onPointerDown(pointer({ clientX: 300 }))
  ui.instance.rerender()
  assert.equal(ui.handles()[0].props["data-resizing"], "true")
  // And only that one: a flag held per handle rather than derived from one piece of state leaves
  // every handle ever dragged looking active.
  assert.equal(ui.handles()[1].props["data-resizing"], undefined)
})
