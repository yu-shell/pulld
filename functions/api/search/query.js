// GET/POST /api/search/query?key=&q= — semantic search for a project (public query_key).
// This is what the command-palette `source` calls. Returns items shaped for the palette.
import { json, cors, embed, projectByKey, bumpUsage, rateLimited } from "./_lib.js"

// Clamp a requested result count to [1,20]. Falls back to `dflt` for missing, empty, or
// non-numeric input — Number("abc") is NaN, which Math.min/max would propagate into topK and
// poison both the Vectorize query (topK*3) and the `results.length >= topK` dedup guard.
//
// The result is floored to a whole number for the same reason it is clamped: it is spent as a
// Vectorize `topK`, which is a count of rows and not a measurement. `?limit=2.5` survived the
// clamp intact, was over-fetched to 7.5, and Vectorize rejected the fractional count — a 502 on
// the public endpoint from one stray decimal point. Number() accepts far more shapes than the
// integers this parameter documents ("2.5", "1e1", " 4 "), so the narrowing belongs here rather
// than at each call site.
export const clampLimit = (raw, dflt) => {
  if (raw === null || raw === undefined || raw === "") return dflt
  const n = Number(raw)
  return Number.isFinite(n) ? Math.floor(Math.min(20, Math.max(1, n))) : dflt
}

// Vectorize returns at most 50 matches per query when the matches carry their metadata, and 100
// when they do not (Vectorize platform limits). This query asks for `returnMetadata: "all"` —
// the title, url and snippet each result is built from — so 50 is the ceiling that applies, and
// asking for more is an error, not a silently truncated list.
export const VEC_TOPK_MAX = 50

// Chunks are over-fetched and then deduped down to one row per document, because a single
// document can occupy several neighbouring chunks and would otherwise fill the whole result list
// by itself. 3x is that headroom — but it is headroom, not a requirement, and it was being
// applied without regard to the ceiling above: `limit=17` asked Vectorize for 51 and got back a
// 502 "search failed", as did every larger limit up to the documented maximum of 20. So the
// endpoint advertised a range whose top fifth could not answer at all, and the failure named
// neither the cap nor the parameter that crossed it.
//
// Clamping here keeps the public contract (limit up to 20) and spends the deepest over-fetch
// Vectorize will serve: at limit=20 that is 50 chunks deduped to 20 documents — 2.5x headroom
// instead of 3x. Fewer duplicate chunks in the pool is a thinner result list in the worst case;
// it is not a failed request.
export const overFetch = (topK) => Math.min(VEC_TOPK_MAX, topK * 3)

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
  let topK = clampLimit(url.searchParams.get("limit"), 8)

  if (request.method === "POST") {
    try {
      const b = await request.json()
      if (typeof b?.q === "string") q = b.q
      if (typeof b?.key === "string") key = b.key
      if (b?.limit) topK = clampLimit(b.limit, topK)
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
      topK: overFetch(topK), // over-fetch chunks (capped at Vectorize's max), then dedup to docs
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
