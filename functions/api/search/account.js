// GET /api/search/account — return the project's API keys.
// Two ways in:
//   ?customer_session_token=polar_cst_...  → the token Polar puts on the post-checkout redirect.
//      We resolve it to the customer's license key via the Polar customer-portal API.
//   ?license=<key>                          → the customer pastes their Polar license key directly.
// Either way we look the project up by license key and return admin_key (indexing) + query_key
// (search). Server-to-server (returns a secret key), so no CORS, and burst-limited per IP before
// any of that work runs (ACCOUNT_RL_LIMIT below).
import { json, rateLimited, RL_WINDOW } from "./_lib.js"

// `extra` carries response headers through to json() — `retry-after` on the 429 below is the only
// one so far. No CORS here (this endpoint answers with a secret key), so nothing has to be named
// in access-control-expose-headers for it to be readable: the page that reads it is same-origin.
const j = (data, status = 200, extra = {}) => json(data, status, { cors: false, ...extra })

// Requests per RL_WINDOW per IP for this endpoint, deliberately far below RL_LIMIT, the allowance
// the query endpoint runs on (see rateLimited in _lib.js for why the limit is per call). Named
// against that constant rather than against the number it currently holds, so the comparison
// cannot quietly become false; test/account-handler.test.mjs asserts the ordering too.
//
// This is the one endpoint in the service that is reachable with no credential and answers with
// one — `admin_key`, which is write access to the customer's index — so until now the two things
// nothing bounded were the two that matter most here: how many license keys an anonymous caller
// may guess at, and how much work one can make this Worker do. The session-token path is the
// expensive half: each request is an outbound call to the Polar customer-portal API plus, for
// every key it lists (up to 20), a D1 read. Unbounded, that is an amplifier anyone can point at
// us, and the fetch log would show nothing — this endpoint writes no row anywhere.
//
// The real page spends exactly one request per load (public/account.html fetches once, on submit
// or on the post-checkout redirect, and never polls), so 20 leaves a customer who re-pastes a key,
// reloads, and shares an office NAT with other customers far short of it. The cost of being wrong
// in this direction is one visible "slow down" message on a page whose own retry is a reload; the
// cost of being wrong in the other is a secret.
//
// Exported so test/account-handler.test.mjs can drive the limiter to its edge by this number
// rather than by a copy of it — a test that spells its own 20 passes whatever this becomes.
export const ACCOUNT_RL_LIMIT = 20

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

  // Before the Polar round-trip and before either D1 lookup, which is the whole point: those are
  // the cost and the guessing this bounds. Keyed per IP because there is no project to key on yet
  // — resolving one is what the caller is asking for — and namespaced so an account burst and a
  // query burst from the same address cannot spend each other's window (query.js keys on
  // `<project id>:<ip>`, and project ids are `prj_…`, so `acct:` can collide with none of them).
  //
  // Counted for a request that carries no credential at all, not only for one that fails to
  // resolve: a bare GET still costs a D1 write, and a flood of them is the flood being bounded.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0"
  if (await rateLimited(env, `acct:${ip}`, ACCOUNT_RL_LIMIT)) {
    return j(
      { error: "rate_limited", message: "Too many key lookups; slow down and try again shortly." },
      429,
      { "retry-after": String(RL_WINDOW) }
    )
  }

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
