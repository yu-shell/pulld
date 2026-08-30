// A regression test for one defect, found on 2026-08-30 during the weekly quality sweep: filling in
// an empty field reported a line as removed that had never existed.
//
// `splitLines` fed the text straight to `String.prototype.split`, and splitting "" yields [""] — one
// empty line rather than no lines at all. So an empty `before` was diffed as a document containing a
// single blank line, and going from empty to "hello" came out as "1 line added, 1 line removed",
// with a phantom row a screen reader announced as "Removed line:".
//
// That is not an exotic input. Empty-to-filled is most of what the component's own use cases are:
// a config value that was unset, a record field left blank in an admin panel, the first revision of
// a document. The fix is that an empty text has no lines, which also makes `before={undefined}` from
// a JS call site mean "nothing was there" rather than "there was a blank line".
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { DiffView } = loadComponent(join(ROOT, "registry", "ui", "diff-view.tsx"))

/** The sr-only caption, which is where the added/removed counts are stated. */
const caption = (props) => {
  const node = walk(render(DiffView, props).tree).find((n) => n.type === "caption")
  return node ? node.props.children : null
}

/** Every row, as the text of its cells — the sign column and the sr-only prefix included. */
const rows = (props) => {
  const flat = (x) =>
    Array.isArray(x)
      ? x.map(flat).join("")
      : x && typeof x === "object"
        ? flat(x.props?.children)
        : String(x ?? "")
  return byTag(walk(render(DiffView, props).tree), "tr").map((tr) =>
    byTag(walk(tr), "td").map((td) => flat(td.props.children))
  )
}

test("filling in an empty text adds lines without removing one", () => {
  assert.equal(caption({ before: "", after: "hello" }), "Differences: 1 line added, 0 lines removed.")
  assert.equal(caption({ before: "", after: "a\nb\nc" }), "Differences: 3 lines added, 0 lines removed.")

  const only = rows({ before: "", after: "hello" })
  assert.equal(only.length, 1, "one row, not a removal paired with an insertion")
  assert.match(only[0].join(" "), /Added line: hello/)
  assert.doesNotMatch(only[0].join(" "), /Removed line/, "nothing was there to remove")
})

test("clearing a text removes its lines without adding one", () => {
  assert.equal(caption({ before: "hello", after: "" }), "Differences: 0 lines added, 1 line removed.")
})

test("a missing text is treated as empty rather than as a blank line", () => {
  assert.equal(caption({ before: undefined, after: "hi" }), "Differences: 1 line added, 0 lines removed.")
  assert.equal(caption({ before: "", after: "" }), null, "two empty texts are still no change")
})

test("a text that really is one blank line keeps counting as one", () => {
  // The distinction the fix turns on: "" is no content, "\n" is a document holding a blank line.
  assert.equal(caption({ before: "\n", after: "x" }), "Differences: 1 line added, 1 line removed.")
  assert.equal(caption({ before: "a\n\n", after: "a" }), "Differences: 0 lines added, 1 line removed.")
})

test("an ordinary diff is unchanged", () => {
  assert.equal(caption({ before: "a\nb\nc", after: "a\nB\nc" }), "Differences: 1 line added, 1 line removed.")
  assert.equal(caption({ before: "a\nb", after: "a\nb" }), null, "identical texts show the empty message")
  // A trailing newline is an artefact of writing the file, not a change to it.
  assert.equal(caption({ before: "a\nb", after: "a\nb\n" }), null)
  // Folding CRLF is what keeps a line-ending change from reporting every line as rewritten.
  assert.equal(caption({ before: "a\r\nb", after: "a\nb" }), null)
})
