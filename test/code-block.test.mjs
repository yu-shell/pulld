// The panel scrolls sideways and contains nothing focusable, which is the shape that quietly locks
// keyboard users out of the right-hand end of a long line (WCAG 2.1.1, axe's
// scrollable-region-focusable). That is what the first case is here to keep true.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const copied = []
const { CodeBlock } = loadComponent(join(ROOT, "registry", "ui", "code-block.tsx"), {
  stubs: {
    "@/registry/ui/copy-button": {
      CopyButton: (props) => {
        copied.push(props.value)
        return null
      },
    },
  },
})

const nodesFor = (props) => walk(render(CodeBlock, props).tree)

test("the scrolling panel is a tab stop, since nothing inside it is one", () => {
  const pre = byTag(nodesFor({ code: "npm i pulld" }), "pre")[0]
  assert.equal(pre.props.tabIndex, 0)
  assert.match(pre.props.className, /overflow-x-auto/)
  assert.match(pre.props.className, /focus-visible:ring-2/, "a tab stop with no visible focus is half a fix")
})

test("the code is rendered verbatim in semantic markup, with the language on the element", () => {
  const nodes = nodesFor({ code: "SELECT 1;", language: "sql" })
  const code = byTag(nodes, "code")[0]
  assert.equal(code.props.children, "SELECT 1;")
  assert.equal(code.props["data-language"], "sql")
  assert.equal(byTag(nodes, "pre").length, 1)
})

test("the language label appears only when there is a language to show", () => {
  const withLanguage = nodesFor({ code: "x", language: "ts" })
  assert.ok(withLanguage.some((n) => n.props?.children === "ts"))

  const without = nodesFor({ code: "x" })
  const code = byTag(without, "code")[0]
  assert.equal(code.props["data-language"], undefined)
  assert.equal(
    byTag(without, "span").length,
    0,
    "an empty label would still take the padding reserved for it"
  )
})

test("the copy button is handed the same string the panel shows", () => {
  copied.length = 0
  nodesFor({ code: "curl https://example.test" })
  assert.deepEqual(copied, ["curl https://example.test"])
})
