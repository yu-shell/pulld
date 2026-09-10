// A cropper is judged on one thing: whether the picture that gets saved is the picture that was on
// screen. Every case below is written to fail against a version that looks right in a browser:
//
//   - a crop allowed to hang over the edge of the photo, which saves an avatar with a transparent
//     wedge down one side and is invisible until somebody uploads a picture and pans to the end,
//   - a zoom anchored to the centre of the frame, so scrolling in on a face pushes the face out,
//   - a height carried through from the caller instead of derived, which lets a square frame emit
//     a rectangle nobody could have seen in it,
//   - an export sized from the source rather than from the output, which is the 192 MB canvas that
//     makes iOS Safari hand back a blank image for a 256px avatar,
//   - and an export that upscales, turning a small crop into a large file with no more detail.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  coverCrop,
  clampCrop,
  cropZoom,
  zoomCropTo,
  outputSize,
  DEFAULT_MAX_OUTPUT,
  ImageCrop,
} = loadComponent(join(ROOT, "registry", "ui", "image-crop.tsx"))

/** A landscape phone photo, and a portrait one. */
const LANDSCAPE = { width: 4000, height: 3000 }
const PORTRAIT = { width: 3000, height: 4000 }
const close = (a, b, tolerance = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${a} is not within ${tolerance} of ${b}`)

// --- the starting rectangle ----------------------------------------------------------------------

test("a square crop of a landscape photo is the full height, centred across", () => {
  assert.deepEqual(coverCrop(LANDSCAPE, 1), { x: 500, y: 0, width: 3000, height: 3000 })
})

test("a square crop of a portrait photo is the full width, centred down", () => {
  assert.deepEqual(coverCrop(PORTRAIT, 1), { x: 0, y: 500, width: 3000, height: 3000 })
})

test("the cover rectangle never leaves the image, whatever the aspect", () => {
  for (const aspect of [0.5, 1, 16 / 9, 3, 0.1]) {
    for (const image of [LANDSCAPE, PORTRAIT, { width: 1, height: 5000 }]) {
      const crop = coverCrop(image, aspect)
      assert.ok(crop.x >= 0 && crop.y >= 0, `${aspect} put the crop at ${crop.x},${crop.y}`)
      assert.ok(crop.x + crop.width <= image.width + 1e-9, `${aspect} overhangs the width`)
      assert.ok(crop.y + crop.height <= image.height + 1e-9, `${aspect} overhangs the height`)
      close(crop.width / crop.height, aspect)
    }
  }
})

// --- the rule that keeps the photo under the whole frame -----------------------------------------

test("a crop dragged off the edge is pushed back in, not shrunk", () => {
  // The transparent-wedge bug. A version that clamps by trimming the width would return a 900-wide
  // rectangle here, which is a different picture at a different zoom than the one being dragged.
  const crop = clampCrop({ x: 3900, y: -400, width: 1000, height: 1000 }, LANDSCAPE, 1)
  assert.deepEqual(crop, { x: 3000, y: 0, width: 1000, height: 1000 })
})

test("the height is derived from the width, so a square frame cannot emit a rectangle", () => {
  const crop = clampCrop({ x: 0, y: 0, width: 1000, height: 250 }, LANDSCAPE, 1)
  assert.equal(crop.height, 1000)
})

test("a crop bigger than the image is cut back to the cover size and pushed inside", () => {
  // Cut to the cover *size*, and moved to the nearest legal position rather than re-centred:
  // clamping is what happens at the end of a drag, and a drag that hits the edge must stop there,
  // not jump back to the middle of the photo.
  const crop = clampCrop({ x: -999, y: -999, width: 99999, height: 99999 }, LANDSCAPE, 1)
  const cover = coverCrop(LANDSCAPE, 1)
  assert.deepEqual(
    { width: crop.width, height: crop.height },
    { width: cover.width, height: cover.height }
  )
  assert.deepEqual({ x: crop.x, y: crop.y }, { x: 0, y: 0 })
})

test("clamping is idempotent — a clamped crop clamps to itself", () => {
  const once = clampCrop({ x: 3900, y: -400, width: 1234.5, height: 7 }, PORTRAIT, 16 / 9)
  assert.deepEqual(clampCrop(once, PORTRAIT, 16 / 9), once)
})

// --- zoom -----------------------------------------------------------------------------------------

test("zoom 1 is the cover rectangle and larger numbers show less of the picture", () => {
  assert.equal(cropZoom(coverCrop(LANDSCAPE, 1), LANDSCAPE, 1), 1)
  const closer = zoomCropTo(coverCrop(LANDSCAPE, 1), LANDSCAPE, 1, 3)
  assert.equal(closer.width, 1000)
  close(cropZoom(closer, LANDSCAPE, 1), 3)
})

test("zooming holds the focal point at the same place in the frame", () => {
  // This is the case a centre-anchored zoom fails. The focal point sits a quarter of the way across
  // the crop and three quarters down; after the zoom it has to sit there still, because on screen
  // it is the pixel under the cursor and it must not move out from under it.
  const start = coverCrop(LANDSCAPE, 1) // { x: 500, y: 0, w: 3000, h: 3000 }
  const focal = { x: start.x + start.width * 0.25, y: start.y + start.height * 0.75 }
  const next = zoomCropTo(start, LANDSCAPE, 1, 2, focal)
  close((focal.x - next.x) / next.width, 0.25)
  close((focal.y - next.y) / next.height, 0.75)
})

test("zooming out past the image is refused rather than allowed to show empty edges", () => {
  const start = zoomCropTo(coverCrop(LANDSCAPE, 1), LANDSCAPE, 1, 4)
  const out = zoomCropTo(start, LANDSCAPE, 1, 0.25)
  assert.deepEqual(out, coverCrop(LANDSCAPE, 1))
})

test("a zoom near an edge stays inside the image even though the focal point pulls outwards", () => {
  const start = zoomCropTo(coverCrop(PORTRAIT, 1), PORTRAIT, 1, 4)
  const corner = zoomCropTo(start, PORTRAIT, 1, 1.2, { x: 0, y: 0 })
  assert.ok(corner.x >= 0 && corner.y >= 0)
  assert.ok(corner.x + corner.width <= PORTRAIT.width + 1e-9)
  assert.ok(corner.y + corner.height <= PORTRAIT.height + 1e-9)
})

test("zoom and cropZoom are inverses across the range", () => {
  let crop = coverCrop(LANDSCAPE, 16 / 9)
  for (const z of [1, 1.5, 2.75, 6, 8]) {
    crop = zoomCropTo(crop, LANDSCAPE, 16 / 9, z)
    close(cropZoom(crop, LANDSCAPE, 16 / 9), z, 1e-9)
  }
})

// --- the size of the exported file ----------------------------------------------------------------

test("an export nobody sized is capped, so a phone photo does not become a 48-megapixel canvas", () => {
  // The whole point of outputSize. A version that returns the crop's own pixels here allocates
  // 3000x3000x4 bytes for what is usually a 256px avatar.
  const crop = coverCrop(LANDSCAPE, 1)
  assert.deepEqual(outputSize(crop), { width: DEFAULT_MAX_OUTPUT, height: DEFAULT_MAX_OUTPUT })
  assert.deepEqual(outputSize(crop, { maxSize: 256 }), { width: 256, height: 256 })
})

test("a crop smaller than the cap is not enlarged into a bigger file with the same detail", () => {
  assert.deepEqual(outputSize({ x: 0, y: 0, width: 120, height: 90 }), { width: 120, height: 90 })
})

test("one given dimension keeps the crop's shape and both given are taken literally", () => {
  const crop = { x: 0, y: 0, width: 1600, height: 900 }
  assert.deepEqual(outputSize(crop, { width: 800 }), { width: 800, height: 450 })
  assert.deepEqual(outputSize(crop, { height: 450 }), { width: 800, height: 450 })
  assert.deepEqual(outputSize(crop, { width: 100, height: 100 }), { width: 100, height: 100 })
})

test("the output is always at least one whole pixel", () => {
  const tiny = outputSize({ x: 0, y: 0, width: 0.2, height: 0.2 }, { maxSize: 10 })
  assert.deepEqual(tiny, { width: 1, height: 1 })
})

// --- what the component renders --------------------------------------------------------------------

const rendered = (props = {}) =>
  render(ImageCrop, { src: "/photo.jpg", alt: "A cat", ...props })

test("the frame is a focusable, named group and the gestures are described, not left to be found", () => {
  const nodes = walk(rendered().tree)
  const [frame] = byRole(nodes, "group")
  assert.equal(frame.props.tabIndex, 0)
  assert.equal(frame.props["aria-label"], "Crop image")
  const hint = nodes.find((n) => n.props?.id === frame.props["aria-describedby"])
  assert.match(hint.props.children, /Arrow keys/)
})

test("there is a keyboard path to every axis: zoom, horizontal and vertical, as real sliders", () => {
  const ranges = byTag(walk(rendered().tree), "input").filter((n) => n.props.type === "range")
  assert.equal(ranges.length, 3)
  // Not appearance-none: a registry component cannot ship the ::-webkit-slider-thumb rules that
  // would be needed to draw a replacement, and without them the thumb vanishes in WebKit.
  for (const range of ranges) assert.doesNotMatch(range.props.className, /appearance-none/)
})

test("the position sliders are reachable but out of the way until focused", () => {
  const nodes = walk(rendered().tree)
  const group = nodes.find((n) => n.props?.className?.includes?.("focus-within:not-sr-only"))
  // sr-only, not hidden: a hidden control is unreachable, and unhiding on focus-within is what
  // keeps a sighted keyboard user from tabbing into something they cannot see.
  assert.match(group.props.className, /(^|\s)sr-only/)
})

test("before the image loads nothing is positioned, rather than positioned at a guess", () => {
  const img = byTag(walk(rendered().tree), "img")[0]
  // No layout in the harness, which is the same answer a server gives: the frame has not been
  // measured, so there is no scale factor and the picture is not placed at a made-up one.
  assert.equal(img.props.style.visibility, "hidden")
  // and the browser's own drag is off, or the first pan hands the file to whatever is underneath
  assert.equal(img.props.draggable, false)
})

test("disabled leaves the tab order and turns every control off", () => {
  const nodes = walk(rendered({ disabled: true }).tree)
  const [frame] = byRole(nodes, "group")
  assert.equal(frame.props.tabIndex, -1)
  assert.equal(frame.props["aria-disabled"], true)
  for (const range of byTag(nodes, "input")) assert.equal(range.props.disabled, true)
})

test("controls={false} hides the zoom slider and keeps the two the screen reader needs", () => {
  const ranges = byTag(walk(rendered({ controls: false }).tree), "input")
  assert.equal(ranges.length, 2)
})

test("the frame carries the aspect it was given, so the window is the shape of the output", () => {
  const [frame] = byRole(walk(rendered({ aspect: 16 / 9, shape: "round" }).tree), "group")
  assert.equal(frame.props.style.aspectRatio, String(16 / 9))
  assert.match(frame.props.className, /rounded-full/)
})

test("a live region is mounted from the start, so the first announcement is not missed", () => {
  const live = walk(rendered().tree).find((n) => n.props?.["aria-live"] === "polite")
  assert.ok(live, "no polite live region")
  assert.equal(live.props.className, "sr-only")
})
