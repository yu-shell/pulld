#!/usr/bin/env node
// Usage alert for pulld Search. Reads the current month's per-project usage from D1 and prints
// `USAGE-ALERT:` lines when a project nears its quota or total usage looks anomalous, so the
// daily routine can surface it in its notification. Best-effort: never throws / never blocks.
//
// Both counters are per-month flows, and the doc one is the easy misread: `search_usage.docs` is
// the number of documents *sent to ingest* this month, re-indexes included — not the number a
// project has stored. "at 84% of doc quota (4200/5000)" therefore does not mean the customer is
// nearly out of room; it usually means they re-index a whole catalogue on every deploy. Written as
// "indexed" it read the other way, which is the wrong conversation to open with them.
//
// The alerting itself is a pure function (usageAlerts) so it can be unit-tested without D1, a
// wrangler install or a network — the way verify-registry.mjs, sweep.mjs, learn.mjs and
// build-index.mjs all expose theirs. This is the only script in the daily routine that had
// neither a unit test nor an end-to-end one, and it is the one that decides whether a paying
// customer running out of quota is mentioned at all: every way it can go wrong (a bad env
// override, a NULL limit, a row whose counters are strings) ends in the same silent success,
// because "no alerts" and "never looked" print nearly the same line.
//
// Thresholds (override via env):
//   QUOTA_PCT       per-project query/doc usage % that triggers an alert (default 80)
//   GLOBAL_QUERIES  total queries/month across all projects that triggers an anomaly alert
//                   (default 500000 — far above one project's 50k plan = likely abuse/runaway)
//   GLOBAL_DOCS     total documents sent/month across all projects, anomaly threshold
//                   (default 50000)
import { pathToFileURL } from "node:url"
import { d1 } from "./_d1.mjs"

export const DEFAULT_QUOTA_PCT = 80
export const DEFAULT_GLOBAL_QUERIES = 500000
export const DEFAULT_GLOBAL_DOCS = 50000

function clampNum(v, dflt, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt
}

/**
 * The alerts one month of `search_usage` rows earns, and the totals behind them.
 *
 * `rows` is the SELECT shape below: one row per project that has a usage row this month, carrying
 * its two counters and the two limits from `search_projects`.
 *
 * The thresholds are validated here rather than at the call site, the way pickScope resolves
 * SWEEP_BATCH: an unparseable `QUOTA_PCT` reaching the comparison as NaN makes every `>=` false,
 * so the quota alert silently stops existing — an override typo that turns the alerting off is
 * indistinguishable from a quiet month.
 *
 * `quotaPct` comes back out resolved, so the caller reports the threshold the comparison above
 * actually used rather than re-deriving it from the env and risking a different answer.
 *
 * @returns {{alerts: string[], totalQueries: number, totalDocs: number, projects: number,
 *            quotaPct: number}}
 */
export function usageAlerts(rows, { quotaPct, globalQueries, globalDocs } = {}) {
  const pct = clampNum(quotaPct, DEFAULT_QUOTA_PCT, 1, 100)
  const queryCap = clampNum(globalQueries, DEFAULT_GLOBAL_QUERIES, 1, Infinity)
  const docCap = clampNum(globalDocs, DEFAULT_GLOBAL_DOCS, 1, Infinity)

  const alerts = []
  let totalQueries = 0
  let totalDocs = 0
  let projects = 0

  for (const r of rows ?? []) {
    projects++
    const q = Number(r?.queries) || 0
    const d = Number(r?.docs) || 0
    totalQueries += q
    totalDocs += d
    // A limit of 0 or NULL has no percentage to be at — `q / 0` is Infinity and `q / null` is
    // whatever Number(null) makes of it, so guard rather than divide.
    const qPct = r?.q_limit ? Math.round((q / r.q_limit) * 100) : 0
    const dPct = r?.doc_limit ? Math.round((d / r.doc_limit) * 100) : 0
    const who = `${r?.project}${r?.email ? ` <${r.email}>` : ""}`
    if (qPct >= pct) {
      alerts.push(`USAGE-ALERT: ${who} at ${qPct}% of query quota (${q}/${r.q_limit} this month)`)
    }
    if (dPct >= pct) {
      alerts.push(`USAGE-ALERT: ${who} at ${dPct}% of doc quota (${d}/${r.doc_limit} sent this month)`)
    }
  }

  if (totalQueries >= queryCap) {
    alerts.push(
      `USAGE-ALERT: total queries this month = ${totalQueries} (>= ${queryCap}) — check for abuse/runaway`
    )
  }
  if (totalDocs >= docCap) {
    alerts.push(`USAGE-ALERT: total documents sent this month = ${totalDocs} (>= ${docCap})`)
  }

  return { alerts, totalQueries, totalDocs, projects, quotaPct: pct }
}

const monthKey = () => new Date().toISOString().slice(0, 7) // YYYY-MM

// --- CLI: run against the real remote D1 ---
function main() {
  const month = monthKey()
  try {
    const rows = d1(
      "SELECT su.project AS project, su.queries AS queries, su.docs AS docs, " +
        "sp.q_limit AS q_limit, sp.doc_limit AS doc_limit, sp.email AS email " +
        "FROM search_usage su JOIN search_projects sp ON su.project = sp.id " +
        `WHERE su.month = '${month}' AND sp.active = 1`
    )

    const { alerts, totalQueries, totalDocs, projects, quotaPct } = usageAlerts(rows, {
      quotaPct: process.env.QUOTA_PCT,
      globalQueries: process.env.GLOBAL_QUERIES,
      globalDocs: process.env.GLOBAL_DOCS,
    })

    // "with usage", not "active": `search_usage` gains a project's row on its first query or
    // ingest of the month (functions/api/search/_lib.js bumpUsage), and the join above is an
    // INNER one, so an active, paying project that has not been called yet this month is not in
    // `rows` at all. Printed as "N active project(s)" that read as churn — on the 1st of a month
    // it says 0 however many customers there are, which is the one morning the number is most
    // likely to be looked at.
    console.log(
      `pulld Search usage (${month}): ${projects} project(s) with usage this month, ` +
        `${totalQueries} queries, ${totalDocs} documents sent`
    )
    if (alerts.length) {
      for (const a of alerts) console.log(a)
      console.log(`\n${alerts.length} alert(s) — surface these.`)
    } else {
      console.log(`OK — no usage alerts (per-project < ${quotaPct}% quota, totals within bounds).`)
    }
  } catch (e) {
    console.log(`usage-alert skipped (best-effort): ${e.message}`)
    process.exit(0)
  }
}

// Only run the CLI when invoked directly (`node scripts/usage-alert.mjs`), not when imported by
// the unit tests — the guard sweep.mjs, learn.mjs, report.mjs and build-index.mjs already carry.
// Without it, importing this file to test usageAlerts shells out to `npx --yes wrangler@latest`
// against the live D1, twice, inside `node --test`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
