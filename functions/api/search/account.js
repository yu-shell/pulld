// GET /api/search/account — return the project's API keys.
// Two ways in:
//   ?customer_session_token=polar_cst_...  → the token Polar puts on the post-checkout redirect.
//      We resolve it to the customer's license key via the Polar customer-portal API.
//   ?license=<key>                          → the customer pastes their Polar license key directly.
// Either way we look the project up by license key and return admin_key (indexing) + query_key
// (search). Server-to-server (returns a secret key), so no CORS.
import { json } from "./_lib.js"

const j = (data, status = 200) => json(data, status, { cors: false })

// Resolve a Polar customer session token to one of this customer's license keys, preferring a key
// that maps to an active search project (a customer may hold several license keys).
async function licenseFromSession(env, session) {
  const base = env.POLAR_API_BASE || "https://api.polar.sh"
  const params = new URLSearchParams()
  if (env.POLAR_ORG_ID) params.set("organization_id", env.POLAR_ORG_ID)
  params.set("limit", "20")
  try {
    const res = await fetch(`${base}/v1/customer-portal/license-keys/?${params.toString()}`, {
      headers: { Authorization: `Bearer ${session}` },
    })
    if (!res.ok) return ""
    const data = await res.json()
    const items = data?.items ?? []
    if (!env.DB) return ""
    // Return only a key that maps to one of this customer's active search projects — never an
    // arbitrary key. (No active-project match → "" → 401, rather than guessing.)
    for (const k of items) {
      if (!k.key) continue
      const hit = await env.DB.prepare(
        "SELECT 1 FROM search_projects WHERE ls_license = ? AND active = 1"
      )
        .bind(k.key)
        .first()
      if (hit) return k.key
    }
    return ""
  } catch {
    return ""
  }
}

export async function onRequestGet(context) {
  const { request, env } = context
  const url = new URL(request.url)
  let license = url.searchParams.get("license") || request.headers.get("x-pulld-license") || ""
  const session =
    url.searchParams.get("customer_session_token") || url.searchParams.get("session") || ""

  if (!license && session) {
    license = await licenseFromSession(env, session)
  }
  if (!license || !env.DB) return j({ error: "unauthorized" }, 401)

  let row
  try {
    row = await env.DB.prepare(
      "SELECT id, admin_key, query_key, plan, q_limit, doc_limit " +
        "FROM search_projects WHERE ls_license = ? AND active = 1"
    )
      .bind(license)
      .first()
  } catch {
    row = null
  }
  if (!row) {
    return j({ error: "not_found", message: "No active project for this license key." }, 404)
  }
  return j({
    project: row.id,
    admin_key: row.admin_key,
    query_key: row.query_key,
    plan: row.plan,
    limits: { queries_per_month: row.q_limit, docs: row.doc_limit },
  })
}
