// Printing a region is a feature whose failures all land on paper, after the dialog has closed and
// the person has walked to the printer. Nothing throws, the sheet looks finished, and what is wrong
// with it is what is missing. So the cases here are written against the specific wrong versions:
//   - a srcdoc frame with no <base>, where every relative image on the sheet quietly 404s,
//   - a clone of a filled-in form, which serialises back to the empty form it was authored as,
//   - a cloned <canvas>, which is a correctly sized blank rectangle,
//   - ...and the over-correction that lets one tainted canvas throw the whole sheet away,
//   - a cross-origin stylesheet serialised through cssRules, which drops it silently,
//   - default print colour handling, which prints a colour-coded table as white on white,
//   - a scroll box printed at its on-screen height, losing everything below the fold,
//   - a document title taken from the page, which is the "Save as PDF" filename.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

const {
  collectStyleSources,
  freezeFormState,
  freezeCanvases,
  buildPrintableDocument,
  PrintButton,
} = loadComponent(join(ROOT, "registry", "ui", "print-button.tsx"), {
  stubs: { "lucide-react": icons },
})

// --- a fake DOM, only as deep as the three walkers reach --------------------

class FakeNode {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.attrs = new Map()
    this.kids = []
    this.parent = null
    this.className = ""
    this.style = {}
    this.ownerDocument = { createElement: (t) => new FakeImage(t) }
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v))
  }
  removeAttribute(k) {
    this.attrs.delete(k)
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this
      this.kids.push(n)
    }
    return this
  }
  matches(selector) {
    return selector
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .includes(this.tagName)
  }
  querySelectorAll(selector) {
    const out = []
    const visit = (node) => {
      for (const kid of node.kids) {
        if (kid.matches(selector)) out.push(kid)
        visit(kid)
      }
    }
    visit(this)
    return out
  }
  replaceWith(node) {
    const i = this.parent.kids.indexOf(this)
    this.parent.kids[i] = node
    node.parent = this.parent
  }
}

class FakeImage extends FakeNode {}
class FakeInput extends FakeNode {
  constructor(type, value, checked = false) {
    super("input")
    this.type = type
    this.value = value
    this.checked = checked
  }
}
class FakeTextarea extends FakeNode {
  constructor(value) {
    super("textarea")
    this.value = value
    this.textContent = ""
  }
}
class FakeOption extends FakeNode {
  constructor(selected) {
    super("option")
    this.selected = selected
  }
}
class FakeSelect extends FakeNode {
  constructor(options) {
    super("select")
    this.options = options
  }
}
class FakeCanvas extends FakeNode {
  constructor(width, height, tainted = false) {
    super("canvas")
    this.width = width
    this.height = height
    this.tainted = tainted
  }
  toDataURL() {
    if (this.tainted) throw new Error("SecurityError: tainted canvas")
    return `data:image/png;base64,#${this.width}x${this.height}`
  }
}

// `instanceof` is how the component tells the field kinds apart, so the stand-ins have to be
// instances of the names it checks against rather than look-alikes.
globalThis.HTMLInputElement = FakeInput
globalThis.HTMLTextAreaElement = FakeTextarea
globalThis.HTMLSelectElement = FakeSelect
globalThis.HTMLCanvasElement = FakeCanvas

// --- the document that gets printed ----------------------------------------

const minimal = { title: "T", bodyHtml: "<p>x</p>", baseHref: "https://example.test/orders/1041" }

test("relative URLs resolve, because a srcdoc frame has no URL of its own", () => {
  const html = buildPrintableDocument(minimal)
  assert.match(
    html,
    /<base href="https:\/\/example\.test\/orders\/1041">/,
    "without <base> every relative src on the sheet resolves against about:srcdoc and 404s"
  )
})

test("backgrounds are forced on, or a colour-coded table prints white on white", () => {
  const html = buildPrintableDocument(minimal)
  assert.match(html, /print-color-adjust:\s*exact/)
  assert.match(html, /-webkit-print-color-adjust:\s*exact/)
})

test("a scroll box is unclipped, or everything below its fold is missing from the sheet", () => {
  const html = buildPrintableDocument(minimal)
  assert.match(html, /overflow:\s*visible\s*!important/)
  assert.match(html, /max-height:\s*none\s*!important/)
})

test("the frame is recognisable, so a blank about:blank document is never printed", () => {
  const html = buildPrintableDocument(minimal)
  assert.match(html, /data-pulld-print/, "the marker printRegion checks for is missing")
})

test("the title is escaped: it is the Save-as-PDF filename, not markup", () => {
  const html = buildPrintableDocument({ ...minimal, title: 'Acme <script>"x"' })
  assert.match(html, /<title>Acme &lt;script&gt;&quot;x&quot;<\/title>/)
  assert.doesNotMatch(html, /<title>Acme <script>/)
})

test("a href with a quote in it cannot break out of the link attribute", () => {
  const html = buildPrintableDocument({
    ...minimal,
    hrefs: ['https://cdn.test/a.css?x="><script>evil()</script>'],
  })
  assert.doesNotMatch(html, /<script>evil\(\)/)
  assert.match(html, /&quot;&gt;&lt;script&gt;/)
})

test("page CSS is carried over in both of the forms it comes in", () => {
  const html = buildPrintableDocument({
    ...minimal,
    hrefs: ["https://cdn.test/app.css"],
    css: [".invoice{color:red}"],
  })
  assert.match(html, /<link rel="stylesheet" href="https:\/\/cdn\.test\/app\.css">/)
  assert.match(html, /\.invoice\{color:red\}/)
})

test("pageStyle lands after the built-in rules, so a caller can override them", () => {
  const html = buildPrintableDocument({ ...minimal, pageStyle: "@page{margin:0}" })
  assert.ok(
    html.indexOf("@page{margin:0}") > html.indexOf("print-color-adjust"),
    "caller CSS placed before the defaults would be overridden by them instead"
  )
})

test("the page's language and direction travel with the markup", () => {
  const html = buildPrintableDocument({ ...minimal, lang: "ar", dir: "rtl" })
  assert.match(html, /<html lang="ar" dir="rtl">/)
})

// --- which stylesheets get copied, and how ---------------------------------

function fakeDocument({ nodes = [], adopted } = {}) {
  return {
    querySelectorAll: (selector) => nodes.filter((n) => n.matches(selector)),
    adoptedStyleSheets: adopted,
  }
}

const styleNode = (text) => ({ tagName: "STYLE", textContent: text, matches: () => true })
const linkNode = (href) => ({ tagName: "LINK", href, matches: () => true })

test("a cross-origin sheet is linked rather than read, because reading it throws", () => {
  const { hrefs } = collectStyleSources(
    fakeDocument({ nodes: [linkNode("https://fonts.test/x.css")] })
  )
  assert.deepEqual(hrefs, ["https://fonts.test/x.css"])
})

test("inline <style> blocks are inlined", () => {
  const { css } = collectStyleSources(fakeDocument({ nodes: [styleNode(".a{color:red}")] }))
  assert.deepEqual(css, [".a{color:red}"])
})

test("constructable stylesheets are serialised, having no href to copy", () => {
  const sheet = { cssRules: [{ cssText: ".b{color:blue}" }] }
  const { css } = collectStyleSources(fakeDocument({ adopted: [sheet] }))
  assert.deepEqual(css, [".b{color:blue}"])
})

test("an unreadable sheet is skipped, not thrown over", () => {
  const bad = {
    get cssRules() {
      throw new Error("SecurityError")
    },
  }
  const good = { cssRules: [{ cssText: ".c{}" }] }
  const { css } = collectStyleSources(fakeDocument({ adopted: [bad, good] }))
  assert.deepEqual(css, [".c{}"], "one unreadable sheet must not cost the readable ones")
})

// --- what the clone loses --------------------------------------------------

test("what was typed survives the clone, which otherwise prints the empty form", () => {
  const live = new FakeNode("div").append(new FakeInput("text", "Ada Lovelace"))
  const clone = new FakeNode("div").append(new FakeInput("text", ""))

  freezeFormState(live, clone)
  assert.equal(clone.kids[0].getAttribute("value"), "Ada Lovelace")
})

test("a ticked checkbox prints ticked, and an unticked one does not", () => {
  const live = new FakeNode("div").append(
    new FakeInput("checkbox", "on", true),
    new FakeInput("checkbox", "on", false)
  )
  const clone = new FakeNode("div").append(
    new FakeInput("checkbox", "on"),
    new FakeInput("checkbox", "on")
  )
  clone.kids[1].setAttribute("checked", "") // authored checked, since unticked

  freezeFormState(live, clone)
  assert.equal(clone.kids[0].getAttribute("checked"), "")
  assert.equal(
    clone.kids[1].getAttribute("checked"),
    null,
    "a box the user cleared must not print ticked because the markup said so"
  )
})

test("a textarea's value is its content, not an attribute", () => {
  const live = new FakeNode("div").append(new FakeTextarea("note to the courier"))
  const clone = new FakeNode("div").append(new FakeTextarea(""))

  freezeFormState(live, clone)
  assert.equal(clone.kids[0].textContent, "note to the courier")
})

test("the chosen option prints as the chosen one", () => {
  const live = new FakeNode("div").append(
    new FakeSelect([new FakeOption(false), new FakeOption(true)])
  )
  const clone = new FakeNode("div").append(
    new FakeSelect([new FakeOption(false), new FakeOption(false)])
  )

  freezeFormState(live, clone)
  assert.equal(clone.kids[0].options[1].getAttribute("selected"), "")
  assert.equal(clone.kids[0].options[0].getAttribute("selected"), null)
})

test("the region itself is included when it is the field, not only its descendants", () => {
  const live = new FakeInput("text", "typed")
  const clone = new FakeInput("text", "")

  freezeFormState(live, clone)
  assert.equal(clone.getAttribute("value"), "typed")
})

test("a canvas prints what it was showing, not the blank rectangle it clones to", () => {
  const live = new FakeNode("div").append(new FakeCanvas(200, 80))
  const clone = new FakeNode("div").append(new FakeCanvas(200, 80))

  freezeCanvases(live, clone)
  assert.equal(clone.kids[0].tagName, "IMG")
  assert.equal(clone.kids[0].src, "data:image/png;base64,#200x80")
  assert.equal(clone.kids[0].width, 200)
})

test("one tainted canvas costs its own picture, not the whole sheet", () => {
  const live = new FakeNode("div").append(new FakeCanvas(10, 10, true), new FakeCanvas(20, 20))
  const clone = new FakeNode("div").append(new FakeCanvas(10, 10), new FakeCanvas(20, 20))

  assert.doesNotThrow(() => freezeCanvases(live, clone))
  assert.equal(clone.kids[0].tagName, "CANVAS", "the tainted one stays the blank element it was")
  assert.equal(clone.kids[1].tagName, "IMG", "the readable one still gets its picture")
})

// --- the button ------------------------------------------------------------

const nodes = (props) => walk(render(PrintButton, props).tree)

test("it does not submit the form it is sitting in", () => {
  const button = byTag(nodes({ target: { current: null } }), "button")[0]
  assert.equal(button.props.type, "button")
})

test("the result is announced, not left to the icon", () => {
  const live = nodes({ target: { current: null } }).filter(
    (n) => n.props?.["aria-live"] === "polite"
  )
  assert.equal(live.length, 1)
  assert.match(String(live[0].props.className), /sr-only/)
})

test("nothing rendered depends on feature detection, so hydration cannot mismatch", () => {
  const withPrint = JSON.stringify(nodes({ target: { current: null } }).map((n) => n.type))
  const saved = globalThis.window
  globalThis.window = undefined
  const withoutPrint = JSON.stringify(nodes({ target: { current: null } }).map((n) => n.type))
  globalThis.window = saved
  assert.equal(withPrint, withoutPrint)
})

test("the caller's own label is what shows at rest", () => {
  const tree = JSON.stringify(nodes({ target: { current: null }, children: "Print receipt" }))
  assert.match(tree, /Print receipt/)
})
