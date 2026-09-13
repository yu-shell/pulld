// json-viewer is a real ARIA tree, which means it is one Tab stop with a roving tabindex inside it
// rather than one stop per row. That makes the position of the single `tabIndex={0}` row the thing
// worth asserting: it is where the keyboard currently stands, and in a browser it is where focus is.
//
// The failure it guards against is invisible to someone reading the source. A container bigger than
// `maxItemsPerNode` draws a "… N more" row, and asking that row for its last page unmounts it. The
// row the reader was standing on stops existing, the roving stop falls back to the first row, and a
// browser puts focus on <body> — a hundred rows above where they were, outside the tree entirely.
//
// These run against the real source through the harness, so they fail when the component changes
// rather than when a copy of it does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })
const { JsonViewer } = loadComponent(join(ROOT, "registry", "ui", "json-viewer.tsx"), {
  stubs: { "lucide-react": icons },
})

const show = (props) => {
  const instance = render(JsonViewer, props)
  const rows = () => byRole(walk(instance.tree), "treeitem")
  return {
    rows,
    /** The one row carrying the tab stop — where the keyboard stands. */
    stop: () => rows().findIndex((r) => r.props.tabIndex === 0),
    /** Click, or Enter/Space: the same path through `activate`. */
    activate(index) {
      rows()[index].props.onClick()
      instance.rerender()
    },
  }
}

test("exactly one row holds the tab stop, whatever has been opened", () => {
  const view = show({ data: { a: { b: { c: 1 } }, d: [1, 2] }, defaultExpandedDepth: Infinity })
  const stops = view.rows().filter((r) => r.props.tabIndex === 0)
  assert.equal(stops.length, 1, "a roving tabindex with two stops is two Tab presses inside one widget")
  assert.equal(view.stop(), 0, "before anything is focused the stop sits on the first row")
})

test("asking for the last page keeps the keyboard where the reader was", () => {
  // 150 entries at 100 per page: one "… 50 more" row, and one press clears it.
  const view = show({
    data: { items: Array.from({ length: 150 }, (_, i) => i) },
    maxItemsPerNode: 100,
    defaultExpandedDepth: 2,
  })

  const before = view.rows()
  assert.equal(before.length, 103, "root + items + 100 entries + the more row")
  const moreIndex = before.length - 1

  view.activate(moreIndex)

  const rows = view.rows()
  assert.equal(rows.length, 152, "the remaining 50 are drawn and the more row is gone")
  assert.equal(
    view.stop(),
    moreIndex,
    "the stop lands on the row that took the more row's place, not back on the root row"
  )
  assert.equal(
    rows[view.stop()].props["aria-posinset"],
    101,
    "and that row is the 101st entry — the first one the press revealed"
  )
})

test("a container with pages left moves the stop to the entries just revealed", () => {
  // 150 entries at 50 per page, so a more row survives the press. The reader is still moved onto
  // the new entries rather than left on the footer: the same rule, and the same arithmetic.
  const view = show({
    data: { items: Array.from({ length: 150 }, (_, i) => i) },
    maxItemsPerNode: 50,
    defaultExpandedDepth: 2,
  })

  const moreIndex = view.rows().length - 1
  view.activate(moreIndex)

  const rows = view.rows()
  assert.equal(rows.length, 103, "50 more entries, and a more row still holding the last 50")
  assert.equal(view.stop(), moreIndex)
  assert.equal(rows[view.stop()].props["aria-posinset"], 51, "the 51st entry, first of the new page")
  assert.equal(
    rows.at(-1).props["aria-posinset"],
    rows.at(-1).props["aria-setsize"],
    "the more row is still there, still last of its set"
  )
})

test("the more row is counted as one of its parent's children", () => {
  // The index arithmetic above only holds because the revealed entries take the position the more
  // row held, which is the same thing as it being the last child rather than a footer outside the set.
  const view = show({
    data: { items: Array.from({ length: 10 }, (_, i) => i) },
    maxItemsPerNode: 4,
    defaultExpandedDepth: 2,
  })
  const rows = view.rows()
  const more = rows[rows.length - 1]
  assert.equal(more.props["aria-level"], 3, "it sits at the depth of the entries it stands in for")
  assert.equal(more.props["aria-posinset"], 5, "four drawn entries, then this")
  assert.equal(more.props["aria-setsize"], 5)
  assert.equal(
    rows[rows.length - 2].props["aria-setsize"],
    5,
    "its siblings count it too, or a screen reader reads '4 of 5' for the last drawn entry"
  )
})

test("a value pointing back at an ancestor stops instead of unfolding forever", () => {
  const loop = { name: "root" }
  loop.self = loop
  // Infinity means "open everything", which is the depth at which a cycle would hang the render.
  const view = show({ data: loop, defaultExpandedDepth: Infinity })
  assert.equal(view.rows().length, 3, "the root, its name, and the self-reference drawn as a leaf")
})
