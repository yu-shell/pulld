#!/usr/bin/env node
// Fetch report — which components are actually being installed, and how many buy-button clicks
// that turned into.
//
// Traffic is split into install / index / human / crawler by functions/_traffic.js, re-derived
// from the stored user-agent rather than the `is_bot` column, so rows written under the old
// (leakier) regex are classified correctly too. `install` is the number that matters — `index` is
// a mirror sweeping the whole catalogue, which looks like adoption only in the aggregate.
//
// Best-effort (does not fail if D1 is unreachable). Usage: `node scripts/report.mjs [days]`
import { execFileSync } from "node:child_process"
import { classify } from "../functions/_traffic.js"

const rawDays = Number(process.argv[2] || 30)
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30

function d1(sql) {
  const out = execFileSync(
    "npx",
    [
      "--yes",
      "wrangler@latest",
      "d1",
      "execute",
      "pulld",
      "--remote",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", timeout: 30000 }
  )
  const parsed = JSON.parse(out)
  const block = Array.isArray(parsed) ? parsed[0] : parsed
  return block?.results ?? []
}

function reportFetches() {
  const rows = d1(
    "SELECT item, ua, COUNT(*) AS n " +
      `FROM fetches WHERE date >= date('now','-${DAYS} day') AND item != 'registry' ` +
      "GROUP BY item, ua"
  )
  if (!rows.length) {
    console.log(`(last ${DAYS} days: no fetch records — normal right after launch)`)
    return
  }

  const byItem = new Map()
  const clients = new Map()
  const totals = { install: 0, index: 0, human: 0, crawler: 0 }
  for (const r of rows) {
    const item = String(r.item)
    const n = Number(r.n) || 0
    const kind = classify(r.ua)
    const acc = byItem.get(item) || { install: 0, index: 0, human: 0, crawler: 0 }
    acc[kind] += n
    byItem.set(item, acc)
    totals[kind] += n
    if (kind === "install" || kind === "index") {
      const key = `${kind}\t${String(r.ua || "").slice(0, 40)}`
      clients.set(key, (clients.get(key) || 0) + n)
    }
  }

  const ranked = [...byItem.entries()].sort(
    (a, b) => b[1].install + b[1].human - (a[1].install + a[1].human) || b[1].index - a[1].index
  )
  console.log(`fetches per item (last ${DAYS} days)`)
  console.log(`  ${"item".padEnd(22)}install\thuman\tindex\tcrawler`)
  for (const [item, c] of ranked) {
    console.log(`  ${item.padEnd(22)}${c.install}\t${c.human}\t${c.index}\t${c.crawler}`)
  }
  console.log(
    `\ntotal: install=${totals.install} human=${totals.human}` +
      ` index=${totals.index} crawler=${totals.crawler}`
  )

  // Print who each non-crawler fetch came from, so `install`/`index` is never read as "N
  // developers" when it is one client repeating itself.
  if (clients.size) {
    console.log("\nclients (by user-agent)")
    for (const [key, n] of [...clients.entries()].sort((a, b) => b[1] - a[1])) {
      const [kind, ua] = key.split("\t")
      console.log(`  ${kind.padEnd(8)}${(ua || "(none)").padEnd(42)}${n}`)
    }
  }
}

function reportClicks() {
  const rows = d1(
    "SELECT target, ua, COUNT(*) AS n " +
      `FROM clicks WHERE date >= date('now','-${DAYS} day') GROUP BY target, ua`
  )
  const byTarget = new Map()
  for (const r of rows) {
    const t = String(r.target)
    const acc = byTarget.get(t) || { install: 0, index: 0, human: 0, crawler: 0 }
    acc[classify(r.ua)] += Number(r.n) || 0
    byTarget.set(t, acc)
  }
  console.log(`\nbuy-button clicks (last ${DAYS} days)`)
  if (!byTarget.size) {
    console.log("  (none yet)")
    return
  }
  for (const [t, c] of byTarget) {
    console.log(
      `  ${t.padEnd(10)}human=${c.human}\tother-clients=${c.install + c.index}\tcrawler=${c.crawler}`
    )
  }
  console.log("  (crawlers are shown the link instead of being redirected, so they reach no checkout)")
}

try {
  reportFetches()
} catch (e) {
  console.log(`failed to fetch report (best-effort): ${e.message}`)
}
try {
  reportClicks()
} catch (e) {
  // Missing table = /go/* not deployed yet (see db/schema.sql); nothing to report.
  console.log(`\n(no click report: ${String(e.message).split("\n")[0]})`)
}
