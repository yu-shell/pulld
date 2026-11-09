// What the fetch report is *about*.
//
// `fetches` is not one row type (scripts/_installs.mjs), and report.mjs used to say so twice: once
// through isRewardItem, in the session report, and once as its own SQL — `AND item NOT IN
// ('registry','index')` — in the per-item table above it. The second copy was already out of step,
// so a Pro request DENIED for want of a licence was listed as a component somebody installed. These
// tests hold the report to the one shared rule, and to the funnel the moved rows now feed.
//
// Importing report.mjs at all is only possible because of its `import.meta.url === argv[1]` guard;
// without it this file would shell out to `npx wrangler` against the live D1 four times.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  partitionFetchRows,
  proFunnel,
  nameWidth,
  clientRows,
  shortUa,
  UA_COLUMN,
} from "../scripts/report.mjs"

const CLI = "shadcn/2.1.0" // an install client
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
const CRAWLER = "curl/8.4.0"

test("a denied Pro request is not a component somebody installed", () => {
  const { components, pro } = partitionFetchRows([
    { item: "copy-button", ua: CLI, n: 3 },
    { item: "pro/dashboard-overview:402", ua: BROWSER, n: 1 },
  ])
  assert.deepEqual(
    components.map((r) => r.item),
    ["copy-button"]
  )
  assert.deepEqual(
    pro.map((r) => r.item),
    ["pro/dashboard-overview:402"]
  )
})

test("a served Pro block is kept out of the per-item table too", () => {
  const { components, pro } = partitionFetchRows([{ item: "pro/dashboard-overview", ua: CLI, n: 2 }])
  assert.deepEqual(components, [])
  assert.equal(pro.length, 1)
})

// The half that had not drifted — held here so the shared rule cannot be swapped for a narrower one.
test("the catalogue indexes belong to neither table", () => {
  const { components, pro } = partitionFetchRows([
    { item: "registry", ua: CLI, n: 9 },
    { item: "index", ua: CLI, n: 7 },
    { item: "kbd", ua: CLI, n: 1 },
  ])
  assert.deepEqual(
    components.map((r) => r.item),
    ["kbd"]
  )
  assert.deepEqual(pro, [])
})

test("rows are partitioned by the shared rule, not by a second copy of it", async () => {
  const { isRewardItem } = await import("../scripts/_installs.mjs")
  const items = ["copy-button", "registry", "index", "pro/x", "pro/x:402", "kbd"]
  const { components } = partitionFetchRows(items.map((item) => ({ item, ua: CLI, n: 1 })))
  assert.deepEqual(
    components.map((r) => r.item),
    items.filter(isRewardItem)
  )
})

test("a missing or malformed row set is survivable", () => {
  assert.deepEqual(partitionFetchRows(), { components: [], pro: [] })
  assert.deepEqual(partitionFetchRows([{}, { item: null }]), { components: [], pro: [] })
})

test("both sides of the gate are counted for one block, from people only", () => {
  const [block] = proFunnel([
    { item: "pro/dashboard-overview:402", ua: BROWSER, n: 1 },
    { item: "pro/dashboard-overview:402", ua: CRAWLER, n: 3 },
    { item: "pro/dashboard-overview", ua: CLI, n: 2 },
    { item: "pro/dashboard-overview", ua: CRAWLER, n: 4 },
  ])
  assert.deepEqual(block, { name: "dashboard-overview", served: 2, denied: 1, automated: 7 })
})

// A crawler walking /r/pro/ is the one thing this table must never read as demand: it is the only
// place a request that reached a paywall is counted, and 402s are mostly automated.
test("a block only crawlers asked for shows no attempt to buy", () => {
  const [block] = proFunnel([{ item: "pro/ghost:402", ua: CRAWLER, n: 12 }])
  assert.deepEqual(block, { name: "ghost", served: 0, denied: 0, automated: 12 })
})

test("blocks are ranked by the requests people made, not by total traffic", () => {
  const ranked = proFunnel([
    { item: "pro/noisy:402", ua: CRAWLER, n: 99 },
    { item: "pro/wanted:402", ua: BROWSER, n: 2 },
  ])
  assert.deepEqual(
    ranked.map((b) => b.name),
    ["wanted", "noisy"]
  )
})

test("nothing to report is an empty list, not a row of zeroes", () => {
  assert.deepEqual(proFunnel([]), [])
  assert.deepEqual(proFunnel(), [])
  assert.deepEqual(proFunnel([{ item: "copy-button", ua: CLI, n: 5 }]), [])
})

// The first column of every table in report.mjs is followed immediately by a tab-separated count,
// so a name as wide as the column runs that count into itself and the row stops being readable.
// The Pro table learned this from `pro/dashboard-overview:4020`; the components and misses tables
// kept a `padEnd(22)` that `unsaved-changes-guard` (21) was one character short of. These pin the
// rule in the shared helper so a fourth table cannot re-introduce a constant.
test("a name as long as the column still leaves a gap before the count", () => {
  const w = nameWidth("item", ["keyboard-shortcuts-sheet"])
  assert.ok("keyboard-shortcuts-sheet".padEnd(w).endsWith("  "))
  assert.equal(w, "keyboard-shortcuts-sheet".length + 2)
})

test("the width is taken from the longest name, not from the first or the last", () => {
  assert.equal(nameWidth("item", ["kbd", "unsaved-changes-guard", "qr-code"]), 23)
})

test("the header is a floor, so a table of short names is not narrower than its own heading", () => {
  assert.equal(nameWidth("crawler", ["kbd"]), "crawler".length + 2)
})

// The miss list prints whatever name a client guessed at, and /r/<name>.json bounds that nowhere.
test("an unbounded miss name widens the column instead of colliding with it", () => {
  const long = "a".repeat(120)
  const w = nameWidth("name", ["kbd", long])
  assert.equal(w, 122)
  assert.ok(long.padEnd(w).endsWith("  "))
})

test("an empty table falls back to the header width rather than -Infinity", () => {
  assert.equal(nameWidth("block", []), "block".length + 2)
  assert.ok(Number.isFinite(nameWidth("item", [])))
})

// --- who the fetches came from ---
//
// The client table is the one place the report says whether `install=31` is thirty-one decisions
// or one mirror repeating itself, and it can only say that while the user-agent printed beside a
// count identifies the client the count belongs to.
//
// It used to key a client on `${kind}\t${ua.slice(0, 40)}` and take the pair apart again with
// `key.split("\t")` destructured into two, which breaks on a user-agent that holds a tab — legal
// in an HTTP field value (RFC 9110 §5.5), stored verbatim by functions/r/[[path]].js, and enough
// to print two different clients as the same name.
const MCP_V2 = "@shadcn/mcp\tv2"
const MCP_V3 = "@shadcn/mcp\tv3"

test("a tab in a user-agent is part of the name, not the end of it", () => {
  const rows = clientRows([
    { item: "copy-button", ua: MCP_V2, n: 3 },
    { item: "kbd", ua: MCP_V3, n: 1 },
  ])
  assert.deepEqual(rows, [
    { kind: "install", ua: MCP_V2, n: 3 },
    { kind: "install", ua: MCP_V3, n: 1 },
  ])
  // The failure this replaces: both rows reported as the name they share up to the tab.
  assert.notEqual(rows[0].ua, rows[1].ua)
  for (const r of rows) assert.ok(r.ua.includes("\t"), "the stored user-agent was cut at the tab")
})

test("the kind travels beside the name rather than inside it", () => {
  // The kind is _traffic.js's verdict on the user-agent and nothing a user-agent says about itself
  // can change it. Flattened, the two were the same string: `install\tshadcn/2.1.0\tindex` read
  // back as kind `install` and a name cut to `shadcn/2.1.0`, with the rest of it — the part a
  // reader would use to tell this client from the next — gone. Kept apart, the verdict is the
  // verdict and the name is whole.
  const rows = clientRows([
    { item: "kbd", ua: "shadcn-helper-intellij-plugin/1.4", n: 20 },
    { item: "kbd", ua: "shadcn/2.1.0\tindex", n: 2 },
  ])
  assert.deepEqual(rows, [
    { kind: "index", ua: "shadcn-helper-intellij-plugin/1.4", n: 20 },
    { kind: "install", ua: "shadcn/2.1.0\tindex", n: 2 },
  ])
})

test("clients are grouped by the whole user-agent, not by the part that fits the column", () => {
  // Two clients alike for the first 60 characters. Truncating before grouping summed them into one
  // row of 5; they are two clients and two rows.
  const base = "shadcn-mcp/1.0 ".repeat(4) // 60 chars
  const rows = clientRows([
    { item: "copy-button", ua: `${base}alpha`, n: 2 },
    { item: "copy-button", ua: `${base}beta`, n: 3 },
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.n), [3, 2])
})

test("the same client over several items is one row carrying the total", () => {
  const rows = clientRows([
    { item: "copy-button", ua: CLI, n: 4 },
    { item: "kbd", ua: CLI, n: 6 },
  ])
  assert.deepEqual(rows, [{ kind: "install", ua: CLI, n: 10 }])
})

test("only the two kinds the table is about are listed", () => {
  // A browser is `human` and a crawler is `crawler`; neither belongs in a table of install clients
  // and catalogue mirrors, and the per-item columns above already carry them.
  const rows = clientRows([
    { item: "kbd", ua: BROWSER, n: 9 },
    { item: "kbd", ua: CRAWLER, n: 9 },
    { item: "kbd", ua: "", n: 9 },
    { item: "kbd", ua: CLI, n: 1 },
  ])
  assert.deepEqual(rows, [{ kind: "install", ua: CLI, n: 1 }])
})

test("busiest first, and ties in a fixed order so one window prints one table", () => {
  const rows = clientRows([
    { item: "kbd", ua: "shadcn/2", n: 1 },
    { item: "kbd", ua: "shadcn/1", n: 1 },
    { item: "kbd", ua: "shadcn-helper/9", n: 1 },
    { item: "kbd", ua: "@shadcn/mcp", n: 7 },
  ])
  assert.deepEqual(
    rows.map((r) => [r.kind, r.ua]),
    [
      ["install", "@shadcn/mcp"],
      ["index", "shadcn-helper/9"],
      ["install", "shadcn/1"],
      ["install", "shadcn/2"],
    ]
  )
})

test("a malformed or missing row set is survivable, like partitionFetchRows", () => {
  assert.deepEqual(clientRows(), [])
  assert.deepEqual(clientRows(null), [])
  assert.deepEqual(clientRows([{}, { ua: null }, { ua: CRAWLER }]), [])
  // A count that is not a number is 0, not NaN — the sort is by it.
  assert.deepEqual(clientRows([{ ua: CLI, n: "x" }]), [{ kind: "install", ua: CLI, n: 0 }])
})

// Bounding the name is the printer's job now, and a bounded name says that it was bounded — two
// rows ending in `…` are visibly an abbreviation rather than silently the same client twice.
test("a user-agent that fits the column is printed whole", () => {
  assert.equal(shortUa(CLI), CLI)
  const exact = "a".repeat(UA_COLUMN - 2)
  assert.equal(shortUa(exact), exact)
  assert.ok(exact.padEnd(UA_COLUMN).endsWith("  "), "no gap left before the count")
})

test("a longer one is cut to the column and marked", () => {
  const long = "shadcn-mcp/" + "9".repeat(80)
  const shown = shortUa(long)
  assert.equal(shown.length, UA_COLUMN - 2)
  assert.ok(shown.endsWith("\u2026"))
  assert.ok(long.startsWith(shown.slice(0, -1)))
  assert.ok(shown.padEnd(UA_COLUMN).endsWith("  "))
})
