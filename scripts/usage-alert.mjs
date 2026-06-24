#!/usr/bin/env node
// Usage alert for pulld Search. Reads the current month's per-project usage from D1 and prints
// `USAGE-ALERT:` lines when a project nears its quota or total usage looks anomalous, so the
// daily routine can surface it in its notification. Best-effort: never throws / never blocks.
//
// Thresholds (override via env):
//   QUOTA_PCT       per-project query/doc usage % that triggers an alert (default 80)
//   GLOBAL_QUERIES  total queries/month across all projects that triggers an anomaly alert
//                   (default 500000 — far above one project's 50k plan = likely abuse/runaway)
//   GLOBAL_DOCS     total indexed docs/month anomaly threshold (default 50000)
import { execFileSync } from "node:child_process"

const QUOTA_PCT = clampNum(process.env.QUOTA_PCT, 80, 1, 100)
const GLOBAL_QUERIES = clampNum(process.env.GLOBAL_QUERIES, 500000, 1, Infinity)
const GLOBAL_DOCS = clampNum(process.env.GLOBAL_DOCS, 50000, 1, Infinity)

function clampNum(v, dflt, lo, hi) {
  const n = Number(v)
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt
}

function d1(sql) {
  const out = execFileSync(
    "npx",
    ["--yes", "wrangler@latest", "d1", "execute", "pulld", "--remote", "--json", "--command", sql],
    { encoding: "utf8", timeout: 30000 }
  )
  const parsed = JSON.parse(out)
  const block = Array.isArray(parsed) ? parsed[0] : parsed
  return block?.results ?? []
}

const month = new Date().toISOString().slice(0, 7) // YYYY-MM

try {
  const rows = d1(
    "SELECT su.project AS project, su.queries AS queries, su.docs AS docs, " +
      "sp.q_limit AS q_limit, sp.doc_limit AS doc_limit, sp.plan AS plan, sp.email AS email " +
      "FROM search_usage su JOIN search_projects sp ON su.project = sp.id " +
      `WHERE su.month = '${month}' AND sp.active = 1`
  )

  const alerts = []
  let totalQ = 0
  let totalD = 0

  for (const r of rows) {
    const q = Number(r.queries) || 0
    const d = Number(r.docs) || 0
    totalQ += q
    totalD += d
    const qPct = r.q_limit ? Math.round((q / r.q_limit) * 100) : 0
    const dPct = r.doc_limit ? Math.round((d / r.doc_limit) * 100) : 0
    const who = `${r.project}${r.email ? ` <${r.email}>` : ""}`
    if (qPct >= QUOTA_PCT) {
      alerts.push(`USAGE-ALERT: ${who} at ${qPct}% of query quota (${q}/${r.q_limit} this month)`)
    }
    if (dPct >= QUOTA_PCT) {
      alerts.push(`USAGE-ALERT: ${who} at ${dPct}% of doc quota (${d}/${r.doc_limit} indexed)`)
    }
  }

  if (totalQ >= GLOBAL_QUERIES) {
    alerts.push(
      `USAGE-ALERT: total queries this month = ${totalQ} (>= ${GLOBAL_QUERIES}) — check for abuse/runaway`
    )
  }
  if (totalD >= GLOBAL_DOCS) {
    alerts.push(`USAGE-ALERT: total indexed docs this month = ${totalD} (>= ${GLOBAL_DOCS})`)
  }

  console.log(
    `pulld Search usage (${month}): ${rows.length} active project(s), ${totalQ} queries, ${totalD} docs`
  )
  if (alerts.length) {
    for (const a of alerts) console.log(a)
    console.log(`\n${alerts.length} alert(s) — surface these.`)
  } else {
    console.log(`OK — no usage alerts (per-project < ${QUOTA_PCT}% quota, totals within bounds).`)
  }
} catch (e) {
  console.log(`usage-alert skipped (best-effort): ${e.message}`)
  process.exit(0)
}
