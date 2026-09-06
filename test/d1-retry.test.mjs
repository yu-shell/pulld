// Unit tests for the shared D1 helper (scripts/_d1.mjs).
//
// Everything the daily routine knows about pulld comes through this one shell-out: report.mjs's
// fetch/miss/click tables, learn.mjs's install reward, sweep.mjs's audit scope, usage-alert.mjs's
// quota warnings. It runs `npx --yes wrangler@latest`, which on a cold cache spends longer
// resolving and installing the package than the old 30s budget allowed — the first call of the
// morning failed and the second succeeded, eight mornings running, before report.mjs grew a
// retry. The other three scripts kept the single attempt, and their failure is quiet by
// construction: two print a best-effort "skipped" line and exit 0, and sweep.mjs used to return
// {} — zero installs, which is a legitimate-looking answer that quietly re-ranks what gets
// audited next.
//
// So the retry and the error shaping are what these tests pin, through the injectable `run`:
// a first-attempt failure must not reach the caller, the longer budget must be spent first, and
// the cause wrangler writes to stderr must survive into the thrown message — `e.message` alone
// is `Command failed: npx …`, which is what made the original diagnosis take eight days.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  d1,
  parseRows,
  causeOf,
  wranglerD1,
  BUDGETS_MS,
  MAX_OUTPUT_BYTES,
} from "../scripts/_d1.mjs"

const SQL = "SELECT item FROM fetches"

/** What `execFileSync` throws on a timeout: the command in `message`, the reason in `stderr`. */
const execFailure = (stderr = "") => {
  const e = new Error("Command failed: npx --yes wrangler@latest d1 execute pulld\n(more noise)")
  e.stderr = stderr
  return e
}

/** A runner that fails its first `failures` attempts, recording the budget each one was given. */
const runnerFailingTimes = (failures, out, error = () => execFailure()) => {
  const budgets = []
  const run = (sql, timeout) => {
    budgets.push(timeout)
    if (budgets.length <= failures) throw error()
    return out
  }
  return { run, budgets }
}

const ROWS = JSON.stringify([{ results: [{ item: "copy-button" }] }])

test("a cold-cache first attempt is retried, and the caller never sees it", () => {
  const { run, budgets } = runnerFailingTimes(1, ROWS)
  assert.deepEqual(d1(SQL, { run }), [{ item: "copy-button" }])
  assert.equal(budgets.length, 2, "the failed attempt must be retried exactly once")
})

test("the longer budget is spent first — a cold npx install is slow, not broken", () => {
  const { run, budgets } = runnerFailingTimes(1, ROWS)
  d1(SQL, { run })
  assert.deepEqual(budgets, BUDGETS_MS)
  assert.ok(budgets[0] > budgets[1], "the retry must not get more time than the cold attempt")
})

test("a first-attempt success does not run a second attempt", () => {
  const { run, budgets } = runnerFailingTimes(0, ROWS)
  assert.deepEqual(d1(SQL, { run }), [{ item: "copy-button" }])
  assert.equal(budgets.length, 1)
})

test("the SQL reaches the runner unchanged on every attempt", () => {
  const seen = []
  const run = (sql) => {
    seen.push(sql)
    if (seen.length === 1) throw execFailure()
    return ROWS
  }
  d1(SQL, { run })
  assert.deepEqual(seen, [SQL, SQL])
})

test("when every attempt fails it throws, naming each attempt and its stderr cause", () => {
  const run = () => {
    throw execFailure("✘ [ERROR] no such table: fetches")
  }
  assert.throws(
    () => d1(SQL, { run }),
    (e) => {
      // The cause is the whole point: `Command failed: npx …` alone says nothing about why.
      assert.match(e.message, /no such table: fetches/)
      assert.match(e.message, /attempt 1:/)
      assert.match(e.message, /attempt 2:/)
      // Only the first line of each attempt's message, so the child's noise does not drown it.
      assert.doesNotMatch(e.message, /more noise/)
      return true
    }
  )
})

test("a failure with nothing on stderr still reports the command that failed", () => {
  const run = () => {
    throw execFailure()
  }
  assert.throws(() => d1(SQL, { run }), /attempt 1: Command failed: npx/)
})

test("the thrown value is an Error, so every caller's best-effort catch still holds", () => {
  const run = () => {
    throw execFailure("boom")
  }
  // learn.mjs / usage-alert.mjs print `e.message`; sweep.mjs interpolates it into its stderr line.
  assert.throws(() => d1(SQL, { run }), (e) => e instanceof Error && typeof e.message === "string")
})

test("malformed output is retried too — a truncated read is not a verdict about the data", () => {
  const { run, budgets } = runnerFailingTimes(0, "{not json")
  assert.throws(() => d1(SQL, { run }))
  assert.equal(budgets.length, BUDGETS_MS.length)
})

test("parseRows accepts both shapes wrangler prints, and no rows means no rows", () => {
  assert.deepEqual(parseRows(JSON.stringify([{ results: [{ n: 1 }] }])), [{ n: 1 }])
  assert.deepEqual(parseRows(JSON.stringify({ results: [{ n: 2 }] })), [{ n: 2 }])
  // A block that succeeded but selected nothing, and one with no `results` key at all.
  assert.deepEqual(parseRows(JSON.stringify([{ results: [] }])), [])
  assert.deepEqual(parseRows(JSON.stringify([{ success: true }])), [])
  assert.deepEqual(parseRows(JSON.stringify([])), [])
})

test("causeOf reads stderr, falls back to stdout, and keeps only the last lines", () => {
  assert.equal(causeOf({ stderr: " no such table \n" }), "no such table")
  assert.equal(causeOf({ stdout: "only here" }), "only here")
  assert.equal(causeOf({ stderr: "a\nb\nc\nd\ne\nf" }), "c | d | e | f")
  assert.equal(causeOf({}), "")
  assert.equal(causeOf(undefined), "")
})

// --- the output buffer ------------------------------------------------------
// The second way this shell-out fails quietly, and the one that arrives on its own. `execFileSync`
// holds the child's whole stdout in memory and Node caps that at 1 MiB, so the reply that worked
// yesterday throws ENOBUFS today purely because more has been logged since. It hit sweep.mjs first
// — it reads the entire `fetches` table, because which rows count as an install is installsByItem's
// rule and re-deriving it in SQL is the drift _installs.mjs exists to prevent — at roughly 8,000
// rows of ~140 bytes. The retry above is no defence: both budgets are timeouts, and a reply that is
// too large is exactly as large on the second attempt.
//
// So these pin the option itself rather than a number of rows, which is the only part a unit test
// can see and the part a reformat would drop.

test("the output buffer is raised past Node's 1 MiB default, which ENOBUFS is a property of", () => {
  assert.ok(
    MAX_OUTPUT_BYTES > 1024 * 1024,
    `a cap at or below Node's default cannot help — got ${MAX_OUTPUT_BYTES}`
  )
})

test("wranglerD1 actually passes that buffer to the child, along with the piped stderr", () => {
  let options = null
  wranglerD1(SQL, 30000, {
    exec: (_file, _args, opts) => {
      options = opts
      return ROWS
    },
  })
  assert.equal(options.maxBuffer, MAX_OUTPUT_BYTES)
  // The other two are load-bearing for the tests above: without piped stderr there is no `e.stderr`
  // for causeOf to read, and without the timeout the retry has no budget to spend.
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"])
  assert.equal(options.timeout, 30000)
})

test("wranglerD1 sends the caller's SQL as one argv entry, never through a shell", () => {
  let argv = null
  wranglerD1("SELECT item FROM fetches WHERE ua LIKE '%bot%'", 30000, {
    exec: (_file, args) => {
      argv = args
      return ROWS
    },
  })
  // `--command` and its value adjacent and unquoted: a SQL string that reached a shell would need
  // quoting, and the one place that would show up is a query containing a quote of its own.
  const i = argv.indexOf("--command")
  assert.ok(i >= 0)
  assert.equal(argv[i + 1], "SELECT item FROM fetches WHERE ua LIKE '%bot%'")
  assert.equal(argv.length, i + 2, "the SQL must be the last argument")
})
