// A filter builder looks finished in eighty lines: a row of three selects, an array of rows, and
// `JSON.stringify` at the end. The cases below are written to fail against that and against the
// implementations it grows into:
//
//   - an operator menu that is the same list for every field, so a string offers "greater than",
//   - values left alone when the operator narrows, so `between [10,20]` sent as `gt [10,20]` and
//     the server deciding for itself what the 20 meant,
//   - values carried across a field change, so "acme" survives into an amount and the row reads
//     as complete,
//   - `Number(value)` as the numeric test, which reads a blank cell as zero,
//   - `Date.parse(value)` as the date test, which reads `42` as a year and rolls the 30th of
//     February into March,
//   - rows that are not filled in dropped from the query without a word, which is the bug the
//     person reports as "the filter is wrong",
//   - a conjunction select on every row, which writes `A and B or C` and means nothing,
//   - and a URL encoding that splits on `,` and `:`, which a value containing either defeats.
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
  FILTER_OPERATORS,
  operatorsForField,
  operatorLabel,
  operatorSpec,
  operatorArity,
  fieldKind,
  blankValue,
  blankValues,
  coerceValues,
  createFilterId,
  createRule,
  createGroup,
  retargetRule,
  retargetOperator,
  isPlainNumber,
  isPlainDate,
  valueIsValid,
  ruleIssue,
  ruleIsComplete,
  nodeDepth,
  treeDepth,
  countRules,
  replaceNode,
  findNode,
  appendChild,
  setConjunction,
  buildFilterQuery,
  escapeFilterSegment,
  toFilterParam,
  parseFilterParam,
  describeFilter,
  canAddGroupAtDepth,
  defaultFilterBuilderLabels,
  FilterBuilder,
} = loadComponent(join(ROOT, "registry", "ui", "filter-builder.tsx"), {
  stubs: { "lucide-react": { Plus: icon("plus"), Trash2: icon("trash") } },
})

const FIELDS = [
  { name: "name", label: "Name", kind: "text" },
  { name: "amount", label: "Amount", kind: "number" },
  { name: "signed_up", label: "Signed up", kind: "date" },
  { name: "active", label: "Active", kind: "boolean" },
  {
    name: "status",
    label: "Status",
    kind: "enum",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  },
]

const field = (name) => FIELDS.find((f) => f.name === name)
const ids = (() => {
  let n = 0
  return () => `t${++n}`
})()
const rule = (overrides) => ({ id: ids(), kind: "rule", field: "name", operator: "eq", values: [""], ...overrides })
const group = (children, conjunction = "and") => ({ id: ids(), kind: "group", conjunction, children })

/** The tree without ids, so a structure can be compared without pinning the counter. */
const shape = (node) =>
  node.kind === "rule"
    ? { kind: "rule", field: node.field, operator: node.operator, values: node.values }
    : { kind: "group", conjunction: node.conjunction, children: node.children.map(shape) }

const labelled = (nodes, label) => nodes.filter((n) => n.props?.["aria-label"] === label)

/** Every literal string in the tree, whether it is an only child or sits beside an icon. */
const texts = (tree) =>
  walk(tree).flatMap((n) => {
    const children = n.props?.children
    if (typeof children === "string") return [children]
    if (Array.isArray(children)) return children.filter((child) => typeof child === "string")
    return []
  })

const buttonWith = (tree, label) =>
  walk(tree).find(
    (n) =>
      n.type === "button" &&
      (Array.isArray(n.props?.children)
        ? n.props.children.includes(label)
        : n.props?.children === label)
  )

// ------------------------------------------------- operators follow the field's kind

test("a text field is not offered the comparisons that belong to numbers", () => {
  const offered = operatorsForField(field("name")).map((spec) => spec.id)
  assert.ok(offered.includes("contains"))
  for (const id of ["gt", "gte", "lt", "lte", "between"]) {
    assert.ok(!offered.includes(id), `text should not offer ${id}`)
  }
})

test("a date field is not offered the substring operators", () => {
  const offered = operatorsForField(field("signed_up")).map((spec) => spec.id)
  assert.ok(offered.includes("gt"))
  assert.ok(offered.includes("between"))
  for (const id of ["contains", "not_contains", "starts_with", "ends_with"]) {
    assert.ok(!offered.includes(id), `date should not offer ${id}`)
  }
})

test("an enum is offered membership but not substrings", () => {
  const offered = operatorsForField(field("status")).map((spec) => spec.id)
  assert.ok(offered.includes("in"))
  assert.ok(offered.includes("not_in"))
  assert.ok(!offered.includes("contains"))
  assert.ok(!offered.includes("gt"))
})

test("a boolean is offered equality and emptiness only", () => {
  assert.deepEqual(operatorsForField(field("active")).map((spec) => spec.id), [
    "eq",
    "ne",
    "is_empty",
    "is_not_empty",
  ])
})

test("every operator is offered to at least one kind, and every kind has an operator", () => {
  for (const spec of FILTER_OPERATORS) assert.ok(spec.kinds.length > 0, `${spec.id} reaches no kind`)
  for (const kind of ["text", "number", "date", "boolean", "enum"]) {
    assert.ok(operatorsForField({ name: "x", kind }).length > 0, `${kind} has no operators`)
  }
})

test("a field narrowing its operators gets its own order, without the ones its kind cannot draw", () => {
  const narrowed = operatorsForField({
    name: "amount",
    kind: "number",
    operators: ["between", "eq", "contains", "eq"],
  })
  // `contains` is dropped (a number has no substring) and the repeat collapses, so the menu is
  // exactly what can be drawn, in the order the field asked for.
  assert.deepEqual(narrowed.map((spec) => spec.id), ["between", "eq"])
})

test("the same operator id reads differently over a date than over a number", () => {
  const gt = operatorSpec("gt")
  assert.equal(operatorLabel(gt, "number"), "is greater than")
  assert.equal(operatorLabel(gt, "date"), "is after")
  // The id is what the server sees, so the two spellings must not have become two operators.
  assert.equal(gt.id, "gt")
})

// ------------------------------------------------- the value slots follow the operator

test("arities are what the operators say they are", () => {
  assert.equal(operatorArity("is_empty"), 0)
  assert.equal(operatorArity("eq"), 1)
  assert.equal(operatorArity("between"), 2)
  assert.equal(operatorArity("in"), "many")
})

test("narrowing between to gt drops the second value rather than hiding it", () => {
  const before = rule({ field: "amount", operator: "between", values: ["10", "20"] })
  const after = retargetOperator(before, "gt")
  assert.deepEqual(after.values, ["10"])
})

test("a dropped value does not reach the query", () => {
  const narrowed = retargetOperator(
    rule({ field: "amount", operator: "between", values: ["10", "20"] }),
    "gt"
  )
  const { query } = buildFilterQuery(group([narrowed]), FIELDS)
  assert.deepEqual(query.children[0].values, ["10"])
})

test("widening gt to between keeps the value and opens a second slot", () => {
  const after = retargetOperator(rule({ field: "amount", operator: "gt", values: ["10"] }), "between")
  assert.deepEqual(after.values, ["10", ""])
})

test("an operator that takes no value keeps no value", () => {
  const after = retargetOperator(rule({ field: "name", operator: "eq", values: ["acme"] }), "is_empty")
  assert.deepEqual(after.values, [])
  const back = retargetOperator(after, "eq")
  assert.deepEqual(back.values, [""])
})

test("a list operator keeps the values it has and never collapses to no slot", () => {
  assert.deepEqual(coerceValues(["a", "b", "c"], "many"), ["a", "b", "c"])
  assert.deepEqual(coerceValues([], "many"), [""])
  assert.deepEqual(coerceValues(["a", "", "b"], "many"), ["a", "b"])
})

test("a kind drawn as a select starts at a legal value, not at blank", () => {
  // A select holding "" shows its first option while the rule reports no value: the row would read
  // as "Open" and say "Enter a value" at the same time.
  assert.equal(blankValue(field("status")), "open")
  assert.equal(blankValue(field("active")), "true")
  assert.equal(blankValue(field("name")), "")
  assert.equal(blankValue(field("amount")), "")
  assert.equal(blankValue(field("signed_up")), "")
})

test("a new rule on a select-drawn field is complete the moment it is added", () => {
  const fresh = createRule(field("status"), ids)
  assert.equal(ruleIssue(fresh, FIELDS), "ok")
  const text = createRule(field("name"), ids)
  assert.equal(ruleIssue(text, FIELDS), "missing_value")
})

test("blankValues gives one slot per arity", () => {
  assert.deepEqual(blankValues(0, field("name")), [])
  assert.deepEqual(blankValues(1, field("name")), [""])
  assert.deepEqual(blankValues(2, field("name")), ["", ""])
  assert.deepEqual(blankValues("many", field("name")), [""])
})

// ------------------------------------------------- changing the field

test("changing to a field of another kind drops a value that kind cannot hold", () => {
  const before = rule({ field: "name", operator: "contains", values: ["acme"] })
  const after = retargetRule(before, field("amount"), field("name"))
  assert.equal(after.field, "amount")
  // `contains` does not exist on a number, so the operator falls back to one that does …
  assert.ok(operatorsForField(field("amount")).some((spec) => spec.id === after.operator))
  assert.notEqual(after.operator, "contains")
  // … and "acme" does not survive as an amount, which would read as a complete rule.
  assert.deepEqual(after.values, [""])
  assert.equal(ruleIssue(after, FIELDS), "missing_value")
})

test("changing between two fields of the same kind keeps the operator and the value", () => {
  const before = rule({ field: "amount", operator: "gte", values: ["100"] })
  const other = { name: "seats", label: "Seats", kind: "number" }
  const after = retargetRule(before, other, field("amount"))
  assert.equal(after.field, "seats")
  assert.equal(after.operator, "gte")
  assert.deepEqual(after.values, ["100"])
})

test("changing between two enums replaces a value the new one does not offer", () => {
  const before = rule({ field: "status", operator: "eq", values: ["open"] })
  const other = {
    name: "tier",
    kind: "enum",
    options: [{ value: "free" }, { value: "paid" }],
  }
  const after = retargetRule(before, other, field("status"))
  assert.deepEqual(after.values, ["free"])
  assert.equal(ruleIssue(after, [...FIELDS, other]), "ok")
})

test("an operator the new field also has is kept", () => {
  const before = rule({ field: "name", operator: "ne", values: ["acme"] })
  const after = retargetRule(before, field("status"), field("name"))
  assert.equal(after.operator, "ne")
})

test("the arity is refitted when the kept operator's slots differ", () => {
  // `in` exists on both text and enum, so it survives the move; the value is re-pointed because
  // the kind changed.
  const before = rule({ field: "name", operator: "in", values: ["a", "b"] })
  const after = retargetRule(before, field("status"), field("name"))
  assert.equal(after.operator, "in")
  assert.deepEqual(after.values, ["open"])
})

// ------------------------------------------------- what counts as filled in

test("a blank is not the number zero", () => {
  // Number("") is 0 and Number(" ") is 0, so a numeric test written with it reads an empty box as
  // a filter on zero.
  assert.equal(Number(""), 0)
  assert.equal(isPlainNumber(""), false)
  assert.equal(isPlainNumber(" "), false)
  assert.equal(ruleIssue(rule({ field: "amount", operator: "eq", values: [""] }), FIELDS), "missing_value")
})

test("hex, exponents and infinity are not numbers a person typed into a filter", () => {
  assert.equal(isPlainNumber("0x10"), false)
  assert.equal(isPlainNumber("1e3"), false)
  assert.equal(isPlainNumber("Infinity"), false)
  assert.equal(isPlainNumber("1,5"), false)
  assert.equal(isPlainNumber("-12.5"), true)
  assert.equal(isPlainNumber(".5"), true)
})

test("a date that does not exist is rejected, though Date.parse accepts it", () => {
  // Date.parse("2026-02-30") answers the 2nd of March, which would move the boundary silently.
  assert.ok(!Number.isNaN(Date.parse("2026-02-30")))
  assert.equal(isPlainDate("2026-02-30"), false)
  assert.equal(isPlainDate("2026-11-10"), true)
})

test("a bare number is not a date, though Date.parse reads it as a year", () => {
  assert.ok(!Number.isNaN(Date.parse("42")))
  assert.equal(isPlainDate("42"), false)
  assert.equal(
    ruleIssue(rule({ field: "signed_up", operator: "gt", values: ["42"] }), FIELDS),
    "invalid_date"
  )
})

test("an enum value outside the option list is rejected", () => {
  assert.equal(valueIsValid("open", field("status")), true)
  assert.equal(valueIsValid("archived", field("status")), false)
  assert.equal(
    ruleIssue(rule({ field: "status", operator: "eq", values: ["archived"] }), FIELDS),
    "invalid_option"
  )
})

test("a boolean takes only true and false", () => {
  assert.equal(valueIsValid("true", field("active")), true)
  assert.equal(valueIsValid("yes", field("active")), false)
})

test("an operator with no value slots is complete with no value", () => {
  assert.equal(ruleIssue(rule({ field: "name", operator: "is_empty", values: [] }), FIELDS), "ok")
})

test("a row with no field chosen says so", () => {
  assert.equal(ruleIssue(rule({ field: "", operator: "eq", values: [""] }), FIELDS), "no_field")
})

test("a field that has gone away is reported as such, not as a missing value", () => {
  assert.equal(
    ruleIssue(rule({ field: "deleted_column", operator: "eq", values: ["x"] }), FIELDS),
    "unknown_field"
  )
})

test("a range typed backwards is complete and says it matches nothing", () => {
  const backwards = rule({ field: "amount", operator: "between", values: ["20", "10"] })
  assert.equal(ruleIssue(backwards, FIELDS), "reversed_range")
  // Complete, because it is a filter the person is entitled to ask for — it is not dropped.
  assert.equal(ruleIsComplete(backwards, FIELDS), true)
  const { query, dropped } = buildFilterQuery(group([backwards]), FIELDS)
  assert.equal(dropped.length, 0)
  assert.deepEqual(query.children[0].values, ["20", "10"])
})

test("a backwards date range is caught too", () => {
  const backwards = rule({
    field: "signed_up",
    operator: "between",
    values: ["2026-11-10", "2026-01-01"],
  })
  assert.equal(ruleIssue(backwards, FIELDS), "reversed_range")
})

test("one blank slot of a range is a missing value, not a range", () => {
  assert.equal(
    ruleIssue(rule({ field: "amount", operator: "between", values: ["10", ""] }), FIELDS),
    "missing_value"
  )
})

test("every issue code has something to say about it", () => {
  const codes = new Set()
  const cases = [
    rule({ field: "", values: [""] }),
    rule({ field: "nope", values: ["x"] }),
    rule({ field: "name", values: [""] }),
    rule({ field: "amount", values: ["abc"] }),
    rule({ field: "signed_up", values: ["42"] }),
    rule({ field: "status", values: ["archived"] }),
    rule({ field: "amount", operator: "between", values: ["20", "10"] }),
  ]
  for (const candidate of cases) codes.add(ruleIssue(candidate, FIELDS))
  codes.delete("ok")
  assert.equal(codes.size, 7, `expected every issue kind, saw ${[...codes].join(", ")}`)
  for (const code of codes) {
    assert.ok(defaultFilterBuilderLabels.issue[code], `no message for ${code}`)
  }
})

// ------------------------------------------------- the rows that were left out

test("an unfinished row is reported rather than quietly skipped", () => {
  const tree = group([
    rule({ field: "name", operator: "contains", values: ["acme"] }),
    rule({ field: "amount", operator: "gt", values: [""] }),
  ])
  const { query, dropped } = buildFilterQuery(tree, FIELDS)
  assert.equal(query.children.length, 1)
  assert.equal(dropped.length, 1)
  assert.deepEqual(
    { field: dropped[0].field, issue: dropped[0].issue },
    { field: "amount", issue: "missing_value" }
  )
})

test("a filter with nothing usable in it is null, not an empty match", () => {
  const { query, dropped } = buildFilterQuery(group([rule({ field: "name", values: [""] })]), FIELDS)
  assert.equal(query, null)
  assert.equal(dropped.length, 1)
})

test("an empty builder produces no filter and reports nothing wrong", () => {
  const { query, dropped } = buildFilterQuery(group([]), FIELDS)
  assert.equal(query, null)
  assert.deepEqual(dropped, [])
})

// ------------------------------------------------- nesting, bounded

test("the default depth allows one level of nesting and no more", () => {
  assert.equal(canAddGroupAtDepth(0, 2), true)
  assert.equal(canAddGroupAtDepth(1, 2), false)
  assert.equal(canAddGroupAtDepth(1, 3), true)
  assert.equal(canAddGroupAtDepth(2, 3), false)
})

test("depth is measured from the outermost group", () => {
  const nested = group([rule({}), group([rule({})], "or")])
  assert.equal(treeDepth(nested), 2)
  assert.equal(treeDepth(group([rule({})])), 1)
  assert.equal(nodeDepth(nested, nested.children[1].id), 1)
  assert.equal(nodeDepth(nested, nested.children[1].children[0].id), 2)
  assert.equal(nodeDepth(nested, "absent"), -1)
})

test("a group that loses its last row goes with it", () => {
  const inner = group([rule({ field: "name" })], "or")
  const tree = group([rule({ field: "amount" }), inner])
  const after = replaceNode(tree, inner.children[0].id, null)
  assert.equal(after.children.length, 1)
  assert.equal(after.children[0].kind, "rule")
  // An empty group is not left behind: it selects everything and reads as a box with no condition.
  assert.equal(findNode(after, inner.id), undefined)
})

test("the outermost group survives losing its last row", () => {
  const only = rule({ field: "name" })
  const after = replaceNode(group([only]), only.id, null)
  assert.equal(after.children.length, 0)
  assert.equal(after.kind, "group")
})

test("a group holding one row collapses in the query", () => {
  const tree = group([group([rule({ field: "name", operator: "contains", values: ["a"] })], "or")])
  const { query } = buildFilterQuery(tree, FIELDS)
  // and(or(x)) and x select the same rows; the query says the shorter one.
  assert.deepEqual(query, {
    op: "and",
    children: [{ field: "name", operator: "contains", values: ["a"] }],
  })
})

test("nesting survives into the query with both conjunctions intact", () => {
  const tree = group(
    [
      rule({ field: "status", operator: "eq", values: ["open"] }),
      group(
        [
          rule({ field: "amount", operator: "gte", values: ["100"] }),
          rule({ field: "amount", operator: "lte", values: ["5"] }),
        ],
        "or"
      ),
    ],
    "and"
  )
  const { query } = buildFilterQuery(tree, FIELDS)
  assert.deepEqual(query, {
    op: "and",
    children: [
      { field: "status", operator: "eq", values: ["open"] },
      {
        op: "or",
        children: [
          { field: "amount", operator: "gte", values: ["100"] },
          { field: "amount", operator: "lte", values: ["5"] },
        ],
      },
    ],
  })
})

test("appendChild and setConjunction reach a nested group", () => {
  const inner = group([rule({})], "or")
  const tree = group([inner])
  const added = appendChild(tree, inner.id, rule({ field: "amount" }))
  assert.equal(findNode(added, inner.id).children.length, 2)
  const flipped = setConjunction(added, inner.id, "and")
  assert.equal(findNode(flipped, inner.id).conjunction, "and")
  // The root is untouched by a change to a child.
  assert.equal(flipped.conjunction, "and")
  assert.equal(countRules(flipped), 2)
})

test("an edit returns a new root, so a render can tell something changed", () => {
  const tree = group([rule({ field: "name" })])
  const after = appendChild(tree, tree.id, rule({ field: "amount" }))
  assert.notEqual(after, tree)
  assert.equal(tree.children.length, 1)
})

// ------------------------------------------------- the query in a URL

test("a value carrying the structural characters survives the round trip", () => {
  const tree = group([
    rule({ field: "name", operator: "eq", values: ['A, B (2kg): 50% | "x" \\ y'] }),
    rule({ field: "status", operator: "in", values: ["open", "clo,sed"] }),
  ])
  const text = toFilterParam(tree)
  const back = parseFilterParam(text, ids)
  assert.deepEqual(shape(back), shape(tree))
})

test("the encoding is readable, not opaque", () => {
  const tree = group(
    [
      rule({ field: "status", operator: "eq", values: ["open"] }),
      rule({ field: "amount", operator: "gte", values: ["100"] }),
    ],
    "and"
  )
  assert.equal(toFilterParam(tree), "and(status:eq:open,amount:gte:100)")
})

test("escaping only touches the characters that are structural", () => {
  assert.equal(escapeFilterSegment("plain"), "plain")
  assert.equal(escapeFilterSegment("a:b"), "a\\:b")
  assert.equal(escapeFilterSegment("a(b)"), "a\\(b\\)")
  assert.equal(escapeFilterSegment("a\\b"), "a\\\\b")
})

test("nesting and the value-less operators round trip", () => {
  const tree = group(
    [
      rule({ field: "name", operator: "is_empty", values: [] }),
      group([rule({ field: "amount", operator: "between", values: ["1", "2"] })], "or"),
    ],
    "or"
  )
  const back = parseFilterParam(toFilterParam(tree), ids)
  assert.deepEqual(shape(back), shape(tree))
})

test("an empty group round trips", () => {
  const back = parseFilterParam("and()", ids)
  assert.deepEqual(shape(back), { kind: "group", conjunction: "and", children: [] })
})

test("a bare rule arrives wrapped, so there is always a group to add to", () => {
  const back = parseFilterParam("name:eq:acme", ids)
  assert.equal(back.kind, "group")
  assert.equal(back.children.length, 1)
  assert.equal(back.children[0].field, "name")
})

test("unicode and an empty value survive", () => {
  const tree = group([
    rule({ field: "名前", operator: "eq", values: ["アクメ商会"] }),
    rule({ field: "name", operator: "in", values: ["", "b"] }),
  ])
  assert.deepEqual(shape(parseFilterParam(toFilterParam(tree), ids)), shape(tree))
})

test("a URL that cannot be read loads nothing rather than half a filter", () => {
  for (const bad of [
    "",
    "   ",
    "name",
    "name:",
    "name:nonsense:x",
    "xor(name:eq:a)",
    "and(name:eq:a",
    "and(name:eq:a))",
    "and(name:eq:a)junk",
    "and(,)",
    // `between` wants two values and was handed one: a filter that loads as complete and compares
    // against a bound that is not there.
    "amount:between:10",
    "amount:between:10|20|30",
    // `is_empty` takes no value, so a value here means the string was built by something else.
    "name:is_empty:x",
    // and the reverse: an operator that needs a value, with the value section missing.
    "name:eq",
  ]) {
    assert.equal(parseFilterParam(bad, ids), null, `should not parse: ${JSON.stringify(bad)}`)
  }
})

test("a list operator accepts any number of values from a URL", () => {
  const back = parseFilterParam("status:in:open|closed|other", ids)
  assert.deepEqual(back.children[0].values, ["open", "closed", "other"])
})

test("the URL form is the editor's state, not the pruned query", () => {
  // A draft with an unfinished row has to survive a reload, or the row the person was in the
  // middle of typing vanishes when they share the link with themselves.
  const tree = group([rule({ field: "amount", operator: "gt", values: [""] })])
  const back = parseFilterParam(toFilterParam(tree), ids)
  assert.deepEqual(shape(back), shape(tree))
  assert.equal(buildFilterQuery(back, FIELDS).query, null)
})

// ------------------------------------------------- the filter in words

test("the sentence uses the field's label and the operator's spelling for that kind", () => {
  const tree = group([
    rule({ field: "signed_up", operator: "gt", values: ["2026-01-01"] }),
    rule({ field: "status", operator: "eq", values: ["open"] }),
  ])
  assert.equal(
    describeFilter(tree, FIELDS),
    "Signed up is after 2026-01-01 and Status is Open"
  )
})

test("a range reads as a range and a nested group is bracketed", () => {
  const tree = group(
    [
      rule({ field: "amount", operator: "between", values: ["1", "9"] }),
      group(
        [
          rule({ field: "name", operator: "contains", values: ["a"] }),
          rule({ field: "name", operator: "contains", values: ["b"] }),
        ],
        "or"
      ),
    ],
    "and"
  )
  assert.equal(
    describeFilter(tree, FIELDS),
    "Amount is between 1 and 9 and (Name contains a or Name contains b)"
  )
})

test("an operator with no value reads without one", () => {
  assert.equal(
    describeFilter(group([rule({ field: "name", operator: "is_empty", values: [] })]), FIELDS),
    "Name is empty"
  )
})

// ------------------------------------------------- the editor

const renderBuilder = (props = {}) => render(FilterBuilder, { fields: FIELDS, ...props })

test("an empty builder says so and offers a first condition", () => {
  const view = renderBuilder()
  const text = texts(view.tree)
  assert.ok(text.includes(defaultFilterBuilderLabels.empty))
  assert.ok(text.includes(defaultFilterBuilderLabels.addCondition))
})

test("adding a condition adds a row built on the first field", () => {
  let latest = null
  const view = renderBuilder({ onChange: (next) => (latest = next) })
  const add = buttonWith(view.tree, defaultFilterBuilderLabels.addCondition)
  add.props.onClick()
  view.rerender()
  assert.equal(countRules(latest), 1)
  assert.equal(latest.children[0].field, "name")
  assert.equal(labelled(walk(view.tree), defaultFilterBuilderLabels.field(1)).length, 1)
})

test("one conjunction select per group, however many rows there are", () => {
  const view = renderBuilder({
    defaultValue: group([rule({}), rule({ field: "amount" }), rule({ field: "status" })]),
  })
  const selects = labelled(walk(view.tree), defaultFilterBuilderLabels.conjunction)
  // A select on every row writes "A and B or C", which has no single reading.
  assert.equal(selects.length, 1)
})

test("the conjunction select changes the whole group", () => {
  let latest = null
  const tree = group([rule({}), rule({ field: "amount" })])
  const view = renderBuilder({ defaultValue: tree, onChange: (next) => (latest = next) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.conjunction)[0]
  assert.equal(select.props.value, "and")
  select.props.onChange({ target: { value: "or" } })
  view.rerender()
  assert.equal(latest.conjunction, "or")
})

test("the field select carries every field and re-points the row", () => {
  let latest = null
  const tree = group([rule({ field: "name", operator: "contains", values: ["acme"] })])
  const view = renderBuilder({ defaultValue: tree, onChange: (next) => (latest = next) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.field(1))[0]
  const options = walk(select).filter((n) => n.type === "option").map((n) => n.props.value)
  for (const candidate of FIELDS) assert.ok(options.includes(candidate.name))
  select.props.onChange({ target: { value: "amount" } })
  view.rerender()
  assert.equal(latest.children[0].field, "amount")
  assert.notEqual(latest.children[0].operator, "contains")
  assert.deepEqual(latest.children[0].values, [""])
})

test("the operator select offers only what the row's field supports", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "signed_up", operator: "gt", values: ["2026-01-01"] })]) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.operator(1))[0]
  const offered = walk(select).filter((n) => n.type === "option").map((n) => n.props.value)
  assert.ok(offered.includes("between"))
  assert.ok(!offered.includes("contains"))
})

test("between draws two value boxes and is_empty draws none", () => {
  const view = renderBuilder({
    defaultValue: group([rule({ field: "amount", operator: "between", values: ["1", "2"] })]),
  })
  const nodes = walk(view.tree)
  assert.equal(labelled(nodes, defaultFilterBuilderLabels.value(1, 1, 2)).length, 1)
  assert.equal(labelled(nodes, defaultFilterBuilderLabels.value(1, 2, 2)).length, 1)

  const empty = renderBuilder({
    defaultValue: group([rule({ field: "name", operator: "is_empty", values: [] })]),
  })
  const inputs = byTag(walk(empty.tree), "input")
  assert.equal(inputs.length, 0)
})

test("a list operator draws a box per value and can grow", () => {
  let latest = null
  const view = renderBuilder({
    defaultValue: group([rule({ field: "name", operator: "in", values: ["a", "b"] })]),
    onChange: (next) => (latest = next),
  })
  assert.equal(byTag(walk(view.tree), "input").length, 2)
  const addValue = buttonWith(view.tree, defaultFilterBuilderLabels.addValue)
  addValue.props.onClick()
  view.rerender()
  assert.deepEqual(latest.children[0].values, ["a", "b", ""])
})

test("the last value of a list keeps its remove button but will not act", () => {
  let calls = 0
  const view = renderBuilder({
    defaultValue: group([rule({ field: "name", operator: "in", values: ["a"] })]),
    onChange: () => (calls += 1),
  })
  const remove = labelled(walk(view.tree), defaultFilterBuilderLabels.removeValue(1, 1))[0]
  assert.equal(remove.props["aria-disabled"], true)
  remove.props.onClick()
  assert.equal(calls, 0)
})

test("a number box is a text box with a numeric keypad, not type=number", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["10"] })]) })
  const input = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  // type="number" discards what it cannot parse before the component sees it, so "1," becomes an
  // empty box and the row reports a value that was never missing.
  assert.equal(input.props.type, "text")
  assert.equal(input.props.inputMode, "decimal")
})

test("a date box is a date box", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "signed_up", operator: "gt", values: [""] })]) })
  const input = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.equal(input.props.type, "date")
})

test("an enum draws its options with their labels", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "status", operator: "eq", values: ["open"] })]) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  const options = walk(select).filter((n) => n.type === "option")
  assert.deepEqual(options.map((n) => n.props.value), ["open", "closed"])
  assert.deepEqual(options.map((n) => n.props.children), ["Open", "Closed"])
})

test("a boolean select shows only values it accepts, and starts on one of them", () => {
  const view = renderBuilder({ defaultValue: group([createRule(field("active"), ids)]) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.deepEqual(
    walk(select).filter((n) => n.type === "option").map((n) => n.props.value),
    ["true", "false"]
  )
  // The select cannot show a blank, so the value behind it must not be one.
  assert.equal(select.props.value, "true")
})

test("an unfinished row marks its box invalid and points at the reason", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["abc"] })]) })
  const nodes = walk(view.tree)
  const input = labelled(nodes, defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.equal(input.props["aria-invalid"], true)
  const describedBy = input.props["aria-describedby"]
  assert.ok(describedBy)
  const message = nodes.find((n) => n.props?.id === describedBy)
  assert.equal(message.props.children, defaultFilterBuilderLabels.issue.invalid_number)
})

test("a complete row marks nothing invalid", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["10"] })]) })
  const input = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.equal(input.props["aria-invalid"], undefined)
  assert.equal(input.props["aria-describedby"], undefined)
})

test("the reason a row cannot be used is not a live region", () => {
  // Announcing it while the box is still being typed into interrupts the typing; it is reached
  // through aria-describedby instead.
  const view = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["abc"] })]) })
  const live = walk(view.tree).filter((n) => n.props?.["aria-live"])
  assert.equal(live.length, 1)
  assert.equal(live[0].props.className, "sr-only")
})

test("adding and removing a row is announced", () => {
  const view = renderBuilder({ defaultValue: group([rule({}), rule({ field: "amount" })]) })
  const remove = labelled(walk(view.tree), defaultFilterBuilderLabels.removeCondition(2))[0]
  remove.props.onClick()
  view.rerender()
  const live = walk(view.tree).find((n) => n.props?.["aria-live"])
  assert.equal(live.props.children, defaultFilterBuilderLabels.removed(2, 1))
})

test("every control in a row is named, and the names say which row", () => {
  const view = renderBuilder({ defaultValue: group([rule({}), rule({ field: "amount", operator: "between", values: ["1", "2"] })]) })
  const nodes = walk(view.tree)
  for (const label of [
    defaultFilterBuilderLabels.field(1),
    defaultFilterBuilderLabels.operator(1),
    defaultFilterBuilderLabels.value(1, 1, 1),
    defaultFilterBuilderLabels.field(2),
    defaultFilterBuilderLabels.operator(2),
    defaultFilterBuilderLabels.value(2, 1, 2),
    defaultFilterBuilderLabels.value(2, 2, 2),
    defaultFilterBuilderLabels.removeCondition(1),
    defaultFilterBuilderLabels.removeCondition(2),
  ]) {
    assert.equal(labelled(nodes, label).length, 1, `expected exactly one control named ${label}`)
  }
  for (const control of [...byTag(nodes, "select"), ...byTag(nodes, "input"), ...byTag(nodes, "button")]) {
    const named = control.props["aria-label"] || control.props.children
    assert.ok(named, "a control with no accessible name")
  }
})

test("a nested group is a labelled group and is removable as one", () => {
  const inner = group([rule({ field: "amount" })], "or")
  const view = renderBuilder({ defaultValue: group([rule({}), inner]) })
  const nodes = walk(view.tree)
  const box = nodes.find((n) => n.props?.role === "group")
  assert.equal(box.props["aria-label"], defaultFilterBuilderLabels.group(2, "or"))
  assert.equal(labelled(nodes, defaultFilterBuilderLabels.removeGroup(2)).length, 1)
})

test("a new group is offered the other conjunction, because repeating the parent's changes nothing", () => {
  let latest = null
  const view = renderBuilder({ defaultValue: group([rule({})], "and"), onChange: (next) => (latest = next) })
  const addGroup = buttonWith(view.tree, defaultFilterBuilderLabels.addGroup)
  addGroup.props.onClick()
  view.rerender()
  const added = latest.children.find((child) => child.kind === "group")
  assert.equal(added.conjunction, "or")
  assert.equal(added.children.length, 1)
})

test("at the deepest allowed level the group button is not drawn", () => {
  const inner = group([rule({ field: "amount" })], "or")
  const view = renderBuilder({ defaultValue: group([rule({}), inner]), maxDepth: 2 })
  const groupButtons = walk(view.tree).filter(
    (n) => n.type === "button" && n.props?.children?.includes?.(defaultFilterBuilderLabels.addGroup)
  )
  // One for the outer group, none inside the nested one.
  assert.equal(groupButtons.length, 1)

  const deeper = renderBuilder({ defaultValue: group([rule({}), inner]), maxDepth: 3 })
  assert.equal(
    walk(deeper.tree).filter(
      (n) => n.type === "button" && n.props?.children?.includes?.(defaultFilterBuilderLabels.addGroup)
    ).length,
    2
  )
})

test("maxRules stops the add buttons without hiding them", () => {
  const view = renderBuilder({ defaultValue: group([rule({})]), maxRules: 1 })
  const add = buttonWith(view.tree, defaultFilterBuilderLabels.addCondition)
  assert.equal(add.props["aria-disabled"], true)
})

test("a controlled builder does not move on its own", () => {
  const tree = group([rule({})])
  const view = render(FilterBuilder, {
    fields: FIELDS,
    value: tree,
    onChange: () => {},
  })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.field(1))[0]
  select.props.onChange({ target: { value: "amount" } })
  view.rerender()
  // The value prop is still the old tree, so the row has not changed — the owner decides.
  assert.equal(labelled(walk(view.tree), defaultFilterBuilderLabels.field(1))[0].props.value, "name")
})

test("disabled reaches the fieldset and the controls", () => {
  const view = renderBuilder({ defaultValue: group([rule({})]), disabled: true })
  assert.equal(view.tree.props.disabled, true)
  for (const control of byTag(walk(view.tree), "select")) assert.equal(control.props.disabled, true)
})

test("the legend is rendered when given and absent when not", () => {
  const withLegend = renderBuilder({ legend: "Audience" })
  assert.equal(byTag(walk(withLegend.tree), "legend")[0].props.children, "Audience")
  assert.equal(byTag(walk(renderBuilder().tree), "legend").length, 0)
})

test("labels can be replaced one at a time", () => {
  const view = renderBuilder({ defaultValue: group([rule({})]), labels: { where: "Show rows where" } })
  assert.ok(texts(view.tree).includes("Show rows where"))
  // The ones not overridden stay.
  assert.ok(labelled(walk(view.tree), defaultFilterBuilderLabels.field(1)).length === 1)
})

// ------------------------------------------------- the table itself
//
// The block below exists because mutation testing found the operator table almost entirely
// unheld: changing which kinds an operator serves, or how many values it takes, left every test
// above passing. The table is not an implementation detail — it is the component's contract with
// the field definitions a caller writes — so it is pinned entry by entry.

test("each kind's menu is exactly this, in this order", () => {
  const menu = (kind) => operatorsForField({ name: "x", kind, options: [{ value: "a" }] }).map((s) => s.id)
  assert.deepEqual(menu("text"), [
    "eq",
    "ne",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ])
  assert.deepEqual(menu("number"), [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ])
  assert.deepEqual(menu("date"), [
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "is_empty",
    "is_not_empty",
  ])
  assert.deepEqual(menu("boolean"), ["eq", "ne", "is_empty", "is_not_empty"])
  assert.deepEqual(menu("enum"), ["eq", "ne", "in", "not_in", "is_empty", "is_not_empty"])
  // A field with no kind is text, so a caller can leave it off.
  assert.deepEqual(menu(undefined), menu("text"))
})

test("each operator takes exactly this many values", () => {
  assert.deepEqual(
    FILTER_OPERATORS.map((spec) => [spec.id, spec.arity]),
    [
      ["eq", 1],
      ["ne", 1],
      ["contains", 1],
      ["not_contains", 1],
      ["starts_with", 1],
      ["ends_with", 1],
      ["gt", 1],
      ["gte", 1],
      ["lt", 1],
      ["lte", 1],
      ["between", 2],
      ["in", "many"],
      ["not_in", "many"],
      ["is_empty", 0],
      ["is_not_empty", 0],
    ]
  )
})

test("the date spellings are on the four comparisons and nowhere else", () => {
  const dated = FILTER_OPERATORS.filter((spec) => spec.labelByKind?.date).map((spec) => [
    spec.id,
    spec.labelByKind.date,
  ])
  assert.deepEqual(dated, [
    ["gt", "is after"],
    ["gte", "is on or after"],
    ["lt", "is before"],
    ["lte", "is on or before"],
  ])
})

// ------------------------------------------------- the edges the mutants found

test("a date in December, and on the 31st, is a date", () => {
  assert.equal(isPlainDate("2026-12-31"), true)
  assert.equal(isPlainDate("2026-01-01"), true)
  assert.equal(isPlainDate("2026-13-01"), false)
  assert.equal(isPlainDate("2026-00-10"), false)
  assert.equal(isPlainDate("2026-11-32"), false)
  assert.equal(isPlainDate("2026-11-00"), false)
})

test("false is as valid a boolean as true", () => {
  assert.equal(valueIsValid("false", field("active")), true)
  assert.equal(valueIsValid("TRUE", field("active")), false)
  assert.equal(valueIsValid("1", field("active")), false)
})

test("a blank is never a valid value, whatever the kind", () => {
  for (const name of ["name", "amount", "signed_up", "active", "status"]) {
    assert.equal(valueIsValid("", field(name)), false, `blank passed for ${name}`)
    assert.equal(valueIsValid("  ", field(name)), false, `whitespace passed for ${name}`)
  }
})

test("a boolean outside true/false is a bad option, not a missing value", () => {
  assert.equal(
    ruleIssue(rule({ field: "active", operator: "eq", values: ["yes"] }), FIELDS),
    "invalid_option"
  )
})

test("a list operator ignores the blank slots it is left with", () => {
  // The designed behaviour: a list row is usable as soon as one value is filled in, and the empty
  // boxes beside it are not conditions.
  const partly = rule({ field: "name", operator: "in", values: ["a", ""] })
  assert.equal(ruleIssue(partly, FIELDS), "ok")
  const { query } = buildFilterQuery(group([partly]), FIELDS)
  assert.deepEqual(query.children[0].values, ["a"])
  // All blank is still nothing to filter on.
  assert.equal(
    ruleIssue(rule({ field: "name", operator: "in", values: ["", ""] }), FIELDS),
    "missing_value"
  )
})

test("a list operator keeps every value it was given, not the first two", () => {
  const many = rule({ field: "name", operator: "in", values: ["a", "b", "c", "d"] })
  const { query } = buildFilterQuery(group([many]), FIELDS)
  assert.deepEqual(query.children[0].values, ["a", "b", "c", "d"])
})

test("a range the right way round is fine, and so is one with equal bounds", () => {
  // Equal bounds are a single-value range, which is a filter a person is entitled to build; it is
  // not the backwards case.
  for (const values of [
    ["10", "20"],
    ["10", "10"],
    ["-5", "0"],
  ]) {
    assert.equal(
      ruleIssue(rule({ field: "amount", operator: "between", values }), FIELDS),
      "ok",
      `${values.join("..")} should be usable`
    )
  }
  assert.equal(
    ruleIssue(
      rule({ field: "signed_up", operator: "between", values: ["2026-01-01", "2026-01-01"] }),
      FIELDS
    ),
    "ok"
  )
  assert.equal(
    ruleIssue(
      rule({ field: "signed_up", operator: "between", values: ["2026-01-01", "2026-12-31"] }),
      FIELDS
    ),
    "ok"
  )
})

test("a range is only checked for direction on the kinds that have one", () => {
  // Two text values are not an ordered pair, and `between` is not offered on text — but the check
  // must not fire on anything that is not a number or a date.
  const spec = operatorsForField(field("name")).map((s) => s.id)
  assert.ok(!spec.includes("between"))
})

test("a bare rule handed in without a group is wrapped and joined with and", () => {
  const single = rule({ field: "name", operator: "contains", values: ["a"] })
  const { query } = buildFilterQuery(single, FIELDS)
  assert.deepEqual(query, {
    op: "and",
    children: [{ field: "name", operator: "contains", values: ["a"] }],
  })
})

test("a bare rule parsed from a URL is wrapped in an and group", () => {
  assert.equal(parseFilterParam("name:eq:acme", ids).conjunction, "and")
})

test("a value ending in a backslash survives the round trip", () => {
  // A trailing escape is the classic place an escaped parser walks off the end of the string.
  for (const value of ["ends with\\", "\\", "\\\\", "a\\|b"]) {
    const tree = group([rule({ field: "name", operator: "eq", values: [value] })])
    const back = parseFilterParam(toFilterParam(tree), ids)
    assert.deepEqual(shape(back), shape(tree), `lost: ${JSON.stringify(value)}`)
  }
})

test("a list reads as a list and a two-value range reads as a range", () => {
  assert.equal(
    describeFilter(group([rule({ field: "name", operator: "in", values: ["a", "b"] })]), FIELDS),
    "Name is any of a, b"
  )
  assert.equal(
    describeFilter(group([rule({ field: "amount", operator: "between", values: ["1", "9"] })]), FIELDS),
    "Amount is between 1 and 9"
  )
})

test("a group holding one row is not bracketed in the sentence", () => {
  const tree = group(
    [
      rule({ field: "name", operator: "contains", values: ["a"] }),
      group([rule({ field: "amount", operator: "gt", values: ["1"] })], "or"),
    ],
    "and"
  )
  assert.equal(describeFilter(tree, FIELDS), "Name contains a and Amount is greater than 1")
})

test("a row with no field chosen still reads as something", () => {
  assert.equal(
    describeFilter(group([rule({ field: "", operator: "is_empty", values: [] })]), FIELDS),
    "(no field) is empty"
  )
})

test("the accessible names say all or any, and count in singular and plural", () => {
  // Pinned as literals rather than against the label functions: a test that compares the rendered
  // name with the same function that produced it cannot see the function change.
  assert.equal(defaultFilterBuilderLabels.group(2, "and"), "Condition group 2, matching all of")
  assert.equal(defaultFilterBuilderLabels.group(2, "or"), "Condition group 2, matching any of")
  assert.equal(defaultFilterBuilderLabels.removed(2, 1), "Condition 2 removed, 1 condition left")
  assert.equal(defaultFilterBuilderLabels.removed(1, 3), "Condition 1 removed, 3 conditions left")
  assert.equal(defaultFilterBuilderLabels.value(2, 1, 2), "Value 1 for condition 2")
  assert.equal(defaultFilterBuilderLabels.value(2, 1, 1), "Value for condition 2")
  assert.equal(defaultFilterBuilderLabels.where, "Where")
  assert.equal(defaultFilterBuilderLabels.and, "and")
  assert.equal(defaultFilterBuilderLabels.or, "or")
})

test("every edit says what kind of edit it was", () => {
  const seen = []
  const tree = group([rule({}), rule({ field: "amount" })])
  const view = renderBuilder({ defaultValue: tree, onChange: (_, change) => seen.push(change.type) })

  buttonWith(view.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  view.rerender()
  buttonWith(view.tree, defaultFilterBuilderLabels.addGroup).props.onClick()
  view.rerender()
  labelled(walk(view.tree), defaultFilterBuilderLabels.conjunction)[0].props.onChange({
    target: { value: "or" },
  })
  view.rerender()
  labelled(walk(view.tree), defaultFilterBuilderLabels.field(1))[0].props.onChange({
    target: { value: "amount" },
  })
  view.rerender()
  labelled(walk(view.tree), defaultFilterBuilderLabels.removeCondition(1))[0].props.onClick()
  view.rerender()

  // The change type is API: a caller switching on it to decide what to re-fetch sees these names.
  assert.deepEqual(seen, ["add-rule", "add-group", "conjunction", "update", "remove"])
})

test("adding a row announces which row it was", () => {
  const view = renderBuilder({ defaultValue: group([rule({})]) })
  buttonWith(view.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  view.rerender()
  const live = walk(view.tree).find((n) => n.props?.["aria-live"])
  assert.equal(live.props.children, "Condition 2 added")
})

test("a group added inside an or group opens on and", () => {
  let latest = null
  const view = renderBuilder({ defaultValue: group([rule({})], "or"), onChange: (next) => (latest = next) })
  buttonWith(view.tree, defaultFilterBuilderLabels.addGroup).props.onClick()
  view.rerender()
  assert.equal(latest.children.find((child) => child.kind === "group").conjunction, "and")
})

test("a two-value range is two boxes, not a growable list", () => {
  // The distinguishing mark: the list editor carries an Add value button and the range does not.
  const range = renderBuilder({
    defaultValue: group([rule({ field: "amount", operator: "between", values: ["1", "2"] })]),
  })
  assert.equal(buttonWith(range.tree, defaultFilterBuilderLabels.addValue), undefined)
  const list = renderBuilder({
    defaultValue: group([rule({ field: "name", operator: "in", values: ["a"] })]),
  })
  assert.ok(buttonWith(list.tree, defaultFilterBuilderLabels.addValue))
})

test("a single-value operator is one box and no range joiner", () => {
  const view = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "gt", values: ["1"] })]) })
  assert.equal(byTag(walk(view.tree), "input").length, 1)
  assert.equal(buttonWith(view.tree, defaultFilterBuilderLabels.addValue), undefined)
})

test("the boolean options read as their values", () => {
  const view = renderBuilder({ defaultValue: group([createRule(field("active"), ids)]) })
  const select = labelled(walk(view.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.deepEqual(
    walk(select).filter((n) => n.type === "option").map((n) => n.props.children),
    ["true", "false"]
  )
})

// The second mutation pass left these: defaults and minted ids that nothing was holding in place.

test("minted ids are different every time", () => {
  // Two rows sharing a key is the bug this component exists to avoid: remove a row in the middle
  // and the value typed into the row below appears against a field nobody chose.
  const seen = new Set([createFilterId(), createFilterId(), createFilterId()])
  assert.equal(seen.size, 3)
  const tree = group([])
  const a = createRule(field("name"))
  const b = createRule(field("name"))
  assert.notEqual(a.id, b.id)
  assert.equal(findNode(appendChild(appendChild(tree, tree.id, a), tree.id, b), b.id).id, b.id)
})

test("a new rule opens on the first operator its field offers", () => {
  assert.equal(createRule(field("name"), ids).operator, "eq")
  assert.equal(createRule(field("amount"), ids).operator, "eq")
  assert.equal(
    createRule({ name: "amount", kind: "number", operators: ["between", "eq"] }, ids).operator,
    "between"
  )
  // A field that offers nothing its kind can draw still produces a usable row rather than a blank.
  assert.equal(createRule({ name: "x", kind: "number", operators: [] }, ids).operator, "eq")
  assert.equal(createRule(undefined, ids).field, "")
})

test("a group joins with and unless told otherwise", () => {
  assert.equal(createGroup().conjunction, "and")
  assert.equal(createGroup("or").conjunction, "or")
  assert.deepEqual(createGroup().children, [])
})

test("a builder started with nothing joins its rows with and", () => {
  let latest = null
  const view = renderBuilder({ onChange: (next) => (latest = next) })
  buttonWith(view.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  view.rerender()
  buttonWith(view.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  view.rerender()
  assert.equal(latest.conjunction, "and")
  assert.equal(labelled(walk(view.tree), defaultFilterBuilderLabels.conjunction)[0].props.value, "and")
})

test("a new group's first row is built on the first field, and the add is announced", () => {
  let latest = null
  const view = renderBuilder({ defaultValue: group([rule({})]), onChange: (next) => (latest = next) })
  buttonWith(view.tree, defaultFilterBuilderLabels.addGroup).props.onClick()
  view.rerender()
  const added = latest.children.find((child) => child.kind === "group")
  assert.equal(added.children[0].field, FIELDS[0].name)
  const live = walk(view.tree).find((n) => n.props?.["aria-live"])
  assert.equal(live.props.children, "Group 2 added")
})

test("a dangling escape at the end of a URL is read as the character itself", () => {
  // Not a crash and not an "undefined" appended to the value: a hand-edited link that ends mid
  // escape is the one input here that nothing generated.
  const back = parseFilterParam("name:eq:a\\", ids)
  assert.deepEqual(back.children[0].values, ["a\\"])
})

test("the counter-based id factory is what the component uses by default", () => {
  // Nothing is passed to it here, so the ids come from the module counter — two builders on one
  // page must not mint the same key.
  const first = renderBuilder()
  buttonWith(first.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  const second = renderBuilder()
  buttonWith(second.tree, defaultFilterBuilderLabels.addCondition).props.onClick()
  first.rerender()
  second.rerender()
  const keyOf = (view) =>
    walk(view.tree).find((n) => n.props?.["aria-label"] === defaultFilterBuilderLabels.field(1))
  assert.ok(keyOf(first))
  assert.ok(keyOf(second))
})

test("an unusable box is marked for sighted readers too, not only for screen readers", () => {
  // aria-invalid is the half a screen reader hears; the border is the half everyone else sees, and
  // a row that announces a problem it does not show is only half reported.
  const bad = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["abc"] })]) })
  const box = labelled(walk(bad.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.match(box.props.className, /border-destructive/)
  const good = renderBuilder({ defaultValue: group([rule({ field: "amount", operator: "eq", values: ["10"] })]) })
  const fine = labelled(walk(good.tree), defaultFilterBuilderLabels.value(1, 1, 1))[0]
  assert.doesNotMatch(fine.props.className, /border-destructive/)
})
