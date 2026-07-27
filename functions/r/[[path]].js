// Pages Function for /r/*.json: logs each fetch (best-effort), then serves the static asset.
// Log-then-serve pattern. Serving the registry is never blocked — not when env.DB (D1) is
// unbound, not for bots, and not when the log insert fails.

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

  // A 304 is a delivered component too: the client asked for the item and left with a usable
  // copy, it just already had the bytes. ASSETS answers If-None-Match itself, so every client
  // that caches (a browser, a catalogue mirror re-checking what it holds) revalidates into a
  // 304 — and `res.ok` is false for 304, which silently dropped those rows. The count that
  // learn.mjs rewards and sweep.mjs prioritises on was therefore biased toward clients that
  // never cache. Anything else (404, 5xx) is not a fetch of a component and stays unlogged.
  const served = res.ok || res.status === 304

  try {
    if (served && m && env.DB) {
      const item = m[1]
      const ua = request.headers.get("user-agent") || ""
      const country = (request.headers.get("cf-ipcountry") || "").slice(0, 8)
      const isBot = isCrawler(ua) ? 1 : 0
      const date = new Date().toISOString().slice(0, 10)
      context.waitUntil(
        env.DB.prepare(
          "INSERT INTO fetches (date, item, ts, ua, country, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
        )
          .bind(date, item, Date.now(), ua.slice(0, 256), country, isBot)
          .run()
          .catch((e) =>
            // Serving is unaffected; surface log failures to the Workers log for observability.
            console.error("fetch-log insert failed:", e?.message || e)
          )
      )
    }
  } catch (e) {
    console.error("fetch-log skipped:", e?.message || e)
  }

  // Note: Pages sets `max-age=0, must-revalidate` on /r/*.json (a Cache-Control override from
  // the Function is ignored by Pages). must-revalidate means the origin is revalidated on every
  // request, so the Function runs each time — and because a revalidation is counted above, no
  // fetch is missed from the log.
  return res
}
