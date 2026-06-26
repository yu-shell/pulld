// POST /api/search/ingest — index documents for a project (admin_key required).
// Server-to-server only: admin_key is a secret write key, so no CORS is offered.
// Body: { documents: [{ id, title, url, content }] }. Chunks + embeds + upserts to Vectorize
// under the project's namespace.
import { json, embed, chunk, projectByKey, bumpUsage, MAX_CHUNKS_PER_DOC } from "./_lib.js"

const MAX_CHUNKS_PER_REQUEST = 400
const PRUNE_BATCH = 1000 // vector ids per deleteByIds call (mirrors delete.js)
const j = (data, status = 200) => json(data, status, { cors: false })

export async function onRequestPost(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const key =
    request.headers.get("x-pulld-admin-key") || url.searchParams.get("admin_key") || ""

  const project = await projectByKey(env, "admin_key", key)
  if (!project) return j({ error: "unauthorized" }, 401)
  if (!env.VEC || !env.AI) return j({ error: "search not configured" }, 503)

  let body
  try {
    body = await request.json()
  } catch {
    return j({ error: "bad json" }, 400)
  }
  const docs = Array.isArray(body?.documents) ? body.documents : []
  if (!docs.length) return j({ error: "no documents" }, 400)
  if (docs.length > 100) return j({ error: "max 100 documents per request" }, 400)

  const texts = []
  const meta = []
  // Tail chunk ids to prune after upserting (see below): when a doc is re-indexed with fewer
  // chunks than a previous version, the higher-index chunks would otherwise linger.
  const staleIds = []
  for (const d of docs) {
    const id = String(d?.id ?? "").slice(0, 200)
    if (!id) continue
    const parts = chunk(`${d.title ?? ""}\n${d.content ?? ""}`).slice(0, MAX_CHUNKS_PER_DOC)
    // A doc can shrink on re-index. Upserting only overwrites chunks 0..N-1; any higher-index
    // chunks from a previous, longer version would survive and keep matching queries —
    // contradicting the documented "re-sending the same id overwrites that document". Mark the
    // now-unused tail (N..MAX_CHUNKS_PER_DOC-1) for deletion. Skip empty docs (0 chunks): removing
    // a document is the delete endpoint's job, not a silent side effect of empty-content ingest.
    if (parts.length > 0) {
      for (let ci = parts.length; ci < MAX_CHUNKS_PER_DOC; ci++) {
        staleIds.push(`${project.id}:${id}:${ci}`)
      }
    }
    for (let ci = 0; ci < parts.length; ci++) {
      if (texts.length >= MAX_CHUNKS_PER_REQUEST) {
        return j(
          {
            error: "too_many_chunks",
            message: `Content too large; split into more documents (max ${MAX_CHUNKS_PER_REQUEST} chunks/request, ${MAX_CHUNKS_PER_DOC} chunks/doc).`,
          },
          413
        )
      }
      texts.push(parts[ci])
      meta.push({
        vid: `${project.id}:${id}:${ci}`,
        docId: id,
        title: String(d.title ?? id).slice(0, 200),
        url: String(d.url ?? "").slice(0, 500),
        text: parts[ci].slice(0, 400),
      })
    }
  }
  if (!texts.length) return j({ error: "nothing to index" }, 400)

  let embeddings
  try {
    embeddings = await embed(env, texts)
  } catch (e) {
    console.error("ingest embed failed:", e?.message || e)
    return j({ error: "embedding failed" }, 502)
  }
  if (embeddings.length !== texts.length) {
    return j({ error: "embedding count mismatch" }, 502)
  }

  const vectors = embeddings.map((values, i) => ({
    id: meta[i].vid,
    values,
    namespace: project.id,
    metadata: {
      docId: meta[i].docId,
      title: meta[i].title,
      url: meta[i].url,
      text: meta[i].text,
    },
  }))

  try {
    await env.VEC.upsert(vectors)
  } catch (e) {
    console.error("ingest upsert failed:", e?.message || e)
    return j({ error: "upsert failed" }, 502)
  }

  // Prune orphaned tail chunks left by previous, longer versions of these docs. Never delete a
  // vector we just wrote — guards against the same id appearing twice in one request. Best-effort:
  // the new content is already indexed, so a prune hiccup degrades to a few stale chunks (which the
  // next re-index or an explicit delete clears), not a failed update.
  const upserted = new Set(vectors.map((v) => v.id))
  const toPrune = staleIds.filter((vid) => !upserted.has(vid))
  if (toPrune.length) {
    try {
      for (let i = 0; i < toPrune.length; i += PRUNE_BATCH) {
        await env.VEC.deleteByIds(toPrune.slice(i, i + PRUNE_BATCH))
      }
    } catch (e) {
      console.error("ingest prune failed:", e?.message || e)
    }
  }

  const docsThisMonth = await bumpUsage(env, project.id, "docs", docs.length)
  return j({
    ok: true,
    indexed_docs: docs.length,
    indexed_chunks: vectors.length,
    docs_this_month: docsThisMonth,
  })
}
