// Handler-level tests for the registry route (functions/r/[[path]].js) — the one path every
// install goes through. Two invariants: serving must never be blocked by logging (a lost asset
// is a failed `shadcn add`), and the log must record every delivered component, because that
// count is the reward learn.mjs tunes metadata against and the priority sweep.mjs works from.
// A revalidated (304) delivery is the case that used to be dropped.
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
// 200 for a served file, 304 when the client's If-None-Match still matches, 404 for no such item.
function fakeAssets(status = 200, body = '{"name":"copy-button"}') {
  return {
    calls: [],
    fetch(request) {
      this.calls.push(request.url)
      const nullBody = status === 304 || status === 204
      return Promise.resolve(
        new Response(nullBody ? null : body, {
          status,
          headers: { etag: '"v1"' },
        })
      )
    },
  }
}

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

test("a served component is logged with its name and classification", async () => {
  const db = fakeDB()
  const c = ctx({ db })
  const res = await onRequestGet(c)
  await flush(c)

  assert.equal(res.status, 200)
  assert.equal(db.rows.length, 1)
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
    const c = ctx({ db, assets: fakeAssets(status, "not found") })
    const res = await onRequestGet(c)
    await flush(c)
    assert.equal(res.status, status)
    assert.equal(db.rows.length, 0, `status ${status} must not be logged`)
  }
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

test("a missing ASSETS binding degrades to 503 instead of an opaque crash", async () => {
  const c = ctx()
  c.env.ASSETS = null
  const res = await onRequestGet(c)
  assert.equal(res.status, 503)
})
