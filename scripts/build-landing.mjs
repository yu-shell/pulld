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

// Tiny static visual approximations of each component, shown as a square sample on its card.
// This page is for humans, so a quick "this is roughly what it looks like" preview makes it
// livelier. Hand-authored mock-ups (not the real React components), styled with the page tokens.
const ICON = {
  copy: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  eye: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  sun: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  inbox: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.5A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.5Z"/></svg>`,
  box: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 21V9"/></svg>`,
}
const PREVIEWS = {
  "copy-button": `<button class="pv-iconbtn">${ICON.copy}</button>`,
  kbd: `<span class="pv-kbd">⌘</span><span class="pv-kbd">K</span>`,
  "empty-state": `<div class="pv-empty">${ICON.inbox}<span>No results</span></div>`,
  "stat-card": `<div class="pv-card"><div class="pv-muted">Revenue</div><div style="display:flex;align-items:baseline;gap:5px;margin-top:2px"><span class="pv-big">$12.4k</span><span class="pv-up">↑12%</span></div></div>`,
  "theme-toggle": `<button class="pv-iconbtn">${ICON.sun}</button>`,
  "avatar-stack": `<div class="pv-avs"><span class="pv-av">A</span><span class="pv-av" style="background:#e0567f">M</span><span class="pv-av" style="background:#2bb673">K</span><span class="pv-av pv-more">+3</span></div>`,
  "password-input": `<div class="pv-input"><span class="pv-dots">••••••</span><span style="margin-left:auto;color:var(--muted);display:inline-flex">${ICON.eye}</span></div>`,
  spinner: `<span class="pv-spin" aria-hidden="true"></span>`,
  "code-block": `<div class="pv-code">add …<span class="pv-codecopy">${ICON.copy}</span></div>`,
  "loading-button": `<button class="pv-btn pv-primary"><span class="pv-spin pv-spin-on-primary"></span> Saving…</button>`,
  "confirm-button": `<button class="pv-btn pv-danger">Delete</button>`,
  "dashboard-overview": `<div class="pv-dash"><div class="pv-dbar"></div><div class="pv-drow"><span></span><span></span><span></span></div></div>`,
}
const preview = (name) =>
  `<div class="preview">${PREVIEWS[name] || `<span class="pv-ph">${ICON.box}</span>`}</div>`

const cards = items
  .map((it) => {
    const cmd = `npx shadcn@latest add ${BASE}/r/${it.name}.json`
    const composes =
      Array.isArray(it.registryDependencies) && it.registryDependencies.length
        ? `<span class="dep">composes ${it.registryDependencies.map(esc).join(", ")}</span>`
        : ""
    return `      <article class="card">
        ${preview(it.name)}
        <div class="card-body">
          <div class="card-head">
            <h3>${esc(it.title || it.name)}</h3>
            ${composes}
          </div>
          <p>${esc(it.description || "")}</p>
          <div class="cmd">
            <code>${esc(cmd)}</code>
            <button type="button" class="copy" data-cmd="${esc(cmd)}" aria-label="Copy install command">copy</button>
          </div>
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
        ${preview(it.name)}
        <div class="card-body">
          <div class="card-head">
            <h3>${esc(it.title || it.name)} <span class="badge">PRO</span></h3>
            ${deps}
          </div>
          <p>${esc(it.description || "")}</p>
          <div class="cmd"><code>${esc(cmd)}</code></div>
          <a class="buy" href="${esc(PRO_CHECKOUT)}">Get a license — ${esc(PRO_PRICE)} one-time</a>
        </div>
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
  .card{display:flex;gap:16px;align-items:center;background:var(--surface);
    border:1px solid var(--line);border-radius:14px;padding:16px}
  .card-body{flex:1;min-width:0}
  .card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .card h3{margin:0;font-size:17px;letter-spacing:-.01em}
  .dep{color:var(--accent);font-size:12px;font-weight:500;white-space:nowrap}
  .card p{color:var(--muted);font-size:14.5px;margin:6px 0 12px}
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
  .preview{flex:none;width:104px;height:104px;display:flex;align-items:center;justify-content:center;
    gap:6px;flex-wrap:wrap;background:var(--bg);border:1px solid var(--line);border-radius:10px;
    padding:10px;overflow:hidden}
  .pv-ph{color:var(--muted);opacity:.55}
  .pv-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;
    border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--muted)}
  .pv-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:8px;
    border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:12.5px;font-weight:500}
  .pv-primary{background:var(--accent);color:#fff;border-color:transparent}
  .pv-danger{color:#dc2626;border-color:#dc2626}
  .pv-kbd{display:inline-flex;align-items:center;height:24px;padding:0 8px;border-radius:6px;
    border:1px solid var(--line);border-bottom-width:2px;background:var(--surface);font:12px ui-monospace,monospace;color:var(--muted)}
  .pv-spin{width:20px;height:20px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;
    display:inline-block;animation:pvspin .7s linear infinite}
  .pv-spin-on-primary{width:13px;height:13px;border-color:rgba(255,255,255,.45);border-top-color:#fff}
  @keyframes pvspin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){ .pv-spin{animation:none} }
  .pv-card{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:8px 10px}
  .pv-muted{color:var(--muted);font-size:10.5px}
  .pv-big{font-size:16px;font-weight:600;color:var(--ink);line-height:1.2}
  .pv-up{color:#16a34a;font-size:10.5px;font-weight:600}
  .pv-avs{display:flex}
  .pv-av{width:26px;height:26px;border-radius:50%;border:2px solid var(--surface);background:var(--accent);
    color:#fff;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;margin-left:-9px}
  .pv-av:first-child{margin-left:0}
  .pv-more{background:var(--line);color:var(--muted)}
  .pv-input{display:flex;align-items:center;gap:6px;height:30px;padding:0 9px;border-radius:8px;
    border:1px solid var(--line);background:var(--surface);width:100%}
  .pv-dots{letter-spacing:2px;color:var(--ink);font-size:13px}
  .pv-empty{display:flex;flex-direction:column;align-items:center;gap:4px;color:var(--muted);font-size:11px;
    border:1px dashed var(--line);border-radius:8px;padding:8px 12px}
  .pv-code{position:relative;font:11px ui-monospace,monospace;color:var(--ink);background:var(--surface);
    border:1px solid var(--line);border-radius:8px;padding:8px 26px 8px 9px}
  .pv-codecopy{position:absolute;top:6px;right:7px;color:var(--muted);display:inline-flex}
  .pv-dash{display:flex;flex-direction:column;gap:6px;width:100%}
  .pv-dbar{height:14px;border-radius:4px;background:var(--surface);border:1px solid var(--line)}
  .pv-drow{display:flex;gap:5px}
  .pv-drow span{flex:1;height:30px;border-radius:5px;background:var(--surface);border:1px solid var(--line)}
  .pv-drow span:first-child{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
  @media (prefers-color-scheme:dark){ .pv-danger{color:#f87171;border-color:#f87171} .pv-up{color:#4ade80} }
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
