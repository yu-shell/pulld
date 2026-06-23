#!/usr/bin/env node
// Quality-sweep helper. Two subcommands:
//   scope          - pick which components to audit this run
//   mark <name...> - record components as swept (updates data/sweep-state.json)
//
// Scope = new components (never swept) + most-installed (best-effort from D1) +
// a rotating slice (oldest-swept first), deduped and capped at SWEEP_BATCH.
// This keeps a weekly run cheap and focused while covering the whole catalog over time.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const STATE_PATH = join(ROOT, "data", "sweep-state.json")
const BATCH = Number(process.env.SWEEP_BATCH || 6)
const TOP_INSTALLED = 3

const today = () => new Date().toISOString().slice(0, 10)

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
  // best-effort: clean (non-bot) fetch counts per free item, from D1
  try {
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
        "SELECT item, SUM(CASE WHEN is_bot=0 THEN 1 ELSE 0 END) AS clean " +
          "FROM fetches WHERE item NOT LIKE 'pro/%' AND item != 'registry' GROUP BY item",
      ],
      { encoding: "utf8", timeout: 30000 }
    )
    const parsed = JSON.parse(out)
    const rows = (Array.isArray(parsed) ? parsed[0] : parsed)?.results ?? []
    const m = {}
    for (const r of rows) m[r.item] = r.clean || 0
    return m
  } catch {
    return {}
  }
}

const cmd = process.argv[2]

if (cmd === "scope") {
  const all = componentNames()
  const st = loadState()
  const inst = installCounts()

  const newOnes = all.filter((n) => !st.components[n]?.lastSwept)
  const top = all
    .filter((n) => inst[n])
    .sort((a, b) => inst[b] - inst[a])
    .slice(0, TOP_INSTALLED)
  const rotating = [...all].sort((a, b) =>
    (st.components[a]?.lastSwept || "") < (st.components[b]?.lastSwept || "") ? -1 : 1
  )

  const picked = []
  for (const n of [...newOnes, ...top, ...rotating]) {
    if (!picked.includes(n)) picked.push(n)
    if (picked.length >= BATCH) break
  }
  const reasonFor = (n) =>
    newOnes.includes(n) ? "new" : top.includes(n) ? `top-installed(${inst[n]})` : "rotating"

  console.log(
    JSON.stringify(
      {
        run: today(),
        batch: picked.map((n) => ({
          name: n,
          reason: reasonFor(n),
          lastSwept: st.components[n]?.lastSwept || null,
        })),
      },
      null,
      2
    )
  )
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
