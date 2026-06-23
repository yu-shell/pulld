// Pages Function for /r/*.json: logs each fetch (best-effort), then serves the static asset.
// Log-then-serve pattern. Serving the registry is never blocked — not when env.DB (D1) is
// unbound, not for bots, and not when the log insert fails.

const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|headless|python-requests|curl\/|wget|go-http|java\//i

export async function onRequestGet(context) {
  const { request, env } = context

  // Without ASSETS we cannot serve; degrade explicitly instead of throwing an opaque 500.
  if (!env || !env.ASSETS) {
    return new Response("registry asset binding unavailable", { status: 503 })
  }

  const res = await env.ASSETS.fetch(request)

  const url = new URL(request.url)
  const m = url.pathname.match(/^\/r\/([a-z0-9-]+)\.json$/i)

  try {
    if (res.ok && m && env.DB) {
      const item = m[1]
      const ua = request.headers.get("user-agent") || ""
      const country = (request.headers.get("cf-ipcountry") || "").slice(0, 8)
      const isBot = BOT_UA.test(ua) ? 1 : 0
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
  // request, so the Function runs each time and no fetch is missed from the log.
  return res
}
