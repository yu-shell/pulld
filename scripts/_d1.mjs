// One source of truth for "ask D1 a question" — the third companion to functions/_traffic.js
// (who fetched) and scripts/_installs.mjs (what counts as a fetch worth rewarding).
//
// Four scripts in the daily routine read the same remote D1 through the same `npx --yes
// wrangler@latest d1 execute` shell-out, and each one grew its own copy of the helper. Only
// report.mjs's copy learned what the routine had been demonstrating for weeks:
//
//   * `npx --yes wrangler@latest` RESOLVES AND INSTALLS the package on a cold cache, which does
//     not fit a 30s budget. The first call of the morning fails, the warmed second takes under
//     two seconds. Observed eight mornings running before report.mjs got its retry.
//   * `execFileSync` puts only the command in `e.message` and the real cause in `e.stderr`, so a
//     copy that reads `e.message` alone reports `Command failed: npx …` and nothing else — and
//     one that leaves stderr on the default (inherited) stdio has no `e.stderr` to read at all.
//
// The three copies that never learned it are the three whose failures are hardest to notice:
// learn.mjs and usage-alert.mjs print a best-effort "skipped" line and exit 0, and sweep.mjs's
// `catch { return {} }` is worse than skipping — zero installs is a legitimate-looking answer, so
// a timed-out morning silently re-ranks which components the quality sweep picks next. All four
// now share this one, which retries once with the longer budget first and keeps the cause either
// way, so a cold cache costs two seconds instead of a day of signal.
import { execFileSync } from "node:child_process"

// First attempt gets the longer budget: a cold `npx` install is slow, not broken.
export const BUDGETS_MS = [60000, 30000]

// `execFileSync` buffers the whole child stdout in memory and Node caps that at 1 MiB by default,
// throwing ENOBUFS the moment a reply crosses it. That cap is a property of how much has been
// logged, not of the query, so it arrives one morning with nothing changed: sweep.mjs reads the
// whole `fetches` table (it has to — which rows count as an install is `installsByItem`'s rule,
// and re-expressing it in SQL is exactly the drift _installs.mjs exists to prevent), and at ~140
// bytes a row it crossed 1 MiB at around 8,000 fetches. learn.mjs's windowed copy of the same
// query is the next one in line.
//
// It also defeats the retry above rather than being caught by it: both budgets are timeouts, and
// a reply that is too large is no smaller on the second attempt. So the cap is lifted here, at the
// one shell-out all four scripts share, instead of at whichever caller notices first. 64 MiB is
// room for a few hundred thousand rows — far past the point where this should be a windowed query
// rather than a bigger buffer, but it fails loudly at that size instead of silently at 1 MiB.
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// The command every caller was already running, with stderr piped rather than inherited so the
// cause survives on the error object instead of scrolling past on the parent's stderr. `exec` is
// injectable for the same reason `run` is below: the options here are the whole defence against
// ENOBUFS, and a test that cannot see them cannot notice one going missing in a reformat.
export function wranglerD1(sql, timeout, { exec = execFileSync } = {}) {
  return exec(
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
      sql,
    ],
    {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_OUTPUT_BYTES,
    }
  )
}

// `wrangler d1 execute --json` prints either a single result block or an array of them depending
// on version; every caller had already learned to accept both.
export function parseRows(out) {
  const parsed = JSON.parse(out)
  const block = Array.isArray(parsed) ? parsed[0] : parsed
  return block?.results ?? []
}

// The last few lines of the child's output — where wrangler puts the reason (no such table, auth,
// network) that `e.message` throws away.
export const causeOf = (e) =>
  String(e?.stderr || e?.stdout || "")
    .trim()
    .split("\n")
    .slice(-4)
    .join(" | ")

// Runs `sql` against the remote D1 and returns its rows. `run` is injectable so the retry and the
// error shaping can be unit-tested without a network, a wrangler install or a real database.
// Throws only when every attempt failed, with each attempt's cause named in the message.
export function d1(sql, { run = wranglerD1, budgets = BUDGETS_MS } = {}) {
  const failed = []
  for (const timeout of budgets) {
    try {
      return parseRows(run(sql, timeout))
    } catch (e) {
      const why = causeOf(e)
      failed.push(`${String(e?.message ?? e).split("\n")[0]}${why ? ` — ${why}` : ""}`)
    }
  }
  throw new Error(failed.map((f, i) => `attempt ${i + 1}: ${f}`).join("\n  "))
}
