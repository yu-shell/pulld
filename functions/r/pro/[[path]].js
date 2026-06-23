// Pro block gate: serves a Pro block's JSON only when a valid license key is presented
// (via `?key=`), validated against the D1 `licenses` table; otherwise returns 402.
// Pro block contents live in _pro-blocks.js, which is not committed and not served statically,
// so they cannot be retrieved without a valid key.
import { PRO_BLOCKS } from "../../_pro-blocks.js"

const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|headless|python-requests|curl\/|wget|go-http|java\//i

function logFetch(context, env, item, paid) {
  try {
    const { request } = context
    if (!env.DB) return
    const ua = request.headers.get("user-agent") || ""
    const country = (request.headers.get("cf-ipcountry") || "").slice(0, 8)
    const isBot = BOT_UA.test(ua) ? 1 : 0
    const date = new Date().toISOString().slice(0, 10)
    context.waitUntil(
      env.DB.prepare(
        "INSERT INTO fetches (date, item, ts, ua, country, is_bot) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(date, `pro/${item}${paid ? "" : ":402"}`, Date.now(), ua.slice(0, 256), country, isBot)
        .run()
        .catch((e) => console.error("pro fetch-log failed:", e?.message || e))
    )
  } catch (e) {
    console.error("pro fetch-log skipped:", e?.message || e)
  }
}

export async function onRequestGet(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const m = url.pathname.match(/^\/r\/pro\/([a-z0-9-]+)\.json$/i)
  if (!m) return new Response("not found", { status: 404 })

  const name = m[1]
  const block = PRO_BLOCKS[name]
  if (!block) return new Response("not found", { status: 404 })

  const key =
    url.searchParams.get("key") || request.headers.get("x-pulld-key") || ""

  let valid = false
  if (key && env.DB) {
    try {
      const row = await env.DB.prepare(
        // Test-mode keys (test_mode=1) must not unlock in production; only accept 0/NULL.
        "SELECT key FROM licenses WHERE key = ? AND active = 1 AND (test_mode = 0 OR test_mode IS NULL)"
      )
        .bind(key)
        .first()
      valid = !!row
    } catch (e) {
      console.error("license check failed:", e?.message || e)
    }
  }

  if (!valid) {
    logFetch(context, env, name, false)
    return new Response(
      JSON.stringify({
        error: "payment_required",
        message:
          "This is a pulld Pro block. Get a license at https://pulld.pages.dev/pro and install with ?key=YOUR_KEY (or set X-Pulld-Key).",
      }),
      { status: 402, headers: { "content-type": "application/json" } }
    )
  }

  logFetch(context, env, name, true)
  return new Response(JSON.stringify(block), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
