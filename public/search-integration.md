# pulld Search — integration guide

Hosted semantic (meaning-based) search for your app. You index your content; queries match by
meaning and return ranked results — no vector database or embedding pipeline to run.

This guide is written so an AI coding agent can wire pulld Search end to end. Follow it in order.

## 1. Get your keys

After subscribing, exchange your Lemon Squeezy license key for your project keys at
<https://pulld.pages.dev/account> (or `GET https://pulld.pages.dev/api/search/account?license=<LS_LICENSE_KEY>`).

You get two keys:

- `query_key` (starts `pk_`) — **public**, read-only, safe in client code. Used to **search**.
- `admin_key` (starts `ak_`) — **secret**, server-side only. Used to **index** (ingest). Never ship it to the browser or commit it.

## 2. Wire search into the UI

With pulld's command-palette component, one line:

```tsx
import { CommandPalette, pulldSearchSource } from "@/components/ui/command-palette"

;<CommandPalette source={pulldSearchSource({ queryKey: "pk_your_public_key" })} />
```

Or call the query endpoint directly from any UI:

```
GET https://pulld.pages.dev/api/search/query?key=<query_key>&q=<text>&limit=8
→ { "results": [ { "id", "label", "url", "snippet", "score" } ] }
```

Public and CORS-enabled. Rate-limited to 120 requests / 60s per IP.

## 3. Index your content (ingest)

Search only returns what you have indexed. Send your content — docs, help articles, products, FAQ —
to the ingest endpoint. Server-to-server only (uses the secret `admin_key`).

```
POST https://pulld.pages.dev/api/search/ingest
Headers: x-pulld-admin-key: <admin_key>
         content-type: application/json
Body:    { "documents": [ { "id", "title", "url", "content" } ] }
→ { "ok": true, "indexed_docs": N, "indexed_chunks": M, "docs_this_month": K }
```

Rules:

- Up to **100 documents per request** (each doc is chunked: ≤20 chunks/doc, ≤400 chunks/request).
- `id` is your stable key. **Re-sending the same `id` overwrites** that document — that is how you update it.
- `url` is where a result points (the command palette navigates there on select).
- `content` is the text searched over; `title` becomes the result label.

Example:

```bash
curl -X POST https://pulld.pages.dev/api/search/ingest \
  -H "x-pulld-admin-key: ak_your_secret_key" \
  -H "content-type: application/json" \
  -d '{"documents":[{"id":"refunds","title":"Refund policy","url":"/docs/refunds","content":"You can request a refund within 30 days of purchase..."}]}'
```

### Remove documents

To remove documents (e.g. content was deleted or unpublished), POST their ids to the delete
endpoint. Server-to-server, same `admin_key`.

```
POST https://pulld.pages.dev/api/search/delete
Headers: x-pulld-admin-key: <admin_key>
         content-type: application/json
Body:    { "ids": ["refunds", "old-article"] }
→ { "ok": true, "deleted_docs": 2 }
```

Up to 100 ids per request. Deleting an id that doesn't exist is a harmless no-op.

## 4. Keep the index in sync

pulld does **not** crawl your site — you push content. Pick whichever fits your stack:

**A. Build-time (simplest).** Add a script to your build/deploy that reads your content and POSTs it.
It re-runs on every deploy, so the index tracks your latest content.

```ts
// scripts/index-content.ts — run in CI/build. PULLD_ADMIN_KEY is a server-side secret.
const docs = await loadAllDocs() // your markdown / CMS / DB → [{ id, title, url, content }]
for (let i = 0; i < docs.length; i += 100) {
  await fetch("https://pulld.pages.dev/api/search/ingest", {
    method: "POST",
    headers: {
      "x-pulld-admin-key": process.env.PULLD_ADMIN_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ documents: docs.slice(i, i + 100) }),
  })
}
```

**B. On-change (freshest).** In your CMS's publish/update webhook, POST just the changed document(s)
with the same `id` to overwrite.

**C. Manual.** Run the build-time script by hand whenever content changes.

Keep `admin_key` as a server-side secret (e.g. `PULLD_ADMIN_KEY`) — never in client code or git.

## Notes & limits

- Pro plan: 50,000 queries/month, 5,000 indexed docs.
- Multilingual (English, Japanese, and more) for both content and queries.
- Indexing and deletion are asynchronous — a freshly ingested or removed document can take a few
  seconds to take effect in search results.
- Update a document by re-indexing it with the same `id`; remove it with the delete endpoint above.
