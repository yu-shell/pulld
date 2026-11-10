"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The kind of value a field holds, which is what decides the operators it can be compared with.
 *
 * This is deliberately a short list rather than a mirror of a database's type system: the thing a
 * filter row needs to know is how many value slots to draw and what counts as a filled-in value,
 * and `varchar` / `text` / `citext` all answer that the same way.
 */
export type FilterFieldKind = "text" | "number" | "date" | "boolean" | "enum"

export interface FilterFieldOption {
  value: string
  label?: string
}

export interface FilterField {
  /** Sent to the server. Stable; not shown to anyone. */
  name: string
  /** Shown in the field menu. Falls back to `name`. */
  label?: string
  /** Defaults to `"text"`, the kind with the fewest assumptions baked in. */
  kind?: FilterFieldKind
  /** Required for `kind: "enum"` — the only values the field accepts. */
  options?: readonly FilterFieldOption[]
  /**
   * Narrows the operator menu to these, in this order. Anything here that the kind does not
   * support is ignored rather than drawn, because an operator with no value editor behind it is
   * a row that cannot be completed.
   */
  operators?: readonly FilterOperatorId[]
}

export type FilterOperatorId =
  | "eq"
  | "ne"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "not_in"
  | "is_empty"
  | "is_not_empty"

/**
 * How many value slots an operator takes. `"many"` is a list of one or more.
 *
 * This is the number the value editor is built from, and it is the reason an operator change has
 * to touch the values rather than only the label: `between` holds two, `is any of` holds a list,
 * and `is empty` holds none. See `coerceValues`.
 */
export type FilterArity = 0 | 1 | 2 | "many"

export interface FilterOperatorSpec {
  id: FilterOperatorId
  arity: FilterArity
  /** The kinds that offer this operator at all. */
  kinds: readonly FilterFieldKind[]
  label: string
  /**
   * The label for kinds that say it differently. The id is what the server sees, so `gt` on a date
   * is still `gt` — but a person reading "greater than" over a date picker has to translate, and
   * "after" is the same operator spelled the way the field is thought about.
   */
  labelByKind?: Partial<Record<FilterFieldKind, string>>
}

/**
 * Every operator this component can draw, in menu order.
 *
 * Ordered so the two that need no value at all sit at the end: they are the rows that look broken
 * when they land in the middle of a list of comparisons, and they are reached for least often.
 */
export const FILTER_OPERATORS: readonly FilterOperatorSpec[] = [
  { id: "eq", arity: 1, kinds: ["text", "number", "date", "boolean", "enum"], label: "is" },
  { id: "ne", arity: 1, kinds: ["text", "number", "date", "boolean", "enum"], label: "is not" },
  { id: "contains", arity: 1, kinds: ["text"], label: "contains" },
  { id: "not_contains", arity: 1, kinds: ["text"], label: "does not contain" },
  { id: "starts_with", arity: 1, kinds: ["text"], label: "starts with" },
  { id: "ends_with", arity: 1, kinds: ["text"], label: "ends with" },
  {
    id: "gt",
    arity: 1,
    kinds: ["number", "date"],
    label: "is greater than",
    labelByKind: { date: "is after" },
  },
  {
    id: "gte",
    arity: 1,
    kinds: ["number", "date"],
    label: "is greater than or equal to",
    labelByKind: { date: "is on or after" },
  },
  {
    id: "lt",
    arity: 1,
    kinds: ["number", "date"],
    label: "is less than",
    labelByKind: { date: "is before" },
  },
  {
    id: "lte",
    arity: 1,
    kinds: ["number", "date"],
    label: "is less than or equal to",
    labelByKind: { date: "is on or before" },
  },
  { id: "between", arity: 2, kinds: ["number", "date"], label: "is between" },
  { id: "in", arity: "many", kinds: ["text", "number", "enum"], label: "is any of" },
  { id: "not_in", arity: "many", kinds: ["text", "number", "enum"], label: "is none of" },
  {
    id: "is_empty",
    arity: 0,
    kinds: ["text", "number", "date", "boolean", "enum"],
    label: "is empty",
  },
  {
    id: "is_not_empty",
    arity: 0,
    kinds: ["text", "number", "date", "boolean", "enum"],
    label: "is not empty",
  },
]

const OPERATOR_BY_ID = new Map(FILTER_OPERATORS.map((spec) => [spec.id, spec]))

export function operatorSpec(id: FilterOperatorId): FilterOperatorSpec | undefined {
  return OPERATOR_BY_ID.get(id)
}

export function fieldKind(field: FilterField | undefined): FilterFieldKind {
  return field?.kind ?? "text"
}

export function fieldLabel(field: FilterField | undefined): string {
  if (!field) return ""
  return field.label ?? field.name
}

/** The operators a field offers, in menu order, honouring its own `operators` narrowing. */
export function operatorsForField(field: FilterField | undefined): FilterOperatorSpec[] {
  const kind = fieldKind(field)
  const supported = FILTER_OPERATORS.filter((spec) => spec.kinds.includes(kind))
  if (!field?.operators) return supported
  // The field's order wins, because a field that lists its operators is saying which one a person
  // reaches for first. Unsupported entries drop out here rather than being drawn and then failing
  // to produce a value editor.
  const chosen: FilterOperatorSpec[] = []
  for (const id of field.operators) {
    if (chosen.some((spec) => spec.id === id)) continue
    const spec = supported.find((candidate) => candidate.id === id)
    if (spec) chosen.push(spec)
  }
  return chosen
}

/** The label an operator carries for a particular kind. */
export function operatorLabel(spec: FilterOperatorSpec, kind: FilterFieldKind): string {
  return spec.labelByKind?.[kind] ?? spec.label
}

export function operatorArity(id: FilterOperatorId): FilterArity {
  return OPERATOR_BY_ID.get(id)?.arity ?? 1
}

export type FilterConjunction = "and" | "or"

export interface FilterRule {
  id: string
  kind: "rule"
  /** A `FilterField["name"]`, or `""` for a row whose field has not been chosen yet. */
  field: string
  operator: FilterOperatorId
  /**
   * One entry per value slot. Always exactly as long as the operator's arity demands, so a value
   * dropped by an operator change is gone rather than hidden: an operator narrowed from `between`
   * to `gt` that kept `["10", "20"]` would send the 20 to the server, where nothing would use it
   * and everything would be entitled to.
   */
  values: string[]
}

export interface FilterGroup {
  id: string
  kind: "group"
  conjunction: FilterConjunction
  children: FilterNode[]
}

export type FilterNode = FilterRule | FilterGroup

export function isGroup(node: FilterNode): node is FilterGroup {
  return node.kind === "group"
}

export function isRule(node: FilterNode): node is FilterRule {
  return node.kind === "rule"
}

let idCounter = 0

/**
 * Mints a node id.
 *
 * React keys are the reason these exist: keying a row by its index makes the state of the row
 * below move up when a row in the middle is removed, which in a form means the value you typed
 * appears against a field you did not choose. The counter is module-level so two builders on one
 * page cannot collide.
 */
export function createFilterId(): string {
  idCounter += 1
  return `fb-${idCounter}`
}

export function createRule(
  field: FilterField | undefined,
  generateId: () => string = createFilterId
): FilterRule {
  const operators = operatorsForField(field)
  const operator = operators[0]?.id ?? "eq"
  return {
    id: generateId(),
    kind: "rule",
    field: field?.name ?? "",
    operator,
    values: blankValues(operatorArity(operator), field),
  }
}

export function createGroup(
  conjunction: FilterConjunction = "and",
  children: FilterNode[] = [],
  generateId: () => string = createFilterId
): FilterGroup {
  return { id: generateId(), kind: "group", conjunction, children }
}

/**
 * The value this kind starts a slot at.
 *
 * The kinds drawn as a select do not start blank, and that is not a convenience: a select holding
 * `""` shows its first option while the rule says no value was entered, so the row contradicts
 * itself — it reads as "Active" and reports "Enter a value". Starting at the first legal option
 * makes what is shown what is there. Text, numbers and dates start empty, because guessing one
 * would put a condition into the query that the person never typed.
 */
export function blankValue(field?: FilterField): string {
  switch (fieldKind(field)) {
    case "enum":
      return field?.options?.[0]?.value ?? ""
    case "boolean":
      return "true"
    default:
      return ""
  }
}

export function blankValues(arity: FilterArity, field?: FilterField): string[] {
  const blank = blankValue(field)
  if (arity === 0) return []
  if (arity === 1) return [blank]
  if (arity === 2) return [blank, blank]
  return [blank]
}

/**
 * Fits `values` to an arity, keeping what the new shape can hold.
 *
 * Truncating rather than stashing is the point — see the note on `FilterRule["values"]`.
 */
export function coerceValues(values: readonly string[], arity: FilterArity): string[] {
  if (arity === 0) return []
  if (arity === 1) return [values[0] ?? ""]
  if (arity === 2) return [values[0] ?? "", values[1] ?? ""]
  const kept = values.filter((value, index) => index === 0 || value !== "")
  return kept.length > 0 ? [...kept] : [""]
}

/**
 * Re-points a rule at a different field.
 *
 * Two things change and one of them is easy to miss. The operator has to be re-checked, because
 * `contains` does not exist on a number — that is the obvious half. The other half is the values:
 * they are only carried over when the new field is the same kind as the old one. "acme" surviving
 * a move from Company to Amount would make a rule that reads as complete and filters on a number
 * that is not one.
 */
export function retargetRule(
  rule: FilterRule,
  field: FilterField | undefined,
  previous: FilterField | undefined
): FilterRule {
  const operators = operatorsForField(field)
  const keptOperator = operators.find((spec) => spec.id === rule.operator)
  const operator = keptOperator?.id ?? operators[0]?.id ?? "eq"
  const arity = operatorArity(operator)
  const sameKind = fieldKind(field) === fieldKind(previous)
  if (!sameKind) {
    return { ...rule, field: field?.name ?? "", operator, values: blankValues(arity, field) }
  }
  const values = coerceValues(rule.values, arity)
  return {
    ...rule,
    field: field?.name ?? "",
    operator,
    // An enum's values are only meaningful against its own option list, so a move between two
    // enums drops whatever the new one does not offer. Replaced rather than emptied, so the row
    // stays complete the way it was.
    values:
      fieldKind(field) === "enum"
        ? values.map((value) =>
            field?.options?.some((option) => option.value === value) ? value : blankValue(field)
          )
        : values,
  }
}

/** Applies an operator change, fitting the values to the new arity. */
export function retargetOperator(rule: FilterRule, operator: FilterOperatorId): FilterRule {
  const arity = operatorArity(operator)
  if (operatorArity(rule.operator) === arity) return { ...rule, operator }
  return { ...rule, operator, values: coerceValues(rule.values, arity) }
}

export function isPlainNumber(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === "") return false
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return false
  return Number.isFinite(Number(trimmed))
}

/**
 * A `YYYY-MM-DD` date that exists.
 *
 * The regexp is not the check — `Date.parse("2026-02-30")` answers the 2nd of March rather than
 * failing, so a filter built on it silently moves the boundary the person typed. Building the date
 * and reading its parts back is what catches that.
 */
export function isPlainDate(text: string): boolean {
  const trimmed = text.trim()
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (!parts) return false
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const built = new Date(Date.UTC(year, month - 1, day))
  return (
    built.getUTCFullYear() === year &&
    built.getUTCMonth() === month - 1 &&
    built.getUTCDate() === day
  )
}

export function isBooleanValue(text: string): boolean {
  return text === "true" || text === "false"
}

/** Whether one value slot holds something the field's kind can be compared against. */
export function valueIsValid(value: string, field: FilterField | undefined): boolean {
  if (value.trim() === "") return false
  switch (fieldKind(field)) {
    case "number":
      return isPlainNumber(value)
    case "date":
      return isPlainDate(value)
    case "boolean":
      return isBooleanValue(value)
    case "enum":
      return Boolean(field?.options?.some((option) => option.value === value))
    default:
      return true
  }
}

export type FilterRuleIssue =
  | "ok"
  | "no_field"
  | "unknown_field"
  | "missing_value"
  | "invalid_number"
  | "invalid_date"
  | "invalid_option"
  | "reversed_range"

/**
 * What is wrong with one rule, or `"ok"`.
 *
 * Returned as a code rather than a boolean because the four ways a row can be unusable need four
 * different things said about them, and because "incomplete" and "complete but impossible" are
 * not the same state: a range typed backwards is filled in, and matches nothing.
 */
export function ruleIssue(rule: FilterRule, fields: readonly FilterField[]): FilterRuleIssue {
  if (rule.field === "") return "no_field"
  const field = fields.find((candidate) => candidate.name === rule.field)
  if (!field) return "unknown_field"
  const arity = operatorArity(rule.operator)
  if (arity === 0) return "ok"
  const slots = arity === "many" ? rule.values.filter((value) => value.trim() !== "") : rule.values
  if (slots.length === 0 || slots.some((value) => value.trim() === "")) return "missing_value"
  for (const value of slots) {
    if (valueIsValid(value, field)) continue
    switch (fieldKind(field)) {
      case "number":
        return "invalid_number"
      case "date":
        return "invalid_date"
      case "enum":
      case "boolean":
        return "invalid_option"
      default:
        return "missing_value"
    }
  }
  if (arity === 2) {
    const kind = fieldKind(field)
    if (kind === "number" && Number(rule.values[0]) > Number(rule.values[1])) return "reversed_range"
    // Dates are compared as strings on purpose: `YYYY-MM-DD` sorts correctly as text, and both
    // slots are known to be real dates by this point, so there is no timezone to get wrong.
    if (kind === "date" && rule.values[0] > rule.values[1]) return "reversed_range"
  }
  return "ok"
}

export function ruleIsComplete(rule: FilterRule, fields: readonly FilterField[]): boolean {
  const issue = ruleIssue(rule, fields)
  // A backwards range is complete — it is a filter that matches nothing, which is a thing a person
  // is allowed to ask for, and the row says so beside itself rather than being dropped.
  return issue === "ok" || issue === "reversed_range"
}

/** How deep a node sits, counting the outermost group as 0. */
export function nodeDepth(root: FilterNode, id: string, depth = 0): number {
  if (root.id === id) return depth
  if (!isGroup(root)) return -1
  for (const child of root.children) {
    const found = nodeDepth(child, id, depth + 1)
    if (found !== -1) return found
  }
  return -1
}

/** The depth of the deepest group, counting the outermost as 1. */
export function treeDepth(node: FilterNode): number {
  if (!isGroup(node)) return 0
  const deepest = node.children.reduce((max, child) => Math.max(max, treeDepth(child)), 0)
  return deepest + 1
}

export function countRules(node: FilterNode): number {
  if (isRule(node)) return 1
  return node.children.reduce((total, child) => total + countRules(child), 0)
}

/* ------------------------------------------------------------------ editing

   Every edit is a replacement of the node it touches, carried out by rebuilding the path down to
   it. Mutating in place would be shorter and would not re-render: React compares the root, and a
   tree whose root is the same object it was is a tree that has not changed as far as it can tell.
*/

export function replaceNode(root: FilterGroup, id: string, next: FilterNode | null): FilterGroup {
  const children: FilterNode[] = []
  for (const child of root.children) {
    if (child.id === id) {
      if (next) children.push(next)
      continue
    }
    if (isGroup(child)) {
      const replaced = replaceNode(child, id, next)
      // A group that loses its last child is removed rather than left as an empty pair of
      // brackets: it serialises to nothing, it matches everything, and on screen it is a box with
      // an "Add condition" button and no way to say what it is for. The outermost group is the
      // exception — it is the builder itself, and an empty one is how a filter starts.
      if (replaced.children.length === 0) continue
      children.push(replaced)
      continue
    }
    children.push(child)
  }
  return { ...root, children }
}

export function findNode(root: FilterNode, id: string): FilterNode | undefined {
  if (root.id === id) return root
  if (!isGroup(root)) return undefined
  for (const child of root.children) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

export function appendChild(root: FilterGroup, groupId: string, child: FilterNode): FilterGroup {
  if (root.id === groupId) return { ...root, children: [...root.children, child] }
  return {
    ...root,
    children: root.children.map((node) =>
      isGroup(node) ? appendChild(node, groupId, child) : node
    ),
  }
}

export function setConjunction(
  root: FilterGroup,
  groupId: string,
  conjunction: FilterConjunction
): FilterGroup {
  if (root.id === groupId) return { ...root, conjunction }
  return {
    ...root,
    children: root.children.map((node) =>
      isGroup(node) ? setConjunction(node, groupId, conjunction) : node
    ),
  }
}

/* ------------------------------------------------------- output: server JSON */

export interface FilterQueryRule {
  field: string
  operator: FilterOperatorId
  /** Exactly the values the operator uses: none for `is empty`, two for `between`. */
  values: string[]
}

export interface FilterQuery {
  op: FilterConjunction
  children: (FilterQuery | FilterQueryRule)[]
}

export interface FilterDropped {
  id: string
  field: string
  issue: FilterRuleIssue
}

/**
 * The filter to send, and every row left out of it.
 *
 * The second half is the part that is usually missing. A builder that quietly skips the rows that
 * are not filled in produces a result set that does not match what is on screen, and the person
 * reads that as the search being broken rather than as a row they never finished — so the rows
 * that were dropped come back with the query, for the caller to say something about.
 *
 * `null` means there is nothing to filter on, which is not the same as an empty match: a caller
 * handed `null` should fetch everything.
 */
export function buildFilterQuery(
  node: FilterNode,
  fields: readonly FilterField[]
): { query: FilterQuery | null; dropped: FilterDropped[] } {
  const dropped: FilterDropped[] = []

  const walk = (current: FilterNode): FilterQuery | FilterQueryRule | null => {
    if (isRule(current)) {
      if (!ruleIsComplete(current, fields)) {
        dropped.push({ id: current.id, field: current.field, issue: ruleIssue(current, fields) })
        return null
      }
      const arity = operatorArity(current.operator)
      const values =
        arity === 0
          ? []
          : arity === "many"
            ? current.values.filter((value) => value.trim() !== "")
            : current.values.slice(0, arity === 1 ? 1 : 2)
      return { field: current.field, operator: current.operator, values }
    }
    const children = current.children
      .map(walk)
      .filter((child): child is FilterQuery | FilterQueryRule => child !== null)
    if (children.length === 0) return null
    // A group with one surviving child is collapsed into that child. `and(x)` and `x` select the
    // same rows, and the shorter one is what a hand-written query would say.
    if (children.length === 1) return children[0]
    return { op: current.conjunction, children }
  }

  const query = walk(node)
  if (query === null) return { query: null, dropped }
  // A single rule at the top still arrives wrapped, so a caller never has to tell the two shapes
  // apart before reading `op`.
  if ("field" in query) {
    return { query: { op: isGroup(node) ? node.conjunction : "and", children: [query] }, dropped }
  }
  return { query, dropped }
}

/* -------------------------------------------------------- output: URL string

   A filter in a URL is read by people — it is in the shared link, the bookmark, the bug report —
   so the form is `and(status:eq:active,amount:gte:100)` rather than base64 or JSON. That makes
   six characters structural, and every one of them can appear in a value: a product named
   "A, B (2kg)" has to survive the round trip, so the segments are escaped rather than trusted.
*/

const PARAM_SPECIALS = /[\\:|,()]/g

export function escapeFilterSegment(text: string): string {
  return text.replace(PARAM_SPECIALS, (match) => `\\${match}`)
}

export function toFilterParam(node: FilterNode): string {
  if (isRule(node)) {
    const head = `${escapeFilterSegment(node.field)}:${node.operator}`
    if (node.values.length === 0) return head
    return `${head}:${node.values.map(escapeFilterSegment).join("|")}`
  }
  return `${node.conjunction}(${node.children.map(toFilterParam).join(",")})`
}

/** Reads one escaped segment, stopping at the first unescaped character in `stop`. */
function readSegment(text: string, start: number, stop: string): { value: string; next: number } {
  let value = ""
  let i = start
  while (i < text.length) {
    const char = text[i]
    if (char === "\\" && i + 1 < text.length) {
      value += text[i + 1]
      i += 2
      continue
    }
    if (stop.includes(char)) break
    value += char
    i += 1
  }
  return { value, next: i }
}

/**
 * Parses what `toFilterParam` wrote, with fresh ids.
 *
 * Returns `null` for anything it cannot read, rather than a partial tree. A URL is the one input
 * here that arrives from outside — edited by hand, truncated by a chat client, carried over from
 * an older version of the fields — and half a filter applied silently is worse than a filter that
 * did not load, because the person cannot see what is missing.
 */
export function parseFilterParam(
  text: string,
  generateId: () => string = createFilterId
): FilterGroup | null {
  const parseNode = (at: number): { node: FilterNode; next: number } | null => {
    const head = readSegment(text, at, ":(,)")
    if (text[head.next] === "(") {
      if (head.value !== "and" && head.value !== "or") return null
      const children: FilterNode[] = []
      let i = head.next + 1
      if (text[i] === ")") return { node: createGroup(head.value, [], generateId), next: i + 1 }
      for (;;) {
        const child = parseNode(i)
        if (!child) return null
        children.push(child.node)
        i = child.next
        if (text[i] === ",") {
          i += 1
          continue
        }
        if (text[i] === ")") return { node: createGroup(head.value, children, generateId), next: i + 1 }
        return null
      }
    }
    if (text[head.next] !== ":") return null
    const operator = readSegment(text, head.next + 1, ":,)")
    if (!OPERATOR_BY_ID.has(operator.value as FilterOperatorId)) return null
    const id = operator.value as FilterOperatorId
    const rule: FilterRule = { id: generateId(), kind: "rule", field: head.value, operator: id, values: [] }
    if (text[operator.next] !== ":") {
      // No value section at all. Legal only for the operators that take no value — anything else
      // would load as a row that looks complete and filters on nothing.
      return operatorArity(id) === 0 ? { node: rule, next: operator.next } : null
    }
    const values: string[] = []
    let i = operator.next + 1
    for (;;) {
      const value = readSegment(text, i, "|,)")
      values.push(value.value)
      i = value.next
      if (text[i] === "|") {
        i += 1
        continue
      }
      break
    }
    const arity = operatorArity(id)
    if (arity === 0) return null
    if (arity !== "many" && values.length !== arity) return null
    return { node: { ...rule, values }, next: i }
  }

  if (text.trim() === "") return null
  const parsed = parseNode(0)
  if (!parsed || parsed.next !== text.length) return null
  // A bare rule is wrapped, so the editor always has a group to add the next row to.
  return isGroup(parsed.node) ? parsed.node : createGroup("and", [parsed.node], generateId)
}

/* ----------------------------------------------------------- output: a sentence */

/**
 * The filter in words, for a live region, a summary line or a chip.
 *
 * Built from the same tree the editor draws, so it cannot drift from it — and it uses the field
 * labels and the kind-specific operator labels, which is what makes "Signed up is after 2026-01-01"
 * read as a sentence instead of as `signed_up gt 2026-01-01`.
 */
export function describeFilter(node: FilterNode, fields: readonly FilterField[]): string {
  if (isRule(node)) {
    const field = fields.find((candidate) => candidate.name === node.field)
    const spec = operatorSpec(node.operator)
    const name = field ? fieldLabel(field) : node.field || "(no field)"
    const operator = spec ? operatorLabel(spec, fieldKind(field)) : node.operator
    const shown = node.values.map((value) => {
      if (!field || fieldKind(field) !== "enum") return value
      const option = field.options?.find((candidate) => candidate.value === value)
      return option?.label ?? value
    })
    if (shown.length === 0) return `${name} ${operator}`
    if (shown.length === 2 && operatorArity(node.operator) === 2) {
      return `${name} ${operator} ${shown[0]} and ${shown[1]}`
    }
    return `${name} ${operator} ${shown.join(", ")}`
  }
  const parts = node.children.map((child) => {
    const text = describeFilter(child, fields)
    // Brackets only where they change the reading: a nested group inside a group of the other
    // conjunction is exactly the case the person needs to see grouped.
    return isGroup(child) && child.children.length > 1 ? `(${text})` : text
  })
  return parts.join(node.conjunction === "and" ? " and " : " or ")
}

/* --------------------------------------------------------------- the editor */

export interface FilterBuilderLabels {
  /** Sits where the conjunction goes on the first row of a group. */
  where: string
  and: string
  or: string
  conjunction: string
  addCondition: string
  addGroup: string
  addValue: string
  removeCondition: (position: number) => string
  removeGroup: (position: number) => string
  removeValue: (slot: number, position: number) => string
  field: (position: number) => string
  operator: (position: number) => string
  value: (position: number, slot: number, slots: number) => string
  chooseField: string
  group: (position: number, conjunction: FilterConjunction) => string
  empty: string
  added: (position: number) => string
  addedGroup: (position: number) => string
  removed: (position: number, left: number) => string
  issue: Record<Exclude<FilterRuleIssue, "ok">, string>
}

export const defaultFilterBuilderLabels: FilterBuilderLabels = {
  where: "Where",
  and: "and",
  or: "or",
  conjunction: "Join conditions with",
  addCondition: "Add condition",
  addGroup: "Add group",
  addValue: "Add value",
  removeCondition: (position) => `Remove condition ${position}`,
  removeGroup: (position) => `Remove group ${position}`,
  removeValue: (slot, position) => `Remove value ${slot} of condition ${position}`,
  field: (position) => `Field for condition ${position}`,
  operator: (position) => `Operator for condition ${position}`,
  value: (position, slot, slots) =>
    slots > 1 ? `Value ${slot} for condition ${position}` : `Value for condition ${position}`,
  chooseField: "Choose a field",
  group: (position, conjunction) =>
    `Condition group ${position}, matching ${conjunction === "and" ? "all" : "any"} of`,
  empty: "No conditions yet.",
  added: (position) => `Condition ${position} added`,
  addedGroup: (position) => `Group ${position} added`,
  removed: (position, left) =>
    `Condition ${position} removed, ${left} ${left === 1 ? "condition" : "conditions"} left`,
  issue: {
    no_field: "Choose a field.",
    unknown_field: "This field is no longer available.",
    missing_value: "Enter a value.",
    invalid_number: "Enter a number.",
    invalid_date: "Enter a date as YYYY-MM-DD.",
    invalid_option: "Choose one of the listed values.",
    reversed_range: "The range is the wrong way round, so it matches nothing.",
  },
}

export type FilterChange =
  | { type: "add-rule"; id: string }
  | { type: "add-group"; id: string }
  | { type: "remove"; id: string }
  | { type: "update"; id: string }
  | { type: "conjunction"; id: string }

export interface FilterBuilderProps
  extends Omit<
    React.ComponentPropsWithoutRef<"fieldset">,
    "children" | "onChange" | "defaultValue"
  > {
  /** The fields a condition can be built on. The first one is what a new row starts with. */
  fields: readonly FilterField[]
  /** Controlled tree. Pair with `onChange`. */
  value?: FilterGroup
  /** Starting tree when uncontrolled. Defaults to an empty `and` group. */
  defaultValue?: FilterGroup
  onChange?: (next: FilterGroup, change: FilterChange) => void
  /**
   * How many levels of group are allowed, counting the outermost as 1. The default of 2 is one
   * level of nesting, which covers "all of these, and one of those" — the shape people actually
   * build — while keeping the condition readable. Unlimited nesting is what makes a saved filter
   * nobody can interpret later.
   */
  maxDepth?: number
  /** Optional cap on the number of conditions. */
  maxRules?: number
  legend?: React.ReactNode
  labels?: Partial<FilterBuilderLabels>
  disabled?: boolean
  generateId?: () => string
}

export function canAddGroupAtDepth(depth: number, maxDepth: number): boolean {
  return depth + 2 <= maxDepth
}

const SELECT_CLASS =
  "h-9 min-w-0 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

const INPUT_CLASS =
  "h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

/** What the rest of this registry puts on a field whose content cannot be used. */
const INVALID_CLASS = "border-destructive focus-visible:ring-destructive"

const ICON_BUTTON_CLASS =
  "inline-flex size-9 flex-none items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

const GHOST_BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

export function FilterBuilder({
  fields,
  value,
  defaultValue,
  onChange,
  maxDepth = 2,
  maxRules,
  legend,
  labels: labelOverrides,
  disabled,
  generateId = createFilterId,
  className,
  ...props
}: FilterBuilderProps) {
  const labels = React.useMemo(
    () => ({ ...defaultFilterBuilderLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const baseId = React.useId()
  const controlled = value !== undefined
  const [internal, setInternal] = React.useState<FilterGroup>(
    () => defaultValue ?? createGroup("and", [], generateId)
  )
  const tree = controlled ? value : internal
  const [message, setMessage] = React.useState("")

  const total = countRules(tree)
  const canAddRule = maxRules === undefined || total < maxRules

  const commit = (next: FilterGroup, change: FilterChange) => {
    if (!controlled) setInternal(next)
    onChange?.(next, change)
  }

  const fieldByName = (name: string) => fields.find((candidate) => candidate.name === name)

  const addRule = (groupId: string) => {
    if (!canAddRule) return
    const rule = createRule(fields[0], generateId)
    commit(appendChild(tree, groupId, rule), { type: "add-rule", id: rule.id })
    setMessage(labels.added(total + 1))
  }

  const addGroup = (groupId: string) => {
    if (!canAddRule) return
    // A new group starts with one row and the other conjunction, because a nested group that
    // repeats its parent's conjunction changes nothing about what is selected — nesting is only
    // worth drawing when the join inside differs from the join outside.
    const parent = findNode(tree, groupId)
    const conjunction: FilterConjunction =
      parent && isGroup(parent) && parent.conjunction === "and" ? "or" : "and"
    const group = createGroup(conjunction, [createRule(fields[0], generateId)], generateId)
    commit(appendChild(tree, groupId, group), { type: "add-group", id: group.id })
    setMessage(labels.addedGroup(total + 1))
  }

  const removeNode = (node: FilterNode, position: number) => {
    const next = replaceNode(tree, node.id, null)
    commit(next, { type: "remove", id: node.id })
    setMessage(labels.removed(position, countRules(next)))
  }

  const updateRule = (rule: FilterRule) => {
    commit(replaceNode(tree, rule.id, rule), { type: "update", id: rule.id })
  }

  const changeConjunction = (groupId: string, conjunction: FilterConjunction) => {
    commit(setConjunction(tree, groupId, conjunction), { type: "conjunction", id: groupId })
  }

  const renderValueSlots = (rule: FilterRule, position: number) => {
    const field = fieldByName(rule.field)
    const arity = operatorArity(rule.operator)
    if (arity === 0) return null
    const issue = ruleIssue(rule, fields)
    const invalid = issue !== "ok" && issue !== "no_field" && issue !== "unknown_field"
    const issueId = `${baseId}-${rule.id}-issue`

    const setSlot = (index: number, next: string) => {
      const values = [...rule.values]
      values[index] = next
      updateRule({ ...rule, values })
    }

    const slot = (index: number, slots: number) => {
      const shared = {
        key: index,
        "aria-label": labels.value(position, index + 1, slots),
        "aria-invalid": invalid || undefined,
        "aria-describedby": invalid ? issueId : undefined,
        disabled,
      }
      const kind = fieldKind(field)
      if (kind === "enum") {
        return (
          <select
            {...shared}
            value={rule.values[index] ?? ""}
            onChange={(event) => setSlot(index, event.target.value)}
            className={cn(SELECT_CLASS, "flex-1", invalid && INVALID_CLASS)}
          >
            {field?.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label ?? option.value}
              </option>
            ))}
          </select>
        )
      }
      if (kind === "boolean") {
        return (
          <select
            {...shared}
            value={rule.values[index] ?? ""}
            onChange={(event) => setSlot(index, event.target.value)}
            className={cn(SELECT_CLASS, "flex-1", invalid && INVALID_CLASS)}
          >
            <option value="true">{"true"}</option>
            <option value="false">{"false"}</option>
          </select>
        )
      }
      return (
        <input
          {...shared}
          type={kind === "date" ? "date" : "text"}
          // A number field is a text input with a numeric keypad, not `type="number"`. The native
          // number input discards what it cannot parse before the component ever sees it, so a
          // half-typed "1." or a pasted "1,5" becomes an empty value with nothing said about it,
          // and the row reads as "no value entered" when a value was. Validating here means the
          // row can say what is wrong with what was actually typed.
          inputMode={kind === "number" ? "decimal" : undefined}
          value={rule.values[index] ?? ""}
          onChange={(event) => setSlot(index, event.target.value)}
          className={cn(INPUT_CLASS, invalid && INVALID_CLASS)}
        />
      )
    }

    if (arity === 1) return slot(0, 1)

    if (arity === 2) {
      return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {slot(0, 2)}
          <span className="flex-none text-sm text-muted-foreground">{labels.and}</span>
          {slot(1, 2)}
        </div>
      )
    }

    const slots = rule.values.length
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {rule.values.map((_, index) => (
          <div key={index} className="flex items-center gap-2">
            {slot(index, slots)}
            <button
              type="button"
              // The last slot keeps its button but announces itself unavailable: a list that drops
              // to zero inputs is an operator with nowhere to type, and a button that disappears
              // under the pointer is worse than one that says why it will not act.
              aria-disabled={slots <= 1 || undefined}
              aria-label={labels.removeValue(index + 1, position)}
              disabled={disabled}
              onClick={() => {
                if (slots <= 1) return
                updateRule({ ...rule, values: rule.values.filter((__, i) => i !== index) })
              }}
              className={cn(ICON_BUTTON_CLASS, slots <= 1 && "pointer-events-none opacity-50")}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => updateRule({ ...rule, values: [...rule.values, blankValue(field)] })}
          className={cn(GHOST_BUTTON_CLASS, "self-start")}
        >
          <Plus aria-hidden="true" className="size-4" />
          {labels.addValue}
        </button>
      </div>
    )
  }

  const renderRule = (rule: FilterRule, position: number) => {
    const field = fieldByName(rule.field)
    const issue = ruleIssue(rule, fields)
    const issueId = `${baseId}-${rule.id}-issue`
    const operators = operatorsForField(field)
    return (
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select
            aria-label={labels.field(position)}
            value={rule.field}
            disabled={disabled}
            onChange={(event) =>
              updateRule(retargetRule(rule, fieldByName(event.target.value), field))
            }
            className={SELECT_CLASS}
          >
            {rule.field === "" || !field ? (
              <option value={rule.field}>{rule.field || labels.chooseField}</option>
            ) : null}
            {fields.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {fieldLabel(candidate)}
              </option>
            ))}
          </select>
          <select
            aria-label={labels.operator(position)}
            value={rule.operator}
            disabled={disabled}
            onChange={(event) =>
              updateRule(retargetOperator(rule, event.target.value as FilterOperatorId))
            }
            className={SELECT_CLASS}
          >
            {operators.map((spec) => (
              <option key={spec.id} value={spec.id}>
                {operatorLabel(spec, fieldKind(field))}
              </option>
            ))}
          </select>
          {renderValueSlots(rule, position)}
        </div>
        {issue !== "ok" ? (
          <p
            id={issueId}
            // Not a live region: a message that speaks while the field is still being typed into
            // interrupts the typing. It is reachable through aria-describedby on the input it
            // belongs to, which is what a screen reader reads when focus arrives there.
            className="mt-1 text-sm text-muted-foreground"
          >
            {labels.issue[issue]}
          </p>
        ) : null}
      </div>
    )
  }

  const renderGroup = (group: FilterGroup, depth: number): React.ReactNode => {
    const nestable = canAddGroupAtDepth(depth, maxDepth)
    return (
      <div className="space-y-2">
        {group.children.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
            {labels.empty}
          </p>
        ) : null}
        {group.children.map((child, index) => (
          <div key={child.id} className="flex min-w-0 items-start gap-2">
            <div className="flex-none pt-1.5">
              {index === 0 ? (
                <span className="inline-block w-16 text-sm text-muted-foreground">
                  {labels.where}
                </span>
              ) : index === 1 ? (
                <select
                  aria-label={labels.conjunction}
                  value={group.conjunction}
                  disabled={disabled}
                  onChange={(event) =>
                    changeConjunction(group.id, event.target.value as FilterConjunction)
                  }
                  className={cn(SELECT_CLASS, "w-16")}
                >
                  <option value="and">{labels.and}</option>
                  <option value="or">{labels.or}</option>
                </select>
              ) : (
                // Rows after the second repeat the conjunction as text. One select per group is
                // the whole point: a select on every row invites "A and B or C", which has no
                // single reading, and the row that changed it would own a decision about rows
                // above it that the person never made.
                <span className="inline-block w-16 text-sm text-muted-foreground">
                  {group.conjunction === "and" ? labels.and : labels.or}
                </span>
              )}
            </div>
            {isGroup(child) ? (
              <div
                role="group"
                aria-label={labels.group(index + 1, child.conjunction)}
                className="min-w-0 flex-1 rounded-md border border-dashed border-input p-3"
              >
                {renderGroup(child, depth + 1)}
              </div>
            ) : (
              renderRule(child, index + 1)
            )}
            <button
              type="button"
              aria-label={
                isGroup(child) ? labels.removeGroup(index + 1) : labels.removeCondition(index + 1)
              }
              disabled={disabled}
              onClick={() => removeNode(child, index + 1)}
              className={ICON_BUTTON_CLASS}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-disabled={!canAddRule || undefined}
            disabled={disabled}
            onClick={() => addRule(group.id)}
            className={cn(GHOST_BUTTON_CLASS, !canAddRule && "pointer-events-none opacity-50")}
          >
            <Plus aria-hidden="true" className="size-4" />
            {labels.addCondition}
          </button>
          {nestable ? (
            <button
              type="button"
              aria-disabled={!canAddRule || undefined}
              disabled={disabled}
              onClick={() => addGroup(group.id)}
              className={cn(GHOST_BUTTON_CLASS, !canAddRule && "pointer-events-none opacity-50")}
            >
              <Plus aria-hidden="true" className="size-4" />
              {labels.addGroup}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <fieldset
      {...props}
      disabled={disabled}
      // min-w-0 because a fieldset is as wide as its content by default, which lets one long row
      // stretch the form instead of wrapping inside it.
      className={cn("min-w-0", className)}
    >
      {legend ? <legend className="mb-2 text-base font-medium">{legend}</legend> : null}
      {renderGroup(tree, 0)}
      {/* Adding and removing rows change no value, so nothing else here is announced. */}
      <div aria-live="polite" className="sr-only">
        {message}
      </div>
    </fieldset>
  )
}
