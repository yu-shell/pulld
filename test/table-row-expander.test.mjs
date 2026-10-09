// The expandable table row everyone writes first puts the detail row in the same `<tbody>` as the
// data rows, guesses a `colSpan`, holds `useState(false)` inside each row, and animates the `<tr>`.
// Each of those renders something that looks finished. The cases below are written to fail against
// them:
//
//   - a detail `colSpan` smaller than the table, which squeezes the columns it does *not* reach,
//   - a fallback of 1 when the count is unknown, which is the worst possible guess rather than the
//     safest,
//   - a column count read from the header row, or one that counts the detail cell's own 1000,
//   - per-row open state, which stays with the row's position when the table is re-ordered,
//   - a shared `<tbody>`, where `nth-child` striping lands on the detail rows and no data row,
//   - `aria-expanded` on the `<tr>`, where official's `:has([aria-expanded=true])` cannot see it,
//   - `aria-controls` pointing at a detail cell that is not rendered,
//   - a bare chevron with no accessible name, so forty rows announce the word "button",
//   - and measuring the columns in an effect, so the first paint of the detail row is at the
//     fallback and the columns jump one frame later.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  DETAIL_COLSPAN_WHEN_UNKNOWN,
  DETAIL_CELL_ATTRIBUTE,
  resolveDetailColSpan,
  countTableColumns,
  useRowExpansion,
  defaultRowExpanderLabels,
  TableRowExpanderTrigger,
  TableRowExpanderDetail,
  TableRowExpander,
} = loadComponent(join(ROOT, "registry", "ui", "table-row-expander.tsx"), {
  stubs: {
    "lucide-react": {
      ChevronRight: function ChevronRight(props) {
        return { type: "svg", props: { "data-icon": "chevron", ...props } }
      },
    },
  },
})

// --- the colSpan rule -----------------------------------------------------------------------------

test("a known column count is used as it is", () => {
  assert.equal(resolveDetailColSpan(3), 3)
  assert.equal(resolveDetailColSpan(1), 1)
  assert.equal(resolveDetailColSpan(12), 12)
})

test("an unknown column count over-claims rather than guessing small", () => {
  // The measurement behind this: on a three-column table, colSpan 9 is pixel-identical to the
  // correct 3, while colSpan 1 collapses the last column from 100px to 26.6px. Any fallback at or
  // below the real count is the failure this constant exists to avoid.
  for (const unknown of [null, undefined, NaN, Infinity]) {
    const span = resolveDetailColSpan(unknown)
    assert.equal(span, DETAIL_COLSPAN_WHEN_UNKNOWN)
    assert.ok(span > 64, `a fallback of ${span} would under-claim on a wide table`)
  }
})

test("the unknown-count fallback stays inside what HTML allows for colspan", () => {
  // Over-claiming is free, but only because the browser clamps it. 1000 is the clamp.
  assert.equal(DETAIL_COLSPAN_WHEN_UNKNOWN, 1000)
})

test("a fractional or zero count rounds up, never down", () => {
  // Rounding down is the under-claim again, arrived at by arithmetic instead of by a guess.
  assert.equal(resolveDetailColSpan(2.4), 3)
  assert.equal(resolveDetailColSpan(0), 1)
  assert.equal(resolveDetailColSpan(-5), 1)
})

// --- counting the columns -------------------------------------------------------------------------

// A stand-in for the bits of HTMLTableElement the counter touches.
const fakeTable = (rows) => ({
  rows: rows.map((cells) => ({
    cells: cells.map((cell) =>
      typeof cell === "number"
        ? { colSpan: cell, hasAttribute: () => false }
        : { colSpan: cell.colSpan, hasAttribute: (name) => name === DETAIL_CELL_ATTRIBUTE }
    ),
  })),
})

test("the widest row decides, not the header row", () => {
  // The header missing the chevron column is the most common way to build this: the column gets
  // added to the body and forgotten in the thead. Reading row 0 would answer 3 for a 4-column
  // table, and 3 is an under-claim.
  const table = fakeTable([
    [1, 1, 1], // thead, missing the chevron column
    [1, 1, 1, 1], // tbody, with it
  ])
  assert.equal(countTableColumns(table), 4)
})

test("colSpan in the header is added up rather than counted as one cell", () => {
  // The spanning row must be the widest one, or counting cells gives the same answer by accident:
  // 3+1 is four columns held in two cells, and a grouped header ("Contact" over email and phone)
  // is the ordinary way a table arrives at that shape.
  assert.equal(countTableColumns(fakeTable([[3, 1], [1, 1]])), 4)
})

test("a detail cell's own span is not counted as columns", () => {
  // Otherwise the fallback feeds back into the measurement: the detail cell reports 1000, 1000
  // becomes the count, and every detail row after it is pinned there.
  const table = fakeTable([
    [1, 1, 1],
    [1, 1, 1],
    [{ colSpan: DETAIL_COLSPAN_WHEN_UNKNOWN, detail: true }],
  ])
  assert.equal(countTableColumns(table), 3)
})

test("a table that cannot be measured answers null rather than a number", () => {
  // null is what routes to the over-claim. A 0 here would be rounded up to 1 by the rule above,
  // which is the under-claim.
  assert.equal(countTableColumns(null), null)
  assert.equal(countTableColumns(undefined), null)
  assert.equal(countTableColumns({ rows: [] }), null)
  assert.equal(countTableColumns(fakeTable([[]])), null)
})

test("a missing colSpan counts as one column", () => {
  const table = { rows: [{ cells: [{ hasAttribute: () => false }, { hasAttribute: () => false }] }] }
  assert.equal(countTableColumns(table), 2)
})

// --- the expansion state --------------------------------------------------------------------------

/** Drives a hook through the harness by rendering a component that only calls it. */
function renderHook(hook, props) {
  let latest
  const Probe = (p) => {
    latest = hook(p)
    return null
  }
  const instance = render(Probe, props)
  return {
    get current() {
      return latest
    },
    act(fn) {
      fn(latest)
      instance.rerender()
      return latest
    },
    update(next) {
      instance.update(next)
      return latest
    },
  }
}

test("rows open and close by id", () => {
  const hook = renderHook(useRowExpansion, {})
  assert.deepEqual(hook.current.expandedIds, [])
  hook.act((h) => h.toggle("a"))
  assert.ok(hook.current.isExpanded("a"))
  hook.act((h) => h.toggle("a"))
  assert.equal(hook.current.isExpanded("a"), false)
})

test("open rows are remembered by id, so re-ordering the table keeps the panel with its row", () => {
  // The per-row useState(false) this replaces cannot do it: sort the table and the open panel stays
  // at the index it was at, under whichever row has moved into that position.
  const hook = renderHook(useRowExpansion, { defaultExpandedIds: ["b"] })
  assert.deepEqual([...hook.current.expandedIds], ["b"])
  assert.ok(hook.current.isExpanded("b"))
  assert.equal(hook.current.isExpanded("a"), false)
})

test("multiple: false closes the row that was open instead of adding to it", () => {
  const hook = renderHook(useRowExpansion, { multiple: false })
  hook.act((h) => h.expand("a"))
  hook.act((h) => h.expand("b"))
  assert.deepEqual([...hook.current.expandedIds], ["b"])
})

test("multiple: true keeps both, in the order they were opened", () => {
  const hook = renderHook(useRowExpansion, {})
  hook.act((h) => h.expand("a"))
  hook.act((h) => h.expand("b"))
  assert.deepEqual([...hook.current.expandedIds], ["a", "b"])
})

test("expanding a row that is already open does not duplicate it or fire a change", () => {
  const seen = []
  const hook = renderHook(useRowExpansion, { onExpandedChange: (ids) => seen.push(ids) })
  hook.act((h) => h.expand("a"))
  hook.act((h) => h.expand("a"))
  assert.deepEqual([...hook.current.expandedIds], ["a"])
  assert.equal(seen.length, 1)
})

test("collapsing a row that is already closed fires nothing", () => {
  const seen = []
  const hook = renderHook(useRowExpansion, { onExpandedChange: (ids) => seen.push(ids) })
  hook.act((h) => h.collapse("nope"))
  assert.equal(seen.length, 0)
})

test("collapseAll empties the set, and does nothing twice", () => {
  const seen = []
  const hook = renderHook(useRowExpansion, {
    defaultExpandedIds: ["a", "b"],
    onExpandedChange: (ids) => seen.push(ids),
  })
  hook.act((h) => h.collapseAll())
  assert.deepEqual([...hook.current.expandedIds], [])
  hook.act((h) => h.collapseAll())
  assert.equal(seen.length, 1)
})

test("a controlled set is what gets read, and the parent is still told what to change it to", () => {
  const seen = []
  const hook = renderHook(useRowExpansion, {
    expandedIds: ["a"],
    onExpandedChange: (ids) => seen.push(ids),
  })
  hook.act((h) => h.toggle("b"))
  // The prop did not change, so neither did what the hook reports.
  assert.deepEqual([...hook.current.expandedIds], ["a"])
  assert.deepEqual(seen, [["a", "b"]])
})

test("a parent that stops controlling does not revert to a stale internal set", () => {
  // The `if (!controlled) setInternal(...)` shortcut passes every other test here and fails this
  // one: the internal copy would still be [] from before the parent took over.
  const hook = renderHook(useRowExpansion, { expandedIds: ["a"], onExpandedChange: () => {} })
  hook.act((h) => h.expand("b"))
  hook.update({ onExpandedChange: () => {} })
  assert.deepEqual([...hook.current.expandedIds], ["a", "b"])
})

// --- the trigger ----------------------------------------------------------------------------------

const triggerProps = (overrides = {}) => ({
  expanded: false,
  onExpandedChange: () => {},
  label: "invoice INV-2048",
  controls: "detail-1",
  ...overrides,
})

const buttonOf = (tree) => byTag(walk(tree), "button")[0]

test("the trigger is a real button, so Enter and Space work without any key handling", () => {
  const { tree } = render(TableRowExpanderTrigger, triggerProps())
  const button = buttonOf(tree)
  assert.equal(button.type, "button")
  assert.equal(button.props.type, "button")
})

test("aria-expanded sits on the button, where official's :has([aria-expanded=true]) can see it", () => {
  // Measured from official's own compiled stylesheet: TableRow's `has-aria-expanded:bg-muted/50`
  // expands to `:has([aria-expanded=true])`, a descendant match. On the <tr> it matches nothing.
  const closed = render(TableRowExpanderTrigger, triggerProps())
  assert.equal(buttonOf(closed.tree).props["aria-expanded"], false)
  const open = render(TableRowExpanderTrigger, triggerProps({ expanded: true }))
  assert.equal(buttonOf(open.tree).props["aria-expanded"], true)
})

test("the chevron button carries the row's name, not just the word button", () => {
  const closed = render(TableRowExpanderTrigger, triggerProps())
  const name = buttonOf(closed.tree).props["aria-label"]
  assert.match(name, /invoice INV-2048/)
  assert.equal(name, defaultRowExpanderLabels.expand("invoice INV-2048"))

  const open = render(TableRowExpanderTrigger, triggerProps({ expanded: true }))
  const openName = buttonOf(open.tree).props["aria-label"]
  assert.match(openName, /invoice INV-2048/)
  assert.notEqual(openName, name)
})

test("the chevron itself is hidden from the reading order", () => {
  // The name says Show/Hide and aria-expanded says which way round it is. A third telling of the
  // same fact, on every row, is the cost of forgetting this.
  const { tree } = render(TableRowExpanderTrigger, triggerProps())
  const icon = walk(tree).find((node) => node.props?.["data-icon"] === "chevron")
  assert.equal(icon.props["aria-hidden"], "true")
})

test("aria-controls points at the detail cell only while it exists", () => {
  // A dangling aria-controls is worse than none: it offers a jump that lands nowhere.
  const closed = render(TableRowExpanderTrigger, triggerProps())
  assert.equal(buttonOf(closed.tree).props["aria-controls"], undefined)
  const open = render(TableRowExpanderTrigger, triggerProps({ expanded: true }))
  assert.equal(buttonOf(open.tree).props["aria-controls"], "detail-1")
})

test("pressing the trigger asks for the opposite of what it is now", () => {
  const calls = []
  const closed = render(
    TableRowExpanderTrigger,
    triggerProps({ onExpandedChange: (next) => calls.push(next) })
  )
  buttonOf(closed.tree).props.onClick({})
  assert.deepEqual(calls, [true])

  const open = render(
    TableRowExpanderTrigger,
    triggerProps({ expanded: true, onExpandedChange: (next) => calls.push(next) })
  )
  buttonOf(open.tree).props.onClick({})
  assert.deepEqual(calls, [true, false])
})

test("a caller's own onClick runs, and preventDefault on it stops the toggle", () => {
  const calls = []
  const { tree } = render(
    TableRowExpanderTrigger,
    triggerProps({
      onClick: () => calls.push("caller"),
      onExpandedChange: () => calls.push("toggled"),
    })
  )
  buttonOf(tree).props.onClick({ defaultPrevented: false })
  assert.deepEqual(calls, ["caller", "toggled"])

  calls.length = 0
  buttonOf(tree).props.onClick({ defaultPrevented: true })
  assert.deepEqual(calls, ["caller"])
})

test("the trigger keeps a visible focus ring and a disabled state", () => {
  const { tree } = render(TableRowExpanderTrigger, triggerProps({ disabled: true }))
  const button = buttonOf(tree)
  assert.equal(button.props.disabled, true)
  assert.match(button.props.className, /focus-visible:ring-2/)
})

test("labels can be replaced one at a time", () => {
  const { tree } = render(
    TableRowExpanderTrigger,
    triggerProps({ labels: { expand: (l) => `Open ${l}` } })
  )
  assert.equal(buttonOf(tree).props["aria-label"], "Open invoice INV-2048")
})

// --- the detail row -------------------------------------------------------------------------------

const cellOf = (tree) => byTag(walk(tree), "td")[0]

test("the detail cell spans the whole table", () => {
  const { tree } = render(TableRowExpanderDetail, { children: "lines", colSpan: 4 })
  assert.equal(cellOf(tree).props.colSpan, 4)
})

test("a detail row rendered before the table can be measured over-claims", () => {
  const { tree } = render(TableRowExpanderDetail, { children: "lines", colSpan: null })
  assert.equal(cellOf(tree).props.colSpan, DETAIL_COLSPAN_WHEN_UNKNOWN)
})

test("the detail cell marks itself so the column counter skips it", () => {
  const { tree } = render(TableRowExpanderDetail, { children: "lines", colSpan: 3 })
  assert.equal(cellOf(tree).props[DETAIL_CELL_ATTRIBUTE], "")
})

test("the detail content sits in a panel inside the cell, which is the only thing that can collapse", () => {
  // Measured: a <tr> and a <td> asked to be `height: 0; overflow: hidden` are both 33px tall; a
  // <div> inside the cell is 0. An animation attached to the row is attached to the one element in
  // the tree that cannot honour it.
  const { tree } = render(TableRowExpanderDetail, {
    children: "lines",
    colSpan: 3,
    panelClassName: "data-[state=open]:animate-accordion-down",
  })
  const nodes = walk(tree)
  const panel = nodes.find((n) => n.type === "div")
  assert.ok(panel, "the detail content must be wrapped in an element that can be collapsed")
  assert.match(panel.props.className, /animate-accordion-down/)
  // data-state is what official's own collapsing components key their keyframes off.
  assert.equal(panel.props["data-state"], "open")
})

test("the cell holds no padding of its own, because padding cannot collapse either", () => {
  // The panel owns the padding. Left on the <td>, the closed height is the padding rather than
  // zero — the same measurement that rules out animating the row rules out padding on the cell.
  const { tree } = render(TableRowExpanderDetail, { children: "lines", colSpan: 3 })
  assert.match(cellOf(tree).props.className, /(^|\s)p-0(\s|$)/)
})

test("the chevron turns only when the row is open, and holds still for reduced motion", () => {
  const iconOf = (tree) => walk(tree).find((n) => n.props?.["data-icon"] === "chevron")
  const closed = render(TableRowExpanderTrigger, triggerProps())
  assert.doesNotMatch(iconOf(closed.tree).props.className, /rotate-90/)
  const open = render(TableRowExpanderTrigger, triggerProps({ expanded: true }))
  assert.match(iconOf(open.tree).props.className, /rotate-90/)
  assert.match(iconOf(open.tree).props.className, /motion-reduce:transition-none/)
})

test("the detail row is a real row rather than one hidden from the table's grid", () => {
  const { tree } = render(TableRowExpanderDetail, { children: "lines", colSpan: 3 })
  const row = byTag(walk(tree), "tr")[0]
  assert.equal(row.props["aria-hidden"], undefined)
  assert.equal(row.props.role, undefined)
})

// --- the pair -------------------------------------------------------------------------------------

const expanderProps = (overrides = {}) => ({
  label: "order 1001",
  expanded: false,
  onExpandedChange: () => {},
  detail: { type: "pre", props: { children: "trace" } },
  children: [
    { type: "td", props: { children: "#1001" }, key: "a" },
    { type: "td", props: { children: "Ada" }, key: "b" },
  ],
  ...overrides,
})

test("each row is its own tbody, so striping and row counting stay per logical row", () => {
  // Measured in Chrome: with both rows in one shared tbody, `tbody tr:nth-child(even)` stripes the
  // detail rows and leaves every data row plain. Grouped, `tbody:nth-of-type(even) tr` is correct.
  const { tree } = render(TableRowExpander, expanderProps())
  assert.equal(tree.type, "tbody")
})

test("nothing is rendered under the row while it is closed", () => {
  // A row that is present but empty is not cheaper than one that is absent, and it leaves a
  // hairline under every row in the table — a <tr> cannot be collapsed to nothing.
  const { tree } = render(TableRowExpander, expanderProps())
  assert.equal(byTag(walk(tree), "tr").length, 1)
  assert.equal(byTag(walk(tree), "td").filter((td) => td.props.colSpan).length, 0)
})

test("opening adds exactly one detail row, after the data row", () => {
  const { tree } = render(TableRowExpander, expanderProps({ expanded: true }))
  const rows = byTag(walk(tree), "tr")
  assert.equal(rows.length, 2)
  const detailCells = byTag(walk(tree), "td").filter((td) => td.props.colSpan)
  assert.equal(detailCells.length, 1)
})

test("the trigger's aria-controls matches the id of the detail cell that appears", () => {
  const { tree } = render(TableRowExpander, expanderProps({ expanded: true }))
  const nodes = walk(tree)
  const controls = byTag(nodes, "button")[0].props["aria-controls"]
  const detailCell = byTag(nodes, "td").find((td) => td.props.colSpan)
  assert.ok(controls, "aria-controls must be set while the row is open")
  assert.equal(detailCell.props.id, controls)
})

test("the chevron's cell is added to the row, before the caller's own cells", () => {
  const { tree } = render(TableRowExpander, expanderProps())
  const dataRow = byTag(walk(tree), "tr")[0]
  const cells = walk(dataRow.props.children).filter((n) => n.type === "td")
  assert.equal(cells.length, 3)
  assert.ok(walk(cells[0]).some((n) => n.type === "button"))
})

test("trigger: 'end' puts the chevron after the caller's cells instead", () => {
  const { tree } = render(TableRowExpander, expanderProps({ trigger: "end" }))
  const dataRow = byTag(walk(tree), "tr")[0]
  const cells = walk(dataRow.props.children).filter((n) => n.type === "td")
  assert.equal(cells.length, 3)
  assert.ok(walk(cells[2]).some((n) => n.type === "button"))
})

test("trigger: 'none' adds no cell, leaving the row's column count alone", () => {
  // For a caller placing the trigger inside one of their own cells. Adding a cell here anyway is
  // what makes the body one column wider than the header.
  const { tree } = render(TableRowExpander, expanderProps({ trigger: "none" }))
  const nodes = walk(tree)
  assert.equal(byTag(nodes, "button").length, 0)
  const dataRow = byTag(nodes, "tr")[0]
  assert.equal(walk(dataRow.props.children).filter((n) => n.type === "td").length, 2)
})

test("an explicit colSpan wins over anything measured", () => {
  // Both values have to exist for this to mean anything: with nothing measured yet, `colSpan ??
  // columnCount` and `columnCount ?? colSpan` agree. So press first to put a measured 3 in hand,
  // then assert the caller's 7 is still what ships.
  const instance = render(TableRowExpander, expanderProps({ colSpan: 7 }))
  instance.nodes[0].closest = () => ({
    rows: [{ cells: [1, 1, 1].map(() => ({ colSpan: 1, hasAttribute: () => false })) }],
  })
  byTag(walk(instance.tree), "button")[0].props.onClick({})
  const opened = instance.update(expanderProps({ expanded: true, colSpan: 7 }))
  const detailCell = byTag(walk(opened), "td").find((td) => td.props.colSpan)
  assert.equal(detailCell.props.colSpan, 7)
})

test("a row opened on the first paint, before any press, gets the safe over-claim", () => {
  // Nothing has been measured yet because nothing has been pressed, and this is the case the
  // over-claim exists for: a row expanded by defaultExpandedIds or by the server.
  const { tree } = render(TableRowExpander, expanderProps({ expanded: true }))
  const detailCell = byTag(walk(tree), "td").find((td) => td.props.colSpan)
  assert.equal(detailCell.props.colSpan, DETAIL_COLSPAN_WHEN_UNKNOWN)
})

test("pressing the chevron measures the real table before the detail row renders", () => {
  // The ordering is the point. Measuring in an effect instead would paint the detail row at the
  // fallback first and correct it a frame later, which is the frame the columns jump in. The
  // harness gives the tbody ref a stand-in whose closest() answers a table of three columns.
  const calls = []
  const instance = render(TableRowExpander, expanderProps({ onExpandedChange: (n) => calls.push(n) }))
  const tbodyRef = instance.nodes[0]
  assert.ok(tbodyRef, "the tbody must be ref'd, or there is nothing to measure from")
  tbodyRef.closest = (selector) =>
    selector === "table"
      ? {
          rows: [
            { cells: [{ colSpan: 1, hasAttribute: () => false }, { colSpan: 1, hasAttribute: () => false }, { colSpan: 1, hasAttribute: () => false }] },
          ],
        }
      : null

  const button = byTag(walk(instance.tree), "button")[0]
  button.props.onClick({})
  assert.deepEqual(calls, [true], "the press must still reach the caller")

  // Now that it has been measured, the open row uses the measured count rather than the fallback.
  const opened = instance.update(expanderProps({ expanded: true, onExpandedChange: () => {} }))
  const detailCell = byTag(walk(opened), "td").find((td) => td.props.colSpan)
  assert.equal(detailCell.props.colSpan, 3)
})

test("a table that cannot be found leaves the over-claim in place rather than writing a 1", () => {
  const instance = render(TableRowExpander, expanderProps())
  const tbodyRef = instance.nodes[0]
  tbodyRef.closest = () => null
  byTag(walk(instance.tree), "button")[0].props.onClick({})
  const opened = instance.update(expanderProps({ expanded: true }))
  const detailCell = byTag(walk(opened), "td").find((td) => td.props.colSpan)
  assert.equal(detailCell.props.colSpan, DETAIL_COLSPAN_WHEN_UNKNOWN)
})

test("the data row says whether it is open, for styling that is not the chevron's", () => {
  const closed = render(TableRowExpander, expanderProps())
  assert.equal(byTag(walk(closed.tree), "tr")[0].props["data-state"], "closed")
  const open = render(TableRowExpander, expanderProps({ expanded: true }))
  assert.equal(byTag(walk(open.tree), "tr")[0].props["data-state"], "open")
})

test("disabled reaches the trigger, so a row whose detail is still loading cannot be opened", () => {
  const { tree } = render(TableRowExpander, expanderProps({ disabled: true }))
  assert.equal(byTag(walk(tree), "button")[0].props.disabled, true)
})

test("the row's label reaches the trigger's accessible name", () => {
  const { tree } = render(TableRowExpander, expanderProps({ label: "order 1001" }))
  assert.match(byTag(walk(tree), "button")[0].props["aria-label"], /order 1001/)
})
