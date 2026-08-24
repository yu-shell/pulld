// The Pro license gate, minus the blocks it serves.
//
// Split out of functions/r/pro/[[path]].js for one reason: the route imports PRO_BLOCKS from
// functions/_pro-blocks.js, which scripts/build-pro.mjs generates and .gitignore keeps out of the
// repository. A top-level import of a file that is not in the repository makes the module
// unimportable anywhere but the machine that built it — so the one code path that decides whether
// paid content is handed out was the only handler under functions/ with no test, and could not
// have had one. Every other handler here has `node --test` coverage precisely because functions/
// is excluded from tsconfig and that is its only automated check.
//
// Taking `blocks` as a parameter is the same move verify-registry.mjs, sweep.mjs, learn.mjs and
// build-index.mjs all make: the decision is a function of its inputs, so hand it its inputs and
// it can be tested without the real world. The route below it keeps the import and passes the
// real map through.
import { isCrawler } from "./_traffic.js"

function logFetch(context, env, item, paid) {
  try {
    const { request } = context
    if (!env.DB) return
    const ua = request.headers.get("user-agent") || ""
    const country = (request.headers.get("cf-ipcountry") || "").slice(0, 8)
    const isBot = isCrawler(ua) ? 1 : 0
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

// Serves `blocks[name]` only when a valid license key is presented (via `?key=` or X-Pulld-Key),
// validated against the D1 `licenses` table; otherwise 402. Every way of not knowing — no key, no
// D1 binding, a D1 that throws — leaves `valid` false and answers 402, so the gate fails closed.
export async function handleProGet(context, blocks) {
  const { request, env } = context
  const url = new URL(request.url)
  const m = url.pathname.match(/^\/r\/pro\/([a-z0-9-]+)\.json$/i)
  if (!m) return new Response("not found", { status: 404 })

  const name = m[1]
  // `_pro-blocks.js` is written as `export const PRO_BLOCKS = ` + JSON.stringify(map), so the
  // map is a plain object literal and inherits Object.prototype. `blocks[name]` therefore answers
  // for names nobody sells: the route's own `[a-z0-9-]+` is case-INSENSITIVE, so `toString`,
  // `constructor`, `valueOf`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable` and
  // `toLocaleString` all reach the lookup and all come back truthy. Measured against the handler
  // before this fix: `/r/pro/toString.json` with no key answered 402 "This is a pulld Pro block.
  // Get a license…", pointing a caller at a checkout for a block that does not exist; with a
  // VALID key it answered 200 with `content-type: application/json` and a zero-length body,
  // because JSON.stringify of a function is undefined. That is the failure the free registry
  // route has its own comment about avoiding — a client receives success and dies on a JSON parse
  // instead of being told the name is not real. An own-property check drops all seven back onto
  // the ordinary 404.
  if (!Object.prototype.hasOwnProperty.call(blocks, name)) {
    return new Response("not found", { status: 404 })
  }
  const block = blocks[name]

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
