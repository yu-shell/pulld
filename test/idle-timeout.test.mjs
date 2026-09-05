// The obvious version of this component counts seconds down with an interval and lives in one tab,
// and both of those are wrong in exactly the situation it exists for. So the cases below are
// written to pass against the shipped implementation and fail against the versions that look right:
//
//   - a tick counter, which a throttled background tab leaves reading high (grace that is not there),
//   - a single long `setTimeout`, which overflows past 2**31-1 ms and fires immediately,
//   - a timer that is never re-read when the tab comes back into view,
//   - a page-local timeout, which signs the user out of a tab they were working in another tab,
//   - adopting whatever deadline a peer sends, rather than the later of the two,
//   - letting passive activity dismiss the warning (unreadable, and it answers nothing),
//   - broadcasting on every mousemove,
//   - firing onIdle once per evaluation rather than once per deadline,
//   - announcing the countdown to a screen reader every second.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

// --- a browser small enough to hold the parts this component touches --------------------------
class HTMLElement {}
globalThis.HTMLElement = HTMLElement

function eventTarget(store) {
  return {
    addEventListener(type, fn) {
      store.set(type, [...(store.get(type) ?? []), fn])
    },
    removeEventListener(type, fn) {
      store.set(
        type,
        (store.get(type) ?? []).filter((registered) => registered !== fn)
      )
    },
  }
}

const windowListeners = new Map()
const documentListeners = new Map()

const storage = new Map()
const localStorage = {
  writes: [],
  setItem(key, value) {
    storage.set(key, value)
    localStorage.writes.push({ key, value })
  },
  getItem: (key) => storage.get(key) ?? null,
}

globalThis.window = { ...eventTarget(windowListeners), localStorage }
globalThis.document = { ...eventTarget(documentListeners), activeElement: null }

// The harness runs effects the way a commit would but never runs their cleanups, so every settle
// pass leaves another copy of a listener behind. Dispatching to the most recently registered one is
// what a real commit would have left in place.
function dispatch(store, type, event) {
  const handlers = store.get(type) ?? []
  handlers[handlers.length - 1]?.(event)
}

/** Every message this tab put on the wire, and a way to deliver one from a peer. */
const channel = { posted: [], listeners: [], closed: 0 }
function installBroadcastChannel() {
  globalThis.BroadcastChannel = class {
    constructor(name) {
      this.name = name
    }
    postMessage(message) {
      channel.posted.push(message)
    }
    addEventListener(type, fn) {
      if (type === "message") channel.listeners.push(fn)
    }
    removeEventListener(type, fn) {
      channel.listeners = channel.listeners.filter((registered) => registered !== fn)
    }
    close() {
      channel.closed += 1
    }
  }
}
/** A message arriving from another tab. */
const fromPeer = (data) => channel.listeners[channel.listeners.length - 1]?.({ data })

// --- a clock the test owns --------------------------------------------------------------------
// `advance` is a browser doing its job: time passes and the due timers run. `jump` is a hidden tab
// or a sleeping laptop: time passes and no timer runs at all. The difference between the two is
// the entire argument of this component, so both are needed.
let now = 1_700_000_000_000
const timers = new Map()
let nextTimerId = 1
let restoreClock = null

function installClock() {
  const realNow = Date.now
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  now = 1_700_000_000_000
  timers.clear()
  Date.now = () => now
  globalThis.setTimeout = (fn, ms) => {
    const id = nextTimerId++
    timers.set(id, { fn, at: now + (Number(ms) || 0) })
    return id
  }
  globalThis.clearTimeout = (id) => timers.delete(id)
  restoreClock = () => {
    Date.now = realNow
    globalThis.setTimeout = realSet
    globalThis.clearTimeout = realClear
    timers.clear()
  }
}

function advance(ms) {
  const target = now + ms
  for (let guard = 0; guard < 100_000; guard++) {
    let dueId = null
    let due = null
    for (const [id, timer] of timers) {
      if (timer.at <= target && (due === null || timer.at < due.at)) {
        dueId = id
        due = timer
      }
    }
    if (due === null) break
    timers.delete(dueId)
    now = Math.max(now, due.at)
    due.fn()
  }
  now = target
}

/** Time passing with every timer frozen — a background tab, or a machine that was asleep. */
const jump = (ms) => {
  now += ms
}

function reset() {
  windowListeners.clear()
  documentListeners.clear()
  storage.clear()
  localStorage.writes.length = 0
  channel.posted.length = 0
  channel.listeners.length = 0
  channel.closed = 0
  document.activeElement = null
  installBroadcastChannel()
  installClock()
}

const {
  idleStateAt,
  nextWakeDelay,
  announceStep,
  formatRemaining,
  spokenRemaining,
  useIdleTimeout,
  IdleTimeout,
  MAX_WAKE_MS,
} = loadComponent(join(ROOT, "registry", "ui", "idle-timeout.tsx"), {
  stubs: { "lucide-react": icons },
})

/** Renders the hook so its return value can be asserted on, and its effects run. */
function hookHarness(props) {
  let latest = null
  const Probe = (p) => {
    latest = useIdleTimeout(p)
    return null
  }
  const instance = render(Probe, props)
  return {
    get session() {
      return latest
    },
    rerender: () => instance.rerender(),
    update: (next) => instance.update(next),
    unmount: () => instance.unmount(),
  }
}

// --- the arithmetic, with no browser in the way ------------------------------------------------

test("state is read off the deadline, not counted towards it", () => {
  const deadline = 1000
  assert.equal(idleStateAt(deadline, 0, 300), "active")
  assert.equal(idleStateAt(deadline, 700, 300), "prompted")
  assert.equal(idleStateAt(deadline, 1000, 300), "idle")
  // The case a tick counter gets wrong: nothing observed the intervening time, and the answer is
  // still exactly right because it was never being accumulated.
  assert.equal(idleStateAt(deadline, 9_999_999, 300), "idle")
})

test("a wait longer than setTimeout can hold is never armed in one go", () => {
  // 2 ** 31 ms is about 24.9 days. A delay above that wraps and fires immediately, so a session
  // measured in days would sign the user out on page load.
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  const delay = nextWakeDelay("active", thirtyDays, 60_000)
  assert.ok(delay <= MAX_WAKE_MS, `armed for ${delay}ms`)
  assert.ok(delay < 2 ** 31 - 1)
  assert.ok(delay > 0)
})

test("the wake lands on the warning when the warning is closer than the cap", () => {
  assert.equal(nextWakeDelay("active", 70_000, 60_000), 10_000)
  assert.equal(nextWakeDelay("active", 600_000, 60_000), MAX_WAKE_MS)
  assert.equal(nextWakeDelay("prompted", 45_000, 60_000), 1_000)
  assert.equal(nextWakeDelay("idle", 0, 60_000), 0)
})

test("a wake is never scheduled for zero, however the numbers come out", () => {
  // A zero-delay re-arm inside a handler that re-arms is a spin, and it happens at the exact
  // moment the warning is due.
  for (const remaining of [60_000, 60_001, 59_999, 0, -5_000]) {
    assert.ok(nextWakeDelay("active", remaining, 60_000) >= 50)
  }
})

test("the announced time changes far less often than the displayed one", () => {
  // One announcement per second is not an aid: each one cuts off the last, and nothing else on the
  // page can be heard while the countdown runs.
  const steps = new Set()
  for (let ms = 120_000; ms > 0; ms -= 1000) steps.add(announceStep(ms))
  assert.ok(steps.size <= 10, `${steps.size} announcements over two minutes`)
  // But the final seconds are each worth hearing.
  assert.notEqual(announceStep(5_000), announceStep(4_000))
  assert.notEqual(announceStep(2_000), announceStep(1_000))
  // ...and the middle of a minute is not.
  assert.equal(announceStep(95_000), announceStep(100_000))
})

test("the clock reads as a clock, and the sentence agrees with it", () => {
  assert.equal(formatRemaining(119_000), "1:59")
  assert.equal(formatRemaining(9_000), "0:09")
  assert.equal(formatRemaining(3_661_000), "1:01:01")
  assert.equal(formatRemaining(-5), "0:00")
  assert.equal(spokenRemaining(119_000), "Signing out in 2 minutes")
  assert.equal(spokenRemaining(60_000), "Signing out in 1 minute")
  assert.equal(spokenRemaining(1_000), "Signing out in 1 second")
})

// --- the tab nobody was looking at --------------------------------------------------------------

test("a tab that was hidden past its deadline is idle the moment it is looked at", () => {
  reset()
  const fired = []
  const probe = hookHarness({
    timeoutMs: 300_000,
    promptBeforeMs: 60_000,
    onIdle: () => fired.push("idle"),
    onPrompt: () => fired.push("prompt"),
  })
  try {
    assert.equal(probe.session.state, "active")
    // Ten minutes pass with every timer frozen — which is what a browser does to a background tab,
    // only more so. A tick counter comes back believing five minutes are left.
    jump(600_000)
    assert.deepEqual(fired, [], "a frozen tab noticed something with no timer to notice it with")
    // Asserted on the callback rather than on the rendered state, because the callback is reached
    // from the listener alone. A version with no `visibilitychange` handler still looks right the
    // moment anything else re-renders the tree, and this is the case that pins the handler itself.
    dispatch(documentListeners, "visibilitychange")
    assert.deepEqual(fired, ["idle"])
    probe.rerender()
    assert.equal(probe.session.state, "idle")
    assert.equal(probe.session.remainingMs, 0)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("focus and a bfcache restore also re-read the clock", () => {
  reset()
  for (const [store, type] of [
    [windowListeners, "focus"],
    [windowListeners, "pageshow"],
  ]) {
    const fired = []
    const probe = hookHarness({
      timeoutMs: 300_000,
      promptBeforeMs: 60_000,
      onIdle: () => fired.push("idle"),
    })
    try {
      jump(600_000)
      dispatch(store, type)
      assert.deepEqual(fired, ["idle"], `${type} did not re-read the deadline`)
    } finally {
      probe.unmount()
    }
  }
  restoreClock()
})

test("onIdle fires once for a deadline however many times the clock is re-read", () => {
  reset()
  let idles = 0
  const probe = hookHarness({ timeoutMs: 60_000, promptBeforeMs: 10_000, onIdle: () => idles++ })
  try {
    advance(60_000)
    probe.rerender()
    assert.equal(idles, 1)
    for (const type of ["visibilitychange"]) dispatch(documentListeners, type)
    dispatch(windowListeners, "focus")
    dispatch(windowListeners, "pageshow")
    advance(60_000)
    probe.rerender()
    assert.equal(idles, 1)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("the warning arrives on its own, without the tab being touched", () => {
  reset()
  const fired = []
  const probe = hookHarness({
    timeoutMs: 300_000,
    promptBeforeMs: 60_000,
    onIdle: () => fired.push("idle"),
    onPrompt: () => fired.push("prompt"),
  })
  try {
    advance(239_000)
    probe.rerender()
    assert.equal(probe.session.state, "active")
    advance(2_000)
    probe.rerender()
    assert.equal(probe.session.state, "prompted")
    assert.deepEqual(fired, ["prompt"])
    assert.ok(probe.session.remainingMs <= 60_000 && probe.session.remainingMs > 0)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

// --- activity ------------------------------------------------------------------------------------

test("activity before the warning pushes the deadline out", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 300_000, promptBeforeMs: 60_000, onIdle: () => {} })
  try {
    advance(200_000)
    dispatch(documentListeners, "keydown")
    advance(200_000)
    probe.rerender()
    // 400s have passed on a 300s timeout; the keystroke at 200s is why the session is still up.
    assert.equal(probe.session.state, "active")
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("passive activity does not answer the warning", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 120_000, promptBeforeMs: 60_000, onIdle: () => {} })
  try {
    advance(61_000)
    probe.rerender()
    assert.equal(probe.session.state, "prompted")
    // A sleeve on the trackpad. A version that clears here cannot be read at all, because reaching
    // for its button clears it — and it stops asking the question it exists to ask.
    dispatch(documentListeners, "mousemove")
    dispatch(documentListeners, "scroll")
    probe.rerender()
    assert.equal(probe.session.state, "prompted")
    // The explicit answer does put it back.
    probe.session.extend()
    probe.rerender()
    assert.equal(probe.session.state, "active")
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("a storm of mouse moves is not a storm of broadcasts", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 300_000, promptBeforeMs: 60_000, onIdle: () => {} })
  try {
    for (let i = 0; i < 600; i++) {
      dispatch(documentListeners, "mousemove")
      advance(100) // sixty seconds of continuous movement
    }
    // Every tab in the browser receives each of these. One per mousemove is 600 messages.
    assert.ok(channel.posted.length <= 15, `${channel.posted.length} messages in a minute`)
    assert.ok(channel.posted.length >= 1, "peers were never told the user is here")
  } finally {
    probe.unmount()
    restoreClock()
  }
})

// --- the other tabs ------------------------------------------------------------------------------

test("a peer that saw the user keeps this tab signed in", () => {
  reset()
  let idles = 0
  const probe = hookHarness({ timeoutMs: 120_000, promptBeforeMs: 30_000, onIdle: () => idles++ })
  try {
    advance(100_000)
    probe.rerender()
    assert.equal(probe.session.state, "prompted")
    // The user has been typing in another tab the whole time. A page-local timeout signs them out
    // of work that was never idle.
    fromPeer({ type: "active", at: now })
    probe.rerender()
    assert.equal(probe.session.state, "active")
    advance(60_000)
    probe.rerender()
    assert.equal(idles, 0)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("a peer's older sighting never shortens this tab's session", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 120_000, promptBeforeMs: 30_000, onIdle: () => {} })
  try {
    // A tab that has been open and untouched reports the sighting it started with. Adopting it
    // blindly lets an idle tab cut short the one being worked in — the deadline moves *backwards*.
    const opened = now
    advance(60_000)
    dispatch(documentListeners, "keydown")
    fromPeer({ type: "active", at: opened })
    advance(70_000)
    probe.rerender()
    // 130s since the tab opened, 70s since the keystroke, on a 120s timeout: still working. A tab
    // that adopts whatever it is sent has just moved its own deadline backwards into the past.
    assert.equal(probe.session.state, "active")
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("signing out in one tab signs out in the rest", () => {
  reset()
  let idles = 0
  const probe = hookHarness({ timeoutMs: 300_000, promptBeforeMs: 60_000, onIdle: () => idles++ })
  try {
    fromPeer({ type: "idle" })
    probe.rerender()
    assert.equal(probe.session.state, "idle")
    assert.equal(idles, 1)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("answering the warning tells the other tabs, so their warnings close too", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 120_000, promptBeforeMs: 60_000, onIdle: () => {} })
  try {
    advance(61_000)
    probe.rerender()
    channel.posted.length = 0
    probe.session.extend()
    probe.rerender()
    assert.equal(channel.posted.length, 1)
    assert.equal(channel.posted[0].type, "active")
    assert.equal(channel.posted[0].at, now)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("the sign-out button ends it here and says so", () => {
  reset()
  let idles = 0
  const probe = hookHarness({ timeoutMs: 300_000, promptBeforeMs: 60_000, onIdle: () => idles++ })
  try {
    probe.session.signOutNow()
    probe.rerender()
    assert.equal(probe.session.state, "idle")
    assert.equal(idles, 1)
    assert.ok(channel.posted.some((m) => m.type === "idle"))
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("without BroadcastChannel the tabs still agree, through storage", () => {
  reset()
  const saved = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  const probe = hookHarness({
    timeoutMs: 120_000,
    promptBeforeMs: 60_000,
    channelName: "session",
    onIdle: () => {},
  })
  try {
    probe.session.extend()
    assert.equal(localStorage.writes.length, 1)
    assert.equal(localStorage.writes[0].key, "session")
    assert.equal(JSON.parse(localStorage.writes[0].value).type, "active")

    // `storage` does not fire for a value that did not change, so two extends landing on the same
    // millisecond must still be two distinct writes or the second one is invisible to every peer.
    probe.session.extend()
    assert.notEqual(localStorage.writes[0].value, localStorage.writes[1].value)

    advance(61_000)
    probe.rerender()
    assert.equal(probe.session.state, "prompted")
    dispatch(windowListeners, "storage", {
      key: "session",
      newValue: JSON.stringify({ type: "active", at: now, n: 9 }),
    })
    probe.rerender()
    assert.equal(probe.session.state, "active")
  } finally {
    probe.unmount()
    globalThis.BroadcastChannel = saved
    restoreClock()
  }
})

test("a storage write under someone else's key is not a session event", () => {
  reset()
  const saved = globalThis.BroadcastChannel
  globalThis.BroadcastChannel = undefined
  const probe = hookHarness({
    timeoutMs: 120_000,
    promptBeforeMs: 60_000,
    channelName: "session",
    onIdle: () => {},
  })
  try {
    dispatch(windowListeners, "storage", { key: "theme", newValue: "dark" })
    // Any app writes to localStorage; a parse of the wrong key must not end or extend a session.
    dispatch(windowListeners, "storage", { key: "session", newValue: "not json" })
    probe.rerender()
    assert.equal(probe.session.state, "active")
  } finally {
    probe.unmount()
    globalThis.BroadcastChannel = saved
    restoreClock()
  }
})

// --- switches ------------------------------------------------------------------------------------

test("disabled means no clock at all, and re-enabling starts a fresh one", () => {
  reset()
  let idles = 0
  const props = { timeoutMs: 60_000, promptBeforeMs: 30_000, disabled: true, onIdle: () => idles++ }
  const probe = hookHarness(props)
  try {
    advance(600_000)
    probe.rerender()
    // The login screen is not an idle session.
    assert.equal(probe.session.state, "active")
    assert.equal(idles, 0)
    probe.update({ ...props, disabled: false })
    advance(60_000)
    probe.rerender()
    assert.equal(idles, 1)
  } finally {
    probe.unmount()
    restoreClock()
  }
})

test("a prompt window longer than the session does not invert the states", () => {
  reset()
  const probe = hookHarness({ timeoutMs: 30_000, promptBeforeMs: 300_000, onIdle: () => {} })
  try {
    probe.rerender()
    // Warning from the first instant is the honest reading of "warn 5 minutes before a 30s session";
    // what it must not do is start in a state that is neither.
    assert.ok(["active", "prompted"].includes(probe.session.state))
    advance(31_000)
    probe.rerender()
    assert.equal(probe.session.state, "idle")
  } finally {
    probe.unmount()
    restoreClock()
  }
})

// --- the dialog ----------------------------------------------------------------------------------

test("nothing is rendered until the warning is due, and then it is an alertdialog", () => {
  reset()
  const instance = render(IdleTimeout, {
    timeoutMs: 120_000,
    promptBeforeMs: 60_000,
    onIdle: () => {},
  })
  try {
    assert.equal(instance.tree, null)
    advance(61_000)
    instance.rerender()
    const nodes = walk(instance.tree)
    const dialog = byRole(nodes, "alertdialog")[0]
    assert.ok(dialog, "no alertdialog once the warning was due")
    assert.equal(dialog.props["aria-modal"], "true")
    assert.ok(dialog.props["aria-labelledby"])
    assert.ok(dialog.props["aria-describedby"])
    // The countdown must not be announced on every tick; a polite region carries it instead.
    const timer = byRole(nodes, "timer")[0]
    assert.ok(timer, "the countdown is not a timer")
    assert.equal(timer.props["aria-live"], "off")
    const live = nodes.find((n) => n.props?.["aria-live"] === "polite")
    assert.ok(live, "nothing announces the remaining time")
    assert.ok(String(live.props.children).startsWith("Signing out in"))
    const buttons = nodes.filter((n) => n.type === "button")
    assert.equal(buttons.length, 2)
    // The safe choice is the one an Enter already on its way to the page would hit.
    assert.equal(buttons[buttons.length - 1].props.children, "Stay signed in")
  } finally {
    instance.unmount()
    restoreClock()
  }
})

test("the dialog closes when the session is extended", () => {
  reset()
  const instance = render(IdleTimeout, {
    timeoutMs: 120_000,
    promptBeforeMs: 60_000,
    onIdle: () => {},
  })
  try {
    advance(61_000)
    instance.rerender()
    const stay = walk(instance.tree)
      .filter((n) => n.type === "button")
      .find((n) => n.props.children === "Stay signed in")
    stay.props.onClick()
    instance.rerender()
    assert.equal(instance.tree, null)
  } finally {
    instance.unmount()
    restoreClock()
  }
})
