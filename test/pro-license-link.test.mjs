// The 402 body's "Get a license at …" link, checked against the page it points at.
//
// This is the only call to action the Pro paywall ever makes, and it is made to the most qualified
// reader this project has: somebody who ran `shadcn add` on a Pro block and was refused.
// scripts/report.mjs counts exactly those requests as "an install that hit the paywall — the top of
// the buy funnel". Nothing in the project checked where the link went.
//
// It went to `https://pulld.pages.dev/pro`, a path this project does not serve. It looked fine
// because Pages substitutes index.html for an unknown asset: measured against production, /pro
// answers 200 with 692 KB of the landing page. So the link resolved by accident of the same
// fallback functions/r/[[path]].js has a whole branch to stop handing out, landed the reader at the
// top of the catalogue rather than on the offer, and was one 404.html away from being a dead link —
// with no signal anywhere, because a 200 is a 200.
//
// Two halves have to agree for the fixed link to work, and they are in different trees:
// functions/_pro-gate.js names a fragment, scripts/build-landing.mjs puts that `id` on the Pro
// section's heading. They cannot share a constant the way scripts/_landing-markup.mjs holds the
// markers build-landing.mjs and verify-registry.mjs both need — this module is bundled into the
// deployed Cloudflare Function, so it must not import anything from scripts/. So the agreement is
// pinned here instead: the fragment is read out of the real 402 body and looked for in the real
// generated page, and either side moving alone fails this file.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { handleProGet } from "../functions/_pro-gate.js"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BLOCKS = { "dashboard-overview": { name: "dashboard-overview" } }

// No key and no D1 binding: the gate fails closed to 402, which is the response under test. With
// no DB the fetch log returns before it would need waitUntil, so nothing is left pending.
async function denial(origin = "https://pulld.pages.dev") {
  const res = await handleProGet(
    {
      request: new Request(`${origin}/r/pro/dashboard-overview.json`, {
        headers: { "user-agent": "shadcn/2.4.0" },
      }),
      env: {},
      waitUntil: () => {},
    },
    BLOCKS
  )
  assert.equal(res.status, 402)
  return (await res.json()).message
}

/** The one absolute URL the 402 message offers. */
async function licenseLink(origin) {
  const message = await denial(origin)
  const found = message.match(/https?:\/\/\S*[^\s.)]/)?.[0]
  assert.ok(found, `the 402 message offers no link to buy from: ${message}`)
  return new URL(found)
}

test("the 402 points at the landing page's Pro section, not at an unserved path", async () => {
  const link = await licenseLink()
  // The regression. /pro is not a route here; it only ever resolved because Pages serves
  // index.html for an unknown asset under status 200.
  assert.notEqual(link.pathname, "/pro", "the 402 is back to pointing at a path nothing serves")
  assert.equal(link.pathname, "/", "the license link is no longer the landing page")
  assert.equal(link.hash, "#pro", "the link no longer lands on the Pro section")
})

// Not /go/pro, the tracked checkout redirect, although that is the link the landing page's own buy
// button uses. functions/_traffic.js only counts a /go/* click as a person when it arrives carrying
// the landing page as its referrer, because "the buy buttons exist on exactly one page and are
// published nowhere else" — publishing one in an API response is precisely the syndication that
// comment names as the thing that would have to be taught to the classifier first. Until then a
// buyer sent straight to /go/pro arrives with no referrer and is reported as `direct`, which the
// report prints as "a script wearing a browser user-agent".
test("the 402 does not syndicate the tracked checkout link", async () => {
  const link = await licenseLink()
  assert.equal(
    link.pathname.startsWith("/go/"),
    false,
    "the 402 now sends buyers through /go/*, where they arrive with no referrer and are counted as scripts"
  )
})

// Derived from the request, the way functions/r/[[path]].js builds the registry URL for its own 404
// body. A hardcoded origin sends everybody who hits the paywall on a preview deploy to production.
test("the link names the deploy that served the 402", async () => {
  for (const origin of ["https://pulld.pages.dev", "https://abc123.pulld.pages.dev"]) {
    assert.equal((await licenseLink(origin)).origin, origin)
  }
})

// The other half: the anchor the link relies on has to exist on the page that is actually shipped.
// Built here rather than read off public/index.html as it stands, for the reason
// test/landing-cards.test.mjs gives — a stale artifact looks exactly as correct as a current one.
//
// Skipped without pro/registry.json, like the pro assertions in test/landing-cards.test.mjs: the
// Pro section only renders when that file is present, and a checkout without it has no Pro blocks
// for the gate to refuse either.
test("the landing page carries the anchor the 402 links to", async (t) => {
  if (!existsSync(join(ROOT, "pro", "registry.json"))) {
    return t.skip("no pro registry on this machine")
  }
  const fragment = (await licenseLink()).hash.slice(1)
  execFileSync("node", [join(ROOT, "scripts", "build-landing.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
  })
  const html = readFileSync(join(ROOT, "public", "index.html"), "utf8")
  assert.match(
    html,
    new RegExp(`id="${fragment}"`),
    `the 402 links to #${fragment} but the generated page has no element with that id — ` +
      `the link lands at the top of the catalogue instead of on the offer`
  )
})
