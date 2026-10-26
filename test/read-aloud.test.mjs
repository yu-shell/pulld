// Reading a page aloud is one API call and a pile of lies about what it is doing. Everything below
// was written against a version that believed one of them, and most of the beliefs came from a
// probe page driven in a real browser (Chromium 152 / macOS, 2026-10-26) rather than from folklore:
//
//   - choosing the voice flagged `default: true`, which is the *system's* voice: on a Mac set to
//     Japanese that is Kyoko, so every English article is read by a Japanese synthesiser,
//   - reading `getVoices()` once during render, where it answers with an empty array — measured 0
//     voices synchronously and 180 nine milliseconds later, on `voiceschanged`,
//   - driving the UI from `speechSynthesis.speaking`, which was true in three places where nothing
//     of yours is being read: before `start` fires, throughout a pause, and inside your own `end`
//     handler while anything else is queued,
//   - flipping to "Paused" on the click rather than on the engine's `pause` event,
//   - reporting every `error` to the user, when `cancel()` was measured to deliver
//     `error: "interrupted"` — so pressing stop puts a failure on screen,
//   - advancing the sentence chain on whichever event arrives, so stop is a pause: the next
//     sentence starts a tick after the user asked for silence,
//   - calling `speechSynthesis.cancel()` on unmount whoever was speaking, which is page-wide, so
//     closing a dialog silences the article behind it,
//   - splitting sentences on /[.!?]/, which breaks "3.5", "Dr. Smith", "e.g." and "1. Buy milk",
//   - and leaving the voice running when the component goes away, which in a single-page app reads
//     the previous article over the new page with no control left that can stop it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** Stable identities, so a test can say *which* icon is showing. */
const icon = (name) => Object.assign(() => null, { displayName: name })
const icons = {
  Loader2: icon("Loader2"),
  Pause: icon("Pause"),
  Play: icon("Play"),
  Square: icon("Square"),
  TriangleAlert: icon("TriangleAlert"),
  Volume2: icon("Volume2"),
  VolumeX: icon("VolumeX"),
}

const {
  ReadAloudButton,
  useReadAloud,
  isReadAloudSupported,
  pickVoice,
  splitForSpeech,
  DEFAULT_MAX_CHUNK_CHARS,
} = loadComponent(join(ROOT, "registry", "ui", "read-aloud.tsx"), {
  stubs: { "lucide-react": icons },
})

const voice = (name, lang, { isDefault = false, local = true } = {}) => ({
  name,
  lang,
  default: isDefault,
  localService: local,
  voiceURI: name,
})

/**
 * The installed voices of the machine this was measured on, in miniature.
 *
 * `Kyoko` carries the `default` flag because that is what was actually there: the system language
 * was Japanese, so the browser's default voice is Japanese however the page is written.
 */
const VOICES = [
  voice("Kyoko", "ja-JP", { isDefault: true }),
  voice("Daniel", "en-GB"),
  voice("Daniel (Enhanced)", "en-GB", { local: false }),
  voice("Albert", "en-US"),
  voice("Alice", "it-IT"),
]

/**
 * Installs one browser for one test.
 *
 * `voicesReady: false` is the default because it is what a fresh document does — the first
 * `getVoices()` answers empty and the list arrives on `voiceschanged`. A component that only works
 * when the voices are already there has to fail here.
 */
function browser({ supported = true, voicesReady = false, voices = VOICES, documentLang = "en-GB" } = {}) {
  const calls = []
  const spoken = []
  const listeners = []
  const subscribed = []
  let list = voicesReady ? voices : []
  let speaking = false
  let paused = false

  class FakeUtterance {
    constructor(text) {
      this.text = text
      this.lang = ""
      this.voice = null
      this.rate = 1
      this.pitch = 1
      this.volume = 1
      this.onstart = null
      this.onend = null
      this.onerror = null
      this.onpause = null
      this.onresume = null
      this.onboundary = null
    }
  }

  const synth = {
    speak(utterance) {
      calls.push("speak")
      spoken.push(utterance)
      speaking = true
    },
    cancel() {
      calls.push("cancel")
      speaking = false
      paused = false
    },
    // Measured: `paused` goes true and `speaking` *stays* true. A component reading `speaking` to
    // decide whether a voice is talking believes a paused utterance is still being read.
    pause() {
      calls.push("pause")
      paused = true
    },
    resume() {
      calls.push("resume")
      paused = false
    },
    getVoices: () => list,
    get speaking() {
      return speaking
    },
    get paused() {
      return paused
    },
    get pending() {
      return false
    },
    addEventListener(type, fn) {
      subscribed.push(type)
      if (type === "voiceschanged") listeners.push(fn)
    },
    removeEventListener(type, fn) {
      const at = listeners.indexOf(fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }

  globalThis.window = supported ? { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance } : {}
  globalThis.document = { documentElement: { lang: documentLang } }
  // Assigned rather than set: `navigator` is an accessor on the global object in node.
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "en-US" },
    configurable: true,
    writable: true,
  })

  const at = (index) => (index === undefined ? spoken[spoken.length - 1] : spoken[index])
  return {
    calls,
    spoken,
    subscribed,
    at,
    texts: () => spoken.map((u) => u.text),
    countOf: (name) => calls.filter((c) => c === name).length,
    loadVoices(next = voices) {
      list = next
      for (const fn of [...listeners]) fn()
    },
    /** The engine's own events, which are the only thing the component is allowed to believe. */
    fireStart: (index) => at(index)?.onstart?.({}),
    fireEnd: (index) => at(index)?.onend?.({}),
    fireError: (code, index) => at(index)?.onerror?.({ error: code }),
    firePause: (index) => at(index)?.onpause?.({}),
    fireResume: (index) => at(index)?.onresume?.({}),
    fireBoundary: (charIndex, index) => at(index)?.onboundary?.({ charIndex }),
  }
}

const TEXT = "One two three. Four five six. Seven eight nine."

const nodes = (view) => walk(view.tree)
const buttons = (view) => byTag(nodes(view), "button")
const live = (view) => nodes(view).find((n) => n.props?.role === "status")
const iconsIn = (view) => nodes(view).filter((n) => typeof n.type === "function" && n.type.displayName)
const showing = (view) => iconsIn(view).map((n) => n.type.displayName)
const press = (view, index = 0) => {
  buttons(view)[index].props.onClick({ defaultPrevented: false })
  view.rerender()
}

// --- splitting -------------------------------------------------------------

test("splits prose into sentences, and the offsets point back at the original", () => {
  const chunks = splitForSpeech(TEXT)
  assert.deepEqual(
    chunks.map((c) => c.text),
    ["One two three.", "Four five six.", "Seven eight nine."]
  )
  for (const chunk of chunks) assert.equal(TEXT.slice(chunk.start, chunk.end), chunk.text)
})

test("a full stop followed by more text is inside a word, not the end of a sentence", () => {
  // One rule covers decimals, file names, domains and abbreviations written without spaces, which
  // is why there is no special case for URLs.
  assert.deepEqual(
    splitForSpeech("It cost 3.5 million. See example.com/a.b for README.md.").map((c) => c.text),
    ["It cost 3.5 million.", "See example.com/a.b for README.md."]
  )
})

test("abbreviations and initials keep their sentence", () => {
  assert.deepEqual(splitForSpeech("Dr. Smith arrived at 9.").map((c) => c.text), ["Dr. Smith arrived at 9."])
  assert.deepEqual(
    splitForSpeech("Ask J. R. R. Tolkien, e.g. about maps. Then stop.").map((c) => c.text),
    ["Ask J. R. R. Tolkien, e.g. about maps.", "Then stop."]
  )
})

test("a numbered list marker is not a sentence of its own", () => {
  // Breaking at the marker leaves a chunk that is nothing but "1." for the voice to read out.
  assert.deepEqual(
    splitForSpeech("1. Buy milk. 2. Pay rent.").map((c) => c.text),
    ["1. Buy milk.", "2. Pay rent."]
  )
})

test("the ideographic full stop ends a sentence although no space follows it", () => {
  // The whitespace test that makes the Latin rules work would reject every real boundary here.
  assert.deepEqual(
    splitForSpeech("これはテストです。次の文です。").map((c) => c.text),
    ["これはテストです。", "次の文です。"]
  )
})

test("a closing quote stays with the sentence it closes", () => {
  assert.deepEqual(
    splitForSpeech('He said "stop." Then we left.').map((c) => c.text),
    ['He said "stop."', "Then we left."]
  )
})

test("a run of terminators is one boundary", () => {
  assert.deepEqual(splitForSpeech("Really?! Yes... Fine.").map((c) => c.text), ["Really?!", "Yes...", "Fine."])
})

test("a paragraph break is a boundary, a single newline is not", () => {
  // Headings and list items end with no punctuation at all; hard-wrapped prose would otherwise be
  // read a line at a time, with the voice falling at the end of every line.
  assert.deepEqual(splitForSpeech("Heading\n\nBody text.").map((c) => c.text), ["Heading", "Body text."])
  assert.deepEqual(splitForSpeech("one line\nwrapped here.").map((c) => c.text), ["one line\nwrapped here."])
})

test("a sentence longer than the limit is split at a space, never mid-word", () => {
  const long = `${"alpha bravo ".repeat(10)}end.`
  const chunks = splitForSpeech(long, { maxChars: 30 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 30, `"${chunk.text}" is ${chunk.text.length} chars`)
    assert.equal(long.slice(chunk.start, chunk.end), chunk.text)
  }
  assert.equal(chunks.map((c) => c.text.replace(/\s+/g, " ")).join(" "), long.trim().replace(/\s+/g, " "))
})

test("one unbroken token longer than the limit is cut where the limit falls", () => {
  const chunks = splitForSpeech("x".repeat(25), { maxChars: 10 })
  assert.deepEqual(chunks.map((c) => c.text.length), [10, 10, 5])
})

test("pieces with nothing speakable in them are dropped", () => {
  // They settle harmlessly — an empty utterance was measured to fire start then end 3ms later — but
  // they would take a place in the progress count and pull a highlight off the spoken sentence.
  assert.deepEqual(splitForSpeech("Hello.\n\n---\n\nWorld.").map((c) => c.text), ["Hello.", "World."])
  assert.deepEqual(splitForSpeech("   "), [])
  assert.deepEqual(splitForSpeech(""), [])
})

test("the default chunk size is small enough to be a sentence or two", () => {
  assert.equal(DEFAULT_MAX_CHUNK_CHARS, 300)
})

// --- choosing a voice ------------------------------------------------------

test("the browser's default voice is not chosen when it is the wrong language", () => {
  // The measured trap: `default: true` marks the system's voice, not a voice for the content.
  const chosen = pickVoice(VOICES, "en-GB")
  assert.equal(chosen.name, "Daniel")
  assert.notEqual(chosen.name, "Kyoko")
})

test("an exact tag beats the primary subtag, and a local voice beats a remote one", () => {
  assert.equal(pickVoice(VOICES, "en-GB").name, "Daniel")
  // en-AU has no exact match, so any English voice is taken — in listed order, local first.
  assert.equal(pickVoice(VOICES, "en-AU").name, "Daniel")
  assert.equal(pickVoice([voice("Remote", "en-GB", { local: false }), voice("Local", "en-GB")], "en-GB").name, "Local")
})

test("no voice for the language means no voice, rather than the wrong one", () => {
  // `lang` still goes on the utterance, which is how you ask for a language without naming a voice.
  assert.equal(pickVoice(VOICES, "fi-FI"), null)
  assert.equal(pickVoice([], "en-GB"), null)
})

// --- the component --------------------------------------------------------

test("an unsupported browser gets a reachable button that says so", () => {
  browser({ supported: false })
  assert.equal(isReadAloudSupported(), false)
  const view = render(ReadAloudButton, { text: TEXT })
  const [button] = buttons(view)
  assert.equal(button.props["aria-disabled"], true)
  assert.notEqual(button.props.disabled, true, "a disabled button leaves the tab order")
  assert.ok(showing(view).includes("VolumeX"))
  assert.ok(
    button.props.children.includes("Reading aloud isn't supported here"),
    "the reason has to be the button's own text, not only a tooltip"
  )
})

test("the live region exists while idle, so its first message is announced", () => {
  browser()
  const view = render(ReadAloudButton, { text: TEXT })
  const region = live(view)
  assert.ok(region, "a live region inserted later is not reliably announced")
  assert.equal(region.props["aria-live"], "polite")
  assert.ok(region.props.className.includes("sr-only"))
})

test("pressing play speaks the first sentence and does not yet claim to be reading", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  assert.deepEqual(b.texts(), ["One two three."])
  // Measured 51ms between `speak()` returning and `start` arriving, with `speechSynthesis.speaking`
  // already true for all of it.
  assert.equal(buttons(view)[0].props["data-status"], "starting")
  assert.equal(buttons(view)[0].props["aria-busy"], true)
  assert.ok(showing(view).includes("Loader2"))
  assert.equal(live(view).props.children, "")
})

test("the engine's start event is what turns the button into a pause control", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  assert.equal(buttons(view)[0].props["data-status"], "speaking")
  assert.ok(showing(view).includes("Pause"))
  assert.equal(live(view).props.children, "Reading aloud")
})

test("each sentence is spoken when the one before it ends", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  b.fireEnd()
  view.rerender()
  assert.deepEqual(b.texts(), ["One two three.", "Four five six."])
  b.fireStart()
  b.fireEnd()
  view.rerender()
  assert.deepEqual(b.texts(), ["One two three.", "Four five six.", "Seven eight nine."])
})

test("finishing the last sentence reports done and goes quiet", () => {
  const b = browser()
  const done = []
  const view = render(ReadAloudButton, { text: TEXT, onDone: () => done.push(true) })
  press(view)
  for (let i = 0; i < 3; i++) {
    b.fireStart()
    b.fireEnd()
    view.rerender()
  }
  assert.equal(b.spoken.length, 3, "nothing is spoken past the end of the text")
  assert.deepEqual(done, [true])
  assert.equal(buttons(view)[0].props["data-status"], "idle")
  assert.equal(buttons(view)[1], undefined, "and there is nothing left to stop")
  assert.equal(live(view).props.children, "")
})

test("stop ends the reading instead of pausing it", () => {
  // The defect this guards: the chain advances in `end`, so a stop that only cancels gets the next
  // sentence started a tick later by the event its own cancel produced.
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  const stop = buttons(view)[1]
  assert.equal(stop.props["aria-label"], "Stop")
  stop.props.onClick({})
  view.rerender()
  assert.equal(b.countOf("cancel") > 0, true)
  // Whatever the engine delivers for the utterance that was abandoned, nothing may follow it.
  b.fireEnd()
  b.fireError("interrupted")
  view.rerender()
  assert.deepEqual(b.texts(), ["One two three."])
  assert.equal(buttons(view)[0].props["data-status"], "idle")
})

test("pressing stop does not put an error on screen", () => {
  // Measured: `cancel()` delivers `error: "interrupted"`, never `end`. Reporting every error means
  // a failure message every single time the user stops.
  const b = browser()
  const failures = []
  const view = render(ReadAloudButton, { text: TEXT, onFailure: (f) => failures.push(f.cause) })
  press(view)
  b.fireStart()
  view.rerender()
  buttons(view)[1].props.onClick({})
  b.fireError("interrupted")
  view.rerender()
  assert.deepEqual(failures, [])
  assert.equal(live(view).props.children, "")
  assert.equal(buttons(view)[0].props["data-cause"], undefined)
})

test("being interrupted by something else on the page is reported and stops the reading", () => {
  const b = browser()
  const failures = []
  const view = render(ReadAloudButton, { text: TEXT, onFailure: (f) => failures.push(f.cause) })
  press(view)
  b.fireStart()
  view.rerender()
  b.fireError("interrupted")
  view.rerender()
  assert.deepEqual(failures, ["interrupted"])
  assert.equal(buttons(view)[0].props["data-status"], "idle")
  assert.deepEqual(b.texts(), ["One two three."], "the chain does not carry on past an interruption")
})

test("a real failure is shown, mapped to its cause, and keeps the button reachable", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireError("voice-unavailable")
  view.rerender()
  const [button] = buttons(view)
  assert.equal(button.props["data-cause"], "voice-unavailable")
  assert.equal(button.props["aria-disabled"], true, "a retry that cannot work is not offered")
  assert.notEqual(button.props.disabled, true)
  assert.ok(showing(view).includes("TriangleAlert"))
  assert.equal(live(view).props.children, "No voice is available for this language.")
})

test("a retryable failure leaves play pressable", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireError("network")
  view.rerender()
  assert.equal(buttons(view)[0].props["aria-disabled"], undefined)
  assert.equal(buttons(view)[0].props["data-cause"], "network")
  press(view)
  assert.equal(b.texts().length, 2, "play starts a fresh reading")
})

test("pausing waits for the engine to confirm it", () => {
  const b = browser()
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  press(view)
  assert.ok(b.calls.includes("pause"))
  // Measured 5ms before the `pause` event arrives. Until it does, nothing is known to have changed.
  assert.equal(buttons(view)[0].props["data-status"], "speaking")
  b.firePause()
  view.rerender()
  assert.equal(buttons(view)[0].props["data-status"], "paused")
  assert.ok(showing(view).includes("Play"))
  assert.equal(live(view).props.children, "Paused")
})

test("a paused reading is not a reading, whatever speechSynthesis.speaking says", () => {
  const b = browser()
  let seen = null
  const Probe = ({ text }) => {
    const state = useReadAloud({ text })
    seen = state
    return null
  }
  const view = render(Probe, { text: TEXT })
  seen.start(0)
  view.rerender()
  b.fireStart()
  view.rerender()
  seen.pause()
  b.firePause()
  view.rerender()
  assert.equal(globalThis.window.speechSynthesis.speaking, true, "the platform flag stays true")
  assert.equal(globalThis.window.speechSynthesis.paused, true)
  assert.equal(seen.isSpeaking, false)
  assert.equal(seen.isPaused, true)
  seen.resume()
  b.fireResume()
  view.rerender()
  assert.equal(seen.isSpeaking, true)
  view.unmount()
})

test("the voices that arrive after the first render are the ones used", () => {
  // The first getVoices() was measured to return 0, nine milliseconds before the real list.
  const b = browser({ voicesReady: false })
  const view = render(ReadAloudButton, { text: TEXT, lang: "en-GB" })
  b.loadVoices()
  view.rerender()
  press(view)
  assert.equal(b.at().voice.name, "Daniel")
  assert.equal(b.at().lang, "en-GB")
})

test("a voice is still found when voiceschanged never fires", () => {
  // The list is read again at the moment of speaking, which costs nothing and is the only thing
  // that works in an engine that populates lazily without announcing it.
  const b = browser({ voicesReady: false })
  const view = render(ReadAloudButton, { text: TEXT, lang: "en-GB" })
  globalThis.window.speechSynthesis.getVoices = () => VOICES
  press(view)
  assert.equal(b.at().voice.name, "Daniel")
})

test("the page's own language decides the voice when none is given", () => {
  const b = browser({ voicesReady: true, documentLang: "it-IT" })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  assert.equal(b.at().lang, "it-IT")
  assert.equal(b.at().voice.name, "Alice")
})

test("rate, pitch and volume reach the utterance", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT, rate: 1.4, pitch: 0.8, volume: 0.5 })
  press(view)
  assert.equal(b.at().rate, 1.4)
  assert.equal(b.at().pitch, 0.8)
  assert.equal(b.at().volume, 0.5)
})

test("boundary events report a position in the whole text, not in the sentence", () => {
  const b = browser({ voicesReady: true })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  seen.start(1)
  view.rerender()
  b.fireStart()
  b.fireBoundary(5)
  view.rerender()
  // Sentence two starts at offset 15, so word-offset 5 inside it is offset 20 of the passage.
  assert.equal(seen.charIndex, 20)
  assert.equal(TEXT.slice(seen.charIndex, seen.charIndex + 4), "five")
  b.at().onboundary?.({})
  view.rerender()
  assert.equal(seen.charIndex, 15, "an offset-less boundary is the head of the sentence")
  view.unmount()
})

test("reading can start from a chosen sentence", () => {
  const b = browser({ voicesReady: true })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  seen.start(2)
  view.rerender()
  assert.deepEqual(b.texts(), ["Seven eight nine."])
  assert.equal(seen.chunkIndex, 2)
  view.unmount()
})

test("the progress counter is shown but never announced", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT, showProgress: true })
  press(view)
  b.fireStart()
  view.rerender()
  const counter = nodes(view).find((n) => n.type === "span" && n.props?.["aria-hidden"] === "true")
  assert.ok(counter, "the counter must be outside the live region")
  assert.equal(counter.props.children.join(""), "1 / 3")
  // A polite region rewritten once per sentence queues an announcement for every sentence and reads
  // them over the passage itself.
  assert.equal(live(view).props.children, "Reading aloud")
})

test("text with nothing speakable in it reports why instead of pretending to read", () => {
  const b = browser({ voicesReady: true })
  const failures = []
  const view = render(ReadAloudButton, { text: "   ", onFailure: (f) => failures.push(f) })
  press(view)
  view.rerender()
  assert.deepEqual(b.texts(), [])
  assert.deepEqual(failures.map((f) => f.cause), ["nothing-to-read"])
  assert.equal(failures[0].retryable, false, "the same empty text will be just as empty next time")
  assert.equal(live(view).props.children, "There's nothing here to read.")
})

test("unmounting stops the voice", () => {
  // In a single-page app nothing else will: the voice is not attached to the component, so the
  // previous article is read over the new page with no control anywhere that can stop it.
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  const before = b.countOf("cancel")
  view.unmount()
  assert.ok(b.countOf("cancel") > before)
})

test("unmounting a component that is not speaking leaves the page's voice alone", () => {
  // `cancel()` is page-wide. Without an owner, closing a dialog silences the article behind it.
  const b = browser({ voicesReady: true })
  const speaker = render(ReadAloudButton, { text: TEXT })
  press(speaker)
  b.fireStart()
  speaker.rerender()
  const bystander = render(ReadAloudButton, { text: "Something else entirely." })
  const before = b.countOf("cancel")
  bystander.unmount()
  assert.equal(b.countOf("cancel"), before)
  // And the one that is actually speaking can still be stopped.
  press(speaker, 1)
  assert.ok(b.countOf("cancel") > before)
  speaker.unmount()
})

test("stop on a component that never spoke does not cancel the page's speech", () => {
  const b = browser({ voicesReady: true })
  const speaker = render(ReadAloudButton, { text: TEXT })
  press(speaker)
  b.fireStart()
  speaker.rerender()
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const bystander = render(Probe, { text: "Other text." })
  const before = b.countOf("cancel")
  seen.stop()
  seen.pause()
  seen.resume()
  assert.equal(b.countOf("cancel"), before)
  assert.equal(b.calls.filter((c) => c === "pause").length, 0)
  bystander.unmount()
  speaker.unmount()
})

test("replacing the text stops a reading of the old text", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  const before = b.countOf("cancel")
  view.update({ text: "A completely different passage." })
  assert.ok(b.countOf("cancel") > before)
  assert.equal(buttons(view)[0].props["data-status"], "idle")
  b.fireEnd()
  view.rerender()
  assert.deepEqual(b.texts(), ["One two three."], "the old chain does not continue into new text")
})

test("a consumer's own click handler can refuse the press", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT, onClick: () => {} })
  buttons(view)[0].props.onClick({ defaultPrevented: true })
  view.rerender()
  assert.deepEqual(b.texts(), [])
})

test("each sentence is announced to the consumer as it starts", () => {
  const b = browser({ voicesReady: true })
  const seen = []
  const view = render(ReadAloudButton, {
    text: TEXT,
    onChunkChange: (index, chunk) => seen.push([index, chunk.text]),
  })
  press(view)
  b.fireStart()
  b.fireEnd()
  view.rerender()
  b.fireStart()
  view.rerender()
  assert.deepEqual(seen, [
    [0, "One two three."],
    [1, "Four five six."],
  ])
})

test("icon-only keeps the action in the accessible name", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT, iconOnly: true })
  assert.equal(buttons(view)[0].props["aria-label"], "Listen")
  press(view)
  b.fireStart()
  view.rerender()
  assert.equal(buttons(view)[0].props["aria-label"], "Pause")
  // No aria-pressed: the action changes between three verbs rather than toggling one setting, and
  // "Listen, pressed" is the wrong thing to hear while reading is paused.
  assert.equal(buttons(view)[0].props["aria-pressed"], undefined)
  view.unmount()
})

test("renders on the server, where there is no window at all", () => {
  // Not the same as a browser without speech: `typeof window === "undefined"` is the shape SSR has,
  // and a module that reaches for the global at import time throws before anything can render.
  browser()
  const saved = globalThis.window
  const savedDocument = globalThis.document
  // eslint-disable-next-line no-undef
  delete globalThis.window
  // eslint-disable-next-line no-undef
  delete globalThis.document
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true })
  try {
    assert.equal(isReadAloudSupported(), false)
    const view = render(ReadAloudButton, { text: TEXT })
    const [button] = buttons(view)
    assert.equal(button.props["aria-disabled"], true)
    assert.equal(button.props["data-status"], "unsupported")
    assert.ok(showing(view).includes("VolumeX"))
  } finally {
    globalThis.window = saved
    globalThis.document = savedDocument
  }
})

test("pressing again before the voice starts drops the reading rather than pausing it", () => {
  // `pause()` acts on a queue that has not begun, and nothing promises a `start` will arrive to be
  // paused — the button would sit on "Starting…" with the engine paused underneath it.
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  assert.equal(buttons(view)[0].props["data-status"], "starting")
  press(view)
  assert.equal(b.calls.filter((c) => c === "pause").length, 0)
  assert.ok(b.countOf("cancel") > 0)
  assert.equal(buttons(view)[0].props["data-status"], "idle")
})

test("an index that is out of range, or not a number, still reads something", () => {
  // `Math.max(0, NaN)` is NaN, which walks straight past a clamp and into the array.
  const b = browser({ voicesReady: true })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  seen.start(99)
  view.rerender()
  assert.deepEqual(b.texts(), ["Seven eight nine."])
  seen.start(Number.NaN)
  view.rerender()
  assert.equal(b.at().text, "One two three.")
  seen.start(-4)
  view.rerender()
  assert.equal(b.at().text, "One two three.")
  view.unmount()
})

// --- the defaults, which nothing above ever exercised ----------------------

test("rate, pitch and volume default to the voice's own", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  assert.equal(b.at().rate, 1)
  assert.equal(b.at().pitch, 1)
  assert.equal(b.at().volume, 1)
})

test("start() with no argument begins at the first sentence", () => {
  const b = browser({ voicesReady: true })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  assert.equal(seen.chunkIndex, -1, "nothing is current while idle")
  seen.start()
  view.rerender()
  assert.deepEqual(b.texts(), ["One two three."])
  assert.equal(seen.chunkIndex, 0)
  view.unmount()
})

test("the voice is given up when the passage finishes", () => {
  // Otherwise the component holds the page's voice for as long as it stays mounted, and its own
  // stop button cancels speech that now belongs to something else.
  const b = browser({ voicesReady: true })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  seen.start()
  view.rerender()
  for (let i = 0; i < 3; i++) {
    b.fireStart()
    b.fireEnd()
    view.rerender()
  }
  assert.equal(seen.chunkIndex, -1, "no sentence is current once the passage is done")
  assert.equal(seen.charIndex, null)
  const after = b.countOf("cancel")
  seen.stop()
  assert.equal(b.countOf("cancel"), after, "a finished reader no longer owns the voice")
  view.unmount()
})

test("resume on a component that is not speaking does not restart somebody else's passage", () => {
  const b = browser({ voicesReady: true })
  const speaker = render(ReadAloudButton, { text: TEXT })
  press(speaker)
  b.fireStart()
  speaker.rerender()
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const bystander = render(Probe, { text: "Other text." })
  seen.resume()
  seen.pause()
  assert.equal(b.countOf("resume"), 0)
  assert.equal(b.countOf("pause"), 0)
  bystander.unmount()
  speaker.unmount()
})

// --- feature detection and language fallback -------------------------------

test("speaking needs both halves of the API, not just one", () => {
  browser()
  delete globalThis.window.SpeechSynthesisUtterance
  assert.equal(isReadAloudSupported(), false, "a synth with no utterance constructor cannot speak")
  browser()
  delete globalThis.window.speechSynthesis
  assert.equal(isReadAloudSupported(), false)
})

test("the language falls back to the browser's, then to a known tag", () => {
  const b = browser({ voicesReady: true, documentLang: "" })
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "fr-CA" },
    configurable: true,
    writable: true,
  })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  assert.equal(b.at().lang, "fr-CA")

  const b2 = browser({ voicesReady: true, documentLang: "" })
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true })
  const view2 = render(ReadAloudButton, { text: TEXT })
  press(view2)
  assert.equal(b2.at().lang, "en-US")
})

test("an exact tag is taken even when only a remote voice has it", () => {
  // The order is exact-local, exact-remote, subtag-local, subtag-remote: a voice that speaks the
  // asked-for variant is worth a network round trip, a voice for a different region is not.
  const voices = [voice("Near", "en-US"), voice("Far", "en-GB", { local: false })]
  assert.equal(pickVoice(voices, "en-GB").name, "Far")
})

test("the other two ideographic terminators end a sentence too", () => {
  assert.deepEqual(
    splitForSpeech("本当ですか？はい！わかりました。").map((c) => c.text),
    ["本当ですか？", "はい！", "わかりました。"]
  )
})

// --- what the button actually renders --------------------------------------

test("both controls are type=button, so neither submits a form it sits in", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  assert.equal(buttons(view)[0].props.type, "button")
  press(view)
  b.fireStart()
  view.rerender()
  for (const button of buttons(view)) assert.equal(button.props.type, "button")
})

test("no icon is announced", () => {
  // A screen reader reading "volume two" over a passage being read aloud is the whole problem.
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  const drawn = iconsIn(view)
  assert.ok(drawn.length >= 2)
  for (const node of drawn) assert.equal(node.props["aria-hidden"], "true")
})

test("the stop button is not there when there is nothing to stop", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  assert.equal(buttons(view).length, 1)
  press(view)
  assert.equal(buttons(view).length, 2, "stop is offered as soon as play was pressed")
  b.fireStart()
  view.rerender()
  assert.equal(buttons(view).length, 2)
  b.firePause()
  view.rerender()
  assert.equal(buttons(view).length, 2, "a paused passage can still be abandoned")
  buttons(view)[1].props.onClick({})
  view.rerender()
  assert.equal(buttons(view).length, 1)
})

test("the status line is visible by default and the counter is not", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  assert.ok(!live(view).props.className.includes("sr-only"), "the default is a line people can see")
  assert.equal(
    nodes(view).find((n) => n.type === "span" && n.props?.["aria-hidden"] === "true"),
    undefined,
    "the sentence counter is opt-in"
  )
  const hidden = render(ReadAloudButton, { text: TEXT, hideMessage: true })
  press(hidden)
  b.fireStart()
  hidden.rerender()
  assert.ok(live(hidden).props.className.includes("sr-only"), "and it can be taken off the screen")
  assert.equal(live(hidden).props.children, "Reading aloud", "while still being announced")
})

test("the button names the action it will take in each state", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  const labelOf = () => buttons(view)[0].props.children.filter((c) => typeof c === "string")[0]
  assert.equal(labelOf(), "Listen")
  press(view)
  assert.equal(labelOf(), "Starting…")
  assert.ok(iconsIn(view)[0].props.className.includes("animate-spin"), "the wait is shown as a wait")
  b.fireStart()
  view.rerender()
  assert.equal(labelOf(), "Pause")
  b.firePause()
  view.rerender()
  assert.equal(labelOf(), "Resume")
  b.fireResume()
  view.rerender()
  assert.equal(labelOf(), "Pause")
})

test("an interruption is not written into the live region", () => {
  // It is reported to the consumer, but the person listening did not do anything wrong and has
  // nothing to fix — something else on the page took the voice.
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  b.fireError("interrupted")
  view.rerender()
  assert.equal(live(view).props.children, "")
  assert.equal(buttons(view)[0].props["aria-describedby"], undefined)
})

// --- the two lookup tables, pinned entry by entry --------------------------

test("every error code the specification defines is mapped, and says whether retrying can help", () => {
  // The table is the component's answer to "what do I tell the user, and do I offer the button
  // again" — a wrong row is a dead retry button or a silent standing failure, and neither shows up
  // anywhere else.
  const expected = [
    ["canceled", "interrupted", true],
    ["interrupted", "interrupted", true],
    ["audio-busy", "audio-unavailable", true],
    ["audio-hardware", "audio-unavailable", true],
    ["network", "network", true],
    ["synthesis-unavailable", "synthesis-failed", true],
    ["synthesis-failed", "synthesis-failed", true],
    ["language-unavailable", "voice-unavailable", false],
    ["voice-unavailable", "voice-unavailable", false],
    ["text-too-long", "text-too-long", false],
    ["invalid-argument", "invalid-argument", false],
    ["not-allowed", "not-allowed", false],
    ["something-new-from-the-platform", "unknown", true],
  ]
  for (const [code, cause, retryable] of expected) {
    const b = browser({ voicesReady: true })
    const seen = []
    const view = render(ReadAloudButton, { text: TEXT, onFailure: (f) => seen.push(f) })
    press(view)
    b.fireStart()
    view.rerender()
    b.fireError(code)
    view.rerender()
    assert.equal(seen.length, 1, `${code} produced ${seen.length} failures`)
    assert.equal(seen[0].cause, cause, `${code} should mean ${cause}`)
    assert.equal(seen[0].code, code, "the engine's own code is passed through")
    assert.equal(seen[0].retryable, retryable, `${code} retryable`)
    assert.ok(seen[0].message.length > 10, `${cause} needs wording of its own`)
    // Every cause but the interruption is something to say out loud.
    assert.equal(live(view).props.children === "", cause === "interrupted")
  }
})

test("none of the stops that do not end a sentence ends one", () => {
  // Pinned word by word: the table is the whole behaviour, and an entry quietly dropped from it
  // splits somebody's paragraph in the middle of a name.
  const abbreviations = [
    "Mr", "Mrs", "Ms", "Mx", "Dr", "Prof", "Sr", "Jr", "St", "Rev", "Hon", "Gen", "Col", "Sgt",
    "Capt", "Lt", "vs", "etc", "eg", "ie", "al", "cf", "viz", "approx", "est", "dept", "univ",
    "Inc", "Ltd", "Co", "Corp", "plc", "fig", "figs", "no", "nos", "vol", "vols", "pp", "ed",
    "eds", "ca", "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov",
    "Dec", "Mon", "Tue", "Tues", "Wed", "Thu", "Thur", "Thurs", "Fri", "Sat", "Sun",
  ]
  for (const word of abbreviations) {
    const text = `Ask ${word}. Then leave.`
    assert.deepEqual(
      splitForSpeech(text).map((c) => c.text),
      [text],
      `"${word}." was read as the end of a sentence`
    )
  }
  // And the control: an ordinary word in the same position does end one.
  assert.deepEqual(
    splitForSpeech("Ask Dennis. Then leave.").map((c) => c.text),
    ["Ask Dennis.", "Then leave."]
  )
})

// --- the edges the mutation run found nothing holding ----------------------

test("an idle button says so from the first render", () => {
  browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  assert.equal(buttons(view)[0].props["data-status"], "idle")
})

test("one voice in the list is still a voice", () => {
  assert.equal(pickVoice([voice("Only", "en-GB")], "en-GB").name, "Only")
  assert.equal(pickVoice([voice("Only", "ja-JP")], "en-GB"), null)
})

test("the voice list itself is updated when the browser announces it", () => {
  // Reading the list again at speak time covers a browser that never announces, so it hides a
  // subscription that was never made — which the consumer sees as an empty voice picker.
  const b = browser({ voicesReady: false })
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text, lang: "en-GB" })
    return null
  }
  const view = render(Probe, { text: TEXT })
  assert.deepEqual(seen.voices, [])
  assert.equal(seen.voice, null)
  b.loadVoices()
  view.rerender()
  assert.equal(seen.voices.length, VOICES.length)
  assert.equal(seen.voice.name, "Daniel")
  assert.ok(b.subscribed.includes("voiceschanged"), "the list arrives on this event and no other")
  view.unmount()
})

test("a short word before an exclamation mark still ends the sentence", () => {
  // The abbreviation and list-marker rules belong to the full stop alone; "!" and "?" are never
  // part of a word, so nothing may send them through that lookup.
  assert.deepEqual(splitForSpeech("Go! Now.").map((c) => c.text), ["Go!", "Now."])
  assert.deepEqual(splitForSpeech("Up? Yes.").map((c) => c.text), ["Up?", "Yes."])
})

test("a one-character passage is a passage", () => {
  assert.deepEqual(splitForSpeech("x").map((c) => c.text), ["x"])
})

test("a chunk size of zero is read as the smallest one, not as no limit", () => {
  // A limit of zero makes the backstop unable to advance; a consumer computing it from a setting
  // should get the smallest workable split rather than a page that stops responding.
  const chunks = splitForSpeech("abc def", { maxChars: 0 })
  assert.ok(chunks.length > 0)
  assert.equal(chunks.map((c) => c.text).join(""), "abcdef")
})

test("a sentence that is exactly the limit is left whole", () => {
  const sentence = "123456789 123456789 12345678."
  assert.equal(sentence.length, 29)
  assert.deepEqual(splitForSpeech(sentence, { maxChars: 29 }).map((c) => c.text), [sentence])
})

test("a passage that opens with a blank line still reads from the top", () => {
  assert.deepEqual(splitForSpeech("\n\nFirst line.\n\nSecond.").map((c) => c.text), ["First line.", "Second."])
})

test("a stop inside two closing marks still ends the sentence", () => {
  assert.deepEqual(
    splitForSpeech('She wrote ("stop.") Then she left.').map((c) => c.text),
    ['She wrote ("stop.")', "Then she left."]
  )
})

test("half the speech API is not enough to offer the button", () => {
  const b = browser({ voicesReady: true })
  delete globalThis.window.SpeechSynthesisUtterance
  let seen = null
  const Probe = ({ text }) => {
    seen = useReadAloud({ text })
    return null
  }
  const view = render(Probe, { text: TEXT })
  const failures = []
  seen.start()
  view.rerender()
  assert.deepEqual(b.texts(), [], "nothing was handed to an engine that cannot take it")
  assert.equal(seen.failure.cause, "unsupported")
  assert.equal(seen.failure.retryable, false)
  assert.equal(failures.length, 0)
  view.unmount()
})

test("an error with no code of its own is still reported", () => {
  const b = browser({ voicesReady: true })
  const seen = []
  const view = render(ReadAloudButton, { text: TEXT, onFailure: (f) => seen.push(f) })
  press(view)
  b.fireStart()
  view.rerender()
  b.at().onerror?.({})
  view.rerender()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cause, "unknown")
  assert.equal(seen[0].code, "unknown")
})

test("pressing the button while paused is what resumes it", () => {
  const b = browser({ voicesReady: true })
  const view = render(ReadAloudButton, { text: TEXT })
  press(view)
  b.fireStart()
  view.rerender()
  press(view)
  b.firePause()
  view.rerender()
  press(view)
  assert.equal(b.countOf("resume"), 1)
  b.fireResume()
  view.rerender()
  assert.equal(buttons(view)[0].props["data-status"], "speaking")
})
