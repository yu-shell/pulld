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
// .ls_license), so /account resolves it the same way. Revocation matches by Polar
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
function idSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
}
const searchProductIds = (env) => idSet(env.POLAR_SEARCH_PRODUCT_IDS)
const proProductIds = (env) => idSet(env.POLAR_PRO_PRODUCT_IDS)

// Resolve a product's License Keys benefit id. A customer who buys several products holds one key
// per benefit, so matching on the benefit is what keeps Search and Pro keys apart.
async function licenseBenefitId(base, token, productId) {
  if (!productId) return null
  try {
    const res = await fetch(`${base}/v1/products/${productId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const p = await res.json()
    return (p.benefits || []).find((b) => b.type === "license_keys")?.id || null
  } catch {
    return null
  }
}

// Fetch the license key the customer received for THIS product, via the Polar API — matched on
// both customer and the product's license benefit, so a customer who owns Search + Pro never gets
// the other product's key. Returns null on any miss (caller retries); never a wrong/arbitrary key.
async function fetchLicenseKey(env, { customerId, productId }) {
  const token = env.POLAR_ACCESS_TOKEN
  if (!token || !customerId) return null
  const base = env.POLAR_API_BASE || "https://api.polar.sh"
  const benefitId = await licenseBenefitId(base, token, productId)
  // Fail closed: if a product was given but we couldn't resolve its license benefit, don't fall
  // back to an unfiltered lookup (which could return another product's key) — let the caller retry.
  if (productId && !benefitId) return null
  const params = new URLSearchParams()
  if (env.POLAR_ORG_ID) params.set("organization_id", env.POLAR_ORG_ID)
  if (benefitId) params.set("benefit_id", benefitId)
  params.set("limit", "50")
  try {
    const res = await fetch(`${base}/v1/license-keys/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const items = (await res.json())?.items ?? []
    const match = items.find(
      (k) =>
        (k.customer_id === customerId || k.user_id === customerId) &&
        (!benefitId || k.benefit_id === benefitId)
    )
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
  const isPro = proProductIds(env).has(productId)

  try {
    if (isIssue && (isSearch || isPro)) {
      const license = await fetchLicenseKey(env, { customerId, productId })
      if (!license) {
        // The license key may be granted slightly after the order/subscription. Return a retryable
        // status so Polar redelivers and we issue once the key exists, rather than dropping it.
        await logEvent(env, `polar:${type}`, false, `issue, license key not ready (cust=${customerId}) — retry`)
        return new Response("license key not ready", { status: 503 })
      }
      if (isSearch) {
        const projId = "prj_" + genKey().slice(0, 12)
        await env.DB.prepare(
          "INSERT INTO search_projects (id, admin_key, query_key, email, ls_license, ls_subscription, plan, q_limit, doc_limit, created, active) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'pro', 50000, 5000, ?, 1) " +
            "ON CONFLICT(ls_license) DO UPDATE SET active=1, email=excluded.email, ls_subscription=excluded.ls_subscription"
        )
          .bind(projId, "ak_" + genKey(), "pk_" + genKey(), email, license, subId, new Date().toISOString())
          .run()
        await logEvent(env, `polar:${type}`, true, `search project provisioned (sub=${subId})`)
      } else {
        // Pro one-time block license. refunded is terminal: a replayed issue won't revive it.
        await env.DB.prepare(
          "INSERT INTO licenses (key, email, product, created, active, status, test_mode) " +
            "VALUES (?, ?, 'pulld-pro', ?, 1, 'active', 0) " +
            "ON CONFLICT(key) DO UPDATE SET email=excluded.email, active=1, status='active' " +
            "WHERE licenses.status IS NULL OR licenses.status <> 'refunded'"
        )
          .bind(license, email, new Date().toISOString())
          .run()
        await logEvent(env, `polar:${type}`, true, `pro license issued`)
      }
    } else if (isRevoke) {
      if (subId) {
        await env.DB.prepare("UPDATE search_projects SET active = 0 WHERE ls_subscription = ?")
          .bind(subId)
          .run()
      }
      // One-time Pro refund (no subscription): deactivate the license by its key.
      if (isPro || !subId) {
        const lk = await fetchLicenseKey(env, { customerId, productId })
        if (lk) {
          await env.DB.prepare("UPDATE licenses SET active = 0, status = 'refunded' WHERE key = ?")
            .bind(lk)
            .run()
        }
      }
      await logEvent(env, `polar:${type}`, true, `revoked (sub=${subId} pro=${isPro})`)
    } else if (isIssue) {
      // Paid order for a product in neither POLAR_SEARCH_PRODUCT_IDS nor POLAR_PRO_PRODUCT_IDS —
      // log loudly (ok=0) so a product-id misconfiguration is visible rather than silently dropped.
      await logEvent(env, `polar:${type}`, false, `unrecognized product ${productId} — check POLAR_*_PRODUCT_IDS`)
    }
  } catch (e) {
    console.error("polar-webhook db:", e?.message || e)
    await logEvent(env, `polar:${type}`, false, "db-error:" + (e?.message || ""))
    if (isIssue || isRevoke) return new Response("db error", { status: 500 })
  }

  return new Response("ok", { status: 200 })
}
