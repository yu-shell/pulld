// Lemon Squeezy webhook -> automatic license issuance.
// Verifies X-Signature (HMAC-SHA256 hex of the body, secret=env.LEMON_WEBHOOK_SECRET) with a
// timing-safe comparison and only writes to D1 when the signature is valid. A purchase issues a
// key into `licenses`; a refund/revocation sets active=0.
// Robustness:
//  - `status='refunded'` is terminal: a replayed "created" event never re-activates a refunded row.
//  - For state-changing events, a DB failure or missing binding returns 503/500 (not a silent 200)
//    so Lemon Squeezy retries, preventing missed revocations.
// Missing secret -> 503; invalid signature -> 401 (fail-closed). The secret is a Cloudflare
// secret, not stored in the repo.

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false
  }
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

async function hmacHex(secret, body) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body))
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

async function logEvent(env, event, ok, note) {
  try {
    if (!env.DB) return
    await env.DB.prepare(
      "INSERT INTO webhook_log (ts, event, ok, note) VALUES (?, ?, ?, ?)"
    )
      .bind(new Date().toISOString(), event || "?", ok ? 1 : 0, (note || "").slice(0, 200))
      .run()
  } catch (e) {
    console.error("webhook_log failed:", e?.message || e)
  }
}

export async function onRequestPost(context) {
  const { request, env } = context

  const secret = env.LEMON_WEBHOOK_SECRET
  if (!secret) return new Response("not configured", { status: 503 })

  const raw = await request.text()

  let valid = false
  try {
    const expected = await hmacHex(secret, raw)
    valid = timingSafeEqual(
      (request.headers.get("x-signature") || "").trim(),
      expected
    )
  } catch (e) {
    console.error("hmac error:", e?.message || e)
  }
  if (!valid) {
    await logEvent(env, "invalid-signature", false, "")
    return new Response("invalid signature", { status: 401 })
  }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    await logEvent(env, "bad-json", false, "")
    return new Response("bad json", { status: 400 })
  }

  const event = body?.meta?.event_name || "unknown"
  const attrs = body?.data?.attributes || {}
  const key = attrs.key || attrs.license_key || null
  const email = attrs.user_email || attrs.email || null
  const testMode =
    attrs.test_mode === true || body?.meta?.test_mode === true ? 1 : 0

  const isIssue =
    !!key && (event === "license_key_created" || event === "order_created")
  const isRevoke =
    !!key && (event === "order_refunded" || event === "license_key_updated")

  // State-changing events require the DB; if unbound, return non-200 so Lemon Squeezy retries.
  if ((isIssue || isRevoke) && !env.DB) {
    await logEvent(env, event, false, "no DB binding")
    return new Response("db unavailable", { status: 503 })
  }

  try {
    if (isIssue) {
      // refunded is terminal: a replayed "created" event does not revive a refunded row.
      await env.DB.prepare(
        "INSERT INTO licenses (key, email, product, created, active, status, test_mode) " +
          "VALUES (?, ?, ?, ?, 1, 'active', ?) " +
          "ON CONFLICT(key) DO UPDATE SET email=excluded.email, product=excluded.product, " +
          "active=1, status='active', test_mode=excluded.test_mode " +
          "WHERE licenses.status IS NULL OR licenses.status <> 'refunded'"
      )
        .bind(key, email, attrs.product_name || "pulld-pro", new Date().toISOString(), testMode)
        .run()
      await logEvent(env, event, true, `license issued (test_mode=${testMode})`)
    } else if (isRevoke) {
      const refunded = event === "order_refunded"
      const active = refunded
        ? 0
        : attrs.status && attrs.status !== "active"
          ? 0
          : 1
      const status = refunded ? "refunded" : active ? "active" : "disabled"
      // A refund always applies (terminal); license_key_updated does not revive a refunded row.
      await env.DB.prepare(
        "UPDATE licenses SET active=?, status=? " +
          "WHERE key=? AND (?=1 OR status IS NULL OR status <> 'refunded')"
      )
        .bind(active, status, key, refunded ? 1 : 0)
        .run()
      await logEvent(env, event, true, `revoke active=${active}`)
    } else {
      await logEvent(
        env,
        event,
        true,
        key
          ? "key present, event unhandled"
          : `no key; attrs:${Object.keys(attrs).join(",").slice(0, 150)}`
      )
    }
  } catch (e) {
    console.error("ls-webhook db:", e?.message || e)
    await logEvent(env, event, false, "db-error:" + (e?.message || ""))
    // For state-changing events, don't confirm with 200 on a DB failure; let Lemon Squeezy retry
    // so no issuance or revocation is missed.
    if (isIssue || isRevoke) return new Response("db error", { status: 500 })
  }

  return new Response("ok", { status: 200 })
}
