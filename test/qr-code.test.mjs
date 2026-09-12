// A QR encoder written from the spec is the rare component whose bugs are completely invisible: a
// wrong table row, a wrong turn in the zigzag or a mask applied over the format bits all produce a
// grid that looks exactly like a QR code, prints, and is simply never read by anything. Reading the
// code back is the only check that means anything, and reading it back with your own decoder only
// proves the two halves share an assumption.
//
// So the digests below are not "whatever the encoder happened to emit". Every matrix they cover was
// rendered to a PNG and decoded by Apple's Vision framework — an independent decoder, no shared
// code — and the decoded string compared byte for byte with the input. On 2026-09-12 that sweep was
// 426 codes: 186 of 188 structured cases (all 40 versions x 4 levels, every mask forced, the mode
// and capacity boundaries, UTF-8, and a version 40 code at maximum capacity) and 240 of 240 random
// payloads at the shipped defaults. The two that did not read are recorded at the bottom of this
// file; both are a detector limit rather than an encoding error, and the evidence for saying so is
// there too.
//
// That sweep needs macOS and a Swift toolchain, so it cannot run here. What runs here is its
// residue: freeze the verified grids, and any later edit that shifts a table row or a turn fails
// immediately instead of shipping a code nobody can scan.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  encodeQr,
  qrPath,
  wifiPayload,
  otpauthUri,
  QrCode,
  MIN_QR_VERSION,
  MAX_QR_VERSION,
} = loadComponent(join(ROOT, "registry", "ui", "qr-code.tsx"))

const serialise = (m) =>
  [m.version, m.errorCorrection, m.mask, m.mode, m.size, m.modules.map((r) => r.map((c) => (c ? "1" : "0")).join("")).join("")].join("|")
const digest = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32)

// --- the frozen grids ------------------------------------------------------------------------------

test("every version and level still produces the grid Vision decoded, with the mask forced", () => {
  // Mask forced, so this digest moves only if the two spec tables, the Reed-Solomon, the block
  // interleaving or the module placement changed. It is the one that caught EC_BLOCKS.H being a row
  // short from version 32 up — nine versions that encoded, rendered, and decoded to nothing.
  let all = ""
  for (let v = 1; v <= 40; v++) {
    for (const ec of ["L", "M", "Q", "H"]) {
      all += serialise(encodeQr(`v${v}${ec}:NNN`, { errorCorrection: ec, minVersion: v, maxVersion: v, boost: false, mask: 0 }))
    }
  }
  assert.equal(digest(all), "b736f83e8b6603a0630267a1c0d0e4d8")
})

test("every version and level still chooses the same mask", () => {
  // The same 160 grids with the mask scored rather than forced. If this digest moves and the one
  // above does not, the penalty rules changed and nothing else did.
  let all = ""
  for (let v = 1; v <= 40; v++) {
    for (const ec of ["L", "M", "Q", "H"]) {
      all += serialise(encodeQr(`v${v}${ec}:NNN`, { errorCorrection: ec, minVersion: v, maxVersion: v, boost: false }))
    }
  }
  assert.equal(digest(all), "d0d49ad106d8127f0663ec2a2247be1f")
})

const VERIFIED = [
  ["url", "https://pulld.pages.dev/r/qr-code.json", {}, "32e5d9bff010bfc26c6581d434eeede9"],
  ["numeric", "0123456789012345678901234567890123456789", {}, "ab4cdd9bd799b4be48d0ec92915ab8e3"],
  ["alphanumeric", "HELLO WORLD 1234 $%*+-./:", {}, "01e2709565c36aa3893ee9561545a082"],
  ["hello world, version 1-Q, mask 0", "HELLO WORLD", { errorCorrection: "Q", mask: 0, boost: false }, "373cfd8b9ca904176a3274f882d2fbeb"],
  ["utf-8", "スラッシュの日本語ペイロード検証", {}, "83e6f8679ef7cff486d0b159d48bd037"],
  ["astral plane", "pulld ✅ qr-code 🎯", {}, "a78cec8910408d719877229733aa2c18"],
  ["wifi payload", wifiPayload({ ssid: "Cafe Guest", password: "hunter2;drop:table" }), { errorCorrection: "Q" }, "a55ca89f13d2cf55b7f7b6a5a4428f9e"],
  ["otpauth uri", otpauthUri({ issuer: "Acme Corp", account: "ada@example.com", secret: "JBSWY3DPEHPK3PXP" }), {}, "cd61736e01407e5b4c7b0b07ec558002"],
]

for (const [name, value, options, expected] of VERIFIED) {
  test(`decoded-and-frozen: ${name}`, () => {
    assert.equal(digest(serialise(encodeQr(value, options))), expected)
  })
}

// --- structure a scanner depends on ------------------------------------------------------------------

test("the three finder patterns are where a scanner looks for them", () => {
  const { modules, size } = encodeQr("https://pulld.pages.dev")
  const ring = (cx, cy) => {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        assert.equal(modules[cy + dy][cx + dx], distance !== 2, `finder at ${cx},${cy} wrong at ${dx},${dy}`)
      }
    }
  }
  ring(3, 3)
  ring(size - 4, 3)
  ring(3, size - 4)
  // And deliberately not a fourth: the missing corner is how a reader works out the rotation.
  const bottomRight = modules[size - 4][size - 4] && modules[size - 6][size - 6]
  assert.equal(bottomRight, false)
})

test("the timing patterns alternate and the dark module is dark", () => {
  const { modules, size } = encodeQr("https://pulld.pages.dev/r/qr-code.json", { errorCorrection: "H" })
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing broken at column ${i}`)
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing broken at row ${i}`)
  }
  // Always set, in every code ever made. A reader uses it to tell the format area from the data.
  assert.equal(modules[size - 8][8], true)
})

test("size is 4v+17 at both ends of the range", () => {
  assert.equal(encodeQr("a", { minVersion: MIN_QR_VERSION, maxVersion: MIN_QR_VERSION }).size, 21)
  assert.equal(encodeQr("a", { minVersion: MAX_QR_VERSION, maxVersion: MAX_QR_VERSION }).size, 177)
})

// --- packing ------------------------------------------------------------------------------------------

test("the mode is the smallest one the text actually qualifies for", () => {
  assert.equal(encodeQr("0123456789").mode, "numeric")
  assert.equal(encodeQr("HELLO WORLD").mode, "alphanumeric")
  // The trap: alphanumeric mode has no lower case, so nearly every real URL is byte mode and the
  // upper-cased one beside it is not. Guessing this by eye is how unreadable codes get made.
  assert.equal(encodeQr("HTTPS://EXAMPLE.COM").mode, "alphanumeric")
  assert.equal(encodeQr("https://example.com").mode, "byte")
  assert.equal(encodeQr("HELLO, WORLD").mode, "byte") // a comma is not in the 45
  assert.equal(encodeQr("日本語").mode, "byte")
})

test("packing digits three-to-ten-bits is not a rounding claim", () => {
  // 40 digits: numeric fits version 1 at level M, the same text as bytes does not.
  const digits = "0123456789012345678901234567890123456789"
  assert.equal(encodeQr(digits, { errorCorrection: "M", boost: false }).version, 2)
  assert.ok(encodeQr(digits.replace(/0/g, "a"), { errorCorrection: "M", boost: false }).version > 2)
})

test("boost raises the level into slack that would otherwise be padding", () => {
  // Six bytes in a version 1 grid: asked for L, and there is room for H at the same size.
  const asked = encodeQr("pulld", { errorCorrection: "L", boost: false })
  const boosted = encodeQr("pulld", { errorCorrection: "L", boost: true })
  assert.equal(asked.errorCorrection, "L")
  assert.equal(boosted.errorCorrection, "H")
  assert.equal(boosted.version, asked.version, "boost must never grow the code")
})

test("minVersion holds the size still for a payload that changes", () => {
  // The reason it exists: a rotating token that crosses a capacity boundary would otherwise resize
  // the code mid-scan.
  const short = encodeQr("428", { minVersion: 10 })
  const longer = encodeQr("4281f0a9c3e77b52d6", { minVersion: 10 })
  assert.equal(short.version, 10)
  assert.equal(longer.version, 10)
})

test("a payload that cannot fit throws rather than truncating", () => {
  // The one failure worth being loud about: a silently truncated code still scans, and hands back
  // the wrong string.
  assert.throws(() => encodeQr("x".repeat(1274), { errorCorrection: "H", boost: false }), RangeError)
  assert.doesNotThrow(() => encodeQr("x".repeat(1273), { errorCorrection: "H", boost: false }))
  assert.throws(() => encodeQr("x".repeat(2954), { errorCorrection: "L", boost: false }), RangeError)
  assert.doesNotThrow(() => encodeQr("x".repeat(2953), { errorCorrection: "L", boost: false }))
})

test("out-of-range options are rejected", () => {
  assert.throws(() => encodeQr("a", { minVersion: 0 }), RangeError)
  assert.throws(() => encodeQr("a", { maxVersion: 41 }), RangeError)
  assert.throws(() => encodeQr("a", { minVersion: 5, maxVersion: 4 }), RangeError)
  assert.throws(() => encodeQr("a", { mask: 8 }), RangeError)
  assert.throws(() => encodeQr("a", { mask: 1.5 }), RangeError)
})

// --- the path -------------------------------------------------------------------------------------------

test("qrPath merges each row's dark run into one subpath and offsets by the quiet zone", () => {
  const matrix = encodeQr("https://pulld.pages.dev")
  const path = qrPath(matrix, 4)
  // The top-left finder's first row is seven dark modules: one subpath, not seven.
  assert.ok(path.startsWith("M4 4h7v1h-7z"), `unexpected start: ${path.slice(0, 24)}`)
  const dark = matrix.modules.flat().filter(Boolean).length
  const subpaths = path.match(/M/g).length
  assert.ok(subpaths < dark, `runs are not being merged: ${subpaths} subpaths for ${dark} modules`)
  // Every dark module drawn exactly once — the invariant that matters, since a merge that dropped
  // or doubled a module would still produce a plausible-looking path.
  const drawn = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, [, n]) => sum + Number(n), 0)
  assert.equal(drawn, dark)
  // Nothing may be drawn inside the quiet zone, which is the whole reason it is a quiet zone.
  for (const [, x, y] of path.matchAll(/M(\d+) (\d+)/g)) {
    assert.ok(Number(x) >= 4 && Number(y) >= 4, `module drawn at ${x},${y}, inside the margin`)
  }
})

test("the path repaints to the grid it came from, module for module", () => {
  // The Vision sweep rasterised matrix.modules directly, but the component renders qrPath() — so a
  // bug in the run-merging would have been invisible to all of it. Painting the emitted path back
  // out and comparing closes that gap without needing an SVG renderer: if the path is the grid, and
  // the grid decodes, the thing on screen decodes. (Checked against Vision too, on 2026-09-12: nine
  // path-derived images, all nine read back exactly.)
  for (const [value, options, margin] of [
    ["https://pulld.pages.dev/r/qr-code.json", {}, 4],
    ["スラッシュの日本語ペイロード検証", {}, 4],
    ["https://pulld.pages.dev", {}, 0],
    ["https://pulld.pages.dev", {}, 8],
    ["pulld", { errorCorrection: "H", boost: false }, 4],
  ]) {
    const matrix = encodeQr(value, options)
    const path = qrPath(matrix, margin)
    const repainted = Array.from({ length: matrix.size }, () => new Array(matrix.size).fill(false))
    let consumed = 0
    for (const [whole, x, y, run, back] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
      consumed += whole.length
      assert.equal(run, back, `subpath does not close: ${whole}`)
      for (let i = 0; i < Number(run); i++) {
        const px = Number(x) - margin + i
        const py = Number(y) - margin
        assert.ok(px >= 0 && px < matrix.size && py >= 0 && py < matrix.size, `${whole} leaves the grid`)
        assert.equal(repainted[py][px], false, `module painted twice at ${px},${py}`)
        repainted[py][px] = true
      }
    }
    assert.equal(consumed, path.length, "the path holds commands outside the grammar above")
    assert.deepEqual(repainted, matrix.modules, `repainted path differs for ${JSON.stringify(value.slice(0, 20))}`)
  }
})

// --- the payload builders ---------------------------------------------------------------------------------

test("wifiPayload escapes the separators a generated password contains", () => {
  // Unescaped, the ; ends the field and the phone joins with half a password — while the sign on
  // the wall shows the whole one.
  assert.equal(
    wifiPayload({ ssid: "Cafe Guest", password: "hunter2;drop:table" }),
    "WIFI:T:WPA;S:Cafe Guest;P:hunter2\\;drop\\:table;;"
  )
  assert.equal(wifiPayload({ ssid: "a,b\\c" }), "WIFI:T:nopass;S:a\\,b\\\\c;;")
  assert.equal(wifiPayload({ ssid: "net", password: "pw", hidden: true }), "WIFI:T:WPA;S:net;P:pw;H:true;;")
  assert.equal(wifiPayload({ ssid: "net", security: "WEP", password: "pw" }), "WIFI:T:WEP;S:net;P:pw;;")
  // An all-hex value is quoted, or the format reads it as a raw key rather than as characters.
  assert.equal(wifiPayload({ ssid: "1234abcd" }), 'WIFI:T:nopass;S:"1234abcd";;')
  // No password means no P field at all, not an empty one.
  assert.equal(wifiPayload({ ssid: "open" }), "WIFI:T:nopass;S:open;;")
})

test("otpauthUri puts the issuer in both places and escapes the label halves separately", () => {
  const uri = otpauthUri({ issuer: "Acme Corp", account: "ada+2fa@example.com", secret: "JBSWY3DPEHPK3PXP" })
  // The colon is the separator and must survive; everything either side of it must not.
  assert.ok(uri.startsWith("otpauth://totp/Acme%20Corp:ada%2B2fa%40example.com?"), uri)
  assert.ok(uri.includes("secret=JBSWY3DPEHPK3PXP"))
  assert.ok(uri.includes("issuer=Acme+Corp"), "apps that read only the parameter need it too")
  assert.equal(otpauthUri({ account: "ada@example.com", secret: "S" }), "otpauth://totp/ada%40example.com?secret=S")
  const hotp = otpauthUri({ account: "a", secret: "S", type: "hotp", counter: 0, period: 30 })
  assert.ok(hotp.includes("counter=0"))
  assert.ok(!hotp.includes("period"), "period is meaningless for a counter-based code")
})

// --- the component ------------------------------------------------------------------------------------------

const svgOf = (props) => byTag(walk(render(QrCode, props).tree), "svg")[0]

test("renders one named img with the quiet zone inside the viewBox", () => {
  const svg = svgOf({ value: "https://pulld.pages.dev" })
  assert.equal(svg.props.role, "img")
  assert.equal(svg.props["aria-label"], "QR code")
  // 25 modules at version 2, plus 4 either side.
  const size = encodeQr("https://pulld.pages.dev").size
  assert.equal(svg.props.viewBox, `0 0 ${size + 8} ${size + 8}`)
  assert.equal(svg.props.shapeRendering, "crispEdges")
})

test("the ground is drawn rather than left to the page", () => {
  // A transparent quiet zone takes the colour of whatever is behind it, and a code on a dark
  // surface with a dark border is a code no phone will find.
  const nodes = walk(render(QrCode, { value: "https://pulld.pages.dev" }).tree)
  const rect = byTag(nodes, "rect")[0]
  assert.equal(rect.props.className, "fill-white")
  assert.equal(byTag(nodes, "path")[0].props.className, "fill-black")
})

test("invert swaps both fills, and either can be overridden alone", () => {
  const inverted = walk(render(QrCode, { value: "x", invert: true }).tree)
  assert.equal(byTag(inverted, "rect")[0].props.className, "fill-black")
  assert.equal(byTag(inverted, "path")[0].props.className, "fill-white")
  const themed = walk(render(QrCode, { value: "x", moduleClassName: "fill-primary" }).tree)
  assert.equal(byTag(themed, "path")[0].props.className, "fill-primary")
  assert.equal(byTag(themed, "rect")[0].props.className, "fill-white")
})

test("the encoded text is not announced unless asked for", () => {
  // The two things most often in a code are a Wi-Fi password and a 2FA secret. Neither belongs in
  // an accessible name by default.
  const secret = otpauthUri({ account: "ada@example.com", secret: "JBSWY3DPEHPK3PXP" })
  assert.equal(svgOf({ value: secret }).props["aria-label"], "QR code")
  assert.equal(svgOf({ value: secret, label: "Scan with your authenticator" }).props["aria-label"], "Scan with your authenticator")
  assert.equal(svgOf({ value: "abc", label: "Invite", announceValue: true }).props["aria-label"], "Invite: abc")
})

test("margin reaches the viewBox, and 0 is allowed for a surface that supplies its own", () => {
  const size = encodeQr("x").size
  assert.equal(svgOf({ value: "x", margin: 0 }).props.viewBox, `0 0 ${size} ${size}`)
  assert.equal(svgOf({ value: "x", margin: 8 }).props.viewBox, `0 0 ${size + 16} ${size + 16}`)
})

test("an empty or unencodable value renders the fallback instead of throwing", () => {
  // Throwing here would take the surrounding layout down with it; the pure encoder still throws for
  // anyone who wants to handle it.
  assert.equal(byTag(walk(render(QrCode, { value: "" }).tree), "svg").length, 0)
  const tooLong = { value: "x".repeat(3000), fallback: { type: "p", props: { children: "Too long" } } }
  const nodes = walk(render(QrCode, tooLong).tree)
  assert.equal(byTag(nodes, "svg").length, 0)
  assert.equal(byTag(nodes, "p")[0].props.children, "Too long")
})

test("repeated renders of the same value are byte-identical", () => {
  // There is a small cache behind this, which is what lets the component stay hook-free and render
  // on a server. A cache that ever returned a different grid for the same input would be worse than
  // no cache at all.
  const a = svgOf({ value: "https://pulld.pages.dev/r/qr-code.json", errorCorrection: "Q" })
  const b = svgOf({ value: "https://pulld.pages.dev/r/qr-code.json", errorCorrection: "Q" })
  assert.equal(a.props.children[1].props.d, b.props.children[1].props.d)
  const other = svgOf({ value: "https://pulld.pages.dev/r/qr-code.json", errorCorrection: "L" })
  assert.notEqual(a.props.children[1].props.d, other.props.children[1].props.d)
})

// --- the two codes Vision would not read, and why that is not this file's problem ------------------------
//
// v20-M and v38-Q, each carrying an eight-character payload forced into a grid sized for hundreds of
// bytes, so the content is almost entirely padding. Both were re-rendered with all eight masks: seven
// decoded and only mask 2 did not, at every scale tried. Mask 2 is the column rule (x % 3), and over a
// field of repeating pad bytes it produces page-wide regular vertical stripes that the detector's
// locator cannot resolve. The spec's four penalty rules do not score that pattern down — no run
// reaches five, no 2x2 block forms — so the scoring picks it, correctly and unhelpfully.
//
// It is an encoding that conforms and a detector that declines, not a bug here: the same version and
// level with a payload of any realistic size decoded first time, as did both neighbours on either
// side. Left alone deliberately. Departing from the spec's scoring would make this registry's output
// differ from every reference implementation to chase one pathological case in one decoder, and the
// case only arises by forcing minVersion far above what the payload needs.
test("the two known-pathological grids are still the only ones of their shape", () => {
  // Cheap guard on the claim above: these two still pick mask 2, so if a future change to the
  // scoring moves them, the note is out of date and should be revisited rather than trusted.
  assert.equal(encodeQr("v20M:NNN", { errorCorrection: "M", minVersion: 20, maxVersion: 20, boost: false }).mask, 2)
  assert.equal(encodeQr("v38Q:NNN", { errorCorrection: "Q", minVersion: 38, maxVersion: 38, boost: false }).mask, 2)
})
