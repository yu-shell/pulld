// GET/POST /api/search/query?key=&q= — semantic search for a project (public query_key).
// This is what the command-palette `source` calls. Returns items shaped for the palette.
import { json, cors, embed, projectByKey, bumpUsage, rateLimited } from "./_lib.js"

export function onRequestOptions() {
  return cors()
}

export async function onRequestGet(context) {
  return handle(context)
}
export async function onRequestPost(context) {
  return handle(context)
}

async function handle(context) {
  const { request, env } = context
  const url = new URL(request.url)

  let q = url.searchParams.get("q") || ""
  let key = url.searchParams.get("key") || request.headers.get("x-pulld-key") || ""
  let topK = Math.min(20, Math.max(1, Number(url.searchParams.get("limit") || 8)))

  if (request.method === "POST") {
    try {
      const b = await request.json()
      if (typeof b?.q === "string") q = b.q
      if (typeof b?.key === "string") key = b.key
      if (b?.limit) topK = Math.min(20, Math.max(1, Number(b.limit)))
    } catch {
      /* ignore */
    }
  }

  const project = await projectByKey(env, "query_key", key)
  if (!project) return json({ error: "unauthorized" }, 401)

  // Burst limit per project+IP, before consuming the monthly quota or doing any embed/query work,
  // so a flood from one client can't drain the customer's quota or run up cost.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0"
  if (await rateLimited(env, `${project.id}:${ip}`)) {
    return json(
      { error: "rate_limited", message: "Too many requests; slow down." },
      429,
      { "retry-after": "10" }
    )
  }

  if (!env.VEC || !env.AI) return json({ error: "search not configured" }, 503)
  if (!q.trim()) return json({ results: [] })

  const used = await bumpUsage(env, project.id, "queries", 1)
  if (used > (project.q_limit ?? 1000)) {
    return json({ error: "quota_exceeded", message: "Monthly query limit reached." }, 429)
  }

  let vector
  try {
    const out = await embed(env, [q])
    vector = out[0]
  } catch (e) {
    console.error("query embed failed:", e?.message || e)
    return json({ error: "embedding failed" }, 502)
  }
  if (!vector) return json({ results: [] })

  let res
  try {
    res = await env.VEC.query(vector, {
      topK: topK * 3, // over-fetch chunks, then dedup to docs
      namespace: project.id,
      returnMetadata: "all",
    })
  } catch (e) {
    console.error("query vectorize failed:", e?.message || e)
    return json({ error: "search failed" }, 502)
  }

  const seen = new Set()
  const results = []
  for (const m of res?.matches ?? []) {
    const md = m.metadata || {}
    if (!md.docId || seen.has(md.docId)) continue
    seen.add(md.docId)
    results.push({
      id: md.docId,
      label: md.title || md.docId,
      url: md.url || "",
      snippet: md.text || "",
      score: m.score,
    })
    if (results.length >= topK) break
  }
  return json({ results })
}
