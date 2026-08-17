// One source of truth for "what was fetched?" — the companion to functions/_traffic.js.
//
// _traffic.js centralises *who* fetched (user-agent → install / index / human / crawler) precisely
// because learn.mjs, sweep.mjs and the report must agree on it. *What* was fetched needs the same
// treatment: the `fetches` table is not one row type. Alongside a free component it also holds
//   - `registry`          — the catalogue index, not a component install
//   - `pro/<name>`        — a paid Pro block (a different funnel, and gated by a license)
//   - `pro/<name>:402`    — a Pro block request that was DENIED for lack of a license
// none of which is evidence that a free component is worth installing. `pro/<name>:402` is the
// worst of the three: a failed purchase attempt counted as a successful install.
//
// The rule lived in sweep.mjs's SQL (`item NOT LIKE 'pro/%' AND item != 'registry'`) but not in
// learn.mjs's, so the two disagreed about the same table. Keeping it here means the reward scope
// can't drift between the loop that picks what to work on and the loop that judges whether a
// metadata change paid off.
import { isInstall } from "../functions/_traffic.js"
import { creditSessions } from "./_bursts.mjs"

// The two catalogue names. `registry` is what `shadcn build` calls its index; `index` is the same
// catalogue served again at official shadcn's path so clients probing there can see this registry
// (scripts/build-index.mjs). Publishing the second one on 2026-08-17 turned what had been a 404 —
// recorded in `misses` and harmless — into a 200 served under the item name `index`, which would
// otherwise have walked straight into the reward as if it were a component somebody installed.
const CATALOGUE_ITEMS = new Set(["registry", "index"])

// True when a `fetches.item` value is a free component whose fetches count as install reward.
export const isRewardItem = (item) => {
  const s = String(item ?? "")
  return s !== "" && !CATALOGUE_ITEMS.has(s) && !s.startsWith("pro/")
}

// rows: the `SELECT item, ts, ua, country FROM fetches ...` shape both callers use — one row per
// fetch, NOT a GROUP BY count, because the count is exactly what cannot be trusted.
//
// Returns { [item]: choices } over reward items only, with crawlers and catalogue mirrors excluded
// by _traffic.js's isInstall and *bursts* excluded by _bursts.js's creditSessions. Counting rows
// read 21 fetches from one client in 0.222s as 21 installs, which is how a single mirror in VN
// moved the 30-day column from 10 to 31 and carried this loop's reward gate over MIN_SIGNAL on
// nothing. An item fetched only by excluded clients — or only inside a sweep — stays in the map
// with 0, so callers can still tell "seen, but nobody chose it" from "never fetched".
export function installsByItem(rows) {
  const out = {}
  const events = []
  for (const r of rows ?? []) {
    const item = String(r?.item ?? "")
    if (!isRewardItem(item)) continue
    out[item] = out[item] || 0
    if (isInstall(r?.ua)) events.push({ item, ts: r?.ts, ua: r?.ua, country: r?.country })
  }
  const { byItem } = creditSessions(events)
  for (const item of Object.keys(byItem)) out[item] = byItem[item]
  return out
}
