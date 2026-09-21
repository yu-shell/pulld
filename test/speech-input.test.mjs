// Speech recognition ends by itself, and the only thing it tells your code is an `end` event. That
// single fact is where every hand-rolled dictation button goes wrong, and most of what is below is
// written against a version that got one of these backwards:
//
//   - tracking "recording" with the boolean the click set, so the button keeps a pulsing red dot
//     and the word "Listening" over a microphone the browser handed back a minute ago,
//   - saying "Listening" while the permission dialog is still sitting there unanswered,
//   - reading only `window.SpeechRecognition`, which is absent in every browser that actually
//     ships the feature under the prefixed name,
//   - taking `not-allowed` at face value and telling everybody to change their site settings —
//     wrong on an http origin and inside a locked-down iframe, where no prompt was ever shown and
//     no setting can help,
//   - reporting `aborted` as an error, which puts a failure on screen every time stop is pressed,
//   - restarting on every `end` with no budget, which is a hot loop on a machine with no
//     microphone,
//   - restarting from inside the `end` handler, which the browser is entitled to reject,
//   - carrying the result cursor across a restart, so the first words after every pause vanish —
//     the new session's result list is numbered from zero and the old cursor skips past it,
//   - writing interim text into the field the user is editing, so their content is rewritten under
//     them as the service changes its mind about what it heard,
//   - `value + transcript`, which welds every chunk onto the previous word,
//   - calling `abort()` on stop, which throws away the last thing that was said,
//   - and never aborting on unmount, which leaves the recording indicator lit with no control left
//     anywhere that could turn it off.
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
  Mic: icon("Mic"),
  MicOff: icon("MicOff"),
  TriangleAlert: icon("TriangleAlert"),
}

const { SpeechInputButton, useSpeechInput, isSpeechInputSupported, appendTranscript } =
  loadComponent(join(ROOT, "registry", "ui", "speech-input.tsx"), {
    stubs: { "lucide-react": icons },
  })

/** Builds a SpeechRecognitionResultList out of `[{ text, isFinal }]`. */
function resultList(entries) {
  const list = { length: entries.length }
  entries.forEach((entry, index) => {
    list[index] = { isFinal: entry.isFinal, length: 1, 0: { transcript: entry.text, confidence: 0.9 } }
  })
  return list
}

/**
 * Installs one browser for one test.
 *
 * `prefixed` decides which constructor name the feature hides behind — the default is the prefixed
 * one, because that is the spelling the browsers that have this actually expose, and a component
 * that only reads the unprefixed name has to fail here. `permission: null` removes
 * `navigator.permissions` entirely rather than setting it undefined, because that is the shape the
 * real absence has, and `policyAllows: null` does the same for `document.permissionsPolicy`, which
 * is genuinely missing outside Chromium.
 */
function browser({
  supported = true,
  prefixed = true,
  permission = "prompt",
  secure = true,
  policyAllows = true,
  documentLang = "en-GB",
} = {}) {
  const starts = []
  const calls = []
  const listeners = []
  let instance = null
  let state = permission

  class FakeRecognition {
    constructor() {
      this.lang = ""
      this.continuous = false
      this.interimResults = false
      this.maxAlternatives = 0
      this.onstart = null
      this.onend = null
      this.onerror = null
      this.onresult = null
      instance = this
    }
    start() {
      calls.push("start")
      starts.push({
        lang: this.lang,
        continuous: this.continuous,
        interimResults: this.interimResults,
      })
    }
    stop() {
      calls.push("stop")
    }
    abort() {
      calls.push("abort")
    }
  }

  const scope = { isSecureContext: secure }
  if (supported) {
    if (prefixed) scope.webkitSpeechRecognition = FakeRecognition
    else scope.SpeechRecognition = FakeRecognition
  }

  const nav = { language: "fr-FR" }
  if (permission !== null) {
    nav.permissions = {
      query: async () => ({
        // A getter, so a status handed out before the user answered still reads the new value —
        // which is what the real object does.
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
  globalThis.window = scope
  globalThis.document = {
    documentElement: { lang: documentLang },
    ...(policyAllows === null ? {} : { permissionsPolicy: { allowsFeature: () => policyAllows } }),
  }

  return {
    starts,
    calls,
    get instance() {
      return instance
    },
    fire: {
      start: () => instance?.onstart?.(),
      end: () => instance?.onend?.(),
      error: (code) => instance?.onerror?.({ error: code }),
      result: (entries, resultIndex = 0) =>
        instance?.onresult?.({ resultIndex, results: resultList(entries) }),
    },
    setPermission(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Lets `permissions.query()`, its continuation, and the deferred restart run. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const buttonOf = (result) => byTag(walk(result.tree), "button")[0]
const messageOf = (result) => byTag(walk(result.tree), "p")[0]
const interimOf = (result) =>
  walk(result.tree).find((node) => node.props?.["data-interim"] === "true")?.props?.children
const iconOf = (result) =>
  walk(result.tree).find(
    (node) => typeof node.type === "function" && node.props?.["aria-hidden"] === "true"
  )?.type

function click(result) {
  buttonOf(result).props.onClick({ defaultPrevented: false })
  result.rerender()
}

/** Mounts, settles the permission query, and returns the instance. */
async function mount(props = {}) {
  const result = render(SpeechInputButton, props)
  await flush()
  result.rerender()
  return result
}

// --- the platform, and the four things `not-allowed` means -------------------------------------

test("finds the feature behind the prefixed name, which is the only one browsers ship it under", async () => {
  const env = browser({ prefixed: true })
  assert.equal(isSpeechInputSupported(), true, "read only window.SpeechRecognition")

  const result = await mount()
  click(result)
  assert.equal(env.starts.length, 1)
  result.unmount()
})

test("a browser without it says so, stays reachable, and starts nothing", async () => {
  const env = browser({ supported: false })
  assert.equal(isSpeechInputSupported(), false)

  const result = await mount()
  const button = buttonOf(result)
  assert.equal(button.props["data-status"], "unsupported")
  assert.equal(button.props["aria-disabled"], true, "unreachable controls cannot explain themselves")
  assert.equal(button.props.disabled, undefined, "a real `disabled` drops it out of the tab order")
  assert.equal(iconOf(result), icons.MicOff)

  click(result)
  assert.equal(env.starts.length, 0)
  result.unmount()
})

test("an http origin is settled without starting, so no mystery denial is ever produced", async () => {
  // The constructor is present here — that is the trap. A feature detect passes and starting would
  // come back `not-allowed` with no prompt shown.
  const env = browser({ secure: false })
  assert.equal(isSpeechInputSupported(), true, "the API is present on http; only using it fails")

  const result = await mount()
  click(result)
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 0, "started on an insecure origin instead of explaining")
  assert.equal(buttonOf(result).props["data-cause"], "insecure-context")
  assert.match(messageOf(result).props.children, /secure/i)
  assert.doesNotMatch(
    messageOf(result).props.children,
    /settings/i,
    "sent the user to a settings screen for something no setting can fix"
  )
  result.unmount()
})

test("a frame that forbids the microphone is settled without starting", async () => {
  const env = browser({ policyAllows: false })
  const result = await mount()
  click(result)
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 0)
  assert.equal(buttonOf(result).props["data-cause"], "blocked-by-policy")
  assert.doesNotMatch(messageOf(result).props.children, /settings/i)
  result.unmount()
})

test("a stored denial offers no retry, because retrying cannot re-prompt", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  click(result)
  env.fire.error("not-allowed")
  env.fire.end()
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["data-cause"], "denied")
  assert.equal(button.props["aria-pressed"], false, "still claiming to record after a refusal")
  assert.equal(button.props["aria-disabled"], true)
  assert.match(messageOf(result).props.children, /settings/i, "did not say where the way out is")

  const before = env.starts.length
  click(result)
  assert.equal(env.starts.length, before, "a dead button still started a session")
  result.unmount()
})

test("a dismissed prompt does offer a retry, because asking again really does re-prompt", async () => {
  const env = browser({ permission: "prompt" })
  const result = await mount()
  click(result)
  env.fire.error("not-allowed")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], "dismissed")
  assert.equal(buttonOf(result).props["aria-disabled"], undefined)

  click(result)
  assert.equal(env.starts.length, 2, "a retryable refusal refused to retry")
  result.unmount()
})

test("refused while the permission reads granted is blamed upwards, not on the user", async () => {
  // Granted and still refused can only come from a frame or a header, so sending somebody to their
  // own settings would be advice that cannot possibly work.
  const env = browser({ permission: "granted" })
  const result = await mount()
  click(result)
  env.fire.error("not-allowed")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], "blocked-by-policy")
  assert.doesNotMatch(messageOf(result).props.children, /settings/i)
  result.unmount()
})

test("without the Permissions API the copy still points somewhere that can help", async () => {
  const env = browser({ permission: null })
  const result = await mount()
  click(result)
  env.fire.error("not-allowed")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], "denied")
  assert.match(messageOf(result).props.children, /settings/i)
  result.unmount()
})

test("`aborted` is our own doing and is never reported as a failure", async () => {
  const env = browser()
  const result = await mount()
  click(result)
  env.fire.start()
  result.rerender()

  buttonOf(result).props.onClick({ defaultPrevented: false })
  env.fire.error("aborted")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], undefined, "pressing stop produced an error")
  assert.equal(messageOf(result).props.children, "")
  result.unmount()
})

test("a permission flipped back in site settings clears the dead-end message", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  click(result)
  env.fire.error("not-allowed")
  env.fire.end()
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["data-cause"], "denied")

  env.setPermission("prompt")
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], undefined, "left advice on screen that is now false")
  assert.equal(buttonOf(result).props["aria-disabled"], undefined, "stayed dead until a reload")
  result.unmount()
})

// --- the lie the component exists to stop ------------------------------------------------------

test("a session the browser ends by itself takes the button with it", async () => {
  const env = browser()
  const result = await mount()
  click(result)
  env.fire.start()
  result.rerender()
  assert.equal(buttonOf(result).props["aria-pressed"], true)
  assert.equal(buttonOf(result).props["data-active"], "true")

  // Nothing was clicked. The browser simply stopped, which is what it does after a pause.
  env.fire.end()
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["aria-pressed"], false, "still announcing itself as recording")
  assert.equal(button.props["data-active"], "false")
  assert.equal(button.props["data-status"], "idle")
  result.unmount()
})

test("an unanswered permission dialog is not called listening", async () => {
  const env = browser({ permission: "prompt" })
  const result = await mount()
  click(result)

  const button = buttonOf(result)
  assert.equal(button.props["data-status"], "prompting")
  assert.equal(button.props["data-active"], "false", "claimed the microphone was live")
  assert.match(messageOf(result).props.children, /permission/i)
  assert.doesNotMatch(messageOf(result).props.children, /listening/i)
  result.unmount()
})

test("the status line is a live region that exists before it has anything to say", async () => {
  const env = browser()
  const result = await mount()
  const message = messageOf(result)
  assert.equal(message.props.role, "status")
  assert.equal(message.props["aria-live"], "polite")
  assert.equal(message.props.children, "", "should be mounted and empty, not absent")
  // Visually hidden, which `sr-only` does by clipping, and never hidden outright. `hidden`,
  // `display:none` and `aria-hidden` all take the element out of the accessibility tree, and a live
  // region that is not in the tree is not announced — which is the same silence as not rendering it
  // at all, only harder to spot.
  assert.match(message.props.className, /sr-only/)
  assert.equal(message.props.hidden, undefined, "hidden takes the region out of the accessibility tree")
  assert.equal(message.props["aria-hidden"], undefined)

  // And it is the same element once there is something to say, not a fresh one inserted with its
  // text already in place — which is the one way to make a live region reliably silent.
  click(result)
  env.fire.start()
  result.rerender()
  const announcing = messageOf(result)
  assert.equal(announcing.props.id, message.props.id)
  assert.equal(announcing.props.hidden, undefined)
  assert.doesNotMatch(announcing.props.className, /sr-only/)
  assert.match(announcing.props.children, /listening/i)
  result.unmount()
})

// --- continuous dictation and the restart budget -----------------------------------------------

test("continuous dictation restarts when the browser stops, but not from inside the handler", async () => {
  const env = browser()
  const result = await mount({ continuous: true })
  click(result)
  env.fire.start()
  result.rerender()

  env.fire.end()
  assert.equal(env.starts.length, 1, "started the next session from inside the previous one's `end`")

  await flush()
  result.rerender()
  assert.equal(env.starts.length, 2, "a pause ended the dictation for good")
  assert.equal(buttonOf(result).props["aria-pressed"], true, "the user never asked it to stop")
  result.unmount()
})

test("a restart takes the new session's first words instead of skipping them", async () => {
  // The bug this pins: a restarted session hands back a result list numbered from zero, so a cursor
  // carried over from the session before it skips that many results of the new one. Session one
  // confirms two results; if the cursor survives, session two's own result 0 is never taken.
  const env = browser()
  const taken = []
  const writes = []
  const result = await mount({
    continuous: true,
    value: "",
    onValueChange: (next) => writes.push(next),
    onTranscript: (chunk) => taken.push(chunk),
  })
  click(result)
  env.fire.start()
  // One event confirming two results at once, which is where a `+=` accumulator welds the last word
  // of the first onto the first word of the second.
  env.fire.result([
    { text: "book a table", isFinal: true },
    { text: "for four", isFinal: true },
  ])
  result.rerender()
  assert.deepEqual(taken, ["book a table", "for four"], "reported two confirmed results as one chunk")
  assert.equal(writes.at(-1), "book a table for four", "welded two results of one event together")

  env.fire.end()
  await flush()
  env.fire.start()
  env.fire.result([{ text: "tomorrow at six", isFinal: true }])
  result.rerender()

  assert.deepEqual(taken, ["book a table", "for four", "tomorrow at six"], "dropped the words after the pause")
  result.unmount()
})

test("silent restarts are budgeted, so a muted microphone cannot spin forever", async () => {
  const env = browser()
  const result = await mount({ continuous: true, maxSilentRestarts: 1 })
  click(result)

  env.fire.start()
  env.fire.end()
  await flush()
  assert.equal(env.starts.length, 2, "the budget should allow one restart")

  env.fire.start()
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 2, "restarted past the budget")
  const button = buttonOf(result)
  assert.equal(button.props["aria-pressed"], false)
  assert.equal(button.props["data-cause"], "no-speech")
  result.unmount()
})

test("a session that heard something clears the budget, so a real pause costs nothing", async () => {
  const env = browser()
  const result = await mount({ continuous: true, maxSilentRestarts: 1 })
  click(result)

  env.fire.start()
  env.fire.end() // silent: spends the budget
  await flush()
  env.fire.start()
  env.fire.result([{ text: "still here", isFinal: true }])
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 3, "a pause in the middle of a paragraph ended the dictation")
  assert.equal(buttonOf(result).props["aria-pressed"], true)
  result.unmount()
})

test("silence mid-dictation is a pause, not an error to put on screen", async () => {
  const env = browser()
  const result = await mount({ continuous: true })
  click(result)
  env.fire.start()
  env.fire.error("no-speech")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], undefined, "flashed an error during a pause")

  // For a single utterance it is worth saying, because nothing else will happen.
  const single = await mount()
  click(single)
  env.fire.start()
  env.fire.error("no-speech")
  env.fire.end()
  await flush()
  single.rerender()
  assert.equal(buttonOf(single).props["data-cause"], "no-speech")
  result.unmount()
  single.unmount()
})

test("a standing condition stops dictation instead of being restarted into", async () => {
  const env = browser()
  const result = await mount({ continuous: true })
  click(result)
  env.fire.start()
  env.fire.error("audio-capture")
  env.fire.end()
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 1, "restarted into an error that can only repeat")
  assert.equal(buttonOf(result).props["data-cause"], "no-microphone")
  assert.equal(buttonOf(result).props["aria-pressed"], false)
  result.unmount()
})

// --- taking results without dropping or duplicating them ---------------------------------------

test("a final already taken is not taken again when the event re-reports it", async () => {
  const env = browser()
  const taken = []
  const result = await mount({ onTranscript: (chunk) => taken.push(chunk) })
  click(result)
  env.fire.start()
  env.fire.result([{ text: "hello", isFinal: true }])
  // The list is cumulative: the next event carries the same confirmed result plus a new one.
  env.fire.result([
    { text: "hello", isFinal: true },
    { text: "world", isFinal: true },
  ], 1)
  result.rerender()

  assert.deepEqual(taken, ["hello", "world"])
  result.unmount()
})

test("a final stranded behind an unconfirmed result is still taken when it settles", async () => {
  const env = browser()
  const taken = []
  const result = await mount({ onTranscript: (chunk) => taken.push(chunk) })
  click(result)
  env.fire.start()
  // Result 0 is still being guessed at while result 1 is already confirmed. Moving the cursor past
  // the gap would lose result 0 the moment it settles.
  env.fire.result([
    { text: "eigh", isFinal: false },
    { text: "o'clock", isFinal: true },
  ])
  result.rerender()
  assert.deepEqual(taken, [], "took a result from beyond an unconfirmed one")

  env.fire.result([
    { text: "eight", isFinal: true },
    { text: "o'clock", isFinal: true },
  ])
  result.rerender()
  assert.deepEqual(taken, ["eight", "o'clock"])
  result.unmount()
})

test("interim words are shown but never land in the value", async () => {
  const env = browser()
  const writes = []
  const result = await mount({ value: "", onValueChange: (next) => writes.push(next) })
  click(result)
  env.fire.start()
  env.fire.result([{ text: "eigh", isFinal: false }])
  result.rerender()

  assert.equal(interimOf(result), "eigh", "the live guess should be visible")
  assert.deepEqual(writes, [], "rewrote the user's field with a guess")

  env.fire.result([{ text: "eight", isFinal: true }])
  result.rerender()
  assert.deepEqual(writes, ["eight"])
  assert.equal(interimOf(result), undefined, "a confirmed result left its guess on screen")
  result.unmount()
})

test("an interim that never settles disappears when the session ends", async () => {
  const env = browser()
  const result = await mount()
  click(result)
  env.fire.start()
  env.fire.result([{ text: "half a wor", isFinal: false }])
  result.rerender()
  assert.equal(interimOf(result), "half a wor")

  env.fire.end()
  await flush()
  result.rerender()
  assert.equal(interimOf(result), undefined, "left a guess from a session that is over")
  result.unmount()
})

test("two chunks arriving before the parent re-renders both survive", async () => {
  // The stale-closure bug: appending to the `value` prop as it was when recording started means the
  // second chunk overwrites the first, because the parent has not re-rendered in between.
  const env = browser()
  const writes = []
  const result = await mount({ value: "", onValueChange: (next) => writes.push(next) })
  click(result)
  env.fire.start()
  env.fire.result([{ text: "book a table", isFinal: true }])
  env.fire.result([
    { text: "book a table", isFinal: true },
    { text: "tomorrow", isFinal: true },
  ], 1)
  result.rerender()

  assert.deepEqual(writes, ["book a table", "book a table tomorrow"])
  result.unmount()
})

test("dictation appends to what the field already holds, rather than replacing it", async () => {
  const env = browser()
  const writes = []
  const result = await mount({ value: "Table for four", onValueChange: (next) => writes.push(next) })
  click(result)
  env.fire.start()
  env.fire.result([{ text: "tomorrow at six", isFinal: true }])
  result.rerender()

  assert.deepEqual(writes, ["Table for four tomorrow at six"])
  result.unmount()
})

test("appendTranscript spaces words the way a person typing them would", () => {
  const cases = [
    ["", "hello", "hello", "a leading space in an empty field"],
    ["hello", "world", "hello world", "welded onto the previous word"],
    ["hello", " world", "hello world", "the service's own leading space doubled up"],
    ["hello ", "world", "hello world", "a second space after one that was already there"],
    ["hello", ".", "hello.", "a space before a full stop"],
    ["hello", ", then", "hello, then", "a space before a comma"],
    ["hello", "   ", "hello", "whitespace-only chunk changed the value"],
    ["", "", "", ""],
  ]
  for (const [base, chunk, expected, complaint] of cases) {
    assert.equal(appendTranscript(base, chunk), expected, complaint)
  }
})

// --- configuration, stopping, and handing the microphone back ----------------------------------

test("the language comes from the page, not from whatever the browser's menus are in", async () => {
  const env = browser({ documentLang: "ja-JP" })
  const result = await mount()
  click(result)

  assert.equal(env.starts[0].lang, "ja-JP", "fell back to the user agent's own language")
  result.unmount()

  const explicit = await mount({ lang: "de-DE" })
  click(explicit)
  assert.equal(env.starts[1].lang, "de-DE", "ignored an explicit language")
  explicit.unmount()
})

test("stop asks for the last words instead of throwing them away", async () => {
  const env = browser()
  const result = await mount()
  click(result)
  env.fire.start()
  result.rerender()

  click(result)
  assert.ok(env.calls.includes("stop"), "never asked the service to finish")
  assert.ok(!env.calls.includes("abort"), "aborted on stop, losing the last thing that was said")
  assert.equal(buttonOf(result).props["data-status"], "stopping")

  // The final result really can still arrive after stop was pressed.
  const taken = []
  const held = await mount({ onTranscript: (chunk) => taken.push(chunk) })
  click(held)
  env.fire.start()
  held.rerender()
  click(held)
  env.fire.result([{ text: "and a high chair", isFinal: true }])
  env.fire.end()
  await flush()
  held.rerender()
  assert.deepEqual(taken, ["and a high chair"])
  result.unmount()
  held.unmount()
})

test("unmounting detaches the handlers and hands the microphone back", async () => {
  const env = browser()
  const result = await mount()
  click(result)
  env.fire.start()
  result.rerender()

  const recognition = env.instance
  result.unmount()

  assert.ok(env.calls.includes("abort"), "left the browser recording with no control left to stop it")
  // Detached *before* aborting: `abort()` fires `error` and `end` synchronously, and a handler still
  // attached at that moment runs after the component is gone.
  assert.equal(recognition.onend, null)
  assert.equal(recognition.onerror, null)
  assert.equal(recognition.onresult, null)
  assert.equal(recognition.onstart, null)
})

test("the hook is usable on its own, and starts nothing until asked", async () => {
  const env = browser()
  const probe = (props) => useSpeechInput(props)
  const result = render(probe, {})
  await flush()
  result.rerender()

  assert.equal(env.starts.length, 0)
  assert.equal(result.tree.status, "idle")
  assert.equal(result.tree.isRecording, false)
  assert.equal(result.tree.transcript, "")
  assert.equal(result.tree.interimTranscript, "")

  result.tree.start()
  result.rerender()
  assert.equal(env.starts.length, 1)
  assert.equal(result.tree.isRecording, true)
  result.unmount()
})
