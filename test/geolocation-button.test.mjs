// PERMISSION_DENIED is the most overloaded error code on the platform. The specification's "request
// a position" algorithm reaches it from four unrelated places — a Permissions Policy that forbids
// the feature, a non-secure context, a stored "denied", and a prompt the user closed — and hands
// back the identical code for all of them. Every case below is written against a version that took
// that code at face value:
//
//   - telling everyone who hits it to "allow location in your browser settings", which is wrong
//     advice on the http staging box and inside a locked-down iframe, where there is no setting to
//     change and no prompt was ever shown,
//   - trusting `"geolocation" in navigator` as the feature detect, when the attribute is not
//     [SecureContext] and is present, and useless, on every http origin,
//   - offering "Try again" after a stored denial, which cannot re-prompt and returns the same
//     error instantly for as long as the page is open,
//   - *not* offering it after a dismissal, which can,
//   - leaving `timeout` unset, where the browser's default is Infinity and a phone indoors hangs
//     with the spinner still turning,
//   - staying dead after the user fixes the permission in site settings, instead of listening for
//     the change,
//   - calling watchPosition and never clearing it, which leaves the location hardware awake for
//     the life of the page,
//   - using `disabled` to express the refusal, which drops the control out of the tab order so the
//     explanation reaches everyone except the people who need it,
//   - rendering the error text only once there is an error, which is the one way to make a live
//     region reliably silent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const { GeolocationButton, useGeolocation, isGeolocationSupported } = loadComponent(
  join(ROOT, "registry", "ui", "geolocation-button.tsx"),
  { stubs: { "lucide-react": icons } }
)

const DENIED = 1
const UNAVAILABLE = 2
const TIMED_OUT = 3

const FIX = { coords: { latitude: 51.5, longitude: -0.12, accuracy: 30 }, timestamp: 1 }

/**
 * Installs one browser for one test.
 *
 * `permission: null` removes `navigator.permissions` entirely rather than setting it undefined,
 * because that is the shape the real absence has. `policyAllows: null` does the same for
 * `document.permissionsPolicy`, which is genuinely missing outside Chromium — the component has to
 * survive not being able to ask.
 */
function browser({ geolocation = true, permission = "prompt", secure = true, policyAllows = true } = {}) {
  const calls = []
  const cleared = []
  const listeners = []
  let handlers = {}
  let state = permission
  let nextWatchId = 1

  const geo = {
    getCurrentPosition(success, error, options) {
      calls.push({ kind: "get", options })
      handlers = { success, error }
    },
    watchPosition(success, error, options) {
      calls.push({ kind: "watch", options })
      handlers = { success, error }
      return nextWatchId++
    },
    clearWatch(id) {
      cleared.push(id)
    },
  }

  const nav = {}
  if (geolocation) nav.geolocation = geo
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
  globalThis.window = { isSecureContext: secure }
  globalThis.document =
    policyAllows === null ? {} : { permissionsPolicy: { allowsFeature: () => policyAllows } }

  return {
    calls,
    cleared,
    succeed: (fix = FIX) => handlers.success?.(fix),
    /** Note the plain object: the component must read `code`, not the constants on a real error. */
    fail: (code) => handlers.error?.({ code }),
    setPermission(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Lets `permissions.query()` and its continuation run before the tree is read again. */
async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

const buttonOf = (result) => byTag(walk(result.tree), "button")[0]
const messageOf = (result) => byTag(walk(result.tree), "p")[0]

function click(result) {
  buttonOf(result).props.onClick({ defaultPrevented: false })
  result.rerender()
}

/** Mounts, settles the permission query, and returns the instance. */
async function mount(props = {}) {
  const result = render(GeolocationButton, props)
  await flush()
  result.rerender()
  return result
}

test("starts idle, asks for nothing, and already has somewhere to announce from", async () => {
  const env = browser()
  const result = await mount()

  assert.equal(env.calls.length, 0, "a position was requested before anyone asked for one")
  const message = messageOf(result)
  assert.equal(message.props.role, "status")
  assert.equal(message.props["aria-live"], "polite")
  assert.equal(message.props.children, "", "the region should be mounted and empty, not absent")
  assert.match(message.props.className, /sr-only/)
  result.unmount()
})

test("always passes a finite timeout, because the browser's own default is Infinity", async () => {
  const env = browser()
  const result = await mount()
  click(result)

  assert.equal(env.calls.length, 1)
  const { timeout } = env.calls[0].options
  assert.equal(typeof timeout, "number")
  assert.ok(Number.isFinite(timeout) && timeout > 0, `timeout was ${timeout} — a spinner that never stops`)
  result.unmount()
})

test("an http origin is settled without calling, so no mystery denial is ever produced", async () => {
  // The attribute is present here — that is the trap. A feature detect passes and the call would
  // come back PERMISSION_DENIED with no prompt shown.
  const env = browser({ secure: false })
  assert.equal(isGeolocationSupported(), true, "the API is present on http; only calling it fails")

  const result = await mount()
  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.length, 0, "called the API on an insecure origin instead of explaining")
  const button = buttonOf(result)
  assert.equal(button.props["data-cause"], "insecure-context")
  assert.match(messageOf(result).props.children, /secure/i)
  assert.doesNotMatch(
    messageOf(result).props.children,
    /settings/i,
    "sent the user to a settings screen for something no setting can fix"
  )
  result.unmount()
})

test("a frame that forbids the feature is settled without calling", async () => {
  const env = browser({ policyAllows: false })
  const result = await mount()
  click(result)
  await flush()
  result.rerender()

  assert.equal(env.calls.length, 0)
  assert.equal(buttonOf(result).props["data-cause"], "blocked-by-policy")
  assert.doesNotMatch(messageOf(result).props.children, /settings/i)
  result.unmount()
})

test("a stored denial offers no retry, because retrying cannot re-prompt", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["data-cause"], "denied")
  assert.equal(button.props["aria-disabled"], true)
  assert.match(messageOf(result).props.children, /settings/i, "did not say where the way out is")

  // And the refusal is real: pressing it again issues nothing.
  const before = env.calls.length
  click(result)
  assert.equal(env.calls.length, before, "a dead button still fired a request")
  result.unmount()
})

test("a dismissed prompt does offer a retry, because asking again really does re-prompt", async () => {
  // Nothing was stored — the dialog was closed rather than answered — so the state is still
  // "prompt". This is the one denial where trying again is honest.
  const env = browser({ permission: "prompt" })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["data-cause"], "dismissed")
  assert.equal(button.props["aria-disabled"], undefined, "refused a retry that would have worked")

  click(result)
  assert.equal(env.calls.length, 2, "the retry it offered did not ask again")
  result.unmount()
})

test("refused while the stored answer is granted is blamed on the page, not the user", async () => {
  // The policy check sits above the permission check in the algorithm, so a denial arriving while
  // the user has already said yes cannot be the user's doing.
  const env = browser({ permission: "granted", policyAllows: null })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()

  assert.equal(buttonOf(result).props["data-cause"], "blocked-by-policy")
  result.unmount()
})

test("with no Permissions API it falls back to the case that stays broken", async () => {
  const env = browser({ permission: null, policyAllows: null })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["data-cause"], "denied")
  assert.equal(button.props["aria-disabled"], true)
  result.unmount()
})

test("a timeout and an unavailable position stay retryable", async () => {
  for (const [code, cause] of [
    [TIMED_OUT, "timeout"],
    [UNAVAILABLE, "unavailable"],
  ]) {
    const env = browser()
    const result = await mount()
    click(result)
    env.fail(code)
    await flush()
    result.rerender()

    const button = buttonOf(result)
    assert.equal(button.props["data-cause"], cause)
    assert.equal(button.props["aria-disabled"], undefined, `${cause} should be worth another go`)
    result.unmount()
  }
})

test("coming back from site settings clears the dead end without a reload", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()
  assert.equal(buttonOf(result).props["aria-disabled"], true)

  // The user opens site settings, flips the switch, and comes back to the same page.
  env.setPermission("prompt")
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props["data-phase"], "idle", "stayed in the error state after the block was lifted")
  assert.equal(button.props["aria-disabled"], undefined)
  assert.equal(messageOf(result).props.children, "", "kept showing advice that is no longer true")
  result.unmount()
})

test("an unrelated failure survives a permission change", async () => {
  const env = browser({ permission: "prompt" })
  const result = await mount()
  click(result)
  env.fail(TIMED_OUT)
  await flush()
  result.rerender()

  env.setPermission("granted")
  result.rerender()
  assert.equal(
    buttonOf(result).props["data-cause"],
    "timeout",
    "a permission change wiped an error that had nothing to do with permission"
  )
  result.unmount()
})

test("says which wait the spinner is for", async () => {
  const waiting = browser({ permission: "prompt" })
  const prompting = await mount()
  click(prompting)
  assert.equal(buttonOf(prompting).props["data-phase"], "prompting")
  assert.equal(buttonOf(prompting).props["aria-busy"], true)
  prompting.unmount()

  const granted = browser({ permission: "granted" })
  const locating = await mount()
  click(locating)
  assert.equal(buttonOf(locating).props["data-phase"], "locating")
  locating.unmount()
  void waiting
  void granted
})

test("a fix ends the wait and is handed over", async () => {
  const env = browser({ permission: "granted" })
  const seen = []
  const result = await mount({ onPosition: (p) => seen.push(p) })
  click(result)
  env.succeed()
  result.rerender()

  assert.equal(buttonOf(result).props["data-phase"], "success")
  assert.deepEqual(seen, [FIX])
  result.unmount()
})

test("a watch is registered as a watch and handed back on unmount", async () => {
  const env = browser({ permission: "granted" })
  const result = await mount({ watch: true })
  click(result)

  assert.equal(env.calls[0].kind, "watch")
  assert.deepEqual(env.cleared, [])

  result.unmount()
  assert.deepEqual(env.cleared, [1], "the watch outlived the component, keeping the GPS awake")
})

test("a watch keeps reporting rather than stopping at the first fix", async () => {
  const env = browser({ permission: "granted" })
  const seen = []
  const result = await mount({ watch: true, onPosition: (p) => seen.push(p.coords.latitude) })
  click(result)
  env.succeed(FIX)
  result.rerender()
  env.succeed({ ...FIX, coords: { ...FIX.coords, latitude: 48.8 } })
  result.rerender()

  assert.deepEqual(seen, [51.5, 48.8], "the watch stopped being listened to after one update")
  result.unmount()
})

test("the refusal never uses `disabled`, which would remove the explanation from the tab order", async () => {
  const env = browser({ permission: "denied" })
  const result = await mount()
  click(result)
  env.fail(DENIED)
  await flush()
  result.rerender()

  const button = buttonOf(result)
  assert.equal(button.props.disabled, undefined)
  assert.equal(button.props["aria-disabled"], true)
  assert.equal(
    button.props["aria-describedby"],
    messageOf(result).props.id,
    "the button does not point at the reason it is refusing"
  )
  void env
  result.unmount()
})

test("the hook is usable on its own", async () => {
  const env = browser({ permission: "granted" })
  let seen = null
  function Probe() {
    seen = useGeolocation({ timeout: 5000 })
    return null
  }
  const result = render(Probe, {})
  await flush()
  result.rerender()

  assert.equal(seen.phase, "idle")
  seen.request()
  result.rerender()
  assert.equal(env.calls[0].options.timeout, 5000)

  env.succeed()
  result.rerender()
  assert.equal(seen.phase, "success")
  assert.equal(seen.position, FIX)

  seen.clear()
  result.rerender()
  assert.equal(seen.phase, "idle")
  assert.equal(seen.position, null)
  result.unmount()
})
