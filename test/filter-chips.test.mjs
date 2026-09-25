// filter-chips shows the conditions a list is currently filtered by, and the way it goes wrong is
// that it looks right. The cases below are written to fail against the versions that do:
//
//   - chips kept in their own array. Every hand-rolled row does this, and it works until anything
//     else touches the query — a Back button, a shared link, a saved view, a reset elsewhere on the
//     page — after which the pills describe a filter that is no longer applied, or stay silent about
//     one that is. Here the chips are derived on every render, and the test for it is that a query
//     arriving from outside rewrites the row.
//   - removing a filter by rebuilding the query from the fields, which quietly drops the sort order
//     and everything else the component was never told about.
//   - removing one value of a multi-valued parameter by deleting the parameter, so narrowing
//     "status in (open, pending)" to just pending turns the filter off altogether.
//   - keeping the page number across a filter change, which is how removing a chip lands on an empty
//     page 7 with three chips still showing.
//   - an unlabelled ×, which is read out as "button" and nothing else.
//   - a live region that is mounted along with its message, i.e. one nobody was listening to — which
//     matters most for the message that arrives as the last chip goes away.
//   - and focus left on a button that has just been removed from the document, which drops to <body>
//     and makes the keyboard start again from the top of the page.
//
// What the harness can see of focus is the call, not the caret: "the row asked this node to take
// focus" is asserted here, and whether the browser honoured it belongs to a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  FilterChips,
  appliedFilters,
  removeFilter,
  clearFilters,
  toSearchParams,
  DEFAULT_RESET_KEYS,
} = loadComponent(join(ROOT, "registry", "ui", "filter-chips.tsx"), {
  stubs: {
    "lucide-react": {
      X: function X(props) {
        return { type: "svg", props: { "data-icon": "x", ...props } }
      },
    },
  },
})

const STATUS = { open: "Open", pending: "Pending", closed: "Closed" }

const FIELDS = [
  {
    key: "status",
    label: "Status",
    // "all" is what a reset select writes: a filter that filters nothing.
    format: (value) => (value === "all" ? null : (STATUS[value] ?? value)),
  },
  { key: "owner", label: "Owner" },
  { key: "period", label: "Period", chip: "key" },
  { key: "tags", label: "Tags", delimiter: "," },
]

/** Everything a test needs to reach in the rendered row. */
function row(instance) {
  const nodes = walk(instance.tree)
  const buttons = byTag(nodes, "button")
  return {
    nodes,
    list: nodes.find((node) => node.props?.role === "list"),
    chips: byTag(nodes, "li"),
    removes: buttons.filter((button) =>
      String(button.props["aria-label"] ?? "").startsWith("Remove")
    ),
    clear: buttons.find((button) => button.props.children === "Clear all"),
    undo: buttons.find((button) => button.props.children === "Undo"),
    live: nodes.find((node) => node.props?.role === "status"),
  }
}

/** The text a person would read out of a node, spaces and all. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object") return textOf(node.props?.children)
  return ""
}

const chipTexts = (instance) => row(instance).chips.map((chip) => textOf(chip).trim())
const focusCalls = (ref) => (ref?.current?.calls ?? []).filter((call) => call.name === "focus")

// --- the chips are the state, not a copy of it ----------------------------------------------------

test("chips are derived from the query, in the order the fields are declared", () => {
  // The query says owner first; the row must not, or the pills reshuffle whenever a router rebuilds
  // the URL and read as a different set of filters.
  const chips = appliedFilters("owner=amy&status=open", FIELDS)
  assert.deepEqual(
    chips.map((chip) => [chip.key, chip.text]),
    [
      ["status", "Open"],
      ["owner", "amy"],
    ]
  )
})

test("a repeated parameter is one chip per value, each removable on its own", () => {
  const chips = appliedFilters("status=open&status=pending", FIELDS)
  assert.deepEqual(
    chips.map((chip) => chip.text),
    ["Open", "Pending"]
  )
  assert.deepEqual(
    chips.map((chip) => chip.whole),
    [false, false]
  )
})

test("a chip:\"key\" field is one chip for the whole parameter", () => {
  const chips = appliedFilters("period=2026-09-01..2026-09-30", FIELDS)
  assert.equal(chips.length, 1)
  assert.equal(chips[0].text, "2026-09-01..2026-09-30")
  assert.equal(chips[0].whole, true)
})

test("a chip:\"key\" chip reports every value of its parameter, hidden ones included", () => {
  // The text shows what a person can read; `values` is what the parameter actually holds, which is
  // what a caller building its own query out of a chip has to go by.
  const keyed = [{ ...FIELDS[0], chip: "key" }]
  const chips = appliedFilters("status=all&status=open", keyed)
  assert.equal(chips[0].text, "Open")
  assert.deepEqual([...chips[0].values], ["all", "open"])
})

test("a delimited parameter is split and trimmed", () => {
  const chips = appliedFilters("tags=urgent,%20billing", FIELDS)
  assert.deepEqual(
    chips.map((chip) => chip.text),
    ["urgent", "billing"]
  )
})

test("an empty value and a repeated value are not two filters", () => {
  assert.deepEqual(appliedFilters("status=", FIELDS), [])
  const chips = appliedFilters("status=open&status=open", FIELDS)
  assert.deepEqual(
    chips.map((chip) => chip.text),
    ["Open"]
  )
})

test("an empty value is not a filter, whatever a format would call it", () => {
  // Decided before formatting, on purpose: "?status=" is a select that has been reset, and a field
  // whose format has a word for the empty case would otherwise put a chip on the absence of a filter.
  const fields = [{ key: "status", label: "Status", format: (value) => (value === "" ? "Any" : value) }]
  assert.deepEqual(appliedFilters("status=", fields), [])
  assert.deepEqual(appliedFilters("owner=", FIELDS), [])
})

test("format returning null hides a value that filters nothing", () => {
  assert.deepEqual(appliedFilters("status=all", FIELDS), [])
  const chips = appliedFilters("status=all&status=open", FIELDS)
  assert.deepEqual(
    chips.map((chip) => chip.text),
    ["Open"]
  )
})

test("a parameter that is not a declared field gets no chip", () => {
  assert.deepEqual(appliedFilters("sort=name&page=7", FIELDS), [])
})

test("all three query shapes are read the same way", () => {
  const expected = [
    ["status", "Open"],
    ["owner", "amy"],
  ]
  const read = (query) => appliedFilters(query, FIELDS).map((chip) => [chip.key, chip.text])
  assert.deepEqual(read("status=open&owner=amy"), expected)
  assert.deepEqual(read(new URLSearchParams("status=open&owner=amy")), expected)
  assert.deepEqual(read({ status: "open", owner: "amy" }), expected)
  // A record with several values is a repeated parameter, not one comma-joined value — which is what
  // handing the array straight to URLSearchParams would have produced.
  assert.deepEqual(
    appliedFilters({ status: ["open", "pending"] }, FIELDS).map((chip) => chip.text),
    ["Open", "Pending"]
  )
})

test("the caller's URLSearchParams is never mutated", () => {
  const params = new URLSearchParams("status=open&status=pending")
  const chips = appliedFilters(params, FIELDS)
  removeFilter(params, FIELDS, chips[0])
  clearFilters(params, FIELDS)
  assert.equal(params.toString(), "status=open&status=pending")
})

// --- removing one filter --------------------------------------------------------------------------

test("removing one value of a multi-valued filter narrows it instead of turning it off", () => {
  const chips = appliedFilters("status=open&status=pending", FIELDS)
  assert.equal(removeFilter("status=open&status=pending", FIELDS, chips[0]), "status=pending")
})

test("removing a value keeps everything the row was never told about", () => {
  const query = "status=open&sort=name&view=grid"
  const chips = appliedFilters(query, FIELDS)
  assert.equal(removeFilter(query, FIELDS, chips[0]), "sort=name&view=grid")
})

test("removing a chip:\"key\" chip takes the whole parameter, hidden values included", () => {
  const query = "status=all&status=open&sort=name"
  const keyed = [{ ...FIELDS[0], chip: "key" }, ...FIELDS.slice(1)]
  const chips = appliedFilters(query, keyed)
  assert.equal(chips.length, 1)
  // "all" has no chip of its own, so if the × left it behind the list would stay filtered by a
  // condition nothing on screen mentions.
  assert.equal(removeFilter(query, keyed, chips[0]), "sort=name")
})

test("removing a value from a delimited parameter re-joins the rest", () => {
  const query = "tags=urgent,billing,eu"
  const chips = appliedFilters(query, FIELDS)
  assert.equal(removeFilter(query, FIELDS, chips[1]), "tags=urgent%2Ceu")
  assert.equal(toSearchParams(removeFilter(query, FIELDS, chips[1])).get("tags"), "urgent,eu")
})

test("removing a repeated value removes every copy of it", () => {
  const query = "status=open&status=open&status=pending"
  const chips = appliedFilters(query, FIELDS)
  assert.equal(removeFilter(query, FIELDS, chips[0]), "status=pending")
})

test("a filter change drops the page number, because a cursor into other results means nothing", () => {
  assert.deepEqual([...DEFAULT_RESET_KEYS], ["page"])
  const query = "status=open&owner=amy&page=7&sort=name"
  const chips = appliedFilters(query, FIELDS)
  assert.equal(removeFilter(query, FIELDS, chips[0]), "owner=amy&sort=name")
  assert.equal(clearFilters(query, FIELDS), "sort=name")
})

test("a reset key that is also a declared field is kept, not reset", () => {
  const fields = [...FIELDS, { key: "page", label: "Page" }]
  const query = "status=open&page=7"
  const chips = appliedFilters(query, fields)
  assert.equal(removeFilter(query, fields, chips[0]), "page=7")
})

test("extra reset keys are dropped alongside the default", () => {
  const query = "status=open&cursor=abc&page=2&sort=name"
  const chips = appliedFilters(query, FIELDS)
  assert.equal(
    removeFilter(query, FIELDS, chips[0], { resetKeys: [...DEFAULT_RESET_KEYS, "cursor"] }),
    "sort=name"
  )
})

// --- clearing -------------------------------------------------------------------------------------

test("clear all takes only the declared filters", () => {
  const query = "status=open&owner=amy&tags=eu&sort=name&view=grid&page=3"
  assert.equal(clearFilters(query, FIELDS), "sort=name&view=grid")
})

// --- the rendered row -----------------------------------------------------------------------------

test("every chip names its condition and its remove button names what removing it does", () => {
  const instance = render(FilterChips, {
    fields: FIELDS,
    value: "status=open&owner=amy",
    onValueChange: () => {},
  })
  const ui = row(instance)
  assert.equal(ui.list.props["aria-label"], "Applied filters")
  // Written out because Tailwind's preflight strips the list style, and Safari then drops the role.
  assert.equal(ui.list.props.role, "list")
  assert.deepEqual(chipTexts(instance), ["Status: Open", "Owner: amy"])
  assert.deepEqual(
    ui.removes.map((button) => button.props["aria-label"]),
    ["Remove Status filter: Open", "Remove Owner filter: amy"]
  )
  // The icon is decoration; the accessible name is on the button.
  const icons = ui.nodes.filter((node) => node.props?.["data-icon"] === "x")
  assert.equal(icons.length, 2)
  for (const icon of icons) assert.equal(icon.props["aria-hidden"], "true")
})

test("the live region is mounted even with no filters applied", () => {
  const instance = render(FilterChips, { fields: FIELDS, value: "sort=name" })
  const ui = row(instance)
  assert.equal(ui.chips.length, 0)
  assert.equal(ui.list, undefined)
  // Present and empty. A region that appears together with its text is not announced, and the text
  // that matters most here arrives as the row empties.
  assert.ok(ui.live, "the live region unmounted with the chips")
  assert.equal(ui.live.props["aria-live"], "polite")
  // `hidden` on an empty region is the version that passes every other test here and announces
  // nothing: the node is in the DOM but out of the accessibility tree until its text arrives, which
  // is the same silence as not being there at all.
  assert.equal(ui.live.props.hidden, undefined, "the live region is hidden until it has something to say")
  assert.equal(textOf(ui.live), "")
})

test("nothing is emitted on mount or when the query changes from outside", () => {
  const emitted = []
  const props = {
    fields: FIELDS,
    value: "status=open",
    onValueChange: (next) => emitted.push(next),
  }
  const instance = render(FilterChips, props)
  instance.update({ ...props, value: "status=pending" })
  assert.deepEqual(emitted, [])
})

test("a query arriving from outside rewrites the row", () => {
  const props = { fields: FIELDS, value: "status=open", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  assert.deepEqual(chipTexts(instance), ["Status: Open"])
  // The whole reason the component holds no list of its own: a Back button, a link or another
  // control changes the query, and the row has to follow it rather than its own memory.
  instance.update({ ...props, value: "owner=amy&tags=eu" })
  assert.deepEqual(chipTexts(instance), ["Owner: amy", "Tags: eu"])
})

test("pressing × emits the narrowed query and drops the chip", () => {
  const emitted = []
  const instance = render(FilterChips, {
    fields: FIELDS,
    defaultValue: "status=open&status=pending&sort=name",
    onValueChange: (next) => emitted.push(next),
  })
  row(instance).removes[0].props.onClick()
  instance.rerender()
  assert.deepEqual(emitted, ["status=pending&sort=name"])
  assert.deepEqual(chipTexts(instance), ["Status: Pending"])
})

test("clear all appears at two chips, not at one", () => {
  const one = render(FilterChips, { fields: FIELDS, value: "status=open" })
  assert.equal(row(one).clear, undefined)
  const two = render(FilterChips, { fields: FIELDS, value: "status=open&owner=amy" })
  assert.ok(row(two).clear)
  const never = render(FilterChips, {
    fields: FIELDS,
    value: "status=open&owner=amy",
    clearAllFrom: Infinity,
  })
  assert.equal(row(never).clear, undefined)
  // Never an enabled control for clearing nothing.
  const none = render(FilterChips, { fields: FIELDS, value: "sort=name", clearAllFrom: 0 })
  assert.equal(row(none).clear, undefined)
})

test("every control is disabled together", () => {
  const instance = render(FilterChips, {
    fields: FIELDS,
    value: "status=open&owner=amy",
    disabled: true,
  })
  const ui = row(instance)
  for (const button of [...ui.removes, ui.clear]) assert.equal(button.props.disabled, true)
})

// --- what gets announced --------------------------------------------------------------------------

test("a removal is announced with the count the page reports", () => {
  const props = {
    fields: FIELDS,
    value: "status=open&owner=amy",
    resultCount: 128,
    onValueChange: () => {},
  }
  const instance = render(FilterChips, props)
  assert.equal(textOf(row(instance).live), "", "nothing has happened yet")
  row(instance).removes[0].props.onClick()
  instance.update({ ...props, value: "owner=amy" })
  assert.equal(textOf(row(instance).live), "Removed Status: Open. 128 results.")
})

test("a count arriving after the fetch updates the same announcement", () => {
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  row(instance).removes[0].props.onClick()
  instance.update({ ...props, value: "owner=amy" })
  // The list is still loading, so the page has no count to give yet.
  assert.equal(textOf(row(instance).live), "Removed Status: Open.")
  instance.update({ ...props, value: "owner=amy", resultCount: 1 })
  assert.equal(textOf(row(instance).live), "Removed Status: Open. 1 result.")
})

test("a count the row was not asked about is not narrated", () => {
  // The page's own search box changes the count on every keystroke. This region speaks for what
  // happened here, so with nothing done here it stays silent.
  const props = { fields: FIELDS, value: "status=open", resultCount: 40 }
  const instance = render(FilterChips, props)
  assert.equal(textOf(row(instance).live), "")
  instance.update({ ...props, resultCount: 12 })
  assert.equal(textOf(row(instance).live), "")
})

// --- clearing, and putting it back ----------------------------------------------------------------

test("clear all offers an undo that restores the query exactly, page number included", () => {
  const emitted = []
  const props = {
    fields: FIELDS,
    value: "status=open&owner=amy&page=7&sort=name",
    onValueChange: (next) => emitted.push(next),
  }
  const instance = render(FilterChips, props)
  assert.equal(row(instance).undo, undefined)
  row(instance).clear.props.onClick()
  instance.update({ ...props, value: "sort=name" })
  const cleared = row(instance)
  assert.deepEqual(chipTexts(instance), [])
  assert.ok(cleared.undo, "clearing several filters at once left no way back")
  assert.equal(textOf(cleared.live), "All filters cleared.")

  cleared.undo.props.onClick()
  instance.update({ ...props, value: "status=open&owner=amy&page=7&sort=name" })
  assert.deepEqual(emitted, ["sort=name", "status=open&owner=amy&page=7&sort=name"])
  assert.deepEqual(chipTexts(instance), ["Status: Open", "Owner: amy"])
  assert.equal(textOf(row(instance).live), "Filters restored.")
  assert.equal(row(instance).undo, undefined, "the offer outlived the thing it undid")
})

test("allowUndo: false clears with no offer to put it back", () => {
  const props = {
    fields: FIELDS,
    value: "status=open&owner=amy",
    allowUndo: false,
    onValueChange: () => {},
  }
  const instance = render(FilterChips, props)
  row(instance).clear.props.onClick()
  instance.update({ ...props, value: "" })
  assert.equal(row(instance).undo, undefined)
})

test("the undo offer does not appear beside the chips it is about to remove", () => {
  // Controlled, with a parent that has not applied the change yet — a route change, usually. An undo
  // showing while the filters are still on screen offers to put back what is already there.
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  row(instance).clear.props.onClick()
  instance.rerender()
  assert.equal(row(instance).undo, undefined)
  assert.equal(row(instance).chips.length, 2)
})

test("a query change from elsewhere withdraws the undo offer and the announcement", () => {
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  row(instance).clear.props.onClick()
  instance.update({ ...props, value: "" })
  assert.ok(row(instance).undo)
  // Something else set a filter: restoring the old ones would no longer match what is on screen, and
  // the last announcement is about a filter that is gone.
  instance.update({ ...props, value: "tags=eu" })
  const after = row(instance)
  assert.equal(after.undo, undefined)
  assert.equal(textOf(after.live), "")
  assert.deepEqual(chipTexts(instance), ["Tags: eu"])
})

// --- focus ----------------------------------------------------------------------------------------

test("focus moves to the chip that took the removed one's place", () => {
  const props = {
    fields: FIELDS,
    value: "status=open&status=pending&owner=amy",
    onValueChange: () => {},
  }
  const instance = render(FilterChips, props)
  const first = row(instance).removes[0].props.ref
  const second = row(instance).removes[1].props.ref
  row(instance).removes[0].props.onClick()
  instance.update({ ...props, value: "status=pending&owner=amy" })
  assert.equal(focusCalls(first).length, 1, "focus was left on a button that no longer exists")
  assert.equal(focusCalls(second).length, 0)
})

test("removing the end of the row falls back to the chip before it", () => {
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  const first = row(instance).removes[0].props.ref
  row(instance).removes[1].props.onClick()
  instance.update({ ...props, value: "status=open" })
  assert.equal(focusCalls(first).length, 1)
})

test("removing the only chip focuses the row rather than losing focus to the page", () => {
  const props = { fields: FIELDS, value: "status=open", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  const container = instance.tree.props.ref
  // Without this the focus() below is a call a browser ignores, and focus still lands on <body>.
  assert.equal(instance.tree.props.tabIndex, -1, "the row cannot be focused from code")
  row(instance).removes[0].props.onClick()
  instance.update({ ...props, value: "" })
  assert.deepEqual(chipTexts(instance), [])
  assert.equal(focusCalls(container).length, 1, "focus dropped to <body>")
})

test("clearing moves focus to the undo, which is the only thing left to press", () => {
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  row(instance).clear.props.onClick()
  instance.update({ ...props, value: "" })
  assert.equal(focusCalls(row(instance).undo.props.ref).length, 1)
})

test("a focus move queued for a change the parent never applied does not fire later", () => {
  // The parent ignored onValueChange, then something else changed the query. Focusing position 0 of
  // a row that was rebuilt for an unrelated reason would move focus for no reason a person can see.
  const props = { fields: FIELDS, value: "status=open&owner=amy", onValueChange: () => {} }
  const instance = render(FilterChips, props)
  const first = row(instance).removes[0].props.ref
  row(instance).removes[0].props.onClick()
  instance.rerender()
  assert.equal(focusCalls(first).length, 0, "focus moved while the removed chip was still there")
  instance.update({ ...props, value: "tags=eu" })
  assert.equal(focusCalls(first).length, 0)
})
