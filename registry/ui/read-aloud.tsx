"use client"

import * as React from "react"
import { Loader2, Pause, Play, Square, TriangleAlert, Volume2, VolumeX } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Speech synthesis, read off `window` at call time rather than captured at module scope.
 *
 * Two reasons. On the server the global is not there at all, and a module-level `const synth =
 * window.speechSynthesis` makes importing this file throw during SSR rather than rendering a button
 * that says it cannot speak. And the object is a live singleton shared by the whole page, so the
 * answer to "is there one" has to be asked again each time rather than remembered.
 *
 * Unlike `SpeechRecognition` (see `speech-input`, which hand-declares its surface because the only
 * spelling browsers ship is the undeclared prefixed one) both of these are in `lib.dom.d.ts`, so
 * the platform types are used as they come.
 */
function speechSynth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null
  const synth = window.speechSynthesis
  return synth && typeof synth.speak === "function" ? synth : null
}

function utteranceConstructor(): typeof SpeechSynthesisUtterance | null {
  if (typeof window === "undefined") return null
  const ctor = window.SpeechSynthesisUtterance
  return typeof ctor === "function" ? ctor : null
}

/** Whether this browser can speak at all. False on the server, so render the same tree either way. */
export function isReadAloudSupported(): boolean {
  return speechSynth() !== null && utteranceConstructor() !== null
}

/**
 * The page's own language, which is the language its prose is written in.
 *
 * Same resolution as `speech-input` uses for dictation, for the same reason: left unset, the voice
 * is chosen by the user agent and the specification does not say how, so the one configuration
 * whose behaviour cannot be predicted is the one you get by not configuring it. Here it is worse
 * than unpredictable — see `pickVoice`, where the browser's own default voice was measured to be in
 * a different language than the page.
 */
function documentLanguage(): string {
  if (typeof document !== "undefined") {
    const declared = document.documentElement?.lang
    if (declared) return declared
  }
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language
  return "en-US"
}

/** The primary subtag, lower-cased: `pt-BR` and `pt` both reduce to `pt`. */
function primarySubtag(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? ""
}

/**
 * Chooses the voice to read `lang` with, or null to leave the choice to the engine.
 *
 * Exported because it is the decision most worth overriding, and because the obvious implementation
 * is wrong in a way that only shows up on somebody else's machine. `voices.find((v) => v.default)`
 * is what everybody writes first — and `default` marks *the system's* voice, not a voice for the
 * content. Measured on a Mac whose system language is Japanese (Chromium 152, 2026-10-26): of 180
 * installed voices the one flagged `default: true` was `Kyoko (ja-JP)`, so an English article read
 * with the default voice is an English article read by a Japanese synthesiser. The page's language
 * is the only thing that says how the text should sound.
 *
 * Order: an exact tag match, then any voice sharing the primary subtag (`en-AU` will read `en-GB`
 * prose far better than a Japanese voice will), then nothing. Returning null is deliberate — a
 * voice that cannot pronounce the text is worse than letting the engine pick, and the utterance
 * carries `lang` regardless, which is the standard way to ask for a language without naming a voice.
 *
 * Local voices are preferred over remote ones within each tier: a network voice depends on the
 * engine's server being reachable and is where the `network` error code comes from.
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  const wanted = lang.toLowerCase()
  const base = primarySubtag(lang)
  const score = (voice: SpeechSynthesisVoice): number => {
    const voiceLang = (voice.lang ?? "").toLowerCase()
    if (voiceLang === wanted) return voice.localService ? 0 : 1
    if (base && primarySubtag(voiceLang) === base) return voice.localService ? 2 : 3
    return Number.POSITIVE_INFINITY
  }
  let best: SpeechSynthesisVoice | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const voice of voices) {
    const value = score(voice)
    if (value < bestScore) {
      best = voice
      bestScore = value
    }
  }
  return best
}

/**
 * Keeps the installed voices in state, because the first read of them is empty.
 *
 * Measured (Chromium 152 / macOS, 2026-10-26): the first synchronous `getVoices()` on a fresh
 * document returned **0 voices**, and `voiceschanged` fired 9ms later with **180**. A component that
 * reads the list once during its first render therefore has nothing to choose from — which is how
 * read-aloud buttons end up using the system default voice for everything, in the wrong language.
 *
 * Both halves are needed and neither is redundant. The event is the only notification that the list
 * has arrived; but the specification fires it when the list *changes*, so a browser that already
 * had its voices loaded when this page parsed may never fire it at all — and there the seed read is
 * the only one that answers. The list is read once more at the moment of speaking (see
 * `speakChunk`) because that is free, and it covers an engine that populates lazily on first use
 * without announcing it.
 */
export function useSpeechVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>(() => speechSynth()?.getVoices() ?? [])

  React.useEffect(() => {
    const synth = speechSynth()
    if (!synth) return
    const read = () => setVoices(synth.getVoices())
    read()
    synth.addEventListener?.("voiceschanged", read)
    return () => synth.removeEventListener?.("voiceschanged", read)
  }, [])

  return voices
}

/** One piece of the text, with where it came from so a consumer can highlight it. */
export interface ReadAloudChunk {
  text: string
  /** Index in the original text of the first character of `text`. */
  start: number
  /** Index one past the last character. */
  end: number
}

/**
 * How much text goes into one utterance by default.
 *
 * Small enough that a chunk is a sentence or two of prose, which is what makes the progress index
 * useful, and far below any length an engine is likely to refuse (`text-too-long` is a real error
 * code in the specification). See `splitForSpeech` for why the text is split at all.
 */
export const DEFAULT_MAX_CHUNK_CHARS = 300

const SENTENCE_ENDS = new Set([".", "．", "!", "?", "…", "。", "！", "？"])
const CLOSERS = new Set([")", "]", "}", '"', "'", "»", "”", "’", "）", "」", "』", "〉"])
const SPEAKABLE = /[\p{L}\p{N}]/u

/**
 * Words that end in a full stop without ending a sentence. Lower-cased, without the stop.
 *
 * Not exhaustive and cannot be: this is a heuristic over prose, and the cost of each entry is
 * asymmetric. A missing one splits a sentence in two, which costs a 2ms pause in the middle
 * (measured below) and a sentence-final fall in the voice. A wrong one glues two sentences
 * together, which costs nothing at all. So the list stays short and uncontroversial rather than
 * trying to cover every abbreviation in the language.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "sr", "jr", "st", "rev", "hon", "gen", "col", "sgt", "capt",
  "lt", "vs", "etc", "eg", "ie", "al", "cf", "viz", "approx", "est", "dept", "univ", "inc", "ltd",
  "co", "corp", "plc", "fig", "figs", "no", "nos", "vol", "vols", "pp", "ed", "eds", "ca",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
])

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch)

/**
 * Whether the terminator at `index` really ends a sentence.
 *
 * `pieceStart` is where the current chunk began, which is what makes a leading list marker
 * recognisable: the stop in "1. Buy milk" is a numbering convention, not a sentence, and breaking
 * there leaves a chunk that is nothing but "1." for the voice to read out as a number.
 */
function terminatesSentence(text: string, index: number, pieceStart: number): boolean {
  const ch = text[index]
  // The CJK stops are unambiguous — the scripts that use them do not follow them with a space, so
  // the "whitespace after" test below would reject every real sentence boundary in Japanese.
  if (ch === "。" || ch === "！" || ch === "？") return true

  // The terminator may be part of a run: "?!", an ellipsis, a stop inside a closing quote. The
  // boundary is judged on what follows the whole run.
  let last = index
  while (last + 1 < text.length && (SENTENCE_ENDS.has(text[last + 1]!) || CLOSERS.has(text[last + 1]!))) {
    last++
  }
  const after = text[last + 1]
  // Followed immediately by more text, this is inside a word rather than after one: `3.5`, `e.g.`,
  // `example.com`, `README.md`. One rule covers all of them, which is why there is no URL case.
  if (after !== undefined && !isSpace(after)) return false
  if (ch !== "." && ch !== "．") return true

  // A full stop, followed by a space. Three things look like that and are not sentence ends.
  const token = text.slice(pieceStart, index).trimStart()
  const word = token.split(/\s/).pop() ?? ""
  // A list marker at the head of the piece: "1.", "a.", "iv.".
  if (word === token && /^[\p{N}a-z]{1,3}$/iu.test(word)) return false
  // A single initial: "J. R. R. Tolkien", "U. S.".
  if (/^\p{L}$/u.test(word)) return false
  // An initialism carries its own stops, so the word before the last one still has one in it:
  // "e.g", "i.e", "U.S", "a.m". Matching the shape rather than listing them covers the lot, and it
  // is also why the lookup below strips the inner stops — the set spells these without them.
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return false
  return !ABBREVIATIONS.has(word.replace(/\./g, "").toLowerCase())
}

/** Trims a range to its speakable extent and appends it, or appends nothing if there is none. */
function pushRange(source: string, from: number, to: number, out: ReadAloudChunk[]): void {
  let start = from
  let end = to
  while (start < end && isSpace(source[start])) start++
  while (end > start && isSpace(source[end - 1])) end--
  if (start >= end) return
  const text = source.slice(start, end)
  // A piece with no letter or digit in it — a rule of dashes, a row of asterisks — is silent. It
  // was measured to settle harmlessly (an empty utterance fired `start` then `end` 3ms later), but
  // it would still take up a place in the progress count and a turn in the chain, so the index a
  // consumer highlights would drift off the sentence being spoken.
  if (!SPEAKABLE.test(text)) return
  out.push({ text, start, end })
}

/**
 * Splits text into the pieces that get spoken one at a time, with their offsets.
 *
 * **Why split at all.** The reason usually given is that Chrome cuts a long utterance off after
 * about fifteen seconds. That was **not reproduced** here: on Chromium 152 / macOS (2026-10-26) a
 * single 1,484-character utterance spoke for **98.6 seconds** and ended normally, and the same text
 * at `rate: 5` ended at 29.8s having fired 182 `boundary` events. So the cutoff is not a thing this
 * component can claim to work around, and it is not the reason the splitting is here.
 *
 * What survives measurement is narrower and still worth it. The specification has a `text-too-long`
 * error code, so a limit exists somewhere even where it was not hit. And the index of the sentence
 * being spoken is only observable between utterances: `boundary` gives a character offset, but
 * turning that into "which sentence" requires exactly this split anyway, and `boundary` is the
 * event most often missing in engines that have everything else. Chunking makes the useful signal
 * come from `start` and `end`, which every engine fires. The cost is a 2–3ms gap between pieces
 * (measured by chaining four sentences: `end` at 1969ms, next `start` at 1972ms), so splitting on
 * sentence boundaries is close to free; splitting mid-sentence is not, because the voice falls at
 * the end of an utterance as if it had finished a thought. Hence sentence boundaries first and the
 * character limit only as a backstop.
 *
 * A single newline is deliberately **not** a boundary. Hard-wrapped prose would otherwise be read
 * one line at a time with a sentence-final fall at the end of every line. Two or more newlines —
 * a paragraph break — are, since headings and list items often end with no punctuation at all.
 * Whether a lone newline sounds better broken has not been judged by ear here, so the conservative
 * reading wins; a consumer who disagrees can pre-split and pass the pieces in themselves.
 */
export function splitForSpeech(
  text: string,
  { maxChars = DEFAULT_MAX_CHUNK_CHARS }: { maxChars?: number } = {}
): ReadAloudChunk[] {
  const out: ReadAloudChunk[] = []
  if (typeof text !== "string" || text.length === 0) return out
  const limit = Math.max(1, Math.floor(maxChars))

  /** Appends `from`..`to`, breaking it up if it is over the limit. */
  const flush = (from: number, to: number) => {
    let start = from
    while (to - start > limit) {
      const cut = start + limit
      // Back up to the last space inside the limit so a word is never split in half. A single
      // unbroken token longer than the limit — a long URL read out character by character — has no
      // space to back up to, and is cut where the limit falls.
      let boundary = cut
      while (boundary > start && !isSpace(text[boundary])) boundary--
      if (boundary <= start) boundary = cut
      pushRange(text, start, boundary, out)
      start = boundary
    }
    pushRange(text, start, to, out)
  }

  let pieceStart = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "\n") {
      // A run of whitespace holding two or more newlines is a paragraph break.
      let end = i
      let newlines = 0
      while (end < text.length && isSpace(text[end])) {
        if (text[end] === "\n") newlines++
        end++
      }
      if (newlines >= 2) {
        flush(pieceStart, end)
        pieceStart = end
      }
      i = end - 1
      continue
    }
    if (!SENTENCE_ENDS.has(ch) || !terminatesSentence(text, i, pieceStart)) continue
    let end = i + 1
    while (end < text.length && (SENTENCE_ENDS.has(text[end]!) || CLOSERS.has(text[end]!))) end++
    flush(pieceStart, end)
    pieceStart = end
    i = end - 1
  }
  flush(pieceStart, text.length)
  return out
}

/**
 * Why reading stopped or refused to start.
 *
 * `interrupted` is the one that is not an error. Measured: calling `speechSynthesis.cancel()` while
 * an utterance was speaking produced an `error` event with code `interrupted` 1ms later, never an
 * `end` — so a component that reports every `error` puts a failure on screen every single time the
 * user presses stop. It is kept as a cause rather than dropped because it also arrives when
 * *something else on the page* takes the voice away, and that is worth telling a consumer about.
 */
export type ReadAloudFailureCause =
  | "unsupported"
  | "nothing-to-read"
  | "interrupted"
  | "voice-unavailable"
  | "text-too-long"
  | "audio-unavailable"
  | "network"
  | "not-allowed"
  | "invalid-argument"
  | "synthesis-failed"
  | "unknown"

export interface ReadAloudFailure {
  cause: ReadAloudFailureCause
  /** The engine's own error code, or null when this was settled before speaking began. */
  code: string | null
  /** Wording safe to show as-is. Override per cause with the `messages` prop. */
  message: string
  /** Whether pressing play again, right now, could produce a different result. */
  retryable: boolean
}

/**
 * Where reading has got to.
 *
 * `starting` is split from `speaking` because the gap is real and the component should not claim to
 * be reading before it is: measured 51ms between `speak()` returning and `start` firing for a local
 * voice, and `speechSynthesis.speaking` was already `true` throughout that gap (see `isSpeaking`).
 */
export type ReadAloudStatus = "unsupported" | "idle" | "starting" | "speaking" | "paused"

const RETRYABLE: Record<ReadAloudFailureCause, boolean> = {
  unsupported: false,
  "nothing-to-read": false,
  interrupted: true,
  "voice-unavailable": false,
  "text-too-long": false,
  "audio-unavailable": true,
  network: true,
  "not-allowed": false,
  "invalid-argument": false,
  "synthesis-failed": true,
  unknown: true,
}

const DEFAULT_MESSAGES: Record<ReadAloudFailureCause, string> = {
  unsupported: "This browser can't read text aloud.",
  "nothing-to-read": "There's nothing here to read.",
  interrupted: "Reading was interrupted.",
  "voice-unavailable": "No voice is available for this language.",
  "text-too-long": "That passage was too long for the speech engine.",
  "audio-unavailable": "The audio device is busy or unavailable.",
  network: "The voice couldn't be reached — it may need a connection.",
  "not-allowed": "This page isn't permitted to play speech.",
  "invalid-argument": "The speech settings were out of range.",
  "synthesis-failed": "The speech engine couldn't read that.",
  unknown: "Reading stopped unexpectedly.",
}

/** Maps a spec error code to a cause. */
function causeForCode(code: string): ReadAloudFailureCause {
  switch (code) {
    case "canceled":
    case "interrupted":
      return "interrupted"
    case "audio-busy":
    case "audio-hardware":
      return "audio-unavailable"
    case "network":
      return "network"
    case "synthesis-unavailable":
    case "synthesis-failed":
      return "synthesis-failed"
    case "language-unavailable":
    case "voice-unavailable":
      return "voice-unavailable"
    case "text-too-long":
      return "text-too-long"
    case "invalid-argument":
      return "invalid-argument"
    case "not-allowed":
      return "not-allowed"
    default:
      return "unknown"
  }
}

/**
 * Which hook instance the shared voice currently belongs to.
 *
 * `speechSynthesis` is one object for the whole page, and `cancel()` empties *its* queue — not
 * yours. The same shape as `fullscreen-button` reading `document.fullscreenElement`: without an
 * owner, two read-aloud buttons on one page each believe the speech is theirs, so unmounting the
 * one in a closed dialog silences the article, and stopping either one shows both as stopped. The
 * component that is speaking writes itself here; everyone else leaves the singleton alone.
 */
let voiceOwner: object | null = null

export interface UseReadAloudOptions {
  /** The text to read. Split into utterances by `splitForSpeech`. */
  text: string
  /** BCP 47 tag to read in. Defaults to the document's own `lang`. */
  lang?: string
  /** A specific voice, overriding the match `pickVoice` would make. */
  voice?: SpeechSynthesisVoice | null
  /** 0.1–10, where 1 is the voice's normal pace. */
  rate?: number
  /** 0–2, where 1 is the voice's normal pitch. */
  pitch?: number
  /** 0–1. */
  volume?: number
  /** Characters per utterance. See `DEFAULT_MAX_CHUNK_CHARS`. */
  maxChunkChars?: number
  /** Called as each piece starts, with its index and the piece itself. */
  onChunkChange?: (index: number, chunk: ReadAloudChunk) => void
  /** Called once the last piece has finished, and not when reading is stopped. */
  onDone?: () => void
  onFailure?: (failure: ReadAloudFailure) => void
}

export interface UseReadAloudResult {
  status: ReadAloudStatus
  /**
   * Whether a voice is producing sound right now.
   *
   * Not `speechSynthesis.speaking`, which was measured to be true in three situations where nothing
   * of yours is being read: synchronously after `speak()` and throughout the 51ms before `start`
   * fires; for the whole time an utterance is **paused** (`paused: true` and `speaking: true`
   * together); and inside your own utterance's `end` handler when anything else is queued behind it
   * — it describes the page's queue, not your utterance. Every state here is assembled from
   * `start` / `end` / `pause` / `resume` / `error` instead.
   */
  isSpeaking: boolean
  isPaused: boolean
  isSupported: boolean
  /** The pieces `text` was split into, in order. */
  chunks: ReadAloudChunk[]
  /** Index into `chunks` of the piece being read, or -1 when idle. */
  chunkIndex: number
  /**
   * Best-effort offset into the original text of the word being spoken, or null.
   *
   * From `boundary`, which fired roughly once per word at every length measured here (7 events at
   * 45 characters, 182 at 1,484). It is the first thing missing in an engine that supports
   * everything else, so it is typed as nullable and nothing in this component depends on it —
   * `chunkIndex` is the signal to build a highlight on, and this one refines it where it exists.
   */
  charIndex: number | null
  voices: SpeechSynthesisVoice[]
  /** The voice that will be used, or null to leave the choice to the engine. */
  voice: SpeechSynthesisVoice | null
  failure: ReadAloudFailure | null
  /** Starts reading, from a given piece if one is named. Restarts if already reading. */
  start: (fromChunk?: number) => void
  stop: () => void
  pause: () => void
  resume: () => void
  /** Play / pause / resume, as the button does. */
  toggle: () => void
}

/**
 * Reads a passage aloud a sentence at a time, reporting only what the engine actually told it.
 */
export function useReadAloud({
  text,
  lang,
  voice: voiceOverride,
  rate = 1,
  pitch = 1,
  volume = 1,
  maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
  onChunkChange,
  onDone,
  onFailure,
}: UseReadAloudOptions): UseReadAloudResult {
  const isSupported = React.useMemo(() => isReadAloudSupported(), [])
  const [status, setStatus] = React.useState<ReadAloudStatus>(isSupported ? "idle" : "unsupported")
  const [chunkIndex, setChunkIndex] = React.useState(-1)
  const [charIndex, setCharIndex] = React.useState<number | null>(null)
  const [failure, setFailure] = React.useState<ReadAloudFailure | null>(null)

  const voices = useSpeechVoices()
  const chunks = React.useMemo(() => splitForSpeech(text, { maxChars: maxChunkChars }), [text, maxChunkChars])

  const resolvedLang = lang ?? documentLanguage()
  // Matched unconditionally, then overridden. `voiceOverride ?? useMemo(...)` reads better and is a
  // conditional hook call: `??` short-circuits, so the memo is skipped on exactly those renders
  // where a voice was passed, and the hook order changes the moment the prop appears or goes away.
  const matchedVoice = React.useMemo(() => pickVoice(voices, resolvedLang), [voices, resolvedLang])
  const voice = voiceOverride ?? matchedVoice

  /**
   * Which run of reading is current. Bumped before anything is cancelled, so the events belonging
   * to the run being abandoned can be recognised and ignored.
   *
   * This is what keeps stop from being a pause. The chain advances in `end`, and `cancel()` was
   * measured to deliver `error`, not `end` — but that only holds for the utterance that was
   * speaking, and nothing in the specification promises it. A chain guarded only by "did we get an
   * error" resumes at the next sentence the moment somebody presses stop. A generation counter does
   * not care which event arrived.
   */
  const runRef = React.useRef(0)
  /** This instance's identity, for `voiceOwner`. */
  const ownerRef = React.useRef<object>({})
  const chunksRef = React.useRef(chunks)

  const onChunkChangeRef = React.useRef(onChunkChange)
  const onDoneRef = React.useRef(onDone)
  const onFailureRef = React.useRef(onFailure)
  React.useEffect(() => {
    onChunkChangeRef.current = onChunkChange
    onDoneRef.current = onDone
    onFailureRef.current = onFailure
  }, [onChunkChange, onDone, onFailure])

  // Read through refs so the chain, which outlives the render that started it, speaks at the
  // settings that are current rather than the ones in force when play was pressed.
  const settingsRef = React.useRef({ resolvedLang, voice, rate, pitch, volume })
  React.useEffect(() => {
    settingsRef.current = { resolvedLang, voice, rate, pitch, volume }
    chunksRef.current = chunks
  }, [chunks, pitch, rate, resolvedLang, voice, volume])

  const report = React.useCallback((cause: ReadAloudFailureCause, code: string | null) => {
    const next: ReadAloudFailure = {
      cause,
      code,
      message: DEFAULT_MESSAGES[cause],
      retryable: RETRYABLE[cause],
    }
    setFailure(next)
    onFailureRef.current?.(next)
  }, [])

  /** Gives up the shared voice, if it was ours to give up. */
  const releaseOwnership = React.useCallback(() => {
    if (voiceOwner === ownerRef.current) voiceOwner = null
  }, [])

  const settle = React.useCallback(() => {
    releaseOwnership()
    setStatus(isReadAloudSupported() ? "idle" : "unsupported")
    setChunkIndex(-1)
    setCharIndex(null)
  }, [releaseOwnership])

  const speakFrom = React.useCallback(
    (index = 0) => {
      const synth = speechSynth()
      const Utterance = utteranceConstructor()
      if (!synth || !Utterance) {
        report("unsupported", null)
        return
      }
      const pieces = chunksRef.current
      if (pieces.length === 0) {
        report("nothing-to-read", null)
        return
      }
      // `Math.max(0, NaN)` is NaN, so the clamp alone does not keep a bad index out of the array.
      const asked = Number.isFinite(index) ? Math.trunc(index) : 0
      const from = Math.min(Math.max(0, asked), pieces.length - 1)

      // Order matters: the run is retired *before* the queue is emptied, so the `error` that
      // `cancel()` produces for the utterance now being abandoned arrives stamped with a run that
      // is no longer current and is ignored rather than shown as a failure.
      const run = ++runRef.current
      synth.cancel()
      voiceOwner = ownerRef.current
      setFailure(null)
      setCharIndex(null)
      setChunkIndex(from)
      setStatus("starting")

      const speakChunk = (at: number) => {
        if (run !== runRef.current) return
        const list = chunksRef.current
        if (at >= list.length) {
          settle()
          onDoneRef.current?.()
          return
        }
        const piece = list[at]!
        const { resolvedLang: utteranceLang, voice: chosen, rate: r, pitch: p, volume: v } = settingsRef.current
        const utterance = new Utterance(piece.text)
        utterance.lang = utteranceLang
        // Read again rather than trusting the list from render: this costs nothing and is the only
        // thing that works in an engine which populates its voices lazily on first use without
        // firing `voiceschanged`.
        const fresh = chosen ?? pickVoice(synth.getVoices(), utteranceLang)
        if (fresh) utterance.voice = fresh
        utterance.rate = r
        utterance.pitch = p
        utterance.volume = v

        utterance.onstart = () => {
          if (run !== runRef.current) return
          setStatus("speaking")
          setChunkIndex(at)
          onChunkChangeRef.current?.(at, piece)
        }
        utterance.onboundary = (event: SpeechSynthesisEvent) => {
          if (run !== runRef.current) return
          setCharIndex(piece.start + (event.charIndex ?? 0))
        }
        // The engine's own events, not an optimistic guess: `pause()` was measured to take 5ms to
        // take effect, and a button that flips to "Paused" on the click and then never hears back
        // is describing something that may not have happened.
        utterance.onpause = () => {
          if (run !== runRef.current) return
          setStatus("paused")
        }
        utterance.onresume = () => {
          if (run !== runRef.current) return
          setStatus("speaking")
        }
        utterance.onend = () => {
          if (run !== runRef.current) return
          speakChunk(at + 1)
        }
        utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
          if (run !== runRef.current) return
          const code = event.error ?? "unknown"
          const cause = causeForCode(code)
          // Still the current run and interrupted anyway: something else on the page took the
          // voice. Our own stop retired the run before cancelling, so it never lands here.
          settle()
          report(cause, code)
        }
        synth.speak(utterance)
      }

      speakChunk(from)
    },
    [report, settle]
  )

  const stop = React.useCallback(() => {
    runRef.current++
    const synth = speechSynth()
    // Only when the speech is ours. `cancel()` is page-wide, so stopping a button that is not
    // speaking would silence whatever else is.
    if (synth && voiceOwner === ownerRef.current) synth.cancel()
    setFailure(null)
    settle()
  }, [settle])

  const pause = React.useCallback(() => {
    const synth = speechSynth()
    if (synth && voiceOwner === ownerRef.current) synth.pause()
  }, [])

  const resume = React.useCallback(() => {
    const synth = speechSynth()
    if (synth && voiceOwner === ownerRef.current) synth.resume()
  }, [])

  const toggle = React.useCallback(() => {
    if (status === "speaking") pause()
    else if (status === "paused") resume()
    // Pressing again before the voice has started is a change of mind, not a pause: `pause()` acts
    // on a queue that has not begun, and nothing promises a `start` will arrive to be paused — so
    // the honest answer to a second press in that 51ms window is to drop the reading entirely.
    else if (status === "starting") stop()
    else speakFrom(0)
  }, [pause, resume, speakFrom, status, stop])

  // Stopping on unmount is the whole reason this needs a cleanup: the voice is not attached to the
  // component, so a route change in a single-page app leaves the previous article being read over
  // the new page with no control anywhere that can stop it. A real document navigation does not
  // need help — measured on Chromium 152 / macOS: after navigating away mid-utterance,
  // `speechSynthesis.speaking` was already false 19ms into the new document — so there is no
  // `pagehide` listener here, deliberately.
  React.useEffect(() => {
    return () => {
      runRef.current++
      const synth = speechSynth()
      if (synth && voiceOwner === ownerRef.current) {
        synth.cancel()
        voiceOwner = null
      }
    }
  }, [])

  // Reading cannot continue into text that has been replaced under it.
  const textRef = React.useRef(text)
  React.useEffect(() => {
    if (textRef.current === text) return
    textRef.current = text
    if (voiceOwner === ownerRef.current) stop()
  }, [stop, text])

  return {
    status,
    isSpeaking: status === "speaking",
    isPaused: status === "paused",
    isSupported,
    chunks,
    chunkIndex,
    charIndex,
    voices,
    voice,
    failure,
    start: speakFrom,
    stop,
    pause,
    resume,
    toggle,
  }
}

export interface ReadAloudButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children" | "onClick">,
    Omit<UseReadAloudOptions, "text"> {
  /** The passage to read. */
  text: string
  /** Visible label, and the accessible name, while idle. */
  label?: string
  pauseLabel?: string
  resumeLabel?: string
  stopLabel?: string
  startingLabel?: string
  unsupportedLabel?: string
  /** Announced once reading begins. Kept coarse on purpose — see the live region below. */
  readingLabel?: string
  pausedLabel?: string
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
  /** Hide the status line. It stays in the live region either way. */
  hideMessage?: boolean
  /** Show "sentence 3 of 12" beside the button. Never announced; see the live region below. */
  showProgress?: boolean
  /** Offer a separate stop button while reading. */
  showStop?: boolean
  /** Per-cause wording, merged over the defaults. */
  messages?: Partial<Record<ReadAloudFailureCause, string>>
  /** Class for the wrapper. `className` goes to the primary button. */
  containerClassName?: string
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

/**
 * A button that reads a passage aloud, and says only what the speech engine has confirmed.
 */
export function ReadAloudButton({
  text,
  label = "Listen",
  pauseLabel = "Pause",
  resumeLabel = "Resume",
  stopLabel = "Stop",
  startingLabel = "Starting…",
  unsupportedLabel = "Reading aloud isn't supported here",
  readingLabel = "Reading aloud",
  pausedLabel = "Paused",
  iconOnly = false,
  hideMessage = false,
  showProgress = false,
  showStop = true,
  messages,
  containerClassName,
  lang,
  voice,
  rate,
  pitch,
  volume,
  maxChunkChars,
  onChunkChange,
  onDone,
  onFailure,
  onClick,
  className,
  ...props
}: ReadAloudButtonProps) {
  const { status, isSupported, chunks, chunkIndex, failure, toggle, stop } = useReadAloud({
    text,
    lang,
    voice,
    rate,
    pitch,
    volume,
    maxChunkChars,
    onChunkChange,
    onDone,
    onFailure,
  })

  const messageId = React.useId()
  const active = status === "speaking" || status === "paused" || status === "starting"
  const busy = status === "starting"
  // A failure the user cannot do anything about leaves the button reachable and says why, rather
  // than dangling an action that cannot work.
  const actionable = isSupported && (active || failure?.retryable !== false)

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented || !actionable) return
    toggle()
  }

  const action = !isSupported
    ? unsupportedLabel
    : status === "starting"
      ? startingLabel
      : status === "speaking"
        ? pauseLabel
        : status === "paused"
          ? resumeLabel
          : label

  // Deliberately coarse, and deliberately not the sentence number. A polite live region rewritten
  // once per sentence queues an announcement for every sentence in the passage and reads them over
  // the top of the passage itself — in a component whose entire job is to speak, that is the worst
  // possible place to put a screen reader's attention. The sentence counter below is outside the
  // region for the same reason.
  const liveMessage = failure
    ? failure.cause === "interrupted"
      ? ""
      : (messages?.[failure.cause] ?? failure.message)
    : status === "speaking"
      ? readingLabel
      : status === "paused"
        ? pausedLabel
        : ""

  const Icon = !isSupported
    ? VolumeX
    : busy
      ? Loader2
      : status === "speaking"
        ? Pause
        : status === "paused"
          ? Play
          : failure && !failure.retryable
            ? TriangleAlert
            : Volume2

  return (
    <div className={cn("flex flex-col items-start gap-2", containerClassName)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          // No `aria-pressed`. This button's action changes between three verbs rather than
          // toggling one setting on and off, and "Listen, pressed" is the wrong thing to hear while
          // reading is paused. The name says what pressing it will do, which is what changes.
          aria-label={iconOnly ? action : undefined}
          // `aria-disabled` rather than `disabled`: a disabled button leaves the tab order, so a
          // keyboard or screen-reader user never reaches it and never hears why reading is
          // unavailable. `handleClick` is what refuses.
          aria-disabled={actionable ? undefined : true}
          aria-busy={busy || undefined}
          aria-describedby={liveMessage ? messageId : undefined}
          data-status={status}
          data-cause={failure?.cause}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50",
            iconOnly ? "w-9" : "px-4",
            className
          )}
          {...props}
        >
          <Icon className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
          {iconOnly ? null : action}
        </button>
        {showStop && active ? (
          <button
            type="button"
            onClick={stop}
            aria-label={stopLabel}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Square className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        {showProgress && active && chunkIndex >= 0 ? (
          <span className="text-sm tabular-nums text-muted-foreground" aria-hidden="true">
            {chunkIndex + 1} / {chunks.length}
          </span>
        ) : null}
      </div>
      {/*
        Mounted from the start and left empty, never conditionally rendered: a live region inserted
        into the document already holding its text is not reliably announced, so the version that
        only appears when something happens is silent for exactly the people relying on it.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        className={cn("text-sm text-muted-foreground", (hideMessage || !liveMessage) && "sr-only")}
      >
        {liveMessage}
      </p>
    </div>
  )
}
