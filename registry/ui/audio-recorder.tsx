"use client"

import * as React from "react"
import { Loader2, Mic, Pause, Play, Square, Trash2, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The MediaDevices entry point, or null where there isn't one.
 *
 * Hand-written because TypeScript declares `readonly mediaDevices: MediaDevices` on `Navigator` —
 * not optional — so `navigator.mediaDevices.getUserMedia(...)` type-checks everywhere and then
 * throws a TypeError on the browsers, and the origins, that haven't got it.
 */
function mediaDevicesOf(): MediaDevices | null {
  if (typeof navigator === "undefined" || !("mediaDevices" in navigator)) return null
  const api: MediaDevices | undefined = navigator.mediaDevices
  return api && typeof api.getUserMedia === "function" ? api : null
}

/** The `MediaRecorder` constructor, with `isTypeSupported` marked for what it is: not always there. */
type MediaRecorderCtor = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder
  isTypeSupported?: (type: string) => boolean
}

/**
 * The `MediaRecorder` constructor, or null.
 *
 * A separate detect from `mediaDevicesOf`, and the separation is load-bearing: the two features
 * shipped years apart, so "can reach the microphone" and "can record what comes out of it" are
 * genuinely different questions. Safari had `getUserMedia` for four releases before it had this.
 * Collapsing them produces a component that asks for the microphone, lights the recording
 * indicator, and only then discovers it cannot record — a permission prompt spent on nothing.
 */
function mediaRecorderCtor(): MediaRecorderCtor | null {
  if (typeof window === "undefined") return null
  const holder = window as unknown as Record<string, unknown>
  const ctor = holder.MediaRecorder
  return typeof ctor === "function" ? (ctor as MediaRecorderCtor) : null
}

/** An `AudioContext` constructor, including the spelling older Safari shipped. */
type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null
  const holder = window as unknown as Record<string, unknown>
  const ctor = holder.AudioContext ?? holder.webkitAudioContext
  return typeof ctor === "function" ? (ctor as AudioContextCtor) : null
}

/** Whether this browser can record audio at all. Both halves are required. */
export function isAudioRecorderSupported(): boolean {
  return mediaDevicesOf() !== null && mediaRecorderCtor() !== null
}

/**
 * Whether this page is a non-secure context, where the microphone is unavailable and always will be.
 */
function insecureContext(): boolean {
  // A browser old enough to lack `isSecureContext` must not be read as insecure — that would
  // refuse to work on the very browsers this is meant to degrade for.
  return typeof window !== "undefined" && window.isSecureContext === false
}

/**
 * Whether Permissions Policy forbids the microphone in this document, where that can be asked.
 *
 * One of the four producers of an unexplained `NotAllowedError`. The default allowlist for
 * `microphone` is `'self'`, so an `<iframe>` embedding this page without `allow="microphone"` is
 * refused, as is any origin serving `Permissions-Policy: microphone=()`. Neither is something the
 * person looking at the screen can do anything about, and neither shows a prompt.
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
 * The only other way to learn the permission state is to call `getUserMedia`, and that *acts* — it
 * can put a prompt in front of somebody who never asked for one, and it opens the microphone. This
 * answers the same question silently, which is what makes it possible to tell the four different
 * things `NotAllowedError` means apart.
 *
 * Guarded twice: `navigator.permissions` is declared non-optional by TypeScript and is genuinely
 * absent in older browsers, and a browser that has the Permissions API may still not recognise the
 * `microphone` descriptor — Safari does not — in which case `query` rejects instead of answering.
 * Not knowing is an ordinary answer here, and every path below works without it.
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
 * Container and codec spellings to try, best first.
 *
 * This list is the second reason the component exists. There is no format every browser records:
 * Chromium and Firefox produce WebM, and Safari produces MP4, and `new MediaRecorder(stream, {
 * mimeType })` with a type the browser cannot write throws `NotSupportedError` from the
 * constructor — not later, not as an event, but immediately, which is why a recorder hard-coded to
 * `audio/webm` is a feature that has never once worked in Safari. Opus is first because it is
 * dramatically smaller than AAC at speech bitrates, and the bare container spellings come after
 * the codec-qualified ones so a browser that recognises the container but not the codec string
 * still gets a type it can use.
 *
 * Export is deliberate: a backend that only accepts one container wants to pass its own list.
 */
export const AUDIO_MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
]

/**
 * The first candidate this browser says it can record, or null to let it choose for itself.
 *
 * Null is a real answer and not a failure. `new MediaRecorder(stream)` with no options always
 * works where `MediaRecorder` exists, and a browser whose `isTypeSupported` is missing — which is
 * every implementation old enough to need the help most — cannot be interrogated, so asking it to
 * pick beats guessing on its behalf. What comes back is read off `recorder.mimeType` afterwards
 * either way, because the type that was requested and the type that was written are not reliably
 * the same thing.
 */
export function pickAudioMimeType(
  candidates: readonly string[] = AUDIO_MIME_CANDIDATES
): string | null {
  const ctor = mediaRecorderCtor()
  if (!ctor || typeof ctor.isTypeSupported !== "function") return null
  for (const type of candidates) {
    try {
      if (ctor.isTypeSupported(type)) return type
    } catch {
      // A browser that throws rather than answering has answered.
    }
  }
  return null
}

/**
 * A file extension for a recorded type, leading dot included.
 *
 * Needed because the extension has to match what the browser actually wrote, and that is only
 * known after recording. Naming the upload `.webm` on a Safari recording hands the server an MP4
 * called WebM, which is the kind of mismatch that survives every test on the developer's own
 * machine and fails on half the users' — ffmpeg and most server-side probes trust the bytes, but
 * plenty of storage layers, players and content-type sniffers trust the name.
 */
export function audioFileExtension(type: string | null | undefined): string {
  const base = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  switch (base) {
    case "audio/webm":
      return ".webm"
    // `.m4a` rather than `.mp4`: the container is MP4 either way, but a file named `.mp4` with no
    // video track is offered to video players and opens as a black rectangle.
    case "audio/mp4":
    case "audio/aac":
    case "audio/x-m4a":
      return ".m4a"
    case "audio/ogg":
      return ".ogg"
    case "audio/mpeg":
      return ".mp3"
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return ".wav"
    default:
      // Not a guess dressed up as an answer: an unknown container gets the generic extension
      // rather than one that would mislabel it.
      return ".bin"
  }
}

/**
 * A byte buffer for the analyser, typed so it fits `getByteTimeDomainData` on every TypeScript.
 *
 * TypeScript 5.7 made the typed arrays generic in their backing buffer, and the DOM signature asks
 * for `Uint8Array<ArrayBuffer>` specifically, so a plain `new Uint8Array(n)` — inferred as
 * `ArrayBufferLike`, which `SharedArrayBuffer` also satisfies — no longer type-checks there.
 * Allocating the buffer explicitly fixes that, and taking the type from this function rather than
 * writing `Uint8Array<ArrayBuffer>` keeps the file compiling on the versions before 5.7, where
 * `Uint8Array` takes no type argument at all. A component that only builds on the newest compiler
 * is a component half this registry's consumers cannot install.
 */
function makeByteBuffer(size: number) {
  return new Uint8Array(new ArrayBuffer(size))
}

type ByteBuffer = ReturnType<typeof makeByteBuffer>

/** `0:07`, or `1:02:03` once it runs past an hour. For a duration in milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * Why recording failed — worked out, not guessed.
 *
 * Four of these arrive as the identical `NotAllowedError`, and they need four different things
 * from four different people: `denied` is the user's own stored choice, `dismissed` is a prompt
 * closed without an answer, `insecure-context` and `blocked-by-policy` are the developer's to fix
 * and are invisible to the user.
 */
export type AudioFailureCause =
  | "unsupported"
  | "recorder-unsupported"
  | "insecure-context"
  | "blocked-by-policy"
  | "denied"
  | "dismissed"
  | "no-microphone"
  | "in-use"
  | "encoding-unsupported"
  | "interrupted"
  | "record-failed"
  | "empty"
  | "unknown"

export interface AudioFailure {
  cause: AudioFailureCause
  /** The `DOMException.name` the browser used, or null when this was settled before any call. */
  code: string | null
  /** Wording safe to show as-is. Override per cause with the `messages` prop. */
  message: string
  /**
   * Whether trying again, right now, can produce a different answer.
   *
   * False for `denied` is the point of the component. Once the microphone is blocked for an origin
   * the browser refuses without prompting, so a "Try again" is a button that cannot work: it
   * returns the same error instantly for as long as the page is open. The only way out runs
   * through the browser's own site settings, which is what the copy for that case says — and why
   * the permission `change` listener below exists, so that coming back from those settings costs
   * nothing.
   */
  retryable: boolean
}

const RETRYABLE: Record<AudioFailureCause, boolean> = {
  unsupported: false,
  "recorder-unsupported": false,
  "insecure-context": false,
  "blocked-by-policy": false,
  denied: false,
  dismissed: true,
  "no-microphone": true,
  "in-use": true,
  // Nothing on this device can write any container this asked for. A second attempt with the same
  // list fails identically; the way out is a different `mimeCandidates`, not a retry.
  "encoding-unsupported": false,
  interrupted: true,
  "record-failed": true,
  empty: true,
  unknown: true,
}

const DEFAULT_MESSAGES: Record<AudioFailureCause, string> = {
  unsupported: "This browser can't use a microphone.",
  "recorder-unsupported": "This browser can reach the microphone but can't record audio.",
  "insecure-context":
    "The microphone needs a secure (https) connection, so the browser refused without asking.",
  "blocked-by-policy": "This page isn't permitted to use the microphone.",
  denied:
    "The microphone is blocked for this site. Allow it in your browser's site settings — this page can't ask again.",
  dismissed: "The microphone request was dismissed.",
  "no-microphone": "No microphone was found on this device.",
  "in-use": "The microphone is being used by another app.",
  "encoding-unsupported": "This browser can't record any of the audio formats this page asked for.",
  "interrupted": "Recording stopped — the microphone may have been unplugged or taken by another app.",
  "record-failed": "The recording couldn't be completed.",
  empty: "Nothing was recorded.",
  unknown: "The recording couldn't be started.",
}

/**
 * Maps a `getUserMedia` rejection to a cause. `NotAllowedError` is resolved separately.
 *
 * The legacy spellings are not decoration: `PermissionDeniedError`, `DevicesNotFoundError` and
 * `TrackStartError` are what older Chrome and the prefixed implementations threw, and a browser
 * old enough to use the prefixed entry point is exactly the one that will not be updated.
 */
function causeForError(name: string): AudioFailureCause | null {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return null
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-microphone"
    // The microphone exists, the permission is fine, and the operating system will not hand it
    // over — almost always because a call in another app or another tab already holds it.
    case "NotReadableError":
    case "TrackStartError":
      return "in-use"
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "no-microphone"
    case "AbortError":
      return "interrupted"
    // Thrown where media support has been disabled at the browser level.
    case "SecurityError":
      return "blocked-by-policy"
    default:
      return "unknown"
  }
}

/** Stops every track on a stream. The only thing that turns the recording indicator off. */
function stopTracks(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks?.() ?? []) {
    track.onended = null
    track.stop()
  }
}

/** Where the recorder has got to. */
export type RecorderPhase =
  | "idle"
  | "prompting"
  | "starting"
  | "recording"
  | "paused"
  | "stopping"
  | "recorded"
  | "error"

/** A finished recording. */
export interface AudioRecording {
  /** The encoded audio. This is the thing to upload. See `audioFileExtension` for the name. */
  blob: Blob
  /**
   * An object URL for playing it back, owned by this component.
   *
   * Revoked when the next recording starts and on unmount, because an object URL pins its blob in
   * memory until somebody releases it and a voice-note field is used over and over. Anything that
   * has to outlive the component — a player elsewhere on the page, a value kept in form state —
   * should make its own from `blob` and revoke that itself.
   */
  url: string
  /**
   * How long was recorded, in milliseconds, measured while it happened.
   *
   * Measured here because the file cannot be asked. A `MediaRecorder` writes its container header
   * before it knows how long the recording will be and never goes back to finalise it, so a WebM
   * from this API carries no duration: hand the blob to an `<audio>` element and `duration` reads
   * `Infinity`, which is why so many voice-note widgets show a broken scrubber and a timeline of
   * nothing. The usual workaround — seek to a huge offset and wait for the element to report where
   * it landed — is a second asynchronous dance to recover a number that was in hand all along.
   * This is that number: wall-clock between start and stop, with any paused stretches subtracted.
   */
  duration: number
  /** The container actually written, read off the recorder rather than the type requested. */
  type: string
  /** Bytes. */
  size: number
}

export interface UseAudioRecorderOptions {
  /**
   * Container and codec spellings to try, best first. Default `AUDIO_MIME_CANDIDATES`.
   *
   * Pass a narrower list when the receiving end only accepts one — but pass a list, not a string,
   * because a single hard-coded type is the thing this exists to avoid.
   */
  mimeCandidates?: readonly string[]
  /**
   * Browser audio processing, all on by default — which is right for speech and wrong for music.
   *
   * These are on by the platform's own defaults because the overwhelming majority of recordings
   * made in a browser are somebody talking, and for talking they are a large improvement: the echo
   * canceller stops a laptop recording its own speaker output, and the gain control keeps a quiet
   * speaker audible. For anything musical they are destructive in a way that cannot be undone
   * afterwards — the noise suppressor is tuned to discard what is not a voice, so a guitar loses
   * its decay and a cymbal turns to gravel, and the gain control pumps the volume between phrases.
   * A recorder for instrument practice or a singing teacher wants all three off.
   */
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  /** Pin one specific input by id, from `enumerateDevices`. */
  deviceId?: string
  /**
   * Stop automatically after this many milliseconds. Undefined records until stopped.
   *
   * Worth setting for anything that gets uploaded. Every chunk is held in memory until the
   * recording is finished, so an interview left running on a forgotten tab grows until the tab
   * dies — and the recording dies with it, because nothing was ever handed back.
   */
  maxDuration?: number
  /**
   * How long the input can stay silent before `isSilent` goes true. Default 4000ms.
   *
   * This is the component's first reason to exist. A microphone muted in the operating system, or
   * at a hardware switch on the headset, or by a mixer application, does not fail: `getUserMedia`
   * resolves, the track is live and unmuted as far as the browser is concerned, `MediaRecorder`
   * runs happily, and what comes out is a perfectly valid file of digital silence. Nothing in the
   * API reports this. The person finds out when somebody tells them the voice note is empty, which
   * is after they have stopped, sent it and closed the tab.
   */
  silenceTimeout?: number
  /**
   * The RMS level below which the input counts as silent, 0 to 1. Default 0.01.
   *
   * 0.01 is about -40 dBFS, which is below a quiet room's noise floor as the microphone hears it
   * but comfortably above the exact zeros a muted device delivers. Raising it turns "quiet" into
   * "silent" and will cry wolf at a soft speaker.
   */
  silenceThreshold?: number
  onStart?: () => void
  /** Called with the finished recording. */
  onRecording?: (recording: AudioRecording) => void
  /**
   * Called when something fails.
   *
   * Not `onError`: that is a native DOM attribute React defines on every element, so a prop by
   * that name collides with it as soon as these options are spread onto an element.
   */
  onFailure?: (failure: AudioFailure) => void
}

export interface UseAudioRecorderResult {
  phase: RecorderPhase
  /** The last failure, or null. Cleared when recording starts. */
  failure: AudioFailure | null
  /** The finished recording, or null. */
  recording: AudioRecording | null
  /** Milliseconds recorded so far, paused stretches excluded. Ticks while recording. */
  elapsed: number
  /** Input level, 0 to 1, smoothed for display. 0 unless recording. */
  level: number
  /** True while the input is at or past full scale, where the recording is being clipped. */
  isClipping: boolean
  /** True once the input has been silent for `silenceTimeout`. See that option. */
  isSilent: boolean
  /** Whether the Web Audio API was available to measure the level at all. */
  isMetered: boolean
  /** The stored permission, or "unknown" where the Permissions API can't say. */
  permission: PermissionState | "unknown"
  /** Whether the APIs exist. Starts true so the server and first client render agree. */
  isSupported: boolean
  start: () => void
  /** Stop and finish. The recording arrives through `recording` and `onRecording`. */
  stop: () => void
  pause: () => void
  resume: () => void
  /** Throw the recording away and go back to idle, releasing its object URL. */
  discard: () => void
}

/**
 * The whole behaviour, for a recorder you lay out yourself.
 */
export function useAudioRecorder(options: UseAudioRecorderOptions = {}): UseAudioRecorderResult {
  const [phase, setPhase] = React.useState<RecorderPhase>("idle")
  const [failure, setFailure] = React.useState<AudioFailure | null>(null)
  const [recording, setRecording] = React.useState<AudioRecording | null>(null)
  const [elapsed, setElapsed] = React.useState(0)
  const [level, setLevel] = React.useState(0)
  const [isClipping, setIsClipping] = React.useState(false)
  const [isSilent, setIsSilent] = React.useState(false)
  const [isMetered, setIsMetered] = React.useState(false)
  const [permission, setPermission] = React.useState<PermissionState | "unknown">("unknown")
  const [isSupported, setIsSupported] = React.useState(true)

  const streamRef = React.useRef<MediaStream | null>(null)
  const recorderRef = React.useRef<MediaRecorder | null>(null)
  const chunksRef = React.useRef<Blob[]>([])
  const contextRef = React.useRef<AudioContext | null>(null)
  const analyserRef = React.useRef<AnalyserNode | null>(null)
  const sourceRef = React.useRef<MediaStreamAudioSourceNode | null>(null)
  const bufferRef = React.useRef<ByteBuffer | null>(null)
  const frameRef = React.useRef<number | null>(null)
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null)
  const recordingRef = React.useRef<AudioRecording | null>(null)
  const mountedRef = React.useRef(true)
  const failureRef = React.useRef<AudioFailure | null>(null)
  const permissionRef = React.useRef<PermissionState | "unknown">("unknown")

  // Elapsed time is kept as two numbers rather than counted up, and that is not a style choice. A
  // counter incremented on a timer is wrong by however much the browser throttled that timer, and
  // a background tab is throttled to roughly once a second — so a two-minute voice note recorded
  // while the user read something in another tab would be handed back claiming to be forty
  // seconds, and the number is what the receiving end shows forever. These two are timestamps, so
  // the duration is correct no matter how rarely anything got to run.
  const startedAtRef = React.useRef(0)
  const bankedRef = React.useRef(0)

  const levelRef = React.useRef(0)
  const silentForRef = React.useRef(0)
  const lastFrameRef = React.useRef(0)
  // Every start gets a number, and a continuation that is not the current one is dropped. There is
  // no way to cancel a `getUserMedia` already in flight, so without this a stream from an abandoned
  // attempt lands on top of a fresh one — and, worse, lands with nothing holding it, which is a
  // microphone left open for the life of the page with no control that can reach it.
  const sessionRef = React.useRef(0)
  const pendingRef = React.useRef(false)

  // Options are read through a ref rather than closed over, so `start` and `stop` keep stable
  // identities. A callback that changes when an inline `onRecording` changes would otherwise
  // restart the microphone on an unrelated re-render, and a recording that stops and starts
  // mid-sentence is a worse bug than any it could fix.
  const optionsRef = React.useRef(options)
  React.useEffect(() => {
    optionsRef.current = options
  })

  // Declared before everything that reads it: under StrictMode the cleanups run and the effects run
  // again, and if this came last the second pass would see `false` and quietly refuse to work.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const active = React.useCallback(
    (id: number) => mountedRef.current && sessionRef.current === id,
    []
  )

  const fail = React.useCallback(
    (cause: AudioFailureCause, code: string | null, keepPhase?: RecorderPhase) => {
      const next: AudioFailure = {
        cause,
        code,
        message: DEFAULT_MESSAGES[cause],
        retryable: RETRYABLE[cause],
      }
      failureRef.current = next
      setFailure(next)
      setPhase(keepPhase ?? "error")
      optionsRef.current.onFailure?.(next)
    },
    []
  )

  /**
   * Settles support on mount, with the reason rather than a bare boolean.
   *
   * Reporting only `isSupported: false` is what produces the thing this component argues against
   * everywhere else: a greyed-out button with nothing next to it saying why. Nobody has clicked
   * anything yet, so there is no failure to describe, and the one person who cannot record is the
   * one told the least.
   */
  React.useEffect(() => {
    if (isAudioRecorderSupported()) return
    // Reported once. `fail` mints a fresh failure object every call, so an unguarded version
    // re-announces itself through `onFailure` on every StrictMode remount — and a consumer that
    // shows a toast per failure gets two of them for a browser that was never going to work.
    if (failureRef.current) return
    setIsSupported(false)
    if (insecureContext()) {
      fail("insecure-context", null)
      return
    }
    // Which half is missing decides the copy. "This browser can't use a microphone" is false, and
    // misleading, on a browser whose microphone works and whose recorder does not.
    fail(mediaDevicesOf() === null ? "unsupported" : "recorder-unsupported", null)
  }, [fail])

  /** Stops the meter loop. */
  const stopMeter = React.useCallback(() => {
    const frame = frameRef.current
    frameRef.current = null
    if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
  }, [])

  /** Stops the elapsed-time ticker. */
  const stopTimer = React.useCallback(() => {
    const timer = timerRef.current
    timerRef.current = null
    if (timer !== null) clearInterval(timer)
  }, [])

  /**
   * Hands back the microphone and everything attached to it.
   *
   * Four separate releases, and every one of them has been left out of a hand-rolled version. The
   * tracks are what hold the device: a recorder that only calls `recorder.stop()` leaves the
   * browser's tab indicator lit and, on a phone, the operating system's own — a red dot over a page
   * that is not recording anything, which is the single complaint this component is built to
   * avoid. The `AudioContext` is the second: it keeps the audio hardware spun up, and browsers cap
   * how many a page may have open at once, so a recorder mounted and unmounted a few times stops
   * being able to meter at all. The source node is disconnected before the context closes so the
   * graph is not left holding the stream, and the recorder's own handlers are detached so a late
   * `stop` event cannot land on a component that has moved on.
   */
  const release = React.useCallback(() => {
    stopMeter()
    stopTimer()

    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null
      // Only if it is still running: `stop()` on an inactive recorder throws InvalidStateError,
      // and this path runs on unmount, where it usually is inactive.
      if (recorder.state !== "inactive") {
        try {
          recorder.stop()
        } catch {
          // Nothing left to do about it here.
        }
      }
    }

    const source = sourceRef.current
    sourceRef.current = null
    try {
      source?.disconnect()
    } catch {
      // Already disconnected.
    }
    analyserRef.current = null
    bufferRef.current = null

    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== "closed") {
      // Returns a promise that nothing waits for; a rejection here is not actionable.
      void context.close?.().catch?.(() => {})
    }

    const stream = streamRef.current
    streamRef.current = null
    stopTracks(stream)

    levelRef.current = 0
    silentForRef.current = 0
    if (mountedRef.current) {
      setLevel(0)
      setIsClipping(false)
    }
  }, [stopMeter, stopTimer])

  /** Releases the object URL of the recording we are holding. */
  const releaseRecording = React.useCallback(() => {
    const held = recordingRef.current
    recordingRef.current = null
    if (held && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(held.url)
    }
  }, [])

  /** Milliseconds recorded, derived rather than counted. See `startedAtRef`. */
  const measure = React.useCallback(() => {
    const running = startedAtRef.current > 0 ? Date.now() - startedAtRef.current : 0
    return bankedRef.current + Math.max(0, running)
  }, [])

  /**
   * Reads the input level once per frame and keeps the silence account.
   *
   * Time-domain data, not frequency: the level of a signal is how far it swings from the midpoint,
   * and `getByteFrequencyData` answers a different question entirely — it would report a strong
   * reading for a steady hum nobody can hear and a weak one for a crisp consonant.
   *
   * The silence account is kept in sampled time rather than wall-clock time, deliberately. A
   * background tab stops being given frames, so wall-clock would conclude "silent for thirty
   * seconds" about a tab that was simply not being painted, and warn the user that a perfectly
   * good recording is empty. Frames are the only evidence of silence there is, so only frames
   * count towards it.
   */
  const sample = React.useCallback(
    (now: number) => {
      const analyser = analyserRef.current
      const buffer = bufferRef.current
      if (!analyser || !buffer) return

      analyser.getByteTimeDomainData(buffer)
      let sum = 0
      let peak = 0
      for (let i = 0; i < buffer.length; i += 1) {
        const value = ((buffer[i] ?? 128) - 128) / 128
        sum += value * value
        const magnitude = Math.abs(value)
        if (magnitude > peak) peak = magnitude
      }
      const rms = Math.sqrt(sum / buffer.length)

      // Fast attack, slow release. A meter that follows the signal down as fast as it follows it up
      // flickers on every syllable gap and reads as a fault rather than as speech.
      const smoothed = Math.max(rms, levelRef.current * 0.82)
      levelRef.current = smoothed

      const opts = optionsRef.current
      const threshold = opts.silenceThreshold ?? 0.01
      const timeout = opts.silenceTimeout ?? 4000
      const delta = lastFrameRef.current > 0 ? Math.min(250, now - lastFrameRef.current) : 0
      lastFrameRef.current = now

      if (rms >= threshold) {
        silentForRef.current = 0
        if (mountedRef.current) setIsSilent(false)
      } else {
        silentForRef.current += delta
        if (silentForRef.current >= timeout && mountedRef.current) setIsSilent(true)
      }

      if (!mountedRef.current) return
      // Quantised to 32 steps before it reaches state. Un-quantised, this sets state sixty times a
      // second and re-renders the whole subtree with it, for a bar whose width nobody can tell
      // apart at that resolution. Quantised, a silent input re-renders not at all.
      const step = Math.round(smoothed * 32) / 32
      setLevel((current) => (current === step ? current : step))
      setIsClipping(peak >= 0.98)
    },
    []
  )

  /** Starts the per-frame meter, where the browser has frames to give. */
  const startMeter = React.useCallback(() => {
    if (typeof requestAnimationFrame !== "function") return
    const loop = (now: number) => {
      if (!analyserRef.current) return
      sample(now)
      frameRef.current = requestAnimationFrame(loop)
    }
    lastFrameRef.current = 0
    frameRef.current = requestAnimationFrame(loop)
  }, [sample])

  // Set when the source ends under us, read by the `stop` handler. The two are separate events and
  // the handler cannot tell from the recorder alone whether it was asked to stop or had to.
  const interruptedRef = React.useRef(false)

  /**
   * Builds the recording out of the chunks and hands the microphone back.
   *
   * Runs from the recorder's own `stop` event rather than from the `stop()` call, because `stop()`
   * is a request: the encoder still has audio buffered, that audio arrives as one more
   * `dataavailable`, and only then does `stop` fire. A version that builds the blob where the user
   * clicked loses the last fraction of a second of every recording — reliably, but by too little
   * to notice until somebody records a short word.
   */
  const finalize = React.useCallback(
    (id: number) => {
      // Guarded before anything is touched, and that order is the whole of it. `stop()` returns
      // immediately and the `stop` event arrives whenever the encoder has finished, so an event
      // for a recording that was already abandoned — `start` pressed again, discarded, the
      // component unmounted — lands at a moment when the session that replaced it owns the
      // microphone. Releasing first and checking afterwards therefore hands back the *live*
      // recording's stream and closes its context, which looks from the outside like a recorder
      // that dies a second after it starts. Nothing is leaked by returning here: the tracks of an
      // abandoned session were released by whatever abandoned it.
      if (!active(id)) return

      const duration = measure()
      const interrupted = interruptedRef.current
      interruptedRef.current = false
      const chunks = chunksRef.current
      chunksRef.current = []
      // Read before `release` nulls it, and taken from the recorder rather than from the request:
      // a browser handed a type it half-recognises may write a different one, and the first chunk's
      // own type is empty on some implementations.
      const written = recorderRef.current?.mimeType || chunks[0]?.type || ""

      release()

      const size = chunks.reduce((total, chunk) => total + (chunk.size ?? 0), 0)
      if (chunks.length === 0 || size === 0) {
        // Not the muted-microphone case — silence still encodes to a valid file with a header. This
        // is the recorder having produced nothing at all, which a caller must not be handed as a
        // zero-byte "recording" to upload.
        fail("empty", null)
        return
      }

      const blob = new Blob(chunks, written ? { type: written } : undefined)
      releaseRecording()
      const next: AudioRecording = {
        blob,
        url: URL.createObjectURL(blob),
        duration,
        type: blob.type || written,
        size: blob.size,
      }
      recordingRef.current = next
      setRecording(next)
      setElapsed(duration)
      if (interrupted) {
        // Both at once, on purpose. The microphone went away mid-recording, which is worth saying,
        // and what was captured before that is a real recording — discarding four minutes of an
        // interview because the headset was unplugged at the end is the one outcome nobody forgives.
        fail("interrupted", "ended", "recorded")
      } else {
        failureRef.current = null
        setFailure(null)
        setPhase("recorded")
      }
      optionsRef.current.onRecording?.(next)
    },
    [active, fail, measure, release, releaseRecording]
  )

  /** Asks the recorder to finish. The recording is built in `finalize`, from the `stop` event. */
  const finishRecorder = React.useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === "inactive") return
    // Banked before asking, not measured in the handler: `stop()` returns immediately and the
    // `stop` event arrives once the encoder has flushed, so measuring there adds the flush to the
    // duration of every recording.
    bankedRef.current = measure()
    startedAtRef.current = 0
    stopTimer()
    stopMeter()
    if (mountedRef.current) {
      setElapsed(bankedRef.current)
      setLevel(0)
      setIsClipping(false)
      setPhase("stopping")
    }
    try {
      recorder.stop()
    } catch {
      // InvalidStateError from a recorder that stopped between the check and here. The `stop` event
      // for that stop is already on its way.
    }
  }, [measure, stopMeter, stopTimer])

  /** Ticks the displayed time and enforces `maxDuration`. */
  const startTimer = React.useCallback(() => {
    stopTimer()
    timerRef.current = setInterval(() => {
      if (!mountedRef.current) return
      const ms = measure()
      setElapsed(ms)
      const max = optionsRef.current.maxDuration
      // Checked against the measured time rather than a tick count, so a throttled background tab
      // stops at the right recorded length instead of at four times it.
      if (max !== undefined && max > 0 && ms >= max) finishRecorder()
    }, 250)
  }, [finishRecorder, measure, stopTimer])

  const start = React.useCallback(() => {
    const opts = optionsRef.current
    const api = mediaDevicesOf()
    const Recorder = mediaRecorderCtor()
    if (!api || !Recorder) {
      setIsSupported(false)
      // Asked in this order so the http case says the true thing instead of blaming the browser:
      // `MediaDevices` is [SecureContext], so the whole object is missing on a plain-http origin
      // and the obvious feature detect fires on a browser whose microphone works perfectly well.
      if (insecureContext()) fail("insecure-context", null)
      else fail(!api ? "unsupported" : "recorder-unsupported", null)
      return
    }
    if (insecureContext()) {
      fail("insecure-context", null)
      return
    }
    if (blockedByPermissionsPolicy()) {
      fail("blocked-by-policy", null)
      return
    }
    // A second request while the first is still acquiring is never useful and is actively harmful:
    // the first already holds the device, so the duplicate comes back `NotReadableError` and
    // somebody who double-tapped Record is told another app has their microphone.
    if (pendingRef.current) return

    release()
    releaseRecording()

    const id = sessionRef.current + 1
    sessionRef.current = id
    pendingRef.current = true
    interruptedRef.current = false
    chunksRef.current = []
    bankedRef.current = 0
    startedAtRef.current = 0
    silentForRef.current = 0
    failureRef.current = null
    setFailure(null)
    setRecording(null)
    setElapsed(0)
    setIsSilent(false)
    // "prompt" is the one state that reliably means a dialog is about to appear. Where the
    // Permissions API could not answer, claiming to know would be the lie — and the wait is
    // unbounded either way, because a person deciding whether to hand over their microphone is not
    // a fault.
    setPhase(permissionRef.current === "prompt" ? "prompting" : "starting")

    const constraints: MediaTrackConstraints = {}
    if (opts.deviceId) constraints.deviceId = { exact: opts.deviceId }
    if (opts.echoCancellation !== undefined) constraints.echoCancellation = opts.echoCancellation
    if (opts.noiseSuppression !== undefined) constraints.noiseSuppression = opts.noiseSuppression
    if (opts.autoGainControl !== undefined) constraints.autoGainControl = opts.autoGainControl
    const audio = Object.keys(constraints).length > 0 ? constraints : true

    const settle = (stream: MediaStream) => {
      pendingRef.current = false
      if (!active(id)) {
        // Abandoned while in flight. Nothing is holding this stream and nothing else ever will, so
        // it has to be stopped here or the microphone stays open for the life of the page.
        stopTracks(stream)
        return
      }
      streamRef.current = stream

      const Context = audioContextCtor()
      if (Context) {
        try {
          const context = new Context()
          const source = context.createMediaStreamSource(stream)
          const analyser = context.createAnalyser()
          // Small on purpose: this is a level meter, not a spectrum analyser, and 1024 samples is
          // a sixth of a frame's worth of audio — enough for a stable RMS and cheap enough to do
          // sixty times a second on a phone.
          analyser.fftSize = 1024
          source.connect(analyser)
          // Connected to the analyser and to nothing else. Connecting on to
          // `context.destination` is the obvious next line and it routes the microphone into the
          // speakers, which on any device without headphones is an immediate feedback howl — and
          // then records it.
          contextRef.current = context
          sourceRef.current = source
          analyserRef.current = analyser
          bufferRef.current = makeByteBuffer(analyser.fftSize)
          // A context created outside a user gesture starts suspended and measures nothing. The
          // click that called `start` is enough activation for this to be allowed; it is awaited by
          // nobody because the meter appearing a frame late is not worth a branch.
          if (context.state === "suspended") void context.resume?.()?.catch?.(() => {})
          setIsMetered(true)
          startMeter()
        } catch {
          // Metering is a bonus and the recording is the job. A browser that will not give us an
          // AudioContext — or has hit its limit on them — can still record perfectly well, and
          // failing the recording over the level meter would be the tail wagging the dog.
          setIsMetered(false)
        }
      }

      const wanted = pickAudioMimeType(opts.mimeCandidates)
      let recorder: MediaRecorder
      try {
        recorder = wanted ? new Recorder(stream, { mimeType: wanted }) : new Recorder(stream)
      } catch (error) {
        // `NotSupportedError`, thrown by the constructor rather than reported later. Reached when
        // `isTypeSupported` claimed a type the implementation cannot actually write, which happens.
        // The browser's own default is the one type it is guaranteed to manage, so that is the
        // retry — a recording in an unexpected container beats no recording at all, and `type`
        // reports what arrived.
        try {
          recorder = new Recorder(stream)
        } catch {
          const name = (error as DOMException | undefined)?.name ?? "unknown"
          release()
          fail("encoding-unsupported", name)
          return
        }
      }

      recorderRef.current = recorder
      // Accumulated rather than kept as one blob. The specification does not promise a single
      // `dataavailable` at the end — an implementation may deliver the recording in pieces for its
      // own reasons, and one that does turns `event.data` saved over a variable into a file holding
      // the last few seconds of a long recording.
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        if (!active(id)) return
        // Whatever was captured before the fault is still worth keeping, so this goes through the
        // same stop path rather than discarding it.
        interruptedRef.current = true
        finishRecorder()
      }
      recorder.onstop = () => finalize(id)

      // The source ending on its own — a headset unplugged, the microphone seized by the operating
      // system, the permission revoked from the browser's own UI while the page is open. Nothing
      // else reports it, and without this the timer keeps counting up over a recording of nothing.
      const [track] = stream.getAudioTracks?.() ?? []
      if (track) {
        track.onended = () => {
          if (!active(id)) return
          interruptedRef.current = true
          finishRecorder()
        }
      }

      try {
        // No timeslice. One is only needed to get chunks during recording, which nothing here
        // wants, and on some implementations it changes how the container is written.
        recorder.start()
      } catch (error) {
        const name = (error as DOMException | undefined)?.name ?? "unknown"
        release()
        fail("record-failed", name)
        return
      }

      startedAtRef.current = Date.now()
      setPhase("recording")
      startTimer()
      opts.onStart?.()
    }

    const reject = (error: unknown) => {
      pendingRef.current = false
      if (!active(id)) return
      const name = (error as DOMException | undefined)?.name ?? "unknown"
      const mapped = causeForError(name)
      if (mapped) {
        fail(mapped, name)
        return
      }

      // NotAllowedError, which is four different things.
      //
      // The two checked before the call are checked again, because a document can be moved into a
      // frame that forbids the feature between the two moments, and because a browser reaching here
      // when the pre-checks could not run still deserves the right answer. Then the stored state
      // decides the rest, read now rather than taken from React state: pressing Block both fails
      // this call and fires `change`, and there is no guarantee the event has arrived.
      if (insecureContext()) {
        fail("insecure-context", name)
        return
      }
      if (blockedByPermissionsPolicy()) {
        fail("blocked-by-policy", name)
        return
      }
      void queryMicrophonePermission().then((status) => {
        if (!active(id)) return
        if (!status) {
          // Nothing can tell these apart here, so the copy for `denied` carries the day — it is the
          // only one of the two that stays broken, and advice to check site settings is harmless to
          // somebody who merely closed the dialog. This is the ordinary path in Safari, which has
          // no `microphone` permission descriptor.
          fail("denied", name)
          return
        }
        setPermission(status.state)
        permissionRef.current = status.state
        if (status.state === "denied") {
          fail("denied", name)
          return
        }
        // Refused while the stored answer is "granted" can only come from above the user — a frame
        // or a header — so sending them to their own settings would be wrong.
        if (status.state === "granted") {
          fail("blocked-by-policy", name)
          return
        }
        // Still "prompt": nothing was stored, so the dialog was closed rather than answered. This
        // is the one refusal worth offering a retry for, and asking again really re-prompts.
        fail("dismissed", name)
      })
    }

    try {
      // `video: false`, not omitted. Asking for video as well lights the camera indicator and puts
      // a second permission in front of somebody who wanted to record a voice note.
      const request = api.getUserMedia({ audio, video: false })
      request.then(settle, reject)
    } catch (error) {
      // A browser that throws synchronously rather than rejecting — the prefixed implementations
      // did, and a TypeError for malformed constraints still does.
      reject(error)
    }
  }, [active, fail, finalize, finishRecorder, release, releaseRecording, startMeter, startTimer])

  const pause = React.useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== "recording") return
    try {
      // Asked first, and the clock only stopped once it agreed. `pause` is the one method here that
      // an implementation may simply not have, and banking the time before finding that out would
      // leave a recorder that is still running with a clock that has stopped.
      recorder.pause()
    } catch {
      return
    }
    bankedRef.current = measure()
    startedAtRef.current = 0
    stopTimer()
    stopMeter()
    levelRef.current = 0
    setLevel(0)
    setIsClipping(false)
    setElapsed(bankedRef.current)
    setPhase("paused")
  }, [measure, stopMeter, stopTimer])

  const resume = React.useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== "paused") return
    try {
      recorder.resume()
    } catch {
      return
    }
    startedAtRef.current = Date.now()
    silentForRef.current = 0
    setIsSilent(false)
    setPhase("recording")
    startMeter()
    startTimer()
  }, [startMeter, startTimer])

  const discard = React.useCallback(() => {
    // Bumping the id first orphans anything still in flight, and `release` detaches the recorder's
    // own handlers, so a `stop` event for a recording that was thrown away cannot arrive later and
    // hand it back.
    sessionRef.current += 1
    pendingRef.current = false
    interruptedRef.current = false
    release()
    releaseRecording()
    chunksRef.current = []
    bankedRef.current = 0
    startedAtRef.current = 0
    failureRef.current = null
    setRecording(null)
    setFailure(null)
    setElapsed(0)
    setIsSilent(false)
    setPhase("idle")
  }, [release, releaseRecording])

  /**
   * Reads the stored permission and keeps the dead end honest.
   *
   * The `change` event is the reason this is a subscription rather than one read. A user sent to
   * site settings by the `denied` message comes back to a page that is still open, and the browser
   * fires `change` the moment they flip the switch. Handling it turns "allow it in your settings"
   * into advice that visibly works; ignoring it leaves the button dead until a reload, which is the
   * point at which people conclude the site is broken.
   */
  React.useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false

    const handleChange = () => {
      if (!status) return
      const next = status.state
      setPermission(next)
      permissionRef.current = next
      if (next === "denied") return
      if (failureRef.current?.cause === "denied") {
        failureRef.current = null
        setFailure(null)
        setPhase("idle")
      }
    }

    void queryMicrophonePermission().then((result) => {
      if (cancelled || !result) return
      status = result
      setPermission(result.state)
      permissionRef.current = result.state
      result.addEventListener("change", handleChange)
    })

    return () => {
      cancelled = true
      status?.removeEventListener("change", handleChange)
    }
  }, [])

  // The microphone, the audio context and the object URL all belong to the browser, not to this
  // component, so navigating away inside a single-page app is exactly the moment they would be
  // leaked: the tracks keep the recording indicator lit with no control left that could turn it
  // off, the context holds the audio hardware, and the blob stays in memory.
  React.useEffect(
    () => () => {
      sessionRef.current += 1
      release()
      releaseRecording()
    },
    [release, releaseRecording]
  )

  return {
    phase,
    failure,
    recording,
    elapsed,
    level,
    isClipping,
    isSilent,
    isMetered,
    permission,
    isSupported,
    start,
    stop: finishRecorder,
    pause,
    resume,
    discard,
  }
}

/** How many segments the level meter draws. */
const METER_BARS = 20

export interface AudioRecorderProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children">,
    UseAudioRecorderOptions {
  /** Accessible name for the whole recorder. */
  label?: string
  /** Resting label on the primary button. */
  recordLabel?: string
  stopLabel?: string
  pauseLabel?: string
  resumeLabel?: string
  discardLabel?: string
  againLabel?: string
  retryLabel?: string
  /** Accessible name for the level meter. */
  meterLabel?: string
  /** Accessible name for the playback element. */
  playbackLabel?: string
  /** Per-cause wording, merged over the defaults. */
  messages?: Partial<Record<AudioFailureCause, string>>
  /** Status wording. Each one is announced through the live region as it becomes true. */
  promptingMessage?: string
  startingMessage?: string
  recordingMessage?: string
  pausedMessage?: string
  stoppingMessage?: string
  recordedMessage?: string
  /**
   * Shown and announced once the input has been silent for `silenceTimeout`.
   *
   * The whole reason the meter is here. Say what is actually wrong — nothing is reaching the
   * microphone — rather than "check your microphone", because the usual cause is a mute switch
   * somewhere outside the browser and the browser is reporting everything as fine.
   */
  silentMessage?: string
  /** Hide the message under the controls. It stays in the live region either way. */
  hideMessage?: boolean
  /** Hide the `<audio>` player shown after recording. */
  hidePlayback?: boolean
}

/**
 * A voice-note recorder that shows the level while it records, and hands the microphone back when
 * it stops.
 *
 * There is deliberately no `autoStart`. A component that opens the microphone on mount records
 * whatever is being said in the room before anybody has agreed to it, and on a repeat visit it
 * does so without a prompt, because the grant is already stored. A camera at least shows you its
 * own preview; a microphone gives no sign at all beyond an indicator most people have never
 * noticed. Recording starts on a press.
 */
export function AudioRecorder({
  label = "Voice recorder",
  recordLabel = "Record",
  stopLabel = "Stop",
  pauseLabel = "Pause",
  resumeLabel = "Resume",
  discardLabel = "Discard recording",
  againLabel = "Record again",
  retryLabel = "Try again",
  meterLabel = "Input level",
  playbackLabel = "The recording you just made",
  messages,
  promptingMessage = "Waiting for microphone permission…",
  startingMessage = "Starting the microphone…",
  recordingMessage = "Recording.",
  pausedMessage = "Paused.",
  stoppingMessage = "Finishing the recording…",
  recordedMessage = "Recording finished.",
  silentMessage = "No sound is reaching the microphone — check that it isn't muted.",
  hideMessage = false,
  hidePlayback = false,
  mimeCandidates,
  echoCancellation,
  noiseSuppression,
  autoGainControl,
  deviceId,
  maxDuration,
  silenceTimeout,
  silenceThreshold,
  onStart,
  onRecording,
  onFailure,
  className,
  ...props
}: AudioRecorderProps) {
  const {
    phase,
    failure,
    recording,
    elapsed,
    level,
    isClipping,
    isSilent,
    isMetered,
    start,
    stop,
    pause,
    resume,
    discard,
  } = useAudioRecorder({
    mimeCandidates,
    echoCancellation,
    noiseSuppression,
    autoGainControl,
    deviceId,
    maxDuration,
    silenceTimeout,
    silenceThreshold,
    onStart,
    onRecording,
    onFailure,
  })

  // The message is referenced by id from the primary button, so it needs one that survives
  // hydration.
  const messageId = React.useId()

  const busy = phase === "prompting" || phase === "starting" || phase === "stopping"
  const live = phase === "recording" || phase === "paused"

  const message = failure
    ? (messages?.[failure.cause] ?? failure.message)
    : phase === "prompting"
      ? promptingMessage
      : phase === "starting"
        ? startingMessage
        : phase === "stopping"
          ? stoppingMessage
          : phase === "recording"
            ? // The silence warning displaces the ordinary "Recording." rather than sitting
              // underneath it. Both at once reads as a page describing two different situations,
              // and the one that matters is the one that means the file will be empty.
              isSilent
              ? silentMessage
              : recordingMessage
            : phase === "paused"
              ? isSilent
                ? silentMessage
                : pausedMessage
              : phase === "recorded"
                ? recordedMessage
                : ""

  // The only states where pressing the primary button is a real offer. A failure marked
  // non-retryable keeps the control reachable and says why, rather than dangling an action that
  // cannot work.
  const actionable = !busy && failure?.retryable !== false

  const primaryLabel = live
    ? stopLabel
    : recording
      ? againLabel
      : failure?.retryable
        ? retryLabel
        : recordLabel
  const PrimaryIcon = busy ? Loader2 : live ? Square : failure && !failure.retryable ? TriangleAlert : Mic

  function handlePrimary() {
    if (!actionable) return
    if (live) {
      stop()
      return
    }
    start()
  }

  const lit = Math.round(level * METER_BARS)

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex w-full max-w-sm flex-col gap-3", className)}
      {...props}
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handlePrimary}
          // `aria-disabled` rather than `disabled`, so the control keeps its place in the tab order
          // and can still be reached and read. A real `disabled` button is skipped entirely, which
          // means the one explanation of why recording is unavailable is delivered to everyone
          // except the people who most need it.
          aria-disabled={actionable ? undefined : true}
          aria-busy={busy || undefined}
          aria-describedby={message ? messageId : undefined}
          data-phase={phase}
          data-cause={failure?.cause}
          className={cn(
            "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50",
            live && "border-destructive/60 text-destructive"
          )}
        >
          <PrimaryIcon className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
          {primaryLabel}
        </button>

        {live ? (
          <button
            type="button"
            onClick={phase === "paused" ? resume : pause}
            aria-label={phase === "paused" ? resumeLabel : pauseLabel}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {phase === "paused" ? (
              <Play className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Pause className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        ) : null}

        {/*
          The level meter, and the component's own subject. `role="meter"` rather than a bare
          decorated div because "is any sound arriving" is precisely the thing somebody who cannot
          see the bars most needs, and a meter is not a live region, so reporting it costs nothing:
          it is read when asked for, never announced. The silence warning below is the part that
          does speak, because by then there is something to say.
        */}
        <div
          role="meter"
          aria-label={meterLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(level * 100)}
          aria-valuetext={isSilent ? silentMessage : undefined}
          className="flex h-9 min-w-0 flex-1 items-center gap-[2px]"
        >
          {Array.from({ length: METER_BARS }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={cn(
                "h-3 flex-1 rounded-[1px] bg-muted transition-colors duration-75",
                index < lit && "bg-primary",
                // Only the top of the meter turns red, and only while it is actually there. A
                // recorder that paints the whole bar on a transient peak teaches people to ignore
                // it.
                index < lit && isClipping && index >= METER_BARS - 3 && "bg-destructive"
              )}
            />
          ))}
        </div>

        <span
          className={cn(
            "shrink-0 text-sm tabular-nums",
            phase === "recording" ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {formatDuration(elapsed)}
        </span>

        {recording && !live ? (
          <button
            type="button"
            onClick={discard}
            aria-label={discardLabel}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {recording && !hidePlayback ? (
        /*
          The duration is printed beside the player rather than left to it. A browser's own audio
          controls read the length out of the file, and a MediaRecorder file has not got one — the
          header is written before the length is known and never revisited — so the native timeline
          shows `Infinity`, or nothing, or counts up past the end. The number here was measured
          while the recording happened, which is the only place it was ever available.
        */
        <div className="flex items-center gap-2">
          <audio
            src={recording.url}
            controls
            preload="metadata"
            aria-label={playbackLabel}
            className="h-9 min-w-0 flex-1"
          />
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatDuration(recording.duration)}
          </span>
        </div>
      ) : null}

      {/*
        Mounted from the start and left empty, never conditionally rendered, and never `hidden`.
        A live region inserted into the document already holding its text is not reliably announced,
        and `hidden`, `display:none` and `aria-hidden` all take it out of the accessibility tree,
        which is the same silence as not rendering it. `sr-only` is the one way to hide it visually
        and keep it speaking.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        data-silent={isSilent || undefined}
        data-metered={isMetered || undefined}
        className={cn(
          "text-sm",
          isSilent || failure ? "text-destructive" : "text-muted-foreground",
          (hideMessage || !message) && "sr-only"
        )}
      >
        {message}
      </p>
    </div>
  )
}
