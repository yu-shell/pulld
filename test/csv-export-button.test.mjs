// A CSV writer is a component whose failures all happen somewhere else. The click works, a file
// lands in the downloads folder, and the damage shows up in a spreadsheet on someone else's machine
// — which is why the cases here are written against the specific wrong versions rather than the
// happy path:
//   - a cell starting with = + - or @, which the spreadsheet opening the file executes,
//   - ...and the belief that quoting the field is enough, which it is not,
//   - ...and the over-correction that prefixes -42 too, so no column adds up any more,
//   - a value containing a comma, a quote or a newline written straight through,
//   - LF line endings, and a BOM-less file, which is Excel mojibake for every non-ASCII byte,
//   - reading the column names off row 0, which drops a field the later rows have,
//   - an un-revoked object URL, and an anchor clicked before it is in the document,
//   - a second click starting a second export while the first is still fetching.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Spelled as an escape on both sides of the assertion, because the character itself is invisible. */
const BOM = "\uFEFF"
const icons = new Proxy({}, { get: () => () => null })

const {
  resolveColumns,
  formatCsvValue,
  sanitizeCsvCell,
  escapeCsvCell,
  toCsv,
  withCsvExtension,
  downloadCsvFile,
  CsvExportButton,
} = loadComponent(join(ROOT, "registry", "ui", "csv-export-button.tsx"), {
  stubs: { "lucide-react": icons },
})

// --- the security half -----------------------------------------------------

test("a cell a spreadsheet would execute is defused with the text marker", () => {
  for (const payload of [
    '=HYPERLINK("https://evil.example","Click")',
    "=1+1",
    "+1+1",
    "@SUM(A1)",
    "-2+3",
    "\tcmd",
    "\rcmd",
  ]) {
    assert.equal(sanitizeCsvCell(payload), `'${payload}`, `${JSON.stringify(payload)} went through`)
  }
})

test("a number is left alone, so the negative column still adds up", () => {
  for (const number of ["-42", "-1.5", "+7", "-0.5e3", "-.5", "1234"]) {
    assert.equal(sanitizeCsvCell(number), number, `${number} was turned into text`)
  }
})

test("a phone number is not a number, and is defused", () => {
  // Excel shows #NAME? for this one even without an attacker involved, so prefixing is right twice.
  assert.equal(sanitizeCsvCell("+44 20 7946 0000"), "'+44 20 7946 0000")
  assert.equal(sanitizeCsvCell("-"), "'-")
})

test("quoting is not a substitute for defusing — the field itself has to change", () => {
  // The tempting wrong fix is to wrap the payload in quotes and call it handled. A spreadsheet
  // strips the quotes while parsing and evaluates what is left, so the marker has to be in the
  // value. Here the defused cell needs no quotes at all, which is what the output should show.
  assert.equal(toCsv([{ note: "=1+1" }]), "note\r\n'=1+1")
})

test("headers go through the same guard as the data", () => {
  assert.equal(toCsv([{ x: 1 }], { columns: [{ header: "=EVIL()", value: (r) => r.x }] }), "'=EVIL()\r\n1")
})

test("sanitising can be turned off for a file no spreadsheet will open", () => {
  assert.equal(toCsv([{ note: "=1+1" }], { sanitize: false }), "note\r\n=1+1")
})

// --- RFC 4180 --------------------------------------------------------------

test("a cell is quoted when it holds the delimiter, a quote or a line break", () => {
  assert.equal(escapeCsvCell("plain"), "plain")
  assert.equal(escapeCsvCell("a,b"), '"a,b"')
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""')
  assert.equal(escapeCsvCell("line\nbreak"), '"line\nbreak"')
  assert.equal(escapeCsvCell("carriage\rreturn"), '"carriage\rreturn"')
})

test("a newline inside a value stays inside one record", () => {
  // Written straight through, this splits the record in two and every following row lands one
  // column over — a file that opens fine and is wrong from that row down.
  const csv = toCsv([{ id: 1, note: "first\nsecond" }, { id: 2, note: "ok" }])
  assert.equal(csv, 'id,note\r\n1,"first\nsecond"\r\n2,ok')
  // Three records, not four: the quoted break is not a record separator.
  assert.equal(csv.split("\r\n").length, 3)
})

test("records are joined with CRLF", () => {
  assert.equal(toCsv([{ a: 1 }, { a: 2 }]), "a\r\n1\r\n2")
})

test("the delimiter decides what needs quoting, not the comma", () => {
  const rows = [{ label: "a,b", other: "x;y" }]
  assert.equal(toCsv(rows, { delimiter: ";" }), 'label;other\r\na,b;"x;y"')
})

test("the header line can be left out", () => {
  assert.equal(toCsv([{ a: 1 }], { includeHeader: false }), "1")
})

test("the text carries no byte-order mark — that belongs to the file's bytes", () => {
  // A BOM left in the string is an invisible U+FEFF glued to the first header, which breaks any
  // comparison or hash of this text and is impossible to see in a diff.
  assert.ok(!toCsv([{ a: 1 }]).includes(BOM))
})

// --- columns and values ----------------------------------------------------

test("derived columns are the union across every row, not row zero's keys", () => {
  const columns = resolveColumns([{ id: 1 }, { id: 2, deleted_at: "2026-09-04" }])
  assert.deepEqual(
    columns.map((c) => c.header),
    ["id", "deleted_at"]
  )
  assert.equal(toCsv([{ id: 1 }, { id: 2, deleted_at: "x" }]), "id,deleted_at\r\n1,\r\n2,x")
})

test("a column is a property name, or a header with a function of the whole row", () => {
  const rows = [{ first: "Ada", last: "Lovelace", id: 7 }]
  assert.equal(
    toCsv(rows, {
      columns: [
        "id",
        { header: "Given name", value: (r) => r.first },
        { header: "Full", value: (r) => `${r.first} ${r.last}` },
      ],
    }),
    "id,Given name,Full\r\n7,Ada,Ada Lovelace"
  )
})

test("values become the text a file should hold", () => {
  assert.equal(formatCsvValue(null), "")
  assert.equal(formatCsvValue(undefined), "")
  assert.equal(formatCsvValue(""), "")
  assert.equal(formatCsvValue(0), "0")
  assert.equal(formatCsvValue(false), "false")
  assert.equal(formatCsvValue(12n), "12")
  assert.equal(formatCsvValue({ a: 1 }), '{"a":1}')
  assert.equal(formatCsvValue(new Date(Date.UTC(2026, 8, 4, 12, 0, 0))), "2026-09-04T12:00:00.000Z")
  assert.equal(formatCsvValue(new Date("nonsense")), "")
})

test("NaN and Infinity are written as empty, not as the words", () => {
  // "NaN" is a text cell in the middle of a numeric column, and it breaks the column's total
  // without saying anything.
  assert.equal(formatCsvValue(NaN), "")
  assert.equal(formatCsvValue(Infinity), "")
})

test("cell formatting can be replaced wholesale", () => {
  const formatCell = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? ""))
  assert.equal(toCsv([{ at: new Date(Date.UTC(2026, 8, 4)) }], { formatCell }), "at\r\n2026-09-04")
})

test("an extension is added only when the caller did not choose one", () => {
  assert.equal(withCsvExtension("export"), "export.csv")
  assert.equal(withCsvExtension("export.csv"), "export.csv")
  assert.equal(withCsvExtension("report.tsv"), "report.tsv")
})

// --- the download ----------------------------------------------------------

/** Stands in for the pieces of the browser the download touches, recording what it was asked to do. */
function stubBrowser() {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    Blob: globalThis.Blob,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  }
  const log = { blobs: [], anchors: [], revoked: [], timers: [], appended: [] }

  globalThis.Blob = class {
    constructor(parts, options) {
      this.parts = parts
      this.options = options
      log.blobs.push(this)
    }
  }
  URL.createObjectURL = (blob) => `blob:stub/${log.blobs.indexOf(blob)}`
  URL.revokeObjectURL = (url) => log.revoked.push(url)
  globalThis.document = {
    createElement() {
      const anchor = {
        style: {},
        clicked: false,
        inDocumentWhenClicked: null,
        click() {
          this.clicked = true
          this.inDocumentWhenClicked = log.appended.includes(this)
        },
        remove() {
          log.appended = log.appended.filter((a) => a !== this)
        },
      }
      log.anchors.push(anchor)
      return anchor
    },
    body: {
      appendChild(node) {
        log.appended.push(node)
      },
    },
  }
  globalThis.window = {
    setTimeout(fn, ms) {
      log.timers.push({ fn, ms })
      return log.timers.length
    },
    clearTimeout() {},
  }
  return {
    log,
    /** Runs the deferred work the component handed to setTimeout. */
    flushTimers() {
      const pending = log.timers.splice(0)
      for (const timer of pending) timer.fn()
    },
    restore() {
      globalThis.document = saved.document
      globalThis.window = saved.window
      globalThis.Blob = saved.Blob
      URL.createObjectURL = saved.createObjectURL
      URL.revokeObjectURL = saved.revokeObjectURL
    },
  }
}

test("the file gets a UTF-8 BOM, so Excel does not mangle every non-ASCII byte", (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  downloadCsvFile("export.csv", "name\r\n山田")
  const [blob] = browser.log.blobs
  assert.equal(blob.parts[0], BOM)
  assert.equal(blob.parts[1], "name\r\n山田")
  assert.equal(blob.options.type, "text/csv;charset=utf-8")
})

test("the BOM can be dropped for a file a program will parse", (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  downloadCsvFile("export.csv", "a\r\n1", { bom: false })
  assert.deepEqual(browser.log.blobs[0].parts, ["a\r\n1"])
})

test("the anchor is in the document before it is clicked, and gone afterwards", (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  downloadCsvFile("report", "a\r\n1")
  const [anchor] = browser.log.anchors
  assert.equal(anchor.clicked, true)
  // Firefox ignores a click on an element that is not in the tree, which is a download that simply
  // never happens on one browser.
  assert.equal(anchor.inDocumentWhenClicked, true)
  assert.deepEqual(browser.log.appended, [])
  assert.equal(anchor.download, "report.csv")
  assert.equal(anchor.rel, "noopener")
})

test("the object URL is revoked, but on a later task", (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  downloadCsvFile("export.csv", "a\r\n1")
  // Revoking inside the click's own task cancels the download it was created for; not revoking at
  // all pins the whole exported table in memory for the life of the document.
  assert.deepEqual(browser.log.revoked, [])
  assert.equal(browser.log.timers.length, 1)
  browser.flushTimers()
  assert.deepEqual(browser.log.revoked, ["blob:stub/0"])
})

// --- the button ------------------------------------------------------------

const clickEvent = () => ({ defaultPrevented: false, preventDefault() {} })

/** Renders the button and returns the harness instance plus a fresh view of the root element. */
function mount(props) {
  const instance = render(CsvExportButton, props)
  return {
    instance,
    get button() {
      return byTag(walk(instance.tree), "button")[0]
    },
    live() {
      return walk(instance.tree).find((n) => n.props?.["aria-live"] === "polite")?.props?.children
    },
  }
}

test("it is a real button that will not submit the form it sits in", (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const view = mount({ rows: [{ a: 1 }] })
  assert.equal(view.button.props.type, "button")
  assert.equal(view.button.props["aria-busy"], false)
  view.instance.unmount()
})

test("clicking exports the rows and announces what was downloaded", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const exported = []
  const view = mount({
    rows: [{ id: 1 }, { id: 2 }],
    filename: "people",
    onExport: (info) => exported.push(info),
  })
  await view.button.props.onClick(clickEvent())
  view.instance.rerender()

  assert.deepEqual(browser.log.blobs[0].parts[1], "id\r\n1\r\n2")
  assert.deepEqual(exported, [{ rowCount: 2, filename: "people.csv" }])
  // The icon swap is not an event, so the outcome is said in words as well.
  assert.equal(view.live(), "Downloaded 2 rows as people.csv")
  view.instance.unmount()
})

test("while the rows are being fetched the button is busy and cannot be pressed again", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  let release
  let calls = 0
  const view = mount({
    rows: () => {
      calls++
      return new Promise((resolve) => (release = resolve))
    },
  })

  const first = view.button.props.onClick(clickEvent())
  view.instance.rerender()
  assert.equal(view.button.props["aria-busy"], true)
  assert.equal(view.button.props.disabled, true)
  assert.equal(view.live(), "Preparing export")

  // The second press is the double-click that otherwise downloads the file twice, or runs the
  // expensive query behind it twice. Deliberately not awaited: an unguarded handler calls rows()
  // synchronously before its first await, so the count below catches it straight away — awaiting
  // would instead park on a promise that is never resolved and turn a failure into a hung test.
  void view.button.props.onClick(clickEvent())
  assert.equal(calls, 1)

  release([{ id: 1 }])
  await first
  view.instance.rerender()
  assert.equal(view.button.props["aria-busy"], false)
  assert.equal(browser.log.blobs.length, 1)
  view.instance.unmount()
})

test("no rows and no declared columns downloads nothing, and says so", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const view = mount({ rows: [] })
  await view.button.props.onClick(clickEvent())
  view.instance.rerender()

  // A file with neither headers nor rows is a zero-byte download that reads as a broken button.
  assert.deepEqual(browser.log.blobs, [])
  assert.equal(view.live(), "Nothing to export")
  view.instance.unmount()
})

test("no rows but declared columns writes the header-only file", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const view = mount({ rows: [], columns: ["id", "email"] })
  await view.button.props.onClick(clickEvent())

  assert.equal(browser.log.blobs[0].parts[1], "id,email")
  view.instance.unmount()
})

test("a failure to produce the rows is reported, and the button comes back", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const errors = []
  const view = mount({
    rows: () => Promise.reject(new Error("network")),
    onError: (error) => errors.push(error),
  })
  await view.button.props.onClick(clickEvent())
  view.instance.rerender()

  assert.equal(errors.length, 1)
  assert.equal(errors[0].message, "network")
  assert.equal(view.button.props["aria-busy"], false)
  assert.equal(view.button.props.disabled, false)
  assert.equal(view.live(), "Export failed")
  assert.deepEqual(browser.log.blobs, [])
  view.instance.unmount()
})

test("a caller's own onClick runs beside the export rather than replacing it", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  // Props are spread onto the button after the export handler is attached, so an onClick arriving
  // through them would win — a button that still looks and sounds right and exports nothing.
  const seen = []
  const view = mount({ rows: [{ a: 1 }], onClick: () => seen.push("caller") })
  await view.button.props.onClick(clickEvent())

  assert.deepEqual(seen, ["caller"])
  assert.equal(browser.log.blobs.length, 1)
  view.instance.unmount()
})

test("a caller who calls preventDefault stops the export", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const view = mount({
    rows: [{ a: 1 }],
    onClick: (event) => {
      event.defaultPrevented = true
    },
  })
  await view.button.props.onClick(clickEvent())

  assert.deepEqual(browser.log.blobs, [])
  view.instance.unmount()
})

test("the announcement is cleared, so exporting twice is announced twice", async (t) => {
  const browser = stubBrowser()
  t.after(() => browser.restore())

  const view = mount({ rows: [{ a: 1 }] })
  await view.button.props.onClick(clickEvent())
  view.instance.rerender()
  assert.equal(view.live(), "Downloaded 1 row as export.csv")

  // A live region re-set to the string it already holds says nothing at all, so the region is
  // emptied a few seconds later rather than left holding the last result.
  const clear = browser.log.timers.filter((timer) => timer.ms === 5000)
  assert.equal(clear.length, 1)
  clear[0].fn()
  view.instance.rerender()
  assert.equal(view.live(), "")
  view.instance.unmount()
})
