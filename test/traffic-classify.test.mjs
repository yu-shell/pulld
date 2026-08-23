// Unit tests for the traffic classifier (functions/_traffic.js).
//
// This is not cosmetic bookkeeping: `isInstall` is the bandit reward in learn.mjs and the
// prioritisation input in sweep.mjs, so a client on the wrong side of this line makes the loop
// tune component metadata against scraper traffic. The cases below are drawn from real
// user-agents in the D1 fetch log, including the two that the previous regex let through as
// "clean" (`node`, `shadcn-helper-intellij-plugin/1.0`) and the crawlers that must not be
// confused with the shadcn CLI (`Mozilla/5.0 shadcn-audit`, `shadcn-registry-indexer/0.1`).
import { test } from "node:test"
import assert from "node:assert/strict"
import { classify, classifyClick, isCrawler, isInstall } from "../functions/_traffic.js"

test("crawlers: indexers, scrapers and generic HTTP clients", () => {
  for (const ua of [
    "curio-harvest/0.1 (+https://github.com/curio-mcp/curio; build-time catalogue indexer)",
    "curio-registry-profiler/0.1 (+research; contact someone@example.com)",
    "curio-preview (+https://github.com/curio)",
    "curio-audit/1.0",
    "design-scout/0.1 (+local indexer)",
    "sh4dcn-directory-enricher (+https://sh4dcn.vercel.app)",
    "shadcn-registry-indexer/0.1",
    "shadcn-page-template-audit/1.0",
    "Mozilla/5.0 shadcn-audit",
    "Mozilla/5.0 registry-research",
    "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
    "Googlebot/2.1",
    "python-requests/2.32.5",
    "curl/8.7.1",
    "node", // the largest "clean" client in the log until this classifier existed
    "node-fetch",
    "undici",
  ]) {
    assert.equal(classify(ua), "crawler", ua)
    assert.equal(isCrawler(ua), true, ua)
    assert.equal(isInstall(ua), false, ua)
  }
})

test("install clients: the CLI and MCP servers count as installs", () => {
  for (const ua of ["shadcn", "shadcn/2.1.0", "pulld-mcp/0.1"]) {
    assert.equal(classify(ua), "install", ua)
    assert.equal(isInstall(ua), true, ua)
  }
})

test("catalogue mirrors are their own bucket and are NOT reward", () => {
  // The IntelliJ plugin fetched every component exactly 20 times over 40 days — one client
  // mirroring the catalogue. Counting that as reward would drown the real CLI installs.
  const ua = "shadcn-helper-intellij-plugin/1.0"
  assert.equal(classify(ua), "index")
  assert.equal(isInstall(ua), false)
})

test("humans: browsers", () => {
  for (const ua of [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
  ]) {
    assert.equal(classify(ua), "human", ua)
    assert.equal(isInstall(ua), true, ua)
  }
})

test("a Mozilla costume without a rendering engine is not a person", () => {
  // The single largest source of fake reward in the log: 45 fetches from a bare `Mozilla/5.0`,
  // which arrived as two 0.2-second bursts of 22 different component names. A person does not
  // type 22 names for one component, and no browser omits its engine.
  for (const ua of [
    "Mozilla/5.0",
    "Mozilla/5.0 (compatible)",
    "Mozilla/5.0 (compatible; ContextLayerRegistryAudit/1.0)",
  ]) {
    assert.equal(classify(ua), "crawler", ua)
    assert.equal(isInstall(ua), false, ua)
  }
})

test("named automation is not reward, whatever it calls itself", () => {
  // Every one of these was counted as an install before: none names itself a bot, and none
  // carries the `(+url)` marker, so only the job word in the name gives them away.
  for (const ua of [
    "registry.directory-health/1.0",
    "Portal-Fizgo-readonly-recon/1.0",
    "curio-spike/1.0",
    "shadcn-cli-probe",
    "ContextLayerRegistryAudit/1.0",
  ]) {
    assert.equal(classify(ua), "crawler", ua)
    assert.equal(isInstall(ua), false, ua)
  }
})

test("a directory crawling us is not the CLI installing from us", () => {
  // `ShadCN Directory Search/1.1` fetched registry.json and nothing else, but the old rule let
  // any UA *starting* with "shadcn " count as an install.
  const ua = "ShadCN Directory Search/1.1"
  assert.equal(classify(ua), "crawler")
  assert.equal(isInstall(ua), false)
})

test("an unrecognised client is not counted as reward", () => {
  // Deliberate asymmetry: ignoring a real developer costs one data point, counting a script
  // teaches the loop to chase scrapers. New install clients go in INSTALL_UA, not here.
  for (const ua of ["Convex/1.0", "m", "SomeFutureThing/2.0"]) {
    assert.equal(classify(ua), "crawler", ua)
    assert.equal(isInstall(ua), false, ua)
  }
})

test("a missing user-agent is a crawler, not a human", () => {
  // Every real browser and CLI sends one; an empty UA is an anonymous script.
  for (const ua of ["", null, undefined]) {
    assert.equal(classify(ua), "crawler", String(ua))
    assert.equal(isInstall(ua), false, String(ua))
  }
})

test("crawler wins over tool when a user-agent looks like both", () => {
  // `Mozilla/5.0 shadcn-audit` contains the tool name but is an auditor: order matters.
  assert.equal(classify("Mozilla/5.0 shadcn-audit"), "crawler")
  assert.equal(classify("shadcn-registry-indexer/0.1"), "crawler")
})

// The buy-button click log. `classify` alone cannot answer this one: the user-agents below are
// genuine browser strings, engine and all, so the UA test correctly calls them human. What gives
// them away is that they never loaded the page the button lives on.
const PIXEL = "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36"

test("a click that came from the landing page is a person", () => {
  assert.equal(classifyClick({ ua: PIXEL, referer: "https://pulld.pages.dev/" }), "human")
  assert.equal(
    classifyClick({
      ua: PIXEL,
      referer: "https://pulld.pages.dev/?utm_source=ui.shadcn.com&utm_medium=referral&utm_campaign=directory",
    }),
    "human"
  )
})

test("a browser user-agent with no referrer never loaded the page — not a person", () => {
  // The 2026-08-23 pattern: six search/pro pairs 0-1s apart, all from this UA, none with a
  // referrer. Counting these as people made a traffic problem look like a conversion problem.
  for (const referer of ["", null, undefined, "   "]) {
    assert.equal(classifyClick({ ua: PIXEL, referer }), "direct")
  }
})

test("a declared crawler stays a crawler even when it sends a referrer", () => {
  assert.equal(
    classifyClick({ ua: "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/bot)", referer: "https://pulld.pages.dev/" }),
    "crawler"
  )
  assert.equal(classifyClick({ ua: "Googlebot/2.1 (+http://www.google.com/bot.html)", referer: "" }), "crawler")
})

test("no user-agent at all is never a person, referrer or not", () => {
  assert.equal(classifyClick({ ua: "", referer: "https://pulld.pages.dev/" }), "crawler")
  assert.equal(classifyClick({}), "crawler")
})
