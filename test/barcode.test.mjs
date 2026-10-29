// A barcode encoder written from a spec is the rare component whose bugs are completely invisible.
// A wrong row in the Code 128 table, a left-hand digit drawn with the wrong parity, or a check
// character weighted from the wrong end all produce a symbol that renders, prints, looks exactly
// like a barcode, and is simply never read — or worse, is read as a different string. Reading the
// symbol back is the only check that means anything, and reading it back with your own decoder only
// proves that the two halves share an assumption.
//
// So the digests below are not "whatever the encoder happened to emit". Every symbol they cover was
// rasterised from the path this component actually draws — not from the module array, so the path
// builder and the coordinate maths are inside what was checked — and decoded by Apple's Vision
// framework, an independent decoder sharing no code, no tables and no assumptions with this file.
// On 2026-10-29 that sweep was 153 symbols and all 153 read back byte for byte: every printable
// ASCII character, digit runs of every length from 1 to 24, digit runs embedded in text at every
// length where entering Code C is a judgement call, control characters, 60 random payloads at the
// shipped defaults, all ten EAN-13 first-digit parity rows, every digit in every one of the twelve
// EAN-13 positions, and five published retail numbers.
//
// A sweep that passes proves nothing on its own, so it was run against deliberately broken copies
// first. One Code 128 table row swapped with its neighbour: 9 of 153 stopped decoding. One EAN-13
// left-hand pattern replaced with its neighbour: 18 failed. One row of the first-digit parity table
// corrupted: 2 failed — and both were codes beginning with the digit whose row had been changed,
// which is what a parity fault looks like and nothing else does.
//
// That sweep needs macOS and a Swift toolchain, so it cannot run here. What runs here is its
// residue: freeze the verified symbols, and any later edit that shifts a table row or a turn fails
// immediately instead of shipping labels nobody can scan.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  code128CheckSymbol,
  encodeCode128,
  ean13CheckDigit,
  encodeEan13,
  encodeBarcode,
  barcodePath,
  Barcode,
} = loadComponent(join(ROOT, "registry", "ui", "barcode.tsx"))

const bits = (modules) => modules.map((m) => (m ? "1" : "0")).join("")
const serialise = (b) =>
  [b.symbology, b.value, b.quietZone, b.guards.map((g) => g.join("-")).join(","), bits(b.modules)].join("|")
const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32)

/**
 * The sweep Vision read, regenerated exactly. The random cases are seeded, so this is the same list
 * of payloads in the same order — change any of it and the digests below are no longer the ones that
 * were decoded, which is the point of keeping the generator here rather than a list of strings.
 */
function sweep() {
  const cases = []
  const printable = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))
  for (let i = 0; i < printable.length; i += 10) {
    cases.push({ id: `c128-ascii-${i}`, symbology: "code128", value: printable.slice(i, i + 10).join("") })
  }
  for (let n = 1; n <= 24; n++) {
    cases.push({ id: `c128-digits-${n}`, symbology: "code128", value: "1234567890".repeat(3).slice(0, n) })
  }
  for (let n = 1; n <= 10; n++) {
    cases.push({ id: `c128-mixed-${n}`, symbology: "code128", value: `AB${"7".repeat(n)}CD` })
  }
  for (const value of [
    "PKG-4417-A", "pulld.pages.dev/r/barcode.json", "Order #10294/2026", "a", "0", "~",
    "lower case and UPPER CASE 12345", "SKU0001", "{}[]|\\^`", "ABC-1234567890123456789-XYZ",
    "1A2B3C4D5E", "999999999999999999999999", "Tab\tseparated", "\u0000\u001f start control",
  ]) cases.push({ id: `c128-lit-${cases.length}`, symbology: "code128", value })
  let seed = 20261029
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  for (let i = 0; i < 60; i++) {
    const len = 1 + Math.floor(rnd() * 24)
    let v = ""
    for (let k = 0; k < len; k++) v += printable[Math.floor(rnd() * printable.length)]
    cases.push({ id: `c128-rnd-${i}`, symbology: "code128", value: v })
  }
  for (let f = 0; f <= 9; f++) cases.push({ id: `ean-first-${f}`, symbology: "ean13", value: `${f}12345678901` })
  for (let d = 0; d <= 9; d++) cases.push({ id: `ean-rep-${d}`, symbology: "ean13", value: String(d).repeat(12) })
  for (let d = 0; d <= 9; d++) {
    cases.push({ id: `ean-pos-${d}`, symbology: "ean13", value: `5${String(d).repeat(5)}${String(9 - d).repeat(6)}` })
  }
  for (const value of ["4006381333931", "9780306406157", "0012345678905", "9780143007234", "5012345678900"])
    cases.push({ id: `ean-pub-${value}`, symbology: "ean13", value })
  return cases
}

const group = (symbology) =>
  digest(
    sweep()
      .filter((c) => c.symbology === symbology)
      .map((c) => `${c.id}:${serialise(encodeBarcode(c.value, { symbology: c.symbology }))}`)
      .join("\n"),
  )

// --- the frozen symbols ----------------------------------------------------------------------------

test("the 118 Code 128 symbols Vision decoded are still encoded the same way", () => {
  assert.equal(sweep().filter((c) => c.symbology === "code128").length, 118)
  assert.equal(group("code128"), "6d221eeccdab4f7273f070acf73689c9")
})

test("the 35 EAN-13 symbols Vision decoded are still encoded the same way", () => {
  assert.equal(sweep().filter((c) => c.symbology === "ean13").length, 35)
  assert.equal(group("ean13"), "e9e8f149f4a3fcc574cb68cc7910efa2")
})

test("all ten first-digit parity rows still produce the symbols Vision decoded", () => {
  // Separated from the sweep digest above because this is the table a wrong row hides in best: the
  // first digit is not drawn anywhere, so a bad row produces a symbol that reads as a *different
  // product* rather than failing to read. Broken deliberately, exactly two of the 153 failed, both
  // of them codes starting with the digit whose row was changed.
  const rows = Array.from({ length: 10 }, (_, f) => serialise(encodeEan13(`${f}12345678901`)))
  assert.equal(digest(rows.join("\n")), "72585b75038a4750f49e51a2b1fbf941")
})

test("a published retail number is still the published symbol, module for module", () => {
  // One case written out in full, so that a reader can check this file against a reference without
  // running anything: guard, six left digits under the parity for a leading 4 (odd, even, odd, odd,
  // even, even), centre guard, six right digits, guard. 95 modules, as every EAN-13 is.
  assert.equal(
    bits(encodeEan13("4006381333931").modules),
    "10100011010100111010111101111010001001011001101010100001010000101000010111010010000101100110101",
  )
  assert.equal(encodeEan13("4006381333931").modules.length, 95)
})

// --- the tables, as drawn --------------------------------------------------------------------------

/** Every symbol value the encoder emitted for `text`, with the modules it drew for each. */
function drawnPatterns(text, into = new Map()) {
  const barcode = encodeCode128(text)
  let at = 0
  for (const value of barcode.symbols) {
    const width = value === 106 ? 13 : 11
    into.set(value, bits(barcode.modules.slice(at, at + width)))
    at += width
  }
  return into
}

test("every Code 128 pattern this draws is a legal element pattern", () => {
  // The one table in the component that cannot be derived from anything, checked through the
  // encoder's own output rather than by reaching into the source. Four facts hold for every row of
  // real Code 128, and the fourth is the format's own self-checking property — a row whose bars sum
  // to an odd number is not a row of Code 128 at all, whatever it looks like on paper.
  const drawn = new Map()
  for (let code = 0; code < 128; code++) drawnPatterns(String.fromCharCode(code), drawn)
  // The values a single character never produces: the two shifts and switches, and the three start
  // characters. FNC1 and FNC2 (102 and 97) are absent on purpose — this encoder has no use for
  // them, so those rows are never drawn and asserting them would be asserting dead weight.
  for (const text of ["\u0001a\u0001", "A123456", "123456a", "aaa\u0001\u0001\u0001", "1234567890"]) {
    drawnPatterns(text, drawn)
  }
  const expected = [...Array.from({ length: 96 }, (_, v) => v), 98, 99, 100, 101, 103, 104, 105, 106]
  for (const value of expected) assert.ok(drawn.has(value), `value ${value} was never drawn`)

  for (const [value, pattern] of drawn) {
    const runs = pattern.match(/(.)\1*/g).map((r) => r.length)
    const width = value === 106 ? 13 : 11
    const elements = value === 106 ? 7 : 6
    assert.equal(pattern.length, width, `value ${value} is ${pattern.length} modules, not ${width}`)
    assert.equal(pattern[0], "1", `value ${value} does not start with a bar`)
    assert.equal(runs.length, elements, `value ${value} has ${runs.length} elements, not ${elements}`)
    assert.ok(
      runs.every((w) => w >= 1 && w <= 4),
      `value ${value} has an element outside 1..4 modules`,
    )
    const bars = runs.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
    assert.equal(bars % 2, 0, `value ${value} has an odd bar sum, which no Code 128 pattern has`)
  }
  assert.equal(new Set(drawn.values()).size, drawn.size, "two symbol values draw the same pattern")
})

test("EAN-13's three digit alphabets are still complements and reverses of each other", () => {
  // The component tabulates one of them and derives the other two. This checks the relationship in
  // the drawn output rather than in the source, so it holds whichever of the three a future edit
  // decides to write out: the right-hand pattern is the complement of the left-hand odd one, and
  // the left-hand even one is that complement reversed. Parity is the consequence that matters —
  // odd on the left-odd set, even on the other two — because parity is what carries the first digit.
  const ones = (p) => [...p].filter((b) => b === "1").length
  for (let d = 0; d <= 9; d++) {
    // A leading zero is six odd patterns, so every left digit here is the odd form.
    const odd = encodeEan13(`0${String(d).repeat(11)}`)
    const left = bits(odd.modules).slice(3, 10)
    const right = bits(odd.modules).slice(50, 57)
    // A leading 1 is "OOEOEE", so the third left digit is the even form.
    const even = bits(encodeEan13(`1${String(d).repeat(11)}`).modules).slice(17, 24)

    assert.equal(right, [...left].map((b) => (b === "1" ? "0" : "1")).join(""), `digit ${d}: right is not the complement of left`)
    assert.equal(even, [...right].reverse().join(""), `digit ${d}: the even form is not the reversed complement`)
    assert.equal(ones(left) % 2, 1, `digit ${d}: the left-odd pattern has even parity`)
    assert.equal(ones(even) % 2, 0, `digit ${d}: the left-even pattern has odd parity`)
    assert.equal(ones(right) % 2, 0, `digit ${d}: the right pattern has odd parity`)
    assert.equal(left[0], "0", `digit ${d}: a left pattern must start with a space`)
    assert.equal(right[0], "1", `digit ${d}: a right pattern must start with a bar`)
  }
})

// --- the check characters --------------------------------------------------------------------------

test("the EAN-13 check digit agrees with five published numbers", () => {
  // Published numbers rather than numbers this computed: a check digit routine that agrees with
  // itself is worth nothing, and the weights are the one place an off-by-one reverses silently.
  assert.equal(ean13CheckDigit("400638133393"), 1)
  assert.equal(ean13CheckDigit("978030640615"), 7)
  assert.equal(ean13CheckDigit("001234567890"), 5)
  assert.equal(ean13CheckDigit("978014300723"), 4)
  assert.equal(ean13CheckDigit("501234567890"), 0)
})

test("twelve digits gets a check digit, thirteen gets it verified", () => {
  assert.equal(encodeEan13("400638133393").value, "4006381333931")
  assert.equal(encodeEan13("400638133393").checkDigit, 1)
  assert.equal(encodeEan13("4006381333931").value, "4006381333931")
  // Not corrected. A number with one digit wrong is a real product somewhere, and repairing the
  // check digit would print a symbol that scans perfectly as the wrong item — so the thrown message
  // carries the digit that was expected, which is what tells a typo from bad source data.
  assert.throws(() => encodeEan13("4006381333932"), /check digit for 400638133393 is 1, not 2/)
})

test("EAN-13 takes the grouping characters it is printed with, and nothing else", () => {
  assert.equal(encodeEan13("400-638 133393 1").value, "4006381333931")
  // A sign or a decimal point means the value went through something that treated it as a number,
  // after which the digits cannot be trusted at all.
  assert.throws(() => encodeEan13("+4006381333931"), /needs 12 or 13 digits/)
  assert.throws(() => encodeEan13("4.00638133393"), /needs 12 or 13 digits/)
  assert.throws(() => encodeEan13("123"), /needs 12 or 13 digits/)
  assert.throws(() => encodeEan13("40063813339311"), /needs 12 or 13 digits/)
  assert.throws(() => ean13CheckDigit("400638133393" + "1"), /exactly 12 digits/)
})

test("the Code 128 check symbol is weighted by position", () => {
  // Unweighted, a transposition would pass — and two characters swapped is exactly what a partly
  // read or smudged symbol produces, so this is the half of the check that earns its place.
  assert.notEqual(encodeCode128("AB").symbols.at(-2), encodeCode128("BA").symbols.at(-2))
  assert.equal(code128CheckSymbol([104, 33, 34]), (104 + 33 * 1 + 34 * 2) % 103)
  // The start value is added unweighted; everything after it counts from position one.
  assert.equal(encodeCode128("AB").symbols.at(-2), code128CheckSymbol([104, 33, 34]))
  assert.equal(encodeCode128("AB").symbols.at(-1), 106)
})

// --- choosing the packing ---------------------------------------------------------------------------

const symbolCount = (value) => encodeCode128(value).symbols.length

test("a digit run is packed two to a symbol, and an odd one leaves the set for its last digit", () => {
  // Six digits: start C, three pairs, check, stop.
  assert.equal(symbolCount("123456"), 6)
  assert.deepEqual(encodeCode128("123456").symbols.slice(0, 4), [105, 12, 34, 56])
  // Seven: the odd digit costs a switch and a symbol of its own either way round, so eight.
  assert.equal(symbolCount("1234567"), 8)
  // Twenty-four digits is twelve symbols of payload, not twenty-four.
  assert.equal(symbolCount("123456789012345678901234"), 15)
})

test("a digit run inside text is only entered when it pays for the switch", () => {
  // Two symbols to get in and out, one saved per pair: four digits break even and the search keeps
  // them where they are, six is the first run that is worth it. Getting this wrong is not a
  // correctness bug, which is why it is easy to leave wrong — it is three millimetres of extra bar
  // on a label whose width was already decided.
  assert.equal(symbolCount("AB77CD"), 9)
  assert.equal(symbolCount("AB7777CD"), 11) // same as staying in B for all four
  assert.ok(!encodeCode128("AB7777CD").symbols.includes(99), "four digits should not be worth Code C")
  assert.equal(symbolCount("AB777777CD"), 12) // one fewer than the thirteen staying in B would cost
  assert.ok(encodeCode128("AB777777CD").symbols.includes(99), "six digits should be worth Code C")
})

test("one borrowed character is shifted, several are switched to", () => {
  // A control character sits in set A only and a lower-case letter in B only, so a string that
  // alternates between them is the case the two mechanisms are for. One character: shift, which
  // costs two symbols and comes straight back. Three: switch, which costs one and stays.
  const one = encodeCode128("\u0001a\u0001").symbols
  assert.ok(one.includes(98), "a single borrowed character should be shifted")
  assert.equal(one.filter((s) => s === 99 || s === 100 || s === 101).length, 0)
  const several = encodeCode128("aaa\u0001\u0001\u0001").symbols
  assert.ok(several.includes(101), "three characters from the other set should be switched to")
  assert.ok(!several.includes(98), "a switch makes the shift unnecessary")
})

test("Code 128 refuses what it cannot carry, naming the character", () => {
  // The common way a label pipeline fails: an accented name or a curly quote arriving from a
  // spreadsheet. There is a mechanism in the format for the upper half of Latin-1, but scanners
  // disagree about it to the point that the output is not dependable, so this declines instead.
  assert.throws(() => encodeCode128("café"), /ASCII only; "é" at index 3 is U\+00E9/)
  assert.throws(() => encodeCode128("“quoted”"), /ASCII only/)
  assert.throws(() => encodeCode128(""), /at least one character/)
})

// --- drawing -----------------------------------------------------------------------------------------

test("adjacent modules are drawn as one bar, and a guard never merges with its neighbour", () => {
  // Drawn one module at a time, the edges where two dark modules meet get antialiased, and a
  // hairline of background down the middle of a wide bar is read as two bars by cheap hardware.
  const plain = { symbology: "code128", value: "x", modules: [true, true, false, true], quietZone: 0, guards: [] }
  assert.equal(barcodePath(plain, { moduleWidth: 1, height: 10 }), "M0 0h2v10h-2zM3 0h1v10h-1z")
  // A dark module inside a guard range is taller, so the run has to break at the boundary even
  // though the modules either side of it are both dark.
  const guarded = { symbology: "ean13", value: "x", modules: [true, true, true, true], quietZone: 0, guards: [[0, 2]] }
  assert.equal(barcodePath(guarded, { moduleWidth: 1, height: 10, guardDrop: 5 }), "M0 0h2v15h-2zM2 0h2v10h-2z")
})

test("the quiet zone is offset into the drawing, not left to the caller", () => {
  const b = { symbology: "code128", value: "x", modules: [true], quietZone: 10, guards: [] }
  assert.equal(barcodePath(b, { moduleWidth: 2, height: 10 }), "M20 0h2v10h-2z")
})

// --- the component ------------------------------------------------------------------------------------

const svgOf = (props) => byTag(walk(render(Barcode, props).tree), "svg")[0]
const textsOf = (props) => byTag(walk(render(Barcode, props).tree), "text")

test("it is an image with a name, and an EAN-13 is announced in its printed groups", () => {
  // The opposite default to a QR code, deliberately: a 1D symbol carries a short identifier somebody
  // may have to read out or type, not a URL or a secret. Grouped so that it is read as digits rather
  // than as one twelve-figure number.
  assert.equal(svgOf({ value: "4006381333931", symbology: "ean13" }).props.role, "img")
  assert.equal(
    svgOf({ value: "4006381333931", symbology: "ean13" }).props["aria-label"],
    "Barcode: 4 006381 333931",
  )
  // Twelve digits in, and the announcement carries the check digit that was computed — the number
  // the scanner will actually report, not the one that was passed.
  assert.equal(svgOf({ value: "400638133393", symbology: "ean13" }).props["aria-label"], "Barcode: 4 006381 333931")
  assert.equal(svgOf({ value: "PKG-4417-A" }).props["aria-label"], "Barcode: PKG-4417-A")
  assert.equal(svgOf({ value: "PKG-4417-A", label: "Package" }).props["aria-label"], "Package: PKG-4417-A")
  assert.equal(svgOf({ value: "PKG-4417-A", announceValue: false }).props["aria-label"], "Barcode")
})

test("a value that cannot be encoded renders the fallback, not an exception", () => {
  // One bad row in a label sheet should not take the page with it. The encoders still throw for a
  // print job, which is a place a missing symbol is worth stopping for.
  assert.equal(byTag(walk(render(Barcode, { value: "" }).tree), "svg").length, 0)
  const nodes = walk(render(Barcode, { value: "123", symbology: "ean13", fallback: { type: "p", props: { children: "Bad code" } } }).tree)
  assert.equal(byTag(nodes, "svg").length, 0)
  assert.equal(byTag(nodes, "p")[0].props.children, "Bad code")
  assert.equal(byTag(walk(render(Barcode, { value: "café" }).tree), "svg").length, 0)
})

test("the symbology is never inferred from the payload", () => {
  // Thirteen digits are a valid payload for both, so a component that guessed would turn a shipping
  // reference into a retail product code the first time one happened to be thirteen digits long.
  const asText = svgOf({ value: "4006381333931" })
  const asRetail = svgOf({ value: "4006381333931", symbology: "ean13" })
  assert.notEqual(asText.props.width, asRetail.props.width)
  assert.equal(asRetail.props.width, (95 + 22) * 2)
})

test("coordinates are whole numbers and the renderer is told not to smooth them", () => {
  // Whole numbers because a bar on a half pixel is spread over two, and the grey left behind is read
  // as bar by some scanners and as space by others — which is the same as getting the widths wrong.
  const svg = svgOf({ value: "4006381333931", symbology: "ean13", moduleWidth: 3 })
  assert.equal(svg.props.shapeRendering, "crispEdges")
  const d = byTag(walk(render(Barcode, { value: "4006381333931", symbology: "ean13", moduleWidth: 3 }).tree), "path")[0].props.d
  for (const [, x, w, h] of d.matchAll(/M([\d.]+) 0h([\d.]+)v([\d.]+)h-[\d.]+z/g)) {
    for (const n of [x, w, h]) assert.ok(Number.isInteger(Number(n)), `${n} is not a whole number`)
  }
})

test("nothing here scales the symbol to fit its container", () => {
  // The single most common way a symbol that looks finished turns out to be unreadable: a scanner
  // resolves the narrowest element or it resolves nothing, so a max-width that shrinks the picture
  // is not a smaller barcode. A QR code can take that treatment; this cannot.
  const svg = svgOf({ value: "PKG-4417-A" })
  assert.equal(svg.props.className, undefined)
  // Thirteen symbols — start, ten characters, check, stop — of which the stop is 13 modules wide
  // and the rest 11, plus ten modules of margin either side, at two pixels a module.
  const modules = 12 * 11 + 13
  assert.equal(svg.props.width, (modules + 20) * 2)
  assert.equal(svg.props.viewBox, `0 0 ${(modules + 20) * 2} 76`)
  // A caller's own class is still passed through untouched.
  assert.equal(svgOf({ value: "PKG-4417-A", className: "rounded" }).props.className, "rounded")
})

test("the printed line is three groups, each under its own half of the symbol", () => {
  // The standard layout, and not decoration: the first digit sits outside the symbol in the left
  // margin, which is part of why that margin is the wider of the two. Each group is stretched to
  // span its own half rather than trusting a font's metrics, so the digits stay under their own bars
  // in a project whose mono face is not the one this was written against.
  const texts = textsOf({ value: "4006381333931", symbology: "ean13" })
  assert.deepEqual(texts.map((t) => t.props.children), ["4", "006381", "333931"])
  assert.equal(texts[0].props.textAnchor, "end")
  assert.equal(texts[0].props.x, 20) // one module in from the symbol, inside the 11-module margin
  assert.equal(texts[1].props.x, 30)
  assert.equal(texts[1].props.textLength, 80)
  assert.equal(texts[2].props.x, 124)
  assert.equal(texts[2].props.textLength, 80)
  for (const t of texts) assert.equal(t.props.lengthAdjust ?? "spacing", "spacing")
  // A Code 128 line is simply centred, with no groups to line up.
  const plain = textsOf({ value: "PKG-4417-A" })
  assert.equal(plain.length, 1)
  assert.equal(plain[0].props.textAnchor, "middle")
  assert.equal(plain[0].props.children, "PKG-4417-A")
})

test("a payload with control characters has no printed line unless one is given", () => {
  // There is no honest printed form of a control character, so the line is dropped rather than
  // filled with whatever glyphs the font happens to have for them.
  assert.equal(textsOf({ value: "A\u0001B" }).length, 0)
  assert.equal(textsOf({ value: "A\u0001B", text: "A-SOH-B" })[0].props.children, "A-SOH-B")
  assert.equal(textsOf({ value: "PKG-4417-A", showText: false }).length, 0)
  // An override prints instead of the value, which is how a number gets grouped for a reader.
  assert.equal(textsOf({ value: "4006381333931", symbology: "ean13", text: "1234567890123" })[1].props.children, "234567")
})

test("the height follows from the bars, the guards and whether the digits are shown", () => {
  // `height` is the data bars. Guards drop five modules below them and the digits need a band of
  // eight, so the element is taller than the number passed — which is worth pinning, because a
  // caller who reserved exactly `height` would clip the digits off.
  assert.equal(svgOf({ value: "4006381333931", symbology: "ean13" }).props.height, 60 + 16)
  assert.equal(svgOf({ value: "4006381333931", symbology: "ean13", showText: false }).props.height, 60 + 10)
  assert.equal(svgOf({ value: "PKG-4417-A" }).props.height, 60 + 16)
  assert.equal(svgOf({ value: "PKG-4417-A", showText: false }).props.height, 60)
  assert.equal(svgOf({ value: "PKG-4417-A", showText: false, height: 40, moduleWidth: 4 }).props.height, 40)
})

test("the quiet zone defaults to what the symbology requires and can be widened", () => {
  // Specified as a multiple of the module rather than a distance, so printing the same symbol
  // smaller shrinks the margin with it — which is why it is applied here and not left to CSS.
  assert.equal(encodeCode128("A").quietZone, 10)
  assert.equal(encodeEan13("4006381333931").quietZone, 11)
  assert.equal(svgOf({ value: "PKG-4417-A", quietZone: 20 }).props.width, (12 * 11 + 13 + 40) * 2)
})

test("the ground is drawn, and the colours do not follow the theme", () => {
  // The margin has to be light for the symbol to be found at all, and a transparent one takes the
  // colour of whatever is behind it. Dark-on-light is what decoders assume, so this stays black on
  // white in dark mode — like a parcel label — and the overrides are there for a tested exception.
  const nodes = walk(render(Barcode, { value: "PKG-4417-A" }).tree)
  assert.equal(byTag(nodes, "rect")[0].props.className, "fill-white")
  assert.equal(byTag(nodes, "path")[0].props.className, "fill-black")
  const themed = walk(render(Barcode, { value: "PKG-4417-A", barClassName: "fill-foreground", backgroundClassName: "fill-transparent" }).tree)
  assert.equal(byTag(themed, "rect")[0].props.className, "fill-transparent")
  assert.equal(byTag(themed, "path")[0].props.className, "fill-foreground")
  // The printed digits follow the bars, so an override of one does not leave the other behind.
  assert.equal(byTag(themed, "text")[0].props.className, "fill-foreground")
  assert.equal(textsOf({ value: "PKG-4417-A", barClassName: "fill-foreground", textClassName: "fill-muted-foreground" })[0].props.className, "fill-muted-foreground")
})

test("repeated renders of the same value are byte-identical", () => {
  // There is a small cache behind this, which is what lets the component stay hook-free and render
  // on a server. A cache that ever returned a different symbol for the same input would be worse
  // than no cache at all.
  const pathOf = (props) => byTag(walk(render(Barcode, props).tree), "path")[0].props.d
  assert.equal(pathOf({ value: "PKG-4417-A" }), pathOf({ value: "PKG-4417-A" }))
  // Keyed by symbology as well as value, or the same thirteen digits would come back as the wrong
  // symbology the second time they were asked for.
  assert.notEqual(pathOf({ value: "4006381333931" }), pathOf({ value: "4006381333931", symbology: "ean13" }))
  assert.equal(pathOf({ value: "4006381333931", symbology: "ean13" }), pathOf({ value: "400638133393", symbology: "ean13" }))
})

// --- the holes mutation testing found -------------------------------------------------------------
//
// 282 mutants, 239 killed. Of the 43 that lived, 35 are equivalent — a loop bound re-imposed by the
// `modules[end]` guard beside it, a `??` that only differs for an empty string, a parity row with no
// "E" in it either way, the cache limit, which is an optimisation and has no output. The eight below
// were real: each one is a rule the component follows that nothing here was holding it to.

test("a zero quiet zone is honoured rather than replaced by the default", () => {
  // `??`, not `||`. Asking for no margin is a real request — the surrounding page may already be
  // white space — and a falsy check would quietly hand back the symbology's default instead, which
  // is the opposite of what was asked and invisible until something is laid out against it.
  assert.equal(svgOf({ value: "PKG-4417-A", quietZone: 0 }).props.width, (12 * 11 + 13) * 2)
})

test("the printed digits are sized and placed off the module width", () => {
  // Everything about the line scales with the module rather than being a fixed pixel size, so a
  // symbol at moduleWidth 4 does not get the digits of one at 2. The baseline sits far enough below
  // the bars to clear them and high enough to stay inside the band the height reserves — at zero it
  // would be drawn straight through the symbol, which is a mutant that otherwise lives.
  for (const moduleWidth of [2, 4]) {
    const t = textsOf({ value: "4006381333931", symbology: "ean13", moduleWidth })[0]
    assert.equal(t.props.fontSize, 7 * moduleWidth)
    assert.equal(t.props.y, 60 + 6.5 * moduleWidth)
    assert.ok(t.props.y > 60, "the digits must sit below the data bars")
    assert.ok(t.props.y <= 60 + 8 * moduleWidth, "the digits must stay inside the band the height reserves")
  }
  // The Code 128 line is centred on the whole picture, margins included.
  const line = textsOf({ value: "PKG-4417-A" })[0]
  assert.equal(line.props.x, ((12 * 11 + 13 + 20) * 2) / 2)
})

test("the printed digits default to the same colour as the bars", () => {
  // A line left at some other default would be the one part of the symbol that did not follow an
  // override — or worse, invisible on the drawn ground.
  for (const t of textsOf({ value: "4006381333931", symbology: "ean13" })) {
    assert.equal(t.props.className, "fill-black")
  }
  assert.equal(textsOf({ value: "PKG-4417-A" })[0].props.className, "fill-black")
})

test("the shortest of the two ways to borrow a character is the one chosen", () => {
  // One control character, one lower-case letter, one control character. Shifting from set A costs
  // seven symbols in total; starting in B and shifting twice costs eight. Both use a shift, so
  // asserting that a shift happened does not pin which encoding was picked — the count does.
  // Start A, the control character, shift, the letter read as set B, the control character again,
  // the check symbol — which for this payload is 98 as well, and is not a second shift.
  assert.deepEqual(encodeCode128("\u0001a\u0001").symbols, [103, 65, 98, 65, 65, 98, 106])
  assert.equal(encodeCode128("\u0001a\u0001").symbols.length, 7, "starting in B and shifting twice would cost eight")
})

test("the top of set A is the underscore, and the backtick above it forces set B", () => {
  // Set A runs to ASCII 95 and set B from 32, so 95 is the last character a control-character
  // payload can keep in A and 96 is the first that drags it into B. An off-by-one here costs two
  // symbols on a payload that mixes the two, and nothing about the output looks wrong.
  assert.deepEqual(encodeCode128("\u0001_").symbols, [103, 65, 63, 88, 106])
  const backtick = encodeCode128("\u0001`").symbols
  assert.equal(backtick[0], 104, "a backtick is not in set A, so the symbol has to start in B")
  assert.ok(backtick.includes(98), "and borrow the control character back by shifting")
})

test("barcodePath draws every bar the same height unless it is told otherwise", () => {
  // The documented default for a symbology with no guards. The component always passes it
  // explicitly; a caller driving a label printer off the exported function may not.
  const guarded = { symbology: "ean13", value: "x", modules: [true, true], quietZone: 0, guards: [[0, 1]] }
  assert.equal(barcodePath(guarded, { moduleWidth: 1, height: 10 }), "M0 0h1v10h-1zM1 0h1v10h-1z")
})

test("the bars sit inside the canvas at every quiet zone, with the margin on both sides", () => {
  // The defect this was written for: the path was offset by the symbology's own quiet zone while the
  // canvas was measured from the prop, so `quietZone={0}` drew the last twenty pixels of the symbol
  // — its stop pattern — outside the viewBox, where it is clipped. The symbol still looked finished
  // and ended in the middle of a character. Checking the width alone does not see it; the position
  // of the first and last bar does.
  for (const [props, modules] of [
    [{ value: "PKG-4417-A" }, 12 * 11 + 13],
    [{ value: "PKG-4417-A", quietZone: 0 }, 12 * 11 + 13],
    [{ value: "PKG-4417-A", quietZone: 20 }, 12 * 11 + 13],
    [{ value: "4006381333931", symbology: "ean13" }, 95],
    [{ value: "4006381333931", symbology: "ean13", quietZone: 2, moduleWidth: 3 }, 95],
  ]) {
    const tree = walk(render(Barcode, { ...props, showText: false }).tree)
    const svg = byTag(tree, "svg")[0].props
    const bars = [...byTag(tree, "path")[0].props.d.matchAll(/M([\d.]+) 0h([\d.]+)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ])
    const moduleWidth = props.moduleWidth ?? 2
    const margin = (props.quietZone ?? (props.symbology === "ean13" ? 11 : 10)) * moduleWidth
    assert.equal(svg.width, modules * moduleWidth + margin * 2, `width for ${JSON.stringify(props)}`)
    // The first bar of both symbologies is the first module, and the last module is a bar too, so
    // the symbol spans exactly the canvas less its two margins.
    assert.equal(bars[0][0], margin, `first bar for ${JSON.stringify(props)}`)
    assert.equal(bars.at(-1)[0] + bars.at(-1)[1], svg.width - margin, `last bar for ${JSON.stringify(props)}`)
  }
})

test("barcodePath takes the quiet zone it is drawn in", () => {
  const b = { symbology: "code128", value: "x", modules: [true], quietZone: 10, guards: [] }
  assert.equal(barcodePath(b, { moduleWidth: 2, height: 10, quietZone: 0 }), "M0 0h2v10h-2z")
  assert.equal(barcodePath(b, { moduleWidth: 2, height: 10, quietZone: 3 }), "M6 0h2v10h-2z")
})

test("a payload with no printed form has no spoken one either", () => {
  // The same honesty as the dropped text line: a name carrying control characters is read as
  // nothing at all, or as whatever glyph the reader substitutes, neither of which is the data.
  assert.equal(svgOf({ value: "A\u0001B" }).props["aria-label"], "Barcode")
  assert.equal(svgOf({ value: "A\u0001B", label: "Asset tag" }).props["aria-label"], "Asset tag")
  // Printable payloads are unaffected.
  assert.equal(svgOf({ value: "A B" }).props["aria-label"], "Barcode: A B")
})
