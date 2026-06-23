// Shared helpers for pulld Search (semantic search). Underscore prefix = not routed.

const EMBED_MODEL = "@cf/baai/bge-m3" // multilingual, 1024-dim, cheap

export function json(data, status = 200, opts = {}) {
  const { cors = true, ...extra } = opts
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extra,
  }
  // CORS only for the public query endpoint; ingest is server-to-server (secret admin key).
  if (cors) headers["access-control-allow-origin"] = "*"
  return new Response(JSON.stringify(data), { status, headers })
}

export function cors() {
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,x-pulld-key,x-pulld-admin-key",
      "access-control-max-age": "86400",
    },
  })
}

// Embed texts in batches (Workers AI caps batch size).
export async function embed(env, texts, batch = 50) {
  const out = []
  for (let i = 0; i < texts.length; i += batch) {
    const part = texts.slice(i, i + batch)
    const res = await env.AI.run(EMBED_MODEL, { text: part })
    const data = res?.data ?? []
    out.push(...data)
  }
  return out
}

// Naive length-based chunking with overlap.
export function chunk(text, size = 900, overlap = 150) {
  const clean = String(text || "").replace(/\s+/g, " ").trim()
  if (!clean) return []
  const out = []
  const step = Math.max(1, size - overlap)
  for (let i = 0; i < clean.length; i += step) {
    out.push(clean.slice(i, i + size))
    if (i + size >= clean.length) break
  }
  return out
}

const KEY_FIELDS = new Set(["admin_key", "query_key"])

export async function projectByKey(env, field, key) {
  if (!key || !KEY_FIELDS.has(field) || !env.DB) return null
  try {
    return await env.DB.prepare(
      `SELECT * FROM search_projects WHERE ${field} = ? AND active = 1`
    )
      .bind(key)
      .first()
  } catch {
    return null
  }
}

export function monthKey() {
  return new Date().toISOString().slice(0, 7) // YYYY-MM
}

const COUNTERS = new Set(["queries", "docs"])

// Increment a usage counter for this month and return the new total.
export async function bumpUsage(env, project, counter, by = 1) {
  if (!COUNTERS.has(counter) || !env.DB) return 0
  const m = monthKey()
  try {
    await env.DB.prepare(
      `INSERT INTO search_usage (project, month, ${counter}) VALUES (?, ?, ?) ` +
        `ON CONFLICT(project, month) DO UPDATE SET ${counter} = ${counter} + ?`
    )
      .bind(project, m, by, by)
      .run()
    const row = await env.DB.prepare(
      `SELECT ${counter} AS n FROM search_usage WHERE project = ? AND month = ?`
    )
      .bind(project, m)
      .first()
    return row?.n ?? 0
  } catch {
    return 0
  }
}
