// Buy-button click tracker: logs the click, then redirects to the Polar checkout link.
//
// Why this exists: Polar creates a brand-new Checkout Session on *every* visit to a
// buy.polar.sh link ("Each visit produces a brand new Checkout Session"), so the dashboard's
// checkout count is a hit counter for the link, not a measure of purchase intent — a crawler
// following the <a href> looks exactly like a person who changed their mind. Routing the click
// through here records who it actually was, and gives the funnel a denominator we own.
//
// Crawlers are not redirected at all: they get a plain page with the link on it. That keeps them
// out of Polar's checkout log while still being failure-safe — a misclassified person sees one
// extra click, not a dead end.
//
// The checkout URLs live in wrangler.toml [vars] so the landing page (which now links to /go/…)
// and this redirect can't drift apart. Best-effort logging: a click is never blocked by the log.
import { isCrawler } from "../_traffic.js"

const TARGETS = {
  search: "POLAR_SEARCH_CHECKOUT_URL",
  pro: "POLAR_PRO_CHECKOUT_URL",
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]
  )
}

export async function onRequestGet(context) {
  const { request, env, params } = context
  const target = String(params?.target || "").toLowerCase()

  const varName = TARGETS[target]
  const dest = varName && env ? env[varName] : null
  if (!dest) return new Response("not found", { status: 404 })

  const ua = request.headers.get("user-agent") || ""
  const crawler = isCrawler(ua)

  try {
    if (env.DB) {
      const referer = request.headers.get("referer") || ""
      context.waitUntil(
        env.DB.prepare(
          "INSERT INTO clicks (date, target, ts, ua, country, referer, is_bot) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            new Date().toISOString().slice(0, 10),
            target,
            Date.now(),
            ua.slice(0, 256),
            (request.headers.get("cf-ipcountry") || "").slice(0, 8),
            referer.slice(0, 256),
            crawler ? 1 : 0
          )
          .run()
          .catch((e) => console.error("click-log insert failed:", e?.message || e))
      )
    }
  } catch (e) {
    console.error("click-log skipped:", e?.message || e)
  }

  if (crawler) {
    return new Response(
      `<!doctype html><meta name="robots" content="noindex,nofollow">` +
        `<title>pulld — checkout</title>` +
        `<p><a rel="nofollow" href="${escapeHtml(dest)}">Continue to checkout</a></p>`,
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
    )
  }

  return new Response(null, {
    status: 302,
    headers: { location: dest, "cache-control": "no-store" },
  })
}
