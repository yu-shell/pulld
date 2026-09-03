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
// A miniature 11-week grid for the calendar-heatmap card: one digit per square, row-major, 0 for a
// day with nothing up to 4 for the busiest. Written out rather than generated so the built page is
// byte-identical on every run — a card that reshuffled itself each deploy would churn the diff.
const HEATMAP_CELLS =
  "01002300110" +
  "10240031200" +
  "00131042010" +
  "21003210043" +
  "00210031100" +
  "13002100320" +
  "00120004011"
const HEATMAP_TONE = [
  "var(--line)",
  "color-mix(in srgb,var(--accent) 25%,transparent)",
  "color-mix(in srgb,var(--accent) 50%,transparent)",
  "color-mix(in srgb,var(--accent) 75%,transparent)",
  "var(--accent)",
]

// The ratio-bar card's ramp: one hue at three strengths, as the component itself does with
// tints of --primary.
const RATIO_TONE = [
  "var(--accent)",
  "color-mix(in srgb,var(--accent) 62%,transparent)",
  "color-mix(in srgb,var(--accent) 34%,transparent)",
]

const MONTH_CELLS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

const PREVIEWS = {
  "copy-button": `<button class="pv-iconbtn">${ICON.copy}</button>`,
  "calendar-heatmap": `<div style="display:grid;grid-template-columns:repeat(11,6px);gap:2px">${[
    ...HEATMAP_CELLS,
  ]
    .map(
      (d) =>
        `<span style="width:6px;height:6px;border-radius:1px;background:${HEATMAP_TONE[Number(d)]}"></span>`
    )
    .join("")}</div>`,
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
  "ansi-log": `<div class="pv-log"><span><i>$</i>npm run build</span><span class="pv-log-g">✓ built in 1.2s</span><span class="pv-log-r">✗ 2 errors</span><span class="pv-log-d">exit code 1</span></div>`,
  "cron-expression": `<div class="pv-cron"><code>0 9 * * 1-5</code><b>At 09:00, Mon\u2013Fri</b><span>Thu 09:00 UTC</span><span>Fri 09:00 UTC</span></div>`,
  "ratio-bar": `<div style="display:flex;flex-direction:column;gap:8px;width:96px"><span style="display:flex;gap:1px;height:6px;border-radius:99px;overflow:hidden;background:var(--line)">${[46, 30, 24]
    .map((share, i) => `<span style="flex:${share} 1 0;background:${RATIO_TONE[i]}"></span>`)
    .join("")}</span>${[
    ["Images", "46%"],
    ["Video", "30%"],
    ["Other", "24%"],
  ]
    .map(
      ([label, pct], i) =>
        `<span style="display:flex;align-items:center;gap:5px;font-size:9px;line-height:1.2"><span style="width:6px;height:6px;border-radius:99px;background:${RATIO_TONE[i]}"></span><span style="color:var(--ink)">${label}</span><span style="margin-left:auto;color:var(--muted)">${pct}</span></span>`
    )
    .join("")}</div>`,
  "diff-view": `<div class="pv-diff"><span><i></i>retries: 3</span><span class="pv-dif-del"><i>-</i>timeout: 30</span><span class="pv-dif-ins"><i>+</i>timeout: 60</span><span><i></i>debug: off</span></div>`,
  "dashboard-overview": `<div class="pv-dash"><div class="pv-dbar"></div><div class="pv-drow"><span></span><span></span><span></span></div></div>`,
  "command-palette": `<div class="pv-input" style="gap:6px"><span style="color:var(--muted);display:inline-flex">${ICON.search}</span><span style="color:var(--muted);font-size:12px">Search…</span><span style="margin-left:auto;display:flex;gap:3px"><span class="pv-kbd">⌘</span><span class="pv-kbd">K</span></span></div>`,
  toast: `<div class="pv-toast"><span class="pv-tok">${ICON.check}</span><span>Changes saved</span></div>`,
  "search-input": `<div class="pv-input"><span style="color:var(--muted);display:inline-flex">${ICON.search}</span><span style="color:var(--muted);font-size:12px">Search…</span></div>`,
  "number-input": `<div class="pv-input" style="justify-content:center;gap:8px"><span class="pv-numbtn">−</span><span style="font-size:13px;color:var(--ink);min-width:14px;text-align:center">3</span><span class="pv-numbtn">+</span></div>`,
  "otp-input": `<div class="pv-otp"><span>4</span><span>2</span><span></span><span></span></div>`,
  "date-input": `<div class="pv-input pv-date"><span>03</span><i>/</i><span class="on">14</span><i>/</i><span>2026</span></div>`,
  "weekly-hours": `<div style="display:flex;flex-direction:column;gap:4px;width:78px">${[
    ["Mon", "9\u201317", true],
    ["Fri", "9\u201317", true],
    ["Sat", "22\u20132", true],
    ["Sun", "Closed", false],
  ]
    .map(
      ([day, span, on]) =>
        `<span style="display:flex;align-items:center;gap:5px;font-size:9px;line-height:1.2;white-space:nowrap"><span style="position:relative;flex:none;width:12px;height:7px;border-radius:99px;background:${on ? "var(--accent)" : "var(--line)"}"><i style="position:absolute;top:1px;${on ? "right:1px" : "left:1px"};width:5px;height:5px;border-radius:99px;background:#fff"></i></span><span style="flex:none;width:20px;color:${on ? "var(--ink)" : "var(--muted)"}">${day}</span><span style="margin-left:auto;color:${on ? "var(--ink)" : "var(--muted)"};font-variant-numeric:tabular-nums">${span}</span></span>`
    )
    .join("")}</div>`,
  "time-input": `<div class="pv-input pv-date"><span>09</span><i>:</i><span class="on">30</span><span class="pv-ampm">AM</span></div>`,
  "tag-input": `<div class="pv-input" style="height:auto;min-height:30px;flex-wrap:wrap;gap:4px;padding:6px 7px"><span class="pv-tag">react</span><span class="pv-tag">ui</span><span style="color:var(--muted);font-size:11px">|</span></div>`,
  "copy-field": `<div class="pv-input"><span style="font:11px ui-monospace,monospace;color:var(--ink)">tok_1a2b</span><span style="margin-left:auto;color:var(--muted);display:inline-flex">${ICON.copy}</span></div>`,
  "segmented-control": `<div class="pv-seg"><span class="on">Day</span><span>Week</span></div>`,
  "step-indicator": `<div class="pv-steps"><span class="d on"></span><i></i><span class="d cur">2</span><i></i><span class="d">3</span></div>`,
  rating: `<div style="font-size:19px;letter-spacing:2px"><span style="color:var(--accent)">★★★★</span><span style="color:var(--line)">★</span></div>`,
  timeline: `<div class="pv-timeline"><span class="d on"></span><span class="b" style="width:46px"></span><span class="d"></span><span class="b" style="width:30px"></span><span class="d"></span><span class="b" style="width:40px"></span></div>`,
  "announcement-bar": `<div class="pv-annc"><span>New — try it →</span><span class="x">×</span></div>`,
  "network-status": `<div class="pv-net"><span class="i"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 5.2-2.7"/><path d="M16 11.1a10 10 0 0 1 3 1.8"/><path d="M2 8.8a16 16 0 0 1 4.7-2.8"/><path d="M11 5a16 16 0 0 1 11 3.8"/><path d="M12 20h.01"/></svg></span><span>Offline</span><span class="r">Retry</span></div>`,
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
  "duration-input": `<div style="display:flex;flex-direction:column;gap:6px;width:96px"><span class="pv-input" style="height:27px"><span style="font-size:12.5px;color:var(--ink);font-variant-numeric:tabular-nums">1h 30m</span><span style="width:1px;height:13px;background:var(--accent);margin-left:1px"></span></span><span style="font-size:9px;color:var(--muted)">1 hour 30 minutes</span></div>`,
  "color-picker": `<div style="display:flex;flex-direction:column;gap:7px;width:96px"><span style="display:flex;align-items:center;gap:6px"><span style="width:18px;height:18px;border-radius:5px;background:var(--accent);border:1px solid var(--line)"></span><span style="font:11px ui-monospace,monospace;color:var(--ink)">#3b82f6</span></span>${[
    { g: "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)", at: 58 },
    { g: "linear-gradient(to right,#808080,var(--accent))", at: 78 },
    { g: "linear-gradient(to right,#000,var(--accent),#fff)", at: 52 },
  ]
    .map(
      (b) =>
        `<span style="position:relative;display:block;height:6px;border-radius:99px;background:${b.g}"><span style="position:absolute;top:50%;left:${b.at}%;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:99px;background:#fff;border:1px solid rgba(0,0,0,.35)"></span></span>`
    )
    .join("")}</div>`,
  "bulk-action-bar": `<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-start;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 9px;box-shadow:0 3px 10px rgba(0,0,0,.10)"><span style="display:flex;align-items:center;gap:5px"><span style="display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:5px;background:var(--accent);color:#fff;font-size:9px;font-weight:700">3</span><span style="font-size:10px;color:var(--ink)">selected</span></span><span style="display:flex;gap:4px"><span class="pv-btn pv-danger" style="height:17px;padding:0 6px;border-radius:5px;font-size:9px">Delete</span><span style="display:inline-flex;align-items:center;height:17px;padding:0 6px;font-size:9px;color:var(--muted)">Clear</span></span></div>`,
  "save-status": `<div style="display:flex;flex-direction:column;gap:7px;align-items:flex-start"><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Saving…</span><span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--muted)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span style="color:var(--ink)">Saved</span> 2 min ago</span></div>`,
  "floating-label-input":`<div style="position:relative;width:96px"><div class="pv-input" style="border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"><span style="font-size:12.5px;color:var(--ink)">jane@acme.co</span><span style="width:1px;height:13px;background:var(--accent);margin-left:1px"></span></div><span style="position:absolute;top:-6px;left:8px;padding:0 4px;background:var(--bg);font-size:9px;font-weight:500;color:var(--accent)">Email</span></div>`,
  "form-error-summary": `<div class="pv-danger" style="width:96px;border:1px solid;border-radius:8px;padding:7px 8px;display:flex;flex-direction:column;gap:5px"><span style="display:flex;align-items:center;gap:4px;font-size:9.5px;font-weight:600"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>2 problems</span><span style="display:flex;flex-direction:column;gap:3px;padding-left:5px;font-size:9px;text-decoration:underline;text-underline-offset:2px"><span>Enter your email</span><span>Choose a password</span></span></div>`,
  "keyboard-shortcuts": `<div style="display:flex;flex-direction:column;gap:5px;width:96px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 9px;box-shadow:0 3px 10px rgba(0,0,0,.10)"><span style="display:flex;align-items:center;justify-content:space-between;gap:6px;border-bottom:1px solid var(--line);padding-bottom:4px"><span style="font-size:9.5px;font-weight:600;color:var(--ink)">Shortcuts</span><span style="font-size:10px;color:var(--muted);line-height:1">×</span></span><span style="display:flex;align-items:center;justify-content:space-between;gap:6px"><span style="font-size:9px;color:var(--muted)">Search</span><span style="display:flex;gap:2px"><span class="pv-kbd" style="height:15px;padding:0 4px;font-size:9px;border-radius:4px">⌘</span><span class="pv-kbd" style="height:15px;padding:0 4px;font-size:9px;border-radius:4px">K</span></span></span><span style="display:flex;align-items:center;justify-content:space-between;gap:6px"><span style="font-size:9px;color:var(--muted)">New issue</span><span style="display:flex;gap:2px"><span class="pv-kbd" style="height:15px;padding:0 4px;font-size:9px;border-radius:4px">C</span></span></span></div>`,
  "type-to-confirm": `<div style="display:flex;flex-direction:column;gap:5px;width:96px"><span style="font-size:9px;color:var(--muted)">Type <span style="color:var(--ink);font-weight:600;font-family:ui-monospace,monospace">acme-prod</span></span><div class="pv-input" style="height:22px;padding:0 7px;gap:1px;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"><span style="font-size:10px;color:var(--ink);font-family:ui-monospace,monospace">acme-pro</span><span style="width:1px;height:11px;background:var(--accent)"></span></div><span class="pv-btn pv-danger" style="height:19px;padding:0 8px;border-radius:6px;font-size:9.5px;justify-content:center;width:100%;box-sizing:border-box;opacity:.45">Delete</span></div>`,
  "bento-grid": `<div style="display:grid;grid-template-columns:repeat(3,1fr);grid-auto-rows:19px;gap:4px;width:96px"><span style="grid-column:span 2;grid-row:span 2;border:1px solid var(--accent);border-radius:5px;background:color-mix(in srgb,var(--accent) 14%,transparent)"></span><span style="border:1px solid var(--line);border-radius:5px"></span><span style="border:1px solid var(--line);border-radius:5px"></span><span style="grid-column:span 3;border:1px solid var(--line);border-radius:5px"></span></div>`,
  "upload-list": `<div style="display:flex;flex-direction:column;gap:7px;width:96px;border:1px solid var(--line);border-radius:8px;padding:8px 9px"><span style="display:flex;flex-direction:column;gap:4px"><span style="display:flex;align-items:center;gap:5px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg><span style="font-size:9px;color:var(--ink)">logo.png</span><span style="margin-left:auto;font-size:8.5px;color:var(--muted)">62%</span></span><span style="display:block;height:3px;border-radius:2px;background:var(--line)"><span style="display:block;width:62%;height:100%;border-radius:2px;background:var(--accent)"></span></span></span><span style="display:flex;align-items:center;gap:5px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg><span style="font-size:9px;color:var(--ink)">data.csv</span><span style="margin-left:auto;font-size:10px;color:var(--muted);line-height:1">×</span></span></div>`,
  "tree-view": `<div style="display:flex;flex-direction:column;gap:2px;width:96px">${[
    { depth: 0, open: true, label: "src" },
    { depth: 1, open: false, label: "app" },
    { depth: 1, file: true, label: "index.ts", on: true },
    { depth: 0, open: false, label: "public" },
  ]
    .map(
      (r) =>
        `<span style="display:flex;align-items:center;gap:4px;padding:2px 4px;padding-left:${4 + r.depth * 10}px;border-radius:4px;${r.on ? "background:color-mix(in srgb,var(--accent) 16%,transparent)" : ""}">${
          r.file
            ? `<span style="width:8px"></span><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`
            : `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${r.open ? ` style="transform:rotate(90deg)"` : ""}><path d="m9 18 6-6-6-6"/></svg><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`
        }<span style="font-size:9px;color:var(--ink)">${r.label}</span></span>`
    )
    .join("")}</div>`,
  // Leaf rows are padded by the indent plus the width of the arrow they do not have, so
  // the keys line up under the container that holds them.
  "json-viewer": `<div class="pv-json">${[
    { pad: 0, chevron: "open", tail: `{<em>3 keys</em>` },
    { pad: 19, tail: `<b>id</b>:<i class="pv-json-n">42</i>` },
    { pad: 19, tail: `<b>name</b>:<i class="pv-json-s">"acme"</i>` },
    { pad: 9, chevron: "closed", tail: `<b>tags</b>:[ … ]` },
  ]
    .map(
      (r) =>
        `<span style="padding-left:${r.pad}px">${
          r.chevron
            ? `<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${r.chevron === "open" ? ` style="transform:rotate(90deg)"` : ""}><path d="m9 18 6-6-6-6"/></svg>`
            : ""
        }${r.tail}</span>`
    )
    .join("")}</div>`,
  // The same scene twice — plain on the left, tinted on the right — split by the divider and
  // its knob. Drawing one picture and clipping a tinted copy of it over the other half is the
  // component's own trick, and it is what keeps the card from reading as one more image
  // placeholder: the thumbnail has to show a comparison, not a photo.
  // A year of months with one picked and "now" tinted, under the year and its arrows — the two
  // things that tell this apart from a day calendar at thumbnail size.
  "month-picker": `<div style="display:flex;flex-direction:column;gap:5px;width:96px"><div style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1;color:var(--muted)"><span>\u2039</span><span style="flex:1;text-align:center;color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums">2026</span><span>\u203a</span></div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:3px">${MONTH_CELLS.map(
    (m, i) =>
      `<span style="display:flex;align-items:center;justify-content:center;height:13px;border-radius:3px;font-size:8px;line-height:1;${
        i === 7
          ? "background:var(--accent);color:var(--bg);font-weight:600"
          : i === 4
            ? "background:color-mix(in srgb,var(--accent) 22%,transparent);color:var(--ink)"
            : "color:var(--muted)"
      }">${m}</span>`
  ).join("")}</div></div>`,
  "country-select": `<div style="display:flex;flex-direction:column;gap:5px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;height:24px;padding:0 7px;gap:5px"><span style="color:var(--muted);display:inline-flex">${ICON.search}</span><span style="font-size:11px;color:var(--ink)">jap</span></div><div style="display:flex;flex-direction:column;gap:2px"><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 4px;border-radius:3px;background:color-mix(in srgb,var(--accent) 18%,transparent)"><span style="color:var(--ink)">Japan</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">JP</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 4px;border-radius:3px;"><span style="color:var(--ink)">Jamaica</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">JM</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 4px;border-radius:3px;"><span style="color:var(--ink)">Jordan</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">JO</span></span></div></div>`,
  "currency-select": `<div style="display:flex;flex-direction:column;gap:5px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;height:24px;padding:0 7px;gap:5px"><span style="font-size:11px;color:var(--muted)">$</span><span style="font-size:11px;color:var(--ink)">US Dollar</span><span style="margin-left:auto;font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums">USD</span></div><div style="display:flex;flex-direction:column;gap:2px"><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;background:color-mix(in srgb,var(--accent) 18%,transparent)"><span style="width:9px;color:var(--muted);text-align:center">&euro;</span><span style="color:var(--ink)">Euro</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">EUR</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;"><span style="width:9px;color:var(--muted);text-align:center">&yen;</span><span style="color:var(--ink)">Japanese Yen</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">JPY</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;"><span style="width:9px;color:var(--muted);text-align:center">&pound;</span><span style="color:var(--ink)">British Pound</span><span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">GBP</span></span></div></div>`,
  "language-select": `<div style="display:flex;flex-direction:column;gap:5px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;height:24px;padding:0 7px;gap:4px"><span style="font-size:11px;color:var(--ink)">&#26085;&#26412;&#35486;</span><span style="margin-left:auto;font-size:9px;color:var(--muted);font-family:ui-monospace,monospace">ja</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></div><div style="display:flex;flex-direction:column;gap:2px"><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;background:color-mix(in srgb,var(--accent) 18%,transparent)"><span style="color:var(--ink)">Deutsch</span><span style="margin-left:auto;color:var(--muted);font-family:ui-monospace,monospace">de</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;"><span style="color:var(--ink)" dir="rtl">&#1575;&#1604;&#1593;&#1585;&#1576;&#1610;&#1577;</span><span style="margin-left:auto;color:var(--muted);font-family:ui-monospace,monospace">ar</span></span><span style="display:flex;align-items:center;gap:4px;font-size:9px;line-height:1.2;padding:2px 3px;border-radius:3px;"><span style="color:var(--ink)">&#54620;&#44397;&#50612;</span><span style="margin-left:auto;color:var(--muted);font-family:ui-monospace,monospace">ko</span></span></div></div>`,
  "phone-input": `<div style="display:flex;flex-direction:column;gap:4px;width:104px"><div class="pv-input" style="width:104px;box-sizing:border-box;height:22px;padding:0 6px;gap:3px"><span style="font-size:10px;color:var(--ink)">Japan</span><span style="margin-left:auto;display:inline-flex"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span></div><div class="pv-input" style="width:104px;box-sizing:border-box;height:22px;padding:0 6px;gap:3px;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)"><span style="font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums">+81</span><span style="font-size:9px;color:var(--ink);font-variant-numeric:tabular-nums">901 234 5678</span></div><span style="font-size:8px;color:var(--muted);font-family:ui-monospace,monospace">+819012345678</span></div>`,
  "recovery-codes": `<div style="display:flex;flex-direction:column;gap:5px;width:104px"><div class="pv-rc"><span>7f2a-91c4</span><span>b3e8-45da</span><span class="u">c1d9-77ab</span><span>e604-2b3f</span></div><div style="display:flex;align-items:center;gap:4px"><span style="font-size:8px;color:var(--muted)">3 of 4 unused</span><span style="margin-left:auto;color:var(--muted);display:inline-flex"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg></span></div></div>`,
  "unsaved-changes-guard": `<div class="pv-leave"><div class="h"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.6 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg><b>Leave without saving?</b></div><span class="b">Your changes will be lost.</span><div class="f"><span class="keep">Keep</span><span class="go">Discard</span></div></div>`,
  "password-generator": `<div style="display:flex;flex-direction:column;gap:5px;width:104px"><div class="pv-input" style="width:104px;box-sizing:border-box;height:22px;padding:0 6px;gap:4px"><span style="font:10px ui-monospace,monospace;color:var(--ink)">q7#Kp2vR</span><span style="margin-left:auto;color:var(--muted);display:inline-flex"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></span></div><div style="display:flex;align-items:center;height:8px"><span style="height:3px;width:60px;border-radius:2px;background:var(--accent)"></span><span style="width:8px;height:8px;border-radius:50%;background:var(--accent);margin-left:-3px"></span><span style="height:3px;flex:1;border-radius:2px;background:var(--line);margin-left:-3px"></span></div><span style="font-size:8px;color:var(--muted);font-variant-numeric:tabular-nums">20 chars &middot; 118 bits</span></div>`,
  "timezone-select": `<div style="display:flex;flex-direction:column;gap:6px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;height:26px;padding:0 7px;gap:4px"><span style="font-size:11px;color:var(--ink)">New York</span><span style="margin-left:auto;font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums">−04:00</span><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></div><div style="display:flex;flex-direction:column;gap:3px;font-size:9px;line-height:1.2"><span style="color:var(--muted);font-weight:600;letter-spacing:.02em">Europe</span><span style="display:flex;align-items:center;gap:4px;color:var(--ink)">Berlin<span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">+02:00</span></span><span style="display:flex;align-items:center;gap:4px;color:var(--ink)">London<span style="margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums">+01:00</span></span></div></div>`,
  "image-comparison": (() => {
    // width/height and preserveAspectRatio="none" both matter: an absolutely positioned SVG
    // with inset:0 alone is sized by its own viewBox ratio rather than stretched to the box,
    // which left the horizon floating nine pixels above the bottom edge. Distorting the scene
    // is the right trade here — both layers are distorted identically, so they stay aligned,
    // and the card is squeezed to the 84px the preview box leaves whatever width is asked for.
    const scene = (fill, opacity) =>
      `<svg viewBox="0 0 96 64" preserveAspectRatio="none" fill="${fill}" opacity="${opacity}" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%"><circle cx="70" cy="17" r="7"/><path d="M0 64 26 27 50 64Z"/><path d="M36 64 60 33 86 64Z"/></svg>`
    const split = 58
    return `<div style="position:relative;width:96px;height:64px;border-radius:6px;overflow:hidden;border:1px solid var(--line);background:var(--line)">${scene(
      "var(--muted)",
      ".45"
    )}<span style="position:absolute;inset:0;background:color-mix(in srgb,var(--accent) 18%,transparent);clip-path:inset(0 0 0 ${split}%)">${scene(
      "var(--accent)",
      ".85"
    )}</span><span style="position:absolute;top:0;bottom:0;left:${split}%;width:2px;transform:translateX(-50%);background:var(--surface)"></span><span style="position:absolute;top:50%;left:${split}%;width:15px;height:15px;margin:-7.5px 0 0 -7.5px;border-radius:99px;border:1px solid var(--line);background:var(--surface);display:flex;align-items:center;justify-content:center"><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m14 7 5 5-5 5M10 7l-5 5 5 5"/></svg></span></div>`
  })(),
  "sortable-list": `<div style="display:flex;flex-direction:column;gap:4px;width:96px">${[
    { w: 40 },
    { w: 30, lifted: true },
    { w: 46 },
  ]
    .map(
      (r) =>
        `<span style="display:flex;align-items:center;gap:5px;border:1px solid ${r.lifted ? "var(--accent)" : "var(--line)"};border-radius:5px;padding:4px 5px;background:var(--surface);${r.lifted ? "box-shadow:0 3px 8px rgba(0,0,0,.16);transform:translateX(5px)" : ""}"><svg width="7" height="9" viewBox="0 0 16 24" fill="${r.lifted ? "var(--accent)" : "var(--muted)"}" aria-hidden="true"><circle cx="5" cy="6" r="1.7"/><circle cx="5" cy="12" r="1.7"/><circle cx="5" cy="18" r="1.7"/><circle cx="11" cy="6" r="1.7"/><circle cx="11" cy="12" r="1.7"/><circle cx="11" cy="18" r="1.7"/></svg><span style="height:4px;width:${r.w}px;border-radius:2px;background:var(--muted);opacity:.5"></span></span>`
    )
    .join("")}</div>`,
  // Rows fading out into a Load more button: the list keeps going, and the button is always there.
  "infinite-scroll": `<div style="display:flex;flex-direction:column;align-items:center;gap:5px;width:96px">${[
    { w: 46, o: 1 },
    { w: 34, o: 0.55 },
    { w: 42, o: 0.22 },
  ]
    .map(
      (r) =>
        `<span style="display:flex;align-items:center;gap:5px;width:100%;opacity:${r.o}"><span style="width:13px;height:13px;border-radius:4px;background:var(--line)"></span><span style="height:4px;width:${r.w}px;border-radius:2px;background:var(--muted);opacity:.55"></span></span>`
    )
    .join("")}<span class="pv-btn" style="height:19px;padding:0 8px;border-radius:6px;font-size:9.5px;margin-top:3px">Load more</span></div>`,
  // The window: rows inside the frame are drawn, the ones outside it only take up space.
  // 9 + 4 + 47 + 4 + 9 = 73px tall, inside the 84px the preview box leaves.
  "virtual-list": (() => {
    const ghost = `<span style="width:100%;height:9px;border-radius:3px;border:1px dashed var(--line);opacity:.5"></span>`
    const row = (w) =>
      `<span style="display:flex;align-items:center;gap:5px"><span style="width:9px;height:9px;border-radius:3px;background:var(--line)"></span><span style="height:4px;width:${w}px;border-radius:2px;background:var(--muted);opacity:.55"></span></span>`
    const scrollbar = `<span style="position:absolute;right:4px;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--line)"><span style="display:block;height:38%;margin-top:34%;border-radius:2px;background:var(--muted);opacity:.6"></span></span>`
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;width:96px">${ghost}<span style="position:relative;display:flex;flex-direction:column;gap:4px;width:100%;padding:5px 13px 5px 5px;border:1px solid var(--accent);border-radius:6px;background:var(--surface)">${row(38)}${row(46)}${row(30)}${scrollbar}</span>${ghost}</div>`
  })(),
  // Three lines of text, a fourth cut off by the clamp, and the control that reveals it.
  // 4+4+4+4 lines + 12px link + 4 gaps of 5 = 48px, inside the 84px the preview box leaves.
  "read-more": (() => {
    const line = (w, o) =>
      `<span style="height:4px;width:${w};border-radius:2px;background:var(--muted);opacity:${o}"></span>`
    return `<div style="display:flex;flex-direction:column;gap:5px;width:96px">${line("100%", ".5")}${line("92%", ".5")}${line("68%", ".5")}${line("84%", ".16")}<span style="margin-top:2px;font-size:9.5px;color:var(--accent);text-decoration:underline;text-underline-offset:2px">Show more</span></div>`
  })(),
  // The bar across the top of an article, with the text below it going faint where the fill
  // stops — on its own a part-filled bar is every other progress component, so the thumbnail
  // has to show what the fill is measuring. 4px track + 8 + 5 lines of 4 + 4 gaps of 6 = 56px,
  // inside the 84px the preview box leaves.
  "scroll-progress": (() => {
    const line = (w, o) =>
      `<span style="height:4px;width:${w};border-radius:2px;background:var(--muted);opacity:${o}"></span>`
    const track = `<span style="position:relative;display:block;width:100%;height:4px;border-radius:99px;overflow:hidden;background:var(--line)"><span style="position:absolute;left:0;top:0;bottom:0;width:62%;border-radius:99px;background:var(--accent)"></span></span>`
    return `<div style="display:flex;flex-direction:column;width:96px">${track}<span style="display:flex;flex-direction:column;gap:6px;margin-top:8px">${line("100%", ".5")}${line("88%", ".5")}${line("96%", ".5")}${line("72%", ".16")}${line("90%", ".16")}</span></div>`
  })(),
  "middle-truncate": (() => {
    const mono = (text, color, weight = "400") =>
      `<span style="font:10.5px ui-monospace,monospace;color:${color};font-weight:${weight}">${text}</span>`
    // A width rule under the field: the cut is made to fit the container, not at a fixed count.
    const rule = `<svg width="96" height="9" viewBox="0 0 96 9" fill="none" stroke="var(--muted)" stroke-width="1" stroke-linecap="round" aria-hidden="true"><path d="M2 1v7M94 1v7M6 4.5h84"/><path d="m6 4.5 4-2.5M6 4.5l4 2.5M90 4.5l-4-2.5M90 4.5l-4 2.5"/></svg>`
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;justify-content:center;gap:0;padding:0 7px">${mono("quarterly", "var(--ink)")}${mono("…", "var(--accent)", "700")}${mono("v3.xlsx", "var(--ink)")}</div>${rule}</div>`
  })(),
  // A rail of headings with the one being read marked — accent rule, darker text. One entry
  // is indented to show the nesting. 9px caption + 4 rows of 11px + 4 gaps of 4 = 69px, inside
  // the 84px the preview box leaves.
  toc: (() => {
    const row = (label, { on = false, nested = false } = {}) =>
      `<span style="display:block;box-sizing:border-box;border-left:2px solid ${
        on ? "var(--accent)" : "var(--line)"
      };padding-left:${nested ? 14 : 7}px;font-size:9px;line-height:1.25;color:${
        on ? "var(--ink)" : "var(--muted)"
      };font-weight:${on ? "600" : "400"}">${label}</span>`
    return `<div style="display:flex;flex-direction:column;gap:4px;width:96px"><span style="font-size:8px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--muted)">On this page</span>${row(
      "Installation"
    )}${row("Usage", { on: true })}${row("Options", { nested: true })}${row("API")}</div>`
  })(),
  // The component's own projection in miniature, so the thumbnail can't drift
  // from what ships: 12 points into a 96×34 box inset by the stroke, with the
  // last value marked. 9px caption + 4 gap + 34 svg = 47px, inside the 84px the
  // preview box leaves.
  sparkline: (() => {
    const data = [4, 6, 5, 9, 7, 12, 10, 14, 11, 17, 15, 20]
    const w = 96
    const h = 34
    const pad = 3
    const lo = Math.min(...data)
    const hi = Math.max(...data)
    const f = (n) => Math.round(n * 100) / 100
    const pts = data.map((v, i) => [
      pad + ((w - 2 * pad) * i) / (data.length - 1),
      h - pad - (h - 2 * pad) * ((v - lo) / (hi - lo)),
    ])
    const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join("")
    const [lx, ly] = pts[pts.length - 1]
    const area = `M${f(pts[0][0])},${h - pad}${pts
      .map(([x, y]) => `L${f(x)},${f(y)}`)
      .join("")}L${f(lx)},${h - pad}Z`
    return `<div style="display:flex;flex-direction:column;gap:4px;width:96px"><span style="font-size:9px;color:var(--muted)">Requests · 30d</span><svg width="96" height="34" viewBox="0 0 96 34" aria-hidden="true"><path d="${area}" fill="var(--accent)" fill-opacity=".14"/><path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M${f(
      lx
    )},${f(ly)}L${f(lx)},${f(ly)}" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"/></svg></div>`
  })(),
  // The title above, the slug it derived below, so the thumbnail shows the one
  // thing the component is for. 11px title + 4 gap + 8px arrow + 4 gap + 24px
  // field = 51px, inside the 84px the preview box leaves.
  "slug-input": (() => {
    const mono = (text, color) =>
      `<span style="font:10px ui-monospace,monospace;color:${color}">${text}</span>`
    const arrow = `<svg width="9" height="8" viewBox="0 0 9 8" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 1v6M2 4.8l2.5 2.4L7 4.8"/></svg>`
    // 13 monospace characters at 10px ≈ 78px, plus 14px of padding and the
    // caret: inside the 96px the card gives the preview.
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:4px;width:96px"><span style="align-self:flex-start;font-size:9px;color:var(--muted)">My Post!</span>${arrow}<div class="pv-input" style="width:96px;box-sizing:border-box;height:24px;gap:0;padding:0 7px">${mono(
      "/blog/",
      "var(--muted)"
    )}${mono("my-post", "var(--ink)")}<span style="width:1px;height:11px;background:var(--accent);margin-left:1px"></span></div></div>`
  })(),
  // The masked field with the meter under it, drawn the way the component draws
  // it: four segments, filled to the band. Three of four is "Fair", the middle
  // band, which is the one worth showing — it is the only one where the advice
  // line has something to say. 22px field + 4 gap + 5px bar + 4 gap + 9px label
  // = 44px, inside the 84px the preview box leaves.
  "password-strength": (() => {
    const filled = 3
    const bar = [0, 1, 2, 3]
      .map(
        (i) =>
          `<span style="height:5px;flex:1;border-radius:3px;background:${
            i < filled ? "currentColor" : "var(--line)"
          }"></span>`
      )
      .join("")
    return `<div style="display:flex;flex-direction:column;gap:4px;width:96px"><div class="pv-input" style="width:96px;box-sizing:border-box;height:22px;padding:0 7px"><span class="pv-dots">••••••••</span></div><div class="pv-warn" style="display:flex;gap:3px;width:100%">${bar}</div><span class="pv-warn" style="font-size:9px;font-weight:600">Fair</span></div>`
  })(),
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
          <div class="desc-wrap">
            <p class="desc">${esc(it.description || "")}</p>
            <button type="button" class="desc-more" aria-label="Read the full description of ${esc(it.title || it.name)}">… more</button>
          </div>
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

// Buy buttons point at our own /go/* redirect, never at buy.polar.sh directly: the click is
// logged there before the hop, and crawlers stop at it instead of opening a Polar checkout
// session. rel="nofollow" keeps well-behaved crawlers from following it at all. The Polar URLs
// themselves live in wrangler.toml [vars], read by functions/go/[target].js.
const PRO_PRICE = process.env.PRO_PRICE || "$39"
const PRO_CHECKOUT = "/go/pro"

const SEARCH_PRICE = process.env.SEARCH_PRICE || "$19"
const SEARCH_CHECKOUT = "/go/search"
const searchSection = `
    <h2>Hosted service</h2>
    <div class="grid">
      <article class="card search">
        <div class="preview"><span class="pv-search">${ICON.search}</span></div>
        <div class="card-body">
          <div class="card-head"><h3>pulld Search <span class="badge">${esc(SEARCH_PRICE)}/mo</span></h3></div>
          <p>Hosted semantic search — index your content and get typo-tolerant, meaning-based results. Drop it into the command palette's <code>source</code>; nothing to run.</p>
          <a class="buy" rel="nofollow" href="${esc(SEARCH_CHECKOUT)}">Subscribe — ${esc(SEARCH_PRICE)}/mo</a>
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
          <div class="desc-wrap">
            <p class="desc">${esc(it.description || "")}</p>
            <button type="button" class="desc-more" aria-label="Read the full description of ${esc(it.title || it.name)}">… more</button>
          </div>
          <div class="cmd"><code>${esc(cmd)}</code></div>
          <a class="buy" rel="nofollow" href="${esc(PRO_CHECKOUT)}">Get a license — ${esc(PRO_PRICE)} one-time</a>
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
  /* Descriptions are written long on purpose — they are what an agent matches against — but at
     ~1400 characters each they made every card 4-7x taller than its 104px preview. Clamp to two
     lines so the row settles just above the preview, and open the full text in a dialog. The clamp
     is CSS only: the whole description stays in the DOM, so nothing an agent or crawler reads is
     lost. The height is fixed rather than capped so a short description leaves the row the same
     height as every other one. */
  .desc-wrap{position:relative;margin:6px 0 12px}
  .card p.desc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;
    height:calc(2 * 1.6 * 14.5px);margin:0}
  /* Sits on the end of the clamped second line rather than on a row of its own — a row would cost
     another 31px on every card, which is most of the breathing room the clamp just bought. The
     gradient is the card's own background, so the trigger never lands on top of a word. */
  .desc-more{position:absolute;right:0;bottom:0;border:0;cursor:pointer;
    padding:0 0 0 30px;color:var(--accent);font:inherit;font-size:14.5px;line-height:1.6;
    background:linear-gradient(90deg,transparent,var(--surface) 26%)}
  .desc-more:hover{text-decoration:underline;text-underline-offset:2px}
  /* Hidden, not removed: a description short enough to need no dialog must not shift its card. */
  .desc-more.off{visibility:hidden}
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
  .pv-warn{color:#d97706}
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
  .pv-diff{width:96px;border:1px solid var(--line);border-radius:7px;overflow:hidden;
    font:9.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  .pv-diff span{display:flex;gap:3px;padding:0 5px;color:var(--ink);white-space:nowrap}
  .pv-diff i{font-style:normal;width:5px;flex:none;color:var(--muted)}
  .pv-dif-del{background:color-mix(in srgb,#dc2626 13%,transparent)}
  .pv-dif-del i{color:#dc2626}
  .pv-dif-ins{background:color-mix(in srgb,#16a34a 15%,transparent)}
  .pv-dif-ins i{color:#16a34a}
  .pv-log{width:96px;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:var(--code-bg);
    padding:5px 0;font:9.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
  .pv-log span{display:flex;gap:3px;padding:0 6px;color:var(--ink);white-space:nowrap}
  .pv-log i{font-style:normal;color:var(--muted)}
  .pv-log-g{color:#16a34a}
  .pv-log-r{color:#dc2626}
  .pv-log-d{color:var(--muted)}
  .pv-cron{width:96px;display:flex;flex-direction:column;align-items:flex-start;gap:5px}
  .pv-cron code{font:9.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);
    background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 4px}
  .pv-cron b{font-size:10px;line-height:1.3;font-weight:600;color:var(--ink)}
  .pv-cron span{font:9px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
  .pv-json{width:96px;display:flex;flex-direction:column;gap:2px;
    font:9px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
  .pv-json>span{display:flex;align-items:center;gap:3px;white-space:nowrap;color:var(--muted)}
  .pv-json b{font-weight:400;color:var(--ink)}
  .pv-json i{font-style:normal}
  .pv-json em{font-style:normal;opacity:.65}
  .pv-json-s{color:#16a34a}
  .pv-json-n{color:#2563eb}
  @media (prefers-color-scheme:dark){ .pv-danger{color:#f87171;border-color:#f87171} .pv-warn{color:#fbbf24} .pv-up{color:#4ade80} .pv-tok{color:#4ade80} .pv-net .i{color:#f87171} .pv-leave .h{color:#fbbf24} .pv-leave .go{background:#f87171;color:#1c1917} .pv-dif-del i{color:#f87171} .pv-dif-ins i{color:#4ade80} .pv-log-g{color:#4ade80} .pv-log-r{color:#f87171} .pv-json-s{color:#4ade80} .pv-json-n{color:#60a5fa} }
  .pv-numbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;border:1px solid var(--line);color:var(--muted);font-size:13px}
  .pv-leave{width:104px;border:1px solid var(--line);border-radius:8px;background:var(--surface);
    padding:7px 8px 6px;display:flex;flex-direction:column;gap:4px}
  .pv-leave .h{display:flex;align-items:center;gap:4px;color:#d97706}
  .pv-leave b{font-size:9px;line-height:1.25;font-weight:600;color:var(--ink)}
  .pv-leave .b{font-size:8.5px;line-height:1.3;color:var(--muted)}
  .pv-leave .f{display:flex;gap:4px;justify-content:flex-end;margin-top:1px}
  .pv-leave .f span{font-size:8px;padding:2px 5px;border-radius:4px;white-space:nowrap}
  .pv-leave .keep{border:1px solid var(--line);color:var(--ink)}
  .pv-leave .go{background:#dc2626;color:#fff}
  .pv-rc{display:grid;grid-template-columns:repeat(2,1fr);gap:2px 6px;width:104px}
  .pv-rc span{font:8.5px ui-monospace,monospace;letter-spacing:.02em;color:var(--ink);border-bottom:1px dashed var(--line);padding-bottom:1px}
  .pv-rc span.u{color:var(--muted);text-decoration:line-through}
  .pv-otp{display:flex;gap:5px}
  .pv-otp span{width:18px;height:24px;border:1px solid var(--line);border-radius:6px;display:flex;align-items:center;justify-content:center;font:13px ui-monospace,monospace;color:var(--ink);background:var(--surface)}
  .pv-date{gap:0;padding:0 7px;font:11px ui-monospace,monospace;color:var(--ink)}
  .pv-date i{color:var(--muted);font-style:normal;padding:0 1px}
  .pv-date .on{background:var(--accent);color:#fff;border-radius:3px;padding:0 2px}
  .pv-ampm{color:var(--muted);font-size:9.5px;letter-spacing:.03em;padding-left:4px}
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
  .pv-net{display:flex;align-items:center;gap:5px;width:100px;box-sizing:border-box;border-radius:8px;padding:7px;
    font-size:9.5px;line-height:1.2;color:var(--ink);white-space:nowrap;
    background:color-mix(in srgb,#dc2626 10%,var(--surface));border:1px solid color-mix(in srgb,#dc2626 30%,var(--line))}
  .pv-net .i{color:#dc2626;display:inline-flex;flex:none}
  .pv-net .r{margin-left:auto;color:var(--muted);text-decoration:underline;text-underline-offset:2px}
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
  /* Full-description dialog. Shares the palette's overlay so both modals feel like one thing;
     wider and scrollable, because this one is here to be read. Declared after .pp-modal so the
     scroll override wins. */
  .dd-modal{max-width:640px;max-height:78vh;overflow:auto;padding:24px 26px 26px}
  /* The page's h2 is an uppercase muted section label; this heading is a component name, so every
     one of those inherited properties has to be undone. */
  .dd-title{margin:0 34px 12px 0;font-size:19px;letter-spacing:-.01em;text-transform:none;
    color:var(--ink);font-weight:600}
  .dd-body{margin:0;color:var(--muted);font-size:15px;line-height:1.75}
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
  <div id="dd-overlay" class="pp-overlay" hidden>
    <div class="pp-modal dd-modal" role="dialog" aria-modal="true" aria-labelledby="dd-title">
      <button type="button" id="dd-close" class="pp-close" aria-label="Close description">✕</button>
      <h2 id="dd-title" class="dd-title"></h2>
      <p id="dd-body" class="dd-body"></p>
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
    // Full-description dialog. The card shows two clamped lines; this opens the rest.
    // The text is read out of the card's own <p>, so the description is stored once, in the DOM,
    // where crawlers and agents still see all of it.
    (function(){
      var overlay=document.getElementById("dd-overlay"), title=document.getElementById("dd-title"), body=document.getElementById("dd-body");
      if(!overlay||!title||!body) return;
      var opener=null;
      function show(card){
        var p=card.querySelector(".desc"), h=card.querySelector("h3");
        if(!p) return;
        title.textContent = h ? h.textContent.trim() : "";
        body.textContent = p.textContent;
        overlay.hidden=false; document.body.style.overflow="hidden";
        var c=document.getElementById("dd-close"); if(c) c.focus();
      }
      function hide(){
        if(overlay.hidden) return;
        overlay.hidden=true; document.body.style.overflow="";
        if(opener){ opener.focus(); opener=null; }
      }
      document.addEventListener("click", function(e){
        var b=e.target.closest(".desc-more"); if(!b) return;
        var card=b.closest(".card"); if(!card) return;
        opener=b; show(card);
      });
      var cb=document.getElementById("dd-close"); if(cb) cb.addEventListener("click", hide);
      overlay.addEventListener("click", function(e){ if(e.target===overlay) hide(); });
      document.addEventListener("keydown", function(e){
        // ⌘K belongs to the palette; step out of its way rather than stacking two dialogs.
        if(e.key==="Escape" || ((e.metaKey||e.ctrlKey) && String(e.key).toLowerCase()==="k")) hide();
      });
      // Offer the dialog only where there is actually more to read, but keep the button's space so
      // a card with a short description stays the same height as the rest of the row.
      document.querySelectorAll(".card .desc").forEach(function(p){
        var b=p.parentNode.querySelector(".desc-more");
        if(b && p.scrollHeight <= p.clientHeight + 1) b.classList.add("off");
      });
    })();
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
