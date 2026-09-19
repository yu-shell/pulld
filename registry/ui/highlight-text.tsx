import * as React from "react"

import { cn } from "@/lib/utils"

export interface HighlightOptions {
  /** Match upper and lower case as distinct characters. Defaults to false. */
  caseSensitive?: boolean
  /** Treat `é` and `e` as distinct characters. Defaults to false. */
  matchDiacritics?: boolean
  /**
   * Split a string query on whitespace and match each word on its own. Defaults to true, which
   * is what a search box's contents mean: the backend tokenised them, so the highlight should
   * too, and a phrase that never occurs verbatim would otherwise light up nothing at all. Pass
   * an array instead to match exact phrases — an array is always taken term by term, as given.
   */
  splitWords?: boolean
}

/** One run of the original text, flagged with whether the query matched it. */
export interface HighlightSegment {
  text: string
  match: boolean
}

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> }
type SegmenterConstructor = new (
  locales: undefined,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter

/**
 * Split into user-perceived characters rather than UTF-16 code units.
 *
 * The unit of matching has to be the unit of rendering. A `<mark>` is drawn around a slice of the
 * original string, so a slice that begins or ends inside an emoji, a flag or an accented letter
 * does not merely look untidy — it tears a character in half and both halves render as replacement
 * glyphs. Working in graphemes makes that unrepresentable: every boundary this file can produce is
 * a boundary a reader would recognise.
 */
function toUnits(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
  if (typeof Segmenter === "function") {
    return Array.from(
      new Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (entry) => entry.segment
    )
  }
  // Older engines: iterating a string yields code points, which keeps surrogate pairs whole even
  // though it still splits combining marks off their base letter. The folding below absorbs that —
  // a lone combining mark folds to nothing and is carried along by the character before it.
  return Array.from(text)
}

// Safe to share despite the `g` flag. `String.prototype.replace` always starts at zero and leaves
// `lastIndex` at zero afterwards; it is `test` and `exec` that carry the index between calls and
// make a shared global regex skip half its input.
const COMBINING_MARKS = /\p{M}/gu

/**
 * The comparison form of one grapheme.
 *
 * Case first, then marks, because lowercasing can *introduce* a combining mark: `İ` (U+0130) has
 * no single-character lowercase, so `toLowerCase` returns `i` followed by a combining dot. Strip
 * marks first and that dot survives the fold, leaving `İstanbul` unfindable by `istanbul`.
 *
 * `toLowerCase` and not `toLocaleLowerCase`: locale-aware casing would make the same text
 * highlight differently depending on where the reader is — in Turkish, `I` lowercases to a
 * dotless `ı`, so `ISTANBUL` would stop matching `istanbul` on exactly one set of machines.
 *
 * The sigma line is the one special case worth carrying. Greek writes its lowercase sigma as `ς`
 * at the end of a word and `σ` everywhere else; `Σ`.toLowerCase() answers `σ` with no word to
 * look at, so a reader searching for `Ελλάς` as they would write it never matches the `ΕΛΛΑΣ` on
 * screen. Folding both forms together costs one replace and removes the whole class.
 */
function foldUnit(unit: string, caseSensitive: boolean, matchDiacritics: boolean): string {
  let folded = unit
  if (!caseSensitive) folded = folded.toLowerCase().replace(/ς/g, "σ")
  if (!matchDiacritics) folded = folded.normalize("NFD").replace(COMBINING_MARKS, "")
  return folded
}

/** Fold a query term the same way, grapheme by grapheme, so both sides agree character for character. */
function foldTerm(term: string, caseSensitive: boolean, matchDiacritics: boolean): string {
  let folded = ""
  for (const unit of toUnits(term)) folded += foldUnit(unit, caseSensitive, matchDiacritics)
  return folded
}

interface FoldedText {
  /** The comparison form of the whole text — the string `indexOf` actually searches. */
  folded: string
  /** Where unit `i` begins in the *original* text. One longer than the unit count; last entry is its length. */
  origin: number[]
  /**
   * For every index in `folded`, the unit boundary sitting there, or -1 for a position inside a
   * character. This is what keeps folding from corrupting the output: the two strings have
   * different lengths and there is no arithmetic that converts between them, so an offset found
   * in one is only ever carried back to the other through a boundary recorded here.
   */
  boundary: number[]
}

function foldText(text: string, caseSensitive: boolean, matchDiacritics: boolean): FoldedText {
  const units = toUnits(text)
  const origin: number[] = []
  const starts: number[] = []
  let folded = ""
  let at = 0
  for (const unit of units) {
    origin.push(at)
    starts.push(folded.length)
    folded += foldUnit(unit, caseSensitive, matchDiacritics)
    at += unit.length
  }
  origin.push(at)
  starts.push(folded.length)

  const boundary = new Array<number>(folded.length + 1).fill(-1)
  // Ascending, so where several units share a folded position the *last* one wins. That is what
  // decides which side of a highlight a zero-width character lands on, and both answers it gives
  // are the ones a reader would want: a combining mark that folds away is kept with the letter it
  // belongs to (its own start equals the following boundary, so it is swallowed by a match that
  // ends there), while a zero-width joiner sitting before a match stays outside it.
  for (let i = 0; i < starts.length; i++) boundary[starts[i]] = i
  return { folded, origin, boundary }
}

/** Every non-overlapping occurrence of one already-folded term, as `[firstUnit, lastUnit)` pairs. */
function unitRanges(text: FoldedText, term: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  // An empty term would make `indexOf` answer the search position forever. The guard is here
  // rather than only at the call site because this is the loop that would not terminate.
  if (term.length === 0) return ranges

  let from = 0
  while (from + term.length <= text.folded.length) {
    const start = text.folded.indexOf(term, from)
    if (start === -1) break
    const end = start + term.length
    const first = text.boundary[start]
    const last = text.boundary[end]
    if (first !== -1 && last !== -1) {
      ranges.push([first, last])
      from = end
    } else {
      // The match landed inside a character — one half of a `ß` folded to `ss`, say. There is no
      // honest way to draw that, so it is passed over and the search goes on from the next
      // position rather than stopping.
      from = start + 1
    }
  }
  return ranges
}

/**
 * Flatten overlapping ranges into one each, leaving touching ones alone.
 *
 * Two terms genuinely can overlap — `ab` and `bc` both hit `abc` — and rendering that as written
 * would either nest one `<mark>` inside another or emit the shared letter twice, so overlaps have
 * to go. Ranges that merely touch are left as they are, which is the less obvious half: `abab`
 * searched for `ab` is two matches, and folding them into one highlight would make a find bar
 * count one where the reader can see two, so `activeIndex` would run out of places to go. They
 * sit flush against each other and read as a single run either way — which is why the mark below
 * carries no horizontal padding, since padding is what would push the two apart and put a visible
 * gap in the middle of a word.
 */
function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length < 2) return ranges
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range[0] < last[1]) {
      if (range[1] > last[1]) last[1] = range[1]
    } else {
      merged.push([range[0], range[1]])
    }
  }
  return merged
}

function toTerms(query: string | string[], splitWords: boolean): string[] {
  const raw = Array.isArray(query) ? query : splitWords ? query.split(/\s+/) : [query]
  const terms: string[] = []
  for (const term of raw) {
    // Trimmed because a trailing space is what a half-typed query looks like, and a term that is
    // only whitespace would otherwise highlight every gap between words.
    if (typeof term === "string" && term.trim().length > 0) terms.push(term.trim())
  }
  return terms
}

/**
 * Cut `text` into alternating matched and unmatched runs.
 *
 * The whole component is this function plus a `<mark>`, and it is separate so that the matching
 * can be tested exhaustively without a DOM, and reused wherever the rendering is not React —
 * canvas, PDF, a terminal, a different framework.
 *
 * Concatenating the segments always reproduces `text` exactly, whatever the query. That is the
 * invariant worth holding onto: it is what makes the accent folding safe (the text is searched in
 * one form and sliced in another) and it is why nothing here can lose or duplicate a character.
 */
export function splitHighlight(
  text: string,
  query: string | string[],
  options: HighlightOptions = {}
): HighlightSegment[] {
  const { caseSensitive = false, matchDiacritics = false, splitWords = true } = options
  if (!text) return []

  const terms = toTerms(query, splitWords)
  if (terms.length === 0) return [{ text, match: false }]

  const folded = foldText(text, caseSensitive, matchDiacritics)
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    ranges.push(...unitRanges(folded, foldTerm(term, caseSensitive, matchDiacritics)))
  }

  const merged = mergeRanges(ranges)
  if (merged.length === 0) return [{ text, match: false }]

  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [first, last] of merged) {
    const start = folded.origin[first]
    const end = folded.origin[last]
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}

export interface HighlightTextProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children">,
    HighlightOptions {
  /** The text to display. Rendered in full — matching never removes or rewrites any of it. */
  text: string
  /** What to look for. A string is the query as typed; an array is a list of exact phrases. */
  query: string | string[]
  /**
   * Which match to mark as the current one, for a find bar with next/previous buttons. The marks
   * carry `data-match-index`, and the active one carries `data-active="true"`, so it can be
   * brought into view with `container.querySelector('[data-active="true"]')?.scrollIntoView()`.
   */
  activeIndex?: number
  /** Classes for the `<mark>` elements. */
  markClassName?: string
}

/**
 * Text with the parts matching a search query highlighted.
 *
 * Use it in search results and filtered lists, in-page and in-document search, log and diff
 * viewers, command palette and autocomplete options, table cells under an active filter, and
 * anywhere a reader has just typed something and needs to see where it landed.
 *
 * The text is rendered whole and only visually marked, so screen readers, find-in-page, copy and
 * text selection all see exactly the string that was passed in.
 */
export const HighlightText = React.forwardRef<HTMLSpanElement, HighlightTextProps>(
  function HighlightText(
    {
      text,
      query,
      caseSensitive = false,
      matchDiacritics = false,
      splitWords = true,
      activeIndex,
      markClassName,
      className,
      ...props
    },
    ref
  ) {
    const segments = splitHighlight(text, query, { caseSensitive, matchDiacritics, splitWords })

    let matchIndex = -1
    return (
      <span ref={ref} className={className} {...props}>
        {segments.map((segment, index) => {
          if (!segment.match) return <React.Fragment key={index}>{segment.text}</React.Fragment>
          matchIndex += 1
          return (
            <mark
              key={index}
              data-match-index={matchIndex}
              data-active={matchIndex === activeIndex ? "true" : undefined}
              // A real `<mark>` rather than a styled `<span>`, for a reason that only shows up on
              // someone else's machine: in Windows high contrast mode the browser replaces author
              // colours with system ones, and it knows to give a `<mark>` the system's own
              // highlight pair. A span painted with the same classes is handed the ordinary page
              // colours instead, and every highlight on the page silently disappears for the
              // readers who turned high contrast on in order to see things.
              //
              // `text-inherit` undoes the user-agent `color: black`, which would otherwise render
              // black text in dark mode and override the muted colour of whatever line this sits
              // in. Only the background changes; the text keeps the colour it already had.
              className={cn(
                "rounded-[0.2em] bg-primary/20 text-inherit",
                "data-[active=true]:bg-primary/40 data-[active=true]:ring-1 data-[active=true]:ring-primary/50",
                markClassName
              )}
              aria-current={matchIndex === activeIndex ? "true" : undefined}
            >
              {segment.text}
            </mark>
          )
        })}
      </span>
    )
  }
)
