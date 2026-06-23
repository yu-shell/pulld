// GET /api/search/account?license=<LS license key> — return the project's API keys.
// After subscribing, the customer receives a Lemon Squeezy license key; they exchange it here
// for their admin_key (indexing) and query_key (search). Server-to-server (returns a secret key).
import { json } from "./_lib.js"

const j = (data, status = 200) => json(data, status, { cors: false })

export async function onRequestGet(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const license =
    url.searchParams.get("license") || request.headers.get("x-pulld-license") || ""
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
