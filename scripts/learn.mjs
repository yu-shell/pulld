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
//
// The verdict itself (tuningVerdict) is a pure function so it can be unit-tested without D1, a
// state file or a registry — mirroring verify-registry.mjs and sweep.mjs. It is what decides
// whether a metadata change is kept or reverted, so a silent change in it silently rewrites the
// catalogue's copy.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createHash } from "node:crypto"
import { installsByItem } from "./_installs.mjs"
import { d1 } from "./_d1.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_PATH = join(ROOT, "data", "learn-state.json")
const WINDOW = clampInt(process.env.LEARN_WINDOW, 14, 1, 365) // rate window, days
const MIN_SIGNAL = clampInt(process.env.LEARN_MIN_SIGNAL, 20, 1, 1e9) // clean install *choices* in window to trust reward
const EVAL_AFTER = clampInt(process.env.LEARN_EVAL_AFTER, WINDOW, 1, 365) // days before judging a tuning
export const REGRESSION_DROP = 0.3 // >=30% rate drop vs baseline = regression
export const LIFT_GAIN = 0.15 // >=15% rate gain = lift

function clampInt(v, d, lo, hi) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d
}

// Installs are re-derived from the stored user-agent, not from the `is_bot` column: the column
// was written by a regex that missed the largest automated clients, and a crawler counted as an
// install is a fake reward that makes this loop tune metadata against noise. Which *items* count
// is scoped by installsByItem (see scripts/_installs.mjs) — the same rule sweep.mjs uses.
function ratesByItem() {
  const rows = d1(
    "SELECT item, ts, ua, country " +
      `FROM fetches WHERE date >= date('now','-${WINDOW} day')`
  )
  const out = installsByItem(rows)
  for (const k of Object.keys(out)) out[k] /= WINDOW
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

// Judge one past tuning: the install rate recorded when the component was tuned versus its rate
// now, both in installs/day. Returns { kind, lift } where kind is one of:
//   "unmeasured" — there is no baseline to compare against, so there is no verdict (lift: null)
//   "lift" / "regression" / "flat" — measured, by LIFT_GAIN / REGRESSION_DROP
//
// `baseline === null` (unmeasured) is deliberately NOT the same as a baseline of 0. A measured 0
// means "nobody installed this in the window before we touched it", so any traffic afterwards is
// real evidence. An unmeasured baseline means D1 was unreachable when `mark` ran and the rate was
// never taken — treating that as a measured 0 turned every component's ordinary background traffic
// into "LIFT … — keep", crediting the metadata rewrite for installs it had nothing to do with, on
// the one run where we know the least. The loop then keeps a change on evidence that does not
// exist. No baseline, no verdict.
export function tuningVerdict(baseline, current) {
  const now = Number(current) || 0
  // Tested as a finite *number*, deliberately not via `Number(baseline)`: that coerces both null
  // and "" to a perfectly finite 0, letting the very values that mean "no baseline" back in as a
  // measured zero. `mark` only ever writes a number or null, so anything else came from a state
  // file we did not write and is not something to score against.
  if (typeof baseline !== "number" || !Number.isFinite(baseline)) {
    return { kind: "unmeasured", lift: null }
  }
  // A zero baseline has nothing to divide by, so there is no percentage to report — `lift: null`
  // tells the caller to render the move without one.
  if (baseline <= 0) return { kind: now > 0 ? "lift" : "flat", lift: null }
  const lift = (now - baseline) / baseline
  if (lift <= -REGRESSION_DROP) return { kind: "regression", lift }
  if (lift >= LIFT_GAIN) return { kind: "lift", lift }
  return { kind: "flat", lift }
}

// --- mark: snapshot the baseline after the routine tuned a component's metadata ---
function markCmd(args) {
  if (!args.length) {
    console.log("usage: learn.mjs mark <name...>")
    return
  }
  // null, not {}: an unreachable D1 means the baseline was never measured, which the state file
  // has to record as such (see tuningVerdict) rather than as a rate of 0.
  let rates = null
  try {
    rates = ratesByItem()
  } catch {
    console.log("  (D1 unreachable — baselines recorded as unmeasured)")
  }
  const reg = loadRegistry()
  const state = loadState()
  for (const name of args) {
    const item = reg.items.find((i) => i.name === name)
    if (!item) {
      console.log(`  (skip ${name}: not in registry)`)
      continue
    }
    const baselineRate = rates ? (rates[name] ?? 0) : null
    state[name] = { tunedAt: today(), descHash: descHash(item.description), baselineRate }
    console.log(
      baselineRate === null
        ? `  marked ${name} (baseline unmeasured)`
        : `  marked ${name} (baselineRate=${baselineRate.toFixed(3)}/day)`
    )
  }
  saveState(state)
}

// --- default: evaluate prior tunings + recommend the next candidate ---
function evaluate() {
  const reg = loadRegistry()
  const rates = ratesByItem()
  const totalWindow = Object.values(rates).reduce((s, r) => s + r * WINDOW, 0)
  const state = loadState()
  const lowSignal = totalWindow < MIN_SIGNAL

  console.log(
    `learn: window=${WINDOW}d, install choices≈${Math.round(totalWindow)} ` +
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
    const { kind, lift } = tuningVerdict(st.baselineRate, now)
    if (kind === "unmeasured") {
      // This tuning can no longer be judged — the pre-change rate is gone. Re-marking restarts the
      // measurement from today's (already tuned) rate; it does not recover the missing baseline.
      console.log(
        `  ? ${item.name}: baseline was never measured, so this tuning cannot be judged — ` +
          `\`learn.mjs mark ${item.name}\` restarts the measurement from today`
      )
      continue
    }
    // Safe to format: every kind other than "unmeasured" implies a finite baseline. A zero one has
    // no percentage to quote (nothing to divide by), so the move is shown without one.
    const move = `${Number(st.baselineRate).toFixed(3)}→${now.toFixed(3)}/day`
    const pct = lift === null ? "" : ` (${lift > 0 ? "+" : ""}${Math.round(lift * 100)}%)`
    if (kind === "regression") {
      console.log(`  ↓ REGRESSION ${item.name}: ${move}${pct} — revert its last metadata change`)
    } else if (kind === "lift") {
      console.log(`  ↑ LIFT ${item.name}: ${move}${pct} — keep`)
    } else {
      console.log(`  = FLAT ${item.name}: ${move}${pct}`)
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
    return
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
}

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    if (cmd === "mark") markCmd(args)
    else evaluate()
  } catch (e) {
    console.log(`learn skipped (best-effort): ${e.message}`)
  }
}

// Only run the CLI when invoked directly (`node scripts/learn.mjs …`), not when imported by the
// unit tests — importing it used to run the whole loop, shelling out to wrangler and exiting.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
