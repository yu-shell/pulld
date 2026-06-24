#!/usr/bin/env node
// learn.mjs — install-reward metadata tuning for pulld (the AEO loop), honest about low traffic.
//
// Reward = installs (D1 `fetches`, non-bot = "clean"). AI agents read a STATIC registry, so we
// can't A/B test descriptions per impression. Instead this runs a measured improve-the-laggards
// loop and lets the daily routine (Claude) do the actual rewrite:
//   1. Evaluate past tunings: compare a tuned component's recent install rate vs the baseline
//      captured when it was tuned → LIFT / REGRESSION / FLAT. Recommend reverting regressions.
//      (Confounded by time/seasonality and thin traffic — treated as a soft signal, not proof.)
//   2. NEXT-TUNE: pick the weakest-signal component not tuned within the window.
//   3. If total installs in the window are below MIN_SIGNAL, say LOW-SIGNAL: the routine then
//      improves metadata by the AEO rubric alone, without claiming any install reward.
//
// The routine rewrites the title/description per criteria.md AEO rules, then runs
// `node scripts/learn.mjs mark <name>` to snapshot the new baseline. State lives in
// data/learn-state.json (gitignored; regenerates — missing state just means "untuned").
// Best-effort: never throws, never blocks the routine.

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_PATH = join(ROOT, "data", "learn-state.json")
const WINDOW = clampInt(process.env.LEARN_WINDOW, 14, 1, 365) // rate window, days
const MIN_SIGNAL = clampInt(process.env.LEARN_MIN_SIGNAL, 20, 1, 1e9) // clean installs in window to trust reward
const EVAL_AFTER = clampInt(process.env.LEARN_EVAL_AFTER, WINDOW, 1, 365) // days before judging a tuning
const REGRESSION_DROP = 0.3 // >=30% rate drop vs baseline = regression
const LIFT_GAIN = 0.15 // >=15% rate gain = lift

function clampInt(v, d, lo, hi) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d
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

function ratesByItem() {
  const rows = d1(
    "SELECT item, SUM(CASE WHEN is_bot=0 THEN 1 ELSE 0 END) AS clean " +
      `FROM fetches WHERE date >= date('now','-${WINDOW} day') AND item != 'registry' GROUP BY item`
  )
  const out = {}
  for (const r of rows) out[String(r.item)] = (Number(r.clean) || 0) / WINDOW
  return out
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"))
  } catch {
    return {}
  }
}
function saveState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n")
}
function loadRegistry() {
  return JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
}
const descHash = (t) => createHash("sha256").update(String(t || "")).digest("hex").slice(0, 12)
const today = () => new Date().toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000)

const [cmd, ...args] = process.argv.slice(2)

// --- mark: snapshot the baseline after the routine tuned a component's metadata ---
if (cmd === "mark") {
  if (!args.length) {
    console.log("usage: learn.mjs mark <name...>")
    process.exit(0)
  }
  let rates = {}
  try {
    rates = ratesByItem()
  } catch {
    /* baseline 0 if D1 unreachable */
  }
  const reg = loadRegistry()
  const state = loadState()
  for (const name of args) {
    const item = reg.items.find((i) => i.name === name)
    if (!item) {
      console.log(`  (skip ${name}: not in registry)`)
      continue
    }
    state[name] = {
      tunedAt: today(),
      descHash: descHash(item.description),
      baselineRate: rates[name] ?? 0,
    }
    console.log(`  marked ${name} (baselineRate=${(rates[name] ?? 0).toFixed(3)}/day)`)
  }
  saveState(state)
  process.exit(0)
}

// --- default: evaluate prior tunings + recommend the next candidate ---
try {
  const reg = loadRegistry()
  const rates = ratesByItem()
  const totalWindow = Object.values(rates).reduce((s, r) => s + r * WINDOW, 0)
  const state = loadState()
  const lowSignal = totalWindow < MIN_SIGNAL

  console.log(
    `learn: window=${WINDOW}d, total clean installs≈${Math.round(totalWindow)} ` +
      `(${lowSignal ? `< ${MIN_SIGNAL} → LOW-SIGNAL` : "reward usable"})`
  )

  // 1) evaluate prior tunings whose description is unchanged and old enough to judge
  for (const item of reg.items) {
    const st = state[item.name]
    if (!st) continue
    if (descHash(item.description) !== st.descHash) continue // changed since mark; awaits re-mark
    if (daysBetween(st.tunedAt, today()) < EVAL_AFTER) continue
    if (lowSignal) {
      console.log(`  ~ ${item.name}: tuned, but signal too thin to judge`)
      continue
    }
    const now = rates[item.name] ?? 0
    const base = st.baselineRate ?? 0
    if (base <= 0) {
      console.log(
        now > 0
          ? `  ↑ LIFT ${item.name}: 0 → ${now.toFixed(3)}/day since tuning`
          : `  = FLAT ${item.name}: still 0/day`
      )
      continue
    }
    const lift = (now - base) / base
    if (lift <= -REGRESSION_DROP) {
      console.log(
        `  ↓ REGRESSION ${item.name}: ${base.toFixed(3)}→${now.toFixed(3)}/day ` +
          `(${Math.round(lift * 100)}%) — revert its last metadata change`
      )
    } else if (lift >= LIFT_GAIN) {
      console.log(
        `  ↑ LIFT ${item.name}: ${base.toFixed(3)}→${now.toFixed(3)}/day (+${Math.round(lift * 100)}%) — keep`
      )
    } else {
      console.log(`  = FLAT ${item.name}: ${base.toFixed(3)}→${now.toFixed(3)}/day`)
    }
  }

  // 2) pick the next candidate: weakest install signal, not tuned within the window
  const pick = reg.items
    .filter((i) => {
      const st = state[i.name]
      return !st || daysBetween(st.tunedAt, today()) >= WINDOW
    })
    .map((i) => ({ name: i.name, rate: rates[i.name] ?? 0, desc: i.description || "" }))
    .sort((a, b) => a.rate - b.rate || a.desc.length - b.desc.length)[0]

  if (!pick) {
    console.log("  (no candidate — all components tuned within the window)")
    process.exit(0)
  }
  console.log(`\nNEXT-TUNE: ${pick.name} (rate=${pick.rate.toFixed(3)}/day)`)
  console.log(
    lowSignal
      ? `  LOW-SIGNAL → improve by the AEO rubric (criteria.md): sharpen "when to use", add the ` +
          `trigger phrases / synonyms / framework terms an agent would match. Do not claim reward.`
      : `  install-reward → this laggard underperforms peers; make its title/description more ` +
          `specific and matchable, then run \`learn.mjs mark ${pick.name}\`.`
  )
  console.log(`  current: ${pick.desc.slice(0, 200)}`)
} catch (e) {
  console.log(`learn skipped (best-effort): ${e.message}`)
  process.exit(0)
}
