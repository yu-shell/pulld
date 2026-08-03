// POST /api/search/ingest — index documents for a project (admin_key required).
// Server-to-server only: admin_key is a secret write key, so no CORS is offered.
// Body: { documents: [{ id, title, url, content }] }. Chunks + embeds + upserts to Vectorize
// under the project's namespace.
import {
  json,
  embed,
  chunk,
  projectByKey,
  bumpUsage,
  usageThisMonth,
  MAX_CHUNKS_PER_DOC,
  vecId,
} from "./_lib.js"

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
  // What the request actually indexed, versus what it silently dropped. Not every entry in
  // `documents` becomes a document: one with no `id`, or with no text in title+content, produces no
  // chunks and is never written. Counting those charges the customer's monthly `docs` usage — which
  // usage-alert.mjs turns into a doc-quota alert — for content that isn't there, and reports them
  // back as indexed, so a caller with a broken field mapping sees `ok` and a full count while
  // search stays empty. Distinct ids: the same id twice in one request is the one document it
  // overwrites into.
  const indexedIds = new Set()
  let skipped = 0
  for (const d of docs) {
    const id = String(d?.id ?? "").slice(0, 200)
    if (!id) {
      skipped++
      continue
    }
    const parts = chunk(`${d.title ?? ""}\n${d.content ?? ""}`).slice(0, MAX_CHUNKS_PER_DOC)
    // A doc can shrink on re-index. Upserting only overwrites chunks 0..N-1; any higher-index
    // chunks from a previous, longer version would survive and keep matching queries —
    // contradicting the documented "re-sending the same id overwrites that document". Mark the
    // now-unused tail (N..MAX_CHUNKS_PER_DOC-1) for deletion. Skip empty docs (0 chunks): removing
    // a document is the delete endpoint's job, not a silent side effect of empty-content ingest.
    if (parts.length > 0) {
      indexedIds.add(id)
      for (let ci = parts.length; ci < MAX_CHUNKS_PER_DOC; ci++) {
        staleIds.push(vecId(project.id, id, ci))
      }
    } else {
      skipped++
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
        vid: vecId(project.id, id, ci),
        docId: id,
        title: String(d.title ?? id).slice(0, 200),
        url: String(d.url ?? "").slice(0, 500),
        text: parts[ci].slice(0, 400),
      })
    }
  }
  if (!texts.length) return j({ error: "nothing to index" }, 400)

  // Enforce the plan's monthly document quota, mirroring the query quota in query.js. It was
  // already defined (search_projects.doc_limit), metered (the `docs` bump below) and reported on
  // (usage-alert.mjs alerts at 80% of it; public/search-integration.md sells "5,000 indexed docs")
  // — but nothing refused a request over it, so indexing was effectively unlimited and the alert
  // had no backstop. Checked after parsing and before embed/upsert, because those are the Workers
  // AI and Vectorize costs the quota exists to bound; a query is one cheap unit, so query.js can
  // afford to bump first and compare afterwards. Only the documents that will actually be indexed
  // count, matching what the meter charges. An absent limit falls back to the schema default the
  // same way q_limit does; a non-numeric one fails open, since blocking a paying customer over a
  // bad column value is the worse failure.
  const docLimit = Number(project.doc_limit ?? 200)
  if (Number.isFinite(docLimit)) {
    const already = await usageThisMonth(env, project.id, "docs")
    if (already + indexedIds.size > docLimit) {
      return j(
        {
          error: "quota_exceeded",
          message: `Monthly document limit reached (${already}/${docLimit} indexed this month).`,
          docs_this_month: already,
          doc_limit: docLimit,
        },
        429
      )
    }
  }

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

  const docsThisMonth = await bumpUsage(env, project.id, "docs", indexedIds.size)
  return j({
    ok: true,
    indexed_docs: indexedIds.size,
    skipped_docs: skipped,
    indexed_chunks: vectors.length,
    docs_this_month: docsThisMonth,
  })
}
