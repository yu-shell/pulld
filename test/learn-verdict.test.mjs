// Unit tests for the tuning verdict behind `npm run learn` (scripts/learn.mjs).
//
// This is the function that decides whether a metadata rewrite is kept or reverted, so it edits
// the catalogue's copy by proxy — and it does so on install counts thin enough that a single
// mis-scored component moves the loop. The case worth pinning hardest is the one that is not a
// verdict at all: a baseline that was never measured (D1 unreachable when `mark` ran) must not be
// read as a measured 0, or every component's ordinary background traffic reads as LIFT and the
// loop keeps changes on evidence it never collected.
import { test } from "node:test"
import assert from "node:assert/strict"
import { tuningVerdict, LIFT_GAIN, REGRESSION_DROP } from "../scripts/learn.mjs"

const kind = (base, now) => tuningVerdict(base, now).kind

// Both thresholds are inclusive, so the boundary is the part worth pinning. The rates below are
// written as literals rather than derived from the constants: `100 * (1 + LIFT_GAIN)` is
// 114.99999999999999, so deriving them would test float representation instead of the rule. The
// equality assertions keep the literals honest — move a threshold and they say so.
test("a rate drop of at least REGRESSION_DROP is a regression", () => {
  assert.equal(REGRESSION_DROP, 0.3) // the rates below encode this threshold
  assert.equal(kind(100, 70), "regression") // exactly -30%
  assert.equal(kind(100, 71), "flat") // just short of it
  assert.equal(kind(1, 0), "regression")
  assert.equal(tuningVerdict(1, 0.5).lift, -0.5)
})

test("a rate gain of at least LIFT_GAIN is a lift", () => {
  assert.equal(LIFT_GAIN, 0.15) // the rates below encode this threshold
  assert.equal(kind(100, 115), "lift") // exactly +15%
  assert.equal(kind(100, 114), "flat") // just short of it
  assert.equal(kind(1, 4), "lift")
  assert.equal(tuningVerdict(1, 2).lift, 1)
})

test("a move between the two thresholds is flat", () => {
  assert.equal(kind(1, 1), "flat")
  assert.equal(kind(1, 1.1), "flat")
  assert.equal(kind(1, 0.8), "flat")
})

test("a measured zero baseline is real evidence: any traffic after it is a lift", () => {
  // Nothing installed this in the window before the rewrite, so installs afterwards are
  // attributable to it. There is no percentage to quote — the lift is against zero.
  assert.deepEqual(tuningVerdict(0, 0.5), { kind: "lift", lift: null })
  assert.deepEqual(tuningVerdict(0, 0), { kind: "flat", lift: null })
})

test("an unmeasured baseline yields no verdict, never a lift", () => {
  // `mark` writes null when it could not reach D1. Reading that as a measured 0 is what turned
  // background traffic into "LIFT — keep" on exactly the runs where nothing was measured.
  for (const baseline of [null, undefined, "", NaN, "n/a"]) {
    assert.equal(kind(baseline, 0.5), "unmeasured", `baseline ${String(baseline)}`)
    assert.equal(tuningVerdict(baseline, 0.5).lift, null)
  }
  // The same input under the old rule (`baselineRate ?? 0` → 0) would have scored a lift.
  assert.equal(kind(0, 0.5), "lift")
})

test("a missing current rate counts as zero, not as a broken verdict", () => {
  // rates[name] is absent for a component nothing fetched in the window; that is a real 0, and a
  // NaN leaking through here would compare false against both thresholds and silently read FLAT.
  assert.equal(kind(1, undefined), "regression")
  assert.equal(kind(1, NaN), "regression")
})
