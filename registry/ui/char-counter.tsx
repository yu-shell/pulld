"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * How a limit is measured.
 *
 * The unit is the whole point of this component, because the number a person sees and the number
 * the server enforces are counted by different rules, and nothing warns you when they disagree.
 *
 *  - `"grapheme"` — user-perceived characters, the thing a person is actually counting. 👍🏽 is one,
 *    🇯🇵 is one, é written as e + combining acute is one. This is the default, and the only unit
 *    whose number matches what someone looking at the field would say if you asked them.
 *  - `"codePoint"` — Unicode scalars. What `[...value].length` gives, and what most databases mean
 *    by a character length: Postgres `char_length`/`varchar(n)`, MySQL `CHAR_LENGTH` and an
 *    `utf8mb4` `VARCHAR(n)`, Python's `len`, Go's rune count. 👍🏽 is 2 here (thumb + skin tone),
 *    🇯🇵 is 2 (two regional indicators).
 *  - `"utf16"` — UTF-16 code units. What `value.length`, the HTML `maxlength` attribute, Java and
 *    C# all count. Every non-BMP character — every emoji, every rarer CJK ideograph — is 2.
 *  - `"utf8"` — bytes. What a byte-bounded column or a payload cap enforces: Postgres
 *    `octet_length`, DynamoDB item sizes, most HTTP header and cookie limits. Latin text is 1 byte
 *    a character, most CJK is 3, most emoji is 4.
 *
 * Pick the one your server uses. A field that counts graphemes in front of a `varchar(280)` will
 * let someone past 280 with emoji in their text and then lose the save.
 */
export type CharCountUnit = "grapheme" | "codePoint" | "utf16" | "utf8"

/** Where the current value sits relative to its limit. `"near"` drives the visual warning. */
export type CharCountStatus = "ok" | "near" | "over"

type GraphemeSegmenter = { segment(input: string): Iterable<{ segment: string }> }
type SegmenterConstructor = new (
  locales: undefined,
  options: { granularity: "grapheme" }
) => GraphemeSegmenter

// Built once and kept. Every function here runs on every keystroke, and constructing a Segmenter is
// far more expensive than the segmentation itself. `undefined` means "no locale preference", which
// is right: grapheme boundaries are defined by UAX #29 and are not locale-dependent the way word
// and sentence boundaries are. `null` is the memo for "this engine has no Segmenter".
let cachedSegmenter: GraphemeSegmenter | null | undefined
function graphemeSegmenter(): GraphemeSegmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter
  cachedSegmenter =
    typeof Segmenter === "function"
      ? new Segmenter(undefined, { granularity: "grapheme" })
      : null
  return cachedSegmenter
}

let cachedEncoder: TextEncoder | null | undefined

/**
 * The newline problem, which is the same mismatch in a place nobody looks.
 *
 * A `<textarea>`'s `value` reports every line break as a single `\n`, but the HTML spec has forms
 * normalise the value to CRLF on submit, and plenty of back ends store and count it that way. So a
 * 280-limit field holding ten lines is four short of what the counter claims under any unit but
 * graphemes — and it is short by more the longer the text gets, which is exactly when it matters.
 *
 * Turning this on counts a line break the way the wire does. Under `"grapheme"` it changes nothing,
 * because CRLF is a single grapheme cluster by definition — which is the correct answer there.
 */
function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\r\n")
}

function countCodePoints(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // A high surrogate followed by a low one is one code point written in two units. Checking both
    // halves rather than just the first means an unpaired surrogate — which a truncated paste can
    // leave behind — still counts as the one unit it is, instead of swallowing the character after it.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
    }
    n++
  }
  return n
}

function countGraphemes(text: string): number {
  const segmenter = graphemeSegmenter()
  // Older engines: code points keep surrogate pairs whole, so an emoji counts 2 rather than 1
  // instead of the 2-per-half a raw `.length` would report. It is the closest wrong answer available.
  if (!segmenter) return countCodePoints(text)
  let n = 0
  for (const _segment of segmenter.segment(text)) n++
  return n
}

function countUtf8Bytes(text: string): number {
  if (cachedEncoder === undefined) {
    cachedEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null
  }
  if (cachedEncoder) return cachedEncoder.encode(text).length
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0) as number
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

export interface CharCountOptions {
  /** Count a line break as CRLF, the way a submitted form does. See {@link toCrlf}. */
  crlfNewlines?: boolean
}

/**
 * How long `text` is, in the unit a server would agree with.
 *
 * This is the function the whole component exists to get right, and the reason it is exported on
 * its own: the same count has to drive the meter, the disabled state of the submit button, and the
 * `superRefine` on the schema, and those three disagreeing is the bug.
 */
export function countChars(
  text: string,
  unit: CharCountUnit = "grapheme",
  options: CharCountOptions = {}
): number {
  const normalized = options.crlfNewlines ? toCrlf(text) : text
  switch (unit) {
    case "utf16":
      return normalized.length
    case "codePoint":
      return countCodePoints(normalized)
    case "utf8":
      return countUtf8Bytes(normalized)
    default:
      return countGraphemes(normalized)
  }
}

/** The user-perceived characters of `text`, longest boundary the engine can find. */
function toAtoms(text: string): string[] {
  const segmenter = graphemeSegmenter()
  if (segmenter) return Array.from(segmenter.segment(text), (entry) => entry.segment)
  return Array.from(text)
}

/**
 * Cut `text` down to `max` units, never through the middle of a character.
 *
 * Deliberately not what this component does to what you type — see {@link CharCounter} on why the
 * `maxlength` attribute is the wrong tool. It is here for the places where trimming really is the
 * answer and is being done on purpose: a preview string, an OG description, a value on its way into
 * a column that will reject it anyway.
 *
 * It walks grapheme clusters and weighs each one in the requested unit, so a UTF-16 or byte limit
 * still lands on a boundary a person would recognise. `"👍🏽".slice(0, 2)` is half a thumb.
 */
export function truncateToCount(
  text: string,
  max: number,
  unit: CharCountUnit = "grapheme",
  options: CharCountOptions = {}
): string {
  if (countChars(text, unit, options) <= max) return text
  if (!(max > 0)) return ""
  let used = 0
  let out = ""
  for (const atom of toAtoms(text)) {
    const weight = unit === "grapheme" ? 1 : countChars(atom, unit, options)
    if (used + weight > max) break
    used += weight
    out += atom
  }
  return out
}

/**
 * How close to the limit counts as close: a tenth of it, at least 1 and at most 20.
 *
 * Proportional because "10 left" is a different feeling in a 40-character title than in a 2,000
 * character description, and capped because on a very long limit a tenth is a warning that arrives
 * hundreds of characters early and stops meaning anything.
 */
export function defaultWarnAtRemaining(max: number): number {
  return Math.min(20, Math.max(1, Math.ceil(max * 0.1)))
}

export function charCountStatus(
  count: number,
  max: number | undefined,
  warnAtRemaining?: number
): CharCountStatus {
  if (max === undefined || !Number.isFinite(max)) return "ok"
  if (count > max) return "over"
  const warnAt = warnAtRemaining ?? defaultWarnAtRemaining(max)
  return max - count <= warnAt ? "near" : "ok"
}

export interface CharCountState {
  value: string
  unit: CharCountUnit
  /** Length of `value` in `unit`. */
  count: number
  max?: number
  /** `max - count`, negative once over. `null` when there is no limit. */
  remaining: number | null
  status: CharCountStatus
  /** `status === "over"`, kept as its own field because it is what a submit button is disabled on. */
  over: boolean
}

export interface CharCounterLabels {
  /** Read out below the limit. Also used at exactly 0 remaining. */
  remaining: (n: number) => string
  /** Read out past the limit; `n` is how many units over. */
  over: (n: number) => string
  /** Read out when there is no limit at all. */
  count: (n: number) => string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export const defaultCharCounterLabels: CharCounterLabels = {
  remaining: (n) => `${plural(n, "character")} remaining`,
  over: (n) => `${plural(n, "character")} over the limit`,
  count: (n) => plural(n, "character"),
}

/** The sentence describing a count — the counter's accessible text, and what gets announced. */
export function charCountMessage(
  count: number,
  max: number | undefined,
  labels: CharCounterLabels = defaultCharCounterLabels
): string {
  if (max === undefined || !Number.isFinite(max)) return labels.count(count)
  return count > max ? labels.over(count - max) : labels.remaining(max - count)
}

export interface UseCharCounterOptions extends CharCountOptions {
  value: string
  max?: number
  /** Defaults to `"grapheme"`. Match it to your server. See {@link CharCountUnit}. */
  unit?: CharCountUnit
  /** Remaining count at which `status` becomes `"near"`. Defaults to {@link defaultWarnAtRemaining}. */
  warnAtRemaining?: number
  /** Id for the counter element. Generated when omitted. */
  id?: string
  /** Ids the field is already described by; merged ahead of the counter's own. */
  describedBy?: string
  labels?: Partial<CharCounterLabels>
}

export interface UseCharCounterResult extends CharCountState {
  counterId: string
  labels: CharCounterLabels
  /** Non-empty only in the moment a band boundary is crossed. Belongs in a polite live region. */
  announcement: string
  /** Spread onto the `<input>` or `<textarea>`. Deliberately carries no `maxLength`. */
  fieldProps: {
    "aria-describedby": string
    "aria-invalid"?: true
  }
  /** Spread onto a {@link CharCounter} to render the state this hook already wired up. */
  counterProps: CharCounterProps
}

/**
 * The counter without the markup: for a field that already has its own hint line, a layout the
 * component does not fit, or a submit button that needs to know.
 *
 * Announcements are the part worth reading. A counter cannot simply be a live region — an
 * `aria-live` on the number turns every keystroke into an interruption, and since a screen reader
 * queues what it is told, the reader ends up hearing the count trail several characters behind the
 * typing while the letters themselves go unheard. So the counter is wired to the field with
 * `aria-describedby`, which is read on focus and stays silent afterwards, and `announcement` fires
 * only when the value crosses between comfortable, close to the limit, and past it. Three
 * announcements in the life of a field, each of them news.
 */
export function useCharCounter({
  value,
  max,
  unit = "grapheme",
  crlfNewlines = false,
  warnAtRemaining,
  id,
  describedBy,
  labels: labelOverrides,
}: UseCharCounterOptions): UseCharCounterResult {
  const generatedId = React.useId()
  const counterId = id ?? generatedId

  const labels = React.useMemo(
    () => ({ ...defaultCharCounterLabels, ...labelOverrides }),
    [labelOverrides]
  )

  const count = React.useMemo(
    () => countChars(value, unit, { crlfNewlines }),
    [value, unit, crlfNewlines]
  )
  const status = charCountStatus(count, max, warnAtRemaining)
  const over = status === "over"

  const [announcement, setAnnouncement] = React.useState("")
  // Seeded with the status at mount, so a value that arrives already over the limit — an existing
  // bio being edited — is described rather than announced at somebody who has not typed anything yet.
  const lastStatus = React.useRef(status)
  React.useEffect(() => {
    if (lastStatus.current === status) return
    lastStatus.current = status
    setAnnouncement(charCountMessage(count, max, labels))
  }, [status, count, max, labels])

  const fieldProps = React.useMemo(
    () => ({
      "aria-describedby": [describedBy, counterId].filter(Boolean).join(" "),
      // The value will be rejected, so say so where a screen reader will hear it on the field
      // itself. Drop it if you are already managing validity from your form library.
      ...(over ? { "aria-invalid": true as const } : {}),
    }),
    [describedBy, counterId, over]
  )

  const counterProps: CharCounterProps = {
    id: counterId,
    value,
    max,
    unit,
    crlfNewlines,
    warnAtRemaining,
    labels: labelOverrides,
  }

  return {
    value,
    unit,
    count,
    max,
    remaining: max === undefined ? null : max - count,
    status,
    over,
    counterId,
    labels,
    announcement,
    fieldProps,
    counterProps,
  }
}

export interface CharCounterProps
  extends Omit<React.ComponentPropsWithoutRef<"span">, "children">,
    CharCountOptions {
  /** The field's current value. Controlled input only — there is nothing to count otherwise. */
  value: string
  max?: number
  unit?: CharCountUnit
  warnAtRemaining?: number
  /** Replaces the visible number. The accessible text is unaffected. */
  format?: (state: CharCountState) => React.ReactNode
  labels?: Partial<CharCounterLabels>
}

const STATUS_CLASS: Record<CharCountStatus, string> = {
  ok: "text-muted-foreground",
  near: "text-foreground",
  over: "text-destructive font-medium",
}

/**
 * The "42 left" under a bio, a post box, a product description, an SMS body or a subject line.
 *
 * Point the field at it and the field describes itself:
 *
 * ```tsx
 * <textarea id="bio" value={bio} onChange={(e) => setBio(e.target.value)} aria-describedby="bio-count" />
 * <CharCounter id="bio-count" value={bio} max={280} />
 * ```
 *
 * or let {@link useCharCounter} do the wiring, and use what it knows:
 *
 * ```tsx
 * const counter = useCharCounter({ value: bio, max: 280, unit: "codePoint" })
 * <textarea value={bio} onChange={(e) => setBio(e.target.value)} {...counter.fieldProps} />
 * <CharCounter {...counter.counterProps} />
 * <button disabled={counter.over}>Save</button>
 * ```
 *
 * **It counts, and it does not stop you.** The reflex is to put `maxLength` on the field and be
 * done, and that attribute is a trapdoor: paste 400 characters into a 280 field and the browser
 * keeps the first 280 and discards the rest with no event, no error and nothing on screen. The
 * writer sees a full box and no complaint; the sentence they were pasting ends mid-word. What is
 * missing is invisible precisely because it is missing. So the limit is shown and crossed — the
 * count goes negative and red, `over` is true, and refusing the save is a decision you make once,
 * in the one place that already knows why.
 *
 * The number is a real count of what the person can see, not `value.length`. Those differ wherever
 * text is not plain Latin: an emoji is 2 UTF-16 units, a flag is 4, a thumbs-up with a skin tone is
 * 4, so the naive counter charges someone four characters for one glyph — and deleting it makes the
 * remaining count jump by four, which reads as a bug in the box.
 */
export function CharCounter({
  value,
  max,
  unit = "grapheme",
  crlfNewlines = false,
  warnAtRemaining,
  format,
  labels: labelOverrides,
  className,
  id,
  ...props
}: CharCounterProps) {
  const counter = useCharCounter({
    value,
    max,
    unit,
    crlfNewlines,
    warnAtRemaining,
    id,
    labels: labelOverrides,
  })
  const { count, remaining, status, counterId, labels, announcement } = counter
  const spoken = charCountMessage(count, max, labels)

  return (
    <>
      <span
        id={counterId}
        className={cn(
          // Tabular figures because the number changes on every keystroke, and proportional digits
          // make the counter twitch sideways in the corner of the writer's eye while they type.
          "text-xs tabular-nums",
          STATUS_CLASS[status],
          className
        )}
        {...props}
      >
        {/* Hidden from assistive tech so the description read on focus is the sentence below rather
            than a bare "42", which on its own says nothing about what it counts or which way it runs. */}
        <span aria-hidden="true">
          {format ? format(counter) : remaining === null ? count : remaining}
        </span>
        <span className="sr-only">{spoken}</span>
      </span>
      {/* Kept out of the described element: anything in here would be read on every focus, and the
          description would then be the last band change rather than the current count. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </>
  )
}
