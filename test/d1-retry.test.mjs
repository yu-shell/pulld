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
import { d1, parseRows, causeOf, BUDGETS_MS } from "../scripts/_d1.mjs"

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
