// The whole point of this component is that the obvious version of it is wrong, so the tests are
// written to fail against the obvious version rather than to describe the happy path:
//
//   - believing `navigator.onLine === true` (the captive portal, the dead upstream),
//   - believing the `online` event and clearing the banner on it,
//   - treating a 404 from the probe as "the network is down",
//   - retrying on a fixed schedule, so every tab that failed together comes back together,
//   - probing with no deadline, which hangs forever on a black-holed connection.
//
// Each of those gets a case below that the shipped implementation passes and that version fails.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

// The harness runs effects the way a commit would but never runs their cleanups, so every settle
// pass leaves another copy of the listeners behind. Dispatching to the most recently registered
// handler is what a real commit would leave in place, and keeps a probe count meaning what it says.
function eventTarget(store) {
  return {
    addEventListener(type, fn) {
      store.set(type, [...(store.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      store.set(type, (store.get(type) ?? []).filter((registered) => registered !== fn))
    },
  }
}

const windowListeners = new Map()
const documentListeners = new Map()

globalThis.window = eventTarget(windowListeners)
globalThis.document = { ...eventTarget(documentListeners), visibilityState: "visible" }

function dispatch(store, type) {
  const handlers = store.get(type) ?? []
  handlers[handlers.length - 1]?.()
}

function setOnLine(value) {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: value },
    configurable: true,
    writable: true,
  })
}

/** Replaces global fetch with one whose outcome the test decides, and records what it was asked. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

/** Lets every pending microtask and the odd short timer settle before assertions. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const { nextProbeDelay, checkReachable, NetworkStatus, DEFAULT_PROBE_URL } = loadComponent(
  join(ROOT, "registry", "ui", "network-status.tsx"),
  { stubs: { "lucide-react": icons } }
)

// --- the retry schedule ----------------------------------------------------

test("the retry spacing doubles and then stops at the cap", () => {
  const options = { initialDelay: 1000, maxDelay: 30000, random: () => 1 }
  assert.equal(nextProbeDelay(0, options), 1000)
  assert.equal(nextProbeDelay(1, options), 2000)
  assert.equal(nextProbeDelay(2, options), 4000)
  assert.equal(nextProbeDelay(5, options), 30000)
  assert.equal(nextProbeDelay(9, options), 30000)
})

test("clients that failed together do not come back together", () => {
  const draws = new Set()
  for (let i = 0; i < 200; i++) draws.add(nextProbeDelay(3))
  // A fixed schedule — the version this component is arguing against — produces exactly one value
  // here, and every tab that lost the same access point hits the server on the same tick.
  assert.ok(draws.size > 100, `expected the delay to be spread, got ${draws.size} distinct values`)
})

test("the jitter never collapses to an immediate retry", () => {
  const options = { initialDelay: 1000, maxDelay: 30000 }
  for (let attempt = 0; attempt < 8; attempt++) {
    for (let i = 0; i < 50; i++) {
      const delay = nextProbeDelay(attempt, options)
      // Half of each delay is fixed, so even a zero draw leaves a floor. Full jitter would not.
      assert.ok(delay >= Math.min(30000, 1000 * 2 ** attempt) / 2, `attempt ${attempt} gave ${delay}`)
    }
  }
})

test("an outage long enough to overflow the doubling still returns a real delay", () => {
  // 2 ** 5000 is Infinity, and an unguarded implementation returns NaN or Infinity here, which
  // setTimeout treats as zero — a retry loop that spins at exactly the worst moment.
  const delay = nextProbeDelay(5000, { initialDelay: 1000, maxDelay: 30000 })
  assert.ok(Number.isFinite(delay))
  assert.ok(delay > 0 && delay <= 30000)
})

// --- the probe -------------------------------------------------------------

test("a 404 is a reachable network", async () => {
  // The question is whether packets get to a server and back, and a 404 answers it. An
  // implementation that checks res.ok reports a site with no favicon as permanently offline.
  const fetchStub = stubFetch(async () => ({ ok: false, status: 404 }))
  try {
    assert.equal(await checkReachable(), true)
  } finally {
    fetchStub.restore()
  }
})

test("a connection that fails below HTTP is not reachable", async () => {
  const fetchStub = stubFetch(async () => {
    throw new TypeError("Failed to fetch")
  })
  try {
    assert.equal(await checkReachable(), false)
  } finally {
    fetchStub.restore()
  }
})

test("the probe refuses to follow a redirect, which is how a captive portal is caught", async () => {
  const fetchStub = stubFetch(async () => ({ ok: true, status: 200 }))
  try {
    await checkReachable("/health")
    const { init } = fetchStub.calls[0]
    // A gateway answering for somebody else's server with a 302 to its login page produces a
    // perfectly good response when the redirect is followed — the exact state navigator.onLine is
    // already calling online.
    assert.equal(init.redirect, "error")
    assert.equal(init.method, "HEAD")
    assert.equal(init.cache, "no-store")
    assert.equal(init.credentials, "omit")
  } finally {
    fetchStub.restore()
  }
})

test("the probe is not answered by a cache, and joins its buster onto an existing query", async () => {
  const fetchStub = stubFetch(async () => ({ ok: true, status: 200 }))
  try {
    await checkReachable(DEFAULT_PROBE_URL)
    await checkReachable("/health?deep=1")
    assert.match(fetchStub.calls[0].url, /^\/favicon\.ico\?_=\d+$/)
    assert.match(fetchStub.calls[1].url, /^\/health\?deep=1&_=\d+$/)
  } finally {
    fetchStub.restore()
  }
})

test("a probe that hangs is abandoned rather than left holding the answer", async () => {
  const fetchStub = stubFetch(
    (url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
      })
  )
  try {
    // A black-holed connection does not fail, it hangs. Raced against a longer wait rather than
    // simply awaited, because a version with no deadline does not return a wrong answer here — it
    // returns no answer at all, and an await would hang this suite instead of failing it.
    const verdict = await Promise.race([
      checkReachable("/health", { timeout: 10 }),
      new Promise((resolve) => setTimeout(() => resolve("no deadline — still waiting"), 300)),
    ])
    assert.equal(verdict, false)
  } finally {
    fetchStub.restore()
  }
})

// --- the component ---------------------------------------------------------

const messageOf = (instance) => byRole(walk(instance.tree), "status")[0]?.props?.children

test("an interface that is down is believed, and not probed", async () => {
  setOnLine(false)
  const fetchStub = stubFetch(async () => ({ ok: true, status: 200 }))
  try {
    const instance = render(NetworkStatus, {})
    try {
      await settle()
      assert.equal(messageOf(instance), "You're offline. Trying to reconnect…")
      // Nothing to ask: the browser is not wrong about having no interface, and probing only wakes
      // the radio to fail. The online event is what restarts the loop.
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      instance.unmount()
    }
  } finally {
    fetchStub.restore()
    setOnLine(true)
  }
})

test("the online event does not clear the banner on its own — only a successful probe does", async () => {
  setOnLine(true)
  let reachable = false
  const fetchStub = stubFetch(async () => {
    if (!reachable) throw new TypeError("Failed to fetch")
    return { ok: true, status: 200 }
  })
  try {
    const instance = render(NetworkStatus, { initialDelay: 100000 })
    try {
      assert.equal(messageOf(instance), null)

      dispatch(windowListeners, "offline")
      instance.rerender()
      assert.equal(messageOf(instance), "You're offline. Trying to reconnect…")

      // Joining the café Wi-Fi that still wants a login fires this event, and so does a laptop
      // waking onto a network whose upstream is dead. A component that believes it tells the user
      // they are back while nothing loads.
      dispatch(windowListeners, "online")
      await settle()
      instance.rerender()
      assert.equal(fetchStub.calls.length, 1, "the online event should have started a probe")
      assert.equal(messageOf(instance), "You're offline. Trying to reconnect…")

      reachable = true
      dispatch(windowListeners, "online")
      await settle()
      instance.rerender()
      assert.equal(messageOf(instance), "Back online")
    } finally {
      instance.unmount()
    }
  } finally {
    fetchStub.restore()
  }
})

test("the offline event lands immediately, with no probe to wait for", async () => {
  setOnLine(true)
  const fetchStub = stubFetch(async () => ({ ok: true, status: 200 }))
  try {
    const instance = render(NetworkStatus, {})
    try {
      dispatch(windowListeners, "offline")
      instance.rerender()
      assert.equal(messageOf(instance), "You're offline. Trying to reconnect…")
      assert.equal(fetchStub.calls.length, 0)
    } finally {
      instance.unmount()
    }
  } finally {
    fetchStub.restore()
  }
})

test("a tab nobody is looking at is not probed, and probing resumes when it comes back", async () => {
  setOnLine(true)
  const fetchStub = stubFetch(async () => {
    throw new TypeError("Failed to fetch")
  })
  try {
    // Short enough that several retry windows go by inside the wait below. What is being checked is
    // the scheduled retry itself: a version that only skips the probe when the tab is already hidden
    // at the moment it is asked, but lets its own backoff timer fire regardless, keeps a background
    // tab talking to the server indefinitely and would pass a test that never lets the timer run.
    const instance = render(NetworkStatus, { initialDelay: 20, maxDelay: 20 })
    try {
      dispatch(windowListeners, "online")
      await settle()
      // At this spacing the first retry has usually fired too, so the count is not pinned — only
      // that the loop is running, which is what makes the silence after hiding mean something.
      assert.ok(fetchStub.calls.length >= 1, "the online event should have started a probe")

      globalThis.document.visibilityState = "hidden"
      const beforeHiding = fetchStub.calls.length
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(
        fetchStub.calls.length,
        beforeHiding,
        "a hidden tab learns nothing from a probe, and its retries should park"
      )

      globalThis.document.visibilityState = "visible"
      dispatch(documentListeners, "visibilitychange")
      await settle()
      assert.ok(
        fetchStub.calls.length > beforeHiding,
        "returning to the tab should re-check rather than sit on a stale answer"
      )
    } finally {
      instance.unmount()
    }
  } finally {
    fetchStub.restore()
    globalThis.document.visibilityState = "visible"
  }
})

test("nothing is announced or drawn while the connection is fine", () => {
  setOnLine(true)
  const instance = render(NetworkStatus, {})
  try {
    // The live region stays mounted even so: one inserted together with its text is not reliably
    // announced, which would leave the offline message silent for the people who cannot see it.
    const region = byRole(walk(instance.tree), "status")[0]
    assert.ok(region, "the live region should be mounted before there is anything to say")
    assert.equal(region.props.children, null)
    assert.equal(region.props["aria-live"], "polite")
  } finally {
    instance.unmount()
  }
})
