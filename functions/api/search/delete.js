// POST /api/search/delete — remove documents from a project's index (admin_key required).
// Server-to-server only: admin_key is a secret write key, so no CORS is offered.
// Body: { ids: ["doc-1", "doc-2"] } — the document ids to remove. Each doc was indexed as at most
// MAX_CHUNKS_PER_DOC vectors (`<project>:<id>:<0..n>`), so we delete that whole id range; deleting
// ids that don't exist is a harmless no-op, and naming the same id twice in one request is the one
// document it removes. The `<project>` prefix is the authenticated project, so a caller can only
// delete its own documents.
import { json, projectByKey, MAX_CHUNKS_PER_DOC, vecId } from "./_lib.js"

const MAX_IDS_PER_REQUEST = 100
const DELETE_BATCH = 1000 // vector ids per deleteByIds call
const j = (data, status = 200) => json(data, status, { cors: false })

export async function onRequestPost(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const key =
    request.headers.get("x-pulld-admin-key") || url.searchParams.get("admin_key") || ""

  const project = await projectByKey(env, "admin_key", key)
  if (!project) return j({ error: "unauthorized" }, 401)
  if (!env.VEC) return j({ error: "search not configured" }, 503)

  let body
  try {
    body = await request.json()
  } catch {
    return j({ error: "bad json" }, 400)
  }
  const ids = Array.isArray(body?.ids) ? body.ids : []
  if (!ids.length) return j({ error: "no ids" }, 400)
  if (ids.length > MAX_IDS_PER_REQUEST)
    return j({ error: `max ${MAX_IDS_PER_REQUEST} ids per request` }, 400)

  // Distinct ids, the way ingest counts them. The same id twice in one request names one document —
  // ingest.js already settled that (`indexedIds` is a Set there, pinned by
  // test/ingest-count.test.mjs) because the number it returns is charged against the monthly doc
  // quota. Nothing is charged here, so the rule only ever reached one side of the sync loop: this
  // endpoint counted entries, and `["refunds","refunds"]` answered `deleted_docs: 2` for the single
  // document it removed. That count is the whole receipt a delete gives, and the two endpoints a
  // customer syncs with disagreed about what one document is inside one request.
  //
  // The repeat also went out on the wire — MAX_CHUNKS_PER_DOC ids re-sent per repeated id, in the
  // same call that had already deleted them.
  const seen = new Set()
  const vectorIds = []
  for (const raw of ids) {
    const id = String(raw ?? "").slice(0, 200)
    if (!id || seen.has(id)) continue
    seen.add(id)
    for (let ci = 0; ci < MAX_CHUNKS_PER_DOC; ci++) {
      vectorIds.push(vecId(project.id, id, ci))
    }
  }
  if (!vectorIds.length) return j({ error: "no valid ids" }, 400)

  try {
    for (let i = 0; i < vectorIds.length; i += DELETE_BATCH) {
      await env.VEC.deleteByIds(vectorIds.slice(i, i + DELETE_BATCH))
    }
  } catch (e) {
    console.error("delete failed:", e?.message || e)
    return j({ error: "delete failed" }, 502)
  }

  return j({ ok: true, deleted_docs: seen.size })
}
