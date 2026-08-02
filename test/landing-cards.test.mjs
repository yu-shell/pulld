// The landing page clamps every component description to two lines and moves the full text into a
// dialog. Two things about that are worth pinning down.
//
// The first is the reason the page exists at all: descriptions are written long because they are
// what an agent matches against, so the clamp has to be presentational only. If someone ever
// "fixes" the height by truncating in the generator instead of in CSS, the page still looks right
// while quietly shedding the text the registry is optimised for — a regression with no visible
// symptom. The full-text assertion below is the guard.
//
// The second is that the uniform row height depends on a fixed-height clamp rather than a capped
// one, and on the trigger being positioned over the last line rather than sitting on its own row.
// Both are easy to undo by accident while restyling.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT = join(ROOT, "public", "index.html")

// Build the page the same way `npm run registry:build` does, so the test reads real output rather
// than a stale artifact. The generator writes to public/index.html, which is a build product.
execFileSync("node", [join(ROOT, "scripts", "build-landing.mjs")], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 60000,
})
const html = readFileSync(OUT, "utf8")
const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

test("every description reaches the page in full, clamped only by CSS", () => {
  const missing = registry.items
    .filter((it) => it.description)
    .filter((it) => !html.includes(esc(it.description)))
    .map((it) => it.name)
  assert.deepEqual(missing, [], "a description was shortened before it reached the HTML")
})

test("each component card carries a clamped description and a way to open the rest", () => {
  const cards = html.match(/<article class="card"[\s\S]*?<\/article>/g) ?? []
  assert.equal(cards.length, registry.items.length)
  for (const card of cards) {
    const name = card.match(/id="c-([^"]+)"/)?.[1]
    assert.match(card, /<p class="desc">/, `${name}: description is not the clamped paragraph`)
    assert.match(card, /class="desc-more"/, `${name}: no trigger to open the full text`)
    // The trigger's visible label is "… more", so the accessible name has to come from aria-label.
    assert.match(
      card,
      /class="desc-more" aria-label="Read the full description of [^"]+"/,
      `${name}: trigger has no accessible name`
    )
  }
})

test("the dialog the trigger opens is a labelled, modal dialog", () => {
  assert.match(html, /id="dd-overlay"/)
  assert.match(html, /class="pp-modal dd-modal" role="dialog" aria-modal="true" aria-labelledby="dd-title"/)
  assert.match(html, /id="dd-title"/)
  assert.match(html, /id="dd-body"/)
  assert.match(html, /id="dd-close"[^>]*aria-label="Close description"/)
})

test("the clamp is a fixed two lines, so every row lands on the same height", () => {
  assert.match(html, /-webkit-line-clamp:2/, "the two-line clamp is gone")
  assert.match(
    html,
    /\.card p\.desc\{[^}]*height:calc\(2 \* 1\.6 \* 14\.5px\)/,
    "the description box is no longer a fixed height — short descriptions will shrink their card"
  )
  assert.match(
    html,
    /\.desc-more\{position:absolute/,
    "the trigger left the last line and is costing every card another row"
  )
  assert.match(html, /\.desc-more\.off\{visibility:hidden\}/, "hiding the trigger now resizes the card")
})

test("the pro card gets the same treatment when the private registry is present", (t) => {
  if (!existsSync(join(ROOT, "pro", "registry.json"))) return t.skip("no pro registry on this machine")
  const pro = html.match(/<article class="card pro">[\s\S]*?<\/article>/g) ?? []
  assert.ok(pro.length > 0)
  for (const card of pro) {
    assert.match(card, /<p class="desc">/)
    assert.match(card, /class="desc-more"/)
  }
})
