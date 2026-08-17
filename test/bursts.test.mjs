import assert from "node:assert/strict"
import { test } from "node:test"

import { groupSessions, utcDay, formatSpan } from "../scripts/_bursts.mjs"

// The shapes below are the real ones out of D1, kept as fixtures because each of them was, at
// some point, read as adoption. Dates are the days they actually happened.

/** 2026-08-15: one client in VN took 21 components in 0.222s under a bare `shadcn` UA. */
const VN_SWEEP = Array.from({ length: 21 }, (_, i) => ({
  ts: 1786818128434 + i * 10,
  ua: "shadcn",
  country: "VN",
  item: `component-${i}`,
}))

/** 2026-07-22: three fetches of the same component in 1.787s — a retry, not three installs. */
const PK_RETRY = [0, 900, 1787].map((offset) => ({
  ts: 1785000000000 + offset,
  ua: "shadcn",
  country: "PK",
  item: "copy-button",
}))

/** 2026-07-20: three components over 154s from the US — the only install-shaped run in the window. */
const US_SPREAD = [0, 60_000, 154_000].map((offset, i) => ({
  ts: 1784800000000 + offset,
  ua: "shadcn",
  country: "US",
  item: `picked-${i}`,
}))

test("a catalogue sweep collapses to one decision", () => {
  const { sweeps, collapsedCount, rawCount } = groupSessions(VN_SWEEP)
  assert.equal(rawCount, 21)
  assert.equal(collapsedCount, 1)
  assert.equal(sweeps.length, 1)
  assert.equal(sweeps[0].distinct, 21)
  assert.equal(sweeps[0].country, "VN")
  assert.ok(sweeps[0].spanMs < 1000, `span was ${sweeps[0].spanMs}ms`)
})

test("a retry of one component counts once and is not called a sweep", () => {
  const { sessions, sweeps, collapsedCount } = groupSessions(PK_RETRY)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].rows, 3)
  assert.equal(sessions[0].distinct, 1)
  assert.equal(sweeps.length, 0)
  assert.equal(collapsedCount, 1)
})

test("components picked minutes apart stay separate decisions", () => {
  const { sessions, sweeps, collapsedCount } = groupSessions(US_SPREAD)
  assert.equal(sessions.length, 3, "gaps over the threshold end the session")
  assert.equal(sweeps.length, 0)
  assert.equal(collapsedCount, 3)
})

test("the same second from two countries is two clients, not one sweep", () => {
  const events = [
    { ts: 1786818128434, ua: "shadcn", country: "DE", item: "a" },
    { ts: 1786818128444, ua: "shadcn", country: "HK", item: "b" },
    { ts: 1786818128454, ua: "shadcn", country: "US", item: "c" },
  ]
  const { sessions, sweeps } = groupSessions(events)
  assert.equal(sessions.length, 3)
  assert.equal(sweeps.length, 0)
})

test("the same second from two user-agents is two clients", () => {
  const events = [
    { ts: 1786818128434, ua: "shadcn", country: "US", item: "a" },
    { ts: 1786818128444, ua: "shadcn-mcp", country: "US", item: "b" },
    { ts: 1786818128454, ua: "shadcn", country: "US", item: "c" },
  ]
  const { sessions } = groupSessions(events)
  assert.equal(sessions.length, 2)
})

test("input order does not change the answer", () => {
  const shuffled = [...VN_SWEEP].reverse()
  const out = groupSessions(shuffled)
  assert.equal(out.collapsedCount, groupSessions(VN_SWEEP).collapsedCount)
  assert.equal(out.sweeps[0].distinct, 21)
  // Counts alone cannot see a session built backwards, because chaining accepts a
  // negative gap just as readily as a small positive one. The span is where it shows.
  assert.equal(out.sweeps[0].spanMs, 200)
  for (const session of out.sessions) {
    assert.ok(session.spanMs >= 0, `span was ${session.spanMs}ms`)
    assert.ok(session.first <= session.last)
  }
})

test("a mixed window keeps the human-shaped run and collapses the sweep", () => {
  const { collapsedCount, sweeps } = groupSessions([...VN_SWEEP, ...US_SPREAD, ...PK_RETRY])
  // 1 for the sweep, 3 for the spread, 1 for the retry.
  assert.equal(collapsedCount, 5)
  assert.equal(sweeps.length, 1)
})

test("rows with no usable timestamp are dropped rather than grouped at the epoch", () => {
  const { sessions } = groupSessions([
    { ts: null, ua: "shadcn", country: "US", item: "a" },
    { ts: "not-a-number", ua: "shadcn", country: "US", item: "b" },
    { ts: 1786818128434, ua: "shadcn", country: "US", item: "c" },
  ])
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].distinct, 1)
})

test("a timestamp sent as a numeric string still groups", () => {
  const { sessions } = groupSessions([
    { ts: "1786818128434", ua: "shadcn", country: "US", item: "a" },
    { ts: "1786818128444", ua: "shadcn", country: "US", item: "b" },
  ])
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].distinct, 2)
})

test("an empty log is not an error", () => {
  const { sessions, sweeps, collapsedCount } = groupSessions([])
  assert.deepEqual([sessions.length, sweeps.length, collapsedCount], [0, 0, 0])
})

test("the thresholds are adjustable, and the defaults are the ones documented", () => {
  // Two components in one chain is deliberately not a sweep by default.
  const pair = [
    { ts: 1000, ua: "shadcn", country: "US", item: "a" },
    { ts: 1500, ua: "shadcn", country: "US", item: "b" },
  ]
  assert.equal(groupSessions(pair).sweeps.length, 0)
  assert.equal(groupSessions(pair, { minItems: 2 }).sweeps.length, 1)
  // And the 2s default is what splits the US run; a wider gap merges it.
  assert.equal(groupSessions(US_SPREAD, { gapMs: 200_000 }).sessions.length, 1)
})

test("the day of a fetch is read in UTC, the way the log stores it", () => {
  assert.equal(utcDay(1786818128434), "2026-08-15")
})

test("spans are readable at both ends of the range", () => {
  assert.equal(formatSpan(222), "222ms")
  assert.equal(formatSpan(1787), "1.79s")
  assert.equal(formatSpan(154_000), "154s")
})
