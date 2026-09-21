"use client"

import * as React from "react"
import { Loader2, Mic, MicOff, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The bits of the Web Speech API this component actually touches, written out by hand.
 *
 * Two reasons not to lean on the DOM typings. The prefixed constructor — which is still the only
 * one several shipping browsers have — is not declared anywhere, so `window.webkitSpeechRecognition`
 * does not type-check at all. And the unprefixed one drifts: it arrived in `lib.dom.d.ts` only
 * recently, so a consumer on an older TypeScript gets a file that compiles here and not for them.
 * Declaring the surface locally makes the component's dependency on the platform explicit and
 * fixed: these are the properties it sets and the four events it listens to, and nothing else.
 */
interface RecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface RecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: RecognitionAlternative
}

interface RecognitionResultList {
  readonly length: number
  readonly [index: number]: RecognitionResult
}

interface RecognitionResultEvent {
  /** Index of the first result this event changed. See the note in `handleResult`. */
  readonly resultIndex: number
  /** Every result of the **current session**, not of the recording. That distinction is load-bearing. */
  readonly results: RecognitionResultList
}

interface RecognitionErrorEvent {
  readonly error: string
  readonly message?: string
}

interface RecognitionInstance {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onresult: ((event: RecognitionResultEvent) => void) | null
}

type RecognitionConstructor = new () => RecognitionInstance

/**
 * The constructor, prefixed or not, or null where there isn't one.
 *
 * `webkitSpeechRecognition` is not a legacy alias to be tidied away: at the time of writing it is
 * the spelling Chrome, Edge and Safari expose, and a component that only reads the unprefixed name
 * is a component that does nothing in every browser that has the feature. Firefox has neither
 * unless the user has turned it on themselves, which is why "unsupported" below is a first-class
 * state with its own copy rather than an afterthought.
 */
function recognitionConstructorOf(): RecognitionConstructor | null {
  if (typeof window === "undefined") return null
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor
    webkitSpeechRecognition?: RecognitionConstructor
  }
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition
  return typeof ctor === "function" ? ctor : null
}

/** Whether speech recognition exists in this browser at all. */
export function isSpeechInputSupported(): boolean {
  return recognitionConstructorOf() !== null
}

/**
 * Whether this page is a non-secure context, where the microphone is refused without asking.
 *
 * Worth checking before calling rather than after failing, because the failure is indistinguishable
 * from the user having pressed Block: both arrive as `not-allowed`. On the http staging box on an
 * internal IP no prompt ever appears, and a component that maps that code to "allow the microphone
 * in your browser settings" sends everybody hunting for a switch that is not the problem and cannot
 * fix it.
 */
function insecureContext(): boolean {
  // A browser old enough to lack `isSecureContext` must not be read as insecure — that would refuse
  // to work on the very browsers this is meant to degrade for.
  return typeof window !== "undefined" && window.isSecureContext === false
}

/**
 * Whether Permissions Policy forbids the microphone in this document, where that can be asked.
 *
 * The second producer of an unexplained `not-allowed`. The default allowlist for `microphone` is
 * `'self'`, so an `<iframe>` embedding this page without `allow="microphone"` is refused, as is any
 * origin serving `Permissions-Policy: microphone=()`. Neither is something the person looking at
 * the screen can do anything about, and neither shows a prompt.
 *
 * Best effort: the accessor is absent outside Chromium and is not in the DOM typings, so false
 * means "not known to be blocked", never "allowed".
 */
function blockedByPermissionsPolicy(): boolean {
  if (typeof document === "undefined") return false
  type Policy = { allowsFeature?: (feature: string) => boolean }
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy }
  const policy = doc.permissionsPolicy ?? doc.featurePolicy
  if (!policy || typeof policy.allowsFeature !== "function") return false
  try {
    return !policy.allowsFeature("microphone")
  } catch {
    return false
  }
}

/**
 * Reads the stored microphone permission without prompting, or null where that cannot be asked.
 *
 * This is what makes it possible to tell the four different things `not-allowed` means apart. The
 * only other way to learn the permission state is to start recognition, and that *acts* — it can
 * put a prompt in front of somebody who never asked for one.
 *
 * Guarded twice: `navigator.permissions` is declared non-optional by TypeScript and is genuinely
 * absent in older browsers, and a browser that has the Permissions API may still not recognise the
 * `microphone` descriptor, in which case `query` rejects instead of answering. Not knowing is an
 * ordinary answer here, and every path below works without it.
 */
async function queryMicrophonePermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !("permissions" in navigator)) return null
  const permissions: Permissions | undefined = navigator.permissions
  if (!permissions || typeof permissions.query !== "function") return null
  try {
    return await permissions.query({ name: "microphone" as PermissionName })
  } catch {
    return null
  }
}

/**
 * The page's own language, which is what dictation should be transcribed in.
 *
 * Left unset, `lang` is resolved by the user agent, and the specification does not pin down how —
 * so the one configuration whose behaviour cannot be predicted across browsers is the one you get
 * by not configuring it. Resolving it here from the document makes the answer defined everywhere:
 * a page that declares `<html lang="ja">` dictates Japanese regardless of what language the
 * browser's own menus are in.
 */
function documentLanguage(): string {
  if (typeof document !== "undefined") {
    const declared = document.documentElement?.lang
    if (declared) return declared
  }
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language
  return "en-US"
}

/**
 * Why recognition stopped or refused to start.
 *
 * Four of these arrive as the identical `not-allowed` and need four different things from three
 * different people: `denied` is the user's own stored choice, `dismissed` is a prompt closed
 * without an answer, and `insecure-context` and `blocked-by-policy` are the developer's to fix and
 * are invisible to the user.
 */
export type SpeechInputFailureCause =
  | "unsupported"
  | "insecure-context"
  | "blocked-by-policy"
  | "denied"
  | "dismissed"
  | "service-not-allowed"
  | "no-microphone"
  | "network"
  | "no-speech"
  | "language-not-supported"
  | "bad-grammar"
  | "unknown"

export interface SpeechInputFailure {
  cause: SpeechInputFailureCause
  /** The browser's own error code, or null when this was settled before recognition started. */
  code: string | null
  /** Wording safe to show as-is. Override per cause with the `messages` prop. */
  message: string
  /**
   * Whether pressing the button again, right now, can produce a different result.
   *
   * False for `denied` is the point. Once the microphone is blocked for an origin the browser
   * refuses without prompting, so a "Try again" is a button that cannot work — it returns the same
   * error instantly for as long as the page is open. The only way out runs through the browser's
   * own site settings, which is what the copy for that case says, and why the permission `change`
   * listener below exists so that coming back from those settings costs nothing.
   */
  retryable: boolean
}

/**
 * Where recording has got to.
 *
 * `prompting` and `listening` are split because conflating them is the specific lie this component
 * exists to avoid: a button that says "Listening…" while the browser's microphone dialog is still
 * sitting there unanswered is describing something that is not happening. `starting` is the same
 * wait where the Permissions API could not tell us a prompt was coming.
 */
export type SpeechInputStatus =
  | "unsupported"
  | "idle"
  | "prompting"
  | "starting"
  | "listening"
  | "stopping"

/**
 * The error codes worth starting a fresh session for while the user is still holding the button on.
 *
 * Everything else is a standing condition — no microphone attached, the origin blocked, the
 * language unavailable — where restarting produces the same error immediately and forever. Read
 * synchronously in the `error` handler because `end` follows within the same tick and has to know
 * whether to restart before any async permission lookup could answer.
 */
const RESTARTABLE_CODES = new Set(["no-speech", "network"])

const RETRYABLE: Record<SpeechInputFailureCause, boolean> = {
  unsupported: false,
  "insecure-context": false,
  "blocked-by-policy": false,
  denied: false,
  dismissed: true,
  "service-not-allowed": false,
  "no-microphone": true,
  network: true,
  "no-speech": true,
  "language-not-supported": false,
  "bad-grammar": false,
  unknown: true,
}

const DEFAULT_MESSAGES: Record<SpeechInputFailureCause, string> = {
  unsupported: "This browser can't transcribe speech.",
  "insecure-context":
    "Dictation needs a secure (https) connection, so the browser refused without asking.",
  "blocked-by-policy": "This page isn't permitted to use the microphone.",
  denied:
    "The microphone is blocked for this site. Allow it in your browser's site settings — this page can't ask again.",
  dismissed: "The microphone request was dismissed.",
  "service-not-allowed": "This browser's speech service refused the request.",
  "no-microphone": "No microphone was available.",
  network: "The speech service couldn't be reached.",
  "no-speech": "Nothing was heard — try speaking again.",
  "language-not-supported": "That language isn't available for dictation here.",
  "bad-grammar": "The speech grammar couldn't be used.",
  unknown: "Dictation stopped unexpectedly.",
}

/** Maps a spec error code to a cause. `not-allowed` is resolved separately; it means four things. */
function causeForCode(code: string): SpeechInputFailureCause {
  switch (code) {
    case "service-not-allowed":
      return "service-not-allowed"
    case "audio-capture":
      return "no-microphone"
    case "network":
      return "network"
    case "no-speech":
      return "no-speech"
    case "language-not-supported":
      return "language-not-supported"
    case "bad-grammar":
      return "bad-grammar"
    default:
      return "unknown"
  }
}

/**
 * Adds a recognised chunk to text that is already there, the way a person would have typed it.
 *
 * Exported because it is the part a consumer is most likely to want to override, and because it is
 * where the naive version goes wrong. `value + transcript` is what everybody writes first, and it
 * produces "book a tabletomorrow at six": the service hands back a bare phrase with no leading
 * space, so every chunk after the first is welded onto the previous word. Padding unconditionally
 * with a space is the other half of the same bug — it yields "tomorrow ." for a dictated full stop,
 * and a stray leading space in a field that was empty.
 */
export function appendTranscript(base: string, chunk: string): string {
  const addition = chunk.trim()
  if (!addition) return base
  if (!base) return addition
  if (/\s$/.test(base)) return base + addition
  // Punctuation and closing brackets belong to the word before them, never after a space.
  if (/^[,.!?;:…)\]}%'"]/.test(addition)) return base + addition
  return base + " " + addition
}

export interface UseSpeechInputOptions {
  /**
   * BCP 47 tag to transcribe in. Defaults to the document's own `lang`.
   *
   * Applied when a session starts, so changing it mid-recording takes effect on the next one.
   */
  lang?: string
  /**
   * Keep listening across pauses until stopped, rather than ending after one utterance.
   *
   * This is more than the flag of the same name on the platform object. The browser ends a session
   * on its own — after a stretch of silence, and after a while regardless — so "keep listening" is
   * only true if somebody starts a new session when that happens. That is what the `end` handler
   * below does, and `maxSilentRestarts` is what stops it spinning.
   */
  continuous?: boolean
  /** Report unconfirmed words as they are heard. On by default; see `interimTranscript`. */
  interimResults?: boolean
  /**
   * How many times in a row a restarted session may produce nothing before dictation gives up.
   *
   * The budget exists because the restart loop is otherwise unbounded: a machine with the
   * microphone muted, or a laptop that has gone offline, ends each session instantly with the same
   * error, and a handler that restarts on every `end` turns that into a hot loop that burns battery
   * and, on the browsers whose recognition runs server-side, quota. Any session that produces a
   * result clears the count, so a real pause in the middle of a paragraph never counts against it.
   */
  maxSilentRestarts?: number
  /** Called with each confirmed chunk, already trimmed. The interim text never reaches this. */
  onTranscript?: (chunk: string) => void
  /**
   * Called when recording starts and stops, including when the browser stops it by itself.
   *
   * Not `onChange`: that is a native attribute of `<button>`, so a prop by that name would be
   * spread onto the element as React's change handler as well as read here.
   */
  onRecordingChange?: (recording: boolean) => void
  /**
   * Called when a session fails.
   *
   * Not `onError`: that is a native DOM attribute React defines on every element, so a prop by that
   * name collides with it as soon as these options are spread onto the `<button>`.
   */
  onFailure?: (failure: SpeechInputFailure) => void
}

export interface UseSpeechInputResult {
  /** Where recording has got to, driven by the browser's own events rather than by the last click. */
  status: SpeechInputStatus
  /**
   * What the user asked for, which is not the same as what the browser is doing.
   *
   * Stays true across the gap between one session ending and the next starting, so a continuous
   * dictation does not flicker. Pair it with `status === "listening"` when you want the truth.
   */
  isRecording: boolean
  /** Everything confirmed since recording started. Cleared by `reset()` and by a fresh `start()`. */
  transcript: string
  /**
   * The words currently being guessed at, which the service may still rewrite.
   *
   * Kept separate from `transcript` on purpose, and the reason this hook has two strings instead of
   * one. Interim text is a live guess: "eight" becomes "ate" becomes "eighty" as more audio
   * arrives. Writing it into the field the user is editing means their content changes under them,
   * their undo history fills with words nobody typed, and anything they type themselves lands in
   * the middle of a phrase that is about to be replaced. Show it beside the field as a preview —
   * that is all it is good for — and let `transcript` be the only thing that ever lands in a value.
   */
  interimTranscript: string
  /** Whether the API exists. Starts true so the server and the first client render agree. */
  isSupported: boolean
  /** The last failure, or null. Cleared when recording starts. */
  failure: SpeechInputFailure | null
  /** The stored microphone permission, or "unknown" where the Permissions API can't say. */
  permission: PermissionState | "unknown"
  /** Begin recording. Clears the previous transcript. */
  start: () => void
  /** Stop, keeping whatever the service is still about to confirm. */
  stop: () => void
  /** Stop and throw away anything not yet confirmed. */
  abort: () => void
  /** Start or stop. */
  toggle: () => void
  /** Empty both transcripts without touching recording. */
  reset: () => void
}

/**
 * The whole behaviour, for a control you lay out yourself.
 *
 * One thing to know before shipping this anywhere sensitive: on the browsers that implement speech
 * recognition today it is not necessarily a local computation. The specification allows the audio
 * to be sent to a remote service, and the presence of a `network` error code in the error
 * enumeration is the platform admitting as much — a purely on-device recogniser could not fail that
 * way. Treat a dictated field as data that may have left the device, and say so wherever that
 * matters.
 */
export function useSpeechInput({
  lang,
  continuous = false,
  interimResults = true,
  maxSilentRestarts = 3,
  onTranscript,
  onRecordingChange,
  onFailure,
}: UseSpeechInputOptions = {}): UseSpeechInputResult {
  const [status, setStatus] = React.useState<SpeechInputStatus>("idle")
  const [isRecording, setIsRecording] = React.useState(false)
  const [transcript, setTranscript] = React.useState("")
  const [interimTranscript, setInterimTranscript] = React.useState("")
  const [isSupported, setIsSupported] = React.useState(true)
  const [failure, setFailure] = React.useState<SpeechInputFailure | null>(null)
  const [permission, setPermission] = React.useState<PermissionState | "unknown">("unknown")

  const recognitionRef = React.useRef<RecognitionInstance | null>(null)
  // Whether a session is live in the browser. `start()` throws InvalidStateError if one already is,
  // and the window where that is true is wider than it looks: it stays true after `stop()` until
  // `end` arrives, which is exactly when an eager restart would fire.
  const sessionActiveRef = React.useRef(false)
  // What the user asked for, readable from an event handler that closed over an older render.
  const intentRef = React.useRef(false)
  const committedCountRef = React.useRef(0)
  const silentRestartsRef = React.useRef(0)
  const producedResultRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const permissionRef = React.useRef<PermissionState | "unknown">("unknown")
  const failureRef = React.useRef<SpeechInputFailure | null>(null)
  // The restart path reaches the session opener through this rather than by name. Two reasons: the
  // handlers are attached once and would otherwise pin the first render's closure forever, and a
  // `useCallback` that names itself inside its own initializer has no inferable type.
  const beginSessionRef = React.useRef<(() => void) | null>(null)

  const langRef = React.useRef(lang)
  const continuousRef = React.useRef(continuous)
  const interimResultsRef = React.useRef(interimResults)
  const maxSilentRestartsRef = React.useRef(maxSilentRestarts)
  const onTranscriptRef = React.useRef(onTranscript)
  const onRecordingChangeRef = React.useRef(onRecordingChange)
  const onFailureRef = React.useRef(onFailure)

  // Declared before everything that reads it: under StrictMode the cleanups run and the effects run
  // again, and if this came last the second pass would see `false` and quietly refuse to work.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    langRef.current = lang
    continuousRef.current = continuous
    interimResultsRef.current = interimResults
    maxSilentRestartsRef.current = maxSilentRestarts
    onTranscriptRef.current = onTranscript
    onRecordingChangeRef.current = onRecordingChange
    onFailureRef.current = onFailure
  }, [
    continuous,
    interimResults,
    lang,
    maxSilentRestarts,
    onFailure,
    onRecordingChange,
    onTranscript,
  ])

  React.useEffect(() => {
    const supported = isSpeechInputSupported()
    setIsSupported(supported)
    if (!supported) setStatus("unsupported")
  }, [])

  const setRecording = React.useCallback((next: boolean) => {
    if (intentRef.current === next) return
    intentRef.current = next
    setIsRecording(next)
    onRecordingChangeRef.current?.(next)
  }, [])

  const fail = React.useCallback((cause: SpeechInputFailureCause, code: string | null) => {
    const next: SpeechInputFailure = {
      cause,
      code,
      message: DEFAULT_MESSAGES[cause],
      retryable: RETRYABLE[cause],
    }
    failureRef.current = next
    setFailure(next)
    onFailureRef.current?.(next)
  }, [])

  /**
   * Reads the stored permission and keeps the dead end honest.
   *
   * The `change` event is why this is a subscription rather than one read. Somebody sent to site
   * settings by the `denied` message comes back to a page that is still open, and the browser fires
   * `change` the moment they flip the switch. Handling it is what turns "allow it in your settings"
   * into advice that visibly works; ignoring it leaves the button dead until a reload, which is the
   * point at which people conclude the site is broken.
   */
  React.useEffect(() => {
    let statusHandle: PermissionStatus | null = null
    let cancelled = false

    const handleChange = () => {
      if (!statusHandle) return
      const next = statusHandle.state
      setPermission(next)
      permissionRef.current = next
      if (next === "denied") return
      // No longer blocked, so a `denied` message on screen is now false and leaving it there is
      // worse than never having shown it. Only that one is cleared: a network error or a language
      // that is unavailable has nothing to do with permission and is still true.
      if (failureRef.current?.cause === "denied") {
        failureRef.current = null
        setFailure(null)
      }
    }

    void queryMicrophonePermission().then((result) => {
      if (cancelled || !result) return
      statusHandle = result
      setPermission(result.state)
      permissionRef.current = result.state
      result.addEventListener("change", handleChange)
    })

    return () => {
      cancelled = true
      statusHandle?.removeEventListener("change", handleChange)
    }
  }, [])

  const beginSession = React.useCallback(() => {
    const ctor = recognitionConstructorOf()
    if (!ctor) {
      setIsSupported(false)
      setStatus("unsupported")
      setRecording(false)
      fail("unsupported", null)
      return
    }
    // Both of these produce `not-allowed` with no prompt and no way for the user to help. Settled
    // here, before starting, so the reason survives instead of being flattened into a code that
    // means four things.
    if (insecureContext()) {
      setRecording(false)
      setStatus("idle")
      fail("insecure-context", null)
      return
    }
    if (blockedByPermissionsPolicy()) {
      setRecording(false)
      setStatus("idle")
      fail("blocked-by-policy", null)
      return
    }
    if (sessionActiveRef.current) return

    let recognition = recognitionRef.current
    if (!recognition) {
      recognition = new ctor()
      recognitionRef.current = recognition

      recognition.onstart = () => {
        if (!mountedRef.current) return
        // Reset here rather than where `start()` is called, because this is the moment the session's
        // result list begins. A restarted session hands back a brand-new list numbered from zero,
        // and a cursor carried over from the session before it would skip that many results of the
        // new one — the failure being a dictation that silently drops its first few words every
        // time the browser has paused and been restarted.
        committedCountRef.current = 0
        producedResultRef.current = false
        setStatus("listening")
      }

      recognition.onresult = (event) => {
        if (!mountedRef.current) return
        producedResultRef.current = true

        // `results` holds every result of the session so far, and `resultIndex` says where this
        // event's changes begin — but neither is a cursor for "what has been taken already", which
        // is what appending needs. Walking from `resultIndex` each time re-reads results that were
        // already confirmed and appends them twice; walking from zero and rebuilding throws away
        // anything the consumer has edited in between. So the cursor is kept here, and only moves
        // over results that are final.
        let cursor = committedCountRef.current
        const confirmed: string[] = []
        let pending = ""
        // Once an unconfirmed result is reached the cursor stops, even if a later one is already
        // final. Advancing past a gap would strand the result in it: it becomes final a moment
        // later, by which time the cursor is beyond it and it is never taken.
        let stillConfirming = true

        for (let index = cursor; index < event.results.length; index += 1) {
          const result = event.results[index]
          const text = result?.[0]?.transcript ?? ""
          if (result?.isFinal && stillConfirming) {
            // Kept as separate chunks rather than concatenated. One event can confirm more than one
            // result, and joining them with `+` here welds the last word of each onto the first word
            // of the next — the same defect `appendTranscript` exists to prevent, reintroduced one
            // level down where that function never gets to see it.
            const chunk = text.trim()
            if (chunk) confirmed.push(chunk)
            cursor = index + 1
          } else {
            stillConfirming = false
            pending = appendTranscript(pending, text)
          }
        }

        committedCountRef.current = cursor
        setInterimTranscript(pending)

        if (confirmed.length === 0) return
        silentRestartsRef.current = 0
        setTranscript((previous) => confirmed.reduce(appendTranscript, previous))
        for (const chunk of confirmed) onTranscriptRef.current?.(chunk)
      }

      recognition.onerror = (event) => {
        if (!mountedRef.current) return
        const code = event?.error ?? "unknown"
        // We caused this one — `abort()`, an unmount, a navigation. Reporting it would put an error
        // on screen every time somebody pressed stop.
        if (code === "aborted") return

        // Decided synchronously, because `end` follows in the same tick and needs to know whether
        // to start another session before any permission lookup could answer.
        if (!RESTARTABLE_CODES.has(code)) setRecording(false)

        if (code === "not-allowed") {
          // Checked again here, not just before starting: a document can be moved into a frame that
          // forbids the microphone between the two moments, and a browser that reached this path
          // without being able to run the pre-checks still deserves the right answer.
          if (insecureContext()) return fail("insecure-context", code)
          if (blockedByPermissionsPolicy()) return fail("blocked-by-policy", code)
          void queryMicrophonePermission().then((result) => {
            if (!mountedRef.current) return
            if (!result) {
              // Nothing can tell these apart here, so the copy for `denied` carries the day: it is
              // the only one of the two that stays broken, and advice to check site settings is
              // harmless to somebody who merely closed the dialog.
              return fail("denied", code)
            }
            setPermission(result.state)
            permissionRef.current = result.state
            if (result.state === "denied") return fail("denied", code)
            // Refused while the stored answer is "granted" can only come from above the user — a
            // frame or a header — so sending them to their own settings would be wrong.
            if (result.state === "granted") return fail("blocked-by-policy", code)
            // Still "prompt", so nothing was stored and the dialog was closed rather than answered.
            // This is the one refusal worth offering a retry for, and asking again really does
            // re-prompt.
            fail("dismissed", code)
          })
          return
        }

        // Silence during a continuous dictation is not an error the user needs to see — it is a
        // pause. It only becomes one when the restart budget runs out, and `end` reports it then.
        if (code === "no-speech" && continuousRef.current && intentRef.current) return

        fail(causeForCode(code), code)
      }

      recognition.onend = () => {
        sessionActiveRef.current = false
        if (!mountedRef.current) return
        // An interim result that never became final is gone: the session that was guessing at it
        // has ended, and the next one starts from an empty list.
        setInterimTranscript("")

        if (!intentRef.current) {
          setStatus("idle")
          return
        }

        // The whole reason this component exists. The browser ends a session on its own — after a
        // stretch of silence, and after a while regardless — and says nothing to your code beyond
        // this event. A control that tracked only its own clicks is still showing a red dot and the
        // word "Listening" at this point, over a microphone that was handed back some time ago.
        if (!continuousRef.current) {
          setRecording(false)
          setStatus("idle")
          return
        }

        if (!producedResultRef.current) silentRestartsRef.current += 1
        if (silentRestartsRef.current > maxSilentRestartsRef.current) {
          setRecording(false)
          setStatus("idle")
          if (!failureRef.current) fail("no-speech", null)
          return
        }
        setStatus("starting")
        // Deferred out of this handler rather than called from inside it. Starting a session from
        // within the previous session's own `end` is the one ordering the browser is entitled to
        // reject — it has not necessarily finished tearing the old one down — and `start()` throwing
        // there would end the dictation at the first pause. A microtask is enough to be outside it
        // while still being the same beat as far as the user is concerned. Re-checked on arrival:
        // the component can have been unmounted, or stop pressed, in between.
        void Promise.resolve().then(() => {
          if (!mountedRef.current || !intentRef.current) return
          beginSessionRef.current?.()
        })
      }
    }

    recognition.lang = langRef.current ?? documentLanguage()
    recognition.continuous = continuousRef.current
    recognition.interimResults = interimResultsRef.current
    recognition.maxAlternatives = 1

    // Set before the call, not after: in a browser `start()` returns long before any event, but
    // ordering the two the other way round makes the component depend on that being true, and a
    // `start` delivered synchronously would have its "listening" overwritten with "starting".
    //
    // "prompt" is the one state that reliably means a dialog is about to appear. Where the
    // Permissions API could not answer, claiming to know would be the lie.
    setStatus(permissionRef.current === "prompt" ? "prompting" : "starting")
    try {
      recognition.start()
      sessionActiveRef.current = true
    } catch {
      // InvalidStateError: the browser still considers a session live even though `end` has not
      // reached us. Nothing is broken and nothing is owed — the session that is already running is
      // the one that was wanted.
      sessionActiveRef.current = true
    }
  }, [fail, setRecording])

  React.useEffect(() => {
    beginSessionRef.current = beginSession
  }, [beginSession])

  const start = React.useCallback(() => {
    if (intentRef.current) return
    failureRef.current = null
    setFailure(null)
    setTranscript("")
    setInterimTranscript("")
    silentRestartsRef.current = 0
    producedResultRef.current = false
    setRecording(true)
    beginSession()
  }, [beginSession, setRecording])

  const stop = React.useCallback(() => {
    if (!intentRef.current) return
    setRecording(false)
    if (!sessionActiveRef.current) {
      setStatus("idle")
      return
    }
    setStatus("stopping")
    // `stop()` rather than `abort()`: the difference is a whole sentence. Stopping asks the service
    // to finish what it is holding and deliver it as a final result; aborting throws it away. A
    // button that aborts loses the last thing the user said, every time, which reads as the
    // component dropping words at random.
    try {
      recognitionRef.current?.stop()
    } catch {
      // Already stopping or already stopped.
    }
  }, [setRecording])

  const abort = React.useCallback(() => {
    setRecording(false)
    setInterimTranscript("")
    setStatus("idle")
    try {
      recognitionRef.current?.abort()
    } catch {
      // Nothing was running.
    }
  }, [setRecording])

  const toggle = React.useCallback(() => {
    if (intentRef.current) stop()
    else start()
  }, [start, stop])

  const reset = React.useCallback(() => {
    setTranscript("")
    setInterimTranscript("")
  }, [])

  // Handing the microphone back is not optional and nothing else will do it. The recognition object
  // is owned by the page, not by this component, so navigating from the form to the confirmation
  // screen inside a single-page app would otherwise leave the browser recording — with the
  // recording indicator lit in the tab strip and no control left anywhere that could stop it.
  React.useEffect(() => {
    return () => {
      const recognition = recognitionRef.current
      recognitionRef.current = null
      if (!recognition) return
      // Detached before aborting, not after: `abort()` synchronously fires `error` and `end`, and
      // handlers still attached at that moment would run after the component is gone.
      recognition.onstart = null
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try {
        recognition.abort()
      } catch {
        // Nothing was running.
      }
    }
  }, [])

  return {
    status,
    isRecording,
    transcript,
    interimTranscript,
    isSupported,
    failure,
    permission,
    start,
    stop,
    abort,
    toggle,
    reset,
  }
}

export interface SpeechInputButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children" | "value" | "onChange">,
    UseSpeechInputOptions {
  /**
   * The field's current text, when you want the button to fill it for you.
   *
   * Pass this together with `onValueChange` and confirmed speech is appended to whatever is already
   * there, spaced the way `appendTranscript` describes — so the same state that backs your
   * `<input>` backs the dictation, and typing and speaking can be mixed in one field. Leave both
   * off and the button only reports through `onTranscript`.
   */
  value?: string
  /** Called with the field's new text. Only ever carries confirmed speech, never the interim guess. */
  onValueChange?: (value: string) => void
  /**
   * The button's accessible name, which does not change while recording.
   *
   * Deliberately unlike the sibling `geolocation-button`, whose label reports what it is doing. This
   * one is a toggle, and the convention for a toggle is a name that stays put while `aria-pressed`
   * carries the state — a name that flips to "Stop dictating" is announced as a different control
   * appearing, and a user who has just been told "Dictate, pressed" hears the contradiction. The
   * state reaches everyone else through the live region below.
   */
  label?: string
  /** Name used where the API is missing. Kept as the accessible name so the control explains itself. */
  unsupportedLabel?: string
  /** Announced while the browser's microphone dialog is open. */
  promptingLabel?: string
  /** Announced between the request and the microphone actually opening. */
  startingLabel?: string
  /** Announced while the microphone is live. */
  listeningLabel?: string
  /** Announced while the last words are being confirmed. */
  stoppingLabel?: string
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
  /** Hide the status line. It stays in the live region either way. */
  hideMessage?: boolean
  /** Show the unconfirmed words beside the button while they are being guessed at. */
  showInterim?: boolean
  /** Per-cause wording, merged over the defaults. */
  messages?: Partial<Record<SpeechInputFailureCause, string>>
  /** Class for the wrapper. `className` goes to the button. */
  containerClassName?: string
}

/**
 * A press-to-dictate button that stops claiming to listen the moment it isn't.
 */
export function SpeechInputButton({
  value,
  onValueChange,
  label = "Dictate",
  unsupportedLabel = "Dictation isn't supported here",
  promptingLabel = "Waiting for microphone permission…",
  startingLabel = "Starting…",
  listeningLabel = "Listening…",
  stoppingLabel = "Finishing…",
  iconOnly = false,
  hideMessage = false,
  showInterim = true,
  messages,
  containerClassName,
  lang,
  continuous,
  interimResults,
  maxSilentRestarts,
  onTranscript,
  onRecordingChange,
  onFailure,
  onClick,
  className,
  ...props
}: SpeechInputButtonProps) {
  // Read through a ref so the transcript handler appends to the text as it is *now*. Closing over
  // the prop instead would append to whatever the value was when recording started, so every chunk
  // after the first would wipe out the one before it.
  const valueRef = React.useRef(value)
  React.useEffect(() => {
    valueRef.current = value
  }, [value])

  const onValueChangeRef = React.useRef(onValueChange)
  const onTranscriptRef = React.useRef(onTranscript)
  React.useEffect(() => {
    onValueChangeRef.current = onValueChange
    onTranscriptRef.current = onTranscript
  }, [onTranscript, onValueChange])

  const handleTranscript = React.useCallback((chunk: string) => {
    onTranscriptRef.current?.(chunk)
    const change = onValueChangeRef.current
    if (!change) return
    const next = appendTranscript(valueRef.current ?? "", chunk)
    // Kept in step immediately: two chunks can arrive before the parent has re-rendered with the
    // new value, and the second would otherwise be appended to the stale one.
    valueRef.current = next
    change(next)
  }, [])

  const { status, isRecording, interimTranscript, isSupported, failure, toggle } = useSpeechInput({
    lang,
    continuous,
    interimResults,
    maxSilentRestarts,
    onTranscript: handleTranscript,
    onRecordingChange,
    onFailure,
  })

  // Referenced by id from the button, so it needs one that survives hydration.
  const messageId = React.useId()

  const busy = status === "prompting" || status === "starting" || status === "stopping"
  // A failure marked non-retryable keeps the control reachable and says why, rather than dangling
  // an action that cannot work. Recording is always stoppable, whatever went wrong.
  const actionable = isSupported && (isRecording || failure?.retryable !== false)

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented || !actionable) return
    toggle()
  }

  const statusMessage =
    status === "prompting"
      ? promptingLabel
      : status === "starting"
        ? startingLabel
        : status === "listening"
          ? listeningLabel
          : status === "stopping"
            ? stoppingLabel
            : ""

  // A failure outranks the status line, except while recording is under way again — at which point
  // the old message describes something that is no longer true.
  const message = failure && !statusMessage ? (messages?.[failure.cause] ?? failure.message) : statusMessage

  const accessibleName = isSupported ? label : unsupportedLabel
  const Icon = busy ? Loader2 : !isSupported ? MicOff : failure && !failure.retryable ? TriangleAlert : Mic

  return (
    <div className={cn("flex flex-col items-start gap-2", containerClassName)}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          // The setting the user operates, which is what a toggle announces. An icon swap is not
          // something a screen reader reports, so it cannot be the only signal that this is on.
          aria-pressed={isRecording}
          // `aria-disabled` rather than `disabled`: a real disabled button leaves the tab order, so
          // a keyboard or screen-reader user never reaches it and never hears why dictation is
          // unavailable. The click handler above is what refuses.
          aria-disabled={actionable ? undefined : true}
          aria-busy={busy || undefined}
          aria-label={iconOnly ? accessibleName : undefined}
          // Points at the status line so the reason is part of the button's description wherever
          // one exists, rather than only being announced once as it appears.
          aria-describedby={message ? messageId : undefined}
          data-status={status}
          // The honest one, for styling or a test: `aria-pressed="true"` with `data-active="false"`
          // is a dictation the browser has quietly stopped and is about to resume.
          data-active={status === "listening" ? "true" : "false"}
          data-cause={failure?.cause}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-pressed:border-destructive/60 aria-pressed:text-destructive",
            iconOnly ? "w-9" : "px-4",
            className
          )}
          {...props}
        >
          <Icon
            className={cn(
              "h-4 w-4",
              busy && "animate-spin",
              status === "listening" && "animate-pulse"
            )}
            aria-hidden="true"
          />
          {iconOnly ? null : accessibleName}
        </button>
        {/*
          The live guess, shown and deliberately not announced. It is rewritten several times a
          second as more audio arrives, and a polite live region over it would queue every revision
          and read them all — which is both useless and impossible to interrupt. The confirmed text
          lands in the field, where a screen reader reports it the same way it reports typing.
        */}
        {showInterim && interimTranscript ? (
          <span className="truncate text-sm italic text-muted-foreground" data-interim="true">
            {interimTranscript}
          </span>
        ) : null}
      </div>
      {/*
        Mounted from the start and left empty, never conditionally rendered. A live region inserted
        into the document already holding its text is not reliably announced — the region has to
        exist for the browser to notice the text changing inside it — so the version that only
        appears when something happens is silent for exactly the users depending on it.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        className={cn("text-sm text-muted-foreground", (hideMessage || !message) && "sr-only")}
      >
        {message}
      </p>
    </div>
  )
}
