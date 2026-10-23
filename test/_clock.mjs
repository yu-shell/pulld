// A frozen `Date.now`, and the instant to freeze it at, for the tests that assert a time-derived
// response header. Not a test file itself (the `_` prefix keeps it out of the
// `test/**/*.test.mjs` glob) — it is here so the query, account and _lib tests share one copy
// rather than three that drift.
//
// What they pin is the `retry-after` on a 429: the seconds left in the limiter's fixed window
// (functions/api/search/_lib.js retryAfterSeconds). Read off a live clock that number is different
// every run, so the assertion would have to be a range — and a range is exactly what the constants
// these tests replaced would still satisfy at one position in sixty.

/** An exact RL_WINDOW boundary in epoch ms (2026-01-01T00:00:00Z), so "+Ns" means N seconds in. */
export const WINDOW_START = 1_767_225_600_000

/** Runs `fn` with `Date.now()` pinned to `ms`, restoring the real clock however it ends. */
export async function atClock(ms, fn) {
  const real = Date.now
  Date.now = () => ms
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}
