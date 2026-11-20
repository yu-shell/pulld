// A multi-key sort looks finished in forty lines: an array of {field, dir}, a reduce over
// comparators, `a[key] < b[key] ? -1 : 1`. The cases below are written to fail against that and
// against the implementations it grows into:
//
//   - `<` as the text comparison, which files every lowercase word after every uppercase one and
//     sends `Ähre` and `ångström` past `Zebra`,
//   - a collator without `numeric`, which still reads item10 as earlier than item9,
//   - missing values modelled as `undefined`, which the engine pins to the end before the
//     comparator is ever called, so the blanks-first setting is drawn and does nothing,
//   - `null` left to `<`, which sorts it where the word "null" falls,
//   - the nulls position multiplied by the direction, so reversing a sort throws every blank row
//     to the other end of the table,
//   - `new Date(x) - new Date(y)` on a value that is not a date, which hands `sort` a NaN and
//     leaves the whole table in the order it arrived, silently,
//   - `a - b` on numbers, which answers NaN for two Infinities,
//   - leaning on sort stability for a steady view, which it cannot give: stability preserves the
//     order the rows arrived in, and that is not a property of the rows,
//   - the same key added twice, which is a row that cannot change anything,
//   - and `split(",")` as the URL parser, which a key containing a comma defeats.
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

const {
  createSortId,
  createSortTerm,
  defaultDirection,
  effectiveNulls,
  sortFieldKind,
  sortFieldLabel,
  findSortField,
  availableSortFields,
  canAddSortTerm,
  dedupeSortTerms,
  moveSortTerm,
  readSortValue,
  isMissingValue,
  isMissingForKind,
  collatorFor,
  compareSortValues,
  sortComparator,
  sortRows,
  buildSortQuery,
  escapeSortSegment,
  toSortParam,
  parseSortParam,
  directionLabel,
  describeSort,
  defaultSortBuilderLabels,
  SortBuilder,
} = loadComponent(join(ROOT, "registry", "ui", "sort-builder.tsx"), {
  stubs: {
    "lucide-react": {
      ArrowUp: icon("arrow-up"),
      ArrowDown: icon("arrow-down"),
      Plus: icon("plus"),
      Trash2: icon("trash"),
    },
  },
})

const FIELDS = [
  { name: "name", label: "Name", kind: "text" },
  { name: "amount", label: "Amount", kind: "number" },
  { name: "created", label: "Created", kind: "date" },
  { name: "active", label: "Active", kind: "boolean" },
  { name: "slug", label: "Slug", kind: "text", numeric: true },
]

const field = (name) => FIELDS.find((f) => f.name === name)
const ids = (() => {
  let n = 0
  return () => `t${++n}`
})()
const term = (overrides) => ({ id: ids(), field: "name", direction: "asc", ...overrides })

const labelled = (nodes, label) => nodes.filter((n) => n.props?.["aria-label"] === label)
const selectNamed = (tree, label) => labelled(byTag(walk(tree), "select"), label)[0]
const buttonNamed = (tree, label) => labelled(byTag(walk(tree), "button"), label)[0]

/* ------------------------------------------------- text goes through a collator */

test("text is not compared with < — case and accents are not codepoint order", () => {
  const words = ["Zebra", "Ähre", "apple", "Öl", "ångström", "Banana"]
  const sorted = [...words].sort((a, b) => compareSortValues(a, b, "text", { locale: "en" }))
  // Measured: plain `<` gives ["Banana","Zebra","apple","Ähre","Öl","ångström"].
  assert.deepEqual(sorted, ["Ähre", "ångström", "apple", "Banana", "Öl", "Zebra"])
  assert.ok(sorted.indexOf("apple") < sorted.indexOf("Banana"), "lowercase must interleave")
  assert.ok(sorted.indexOf("Ähre") < sorted.indexOf("Zebra"), "accents must not be exiled")
})

test("the locale is not cosmetic — Swedish puts å ä ö after z", () => {
  const words = ["Zebra", "Ähre", "apple", "Öl", "ångström", "Banana"]
  const swedish = [...words].sort((a, b) => compareSortValues(a, b, "text", { locale: "sv" }))
  assert.deepEqual(swedish, ["apple", "Banana", "Zebra", "ångström", "Ähre", "Öl"])
})

test("natural order needs numeric: true — a plain collator does not fix it", () => {
  const files = ["item10", "item9", "item100", "item1"]
  const plain = [...files].sort((a, b) => compareSortValues(a, b, "text", { locale: "en" }))
  assert.deepEqual(plain, ["item1", "item10", "item100", "item9"])
  const natural = [...files].sort((a, b) =>
    compareSortValues(a, b, "text", { locale: "en", numeric: true })
  )
  assert.deepEqual(natural, ["item1", "item9", "item10", "item100"])
})

test("a field's numeric flag reaches the comparator", () => {
  const rows = [{ slug: "step-10" }, { slug: "step-9" }]
  const sorted = sortRows(rows, [term({ field: "slug" })], FIELDS, { locale: "en" })
  assert.deepEqual(sorted.map((r) => r.slug), ["step-9", "step-10"])
})

test("one collator per configuration, reused", () => {
  assert.equal(collatorFor("en", true, "variant"), collatorFor("en", true, "variant"))
  assert.notEqual(collatorFor("en", true, "variant"), collatorFor("en", false, "variant"))
  assert.notEqual(collatorFor("en", true, "variant"), collatorFor("sv", true, "variant"))
})

/* ------------------------------------------------------------- missing values */

test("undefined does not reach the engine's own end-pinning", () => {
  // The trap: Array.prototype.sort moves undefined to the end and never calls the comparator on
  // it, so a blanks-first setting is drawn and silently ignored. Measured: 3 comparator calls for
  // 5 elements. Rows carry undefined here, so only a partition inside the comparator can place
  // them — which is what this asserts.
  const rows = [{ name: "b" }, { name: undefined }, { name: "a" }]
  const first = sortRows(rows, [term({ field: "name", nulls: "first" })], FIELDS, { locale: "en" })
  assert.deepEqual(first.map((r) => r.name), [undefined, "a", "b"])
  const last = sortRows(rows, [term({ field: "name", nulls: "last" })], FIELDS, { locale: "en" })
  assert.deepEqual(last.map((r) => r.name), ["a", "b", undefined])
})

test("null is not sorted where the word \"null\" falls", () => {
  const rows = [{ name: "zoe" }, { name: null }, { name: "ada" }]
  const sorted = sortRows(rows, [term({ field: "name", nulls: "last" })], FIELDS, { locale: "en" })
  assert.deepEqual(sorted.map((r) => r.name), ["ada", "zoe", null])
})

test("an empty string is a blank, not a value that sorts before everything", () => {
  const rows = [{ name: "b" }, { name: "   " }, { name: "a" }]
  const sorted = sortRows(rows, [term({ field: "name", nulls: "last" })], FIELDS, { locale: "en" })
  assert.deepEqual(sorted.map((r) => r.name), ["a", "b", "   "])
  assert.ok(isMissingValue(""))
  assert.ok(isMissingValue("  "))
  assert.ok(!isMissingValue("a"))
  assert.ok(!isMissingValue(0), "0 is a number, not a blank")
  assert.ok(!isMissingValue(false), "false is a value, not a blank")
})

test("reversing the direction does not move the blanks", () => {
  // The SQL default people get bitten by: Postgres treats null as the largest value, so ascending
  // puts blanks last and descending puts them first, and reversing a sort throws every empty row
  // to the other end of the table.
  const rows = [{ amount: 2 }, { amount: null }, { amount: 1 }]
  const asc = sortRows(rows, [term({ field: "amount", direction: "asc", nulls: "last" })], FIELDS)
  const desc = sortRows(rows, [term({ field: "amount", direction: "desc", nulls: "last" })], FIELDS)
  assert.deepEqual(asc.map((r) => r.amount), [1, 2, null])
  assert.deepEqual(desc.map((r) => r.amount), [2, 1, null], "the blank must stay at the end")
})

test("a value that cannot be read as a date is a blank, not a NaN comparison", () => {
  // Measured: [3,1,2].sort(() => NaN) answers [3,1,2]. One unparseable date in a column would
  // otherwise leave the whole table in its arrival order with no error anywhere.
  assert.ok(isMissingForKind("not a date", "date"))
  assert.ok(isMissingForKind("twelve", "number"))
  assert.ok(!isMissingForKind("2026-01-01", "date"))
  const rows = [
    { created: "2026-03-01" },
    { created: "nope" },
    { created: "2026-01-01" },
    { created: "2026-02-01" },
  ]
  const sorted = sortRows(rows, [term({ field: "created", direction: "asc", nulls: "last" })], FIELDS)
  assert.deepEqual(
    sorted.map((r) => r.created),
    ["2026-01-01", "2026-02-01", "2026-03-01", "nope"]
  )
})

test("the comparator never answers NaN", () => {
  const compare = sortComparator([term({ field: "created" }), term({ field: "amount" })], FIELDS)
  const awkward = [
    { created: "nope", amount: Number.POSITIVE_INFINITY },
    { created: null, amount: Number.POSITIVE_INFINITY },
    { created: "2026-01-01", amount: Number.NaN },
    { created: undefined, amount: 0 },
  ]
  for (const a of awkward) {
    for (const b of awkward) {
      const order = compare(a, b)
      assert.ok(!Number.isNaN(order), `NaN for ${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
    }
  }
})

test("two infinities are equal, not NaN", () => {
  const inf = Number.POSITIVE_INFINITY
  assert.equal(compareSortValues(inf, inf, "number"), 0)
  assert.equal(compareSortValues(inf, 1, "number"), 1)
  assert.equal(compareSortValues(-inf, 1, "number"), -1)
})

/* ------------------------------------------------------- kinds and accessors */

test("numbers written as text sort numerically, and a blank is not zero", () => {
  const rows = [{ amount: "10" }, { amount: "" }, { amount: "9" }, { amount: "-2" }]
  const sorted = sortRows(rows, [term({ field: "amount", nulls: "last" })], FIELDS)
  assert.deepEqual(sorted.map((r) => r.amount), ["-2", "9", "10", ""])
})

test("booleans arriving as 1/0 or \"true\"/\"false\" still sort", () => {
  const shapes = [{ active: 1 }, { active: false }, { active: "true" }, { active: "false" }]
  const sorted = sortRows(shapes, [term({ field: "active", direction: "asc" })], FIELDS)
  assert.deepEqual(sorted.map((r) => r.active), [false, "false", 1, "true"])
})

test("dates compare as instants whether they arrive as Date, string or epoch", () => {
  const rows = [
    { created: new Date("2026-03-01T00:00:00Z") },
    { created: "2026-01-01T00:00:00Z" },
    { created: Date.parse("2026-02-01T00:00:00Z") },
  ]
  const sorted = sortRows(rows, [term({ field: "created", direction: "asc" })], FIELDS)
  assert.deepEqual(
    sorted.map((r) => new Date(r.created).toISOString().slice(0, 10)),
    ["2026-01-01", "2026-02-01", "2026-03-01"]
  )
})

test("an accessor sorts on the compared value, not the shown one", () => {
  const fields = [{ name: "who", label: "Who", kind: "text", accessor: (row) => row.user.last }]
  const rows = [{ user: { last: "Zane" } }, { user: { last: "Ada" } }]
  const sorted = sortRows(rows, [term({ field: "who" })], fields, { locale: "en" })
  assert.deepEqual(sorted.map((r) => r.user.last), ["Ada", "Zane"])
  assert.equal(readSortValue(rows[0], fields[0]), "Zane")
})

test("dates default to newest first and text to A → Z", () => {
  assert.equal(defaultDirection("date"), "desc")
  assert.equal(defaultDirection("text"), "asc")
  assert.equal(defaultDirection("number"), "asc")
  assert.equal(createSortTerm(field("created"), ids).direction, "desc")
  assert.equal(createSortTerm(field("name"), ids).direction, "asc")
})

/* ------------------------------------------------------------ the key order */

test("the order of the keys is the meaning, not a detail", () => {
  const rows = [
    { name: "b", amount: 1 },
    { name: "a", amount: 2 },
    { name: "a", amount: 1 },
  ]
  const byNameThenAmount = sortRows(
    rows,
    [term({ field: "name" }), term({ field: "amount" })],
    FIELDS,
    { locale: "en" }
  )
  const byAmountThenName = sortRows(
    rows,
    [term({ field: "amount" }), term({ field: "name" })],
    FIELDS,
    { locale: "en" }
  )
  assert.deepEqual(byNameThenAmount.map((r) => `${r.name}${r.amount}`), ["a1", "a2", "b1"])
  assert.deepEqual(byAmountThenName.map((r) => `${r.name}${r.amount}`), ["a1", "b1", "a2"])
})

test("a later key only speaks where the earlier one tied", () => {
  const rows = [
    { name: "a", amount: 9 },
    { name: "b", amount: 1 },
  ]
  const sorted = sortRows(rows, [term({ field: "name" }), term({ field: "amount" })], FIELDS, {
    locale: "en",
  })
  assert.deepEqual(sorted.map((r) => r.name), ["a", "b"])
})

test("each key keeps its own direction", () => {
  const rows = [
    { name: "a", amount: 1 },
    { name: "a", amount: 2 },
    { name: "b", amount: 1 },
  ]
  const sorted = sortRows(
    rows,
    [term({ field: "name", direction: "asc" }), term({ field: "amount", direction: "desc" })],
    FIELDS,
    { locale: "en" }
  )
  assert.deepEqual(sorted.map((r) => `${r.name}${r.amount}`), ["a2", "a1", "b1"])
})

/* --------------------------------------------------------------- the tie-break */

test("sort stability cannot steady the view — only a tie-break can", () => {
  // Array.prototype.sort IS stable (ES2019) and that is exactly the problem: it preserves the
  // order the rows arrived in, and two fetches of the same equal-ranked rows do not arrive in the
  // same order. Measured: [3,1,2] and [1,2,3] both come back unchanged under a rank comparator.
  const fetchA = [{ id: 3, rank: 1 }, { id: 1, rank: 1 }, { id: 2, rank: 1 }]
  const fetchB = [{ id: 1, rank: 1 }, { id: 2, rank: 1 }, { id: 3, rank: 1 }]
  const fields = [{ name: "rank", kind: "number" }]
  const terms = [term({ field: "rank" })]
  const withoutTieBreak = [sortRows(fetchA, terms, fields), sortRows(fetchB, terms, fields)]
  assert.notDeepEqual(
    withoutTieBreak[0].map((r) => r.id),
    withoutTieBreak[1].map((r) => r.id),
    "without a tie-break the two fetches must differ — that is the whole point"
  )
  const a = sortRows(fetchA, terms, fields, { tieBreak: "id" })
  const b = sortRows(fetchB, terms, fields, { tieBreak: "id" })
  assert.deepEqual(a.map((r) => r.id), [1, 2, 3])
  assert.deepEqual(b.map((r) => r.id), [1, 2, 3])
})

test("the tie-break is ascending whatever the terms do", () => {
  const rows = [{ id: 2, rank: 1 }, { id: 1, rank: 1 }]
  const fields = [{ name: "rank", kind: "number" }]
  const sorted = sortRows(rows, [term({ field: "rank", direction: "desc" })], fields, {
    tieBreak: "id",
  })
  assert.deepEqual(sorted.map((r) => r.id), [1, 2])
})

test("the tie-break can be a function, and compares numbers as numbers", () => {
  const rows = [{ n: 10 }, { n: 9 }]
  const sorted = sortRows(rows, [], [], { tieBreak: (row) => row.n })
  assert.deepEqual(sorted.map((r) => r.n), [9, 10])
})

test("sortRows copies — the input is usually props", () => {
  const rows = [{ name: "b" }, { name: "a" }]
  const sorted = sortRows(rows, [term({ field: "name" })], FIELDS, { locale: "en" })
  assert.deepEqual(rows.map((r) => r.name), ["b", "a"])
  assert.notEqual(sorted, rows)
})

/* ------------------------------------------------- one key, at most one term */

test("a key already in the list is not offered to another row", () => {
  const terms = [term({ field: "name" }), term({ field: "amount" })]
  const offered = availableSortFields(FIELDS, terms).map((f) => f.name)
  assert.deepEqual(offered, ["created", "active", "slug"])
})

test("a row is still offered the key it holds", () => {
  const first = term({ field: "name" })
  const offered = availableSortFields(FIELDS, [first, term({ field: "amount" })], first.id)
  assert.deepEqual(offered.map((f) => f.name), ["name", "created", "active", "slug"])
})

test("nothing can be added once every key is used", () => {
  const terms = FIELDS.map((f) => term({ field: f.name }))
  assert.equal(canAddSortTerm(FIELDS, terms), false)
  assert.equal(canAddSortTerm(FIELDS, terms.slice(0, 2)), true)
  assert.equal(canAddSortTerm(FIELDS, terms.slice(0, 2), 2), false, "maxTerms also stops it")
})

test("a duplicated key cannot change the order, and is dropped from the query", () => {
  const rows = [{ name: "b" }, { name: "a" }]
  const once = [term({ field: "name", direction: "asc" })]
  const twice = [
    term({ field: "name", direction: "asc" }),
    term({ field: "name", direction: "desc" }),
  ]
  assert.deepEqual(
    sortRows(rows, twice, FIELDS, { locale: "en" }).map((r) => r.name),
    sortRows(rows, once, FIELDS, { locale: "en" }).map((r) => r.name)
  )
  const { query, dropped } = buildSortQuery(twice, FIELDS)
  assert.equal(query.length, 1)
  assert.deepEqual(dropped.map((d) => d.issue), ["duplicate_field"])
})

test("dedupe keeps the first occurrence, which is the one that decides", () => {
  const kept = dedupeSortTerms([
    term({ field: "name", direction: "asc" }),
    term({ field: "amount" }),
    term({ field: "name", direction: "desc" }),
  ])
  assert.deepEqual(kept.map((t) => t.field), ["name", "amount"])
  assert.equal(kept[0].direction, "asc")
})

test("moving a key rewrites the order without touching the terms", () => {
  const terms = [term({ field: "name" }), term({ field: "amount" }), term({ field: "created" })]
  assert.deepEqual(moveSortTerm(terms, 2, 0).map((t) => t.field), ["created", "name", "amount"])
  assert.deepEqual(moveSortTerm(terms, 0, 1).map((t) => t.field), ["amount", "name", "created"])
  assert.deepEqual(moveSortTerm(terms, 0, 9).map((t) => t.field), ["name", "amount", "created"])
  assert.deepEqual(moveSortTerm(terms, 1, 1).map((t) => t.field), ["name", "amount", "created"])
  assert.notEqual(moveSortTerm(terms, 0, 1), terms)
})

/* ---------------------------------------------------------- output: the query */

test("the query resolves nulls, because a server cannot look up a field default", () => {
  const fields = [{ name: "amount", kind: "number", nulls: "first" }]
  const { query } = buildSortQuery([term({ field: "amount" })], fields)
  assert.deepEqual(query, [{ field: "amount", direction: "asc", nulls: "first" }])
})

test("a term overrides its field's nulls", () => {
  const fields = [{ name: "amount", kind: "number", nulls: "first" }]
  assert.equal(effectiveNulls(term({ field: "amount", nulls: "last" }), fields[0]), "last")
  assert.equal(effectiveNulls(term({ field: "amount" }), fields[0]), "first")
  assert.equal(effectiveNulls(term({ field: "amount" }), undefined), "last", "last is the default")
})

test("an unfinished or stale term comes back as dropped, not swallowed", () => {
  const terms = [
    term({ field: "" }),
    term({ field: "gone" }),
    term({ field: "name" }),
  ]
  const { query, dropped } = buildSortQuery(terms, FIELDS)
  assert.deepEqual(query, [{ field: "name", direction: "asc", nulls: "last" }])
  assert.deepEqual(dropped.map((d) => [d.field, d.issue]), [
    ["", "no_field"],
    ["gone", "unknown_field"],
  ])
})

test("nothing to sort by is null, not an empty list", () => {
  assert.equal(buildSortQuery([], FIELDS).query, null)
  assert.equal(buildSortQuery([term({ field: "" })], FIELDS).query, null)
})

test("a term naming a key that no longer exists does not reorder the table", () => {
  const rows = [{ name: "b" }, { name: "a" }]
  const sorted = sortRows(rows, [term({ field: "gone" })], FIELDS, { locale: "en" })
  assert.deepEqual(sorted.map((r) => r.name), ["b", "a"])
})

/* ------------------------------------------------------------ output: the URL */

test("the URL form is the one servers already read", () => {
  const terms = [
    term({ field: "created", direction: "desc" }),
    term({ field: "name", direction: "asc" }),
  ]
  assert.equal(toSortParam(terms), "-created,name")
})

test("a key containing the structural characters round-trips", () => {
  for (const name of ["a,b", "-x", "a\\b", "plain", "a-b"]) {
    const parsed = parseSortParam(toSortParam([term({ field: name, direction: "desc" })]))
    assert.equal(parsed.length, 1, name)
    assert.equal(parsed[0].field, name, `field ${name}`)
    assert.equal(parsed[0].direction, "desc", `direction ${name}`)
  }
  assert.equal(escapeSortSegment("a,b"), "a\\,b")
  assert.equal(escapeSortSegment("-x"), "\\-x")
  assert.equal(escapeSortSegment("a-b"), "a-b", "only a leading hyphen is structural")
})

test("split(\",\") would be defeated by this one", () => {
  const parsed = parseSortParam("a\\,b,name")
  assert.deepEqual(parsed.map((t) => t.field), ["a,b", "name"])
})

test("the round trip keeps the order and both directions", () => {
  const terms = [
    term({ field: "created", direction: "desc" }),
    term({ field: "name", direction: "asc" }),
    term({ field: "amount", direction: "desc" }),
  ]
  const parsed = parseSortParam(toSortParam(terms))
  assert.deepEqual(
    parsed.map((t) => [t.field, t.direction]),
    terms.map((t) => [t.field, t.direction])
  )
  parsed.forEach((t) => assert.equal(t.nulls, undefined, "nulls falls back to the field"))
})

test("a URL it cannot read is null, not the half it could", () => {
  for (const bad of [",", "name,", ",name", "-", "name,,amount", "name,-", "a\\"]) {
    assert.equal(parseSortParam(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
  assert.deepEqual(parseSortParam(""), [], "an empty param is an empty sort, not a failure")
})

test("parsed terms get fresh ids", () => {
  const parsed = parseSortParam("name,-created", ids)
  assert.equal(new Set(parsed.map((t) => t.id)).size, 2)
  assert.ok(parsed.every((t) => typeof t.id === "string" && t.id.length > 0))
})

test("the param drops terms with no key rather than writing an empty segment", () => {
  assert.equal(toSortParam([term({ field: "" }), term({ field: "name" })]), "name")
})

/* ------------------------------------------------------- output: the sentence */

test("the order reads as a sentence, in the field's own words", () => {
  const terms = [
    term({ field: "active", direction: "desc" }),
    term({ field: "created", direction: "desc" }),
  ]
  assert.equal(describeSort(terms, FIELDS), "Active yes first, then Created newest first")
})

test("the direction is said in the words the kind calls for", () => {
  assert.equal(directionLabel("date", "desc"), "newest first")
  assert.equal(directionLabel("number", "asc"), "smallest first")
  assert.equal(directionLabel("text", "asc"), "A → Z")
  assert.equal(directionLabel("boolean", "asc"), "no first")
})

test("the sentence can carry the blanks position, and says nothing by default", () => {
  const terms = [term({ field: "amount", direction: "asc", nulls: "first" })]
  assert.equal(describeSort(terms, FIELDS), "Amount smallest first")
  assert.equal(
    describeSort(terms, FIELDS, undefined, { nulls: true }),
    "Amount smallest first (blanks first)"
  )
})

test("an empty or unusable order says so rather than returning \"\"", () => {
  assert.equal(describeSort([], FIELDS), defaultSortBuilderLabels.empty)
  assert.equal(describeSort([term({ field: "gone" })], FIELDS), defaultSortBuilderLabels.empty)
})

/* ----------------------------------------------------------------- the editor */

const view = (props = {}) => render(SortBuilder, { fields: FIELDS, ...props })

const addButton = (tree) =>
  byTag(walk(tree), "button").find((n) =>
    Array.isArray(n.props.children)
      ? n.props.children.includes(defaultSortBuilderLabels.addSort)
      : n.props.children === defaultSortBuilderLabels.addSort
  )

const optionValues = (select) =>
  walk(select)
    .filter((n) => n.type === "option")
    .map((n) => n.props.value)

const liveText = (tree) =>
  walk(tree).find((n) => n.props?.["aria-live"])?.props?.children ?? ""

const strings = (tree) =>
  walk(tree).flatMap((n) => {
    const children = n.props?.children
    if (typeof children === "string") return [children]
    if (Array.isArray(children)) return children.filter((c) => typeof c === "string")
    return []
  })

test("the editor draws one row per term, in order, as an ordered list", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "created", direction: "desc" })] })
  assert.equal(byTag(walk(v.tree), "ol").length, 1)
  assert.equal(byTag(walk(v.tree), "li").length, 2)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.value, "name")
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(2)).props.value, "created")
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.direction(2)).props.value, "desc")
})

test("every control carries a name that says which row it belongs to", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  for (const position of [1, 2]) {
    assert.ok(selectNamed(v.tree, defaultSortBuilderLabels.key(position)), `key ${position}`)
    assert.ok(selectNamed(v.tree, defaultSortBuilderLabels.direction(position)), `dir ${position}`)
    assert.ok(buttonNamed(v.tree, defaultSortBuilderLabels.moveUp(position)), `up ${position}`)
    assert.ok(buttonNamed(v.tree, defaultSortBuilderLabels.moveDown(position)), `down ${position}`)
    assert.ok(buttonNamed(v.tree, defaultSortBuilderLabels.remove(position)), `remove ${position}`)
  }
})

test("the key menu of each row leaves out the keys the other rows hold", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  assert.deepEqual(optionValues(selectNamed(v.tree, defaultSortBuilderLabels.key(1))), [
    "name",
    "created",
    "active",
    "slug",
  ])
  assert.deepEqual(optionValues(selectNamed(v.tree, defaultSortBuilderLabels.key(2))), [
    "amount",
    "created",
    "active",
    "slug",
  ])
})

test("the end-of-list move buttons stay focusable", () => {
  // `disabled` would take them out of the tab order, which shifts every row's tab stops and drops
  // focus to the document when a key is moved to the end with the keyboard.
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  const up = buttonNamed(v.tree, defaultSortBuilderLabels.moveUp(1))
  const down = buttonNamed(v.tree, defaultSortBuilderLabels.moveDown(2))
  assert.equal(up.props["aria-disabled"], true)
  assert.ok(!up.props.disabled, "must not be natively disabled")
  assert.ok(String(up.props.className).includes("pointer-events-none"))
  assert.equal(down.props["aria-disabled"], true)
  assert.ok(!down.props.disabled, "must not be natively disabled")
  assert.equal(buttonNamed(v.tree, defaultSortBuilderLabels.moveDown(1)).props["aria-disabled"], undefined)
})

test("decorative icons are hidden from the accessibility tree", () => {
  const v = view({ defaultValue: [term({ field: "name" })] })
  const icons = walk(v.tree).filter((n) => n.props?.["data-icon"])
  assert.ok(icons.length > 0, "the icons must be reached")
  for (const node of icons) {
    assert.equal(node.props["aria-hidden"], "true", `${node.props["data-icon"]} must be hidden`)
  }
})

test("adding a key appends a row and announces its position", () => {
  const seen = []
  const v = view({
    defaultValue: [term({ field: "name" })],
    onChange: (next, change) => seen.push([next.map((t) => t.field), change.type]),
  })
  addButton(v.tree).props.onClick()
  v.rerender()
  assert.equal(byTag(walk(v.tree), "li").length, 2)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(2)).props.value, "amount")
  assert.deepEqual(seen, [[["name", "amount"], "add"]])
  assert.equal(liveText(v.tree), defaultSortBuilderLabels.added(2))
})

test("a new row starts on an unused key, never a repeat", () => {
  const v = view({ defaultValue: [term({ field: "name" })] })
  addButton(v.tree).props.onClick()
  v.rerender()
  addButton(v.tree).props.onClick()
  v.rerender()
  const keys = [1, 2, 3].map((p) => selectNamed(v.tree, defaultSortBuilderLabels.key(p)).props.value)
  assert.deepEqual(keys, ["name", "amount", "created"])
  assert.equal(new Set(keys).size, 3)
})

test("the add button is inert, not unfocusable, once every key is used", () => {
  const v = render(SortBuilder, {
    fields: [{ name: "name", kind: "text" }],
    defaultValue: [term({ field: "name" })],
  })
  const add = addButton(v.tree)
  assert.equal(add.props["aria-disabled"], true)
  assert.ok(!add.props.disabled)
  assert.ok(String(add.props.className).includes("pointer-events-none"))
  add.props.onClick()
  v.rerender()
  assert.equal(byTag(walk(v.tree), "li").length, 1, "a click must not slip past aria-disabled")
  assert.ok(strings(v.tree).includes(defaultSortBuilderLabels.allKeysUsed))
})

test("removing a row drops it and reports how many are left", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  buttonNamed(v.tree, defaultSortBuilderLabels.remove(1)).props.onClick()
  v.rerender()
  assert.equal(byTag(walk(v.tree), "li").length, 1)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.value, "amount")
  assert.equal(liveText(v.tree), defaultSortBuilderLabels.removed(1, 1))
})

test("moving a key reorders the list and says where it landed", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "created" })] })
  buttonNamed(v.tree, defaultSortBuilderLabels.moveDown(1)).props.onClick()
  v.rerender()
  assert.deepEqual(
    [1, 2].map((p) => selectNamed(v.tree, defaultSortBuilderLabels.key(p)).props.value),
    ["created", "name"]
  )
  assert.equal(liveText(v.tree), defaultSortBuilderLabels.moved("Name", 2, 2))
})

test("a move that would fall off the end does nothing", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  buttonNamed(v.tree, defaultSortBuilderLabels.moveUp(1)).props.onClick()
  v.rerender()
  assert.deepEqual(
    [1, 2].map((p) => selectNamed(v.tree, defaultSortBuilderLabels.key(p)).props.value),
    ["name", "amount"]
  )
})

test("changing the key re-defaults the direction across kinds and keeps it within one", () => {
  const v = view({ defaultValue: [term({ field: "name", direction: "desc" })] })
  selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.onChange({ target: { value: "created" } })
  v.rerender()
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.direction(1)).props.value, "desc")

  const w = view({ defaultValue: [term({ field: "created", direction: "desc" })] })
  selectNamed(w.tree, defaultSortBuilderLabels.key(1)).props.onChange({ target: { value: "amount" } })
  w.rerender()
  assert.equal(
    selectNamed(w.tree, defaultSortBuilderLabels.direction(1)).props.value,
    "asc",
    "a date's newest-first must not become a number's largest-first"
  )

  const x = view({ defaultValue: [term({ field: "name", direction: "desc" })] })
  selectNamed(x.tree, defaultSortBuilderLabels.key(1)).props.onChange({ target: { value: "slug" } })
  x.rerender()
  assert.equal(
    selectNamed(x.tree, defaultSortBuilderLabels.direction(1)).props.value,
    "desc",
    "text to text keeps the chosen direction"
  )
})

test("the direction menu is worded for the key that is chosen", () => {
  const v = view({ defaultValue: [term({ field: "created" })] })
  assert.deepEqual(
    walk(selectNamed(v.tree, defaultSortBuilderLabels.direction(1)))
      .filter((n) => n.type === "option")
      .map((n) => n.props.children),
    ["oldest first", "newest first"]
  )
  selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.onChange({ target: { value: "name" } })
  v.rerender()
  assert.deepEqual(
    walk(selectNamed(v.tree, defaultSortBuilderLabels.direction(1)))
      .filter((n) => n.type === "option")
      .map((n) => n.props.children),
    ["A → Z", "Z → A"]
  )
})

test("changing the key drops a nulls override chosen for the old one", () => {
  const seen = []
  const v = view({
    defaultValue: [term({ field: "name", nulls: "first" })],
    showNulls: true,
    onChange: (next) => seen.push(next),
  })
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.nulls(1)).props.value, "first")
  selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.onChange({ target: { value: "amount" } })
  v.rerender()
  assert.equal(seen.at(-1)[0].nulls, undefined)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.nulls(1)).props.value, "last")
})

test("the blanks control is off by default and shows what will happen when on", () => {
  const without = view({ defaultValue: [term({ field: "name" })] })
  assert.equal(selectNamed(without.tree, defaultSortBuilderLabels.nulls(1)), undefined)
  const fields = [{ name: "amount", label: "Amount", kind: "number", nulls: "first" }]
  const v = render(SortBuilder, {
    fields,
    defaultValue: [term({ field: "amount" })],
    showNulls: true,
  })
  const select = selectNamed(v.tree, defaultSortBuilderLabels.nulls(1))
  assert.ok(select)
  assert.equal(select.props.value, "first", "it must show the field's own default, not a blank")
  assert.deepEqual(optionValues(select), ["first", "last"])
})

test("the blanks choice reaches the term", () => {
  const seen = []
  const v = view({
    defaultValue: [term({ field: "name" })],
    showNulls: true,
    onChange: (next) => seen.push(next.map((t) => t.nulls)),
  })
  selectNamed(v.tree, defaultSortBuilderLabels.nulls(1)).props.onChange({ target: { value: "first" } })
  v.rerender()
  assert.deepEqual(seen.at(-1), ["first"])
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.nulls(1)).props.value, "first")
})

test("a key the fields no longer offer stays visible and is flagged", () => {
  const v = view({ defaultValue: [term({ field: "gone" })] })
  const select = selectNamed(v.tree, defaultSortBuilderLabels.key(1))
  assert.equal(select.props.value, "gone")
  assert.equal(select.props["aria-invalid"], true)
  assert.ok(
    optionValues(select).includes("gone"),
    "the stale key must remain an option or the select shows a key nobody chose"
  )
  assert.ok(String(select.props.className).includes("border-destructive"))
})

test("a row with no key yet offers the placeholder and is not flagged", () => {
  const v = view({ defaultValue: [term({ field: "" })] })
  const select = selectNamed(v.tree, defaultSortBuilderLabels.key(1))
  assert.equal(select.props.value, "")
  assert.equal(select.props["aria-invalid"], undefined)
  assert.ok(optionValues(select).includes(""))
})

test("the whole editor can be disabled", () => {
  const v = view({ defaultValue: [term({ field: "name" })], disabled: true })
  assert.equal(byTag(walk(v.tree), "fieldset")[0].props.disabled, true)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.disabled, true)
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.direction(1)).props.disabled, true)
  assert.equal(buttonNamed(v.tree, defaultSortBuilderLabels.remove(1)).props.disabled, true)
  assert.equal(buttonNamed(v.tree, defaultSortBuilderLabels.moveUp(1)).props.disabled, true)
  assert.equal(addButton(v.tree).props.disabled, true)
})

test("there is one polite live region, and it starts empty", () => {
  const v = view({ defaultValue: [term({ field: "name" })] })
  const live = walk(v.tree).filter((n) => n.props?.["aria-live"])
  assert.equal(live.length, 1)
  assert.equal(live[0].props["aria-live"], "polite")
  assert.ok(String(live[0].props.className).includes("sr-only"))
  assert.equal(live[0].props.children, "")
})

test("an empty editor says so instead of drawing an empty list", () => {
  const v = view()
  assert.equal(byTag(walk(v.tree), "ol").length, 0)
  assert.ok(strings(v.tree).includes(defaultSortBuilderLabels.empty))
  assert.ok(addButton(v.tree), "it must still be possible to start one")
  assert.equal(addButton(v.tree).props["aria-disabled"], undefined)
})

test("a controlled list does not move on its own", () => {
  const terms = [term({ field: "amount" })]
  const seen = []
  const v = render(SortBuilder, {
    fields: FIELDS,
    value: terms,
    onChange: (next) => seen.push(next.map((t) => t.field)),
  })
  assert.equal(selectNamed(v.tree, defaultSortBuilderLabels.key(1)).props.value, "amount")
  addButton(v.tree).props.onClick()
  v.rerender()
  assert.equal(byTag(walk(v.tree), "li").length, 1, "the parent owns the list")
  assert.deepEqual(seen, [["amount", "name"]], "but it is told what was asked for")
})

test("maxTerms stops the list where the caller said", () => {
  const v = view({ defaultValue: [term({ field: "name" })], maxTerms: 1 })
  assert.equal(addButton(v.tree).props["aria-disabled"], true)
})

test("a legend names the fieldset when one is given", () => {
  const v = view({ defaultValue: [term({ field: "name" })], legend: "Order" })
  const legend = byTag(walk(v.tree), "legend")[0]
  assert.ok(legend)
  assert.equal(legend.props.children, "Order")
})

test("labels can be overridden one at a time", () => {
  const v = view({
    defaultValue: [term({ field: "name" })],
    labels: { addSort: "Add another" },
  })
  assert.ok(strings(v.tree).includes("Add another"))
  assert.ok(buttonNamed(v.tree, defaultSortBuilderLabels.remove(1)), "the rest keep their defaults")
})

test("ids do not collide across builders", () => {
  assert.notEqual(createSortId(), createSortId())
})

test("the first row says \"Sort by\" and the rest say \"then\"", () => {
  const v = view({ defaultValue: [term({ field: "name" }), term({ field: "amount" })] })
  const texts = strings(v.tree)
  assert.ok(texts.includes(defaultSortBuilderLabels.sortBy))
  assert.ok(texts.includes(defaultSortBuilderLabels.then))
})

test("helpers used by the editor are exported for a custom one", () => {
  assert.equal(sortFieldKind(field("created")), "date")
  assert.equal(sortFieldKind(undefined), "text")
  assert.equal(sortFieldLabel(field("name")), "Name")
  assert.equal(sortFieldLabel({ name: "bare" }), "bare")
  assert.equal(findSortField(FIELDS, "amount").label, "Amount")
  assert.equal(findSortField(FIELDS, "nope"), undefined)
})
