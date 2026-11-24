"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Which axis a box holds. The two are not the same field with a different label.
 *
 * Latitude runs to ±90 and stops there; longitude runs to ±180 and comes back round the other
 * side. One number of decimals means a different distance on each of them, and only one of them
 * has a legitimate value whose sign cannot be stored (see `signOf`). Everything below that reads
 * `axis` is reading one of those three differences, not a label.
 */
export type Axis = "lat" | "lng"

/** The last degree each axis reaches. Measured against nothing — this is the definition. */
export const AXIS_LIMIT: Record<Axis, number> = { lat: 90, lng: 180 }

/** The two letters each axis uses, negative one second. */
export const HEMISPHERES: Record<Axis, readonly [string, string]> = {
  lat: ["N", "S"],
  lng: ["E", "W"],
}

/**
 * WGS84, the ellipsoid every consumer GPS and every web map reports against.
 *
 * Kept as the two defining numbers with the rest derived, rather than a table of metres per
 * degree, because the derived figures disagree with the ones usually quoted and the derivation is
 * the only way to see why. "111,320 m per degree" is the equatorial *longitude* degree; the
 * equatorial *latitude* degree is 110,574 m, 746 m shorter, because the meridian is the flatter
 * of the two curves there. A component that uses one figure for both is wrong about one axis
 * everywhere.
 */
export const WGS84 = { a: 6378137, f: 1 / 298.257223563 } as const

const E2 = (() => {
  const b = WGS84.a * (1 - WGS84.f)
  return (WGS84.a * WGS84.a - b * b) / (WGS84.a * WGS84.a)
})()

/**
 * How many metres one degree of `axis` covers at latitude `atLat`.
 *
 * Measured on this formula: at the equator a latitude degree is 110,574.3 m and a longitude degree
 * 111,319.5 m; at 35° they are 110,940.6 m and 91,288.2 m; at 60°, 111,412.3 m and 55,800.0 m; at
 * 85°, 111,685.4 m and 9,734.5 m.
 *
 * **The longitude figure is the one that matters for a form.** It falls away with the cosine of
 * the latitude, so the same six decimals that pin a point to 11 cm in Nairobi pin it to 1 cm in
 * Reykjavík — and the field cannot say what a decimal is worth without knowing where on the
 * planet the other box is pointing. That is why `precisionNote` takes the latitude.
 */
export function metresPerDegree(axis: Axis, atLat = 0): number {
  const phi = (atLat * Math.PI) / 180
  const s = Math.sin(phi)
  if (axis === "lat") {
    // Meridian radius of curvature.
    return ((WGS84.a * (1 - E2)) / Math.pow(1 - E2 * s * s, 1.5)) * (Math.PI / 180)
  }
  // Radius of the parallel: the prime vertical radius times cos(phi).
  return ((WGS84.a * Math.cos(phi)) / Math.sqrt(1 - E2 * s * s)) * (Math.PI / 180)
}

/** What the last of `decimals` decimal places is worth on the ground, in metres. */
export function metresForDecimals(decimals: number, axis: Axis, atLat = 0): number {
  return metresPerDegree(axis, atLat) * Math.pow(10, -decimals)
}

/**
 * The decimal place past which the digits are not precision.
 *
 * Measured against a latitude degree: five decimals is 1.11 m, which is where a phone's GPS sits;
 * six is 11 cm; seven is 1.11 cm, which is survey-grade RTK; eight is 1.1 mm. **Nothing in
 * positioning resolves the ninth**, so a field that stores twelve decimal places — 111 nanometres,
 * well inside the wavelength of visible light — is not storing a more exact location, it is
 * storing the arithmetic residue of whatever converted it. The number is representable; float64's
 * own step at 180° is 2.8e-14°, about 3 nm. The claim is what is false, not the storage.
 *
 * Returned rather than enforced: a value that arrived with twelve places is still the value, and
 * truncating somebody's data to make a point is worse than saying what the places mean.
 */
export const MEANINGFUL_DECIMALS = 8

/**
 * Whether a coordinate is in the southern or western half, including the value that cannot say so
 * for itself.
 *
 * **`-0` does not survive being displayed or stored.** Measured: `String(-0)` is `"0"`,
 * `(-0).toFixed(5)` is `"0.00000"` and `JSON.stringify(-0)` is `0`, while `-0 === 0` is `true` and
 * only `Object.is(-0, 0)` is `false`. A point on the equator at 0°00'00"S, or on the prime
 * meridian at 0°00'00"W, therefore loses its hemisphere the moment anything renders it — and no
 * comparison with `< 0` will find it again.
 *
 * So the sign is read through `Object.is` here, and the component carries the hemisphere letter as
 * its own piece of state rather than deriving it from the number on every keystroke. That is the
 * whole reason the letter is a control and not a decoration.
 */
export function signOf(degrees: number): -1 | 1 {
  return degrees < 0 || Object.is(degrees, -0) ? -1 : 1
}

/** The hemisphere letter `degrees` falls in. */
export function hemisphereOf(degrees: number, axis: Axis): string {
  return HEMISPHERES[axis][signOf(degrees) < 0 ? 1 : 0]
}

/**
 * Brings a longitude back inside ±180 without moving one that is already there.
 *
 * **The guard is the component, not an optimisation.** The formula everybody writes,
 * `((x + 180) % 360 + 360) % 360 - 180`, is correct for every out-of-range value and wrong for one
 * in-range value: measured, it turns `180` into `-180`. Those are the same meridian but not the
 * same answer — 180 is how the eastern side of the dateline is written, and a field that silently
 * rewrites a Fiji longitude to the western form has moved the reader's data while reporting
 * success. Worse in combination: rounding 179.9999999 to three decimal seconds lands on exactly
 * 180° (measured), so an unguarded wrap takes a point just short of the dateline and puts it on
 * the far side.
 *
 * Anything already in `[-180, 180]` is handed back untouched, sign of zero included. Only a value
 * outside it is folded, into `(-180, 180]`.
 */
export function wrapLongitude(degrees: number): number {
  if (!Number.isFinite(degrees)) return Number.NaN
  if (degrees >= -180 && degrees <= 180) return degrees
  const folded = (((degrees + 180) % 360) + 360) % 360 - 180
  // The fold sends an exact multiple of 360 to -180; 180 is the form that keeps the sign of the
  // input, which is the half of the dateline the reader was on.
  return folded === -180 && degrees > 0 ? 180 : folded
}

export interface DmsParts {
  /** -1 for the southern or western half. Separate from the numbers, so 0°S survives. */
  sign: -1 | 1
  degrees: number
  minutes: number
  seconds: number
}

/**
 * Splits a signed decimal degree into degrees, minutes and seconds.
 *
 * **The seconds are rounded before the carry, and the carry is the point.** Round afterwards and
 * the field prints times that do not exist: measured, 35.99999997222222° formatted naively is
 * `35°59'60.000"`, because the seconds come out as 59.9999 and `(59.9995).toFixed(2)` is `"60.00"`.
 * Sixty seconds is not a reading. So the rounded seconds roll into the minutes and the rounded
 * minutes into the degrees, and the same value prints as `36°00'00.000"`.
 *
 * `toFixed` is also not round-half-up, which is why the rounding has to happen in one declared
 * place rather than at each point of display: measured, `(1.005).toFixed(2)` is `"1.00"` and
 * `(2.675).toFixed(2)` is `"2.67"`, both a hair below the half because neither value is exactly
 * representable. Two call sites that each round will eventually disagree by one in the last place.
 */
export function toDmsParts(degrees: number, secondDigits = 3): DmsParts {
  const sign = signOf(degrees)
  const abs = Math.abs(degrees)
  let d = Math.floor(abs)
  const minutesFloat = (abs - d) * 60
  let m = Math.floor(minutesFloat)
  let s = Number(((minutesFloat - m) * 60).toFixed(secondDigits))
  if (s >= 60) {
    s = 0
    m += 1
  }
  if (m >= 60) {
    m = 0
    d += 1
  }
  return { sign, degrees: d, minutes: m, seconds: s }
}

/** Puts degrees, minutes and seconds back together as a signed decimal degree. */
export function fromDmsParts({ sign, degrees, minutes, seconds }: DmsParts): number {
  const magnitude = degrees + minutes / 60 + seconds / 3600
  // `0 * -1` is `-0`, which is deliberate: it is the only way the southern zero exists at all, and
  // `signOf` is built to find it again.
  return sign < 0 ? -magnitude : magnitude
}

/**
 * Writes a coordinate as degrees, minutes and seconds with its hemisphere letter.
 *
 * The letter carries the sign rather than a leading `-`, because this is the notation people
 * paste out of a map and because it is the only form in which the southern zero is legible: `-0`
 * prints as `0` (measured) while `0°00'00.000"S` says what it means.
 */
export function formatDms(degrees: number, axis: Axis, secondDigits = 3): string {
  if (!Number.isFinite(degrees)) return ""
  const p = toDmsParts(degrees, secondDigits)
  const seconds = p.seconds.toFixed(secondDigits)
  const padded = secondDigits > 0 ? seconds.padStart(secondDigits + 3, "0") : seconds.padStart(2, "0")
  const letter = HEMISPHERES[axis][p.sign < 0 ? 1 : 0]
  return `${p.degrees}°${String(p.minutes).padStart(2, "0")}'${padded}"${letter}`
}

/** Writes a coordinate as a plain signed decimal degree, with the southern zero kept legible. */
export function formatDecimal(degrees: number, decimals = 6): string {
  if (!Number.isFinite(degrees)) return ""
  const text = Math.abs(degrees).toFixed(decimals)
  return signOf(degrees) < 0 ? `-${text}` : text
}

/**
 * The characters that mean degree, minute, second and minus once a value has been pasted.
 *
 * Every one of these is in real data. `º` is U+00BA, the masculine ordinal, which is what a Mac
 * types with Option-0 and is not the degree sign U+00BA is mistaken for; `′` and `″` are the
 * typographic prime and double prime that map sites emit, against the `'` and `"` a keyboard
 * produces; `−` is U+2212, the mathematical minus, which **`Number` refuses outright** (measured:
 * `Number("−35")` is `NaN`). Normalising them is not tidying, it is the difference between
 * accepting a pasted coordinate and rejecting it for a character the reader cannot see.
 */
const NORMALISE: Record<string, string> = {
  "º": "°", // º masculine ordinal -> degree sign
  "′": "'", // prime
  "″": '"', // double prime
  "’": "'", // right single quote
  "”": '"', // right double quote
  "−": "-", // minus sign
  "–": "-", // en dash
  "－": "-", // fullwidth hyphen-minus
  "´": "'", // acute accent
}

export type CoordinateFormat = "decimal" | "dms"

export interface ParseResult {
  /** The value, or `null` for an empty box, or `NaN` for text that is not a coordinate. */
  degrees: number | null
  /** Which notation it was read as. `null` when there was nothing to read. */
  format: CoordinateFormat | null
}

/**
 * Reads one box as a coordinate on `axis`, in either notation.
 *
 * **Empty and wrong are kept apart.** An empty box is `null` and junk is `NaN`, because collapsing
 * them is what `Number` does — `Number("")` is `0`, measured — and zero is a real coordinate off
 * the coast of Ghana. A cleared box that posts a point in the Gulf of Guinea is the single most
 * expensive mistake this component can make, and it is the default behaviour of the obvious
 * implementation.
 *
 * The grammar is strict for the reason this registry's `number-range-input` gives, and the list of
 * things `Number` accepts that nobody typed is worth naming because it is longer than it looks:
 * measured, `Number("1e3")` is 1000, `Number("0x10")` is 16, `Number("Infinity")` is `Infinity`
 * and `Number(" 35 ")` is 35. None of those is a latitude. `35.` and `.5` do pass, because that is
 * what a half-typed decimal looks like and a box that refuses them cannot be typed into.
 *
 * A hemisphere letter may lead or trail, and it is checked against the axis: `N` in a longitude
 * box is a mistake worth reporting, not a sign to apply. A letter and a `-` together contradict
 * each other (`-35S`) and are refused rather than resolved, since either reading loses half the
 * readers.
 */
export function parseCoordinate(text: string, axis: Axis): ParseResult {
  let bare = ""
  for (const char of text.trim()) bare += NORMALISE[char] ?? char
  bare = bare.trim()
  if (bare === "") return { degrees: null, format: null }

  const [positive, negative] = HEMISPHERES[axis]
  const other = HEMISPHERES[axis === "lat" ? "lng" : "lat"]
  let letter: string | null = null

  // The letter is taken from either end, once.
  const head = bare[0]?.toUpperCase()
  const tail = bare[bare.length - 1]?.toUpperCase()
  const isAny = (c?: string) =>
    c === positive || c === negative || c === other[0] || c === other[1]
  if (isAny(head)) {
    letter = head!
    bare = bare.slice(1).trim()
  } else if (isAny(tail)) {
    letter = tail!
    bare = bare.slice(0, -1).trim()
  }
  // A letter from the other axis is a mistake to report, not a sign to apply.
  if (letter === other[0] || letter === other[1]) return { degrees: Number.NaN, format: null }

  let sign: -1 | 1 = 1
  if (bare[0] === "+" || bare[0] === "-") {
    if (letter) return { degrees: Number.NaN, format: null }
    sign = bare[0] === "-" ? -1 : 1
    bare = bare.slice(1).trim()
  } else if (letter === negative) {
    sign = -1
  }
  if (bare === "") return { degrees: Number.NaN, format: null }

  // Degrees-minutes-seconds, with the separators optional once the symbols are there.
  const dms = /^(\d+)\s*°\s*(?:(\d+)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?\s*)?)?$/.exec(bare)
  if (dms) {
    const d = Number(dms[1])
    const m = dms[2] === undefined ? 0 : Number(dms[2])
    const s = dms[3] === undefined ? 0 : Number(dms[3])
    // Sixty is the next unit up, not a reading; a paste carrying it is junk rather than something
    // to normalise, because normalising it hides that the source was broken.
    if (m >= 60 || s >= 60) return { degrees: Number.NaN, format: "dms" }
    return { degrees: fromDmsParts({ sign, degrees: d, minutes: m, seconds: s }), format: "dms" }
  }
  // A space- or colon-separated triple, which is how a GIS export and a handheld GPS both write it.
  const triple = /^(\d+)[\s:]+(\d+)(?:[\s:]+(\d+(?:\.\d+)?))?$/.exec(bare)
  if (triple) {
    const m = Number(triple[2])
    const s = triple[3] === undefined ? 0 : Number(triple[3])
    if (m >= 60 || s >= 60) return { degrees: Number.NaN, format: "dms" }
    return {
      degrees: fromDmsParts({ sign, degrees: Number(triple[1]), minutes: m, seconds: s }),
      format: "dms",
    }
  }
  // Plain decimal degrees, with a trailing degree sign allowed because pasted values carry one.
  const decimal = /^(\d+(?:\.\d*)?|\.\d+)\s*°?$/.exec(bare)
  if (decimal) {
    const magnitude = Number(decimal[1])
    if (!Number.isFinite(magnitude)) return { degrees: Number.NaN, format: "decimal" }
    return { degrees: sign < 0 ? -magnitude : magnitude, format: "decimal" }
  }
  return { degrees: Number.NaN, format: null }
}

export interface AxisIssue {
  axis: Axis
  code: "not-a-number" | "out-of-range" | "wrapped"
  message: string
}

/**
 * Judges one parsed value against its axis.
 *
 * **The two axes are judged differently, and neither is silently corrected.** Latitude past ±90 is
 * refused: there is no reading of 95°N that does not also move the longitude 180°, so clamping it
 * to 90 would put the point somewhere the reader did not ask for while reporting success.
 * Longitude past ±180 has an unambiguous reading — 181° is 179°W, the same meridian — so it is
 * offered as a correction (`wrapped`) rather than an error, and `wrapLongitude` is the thing that
 * does it, with the dateline guard described there.
 */
export function checkCoordinate(
  degrees: number | null,
  axis: Axis,
  { wrap = true }: { wrap?: boolean } = {}
): { value: number | null; issue: AxisIssue | null } {
  if (degrees === null) return { value: null, issue: null }
  const name = axis === "lat" ? "Latitude" : "Longitude"
  if (!Number.isFinite(degrees)) {
    return {
      value: Number.NaN,
      issue: { axis, code: "not-a-number", message: `${name} is not a coordinate.` },
    }
  }
  const limit = AXIS_LIMIT[axis]
  if (Math.abs(degrees) <= limit) return { value: degrees, issue: null }
  if (axis === "lng" && wrap) {
    const wrapped = wrapLongitude(degrees)
    return {
      value: wrapped,
      issue: {
        axis,
        code: "wrapped",
        message: `${formatDecimal(degrees, 4)}° is the same meridian as ${formatDecimal(wrapped, 4)}°.`,
      },
    }
  }
  return {
    value: Number.NaN,
    issue: {
      axis,
      code: "out-of-range",
      message: `${name} runs from -${limit} to ${limit}.`,
    },
  }
}

/**
 * Whether the pair can only be the wrong way round.
 *
 * **This finds half the mistakes it is asked about, and saying which half is the honest part.** A
 * latitude past ±90 cannot be a latitude, so a Tokyo pair entered backwards (139.69 in the
 * latitude box) is caught outright. A London pair backwards is not: 51.5072 and -0.1276 are both
 * legal in both boxes, and so is every pair whose longitude is inside ±90 — which is half the
 * planet. Measured over six cities on five continents, four of the six were undetectable.
 *
 * So this is wired to a warning and an explicit swap control, and never to an automatic
 * correction. GeoJSON is the reason the mistake is so common — RFC 7946 writes a point as
 * `[longitude, latitude]`, the reverse of the order people say out loud — and an automatic fix
 * that is right half the time would move the other half of the data without telling anyone.
 */
export function looksSwapped(lat: number | null, lng: number | null): boolean {
  // One guard, not two: `Number.isFinite(null)` is `false`, so a separate `=== null` check is the
  // same condition written twice. Mutation testing found it by changing the `||` to `&&` in either
  // line without any test noticing, which is what two spellings of one rule look like from outside.
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return Math.abs(lat as number) > AXIS_LIMIT.lat && Math.abs(lng as number) <= AXIS_LIMIT.lat
}

/** A sentence saying what the decimals on screen are worth at this latitude. */
export function precisionNote(decimals: number, atLat: number | null): string {
  // Same single guard as `looksSwapped`: this catches `null` and `NaN` alike.
  const lat = Number.isFinite(atLat) ? (atLat as number) : 0
  const metres = metresForDecimals(decimals, "lng", lat)
  const latMetres = metresForDecimals(decimals, "lat", lat)
  // Each tier down to micrometres, because the tier is the answer. Stopping at centimetres prints
  // "0.0 cm" for twelve decimal places, which is the one case this sentence exists to explain.
  const say = (m: number) => {
    if (m >= 1000) return `${(m / 1000).toFixed(m / 1000 >= 10 ? 0 : 1)} km`
    if (m >= 1) return `${m.toFixed(m >= 10 ? 0 : 2)} m`
    if (m >= 0.01) return `${(m * 100).toFixed(m * 100 >= 10 ? 0 : 1)} cm`
    if (m >= 0.001) return `${(m * 1000).toFixed(1)} mm`
    if (m >= 1e-6) return `${(m * 1e6).toFixed(m * 1e6 >= 10 ? 0 : 1)} \u00b5m`
    return "less than a micrometre"
  }
  const beyond =
    decimals > MEANINGFUL_DECIMALS
      ? " — finer than any positioning system resolves, so the extra places are arithmetic, not accuracy"
      : ""
  return `${decimals} decimal places: ${say(latMetres)} north-south, ${say(metres)} east-west at this latitude${beyond}.`
}

export interface LatLng {
  lat: number
  lng: number
}

export interface LatLngInputProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> {
  /** The point, in signed decimal degrees. Controlled when supplied. */
  value?: LatLng | null
  defaultValue?: LatLng | null
  /** Called with a complete, in-range point, or `null` while either box is empty or wrong. */
  onValueChange?: (value: LatLng | null) => void
  /** Which notation the boxes show. Typing the other one is always accepted. */
  format?: CoordinateFormat
  /** Decimal places shown in `decimal` format. */
  decimals?: number
  /** Decimal places on the seconds in `dms` format. */
  secondDigits?: number
  /** Offer to fold an out-of-range longitude onto its own meridian. */
  wrapLongitudeBeyondRange?: boolean
  /** Posts `lat` and `lng` as canonical signed decimal degrees, and posts nothing when invalid. */
  name?: string
  label?: string
  disabled?: boolean
}

const LABELS: Record<Axis, string> = { lat: "Latitude", lng: "Longitude" }

/**
 * Two boxes for one point, which is a different component from two number fields.
 *
 * What it is for: registering a shop or site, a geofence, a collection point, a survey station or
 * drone waypoint, a wildlife or sensor observation, and checking the numbers after dragging a pin.
 * It takes decimal degrees or degrees-minutes-seconds in either box, in either order, and reports
 * what it could not read rather than quietly substituting zero.
 *
 * Within pulld, `geolocation-button` asks the device where it is and this asks a person where
 * something is; `number-range-input` holds one axis' worth of from-and-to, and `unit-input` one
 * value with its unit.
 */
export function LatLngInput({
  value,
  defaultValue = null,
  onValueChange,
  format = "decimal",
  decimals = 6,
  secondDigits = 3,
  wrapLongitudeBeyondRange = true,
  name,
  label = "Coordinates",
  disabled,
  className,
  ...rest
}: LatLngInputProps) {
  const isControlled = value !== undefined
  const reactId = React.useId()
  // `Number.isFinite` already answers `false` for `null`, so it is the whole guard — the third
  // place in this file where a separate null check was the same condition written twice.
  const write = (axis: Axis, v: number | null) =>
    !Number.isFinite(v)
      ? ""
      : format === "dms"
        ? formatDms(v as number, axis, secondDigits)
        : formatDecimal(v as number, decimals)

  const seed = isControlled ? value : defaultValue
  const seedText: Record<Axis, string> = {
    lat: write("lat", seed?.lat ?? null),
    lng: write("lng", seed?.lng ?? null),
  }
  const [text, setText] = React.useState<Record<Axis, string>>(seedText)

  // A controlled value that changes from outside is rewritten into the boxes, but only when it is
  // a different point from the one on screen. Comparing the rendered text instead of the numbers
  // is what keeps a half-typed "35." from being erased by the parent echoing 35 back. Seeded from
  // the same strings the boxes started with rather than a second copy of that expression.
  const lastPushed = React.useRef<string>(`${seedText.lat}|${seedText.lng}`)
  React.useEffect(() => {
    if (!isControlled) return
    const next = `${write("lat", value?.lat ?? null)}|${write("lng", value?.lng ?? null)}`
    if (next === lastPushed.current) return
    lastPushed.current = next
    const [lat, lng] = next.split("|")
    setText({ lat, lng })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isControlled, value?.lat, value?.lng, format, decimals, secondDigits])

  const parsed: Record<Axis, ParseResult> = {
    lat: parseCoordinate(text.lat, "lat"),
    lng: parseCoordinate(text.lng, "lng"),
  }
  const checkedLat = checkCoordinate(parsed.lat.degrees, "lat")
  const checkedLng = checkCoordinate(parsed.lng.degrees, "lng", {
    wrap: wrapLongitudeBeyondRange,
  })
  const issues = [checkedLat.issue, checkedLng.issue].filter(Boolean) as AxisIssue[]
  const swapped = looksSwapped(parsed.lat.degrees, parsed.lng.degrees)
  const complete =
    checkedLat.value !== null &&
    checkedLng.value !== null &&
    Number.isFinite(checkedLat.value) &&
    Number.isFinite(checkedLng.value)
  const point: LatLng | null = complete
    ? { lat: checkedLat.value as number, lng: checkedLng.value as number }
    : null

  // The parent hears about a point, not about a keystroke. Emitting on every edit would hand it
  // `null` between the two boxes being filled, which reads as "cleared" to anything that stores it.
  const lastEmitted = React.useRef<string>("\u0000")
  React.useEffect(() => {
    const key = point ? `${point.lat},${point.lng}` : "null"
    if (key === lastEmitted.current) return
    lastEmitted.current = key
    onValueChange?.(point)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point?.lat, point?.lng])

  const edit = (axis: Axis, next: string) => setText((t) => ({ ...t, [axis]: next }))

  const swap = () => setText((t) => ({ lat: t.lng, lng: t.lat }))

  const statusId = `${reactId}-status`
  const noteId = `${reactId}-note`
  const atLat = Number.isFinite(checkedLat.value as number) ? (checkedLat.value as number) : null

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex w-full flex-col gap-2", className)}
      {...rest}
    >
      <div className="flex flex-wrap items-end gap-2">
        {(["lat", "lng"] as Axis[]).map((axis) => {
          const issue = issues.find((i) => i.axis === axis)
          const bad = issue?.code === "not-a-number" || issue?.code === "out-of-range"
          return (
            <div key={axis} className="flex min-w-[9rem] flex-1 flex-col gap-1">
              <label
                htmlFor={`${reactId}-${axis}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {LABELS[axis]}
                <span className="sr-only">
                  {axis === "lat"
                    ? ", north and south, -90 to 90"
                    : ", east and west, -180 to 180"}
                </span>
              </label>
              <input
                id={`${reactId}-${axis}`}
                // `type="text"` rather than `type="number"`: a number input discards text it cannot
                // parse, so `35°41'22"N` would vanish from under the reader instead of being read.
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                value={text[axis]}
                aria-invalid={bad || undefined}
                aria-describedby={`${statusId} ${noteId}`}
                placeholder={axis === "lat" ? "35.689500" : "139.691700"}
                onChange={(e) => edit(axis, e.target.value)}
                className={cn(
                  "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
                  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  bad && "border-destructive focus-visible:ring-destructive"
                )}
              />
            </div>
          )
        })}
        <button
          type="button"
          onClick={swap}
          disabled={disabled}
          className={cn(
            "h-9 shrink-0 rounded-md border border-input px-3 text-xs font-medium transition-colors",
            "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            swapped && "border-destructive text-destructive"
          )}
        >
          Swap
          <span className="sr-only"> latitude and longitude</span>
        </button>
      </div>

      {/* One polite status line for the whole group: two live regions racing each other is how a
          screen reader ends up reading neither. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn(
          "text-xs",
          issues.some((i) => i.code !== "wrapped") || swapped
            ? "text-destructive"
            : "text-muted-foreground"
        )}
      >
        {swapped
          ? `That latitude is past ${AXIS_LIMIT.lat}°, so the two are the wrong way round. GeoJSON writes longitude first.`
          : issues.length > 0
            ? issues.map((i) => i.message).join(" ")
            : point
              ? `${formatDms(point.lat, "lat", secondDigits)} ${formatDms(point.lng, "lng", secondDigits)} — ${formatDecimal(point.lat, decimals)}, ${formatDecimal(point.lng, decimals)}`
              : "Decimal degrees or degrees-minutes-seconds, either box."}
      </p>
      <p id={noteId} className="text-xs text-muted-foreground">
        {precisionNote(decimals, atLat)}
      </p>

      {name ? (
        <>
          <input
            type="hidden"
            name={`${name}.lat`}
            value={point ? formatDecimal(point.lat, Math.max(decimals, 6)) : ""}
            disabled={!point}
          />
          <input
            type="hidden"
            name={`${name}.lng`}
            value={point ? formatDecimal(point.lng, Math.max(decimals, 6)) : ""}
            disabled={!point}
          />
        </>
      ) : null}
    </div>
  )
}
