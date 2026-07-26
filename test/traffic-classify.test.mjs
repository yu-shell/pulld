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
import { classify, isCrawler, isInstall } from "../functions/_traffic.js"

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
  const chrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
  assert.equal(classify(chrome), "human")
  assert.equal(isInstall(chrome), true)
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
