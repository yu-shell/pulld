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
//
// D1 access — the retry a cold `npx` cache needs, and the cause `e.message` throws away — was
// first worked out here and now lives in scripts/_d1.mjs, shared with the three other scripts on
// the same shell-out.
import { classify, classifyClick, isInstall } from "../functions/_traffic.js"
import { d1 } from "./_d1.mjs"
import { groupSessions, creditSessions, utcDay, formatSpan } from "./_bursts.mjs"
import { isRewardItem } from "./_installs.mjs"

const rawDays = Number(process.argv[2] || 30)
const DAYS = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : 30

function reportFetches() {
  const rows = d1(
    "SELECT item, ua, COUNT(*) AS n " +
      `FROM fetches WHERE date >= date('now','-${DAYS} day') ` +
      "AND item NOT IN ('registry','index') " +
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

// How many separate decisions the install/human columns actually represent.
//
// The per-request classifier cannot see this: a bare `shadcn` UA is an install client whether it
// belongs to a person or to a mirror, and on 2026-08-15 one of them took 21 components in 0.222
// seconds, moving the 30-day column from 10 to 31. Five separate mornings have now been spent
// re-deriving that by hand out of D1, which is the definition of a diagnosis that belongs in the
// tool. This only prints; the reward `learn.mjs` tunes against is deliberately left alone, since
// changing what counts as an install changes the meaning of every number beside it.
function reportSessions() {
  const rows = d1(
    "SELECT item, ts, ua, country " +
      `FROM fetches WHERE date >= date('now','-${DAYS} day')`
  ).filter((r) => isRewardItem(r.item) && isInstall(r.ua))

  if (!rows.length) return

  const { sweeps, rawCount, collapsedCount } = groupSessions(rows)
  // The same call learn.mjs's reward is built from, so the two never disagree about how much
  // signal exists on a given morning.
  const { total: rewardTotal } = creditSessions(rows)
  console.log(`\nreward hygiene — how many decisions the install+human columns hold (last ${DAYS} days)`)
  if (!sweeps.length) {
    console.log(`  no bursts: ${rawCount} fetches look like ${collapsedCount} separate choices (${rewardTotal} rewardable)`)
    return
  }
  for (const s of sweeps) {
    console.log(
      `  ${utcDay(s.first)} ${(s.country || "??").padEnd(3)}` +
        ` ${(s.ua || "(none)").slice(0, 28).padEnd(30)}` +
        `${String(s.distinct).padStart(3)} components in ${formatSpan(s.spanMs)}`
    )
  }
  console.log(
    `  ^ each line is one client walking the catalogue, not that many people choosing.\n` +
      `  counted as sessions: ${rawCount} fetches -> ${collapsedCount} client actions,` +
      ` of which ${rewardTotal} are per-component choices learn.mjs can reward`
  )
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
    "SELECT target, ua, referer, COUNT(*) AS n " +
      `FROM clicks WHERE date >= date('now','-${DAYS} day') GROUP BY target, ua, referer`
  )
  const byTarget = new Map()
  const sources = new Map()
  for (const r of rows) {
    const t = String(r.target)
    const n = Number(r.n) || 0
    const acc = byTarget.get(t) || { human: 0, direct: 0, crawler: 0, other: 0 }
    const kind = classifyClick({ ua: r.ua, referer: r.referer })
    if (kind === "human") {
      acc.human += n
      const src = String(r.referer || "").trim()
      sources.set(src, (sources.get(src) || 0) + n)
    } else if (kind === "direct") acc.direct += n
    else if (kind === "crawler") acc.crawler += n
    else acc.other += n
    byTarget.set(t, acc)
  }
  console.log(`\nbuy-button clicks (last ${DAYS} days)`)
  if (!byTarget.size) {
    console.log("  (none yet)")
    return
  }
  for (const [t, c] of byTarget) {
    console.log(
      `  ${t.padEnd(10)}from-page=${c.human}\tdirect-hit=${c.direct + c.other}\tcrawler=${c.crawler}`
    )
  }
  console.log("  from-page  = arrived with the landing page as referrer — the only bucket that is a person choosing to buy")
  console.log("  direct-hit = /go/* fetched without ever loading the page; a script wearing a browser user-agent")
  console.log("  (crawlers are shown the link instead of being redirected, so they reach no checkout)")
  if (sources.size) {
    console.log("  which page sent the real clicks:")
    for (const [src, n] of [...sources].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${String(n).padStart(3)}  ${src.slice(0, 96)}`)
    }
  }
}

try {
  reportFetches()
} catch (e) {
  console.log(`failed to fetch report (best-effort): ${e.message}`)
}
try {
  reportSessions()
} catch (e) {
  console.log(`\n(no session report: ${String(e.message).split("\n")[0]})`)
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
