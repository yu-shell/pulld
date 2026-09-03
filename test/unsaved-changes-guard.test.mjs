// The naive version of this component is four lines of `beforeunload`, and the whole point is that
// those four lines protect the tab button and nothing else. So the cases below are written to pass
// against the shipped implementation and fail against the versions that look right:
//
//   - `beforeunload` only, with no in-app interception (every router link walks past it),
//   - `preventDefault()` without `returnValue`, or the other way round,
//   - a click interceptor that only calls `preventDefault()` (routers that do not check it navigate),
//   - one that also swallows cmd-click, middle click, downloads, `target="_blank"` and `#anchor`,
//   - a replay that is intercepted by its own interceptor,
//   - a `navigate` listener that assumes every traversal is cancellable, or that blocks pushes too,
//   - an allow-flag left set, so the second back press walks through.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

// --- a DOM small enough to hold the parts this component touches ------------------------------
class Element {
  closest() {
    return null
  }
}
class HTMLElement extends Element {}
class HTMLAnchorElement extends HTMLElement {
  constructor(href, { target = "", download = false, isConnected = true } = {}) {
    super()
    this.href = href
    this.target = target
    this.download = download
    this.isConnected = isConnected
    this.clicks = 0
  }
  hasAttribute(name) {
    return name === "download" && this.download
  }
  closest(selector) {
    return selector === "a[href]" ? this : null
  }
  click() {
    this.clicks += 1
    this.onclick?.()
  }
}
globalThis.Element = Element
globalThis.HTMLElement = HTMLElement
globalThis.HTMLAnchorElement = HTMLAnchorElement

// The harness runs effects the way a commit would but never runs their cleanups, so every settle
// pass leaves another copy of a listener behind. Dispatching to the most recently registered one is
// what a real commit would have left in place.
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
const navigationListeners = new Map()

const assigned = []
const traversed = []

const location = {
  origin: "https://app.test",
  href: "https://app.test/edit",
  pathname: "/edit",
  search: "",
  hash: "",
  assign: (url) => assigned.push(url),
}

globalThis.window = { ...eventTarget(windowListeners), location }
globalThis.document = { ...eventTarget(documentListeners), activeElement: null }

function dispatch(store, type, event) {
  const handlers = store.get(type) ?? []
  handlers[handlers.length - 1]?.(event)
  return event
}

function withNavigation(enabled) {
  globalThis.window.navigation = enabled
    ? {
        ...eventTarget(navigationListeners),
        traverseTo: (key) => traversed.push(key),
      }
    : undefined
}

function reset() {
  windowListeners.clear()
  documentListeners.clear()
  navigationListeners.clear()
  assigned.length = 0
  traversed.length = 0
  document.activeElement = null
  location.pathname = "/edit"
  location.search = ""
  location.href = "https://app.test/edit"
  withNavigation(false)
}

/** A click on `anchor`, with the flags a plain primary click has unless told otherwise. */
function clickEvent(anchor, overrides = {}) {
  return {
    target: anchor,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.stopped = true
    },
    ...overrides,
  }
}

function navigateEvent(overrides = {}) {
  return {
    navigationType: "traverse",
    hashChange: false,
    downloadRequest: null,
    cancelable: true,
    destination: { url: "https://app.test/other", key: "entry-1" },
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
    ...overrides,
  }
}

const unloadEvent = () => ({
  returnValue: undefined,
  prevented: false,
  preventDefault() {
    this.prevented = true
  },
})

const { useBeforeUnload, useUnsavedChanges, UnsavedChangesGuard } = loadComponent(
  join(ROOT, "registry", "ui", "unsaved-changes-guard.tsx"),
  { stubs: { "lucide-react": icons } }
)

/** Mounts the guard and returns the instance plus helpers for reading the rendered dialog. */
function mount(props = {}) {
  const instance = render(UnsavedChangesGuard, { when: true, ...props })
  const nodes = () => walk(instance.tree)
  return {
    instance,
    nodes,
    dialog: () => nodes().find((n) => n.props?.role === "alertdialog") ?? null,
    buttons: () => byTag(nodes(), "button"),
    // Dispatching is only half of what a browser does: the state update it causes is not on screen
    // until React has rendered again, so every helper settles before the caller looks at the tree.
    click: (anchor, overrides) => {
      const event = dispatch(documentListeners, "click", clickEvent(anchor, overrides))
      instance.rerender()
      return event
    },
    navigate: (overrides) => {
      const event = dispatch(navigationListeners, "navigate", navigateEvent(overrides))
      instance.rerender()
      return event
    },
  }
}

// --- the browser half ---------------------------------------------------------------------------

test("beforeunload sets returnValue as well as calling preventDefault", () => {
  reset()
  const Probe = ({ when }) => {
    useBeforeUnload(when)
    return null
  }
  render(Probe, { when: true })

  const event = dispatch(windowListeners, "beforeunload", unloadEvent())
  assert.equal(event.prevented, true, "preventDefault is what the spec settled on")
  assert.equal(event.returnValue, "", "returnValue is what older engines look at")
})

test("no beforeunload listener is registered while there is nothing to lose", () => {
  reset()
  const Probe = ({ when }) => {
    useBeforeUnload(when)
    return null
  }
  render(Probe, { when: false })

  assert.equal(
    (windowListeners.get("beforeunload") ?? []).length,
    0,
    "an always-on listener costs the back/forward cache on every page, not just the risky one"
  )
})

test("the listener goes away again once the form is clean", () => {
  reset()
  const Probe = ({ when }) => {
    useBeforeUnload(when)
    return null
  }
  const instance = render(Probe, { when: true })
  assert.ok((windowListeners.get("beforeunload") ?? []).length > 0)

  // The harness never runs cleanups between passes, so the question a fresh store can answer is
  // whether a clean pass registers anything at all — which is the behaviour the deps guard.
  windowListeners.clear()
  instance.update({ when: false })
  assert.equal((windowListeners.get("beforeunload") ?? []).length, 0)
})

// --- links ---------------------------------------------------------------------------------------

test("a router link is held, which is the case beforeunload never sees", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other")

  const event = guard.click(anchor)

  assert.equal(event.prevented, true)
  assert.equal(
    event.stopped,
    true,
    "routers differ on whether they check defaultPrevented; stopping the event before the React root is true of all of them"
  )
  assert.ok(guard.dialog(), "the dialog is what the user answers")
})

test("nothing is held while the form is clean", () => {
  reset()
  const guard = mount({ when: false })
  const event = guard.click(new HTMLAnchorElement("https://app.test/other"))

  assert.equal(event.prevented, false)
  assert.equal(guard.dialog(), null)
})

test("clicks that were never going to unload this page are left alone", () => {
  const cases = [
    ["cmd-click opens a new tab", { metaKey: true }, {}],
    ["ctrl-click opens a new tab", { ctrlKey: true }, {}],
    ["shift-click opens a new window", { shiftKey: true }, {}],
    ["alt-click downloads", { altKey: true }, {}],
    ["middle click opens a new tab", { button: 1 }, {}],
    ["a click something else already handled", { defaultPrevented: true }, {}],
  ]
  for (const [why, overrides] of cases) {
    reset()
    const guard = mount()
    const event = guard.click(new HTMLAnchorElement("https://app.test/other"), overrides)
    assert.equal(event.prevented, false, why)
    assert.equal(guard.dialog(), null, why)
  }
})

test("links that go somewhere else, or nowhere, are left alone", () => {
  const cases = [
    ["a download stays on the page", new HTMLAnchorElement("https://app.test/f.csv", { download: true })],
    ["target=_blank opens elsewhere", new HTMLAnchorElement("https://app.test/o", { target: "_blank" })],
    ["another origin is the browser's own departure, and beforeunload has it", new HTMLAnchorElement("https://elsewhere.test/o")],
    ["mailto: is not a navigation", new HTMLAnchorElement("mailto:a@b.test")],
    ["a fragment of this page keeps the form", new HTMLAnchorElement("https://app.test/edit#section")],
    ["the page we are already on", new HTMLAnchorElement("https://app.test/edit")],
  ]
  for (const [why, anchor] of cases) {
    reset()
    const guard = mount()
    const event = guard.click(anchor)
    assert.equal(event.prevented, false, why)
    assert.equal(guard.dialog(), null, why)
  }
})

test("discarding replays the original click once, and does not hold its own replay", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other")
  // The replay goes back through the same document listener, exactly as the browser would deliver it.
  anchor.onclick = () => dispatch(documentListeners, "click", clickEvent(anchor))

  guard.click(anchor)
  const discard = guard.buttons().at(-1)
  discard.props.onClick()
  guard.instance.rerender()

  assert.equal(anchor.clicks, 1, "the router sees the click it would have seen")
  assert.equal(guard.dialog(), null, "and the replay is not held a second time")
  assert.deepEqual(assigned, [], "a mounted anchor never needs a full page load")
})

test("discarding an anchor that has since unmounted still reaches the destination", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other", { isConnected: false })

  guard.click(anchor)
  guard.buttons().at(-1).props.onClick()
  guard.instance.rerender()

  assert.equal(anchor.clicks, 0)
  assert.deepEqual(assigned, ["https://app.test/other"])
})

test("keeping editing closes the dialog and navigates nowhere", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other")

  guard.click(anchor)
  const keep = guard.buttons()[0]
  keep.props.onClick()
  guard.instance.rerender()

  assert.equal(guard.dialog(), null)
  assert.equal(anchor.clicks, 0)
  assert.deepEqual(assigned, [])
})

test("the browser stops asking once the user has answered, and starts again if they stay", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other", { isConnected: false })

  assert.equal(dispatch(windowListeners, "beforeunload", unloadEvent()).prevented, true)

  guard.click(anchor)
  guard.buttons().at(-1).props.onClick()
  guard.instance.rerender()
  assert.equal(
    dispatch(windowListeners, "beforeunload", unloadEvent()).prevented,
    false,
    "the native prompt would otherwise stack on top of the dialog that was just answered"
  )

  dispatch(documentListeners, "pointerdown", {})
  assert.equal(
    dispatch(windowListeners, "beforeunload", unloadEvent()).prevented,
    true,
    "still here, still typing — the work is at risk again"
  )
})

// --- back and forward ------------------------------------------------------------------------------

test("the back button is held, and the traversal is resumed on discard", () => {
  reset()
  withNavigation(true)
  const guard = mount()

  const event = guard.navigate()
  assert.equal(event.prevented, true)
  assert.ok(guard.dialog())

  guard.buttons().at(-1).props.onClick()
  guard.instance.rerender()
  assert.deepEqual(traversed, ["entry-1"], "back means back, once it has been agreed to")
})

test("the resumed traversal passes exactly once", () => {
  reset()
  withNavigation(true)
  const guard = mount()

  guard.navigate()
  guard.buttons().at(-1).props.onClick()
  guard.instance.rerender()

  const resumed = guard.navigate()
  assert.equal(resumed.prevented, false, "this is the traversal the user agreed to")

  const again = guard.navigate()
  assert.equal(again.prevented, true, "a flag left set would let every later back press through")
})

test("navigations that are not a traversal, or cannot be refused, are left alone", () => {
  const cases = [
    ["a push is the app's own routing, and blocking it traps a form that just saved", { navigationType: "push" }],
    ["a replace, likewise", { navigationType: "replace" }],
    ["a reload is a real unload, and beforeunload has it", { navigationType: "reload" }],
    ["a fragment change keeps the document", { hashChange: true }],
    ["a download leaves the page where it is", { downloadRequest: "report.csv" }],
    ["whether a traversal can be refused is the browser's decision, so it is asked", { cancelable: false }],
    ["without a destination key there is nothing to resume", { destination: { url: "https://app.test/other", key: "" } }],
  ]
  for (const [why, overrides] of cases) {
    reset()
    withNavigation(true)
    const guard = mount()
    const event = guard.navigate(overrides)
    assert.equal(event.prevented, false, why)
    assert.equal(guard.dialog(), null, why)
  }
})

test("a clean form does not hold the back button either", () => {
  reset()
  withNavigation(true)
  const guard = mount({ when: false })
  assert.equal(guard.navigate().prevented, false)
  assert.equal(guard.dialog(), null)
})

test("nothing is registered on the navigation object when back interception is off", () => {
  reset()
  withNavigation(true)
  mount({ interceptBack: false })
  assert.equal((navigationListeners.get("navigate") ?? []).length, 0)
})

// --- the dialog ------------------------------------------------------------------------------------

test("nothing renders until something has been held", () => {
  reset()
  const guard = mount()
  assert.equal(guard.instance.tree, null)
})

test("the dialog interrupts, and the safe answer is the one focus lands on", () => {
  reset()
  const guard = mount()
  guard.click(new HTMLAnchorElement("https://app.test/other"))

  const dialog = guard.dialog()
  assert.ok(dialog)
  assert.equal(dialog.props["aria-modal"], "true")
  assert.ok(dialog.props["aria-labelledby"])
  assert.ok(dialog.props["aria-describedby"])

  const buttons = guard.buttons()
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].props.children, "Keep editing")
  assert.equal(buttons[1].props.children, "Discard changes")
  for (const button of buttons) assert.equal(button.props.type, "button")

  // Which button the dialog opens on is the part that matters, and the harness cannot watch focus
  // move. It can watch the call: the ref the dialog focuses is a prop on the button carrying it, so
  // the method is spied on and the effect re-run, which is what a re-render does here.
  const focused = buttons.filter((button) => button.props.ref)
  assert.equal(focused.length, 1, "exactly one button is the one focus opens on")
  let calls = 0
  const spied = focused[0].props.ref
  const inner = spied.current.focus
  spied.current.focus = (...args) => {
    calls += 1
    return inner?.(...args)
  }
  guard.instance.rerender()
  assert.equal(calls, 1)
  assert.equal(
    focused[0].props.children,
    "Keep editing",
    "an Enter press already on its way to the page must not answer with the destructive choice"
  )
})

test("Escape keeps editing rather than leaving the navigation in limbo", () => {
  reset()
  const guard = mount()
  const anchor = new HTMLAnchorElement("https://app.test/other")
  guard.click(anchor)

  let prevented = false
  guard.dialog().props.onKeyDown({
    key: "Escape",
    defaultPrevented: false,
    preventDefault() {
      prevented = true
      this.defaultPrevented = true
    },
  })
  guard.instance.rerender()

  assert.equal(prevented, true)
  assert.equal(guard.dialog(), null)
  assert.equal(anchor.clicks, 0)
})

test("a caller's own onKeyDown runs and can take the key first", () => {
  reset()
  const seen = []
  const guard = mount({ onKeyDown: (e) => seen.push(e.key) })
  guard.click(new HTMLAnchorElement("https://app.test/other"))

  guard.dialog().props.onKeyDown({
    key: "Escape",
    defaultPrevented: true,
    preventDefault() {},
  })
  guard.instance.rerender()

  assert.deepEqual(seen, ["Escape"], "the prop is called, not silently dropped")
  assert.ok(guard.dialog(), "and a caller that handled the key keeps the dialog open")
})

// --- the replaceable half ----------------------------------------------------------------------------

test("a supplied guard drives the dialog and stands the built-in interception down", () => {
  reset()
  withNavigation(true)
  let proceeded = 0
  let cancelled = 0
  const instance = render(UnsavedChangesGuard, {
    when: true,
    guard: {
      pending: { kind: "link", href: null },
      proceed: () => (proceeded += 1),
      cancel: () => (cancelled += 1),
    },
  })

  assert.ok(walk(instance.tree).find((n) => n.props?.role === "alertdialog"))
  assert.equal(
    (documentListeners.get("click") ?? []).length,
    0,
    "one click held twice is one click held once too often"
  )
  assert.equal((navigationListeners.get("navigate") ?? []).length, 0)
  assert.ok(
    (windowListeners.get("beforeunload") ?? []).length > 0,
    "the tab button stays covered whoever owns the in-app half"
  )

  const buttons = byTag(walk(instance.tree), "button")
  buttons[0].props.onClick()
  buttons[1].props.onClick()
  assert.equal(cancelled, 1)
  assert.equal(proceeded, 1)
})

test("the hook can be used on its own, and reports what is pending", () => {
  reset()
  const seen = []
  const Probe = (props) => {
    seen.push(useUnsavedChanges(props))
    return null
  }
  const instance = render(Probe, { when: true })
  const anchor = new HTMLAnchorElement("https://app.test/other")

  dispatch(documentListeners, "click", clickEvent(anchor))
  instance.rerender()

  const latest = seen.at(-1)
  assert.deepEqual(latest.pending, { kind: "link", href: "https://app.test/other" })
  latest.cancel()
  instance.rerender()
  assert.equal(seen.at(-1).pending, null)
})
