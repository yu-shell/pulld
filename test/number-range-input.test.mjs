// number-range-input holds two boxes that are one field, and every failure mode below is invisible
// to someone reading the source with a mouse in one hand.
//
// The typing: a pair of numbers is *inconsistent for most of the time it is being edited*.
// Replacing 50 with 500 in the lower box passes through 5, and at 5 the range is crossed. A field
// that judges on change is therefore red through ordinary use, one that corrects on change moves
// the digits out from under the caret, and a live query fired on change goes out for the 5.
//
// The parsing: `Number` is far more generous than a price box. It answers 0 for the empty string —
// which turns "cleared the filter" into "zero and up" — and it accepts 1e3, Infinity and 0x10.
// Group separators are worse than generous: strip the character wherever it falls and `1,5` in a
// dot-decimal field becomes 15, a bound wrong by a factor of ten with nothing on screen to say so.
//
// The pair: equal ends are a range (exactly 500) and only min > max is crossed, so the `>=` that
// reads as equivalent rejects every exact-value filter. One-sided ranges are legitimate, so an
// empty box has to mean open rather than zero.
//
// The announcement: two inputs are one field, and the error has to reach a screen reader from
// whichever of the two the reader is sitting in.
//
// These run against the real source through the harness, so they fail when the component changes
// rather than when a copy of it does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { NumberRangeInput, parseBound, checkRange, summarise } = loadComponent(
  join(ROOT, "registry", "ui", "number-range-input.tsx")
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const show = (props = {}) => {
  const changes = []
  const commits = []
  let base = { label: "Price", debounceMs: 5, ...props }
  const withSpies = () => ({
    ...base,
    onValueChange: (value, text) => changes.push({ value, text }),
    onCommit: (verdict) => commits.push(verdict),
  })
  const instance = render(NumberRangeInput, withSpies())

  const read = () => {
    const nodes = walk(instance.tree)
    const inputs = byTag(nodes, "input")
    const pick = (suffix) => inputs.find((n) => String(n.props.id).endsWith(suffix))
    const status = nodes.find((n) => n.type === "p" && String(n.props?.id).endsWith("-status"))
    return {
      min: pick("-min"),
      max: pick("-max"),
      inputs,
      fieldset: nodes.find((n) => n.type === "fieldset"),
      legend: nodes.find((n) => n.type === "legend"),
      status,
      /** What the status line says, as one string. */
      said: status ? String(status.props.children ?? "") : null,
      /** Whether the status reads as an error rather than a summary. */
      errored: status ? /text-destructive/.test(status.props.className) : null,
      /** The decorative mark between the boxes. */
      separator: nodes.find(
        (n) => n.type === "span" && n.props?.["aria-hidden"] === "true"
      ),
    }
  }

  return {
    read,
    changes,
    commits,
    /** The text in each box, which is what the component actually stores. */
    text: () => ({ min: read().min.props.value, max: read().max.props.value }),
    type(side, value) {
      read()[side].props.onChange({ target: { value } })
      instance.rerender()
    },
    blur(side = "min", relatedTarget = null) {
      read()[side].props.onBlur({ relatedTarget })
      instance.rerender()
    },
    press(side, key) {
      read()[side].props.onKeyDown({ key, defaultPrevented: false })
      instance.rerender()
    },
    /** Lets the debounce elapse and settles the tree on the verdict it produced. */
    async settle() {
      await sleep(30)
      instance.update(withSpies())
    },
    update(next) {
      base = { ...base, ...next }
      instance.update(withSpies())
    },
    /** The stand-in nodes the component was handed; the fieldset is the only ref it leaves null. */
    nodes: () => instance.nodes,
    unmount: () => instance.unmount(),
  }
}

// --- parsing ---------------------------------------------------------------

test("an empty box is an open end, not zero", () => {
  assert.equal(parseBound(""), null, "empty must not be 0 — Number('') is, and that is the bug")
  assert.equal(parseBound("   "), null, "whitespace only is still empty")
  assert.equal(parseBound("0"), 0, "a typed zero is a real bound that happens to be zero")

  // And the same distinction has to survive into the value the parent is handed.
  const field = show()
  field.type("min", "0")
  assert.equal(field.changes.at(-1).value.min, 0)
  field.type("min", "")
  assert.equal(field.changes.at(-1).value.min, null, "clearing the box asked for zero and up")
})

test("a half-typed decimal stays typeable", () => {
  // Every one of these is a real intermediate state on the way to 1.5, and a grammar that
  // refuses them is a field you cannot put a decimal into.
  assert.equal(parseBound("1."), 1)
  assert.equal(parseBound(".5"), 0.5)
  assert.equal(parseBound("0."), 0)
  assert.equal(parseBound("1.5"), 1.5)
  assert.equal(parseBound("-0.5"), -0.5)
  // Both signs, since a pasted figure can carry either and a lone one is still not a number.
  assert.equal(parseBound("+5"), 5)
  assert.equal(parseBound("-5"), -5)
  assert.equal(parseBound("+1.5"), 1.5)
})

test("what Number accepts and a price box should not", () => {
  for (const text of ["1e3", "Infinity", "-Infinity", "0x10", "0b11", "-", "+", ".", "--5", "1.2.3", "12abc", "abc", "1 2 3 4"]) {
    assert.ok(
      Number.isNaN(parseBound(text)),
      `${JSON.stringify(text)} should be reported as not a number, got ${parseBound(text)}`
    )
  }
  // The point of the previous assertion: Number says yes to four of them.
  assert.equal(Number("1e3"), 1000)
  assert.equal(Number("0x10"), 16)
  // A figure too long to be a float is not silently Infinity either.
  assert.ok(Number.isNaN(parseBound("9".repeat(400))))
})

test("group separators are accepted only where a group separator can go", () => {
  // Correct grouping, both conventions, same number.
  assert.equal(parseBound("1,234.5", "."), 1234.5)
  assert.equal(parseBound("1.234,5", ","), 1234.5)
  assert.equal(parseBound("1,234,567", "."), 1234567)
  assert.equal(parseBound("1.234.567", ","), 1234567)
  // Intl's own group spaces, including the narrow no-break space Node writes for fr-FR.
  assert.equal(parseBound("1 234,5", ","), 1234.5)
  assert.equal(parseBound("1 234,5", ","), 1234.5)
  assert.equal(parseBound("1 234,5", ","), 1234.5)
  assert.equal(parseBound("1_000", "."), 1000)

  // The factor-of-ten trap: a comma one and a half in a dot-decimal field. Stripping the comma
  // wherever it appears answers 15, which is the whole reason the position is checked.
  assert.ok(Number.isNaN(parseBound("1,5", ".")), "1,5 must be refused, not read as 15")
  assert.ok(Number.isNaN(parseBound("1.5", ",")), "1.5 must be refused in a comma-decimal field")
  // Groups of the wrong size are refused in either direction.
  assert.ok(Number.isNaN(parseBound("1,23", ".")))
  assert.ok(Number.isNaN(parseBound("1,2345", ".")))
  assert.ok(Number.isNaN(parseBound("1234,567,89", ".")))
  // The leading group is one to three digits, never four: "1234,567" is not how anyone writes
  // 1234567, and accepting it is accepting that the separator meant nothing.
  assert.ok(Number.isNaN(parseBound("1234,567", ".")))
  assert.ok(Number.isNaN(parseBound("1234.567", ",")))
  assert.equal(parseBound("123,456", "."), 123456, "three leading digits is the most there can be")
  // Nothing is grouped after the decimal point in any convention.
  assert.ok(Number.isNaN(parseBound("1.234,567", ".")))

  // The same text means two different numbers under the two conventions, which is exactly why
  // the separator is a parameter and never inferred.
  assert.equal(parseBound("1.234", "."), 1.234)
  assert.equal(parseBound("1.234", ","), 1234)
})

// --- the pair --------------------------------------------------------------

test("equal ends are a range, not a mistake", () => {
  assert.deepEqual(checkRange({ min: "500", max: "500" }).issues, [], "exactly 500 is a range")
  assert.deepEqual(
    checkRange({ min: "500", max: "50" }).issues,
    [{ scope: "pair", code: "crossed" }]
  )
  // Negatives compare as numbers, not as text or by magnitude.
  assert.deepEqual(checkRange({ min: "-10", max: "-5" }).issues, [], "-10 to -5 is in order")
  assert.deepEqual(
    checkRange({ min: "-5", max: "-10" }).issues,
    [{ scope: "pair", code: "crossed" }]
  )
  assert.deepEqual(checkRange({ min: "-5", max: "5" }).issues, [])
  // Text compare would put 9 after 10 and magnitude would put -10 after -5.
  assert.deepEqual(checkRange({ min: "9", max: "10" }).issues, [])
})

test("a one-sided range is complete, and requireBoth is what turns that off", () => {
  for (const text of [{ min: "1000", max: "" }, { min: "", max: "500" }, { min: "", max: "" }]) {
    assert.deepEqual(checkRange(text).issues, [], `${JSON.stringify(text)} should be usable`)
  }
  assert.deepEqual(checkRange({ min: "1000", max: "" }).value, { min: 1000, max: null })

  assert.deepEqual(
    checkRange({ min: "1000", max: "" }, { requireBoth: true }).issues,
    [{ scope: "max", code: "missing" }]
  )
  assert.deepEqual(
    checkRange({ min: "", max: "" }, { requireBoth: true }).issues,
    [{ scope: "min", code: "missing" }, { scope: "max", code: "missing" }]
  )
  // Garbage is not missing — it is present and wrong, and saying "enter both ends" about it
  // sends the reader looking for an empty box there isn't one of.
  assert.deepEqual(
    checkRange({ min: "abc", max: "5" }, { requireBoth: true }).issues,
    [{ scope: "min", code: "not-a-number" }]
  )
})

test("the outer limits are checked per end, and reported against the limit that was broken", () => {
  const bounds = { min: 0, max: 10000 }
  assert.deepEqual(
    checkRange({ min: "-5", max: "500" }, { bounds }).issues,
    [{ scope: "min", code: "below-allowed", allowed: 0 }]
  )
  assert.deepEqual(
    checkRange({ min: "5", max: "99999" }, { bounds }).issues,
    [{ scope: "max", code: "above-allowed", allowed: 10000 }]
  )
  // A limit of zero is a limit, not an absent one.
  assert.deepEqual(checkRange({ min: "0", max: "0" }, { bounds }).issues, [])
  // Both limits are inclusive: the end of the catalogue is a value you can ask for.
  assert.deepEqual(checkRange({ min: "0", max: "10000" }, { bounds }).issues, [])
  assert.equal(checkRange({ min: "0", max: "10000" }, { bounds }).ok, true)
  // Only one side bounded.
  assert.deepEqual(checkRange({ min: "-5", max: "" }, { bounds: { max: 10 } }).issues, [])
})

test("ok is false for anything with an issue in it", () => {
  assert.equal(checkRange({ min: "500", max: "50" }).ok, false)
  assert.equal(checkRange({ min: "abc", max: "" }).ok, false)
  assert.equal(checkRange({ min: "", max: "" }, { requireBoth: true }).ok, false)
  assert.equal(checkRange({ min: "50", max: "500" }).ok, true)
  assert.equal(checkRange({ min: "", max: "" }).ok, true)
})

test("each end's own problem is reported ahead of the pair's", () => {
  // Text that is not a number cannot be compared to anything, so there is no crossing to report
  // on top of it.
  const verdict = checkRange({ min: "abc", max: "5" })
  assert.deepEqual(verdict.issues, [{ scope: "min", code: "not-a-number" }])
  assert.deepEqual(verdict.value, { min: null, max: 5 })

  // Out of limits *and* crossed: the limit comes first because it is the more specific fix.
  const both = checkRange({ min: "99999", max: "500" }, { bounds: { max: 10000 } })
  assert.deepEqual(both.issues, [
    { scope: "min", code: "above-allowed", allowed: 10000 },
    { scope: "pair", code: "crossed" },
  ])
  assert.equal(both.issues[0].scope, "min", "the status line shows issues[0]")
})

// --- typing ----------------------------------------------------------------

test("nothing is judged while the typing is still going on", async () => {
  const field = show({ defaultValue: { min: 50, max: 500 } })
  assert.equal(field.read().said, "50 to 500", "a prefilled field opens settled")

  // Narrowing the upper end from 500 to 60, one key at a time. The middle of that is "6", where
  // the range reads 50 to 6 and is crossed — and the range it is on its way to is perfectly
  // fine. This is the sequence that catches every version of this component that judges on
  // change (red through ordinary typing) or corrects on change (the 6 is moved to the other box
  // and the 0 that was coming lands nowhere).
  for (const step of ["", "6", "60"]) {
    field.type("max", step)
    assert.equal(field.text().max, step, `the text was rewritten at ${JSON.stringify(step)}`)
    assert.equal(field.read().said, "", `a verdict leaked at ${JSON.stringify(step)}`)
    assert.equal(field.read().min.props["aria-invalid"], undefined)
    assert.equal(field.read().max.props["aria-invalid"], undefined)
  }

  await field.settle()
  assert.equal(field.read().said, "50 to 60", "the range it arrived at is the one judged")
  assert.equal(field.read().errored, false)
  field.unmount()

  // And the verdict does land when the typing really does leave it crossed.
  const bad = show({ defaultValue: { min: 50, max: 500 } })
  bad.type("min", "900")
  await bad.settle()
  assert.equal(bad.read().said, "The first number must not be greater than the second.")
  assert.equal(bad.read().errored, true)
  bad.unmount()
})

test("a stale error stops marking the boxes the moment it is being fixed", async () => {
  // The other half of "nothing is judged while typing", and the half a clean starting state
  // cannot catch: once a verdict *has* gone red, the first keystroke toward fixing it makes that
  // verdict stale. Leaving the border red while the status line has already gone blank is the
  // worst of the three states — a red field with no stated reason.
  const field = show()
  field.type("min", "500")
  field.type("max", "50")
  await field.settle()
  assert.equal(field.read().min.props["aria-invalid"], true)
  assert.equal(field.read().max.props["aria-invalid"], true)
  assert.match(field.read().said, /must not be greater/)

  field.type("max", "500")
  assert.equal(field.read().said, "", "the stale sentence stayed up")
  assert.equal(field.read().min.props["aria-invalid"], undefined, "a red box with no reason")
  assert.equal(field.read().max.props["aria-invalid"], undefined, "a red box with no reason")

  await field.settle()
  assert.equal(field.read().said, "500 to 500")
  field.unmount()
})

test("the live query is not fired for the number on the way", async () => {
  const field = show()
  for (const step of ["5", "50", "500"]) field.type("min", step)
  // onValueChange is the immediate one and fires per keystroke, by design.
  assert.deepEqual(
    field.changes.map((c) => c.value.min),
    [5, 50, 500]
  )
  assert.equal(field.commits.length, 0, "onCommit must not fire before the typing stops")

  await field.settle()
  assert.equal(field.commits.length, 1, "and exactly once after it does")
  assert.deepEqual(field.commits[0].value, { min: 500, max: null })
  assert.equal(field.commits[0].ok, true)
  field.unmount()
})

test("text that comes back to what is already settled does not fire a second query", async () => {
  const field = show({ defaultValue: { min: 50, max: 500 } })
  field.type("min", "50x")
  field.type("min", "50")
  await field.settle()
  assert.equal(field.commits.length, 0, "a character typed and deleted again is not a new range")
  field.unmount()
})

test("Enter settles without waiting, because someone who pressed it has finished", () => {
  const field = show()
  field.type("min", "50")
  assert.equal(field.commits.length, 0)
  field.press("min", "Enter")
  assert.equal(field.commits.length, 1)
  assert.deepEqual(field.commits[0].value, { min: 50, max: null })
  assert.equal(field.read().said, "50 and up")
  field.unmount()
})

test("the delay is debounceMs rather than a hardcoded one", () => {
  const delays = []
  const real = globalThis.setTimeout
  globalThis.setTimeout = (fn, delay, ...rest) => {
    delays.push(delay)
    return real(fn, delay, ...rest)
  }
  let field
  try {
    field = show({ debounceMs: 250 })
    field.type("min", "5")
  } finally {
    globalThis.setTimeout = real
  }
  assert.ok(delays.includes(250), `expected a 250ms timer, saw ${delays.join(", ")}`)
  // Clears the 250ms timers, which would otherwise fire into whichever test is running by then.
  field.unmount()
})

// --- crossed ends ----------------------------------------------------------

test("crossed ends are reported and nothing is moved", async () => {
  const field = show()
  field.type("min", "500")
  field.type("max", "50")
  await field.settle()
  assert.equal(field.read().said, "The first number must not be greater than the second.")
  // The harm the default avoids: a silent swap takes the 500 the reader just typed and puts it in
  // the other box.
  assert.deepEqual(field.text(), { min: "500", max: "50" }, "the typed digits were moved")
  field.unmount()
})

test("crossBehavior=swap waits for focus to leave the field, then says that it swapped", async () => {
  const field = show({ crossBehavior: "swap" })
  field.type("min", "500")
  field.type("max", "50")
  // Still mid-field: nothing may move while the reader is in it.
  assert.deepEqual(field.text(), { min: "500", max: "50" })
  await field.settle()
  assert.deepEqual(field.text(), { min: "500", max: "50" }, "the pause is not permission to swap")

  field.blur("max")
  assert.deepEqual(field.text(), { min: "50", max: "500" })
  assert.equal(field.read().said, "The two numbers were swapped. 50 to 500")
  assert.equal(field.read().errored, false, "a swapped range is no longer an error")
  // The parent hears about it, because the value it was holding is now the other way round.
  assert.deepEqual(field.changes.at(-1).value, { min: 50, max: 500 })
  field.unmount()
})

test("a swap announcement does not outlive the range it was about", async () => {
  const field = show({ crossBehavior: "swap" })
  field.type("min", "500")
  field.type("max", "50")
  field.blur("max")
  assert.match(field.read().said, /swapped/)
  field.type("min", "10")
  await field.settle()
  assert.equal(field.read().said, "10 to 500", "the notice stayed on a range nobody swapped")
  field.unmount()
})

test("moving from one box to the other does not settle the field", async () => {
  const field = show()
  field.type("min", "500")

  const [fieldset, ...rest] = field.nodes()
  assert.equal(rest.length, 0, "the fieldset should be the only node the component holds")
  const other = { name: "the max input" }
  fieldset.contains = (node) => node === other

  // Tabbing from the lower box to fill in the upper one is movement inside one field. Settling
  // here would flash "the first number must not be greater than the second" about a range that
  // is one keystroke from being right.
  field.blur("min", other)
  assert.equal(field.commits.length, 0, "a move inside the field settled it")
  assert.equal(field.read().said, "")

  // Leaving the field altogether does settle it.
  field.blur("max", { name: "something else on the page" })
  assert.equal(field.commits.length, 1)
  assert.equal(field.read().said, "500 and up")
  field.unmount()
})

// --- two boxes, one field --------------------------------------------------

test("the status is attached to both inputs, whichever one is at fault", async () => {
  const field = show()
  field.type("min", "500")
  field.type("max", "50")
  await field.settle()

  const { min, max, status } = field.read()
  assert.equal(typeof status.props.id, "string")
  // Attached to both: the reader may be in either box when the error appears, and an input that
  // describes nothing tells them nothing is wrong.
  assert.equal(min.props["aria-describedby"], status.props.id)
  assert.equal(max.props["aria-describedby"], status.props.id)
  assert.equal(status.props["aria-live"], "polite")
  field.unmount()
})

test("which box is marked invalid follows the scope of the problem", async () => {
  // A crossed pair: neither number is wrong on its own, so both are marked.
  const crossed = show()
  crossed.type("min", "500")
  crossed.type("max", "50")
  await crossed.settle()
  assert.equal(crossed.read().min.props["aria-invalid"], true)
  assert.equal(crossed.read().max.props["aria-invalid"], true)
  crossed.unmount()

  // A bad number: only that box.
  const bad = show()
  bad.type("max", "abc")
  await bad.settle()
  assert.equal(bad.read().max.props["aria-invalid"], true)
  assert.equal(bad.read().min.props["aria-invalid"], undefined, "the good box was marked too")
  assert.equal(bad.read().said, "Enter a number.")
  bad.unmount()
})

test("both boxes are marked when both are wrong, not just the one the status is about", async () => {
  // The status line can only carry one sentence, but aria-invalid is per box: marking only the
  // box whose message won leaves a screen reader telling the reader the other one is fine while
  // it holds "xyz".
  const field = show()
  field.type("min", "abc")
  field.type("max", "xyz")
  await field.settle()

  assert.deepEqual(
    field.commits.at(-1).issues.map((i) => i.scope),
    ["min", "max"]
  )
  assert.equal(field.read().min.props["aria-invalid"], true)
  assert.equal(field.read().max.props["aria-invalid"], true, "the second bad box was left unmarked")
  assert.equal(field.read().said, "Enter a number.", "one sentence at a time on screen")
  field.unmount()
})

test("a swap that leaves the range still wrong says both things", async () => {
  // Swapping fixes the order and can leave an end out of limits, and the reader has to hear both
  // — otherwise the number they typed has moved box for no stated reason.
  const field = show({ crossBehavior: "swap", bounds: { max: 100 } })
  field.type("min", "500")
  field.type("max", "50")
  field.blur("max")
  assert.deepEqual(field.text(), { min: "50", max: "500" })
  assert.equal(field.read().said, "The two numbers were swapped. Enter 100 or less.")
  assert.equal(field.read().max.props["aria-invalid"], true)
  field.unmount()
})

test("the numeric boxes do not let a phone keyboard rewrite the figure", () => {
  const field = show()
  for (const box of field.read().inputs) {
    assert.equal(box.props.spellCheck, false)
    assert.equal(box.props.autoCapitalize, "off")
    assert.equal(box.props.autoCorrect, "off")
    assert.equal(box.props.autoComplete, "off")
  }
  field.unmount()

  // Defaults, not fixed values.
  const opted = show({ autoComplete: "on" })
  assert.equal(opted.read().min.props.autoComplete, "on")
  opted.unmount()
})

test("the field is a fieldset named by its legend, and the mark between is decorative", () => {
  const field = show({ label: "Price range" })
  const { fieldset, legend, separator, min, max } = field.read()
  assert.ok(fieldset, "two number boxes side by side need to be one group")
  assert.equal(legend.props.children, "Price range")
  assert.equal(/sr-only/.test(legend.props.className), false)
  // Each box still needs its own name — the legend says "of what", not "which end".
  assert.equal(min.props["aria-label"], "Minimum")
  assert.equal(max.props["aria-label"], "Maximum")
  assert.equal(separator.props["aria-hidden"], "true")

  field.update({ hideLabel: true })
  assert.ok(/sr-only/.test(field.read().legend.props.className), "hideLabel must keep the legend")
  assert.equal(field.read().legend.props.children, "Price range")
  field.unmount()
})

test("the boxes are text inputs with a numeric keypad, not number inputs", () => {
  const field = show()
  for (const box of field.read().inputs) {
    // type=number discards text it cannot parse — `input.value` is "" for "12e" — so the
    // reader's mistake would vanish instead of being explained, and a scroll gesture over a
    // focused number input steps its value.
    assert.equal(box.props.type, "text")
    assert.equal(box.props.inputMode, "decimal", "a phone should still get the numeric keypad")
  }
  field.unmount()
})

test("the boxes carry the names a form posts them under, and only when asked", () => {
  const plain = show()
  assert.equal(plain.read().min.props.name, undefined, "no invented naming convention")
  plain.unmount()

  const named = show({ nameMin: "minPrice", nameMax: "maxPrice" })
  assert.equal(named.read().min.props.name, "minPrice")
  assert.equal(named.read().max.props.name, "maxPrice")
  named.unmount()
})

// --- controlled ------------------------------------------------------------

test("a controlled parent does not rewrite text that already means its number", async () => {
  const field = show({ value: { min: null, max: null } })

  // 07 parses to 7 and 1. parses to 1. Writing String(value) back would rewrite both under the
  // caret, which is what makes the obvious controlled number field impossible to type in.
  field.type("min", "07")
  field.update({ value: { min: 7, max: null } })
  assert.equal(field.text().min, "07", "the leading zero was rewritten away")

  field.type("max", "1.")
  field.update({ value: { min: 7, max: 1 } })
  assert.equal(field.text().max, "1.", "the decimal point was eaten")
  field.unmount()
})

test("a controlled parent that answers a render late does not lose the keystroke", () => {
  // What a filter in the URL does: onValueChange triggers a router push, and the new value comes
  // back on a later pass. For that pass the field holds "9" while value.min is still null, and a
  // component that reconciles on every render reads that as disagreement and wipes it — so every
  // keystroke is wiped and the field cannot be typed in at all.
  const field = show({ value: { min: null, max: null } })
  field.type("min", "9")
  assert.equal(field.text().min, "9")

  // Rendered again with the value still behind.
  field.update({})
  assert.equal(field.text().min, "9", "the keystroke was wiped while the parent caught up")

  // And then it catches up, which must not disturb the text either.
  field.update({ value: { min: 9, max: null } })
  assert.equal(field.text().min, "9")
  field.unmount()
})

test("a controlled parent replacing the range does replace the text", () => {
  const field = show({ value: { min: 50, max: 500 } })
  assert.deepEqual(field.text(), { min: "50", max: "500" })
  // What a preset button or a reset does.
  field.update({ value: { min: 1000, max: null } })
  assert.deepEqual(field.text(), { min: "1000", max: "" }, "a programmatic change must land")
  field.unmount()
})

test("a controlled parent clearing the range clears the text", () => {
  // The other half of the contract: `value` changing is what replaces the text. Here it changes
  // back to empty, which is what a "clear filters" button does, and both boxes have to follow.
  const field = show({ value: { min: 50, max: 500 } })
  field.type("min", "70")
  field.update({ value: { min: null, max: null } })
  assert.deepEqual(field.text(), { min: "", max: "" }, "clearing the range left text behind")
  field.unmount()
})

test("text the parent cannot represent is left alone rather than wiped", async () => {
  // "abc" parses to no usable number, so the parent is handed null and has nothing to send back.
  // Wiping the text would take away the very thing the error message is about, leaving an empty
  // box next to "Enter a number."
  const field = show({ value: { min: null, max: null } })
  field.type("min", "abc")
  field.update({})
  assert.equal(field.text().min, "abc")
  await field.settle()
  assert.equal(field.read().said, "Enter a number.")
  assert.equal(field.text().min, "abc", "the text the error is about disappeared")
  field.unmount()
})

// --- wording ---------------------------------------------------------------

test("the summary is built from the typed text, not from a reformatted number", () => {
  // Round-tripping through Number would print 1,000 as 1000 and 07 as 7, so the characters read
  // aloud would stop being the characters on screen.
  assert.equal(summarise({ min: "1,000", max: "2,000" }), "1,000 to 2,000")
  assert.equal(summarise({ min: "07", max: "" }), "07 and up")
  assert.equal(summarise({ min: "", max: "500" }), "Up to 500")
  assert.equal(summarise({ min: "", max: "" }), "", "an unset range has nothing to announce")
  assert.equal(summarise({ min: "  ", max: " " }), "")
})

test("every sentence can be replaced", async () => {
  const field = show({
    messages: {
      crossed: "下限が上限を超えています。",
      between: "{min} 〜 {max}",
    },
  })
  field.type("min", "500")
  field.type("max", "50")
  await field.settle()
  assert.equal(field.read().said, "下限が上限を超えています。")

  field.type("max", "5000")
  await field.settle()
  assert.equal(field.read().said, "500 〜 5000", "a partial override must keep the other defaults")
  field.unmount()
})

test("the status line shows the first issue, not whichever is last", async () => {
  // This range is both out of limits and crossed. The limit is the more specific fix and comes
  // first in `issues`, and it is the one the reader has to see — being told the ends are the
  // wrong way round sends them to reorder two numbers one of which cannot be used at all.
  const field = show({ bounds: { min: 0, max: 10000 } })
  field.type("min", "99999")
  field.type("max", "500")
  await field.settle()

  const verdict = field.commits.at(-1)
  assert.deepEqual(
    verdict.issues.map((i) => i.code),
    ["above-allowed", "crossed"]
  )
  assert.equal(field.read().said, "Enter 10000 or less.")
  field.unmount()
})

test("the limit that was broken is substituted into the sentence", async () => {
  const field = show({ bounds: { min: 0, max: 10000 } })
  field.type("min", "-5")
  await field.settle()
  assert.equal(field.read().said, "Enter 0 or more.")
  field.type("min", "20000")
  await field.settle()
  assert.equal(field.read().said, "Enter 10000 or less.")
  field.unmount()
})

// --- states ----------------------------------------------------------------

test("a disabled field disables both boxes through the fieldset, and swaps nothing", async () => {
  const field = show({ disabled: true, crossBehavior: "swap", defaultValue: { min: 500, max: 50 } })
  assert.equal(field.read().fieldset.props.disabled, true)
  field.blur("max")
  assert.deepEqual(field.text(), { min: "500", max: "50" }, "a disabled field swapped its values")
  field.unmount()

  const ro = show({ readOnly: true, crossBehavior: "swap", defaultValue: { min: 500, max: 50 } })
  assert.equal(ro.read().min.props.readOnly, true)
  ro.blur("max")
  assert.deepEqual(ro.text(), { min: "500", max: "50" }, "a read-only field swapped its values")
  ro.unmount()
})

test("showStatus=false leaves the inputs describing nothing rather than a missing id", () => {
  const field = show({ showStatus: false })
  assert.equal(field.read().status, undefined)
  assert.equal(field.read().min.props["aria-describedby"], undefined)
  field.unmount()
})

test("a caller's own aria-describedby is kept alongside the status", () => {
  const field = show({ "aria-describedby": "my-hint" })
  const { min, status } = field.read()
  assert.equal(min.props["aria-describedby"], `my-hint ${status.props.id}`)
  field.unmount()
})

test("the separator used for parsing is the one the field was given", async () => {
  const field = show({ decimalSeparator: "," })
  field.type("min", "1.234,5")
  assert.equal(field.changes.at(-1).value.min, 1234.5)
  field.type("max", "1.5")
  await field.settle()
  assert.equal(field.read().said, "Enter a number.", "1.5 is not a number in a comma field")
  field.unmount()
})
