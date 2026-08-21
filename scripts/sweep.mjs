#!/usr/bin/env node
// Quality-sweep helper. Two subcommands:
//   scope          - pick which components to audit this run
//   mark <name...> - record components as swept (updates data/sweep-state.json)
//
// Scope = new components (never swept) + most-installed (best-effort from D1) +
// a rotating slice (oldest-swept first), deduped and capped at SWEEP_BATCH.
// This keeps a weekly run cheap and focused while covering the whole catalog over time.
//
// The selection itself is a pure function (pickScope) so it can be unit-tested without a registry,
// a state file or D1 — mirroring verify-registry.mjs. It decides what the quality sweep audits, so
// a silent change in it is a silent change in what gets looked at.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { installsByItem } from "./_installs.mjs"
import { d1 } from "./_d1.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_PATH = join(ROOT, "data", "sweep-state.json")
export const DEFAULT_BATCH = 6
const TOP_INSTALLED = 3

const today = () => new Date().toISOString().slice(0, 10)

// Pure scope selection. `state` is the data/sweep-state.json shape, `installs` the
// installsByItem map (absent = D1 unreachable, which must degrade to new + rotating rather than
// throw), `batch` the raw SWEEP_BATCH override. Returns the batch entries in the order they are to
// be audited.
//
// The cap is what keeps a run cheap, so it is resolved here rather than at the call site: an
// unparseable SWEEP_BATCH used to reach the loop as NaN, and `picked.length >= NaN` is never true,
// so the "capped" batch quietly became the entire catalog — the opposite of what the cap is for.
// Out-of-range or non-numeric falls back to the default, the way learn.mjs and usage-alert.mjs
// validate their own env overrides.
export function pickScope({ names = [], state = {}, installs = {}, batch } = {}) {
  const requested = Math.floor(Number(batch))
  const cap = Number.isFinite(requested) && requested >= 1 ? requested : DEFAULT_BATCH
  const components = state?.components ?? {}
  const sweptAt = (n) => components[n]?.lastSwept || ""

  const newOnes = names.filter((n) => !sweptAt(n))
  const top = names
    .filter((n) => installs[n])
    .sort((a, b) => installs[b] - installs[a])
    .slice(0, TOP_INSTALLED)
  // Oldest-swept first. A three-way compare, not `a < b ? -1 : 1`: the latter claims "greater" for
  // two equal dates, and every component swept on the same day (the normal case — `mark` stamps a
  // whole batch at once) compares equal, so their relative order was left to the sort's internals.
  const rotating = [...names].sort((a, b) => {
    const [x, y] = [sweptAt(a), sweptAt(b)]
    return x < y ? -1 : x > y ? 1 : 0
  })

  const picked = []
  for (const n of [...newOnes, ...top, ...rotating]) {
    if (!picked.includes(n)) picked.push(n)
    if (picked.length >= cap) break
  }
  const reasonFor = (n) =>
    newOnes.includes(n) ? "new" : top.includes(n) ? `top-installed(${installs[n]})` : "rotating"

  return picked.map((n) => ({
    name: n,
    reason: reasonFor(n),
    lastSwept: components[n]?.lastSwept || null,
  }))
}

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"))
  } catch {
    return { lastRun: null, components: {} }
  }
}
function saveState(s) {
  mkdirSync(dirname(STATE_PATH), { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n")
}
function componentNames() {
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  return (reg.items ?? []).map((i) => i.name)
}
function installCounts() {
  // best-effort: per-item install counts from D1. Crawlers are excluded by user-agent and Pro /
  // catalogue rows by item name, both inside installsByItem (see scripts/_installs.mjs) so this
  // and learn.mjs's reward cannot drift apart.
  try {
    return installsByItem(d1("SELECT item, ts, ua, country FROM fetches"))
  } catch (e) {
    // Falling back to {} is not the same as "nobody installed anything": pickScope's
    // most-installed slice silently becomes an arbitrary one, and the run still prints a
    // perfectly ordinary batch. Say so on stderr — stdout is the JSON the routine parses.
    console.error(`sweep: install counts unavailable, scoping without them — ${e.message}`)
    return {}
  }
}

// --- CLI: run against the real registry.json, data/sweep-state.json and D1 ---
function main() {
  const cmd = process.argv[2]

  if (cmd === "scope") {
    const batch = pickScope({
      names: componentNames(),
      state: loadState(),
      installs: installCounts(),
      batch: process.env.SWEEP_BATCH,
    })
    console.log(JSON.stringify({ run: today(), batch }, null, 2))
  } else if (cmd === "mark") {
    const marks = process.argv.slice(3)
    if (!marks.length) {
      console.log("nothing to mark")
      process.exit(0)
    }
    const st = loadState()
    for (const n of marks) st.components[n] = { lastSwept: today() }
    st.lastRun = today()
    saveState(st)
    console.log(`OK marked swept: ${marks.join(", ")}`)
  } else {
    console.log("usage: node scripts/sweep.mjs scope | mark <name...>")
    process.exit(1)
  }
}

// Only run the CLI when invoked directly (`node scripts/sweep.mjs …`), not when imported by the
// unit tests — importing it used to print the usage line and process.exit(1) out of the test run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
