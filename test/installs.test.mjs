// Unit tests for the install-reward scope (scripts/_installs.mjs).
//
// This is the number the AEO loop optimises against: learn.mjs decides whether its install reward
// is trustworthy at all (LOW-SIGNAL vs "reward usable") from the total, and judges LIFT /
// REGRESSION per component from the per-item rate; sweep.mjs picks what to audit next from the
// same counts. Every row that leaks in is a fake reward — and the one that leaked was
// `pro/<name>:402`, a Pro-block request that was *denied* for want of a license, i.e. a failed
// purchase read as a successful install. These tests pin both halves of the rule (which items
// count, which clients count) so the two scripts can never drift apart again.
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

const row = (item, ua, n) => ({ item, ua, n })

test("isRewardItem: free components count; catalogue index and Pro rows do not", () => {
  assert.equal(isRewardItem("copy-button"), true)
  assert.equal(isRewardItem("registry"), false)
  assert.equal(isRewardItem("pro/dashboard-overview"), false)
  // A denied Pro fetch — the row that made a failed purchase look like an install.
  assert.equal(isRewardItem("pro/dashboard-overview:402"), false)
  // Missing / empty item names are not a component either.
  assert.equal(isRewardItem(""), false)
  assert.equal(isRewardItem(null), false)
  assert.equal(isRewardItem(undefined), false)
})

test("Pro and catalogue rows are excluded entirely, not just zeroed", () => {
  const out = installsByItem([
    row("copy-button", UA.cli, 3),
    row("pro/dashboard-overview", UA.cli, 40),
    row("pro/dashboard-overview:402", UA.cli, 120),
    row("registry", UA.cli, 25),
  ])
  assert.deepEqual(out, { "copy-button": 3 })
  // Absent, so learn.mjs's total install signal is not inflated by them.
  assert.equal("pro/dashboard-overview" in out, false)
  assert.equal("registry" in out, false)
})

test("only install/human clients add to the count; mirrors and crawlers do not", () => {
  const out = installsByItem([
    row("copy-button", UA.cli, 2),
    row("copy-button", UA.browser, 1),
    row("copy-button", UA.mirror, 500),
    row("copy-button", UA.bot, 900),
  ])
  assert.equal(out["copy-button"], 3)
})

test("an item fetched only by excluded clients stays present with 0", () => {
  // "seen, but no real installs" must be distinguishable from "never fetched": sweep.mjs's
  // top-installed slice filters on a truthy count, and learn.mjs ranks laggards by rate.
  const out = installsByItem([row("tree-view", UA.mirror, 300), row("tree-view", UA.bot, 12)])
  assert.equal(out["tree-view"], 0)
  assert.equal("tree-view" in out, true)
})

test("counts are summed per item across user-agent groups", () => {
  const out = installsByItem([
    row("toast", UA.cli, 4),
    row("toast", "shadcn/2.2.0", 6),
    row("gauge", UA.cli, 1),
  ])
  assert.deepEqual(out, { toast: 10, gauge: 1 })
})

test("non-numeric or missing counts contribute 0 rather than NaN", () => {
  // D1 returns numbers, but a NaN here would silently poison every rate learn.mjs prints.
  const out = installsByItem([
    row("toast", UA.cli, "7"),
    row("toast", UA.cli, undefined),
    row("toast", UA.cli, "not-a-number"),
  ])
  assert.equal(out["toast"], 7)
})

test("empty / missing input is an empty map, not a throw", () => {
  assert.deepEqual(installsByItem([]), {})
  assert.deepEqual(installsByItem(undefined), {})
  assert.deepEqual(installsByItem(null), {})
})
