// A wake lock is the one browser resource that is taken away from you silently. There is no error,
// nothing in the console, and the only thing that changes is that the phone in the user's hands
// starts dimming again while your toggle still reads "Screen stays on". So the cases below are
// written against the specific wrong versions:
//
//   - holding one `isOn` boolean and flipping it on click, which is a claim about the lock rather
//     than a reading of it,
//   - never re-acquiring after the tab is hidden, which is that same claim going stale the first
//     time the user checks a message — the single most common thing to get wrong here, and the one
//     that demos perfectly because a demo never leaves the tab,
//   - writing `navigator.wakeLock.request(...)` because TypeScript declared the property
//     non-optional, which is a TypeError on an unsupporting browser and on every http origin,
//   - asking for the lock while the document is hidden, which is a guaranteed NotAllowedError,
//   - reporting that particular NotAllowedError to the user, when it is just a race with the tab
//     switch that the visibility handler is about to fix,
//   - retrying forever after a refusal that is never going to become a yes,
//   - letting the sentinel that arrives after the user switched the toggle off stay held,
//   - firing two overlapping requests and keeping only the second, leaking the first,
//   - never releasing on unmount, which pins the screen awake for the rest of the SPA's life,
//   - announcing the state by swapping the icon, which no screen reader reports,
//   - using `disabled` for the unsupported case, which takes the control out of the tab order so
//     nobody ever hears why it is not available.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const { WakeLockToggle, useWakeLock, isWakeLockSupported } = loadComponent(
  join(ROOT, "registry", "ui", "wake-lock-toggle.tsx"),
  { stubs: { "lucide-react": icons } }
)

const documentListeners = new Map()

globalThis.document = {
  visibilityState: "visible",
  addEventListener(type, fn) {
    documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn])
  },
  removeEventListener(type, fn) {
    documentListeners.set(
      type,
      (documentListeners.get(type) ?? []).filter((registered) => registered !== fn)
    )
  },
}

/**
 * Fires an event at the handler registered last.
 *
 * The harness re-runs every effect on every settling pass without tearing the previous one down,
 * so several identical listeners pile up. Only the newest belongs to the current state; delivering
 * to all of them would run the component's handler against stale closures.
 */
function dispatch(type) {
  const handlers = documentListeners.get(type) ?? []
  return handlers[handlers.length - 1]?.()
}

/** A `WakeLockSentinel` that records its release and can be taken away the way a browser takes it. */
function makeSentinel() {
  const listeners = []
  const sentinel = {
    type: "screen",
    released: false,
    releaseCalls: 0,
    release() {
      sentinel.releaseCalls += 1
      sentinel.released = true
      return Promise.resolve()
    },
    addEventListener(type, fn) {
      if (type === "release") listeners.push(fn)
    },
    removeEventListener() {},
    /** What the browser does when the tab is hidden, the battery dips, or the OS says no more. */
    revoke() {
      sentinel.released = true
      for (const fn of listeners.splice(0)) fn()
    },
  }
  return sentinel
}

/**
 * Installs a `navigator` for one test.
 *
 * `support: false` removes the property entirely rather than setting it undefined, because that is
 * the shape the real absence has and the one `"wakeLock" in navigator` is there to detect.
 */
function browser({ support = true, request } = {}) {
  const sentinels = []
  const requests = []
  const wakeLock = {
    request: (type) => {
      requests.push(type)
      if (request) return request(requests.length)
      const sentinel = makeSentinel()
      sentinels.push(sentinel)
      return Promise.resolve(sentinel)
    },
  }
  Object.defineProperty(globalThis, "navigator", {
    value: support ? { wakeLock } : {},
    configurable: true,
    writable: true,
  })
  return {
    requests,
    sentinels,
    track(sentinel) {
      sentinels.push(sentinel)
      return sentinel
    },
  }
}

/** Lets the request promise and its continuation run before the tree is read again. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

const buttonOf = (result) => byTag(walk(result.tree), "button")[0]

function click(result) {
  buttonOf(result).props.onClick({ defaultPrevented: false })
}

test.beforeEach(() => {
  documentListeners.clear()
  globalThis.document.visibilityState = "visible"
})

test("starts off, holding nothing, and asks for no lock until it is told to", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["aria-pressed"], false)
  assert.equal(button.props["data-state"], "off")
  assert.equal(button.props["data-active"], "false")
  assert.equal(env.requests.length, 0, "a lock was taken before anyone asked for one")
  result.unmount()
})

test("taking the lock is what turns it on — not the click", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()

  // The setting flips at once; the lock has not arrived yet, and the component says so.
  assert.equal(buttonOf(result).props["aria-pressed"], true)
  assert.equal(
    buttonOf(result).props["data-active"],
    "false",
    "claimed a live lock while the request was still in flight"
  )

  await flush()
  result.rerender()
  assert.deepEqual(env.requests, ["screen"])
  assert.equal(buttonOf(result).props["data-active"], "true")
  assert.equal(buttonOf(result).props["data-state"], "on")
  result.unmount()
})

test("the browser taking the lock back is visible, and the setting survives it", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["data-active"], "true")

  // Exactly what happens when the user switches to another tab for ten seconds.
  env.sentinels[0].revoke()
  result.rerender()

  assert.equal(
    buttonOf(result).props["data-active"],
    "false",
    "went on claiming a live lock after the browser released it — the toggle lying is the whole bug"
  )
  assert.equal(
    buttonOf(result).props["aria-pressed"],
    true,
    "the user's setting must survive the tab being hidden; only the lock was lost"
  )
  result.unmount()
})

test("coming back to the tab takes the lock again", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()
  await flush()
  result.rerender()

  globalThis.document.visibilityState = "hidden"
  env.sentinels[0].revoke()
  result.rerender()
  assert.equal(env.requests.length, 1, "asked for a lock while the document was hidden")

  globalThis.document.visibilityState = "visible"
  dispatch("visibilitychange")
  await flush()
  result.rerender()

  assert.equal(
    env.requests.length,
    2,
    "never re-acquired after the tab came back — the toggle reads on and the screen sleeps anyway"
  )
  assert.equal(buttonOf(result).props["data-active"], "true")
  result.unmount()
})

test("switching it off hands the lock back", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()
  await flush()
  result.rerender()

  click(result)
  result.rerender()
  await flush()

  assert.equal(env.sentinels[0].releaseCalls, 1, "left the lock held after being switched off")
  assert.equal(buttonOf(result).props["aria-pressed"], false)
  assert.equal(buttonOf(result).props["data-active"], "false")
  result.unmount()
})

test("unmounting hands the lock back", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()
  await flush()
  result.rerender()

  result.unmount()
  await flush()

  assert.equal(
    env.sentinels[0].releaseCalls,
    1,
    "navigating away left the screen pinned awake with no control left to turn it off"
  )
})

test("a sentinel that arrives after the user changed their mind is not kept", async () => {
  let resolveRequest
  const late = makeSentinel()
  const env = browser({ request: () => new Promise((resolve) => (resolveRequest = resolve)) })
  env.track(late)

  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()

  // Off again before the browser answered.
  click(result)
  result.rerender()

  resolveRequest(late)
  await flush()
  result.rerender()

  assert.equal(late.releaseCalls, 1, "kept a lock the user had already switched off")
  assert.equal(buttonOf(result).props["aria-pressed"], false)
  assert.equal(buttonOf(result).props["data-active"], "false")
  result.unmount()
})

test("overlapping asks do not stack two locks", async () => {
  const env = browser()
  const result = render(WakeLockToggle, {})
  click(result)
  result.rerender()

  // A visibility flap arriving while the first request is still open.
  dispatch("visibilitychange")
  dispatch("visibilitychange")
  await flush()
  result.rerender()

  assert.equal(
    env.requests.length,
    1,
    "issued overlapping requests — every sentinel but the last is leaked and can never be released"
  )
  result.unmount()
})

test("a refusal while the page is visible switches the setting back off and reports it", async () => {
  const errors = []
  const env = browser({
    request: () => Promise.reject(new DOMException("denied by permissions policy", "NotAllowedError")),
  })
  const result = render(WakeLockToggle, { onWakeLockError: (error) => errors.push(error) })
  click(result)
  result.rerender()
  await flush()
  result.rerender()

  assert.equal(
    buttonOf(result).props["aria-pressed"],
    false,
    "stayed on after the browser refused — an iframe without allow=\"screen-wake-lock\" gets a toggle that does nothing"
  )
  assert.equal(errors.length, 1)
  assert.equal(env.requests.length, 1, "retried a refusal that is never going to become a yes")
  result.unmount()
})

test("a request lost to the tab being hidden is a race, not an error", async () => {
  const env = browser({
    request: () => {
      globalThis.document.visibilityState = "hidden"
      return Promise.reject(new DOMException("document is not visible", "NotAllowedError"))
    },
  })
  const errors = []
  const result = render(WakeLockToggle, { onWakeLockError: (error) => errors.push(error) })
  click(result)
  result.rerender()
  await flush()
  result.rerender()

  assert.equal(errors.length, 0, "showed the user an error every time they switched tabs")
  assert.equal(
    buttonOf(result).props["aria-pressed"],
    true,
    "gave up the setting over a race the visibility handler was about to fix"
  )

  globalThis.document.visibilityState = "visible"
  void env
  result.unmount()
})

test("no API: the control stays reachable, explains itself, and never throws", async () => {
  browser({ support: false })
  assert.equal(isWakeLockSupported(), false)

  const result = render(WakeLockToggle, {})
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["aria-disabled"], true)
  assert.equal(
    button.props.disabled,
    undefined,
    "used the disabled attribute, which drops the control out of the tab order so nobody hears why"
  )
  assert.equal(button.props["aria-pressed"], false)

  // The TypeScript trap: `navigator.wakeLock` is declared non-optional, so the naive version
  // reaches straight through it and throws TypeError here rather than reporting "unsupported".
  click(result)
  result.rerender()
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["aria-pressed"], false)
  result.unmount()
})

test("defaultEnabled asks for the lock on mount, with no click to hang it on", async () => {
  const env = browser()
  const result = render(WakeLockToggle, { defaultEnabled: true })
  await flush()
  result.rerender()

  assert.deepEqual(env.requests, ["screen"])
  assert.equal(buttonOf(result).props["data-active"], "true")
  result.unmount()
})

test("the state is on the element, not only in the icon", async () => {
  browser()
  const result = render(WakeLockToggle, { iconOnly: true, onLabel: "Awake", offLabel: "Sleepable" })
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["aria-label"], "Sleepable")
  assert.equal(typeof button.props["aria-pressed"], "boolean")
  const icon = walk(result.tree).find((node) => node.props?.["aria-hidden"] === "true")
  assert.ok(icon, "the decorative icon is not hidden from assistive technology")
  result.unmount()
})

test("the hook reports the setting and the live lock separately", async () => {
  const env = browser()
  let latest
  function Probe() {
    latest = useWakeLock({ defaultEnabled: true })
    return null
  }
  const result = render(Probe, {})
  await flush()
  result.rerender()

  assert.equal(latest.isEnabled, true)
  assert.equal(latest.isActive, true)
  assert.equal(latest.isSupported, true)
  assert.equal(latest.error, null)

  env.sentinels[0].revoke()
  result.rerender()
  assert.equal(latest.isEnabled, true)
  assert.equal(
    latest.isActive,
    false,
    "isActive has to be readable on its own — it is how a caller surfaces that the screen will sleep after all"
  )
  result.unmount()
})

test("asking the hook directly with no API reports it instead of failing silently", async () => {
  browser({ support: false })
  let latest
  function Probe() {
    latest = useWakeLock({ defaultEnabled: true })
    return null
  }
  const result = render(Probe, {})
  await flush()
  result.rerender()

  assert.equal(latest.isSupported, false)
  assert.equal(
    latest.isEnabled,
    false,
    "left the setting on over an API that does not exist — the toggle would sit on forever while the screen dimmed"
  )
  assert.ok(latest.error instanceof Error)
  assert.match(latest.error.message, /secure context/i)
  result.unmount()
})
