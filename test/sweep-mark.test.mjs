// Unit tests for recording a quality sweep as done (scripts/sweep.mjs, `mark`).
//
// This is the only record that a component was ever audited, and it is write-once-and-forget:
// pickScope reads `lastSwept` back by registry name and nothing else ever looks at the file. So an
// entry written under a name the registry does not ship is invisible and permanent, and — worse —
// the component that really was audited still has no record while the command reports success.
// `mark` is handed a whole batch in one call at the end of the weekly routine, which is exactly
// where one mistyped name hides among five good ones.
//
// These tests pin the refusal, that the refusal is reported separately from what landed, and that
// a run which recorded nothing does not stamp `lastRun`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { applyMarks } from "../scripts/sweep.mjs"

const CATALOG = ["copy-button", "kbd", "spinner"]
const state = (components = {}, lastRun = "2026-10-01") => ({ lastRun, components })
const swept = (pairs) =>
  Object.fromEntries(Object.entries(pairs).map(([n, d]) => [n, { lastSwept: d }]))

test("a name the registry ships is stamped with the run's date", () => {
  const out = applyMarks({
    names: CATALOG,
    marks: ["kbd"],
    state: state(),
    date: "2026-10-27",
  })
  assert.deepEqual(out.marked, ["kbd"])
  assert.deepEqual(out.unknown, [])
  assert.deepEqual(out.state.components.kbd, { lastSwept: "2026-10-27" })
  assert.equal(out.state.lastRun, "2026-10-27")
})

test("a name the registry does not ship is refused instead of recorded", () => {
  const out = applyMarks({
    names: CATALOG,
    marks: ["copy-buton"],
    state: state(),
    date: "2026-10-27",
  })
  assert.deepEqual(out.marked, [])
  assert.deepEqual(out.unknown, ["copy-buton"])
  assert.equal(out.state.components["copy-buton"], undefined)
})

test("one typo in a batch does not pass for the component it was meant to be", () => {
  // The whole point: the operator audited three components and spelled one of them wrong. The two
  // that landed must land, the third must not be reported as swept, and it must be named.
  const out = applyMarks({
    names: CATALOG,
    marks: ["copy-button", "kbd", "spiner"],
    state: state(),
    date: "2026-10-27",
  })
  assert.deepEqual(out.marked, ["copy-button", "kbd"])
  assert.deepEqual(out.unknown, ["spiner"])
  assert.equal(out.state.components.spinner, undefined)
  assert.equal(out.state.components["spiner"], undefined)
})

test("a run that recorded nothing leaves lastRun where it was", () => {
  // Stamping it would leave the file claiming a sweep that did not happen — the same lie in the
  // state file that the success line used to tell on stdout.
  const before = state(swept({ kbd: "2026-09-01" }), "2026-09-01")
  const out = applyMarks({ names: CATALOG, marks: ["nope"], state: before, date: "2026-10-27" })
  assert.equal(out.state.lastRun, "2026-09-01")
  assert.deepEqual(out.state.components, swept({ kbd: "2026-09-01" }))
})

test("re-marking a component moves its date forward and keeps the others", () => {
  const out = applyMarks({
    names: CATALOG,
    marks: ["kbd"],
    state: state(swept({ kbd: "2026-06-23", spinner: "2026-07-05" })),
    date: "2026-10-27",
  })
  assert.deepEqual(
    out.state.components,
    swept({ kbd: "2026-10-27", spinner: "2026-07-05" })
  )
})

test("the same name twice in one call is marked once and reported once", () => {
  const out = applyMarks({
    names: CATALOG,
    marks: ["kbd", "kbd"],
    state: state(),
    date: "2026-10-27",
  })
  assert.deepEqual(out.marked, ["kbd"])
})

test("the same unknown name twice is reported once, not once per spelling attempt", () => {
  const out = applyMarks({ names: CATALOG, marks: ["ghost", "ghost"], state: state() })
  assert.deepEqual(out.unknown, ["ghost"])
})

test("the state handed in is not mutated", () => {
  // main() only writes the file when something landed, so the object it read must survive the
  // refusal path untouched.
  const before = state(swept({ kbd: "2026-09-01" }), "2026-09-01")
  const snapshot = JSON.parse(JSON.stringify(before))
  applyMarks({ names: CATALOG, marks: ["kbd", "ghost"], state: before, date: "2026-10-27" })
  assert.deepEqual(before, snapshot)
})

test("a state file with no components key is written into rather than crashed on", () => {
  // loadState() hands back whatever parsed, and `{}` is a shape a hand-edited or older file can
  // have. pickScope already defends against it; writing had no such guard.
  const out = applyMarks({ names: CATALOG, marks: ["kbd"], state: {}, date: "2026-10-27" })
  assert.deepEqual(out.state.components, swept({ kbd: "2026-10-27" }))
})

test("an empty catalog refuses every name rather than recording all of them", () => {
  // The registry failing to load must not turn `mark` into a command that accepts anything.
  const out = applyMarks({ names: [], marks: ["kbd"], state: state() })
  assert.deepEqual(out.marked, [])
  assert.deepEqual(out.unknown, ["kbd"])
})
