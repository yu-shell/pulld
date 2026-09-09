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
import { partitionFetchRows, proFunnel } from "../scripts/report.mjs"

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
