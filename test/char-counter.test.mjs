// The naive character counter is `value.length`, and it is wrong for every writer whose text is not
// plain Latin — while looking perfectly correct to whoever wrote it. So the cases below are written
// to fail against the versions that look right:
//
//   - counting UTF-16 code units, so one emoji costs 2 and deleting it returns 4,
//   - counting code points but calling them characters, so a flag costs 2 and a skin tone 2,
//   - slicing a string to length, which cuts a surrogate pair in half,
//   - shipping `maxLength` on the field, which discards the tail of a paste with no event,
//   - putting the count itself in an `aria-live` region, so every keystroke is an interruption,
//   - announcing on mount, so a field opened with existing text talks before anything is typed,
//   - counting a textarea's `\n` when the wire carries `\r\n`.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  countChars,
  truncateToCount,
  charCountStatus,
  charCountMessage,
  defaultWarnAtRemaining,
  defaultCharCounterLabels,
  useCharCounter,
  CharCounter,
} = loadComponent(join(ROOT, "registry", "ui", "char-counter.tsx"))

// One glyph each, and every one of them a different kind of trap.
const THUMB = "👍" // non-BMP: 1 grapheme, 1 code point, 2 UTF-16 units, 4 bytes
const THUMB_TONE = "👍🏽" // + a skin-tone modifier: 1 grapheme, 2 code points, 4 units, 8 bytes
const FLAG = "🇯🇵" // two regional indicators: 1 grapheme, 2 code points, 4 units, 8 bytes
const FAMILY = "👨‍👩‍👧" // ZWJ sequence: 1 grapheme, 5 code points, 8 units, 18 bytes
const E_ACUTE = "é" // e + combining acute: 1 grapheme, 2 code points, 2 units, 3 bytes
const KANJI = "日" // BMP but not ASCII: 1 grapheme, 1 code point, 1 unit, 3 bytes

// --- counting ---------------------------------------------------------------------------------

test("a grapheme is what a person would call one character", () => {
  for (const glyph of [THUMB, THUMB_TONE, FLAG, FAMILY, E_ACUTE, KANJI]) {
    assert.equal(countChars(glyph, "grapheme"), 1, `${glyph} should count as one character`)
  }
})

test("the naive count is the one this component exists to replace", () => {
  // Each of these is what `value.length` would have reported for a single glyph.
  assert.equal(countChars(THUMB, "utf16"), 2)
  assert.equal(countChars(THUMB_TONE, "utf16"), 4)
  assert.equal(countChars(FLAG, "utf16"), 4)
  assert.equal(countChars(FAMILY, "utf16"), 8)
  assert.equal(countChars(KANJI, "utf16"), 1)
})

test("code points are the database's unit, and are not graphemes either", () => {
  assert.equal(countChars(THUMB, "codePoint"), 1)
  assert.equal(countChars(THUMB_TONE, "codePoint"), 2)
  assert.equal(countChars(FLAG, "codePoint"), 2)
  assert.equal(countChars(FAMILY, "codePoint"), 5)
  assert.equal(countChars(E_ACUTE, "codePoint"), 2)
})

test("bytes are the unit a byte-bounded column enforces", () => {
  assert.equal(countChars("abc", "utf8"), 3)
  assert.equal(countChars(KANJI, "utf8"), 3)
  assert.equal(countChars(THUMB, "utf8"), 4)
  assert.equal(countChars(FLAG, "utf8"), 8)
  assert.equal(countChars(E_ACUTE, "utf8"), 3)
})

test("an unpaired surrogate counts as the one unit it is, not as the character after it", () => {
  // A truncated paste can leave a lone high surrogate behind. A code-point scanner that assumes the
  // next unit completes the pair would swallow the "a" and report 1 for a two-element string.
  const lone = "\ud83d" + "a"
  assert.equal(countChars(lone, "codePoint"), 2)
  assert.equal(countChars(lone, "utf16"), 2)
})

test("the empty string is zero in every unit", () => {
  for (const unit of ["grapheme", "codePoint", "utf16", "utf8"]) {
    assert.equal(countChars("", unit), 0)
  }
})

test("grapheme is the default unit", () => {
  assert.equal(countChars(FLAG), 1)
  assert.equal(countChars(FLAG), countChars(FLAG, "grapheme"))
})

test("crlfNewlines counts a line break the way a submitted form does", () => {
  const threeLines = "a\nb\nc"
  assert.equal(countChars(threeLines, "utf16"), 5)
  assert.equal(countChars(threeLines, "utf16", { crlfNewlines: true }), 7)
  assert.equal(countChars(threeLines, "utf8", { crlfNewlines: true }), 7)
  assert.equal(countChars(threeLines, "codePoint", { crlfNewlines: true }), 7)
  // A CRLF is a single grapheme cluster, so the grapheme count is the one unit the option cannot
  // change — which is the right answer, since a line break is one thing to the person writing it.
  assert.equal(countChars(threeLines, "grapheme", { crlfNewlines: true }), 5)
})

test("crlfNewlines does not double an existing CRLF", () => {
  assert.equal(countChars("a\r\nb", "utf16", { crlfNewlines: true }), 4)
  assert.equal(countChars("a\rb", "utf16", { crlfNewlines: true }), 4)
})

// --- truncation -------------------------------------------------------------------------------

test("truncation lands on a character boundary, never inside one", () => {
  const text = THUMB + THUMB + THUMB
  // `text.slice(0, 3)` here would be one thumb plus half of the next.
  assert.equal(truncateToCount(text, 2, "grapheme"), THUMB + THUMB)
  // Under a UTF-16 limit each thumb costs 2, so a limit of 3 fits one and cannot fit half of another.
  assert.equal(truncateToCount(text, 3, "utf16"), THUMB)
  // Same under a byte limit: 4 bytes a thumb, so 7 fits one.
  assert.equal(truncateToCount(text, 7, "utf8"), THUMB)
})

test("truncation keeps a combining mark with the letter it belongs to", () => {
  assert.equal(truncateToCount("a" + E_ACUTE, 2, "utf16"), "a")
  assert.equal(truncateToCount("a" + E_ACUTE, 3, "utf16"), "a" + E_ACUTE)
})

test("text already inside the limit comes back untouched", () => {
  assert.equal(truncateToCount("hello", 5, "grapheme"), "hello")
  assert.equal(truncateToCount("hello", Infinity, "grapheme"), "hello")
})

test("a limit that cannot fit anything yields nothing rather than something broken", () => {
  assert.equal(truncateToCount("hello", 0), "")
  assert.equal(truncateToCount("hello", -3), "")
  assert.equal(truncateToCount("hello", Number.NaN), "")
  // One glyph wider than the whole limit: better empty than half a flag.
  assert.equal(truncateToCount(FLAG, 3, "utf16"), "")
})

test("truncation respects the CRLF weighting it was asked for", () => {
  // Under CRLF each break costs 2, so "a\nb" weighs 4 and only "a\n" fits in 3.
  assert.equal(truncateToCount("a\nb", 3, "utf16", { crlfNewlines: true }), "a\n")
  assert.equal(truncateToCount("a\nb", 3, "utf16"), "a\nb")
})

// --- bands ------------------------------------------------------------------------------------

test("the warning band is a tenth of the limit, floored at 1 and capped at 20", () => {
  assert.equal(defaultWarnAtRemaining(280), 20)
  assert.equal(defaultWarnAtRemaining(100), 10)
  assert.equal(defaultWarnAtRemaining(5), 1)
  assert.equal(defaultWarnAtRemaining(1), 1)
  assert.equal(defaultWarnAtRemaining(2000), 20)
})

test("status crosses at the boundaries and not before them", () => {
  assert.equal(charCountStatus(0, 100), "ok")
  assert.equal(charCountStatus(89, 100), "ok")
  assert.equal(charCountStatus(90, 100), "near")
  assert.equal(charCountStatus(100, 100), "near", "exactly at the limit is not over it")
  assert.equal(charCountStatus(101, 100), "over")
  assert.equal(charCountStatus(50, 100, 60), "near", "an explicit band overrides the default")
})

test("with no limit there is no band to be in", () => {
  assert.equal(charCountStatus(9999, undefined), "ok")
  assert.equal(charCountStatus(9999, Infinity), "ok")
})

test("messages count in the right direction and say one character once", () => {
  assert.equal(charCountMessage(279, 280), "1 character remaining")
  assert.equal(charCountMessage(278, 280), "2 characters remaining")
  assert.equal(charCountMessage(280, 280), "0 characters remaining")
  assert.equal(charCountMessage(281, 280), "1 character over the limit")
  assert.equal(charCountMessage(292, 280), "12 characters over the limit")
  assert.equal(charCountMessage(3, undefined), "3 characters")
})

test("labels are overridable so the counter can be translated", () => {
  const labels = { ...defaultCharCounterLabels, remaining: (n) => `のこり${n}文字` }
  assert.equal(charCountMessage(270, 280, labels), "のこり10文字")
})

// --- the rendered counter ----------------------------------------------------------------------

const textOf = (node) => {
  const parts = []
  const visit = (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return
    if (Array.isArray(child)) return child.forEach(visit)
    if (typeof child === "object") return visit(child.props?.children)
    parts.push(String(child))
  }
  visit(node)
  return parts.join("")
}

/** The element the field's aria-describedby points at. */
const described = (nodes, id) => nodes.find((n) => n.props?.id === id)
/** The polite region — the only thing here allowed to speak while someone types. */
const liveRegion = (nodes) => nodes.find((n) => n.props?.["aria-live"] === "polite")

test("the counter counts what the writer sees, not what the string is made of", () => {
  const { tree } = render(CharCounter, { id: "c", value: FLAG.repeat(5), max: 5 })
  const nodes = walk(tree)
  // The naive counter would show -15 here and refuse a value that is exactly at its limit.
  assert.equal(textOf(described(nodes, "c")), "00 characters remaining")
})

test("the visible number is hidden from assistive tech and the sentence is not", () => {
  const nodes = walk(render(CharCounter, { id: "c", value: "hello", max: 100 }).tree)
  const spans = byTag(nodes, "span")
  const visible = spans.find((n) => n.props?.["aria-hidden"] === "true")
  assert.equal(visible.props.children, 95, "shows what is left")
  const spoken = spans.find((n) => n.props?.className === "sr-only")
  assert.equal(spoken.props.children, "95 characters remaining")
})

test("the count goes negative rather than the field going quiet", () => {
  const nodes = walk(render(CharCounter, { id: "c", value: "x".repeat(292), max: 280 }).tree)
  const visible = byTag(nodes, "span").find((n) => n.props?.["aria-hidden"] === "true")
  assert.equal(visible.props.children, -12)
  assert.match(described(nodes, "c").props.className, /text-destructive/)
  assert.equal(textOf(described(nodes, "c")), "-1212 characters over the limit")
})

test("nothing in the tree carries maxLength — the limit is shown, not silently enforced", () => {
  const nodes = walk(render(CharCounter, { id: "c", value: "hi", max: 10 }).tree)
  for (const node of nodes) {
    assert.equal(node.props?.maxLength, undefined)
    assert.equal(node.props?.maxlength, undefined)
  }
})

test("the counter changes colour by band without changing what it says", () => {
  const classOf = (value, max) =>
    described(walk(render(CharCounter, { id: "c", value, max }).tree), "c").props.className
  assert.match(classOf("x".repeat(10), 100), /text-muted-foreground/)
  assert.match(classOf("x".repeat(95), 100), /text-foreground/)
  assert.match(classOf("x".repeat(101), 100), /text-destructive/)
})

test("with no max it counts up and says so", () => {
  const nodes = walk(render(CharCounter, { id: "c", value: "hello" }).tree)
  const visible = byTag(nodes, "span").find((n) => n.props?.["aria-hidden"] === "true")
  assert.equal(visible.props.children, 5)
  assert.equal(textOf(described(nodes, "c")), "55 characters")
})

test("format replaces the number without touching what is read out", () => {
  const nodes = walk(
    render(CharCounter, {
      id: "c",
      value: "hello",
      max: 100,
      format: (state) => `${state.count}/${state.max}`,
    }).tree
  )
  const visible = byTag(nodes, "span").find((n) => n.props?.["aria-hidden"] === "true")
  assert.equal(visible.props.children, "5/100")
  const spoken = byTag(nodes, "span").find((n) => n.props?.className === "sr-only")
  assert.equal(spoken.props.children, "95 characters remaining")
})

// --- announcements ------------------------------------------------------------------------------

test("the live region is silent on mount, even for a value that is already over", () => {
  const nodes = walk(render(CharCounter, { id: "c", value: "x".repeat(300), max: 280 }).tree)
  assert.equal(liveRegion(nodes).props.children, "")
})

test("typing inside a band is not announced", () => {
  const view = render(CharCounter, { id: "c", value: "x".repeat(10), max: 280 })
  for (const length of [11, 12, 13, 40]) {
    view.update({ id: "c", value: "x".repeat(length), max: 280 })
    assert.equal(liveRegion(walk(view.tree)).props.children, "")
  }
})

test("crossing into the warning band is announced once, with the count at that moment", () => {
  const view = render(CharCounter, { id: "c", value: "x".repeat(200), max: 280 })
  view.update({ id: "c", value: "x".repeat(261), max: 280 })
  assert.equal(liveRegion(walk(view.tree)).props.children, "19 characters remaining")
  // Still in the band: the region keeps the sentence it already read, and says nothing new.
  view.update({ id: "c", value: "x".repeat(270), max: 280 })
  assert.equal(liveRegion(walk(view.tree)).props.children, "19 characters remaining")
})

test("crossing the limit, and coming back under it, are both announced", () => {
  const view = render(CharCounter, { id: "c", value: "x".repeat(275), max: 280 })
  view.update({ id: "c", value: "x".repeat(285), max: 280 })
  assert.equal(liveRegion(walk(view.tree)).props.children, "5 characters over the limit")
  view.update({ id: "c", value: "x".repeat(279), max: 280 })
  assert.equal(liveRegion(walk(view.tree)).props.children, "1 character remaining")
})

test("the announcement lives outside the described element, so focus reads the count", () => {
  const view = render(CharCounter, { id: "c", value: "x".repeat(275), max: 280 })
  view.update({ id: "c", value: "x".repeat(285), max: 280 })
  const nodes = walk(view.tree)
  assert.equal(textOf(described(nodes, "c")), "-55 characters over the limit")
  assert.equal(
    walk(described(nodes, "c")).some((n) => n.props?.["aria-live"]),
    false,
    "an aria-live inside the description would be read on every focus"
  )
})

// --- the hook ------------------------------------------------------------------------------------

/** Renders a component whose only job is to hand back what the hook returned. */
function hookResult(options) {
  let captured
  render(() => {
    captured = useCharCounter(options)
    return null
  }, {})
  return captured
}

test("the hook wires the field to the counter and keeps the ids the field already had", () => {
  const plain = hookResult({ value: "hi", max: 10, id: "count" })
  assert.equal(plain.fieldProps["aria-describedby"], "count")
  const withHint = hookResult({ value: "hi", max: 10, id: "count", describedBy: "bio-hint" })
  assert.equal(withHint.fieldProps["aria-describedby"], "bio-hint count")
})

test("the field is marked invalid only once the value actually is", () => {
  assert.equal(hookResult({ value: "x".repeat(10), max: 10 }).fieldProps["aria-invalid"], undefined)
  assert.equal(hookResult({ value: "x".repeat(11), max: 10 }).fieldProps["aria-invalid"], true)
})

test("the hook never hands back a maxLength for the field", () => {
  assert.equal("maxLength" in hookResult({ value: "hi", max: 10 }).fieldProps, false)
})

test("the hook reports the state a submit button needs", () => {
  const state = hookResult({ value: FLAG.repeat(6), max: 5 })
  assert.equal(state.count, 6)
  assert.equal(state.remaining, -1)
  assert.equal(state.over, true)
  assert.equal(state.status, "over")
})

test("with no max there is no remaining to report", () => {
  const state = hookResult({ value: "hello" })
  assert.equal(state.remaining, null)
  assert.equal(state.over, false)
})

test("counterProps carry the same id the field was pointed at", () => {
  const state = hookResult({ value: "hi", max: 10, id: "count", unit: "utf8" })
  assert.equal(state.counterProps.id, "count")
  assert.equal(state.counterProps.unit, "utf8")
  assert.equal(state.counterProps.value, "hi")
})

test("the unit is honoured end to end, so the counter can agree with the server", () => {
  assert.equal(hookResult({ value: THUMB_TONE, max: 10, unit: "grapheme" }).count, 1)
  assert.equal(hookResult({ value: THUMB_TONE, max: 10, unit: "codePoint" }).count, 2)
  assert.equal(hookResult({ value: THUMB_TONE, max: 10, unit: "utf16" }).count, 4)
  assert.equal(hookResult({ value: THUMB_TONE, max: 10, unit: "utf8" }).count, 8)
})
