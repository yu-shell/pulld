// A microphone is the one resource on the platform whose failures are all invisible. A camera left
// running lights a lamp; a recording that captured nothing looks, sounds and behaves exactly like a
// recording that worked, right up until somebody tries to listen to it. Every case below is written
// against a version that got one of these wrong:
//
//   - calling recorder.stop() and nothing else, which leaves the tracks live and the tab's
//     recording indicator lit over a page that is not recording,
//   - never closing the AudioContext, which holds the audio hardware and runs a page out of the
//     contexts it is allowed to open,
//   - connecting the analyser on to context.destination, which routes the microphone into the
//     speakers and records the howl,
//   - hard-coding audio/webm, which throws NotSupportedError out of the MediaRecorder constructor
//     on every Safari there has ever been,
//   - saving event.data over a variable instead of accumulating it, which keeps whichever piece
//     arrived last,
//   - reading the duration back off the blob, which is Infinity, or counting it on a timer, which
//     is wrong by however much a background tab was throttled,
//   - trusting that a working MediaRecorder means audio is arriving, when a muted input produces a
//     valid file of digital silence and reports nothing,
//   - concluding silence from wall-clock time, which accuses a backgrounded tab of being muted,
//   - throwing away what was recorded when the headset is unplugged mid-sentence,
//   - taking NotAllowedError at face value and telling everybody to change their site settings,
//     which is wrong advice on http and inside an iframe, where there is no setting and no prompt,
//   - never revoking the object URL, so a voice-note field used ten times pins ten clips in memory.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const {
  AudioRecorder,
  useAudioRecorder,
  isAudioRecorderSupported,
  pickAudioMimeType,
  audioFileExtension,
  formatDuration,
  AUDIO_MIME_CANDIDATES,
} = loadComponent(join(ROOT, "registry", "ui", "audio-recorder.tsx"), {
  stubs: { "lucide-react": icons },
})

const realDateNow = Date.now
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

/** One audio track, with the two things the component does to it. */
function makeStream() {
  const track = {
    kind: "audio",
    stopped: 0,
    onended: null,
    stop() {
      track.stopped += 1
    },
  }
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  }
  return { stream, track }
}

/**
 * Installs one browser for one test.
 *
 * `mediaDevices: false` removes the property rather than setting it undefined, because that is the
 * shape the real absence has — and, on a plain-http origin, the shape a perfectly capable browser
 * has too. `recorder: false` is the separate absence that matters on its own: Safari could reach a
 * microphone for four releases before it could record one.
 */
function browser({
  mediaDevices = true,
  recorder = true,
  permission = "prompt",
  secure = true,
  policyAllows = true,
  /** What `MediaRecorder.isTypeSupported` says yes to. */
  supports = ["audio/webm;codecs=opus"],
  /** Whether the static exists at all. It does not on the oldest implementations. */
  hasIsTypeSupported = true,
  /** How many constructions reject the type they were given, as Safari's used to. */
  constructorRejects = 0,
  /** What the recorder reports writing, when that is not what was asked for. */
  writesAs = null,
  audioContext = true,
  contextState = "running",
} = {}) {
  const requests = []
  const recorders = []
  const contexts = []
  const listeners = []
  const urls = { created: [], revoked: [] }
  const intervals = []
  const frames = []
  let state = permission
  let nextUrl = 0
  let now = 1_000_000
  let rejectsLeft = constructorRejects
  /** The signal the analyser reports: alternating +/- amplitude, so rms and peak are both this. */
  let amplitude = 0

  class FakeRecorder {
    constructor(stream, options = {}) {
      if (rejectsLeft > 0) {
        rejectsLeft -= 1
        const error = new Error("mimeType not supported")
        error.name = "NotSupportedError"
        throw error
      }
      this.stream = stream
      this.requested = options.mimeType ?? null
      this.mimeType = writesAs ?? options.mimeType ?? "audio/webm"
      this.state = "inactive"
      this.started = 0
      this.timeslices = []
      this.ondataavailable = null
      this.onstop = null
      this.onerror = null
      recorders.push(this)
    }
    start(timeslice) {
      this.state = "recording"
      this.started += 1
      this.timeslices.push(timeslice)
    }
    stop() {
      if (this.state === "inactive") throw new Error("InvalidStateError")
      this.state = "inactive"
    }
    pause() {
      this.state = "paused"
    }
    resume() {
      this.state = "recording"
    }
    /** Delivers one chunk, the way the platform would. */
    deliver(text, type = this.mimeType) {
      this.ondataavailable?.({ data: new Blob([text], { type }) })
    }
    /** The `stop` event, which arrives after the encoder has flushed. */
    finish() {
      this.onstop?.({})
    }
  }
  if (hasIsTypeSupported) {
    FakeRecorder.isTypeSupported = (type) => supports.includes(type)
  }

  class FakeAudioContext {
    constructor() {
      this.state = contextState
      this.closed = 0
      this.resumed = 0
      this.sources = []
      this.analysers = []
      contexts.push(this)
    }
    createMediaStreamSource(stream) {
      const source = { stream, connectedTo: [], disconnected: 0 }
      source.connect = (node) => source.connectedTo.push(node)
      source.disconnect = () => {
        source.disconnected += 1
      }
      this.sources.push(source)
      return source
    }
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        kind: "analyser",
        getByteTimeDomainData(buffer) {
          const swing = Math.round(amplitude * 128)
          for (let i = 0; i < buffer.length; i += 1) {
            buffer[i] = i % 2 === 0 ? 128 + swing : 128 - swing
          }
        },
      }
      this.analysers.push(analyser)
      return analyser
    }
    async close() {
      this.state = "closed"
      this.closed += 1
    }
    async resume() {
      this.state = "running"
      this.resumed += 1
    }
    get destination() {
      return { kind: "destination" }
    }
  }

  const nav = {}
  if (mediaDevices) {
    nav.mediaDevices = {
      getUserMedia(constraints) {
        const record = { constraints }
        record.promise = new Promise((resolve, reject) => {
          record.resolve = resolve
          record.reject = reject
        })
        requests.push(record)
        return record.promise
      },
    }
  }
  if (permission !== null) {
    nav.permissions = {
      query: async () => ({
        // A getter, so a status handed out before the user answered still reads the new value.
        get state() {
          return state
        },
        addEventListener(type, fn) {
          if (type === "change") listeners.push(fn)
        },
        removeEventListener(type, fn) {
          const at = listeners.indexOf(fn)
          if (at >= 0) listeners.splice(at, 1)
        },
      }),
    }
  }

  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true })
  globalThis.window = { isSecureContext: secure }
  if (recorder) globalThis.window.MediaRecorder = FakeRecorder
  if (audioContext) globalThis.window.AudioContext = FakeAudioContext
  globalThis.document = {}
  if (policyAllows !== null) {
    globalThis.document.permissionsPolicy = { allowsFeature: () => policyAllows }
  }

  URL.createObjectURL = (blob) => {
    const url = `blob:fake/${(nextUrl += 1)}`
    urls.created.push({ url, blob })
    return url
  }
  URL.revokeObjectURL = (url) => urls.revoked.push(url)

  Date.now = () => now
  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, cleared: false }
    intervals.push(handle)
    return handle
  }
  globalThis.clearInterval = (handle) => {
    if (handle) handle.cleared = true
  }
  globalThis.requestAnimationFrame = (fn) => {
    const handle = { fn, cancelled: false }
    frames.push(handle)
    return handle
  }
  globalThis.cancelAnimationFrame = (handle) => {
    if (handle) handle.cancelled = true
  }

  return {
    requests,
    recorders,
    contexts,
    urls,
    intervals,
    get asked() {
      return requests.at(-1)?.constraints
    },
    get recorder() {
      return recorders.at(-1)
    },
    get context() {
      return contexts.at(-1)
    },
    /** Moves the only clock the component measures with. */
    advance(ms) {
      now += ms
    },
    /** Runs the elapsed-time ticker the way a browser would, once. */
    tick() {
      const live = intervals.filter((i) => !i.cleared)
      for (const handle of live) handle.fn()
    },
    /**
     * Delivers one animation frame at `amplitude`, and only one: the loop re-queues itself, so
     * draining would never return. `gap` is how long the browser took to get to it.
     */
    frame(level, gap = 16) {
      amplitude = level
      const pending = frames.filter((f) => !f.cancelled)
      const handle = pending.at(-1)
      if (!handle) return false
      handle.cancelled = true
      now += gap
      handle.fn(now)
      return true
    },
    get framesPending() {
      return frames.filter((f) => !f.cancelled).length
    },
    setPermission(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
    restore() {
      Date.now = realDateNow
      globalThis.setInterval = realSetInterval
      globalThis.clearInterval = realClearInterval
    },
  }
}

/** Lets the getUserMedia continuation and any permission lookup behind it run. */
async function flush() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

const buttons = (result) => byTag(walk(result.tree), "button")
const status = (result) => walk(result.tree).find((node) => node.props?.role === "status")
const meter = (result) => walk(result.tree).find((node) => node.props?.role === "meter")
const player = (result) => byTag(walk(result.tree), "audio")[0]

/** Drives a mounted component into a live recording. */
async function goLive(result, env) {
  buttons(result)[0].props.onClick()
  result.rerender()
  const made = makeStream()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  result.rerender()
  return made
}

/** Records, stops, and lets the recording settle. Returns the stream it used. */
async function recordAndStop(result, env, { text = "audio-bytes", ms = 7000 } = {}) {
  const made = await goLive(result, env)
  env.advance(ms)
  buttons(result)[0].props.onClick()
  result.rerender()
  env.recorder.deliver(text)
  env.recorder.finish()
  await flush()
  result.rerender()
  return made
}

// --- the pure helpers ------------------------------------------------------

test("the mime descent prefers opus and falls through to what the browser admits to", () => {
  const chromium = browser({ supports: ["audio/webm;codecs=opus", "audio/webm"] })
  assert.equal(pickAudioMimeType(), "audio/webm;codecs=opus")
  chromium.restore()

  // Safari: no WebM at all. A component that hard-codes the first candidate throws
  // NotSupportedError out of the constructor here, which is the whole reason for the list.
  const safari = browser({ supports: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"] })
  assert.equal(pickAudioMimeType(), "audio/mp4;codecs=mp4a.40.2")
  safari.restore()

  // Nothing recognised: null means "let the browser choose", which always works, rather than a
  // type that is known to fail.
  const odd = browser({ supports: [] })
  assert.equal(pickAudioMimeType(), null)
  odd.restore()

  // No `isTypeSupported` to ask. Guessing on its behalf would be worse than letting it decide.
  const ancient = browser({ hasIsTypeSupported: false })
  assert.equal(pickAudioMimeType(), null)
  ancient.restore()
})

test("every candidate maps to an extension, and mp4 audio is not called .mp4", () => {
  for (const candidate of AUDIO_MIME_CANDIDATES) {
    assert.notEqual(audioFileExtension(candidate), ".bin", `no extension for ${candidate}`)
  }
  assert.equal(audioFileExtension("audio/webm;codecs=opus"), ".webm")
  // `.m4a`, not `.mp4`: a .mp4 with no video track is handed to video players and opens as a black
  // rectangle.
  assert.equal(audioFileExtension("audio/mp4;codecs=mp4a.40.2"), ".m4a")
  assert.equal(audioFileExtension("AUDIO/OGG"), ".ogg")
  assert.equal(audioFileExtension(null), ".bin")
})

test("durations are formatted without an hour until there is one", () => {
  assert.equal(formatDuration(0), "0:00")
  assert.equal(formatDuration(7400), "0:07")
  assert.equal(formatDuration(62_000), "1:02")
  assert.equal(formatDuration(3_723_000), "1:02:03")
  assert.equal(formatDuration(-5), "0:00")
})

// --- support, and which half is missing -----------------------------------

test("the two halves of support are detected separately", () => {
  const whole = browser()
  assert.equal(isAudioRecorderSupported(), true)
  whole.restore()

  const noMic = browser({ mediaDevices: false })
  assert.equal(isAudioRecorderSupported(), false)
  noMic.restore()

  // The half that is easy to forget. This browser can reach a microphone and cannot record one, so
  // "this browser can't use a microphone" would be a false statement about a working microphone.
  const noRecorder = browser({ recorder: false })
  assert.equal(isAudioRecorderSupported(), false)
  noRecorder.restore()
})

test("an unsupported browser says which half is missing, before anything is pressed", () => {
  const env = browser({ recorder: false })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  assert.equal(failures.length, 1)
  assert.equal(failures[0].cause, "recorder-unsupported")
  assert.equal(failures[0].retryable, false)
  // Reported without a click, so the copy is on screen before anybody tries.
  assert.match(status(result).props.children, /can't record audio/)
  result.unmount()
  env.restore()
})

test("an http origin is reported as insecure, not as a browser without a microphone", () => {
  // MediaDevices is [SecureContext], so on plain http the whole object is genuinely missing and the
  // obvious feature detect fires. The message it leads to — "this browser can't use a microphone" —
  // is false on a browser that records perfectly well and is only refusing this origin.
  const env = browser({ mediaDevices: false, secure: false })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  assert.equal(failures[0].cause, "insecure-context")
  result.unmount()
  env.restore()
})

test("the unsupported failure is announced once, not once per StrictMode pass", () => {
  const env = browser({ mediaDevices: false })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  result.rerender()
  result.rerender()
  assert.equal(failures.length, 1)
  result.unmount()
  env.restore()
})

// --- asking for the microphone --------------------------------------------

test("nothing is requested until the button is pressed", () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  // There is no autoStart on purpose: a component that opens the microphone on mount records the
  // room before anybody agreed to it, and on a second visit does so without a prompt.
  assert.equal(env.requests.length, 0)
  result.unmount()
  env.restore()
})

test("video is explicitly refused so only one permission is asked for", () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  buttons(result)[0].props.onClick()
  // `video: false`, not omitted: asking for video lights the camera indicator and puts a second
  // permission in front of somebody who wanted to record a voice note.
  assert.equal(env.asked.video, false)
  result.unmount()
  env.restore()
})

test("the processing constraints are only sent when they were asked for", () => {
  const plain = browser()
  const a = render(AudioRecorder, {})
  buttons(a)[0].props.onClick()
  // `audio: true`, so the browser's own defaults apply — which are the right ones for speech.
  assert.equal(plain.asked.audio, true)
  a.unmount()
  plain.restore()

  // All three off is the music case: the noise suppressor is tuned to discard what is not a voice,
  // so a guitar loses its decay and the gain control pumps between phrases.
  const music = browser()
  const b = render(AudioRecorder, {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  })
  buttons(b)[0].props.onClick()
  assert.deepEqual(music.asked.audio, {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  })
  b.unmount()
  music.restore()
})

test("a double press does not ask twice", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  buttons(result)[0].props.onClick()
  buttons(result)[0].props.onClick()
  // The first request already holds the device, so the duplicate comes back NotReadableError and
  // somebody who double-tapped Record is told another app has their microphone.
  assert.equal(env.requests.length, 1)
  result.unmount()
  env.restore()
})

test("a permissions-policy block is settled before the microphone is touched", () => {
  const env = browser({ policyAllows: false })
  const result = render(AudioRecorder, {})
  buttons(result)[0].props.onClick()
  assert.equal(env.requests.length, 0)
  result.rerender()
  assert.match(status(result).props.children, /isn't permitted/)
  result.unmount()
  env.restore()
})

// --- NotAllowedError, which is four different things ----------------------

async function refuse(result, env, name = "NotAllowedError") {
  buttons(result)[0].props.onClick()
  const error = new Error(name)
  error.name = name
  env.requests.at(-1).reject(error)
  await flush()
  result.rerender()
}

test("a stored block says so and is not offered a retry", async () => {
  const env = browser({ permission: "denied" })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  await flush()
  await refuse(result, env)
  assert.equal(failures.at(-1).cause, "denied")
  assert.equal(failures.at(-1).retryable, false)
  // The button stays reachable and explains itself rather than offering an action that returns the
  // same error instantly for as long as the page is open.
  assert.equal(buttons(result)[0].props["aria-disabled"], true)
  result.unmount()
  env.restore()
})

test("a dismissed prompt is retryable, because asking again really re-prompts", async () => {
  const env = browser({ permission: "prompt" })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  await flush()
  await refuse(result, env)
  assert.equal(failures.at(-1).cause, "dismissed")
  assert.equal(failures.at(-1).retryable, true)
  assert.equal(buttons(result)[0].props["aria-disabled"], undefined)
  result.unmount()
  env.restore()
})

test("a refusal while the stored answer is granted is blamed on the frame, not the user", async () => {
  const env = browser({ permission: "granted" })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  await flush()
  await refuse(result, env)
  // Refused from above the user — a frame or a header — so sending them to their own settings
  // would be wrong.
  assert.equal(failures.at(-1).cause, "blocked-by-policy")
  result.unmount()
  env.restore()
})

test("without a permission descriptor the advice that stays useful wins", async () => {
  // Safari's ordinary path: it has no `microphone` descriptor, so nothing can tell a stored block
  // from a closed dialog. `denied` is the safe copy — it is the only one of the two that stays
  // broken, and advice to check site settings is harmless to somebody who merely closed the dialog.
  const env = browser({ permission: null })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  await refuse(result, env)
  assert.equal(failures.at(-1).cause, "denied")
  result.unmount()
  env.restore()
})

test("the other rejections are told apart", async () => {
  for (const [name, cause] of [
    ["NotFoundError", "no-microphone"],
    ["NotReadableError", "in-use"],
    ["TrackStartError", "in-use"],
    ["AbortError", "interrupted"],
    ["SecurityError", "blocked-by-policy"],
  ]) {
    const env = browser()
    const failures = []
    const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
    await flush()
    await refuse(result, env, name)
    assert.equal(failures.at(-1).cause, cause, `${name} should be ${cause}`)
    assert.equal(failures.at(-1).code, name)
    result.unmount()
    env.restore()
  }
})

test("a permission fixed in site settings clears the dead end without a reload", async () => {
  const env = browser({ permission: "denied" })
  const result = render(AudioRecorder, {})
  await flush()
  await refuse(result, env)
  assert.equal(buttons(result)[0].props["aria-disabled"], true)

  // The user goes to site settings, flips the switch, and comes back to a page that is still open.
  env.setPermission("granted")
  await flush()
  result.rerender()
  assert.equal(buttons(result)[0].props["aria-disabled"], undefined)
  assert.equal(status(result).props.children, "")
  result.unmount()
  env.restore()
})

// --- the recording itself -------------------------------------------------

test("the recorder is constructed with a type this browser admits to", async () => {
  const env = browser({ supports: ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"] })
  const result = render(AudioRecorder, {})
  await goLive(result, env)
  assert.equal(env.recorder.requested, "audio/mp4;codecs=mp4a.40.2")
  assert.equal(env.recorder.state, "recording")
  // No timeslice: one is only needed to get chunks during recording, and on some implementations it
  // changes how the container is written.
  assert.deepEqual(env.recorder.timeslices, [undefined])
  result.unmount()
  env.restore()
})

test("a constructor that rejects the chosen type is retried with the browser's own default", async () => {
  // isTypeSupported says yes and the constructor throws anyway, which happens. A recording in an
  // unexpected container beats no recording at all.
  const env = browser({ constructorRejects: 1 })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  await goLive(result, env)
  assert.equal(env.recorders.length, 1, "the second construction should have succeeded")
  assert.equal(env.recorder.requested, null)
  assert.equal(env.recorder.state, "recording")
  assert.equal(failures.length, 0)
  result.unmount()
  env.restore()
})

test("a browser that can record nothing at all says so, and hands the microphone back", async () => {
  const env = browser({ constructorRejects: 2 })
  const failures = []
  const result = render(AudioRecorder, { onFailure: (f) => failures.push(f) })
  const made = await goLive(result, env)
  assert.equal(failures.at(-1).cause, "encoding-unsupported")
  assert.equal(failures.at(-1).retryable, false)
  // The stream was already open when this was discovered. Leaving it open would light the recording
  // indicator over a component that has given up.
  assert.equal(made.track.stopped, 1)
  assert.equal(env.context.closed, 1)
  result.unmount()
  env.restore()
})

test("chunks are accumulated, not overwritten by the last one", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await goLive(result, env)
  buttons(result)[0].props.onClick()
  // The specification does not promise one dataavailable at the end. An implementation that
  // delivers three turns `event.data` saved over a variable into a file holding only the last.
  env.recorder.deliver("aaaa")
  env.recorder.deliver("bbbb")
  env.recorder.deliver("cccc")
  env.recorder.finish()
  await flush()
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].size, 12)
  assert.equal(recordings[0].blob.size, 12)
  result.unmount()
  env.restore()
})

test("the type reported is the one the recorder wrote, not the one requested", async () => {
  const env = browser({ supports: ["audio/webm;codecs=opus"], writesAs: "audio/mp4" })
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await recordAndStop(result, env)
  // Naming the upload from the request hands the server an MP4 called WebM.
  assert.equal(recordings[0].type, "audio/mp4")
  assert.equal(audioFileExtension(recordings[0].type), ".m4a")
  result.unmount()
  env.restore()
})

test("a recording that produced no bytes is a failure, not a zero-byte clip", async () => {
  const env = browser()
  const recordings = []
  const failures = []
  const result = render(AudioRecorder, {
    onRecording: (r) => recordings.push(r),
    onFailure: (f) => failures.push(f),
  })
  await goLive(result, env)
  buttons(result)[0].props.onClick()
  // Stopped without a single chunk. Handing this back as a recording gives the caller an empty
  // blob to upload and a player with nothing in it.
  env.recorder.finish()
  await flush()
  result.rerender()
  assert.equal(recordings.length, 0)
  assert.equal(failures.at(-1).cause, "empty")
  assert.equal(player(result), undefined)
  result.unmount()
  env.restore()
})

// --- the duration nobody can read off the file ----------------------------

test("the duration is measured while recording, because the file has not got one", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await recordAndStop(result, env, { ms: 7400 })
  // A MediaRecorder writes its header before it knows the length and never revisits it, so an
  // <audio> element handed this blob reports Infinity. This number was measured as it happened.
  assert.equal(recordings[0].duration, 7400)
  result.unmount()
  env.restore()
})

test("paused time is not counted towards the duration", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await goLive(result, env)

  env.advance(3000)
  // The pause button only exists while recording; it is the second control in the row.
  buttons(result)[1].props.onClick()
  result.rerender()
  assert.equal(env.recorder.state, "paused")

  env.advance(60_000) // the user answers the door
  buttons(result)[1].props.onClick()
  result.rerender()
  assert.equal(env.recorder.state, "recording")

  env.advance(2000)
  buttons(result)[0].props.onClick()
  env.recorder.deliver("x")
  env.recorder.finish()
  await flush()
  assert.equal(recordings[0].duration, 5000)
  result.unmount()
  env.restore()
})

test("the duration survives a throttled tab, because it is not counted on the timer", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await goLive(result, env)
  // Two minutes pass while the tab is in the background. A browser throttles its timers there, so
  // a counter incremented per tick would report a fraction of this; nothing ticks at all here.
  env.advance(120_000)
  buttons(result)[0].props.onClick()
  env.recorder.deliver("x")
  env.recorder.finish()
  await flush()
  assert.equal(recordings[0].duration, 120_000)
  result.unmount()
  env.restore()
})

test("the flush between stop() and the stop event is not added to the duration", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await goLive(result, env)
  env.advance(5000)
  buttons(result)[0].props.onClick()
  // The encoder takes a moment to flush, and the stop event arrives after it. Measuring in the
  // handler would add this to every recording.
  env.advance(900)
  env.recorder.deliver("x")
  env.recorder.finish()
  await flush()
  assert.equal(recordings[0].duration, 5000)
  result.unmount()
  env.restore()
})

test("maxDuration stops the recording on measured time, not on a tick count", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, {
    maxDuration: 10_000,
    onRecording: (r) => recordings.push(r),
  })
  await goLive(result, env)

  env.advance(9000)
  env.tick()
  result.rerender()
  assert.equal(env.recorder.state, "recording", "stopped early")

  env.advance(1500)
  env.tick()
  result.rerender()
  assert.equal(env.recorder.state, "inactive")
  env.recorder.deliver("x")
  env.recorder.finish()
  await flush()
  assert.equal(recordings[0].duration, 10_500)
  result.unmount()
  env.restore()
})

// --- the silent microphone ------------------------------------------------

test("a muted input is detected, which nothing in the platform reports", async () => {
  const env = browser()
  const result = render(AudioRecorder, { silenceTimeout: 1000 })
  await goLive(result, env)

  // getUserMedia resolved, the track is live, MediaRecorder is running, and what is being written
  // is digital silence. The only evidence is the level.
  for (let i = 0; i < 20; i += 1) env.frame(0, 100)
  result.rerender()
  assert.match(status(result).props.children, /No sound is reaching/)
  assert.equal(status(result).props["data-silent"], true)
  assert.match(status(result).props.className, /text-destructive/)
  result.unmount()
  env.restore()
})

test("sound arriving clears the warning", async () => {
  const env = browser()
  const result = render(AudioRecorder, { silenceTimeout: 1000 })
  await goLive(result, env)
  for (let i = 0; i < 20; i += 1) env.frame(0, 100)
  result.rerender()
  assert.equal(status(result).props["data-silent"], true)

  env.frame(0.4, 100)
  result.rerender()
  assert.equal(status(result).props["data-silent"], undefined)
  assert.match(status(result).props.children, /Recording\./)
  result.unmount()
  env.restore()
})

test("silence is counted in frames, so a backgrounded tab is not accused of being muted", async () => {
  const env = browser()
  const result = render(AudioRecorder, { silenceTimeout: 3000 })
  await goLive(result, env)

  // One frame, then the tab goes to the background and is given no more. Half a minute of
  // wall-clock passes. A silence timer driven by the clock would conclude the microphone is muted
  // and tell the user their recording is empty; there is no evidence of that, only an absence of
  // evidence.
  env.frame(0.5, 16)
  env.advance(30_000)
  result.rerender()
  assert.equal(status(result).props["data-silent"], undefined)

  // And the gap is not banked either: the first frame after coming back must not carry 30 seconds
  // of silence with it.
  env.frame(0, 16)
  result.rerender()
  assert.equal(status(result).props["data-silent"], undefined)
  result.unmount()
  env.restore()
})

test("the meter reports the level and is not a live region", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  await goLive(result, env)
  env.frame(0.5, 16)
  result.rerender()

  const bar = meter(result)
  assert.equal(bar.props["aria-valuemin"], 0)
  assert.equal(bar.props["aria-valuemax"], 100)
  assert.ok(bar.props["aria-valuenow"] > 40, `level was ${bar.props["aria-valuenow"]}`)
  // A meter is read when asked for, never announced. Making it a live region would narrate the
  // level of every syllable.
  assert.equal(bar.props["aria-live"], undefined)
  assert.ok(bar.props["aria-label"])
  result.unmount()
  env.restore()
})

test("the level reaching state is a bucket, not every float the microphone produced", async () => {
  const env = browser()
  let api = null
  function Headless() {
    api = useAudioRecorder({})
    return null
  }
  const result = render(Headless, {})
  api.start()
  result.rerender()
  const made = makeStream()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  result.rerender()

  // Two levels one analyser byte apart — which is what a held note really measures, since no two
  // frames of one come out identical. Quantised, both are the same value, so a steady input sets
  // state once and the subtree is not re-rendered for a bar nobody can see change. (That the
  // re-render does not happen is a React scheduling fact this harness cannot observe; that the
  // value is identical is the property which causes it, and that is checkable here.)
  env.frame(0.5, 16)
  result.rerender()
  const first = api.level
  env.frame(0.508, 16)
  result.rerender()
  assert.equal(api.level, first, "a one-byte change in the signal moved the reported level")

  // A real change still moves it — the meter is quantised, not frozen.
  env.frame(0.5625, 16)
  result.rerender()
  assert.ok(api.level > first, `level stayed at ${first} for a much louder signal`)
  // And on a grid of 32, so the bars have something to be.
  assert.equal(api.level * 32, Math.round(api.level * 32))
  result.unmount()
  env.restore()
})

// --- handing the microphone back -----------------------------------------

test("stopping stops the tracks, not just the recorder", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  const made = await recordAndStop(result, env)
  // recorder.stop() ends the recording. track.stop() is the only thing that ends the capture, and
  // without it the tab's recording indicator stays lit over a page that has finished.
  assert.equal(made.track.stopped, 1)
  result.unmount()
  env.restore()
})

test("stopping closes the audio context", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  await recordAndStop(result, env)
  // An AudioContext left open holds the audio hardware, and a page may only have a handful at
  // once — so a recorder used a few times stops being able to meter at all.
  assert.equal(env.context.closed, 1)
  assert.equal(env.context.sources[0].disconnected, 1)
  result.unmount()
  env.restore()
})

test("the analyser is connected to nothing but the analyser", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  await goLive(result, env)
  const connections = env.context.sources[0].connectedTo
  assert.equal(connections.length, 1)
  // Connecting on to context.destination is the obvious next line and it routes the microphone
  // into the speakers: an immediate feedback howl on any device without headphones, recorded.
  assert.equal(connections[0].kind, "analyser")
  assert.ok(!connections.some((node) => node.kind === "destination"))
  result.unmount()
  env.restore()
})

test("a suspended context is resumed, or the meter measures nothing", async () => {
  const env = browser({ contextState: "suspended" })
  const result = render(AudioRecorder, {})
  await goLive(result, env)
  assert.equal(env.context.resumed, 1)
  result.unmount()
  env.restore()
})

test("unmounting mid-recording hands everything back", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  const made = await goLive(result, env)
  env.frame(0.5, 16)

  // Navigating away inside a single-page app. Nothing on the page can reach the microphone after
  // this, so if it is not released here it stays open for the life of the document.
  result.unmount()
  assert.equal(made.track.stopped, 1)
  assert.equal(env.context.closed, 1)
  assert.equal(env.recorder.state, "inactive")
  assert.equal(env.intervals.every((i) => i.cleared), true, "the ticker kept running")
  assert.equal(env.framesPending, 0, "the meter loop kept running")
  env.restore()
})

test("a stream that arrives after the component has gone is stopped on arrival", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  buttons(result)[0].props.onClick()
  result.unmount()

  const made = makeStream()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  // Nothing is holding this stream and nothing else ever will.
  assert.equal(made.track.stopped, 1)
  assert.equal(env.recorders.length, 0, "a recorder was built for an abandoned session")
  env.restore()
})

test("a stop event from the previous recording cannot tear down the live one", async () => {
  const env = browser()
  const recordings = []
  let api = null
  function Headless() {
    api = useAudioRecorder({ onRecording: (r) => recordings.push(r) })
    return null
  }
  const result = render(Headless, {})

  api.start()
  result.rerender()
  const first = makeStream()
  env.requests.at(-1).resolve(first.stream)
  await flush()
  result.rerender()
  const stale = env.recorder

  // `start` again while the first is still recording. Reachable through the hook (the default
  // layout's button says Stop at this point), and the same shape as every other abandonment: the
  // old recorder is asked to stop, and in a browser its `stop` event arrives whenever the encoder
  // gets round to it — which is after the new stream is open and recording. By then everything
  // the stale event could reach belongs to the new session.
  api.start()
  result.rerender()
  const second = makeStream()
  env.requests.at(-1).resolve(second.stream)
  await flush()
  result.rerender()
  assert.equal(first.track.stopped, 1)
  assert.equal(second.track.stopped, 0)
  assert.equal(api.phase, "recording")

  stale.deliver("from-the-abandoned-take")
  stale.finish()
  await flush()
  result.rerender()

  // The live recording is still live, still holds its microphone, and has not been handed back.
  assert.equal(second.track.stopped, 0, "the live stream was released by a stale stop event")
  assert.equal(env.context.state, "running", "the live context was closed by a stale stop event")
  assert.equal(recordings.length, 0)
  assert.equal(api.phase, "recording")

  // And the abandoned take's bytes did not end up in it.
  env.advance(3000)
  api.stop()
  result.rerender()
  env.recorder.deliver("the-real-take")
  env.recorder.finish()
  await flush()
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].size, "the-real-take".length)
  assert.equal(recordings[0].duration, 3000)
  result.unmount()
  env.restore()
})

test("recording again releases the previous stream and its object URL", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  const first = await recordAndStop(result, env)
  const firstUrl = env.urls.created.at(-1).url

  buttons(result)[0].props.onClick()
  result.rerender()
  const second = makeStream()
  env.requests.at(-1).resolve(second.stream)
  await flush()

  assert.equal(first.track.stopped, 1)
  // An object URL pins its blob in memory until somebody releases it, and a voice-note field is
  // used over and over.
  assert.deepEqual(env.urls.revoked, [firstUrl])
  result.unmount()
  env.restore()
})

test("discarding releases the clip and goes back to idle", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  await recordAndStop(result, env)
  const url = env.urls.created.at(-1).url
  assert.ok(player(result))

  // The discard button is the last control in the row once there is something to discard.
  const discard = buttons(result).at(-1)
  assert.match(discard.props["aria-label"], /Discard/)
  discard.props.onClick()
  result.rerender()

  assert.deepEqual(env.urls.revoked, [url])
  assert.equal(player(result), undefined)
  assert.equal(buttons(result)[0].props["data-phase"], "idle")
  result.unmount()
  env.restore()
})

test("a recording discarded mid-flight cannot come back", async () => {
  const env = browser()
  const recordings = []
  let api = null
  function Headless() {
    api = useAudioRecorder({ onRecording: (r) => recordings.push(r) })
    return null
  }
  const result = render(Headless, {})
  api.start()
  result.rerender()
  const made = makeStream()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  result.rerender()
  const recorder = env.recorder

  // Discarded while recording — which only the hook offers, because the default layout has no
  // cancel control: Stop then Discard is two presses and one fewer button. The platform still has
  // a stop event to deliver for the recorder it was holding, and a version that left the handler
  // attached hands back a recording the user explicitly threw away.
  api.discard()
  result.rerender()
  recorder.deliver("leftover")
  recorder.finish()
  await flush()
  result.rerender()
  assert.equal(recordings.length, 0)
  assert.equal(api.recording, null)
  assert.equal(api.phase, "idle")
  assert.equal(made.track.stopped, 1)
  result.unmount()
  env.restore()
})

// --- the microphone going away under us ----------------------------------

test("a headset unplugged mid-sentence keeps what was recorded and says what happened", async () => {
  const env = browser()
  const recordings = []
  const failures = []
  const result = render(AudioRecorder, {
    onRecording: (r) => recordings.push(r),
    onFailure: (f) => failures.push(f),
  })
  const made = await goLive(result, env)
  env.advance(240_000)

  made.track.onended()
  result.rerender()
  env.recorder.deliver("four-minutes-of-interview")
  env.recorder.finish()
  await flush()
  result.rerender()

  // Both at once, deliberately: the interruption is news, and discarding four minutes of an
  // interview because the headset was unplugged at the end is the one outcome nobody forgives.
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].duration, 240_000)
  assert.equal(failures.at(-1).cause, "interrupted")
  assert.match(status(result).props.children, /Recording stopped/)
  assert.ok(player(result), "the recording was not offered for playback")
  assert.equal(made.track.stopped, 1)
  result.unmount()
  env.restore()
})

test("a recorder error keeps what was captured before the fault", async () => {
  const env = browser()
  const recordings = []
  const result = render(AudioRecorder, { onRecording: (r) => recordings.push(r) })
  await goLive(result, env)
  env.advance(4000)
  env.recorder.onerror({})
  result.rerender()
  env.recorder.deliver("partial")
  env.recorder.finish()
  await flush()
  assert.equal(recordings.length, 1)
  assert.equal(recordings[0].duration, 4000)
  result.unmount()
  env.restore()
})

// --- the shell ------------------------------------------------------------

test("the live region is mounted, empty, and in the accessibility tree from the start", () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  const region = status(result)
  assert.equal(region.props["aria-live"], "polite")
  assert.equal(region.props.children, "")
  // `hidden`, `display:none` and `aria-hidden` all take a live region out of the tree, which is the
  // same silence as not rendering it. Only `sr-only` hides it and keeps it speaking.
  assert.equal(region.props.hidden, undefined)
  assert.equal(region.props["aria-hidden"], undefined)
  assert.match(region.props.className, /sr-only/)
  result.unmount()
  env.restore()
})

test("the phase is on the control, and the recorded clip is offered for playback", async () => {
  const env = browser()
  const result = render(AudioRecorder, {})
  await recordAndStop(result, env, { ms: 7000 })
  assert.equal(buttons(result)[0].props["data-phase"], "recorded")
  const audio = player(result)
  assert.ok(audio)
  assert.equal(audio.props.controls, true)
  assert.ok(audio.props["aria-label"])
  // Printed beside the player because the player cannot work it out: the native timeline reads the
  // length out of the file, and this file has not got one.
  const printed = walk(result.tree).filter((n) => n.props?.children === "0:07")
  assert.ok(printed.length >= 1, "the measured duration is not shown")
  result.unmount()
  env.restore()
})

test("the primary control is never a disabled button", async () => {
  const env = browser({ permission: "denied" })
  const result = render(AudioRecorder, {})
  await flush()
  await refuse(result, env)
  const primary = buttons(result)[0]
  // A real `disabled` button is skipped by assistive technology entirely, which delivers the one
  // explanation of why recording is unavailable to everyone except the people who most need it.
  assert.equal(primary.props.disabled, undefined)
  assert.equal(primary.props["aria-disabled"], true)
  assert.ok(primary.props["aria-describedby"])
  result.unmount()
  env.restore()
})

test("hideMessage keeps the text in the live region", async () => {
  const env = browser()
  const result = render(AudioRecorder, { hideMessage: true })
  await goLive(result, env)
  const region = status(result)
  assert.match(region.props.children, /Recording/)
  assert.match(region.props.className, /sr-only/)
  result.unmount()
  env.restore()
})

test("the hook is usable on its own", async () => {
  const env = browser()
  let api = null
  function Headless() {
    api = useAudioRecorder({})
    return null
  }
  const result = render(Headless, {})
  assert.equal(api.phase, "idle")
  api.start()
  result.rerender()
  const made = makeStream()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  result.rerender()
  assert.equal(api.phase, "recording")
  assert.equal(api.isMetered, true)
  result.unmount()
  assert.equal(made.track.stopped, 1)
  env.restore()
})
