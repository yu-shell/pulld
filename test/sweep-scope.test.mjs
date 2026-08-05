// Unit tests for the quality-sweep scope selection (scripts/sweep.mjs).
//
// This is the list the weekly sweep actually audits. Nothing downstream re-checks it: whatever
// pickScope returns is what gets looked at, and what silently does not. The three slices exist for
// different reasons — a component nobody has ever audited, the ones people actually install, and
// the rotation that guarantees the rest of the catalog comes round eventually — so a change that
// starves one of them costs coverage without failing anything. These tests pin the order, the
// dedupe and the cap.
import { test } from "node:test"
import assert from "node:assert/strict"
import { pickScope, DEFAULT_BATCH } from "../scripts/sweep.mjs"

const swept = (pairs) => ({
  lastRun: null,
  components: Object.fromEntries(Object.entries(pairs).map(([n, d]) => [n, { lastSwept: d }])),
})
const names = (batch) => batch.map((b) => b.name)

test("never-swept components come first, and are labelled new", () => {
  const out = pickScope({
    names: ["old-a", "fresh", "old-b"],
    state: swept({ "old-a": "2026-06-01", "old-b": "2026-07-01" }),
    batch: 3,
  })
  assert.equal(out[0].name, "fresh")
  assert.equal(out[0].reason, "new")
  assert.equal(out[0].lastSwept, null)
})

test("most-installed components follow the new ones, capped at three", () => {
  const out = pickScope({
    names: ["a", "b", "c", "d", "e"],
    state: swept({ a: "2026-08-01", b: "2026-08-01", c: "2026-08-01", d: "2026-08-01", e: "2026-08-01" }),
    installs: { a: 5, b: 90, c: 40, d: 12 },
    batch: 5,
  })
  // Ranked by install count, and only the top three qualify — `a` (5) drops out of the slice even
  // though it has installs, and reaches the batch through the rotation instead.
  assert.deepEqual(names(out).slice(0, 3), ["b", "c", "d"])
  assert.deepEqual(
    out.slice(0, 3).map((b) => b.reason),
    ["top-installed(90)", "top-installed(40)", "top-installed(12)"]
  )
  assert.equal(out[3].reason, "rotating")
})

test("an item seen only by crawlers (count 0) is not a top-installed pick", () => {
  // installsByItem keeps such an item in the map with 0 precisely so it stays distinguishable from
  // "never fetched"; it must not be read here as adoption worth auditing first.
  const out = pickScope({
    names: ["a", "b"],
    state: swept({ a: "2026-08-01", b: "2026-08-01" }),
    installs: { a: 0, b: 3 },
    batch: 2,
  })
  assert.equal(out[0].name, "b")
  assert.equal(out[0].reason, "top-installed(3)")
  assert.equal(out[1].reason, "rotating")
})

test("the rotation is oldest-swept first", () => {
  const out = pickScope({
    names: ["recent", "ancient", "middle"],
    state: swept({ recent: "2026-08-01", ancient: "2026-01-05", middle: "2026-05-20" }),
    batch: 3,
  })
  assert.deepEqual(names(out), ["ancient", "middle", "recent"])
})

test("components swept on the same day keep registry order", () => {
  // `mark` stamps a whole batch with one date, so same-day ties are the normal case, not an edge
  // case. Registry order is the tiebreak; leaving it to the sort's internals would make the batch
  // depend on the engine.
  const day = "2026-07-15"
  const all = ["one", "two", "three", "four", "five", "six", "seven"]
  const state = swept(Object.fromEntries(all.map((n) => [n, day])))
  assert.deepEqual(names(pickScope({ names: all, state, batch: 7 })), all)
})

test("a component qualifying twice appears once, keeping its strongest reason", () => {
  const out = pickScope({
    names: ["fresh", "other"],
    state: swept({ other: "2026-06-01" }),
    installs: { fresh: 99 },
    batch: 5,
  })
  // `fresh` is both never-swept and the top install; it is listed once, as "new".
  assert.deepEqual(names(out), ["fresh", "other"])
  assert.equal(out[0].reason, "new")
})

test("the batch is capped, and never exceeds the catalog", () => {
  const all = ["a", "b", "c", "d", "e", "f", "g", "h"]
  assert.equal(pickScope({ names: all, batch: 3 }).length, 3)
  assert.equal(pickScope({ names: all, batch: 100 }).length, all.length)
  assert.equal(pickScope({ names: [], batch: 3 }).length, 0)
})

test("the default batch applies when none is passed", () => {
  const all = Array.from({ length: 20 }, (_, i) => `c${i}`)
  assert.equal(DEFAULT_BATCH, 6)
  assert.equal(pickScope({ names: all }).length, DEFAULT_BATCH)
})

test("an unusable SWEEP_BATCH falls back to the default instead of sweeping everything", () => {
  // The regression this pins: SWEEP_BATCH arrives as a string from the environment, and an
  // unparseable one reached the cap as NaN. `picked.length >= NaN` is never true, so the loop ran
  // to the end of the catalog — a run meant to audit six components audited all of them. Zero and
  // negatives are the other direction of the same mistake: they used to cut the batch to one.
  const all = Array.from({ length: 20 }, (_, i) => `c${i}`)
  for (const batch of ["six", "", "  ", "0", "-3", 0, -3, NaN, Infinity, null, {}, []]) {
    assert.equal(
      pickScope({ names: all, batch }).length,
      DEFAULT_BATCH,
      `batch=${JSON.stringify(batch)} should fall back to the default`
    )
  }
})

test("a usable SWEEP_BATCH is honoured, including numeric strings", () => {
  const all = Array.from({ length: 20 }, (_, i) => `c${i}`)
  assert.equal(pickScope({ names: all, batch: "3" }).length, 3)
  assert.equal(pickScope({ names: all, batch: 12 }).length, 12)
  // A fractional override truncates rather than being rejected — `2.7` still means "a couple".
  assert.equal(pickScope({ names: all, batch: "2.7" }).length, 2)
})

test("no installs (D1 unreachable) degrades to new + rotating rather than throwing", () => {
  const state = swept({ b: "2026-06-01" })
  const out = pickScope({ names: ["a", "b"], state, batch: 2 })
  assert.deepEqual(names(out), ["a", "b"])
  assert.deepEqual(
    out.map((x) => x.reason),
    ["new", "rotating"]
  )
})

test("a missing or malformed state is treated as nothing swept yet", () => {
  // The state file is gitignored local operational state: on a fresh checkout it does not exist,
  // and loadState's fallback has no per-component entries at all.
  for (const state of [undefined, {}, { lastRun: null, components: {} }]) {
    const out = pickScope({ names: ["a", "b"], state, batch: 2 })
    assert.deepEqual(names(out), ["a", "b"])
    assert.equal(out[0].reason, "new")
    assert.equal(out[0].lastSwept, null)
  }
})

test("pickScope does not mutate the names it is given", () => {
  // It sorts internally; sorting the caller's array in place would reorder the registry listing.
  const all = ["z", "m", "a"]
  pickScope({ names: all, state: swept({ z: "2026-01-01", m: "2026-02-01", a: "2026-03-01" }), batch: 3 })
  assert.deepEqual(all, ["z", "m", "a"])
})
