// The sortable column heading everyone writes first flips between ascending and descending, puts
// `aria-sort` on the thing it made clickable, and implements descending as ascending reversed. Each
// of those looks finished on screen. The cases below are written to fail against them:
//
//   - a two-state cycle, which can never give back the order the table arrived in,
//   - `aria-sort` on the button (where it is not a supported attribute and is silently dropped) or
//     left behind on the column that was sorted a moment ago, so two columns claim the table at once,
//   - descending as `.reverse()`, which floats every empty cell to the top and scrambles the rows
//     that tied on the way up,
//   - sorting the array that is already on screen, so the result depends on the order of presses,
//   - and `sort()` on the caller's own array, which mutates a prop and renders nothing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  nextSortState,
  ariaSortFor,
  isBlankValue,
  compareValues,
  sortRows,
  sortCollator,
  SortHeader,
} = loadComponent(join(ROOT, "registry", "ui", "sort-header.tsx"), {
  stubs: {
    "lucide-react": {
      ChevronUp: function ChevronUp(props) {
        return { type: "svg", props: { "data-icon": "up", ...props } }
      },
      ChevronDown: function ChevronDown(props) {
        return { type: "svg", props: { "data-icon": "down", ...props } }
      },
      ChevronsUpDown: function ChevronsUpDown(props) {
        return { type: "svg", props: { "data-icon": "updown", ...props } }
      },
    },
  },
})

// --- the cycle ------------------------------------------------------------------------------------

test("an untouched column starts ascending", () => {
  assert.deepEqual(nextSortState(null, "name"), { column: "name", direction: "ascending" })
})

test("a third press clears the sort rather than flipping back", () => {
  const first = nextSortState(null, "name")
  const second = nextSortState(first, "name")
  assert.deepEqual(second, { column: "name", direction: "descending" })
  // The whole point: the order the table arrived in is reachable again.
  assert.equal(nextSortState(second, "name"), null)
})

test("firstDirection inverts the cycle, and clearing still comes third", () => {
  const options = { firstDirection: "descending" }
  const first = nextSortState(null, "created", options)
  assert.deepEqual(first, { column: "created", direction: "descending" })
  const second = nextSortState(first, "created", options)
  assert.deepEqual(second, { column: "created", direction: "ascending" })
  assert.equal(nextSortState(second, "created", options), null)
})

test("clearable: false cycles between the two directions forever", () => {
  const options = { clearable: false }
  const first = nextSortState(null, "rank", options)
  const second = nextSortState(first, "rank", options)
  assert.deepEqual(second, { column: "rank", direction: "descending" })
  assert.deepEqual(nextSortState(second, "rank", options), {
    column: "rank",
    direction: "ascending",
  })
})

test("pressing a different column starts that column's own cycle, not the last one's direction", () => {
  const descendingOnName = { column: "name", direction: "descending" }
  assert.deepEqual(nextSortState(descendingOnName, "email"), {
    column: "email",
    direction: "ascending",
  })
})

// --- aria-sort ------------------------------------------------------------------------------------

test("exactly one column carries a direction and the rest say none", () => {
  const state = { column: "email", direction: "descending" }
  assert.equal(ariaSortFor(state, "email"), "descending")
  assert.equal(ariaSortFor(state, "name"), "none")
  assert.equal(ariaSortFor(state, "created"), "none")
})

test("with nothing sorted every sortable column says none, not nothing", () => {
  assert.equal(ariaSortFor(null, "name"), "none")
})

// --- blanks ---------------------------------------------------------------------------------------

test("the five shapes of an empty cell are blank; zero and false are values", () => {
  for (const blank of [null, undefined, "", NaN, new Date("nope")]) {
    assert.equal(isBlankValue(blank), true, `${String(blank)} should be blank`)
  }
  for (const value of [0, false, " ", new Date(0)]) {
    assert.equal(isBlankValue(value), false, `${String(value)} should be a value`)
  }
})

test("blanks sort last ascending AND last descending", () => {
  const rows = [{ v: "b" }, { v: null }, { v: "a" }, { v: "" }, { v: "c" }]
  const get = (row) => row.v

  const up = sortRows(rows, { column: "v", direction: "ascending" }, get)
  assert.deepEqual(up.slice(0, 3).map(get), ["a", "b", "c"])
  assert.deepEqual(up.slice(3).map(get), [null, ""])

  // Reversing the ascending result would put the two blanks at the top, which is the bug.
  const down = sortRows(rows, { column: "v", direction: "descending" }, get)
  assert.deepEqual(down.slice(0, 3).map(get), ["c", "b", "a"])
  assert.equal(isBlankValue(get(down[3])), true)
  assert.equal(isBlankValue(get(down[4])), true)
})

// --- descending is not reversed -------------------------------------------------------------------

test("rows that tie keep their original order in both directions", () => {
  const rows = [
    { id: 1, status: "Pending" },
    { id: 2, status: "Done" },
    { id: 3, status: "Pending" },
    { id: 4, status: "Pending" },
  ]
  const get = (row) => row.status

  const up = sortRows(rows, { column: "status", direction: "ascending" }, get)
  assert.deepEqual(up.map((r) => r.id), [2, 1, 3, 4])

  // `.reverse()` of that would give [4, 3, 1, 2] — the three Pending rows shuffled.
  const down = sortRows(rows, { column: "status", direction: "descending" }, get)
  assert.deepEqual(down.map((r) => r.id), [1, 3, 4, 2])
})

// --- comparison rules -----------------------------------------------------------------------------

test("numbers inside strings compare as numbers", () => {
  assert.ok(compareValues("Item 2", "Item 10") < 0)
  assert.ok(compareValues("v1.9.0", "v1.10.0") < 0)
})

test("case and accents do not split a column into runs", () => {
  const rows = ["Zulu", "ångström", "Alpha", "Öberg"].map((v) => ({ v }))
  const sorted = sortRows(rows, { column: "v", direction: "ascending" }, (r) => r.v).map((r) => r.v)
  // A plain sort() gives ["Alpha","Zulu","ångström","Öberg"] — the accented names below Z.
  assert.deepEqual(sorted, ["Alpha", "ångström", "Öberg", "Zulu"])
})

test("dates compare as instants, not as their string form", () => {
  const rows = [
    { at: new Date("2026-02-01") },
    { at: new Date("2026-01-15") },
    { at: new Date("2026-01-02") },
  ]
  const sorted = sortRows(rows, { column: "at", direction: "ascending" }, (r) => r.at)
  assert.deepEqual(
    sorted.map((r) => r.at.toISOString().slice(0, 10)),
    ["2026-01-02", "2026-01-15", "2026-02-01"]
  )
})

test("booleans sort false before true, and zero is not mistaken for empty", () => {
  const rows = [{ v: true }, { v: false }, { v: true }]
  assert.deepEqual(
    sortRows(rows, { column: "v", direction: "ascending" }, (r) => r.v).map((r) => r.v),
    [false, true, true]
  )
  const numbers = [{ n: 3 }, { n: 0 }, { n: -2 }]
  assert.deepEqual(
    sortRows(numbers, { column: "n", direction: "ascending" }, (r) => r.n).map((r) => r.n),
    [-2, 0, 3]
  )
})

test("a locale's own collator is used when one is asked for", () => {
  const collator = sortCollator("sv")
  // Swedish puts ö at the end of the alphabet rather than beside o.
  assert.ok(collator.compare("ö", "z") > 0)
  assert.ok(sortCollator("de").compare("ö", "z") < 0)
})

// --- the caller's array ---------------------------------------------------------------------------

test("sorting does not mutate the rows it was given", () => {
  const rows = Object.freeze([{ v: "b" }, { v: "a" }])
  const before = rows.map((r) => r.v)
  const out = sortRows(rows, { column: "v", direction: "ascending" }, (r) => r.v)
  assert.deepEqual(rows.map((r) => r.v), before)
  assert.notEqual(out, rows)
  assert.deepEqual(out.map((r) => r.v), ["a", "b"])
})

test("no sort still hands back a copy in the original order", () => {
  const rows = [{ v: "b" }, { v: "a" }]
  const out = sortRows(rows, null, (r) => r.v)
  assert.deepEqual(out.map((r) => r.v), ["b", "a"])
  assert.notEqual(out, rows)
})

test("re-sorting the source is independent of which columns were pressed before", () => {
  const rows = [
    { id: 1, name: "Ada", team: "B" },
    { id: 2, name: "Ada", team: "A" },
    { id: 3, name: "Bo", team: "A" },
  ]
  const get = (row, column) => row[column]
  const byNameAlone = sortRows(rows, { column: "name", direction: "ascending" }, get)
  const viaTeam = sortRows(
    sortRows(rows, { column: "team", direction: "ascending" }, get),
    { column: "name", direction: "ascending" },
    get
  )
  // Sorting the array already on screen would give [2, 1, 3] here: the previous sort survives
  // inside the tie. Sorting the source each time is what makes these the same table.
  assert.deepEqual(byNameAlone.map((r) => r.id), [1, 2, 3])
  assert.notDeepEqual(viaTeam.map((r) => r.id), byNameAlone.map((r) => r.id))
})

// --- the rendered heading -------------------------------------------------------------------------

const renderHeader = (props) =>
  render(SortHeader, { column: "name", sort: null, onSortChange: () => {}, children: "Name", ...props })

const headerCell = (instance) => byTag(walk(instance.tree), "th")[0]
const headerButton = (instance) => byTag(walk(instance.tree), "button")[0]

test("aria-sort is on the cell, never on the button", () => {
  const instance = renderHeader({ sort: { column: "name", direction: "ascending" } })
  assert.equal(headerCell(instance).props["aria-sort"], "ascending")
  assert.equal(headerCell(instance).props.scope, "col")
  // `aria-sort` is defined for columnheader; on a button it is dropped without complaint.
  assert.equal("aria-sort" in headerButton(instance).props, false)
  instance.unmount()
})

test("an unsorted column still says none on the cell", () => {
  const instance = renderHeader({ sort: { column: "email", direction: "ascending" } })
  assert.equal(headerCell(instance).props["aria-sort"], "none")
  instance.unmount()
})

test("the heading is a real button, so the keyboard reaches it", () => {
  const instance = renderHeader({})
  const button = headerButton(instance)
  assert.equal(button.type, "button")
  assert.equal(button.props.type, "button")
  assert.equal(typeof button.props.onClick, "function")
  instance.unmount()
})

test("the button fills the cell, and the cell gives up its padding to it", () => {
  const instance = renderHeader({})
  assert.match(headerCell(instance).props.className, /(^|\s)p-0(\s|$)/)
  assert.match(headerButton(instance).props.className, /w-full/)
  assert.match(headerButton(instance).props.className, /px-4/)
  instance.unmount()
})

test("pressing walks the cycle through the caller's state", () => {
  const seen = []
  const instance = renderHeader({ onSortChange: (next) => seen.push(next) })
  headerButton(instance).props.onClick()
  assert.deepEqual(seen.at(-1), { column: "name", direction: "ascending" })

  instance.update({
    column: "name",
    sort: { column: "name", direction: "descending" },
    onSortChange: (next) => seen.push(next),
    children: "Name",
  })
  headerButton(instance).props.onClick()
  assert.equal(seen.at(-1), null)
  instance.unmount()
})

test("the arrow shows all three states and is hidden from assistive tech", () => {
  const icon = (instance) => walk(instance.tree).find((n) => n.props?.["data-icon"])

  const unsorted = renderHeader({})
  assert.equal(icon(unsorted).props["data-icon"], "updown")
  assert.equal(icon(unsorted).props["aria-hidden"], "true")
  unsorted.unmount()

  const up = renderHeader({ sort: { column: "name", direction: "ascending" } })
  assert.equal(icon(up).props["data-icon"], "up")
  up.unmount()

  const down = renderHeader({ sort: { column: "name", direction: "descending" } })
  assert.equal(icon(down).props["data-icon"], "down")
  down.unmount()
})

test("the sortable hint is visible at rest, not only under a pointer", () => {
  const instance = renderHeader({})
  const icon = walk(instance.tree).find((n) => n.props?.["data-icon"])
  // opacity-0 here would mean a phone shows nothing at all to say the column can be sorted.
  assert.doesNotMatch(icon.props.className, /(^|\s)opacity-0(\s|$)/)
  assert.match(icon.props.className, /opacity-40/)
  instance.unmount()
})

test("a disabled heading keeps its tab stop and ignores presses", () => {
  let calls = 0
  const instance = renderHeader({ disabled: true, onSortChange: () => calls++ })
  const button = headerButton(instance)
  // Not the `disabled` attribute: that drops the heading out of the tab order, so a keyboard user
  // holding it loses their place the moment the table starts loading.
  assert.equal(button.props.disabled, undefined)
  assert.equal(button.props["aria-disabled"], true)
  button.props.onClick()
  assert.equal(calls, 0)
  instance.unmount()
})

test("a right-aligned heading puts the arrow on the label's left", () => {
  const instance = renderHeader({ align: "end" })
  const button = headerButton(instance)
  assert.match(button.props.className, /justify-end/)
  const order = walk(instance.tree)
    .filter((n) => n.props?.["data-icon"] || n.props?.children === "Name")
    .map((n) => n.props["data-icon"] ?? "label")
  assert.deepEqual(order, ["updown", "label"])
  instance.unmount()
})

// --- announcing -----------------------------------------------------------------------------------

const liveRegion = (instance) =>
  walk(instance.tree).find((n) => n.props?.["aria-live"] === "polite")

test("the live region starts empty, so it is not part of the cell's own content", () => {
  const instance = renderHeader({ sort: { column: "name", direction: "ascending" } })
  assert.equal(liveRegion(instance).props.children, "")
  instance.unmount()
})

test("pressing announces the new order", () => {
  const instance = renderHeader({})
  headerButton(instance).props.onClick()
  instance.update({
    column: "name",
    sort: { column: "name", direction: "ascending" },
    onSortChange: () => {},
    children: "Name",
  })
  assert.equal(liveRegion(instance).props.children, "Table sorted by Name, ascending.")
  instance.unmount()
})

test("clearing says the table is back to its own order", () => {
  const instance = renderHeader({ sort: { column: "name", direction: "descending" } })
  headerButton(instance).props.onClick()
  instance.update({ column: "name", sort: null, onSortChange: () => {}, children: "Name" })
  assert.match(liveRegion(instance).props.children, /cleared/)
  instance.unmount()
})

test("a header that was not pressed stays silent when another column takes the sort", () => {
  // Name is sorted; the person presses Status, and Name goes from ascending to none. Announcing
  // that from Name would have two headings speaking about one press.
  const instance = renderHeader({ sort: { column: "name", direction: "ascending" } })
  instance.update({
    column: "name",
    sort: { column: "status", direction: "ascending" },
    onSortChange: () => {},
    children: "Name",
  })
  assert.equal(liveRegion(instance).props.children, "")
  instance.unmount()
})

test("a press the table declines to apply announces nothing", () => {
  // Controlled, and the parent ignored it — so nothing was sorted and nothing should be claimed.
  const instance = renderHeader({ onSortChange: () => {} })
  headerButton(instance).props.onClick()
  instance.rerender()
  assert.equal(liveRegion(instance).props.children, "")
  instance.unmount()
})

test("announce: false leaves the announcing to the caller", () => {
  const instance = renderHeader({ announce: false })
  headerButton(instance).props.onClick()
  instance.update({
    column: "name",
    sort: { column: "name", direction: "ascending" },
    onSortChange: () => {},
    children: "Name",
    announce: false,
  })
  assert.equal(liveRegion(instance).props.children, "")
  instance.unmount()
})

test("labels are overridable, so the announcement translates", () => {
  const labels = { announce: (column, direction) => `${column}: ${direction ?? "解除"}` }
  const instance = renderHeader({ labels })
  headerButton(instance).props.onClick()
  instance.update({
    column: "name",
    sort: { column: "name", direction: "ascending" },
    onSortChange: () => {},
    children: "Name",
    labels,
  })
  assert.equal(liveRegion(instance).props.children, "Name: ascending")
  instance.unmount()
})

test("a heading whose label is not plain text announces the name it was given", () => {
  const instance = render(SortHeader, {
    column: "size",
    sort: null,
    onSortChange: () => {},
    label: "File size",
    children: { type: "span", props: { children: "Size" } },
  })
  headerButton(instance).props.onClick()
  instance.update({
    column: "size",
    sort: { column: "size", direction: "ascending" },
    onSortChange: () => {},
    label: "File size",
    children: { type: "span", props: { children: "Size" } },
  })
  assert.match(liveRegion(instance).props.children, /File size/)
  instance.unmount()
})
