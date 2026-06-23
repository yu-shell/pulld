#!/usr/bin/env node
// Fetch report — aggregates D1 `fetches` per item (non-bot rows = clean) to show which
// components are being installed most.
// Best-effort (does not fail if D1 is unreachable). Usage: `node scripts/report.mjs [days]`
import { execFileSync } from "node:child_process"

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

try {
  const rows = d1(
    "SELECT item, COUNT(*) AS raw, " +
      "SUM(CASE WHEN is_bot=0 THEN 1 ELSE 0 END) AS clean " +
      `FROM fetches WHERE date >= date('now','-${DAYS} day') AND item != 'registry' ` +
      "GROUP BY item ORDER BY clean DESC, raw DESC"
  )
  if (!rows.length) {
    console.log(`(last ${DAYS} days: no fetch records — normal right after launch)`)
    process.exit(0)
  }
  console.log(`fetches per item (last ${DAYS} days, clean = non-bot)`)
  for (const r of rows) {
    console.log(`  ${String(r.item).padEnd(16)} clean=${r.clean}\traw=${r.raw}`)
  }
} catch (e) {
  console.log(`failed to fetch report (best-effort): ${e.message}`)
  process.exit(0)
}
