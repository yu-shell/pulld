#!/usr/bin/env node
// Generate the landing page (public/index.html) from registry.json so it stays in sync as
// components are added. Static, dependency-free, self-contained HTML (inline CSS / minimal JS).
// SITE_BASE overrides the install URL.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")
const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
const items = reg.items ?? []

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

const cards = items
  .map((it) => {
    const cmd = `npx shadcn@latest add ${BASE}/r/${it.name}.json`
    const composes =
      Array.isArray(it.registryDependencies) && it.registryDependencies.length
        ? `<span class="dep">composes ${it.registryDependencies.map(esc).join(", ")}</span>`
        : ""
    return `      <article class="card">
        <div class="card-head">
          <h3>${esc(it.title || it.name)}</h3>
          ${composes}
        </div>
        <p>${esc(it.description || "")}</p>
        <div class="cmd">
          <code>${esc(cmd)}</code>
          <button type="button" class="copy" data-cmd="${esc(cmd)}" aria-label="Copy install command">copy</button>
        </div>
      </article>`
  })
  .join("\n")

const first = items[0]?.name || "copy-button"
const heroCmd = `npx shadcn@latest add ${BASE}/r/${first}.json`
const nsConfig = `{ "registries": { "@pulld": "${BASE}/r/{name}.json" } }`

const PRO_PRICE = process.env.PRO_PRICE || "$39"
const PRO_CHECKOUT =
  process.env.PRO_CHECKOUT ||
  "https://pulld.lemonsqueezy.com/checkout/buy/47c36d39-1b45-4b70-bf87-07aefe1bf8e8"
let proSection = ""
const proRegPath = join(ROOT, "pro", "registry.json")
if (existsSync(proRegPath)) {
  const proItems = JSON.parse(readFileSync(proRegPath, "utf8")).items ?? []
  if (proItems.length) {
    const proCards = proItems
      .map((it) => {
        const cmd = `npx shadcn@latest add "${BASE}/r/pro/${it.name}.json?key=YOUR_KEY"`
        const deps =
          Array.isArray(it.registryDependencies) && it.registryDependencies.length
            ? `<span class="dep">composes ${it.registryDependencies.map(esc).join(", ")}</span>`
            : ""
        return `      <article class="card pro">
        <div class="card-head">
          <h3>${esc(it.title || it.name)} <span class="badge">PRO</span></h3>
          ${deps}
        </div>
        <p>${esc(it.description || "")}</p>
        <div class="cmd"><code>${esc(cmd)}</code></div>
        <a class="buy" href="${esc(PRO_CHECKOUT)}">Get a license — ${esc(PRO_PRICE)} one-time</a>
      </article>`
      })
      .join("\n")
    proSection = `
    <h2>Pro blocks</h2>
    <p class="lede" style="font-size:15px;margin-bottom:16px">Composed, opinionated blocks built from the free atoms — a license unlocks install. One-time, ${esc(PRO_PRICE)}.</p>
    <div class="grid">
${proCards}
    </div>
`
  }
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>pulld — components your AI coding agent installs by itself</title>
<meta name="description" content="An open shadcn-compatible component registry. Point any AI coding agent (Claude Code, Cursor, v0) at a component and it pulls it in." />
<style>
  :root{
    --bg:#fbfbfa; --surface:#ffffff; --ink:#1a1a1a; --muted:#6b6b6b;
    --line:#e7e7e4; --accent:#6d5efc; --code-bg:#f4f4f2;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0f0f11; --surface:#17171a; --ink:#ececef; --muted:#9a9aa2;
      --line:#27272c; --accent:#8b7dff; --code-bg:#1e1e22; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:760px;margin:0 auto;padding:64px 24px 96px}
  .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px;letter-spacing:-.02em}
  .dot{width:12px;height:12px;border-radius:3px;background:var(--accent)}
  h1{font-size:34px;line-height:1.15;letter-spacing:-.03em;margin:40px 0 12px}
  .lede{color:var(--muted);font-size:18px;margin:0 0 28px;max-width:60ch}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px}
  .hero-cmd{display:flex;align-items:center;gap:8px;background:var(--code-bg);
    border:1px solid var(--line);border-radius:10px;padding:12px 14px;overflow:auto}
  .hero-cmd code{white-space:nowrap}
  .note{color:var(--muted);font-size:14px;margin:14px 0 0}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
    margin:56px 0 16px;font-weight:600}
  .grid{display:grid;gap:14px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
  .card-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
  .card h3{margin:0;font-size:17px;letter-spacing:-.01em}
  .dep{color:var(--accent);font-size:12px;font-weight:500;white-space:nowrap}
  .card p{color:var(--muted);font-size:14.5px;margin:8px 0 14px}
  .cmd{display:flex;align-items:center;gap:8px;background:var(--code-bg);
    border:1px solid var(--line);border-radius:9px;padding:8px 10px;overflow:auto}
  .cmd code{white-space:nowrap;flex:1}
  .copy{flex:none;border:1px solid var(--line);background:transparent;color:var(--muted);
    border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer}
  .copy:hover{color:var(--ink);border-color:var(--accent)}
  .card.pro{border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}
  .badge{display:inline-block;vertical-align:middle;background:var(--accent);color:#fff;
    font-size:10px;font-weight:700;letter-spacing:.06em;border-radius:5px;padding:2px 6px;margin-left:6px}
  .buy{display:inline-block;margin-top:12px;background:var(--accent);color:#fff;text-decoration:none;
    font-size:13.5px;font-weight:500;border-radius:8px;padding:8px 14px}
  .buy:hover{filter:brightness(1.08)}
  footer{margin-top:64px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:20px}
  a{color:var(--accent)}
</style>
</head>
<body>
  <main class="wrap">
    <div class="brand"><span class="dot" aria-hidden="true"></span> pulld</div>
    <h1>Components your AI coding agent installs by itself.</h1>
    <p class="lede">An open, shadcn-compatible component registry. Point Claude Code, Cursor, or v0 at a component and it pulls it straight into your project — typed, accessible, theme-aware.</p>
    <div class="hero-cmd">
      <code>${esc(heroCmd)}</code>
      <button type="button" class="copy" data-cmd="${esc(heroCmd)}" aria-label="Copy install command">copy</button>
    </div>
    <p class="note">Works with the shadcn CLI &amp; MCP. ${items.length} free components, growing.</p>
    <p class="note" style="margin-top:18px">Or add the <code>@pulld</code> namespace once in <code>components.json</code>, then install by name (<code>@pulld/${esc(first)}</code>):</p>
    <div class="hero-cmd" style="margin-top:8px">
      <code>${esc(nsConfig)}</code>
      <button type="button" class="copy" data-cmd="${esc(nsConfig)}" aria-label="Copy registry config">copy</button>
    </div>

    <h2>Components</h2>
    <div class="grid">
${cards}
    </div>
${proSection}
    <footer>
      MIT-licensed · every component is type-checked, built, and verified before it ships.
    </footer>
  </main>
  <script>
    document.querySelectorAll(".copy").forEach(function(b){
      b.addEventListener("click", function(){
        navigator.clipboard.writeText(b.getAttribute("data-cmd")).then(function(){
          var t=b.textContent; b.textContent="copied"; setTimeout(function(){b.textContent=t},1200);
        }).catch(function(){});
      });
    });
  </script>
</body>
</html>
`

writeFileSync(join(ROOT, "public", "index.html"), html)
console.log(`OK\tpublic/index.html generated: ${items.length} components (base ${BASE})`)
