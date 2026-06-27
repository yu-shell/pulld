// Polar webhook → provisions / deactivates pulld Search projects.
//
// Polar follows the Standard Webhooks spec: headers `webhook-id`, `webhook-timestamp`,
// `webhook-signature`; signed content is `${id}.${timestamp}.${rawBody}`; the signature is
// base64(HMAC-SHA256(secret, signedContent)) and the header is a space-separated list of
// `v1,<sig>` tokens. Polar's signing secret format varies (plain string vs `whsec_`+base64), so
// we try each key interpretation and accept only if one produces a matching signature (extra
// interpretations never weaken security — a wrong key can't forge a valid signature).
//
// Retrieval model: a Search subscription issues a Polar license key (License Keys benefit). We
// fetch that key via the Polar API and store it as the customer's retrieval token (search_projects
// .ls_license), so /account works exactly as with Lemon Squeezy. Revocation matches by Polar
// subscription id (always present in the webhook).
//
// Missing secret → 503; invalid signature → 401 (fail-closed). State-changing events return
// non-200 on a DB failure so Polar retries. Rich diagnostics capture the real payload shape.

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
  let out = 0
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return out === 0
}

function b64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// Candidate HMAC keys for Polar's signing secret. Polar's secret is `polar_whs_<...>` and isn't a
// standard `whsec_`+base64 secret, so we try every plausible interpretation — full string, base64,
// and prefix-stripped (utf8 / base64). Only a key that produces a matching signature is accepted,
// so trying extras never weakens security.
function secretCandidates(secret) {
  const enc = new TextEncoder()
  const cands = []
  const tryB64 = (s) => {
    try {
      return b64ToBytes(s)
    } catch {
      return null
    }
  }
  const add = (bytes) => {
    if (bytes && bytes.length) cands.push(bytes)
  }
  add(enc.encode(secret))
  add(tryB64(secret))
  for (const pfx of ["whsec_", "polar_whs_"]) {
    if (secret.startsWith(pfx)) {
      const rest = secret.slice(pfx.length)
      add(enc.encode(rest))
      add(tryB64(rest))
    }
  }
  return cands
}

async function hmacB64(keyBytes, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))
  return bytesToB64(sig)
}

async function verifySignature(secret, headers, body) {
  const id = headers.get("webhook-id")
  const ts = headers.get("webhook-timestamp")
  const sigHeader = headers.get("webhook-signature")
  if (!id || !ts || !sigHeader) return false
  // Replay window: reject timestamps more than 5 minutes from now.
  const now = Math.floor(Date.now() / 1000)
  const t = Number(ts)
  if (!Number.isFinite(t) || Math.abs(now - t) > 300) return false

  const signed = `${id}.${ts}.${body}`
  const provided = sigHeader
    .split(" ")
    .map((p) => (p.includes(",") ? p.slice(p.indexOf(",") + 1) : p))
    .filter(Boolean)

  for (const keyBytes of secretCandidates(secret)) {
    let expected
    try {
      expected = await hmacB64(keyBytes, signed)
    } catch {
      continue
    }
    for (const p of provided) if (timingSafeEqual(p, expected)) return true
  }
  return false
}

async function logEvent(env, event, ok, note) {
  try {
    if (!env.DB) return
    await env.DB.prepare("INSERT INTO webhook_log (ts, event, ok, note) VALUES (?, ?, ?, ?)")
      .bind(new Date().toISOString(), event || "?", ok ? 1 : 0, (note || "").slice(0, 200))
      .run()
  } catch (e) {
    console.error("webhook_log failed:", e?.message || e)
  }
}

function genKey() {
  const b = new Uint8Array(18)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("")
}

// Polar product ids that map to pulld Search. Set POLAR_SEARCH_PRODUCT_IDS (comma-separated) once
// the product exists; until then provisioning is skipped and the product id is logged.
function searchProductIds(env) {
  return new Set(
    String(env.POLAR_SEARCH_PRODUCT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

// Best-effort: fetch the customer's license key via the Polar API (License Keys benefit).
// Field/endpoint specifics are confirmed against the first real payload; returns null on any miss.
async function fetchLicenseKey(env, { customerId }) {
  const token = env.POLAR_ACCESS_TOKEN
  if (!token) return null
  const base = env.POLAR_API_BASE || "https://api.polar.sh"
  const params = new URLSearchParams()
  if (env.POLAR_ORG_ID) params.set("organization_id", env.POLAR_ORG_ID)
  params.set("limit", "50")
  try {
    const res = await fetch(`${base}/v1/license-keys/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = await res.json()
    const items = data?.items ?? data?.result?.items ?? []
    // Only return a key we can confidently attribute to this customer — never an arbitrary key,
    // which would hand one customer another customer's retrieval token.
    if (!customerId) return null
    const match = items.find((k) => k.customer_id === customerId || k.user_id === customerId)
    return match?.key ?? null
  } catch {
    return null
  }
}

export async function onRequestPost(context) {
  const { request, env } = context

  const secret = env.POLAR_WEBHOOK_SECRET
  if (!secret) return new Response("not configured", { status: 503 })

  const raw = await request.text()
  if (!(await verifySignature(secret, request.headers, raw))) {
    await logEvent(env, "polar-invalid-signature", false, "")
    return new Response("invalid signature", { status: 401 })
  }

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    await logEvent(env, "polar-bad-json", false, "")
    return new Response("bad json", { status: 400 })
  }

  const type = body?.type || "unknown"
  const data = body?.data || {}

  // Extract the fields we need with fallbacks; the real shape is confirmed from diagnostics below.
  const productId = String(data.product_id ?? data.product?.id ?? "")
  const customerId = data.customer_id ?? data.customer?.id ?? data.user_id ?? null
  const email = data.customer?.email ?? data.customer_email ?? data.user?.email ?? null
  const subId =
    type.startsWith("subscription")
      ? data.id ?? null
      : data.subscription_id ?? data.subscription?.id ?? null
  const billingReason = data.billing_reason ?? null

  // Diagnostic: capture the real payload shape (data keys + extracted fields) for the first events.
  await logEvent(
    env,
    `polar:${type}`,
    true,
    `keys=${Object.keys(data).join(",")};pid=${productId};cust=${customerId};sub=${subId};reason=${billingReason}`
  )

  const isIssue =
    type === "subscription.created" ||
    (type === "order.paid" &&
      (!billingReason || ["purchase", "subscription_create"].includes(billingReason)))
  // Only `revoked` ends access. `subscription.canceled` is cancel-at-period-end — the customer
  // keeps access until the period actually ends (then `revoked` fires), so it must NOT deactivate.
  const isRevoke = type === "subscription.revoked" || type === "order.refunded"

  if ((isIssue || isRevoke) && !env.DB) {
    await logEvent(env, `polar:${type}`, false, "no DB binding")
    return new Response("db unavailable", { status: 503 })
  }

  const isSearch = searchProductIds(env).has(productId)

  try {
    if (isIssue && isSearch) {
      const license = await fetchLicenseKey(env, { customerId })
      if (!license) {
        // The license key may not be issued yet (the benefit is granted slightly after the
        // order/subscription). Return a retryable status so Polar redelivers and we provision once
        // the key exists, instead of dropping the provisioning permanently.
        await logEvent(env, `polar:${type}`, false, `search issue, license key not ready (cust=${customerId}) — retry`)
        return new Response("license key not ready", { status: 503 })
      }
      const projId = "prj_" + genKey().slice(0, 12)
      await env.DB.prepare(
        "INSERT INTO search_projects (id, admin_key, query_key, email, ls_license, ls_subscription, plan, q_limit, doc_limit, created, active) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'pro', 50000, 5000, ?, 1) " +
          "ON CONFLICT(ls_license) DO UPDATE SET active=1, email=excluded.email, ls_subscription=excluded.ls_subscription"
      )
        .bind(projId, "ak_" + genKey(), "pk_" + genKey(), email, license, subId, new Date().toISOString())
        .run()
      await logEvent(env, `polar:${type}`, true, `search project provisioned (sub=${subId})`)
    } else if (isRevoke && subId) {
      await env.DB.prepare("UPDATE search_projects SET active = 0 WHERE ls_subscription = ?")
        .bind(subId)
        .run()
      await logEvent(env, `polar:${type}`, true, `search project deactivated (sub=${subId})`)
    }
  } catch (e) {
    console.error("polar-webhook db:", e?.message || e)
    await logEvent(env, `polar:${type}`, false, "db-error:" + (e?.message || ""))
    if (isIssue || isRevoke) return new Response("db error", { status: 500 })
  }

  return new Response("ok", { status: 200 })
}
