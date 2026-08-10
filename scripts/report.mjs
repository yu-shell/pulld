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

// The first call of the day fails and the second succeeds — eight times running now, always with
// the message swallowed to `Command failed: npx …` because execFileSync puts only the command in
// `e.message` and the real cause in `e.stderr`, which nothing read. `npx --yes wrangler@latest`
// resolves and installs the package on a cold cache, which does not fit the 30s budget; the
// warmed second attempt takes under two seconds. So: one retry, and the cause is kept either way
// rather than being rediscovered every morning.
function d1Once(sql, timeout) {
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
    { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }
  )
  const parsed = JSON.parse(out)
  const block = Array.isArray(parsed) ? parsed[0] : parsed
  return block?.results ?? []
}

const cause = (e) =>
  String(e.stderr || e.stdout || "")
    .trim()
    .split("\n")
    .slice(-4)
    .join(" | ")

function d1(sql) {
  const failed = []
  // A cold `npx` install is slow, not broken, so the first attempt gets the longer budget.
  for (const timeout of [60000, 30000]) {
    try {
      return d1Once(sql, timeout)
    } catch (e) {
      const why = cause(e)
      failed.push(`${e.message.split("\n")[0]}${why ? ` — ${why}` : ""}`)
    }
  }
  throw new Error(failed.map((f, i) => `attempt ${i + 1}: ${f}`).join("\n  "))
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

// Names asked for that this registry does not ship. This is the closest thing to a question the
// log ever records — everything else says what was taken, this says what was wanted — so it is
// printed next to the fetch table rather than left for an ad-hoc query. Read it with the client
// in view: the bulk is one IDE plugin walking official shadcn's catalogue, which says nothing
// about demand, while a name nobody else guesses arriving from an install client does.
function reportMisses() {
  const rows = d1(
    "SELECT item, ua, COUNT(*) AS n " +
      `FROM misses WHERE date >= date('now','-${DAYS} day') GROUP BY item, ua`
  )
  console.log(`\nmisses — names asked for that do not exist (last ${DAYS} days)`)
  if (!rows.length) {
    console.log("  (none recorded)")
    return
  }

  const byItem = new Map()
  for (const r of rows) {
    const item = String(r.item)
    const acc = byItem.get(item) || { install: 0, index: 0, human: 0, crawler: 0 }
    acc[classify(r.ua)] += Number(r.n) || 0
    byItem.set(item, acc)
  }

  // Ranked by who asked, not by how often: an index mirror sweeping 60 official names every day
  // would otherwise bury the one name a developer typed.
  const ranked = [...byItem.entries()].sort(
    (a, b) => b[1].install + b[1].human - (a[1].install + a[1].human) || b[1].index - a[1].index
  )
  const notable = ranked.filter((r) => r[1].install || r[1].human)
  console.log(`  ${"name".padEnd(22)}install\thuman\tindex\tcrawler`)
  for (const [item, c] of ranked.slice(0, 25)) {
    console.log(`  ${item.padEnd(22)}${c.install}\t${c.human}\t${c.index}\t${c.crawler}`)
  }
  if (ranked.length > 25) console.log(`  … and ${ranked.length - 25} more names`)
  console.log(
    notable.length
      ? `  ^ asked for by an install client or a browser: ${notable.map((r) => r[0]).join(", ")}`
      : "  (no miss came from an install client or a browser — all automated)"
  )
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
  reportMisses()
} catch (e) {
  // Missing table = the misses migration has not been applied to this D1 yet (db/schema.sql).
  console.log(`\n(no miss report: ${String(e.message).split("\n")[0]})`)
}
try {
  reportClicks()
} catch (e) {
  // Missing table = /go/* not deployed yet (see db/schema.sql); nothing to report.
  console.log(`\n(no click report: ${String(e.message).split("\n")[0]})`)
}
