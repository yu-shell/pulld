// A contrast checker is written the same wrong way almost every time, and the cases below are
// written to fail against that version rather than to describe this one:
//
//   - average the three channels instead of linearising them and weighting by 0.2126/0.7152/0.0722,
//     which reports #777777 on white as 2.03:1 when it is 4.48:1 — failing a pair that conforms,
//   - divide the luminances without the 0.05 flare term in both, which is Infinity for every pair
//     involving black rather than a number that can be compared to a threshold,
//   - carry the float alpha straight into the composite, which disagrees with what the compositor
//     paints because the alpha in play is eight-bit,
//   - decide "large text" from the size alone, when the rule is 18pt at any weight *or* 14pt bold,
//     so the same 18.67px is large at weight 700 and normal at weight 400,
//   - compare the size with a strict >=, which turns `14pt` into normal-size text because
//     `(14 * 96) / 72` and `14 * (96 / 72)` are different floats,
//   - invent a stricter non-text requirement for AAA, when 1.4.11 has no AAA counterpart,
//     and so fail pairs that conform,
//   - round the displayed ratio to nearest, which prints "4.50:1" above a verdict that says the
//     pair misses 4.5:1,
//   - pull three integers out of `getComputedStyle` with a regex, which finds nothing in a theme
//     written in `lab()` or `oklch()` — which is every current shadcn theme,
//   - resolve `var(--token)` on a probe parked at the end of `body`, which returns the inherited
//     text colour rather than an error, so the ratio is wrong and nothing says so,
//   - and assume white under a translucent colour, which tells a dark theme its overlay text passes.
//
// What the harness can and cannot see matters here. It has no document, so the component renders
// its unmeasured state and the measuring is exercised through `measureContrast` against the fake
// document below. That fake is not a model of this component's arithmetic — its compositing and its
// notation table are the numbers read out of a real browser during the design of this part
// (`oklch(0.7 0.15 250)` really does paint 75/163/247, `rgba(255,0,0,0.5)` over white really does
// paint 255/127/127), so agreeing with it is a check against the browser and not against itself.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "registry", "ui", "color-contrast.tsx")

const icons = new Proxy(
  {},
  {
    get: (_target, name) =>
      function Icon(props) {
        return { type: "svg", props: { ...props, "data-icon": String(name).toLowerCase() } }
      },
  },
)

const {
  ColorContrast,
  relativeLuminance,
  contrastRatio,
  compositeOver,
  isLargeText,
  requiredRatio,
  gradeContrast,
  formatRatio,
  cssLengthToPx,
  cssWeightToNumber,
  measureColorIn,
  measureContrast,
  findBackdrop,
  LARGE_TEXT_PX,
  LARGE_BOLD_TEXT_PX,
} = loadComponent(SOURCE, { stubs: { "lucide-react": icons } })

const hex = (h) => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
})

/* ------------------------------------------------------------------ the arithmetic ------------ */

test("the ratio matches the figures the published checkers report, to the digit", () => {
  // Seven pairs whose ratios are quoted everywhere; any of them off by 0.01 means the transfer
  // function, the weights or the flare term is wrong.
  const published = [
    ["#000000", "#ffffff", 21.0],
    ["#777777", "#ffffff", 4.48],
    ["#0000ff", "#ffffff", 8.59],
    ["#ff0000", "#ffffff", 4.0],
    ["#595959", "#ffffff", 7.0],
    ["#767676", "#ffffff", 4.54],
    ["#ffffff", "#ffffff", 1.0],
  ]
  for (const [fg, bg, expected] of published) {
    const got = contrastRatio(hex(fg), hex(bg))
    assert.ok(
      Math.abs(got - expected) < 0.005,
      `${fg} on ${bg}: expected ${expected}, got ${got.toFixed(4)}`,
    )
  }
})

test("the ratio is order-independent and bounded by 1 and 21", () => {
  const a = hex("#3b82f6")
  const b = hex("#fbfbfa")
  assert.equal(contrastRatio(a, b), contrastRatio(b, a))
  assert.equal(contrastRatio(hex("#000000"), hex("#000000")), 1)
  assert.equal(Math.round(contrastRatio(hex("#000000"), hex("#ffffff")) * 100) / 100, 21)
})

test("luminance is weighted, not averaged — the averaged version fails a conforming pair", () => {
  // Green carries roughly ten times the weight of blue. A mean of the channels cannot express that,
  // and the error is not academic: it reports #777777 on white as failing AA when it passes.
  const mean = (c) => (c.r + c.g + c.b) / 3 / 255
  const meanRatio = (x, y) =>
    (Math.max(mean(x), mean(y)) + 0.05) / (Math.min(mean(x), mean(y)) + 0.05)

  // #767676 is the canonical grey that just clears AA on white, at 4.54:1.
  const grey = hex("#767676")
  const white = hex("#ffffff")
  assert.ok(contrastRatio(grey, white) >= 4.5, "#767676 on white passes AA for body text")
  assert.ok(meanRatio(grey, white) < 4.5, "the averaged version would fail it")

  // Two colours of identical mean brightness and very different luminance — the clearest statement
  // that the mean is not a luminance.
  const blue = { r: 0, g: 0, b: 255 }
  const green = { r: 0, g: 255, b: 0 }
  assert.equal(mean(blue), mean(green))
  assert.ok(relativeLuminance(green) > relativeLuminance(blue) * 9)
})

test("the 0.05 in both terms is what keeps black comparable to a threshold", () => {
  // Without it the denominator is zero for every pair involving black.
  const bare = (x, y) =>
    Math.max(relativeLuminance(x), relativeLuminance(y)) /
    Math.min(relativeLuminance(x), relativeLuminance(y))
  assert.equal(bare(hex("#ffffff"), hex("#000000")), Infinity)
  assert.ok(Number.isFinite(contrastRatio(hex("#ffffff"), hex("#000000"))))
  assert.ok(Number.isFinite(contrastRatio(hex("#000000"), hex("#000000"))))
})

test("luminance is clamped rather than extrapolated past the ends of the range", () => {
  assert.equal(relativeLuminance({ r: 300, g: 300, b: 300 }), relativeLuminance(hex("#ffffff")))
  assert.equal(relativeLuminance({ r: -5, g: -5, b: -5 }), relativeLuminance(hex("#000000")))
  assert.equal(relativeLuminance({ r: NaN, g: NaN, b: NaN }), relativeLuminance(hex("#000000")))
})

/* ------------------------------------------------------------------ compositing --------------- */

test("compositing quantises alpha to eight bits, which is what the compositor does", () => {
  // Measured in a browser: rgba(255,0,0,0.5) over white paints 255/127/127, not 255/128/128,
  // because the alpha in play is 128/255 rather than 0.5. The float form is off by one here.
  const got = compositeOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 })
  assert.deepEqual(got, { r: 255, g: 127, b: 127 })

  const float = (t, a, b) => Math.round(a * t + (1 - a) * b)
  assert.equal(float(0, 0.5, 255), 128, "the float form rounds the other way")

  // And over black the same colour paints 128/0/0 — the asymmetry is the quantisation showing.
  assert.deepEqual(compositeOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 0 }), {
    r: 128,
    g: 0,
    b: 0,
  })
})

test("a fully opaque or fully transparent layer composites to one of its two inputs", () => {
  const top = { r: 10, g: 20, b: 30 }
  const bottom = { r: 200, g: 100, b: 50 }
  assert.deepEqual(compositeOver({ ...top, a: 1 }, bottom), top)
  assert.deepEqual(compositeOver({ ...top, a: 0 }, bottom), bottom)
})

test("a missing or nonsense alpha is treated as opaque rather than as transparent", () => {
  // Defaulting the other way would silently report the backdrop's own ratio against itself, 1:1,
  // which reads as a catastrophic failure of a pair that may be fine.
  const top = { r: 10, g: 20, b: 30 }
  assert.deepEqual(compositeOver({ ...top, a: NaN }, { r: 255, g: 255, b: 255 }), top)
})

/* ------------------------------------------------------------------ thresholds ---------------- */

test("large text needs the weight as well as the size", () => {
  // The rule is 18pt at any weight or 14pt when bold, and 14pt bold is fewer pixels than 18pt — so
  // one size straddles the boundary and only the weight decides it.
  const px = LARGE_BOLD_TEXT_PX
  assert.equal(isLargeText({ px, weight: 700 }), true)
  assert.equal(isLargeText({ px, weight: 400 }), false)
  assert.equal(gradeContrast(3.2, "text", "AA", { px, weight: 700 }).operative.required, 3)
  assert.equal(gradeContrast(3.2, "text", "AA", { px, weight: 400 }).operative.required, 4.5)

  // 18pt is large at any weight.
  assert.equal(isLargeText({ px: LARGE_TEXT_PX, weight: 100 }), true)
  // Below 14pt, bold does not help.
  assert.equal(isLargeText({ px: 18.6, weight: 700 }), false)
  assert.equal(isLargeText({ px: 16, weight: 900 }), false)
})

test("`14pt` is large when bold, however the pt was converted to px", () => {
  // `(14 * 96) / 72` is 18.666666666666668 and `14 * (96 / 72)` is 18.666666666666664. A strict
  // comparison against the first rejects the second, which silently holds 14pt bold text to 4.5:1
  // instead of the 3:1 it is entitled to.
  const viaTable = cssLengthToPx("14pt")
  const viaDirect = (14 * 96) / 72
  assert.notEqual(viaTable, viaDirect, "the two associations really are different floats")
  assert.equal(isLargeText({ px: viaTable, weight: 700 }), true)
  assert.equal(isLargeText({ px: viaDirect, weight: 700 }), true)
  // And the four-decimal value a browser reports for 14pt.
  assert.equal(isLargeText({ px: 18.6667, weight: 700 }), true)
})

test("an unknown size is held to the normal-text requirement, not excused from one", () => {
  // No size given is not permission to use the easier threshold.
  assert.equal(gradeContrast(3.2, "text", "AA", undefined).operative.required, 4.5)
  assert.equal(gradeContrast(3.2, "text", "AA", undefined).large, false)
  // Nor is a size with no weight: the weight defaults to 400, which asks for more contrast.
  assert.equal(isLargeText({ px: LARGE_BOLD_TEXT_PX, weight: undefined }), false)
})

test("the four text requirements are the ones WCAG states, and the operative one is chosen", () => {
  const combos = [
    ["AA", false, "body-aa", 4.5],
    ["AAA", false, "body-aaa", 7],
    ["AA", true, "large-aa", 3],
    ["AAA", true, "large-aaa", 4.5],
  ]
  for (const [level, large, id, required] of combos) {
    const text = large ? { px: 24, weight: 400 } : { px: 16, weight: 400 }
    const report = gradeContrast(5, "text", level, text)
    assert.equal(report.operative.id, id)
    assert.equal(report.operative.required, required)
    assert.equal(report.checks.length, 4, "all four are reported, not only the operative one")
  }
})

test("non-text has no AAA counterpart, so AAA does not invent a stricter number", () => {
  // 1.4.11 is a AA criterion. Reporting more than 3:1 at AAA would fail pairs that conform.
  assert.equal(requiredRatio("non-text", "AAA", false), 3)
  assert.equal(requiredRatio("non-text", "AA", false), 3)
  const report = gradeContrast(3.0, "non-text", "AAA")
  assert.equal(report.operative.required, 3)
  assert.equal(report.operative.passes, true)
  assert.equal(report.checks.length, 1)
  assert.equal(report.large, false, "non-text has no notion of large")
})

test("every threshold shown comes from requiredRatio, so the table cannot disagree with itself", () => {
  const report = gradeContrast(5, "text", "AA", { px: 16, weight: 400 })
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.required]))
  assert.equal(byId["body-aa"], requiredRatio("text", "AA", false))
  assert.equal(byId["body-aaa"], requiredRatio("text", "AAA", false))
  assert.equal(byId["large-aa"], requiredRatio("text", "AA", true))
  assert.equal(byId["large-aaa"], requiredRatio("text", "AAA", true))
})

test("the verdict is taken on the unrounded ratio", () => {
  assert.equal(gradeContrast(4.4999, "text", "AA", { px: 16, weight: 400 }).operative.passes, false)
  assert.equal(gradeContrast(4.5, "text", "AA", { px: 16, weight: 400 }).operative.passes, true)
})

/* ------------------------------------------------------------------ display ------------------- */

test("the displayed ratio matches the published checkers, and never contradicts the verdict", () => {
  // Rounded, because every checker a reader might cross-check against rounds: #777777 on white is
  // quoted as 4.48 and is exactly 4.4767. Truncating would print 4.47 and look like a bug.
  assert.equal(formatRatio(4.4767), "4.48")
  assert.equal(formatRatio(21), "21.00")
  assert.equal(formatRatio(Infinity), "—")

  // The exception is the thousandth-wide band where the rounded figure would read as meeting a
  // requirement the pair misses. Told the requirement, it truncates there and only there.
  assert.equal((4.4993).toFixed(2), "4.50", "rounding alone would contradict the verdict")
  assert.equal(formatRatio(4.4993, 4.5), "4.49")
  assert.equal(formatRatio(4.4767, 4.5), "4.48", "no contradiction here, so no truncation")
  assert.equal(formatRatio(4.5, 4.5), "4.50")
  assert.equal(formatRatio(7.004, 7), "7.00")
})

test("CSS lengths convert only when the unit is absolute", () => {
  assert.equal(cssLengthToPx("24px"), 24)
  assert.equal(cssLengthToPx("18pt"), 24)
  assert.equal(cssLengthToPx(" 1in "), 96)
  assert.equal(cssLengthToPx("1pc"), 16)
  assert.equal(cssLengthToPx("20"), 20)
  assert.equal(cssLengthToPx(20), 20)
  // Relative to something only the document knows — the caller has to measure these.
  assert.equal(cssLengthToPx("1.5rem"), null)
  assert.equal(cssLengthToPx("2em"), null)
  assert.equal(cssLengthToPx("50%"), null)
  assert.equal(cssLengthToPx("4vw"), null)
  assert.equal(cssLengthToPx("nonsense"), null)
  assert.equal(cssLengthToPx(undefined), null)
  assert.equal(cssLengthToPx(NaN), null)
})

test("font weight keywords convert the way CSS computes them", () => {
  assert.equal(cssWeightToNumber("normal"), 400)
  assert.equal(cssWeightToNumber("bold"), 700)
  assert.equal(cssWeightToNumber("600"), 600)
  assert.equal(cssWeightToNumber(600), 600)
  // `bolder` and `lighter` are relative to the parent, so only the document can answer them.
  assert.equal(cssWeightToNumber("bolder"), null)
  assert.equal(cssWeightToNumber("lighter"), null)
})

/* ------------------------------------------------------------------ the fake document --------- */

// sRGB bytes read out of a real browser for notations that are not `rgb()`. The point of the table
// is that these arrive at the canvas unconverted, so something has to paint them.
const MEASURED = {
  "oklch(0.7 0.15 250)": [75, 163, 247, 1],
  "oklch(0.7 0.15 250 / 0.6)": [75, 163, 247, 0.6],
  "oklch(0.21 0.006 285.885)": [24, 24, 27, 1],
  "lab(0 0 0)": [0, 0, 0, 1],
  "lab(100 0 0)": [255, 255, 255, 1],
  "lab(48.496 0 0)": [115, 115, 115, 1],
  rebeccapurple: [102, 51, 153, 1],
  transparent: [0, 0, 0, 0],
}

function parseFake(value) {
  const v = String(value).trim()
  if (v in MEASURED) {
    const [r, g, b, a] = MEASURED[v]
    return { r, g, b, a }
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(v)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const h = /^#([0-9a-f]{6})$/i.exec(v)
  if (h) {
    const n = parseInt(h[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  return null
}

/** Source-over with the alpha quantised to eight bits, which is what a browser was measured doing. */
function sourceOver(src, dst) {
  const sa = Math.round(src.a * 255) / 255
  const a = sa + dst.a * (1 - sa)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (s, d) => Math.round((s * sa + d * dst.a * (1 - sa)) / a)
  return { r: mix(src.r, dst.r), g: mix(src.g, dst.g), b: mix(src.b, dst.b), a }
}

const SIZES = { "1.5rem": "24px", "2em": "32px", bolder: "700", lighter: "100" }

function makeNode({ tokens = {}, color = "rgb(26, 26, 26)", background = "rgba(0, 0, 0, 0)" } = {}) {
  const node = {
    tokens,
    ownColor: color,
    ownBackground: background,
    parentElement: null,
    isConnected: true,
    style: {},
    appendChild(child) {
      child.parentElement = node
      return child
    },
    remove() {
      this.parentElement = null
    },
  }
  return node
}

/** Chains `child` under `parent`, as the document would. */
function nest(parent, child) {
  child.parentElement = parent
  return child
}

const inherited = (node, key) => {
  for (let n = node; n; n = n.parentElement) if (n[key] !== undefined && n[key] !== null) return n[key]
  return undefined
}

const VALID_COLOR =
  /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|color\(|color-mix\(|var\(|currentcolor|transparent|rebeccapurple|red|blue|white|black)/i

function installDom() {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    CSS: globalThis.CSS,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
  }

  globalThis.document = {
    body: makeNode({ background: "rgb(255, 255, 255)" }),
    createElement(tag) {
      if (tag === "canvas") {
        let pixel = { r: 0, g: 0, b: 0, a: 0 }
        let fill = null
        const ctx = {
          get fillStyle() {
            return fill
          },
          set fillStyle(v) {
            const parsed = parseFake(v)
            // A value the canvas does not understand leaves fillStyle alone, as a browser's does.
            if (parsed !== null) fill = v
          },
          clearRect() {
            pixel = { r: 0, g: 0, b: 0, a: 0 }
          },
          fillRect() {
            const parsed = parseFake(fill)
            if (parsed !== null) pixel = sourceOver(parsed, pixel)
          },
          getImageData() {
            return { data: [pixel.r, pixel.g, pixel.b, Math.round(pixel.a * 255)] }
          },
        }
        return { width: 0, height: 0, getContext: () => ctx }
      }
      // null, not undefined: a default parameter would give the probe a colour of its own and
      // the inheritance this fake exists to model would never be consulted.
      return makeNode({ color: null, background: null })
    },
    fonts: { ready: { then: () => {} } },
  }
  globalThis.window = { matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) }
  globalThis.CSS = { supports: (_prop, value) => VALID_COLOR.test(String(value).trim()) }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.getComputedStyle = (node) => ({
    direction: "ltr",
    get color() {
      const asked = node.style?.color
      if (asked === undefined) return inherited(node, "ownColor") ?? "rgb(0, 0, 0)"
      const tokens = (() => {
        for (let n = node; n; n = n.parentElement) if (n.tokens && asked in n.tokens) return n.tokens[asked]
        return undefined
      })()
      if (tokens !== undefined) return tokens
      if (/^currentcolor$/i.test(asked)) return inherited(node, "ownColor") ?? "rgb(0, 0, 0)"
      if (parseFake(asked) !== null) return asked
      // An undefined custom property or an unreadable value makes the declaration invalid at
      // computed-value time, and `color` falls back to the inherited value — the measured trap.
      return inherited(node, "ownColor") ?? "rgb(0, 0, 0)"
    },
    get backgroundColor() {
      return inherited(node, "ownBackground") ?? "rgba(0, 0, 0, 0)"
    },
    get fontSize() {
      const asked = node.style?.fontSize
      return SIZES[asked] ?? asked ?? "16px"
    },
    get fontWeight() {
      const asked = node.style?.fontWeight
      return SIZES[asked] ?? asked ?? "400"
    },
  })

  return () => Object.assign(globalThis, saved)
}

const withDom = (fn) => {
  const restore = installDom()
  try {
    return fn()
  } finally {
    restore()
  }
}

/* ------------------------------------------------------------------ resolution ----------------- */

test("a theme token in `lab()` or `oklch()` resolves — the rgb regex finds nothing in it", () => {
  withDom(() => {
    // Every current shadcn theme computes to one of these two notations; reading three integers out
    // of the computed string is how a hand-rolled checker reports nothing at all on one.
    const context = makeNode({ tokens: { "var(--fg)": "lab(0 0 0)", "var(--bg)": "lab(100 0 0)" } })
    const fg = measureColorIn(context, "var(--fg)")
    const bg = measureColorIn(context, "var(--bg)")
    assert.equal(fg.ok && bg.ok, true)
    assert.equal(fg.computed, "lab(0 0 0)")
    assert.equal(/rgba?\(/.test(fg.computed), false, "nothing for a regex to find")
    assert.deepEqual(fg.color, { r: 0, g: 0, b: 0 })
    assert.equal(Math.round(contrastRatio(fg.color, bg.color) * 100) / 100, 21)
  })
})

test("a token resolves in the context it was asked about, not wherever a probe happens to sit", () => {
  withDom(() => {
    // The failure this guards is not an error but a wrong answer: a probe outside the declaring
    // subtree gets the inherited text colour back and nothing marks it as unresolved.
    const outer = makeNode({ color: "rgb(26, 26, 26)" })
    const scoped = nest(outer, makeNode({ tokens: { "var(--scoped)": "oklch(0.7 0.15 250)" } }))

    const inContext = measureColorIn(scoped, "var(--scoped)")
    assert.deepEqual(inContext.ok && inContext.color, { r: 75, g: 163, b: 247 })

    const outside = measureColorIn(outer, "var(--scoped)")
    assert.deepEqual(outside.ok && outside.color, { r: 26, g: 26, b: 26 })
    assert.notDeepEqual(inContext.color, outside.color, "the context is what decides the answer")
  })
})

test("currentColor means the colour where it was asked, too", () => {
  withDom(() => {
    const outer = makeNode({ color: "rgb(26, 26, 26)" })
    const inner = nest(outer, makeNode({ color: "rgb(12, 34, 56)" }))
    assert.deepEqual(measureColorIn(inner, "currentColor").color, { r: 12, g: 34, b: 56 })
    assert.deepEqual(measureColorIn(outer, "currentColor").color, { r: 26, g: 26, b: 26 })
  })
})

test("a value CSS rejects is reported, not quietly turned into the inherited colour", () => {
  withDom(() => {
    const context = makeNode({ color: "rgb(26, 26, 26)" })
    assert.deepEqual(measureColorIn(context, "notacolor"), { ok: false, reason: "invalid" })
    assert.deepEqual(measureColorIn(context, "   "), { ok: false, reason: "invalid" })
    // And a valid one is not rejected: `currentColor` and `var()` both pass the gate.
    assert.equal(measureColorIn(context, "currentColor").ok, true)
  })
})

test("transparency is detected without parsing a notation, and the opaque twin is not", () => {
  withDom(() => {
    const context = makeNode()
    assert.equal(measureColorIn(context, "oklch(0.7 0.15 250)").translucent, false)
    assert.equal(measureColorIn(context, "oklch(0.7 0.15 250 / 0.6)").translucent, true)
    assert.equal(measureColorIn(context, "rgba(255, 0, 0, 0.5)").translucent, true)
    assert.equal(measureColorIn(context, "transparent").translucent, true)
  })
})

test("a translucent colour is composited over the backdrop it was given", () => {
  withDom(() => {
    const context = makeNode()
    const onWhite = measureColorIn(context, "rgba(255, 0, 0, 0.5)", { r: 255, g: 255, b: 255 })
    const onBlack = measureColorIn(context, "rgba(255, 0, 0, 0.5)", { r: 0, g: 0, b: 0 })
    assert.deepEqual(onWhite.color, { r: 255, g: 127, b: 127 })
    assert.deepEqual(onBlack.color, { r: 128, g: 0, b: 0 })
    // The same two numbers the pure function gives, which is the agreement worth having.
    assert.deepEqual(compositeOver({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255 }), onWhite.color)
  })
})

test("the backdrop is the nearest painted ancestor, through any number of transparent ones", () => {
  withDom(() => {
    const page = makeNode({ background: "rgb(251, 251, 250)" })
    const wrap = nest(page, makeNode({ background: "rgba(0, 0, 0, 0)" }))
    const inner = nest(wrap, makeNode({ background: "rgba(0, 0, 0, 0)" }))
    const found = findBackdrop(inner)
    assert.deepEqual(found.color, { r: 251, g: 251, b: 250 })
    assert.equal(found.assumed, false)
  })
})

test("a translucent ancestor is composited rather than skipped", () => {
  withDom(() => {
    // A 60%-black panel over a near-white page is neither of them: 0.6 black over 251 is 100.
    const page = makeNode({ background: "rgb(251, 251, 250)" })
    const panel = nest(page, makeNode({ background: "rgba(0, 0, 0, 0.6)" }))
    const found = findBackdrop(panel)
    assert.deepEqual(found.color, { r: 100, g: 100, b: 100 })
    assert.equal(found.assumed, false)
  })
})

test("with nothing opaque anywhere above, white is marked as an assumption", () => {
  withDom(() => {
    const lone = makeNode({ background: "rgba(0, 0, 0, 0)" })
    const found = findBackdrop(lone)
    assert.deepEqual(found.color, { r: 255, g: 255, b: 255 })
    assert.equal(found.assumed, true, "assumed, so a translucent pair can refuse to answer")
  })
})

/* ------------------------------------------------------------------ the decision --------------- */

test("an opaque pair is graded against the background it was given", () => {
  withDom(() => {
    const context = makeNode({ background: "rgb(255, 255, 255)" })
    // #767676 clears AA at 4.54:1; #777777, one step lighter, is 4.4767 and does not — the two
    // greys either side of the threshold, which is where a checker earns its keep.
    const state = measureContrast(context, { foreground: "#767676", background: "#ffffff" })
    assert.equal(state.status, "measured")
    assert.equal(formatRatio(state.report.ratio), "4.54")
    assert.equal(state.report.operative.passes, true)

    const justUnder = measureContrast(context, { foreground: "#777777", background: "#ffffff" })
    assert.equal(formatRatio(justUnder.report.ratio), "4.48")
    assert.equal(justUnder.report.operative.passes, false, "4.4767 misses 4.5 despite showing 4.48")
    assert.deepEqual(state.translucent, { foreground: false, background: false })
    assert.deepEqual(state.invalid, [])
  })
})

test("translucent text is composited over the background, not over the page behind it", () => {
  withDom(() => {
    // Three layers: half-opaque black text, on a white panel, on a dark page. Compositing the text
    // straight onto the page skips the panel and reports a ratio against a colour nowhere on screen.
    const page = makeNode({ background: "rgb(0, 0, 0)" })
    const context = nest(page, makeNode({ background: "rgb(0, 0, 0)" }))
    const state = measureContrast(context, {
      foreground: "rgba(0, 0, 0, 0.5)",
      background: "#ffffff",
    })
    assert.equal(state.status, "measured")
    // 127 and not 128: the alpha in play is 128/255, so the white contributes 255 * (127/255).
    assert.deepEqual(state.foreground, { r: 127, g: 127, b: 127 }, "half black over the white background")
    assert.deepEqual(state.background, { r: 255, g: 255, b: 255 })
    assert.equal(state.translucent.foreground, true)
  })
})

test("a translucent pair with only an assumed backdrop refuses to give a ratio", () => {
  withDom(() => {
    // Assuming white here is how a dark theme is told its overlay text passes.
    const lone = makeNode({ background: "rgba(0, 0, 0, 0)" })
    const state = measureContrast(lone, {
      foreground: "#ffffff",
      background: "rgba(0, 0, 0, 0.5)",
    })
    assert.equal(state.status, "indeterminate")
    assert.equal(state.report, null)
    assert.equal(state.assumedBackdrop, true)
  })
})

test("naming a backdrop makes the same translucent pair answerable", () => {
  withDom(() => {
    const lone = makeNode({ background: "rgba(0, 0, 0, 0)" })
    const state = measureContrast(lone, {
      foreground: "#ffffff",
      background: "rgba(0, 0, 0, 0.5)",
      backdrop: "#000000",
    })
    assert.equal(state.status, "measured")
    assert.equal(state.assumedBackdrop, false)
    // White on half-black-over-black: the background resolves to 128/0-ish grey, not to black.
    assert.deepEqual(state.background, { r: 0, g: 0, b: 0 })
  })
})

test("a real painted ancestor also makes it answerable, without being asked", () => {
  withDom(() => {
    const page = makeNode({ background: "rgb(255, 255, 255)" })
    const context = nest(page, makeNode({ background: "rgba(0, 0, 0, 0)" }))
    const state = measureContrast(context, {
      foreground: "#000000",
      background: "rgba(255, 255, 255, 0.5)",
    })
    assert.equal(state.status, "measured")
    assert.equal(state.assumedBackdrop, false)
  })
})

test("an unreadable colour is named, and the other one is still measured", () => {
  withDom(() => {
    const context = makeNode({ background: "rgb(255, 255, 255)" })
    const state = measureContrast(context, { foreground: "notacolor", background: "#ffffff" })
    assert.equal(state.status, "invalid")
    assert.deepEqual(state.invalid, ["foreground"])
    assert.equal(state.report, null)
  })
})

test("the size and weight reach the grade, including through units only the document knows", () => {
  withDom(() => {
    const context = makeNode({ background: "rgb(255, 255, 255)" })
    const pair = { foreground: "#949494", background: "#ffffff" }

    const asBody = measureContrast(context, { ...pair, fontSize: 16 })
    assert.equal(asBody.report.operative.required, 4.5)
    assert.equal(asBody.report.operative.passes, false)

    // 1.5rem is 24px here, which is large at any weight — and the same pair now passes.
    const asLarge = measureContrast(context, { ...pair, fontSize: "1.5rem" })
    assert.equal(asLarge.report.large, true)
    assert.equal(asLarge.report.operative.required, 3)
    assert.equal(asLarge.report.operative.passes, true)

    // `bolder` is relative to the parent, so only the document can answer it.
    const asBolder = measureContrast(context, { ...pair, fontSize: "14pt", fontWeight: "bolder" })
    assert.equal(asBolder.report.large, true, "bolder resolved to 700")
  })
})

test("a non-text pair is graded against 3:1 and says so", () => {
  withDom(() => {
    const context = makeNode({ background: "rgb(255, 255, 255)" })
    const state = measureContrast(context, {
      foreground: "#949494",
      background: "#ffffff",
      usage: "non-text",
      fontSize: 16,
    })
    assert.equal(state.report.checks.length, 1)
    assert.equal(state.report.operative.required, 3)
    assert.equal(state.report.operative.passes, true, "3.03:1 clears 3:1")
    assert.equal(state.report.large, false)
  })
})

/* ------------------------------------------------------------------ the component -------------- */

test("without a document it renders its unmeasured state rather than a number", () => {
  // Server rendering, and the first paint before the layout effect. Printing a provisional ratio
  // here would be a number the reader has no reason to distrust.
  const view = render(ColorContrast, { foreground: "#000000", background: "#ffffff" })
  const text = JSON.stringify(view.tree)
  assert.match(text, /Measuring/)
  assert.doesNotMatch(text, /:1/, "no ratio until something has been measured")
  view.unmount()
})

test("the specimen carries the colours under test and is hidden from the accessibility tree", () => {
  const view = render(ColorContrast, {
    foreground: "var(--fg)",
    background: "var(--bg)",
    fontSize: "18pt",
    fontWeight: 700,
  })
  const swatch = walk(view.tree).find((n) => n.props?.style?.color !== undefined)
  assert.ok(swatch, "the pair is applied somewhere")
  assert.equal(swatch.props.style.color, "var(--fg)")
  assert.equal(swatch.props.style.background, "var(--bg)")
  assert.equal(swatch.props.style.fontSize, "18pt")
  assert.equal(swatch.props.style.fontWeight, 700)
  // It is a specimen, not content, and the verdict is already written out in words.
  assert.equal(swatch.props["aria-hidden"], "true")
  view.unmount()
})

test("the specimen can be turned off, and the headline stays", () => {
  const view = render(ColorContrast, {
    foreground: "#000000",
    background: "#ffffff",
    sample: false,
  })
  const nodes = walk(view.tree)
  assert.equal(
    nodes.some((n) => n.props?.style?.color !== undefined),
    false,
  )
  assert.ok(nodes.some((n) => n.props?.role === "status"))
  view.unmount()
})

test("the headline is a live region, so a dragged slider is heard and not only seen", () => {
  const view = render(ColorContrast, { foreground: "#000000", background: "#ffffff" })
  const status = walk(view.tree).filter((n) => n.props?.role === "status")
  assert.equal(status.length, 1)
  view.unmount()
})

test("the icons are decorative — nothing here is said in shape or colour alone", () => {
  // The one component that must not rely on colour to tell the reader something.
  const view = render(ColorContrast, { foreground: "#000000", background: "#ffffff" })
  for (const svg of byTag(walk(view.tree), "svg")) {
    assert.equal(svg.props["aria-hidden"], "true")
  }
  view.unmount()
})

test("onReport fires once per measurement, so a parent re-render cannot make it a loop", () => {
  // The callback is guarded on the value last handed over rather than on a dependency array: a
  // parent that re-renders in response to it would otherwise re-fire it for the same measurement.
  const seen = []
  const view = render(ColorContrast, {
    foreground: "#000000",
    background: "#ffffff",
    onReport: (state) => seen.push(state.status),
  })
  assert.equal(seen.length, 1)
  view.rerender()
  assert.equal(seen.length, 1, "nothing was re-measured, so nothing was reported again")
  view.unmount()
})

test("the headline names what the number is, rather than reading as a bare figure", () => {
  const view = render(ColorContrast, { foreground: "#000000", background: "#ffffff" })
  const status = walk(view.tree).find((n) => n.props?.role === "status")
  const inside = JSON.stringify(status)
  assert.match(inside, /Contrast ratio/)
  view.unmount()
})

test("the caller's className and div props survive", () => {
  const view = render(ColorContrast, {
    foreground: "#000000",
    background: "#ffffff",
    className: "mt-4",
    "data-testid": "contrast",
  })
  assert.match(view.tree.props.className, /mt-4/)
  assert.equal(view.tree.props["data-testid"], "contrast")
  view.unmount()
})
