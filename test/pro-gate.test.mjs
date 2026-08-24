// Handler-level tests for the Pro license gate (functions/_pro-gate.js, wired to the route by
// functions/r/pro/[[path]].js) — the one path in this project that decides whether PAID content
// is handed out. functions/ is excluded from tsconfig (see tsconfig "include"), so `node --test`
// is its only automated coverage, and until now this was the only handler under functions/ that
// had none: the route imports its block map from functions/_pro-blocks.js, which build-pro.mjs
// generates and .gitignore keeps out of the repository, so the module could not be imported on a
// checkout at all. Testing the gate with a map handed to it removes that.
//
// The load-bearing behaviour covered here:
//   - it fails CLOSED. No key, an unknown key, no D1 binding, a D1 that throws — every way of not
//     knowing answers 402, and the block's contents never appear in a body that is not a 200.
//   - a test-mode license (test_mode = 1) does not unlock a production block.
//   - a name nobody sells is a 404, INCLUDING the names that come free with every object literal.
//   - the fetch log records a denial as `pro/<name>:402` and a delivery as `pro/<name>`, which is
//     what keeps scripts/_installs.mjs able to tell a failed purchase from an install; and a log
//     that fails never changes the response.
import { test } from "node:test"
import assert from "node:assert/strict"
import { handleProGet } from "../functions/_pro-gate.js"

const BLOCK = { name: "dashboard-overview", files: [{ path: "pro/blocks/dashboard-overview.tsx" }] }
// A plain object literal, exactly as build-pro.mjs emits it — inheriting Object.prototype is the
// condition the own-property check exists for, so the fixture must not be a null-prototype map.
const BLOCKS = { "dashboard-overview": BLOCK }

// Minimal fake of the D1 binding the gate touches: `first()` for the license lookup, `run()` for
// the fetch-log insert (whose bound row the test asserts on). `licenses` is the set of keys that
// the real WHERE clause — active = 1 AND (test_mode = 0 OR test_mode IS NULL) — would match, so a
// key that is merely present but test-mode or revoked is simply absent from the set.
function fakeDB({ licenses = new Set(), rows = [], throwOnSelect = false } = {}) {
  return {
    rows,
    seenSql: [],
    prepare(sql) {
      this.seenSql.push(sql)
      const db = this
      return {
        bind(...args) {
          return {
            async first() {
              if (throwOnSelect) throw new Error("D1_ERROR: network")
              return licenses.has(args[0]) ? { key: args[0] } : null
            },
            async run() {
              db.rows.push({ sql, args })
              return { success: true }
            },
          }
        },
      }
    },
  }
}

function ctx({
  path = "/r/pro/dashboard-overview.json",
  key = "",
  header = "",
  ua = "shadcn/2.4.0",
  db = fakeDB(),
} = {}) {
  const headers = { "user-agent": ua, "cf-ipcountry": "JP" }
  if (header) headers["x-pulld-key"] = header
  const waited = []
  return {
    request: new Request(`https://pulld.pages.dev${path}${key ? `?key=${key}` : ""}`, { headers }),
    env: db === null ? {} : { DB: db },
    waitUntil: (p) => waited.push(p),
    waited,
    db,
  }
}

// The gate hands the insert to waitUntil rather than awaiting it, so the assertions have to wait
// for the same promises the platform would.
const settle = (c) => Promise.allSettled(c.waited)

test("a valid license key serves the block", async () => {
  const c = ctx({ key: "REAL", db: fakeDB({ licenses: new Set(["REAL"]) }) })
  const res = await handleProGet(c, BLOCKS)
  assert.equal(res.status, 200)
  assert.match(res.headers.get("content-type"), /application\/json/)
  assert.equal(res.headers.get("cache-control"), "no-store")
  assert.deepEqual(await res.json(), BLOCK)
})

test("no key is 402 and never leaks the block", async () => {
  const c = ctx()
  const res = await handleProGet(c, BLOCKS)
  assert.equal(res.status, 402)
  const body = await res.text()
  assert.equal(JSON.parse(body).error, "payment_required")
  assert.equal(body.includes("dashboard-overview.tsx"), false)
})

test("an unknown key is 402", async () => {
  const c = ctx({ key: "GUESS", db: fakeDB({ licenses: new Set(["REAL"]) }) })
  assert.equal((await handleProGet(c, BLOCKS)).status, 402)
})

// A revoked or test-mode key is one the production WHERE clause does not match. Both the clause
// and the outcome are pinned: the clause because it is the only thing keeping test-mode purchases
// out, and dropping it would otherwise leave every test here still green.
test("a key the license clause does not match is 402, and the clause is the production one", async () => {
  const db = fakeDB({ licenses: new Set() }) // test-mode / revoked / inactive all land here
  const res = await handleProGet(ctx({ key: "TEST_MODE", db }), BLOCKS)
  assert.equal(res.status, 402)
  const select = db.seenSql.find((s) => s.startsWith("SELECT"))
  assert.match(select, /active = 1/)
  assert.match(select, /test_mode = 0 OR test_mode IS NULL/)
})

test("fails closed when D1 is unbound", async () => {
  const res = await handleProGet(ctx({ key: "REAL", db: null }), BLOCKS)
  assert.equal(res.status, 402)
})

test("fails closed when the license check throws", async () => {
  const c = ctx({ key: "REAL", db: fakeDB({ licenses: new Set(["REAL"]), throwOnSelect: true }) })
  const res = await handleProGet(c, BLOCKS)
  assert.equal(res.status, 402)
})

test("the X-Pulld-Key header unlocks the same as ?key=", async () => {
  const c = ctx({ header: "REAL", db: fakeDB({ licenses: new Set(["REAL"]) }) })
  assert.equal((await handleProGet(c, BLOCKS)).status, 200)
})

test("a name nobody sells is 404", async () => {
  assert.equal((await handleProGet(ctx({ path: "/r/pro/nope.json" }), BLOCKS)).status, 404)
})

test("a path outside /r/pro/<name>.json is 404", async () => {
  for (const path of ["/r/pro/nested/x.json", "/r/pro/dashboard-overview.txt", "/r/pro/"]) {
    assert.equal((await handleProGet(ctx({ path }), BLOCKS)).status, 404, path)
  }
})

// The regression this file was written for. The block map is a JSON object literal, so it carries
// Object.prototype with it, and the route's `[a-z0-9-]+` is case-INSENSITIVE — so these seven
// names all reached a bare `blocks[name]` and all came back truthy. Measured against the handler
// before the fix: no key gave 402 "This is a pulld Pro block. Get a license…" for a block that
// does not exist, and a VALID key gave 200 with `content-type: application/json` and a zero-length
// body (JSON.stringify of a function is undefined), which is a `shadcn add` dying on a JSON parse
// instead of being told the name is not real.
test("inherited Object.prototype names are 404, not 402 and not an empty 200", async () => {
  const inherited = [
    "toString",
    "constructor",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]
  for (const name of inherited) {
    const denied = await handleProGet(ctx({ path: `/r/pro/${name}.json` }), BLOCKS)
    assert.equal(denied.status, 404, `${name} without a key`)

    const c = ctx({ path: `/r/pro/${name}.json`, key: "REAL", db: fakeDB({ licenses: new Set(["REAL"]) }) })
    const served = await handleProGet(c, BLOCKS)
    assert.equal(served.status, 404, `${name} with a valid key`)
    assert.equal(await served.text(), "not found")
  }
})

test("a denial is logged as pro/<name>:402 and a delivery as pro/<name>", async () => {
  const denied = ctx()
  await handleProGet(denied, BLOCKS)
  await settle(denied)
  assert.equal(denied.db.rows.length, 1)
  assert.match(denied.db.rows[0].sql, /INSERT INTO fetches/)
  assert.equal(denied.db.rows[0].args[1], "pro/dashboard-overview:402")

  const paid = ctx({ key: "REAL", db: fakeDB({ licenses: new Set(["REAL"]) }) })
  await handleProGet(paid, BLOCKS)
  await settle(paid)
  assert.equal(paid.db.rows.at(-1).args[1], "pro/dashboard-overview")
})

test("a crawler's denial is flagged is_bot, a CLI's is not", async () => {
  const bot = ctx({ ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" })
  await handleProGet(bot, BLOCKS)
  await settle(bot)
  assert.equal(bot.db.rows[0].args[5], 1)

  const cli = ctx()
  await handleProGet(cli, BLOCKS)
  await settle(cli)
  assert.equal(cli.db.rows[0].args[5], 0)
})

// Same contract the free registry route holds: the response is decided before the log is written
// and is never held up or changed by it. A gate that 500s because an INSERT failed is a gate that
// stops paying customers for a reason that has nothing to do with their license.
test("a failing fetch-log never changes the response", async () => {
  const exploding = {
    prepare(sql) {
      if (/INSERT INTO fetches/.test(sql)) throw new Error("D1_ERROR: no such table")
      return {
        bind: () => ({ async first() { return { key: "REAL" } } }),
      }
    },
  }
  const c = ctx({ key: "REAL", db: exploding })
  const res = await handleProGet(c, BLOCKS)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), BLOCK)
})
