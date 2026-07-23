#!/usr/bin/env node
// Generate the landing page (public/index.html) from registry.json so it stays in sync as
// components are added. Static, dependency-free, self-contained HTML (inline CSS / minimal JS).
// SITE_BASE overrides the install URL.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")
// Public read-only query key for the pulld-demo project — powers the live ⌘K demo on this page
// (the page searches its own components via pulld Search). Safe to ship; rate-limited per IP.
const DEMO_QUERY_KEY = process.env.DEMO_QUERY_KEY || "pk_3852c981c083241aa2af291864e0594b"
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
  search: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  upload: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/></svg>`,
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
  "command-palette": `<div class="pv-input" style="gap:6px"><span style="color:var(--muted);display:inline-flex">${ICON.search}</span><span style="color:var(--muted);font-size:12px">Search…</span><span style="margin-left:auto;display:flex;gap:3px"><span class="pv-kbd">⌘</span><span class="pv-kbd">K</span></span></div>`,
  toast: `<div class="pv-toast"><span class="pv-tok">${ICON.check}</span><span>Changes saved</span></div>`,
  "search-input": `<div class="pv-input"><span style="color:var(--muted);display:inline-flex">${ICON.search}</span><span style="color:var(--muted);font-size:12px">Search…</span></div>`,
  "number-input": `<div class="pv-input" style="justify-content:center;gap:8px"><span class="pv-numbtn">−</span><span style="font-size:13px;color:var(--ink);min-width:14px;text-align:center">3</span><span class="pv-numbtn">+</span></div>`,
  "otp-input": `<div class="pv-otp"><span>4</span><span>2</span><span></span><span></span></div>`,
  "tag-input": `<div class="pv-input" style="height:auto;min-height:30px;flex-wrap:wrap;gap:4px;padding:6px 7px"><span class="pv-tag">react</span><span class="pv-tag">ui</span><span style="color:var(--muted);font-size:11px">|</span></div>`,
  "copy-field": `<div class="pv-input"><span style="font:11px ui-monospace,monospace;color:var(--ink)">tok_1a2b</span><span style="margin-left:auto;color:var(--muted);display:inline-flex">${ICON.copy}</span></div>`,
  "segmented-control": `<div class="pv-seg"><span class="on">Day</span><span>Week</span></div>`,
  "step-indicator": `<div class="pv-steps"><span class="d on"></span><i></i><span class="d cur">2</span><i></i><span class="d">3</span></div>`,
  rating: `<div style="font-size:19px;letter-spacing:2px"><span style="color:var(--accent)">★★★★</span><span style="color:var(--line)">★</span></div>`,
  timeline: `<div class="pv-timeline"><span class="d on"></span><span class="b" style="width:46px"></span><span class="d"></span><span class="b" style="width:30px"></span><span class="d"></span><span class="b" style="width:40px"></span></div>`,
  "announcement-bar": `<div class="pv-annc"><span>New — try it →</span><span class="x">×</span></div>`,
  "file-dropzone": `<div class="pv-empty">${ICON.upload}<span>Drop files</span></div>`,
  "progress-ring": `<svg width="54" height="54" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="none" stroke="var(--line)" stroke-width="4"/><circle cx="20" cy="20" r="16" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-dasharray="72 101" transform="rotate(-90 20 20)"/><text x="20" y="24" text-anchor="middle" font-size="11" fill="var(--ink)" font-weight="600">72%</text></svg>`,
  "pricing-card": `<div class="pv-card" style="width:96px;padding:9px 10px;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"><div style="font-size:11px;font-weight:600;color:var(--ink)">Pro</div><div style="display:flex;align-items:baseline;gap:2px;margin-top:1px"><span class="pv-big" style="font-size:15px">$29</span><span class="pv-muted">/mo</span></div><div style="display:flex;flex-direction:column;gap:3px;margin-top:7px"><span style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Unlimited</span><span style="display:flex;align-items:center;gap:4px;font-size:10px;color:var(--ink)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>Analytics</span></div></div>`,
  "feature-card": `<div class="pv-card" style="width:96px;padding:11px"><span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;background:color-mix(in srgb,var(--accent) 15%,transparent);color:var(--accent)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span><div style="font-size:11px;font-weight:600;color:var(--ink);margin-top:7px">Fast</div><div style="font-size:10px;color:var(--muted);margin-top:2px;line-height:1.3">Ships in milliseconds</div></div>`,
  "time-ago": `<span style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted)"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>3 minutes ago</span>`,
  gauge: `<div style="position:relative;width:70px;height:42px"><svg width="70" height="42" viewBox="0 0 70 40"><path d="M6 34 A29 29 0 0 1 64 34" fill="none" stroke="var(--line)" stroke-width="8" stroke-linecap="round"/><path d="M6 34 A29 29 0 0 1 64 34" fill="none" stroke="var(--accent)" stroke-width="8" stroke-linecap="round" stroke-dasharray="91.1" stroke-dashoffset="27"/></svg><span style="position:absolute;left:0;right:0;bottom:1px;text-align:center;font-size:13px;font-weight:600;color:var(--ink)">72</span></div>`,
  "multi-select": `<div class="pv-input" style="height:auto;min-height:30px;flex-wrap:wrap;gap:4px;padding:6px 7px"><span class="pv-tag">design ×</span><span class="pv-tag">eng ×</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></div>`,
  countdown: `<div style="display:flex;align-items:center;gap:5px;font-variant-numeric:tabular-nums">${["02", "14", "33"].map((n, i) => `${i ? `<span style="color:var(--muted);font-size:15px">:</span>` : ""}<span style="display:flex;flex-direction:column;align-items:center;min-width:24px;border:1px solid var(--line);border-radius:6px;padding:4px 3px;line-height:1"><span style="font-size:15px;font-weight:600;color:var(--ink)">${n}</span><span style="margin-top:3px;font-size:8px;font-weight:500;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)">${["hrs", "min", "sec"][i]}</span></span>`).join("")}</div>`,
  "inline-edit": `<div class="pv-input"><span style="font-size:12.5px;color:var(--ink)">Project name</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-left:auto;display:inline-flex" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></div>`,
  "autosize-textarea": `<div style="display:flex;flex-direction:column;gap:5px;width:96px;border:1px solid var(--line);border-radius:7px;padding:8px 9px"><span style="height:4px;width:100%;border-radius:2px;background:var(--muted);opacity:.5"></span><span style="height:4px;width:84%;border-radius:2px;background:var(--muted);opacity:.5"></span><span style="display:flex;align-items:center;gap:3px"><span style="height:4px;width:38px;border-radius:2px;background:var(--muted);opacity:.5"></span><span style="width:1px;height:9px;background:var(--accent)"></span></span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="align-self:flex-end;margin-top:1px" aria-hidden="true"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg></div>`,
  "currency-input": `<div class="pv-input" style="width:96px"><span style="font-size:13px;color:var(--ink);font-variant-numeric:tabular-nums">$1,234.50</span><span style="width:1px;height:13px;background:var(--accent);margin-left:1px"></span></div>`,
  "bulk-action-bar": `<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 9px;box-shadow:0 3px 10px rgba(0,0,0,.10)"><span style="display:flex;align-items:center;gap:5px"><span style="display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:5px;background:var(--accent);color:#fff;font-size:9px;font-weight:700">3</span><span style="font-size:10px;color:var(--ink)">selected</span></span><span style="display:flex;gap:4px"><span class="pv-btn pv-danger" style="height:17px;padding:0 6px;border-radius:5px;font-size:9px">Delete</span><span style="display:inline-flex;align-items:center;height:17px;padding:0 6px;font-size:9px;color:var(--muted)">Clear</span></span></div>`,
  "floating-label-input":`<div style="position:relative;width:96px"><div class="pv-input" style="border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"><span style="font-size:12.5px;color:var(--ink)">jane@acme.co</span><span style="width:1px;height:13px;background:var(--accent);margin-left:1px"></span></div><span style="position:absolute;top:-6px;left:8px;padding:0 4px;background:var(--bg);font-size:9px;font-weight:500;color:var(--accent)">Email</span></div>`,
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
    return `      <article class="card" id="c-${it.name}">
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
  "https://buy.polar.sh/polar_cl_h2Vmr8KMgAweYuRNExTD0QXYGOqqVFodnj1zR0fSyw4"

const SEARCH_PRICE = process.env.SEARCH_PRICE || "$19"
const SEARCH_CHECKOUT =
  process.env.SEARCH_CHECKOUT ||
  "https://buy.polar.sh/polar_cl_NUyf4PdoVJn8sIMP70hghnK0JuO8prt7kUGrh3uowc6"
const searchSection = `
    <h2>Hosted service</h2>
    <div class="grid">
      <article class="card search">
        <div class="preview"><span class="pv-search">${ICON.search}</span></div>
        <div class="card-body">
          <div class="card-head"><h3>pulld Search <span class="badge">${esc(SEARCH_PRICE)}/mo</span></h3></div>
          <p>Hosted semantic search — index your content and get typo-tolerant, meaning-based results. Drop it into the command palette's <code>source</code>; nothing to run.</p>
          <a class="buy" href="${esc(SEARCH_CHECKOUT)}">Subscribe — ${esc(SEARCH_PRICE)}/mo</a>
          <p class="note" style="margin:10px 0 0;font-size:13px">Already subscribed? <a href="${BASE}/account">Get your keys →</a></p>
        </div>
      </article>
    </div>
`
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
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
  .grid{display:grid;grid-template-columns:minmax(0,1fr);gap:14px}
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
  .pv-toast{display:flex;align-items:center;gap:7px;width:100%;background:var(--surface);border:1px solid var(--line);
    border-radius:9px;padding:8px 10px;box-shadow:0 4px 14px rgba(0,0,0,.10);font-size:11.5px;color:var(--ink)}
  .pv-tok{color:#16a34a;display:inline-flex;flex:none}
  @media (prefers-color-scheme:dark){ .pv-danger{color:#f87171;border-color:#f87171} .pv-up{color:#4ade80} .pv-tok{color:#4ade80} }
  .pv-numbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;border:1px solid var(--line);color:var(--muted);font-size:13px}
  .pv-otp{display:flex;gap:5px}
  .pv-otp span{width:18px;height:24px;border:1px solid var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;font:13px ui-monospace,monospace;color:var(--ink);background:var(--surface)}
  .pv-tag{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:5px;background:var(--accent);color:#fff;font-size:11px;font-weight:500}
  .pv-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:2px}
  .pv-seg span{font-size:11.5px;padding:3px 9px;border-radius:6px;color:var(--muted)}
  .pv-seg .on{background:var(--accent);color:#fff}
  .pv-steps{display:flex;align-items:center}
  .pv-steps .d{width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:10.5px;font-weight:600;border:1px solid var(--line);color:var(--muted);background:var(--surface)}
  .pv-steps .d.on{background:var(--accent);border-color:transparent}
  .pv-steps .d.cur{border-color:var(--accent);color:var(--accent)}
  .pv-steps i{width:12px;height:2px;background:var(--line)}
  .pv-timeline{display:grid;grid-template-columns:auto 1fr;gap:7px}
  .pv-timeline .d{width:9px;height:9px;border-radius:50%;border:2px solid var(--line);background:var(--surface)}
  .pv-timeline .d.on{background:var(--accent);border-color:var(--accent)}
  .pv-timeline .b{height:6px;border-radius:3px;background:var(--line)}
  .pv-annc{display:flex;align-items:center;gap:6px;width:100%;border-radius:8px;padding:6px 8px;font-size:11px;color:var(--ink);
    background:color-mix(in srgb,var(--accent) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line))}
  .pv-annc .x{margin-left:auto;color:var(--muted)}
  .card.search{border-color:color-mix(in srgb,var(--accent) 40%,var(--line));
    background:color-mix(in srgb,var(--accent) 6%,var(--surface))}
  .pv-search{color:var(--accent);display:inline-flex}
  .pv-search svg{width:30px;height:30px}
  footer{margin-top:64px;color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:20px}
  a{color:var(--accent)}
  .pp-trigger{display:inline-flex;align-items:center;gap:8px;margin-top:22px;background:var(--surface);
    border:1px solid var(--line);color:var(--muted);border-radius:10px;padding:11px 15px;font-size:14px;cursor:pointer}
  .pp-trigger:hover{border-color:var(--accent);color:var(--ink)}
  .pp-kbd2{border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:1px 6px;font:12px ui-monospace,monospace}
  .pp-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;
    justify-content:center;padding:12vh 16px}
  .pp-overlay[hidden]{display:none}
  .pp-modal{position:relative;width:100%;max-width:560px;background:var(--surface);border:1px solid var(--line);
    border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.3);overflow:hidden}
  .pp-close{position:absolute;top:9px;right:9px;width:28px;height:28px;border:none;background:transparent;
    color:var(--muted);font-size:15px;line-height:1;border-radius:7px;cursor:pointer;z-index:1}
  .pp-close:hover{background:var(--code-bg);color:var(--ink)}
  .pp-input2{width:100%;border:none;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);
    font-size:16px;padding:16px 18px;outline:none}
  .pp-results{list-style:none;margin:0;padding:6px;max-height:48vh;overflow:auto}
  .pp-item{padding:10px 12px;border-radius:9px;cursor:pointer}
  .pp-item.on{background:var(--accent);color:#fff}
  .pp-item.on .pp-s{color:rgba(255,255,255,.82)}
  .pp-l{font-size:14.5px;font-weight:500}
  .pp-s{font-size:12.5px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pp-empty{padding:14px 12px;color:var(--muted);font-size:13.5px}
  .pp-foot{border-top:1px solid var(--line);padding:8px 14px;font-size:11.5px;color:var(--muted)}
  .card.flash{outline:2px solid var(--accent);outline-offset:3px}
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

    <button type="button" id="pp-open" class="pp-trigger">Search components by meaning <span class="pp-kbd2">⌘K</span></button>
    <p class="note" style="margin-top:8px;font-size:13px">This search is <a href="${BASE}/account">pulld Search</a> running on this page — try “let users switch to dark mode” or “copy text to clipboard”.</p>

    <h2>Components</h2>
    <div class="grid">
${cards}
    </div>
${searchSection}
${proSection}
    <footer>
      MIT-licensed · every component is type-checked, built, and verified before it ships.
    </footer>
  </main>
  <div id="pp-overlay" class="pp-overlay" hidden>
    <div class="pp-modal" role="dialog" aria-modal="true" aria-label="Search components">
      <button type="button" id="pp-close" class="pp-close" aria-label="Close search">✕</button>
      <input id="pp-input" class="pp-input2" type="text" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder="Search components by meaning…" aria-label="Search components by meaning" />
      <ul id="pp-results" class="pp-results"></ul>
      <div class="pp-foot">powered by <strong>pulld Search</strong> · ↑↓ navigate · ↵ jump · esc close</div>
    </div>
  </div>
  <script>
    document.querySelectorAll(".copy").forEach(function(b){
      b.addEventListener("click", function(){
        navigator.clipboard.writeText(b.getAttribute("data-cmd")).then(function(){
          var t=b.textContent; b.textContent="copied"; setTimeout(function(){b.textContent=t},1200);
        }).catch(function(){});
      });
    });
    // Live ⌘K demo: search this page's own components via pulld Search, jump to the matched card.
    (function(){
      var KEY="${DEMO_QUERY_KEY}", ENDPOINT="${BASE}/api/search/query";
      var overlay=document.getElementById("pp-overlay"), input=document.getElementById("pp-input"), results=document.getElementById("pp-results");
      if(!overlay||!input||!results) return;
      var open=false, items=[], active=-1, timer=null, seq=0;
      function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
      function render(){
        results.innerHTML = items.length
          ? items.map(function(r,i){ return '<li class="pp-item'+(i===active?" on":"")+'" data-i="'+i+'"><div class="pp-l">'+esc(r.label)+'</div>'+(r.snippet?'<div class="pp-s">'+esc(r.snippet)+'</div>':"")+'</li>'; }).join("")
          : '<li class="pp-empty">'+(input.value.trim()?"No matches":"Type to search by meaning…")+'</li>';
      }
      function show(){ overlay.hidden=false; open=true; input.value=""; items=[]; active=-1; render(); document.body.style.overflow="hidden"; setTimeout(function(){input.focus();},0); }
      function hide(){ overlay.hidden=true; open=false; document.body.style.overflow=""; }
      function run(q){ var my=++seq; fetch(ENDPOINT+"?key="+encodeURIComponent(KEY)+"&q="+encodeURIComponent(q)+"&limit=8").then(function(r){return r.json();}).then(function(j){ if(my!==seq)return; items=(j&&j.results)||[]; active=items.length?0:-1; render(); }).catch(function(){ if(my!==seq)return; items=[]; active=-1; render(); }); }
      function move(d){ if(!items.length)return; active=(active+d+items.length)%items.length; render(); var el=results.querySelector(".pp-item.on"); if(el)el.scrollIntoView({block:"nearest"}); }
      function choose(i){ var r=items[i]; if(!r)return; hide(); var card=document.getElementById("c-"+r.id); if(card){ card.scrollIntoView({behavior:"smooth",block:"center"}); card.classList.add("flash"); setTimeout(function(){card.classList.remove("flash");},1500); } else if(r.url){ location.href=r.url; } }
      input.addEventListener("input", function(){ var q=input.value.trim(); clearTimeout(timer); if(!q){ items=[]; active=-1; render(); return; } timer=setTimeout(function(){ run(q); }, 180); });
      results.addEventListener("click", function(e){ var li=e.target.closest(".pp-item"); if(li)choose(+li.getAttribute("data-i")); });
      overlay.addEventListener("click", function(e){ if(e.target===overlay)hide(); });
      var ob=document.getElementById("pp-open"); if(ob)ob.addEventListener("click", show);
      var cb=document.getElementById("pp-close"); if(cb)cb.addEventListener("click", hide);
      document.addEventListener("keydown", function(e){
        if((e.metaKey||e.ctrlKey) && String(e.key).toLowerCase()==="k"){ e.preventDefault(); open?hide():show(); return; }
        if(!open)return;
        if(e.key==="Escape"){ hide(); }
        else if(e.key==="ArrowDown"){ e.preventDefault(); move(1); }
        else if(e.key==="ArrowUp"){ e.preventDefault(); move(-1); }
        else if(e.key==="Enter"){ e.preventDefault(); choose(active); }
      });
    })();
  </script>
</body>
</html>
`

writeFileSync(join(ROOT, "public", "index.html"), html)
console.log(`OK\tpublic/index.html generated: ${items.length} components (base ${BASE})`)
