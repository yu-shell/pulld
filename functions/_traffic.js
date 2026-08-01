// One source of truth for "who fetched this?".
//
// The answer is not cosmetic: it feeds the report, sweep.mjs's install counts, and learn.mjs's
// bandit reward. A client counted as an install is a fake reward, and the loop then tunes
// metadata against noise. The original regex missed the two largest clients (`node` and
// `shadcn-helper-intellij-plugin`), which is how ~1900 automated fetches read as real adoption.
//
// Four buckets, checked in order:
//   crawler — indexers, directory scrapers, generic HTTP clients. Not a person.
//   index   — a real product, but one that mirrors the whole catalogue rather than installing
//             from it (IDE plugins, registry mirrors). Evidence for the IntelliJ plugin: over 40
//             days it fetched EVERY component exactly 20 times — a uniform sweep, not 1001
//             developers picking components. Worth watching as distribution; worthless as reward.
//   install — a developer adding a component right now (shadcn CLI, an MCP server).
//   human   — a browser. Rare; the registry is not something people read by hand.
//
// `fetches.is_bot` stores only the crawler verdict (1/0), so its meaning is unchanged for rows
// written before this file existed. Everything richer is derived from the stored `ua` at read
// time, which is what lets the scripts re-classify history instead of only new traffic.

// The `(+https://…)` / `(+contact)` convention inside a UA is a self-identifying automated agent —
// a stronger and less over-fitted signal than naming each scraper we happen to have seen. The
// job words (audit, probe, recon, …) are the next best thing: an agent that describes what it is
// doing to us is not a person, whatever it calls itself.
const CRAWLER_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|headless|python-requests|curl\/|wget|go-http|java\/|\(\+|^node(\/|$)|node-fetch|undici|axios|okhttp|harvest|indexer|enricher|profiler|scout|audit|research|recon|probe|health|spike|directory|monitor|uptime|scraper|fetcher/i

// Catalogue mirrors. Move a client out of here the moment its fetches stop looking like a sweep.
const INDEX_UA = /shadcn-helper|-mirror\b/i

// Install clients. Checked after CRAWLER_UA, so `Mozilla/5.0 shadcn-audit` stays a crawler.
// The CLI sends bare `shadcn` (or `shadcn/<version>`) and nothing else, so the name has to end
// there: `ShadCN Directory Search/1.1` is a directory crawling us, not somebody installing.
const INSTALL_UA = /^shadcn(\/|$)|shadcn-mcp|@shadcn|pulld-mcp/i

// A browser announces the engine it renders with; scripts that put on a Mozilla costume do not.
// Both halves are needed: `Mozilla/5.0` alone, and `Mozilla/5.0 (compatible)`, are the two most
// common disguises in this log — 45 fetches of the first arrived in two 0.2-second bursts of 22
// different component names, which is an agent guessing names, not a person reading JSON.
const BROWSER_UA = /^mozilla\/\d/i
const BROWSER_ENGINE = /applewebkit|gecko\/|chrome\/|chromium|safari\/|firefox\/|edge?\/|opr\/|opera|trident|msie|version\/\d/i

export function isCrawler(ua) {
  return CRAWLER_UA.test(String(ua || ""))
}

// "" (no user-agent at all) is not a browser — every real client sends one.
export function classify(ua) {
  const s = String(ua || "")
  if (!s || CRAWLER_UA.test(s)) return "crawler"
  if (INDEX_UA.test(s)) return "index"
  if (INSTALL_UA.test(s)) return "install"
  // Whatever is left is only a person if it looks like a browser. Unknown clients land in
  // `crawler` on purpose: this feeds a reward signal, where wrongly ignoring a real developer
  // costs one data point but wrongly counting a script teaches the loop to chase scrapers.
  // A new install client belongs in INSTALL_UA above, not in this fallback.
  return BROWSER_UA.test(s) && BROWSER_ENGINE.test(s) ? "human" : "crawler"
}

// The reward signal. Deliberately excludes `index`: a mirror refreshing its copy of the catalogue
// says nothing about which component is worth installing, and it is large enough to drown the
// handful of real CLI installs it would otherwise be added to. Kept as one function because
// learn.mjs (bandit reward), sweep.mjs (what to work on next) and the report must agree — three
// copies of this rule is how the loop starts optimising for scrapers.
export const isInstall = (ua) => {
  const k = classify(ua)
  return k === "install" || k === "human"
}
