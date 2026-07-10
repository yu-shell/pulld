// POST /api/search/delete — remove documents from a project's index (admin_key required).
// Server-to-server only: admin_key is a secret write key, so no CORS is offered.
// Body: { ids: ["doc-1", "doc-2"] } — the document ids to remove. Each doc was indexed as at most
// MAX_CHUNKS_PER_DOC vectors (`<project>:<id>:<0..n>`), so we delete that whole id range; deleting
// ids that don't exist is a harmless no-op. The `<project>` prefix is the authenticated project,
// so a caller can only delete its own documents.
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

  const vectorIds = []
  let docs = 0
  for (const raw of ids) {
    const id = String(raw ?? "").slice(0, 200)
    if (!id) continue
    docs++
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

  return j({ ok: true, deleted_docs: docs })
}
