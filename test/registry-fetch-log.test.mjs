// Handler-level tests for the registry route (functions/r/[[path]].js) — the one path every
// install goes through. Three invariants: serving must never be blocked by logging (a lost asset
// is a failed `shadcn add`), the log must record every delivered component, because that count is
// the reward learn.mjs tunes metadata against and the priority sweep.mjs works from, and a name
// that does not exist must be recorded as a miss and never as a delivery. A revalidated (304)
// delivery is the case that used to be dropped; a miss counted as a delivery is the case that
// corrupted 1,535 rows, and a miss recorded nowhere at all is what replaced it for one day.
// functions/ is excluded from tsconfig, so `node --test` is its only automated coverage.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestGet } from "../functions/r/[[path]].js"

// Minimal fake of the D1 binding: records the bound row of every INSERT so the test can assert
// what was logged, and (like the real binding) resolves asynchronously.
function fakeDB(rows = []) {
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              rows.push({ sql, args })
              return { success: true }
            },
          }
        },
      }
    },
  }
}

// Stands in for the Pages static-asset binding. `status` is what the asset server would answer:
// 200 for a served file, 304 when the client's If-None-Match still matches.
//
// `type` matters as much as the status. This project ships no 404.html, so Pages does NOT answer
// a miss with 404 — it substitutes index.html under status 200. A fake that returns a bare 404 is
// therefore modelling a response production cannot emit, which is how the miss-handling bug below
// stayed invisible while its test passed. Served assets carry their real content-type too, since
// that is what tells the item apart from the substituted landing page.
function fakeAssets(status = 200, body = '{"name":"copy-button"}', type = "application/json") {
  return {
    calls: [],
    fetch(request) {
      this.calls.push(request.url)
      const nullBody = status === 304 || status === 204
      const headers = { etag: '"v1"' }
      if (!nullBody) headers["content-type"] = type
      return Promise.resolve(new Response(nullBody ? null : body, { status, headers }))
    },
  }
}

// What Pages actually serves for an unknown path: the landing page, verbatim, under status 200.
const fakeSpaFallback = () => fakeAssets(200, "<!doctype html><html>…</html>", "text/html; charset=utf-8")

function ctx({
  path = "/r/copy-button.json",
  ua = "shadcn/2.4.0",
  db = fakeDB(),
  assets = fakeAssets(),
} = {}) {
  const waited = []
  return {
    request: new Request(`https://pulld.pages.dev${path}`, {
      headers: { "user-agent": ua, "cf-ipcountry": "JP" },
    }),
    env: { DB: db, ASSETS: assets },
    waitUntil: (p) => waited.push(p),
    waited,
  }
}

const flush = (c) => Promise.all(c.waited)

// Which table a recorded row went into. Asserting on the count alone cannot tell a delivery from
// a miss now that both are logged, and "logged the miss into `fetches`" is precisely the bug.
const into = (db, table) => db.rows.filter((r) => new RegExp(`INTO ${table} `).test(r.sql))

test("a served component is logged with its name and classification", async () => {
  const db = fakeDB()
  const c = ctx({ db })
  const res = await onRequestGet(c)
  await flush(c)

  assert.equal(res.status, 200)
  assert.equal(db.rows.length, 1)
  assert.equal(into(db, "fetches").length, 1)
  assert.equal(into(db, "misses").length, 0, "a delivery is not a miss")
  const [date, item, ts, ua, country, isBot] = db.rows[0].args
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(item, "copy-button")
  assert.ok(Number.isFinite(ts))
  assert.equal(ua, "shadcn/2.4.0")
  assert.equal(country, "JP")
  assert.equal(isBot, 0)
})

test("a revalidated (304) component is logged too — the client still left with the item", async () => {
  // Pages serves /r/*.json with `max-age=0, must-revalidate`, so every caching client comes back
  // with If-None-Match and ASSETS answers 304. Skipping those undercounts exactly the clients
  // that install more than once.
  const db = fakeDB()
  const c = ctx({ db, assets: fakeAssets(304) })
  const res = await onRequestGet(c)
  await flush(c)

  assert.equal(res.status, 304)
  assert.equal(db.rows.length, 1, "a 304 is a delivered component, not a miss")
  assert.equal(db.rows[0].args[1], "copy-button")
})

test("a crawler is served and logged, flagged as a bot", async () => {
  const db = fakeDB()
  const c = ctx({ db, ua: "Googlebot/2.1 (+http://www.google.com/bot.html)" })
  assert.equal((await onRequestGet(c)).status, 200)
  await flush(c)
  assert.equal(db.rows[0].args[5], 1)
})

test("a response that delivered nothing is not counted as a fetch", async () => {
  for (const status of [404, 500]) {
    const db = fakeDB()
    const c = ctx({ db, assets: fakeAssets(status, "not found", "text/plain") })
    const res = await onRequestGet(c)
    await flush(c)
    assert.equal(res.status, status)
    assert.equal(db.rows.length, 0, `status ${status} must not be logged`)
  }
})

test("an unknown component is a JSON 404, not the landing page under status 200", async () => {
  // The bug this covers: with no 404.html, Pages answers /r/<unknown>.json with index.html and
  // status 200. `shadcn add` then parses 186KB of HTML as a registry item and fails on a syntax
  // error rather than reporting that the component does not exist.
  const db = fakeDB()
  const c = ctx({ path: "/r/does-not-exist.json", db, assets: fakeSpaFallback() })
  const res = await onRequestGet(c)
  await flush(c)

  assert.equal(res.status, 404)
  assert.match(res.headers.get("content-type"), /^application\/json/)
  const body = JSON.parse(await res.text())
  assert.equal(body.error, "not_found")
  assert.equal(body.name, "does-not-exist")
  assert.equal(body.registry, "https://pulld.pages.dev/r/registry.json")
  assert.equal(into(db, "fetches").length, 0, "a miss is not a delivered component")
})

test("a miss is recorded in `misses`, with the name that was asked for", async () => {
  // Returning the 404 without recording it is the other half of the same bug: for one day after
  // the 404 shipped, the names agents guess — the most direct evidence of what this registry is
  // missing — were written nowhere at all.
  const db = fakeDB()
  const c = ctx({ path: "/r/data-table.json", db, ua: "shadcn", assets: fakeSpaFallback() })
  assert.equal((await onRequestGet(c)).status, 404)
  await flush(c)

  const rows = into(db, "misses")
  assert.equal(rows.length, 1)
  const [date, item, ts, ua, country, isBot] = rows[0].args
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(item, "data-table")
  assert.ok(Number.isFinite(ts))
  assert.equal(ua, "shadcn")
  assert.equal(country, "JP")
  assert.equal(isBot, 0)
})

test("the substituted landing page is never logged as a component", async () => {
  // 1,535 rows of the production log are names this registry has never shipped — they were
  // `res.ok`, so they counted as deliveries. `index` is among them: the path official shadcn
  // uses for its catalogue, swept daily by the IntelliJ plugin. They belong in `misses`, which
  // nothing reads as reward, and nowhere else.
  for (const name of ["index", "button", "bento-box"]) {
    const db = fakeDB()
    const c = ctx({ path: `/r/${name}.json`, db, assets: fakeSpaFallback() })
    assert.equal((await onRequestGet(c)).status, 404, name)
    await flush(c)
    assert.equal(into(db, "fetches").length, 0, name)
    assert.deepEqual(
      into(db, "misses").map((r) => r.args[1]),
      [name]
    )
  }
})

test("a crawler's miss is recorded and flagged, not dropped", async () => {
  // Most of this log is automated, and the automated half is the informative half — the IntelliJ
  // plugin sweeping official names is how we know which names agents expect. Dropping bots here
  // would leave the table nearly empty. `is_bot` keeps them separable at read time instead.
  const db = fakeDB()
  const c = ctx({
    path: "/r/date-picker.json",
    db,
    ua: "Googlebot/2.1 (+http://www.google.com/bot.html)",
    assets: fakeSpaFallback(),
  })
  assert.equal((await onRequestGet(c)).status, 404)
  await flush(c)
  assert.equal(into(db, "misses")[0].args[5], 1)
})

test("a failing miss-log never changes the 404", async () => {
  // Same contract as the delivery path: the response is already decided, so a broken binding is
  // swallowed. Both failure shapes — a rejected insert and a prepare() that throws — are covered.
  const rejecting = {
    prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1 down") } }) }),
  }
  const throwing = {
    prepare() {
      throw new Error("binding revoked")
    },
  }
  for (const db of [rejecting, throwing, null]) {
    const c = ctx({ path: "/r/nope.json", db, assets: fakeSpaFallback() })
    const res = await onRequestGet(c)
    await flush(c)
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(await res.text()).name, "nope")
  }
})

test("the delivered type must be JSON, not merely mention it", async () => {
  // The content-type check is anchored on purpose: a type that carries the string somewhere in a
  // parameter is still not a registry item. Without the anchor a substring match reads as JSON.
  const db = fakeDB()
  const c = ctx({
    path: "/r/does-not-exist.json",
    db,
    assets: fakeAssets(200, "<!doctype html>", "text/html; note=application/json"),
  })
  assert.equal((await onRequestGet(c)).status, 404)
  await flush(c)
  assert.equal(into(db, "fetches").length, 0)
  assert.equal(into(db, "misses").length, 1)
})

test("a revalidated delivery is not mistaken for a miss", async () => {
  // 304 carries no content-type, so a content-type test for the substituted page must not
  // sweep up the one delivery shape that legitimately has none.
  const db = fakeDB()
  const c = ctx({ db, assets: fakeAssets(304) })
  const res = await onRequestGet(c)
  await flush(c)
  assert.equal(res.status, 304)
  assert.equal(db.rows.length, 1)
})

test("only /r/<name>.json is attributed to a component", async () => {
  // The route is a catch-all: anything else under /r/ is still served, but there is no item name
  // to attribute it to, so it must not land in `fetches` under a junk key.
  for (const path of ["/r/index.html", "/r/nested/copy-button.json", "/r/copy_button.json"]) {
    const db = fakeDB()
    const c = ctx({ path, db })
    const res = await onRequestGet(c)
    await flush(c)
    assert.equal(res.status, 200, path)
    assert.equal(db.rows.length, 0, path)
  }
})

test("the asset response is passed through untouched", async () => {
  const c = ctx({ assets: fakeAssets(200, '{"name":"copy-button"}') })
  const res = await onRequestGet(c)
  assert.equal(res.headers.get("etag"), '"v1"')
  assert.equal(await res.text(), '{"name":"copy-button"}')
  assert.deepEqual(c.env.ASSETS.calls, ["https://pulld.pages.dev/r/copy-button.json"])
})

test("serving is never blocked by the log", async () => {
  const noDb = ctx({ db: null })
  assert.equal((await onRequestGet(noDb)).status, 200)

  const brokenDb = {
    prepare() {
      return {
        bind() {
          return {
            run: async () => {
              throw new Error("D1 down")
            },
          }
        },
      }
    },
  }
  const c = ctx({ db: brokenDb })
  assert.equal((await onRequestGet(c)).status, 200)
  await flush(c) // the rejected insert is caught inside the handler, not surfaced here

  // A binding that throws synchronously on prepare() must not escape either.
  const throwingDb = {
    prepare() {
      throw new Error("binding revoked")
    },
  }
  assert.equal((await onRequestGet(ctx({ db: throwingDb }))).status, 200)
})

test("an absent D1 binding is silent, not an error on every request", async () => {
  // Without the early return the insert still cannot happen — `null.prepare()` throws into the
  // same catch — so the response is identical either way and no assertion above can see the
  // difference. What differs is the console: an unbound DB is the normal state of a preview
  // deployment, and logging it as a failure on every single request buries the failures that
  // matter. That is the guard's whole job, so it is written down here.
  const errors = []
  const real = console.error
  console.error = (...a) => errors.push(a.join(" "))
  try {
    const c = ctx({ db: null })
    assert.equal((await onRequestGet(c)).status, 200)
    await flush(c)
  } finally {
    console.error = real
  }
  assert.deepEqual(errors, [])
})

test("a missing ASSETS binding degrades to 503 instead of an opaque crash", async () => {
  const c = ctx()
  c.env.ASSETS = null
  const res = await onRequestGet(c)
  assert.equal(res.status, 503)
})
