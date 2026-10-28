// The notification permission is the one browser gate with no second attempt, and almost every
// hand-written version of this button spends it. Each case below is written against a real failure
// mode of the four-line version, and the ones that are not obvious were measured in Chrome 152
// before they were written down (the figures are repeated on the assertions that pin them):
//
//   - offering "Enable notifications" to somebody already blocked, where requestPermission()
//     resolves "denied" in 0.3ms with no prompt, forever, so the button is decoration,
//   - calling `new Notification(...)` inside a try/catch and reporting success from the absence of
//     an exception — measured: constructing while denied throws nothing, returns an object, shows
//     nothing, and fires `error` instead,
//   - treating a closed prompt as a refusal, when nothing was stored and asking again really works,
//   - reading `Notification.permission` during render, which is an accessor that never tells React
//     it changed, and a hydration mismatch besides,
//   - telling an embedded widget's user to fix their site settings, when an opaque origin reads
//     "denied" whatever the top-level page answered — measured in a sandboxed iframe,
//   - staying dead after the user turns notifications back on in site settings, instead of
//     listening for the Permissions API's `change`,
//   - believing `requestPermission()` always returns a promise, when the callback form is older
//     and some browsers only ever shipped that,
//   - opening two prompts because two controls were pressed, or one was pressed twice,
//   - using `disabled` for the refusal, which drops the control out of the tab order and delivers
//     the explanation to everyone except the people who need it,
//   - rendering the message only once there is one, which is the one way to make a live region
//     reliably silent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// One stable component per icon name, carrying its own name, so the tree says which icon was
// chosen. A proxy handing back a fresh anonymous function per access renders the same empty
// output for every state, which makes the whole icon branch invisible to a test.
const iconCache = {}
const icons = new Proxy(
  {},
  { get: (_t, name) => (iconCache[name] ??= Object.assign(() => null, { iconName: name })) }
)
const iconOf = (result) => walk(result.tree).find((n) => n.type?.iconName)

const { NotificationPermissionButton, useNotificationPermission, isNotificationSupported, isOpaqueOrigin } =
  loadComponent(join(ROOT, "registry", "ui", "notification-permission.tsx"), {
    stubs: { "lucide-react": icons },
  })

/**
 * Installs one browser for one test.
 *
 * `notification: false` removes the global entirely rather than setting it undefined, because that
 * is the shape the real absence has. `permissionsApi: false` does the same for
 * `navigator.permissions` — the component has to work without ever being able to ask, which is the
 * state every path here is also exercised in.
 *
 * `form: "callback"` makes `requestPermission` return undefined and deliver its answer to a
 * callback, which is the older of the two signatures and the only one some browsers shipped.
 */
function browser({
  notification = true,
  permission = "default",
  permissionsApi = true,
  form = "promise",
  origin = "https://example.com",
  framed = false,
  serviceWorker = null,
  answer = null,
  requestThrows = false,
  constructorThrows = false,
} = {}) {
  const calls = { request: 0, constructed: [], shown: [], queried: [] }
  const changeListeners = []
  let state = permission
  let pending = null
  let lastNotification = null

  function requestPermission(callback) {
    calls.request += 1
    if (requestThrows) throw new Error("refused")
    const settle = (next) => {
      state = next
      for (const fn of [...changeListeners]) fn()
      return next
    }
    // `answer` lets a test decide when and with what the prompt is answered; without it the
    // prompt stays open until `answerPrompt` is called.
    let deliverToCallback = () => {}
    const promise = new Promise((resolve) => {
      pending = (next) => {
        const settled = settle(next)
        deliverToCallback(settled)
        resolve(settled)
      }
    })
    if (form === "callback") {
      // The old signature: nothing is returned, and the answer arrives through the argument.
      deliverToCallback = (next) => callback?.(next)
      if (answer !== null) pending(answer)
      return undefined
    }
    // "both" is the browser that honours the deprecated callback *and* resolves the promise, which
    // is what the specification actually describes. One press must still be one outcome.
    if (form === "both") deliverToCallback = (next) => callback?.(next)
    if (answer !== null) pending(answer)
    return promise
  }

  class FakeNotification {
    constructor(title, options) {
      calls.constructed.push({ title, options })
      if (constructorThrows) throw new TypeError("constructor unavailable on this platform")
      this.title = title
      this.listeners = {}
      lastNotification = this
    }
    addEventListener(type, fn) {
      ;(this.listeners[type] ??= []).push(fn)
    }
    fire(type) {
      for (const fn of this.listeners[type] ?? []) fn({ type })
    }
  }
  Object.defineProperty(FakeNotification, "permission", { get: () => state, configurable: true })
  FakeNotification.requestPermission = requestPermission

  const win = { self: {}, top: {} }
  if (framed) win.top = {}
  else win.top = win.self
  if (notification) win.Notification = FakeNotification

  const nav = {}
  if (permissionsApi) {
    nav.permissions = {
      query: async ({ name }) => {
        calls.queried.push(name)
        if (name !== "notifications") throw new TypeError(`unknown permission: ${name}`)
        return {
          get state() {
            return state
          },
          addEventListener(type, fn) {
            if (type === "change") changeListeners.push(fn)
          },
          removeEventListener(type, fn) {
            // Honours `type`, because the real one does: a component that removes the listener
            // under a different name than it added it leaves the listener attached, and a fake
            // that ignores the argument reports that as a clean teardown.
            if (type !== "change") return
            const at = changeListeners.indexOf(fn)
            if (at >= 0) changeListeners.splice(at, 1)
          },
        }
      },
    }
  }
  if (serviceWorker !== null) {
    nav.serviceWorker = {
      getRegistration: async () =>
        serviceWorker === false
          ? undefined
          : {
              showNotification: async (title, options) => {
                if (serviceWorker === "throws") throw new Error("no")
                calls.shown.push({ title, options })
              },
            },
    }
  }

  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true })
  globalThis.window = win
  globalThis.location = { origin }

  return {
    calls,
    /** How many `change` listeners are live right now — the subscription, and its teardown. */
    get changeListenerCount() {
      return changeListeners.length
    },
    /** Answer the prompt that is open, with the permission the browser ends up storing. */
    answerPrompt: (next) => pending?.(next),
    /** Change the stored permission the way site settings would, and fire `change`. */
    setPermission(next) {
      state = next
      for (const fn of [...changeListeners]) fn()
    },
    get lastNotification() {
      return lastNotification
    },
  }
}

/** Lets `permissions.query()` and its continuations run before the tree is read again. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

const buttonOf = (result) => byTag(walk(result.tree), "button")[0]
const messageOf = (result) => byTag(walk(result.tree), "p")[0]

function click(result) {
  buttonOf(result).props.onClick({ defaultPrevented: false })
}

/** Mounts, settles the permission query, and returns the instance. */
async function mount(props = {}) {
  const result = render(NotificationPermissionButton, props)
  await flush()
  result.rerender()
  return result
}

/** Mounts the hook alone, for the parts that are not about the button. */
function Probe(props) {
  Probe.last = useNotificationPermission(props)
  return null
}
async function mountHook(props = {}) {
  const result = render(Probe, props)
  await flush()
  result.rerender()
  return result
}

// --- the dead end ----------------------------------------------------------

test("a blocked origin is never asked again, because asking is a 0.3ms no-op", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()

  click(result)
  result.rerender()

  // The measurement this whole component is built on: on an origin already denied,
  // requestPermission() resolved "denied" in 0.3ms with no prompt, four times running. A button
  // wired to it is a control that cannot work, so the component refuses rather than calling it.
  assert.equal(env.calls.request, 0, "it asked an origin that can never answer differently")
  assert.equal(buttonOf(result).props["data-status"], "denied")
  result.unmount()
})

test("the refusal keeps its place in the tab order and says where the switch is", async () => {
  browser({ permission: "denied" })
  const result = await mount()

  const button = buttonOf(result)
  assert.equal(button.props["aria-disabled"], true)
  assert.equal(button.props.disabled, undefined, "`disabled` hides the explanation from the people who need it")
  assert.match(messageOf(result).props.children, /site settings/i)
  assert.equal(button.props["aria-describedby"], messageOf(result).props.id)
  result.unmount()
})

test("an opaque origin is told the truth, not sent to settings it does not have", async () => {
  // Measured in a sandboxed iframe: location.origin is the string "null", Notification is still a
  // function, permission reads "denied" and requestPermission() resolves "denied" with no prompt —
  // the identical reading to a person who pressed Block, and the opposite advice.
  browser({ permission: "denied", origin: "null" })
  const result = await mount()

  assert.equal(buttonOf(result).props["data-denied-reason"], "embedded")
  assert.doesNotMatch(messageOf(result).props.children, /site settings/i)
  result.unmount()
})

test("isOpaqueOrigin compares against the string, not the value", () => {
  browser({ origin: "null" })
  assert.equal(isOpaqueOrigin(), true)
  browser({ origin: "https://example.com" })
  assert.equal(isOpaqueOrigin(), false)
})

test("it subscribes to the permission so site settings can revive the button", async () => {
  // Asserted on the wiring rather than on a re-render, deliberately. This harness re-runs every
  // effect on every pass, so a component with no subscription at all would still look revived
  // after `rerender()` — the pass that re-reads the permission is the pass the assertion asks
  // for. The subscription is the thing that does not exist in a browser unless it is written, so
  // the subscription is what gets pinned: the descriptor asked for, the listener added, and the
  // listener removed again on unmount.
  const env = browser({ permission: "denied" })
  const result = await mount()

  // The count, not the exact number: this harness runs every effect on every settling pass, so a
  // component whose effect is correctly `[]`-depped still subscribes once per pass here. What is
  // being pinned is that it subscribed at all, to the right descriptor, and let go on unmount.
  assert.deepEqual([...new Set(env.calls.queried)], ["notifications"])
  assert.ok(env.changeListenerCount > 0, "nothing is listening, so a fix in site settings is invisible")

  result.unmount()
  assert.equal(env.changeListenerCount, 0, "the listener outlived the component")
})

test("the revived permission is what the button renders", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  assert.equal(buttonOf(result).props["data-status"], "denied")

  env.setPermission("default")
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-status"], "default")
  assert.equal(buttonOf(result).props["aria-disabled"], undefined, "it stayed dead after the fix")
  assert.equal(buttonOf(result).props.children.at(-1), "Enable notifications")
  result.unmount()
})

// --- asking ----------------------------------------------------------------

test("a press asks exactly once and reports granted", async () => {
  const env = browser({ permission: "default", answer: "granted" })
  const outcomes = []
  const result = await mount({ onOutcome: (o) => outcomes.push(o) })

  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.request, 1)
  assert.deepEqual(outcomes, ["granted"])
  assert.equal(buttonOf(result).props["data-status"], "granted")
  result.unmount()
})

test("a prompt closed without an answer is a dismissal, and asking again is still real", async () => {
  // The resolved value *is* the resulting permission, so "default" back means nothing was stored.
  // Reporting that as a refusal is what makes a component give up on somebody who never said no.
  const env = browser({ permission: "default", answer: "default" })
  const outcomes = []
  const result = await mount({ onOutcome: (o) => outcomes.push(o) })

  click(result)
  await flush()
  result.rerender()

  assert.deepEqual(outcomes, ["dismissed"])
  assert.equal(buttonOf(result).props["data-status"], "default")
  assert.equal(buttonOf(result).props["aria-disabled"], undefined)

  click(result)
  await flush()
  assert.equal(env.calls.request, 2, "a dismissal can be followed by a real second ask")
  result.unmount()
})

test("two presses in one tick are one prompt", async () => {
  const env = browser({ permission: "default" })
  const result = await mount()

  click(result)
  click(result)
  env.answerPrompt("granted")
  await flush()

  assert.equal(env.calls.request, 1, "the second press opened a second prompt")
  result.unmount()
})

test("the callback form is answered too, not read as a refusal", async () => {
  // `await undefined` is `undefined`, so a component that trusts the promise form sees no answer
  // at all on a browser that only ever shipped the callback — and the natural coercion of that is
  // "not granted".
  // The answer is delivered *after* the call returns, which is the only ordering a real prompt
  // has. Answering synchronously would hide a version that reads `.then` off the undefined return
  // value: the promise is already settled by then, so the throw lands where nothing can see it.
  const env = browser({ permission: "default", form: "callback" })
  const outcomes = []
  const result = await mountHook({ onOutcome: (o) => outcomes.push(o) })

  const pending = Probe.last.request()
  assert.equal(env.calls.request, 1)
  env.answerPrompt("granted")

  assert.equal(await pending, "granted")
  await flush()
  assert.deepEqual(outcomes, ["granted"])
  result.unmount()
})

test("requestPermission is reached synchronously, inside the gesture", async () => {
  const env = browser({ permission: "default" })
  const result = await mount()

  // Not awaited: the browser honours the prompt only while the click that led here is still the
  // active user gesture, so anything awaited in front of the call is what makes the prompt never
  // appear. The call must already have happened by the time the handler returns.
  click(result)
  assert.equal(env.calls.request, 1, "something was awaited before asking")

  env.answerPrompt("granted")
  await flush()
  result.unmount()
})

// --- the states that are not buttons ---------------------------------------

test("a granted origin is shown as settled, and asks for nothing", async () => {
  const env = browser({ permission: "granted" })
  const result = await mount()

  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.request, 0)
  assert.equal(buttonOf(result).props["data-status"], "granted")
  assert.equal(buttonOf(result).props["aria-disabled"], true)
  result.unmount()
})

test("hideWhenGranted renders nothing at all", async () => {
  browser({ permission: "granted" })
  const result = await mount({ hideWhenGranted: true })
  assert.equal(result.tree, null)
  result.unmount()
})

test("a browser without notifications says so instead of offering", async () => {
  const env = browser({ notification: false })
  const result = await mount()

  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.request, 0)
  assert.equal(buttonOf(result).props["data-status"], "unsupported")
  assert.match(messageOf(result).props.children, /can't show notifications/i)
  assert.equal(isNotificationSupported(), false)
  result.unmount()
})

test("it works with no Permissions API at all", async () => {
  const env = browser({ permission: "default", permissionsApi: false, answer: "granted" })
  const result = await mount()

  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.request, 1)
  assert.equal(buttonOf(result).props["data-status"], "granted")
  result.unmount()
})

test("a browser that rejects the descriptor is an ordinary answer, not a crash", async () => {
  // Measured: querying a name the browser does not recognise throws a TypeError rather than
  // resolving, and browsers differ on which names they take.
  const env = browser({ permission: "default" })
  globalThis.navigator.permissions.query = async () => {
    throw new TypeError("unsupported descriptor")
  }
  const result = await mount()

  assert.equal(buttonOf(result).props["data-status"], "default")
  click(result)
  env.answerPrompt("granted")
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["data-status"], "granted")
  result.unmount()
})

// --- notify() --------------------------------------------------------------

test("notify constructs nothing while blocked, because constructing is silent", async () => {
  // The measurement: `new Notification("probe")` on a denied origin threw nothing, returned an
  // object, displayed nothing, and fired `error`. A try/catch around it reports success forever.
  const env = browser({ permission: "denied" })
  const result = await mountHook()

  assert.equal(await Probe.last.notify("hello"), "not-permitted")
  assert.equal(env.calls.constructed.length, 0, "it constructed a notification nobody can see")
  result.unmount()
})

test("notify reports failure from the error event, not from the absence of a throw", async () => {
  // No `serviceWorker` on navigator at all here, which is also the shape that catches a guard
  // written as `typeof navigator !== "undefined" || "serviceWorker" in navigator`: that reads as
  // true on every browser and then dereferences a registration object that is not there.
  const env = browser({ permission: "granted" })
  const result = await mountHook()

  const outcome = Probe.last.notify("hello")
  await flush()
  env.lastNotification.fire("error")
  assert.equal(await outcome, "failed")
  assert.equal(env.calls.constructed.length, 1)
  result.unmount()
})

test("notify reports shown from the show event", async () => {
  const env = browser({ permission: "granted", serviceWorker: false })
  const result = await mountHook()

  const outcome = Probe.last.notify("hello", { body: "there" })
  await flush()
  env.lastNotification.fire("show")
  assert.equal(await outcome, "shown")
  assert.deepEqual(env.calls.constructed[0], { title: "hello", options: { body: "there" } })
  result.unmount()
})

test("silence is reported as unknown, never as success", async () => {
  const env = browser({ permission: "granted", serviceWorker: false })
  const result = await mountHook()

  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realSetTimeout(fn, 0)
  try {
    const outcome = Probe.last.notify("hello")
    assert.equal(await outcome, "unknown", "it called silence a success")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.equal(env.calls.constructed.length, 1)
  result.unmount()
})

test("notify prefers an existing service worker and registers none of its own", async () => {
  const env = browser({ permission: "granted", serviceWorker: true })
  const result = await mountHook()

  assert.equal(await Probe.last.notify("hello", { tag: "x" }), "shown")
  assert.deepEqual(env.calls.shown, [{ title: "hello", options: { tag: "x" } }])
  assert.equal(env.calls.constructed.length, 0, "it used the constructor with a worker available")
  result.unmount()
})

test("a service worker that refuses is a failure, not a silent fallthrough", async () => {
  const env = browser({ permission: "granted", serviceWorker: "throws" })
  const result = await mountHook()

  assert.equal(await Probe.last.notify("hello"), "failed")
  assert.equal(env.calls.constructed.length, 0)
  result.unmount()
})

test("notify on a browser with no Notification at all", async () => {
  browser({ notification: false })
  const result = await mountHook()
  assert.equal(await Probe.last.notify("hello"), "unsupported")
  result.unmount()
})

// --- the region and the wiring ---------------------------------------------

test("the live region is mounted empty from the first render", async () => {
  browser({ permission: "default" })
  const result = await mount()

  const message = messageOf(result)
  assert.equal(message.props.role, "status")
  assert.equal(message.props["aria-live"], "polite")
  assert.equal(message.props.children, "", "the region should be mounted and empty, not absent")
  assert.match(message.props.className, /sr-only/)
  result.unmount()
})

test("the caller's own description is kept, with the reason read last", async () => {
  browser({ permission: "denied" })
  const result = await mount({ "aria-describedby": "caller-hint" })

  assert.equal(buttonOf(result).props["aria-describedby"], `caller-hint ${messageOf(result).props.id}`)
  result.unmount()
})

test("messages can be replaced per situation", async () => {
  browser({ permission: "denied" })
  const result = await mount({ messages: { blocked: "Turn them on in Settings › Safari." } })

  assert.equal(messageOf(result).props.children, "Turn them on in Settings › Safari.")
  result.unmount()
})

test("a caller that prevents the default is obeyed", async () => {
  const env = browser({ permission: "default" })
  const result = await mount({ onClick: (e) => (e.defaultPrevented = true) })

  buttonOf(result).props.onClick({ defaultPrevented: false, preventDefault() {} })
  assert.equal(env.calls.request, 0, "it asked although the caller cancelled the click")
  result.unmount()
})

test("iconOnly keeps the label as the accessible name", async () => {
  browser({ permission: "default" })
  const result = await mount({ iconOnly: true, label: "Turn on alerts" })

  const button = buttonOf(result)
  assert.equal(button.props["aria-label"], "Turn on alerts")
  assert.match(button.props.className, /w-9/)
  result.unmount()
})

test("by default the label is visible text and the message is not hidden", async () => {
  browser({ permission: "denied" })
  const result = await mount()

  const button = buttonOf(result)
  assert.equal(button.props["aria-label"], undefined, "the text is visible, so it needs no label")
  assert.equal(button.props.children.at(-1), "Notifications blocked")
  assert.doesNotMatch(button.props.className, /w-9/)
  assert.doesNotMatch(messageOf(result).props.className, /sr-only/, "the reason was hidden by default")
  result.unmount()
})

test("it is type=button, so it cannot submit the form it sits in", async () => {
  browser({ permission: "default" })
  const result = await mount()
  assert.equal(buttonOf(result).props.type, "button")
  result.unmount()
})

test("while the prompt is open the button says so and is marked busy", async () => {
  const env = browser({ permission: "default" })
  const result = await mount()

  click(result)
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["aria-busy"], true)
  assert.equal(button.props.children.at(-1), "Waiting for permission…")
  assert.equal(button.props["aria-disabled"], true, "a second press would be a second prompt")
  assert.equal(iconOf(result).type.iconName, "Loader2")
  assert.match(iconOf(result).props.className, /animate-spin/)
  assert.equal(iconOf(result).props["aria-hidden"], "true", "a decorative icon must not be read out")

  env.answerPrompt("granted")
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["aria-busy"], undefined)
  assert.equal(buttonOf(result).props.children.at(-1), "Notifications on")
  result.unmount()
})

test("each settled state has its own label", async () => {
  for (const [permission, label, icon] of [
    ["granted", "Notifications on", "BellRing"],
    ["denied", "Notifications blocked", "BellOff"],
    ["default", "Enable notifications", "Bell"],
  ]) {
    browser({ permission })
    const result = await mount()
    assert.equal(buttonOf(result).props.children.at(-1), label, `wrong label for ${permission}`)
    assert.equal(iconOf(result).type.iconName, icon, `wrong icon for ${permission}`)
    assert.doesNotMatch(iconOf(result).props.className, /animate-spin/)
    result.unmount()
  }
  browser({ notification: false })
  const result = await mount()
  assert.equal(buttonOf(result).props.children.at(-1), "Notifications unavailable")
  assert.equal(iconOf(result).type.iconName, "BellOff")
  result.unmount()
})

test("a refusal at the prompt is reported as denied, not as a dismissal", async () => {
  const env = browser({ permission: "default", answer: "denied" })
  const outcomes = []
  const result = await mountHook({ onOutcome: (o) => outcomes.push(o) })

  assert.equal(await Probe.last.request(), "denied")
  assert.deepEqual(outcomes, ["denied"])
  assert.equal(env.calls.request, 1)
  result.unmount()
})

test("request answers unavailable rather than asking, where there is nothing to ask", async () => {
  for (const options of [{ notification: false }, { permission: "denied" }, { permission: "granted" }]) {
    const env = browser(options)
    const result = await mountHook()
    assert.equal(await Probe.last.request(), "unavailable", JSON.stringify(options))
    assert.equal(env.calls.request, 0, JSON.stringify(options))
    result.unmount()
  }
})

test("a browser that throws from requestPermission is unavailable, not a crash", async () => {
  browser({ permission: "default", requestThrows: true })
  const outcomes = []
  const result = await mountHook({ onOutcome: (o) => outcomes.push(o) })

  assert.equal(await Probe.last.request(), "unavailable")
  assert.deepEqual(outcomes, ["unavailable"])
  result.unmount()
})

test("a browser honouring both signatures still produces one outcome", async () => {
  // The specification keeps the deprecated callback as an optional trailing argument of the
  // promise form, so a browser may answer twice for one press. Resolving twice is harmless; but
  // reporting twice would have the caller increment a counter, send an event, or re-render once
  // per signature the browser happens to implement.
  const env = browser({ permission: "default", form: "both", answer: "granted" })
  const outcomes = []
  const result = await mountHook({ onOutcome: (o) => outcomes.push(o) })

  assert.equal(await Probe.last.request(), "granted")
  await flush()
  assert.deepEqual(outcomes, ["granted"], "one press was reported as two answers")
  assert.equal(env.calls.request, 1)
  result.unmount()
})

test("a constructor that refuses is a failure, and is only tried once", async () => {
  const env = browser({ permission: "granted", constructorThrows: true })
  const result = await mountHook()

  assert.equal(await Probe.last.notify("hello"), "failed")
  assert.equal(env.calls.constructed.length, 1)
  result.unmount()
})

test("the wait for a silent platform is bounded at one second", async () => {
  const env = browser({ permission: "granted" })
  const result = await mountHook()

  const delays = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms)
    return realSetTimeout(fn, 0)
  }
  try {
    assert.equal(await Probe.last.notify("hello"), "unknown")
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  // Long enough that a platform which does fire `show` is not cut off and called silent, short
  // enough that a caller awaiting it is not left hanging on one that never will.
  assert.deepEqual(delays, [1000])
  assert.equal(env.calls.constructed.length, 1)
  result.unmount()
})

test("the server render has no notifications and claims none", () => {
  // Not a contrived case: this module is imported on the server of every app that uses it, and a
  // feature detect that reads `window` before checking it exists throws there rather than
  // answering false.
  const realWindow = globalThis.window
  const realLocation = globalThis.location
  delete globalThis.window
  delete globalThis.location
  try {
    assert.equal(isNotificationSupported(), false)
    assert.equal(isOpaqueOrigin(), false)
  } finally {
    globalThis.window = realWindow
    globalThis.location = realLocation
  }
})
