#!/usr/bin/env node
// Quality-sweep helper. Two subcommands:
//   scope          - pick which components to audit this run
//   mark <name...> - record components as swept (updates data/sweep-state.json). A name this
//                    registry does not ship is refused and named on stderr, never recorded.
//
// Scope = new components (never swept) + most-installed (best-effort from D1) +
// a rotating slice (oldest-swept first), deduped and capped at SWEEP_BATCH.
// This keeps a weekly run cheap and focused while covering the whole catalog over time.
//
// Both decisions are pure functions (pickScope, applyMarks) so they can be unit-tested without a
// registry, a state file or D1 — mirroring verify-registry.mjs. One decides what the quality sweep
// audits and the other what it remembers having audited, so a silent change in either is a silent
// change in what gets looked at.
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
//
// Each slice gets one slot before any slice gets a second, because the three were concatenated
// in priority order and then cut at the cap, which is only fair while the first slice is shorter
// than the batch. It stopped being: this registry gains a component most days (ROUTINE.md step 2)
// and the sweep audits six a week, so the never-swept backlog outgrows the batch and `new` takes
// the whole of it. Measured on 2026-10-31 — 128 components, 102 swept, 26 never — every one of the
// six picks came back `new`, and that is what the last several runs had been doing: the
// most-installed slice, the one slice chosen because those components are the ones people actually
// hold, had not been audited since the backlog opened, and nothing had been RE-audited at all. The
// cap was doing its job and the starvation showed up nowhere, because a batch of six plausible
// names is what a healthy run looks like too.
//
// So the cap is allocated rather than consumed: one slot to each slice that has a candidate, then
// the rest handed out in the same priority order as before. Below the crossover — a backlog that
// fits inside the batch — this returns what it always did, which is why the tests above it did not
// move. Above it, `new` still takes most of a run (four of six here) and the other two resume.
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
  // Oldest-swept first, and only among components that HAVE been swept. A never-swept one has no
  // audit date to be oldest by — it is the `new` slice's — and leaving it in made `rotating` a
  // superset of `newOnes` with the new ones at its head, so the reserved slot below would have
  // spent itself on a second `new` pick and the rotation would still never have come round.
  // (Before the allocation it was merely redundant: `newOnes` came first and deduped them away.)
  //
  // A three-way compare, not `a < b ? -1 : 1`: the latter claims "greater" for two equal dates,
  // and every component swept on the same day (the normal case — `mark` stamps a whole batch at
  // once) compares equal, so their relative order was left to the sort's internals.
  const rotating = names
    .filter((n) => sweptAt(n))
    .sort((a, b) => {
      const [x, y] = [sweptAt(a), sweptAt(b)]
      return x < y ? -1 : x > y ? 1 : 0
    })

  const slices = [
    { reason: () => "new", queue: newOnes, got: [] },
    { reason: (n) => `top-installed(${installs[n]})`, queue: top, got: [] },
    { reason: () => "rotating", queue: rotating, got: [] },
  ]

  // Each slice keeps what it won in its own bucket, and the buckets are concatenated at the end.
  // Allocating and listing are separate because they want different orders: a slot has to be
  // reserved for the later slices before the first one spends the batch, but the batch is still
  // read by a person working down it, so it is listed `new` first exactly as before.
  let left = cap
  const taken = new Set()
  const takeFrom = (slice) => {
    while (slice.queue.length) {
      const n = slice.queue.shift()
      if (taken.has(n)) continue
      taken.add(n)
      slice.got.push({ name: n, reason: slice.reason(n), lastSwept: components[n]?.lastSwept || null })
      left--
      return true
    }
    // Exhausted, or every remaining candidate is already picked — which is how `new` and
    // `top-installed` overlap. It hands its turn on rather than holding a slot empty.
    return false
  }

  for (const slice of slices) {
    if (!left) break
    takeFrom(slice)
  }
  // What is left goes out in the original priority order: a never-swept component is still the
  // most urgent thing in the catalogue, so `new` empties first.
  for (const slice of slices) {
    while (left && takeFrom(slice)) {}
  }

  return slices.flatMap((s) => s.got)
}

// Pure mark application: which of the requested names this registry actually ships, the state that
// records the ones it does, and the ones it refused. Pulled out of main() for the reason pickScope
// is pure — this decides what the sweep remembers having audited, and a silent change in it is a
// silent loss of that record — and because the rule below had no way to be pinned while it lived
// inside the CLI.
//
// A name the registry does not ship is not written; it is handed back so the caller can say so.
// `mark` is the last step of the weekly routine (QUALITY-SWEEP.md step 7) and is handed the whole
// batch in one call, so one mistyped name used to go straight in as its own entry. Nothing ever
// looked at it again: pickScope reads `lastSwept` by registry name, so the junk entry is invisible
// and permanent, the component that really was audited keeps its empty `lastSwept` and comes back
// as "new" in a later scope — and the one line the operator sees is `OK marked swept: …` with the
// typo listed among five names that landed. A record was lost and the report said it was kept.
//
// learn.mjs's `mark` — the other half of the same routine, writing the other state file — has
// checked its names against the registry from the start and prints `(skip <name>: not in registry)`
// for one it does not recognise. This is that check, on the side that never had it.
//
// Repeats collapse, the way the rest of this project treats the same name twice in one request as
// the one thing it names.
export function applyMarks({ names = [], marks = [], state = {}, date = today() } = {}) {
  const shipped = new Set(names)
  const components = { ...(state?.components ?? {}) }
  const marked = []
  const unknown = []
  for (const name of marks) {
    const bucket = shipped.has(name) ? marked : unknown
    if (bucket.includes(name)) continue
    bucket.push(name)
    if (bucket === marked) components[name] = { lastSwept: date }
  }
  // `lastRun` moves only when something was recorded: a run that marked nothing audited nothing,
  // and stamping it would leave the state file claiming a sweep that never happened.
  return { state: marked.length ? { ...state, lastRun: date, components } : state, marked, unknown }
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
    const { state, marked, unknown } = applyMarks({
      names: componentNames(),
      marks,
      state: loadState(),
    })
    // On stderr, the way installCounts() reports a degraded run: stdout carries the result line,
    // and a refusal that shares it reads as part of the success.
    for (const name of unknown) {
      console.error(`sweep: skip ${name} — not in registry, nothing recorded`)
    }
    if (!marked.length) {
      console.error("sweep: marked nothing — none of those names is in the registry")
      process.exit(1)
    }
    saveState(state)
    console.log(`OK marked swept: ${marked.join(", ")}`)
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
