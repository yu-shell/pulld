// highlight-text cuts a string into matched and unmatched runs, and almost everything that can go
// wrong with it is invisible in the rendered output — which is exactly why it is tested here rather
// than looked at.
//
// Three properties carry most of the weight:
//
// The segments must concatenate back to the original text, always. Matching happens in a folded
// copy of the string (lowercased, accents stripped) and the slicing happens in the original, and
// those two strings do not have the same length — `İ` folds to two characters, a combining accent
// folds to none. Any arithmetic that carries an offset from one to the other is wrong, and it is
// wrong in a way that duplicates or eats characters a few letters away from the highlight, where
// nobody is looking. A sum of the parts catches every version of that in one assertion.
//
// The query is never compiled to a regular expression. `C++`, `a.b` and `$100` are ordinary things
// to search for and all three are also regex syntax, so an implementation that builds a pattern
// either throws on them or matches somewhere else entirely. The tests pin the literal behaviour
// from the outside, so a future rewrite that reaches for `new RegExp` fails here rather than in
// somebody's search box.
//
// And the marks a reader sees must be the ranges that matched, with overlaps merged and touching
// matches left alone. Overlapping terms are the interesting case (`ab` and `bc` both land on
// `abc`), and the failure without merging is a duplicated letter in the output, which the
// concatenation property above also catches from a second direction. Merging one step further and
// joining touching matches is the opposite mistake: it reads the same on screen but leaves a find
// bar counting fewer hits than the reader can see.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const { HighlightText, splitHighlight } = loadComponent(
  join(ROOT, "registry", "ui", "highlight-text.tsx")
)

/** The matched runs, in order — the part a reader actually sees highlighted. */
const marked = (text, query, options) =>
  splitHighlight(text, query, options)
    .filter((segment) => segment.match)
    .map((segment) => segment.text)

/** The whole string back out of the segments. Must equal the input for every query. */
const rejoin = (text, query, options) =>
  splitHighlight(text, query, options)
    .map((segment) => segment.text)
    .join("")

const marks = (tree) => walk(tree).filter((node) => node.type === "mark")

// --- the invariant ----------------------------------------------------------

test("the segments always reconstruct the text exactly", () => {
  const texts = [
    "",
    "plain",
    "Café au lait, cafe au lait",
    "éclair and éclair",
    "İstanbul ISTANBUL istanbul",
    "ΕΛΛΑΣ ελλάς",
    "straße strasse",
    "abcabcabc",
    "👩‍👩‍👧‍👦 family 🇯🇵 flag",
    "a‍b",
    "   ",
    "C++ and a.b and $100 and (x) and [y] and ^z$",
    "ß".repeat(20),
  ]
  const queries = [
    "",
    " ",
    "a",
    "e",
    "s",
    "ss",
    "cafe",
    "café",
    "istanbul",
    "ελλάς",
    "abc",
    ["ab", "bc"],
    ["a", "b", "c"],
    "👩‍👩‍👧‍👦",
    "́",
    "C++",
    "$100",
    "not-present-anywhere",
  ]
  const optionSets = [
    undefined,
    { caseSensitive: true },
    { matchDiacritics: true },
    { caseSensitive: true, matchDiacritics: true },
    { splitWords: false },
  ]

  for (const text of texts) {
    for (const query of queries) {
      for (const options of optionSets) {
        assert.equal(
          rejoin(text, query, options),
          text,
          `text ${JSON.stringify(text)} / query ${JSON.stringify(query)} / ${JSON.stringify(options)}`
        )
      }
    }
  }
})

test("no empty segment is ever emitted", () => {
  // An empty run is a <mark> with nothing in it, or a stray text node — both are the residue of an
  // off-by-one in the slicing, and neither is visible on screen.
  const cases = [
    ["abcabc", ["ab", "c"]],
    ["foobar", ["foo", "bar"]],
    ["aaaa", "a"],
    ["abc", ["ab", "bc"]],
    ["one two three", "one two three"],
    ["match", "match"],
  ]
  for (const [text, query] of cases) {
    assert.ok(
      splitHighlight(text, query).every((segment) => segment.text.length > 0),
      `an empty segment for ${JSON.stringify(text)} / ${JSON.stringify(query)}`
    )
  }
})

test("touching matches stay separate, so a find bar can still count them", () => {
  // The distinction that decides this: overlapping ranges *must* be merged, because a <mark>
  // cannot be drawn inside another one — but ranges that merely touch are two matches the reader
  // can see, and collapsing them would leave `activeIndex` with fewer stops than there are hits.
  const segments = splitHighlight("abcabcabc", "abc")
  assert.deepEqual(
    segments.map((segment) => segment.match),
    [true, true, true]
  )
  assert.deepEqual(marked("abab", "ab"), ["ab", "ab"])
  assert.deepEqual(marked("foobar", ["foo", "bar"]), ["foo", "bar"])

  // And the rendering agrees: three matches, three marks, three index stops.
  const { tree } = render(HighlightText, { text: "abcabcabc", query: "abc", activeIndex: 2 })
  const found = marks(tree)
  assert.equal(found.length, 3)
  assert.deepEqual(
    found.map((node) => node.props["data-active"]),
    [undefined, undefined, "true"]
  )
})

test("the mark has no horizontal padding, so a highlight cannot re-space the text", () => {
  // Padding on an inline highlight pushes the surrounding letters apart — the line reflows as the
  // reader types, and two touching matches get a visible gap driven down the middle of one word.
  const { tree } = render(HighlightText, { text: "abab", query: "ab" })
  for (const node of marks(tree)) {
    assert.doesNotMatch(node.props.className, /(^|\s|:)p[xlr]?-/, "no padding utility on the mark")
  }
})

// --- the query is not a pattern ---------------------------------------------

test("regex metacharacters are matched literally and nowhere else", () => {
  // Each of these either throws or matches the wrong thing once the query reaches `new RegExp`.
  assert.deepEqual(marked("upgrading from C++ to Rust", "C++"), ["C++"])
  assert.deepEqual(marked("the a.b field", "a.b"), ["a.b"])
  assert.deepEqual(marked("costs $100 today", "$100"), ["$100"])
  assert.deepEqual(marked("call (x) twice", "(x)"), ["(x)"])
  assert.deepEqual(marked("index [y] here", "[y]"), ["[y]"])
  assert.deepEqual(marked("pattern ^z$ ok", "^z$"), ["^z$"])
  assert.deepEqual(marked("a b\\c d", "b\\c"), ["b\\c"])

  // `.` is the one that matches in the wrong place rather than throwing: as a pattern it would
  // also hit "axb", and the highlight would land on text the reader never searched for.
  assert.deepEqual(marked("axb", "a.b"), [])
  assert.deepEqual(marked("C＋＋", "C++"), [])
})

test("a query that is only whitespace or empty leaves the text untouched", () => {
  // The hang, not the wrong answer, is the point: `indexOf("")` returns the search position for
  // ever, so an unguarded loop here never terminates and the page stops responding.
  for (const query of ["", " ", "\t\n ", [], [""], ["  "]]) {
    assert.deepEqual(splitHighlight("hello world", query), [
      { text: "hello world", match: false },
    ])
  }
})

test("empty text yields no segments", () => {
  assert.deepEqual(splitHighlight("", "anything"), [])
})

// --- folding ----------------------------------------------------------------

test("case is folded by default and respected when asked", () => {
  assert.deepEqual(marked("Hello HELLO hello", "hello"), ["Hello", "HELLO", "hello"])
  assert.deepEqual(marked("Hello HELLO hello", "hello", { caseSensitive: true }), ["hello"])
})

test("accents are folded by default and respected when asked", () => {
  assert.deepEqual(marked("Café", "cafe"), ["Café"])
  assert.deepEqual(marked("Café", "cafe", { matchDiacritics: true }), [])
  assert.deepEqual(marked("cafe", "café"), ["cafe"])
})

test("a decomposed accent is highlighted whole, base letter and mark together", () => {
  // "e" + combining acute. The mark folds to nothing, so a naive implementation highlights the "e"
  // and leaves the accent outside the <mark> — which renders as a bare accent floating after the
  // highlight. The slice has to cover both code points.
  const decomposed = "éclair"
  assert.deepEqual(marked(decomposed, "eclair"), [decomposed])
  assert.deepEqual(marked("café", "cafe"), ["café"])
})

test("lowercasing that lengthens the string does not shift the slice", () => {
  // "İ" (U+0130) has no one-character lowercase: toLowerCase gives "i" plus a combining dot, so the
  // folded string is longer than the original from this point on. Every later offset is wrong by
  // one unless the boundary is carried rather than computed.
  assert.deepEqual(marked("İstanbul", "istanbul"), ["İstanbul"])
  assert.deepEqual(marked("in İstanbul today", "today"), ["today"])
  assert.equal(rejoin("in İstanbul today", ["istanbul", "today"]), "in İstanbul today")
})

test("Greek final sigma matches its ordinary form", () => {
  // ΕΛΛΑΣ on screen, ελλάς as anyone would type it. `Σ`.toLowerCase() is σ, so without folding the
  // two sigmas together this finds nothing.
  assert.deepEqual(marked("ΕΛΛΑΣ", "ελλάς"), [
    "ΕΛΛΑΣ",
  ])
  assert.deepEqual(marked("οδός", "οδόσ"), [
    "οδός",
  ])
})

test("a stray combining mark is not dragged into the highlight next to it", () => {
  // A combining mark with no letter in front of it is a character of its own that folds to
  // nothing, so it sits at the same position in the folded string as the letter after it. Which of
  // the two the highlight starts at is a real choice, and the wrong one silently pulls a character
  // that did not match inside the <mark>.
  assert.deepEqual(marked("́abc", "abc"), ["abc"])
  assert.equal(rejoin("́abc", "abc"), "́abc")
})

test("without Intl.Segmenter, a combining mark still travels with its letter", () => {
  // The fallback splits on code points, so an accent becomes a character of its own sitting
  // *after* its base letter — the mirror image of the case above. A match on the base letter has
  // to carry the accent along, or the highlight ends between a letter and its own accent and the
  // accent is left stranded outside, rendering as a floating mark.
  const original = Intl.Segmenter
  delete Intl.Segmenter
  try {
    assert.equal(typeof Intl.Segmenter, "undefined", "the fallback path is the one under test")
    assert.deepEqual(marked("éclair", "e"), ["é"])
    assert.deepEqual(marked("éclair", "eclair"), ["éclair"])
    assert.equal(rejoin("éclair", "e"), "éclair")
    // Half of a surrogate pair is what a query truncated with slice() looks like. Even on the
    // fallback it must not be able to cut an astral character in two.
    assert.deepEqual(marked("👍 yes", "\ud83d"), [])
    assert.equal(rejoin("👍 yes", "\ud83d"), "👍 yes")
  } finally {
    Intl.Segmenter = original
  }
})

test("a query that folds away entirely matches nothing", () => {
  // A lone combining acute is not empty, but its comparison form is — and "matches everywhere" is
  // the other way this can fail.
  assert.deepEqual(marked("éclair", "́"), [])
})

test("a match landing inside a character is skipped, not drawn", () => {
  // Nothing in this registry can draw half a letter, so the honest answer to a partial hit is to
  // pass over it. There is no fold that turns ß into ss here, so "s" does not match the ß at all —
  // what this pins is that the ß is left alone while the surrounding text still searches
  // correctly.
  assert.deepEqual(marked("straße strasse", "s"), ["s", "s", "s", "s"])
  assert.equal(rejoin("straße strasse", "s"), "straße strasse")
})

// --- terms and overlap ------------------------------------------------------

test("a string query is split on whitespace by default, and kept whole on request", () => {
  assert.deepEqual(marked("the quick brown fox", "quick fox"), ["quick", "fox"])
  assert.deepEqual(marked("the quick brown fox", "quick fox", { splitWords: false }), [])
  assert.deepEqual(marked("a quick fox here", "quick fox", { splitWords: false }), ["quick fox"])
  // A half-typed query ends in a space; it should still highlight what has been typed.
  assert.deepEqual(marked("the quick brown fox", "quick "), ["quick"])
})

test("terms are trimmed, so stray whitespace does not become part of the phrase", () => {
  // Splitting on whitespace hides this — the empty term falls out on its own — so it only shows up
  // on the two paths that keep a term whole, where the surrounding spaces would be matched as
  // characters and the highlight would swallow them or find nothing at all.
  assert.deepEqual(marked("a quick fox", " quick ", { splitWords: false }), ["quick"])
  assert.deepEqual(marked("New York!", [" New York "]), ["New York"])
  assert.deepEqual(marked("fox", ["fox "]), ["fox"])
})

test("an array is always taken term by term, whatever splitWords says", () => {
  assert.deepEqual(marked("New York and New Jersey", ["New York"]), ["New York"])
  assert.deepEqual(marked("New York and New Jersey", ["New York"], { splitWords: true }), [
    "New York",
  ])
  assert.deepEqual(marked("New York and New Jersey", ["New", "York"]), ["New", "York", "New"])
})

test("overlapping terms merge into one highlight instead of nesting", () => {
  assert.deepEqual(marked("abc", ["ab", "bc"]), ["abc"])
  assert.deepEqual(marked("abcd", ["abc", "bcd"]), ["abcd"])
  assert.deepEqual(marked("xabcx", ["ab", "bc"]), ["abc"])
})

test("repeats of one term are found left to right without overlapping themselves", () => {
  // "aa" in "aaa" is one match, not two: find-in-page does not count the second, and two
  // overlapping ranges would emit the middle "a" twice.
  assert.deepEqual(marked("aaa", "aa"), ["aa"])
  assert.deepEqual(marked("aaaa", "aa"), ["aa", "aa"])
  assert.deepEqual(marked("abcabcabc", "abc"), ["abc", "abc", "abc"])
})

test("a query that covers only part of one character highlights nothing", () => {
  // The case that makes grapheme splitting load-bearing rather than tidy. A flag is two regional
  // indicators and a thumbs-up with a skin tone is a base plus a modifier — each pair is one
  // character to a reader and two to the string. Matching the first half and drawing a <mark>
  // around it splits the pair at render time: the flag falls apart into two letters, the thumb
  // loses its skin tone and a bare modifier glyph appears beside it.
  assert.deepEqual(marked("🇯🇵 flag", "🇯"), [])
  assert.deepEqual(marked("👍🏽 nice", "👍"), [])
  assert.equal(rejoin("🇯🇵 flag", "🇯"), "🇯🇵 flag")

  // And the search carries on past the character it could not mark, rather than stopping there.
  assert.deepEqual(marked("👍🏽 and 👍🏽 and plain", "and"), ["and", "and"])
})

test("multi-byte characters are matched and sliced whole", () => {
  const family = "👩‍👩‍👧‍👦"
  assert.deepEqual(marked(`${family} family`, family), [family])
  assert.deepEqual(marked("🇯🇵 flag", "🇯🇵"), ["🇯🇵"])
  // A surrogate half must never come back out as its own segment.
  for (const segment of splitHighlight(`x${family}x`, "x")) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(segment.text), "no orphan surrogate")
    assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(segment.text), "no orphan surrogate")
  }
})

// --- rendering --------------------------------------------------------------

test("matched runs render as <mark> and the text is rendered whole", () => {
  const { tree } = render(HighlightText, { text: "the quick brown fox", query: "quick" })
  const found = marks(tree)
  assert.equal(found.length, 1)
  assert.equal(found[0].props.children, "quick")

  const rendered = walk(tree)
    .filter((node) => typeof node.props?.children === "string")
    .map((node) => node.props.children)
  assert.ok(rendered.includes("quick"), "the matched run is present")
})

test("text containing markup is rendered as text, not as markup", () => {
  // The reason this component exists rather than a one-line `.replace()` into
  // dangerouslySetInnerHTML: both the text and the query routinely come from a URL query string.
  const text = '<img src=x onerror="alert(1)"> and <mark>already</mark>'
  const { tree } = render(HighlightText, { text, query: "and" })
  assert.equal(rejoin(text, "and"), text)
  const strings = walk(tree)
    .map((node) => node.props?.children)
    .filter((child) => typeof child === "string")
  assert.ok(
    strings.some((value) => value.includes("<img src=x")),
    "the tags stay in the text content"
  )
  assert.ok(
    walk(tree).every((node) => node.props?.dangerouslySetInnerHTML === undefined),
    "nothing is injected as HTML"
  )
})

test("marks are numbered, and the active one is flagged for scrolling and for assistive tech", () => {
  const { tree } = render(HighlightText, {
    text: "match match match",
    query: "match",
    activeIndex: 1,
  })
  const found = marks(tree)
  assert.deepEqual(
    found.map((node) => node.props["data-match-index"]),
    [0, 1, 2]
  )
  assert.deepEqual(
    found.map((node) => node.props["data-active"]),
    [undefined, "true", undefined]
  )
  assert.deepEqual(
    found.map((node) => node.props["aria-current"]),
    [undefined, "true", undefined]
  )
})

test("no active index means no mark claims to be current", () => {
  const { tree } = render(HighlightText, { text: "match match", query: "match" })
  for (const node of marks(tree)) {
    assert.equal(node.props["data-active"], undefined)
    assert.equal(node.props["aria-current"], undefined)
  }
})

test("the mark overrides the user-agent colour instead of inheriting black", () => {
  // `<mark>` ships with `color: black` in every user-agent stylesheet, which is unreadable on a
  // dark background — the one styling rule this component cannot leave to the consumer.
  const { tree } = render(HighlightText, { text: "one two", query: "two" })
  const [mark] = marks(tree)
  assert.match(mark.props.className, /text-inherit/)
  assert.match(mark.props.className, /bg-primary/)
})

test("caller classes reach the root and the marks separately", () => {
  const { tree } = render(HighlightText, {
    text: "one two",
    query: "two",
    className: "text-sm",
    markClassName: "bg-amber-200",
    "data-testid": "root",
  })
  assert.equal(tree.props.className, "text-sm")
  assert.equal(tree.props["data-testid"], "root")
  assert.match(marks(tree)[0].props.className, /bg-amber-200/)
})

test("a query that matches nothing renders the text with no marks at all", () => {
  const { tree } = render(HighlightText, { text: "the quick brown fox", query: "zebra" })
  assert.equal(marks(tree).length, 0)
})
