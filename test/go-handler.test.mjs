// Handler-level tests for the buy-button redirect (functions/go/[target].js) — the new first hop
// of the purchase funnel. Two things must hold or the funnel is worse than before it existed:
// a person must always end up at the Polar checkout (a broken redirect is a lost sale, and the
// only sale signal pulld has), and a crawler must NOT be redirected, since Polar opens a fresh
// checkout session on every visit and those are what filled the dashboard with expired rows.
// functions/ is excluded from tsconfig, so `node --test` is its only automated coverage.
import { test } from "node:test"
import assert from "node:assert/strict"
import { onRequestGet } from "../functions/go/[target].js"

const SEARCH_URL = "https://buy.polar.sh/polar_cl_search"
const PRO_URL = "https://buy.polar.sh/polar_cl_pro"

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

function ctx({ target = "search", ua = "", db = fakeDB(), referer = "" } = {}) {
  const headers = { "user-agent": ua, "cf-ipcountry": "JP" }
  if (referer) headers.referer = referer
  const waited = []
  return {
    request: new Request(`https://pulld.pages.dev/go/${target}`, { headers }),
    env: {
      DB: db,
      POLAR_SEARCH_CHECKOUT_URL: SEARCH_URL,
      POLAR_PRO_CHECKOUT_URL: PRO_URL,
    },
    params: { target },
    waitUntil: (p) => waited.push(p),
    waited,
  }
}

const flush = (c) => Promise.all(c.waited)

test("a browser is redirected to the product's checkout link", async () => {
  for (const [target, dest] of [
    ["search", SEARCH_URL],
    ["pro", PRO_URL],
  ]) {
    const c = ctx({ target, ua: "Mozilla/5.0 (Macintosh) Chrome/126.0" })
    const res = await onRequestGet(c)
    assert.equal(res.status, 302, target)
    assert.equal(res.headers.get("location"), dest, target)
    // The redirect must not be cached, or a repeat click never reaches the log.
    assert.equal(res.headers.get("cache-control"), "no-store", target)
  }
})

test("target matching is case-insensitive and an unknown target is a 404", async () => {
  assert.equal((await onRequestGet(ctx({ target: "SEARCH" }))).status, 302)
  for (const target of ["bogus", "", "__proto__", "constructor"]) {
    const res = await onRequestGet(ctx({ target }))
    assert.equal(res.status, 404, target)
  }
})

test("a missing checkout URL is a 404, never a redirect to nowhere", async () => {
  const c = ctx({ target: "pro" })
  delete c.env.POLAR_PRO_CHECKOUT_URL
  assert.equal((await onRequestGet(c)).status, 404)
})

test("a crawler is not redirected — it gets the link instead, so Polar sees no session", async () => {
  const c = ctx({ target: "search", ua: "curio-harvest/0.1 (+https://example.com)" })
  const res = await onRequestGet(c)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get("location"), null)
  const body = await res.text()
  assert.match(body, /noindex,nofollow/)
  assert.ok(body.includes(SEARCH_URL), "the destination is still reachable by hand")
})

test("every click is logged with its classification, before the hop", async () => {
  const db = fakeDB()
  const c = ctx({
    target: "pro",
    ua: "Mozilla/5.0 (Macintosh) Chrome/126.0",
    referer: "https://pulld.pages.dev/",
    db,
  })
  await onRequestGet(c)
  await flush(c)
  assert.equal(db.rows.length, 1)
  const [date, target, ts, ua, country, referer, isBot] = db.rows[0].args
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(target, "pro")
  assert.ok(Number.isFinite(ts))
  assert.match(ua, /Chrome/)
  assert.equal(country, "JP")
  assert.equal(referer, "https://pulld.pages.dev/")
  assert.equal(isBot, 0)

  const botDb = fakeDB()
  const bc = ctx({ target: "search", ua: "Googlebot/2.1", db: botDb })
  await onRequestGet(bc)
  await flush(bc)
  assert.equal(botDb.rows[0].args[6], 1, "crawler clicks are logged too, flagged as bots")
})

test("the redirect still works when logging is impossible", async () => {
  // Serving the click is never blocked by the log — an unbound DB or a failing insert must not
  // cost a sale.
  const noDb = ctx({ target: "search", ua: "Mozilla/5.0 Chrome/126.0" })
  noDb.env.DB = null
  assert.equal((await onRequestGet(noDb)).status, 302)

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
  const c = ctx({ target: "search", ua: "Mozilla/5.0 Chrome/126.0", db: brokenDb })
  const res = await onRequestGet(c)
  assert.equal(res.status, 302)
  await flush(c) // the rejected insert is caught inside the handler, not surfaced here
})
