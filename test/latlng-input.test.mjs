// Two boxes for a latitude and a longitude look finished in fifteen lines: read both with
// `parseFloat`, check they are inside ±90 and ±180, hand back an object. The cases below are
// written to fail against that and against the implementations it grows into:
//
//   - `Number("")` answering 0, so a cleared box posts a point in the Gulf of Guinea,
//   - a hemisphere taken from the sign, which loses 0°00'00"S because `-0` prints as `0`,
//   - seconds rounded after the split instead of before the carry, printing `35°59'60.000"`,
//   - the textbook longitude wrap, which turns a Fiji 180 into a -180 on the other side,
//   - a latitude past 90 clamped to 90, moving the point while reporting success,
//   - a swap "detected" automatically, which is right for half the planet and silent for the rest,
//   - and one metres-per-degree figure used for both axes, which is wrong about one of them
//     everywhere.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  AXIS_LIMIT,
  HEMISPHERES,
  WGS84,
  metresPerDegree,
  metresForDecimals,
  MEANINGFUL_DECIMALS,
  signOf,
  hemisphereOf,
  wrapLongitude,
  toDmsParts,
  fromDmsParts,
  formatDms,
  formatDecimal,
  parseCoordinate,
  checkCoordinate,
  looksSwapped,
  precisionNote,
  LatLngInput,
} = loadComponent(join(ROOT, "registry/ui/latlng-input.tsx"))

// --- parsing -----------------------------------------------------------------------------------

test("an empty box and an unreadable box are different answers", () => {
  // `Number("")` is 0, and 0,0 is a real point in the Gulf of Guinea. A cleared box must not post
  // it, and must not be reported as a mistake either.
  assert.deepEqual(parseCoordinate("", "lat"), { degrees: null, format: null })
  assert.deepEqual(parseCoordinate("   ", "lat"), { degrees: null, format: null })
  assert.ok(Number.isNaN(parseCoordinate("north", "lat").degrees))
})

test("the things Number accepts and nobody typed are refused", () => {
  for (const text of ["1e3", "0x10", "Infinity", "-Infinity", "1,5", "35 .5", "--35"]) {
    assert.ok(
      Number.isNaN(parseCoordinate(text, "lat").degrees),
      `${JSON.stringify(text)} should not read as a coordinate`
    )
  }
})

test("a half-typed decimal is accepted, because the box has to be typeable", () => {
  assert.equal(parseCoordinate("35.", "lat").degrees, 35)
  assert.equal(parseCoordinate(".5", "lat").degrees, 0.5)
})

test("decimal degrees and degrees-minutes-seconds read in the same box", () => {
  const expected = 35 + 41 / 60 + 22.2 / 3600
  assert.equal(parseCoordinate("35.6895", "lat").format, "decimal")
  for (const text of ["35°41'22.2\"N", "35 41 22.2", "35:41:22.2", "35°41'22.2\""]) {
    const r = parseCoordinate(text, "lat")
    assert.equal(r.format, "dms", `${text} should read as dms`)
    assert.ok(Math.abs(r.degrees - expected) < 1e-12, `${text} -> ${r.degrees}`)
  }
  // Degrees and minutes with no seconds is a reading in its own right.
  assert.ok(Math.abs(parseCoordinate("35°41'", "lat").degrees - (35 + 41 / 60)) < 1e-12)
})

test("the typographic characters a pasted coordinate actually carries are normalised", () => {
  // U+2032/U+2033 primes from a map site, U+00BA ordinal for the degree sign, U+2212 minus — which
  // `Number` refuses outright.
  const expected = 35 + 41 / 60 + 22.2 / 3600
  for (const text of ["35º41′22.2″N", "35°41′"]) {
    assert.ok(Number.isFinite(parseCoordinate(text, "lat").degrees), text)
  }
  assert.ok(Math.abs(parseCoordinate("35º41′22.2″N", "lat").degrees - expected) < 1e-12)
  assert.equal(parseCoordinate("−35.5", "lat").degrees, -35.5)
})

test("a hemisphere letter sets the sign from either end, and the wrong axis' letter is a mistake", () => {
  assert.equal(parseCoordinate("35S", "lat").degrees, -35)
  assert.equal(parseCoordinate("S35", "lat").degrees, -35)
  assert.equal(parseCoordinate("35N", "lat").degrees, 35)
  assert.equal(parseCoordinate("139.69W", "lng").degrees, -139.69)
  // E in a latitude box is not a sign to apply.
  assert.ok(Number.isNaN(parseCoordinate("35E", "lat").degrees))
  assert.ok(Number.isNaN(parseCoordinate("N35", "lng").degrees))
})

test("a sign and a letter that contradict each other are refused rather than resolved", () => {
  // Either reading loses half the readers, so neither is chosen.
  assert.ok(Number.isNaN(parseCoordinate("-35S", "lat").degrees))
  assert.ok(Number.isNaN(parseCoordinate("-35N", "lat").degrees))
})

test("sixty minutes or sixty seconds in a paste is junk, not something to normalise", () => {
  assert.ok(Number.isNaN(parseCoordinate("35°60'00\"", "lat").degrees))
  assert.ok(Number.isNaN(parseCoordinate("35°00'60\"", "lat").degrees))
  // Reported as dms so the message can say which notation failed.
  assert.equal(parseCoordinate("35°60'00\"", "lat").format, "dms")
})

// --- the southern zero -------------------------------------------------------------------------

test("0°00'00\"S keeps its hemisphere, which no comparison with < 0 can recover", () => {
  const degrees = parseCoordinate("0°00'00\"S", "lat").degrees
  // The platform loses it on every display path: String(-0) is "0" and (-0).toFixed(5) is
  // "0.00000". Only Object.is can see it, which is why signOf exists.
  assert.ok(Object.is(degrees, -0), "the southern zero must be -0, not 0")
  assert.equal(degrees < 0, false, "guarding this with < 0 is the bug being tested for")
  assert.equal(signOf(degrees), -1)
  assert.equal(hemisphereOf(degrees, "lat"), "S")
  assert.equal(formatDms(degrees, "lat", 3), '0°00\'00.000"S')
  assert.equal(formatDecimal(degrees, 6), "-0.000000")
  // And the ordinary zero is still northern.
  assert.equal(signOf(0), 1)
  assert.equal(hemisphereOf(0, "lat"), "N")
})

// --- degrees, minutes, seconds -----------------------------------------------------------------

test("the seconds are rounded before the carry, so no reading says sixty", () => {
  // 35.99999997222222 is 35°59'59.9999", and (59.9995).toFixed(2) is "60.00".
  assert.equal(formatDms(35.99999997222222, "lat", 3), '36°00\'00.000"N')
  const parts = toDmsParts(35.99999997222222, 3)
  assert.deepEqual(parts, { sign: 1, degrees: 36, minutes: 0, seconds: 0 })
  // The carry has to run through both units, not just the one.
  assert.deepEqual(toDmsParts(35.9999999 / 1, 0).seconds < 60, true)
})

test("rounding to three decimal seconds can land on the pole or the dateline", () => {
  // Worth pinning because it is what makes the longitude wrap dangerous: a value just short of the
  // dateline formats as exactly 180.
  assert.equal(formatDms(89.9999999, "lat", 3), '90°00\'00.000"N')
  assert.equal(formatDms(179.9999999, "lng", 3), '180°00\'00.000"E')
})

test("a decimal degree survives the trip through dms within one ulp", () => {
  for (const v of [35.6895, -12.0464, 0, 51.5072, -77.0428]) {
    const back = fromDmsParts(toDmsParts(v, 6))
    assert.ok(Math.abs(back - v) < 1e-9, `${v} -> ${back}`)
  }
})

test("minutes and seconds are zero-padded, because an unpadded reading is ambiguous", () => {
  assert.equal(formatDms(5.0836111111, "lat", 2), '5°05\'01.00"N')
})

// --- the two axes are not the same field -------------------------------------------------------

test("a longitude already inside the range is handed back untouched, 180 included", () => {
  // The textbook wrap turns 180 into -180 — the same meridian written as the other side of the
  // dateline. A Fiji longitude must not be rewritten.
  assert.equal(wrapLongitude(180), 180)
  assert.equal(wrapLongitude(-180), -180)
  assert.equal(wrapLongitude(179.9999), 179.9999)
  assert.equal(wrapLongitude(0), 0)
  assert.ok(Object.is(wrapLongitude(-0), -0), "the western zero survives the wrap")
})

test("a longitude outside the range folds, keeping the side it came from", () => {
  assert.equal(wrapLongitude(181), -179)
  assert.equal(wrapLongitude(-181), 179)
  assert.equal(wrapLongitude(360), 0)
  assert.equal(wrapLongitude(540), 180)
  assert.equal(wrapLongitude(-540), -180)
})

test("a latitude past 90 is refused, not clamped", () => {
  // Clamping 95 to 90 moves the point while reporting success; there is no reading of 95°N that
  // does not also move the longitude 180°.
  const { value, issue } = checkCoordinate(95, "lat")
  assert.ok(Number.isNaN(value))
  assert.equal(issue.code, "out-of-range")
  assert.match(issue.message, /-90 to 90/)
  assert.equal(checkCoordinate(90, "lat").issue, null)
})

test("a longitude past 180 is a correction, and only when wrapping is wanted", () => {
  const wrapped = checkCoordinate(181, "lng")
  assert.equal(wrapped.value, -179)
  assert.equal(wrapped.issue.code, "wrapped")
  const refused = checkCoordinate(181, "lng", { wrap: false })
  assert.ok(Number.isNaN(refused.value))
  assert.equal(refused.issue.code, "out-of-range")
})

test("an empty box is not an issue", () => {
  assert.deepEqual(checkCoordinate(null, "lat"), { value: null, issue: null })
})

test("the axis limits and letters are the two axes' real difference", () => {
  assert.deepEqual(AXIS_LIMIT, { lat: 90, lng: 180 })
  assert.deepEqual([...HEMISPHERES.lat], ["N", "S"])
  assert.deepEqual([...HEMISPHERES.lng], ["E", "W"])
})

// --- the swap -----------------------------------------------------------------------------------

test("a swap is reported only when it is the only possible reading", () => {
  // Tokyo backwards: 139.69 cannot be a latitude.
  assert.equal(looksSwapped(139.6917, 35.6895), true)
  assert.equal(looksSwapped(35.6895, 139.6917), false)
  // London, Lima, Nairobi, Reykjavík backwards: both numbers are legal in both boxes, so this
  // cannot be found. Four of six cities measured, which is why there is no automatic correction.
  for (const [lat, lng] of [
    [-0.1276, 51.5072],
    [-77.0428, -12.0464],
    [36.8172, -1.2864],
    [-21.9426, 64.1466],
  ]) {
    assert.equal(looksSwapped(lat, lng), false, `${lat},${lng} is not detectable`)
  }
  // And it says nothing about a half-filled or unreadable pair.
  assert.equal(looksSwapped(null, 35), false)
  assert.equal(looksSwapped(Number.NaN, 35), false)
})

// --- what a decimal place is worth --------------------------------------------------------------

test("metres per degree differs by axis at the equator, where one figure is usually used for both", () => {
  // The quoted 111,320 is the equatorial longitude degree; the latitude degree is 746 m shorter.
  assert.ok(Math.abs(metresPerDegree("lat", 0) - 110574.3) < 1, metresPerDegree("lat", 0))
  assert.ok(Math.abs(metresPerDegree("lng", 0) - 111319.5) < 1, metresPerDegree("lng", 0))
  assert.ok(metresPerDegree("lng", 0) - metresPerDegree("lat", 0) > 700)
})

test("a longitude degree collapses with the cosine of the latitude and a latitude degree does not", () => {
  for (const [lat, expectedLat, expectedLng] of [
    [35, 110940.6, 91288.2],
    [60, 111412.3, 55800.0],
    [85, 111685.4, 9734.5],
  ]) {
    assert.ok(Math.abs(metresPerDegree("lat", lat) - expectedLat) < 1, `lat@${lat}`)
    assert.ok(Math.abs(metresPerDegree("lng", lat) - expectedLng) < 1, `lng@${lat}`)
  }
  // The latitude degree grows slightly toward the pole; the longitude one almost vanishes.
  assert.ok(metresPerDegree("lat", 85) > metresPerDegree("lat", 0))
  assert.ok(metresPerDegree("lng", 85) < metresPerDegree("lng", 0) / 10)
})

test("the note names a tier rather than printing 0.0 cm for places that mean nothing", () => {
  assert.match(precisionNote(5, 0), /1\.11 m north-south/)
  assert.match(precisionNote(6, 35), /9\.1 cm east-west/)
  // Twelve places is 111 nanometres. The sentence has to say so, not round it to zero.
  const twelve = precisionNote(12, 35)
  assert.doesNotMatch(twelve, /0\.0 cm/)
  assert.match(twelve, /micrometre/)
  assert.match(twelve, /arithmetic, not accuracy/)
  // Inside the meaningful range the warning is absent.
  assert.doesNotMatch(precisionNote(MEANINGFUL_DECIMALS, 35), /arithmetic, not accuracy/)
  assert.equal(MEANINGFUL_DECIMALS, 8)
})

test("metresForDecimals is the per-degree figure scaled, on both axes", () => {
  assert.ok(Math.abs(metresForDecimals(5, "lat", 0) - 1.105743) < 1e-5)
  assert.ok(Math.abs(metresForDecimals(0, "lng", 0) - metresPerDegree("lng", 0)) < 1e-9)
})

test("WGS84 is kept as its two defining numbers so the rest is derived", () => {
  assert.equal(WGS84.a, 6378137)
  assert.ok(Math.abs(1 / WGS84.f - 298.257223563) < 1e-9)
})

// --- the rendered field -------------------------------------------------------------------------

const boxes = (tree) =>
  byTag(walk(tree), "input").filter((n) => n.props.type === "text")
const hidden = (tree) => byTag(walk(tree), "input").filter((n) => n.props.type === "hidden")
const typeInto = (instance, index, text) => {
  boxes(instance.tree)[index].props.onChange({ target: { value: text } })
  return instance.rerender()
}

test("the pair is one labelled group of two separately labelled text boxes", () => {
  const r = render(LatLngInput, {})
  const group = byRole(walk(r.tree), "group")
  assert.equal(group.length, 1)
  assert.equal(group[0].props["aria-label"], "Coordinates")

  const inputs = boxes(r.tree)
  assert.equal(inputs.length, 2)
  // type="text", not type="number": a number input discards text it cannot parse, so 35°41'22"N
  // would vanish from under the reader.
  for (const input of inputs) assert.equal(input.props.type, "text")
  const labels = byTag(walk(r.tree), "label")
  assert.equal(labels.length, 2)
  assert.equal(labels[0].props.htmlFor, inputs[0].props.id)
  assert.equal(labels[1].props.htmlFor, inputs[1].props.id)
  assert.notEqual(inputs[0].props.id, inputs[1].props.id)
  r.unmount()
})

test("one polite status line carries the verdict for the whole group", () => {
  const r = render(LatLngInput, {})
  const status = byRole(walk(r.tree), "status")
  assert.equal(status.length, 1, "two live regions race each other and neither gets read")
  assert.equal(status[0].props["aria-live"], "polite")
  for (const input of boxes(r.tree)) {
    assert.ok(String(input.props["aria-describedby"]).includes(status[0].props.id))
  }
  r.unmount()
})

test("aria-invalid follows the actual fault and not merely a non-empty box", () => {
  const r = render(LatLngInput, {})
  assert.equal(boxes(r.tree)[0].props["aria-invalid"], undefined)
  typeInto(r, 0, "95")
  assert.equal(boxes(r.tree)[0].props["aria-invalid"], true)
  assert.equal(boxes(r.tree)[1].props["aria-invalid"], undefined, "the other box is fine")
  typeInto(r, 0, "35.6895")
  assert.equal(boxes(r.tree)[0].props["aria-invalid"], undefined)
  r.unmount()
})

test("a wrapped longitude is a note, not an invalid box", () => {
  const r = render(LatLngInput, {})
  typeInto(r, 1, "181")
  assert.equal(boxes(r.tree)[1].props["aria-invalid"], undefined)
  assert.match(byRole(walk(r.tree), "status")[0].props.children, /same meridian/)
  r.unmount()
})

test("the parent hears a point only once both boxes hold one", () => {
  const seen = []
  const r = render(LatLngInput, { onValueChange: (v) => seen.push(v) })
  typeInto(r, 0, "35.6895")
  assert.deepEqual(seen.at(-1), null, "half a point is not a point")
  typeInto(r, 1, "139.6917")
  assert.deepEqual(seen.at(-1), { lat: 35.6895, lng: 139.6917 })
  typeInto(r, 0, "95")
  assert.deepEqual(seen.at(-1), null)
  r.unmount()
})

test("dms typed into either box is accepted and the pair still resolves", () => {
  const seen = []
  const r = render(LatLngInput, { onValueChange: (v) => seen.push(v) })
  typeInto(r, 0, "35°41'22.2\"N")
  typeInto(r, 1, "139°41'30\"E")
  const point = seen.at(-1)
  assert.ok(point, "a dms pair is a point")
  assert.ok(Math.abs(point.lat - (35 + 41 / 60 + 22.2 / 3600)) < 1e-9)
  assert.ok(Math.abs(point.lng - (139 + 41 / 60 + 30 / 3600)) < 1e-9)
  r.unmount()
})

test("the swap button exchanges the two boxes' text", () => {
  const r = render(LatLngInput, {})
  typeInto(r, 0, "139.6917")
  typeInto(r, 1, "35.6895")
  const swapButton = byTag(walk(r.tree), "button").find((n) =>
    String(walk(n).map((x) => x.props?.children).join("")).includes("Swap")
  )
  assert.ok(swapButton, "there is a swap control")
  swapButton.props.onClick()
  r.rerender()
  assert.equal(boxes(r.tree)[0].props.value, "35.6895")
  assert.equal(boxes(r.tree)[1].props.value, "139.6917")
  r.unmount()
})

test("an impossible latitude is called a swap rather than just out of range", () => {
  const r = render(LatLngInput, {})
  typeInto(r, 0, "139.6917")
  typeInto(r, 1, "35.6895")
  assert.match(byRole(walk(r.tree), "status")[0].props.children, /wrong way round/)
  r.unmount()
})

test("a name posts canonical decimal degrees, and posts nothing it would not stand behind", () => {
  const r = render(LatLngInput, { name: "site" })
  typeInto(r, 0, "35°41'22.2\"N")
  typeInto(r, 1, "139.6917")
  const posted = hidden(r.tree)
  assert.deepEqual(
    posted.map((n) => n.props.name),
    ["site.lat", "site.lng"]
  )
  assert.equal(posted[1].props.value, "139.691700")
  assert.ok(posted.every((n) => n.props.disabled === false))
  // An invalid box stops the pair being posted at all, rather than posting half of it.
  typeInto(r, 0, "95")
  for (const node of hidden(r.tree)) {
    assert.equal(node.props.value, "")
    assert.equal(node.props.disabled, true)
  }
  r.unmount()
})

test("no hidden inputs exist without a name", () => {
  const r = render(LatLngInput, {})
  assert.equal(hidden(r.tree).length, 0)
  r.unmount()
})

test("a controlled value is shown, and a half-typed decimal is not erased by an echo", () => {
  const r = render(LatLngInput, { value: { lat: 35.6895, lng: 139.6917 }, decimals: 4 })
  assert.equal(boxes(r.tree)[0].props.value, "35.6895")
  r.update({ value: { lat: -12.0464, lng: -77.0428 }, decimals: 4 })
  assert.equal(boxes(r.tree)[0].props.value, "-12.0464")
  assert.equal(boxes(r.tree)[1].props.value, "-77.0428")
  r.unmount()
})

test("the precision note is rendered and follows the latitude on screen", () => {
  const r = render(LatLngInput, { decimals: 6 })
  typeInto(r, 0, "0")
  const atEquator = walk(r.tree).find((n) => /decimal places/.test(String(n.props?.children)))
  assert.match(String(atEquator.props.children), /11 cm east-west/)
  typeInto(r, 0, "60")
  const atSixty = walk(r.tree).find((n) => /decimal places/.test(String(n.props?.children)))
  assert.match(String(atSixty.props.children), /5\.6 cm east-west/)
  r.unmount()
})

test("the component is disableable in one place", () => {
  const r = render(LatLngInput, { disabled: true, name: "site" })
  for (const input of boxes(r.tree)) assert.equal(input.props.disabled, true)
  for (const button of byTag(walk(r.tree), "button")) assert.equal(button.props.disabled, true)
  r.unmount()
})

// --- holes mutation testing found ---------------------------------------------------------------
//
// Everything below was added after `node scripts/mutate.mjs registry/ui/latlng-input.tsx
// test/latlng-input.test.mjs` reported 128 survivors out of 318. Most of those were type
// annotations the runtime erases (`-1 | 1` -> `-0 | 1`) or rewrites that are arithmetically the
// same (the longitude fold absorbs a `+180` turned into `-180`), but the ones below changed real
// behaviour with nothing to catch them, and two were redundancy in the source rather than a gap in
// the suite — see the note in `looksSwapped`.

test("a bare degree reading, and one with minutes but no seconds, both parse", () => {
  // `35°` alone takes a branch nothing else reached: the minutes group is undefined and the
  // fallback to 0 is what makes it a reading rather than NaN.
  assert.equal(parseCoordinate("35°", "lat").degrees, 35)
  assert.equal(parseCoordinate("35°", "lat").format, "dms")
  assert.ok(Math.abs(parseCoordinate("35 41", "lat").degrees - (35 + 41 / 60)) < 1e-12)
  assert.equal(parseCoordinate("35 41", "lat").format, "dms")
})

test("a decimal with a trailing degree sign is still a decimal", () => {
  // Pasted values carry one, and reading the whole match instead of the number group turns this
  // into NaN.
  assert.equal(parseCoordinate("35.6895°", "lat").degrees, 35.6895)
  assert.equal(parseCoordinate("35.6895°", "lat").format, "decimal")
})

test("a leading plus is a sign, not junk", () => {
  assert.equal(parseCoordinate("+35.5", "lat").degrees, 35.5)
  assert.equal(parseCoordinate("+139.5", "lng").degrees, 139.5)
})

test("the sixty check guards the space-separated form too, not only the symbol form", () => {
  assert.ok(Number.isNaN(parseCoordinate("35 60 00", "lat").degrees))
  assert.ok(Number.isNaN(parseCoordinate("35 00 60", "lat").degrees))
  assert.ok(Number.isNaN(parseCoordinate("35:60:00", "lat").degrees))
  assert.equal(parseCoordinate("35 60 00", "lat").format, "dms")
})

test("both of the other axis' letters are refused, not just the first", () => {
  // W in a latitude box and S in a longitude box are the cases a single-letter check misses.
  for (const text of ["35E", "35W", "E35", "W35"]) {
    assert.ok(Number.isNaN(parseCoordinate(text, "lat").degrees), `${text} in a latitude box`)
  }
  for (const text of ["35N", "35S", "N35", "S35"]) {
    assert.ok(Number.isNaN(parseCoordinate(text, "lng").degrees), `${text} in a longitude box`)
  }
})

test("an issue names the axis it is about", () => {
  assert.match(checkCoordinate(95, "lat").issue.message, /^Latitude/)
  assert.match(checkCoordinate(200, "lng", { wrap: false }).issue.message, /^Longitude/)
  assert.match(checkCoordinate(Number.NaN, "lat").issue.message, /^Latitude is not a coordinate/)
  assert.equal(checkCoordinate(Number.NaN, "lat").issue.code, "not-a-number")
  assert.equal(checkCoordinate(Number.NaN, "lat").issue.axis, "lat")
})

test("the wrapped message shows both meridians to four places", () => {
  assert.equal(
    checkCoordinate(181, "lng").issue.message,
    "181.0000° is the same meridian as -179.0000°."
  )
})

test("a pole is not a swap, and a longitude of exactly 90 is", () => {
  // 90 is a real latitude, so flagging it would call the north pole a mistake.
  assert.equal(looksSwapped(90, 45), false)
  assert.equal(looksSwapped(-90, 45), false)
  // 139 cannot be a latitude and 90 can, so the pair reads unambiguously backwards.
  assert.equal(looksSwapped(139, 90), true)
  assert.equal(looksSwapped(35, null), false)
})

test("the precision sentence steps through every tier it has", () => {
  // The boundaries are only reachable from the ends of the decimals range, which is where the
  // tier picker was previously never exercised.
  assert.match(precisionNote(0, 0), /111 km north-south/)
  assert.match(precisionNote(2, 0), /1\.1 km north-south/)
  assert.match(precisionNote(3, 0), /111 m north-south/)
  assert.match(precisionNote(4, 0), /11 m north-south/)
  assert.match(precisionNote(6, 0), /11 cm north-south/)
  assert.match(precisionNote(8, 0), /1\.1 mm north-south/)
  assert.match(precisionNote(9, 0), /111 µm north-south/)
  // A latitude of NaN is treated as the equator rather than printed as a non-reading.
  assert.match(precisionNote(6, Number.NaN), /11 cm east-west/)
  assert.equal(precisionNote(6, null), precisionNote(6, 0))
})

test("the defaults are the ones documented, not whatever the call sites happen to pass", () => {
  // Every other test passes these explicitly, so the defaults themselves were unheld.
  assert.equal(formatDecimal(35.6895), "35.689500")
  assert.equal(formatDms(35.6895, "lat"), '35°41\'22.200"N')
  assert.deepEqual(toDmsParts(35.6895), { sign: 1, degrees: 35, minutes: 41, seconds: 22.2 })
})

test("zero decimal places on the seconds still pads to two digits", () => {
  // The padding is computed from `secondDigits`, and the no-decimals branch is its own case.
  assert.equal(formatDms(5.0836111111, "lat", 0), '5°05\'01"N')
  assert.equal(formatDms(5.0002777778, "lat", 0), '5°00\'01"N')
})

test("the boxes carry the visible labels and the order-stating placeholders", () => {
  const r = render(LatLngInput, {})
  const labels = byTag(walk(r.tree), "label")
  assert.match(String(labels[0].props.children[0]), /Latitude/)
  assert.match(String(labels[1].props.children[0]), /Longitude/)
  // The sr-only hint says which way each axis runs, which is the part a label alone does not.
  assert.match(String(labels[0].props.children[1].props.children), /north and south, -90 to 90/)
  assert.match(String(labels[1].props.children[1].props.children), /east and west, -180 to 180/)
  const inputs = boxes(r.tree)
  assert.equal(inputs[0].props.placeholder, "35.689500")
  assert.equal(inputs[1].props.placeholder, "139.691700")
  // A coordinate is not something to autofill from a saved address.
  for (const input of inputs) assert.equal(input.props.autoComplete, "off")
  r.unmount()
})

test("the swap control is type=button, so it cannot submit the form it sits in", () => {
  const r = render(LatLngInput, { name: "site" })
  const buttons = byTag(walk(r.tree), "button")
  assert.ok(buttons.length > 0)
  for (const button of buttons) assert.equal(button.props.type, "button")
  r.unmount()
})

test("the status line says what the point is once it has one, and offers the notations until then", () => {
  const r = render(LatLngInput, {})
  const read = () => String(byRole(walk(r.tree), "status")[0].props.children)
  assert.match(read(), /Decimal degrees or degrees-minutes-seconds/)
  typeInto(r, 0, "35.6895")
  typeInto(r, 1, "139.6917")
  // Both notations at once: the one that was typed and the one that was not.
  assert.match(read(), /35°41'22\.200"N/)
  assert.match(read(), /139°41'30\.120"E/)
  assert.match(read(), /35\.689500, 139\.691700/)
  r.unmount()
})

test("an unreadable box is invalid, not merely an out-of-range one", () => {
  const r = render(LatLngInput, {})
  typeInto(r, 0, "north")
  assert.equal(boxes(r.tree)[0].props["aria-invalid"], true)
  assert.match(String(byRole(walk(r.tree), "status")[0].props.children), /not a coordinate/)
  r.unmount()
})

test("a wrapped longitude reads as a note and a real fault reads as a fault", () => {
  const r = render(LatLngInput, {})
  const status = () => byRole(walk(r.tree), "status")[0]
  typeInto(r, 1, "181")
  assert.doesNotMatch(String(status().props.className), /text-destructive/)
  typeInto(r, 0, "95")
  assert.match(String(status().props.className), /text-destructive/)
  r.unmount()
})

test("what is posted keeps six places even when fewer are shown", () => {
  // The box is for reading and the hidden input is for the route handler; rounding the stored
  // coordinate to the display setting would throw away 11 cm per place.
  const r = render(LatLngInput, { name: "site", decimals: 2 })
  typeInto(r, 0, "35.6895")
  typeInto(r, 1, "139.6917")
  const posted = hidden(r.tree)
  assert.equal(posted[0].props.value, "35.689500")
  assert.equal(posted[1].props.value, "139.691700")
  r.unmount()
})

test("a default value is rendered in the format asked for, with each axis' own letters", () => {
  const decimal = render(LatLngInput, { defaultValue: { lat: 35.6895, lng: 139.6917 } })
  assert.equal(boxes(decimal.tree)[0].props.value, "35.689500")
  assert.equal(boxes(decimal.tree)[1].props.value, "139.691700")
  decimal.unmount()

  const dms = render(LatLngInput, {
    defaultValue: { lat: -12.0464, lng: -77.0428 },
    format: "dms",
  })
  // S and W, not S and S: the axis each box was written with is part of the answer.
  assert.equal(boxes(dms.tree)[0].props.value, '12°02\'47.040"S')
  assert.equal(boxes(dms.tree)[1].props.value, '77°02\'34.080"W')
  dms.unmount()
})

test("a point on the equator and the prime meridian renders as zeros, not as empty boxes", () => {
  // 0,0 is the one coordinate that a `||` fallback turns into an empty field, and it is a real
  // place in the Gulf of Guinea.
  const r = render(LatLngInput, { value: { lat: 0, lng: 0 } })
  assert.equal(boxes(r.tree)[0].props.value, "0.000000")
  assert.equal(boxes(r.tree)[1].props.value, "0.000000")
  r.unmount()
})

test("a half-filled pair is never called a swap, whichever half is missing", () => {
  // 139 cannot be a latitude, but with nothing in the other box there is no pair to be backwards.
  assert.equal(looksSwapped(139, null), false)
  assert.equal(looksSwapped(null, 139), false)
  assert.equal(looksSwapped(139, Number.NaN), false)
})

test("the north-south and east-west figures are read off their own axes", () => {
  // At 60° they differ by a factor of two, which is the only latitude where using one figure for
  // both is visible in the sentence.
  const note = precisionNote(6, 60)
  assert.match(note, /11 cm north-south/)
  assert.match(note, /5\.6 cm east-west/)
  // And a single-micrometre tier still carries a decimal, unlike the 111 µm case.
  assert.match(precisionNote(11, 0), /1\.1 µm north-south/)
})

test("metresPerDegree defaults to the equator", () => {
  assert.equal(metresPerDegree("lat"), metresPerDegree("lat", 0))
  assert.equal(metresForDecimals(6, "lng"), metresForDecimals(6, "lng", 0))
})

test("one decimal place on the seconds is padded like two and zero are", () => {
  assert.equal(formatDms(5.0836111111, "lat", 1), '5°05\'01.0"N')
})

test("a controlled point in dms format is written with each box's own letters", () => {
  // The effect that pushes a controlled value into the boxes has to pass the axis through, or both
  // boxes come back with the latitude's letters.
  const r = render(LatLngInput, { value: { lat: 35.6895, lng: 139.6917 }, format: "dms" })
  r.update({ value: { lat: -12.0464, lng: -77.0428 }, format: "dms" })
  assert.equal(boxes(r.tree)[0].props.value, '12°02\'47.040"S')
  assert.equal(boxes(r.tree)[1].props.value, '77°02\'34.080"W')
  r.unmount()
})

test("a box with nothing wrong with it is not styled as though it were", () => {
  const r = render(LatLngInput, {})
  for (const input of boxes(r.tree)) {
    assert.doesNotMatch(String(input.props.className), /border-destructive/)
  }
  for (const button of byTag(walk(r.tree), "button")) {
    assert.doesNotMatch(String(button.props.className), /text-destructive/)
  }
  // And the swap control does light up once the pair can only be backwards.
  typeInto(r, 0, "139.6917")
  typeInto(r, 1, "35.6895")
  assert.match(String(byTag(walk(r.tree), "button")[0].props.className), /text-destructive/)
  r.unmount()
})

test("the boxes are not spellchecked and ask for a plain text keyboard", () => {
  const r = render(LatLngInput, {})
  for (const input of boxes(r.tree)) {
    assert.equal(input.props.spellCheck, false)
    // Not `inputMode="decimal"`: a degrees-minutes-seconds reading needs ° ' " and a letter.
    assert.equal(input.props.inputMode, "text")
  }
  r.unmount()
})
