// Unit tests for the pure helpers in functions/api/search/_lib.js.
// Dependency-free: uses Node's built-in test runner (`node --test`), so the gate stays
// install-free. functions/ is excluded from tsconfig, so these are its only automated coverage.
// Focus is the correctness-sensitive bits: chunk() (which decides how many vectors a doc becomes,
// and therefore the `<project>:<id>:<0..n>` id range the ingest/delete contract relies on) and the
// json()/cors() response shaping the endpoints depend on.
import { test } from "node:test"
import assert from "node:assert/strict"
import { chunk, monthKey, json, cors, MAX_CHUNKS_PER_DOC } from "../functions/api/search/_lib.js"

test("chunk: empty / whitespace-only / nullish input yields no chunks", () => {
  assert.deepEqual(chunk(""), [])
  assert.deepEqual(chunk("   \n\t  "), [])
  assert.deepEqual(chunk(null), [])
  assert.deepEqual(chunk(undefined), [])
})

test("chunk: text shorter than the window is a single chunk", () => {
  assert.deepEqual(chunk("abcdef", 10, 2), ["abcdef"])
})

test("chunk: collapses runs of whitespace and trims before splitting", () => {
  // "   a   b   " -> "a b" (len 3) -> one chunk
  assert.deepEqual(chunk("   a   b   ", 4, 1), ["a b"])
})

test("chunk: splits with the expected size and step (size - overlap), overlapping by `overlap`", () => {
  // size=4, overlap=1 -> step=3 over "abcdefghij" (len 10):
  //   i=0 "abcd", i=3 "defg", i=6 "ghij" (i+size=10 >= len -> stop)
  const parts = chunk("abcdefghij", 4, 1)
  assert.deepEqual(parts, ["abcd", "defg", "ghij"])
  // consecutive chunks overlap by exactly `overlap` characters
  assert.equal(parts[0].slice(-1), parts[1].slice(0, 1)) // "d" == "d"
  assert.equal(parts[1].slice(-1), parts[2].slice(0, 1)) // "g" == "g"
})

test("chunk: stops exactly at the boundary without an empty trailing chunk", () => {
  // len 6, size 3, overlap 0 -> step 3 -> "abc","def" and then stop (no "" tail)
  const parts = chunk("abcdef", 3, 0)
  assert.deepEqual(parts, ["abc", "def"])
  assert.ok(parts.every((p) => p.length > 0))
})

test("chunk: overlap >= size cannot infinite-loop (step is floored to 1) and still terminates", () => {
  // step = max(1, size - overlap) = max(1, 3 - 5) = 1; without the floor, step <= 0 would never
  // advance `i`. The boundary break still stops it once the window reaches the end.
  const parts = chunk("abcde", 3, 5)
  assert.deepEqual(parts, ["abc", "bcd", "cde"])
  // maximum overlap: consecutive chunks share size-1 chars
  assert.equal(parts[0].slice(1), parts[1].slice(0, -1)) // "bc" == "bc"
})

test("MAX_CHUNKS_PER_DOC is a positive integer (ingest/delete id range bound)", () => {
  assert.ok(Number.isInteger(MAX_CHUNKS_PER_DOC) && MAX_CHUNKS_PER_DOC > 0)
})

test("monthKey: YYYY-MM matching the current UTC month", () => {
  const m = monthKey()
  assert.match(m, /^\d{4}-\d{2}$/)
  assert.equal(m, new Date().toISOString().slice(0, 7))
})

test("json: defaults to 200 with JSON content-type, no-store, and CORS open", async () => {
  const res = json({ ok: true })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("content-type"), "application/json")
  assert.equal(res.headers.get("cache-control"), "no-store")
  assert.equal(res.headers.get("access-control-allow-origin"), "*")
  assert.deepEqual(await res.json(), { ok: true })
})

test("json: honors a custom status and round-trips the body", async () => {
  const res = json({ error: "unauthorized" }, 401)
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: "unauthorized" })
})

test("json: cors:false omits the allow-origin header (server-to-server endpoints)", () => {
  const res = json({ secret: 1 }, 200, { cors: false })
  assert.equal(res.headers.get("access-control-allow-origin"), null)
})

test("json: extra opts become response headers and do not disable CORS", () => {
  const res = json({ error: "rate_limited" }, 429, { "retry-after": "10" })
  assert.equal(res.status, 429)
  assert.equal(res.headers.get("retry-after"), "10")
  assert.equal(res.headers.get("access-control-allow-origin"), "*")
})

test("cors: preflight response advertises the methods and custom headers the endpoints use", () => {
  const res = cors()
  assert.equal(res.headers.get("access-control-allow-origin"), "*")
  assert.equal(res.headers.get("access-control-allow-methods"), "GET,POST,OPTIONS")
  const allowHeaders = res.headers.get("access-control-allow-headers") || ""
  assert.ok(allowHeaders.includes("x-pulld-admin-key"))
  assert.ok(allowHeaders.includes("x-pulld-key"))
})
