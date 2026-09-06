// ratio-bar draws one bar split into parts and a legend that names them, and the two things worth
// pinning here are both invisible to a reader of the source:
//
// The percentages must total exactly 100. Rounding each part on its own is the defect the
// component exists to avoid — three equal parts come out 33/33/33 and a reader who adds them up
// finds 99 — so the apportionment is by largest remainder, and the property that makes it correct
// is a sum, not any individual number. A sum is also what a refactor breaks without changing any
// single value enough to look wrong.
//
// And `formatValue` is declared to return a `ReactNode`. It used to be interpolated into a
// template string, so a caller who returned an element — which the type invites — got
// "[object Object] (25%)" on screen while TypeScript raised nothing. That is the failure mode a
// type annotation cannot catch on its own: the signature and the implementation disagreed, and
// only the rendered output says which one was lying.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { RatioBar, ratioPercents } = loadComponent(join(ROOT, "registry", "ui", "ratio-bar.tsx"))

/** The text of a node as the DOM would read it, children and all. */
function text(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out
  if (Array.isArray(node)) {
    node.forEach((child) => text(child, out))
    return out
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node))
    return out
  }
  if (typeof node === "object") return text(node.props?.children, out)
  return out
}

const legend = (tree) =>
  walk(tree)
    .filter((n) => n.type === "li")
    .map((li) => text(li).join(""))

const PARTS = [
  { label: "Images", value: 1 },
  { label: "Video", value: 3 },
]

// --- apportionment ----------------------------------------------------------

test("percentages total exactly 100, however the parts divide", () => {
  const sets = [
    [1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1],
    [1, 2, 3, 4, 5, 6, 7],
    [99.99, 0.01],
    [5, 0, 5],
    [1e-9, 1],
    [2, 2, 2, 1],
  ]
  for (const values of sets) {
    for (const precision of [0, 1, 2]) {
      const percents = ratioPercents(values, precision)
      const sum = percents.reduce((a, b) => a + b, 0)
      assert.ok(
        Math.abs(sum - 100) < 1e-9,
        `${JSON.stringify(values)} at precision ${precision} summed to ${sum}, not 100`
      )
    }
  }
})

test("three equal parts read 34/33/33 rather than 33/33/33", () => {
  assert.deepEqual(ratioPercents([1, 1, 1]), [34, 33, 33])
})

test("a part worth nothing is never rounded up into existence", () => {
  assert.deepEqual(ratioPercents([5, 0, 5]), [50, 0, 50])
  assert.deepEqual(ratioPercents([0, 0, 0]), [0, 0, 0])
})

test("negative, NaN and Infinity contribute nothing instead of poisoning the bar", () => {
  assert.deepEqual(ratioPercents([-5, 10]), [0, 100])
  assert.deepEqual(ratioPercents([NaN, 1, 2]), [0, 33, 67])
  assert.deepEqual(ratioPercents([Infinity, 1]), [0, 100])
})

test("ties fall to the earlier part, so the server and the browser agree", () => {
  // Nothing about the input distinguishes the three, so an unstable comparator would be free to
  // hand the spare point to a different one on each render.
  for (let i = 0; i < 20; i++) assert.deepEqual(ratioPercents([1, 1, 1]), [34, 33, 33])
})

// --- what the legend says ---------------------------------------------------

test("a share rounded to nothing reads <1%, and one rounded to everything reads >99%", () => {
  // Both are lies about a part that is neither, and both still have to leave the column at 100.
  assert.deepEqual(
    legend(render(RatioBar, { parts: [{ label: "A", value: 0.01 }, { label: "B", value: 99.99 }] }).tree),
    ["A<1%", "B>99%"]
  )
})

test("`total` adds the unused capacity as its own legend row", () => {
  assert.deepEqual(
    legend(render(RatioBar, { parts: PARTS, total: 8, formatValue: (v) => `${v} GB` }).tree),
    ["Images1 GB (12%)", "Video3 GB (38%)", "Free4 GB (50%)"]
  )
})

test("remainderLabel={null} draws the gap without listing it", () => {
  assert.deepEqual(
    legend(render(RatioBar, { parts: PARTS, total: 8, remainderLabel: null }).tree),
    ["Images12%", "Video38%"]
  )
})

// --- the formatValue contract ----------------------------------------------

test("a string formatValue renders beside the share", () => {
  assert.deepEqual(
    legend(render(RatioBar, { parts: PARTS, formatValue: (v) => `${v} GB` }).tree),
    ["Images1 GB (25%)", "Video3 GB (75%)"]
  )
})

test("an element formatValue renders its content, not [object Object]", () => {
  const strong = (children) => ({
    $$typeof: Symbol.for("react.element"),
    type: "strong",
    props: { children },
    key: null,
    ref: null,
  })
  const rows = legend(render(RatioBar, { parts: PARTS, formatValue: (v) => strong(`${v} GB`) }).tree)
  assert.deepEqual(rows, ["Images1 GB (25%)", "Video3 GB (75%)"])
  for (const row of rows) assert.doesNotMatch(row, /\[object Object\]/)
})

// --- accessibility ----------------------------------------------------------

test("the bar is hidden from assistive technology, because the legend carries every number", () => {
  const tree = render(RatioBar, { parts: PARTS, "aria-label": "Storage by file type" }).tree
  const bar = walk(tree).find((n) => typeof n.props?.className === "string" && n.props.className.includes("rounded-full"))
  assert.equal(bar.props["aria-hidden"], "true")
})

test("showLegend={false} keeps the legend for screen readers rather than dropping it", () => {
  const tree = render(RatioBar, { parts: PARTS, showLegend: false }).tree
  const list = walk(tree).find((n) => n.type === "ul")
  assert.match(list.props.className, /sr-only/)
  // Still every part — hidden is not the same as absent.
  assert.equal(legend(tree).length, 2)
})
