// Unit tests for the install-reward scope (scripts/_installs.mjs).
//
// This is the number the AEO loop optimises against: learn.mjs decides whether its install reward
// is trustworthy at all (LOW-SIGNAL vs "reward usable") from the total, and judges LIFT /
// REGRESSION per component from the per-item rate; sweep.mjs picks what to audit next from the
// same counts. Every row that leaks in is a fake reward — and the one that leaked was
// `pro/<name>:402`, a Pro-block request that was *denied* for want of a license, i.e. a failed
// purchase read as a successful install. These tests pin all three halves of the rule (which
// items count, which clients count, and how many *choices* a set of fetches represents) so the
// two scripts can never drift apart again.
//
// The third was added on 2026-08-17: counting rows, one client in VN that took 21 components in
// 0.222s read as 21 installs and carried the reward gate over MIN_SIGNAL by itself. The input
// shape changed with it — one row per fetch with a timestamp, not a GROUP BY count, because the
// count is precisely what could not be trusted.
import { test } from "node:test"
import assert from "node:assert/strict"
import { isRewardItem, installsByItem } from "../scripts/_installs.mjs"

// User-agents, one per bucket of functions/_traffic.js.
const UA = {
  cli: "shadcn/2.1.0", // install — a developer adding a component
  // human — counts as reward. Written out in full on purpose: a browser announces the engine it
  // renders with, and _traffic.js requires that, so an abbreviated "Mozilla/5.0 (Macintosh; …)"
  // is a script in a costume rather than a person and would (correctly) not count here.
  browser:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  mirror: "shadcn-helper-intellij-plugin/1.2.0", // index — a catalogue sweep, not adoption
  bot: "Googlebot/2.1 (+http://www.google.com/bot.html)", // crawler
}

// Far enough apart that each fetch is its own session unless a test says otherwise.
let clock = 1786800000000
const row = (item, ua, gapMs = 60_000) => {
  clock += gapMs
  return { item, ua, ts: clock, country: "US" }
}
/** Fetches inside one client action — the shape that used to be counted N times. */
const burst = (items, ua = UA.cli, country = "US") =>
  items.map((item, i) => ({ item, ua, country, ts: clock + 1000 + i * 10 }))

test("isRewardItem: free components count; catalogue index and Pro rows do not", () => {
  assert.equal(isRewardItem("copy-button"), true)
  assert.equal(isRewardItem("registry"), false)
  // The same catalogue served at official shadcn's path. It returns 200 since 2026-08-17, so
  // unlike the 404 it replaced it lands in `fetches` and would otherwise read as an install.
  assert.equal(isRewardItem("index"), false)
  assert.equal(isRewardItem("pro/dashboard-overview"), false)
  // A denied Pro fetch — the row that made a failed purchase look like an install.
  assert.equal(isRewardItem("pro/dashboard-overview:402"), false)
  // Missing / empty item names are not a component either.
  assert.equal(isRewardItem(""), false)
  assert.equal(isRewardItem(null), false)
  assert.equal(isRewardItem(undefined), false)
})

test("Pro rows and both catalogue names are excluded entirely, not just zeroed", () => {
  const out = installsByItem([
    row("copy-button", UA.cli),
    row("pro/dashboard-overview", UA.cli),
    row("pro/dashboard-overview:402", UA.cli),
    row("registry", UA.cli),
    row("index", UA.cli),
  ])
  assert.deepEqual(out, { "copy-button": 1 })
  assert.equal("index" in out, false)
  // Absent, so learn.mjs's total install signal is not inflated by them.
  assert.equal("pro/dashboard-overview" in out, false)
  assert.equal("registry" in out, false)
})

test("only install/human clients count; mirrors and crawlers do not", () => {
  const out = installsByItem([
    row("copy-button", UA.cli),
    row("copy-button", UA.browser),
    row("copy-button", UA.mirror),
    row("copy-button", UA.bot),
  ])
  // Two separate choices minutes apart — the CLI one and the browser one.
  assert.equal(out["copy-button"], 2)
})

test("an item fetched only by excluded clients stays present with 0", () => {
  // "seen, but no real installs" must be distinguishable from "never fetched": sweep.mjs's
  // top-installed slice filters on a truthy count, and learn.mjs ranks laggards by rate.
  const out = installsByItem([row("tree-view", UA.mirror), row("tree-view", UA.bot)])
  assert.equal(out["tree-view"], 0)
  assert.equal("tree-view" in out, true)
})

test("a catalogue sweep credits nothing to any component it touched", () => {
  // The 2026-08-15 shape. Every component was fetched, none of them was chosen.
  const swept = ["copy-button", "toast", "gauge", "kbd", "timeline"]
  const out = installsByItem(burst(swept))
  for (const item of swept) {
    assert.equal(out[item], 0, item)
    assert.equal(item in out, true, `${item} should still be visible as seen`)
  }
})

test("a real choice still counts when it happens beside a sweep", () => {
  const out = installsByItem([
    ...burst(["a", "b", "c", "d"]),
    row("gauge", UA.cli, 600_000),
  ])
  assert.equal(out["gauge"], 1)
  assert.equal(out["a"], 0)
})

test("repeated fetches of one component inside a session count once", () => {
  // The 2026-07-22 PK shape: three fetches of the same component in 1.787s is a retry.
  const base = clock + 5_000_000
  const out = installsByItem([
    { item: "copy-button", ua: UA.cli, country: "PK", ts: base },
    { item: "copy-button", ua: UA.cli, country: "PK", ts: base + 900 },
    { item: "copy-button", ua: UA.cli, country: "PK", ts: base + 1787 },
  ])
  assert.equal(out["copy-button"], 1)
})

test("components picked minutes apart are separate choices", () => {
  const out = installsByItem([
    row("toast", UA.cli),
    row("toast", "shadcn/2.2.0"),
    row("gauge", UA.cli),
  ])
  assert.deepEqual(out, { toast: 2, gauge: 1 })
})

test("rows with an unusable timestamp do not become a phantom choice", () => {
  const out = installsByItem([
    { item: "toast", ua: UA.cli, country: "US", ts: null },
    { item: "toast", ua: UA.cli, country: "US", ts: "not-a-number" },
  ])
  assert.equal(out["toast"], 0)
  assert.equal("toast" in out, true)
})

test("empty / missing input is an empty map, not a throw", () => {
  assert.deepEqual(installsByItem([]), {})
  assert.deepEqual(installsByItem(undefined), {})
  assert.deepEqual(installsByItem(null), {})
})
