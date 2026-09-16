// The quota alerting for pulld Search — the only paid, metered surface this project has.
//
// usage-alert.mjs had no test of any kind before this file: nothing imported it and nothing
// spawned it, which made it the one script in the daily routine whose failure mode is a clean
// exit. It prints `USAGE-ALERT:` lines the routine forwards, and every way it can go wrong ends
// in the same quiet "OK — no usage alerts" — a customer at 99% of their quota and an override
// typo that turned the comparison into NaN print the same reassuring line.
//
// Written against the pure function rather than the CLI, because the CLI's other half is a
// shell-out to the live D1 (covered separately by test/d1-retry.test.mjs).
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  DEFAULT_GLOBAL_DOCS,
  DEFAULT_GLOBAL_QUERIES,
  DEFAULT_QUOTA_PCT,
  usageAlerts,
} from "../scripts/usage-alert.mjs"

// One row of the CLI's SELECT: a project's two monthly counters beside the two plan limits.
const row = (over = {}) => ({
  project: "acme",
  email: "dev@acme.test",
  queries: 0,
  docs: 0,
  q_limit: 1000,
  doc_limit: 200,
  ...over,
})

test("a project under the threshold earns no alert", () => {
  const { alerts, totalQueries, totalDocs, projects } = usageAlerts([
    row({ queries: 700, docs: 100 }),
  ])
  assert.deepEqual(alerts, [])
  assert.equal(totalQueries, 700)
  assert.equal(totalDocs, 100)
  assert.equal(projects, 1)
})

test("crossing the query threshold names the project, its percentage and who to write to", () => {
  const { alerts } = usageAlerts([row({ queries: 800 })])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /^USAGE-ALERT: acme <dev@acme\.test> at 80% of query quota \(800\/1000/)
})

// The wording earned by PR #19: `search_usage.docs` counts documents SENT this month, re-indexes
// included, not documents stored. "indexed" read as "nearly out of room" and opened the wrong
// conversation with the customer.
test("the doc alert says sent, not stored", () => {
  const { alerts } = usageAlerts([row({ docs: 180 })])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /at 90% of doc quota \(180\/200 sent this month\)/)
  assert.doesNotMatch(alerts[0], /indexed/)
})

test("a project with no email is still identified", () => {
  const { alerts } = usageAlerts([row({ email: null, queries: 1000 })])
  assert.match(alerts[0], /^USAGE-ALERT: acme at 100% of query quota/)
})

test("both counters over the line are two separate alerts", () => {
  const { alerts } = usageAlerts([row({ queries: 900, docs: 190 })])
  assert.equal(alerts.length, 2)
  assert.match(alerts[0], /query quota/)
  assert.match(alerts[1], /doc quota/)
})

// A limit of 0 or NULL is not a project at 0% — it is a project with nothing to be a percentage
// of. Dividing anyway gives Infinity (or, for NULL, whatever Number(null) makes of it), and
// `Infinity >= 80` would alert on every such project forever.
test("a missing or zero limit does not divide, and does not alert", () => {
  for (const limits of [{ q_limit: 0 }, { q_limit: null }, { q_limit: undefined }]) {
    const { alerts } = usageAlerts([row({ queries: 5000, ...limits })])
    assert.deepEqual(alerts, [], JSON.stringify(limits))
  }
})

// D1 hands back whatever the column holds; a counter arriving as a string must not turn the sum
// into concatenation ("0" + 700 = "0700") or the comparison into a string compare.
test("counters that arrive as strings are still numbers", () => {
  const { alerts, totalQueries, totalDocs } = usageAlerts([
    row({ queries: "800", docs: "50" }),
    row({ project: "beta", queries: "100", docs: "10" }),
  ])
  assert.equal(totalQueries, 900)
  assert.equal(totalDocs, 60)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /acme .* at 80% of query quota \(800\/1000/)
})

test("totals add up across projects and the anomaly caps read them", () => {
  const rows = [
    row({ project: "a", queries: 300000, q_limit: 1e9 }),
    row({ project: "b", queries: 300000, q_limit: 1e9 }),
  ]
  const { alerts, totalQueries } = usageAlerts(rows)
  assert.equal(totalQueries, 600000)
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], new RegExp(`total queries this month = 600000 \\(>= ${DEFAULT_GLOBAL_QUERIES}\\)`))
})

test("the document anomaly cap is separate from the query one", () => {
  const { alerts } = usageAlerts([row({ docs: DEFAULT_GLOBAL_DOCS, doc_limit: 1e9 })])
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /total documents sent this month/)
})

// The failure this file exists for. An override that does not parse must fall back to the
// default, not reach the comparison as NaN — `NaN >= x` is false for every x, so a typo in
// QUOTA_PCT would silently switch the per-project alerting off and print the same "OK" as a
// quiet month. Resolved inside the function for the same reason pickScope resolves SWEEP_BATCH.
test("an unusable threshold override falls back to the default rather than disabling the alert", () => {
  for (const bad of ["", "abc", "0", "101", "-5", null, undefined, NaN, {}]) {
    const { alerts, quotaPct } = usageAlerts([row({ queries: 800 })], { quotaPct: bad })
    assert.equal(quotaPct, DEFAULT_QUOTA_PCT, `quotaPct=${String(bad)}`)
    assert.equal(alerts.length, 1, `quotaPct=${String(bad)}`)
  }
})

test("a usable threshold override is honoured, and comes back out as the one that was applied", () => {
  const { alerts, quotaPct } = usageAlerts([row({ queries: 500 })], { quotaPct: "50" })
  assert.equal(quotaPct, 50)
  assert.equal(alerts.length, 1)
  // …and the reported threshold is what the caller prints, so the "no alerts" line can never
  // quote a percentage other than the one that was compared against.
  assert.equal(usageAlerts([], { quotaPct: "50" }).quotaPct, 50)
})

test("the anomaly caps validate their overrides the same way", () => {
  assert.equal(usageAlerts([row({ queries: 10 })], { globalQueries: "5" }).alerts.length, 1)
  assert.deepEqual(usageAlerts([row({ queries: 10 })], { globalQueries: "nope" }).alerts, [])
  assert.equal(usageAlerts([row({ docs: 10, doc_limit: 1e9 })], { globalDocs: "5" }).alerts.length, 1)
})

// The month's first morning: `search_usage` gains a project's row on its first query or ingest,
// so an INNER JOIN over it is empty however many customers are active. The count has to be the
// number of projects with usage — reported as "active", 0 read as churn.
test("no usage this month is no alerts and no projects, not a crash", () => {
  for (const empty of [[], null, undefined]) {
    const { alerts, totalQueries, totalDocs, projects } = usageAlerts(empty)
    assert.deepEqual(alerts, [])
    assert.equal(totalQueries, 0)
    assert.equal(totalDocs, 0)
    assert.equal(projects, 0)
  }
})
