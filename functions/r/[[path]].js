// Pages Function for /r/*.json: logs each fetch (best-effort), then serves the static asset.
// Log-then-serve pattern. Serving the registry is never blocked — not when env.DB (D1) is
// unbound, not for bots, and not when the log insert fails.
//
// Two logs, deliberately separate: `fetches` = a component was delivered (the reward learn.mjs
// tunes metadata against), `misses` = a name that was asked for and does not exist (the signal
// for what to build next). Every bug in this file so far has come from those two being mixed.

import { isCrawler } from "../_traffic.js"

export async function onRequestGet(context) {
  const { request, env } = context

  // Without ASSETS we cannot serve; degrade explicitly instead of throwing an opaque 500.
  if (!env || !env.ASSETS) {
    return new Response("registry asset binding unavailable", { status: 503 })
  }

  const res = await env.ASSETS.fetch(request)

  const url = new URL(request.url)
  const m = url.pathname.match(/^\/r\/([a-z0-9-]+)\.json$/i)

  // This project ships no 404.html, so Pages answers an unknown asset with index.html **under
  // status 200**. For /r/<name>.json that is worse than a plain miss: `shadcn add` — or an agent
  // guessing a name — receives 186KB of landing page under a success status and dies on a JSON
  // parse error instead of being told the component does not exist. The fallback is also `res.ok`,
  // so every miss was logged as a delivered component: 1,535 rows of `fetches` name components
  // this registry has never shipped, `index` (the path official shadcn uses for its catalogue)
  // among them.
  //
  // The request asked for `.json`, so anything that did not come back as JSON is not the asset it
  // asked for, whatever made Pages substitute it. 304 carries no content-type and is a real
  // delivery, so it is excluded by `res.ok`.
  if (m && res.ok && !/^application\/json/i.test(res.headers.get("content-type") || "")) {
    // Answering the miss correctly is only half of it. The name somebody guessed is the most
    // direct evidence this project has of what agents come here looking for, and returning 404
    // without recording it traded a corrupt signal for no signal: the day after the fix shipped,
    // every unknown name — including whatever the `shadcn` clients that read the index and picked
    // nothing went on to ask for — vanished from the log entirely.
    //
    // So it is recorded, but in `misses`, never in `fetches`. `fetches` means "a component was
    // delivered" and is what learn.mjs rewards; mixing a miss back into it is the bug this branch
    // exists to fix. Same best-effort discipline as below — the 404 ships regardless.
    logRow(context, "misses", m[1], request)
    return new Response(
      JSON.stringify(
        { error: "not_found", name: m[1], registry: new URL("/r/registry.json", url).href },
        null,
        2
      ) + "\n",
      { status: 404, headers: { "content-type": "application/json; charset=utf-8" } }
    )
  }

  // A 304 is a delivered component too: the client asked for the item and left with a usable
  // copy, it just already had the bytes. ASSETS answers If-None-Match itself, so every client
  // that caches (a browser, a catalogue mirror re-checking what it holds) revalidates into a
  // 304 — and `res.ok` is false for 304, which silently dropped those rows. The count that
  // learn.mjs rewards and sweep.mjs prioritises on was therefore biased toward clients that
  // never cache. Anything else (404, 5xx) is not a fetch of a component and stays unlogged.
  const served = res.ok || res.status === 304

  if (served && m) logRow(context, "fetches", m[1], request)

  // Note: Pages sets `max-age=0, must-revalidate` on /r/*.json (a Cache-Control override from
  // the Function is ignored by Pages). must-revalidate means the origin is revalidated on every
  // request, so the Function runs each time — and because a revalidation is counted above, no
  // fetch is missed from the log.
  return res
}

// The two statements are spelled out rather than built from the table name: a table name cannot
// be a bound parameter, so interpolating one is the shape of an injection even when every call
// site passes a literal. Written this way there is no path from a value to the SQL.
const INSERT = {
  fetches:
    "INSERT INTO fetches (date, item, ts, ua, country, is_bot) VALUES (?, ?, ?, ?, ?, ?)",
  misses: "INSERT INTO misses (date, item, ts, ua, country, is_bot) VALUES (?, ?, ?, ?, ?, ?)",
}

// Records one row in `table` ("fetches" = a component was delivered, "misses" = a name nobody
// ships was asked for). The two tables have the same shape and the same contract: the response
// has already been decided by the caller and is never held up or changed by this, so every
// failure path — no binding, a rejected insert, a binding that throws on prepare() — is
// swallowed into the Workers log.
function logRow(context, table, item, request) {
  try {
    const db = context.env?.DB
    if (!db) return
    const ua = request.headers.get("user-agent") || ""
    const country = (request.headers.get("cf-ipcountry") || "").slice(0, 8)
    context.waitUntil(
      db
        .prepare(INSERT[table])
        .bind(
          new Date().toISOString().slice(0, 10),
          item,
          Date.now(),
          ua.slice(0, 256),
          country,
          isCrawler(ua) ? 1 : 0
        )
        .run()
        .catch((e) => console.error(`${table} insert failed:`, e?.message || e))
    )
  } catch (e) {
    console.error(`${table} log skipped:`, e?.message || e)
  }
}
