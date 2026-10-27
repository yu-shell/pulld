// A badge in the tab title is four lines of code and one shared global. Everything below was
// written against a version that believed something the probe page (Chromium / macOS, 2026-10-27)
// then disproved:
//
//   - that the title captured at mount is still the page's title at unmount — in a single-page app
//     the router has written two more since, so "restore what was there" restores the wrong page,
//   - that assigning `document.title` a value it already holds is free: it fires a mutation record
//     all the same, so a writer that re-applies the badge whenever the title changes answers its
//     own notification and never stops (the fake document below throws rather than hangs if that
//     comes back),
//   - that `characterData` is where a title change shows up — it is a childList record on `<title>`
//     for a plain assignment, and a childList record on `<head>` when a title library swaps the
//     element, which is why the component watches `<head>` with `subtree`,
//   - that two of these can coexist, when there is exactly one `document.title` to write,
//   - and that `visibilityState === "visible"` means somebody is looking, when a tab stays visible
//     while its window sits behind another application.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { TabTitleBadge, useTabTitleBadge, formatBadge, applyTemplate, DEFAULT_TEMPLATE } =
  loadComponent(join(ROOT, "registry/ui/tab-title-badge.tsx"))

// ---------------------------------------------------------------------------------------------
// A document that behaves the way the probe measured, including the parts that are inconvenient.

const documentListeners = new Map()
const windowListeners = new Map()
let observers = []
let titleValue = ""
let assignments = 0
let focused = true

function addTo(map, type, fn) {
  map.set(type, [...(map.get(type) ?? []), fn])
}
function removeFrom(map, type, fn) {
  map.set(type, (map.get(type) ?? []).filter((registered) => registered !== fn))
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
  }
  observe(target, options) {
    this.targets.push({ target, options })
    observers.push(this)
  }
  disconnect() {
    observers = observers.filter((o) => o !== this)
  }
}

globalThis.MutationObserver = FakeMutationObserver

globalThis.document = {
  head: { nodeName: "HEAD" },
  visibilityState: "visible",
  hasFocus: () => focused,
  get title() {
    return titleValue
  },
  set title(next) {
    assignments += 1
    // The loop this component exists to avoid would run forever; a test that hangs says nothing, so
    // the ceiling turns it into a failure with a name.
    if (assignments > 40) {
      throw new Error("document.title was assigned 40 times — the writer is answering its own mutations")
    }
    titleValue = next
    // Measured: the record arrives even when the value did not change, and it arrives after the
    // current task rather than inside the assignment.
    queueMicrotask(() => {
      for (const observer of [...observers]) observer.callback([], observer)
    })
  },
  addEventListener: (type, fn) => addTo(documentListeners, type, fn),
  removeEventListener: (type, fn) => removeFrom(documentListeners, type, fn),
}

globalThis.window = {
  addEventListener: (type, fn) => addTo(windowListeners, type, fn),
  removeEventListener: (type, fn) => removeFrom(windowListeners, type, fn),
}

function dispatch(map, type) {
  for (const fn of [...(map.get(type) ?? [])]) fn({ type })
}

// Timers are counted rather than merely allowed to run, because the thing worth pinning about the
// blink is not how it looks but whether an interval exists at all: a badge nobody asked to blink
// must hold no timer, and the one that does blink must hold exactly one however often the page
// re-renders around it.
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
let intervalsCreated = 0
let intervalsCleared = 0
globalThis.setInterval = (fn, ms) => {
  intervalsCreated += 1
  return realSetInterval(fn, ms)
}
globalThis.clearInterval = (id) => {
  intervalsCleared += 1
  return realClearInterval(id)
}

/** Lets the mutation records and their continuations run before the title is read again. */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

/** Puts the reader somewhere else, the way switching tabs does. */
function leave() {
  document.visibilityState = "hidden"
  focused = false
  dispatch(documentListeners, "visibilitychange")
  dispatch(windowListeners, "blur")
}

/** Brings them back. */
function arrive() {
  document.visibilityState = "visible"
  focused = true
  dispatch(documentListeners, "visibilitychange")
  dispatch(windowListeners, "focus")
}

/** What a router does on navigation: writes a new title over whatever is there. */
function routeTo(title) {
  document.title = title
}

test.beforeEach(() => {
  documentListeners.clear()
  windowListeners.clear()
  observers = []
  titleValue = "Inbox"
  assignments = 0
  intervalsCreated = 0
  intervalsCleared = 0
  focused = true
  document.visibilityState = "visible"
})

/**
 * Renders the hook on its own, exposing the latest state to the test.
 *
 * The teardown is registered here rather than left to a call at the end of each test because the
 * thing being held is module-scoped: a failed assertion that skips `unmount` leaves the next test
 * facing a title that is already owned, so one real failure turns into a column of false ones. The
 * timers go the same way — an interval that outlives its test keeps the process alive after the
 * run has finished.
 */
function renderHook(t, options = {}) {
  const seen = { state: null }
  const Probe = (props) => {
    seen.state = useTabTitleBadge(props)
    return null
  }
  const view = render(Probe, options)
  t.after(() => view.unmount())
  return { view, seen }
}

// ---------------------------------------------------------------------------------------------
// The pure half: what the badge says.

test("formatBadge answers for every shape a count arrives in", () => {
  const cases = [
    { input: {}, expected: null, why: "nothing to announce" },
    { input: { count: 0 }, expected: null, why: "zero is not news" },
    { input: { count: -3 }, expected: null, why: "a subtraction that went past the end" },
    { input: { count: 1 }, expected: "1", why: "the ordinary case" },
    { input: { count: 7 }, expected: "7", why: "the ordinary case" },
    { input: { count: 1.7 }, expected: "1", why: "truncated, never rounded up into an item that does not exist" },
    { input: { count: 0.4 }, expected: null, why: "less than one whole item" },
    { input: { count: Number.NaN }, expected: null, why: "not a number" },
    { input: { count: Number.POSITIVE_INFINITY }, expected: null, why: "not a number" },
    { input: { count: 99 }, expected: "99", why: "at the cap, still exact" },
    { input: { count: 100 }, expected: "99+", why: "over the cap" },
    { input: { count: 1200, max: 9 }, expected: "9+", why: "the cap is the caller's" },
    { input: { count: 5, max: 1 }, expected: "1+", why: "a cap of one is still a cap" },
    { input: { count: 1200, max: 0 }, expected: "1200", why: "a cap of zero is no cap" },
    { input: { label: "New" }, expected: "New", why: "a word instead of a number" },
    { input: { label: "New", count: 0 }, expected: "New", why: "the label wins over the count" },
    { input: { label: "", count: 4 }, expected: "4", why: "an empty label is not a label" },
  ]
  for (const { input, expected, why } of cases) {
    assert.equal(formatBadge(input), expected, `${JSON.stringify(input)}: ${why}`)
  }
})

test("applyTemplate substitutes both tokens, wherever they are and however many", () => {
  assert.equal(applyTemplate(DEFAULT_TEMPLATE, "3", "Inbox"), "(3) Inbox")
  assert.equal(applyTemplate("{badge} • {title}", "9+", "Dashboard"), "9+ • Dashboard")
  assert.equal(applyTemplate("{title} — {badge} new", "2", "Mail"), "Mail — 2 new")
  assert.equal(applyTemplate("{badge}/{badge} {title}", "1", "X"), "1/1 X", "every occurrence, not just the first")
  assert.equal(applyTemplate("{badge} unread", "5", "Inbox"), "5 unread", "a caller may drop the page title")
  assert.equal(applyTemplate("nothing here", "5", "Inbox"), "nothing here")
})

// ---------------------------------------------------------------------------------------------
// The half that touches the one title this document has.

test("writes nothing at all while there is no badge to show", async (t) => {
  const { view } = renderHook(t, { count: 0 })
  await flush()
  view.rerender()

  assert.equal(document.title, "Inbox")
  assert.equal(assignments, 0, "assigned the title a value it already had")
  view.unmount()
})

test("the badge goes up once the reader is somewhere else", async (t) => {
  const { view, seen } = renderHook(t, { count: 3 })
  await flush()
  view.rerender()
  assert.equal(document.title, "Inbox", "shouted at a reader who was already looking")

  leave()
  view.rerender()
  await flush()

  assert.equal(document.title, "(3) Inbox")
  assert.equal(seen.state.badge, "3")
  assert.equal(seen.state.isSeen, false)
  assert.equal(seen.state.isOwner, true)
  view.unmount()
})

test("showWhileSeen keeps it up in front of a reader who asked for that", async (t) => {
  const { view } = renderHook(t, { count: 3, showWhileSeen: true })
  await flush()
  view.rerender()

  assert.equal(document.title, "(3) Inbox")
  view.unmount()
})

test("the template is the caller's", async (t) => {
  const { view } = renderHook(t, { count: 120, template: "{badge} • {title}", showWhileSeen: true })
  await flush()
  view.rerender()

  assert.equal(document.title, "99+ • Inbox")
  view.unmount()
})

test("a route change becomes the new base, and the badge lands on top of it", async (t) => {
  const { view, seen } = renderHook(t, { count: 2, showWhileSeen: true })
  await flush()
  view.rerender()
  assert.equal(document.title, "(2) Inbox")

  routeTo("Settings")
  await flush()
  view.rerender()
  await flush()

  assert.equal(document.title, "(2) Settings", "kept badging the page the reader has left")
  assert.equal(seen.state.baseTitle, "Settings")
  view.unmount()
})

test("unmount gives back the title the page has now, not the one it had at mount", async (t) => {
  const { view } = renderHook(t, { count: 2, showWhileSeen: true })
  await flush()
  view.rerender()
  routeTo("Settings")
  await flush()
  view.rerender()
  await flush()
  assert.equal(document.title, "(2) Settings")

  view.unmount()
  await flush()

  assert.equal(document.title, "Settings", "restored a title belonging to a page that is no longer open")
})

test("unmount with no badge showing leaves the title exactly as it was", async (t) => {
  const { view } = renderHook(t, { count: 0 })
  await flush()
  view.rerender()
  view.unmount()
  await flush()

  assert.equal(document.title, "Inbox")
  assert.equal(assignments, 0)
})

test("the writer does not answer its own mutation", async (t) => {
  const { view } = renderHook(t, { count: 1, showWhileSeen: true })
  await flush()
  view.rerender()
  const afterFirstWrite = assignments

  // Ten rounds of microtasks is far more than a settled title needs, and an order of magnitude
  // more than the loop would need to be caught by the ceiling in the setter.
  for (let i = 0; i < 10; i += 1) await flush()

  assert.equal(document.title, "(1) Inbox")
  assert.equal(assignments, afterFirstWrite, "kept writing after the title already said the right thing")
  view.unmount()
})

test("it watches <head> with subtree, which is the only place both kinds of change show up", async (t) => {
  const { view } = renderHook(t, { count: 1, showWhileSeen: true })
  await flush()
  view.rerender()

  assert.ok(observers.length >= 1, "nothing was observing the document")
  const { target, options } = observers[0].targets[0]
  assert.equal(target, document.head, "observed the title element, which a library swaps out from under it")
  assert.equal(options.childList, true, "a plain assignment is a childList record, not characterData")
  assert.equal(options.subtree, true, "without subtree the record on <title> never arrives")
  view.unmount()
})

test("a second instance stands down rather than fighting over the one title", async (t) => {
  const first = renderHook(t, { count: 2, showWhileSeen: true })
  await flush()
  first.view.rerender()
  assert.equal(first.seen.state.isOwner, true)
  assert.equal(document.title, "(2) Inbox")

  const second = renderHook(t, { count: 9, label: "LOTS", showWhileSeen: true })
  await flush()
  second.view.rerender()
  await flush()

  assert.equal(second.seen.state.isOwner, false, "a second writer claimed the title")
  assert.equal(document.title, "(2) Inbox", "the second instance overwrote the first")

  second.view.unmount()
  first.view.unmount()
  await flush()
  assert.equal(document.title, "Inbox")
})

test("ownership is handed back, so the next mount gets it", async (t) => {
  const first = renderHook(t, { count: 2 })
  await flush()
  first.view.rerender()
  first.view.unmount()
  await flush()

  const second = renderHook(t, { count: 5, showWhileSeen: true })
  await flush()
  second.view.rerender()
  await flush()

  assert.equal(second.seen.state.isOwner, true, "the title was left owned by a hook that is gone")
  assert.equal(document.title, "(5) Inbox")
  second.view.unmount()
})

test("onSeen reports the arrival, once, and only with something waiting", async (t) => {
  let arrivals = 0
  const { view } = renderHook(t, { count: 3, onSeen: () => (arrivals += 1) })
  await flush()
  view.rerender()
  assert.equal(arrivals, 0, "reported an arrival for a reader who never left")

  leave()
  view.rerender()
  await flush()
  assert.equal(arrivals, 0, "leaving is not arriving")

  arrive()
  view.rerender()
  await flush()
  assert.equal(arrivals, 1)

  // Still here. Another visibility event with nothing having changed is not a second arrival.
  arrive()
  view.rerender()
  await flush()
  assert.equal(arrivals, 1, "reported the same arrival twice")
  view.unmount()
})

test("onSeen stays quiet when nothing was waiting", async (t) => {
  let arrivals = 0
  const { view } = renderHook(t, { count: 0, onSeen: () => (arrivals += 1) })
  await flush()
  view.rerender()
  leave()
  view.rerender()
  await flush()
  arrive()
  view.rerender()
  await flush()

  assert.equal(arrivals, 0, "announced an arrival for an empty badge")
  view.unmount()
})

test("the listeners it needs are the ones it registers", async (t) => {
  const { view } = renderHook(t, { count: 1 })
  await flush()
  view.rerender()

  assert.ok((documentListeners.get("visibilitychange") ?? []).length > 0, "nothing listens for the tab changing")
  assert.ok((windowListeners.get("focus") ?? []).length > 0, "nothing listens for the window coming forward")
  assert.ok((windowListeners.get("blur") ?? []).length > 0, "nothing listens for the window going behind")
  view.unmount()
})

test('seenRule "focus" counts a window behind another application as away', async (t) => {
  // The measured difference: the tab is the frontmost tab of its window, so Page Visibility says
  // visible, while the window itself is behind the editor and the reader has seen nothing.
  document.visibilityState = "visible"
  focused = false

  const { view, seen } = renderHook(t, { count: 4, seenRule: "focus" })
  await flush()
  view.rerender()
  await flush()

  assert.equal(seen.state.isSeen, false)
  assert.equal(document.title, "(4) Inbox", "cleared a badge nobody had looked at")
  view.unmount()
})

test('the default rule treats a visible tab as seen, even unfocused', async (t) => {
  document.visibilityState = "visible"
  focused = false

  const { view, seen } = renderHook(t, { count: 4 })
  await flush()
  view.rerender()
  await flush()

  assert.equal(seen.state.isSeen, true)
  assert.equal(document.title, "Inbox")
  view.unmount()
})

test("blinking alternates between the badge and the page's own title", async (t) => {
  const { view } = renderHook(t, { count: 1, showWhileSeen: true, blinkMs: 10 })
  await flush()
  view.rerender()
  assert.equal(document.title, "(1) Inbox", "the first half of a blink is the news")

  // Sampled across several periods rather than asserting which half is showing at one instant. A
  // 15ms wait on a 10ms swing reads as "the other half" only while the machine is idle; under the
  // whole suite it can span two ticks and land back where it started, which is a flaky test rather
  // than a broken component. What the blink actually promises is that both halves come up.
  const shown = new Set([document.title])
  for (let i = 0; i < 24; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 8))
    view.rerender()
    await flush()
    shown.add(document.title)
  }

  assert.ok(shown.has("(1) Inbox"), `the badge never showed — saw ${[...shown].join(" / ")}`)
  assert.ok(shown.has("Inbox"), `the page's own title never showed — saw ${[...shown].join(" / ")}`)

  view.unmount()
  await flush()
  assert.equal(document.title, "Inbox", "left the blink mid-swing")
})

test("a blinking tab that unmounts leaves no timer behind", async (t) => {
  const { view } = renderHook(t, { count: 1, showWhileSeen: true, blinkMs: 5 })
  await flush()
  view.rerender()
  view.unmount()
  const after = assignments

  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(assignments, after, "a timer kept writing the title after unmount")
})

test("the component form renders nothing and reports what it did", async (t) => {
  const states = []
  const view = render(TabTitleBadge, {
    count: 2,
    showWhileSeen: true,
    onStateChange: (state) => states.push(state),
  })
  t.after(() => view.unmount())
  await flush()
  view.rerender()

  assert.equal(view.tree, null, "rendered an element for something that lives in the tab")
  assert.equal(document.title, "(2) Inbox")
  assert.ok(states.length > 0, "never reported its state")
  assert.equal(states.at(-1).badge, "2")
  assert.equal(states.at(-1).baseTitle, "Inbox")
  view.unmount()
})

test("the default is a badge that sits still — nothing blinks unless it was asked for", async (t) => {
  const { view } = renderHook(t, { count: 3, showWhileSeen: true })
  await flush()
  view.rerender()
  assert.equal(document.title, "(3) Inbox")
  const settled = assignments

  // Real time, not microtasks: a stray interval only shows up once the event loop turns over.
  await new Promise((resolve) => setTimeout(resolve, 40))
  view.rerender()
  await flush()

  assert.equal(document.title, "(3) Inbox", "the title moved on its own")
  assert.equal(assignments, settled, "something kept writing the title with no blink asked for")
})

test("unmount takes its listeners with it", async (t) => {
  const { view } = renderHook(t, { count: 1 })
  await flush()
  view.rerender()
  assert.ok((documentListeners.get("visibilitychange") ?? []).length > 0)

  view.unmount()

  assert.equal((documentListeners.get("visibilitychange") ?? []).length, 0, "left a visibility listener behind")
  assert.equal((windowListeners.get("focus") ?? []).length, 0, "left a focus listener behind")
  assert.equal((windowListeners.get("blur") ?? []).length, 0, "left a blur listener behind")
})

test('seenRule "focus" treats a document that cannot report focus as somebody being here', async (t) => {
  // `hasFocus` is not universal — an embedded view or an older environment may not have it. Guessing
  // "away" there would badge the tab of a reader sitting in front of it and never stop.
  const hasFocus = document.hasFocus
  t.after(() => {
    document.hasFocus = hasFocus
  })
  document.hasFocus = undefined
  document.visibilityState = "visible"

  const { view, seen } = renderHook(t, { count: 4, seenRule: "focus" })
  await flush()
  view.rerender()
  await flush()

  assert.equal(seen.state.isSeen, true)
  assert.equal(document.title, "Inbox", "badged the tab of a reader who was looking at it")
})

test("on a server there is no document, and it neither throws nor writes", async (t) => {
  const realDocument = globalThis.document
  const realWindow = globalThis.window
  t.after(() => {
    globalThis.document = realDocument
    globalThis.window = realWindow
  })
  delete globalThis.document
  delete globalThis.window

  const seen = { state: null }
  const Probe = (props) => {
    seen.state = useTabTitleBadge(props)
    return null
  }
  // The render itself is the assertion: every document access is behind a guard, so a missing one
  // is a ReferenceError here rather than a 500 in somebody's server log.
  const view = render(Probe, { count: 3, showWhileSeen: true })
  await flush()
  view.rerender()

  assert.equal(seen.state.badge, "3", "the badge text is decided without a document")
  assert.equal(seen.state.isOwner, false, "claimed a title on a machine that has no tabs")
  assert.equal(seen.state.baseTitle, "")
  view.unmount()
})

test("a badge nobody asked to blink holds no timer at all", async (t) => {
  const { view } = renderHook(t, { count: 3, showWhileSeen: true })
  await flush()
  view.rerender()
  view.rerender()

  assert.equal(document.title, "(3) Inbox")
  assert.equal(intervalsCreated, 0, "started a timer for a badge that is meant to sit still")
})

test("a blinking badge holds exactly one timer, however often the page re-renders", async (t) => {
  const { view } = renderHook(t, { count: 3, showWhileSeen: true, blinkMs: 25 })
  await flush()
  view.rerender()
  view.rerender()
  view.rerender()

  assert.equal(intervalsCreated, 1, "two timers on one swing cancel each other out")

  view.unmount()
  assert.ok(intervalsCleared >= 1, "left the timer running after unmount")
})
