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

// True when a `fetches.item` value is a free component whose fetches count as install reward.
export const isRewardItem = (item) => {
  const s = String(item ?? "")
  return s !== "" && s !== "registry" && !s.startsWith("pro/")
}

// rows: the `SELECT item, ua, COUNT(*) AS n ... GROUP BY item, ua` shape both callers use.
// Returns { [item]: cleanInstalls } over reward items only, crawlers and catalogue mirrors
// excluded by _traffic.js's isInstall. An item that was fetched only by excluded clients stays in
// the map with 0, so callers can tell "seen, but no real installs" from "never fetched".
export function installsByItem(rows) {
  const out = {}
  for (const r of rows ?? []) {
    const item = String(r?.item ?? "")
    if (!isRewardItem(item)) continue
    out[item] = out[item] || 0
    if (isInstall(r?.ua)) out[item] += Number(r?.n) || 0
  }
  return out
}
