// A signature pad is the rare component where "looks fine on my laptop" is the whole failure mode.
// The cases below are written to fail against the versions that look right:
//
//   - joining the sampled points with straight lines, which turns a fast signature into a polygon
//     because the corners are in the sampling rate rather than in the hand,
//   - a bound taken over the sampled points, which cuts the bulge off every curve when the export
//     is trimmed — the loop of a capital L is outside the points that describe it,
//   - a canvas sized in CSS pixels, which draws a 2x or 3x screen at a third of its resolution and
//     blurs the one thing a signature is identified by,
//   - and building the SVG by concatenation without escaping, where a name with an ampersand in it
//     produces a document that will not parse and a name with a tag in it produces one that does
//     something else entirely.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  strokeGeometry,
  strokePathData,
  signatureBounds,
  isSignatureEmpty,
  signatureToSvg,
  backingSize,
  SignaturePad,
} = loadComponent(join(ROOT, "registry", "ui", "signature-pad.tsx"))

const drawn = (strokes, width = 300, height = 160) => ({ type: "drawn", strokes, width, height })

// --- the curve through the samples ---------------------------------------------------------------

test("no points is no geometry, and one point is a dot rather than an empty path", () => {
  assert.equal(strokeGeometry([]), null)
  assert.equal(strokeGeometry(undefined), null)
  assert.deepEqual(strokeGeometry([{ x: 4, y: 9 }]), { kind: "dot", x: 4, y: 9 })
})

test("two points draw a straight line that ends on the second point", () => {
  const geometry = strokeGeometry([
    { x: 0, y: 0 },
    { x: 10, y: 4 },
  ])
  assert.equal(geometry.kind, "path")
  assert.deepEqual(geometry.start, { x: 0, y: 0 })
  // A quadratic whose control point is its own end point is a straight line, so one segment shape
  // covers both cases and the stroke still finishes exactly on the last sample.
  assert.deepEqual(geometry.segments, [{ cx: 10, cy: 4, x: 10, y: 4 }])
})

test("the samples become control points and the curve passes through the midpoints between them", () => {
  // This is the assertion that fails against a polyline. A version that joins the points would
  // have segments ending on (10,0) and (20,0); the smoothed one ends on the midpoints, with the
  // sample itself pulling the curve as a control point.
  const geometry = strokeGeometry([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ])
  assert.deepEqual(geometry.segments, [
    { cx: 10, cy: 0, x: 15, y: 0 },
    { cx: 20, cy: 0, x: 25, y: 0 },
    { cx: 30, cy: 0, x: 30, y: 0 },
  ])
  // and the last one lands on the final sample, not a midpoint short of it
  const last = geometry.segments[geometry.segments.length - 1]
  assert.deepEqual({ x: last.x, y: last.y }, { x: 30, y: 0 })
})

test("the path data is the same geometry, so the SVG export and the canvas cannot disagree", () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: 20, y: 0 },
  ]
  assert.equal(strokePathData(points), "M0 0Q10 5 15 2.5Q20 0 20 0")
  assert.equal(strokePathData([{ x: 1, y: 1 }]), null, "a dot has no path — it is a circle")
  assert.equal(strokePathData([]), null)
})

test("path numbers are rounded, so a pointer sampled at sub-pixel precision does not bloat the file", () => {
  const d = strokePathData([
    { x: 0.123456, y: 0 },
    { x: 1.987654, y: 0 },
  ])
  assert.equal(d, "M0.12 0Q1.99 0 1.99 0")
})

// --- what the ink actually occupies --------------------------------------------------------------

test("the bound actually contains the curve, at every point along it", () => {
  // The claim worth testing is containment, not a number. A trimmed export crops to this box, so
  // anything the curve does outside it is ink that gets sliced off — and the curve is not the
  // samples, it is a chain of quadratics whose control points they are. Evaluated densely here so
  // the test fails if the smoothing is ever changed to something the bound no longer covers.
  const stroke = [
    { x: 0, y: 0 },
    { x: 10, y: 20 },
    { x: 20, y: 0 },
    { x: 30, y: 25 },
    { x: 40, y: 5 },
  ]
  const bounds = signatureBounds([stroke], 0)
  const geometry = strokeGeometry(stroke)

  let from = geometry.start
  for (const s of geometry.segments) {
    for (let t = 0; t <= 1; t += 0.01) {
      const u = 1 - t
      const x = u * u * from.x + 2 * u * t * s.cx + t * t * s.x
      const y = u * u * from.y + 2 * u * t * s.cy + t * t * s.y
      assert.ok(
        x >= bounds.x - 1e-9 && x <= bounds.x + bounds.width + 1e-9,
        `x ${x} escaped [${bounds.x}, ${bounds.x + bounds.width}]`
      )
      assert.ok(
        y >= bounds.y - 1e-9 && y <= bounds.y + bounds.height + 1e-9,
        `y ${y} escaped [${bounds.y}, ${bounds.y + bounds.height}]`
      )
    }
    from = { x: s.x, y: s.y }
  }
})

test("the bound is not loose either — it touches the ink on all four sides", () => {
  // A bound that just returned the whole canvas would pass the containment test above, and would
  // make trimming pointless.
  const bounds = signatureBounds([[{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 20, y: 0 }]], 0)
  assert.deepEqual(bounds, { x: 0, y: 0, width: 20, height: 20 })
})

test("bounds add half the pen width on every side, because the line is centred on the path", () => {
  const bounds = signatureBounds([[{ x: 10, y: 10 }, { x: 20, y: 10 }]], 4)
  assert.deepEqual(bounds, { x: 8, y: 8, width: 14, height: 4 })
})

test("a dot has bounds of its own, and no ink at all has none", () => {
  assert.deepEqual(signatureBounds([[{ x: 5, y: 5 }]], 2), { x: 4, y: 4, width: 2, height: 2 })
  assert.equal(signatureBounds([], 2), null)
  assert.equal(signatureBounds([[]], 2), null)
})

test("a non-finite sample is skipped instead of poisoning the bounds", () => {
  // One NaN reaching the viewBox makes the whole SVG fail to render, and it is the kind of value a
  // pointer event produces when the box has not been laid out yet.
  const bounds = signatureBounds([[{ x: NaN, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }]], 0)
  assert.ok(Number.isFinite(bounds.x) && Number.isFinite(bounds.width))
})

// --- signed or not -------------------------------------------------------------------------------

test("emptiness covers the three ways nothing has been signed", () => {
  assert.equal(isSignatureEmpty(null), true)
  assert.equal(isSignatureEmpty(undefined), true)
  assert.equal(isSignatureEmpty(drawn([])), true)
  assert.equal(isSignatureEmpty(drawn([[]])), true)
  // A name of spaces is what a required field gets from somebody trying to get past it.
  assert.equal(isSignatureEmpty({ type: "typed", name: "   " }), true)
  assert.equal(isSignatureEmpty({ type: "typed", name: "Ada" }), false)
  assert.equal(isSignatureEmpty(drawn([[{ x: 1, y: 1 }]])), false)
})

// --- the export ----------------------------------------------------------------------------------

test("an empty signature exports as null rather than as a blank document", () => {
  assert.equal(signatureToSvg(null), null)
  assert.equal(signatureToSvg(drawn([])), null)
  assert.equal(signatureToSvg({ type: "typed", name: "  " }), null)
})

test("an untrimmed drawn signature keeps the box it was drawn in", () => {
  const svg = signatureToSvg(drawn([[{ x: 0, y: 0 }, { x: 10, y: 10 }]], 300, 160))
  assert.match(svg, /viewBox="0 0 300 160"/)
  assert.match(svg, /width="300" height="160"/)
  assert.match(svg, /<path d="M0 0Q10 10 10 10"/)
  assert.match(svg, /stroke-linecap="round"/)
  assert.doesNotMatch(svg, /<rect/, "no background unless one was asked for")
})

test("trimming crops to the ink plus padding, so a stored signature is not mostly empty box", () => {
  const svg = signatureToSvg(drawn([[{ x: 100, y: 50 }, { x: 120, y: 60 }]], 300, 160), {
    penWidth: 2,
    trim: 10,
  })
  // ink runs 99–121 x, 49–61 y once the pen width is counted; padding 10 on each side.
  assert.match(svg, /viewBox="89 39 42 32"/)
  assert.match(svg, /width="42" height="32"/)
})

test("a dot exports as a circle, because a path with no length draws nothing", () => {
  const svg = signatureToSvg(drawn([[{ x: 8, y: 9 }]]), { penWidth: 3 })
  assert.match(svg, /<circle cx="8" cy="9" r="1.5"/)
})

test("a background is painted when one is asked for", () => {
  const svg = signatureToSvg(drawn([[{ x: 0, y: 0 }, { x: 5, y: 5 }]]), { backgroundColor: "#fff" })
  assert.match(svg, /<rect width="100%" height="100%" fill="#fff"\/>/)
})

test("a typed name is rendered as text in the script face", () => {
  const svg = signatureToSvg({ type: "typed", name: "Ada Lovelace" }, { width: 300, height: 160 })
  assert.match(svg, /<text /)
  assert.match(svg, />Ada Lovelace<\/text>/)
  assert.match(svg, /viewBox="0 0 300 160"/)
})

test("a name is escaped, so it cannot end the document it is being written into", () => {
  // The name field takes free text and the SVG is built by concatenation, which is the setup for
  // the oldest bug there is. Both of these are ordinary names before they are anything else.
  const svg = signatureToSvg({ type: "typed", name: 'Ben & "Jerry" <script>' })
  assert.match(svg, /&amp;/)
  assert.match(svg, /&lt;script&gt;/)
  assert.match(svg, /&quot;/)
  assert.doesNotMatch(svg, /<script>/)
})

test("a colour is escaped too, since it reaches an attribute", () => {
  const svg = signatureToSvg(drawn([[{ x: 0, y: 0 }, { x: 1, y: 1 }]]), { penColor: 'red" x="' })
  assert.doesNotMatch(svg, /stroke="red" x=""/)
  assert.match(svg, /&quot;/)
})

// --- the backing store ---------------------------------------------------------------------------

test("the backing store is the CSS box times the device pixel ratio", () => {
  assert.deepEqual(backingSize(300, 160, 2), { width: 600, height: 320, ratio: 2 })
  assert.deepEqual(backingSize(300, 160, 1), { width: 300, height: 160, ratio: 1 })
})

test("the ratio is clamped, so a 4x phone does not allocate sixteen pixels per CSS pixel", () => {
  assert.deepEqual(backingSize(300, 160, 4, 3), { width: 900, height: 480, ratio: 3 })
})

test("a ratio below one, or not a number at all, is treated as one", () => {
  // devicePixelRatio is undefined on the server and can be fractional on a zoomed desktop; neither
  // should produce a canvas smaller than its own box.
  assert.equal(backingSize(300, 160, undefined).ratio, 1)
  assert.equal(backingSize(300, 160, 0.5).ratio, 1)
  assert.equal(backingSize(300, 160, NaN).ratio, 1)
})

test("a box with no width still gets at least one pixel of backing store", () => {
  // A canvas sized 0 throws on some engines when you ask it for a context.
  assert.deepEqual(backingSize(0, 0, 2), { width: 1, height: 1, ratio: 2 })
})

// --- what gets rendered --------------------------------------------------------------------------

test("the canvas is hidden from assistive technology and the typed field is the announced path", () => {
  const { tree } = render(SignaturePad, { label: "Signature" })
  const nodes = walk(tree)

  const canvas = byTag(nodes, "canvas")[0]
  assert.ok(canvas, "there is a canvas")
  assert.equal(canvas.props["aria-hidden"], "true")
  // touch-action: none, or the first downward stroke scrolls the page instead of drawing.
  assert.match(canvas.props.className, /touch-none/)

  const input = byTag(nodes, "input").find((n) => n.props.type === "text")
  assert.ok(input, "a screen reader user has a field to sign with")
  const label = byTag(nodes, "label").find((n) => n.props.htmlFor === input.props.id)
  assert.ok(label, "and that field is labelled")
})

test("the group is named by its label", () => {
  const { tree } = render(SignaturePad, { label: "Sign to confirm delivery" })
  const group = walk(tree).find((n) => n.props?.role === "group")
  assert.ok(group)
  assert.equal(group.props["aria-labelledby"], walk(tree).find((n) => n.props?.id?.endsWith("-label")).props.id)
})

test("undo and clear are disabled while there is nothing to undo or clear", () => {
  const { tree } = render(SignaturePad, {})
  const buttons = byTag(walk(tree), "button")
  assert.equal(buttons.length, 2)
  assert.ok(buttons.every((b) => b.props.disabled === true))
})

test("clear is enabled by a typed name, but undo is not — undo steps back over strokes", () => {
  const { tree } = render(SignaturePad, { value: { type: "typed", name: "Ada" } })
  const [undo, clear] = byTag(walk(tree), "button")
  assert.equal(undo.props.disabled, true)
  assert.equal(clear.props.disabled, false)
})

test("both are enabled once a stroke exists", () => {
  const { tree } = render(SignaturePad, { value: drawn([[{ x: 0, y: 0 }, { x: 5, y: 5 }]]) })
  const buttons = byTag(walk(tree), "button")
  assert.ok(buttons.every((b) => b.props.disabled === false))
})

test("allowTyped={false} removes the field, and with it the only keyboard path", () => {
  const { tree } = render(SignaturePad, { allowTyped: false })
  assert.equal(byTag(walk(tree), "input").filter((n) => n.props.type === "text").length, 0)
})

test("a named pad posts a data URL for a drawing and the plain name for a typed signature", () => {
  const withDrawing = render(SignaturePad, {
    name: "signature",
    value: drawn([[{ x: 0, y: 0 }, { x: 10, y: 10 }]], 300, 160),
  })
  const hidden = byTag(walk(withDrawing.tree), "input").find((n) => n.props.type === "hidden")
  assert.equal(hidden.props.name, "signature")
  assert.match(hidden.props.value, /^data:image\/svg\+xml;utf8,/)
  assert.match(decodeURIComponent(hidden.props.value), /<path d="M0 0/)

  const withName = render(SignaturePad, { name: "signature", value: { type: "typed", name: "Ada" } })
  const typedHidden = byTag(walk(withName.tree), "input").find((n) => n.props.type === "hidden")
  assert.equal(typedHidden.props.value, "Ada")
})

test("required is enforced by a field the browser will actually validate", () => {
  // Putting it on the hidden input is the version that looks right and silently does nothing: a
  // type=hidden input is barred from constraint validation, so the form submits unsigned.
  const { tree } = render(SignaturePad, { name: "signature", required: true })
  const nodes = byTag(walk(tree), "input")
  assert.notEqual(nodes.find((n) => n.props.type === "hidden").props.required, true)
  assert.equal(nodes.find((n) => n.props.type === "text").props.required, true)
  assert.equal(walk(tree).find((n) => n.props?.role === "group").props["aria-required"], true)
})

test("the requirement lifts once something is drawn, without ever asking for a typed name", () => {
  const { tree } = render(SignaturePad, {
    name: "signature",
    required: true,
    value: drawn([[{ x: 0, y: 0 }, { x: 5, y: 5 }]]),
  })
  const typed = byTag(walk(tree), "input").find((n) => n.props.type === "text")
  assert.notEqual(typed.props.required, true, "a drawn signature already satisfies it")
})

test("typing reports a value, and emptying the field reports null rather than an empty signature", () => {
  const seen = []
  const { tree } = render(SignaturePad, { onChange: (v) => seen.push(v) })
  const input = byTag(walk(tree), "input").find((n) => n.props.type === "text")

  input.props.onChange({ currentTarget: { value: "Ada Lovelace" } })
  assert.deepEqual(seen.at(-1), { type: "typed", name: "Ada Lovelace" })

  input.props.onChange({ currentTarget: { value: "  " } })
  assert.equal(seen.at(-1), null, "whitespace is not a signature")
})
