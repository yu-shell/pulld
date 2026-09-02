// Recovery codes are a screen whose failures are all invisible at the moment they happen. The
// person clicks Print, a print dialog opens, paper comes out — and the fault only surfaces months
// later when they are locked out and the sheet turns out to hold half the codes, or codes that were
// already spent, or nothing legible at all.
//
// So the cases here are written against the specific wrong versions rather than the happy path:
//   - exporting every code instead of only the unused ones (right length, silently useless),
//   - LF line endings in the .txt (one long line in a fair amount of Windows tooling),
//   - interpolating a code into the print document without escaping it,
//   - marking a spent code with line-through alone, which reaches nobody using a screen reader,
//   - dropping the list role from a list-style-none <ul>,
//   - toISOString() for the date, which lands on tomorrow west of Greenwich after 00:00 UTC.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

/** Stands in for the composed copy button so its props can be read off the tree. */
function CopyButtonStub() {
  return null
}

const {
  normalizeCodes,
  isoDate,
  formatCodesText,
  escapeHtml,
  buildPrintDocument,
  RecoveryCodes,
} = loadComponent(join(ROOT, "registry", "ui", "recovery-codes.tsx"), {
  stubs: {
    "lucide-react": icons,
    "@/registry/ui/copy-button": { CopyButton: CopyButtonStub },
  },
})

const SET = [
  { code: "7f2a-91c4" },
  { code: "b3e8-45da" },
  { code: "c1d9-77ab", used: true },
  { code: "e604-2b3f" },
]

test("both accepted shapes normalise to the same thing, trimmed", () => {
  assert.deepEqual(normalizeCodes(["  a1b2  ", "c3d4"]), [
    { code: "a1b2", used: false },
    { code: "c3d4", used: false },
  ])
  assert.deepEqual(normalizeCodes([{ code: "a1b2\n" }, { code: "c3d4", used: true }]), [
    { code: "a1b2", used: false },
    { code: "c3d4", used: true },
  ])
})

test("an entry that is empty once trimmed is dropped, not rendered as a blank row", () => {
  assert.deepEqual(normalizeCodes(["a1b2", "   ", ""]), [{ code: "a1b2", used: false }])
})

test("the date is the local calendar day, not the UTC one", () => {
  // Pinned to a zone behind UTC rather than trusting the runner's own, so the divergence actually
  // happens here instead of only on the machines that would have caught it by luck. Node re-reads
  // TZ when it changes, so this is enough to move the clock.
  const original = process.env.TZ
  try {
    process.env.TZ = "America/Los_Angeles"
    const evening = new Date("2026-03-02T04:30:00Z") // 20:30 on 1 March in Los Angeles
    assert.equal(evening.toISOString().slice(0, 10), "2026-03-02", "TZ did not take effect")
    assert.equal(isoDate(evening), "2026-03-01", "the sheet would be dated tomorrow")
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
  assert.equal(isoDate(new Date(2026, 0, 5)), "2026-01-05", "month and day are zero-padded")
})

test("the downloaded file uses CRLF, and every code sits on a line of its own", () => {
  const text = formatCodesText({
    codes: ["7f2a-91c4", "b3e8-45da"],
    title: "Acme",
    generatedAt: new Date(2026, 8, 2),
    note: "Each code can be used once.",
  })
  assert.ok(!/(^|[^\r])\n/.test(text), "a bare LF survived — Windows editors show one long line")
  const lines = text.split("\r\n")
  assert.equal(lines[0], "Acme")
  assert.equal(lines[1], "Generated 2026-09-02")
  assert.ok(lines.includes("7f2a-91c4") && lines.includes("b3e8-45da"))
  assert.ok(text.endsWith("\r\n"), "the file should end with a newline")
})

test("the note is left out entirely when there is none", () => {
  const text = formatCodesText({ codes: ["a1b2"], title: "Acme", note: null })
  assert.equal(text, "Acme\r\nGenerated " + isoDate(new Date()) + "\r\n\r\na1b2\r\n")
})

test("a code is escaped on its way into the print document", () => {
  const html = buildPrintDocument({
    codes: ['</ul><script>alert(1)</script>'],
    title: 'Acme <staging> & "prod"',
    generatedAt: new Date(2026, 8, 2),
    note: null,
  })
  assert.ok(!html.includes("<script>"), "a code was interpolated as markup")
  assert.ok(html.includes("&lt;/ul&gt;&lt;script&gt;"))
  assert.ok(html.includes("Acme &lt;staging&gt; &amp; &quot;prod&quot;"))
  assert.equal(escapeHtml("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f")
})

test("the printed sheet states its own colours and keeps codes off page breaks", () => {
  const html = buildPrintDocument({ codes: ["a1b2"], title: "Acme", note: null })
  // Browsers drop background colours when printing but keep text colours, so a sheet that inherits
  // a dark theme prints pale grey on white. Both halves have to be stated.
  assert.match(html, /color:\s*#000/)
  assert.match(html, /background:\s*#fff/)
  assert.match(html, /break-inside:\s*avoid/)
  assert.match(html, /<html lang="en">/)
  assert.match(html, /data-recovery-codes/, "the marker printDocument checks for is missing")
})

test("the sheet is identifiable later: it carries a title, a date and a count", () => {
  const html = buildPrintDocument({
    codes: ["a1b2", "c3d4"],
    title: "Acme",
    generatedAt: new Date(2026, 8, 2),
    note: null,
  })
  assert.match(html, /<h1>Acme<\/h1>/)
  assert.ok(html.includes("Generated 2026-09-02"))
  assert.ok(html.includes("2 codes"))
  assert.ok(
    buildPrintDocument({ codes: ["a1b2"], title: "Acme", note: null }).includes("&middot; 1 code<"),
    "the count should not read '1 codes'"
  )
})

test("every export carries the unused codes only", () => {
  const { tree } = render(RecoveryCodes, { codes: SET, label: "Recovery codes" })
  const nodes = walk(tree)

  const copy = nodes.find((n) => n.type === CopyButtonStub)
  assert.ok(copy, "the copy control is not composed from copy-button")
  assert.equal(copy.props.value, "7f2a-91c4\nb3e8-45da\ne604-2b3f")
  assert.ok(
    !copy.props.value.includes("c1d9-77ab"),
    "a spent code reached the clipboard — the saved set would be the right length and still short"
  )
  // The clipboard is a text field, not a file: a carriage return there is a character the next
  // form to read the codes back does not expect.
  assert.ok(!copy.props.value.includes("\r"))
})

test("the accessible names count what is actually going to be exported", () => {
  const nodes = walk(render(RecoveryCodes, { codes: SET }).tree)
  const copy = nodes.find((n) => n.type === CopyButtonStub)
  assert.equal(copy.props["aria-label"], "Copy 3 recovery codes")

  const buttons = byTag(nodes, "button")
  const names = buttons.map((b) => b.props["aria-label"])
  assert.deepEqual(names, ["Download 3 recovery codes", "Print 3 recovery codes"])
  for (const button of buttons) {
    assert.equal(button.props.type, "button", "a toolbar button would submit a surrounding form")
    assert.ok(button.props.title, "an icon-only button with no tooltip is a guess")
  }
})

test("a single remaining code is not called '1 recovery codes'", () => {
  const nodes = walk(render(RecoveryCodes, { codes: ["a1b2"] }).tree)
  assert.equal(
    nodes.find((n) => n.type === CopyButtonStub).props["aria-label"],
    "Copy 1 recovery code"
  )
})

test("with nothing left to export, every control is disabled rather than silently doing nothing", () => {
  const spent = SET.map((entry) => ({ ...entry, used: true }))
  const nodes = walk(render(RecoveryCodes, { codes: spent }).tree)
  assert.equal(nodes.find((n) => n.type === CopyButtonStub).props.disabled, true)
  for (const button of byTag(nodes, "button")) assert.equal(button.props.disabled, true)
})

test("a spent code is marked in words, not only with a line through it", () => {
  const nodes = walk(render(RecoveryCodes, { codes: SET }).tree)
  const items = byTag(nodes, "li")
  assert.equal(items.length, 4)

  const spent = items[2]
  assert.match(spent.props.className, /line-through/)
  const srOnly = walk(spent.props.children).find((n) => n.props?.className === "sr-only")
  assert.ok(srOnly, "line-through is a paint decision and reaches no screen reader on its own")
  assert.match(String(srOnly.props.children), /used/i)

  const live = walk(items[0].props.children).find((n) => n.props?.className === "sr-only")
  assert.equal(live, undefined, "an unused code should not be labelled")
})

test("the list keeps its role and its label", () => {
  const nodes = walk(render(RecoveryCodes, { codes: SET, label: "Backup codes" }).tree)
  const list = byTag(nodes, "ul")[0]
  // Safari drops list semantics from a <ul> whose list-style is none, taking the count of codes
  // with it — the one number that matters on this screen.
  assert.equal(list.props.role, "list")
  const labelledBy = list.props["aria-labelledby"]
  assert.ok(labelledBy)
  const heading = nodes.find((n) => n.props?.id === labelledBy)
  assert.equal(heading.props.children, "Backup codes")
})

test("the header says how many are left only once something has been spent", () => {
  const withSpent = walk(render(RecoveryCodes, { codes: SET }).tree)
    .map((n) => n.props?.children)
    .filter(Array.isArray)
    .flat()
  assert.ok(
    JSON.stringify(withSpent).includes("unused"),
    "narrowing the export without saying so leaves the count invisible"
  )

  const allFresh = JSON.stringify(walk(render(RecoveryCodes, { codes: ["a1b2", "c3d4"] }).tree))
  assert.ok(!allFresh.includes("unused"), "nothing is spent, so there is nothing to qualify")
})

test("actions can be narrowed, and stay in toolbar order", () => {
  const nodes = walk(render(RecoveryCodes, { codes: SET, actions: ["print", "copy"] }).tree)
  assert.ok(nodes.find((n) => n.type === CopyButtonStub), "copy was asked for and is missing")
  const names = byTag(nodes, "button").map((b) => b.props["aria-label"])
  assert.deepEqual(names, ["Print 3 recovery codes"])
})

test("onExport reports which way the codes left the screen", () => {
  const seen = []
  const nodes = walk(
    render(RecoveryCodes, { codes: SET, onExport: (action) => seen.push(action) }).tree
  )
  const copy = nodes.find((n) => n.type === CopyButtonStub)

  // copy-button spreads its props after its own click handler, so an onClick handed to it does not
  // run alongside the clipboard write — it replaces it. A button that looks right, sounds right and
  // copies nothing is the whole failure, so the notification has to come from somewhere else.
  assert.equal(copy.props.onClick, undefined, "an onClick here would disable copying outright")

  const wrapper = nodes.find((n) => walk(n.props?.children).includes(copy) && n.props?.onClick)
  assert.ok(wrapper, "nothing observes the copy, so onExport would never fire for it")
  wrapper.props.onClick()
  assert.deepEqual(seen, ["copy"])
})

test("the guidance line is rendered by default and can be dropped", () => {
  const shown = JSON.stringify(walk(render(RecoveryCodes, { codes: SET }).tree))
  assert.ok(shown.includes("Each code can be used once"))
  const hidden = JSON.stringify(walk(render(RecoveryCodes, { codes: SET, note: null }).tree))
  assert.ok(!hidden.includes("Each code can be used once"))
})

test("the sheet heading falls back to the label and is overridable", () => {
  assert.ok(buildPrintDocument({ codes: ["a1b2"], title: "Recovery codes" }).includes("<h1>Recovery codes</h1>"))
  assert.ok(buildPrintDocument({ codes: ["a1b2"], title: "Acme — security" }).includes("Acme — security"))
})
