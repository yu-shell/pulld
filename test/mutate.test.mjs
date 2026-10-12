// scripts/mutate.mjs was the only script in scripts/ with no test of its own, and it is the one
// whose failure mode is hardest to notice: it reports a number. A mutation run that mutates the
// wrong bytes still prints a tidy count and a survivor list, so there is nothing to look wrong.
//
// The script's own header records that happening. Its first implementation walked the file with
// `ts.createScanner`, which cannot close a template substitution on its own — that needs
// `reScanTemplateToken`, which only the parser calls — so the next backtick in the file opened a
// fresh template and from there every backtick in the prose was read as code. 42 of 74 "mutations"
// landed inside doc comments, every one of them survived, and the score read 22% instead of what
// it was. The fix was to take the mutations from the parsed tree, where a comment is not a node.
//
// That fix is load-bearing and invisible: nothing in the gate would notice it being undone, and
// the tool's output would still look like a measurement. So the invariants it bought are pinned
// here — mutations stay out of comments and out of template prose, the walk survives a template
// literal, type-only literals are not offered, and the operator table is what the file says it is.
import { test } from "node:test"
import assert from "node:assert/strict"

import { mutationsFor } from "../scripts/mutate.mjs"

/** `kind from -> to` per mutation, in the order they were returned. */
const summarise = (source) => mutationsFor(source).map((m) => `${m.kind} ${m.from} -> ${m.to}`)

/** What the mutation actually produces when spliced back into the source. */
const apply = (source, m) => source.slice(0, m.start) + m.to + source.slice(m.end)

test("a file of nothing but comments offers no mutations", () => {
  // Every operator, number, boolean, quoted word and backtick the operators below react to, with
  // none of it being code. This is the 42-of-74 regression: if it ever returns, it returns here.
  const source = [
    '// i < 0 && j >= 1, x === y, "role", 2 things, true and false, a `template` word',
    "/**",
    ' * A block comment: x !== y || z == w, "start", 1, 0, -1, false, `backticks`',
    " */",
  ].join("\n")

  assert.deepEqual(mutationsFor(source), [])
})

test("a template literal does not turn the rest of the file into code-in-prose", () => {
  // The scanner walk's exact failure: the backtick that opens this template was matched with the
  // one that closes it, so `after` was read as prose and never mutated. Asserting the prose is
  // clean is not enough on its own — a walk that stops dead at the template would also pass that.
  const source = ['const t = `prose with < and && and "role" in it`', "const after = 2 > 1"].join("\n")

  assert.deepEqual(summarise(source), ["number 2 -> 1", "operator > -> >=", "number 1 -> 0"])
})

test("code inside a template substitution is mutated and the prose around it is not", () => {
  // A substitution is the part the scanner could not close. Real code inside one is real code, so
  // it is offered; the text on either side of it is not.
  const source = ["const t = `a ${x > 1} b \"role\" c`", "const after = 3 < 4"].join("\n")

  assert.deepEqual(summarise(source), [
    "operator > -> >=",
    "number 1 -> 0",
    "number 3 -> 0",
    "operator < -> <=",
    "number 4 -> 0",
  ])
})

test("every binary operator in the table is offered its documented replacement", () => {
  const source = "const r = a < b || c >= d && e === f && g !== h && i == j && k + l - m && n ?? o"

  assert.deepEqual(summarise(source), [
    "operator < -> <=",
    "operator || -> &&",
    "operator >= -> >",
    "operator && -> ||",
    "operator === -> !==",
    "operator && -> ||",
    "operator !== -> ===",
    "operator && -> ||",
    "operator == -> !=",
    "operator && -> ||",
    "operator + -> -",
    "operator - -> +",
    "operator && -> ||",
    "operator ?? -> ||",
  ])
})

test("a negative sentinel is offered as a dropped sign, which makes it a real position", () => {
  // -1 is the "not found" value all over the registry sources; the mutation that matters is the
  // one that turns it into an index, so the sign is offered separately from the digit.
  const mutations = mutationsFor("const at = -1")
  const sign = mutations.find((m) => m.kind === "sign")

  assert.ok(sign, `expected a sign mutation, got ${JSON.stringify(summarise("const at = -1"))}`)
  assert.equal(apply("const at = -1", sign), "const at = 1")
})

test("numbers and booleans flip the way the tables say", () => {
  assert.deepEqual(summarise("const n = [0, 1, 2, 7]"), [
    "number 0 -> 1",
    "number 1 -> 0",
    "number 2 -> 1",
    // Anything the table does not name goes to 0.
    "number 7 -> 0",
  ])
  assert.deepEqual(summarise("const b = [true, false]"), [
    "boolean true -> false",
    "boolean false -> true",
  ])
})

test("a literal that only exists in a type is not offered", () => {
  // `align?: "start" | "end"` is erased before anything runs, so the mutant cannot change
  // behaviour and is guaranteed to survive — which drags the score down and hides real survivors.
  // The same word in value position is real code and is offered.
  assert.deepEqual(mutationsFor('type A = { align?: "start" | "end" }'), [])
  assert.deepEqual(summarise('const align = "start"'), ["string start -> mutated"])
})

test("class names are not offered but roles and keys are", () => {
  // A test that pinned a utility class would be asserting the stylesheet, and the long class lists
  // carry spaces so they fall outside the pinnable shape anyway.
  assert.deepEqual(mutationsFor('const a = <div className="relative" />'), [])
  assert.deepEqual(mutationsFor('const b = { className: "truncate" }'), [])
  assert.deepEqual(mutationsFor('const c = <div className="flex items-center gap-3" />'), [])
  // Both spellings the function recognises; `class` is the one a plain HTML-ish snippet carries.
  assert.deepEqual(mutationsFor('const d = <div class="relative" />'), [])

  assert.deepEqual(summarise('const e = <div role="dialog" aria-live="polite" />'), [
    "string dialog -> mutated",
    "string polite -> mutated",
  ])
})

test("a string mutation replaces the contents and leaves the quotes alone", () => {
  // The offsets step inside the quotes. Off by one either way and the mutant is written over a
  // quote, which is a syntax error rather than a behaviour change — and a file that will not parse
  // fails every test, so every such mutant reads as "killed" and the run looks healthy.
  const source = 'const d = <div role="dialog" />'
  const [mutation, ...rest] = mutationsFor(source)

  assert.deepEqual(rest, [])
  assert.equal(apply(source, mutation), 'const d = <div role="mutated" />')
})

test("a prefix operator that is not a minus sign is not offered as a dropped sign", () => {
  // The sign branch is guarded on the operator being `-` and its operand being a number. Widen it
  // and `!open` gets a "sign" mutation that deletes the `!` — inverting a condition under a label
  // that says a sentinel was turned into a position.
  assert.deepEqual(mutationsFor("const a = !open"), [])
  assert.deepEqual(mutationsFor("const b = !!open"), [])
})

test("mutations come back in source order and none of them is a no-op", () => {
  // Order is what makes the printed survivor lines line up with the file, and a mutation that
  // replaces a token with itself would be counted as killed-or-survived having changed nothing.
  const source = [
    'const label = "ready"',
    "const n = 2",
    "if (n > 1 && label === \"ready\") {}",
  ].join("\n")
  const mutations = mutationsFor(source)

  assert.ok(mutations.length >= 6, `expected several mutations, got ${mutations.length}`)
  const starts = mutations.map((m) => m.start)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  for (const m of mutations) assert.notEqual(m.from, m.to)
})
