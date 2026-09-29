// A paste area is "listen for onPaste and read e.clipboardData.files" right up until someone pastes
// a screenshot, which is the thing they were always going to paste first. The cases below are
// written to fail against that version:
//
//   - reading `files` alone, which misses a picture that was never a file on disk — it is in
//     `items` and, in some browsers, nowhere else,
//   - reading both and handing back the same screenshot twice, because `getAsFile()` mints a fresh
//     `File` each call and some engines stamp it with the current millisecond,
//   - taking `text/plain` and dropping the `text/html` that arrived with it, which is the whole
//     difference between a pasted spreadsheet being a table and being tab-separated soup,
//   - letting every pasted screenshot keep the name `image.png`,
//   - swallowing a paste meant for a text box inside the region,
//   - and delivering one Ctrl+V twice, because a `paste` event bubbles to the document listener as
//     well as to the element's own handler.
//
// Layout, focus and the caret are not observable here (see _react-harness.mjs), so what a component
// *asks* for is asserted through the stand-in node's `calls` log and the rest is left to a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  TEXT_TYPE,
  HTML_TYPE,
  extensionForType,
  isGenericName,
  stampFor,
  pastedName,
  matchesAccept,
  screenFiles,
  dedupeFiles,
  readClipboard,
  readClipboardItems,
  normalizeFiles,
  describePaste,
  isEditableTarget,
  isFocusableTarget,
  isPermissionError,
  PasteArea,
} = loadComponent(join(ROOT, "registry", "ui", "paste-area.tsx"), {
  stubs: {
    "lucide-react": {
      ClipboardPaste: function ClipboardPaste() {
        return null
      },
      Loader2: function Loader2() {
        return null
      },
    },
  },
})

/** A file with a real byte length, so `maxSize` is measured rather than mocked. */
const fileOf = (name, type, size = 4) =>
  new File([new Uint8Array(size)], name, { type, lastModified: 1_000 })

/** What a browser hands over for a pasted screenshot: present in `items`, absent from `files`. */
const screenshotTransfer = (file, { alsoInFiles = false } = {}) => ({
  types: ["Files"],
  files: alsoInFiles ? [file] : [],
  items: [{ kind: "file", type: file.type, getAsFile: () => file }],
  getData: () => "",
})

// --- extensions ----------------------------------------------------------------------------------

test("a MIME type becomes the extension a person would expect", () => {
  assert.equal(extensionForType("image/png"), "png")
  assert.equal(extensionForType("image/jpeg"), "jpg")
  assert.equal(extensionForType("image/webp"), "webp")
  assert.equal(extensionForType("application/pdf"), "pdf")
})

// `image/png; charset=binary` is still a png. Split on the parameter or the name ends in `.png;`.
test("type parameters and casing do not reach the filename", () => {
  assert.equal(extensionForType("image/png; charset=binary"), "png")
  assert.equal(extensionForType("IMAGE/PNG"), "png")
  assert.equal(extensionForType("  image/gif  "), "gif")
})

test("vendor prefixes and structured suffixes are stripped", () => {
  assert.equal(extensionForType("image/x-icon"), "ico")
  assert.equal(extensionForType("image/svg+xml"), "svg")
  assert.equal(extensionForType("application/x-tar"), "tar")
})

// A blob with no type at all is ordinary — Safari hands one over for some clipboard flavours — and
// the answer has to be a filename, not `.undefined` or `.application/octet-stream`.
test("a missing or unusable type still produces a usable extension", () => {
  assert.equal(extensionForType(""), "bin")
  assert.equal(extensionForType(null), "bin")
  assert.equal(extensionForType("application/octet-stream"), "bin")
  assert.equal(extensionForType("nonsense"), "bin")
})

// --- which names are placeholders ----------------------------------------------------------------

test("the names browsers invent for a screenshot are recognised as placeholders", () => {
  assert.equal(isGenericName("image.png"), true)
  assert.equal(isGenericName("IMAGE.PNG"), true)
  assert.equal(isGenericName("unknown"), true)
  assert.equal(isGenericName("blob"), true)
  assert.equal(isGenericName(""), true)
  assert.equal(isGenericName(null), true)
})

// The point of the short list. A file called `photo.jpg` was named by whoever owns it, and renaming
// it to `pasted-20260929-143012-1.jpg` is this component destroying information rather than adding
// any. Same for a screenshot that the OS already named.
test("a name a person chose is never treated as a placeholder", () => {
  assert.equal(isGenericName("photo.jpg"), false)
  assert.equal(isGenericName("Screenshot 2026-09-29 at 14.30.12.png"), false)
  assert.equal(isGenericName("invoice-2026-09.pdf"), false)
  assert.equal(isGenericName("image-2.png"), false)
})

// --- the stamp -----------------------------------------------------------------------------------

test("the stamp is zero-padded local time, in a filename-safe order", () => {
  assert.equal(stampFor(new Date(2026, 8, 29, 14, 30, 12)), "20260929-143012")
  assert.equal(stampFor(new Date(2026, 0, 3, 4, 5, 6)), "20260103-040506")
})

// Building it from `toISOString` would be UTC, and a screenshot taken at half past two in the
// afternoon in Tokyo would be filed under 0530 of the same day.
test("the stamp follows the reader's clock, not UTC", () => {
  const local = new Date(2026, 8, 29, 23, 30, 0)
  assert.equal(stampFor(local).slice(9, 13), "2330")
})

test("a generated name carries the stamp, the sequence and the real extension", () => {
  assert.equal(pastedName("image/png", "20260929-143012", 2), "pasted-20260929-143012-2.png")
})

// --- screening -----------------------------------------------------------------------------------

test("accept matches on mime, wildcard and extension", () => {
  const png = fileOf("a.png", "image/png")
  assert.equal(matchesAccept(png, undefined), true)
  assert.equal(matchesAccept(png, "image/png"), true)
  assert.equal(matchesAccept(png, "image/*"), true)
  assert.equal(matchesAccept(png, ".png"), true)
  assert.equal(matchesAccept(png, "application/pdf,.txt"), false)
})

test("files are split into the ones to keep and the ones to explain", () => {
  const png = fileOf("a.png", "image/png", 10)
  const pdf = fileOf("b.pdf", "application/pdf", 10)
  const big = fileOf("c.png", "image/png", 5_000)
  const { accepted, rejected } = screenFiles([png, pdf, big], {
    accept: "image/*",
    maxSize: 1_000,
  })
  assert.deepEqual(
    accepted.map((f) => f.name),
    ["a.png"]
  )
  assert.deepEqual(
    rejected.map((r) => [r.file.name, r.reason]),
    [
      ["b.pdf", "type"],
      ["c.png", "size"],
    ]
  )
})

// The cap counts what survived screening, not what arrived: two files of the wrong type followed by
// one good one is one file, not "already over a cap of two".
test("maxFiles counts accepted files, and the overflow is reported rather than dropped", () => {
  const files = [fileOf("a.png", "image/png"), fileOf("b.png", "image/png"), fileOf("c.png", "image/png")]
  const { accepted, rejected } = screenFiles(files, { maxFiles: 2 })
  assert.equal(accepted.length, 2)
  assert.deepEqual(
    rejected.map((r) => [r.file.name, r.reason]),
    [["c.png", "too-many"]]
  )
})

// --- de-duplication ------------------------------------------------------------------------------

// The reason the identity omits `lastModified`. `getAsFile()` returns a new object per call and some
// engines stamp it with `Date.now()`, so the same picture read out of `items` and out of `files`
// differs by a millisecond or two — and keying on the timestamp shows the person their screenshot
// twice, from one Ctrl+V.
test("one picture read twice is one file, even when the two reads disagree about the clock", () => {
  const a = new File([new Uint8Array(4)], "image.png", { type: "image/png", lastModified: 1 })
  const b = new File([new Uint8Array(4)], "image.png", { type: "image/png", lastModified: 2 })
  assert.equal(dedupeFiles([a], [b]).length, 1)
})

test("different files are kept, and the first sighting wins", () => {
  const a = fileOf("a.png", "image/png", 4)
  const b = fileOf("b.png", "image/png", 4)
  assert.deepEqual(
    dedupeFiles([a], [b, a]).map((f) => f.name),
    ["a.png", "b.png"]
  )
})

test("absent and empty groups are not an error", () => {
  assert.deepEqual(dedupeFiles(null, undefined, []), [])
})

// --- reading a paste event -----------------------------------------------------------------------

// The bug this component exists to avoid: a screenshot is a picture that was never a file on disk,
// so it appears in `items` and, in some browsers, in no other place. Reading `files` alone silently
// ignores the single most common thing anyone pastes.
test("a screenshot present only in items is still found", () => {
  const shot = fileOf("image.png", "image/png")
  const raw = readClipboard(screenshotTransfer(shot))
  assert.deepEqual(
    raw.files.map((f) => f.name),
    ["image.png"]
  )
})

test("a screenshot present in both lists is found once", () => {
  const shot = fileOf("image.png", "image/png")
  assert.equal(readClipboard(screenshotTransfer(shot, { alsoInFiles: true })).files.length, 1)
})

test("an item that is not a file is not mistaken for one", () => {
  const raw = readClipboard({
    types: [TEXT_TYPE],
    files: [],
    items: [{ kind: "string", type: TEXT_TYPE, getAsFile: () => null }],
    getData: (type) => (type === TEXT_TYPE ? "hello" : ""),
  })
  assert.deepEqual(raw.files, [])
  assert.equal(raw.text, "hello")
})

// One paste carries several flavours at once, and which one you read changes the result entirely:
// a spreadsheet selection is a real `<table>` in `text/html` and tab-separated text in `text/plain`.
// Both are handed on so the caller decides, rather than this picking for them.
test("the text and html flavours of one paste both survive", () => {
  const raw = readClipboard({
    types: [TEXT_TYPE, HTML_TYPE],
    files: [],
    items: [],
    getData: (type) => (type === TEXT_TYPE ? "a\tb" : "<table><tr><td>a</td><td>b</td></tr></table>"),
  })
  assert.equal(raw.text, "a\tb")
  assert.match(raw.html, /<table>/)
  assert.deepEqual(raw.types, [TEXT_TYPE, HTML_TYPE])
})

// `getData` throws in some engines once the transfer has been neutered. Losing the pasted image over
// a failed read of a string flavour would be a poor trade.
test("a getData that throws costs the string, not the paste", () => {
  const shot = fileOf("image.png", "image/png")
  const raw = readClipboard({
    types: ["Files"],
    files: [],
    items: [{ kind: "file", type: "image/png", getAsFile: () => shot }],
    getData: () => {
      throw new Error("neutered")
    },
  })
  assert.equal(raw.files.length, 1)
  assert.equal(raw.text, null)
})

test("no clipboard data at all is an empty paste, not a crash", () => {
  const raw = readClipboard(null)
  assert.deepEqual(raw, { files: [], text: null, html: null, types: [] })
})

// --- reading the Clipboard API -------------------------------------------------------------------

const clipboardItem = (types, body) => ({
  types,
  getType: async (type) => {
    const value = body[type]
    if (value instanceof Error) throw value
    return new Blob([value], { type })
  },
})

test("clipboard items are sorted into files, text and html", async () => {
  const raw = await readClipboardItems([
    clipboardItem([TEXT_TYPE, HTML_TYPE, "image/png"], {
      [TEXT_TYPE]: "plain",
      [HTML_TYPE]: "<b>rich</b>",
      "image/png": "\u0089PNG",
    }),
  ])
  assert.equal(raw.text, "plain")
  assert.equal(raw.html, "<b>rich</b>")
  assert.equal(raw.files.length, 1)
  assert.equal(raw.files[0].type, "image/png")
  assert.deepEqual(raw.types, [TEXT_TYPE, HTML_TYPE, "image/png"])
})

// A `ClipboardItem` has no filename to offer, so these come out unnamed deliberately — the single
// naming pass in `normalizeFiles` then treats them exactly like a browser's `image.png`, instead of
// there being a second naming path that drifts from the first.
test("a blob from the clipboard arrives unnamed, for the one naming pass to handle", async () => {
  const raw = await readClipboardItems([clipboardItem(["image/png"], { "image/png": "x" })])
  assert.equal(raw.files[0].name, "")
  assert.equal(isGenericName(raw.files[0].name), true)
})

test("one unreadable flavour does not cost the rest of the clipboard", async () => {
  const raw = await readClipboardItems([
    clipboardItem([HTML_TYPE, "image/png"], {
      [HTML_TYPE]: new Error("gone"),
      "image/png": "x",
    }),
  ])
  assert.equal(raw.html, null)
  assert.equal(raw.files.length, 1)
})

test("an empty clipboard is an empty paste", async () => {
  assert.deepEqual(await readClipboardItems(null), {
    files: [],
    text: null,
    html: null,
    types: [],
  })
})

// --- naming --------------------------------------------------------------------------------------

test("a placeholder name is replaced and the original is reported back", () => {
  const [entry] = normalizeFiles([fileOf("image.png", "image/png")], { stamp: "20260929-143012" })
  assert.equal(entry.file.name, "pasted-20260929-143012-1.png")
  assert.equal(entry.renamed, true)
  assert.equal(entry.originalName, "image.png")
})

test("renaming preserves the bytes, the type and the timestamp", async () => {
  const original = new File([new Uint8Array([1, 2, 3])], "image.png", {
    type: "image/png",
    lastModified: 4_242,
  })
  const [entry] = normalizeFiles([original], { stamp: "20260929-143012" })
  assert.equal(entry.file.type, "image/png")
  assert.equal(entry.file.lastModified, 4_242)
  assert.equal(entry.file.size, 3)
  assert.deepEqual(new Uint8Array(await entry.file.arrayBuffer()), new Uint8Array([1, 2, 3]))
})

test("a file that came with a real name is left alone", () => {
  const [entry] = normalizeFiles([fileOf("invoice.pdf", "application/pdf")], {
    stamp: "20260929-143012",
  })
  assert.equal(entry.file.name, "invoice.pdf")
  assert.equal(entry.renamed, false)
  assert.equal(entry.originalName, "invoice.pdf")
})

// Two screenshots in one paste are both `image.png`. Numbering them from the same sequence is what
// keeps them apart in a list, and in an upload that keys on filename.
test("several placeholders in one paste get distinct names", () => {
  const entries = normalizeFiles([fileOf("image.png", "image/png"), fileOf("image.png", "image/png")], {
    stamp: "20260929-143012",
  })
  assert.deepEqual(
    entries.map((e) => e.file.name),
    ["pasted-20260929-143012-1.png", "pasted-20260929-143012-2.png"]
  )
})

// The sequence is the component's, not this call's: two pastes inside the same second share a stamp,
// and restarting at 1 would mint the same name twice.
test("the sequence can be continued across pastes", () => {
  const entries = normalizeFiles([fileOf("image.png", "image/png")], {
    stamp: "20260929-143012",
    sequence: 7,
  })
  assert.equal(entries[0].file.name, "pasted-20260929-143012-7.png")
})

test("only the placeholders consume a sequence number", () => {
  const entries = normalizeFiles(
    [fileOf("report.pdf", "application/pdf"), fileOf("image.png", "image/png")],
    { stamp: "20260929-143012" }
  )
  assert.deepEqual(
    entries.map((e) => e.file.name),
    ["report.pdf", "pasted-20260929-143012-1.png"]
  )
})

test("renaming can be turned off wholesale", () => {
  const [entry] = normalizeFiles([fileOf("image.png", "image/png")], {
    stamp: "20260929-143012",
    rename: false,
  })
  assert.equal(entry.file.name, "image.png")
  assert.equal(entry.renamed, false)
})

// --- what gets announced -------------------------------------------------------------------------

test("the announcement counts files and pluralises", () => {
  const one = { files: [{}], text: null, html: null }
  const two = { files: [{}, {}], text: null, html: null }
  assert.equal(describePaste(one, []), "1 file pasted")
  assert.equal(describePaste(two, []), "2 files pasted")
})

test("a text-only paste is announced as text", () => {
  assert.equal(describePaste({ files: [], text: "hi", html: null }, []), "Text pasted")
  assert.equal(describePaste({ files: [], text: null, html: "<b>hi</b>" }, []), "Formatted text pasted")
})

test("skipped files are announced alongside what was taken", () => {
  assert.equal(describePaste({ files: [{}], text: null, html: null }, [{}]), "1 file pasted, 1 skipped")
  assert.equal(describePaste({ files: [], text: null, html: null }, [{}, {}]), "2 skipped")
})

test("a paste that carried nothing describes nothing, for the caller to label", () => {
  assert.equal(describePaste({ files: [], text: null, html: null }, []), "")
})

// --- which element a paste belongs to ------------------------------------------------------------

test("a text box owns its own paste", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "text" }), true)
  assert.equal(isEditableTarget({ tagName: "input", type: "search" }), true)
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" }), true)
  assert.equal(isEditableTarget({ isContentEditable: true }), true)
})

// An input with no `type` is a text input, which is how most of them are written.
test("an input with no type is a text input", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT" }), true)
})

// Nothing can be pasted into these, so a paste that landed on one belongs to the region.
test("a checkbox, a read-only field and a disabled field are not text boxes", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "checkbox" }), false)
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "file" }), false)
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "text", readOnly: true }), false)
  assert.equal(isEditableTarget({ tagName: "TEXTAREA", disabled: true }), false)
})

test("an ordinary element is not a text box", () => {
  assert.equal(isEditableTarget({ tagName: "DIV" }), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget("body"), false)
})

// --- which clicks take focus ---------------------------------------------------------------------

test("controls take their own focus", () => {
  assert.equal(isFocusableTarget({ tagName: "BUTTON" }), true)
  assert.equal(isFocusableTarget({ tagName: "A" }), true)
  assert.equal(isFocusableTarget({ tagName: "DIV", tabIndex: 0 }), true)
})

test("ordinary content does not", () => {
  assert.equal(isFocusableTarget({ tagName: "DIV" }), false)
  assert.equal(isFocusableTarget({ tagName: "SPAN", tabIndex: -1 }), false)
  assert.equal(isFocusableTarget(null), false)
})

// --- permission errors ---------------------------------------------------------------------------

test("a refusal is told apart from a failure", () => {
  assert.equal(isPermissionError({ name: "NotAllowedError" }), true)
  assert.equal(isPermissionError({ name: "SecurityError" }), true)
  assert.equal(isPermissionError({ name: "DataError" }), false)
  assert.equal(isPermissionError(new Error("boom")), false)
  assert.equal(isPermissionError(null), false)
})

// --- the region ----------------------------------------------------------------------------------

const mount = (props = {}) => render(PasteArea, { onPaste: () => {}, ...props })

/** A paste event, with a recorder for whether the component claimed it. */
const pasteEvent = (clipboardData, target = { tagName: "DIV" }) => {
  const event = {
    clipboardData,
    target,
    prevented: false,
    preventDefault() {
      event.prevented = true
    },
  }
  return event
}

test("the region is focusable and named, with its instruction attached", () => {
  const tree = mount().tree
  assert.equal(tree.props.role, "group")
  assert.equal(tree.props.tabIndex, 0)
  assert.equal(tree.props["aria-label"], "Paste area")
  assert.ok(tree.props["aria-describedby"])
  const hint = walk(tree).find((n) => n.props?.id === tree.props["aria-describedby"])
  assert.ok(hint, "aria-describedby points at nothing")
})

test("a disabled region is out of the tab order and says so", () => {
  const tree = mount({ disabled: true }).tree
  assert.equal(tree.props.tabIndex, -1)
  assert.equal(tree.props["aria-disabled"], true)
})

// The live region is in the DOM before it has anything to say: one inserted at the same moment as
// its text is commonly announced late, or not at all.
test("the live region exists while it is still empty", () => {
  const status = walk(mount().tree).find((n) => n.props?.role === "status")
  assert.ok(status)
  assert.equal(status.props["aria-live"], "polite")
  assert.equal(status.props.children, "")
})

// The server has no `navigator`, so a button decided during render would be in the client's first
// tree and absent from the server's HTML — and React discards the whole tree over that rather than
// reconciling it. It appears after mount instead.
test("no clipboard button is rendered where the API is not there to ask", () => {
  assert.equal(byTag(walk(mount().tree), "button").length, 0)
})

test("a screenshot pasted into the region is delivered, renamed, and the event is claimed", () => {
  const seen = []
  const { tree } = mount({ onPaste: (p) => seen.push(p) })
  const event = pasteEvent(screenshotTransfer(fileOf("image.png", "image/png")))
  tree.props.onPaste(event)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, "event")
  assert.equal(seen[0].files.length, 1)
  assert.match(seen[0].files[0].file.name, /^pasted-\d{8}-\d{6}-1\.png$/)
  assert.equal(seen[0].files[0].originalName, "image.png")
  assert.equal(event.prevented, true)
})

// Both flavours reach the caller so they can decide; picking one here would be this component
// choosing between a spreadsheet's table and its tab-separated text on the caller's behalf.
test("a paste carrying both text and html hands over both", () => {
  const seen = []
  const { tree } = mount({ onPaste: (p) => seen.push(p) })
  tree.props.onPaste(
    pasteEvent({
      types: [TEXT_TYPE, HTML_TYPE],
      files: [],
      items: [],
      getData: (type) => (type === TEXT_TYPE ? "a\tb" : "<table></table>"),
    })
  )
  assert.equal(seen[0].text, "a\tb")
  assert.equal(seen[0].html, "<table></table>")
})

// A region that also holds a caption field must not eat the paste meant for it — the person would
// watch their text simply not appear.
test("a paste that landed in a text box inside the region is left to it", () => {
  const seen = []
  const { tree } = mount({ onPaste: (p) => seen.push(p) })
  const event = pasteEvent(screenshotTransfer(fileOf("image.png", "image/png")), {
    tagName: "INPUT",
    type: "text",
  })
  tree.props.onPaste(event)
  assert.equal(seen.length, 0)
  assert.equal(event.prevented, false)
})

test("a disabled region takes nothing", () => {
  const seen = []
  const { tree } = mount({ disabled: true, onPaste: (p) => seen.push(p) })
  const event = pasteEvent(screenshotTransfer(fileOf("image.png", "image/png")))
  tree.props.onPaste(event)
  assert.equal(seen.length, 0)
  assert.equal(event.prevented, false)
})

// Nothing was taken, so there is nothing to prevent — and the browser's own handling of a paste on a
// non-editable element is what should happen.
test("an empty paste is announced and the event is left alone", () => {
  const seen = []
  const view = mount({ onPaste: (p) => seen.push(p) })
  const event = pasteEvent({ types: [], files: [], items: [], getData: () => "" })
  view.tree.props.onPaste(event)
  view.rerender()

  assert.equal(seen.length, 0)
  assert.equal(event.prevented, false)
  const status = walk(view.tree).find((n) => n.props?.role === "status")
  assert.equal(status.props.children, "Nothing to paste")
})

test("files over the caps are reported rather than dropped in silence", () => {
  const rejected = []
  const seen = []
  const { tree } = mount({
    accept: "image/*",
    onPaste: (p) => seen.push(p),
    onReject: (r) => rejected.push(...r),
  })
  tree.props.onPaste(
    pasteEvent({
      types: ["Files"],
      files: [fileOf("doc.pdf", "application/pdf")],
      items: [],
      getData: () => "",
    })
  )
  assert.equal(seen.length, 0)
  assert.deepEqual(
    rejected.map((r) => [r.file.name, r.reason]),
    [["doc.pdf", "type"]]
  )
})

// Two pastes inside the same second share a stamp, so the sequence has to carry over — otherwise
// both screenshots are called `pasted-<same second>-1.png`.
test("a second paste in the same second does not reuse the first one's name", () => {
  const seen = []
  const { tree } = mount({ onPaste: (p) => seen.push(p) })
  tree.props.onPaste(pasteEvent(screenshotTransfer(fileOf("image.png", "image/png"))))
  tree.props.onPaste(pasteEvent(screenshotTransfer(fileOf("image.png", "image/png"))))
  assert.equal(seen.length, 2)
  assert.notEqual(seen[0].files[0].file.name, seen[1].files[0].file.name)
  assert.match(seen[1].files[0].file.name, /-2\.png$/)
})

test("keepGenericNames leaves the clipboard's own name in place", () => {
  const seen = []
  const { tree } = mount({ keepGenericNames: true, onPaste: (p) => seen.push(p) })
  tree.props.onPaste(pasteEvent(screenshotTransfer(fileOf("image.png", "image/png"))))
  assert.equal(seen[0].files[0].file.name, "image.png")
  assert.equal(seen[0].files[0].renamed, false)
})

// --- clicking to focus ---------------------------------------------------------------------------

test("clicking the region focuses it, so the next Ctrl+V has somewhere to go", () => {
  const view = mount()
  view.tree.props.onClick({ target: { tagName: "DIV" } })
  assert.deepEqual(
    view.nodes[0].calls.map((c) => c.name),
    ["focus"]
  )
})

// Focusing the region on every click would pull focus off the Paste button the instant it was used.
test("clicking a control inside the region leaves focus on the control", () => {
  const view = mount()
  view.tree.props.onClick({ target: { tagName: "BUTTON" } })
  assert.deepEqual(view.nodes[0].calls, [])
})

// --- the document listener -----------------------------------------------------------------------

/** Installs a `document` that records listeners, and takes it away again afterwards. */
function stubDocument(t) {
  const listeners = []
  globalThis.document = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
  t.after(() => {
    delete globalThis.document
  })
  return listeners
}

test("global mode listens on the document and stops when it unmounts", (t) => {
  const listeners = stubDocument(t)
  const view = mount({ global: true })
  assert.ok(listeners.length >= 1, "no document listener was registered")
  assert.ok(listeners.every((l) => l.type === "paste"))
  view.unmount()
  assert.deepEqual(listeners, [], "a document listener outlived the component")
})

test("a region that is not global leaves the document alone", (t) => {
  const listeners = stubDocument(t)
  mount()
  assert.deepEqual(listeners, [])
})

// One Ctrl+V while the region is focused reaches the element handler *and* bubbles to the document.
// Keeping both would deliver the screenshot twice, from a single keystroke.
test("global mode drops the element's own handler, so one paste is delivered once", (t) => {
  stubDocument(t)
  const seen = []
  const view = mount({ global: true, onPaste: (p) => seen.push(p) })
  assert.equal(view.tree.props.onPaste, undefined)
})

test("the document listener delivers the same payload the element handler would", (t) => {
  const listeners = stubDocument(t)
  const seen = []
  mount({ global: true, onPaste: (p) => seen.push(p) })
  listeners[0].fn(pasteEvent(screenshotTransfer(fileOf("image.png", "image/png"))))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].files.length, 1)
})

// A paste aimed at a search box elsewhere on the page reaches this listener too, and taking it would
// mean the person's text never arrives where they were typing.
test("a global listener ignores a paste aimed at a text box anywhere on the page", (t) => {
  const listeners = stubDocument(t)
  const seen = []
  mount({ global: true, onPaste: (p) => seen.push(p) })
  listeners[0].fn(
    pasteEvent(screenshotTransfer(fileOf("image.png", "image/png")), { tagName: "INPUT", type: "text" })
  )
  assert.equal(seen.length, 0)
})

// --- the clipboard button ------------------------------------------------------------------------

/** Installs a `navigator.clipboard.read` that answers with `items`, or rejects with `error`. */
function stubClipboard(t, { items, error } = {}) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator")
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        read: async () => {
          if (error) throw error
          return items ?? []
        },
      },
    },
    configurable: true,
    writable: true,
  })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "navigator", original)
    else delete globalThis.navigator
  })
}

const buttonOf = (view) => byTag(walk(view.tree), "button")[0]

test("the button appears once the browser turns out to have the API", (t) => {
  stubClipboard(t)
  const button = buttonOf(mount())
  assert.ok(button, "no clipboard button after mount")
  assert.equal(button.props.type, "button")
  assert.equal(button.props.children.at(-1), "Paste from clipboard")
})

test("hideButton keeps it out even where the API exists", (t) => {
  stubClipboard(t)
  assert.equal(byTag(walk(mount({ hideButton: true }).tree), "button").length, 0)
})

test("the button reads the clipboard and delivers what it found", async (t) => {
  stubClipboard(t, { items: [clipboardItem(["image/png"], { "image/png": "x" })] })
  const seen = []
  const view = mount({ onPaste: (p) => seen.push(p) })
  await buttonOf(view).props.onClick()

  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, "clipboard-api")
  assert.match(seen[0].files[0].file.name, /^pasted-\d{8}-\d{6}-1\.png$/)
  // The blob had no name of its own, which is a different thing from having a placeholder one.
  assert.equal(seen[0].files[0].originalName, null)
})

test("a refused clipboard says so, and points at the keystroke that still works", async (t) => {
  stubClipboard(t, { error: Object.assign(new Error("no"), { name: "NotAllowedError" }) })
  const view = mount()
  await buttonOf(view).props.onClick()
  view.rerender()
  const status = walk(view.tree).find((n) => n.props?.role === "status")
  assert.match(status.props.children, /permission denied/i)
  assert.match(status.props.children, /Ctrl\+V/)
})

test("a clipboard that fails for another reason is not reported as a refusal", async (t) => {
  stubClipboard(t, { error: new Error("boom") })
  const view = mount()
  await buttonOf(view).props.onClick()
  view.rerender()
  const status = walk(view.tree).find((n) => n.props?.role === "status")
  assert.equal(status.props.children, "Could not read the clipboard")
})

// `aria-disabled`, not `disabled`: a disabled button loses focus the moment it is pressed, dropping
// the keyboard user out of the region they were pasting into.
test("the button is never hard-disabled", (t) => {
  stubClipboard(t)
  const button = buttonOf(mount({ disabled: true }))
  assert.equal(button.props["aria-disabled"], true)
  assert.equal(button.props.disabled, undefined)
})

test("every visible string can be reworded", (t) => {
  stubClipboard(t)
  const view = mount({
    labels: { label: "貼り付け", hint: "ここに貼り付け", button: "クリップボードから" },
  })
  assert.equal(view.tree.props["aria-label"], "貼り付け")
  const texts = walk(view.tree).map((n) => n.props?.children)
  assert.ok(texts.includes("ここに貼り付け"))
  assert.equal(buttonOf(view).props.children.at(-1), "クリップボードから")
})
