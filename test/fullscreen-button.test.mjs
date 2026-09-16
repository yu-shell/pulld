// A full-screen button is a component whose bugs all look like the button lying. It works on the
// machine it was written on, and then a user presses Escape and it says "Exit fullscreen" forever,
// a second one on the same page lights up when the first chart is expanded, an embedded copy does
// nothing at all, and on an iPhone it does nothing at all quietly. So the cases below are written
// against those specific wrong versions:
//
//   - holding an `isFullscreen` boolean and flipping it on click, which desynchronises the first
//     time the user leaves full screen by any of the ways that do not go through this button,
//   - reading `!!document.fullscreenElement` instead of comparing it with the target, so every
//     button on the page claims to be the one that is expanded,
//   - setting the state optimistically when the request resolves rather than when the browser says
//     so, which is the same desynchronisation arriving one step later,
//   - awaiting anything before `requestFullscreen`, which spends the user gesture,
//   - assuming the method exists, so an iPhone gets a button that does nothing,
//   - treating the returned promise as infallible, so an iframe without `allow="fullscreen"` gets
//     the same dead button plus an unhandled rejection,
//   - building the CSS fallback out of class names, which a target with its own height ignores,
//   - forgetting that the fallback has no Escape of its own,
//   - calling `document.exitFullscreen` while somebody else owns the full-screen element,
//   - leaving the fallback's inline styles on the target after unmount, pinning it over the page,
//   - announcing the state by swapping the icon, which no screen reader reports.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const { FullscreenButton, useFullscreen, isFullscreenSupported } = loadComponent(
  join(ROOT, "registry", "ui", "fullscreen-button.tsx"),
  { stubs: { "lucide-react": icons } }
)

/**
 * A document and an element good enough to answer everything this component asks a browser.
 *
 * `support` picks which spellings exist: "standard", "webkit" (Safari before 16.4), or "none"
 * (an iPhone, where element full-screen is absent rather than refused). `request` decides what the
 * call does — resolve, reject, or throw synchronously — so the iframe refusal has a shape here.
 */
function browser({
  support = "standard",
  request = () => Promise.resolve(),
  fullscreenEnabled = true,
  targetBackground = "rgb(255, 255, 255)",
  ancestorBackground = "rgb(9, 9, 11)",
  inlineStyle = {},
} = {}) {
  const calls = { request: [], exit: [], listeners: [], removed: [] }
  const style = { ...inlineStyle }
  const attributes = {}

  const parent = {}
  const doc = {
    fullscreenElement: null,
    fullscreenEnabled,
    documentElement: {},
    addEventListener: (type, fn) => calls.listeners.push({ type, fn }),
    removeEventListener: (type, fn) => calls.removed.push({ type, fn }),
    exitFullscreen: () => {
      calls.exit.push("standard")
      return Promise.resolve()
    },
    defaultView: {
      getComputedStyle: (node) => ({
        backgroundColor: node === target ? targetBackground : ancestorBackground,
      }),
    },
  }
  if (support === "webkit") {
    delete doc.exitFullscreen
    doc.webkitExitFullscreen = () => calls.exit.push("webkit")
  }

  const target = {
    ownerDocument: doc,
    parentElement: parent,
    style: {
      setProperty: (prop, value) => {
        style[prop] = value
      },
      getPropertyValue: (prop) => style[prop] ?? "",
      removeProperty: (prop) => {
        delete style[prop]
      },
    },
    setAttribute: (name, value) => {
      attributes[name] = value
    },
    removeAttribute: (name) => {
      delete attributes[name]
    },
  }
  parent.parentElement = null
  parent.ownerDocument = doc

  const call = (...args) => {
    calls.request.push(args)
    return request(...args)
  }
  if (support === "standard") target.requestFullscreen = call
  if (support === "webkit") target.webkitRequestFullscreen = call

  return {
    doc,
    target,
    style,
    attributes,
    calls,
    ref: { current: target },
    /** What the browser reports as full-screen. Pass an element, or null. */
    setFullscreenElement(el) {
      if (support === "webkit") doc.webkitFullscreenElement = el
      else doc.fullscreenElement = el
    },
    /** Fire the event the browser fires whenever full-screen is entered or left. */
    fire(type = support === "webkit" ? "webkitfullscreenchange" : "fullscreenchange") {
      const hits = calls.listeners.filter((l) => l.type === type)
      assert.ok(hits.length > 0, `nothing is listening for ${type}`)
      hits[hits.length - 1].fn({})
    },
    /** Press Escape the way the document would deliver it. */
    escape() {
      const hits = calls.listeners.filter((l) => l.type === "keydown")
      if (!hits.length) return false
      const event = { key: "Escape", prevented: false, preventDefault() { this.prevented = true } }
      hits[hits.length - 1].fn(event)
      return event
    },
  }
}

/** The button element in a rendered instance. */
const button = (instance) => byTag(walk(instance.tree), "button")[0]

/** The visible text of the button, with the icon (which renders nothing) dropped. */
function label(instance) {
  const children = button(instance).props.children
  return (Array.isArray(children) ? children : [children])
    .filter((child) => typeof child === "string")
    .join("")
}

/** Presses the button, then lets any promise the handler started settle. */
async function click(instance) {
  const event = { defaultPrevented: false, preventDefault() {} }
  button(instance).props.onClick(event)
  await Promise.resolve()
  await Promise.resolve()
  instance.rerender()
  return event
}

// --- the boolean that drifts ------------------------------------------------

test("leaving full screen by Escape puts the button back, because the state is re-read", async () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  assert.equal(label(ui), "Fullscreen")

  await click(ui)
  // The browser grants it: this is the only thing that may flip the label.
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  assert.equal(label(ui), "Exit fullscreen")
  assert.equal(button(ui).props["aria-pressed"], true)

  // The user presses Escape. No click, no promise — only the event.
  b.setFullscreenElement(null)
  b.fire()
  ui.rerender()
  assert.equal(label(ui), "Fullscreen")
  assert.equal(button(ui).props["aria-pressed"], false)
})

test("a granted request reports nothing until the browser says so", async () => {
  const b = browser()
  const seen = []
  const ui = render(FullscreenButton, {
    targetRef: b.ref,
    onFullscreenChange: (value) => seen.push(value),
  })
  await click(ui)
  // The promise has resolved, and that is not evidence: `fullscreenchange` is. A version that
  // flips its own state on the way out of the click announces a full screen that may never arrive
  // — the request can still be refused — and the label is the wrong place to catch it, because
  // this harness re-runs the subscription on every pass and quietly corrects it.
  assert.equal(b.calls.request.length, 1)
  assert.deepEqual(seen, [])
  assert.equal(label(ui), "Fullscreen")
})

test("another element being full-screen does not make this button claim it", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  b.setFullscreenElement({ somebody: "else" })
  b.fire()
  ui.rerender()
  assert.equal(label(ui), "Fullscreen")
  assert.equal(button(ui).props["aria-pressed"], false)
})

test("mounting into an element that is already full-screen reads it, with no event at all", () => {
  const b = browser()
  b.setFullscreenElement(b.target)
  const ui = render(FullscreenButton, { targetRef: b.ref })
  assert.equal(label(ui), "Exit fullscreen")
})

// --- the gesture -----------------------------------------------------------

test("requestFullscreen is called during the click itself", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  button(ui).props.onClick({ defaultPrevented: false, preventDefault() {} })
  // Synchronously, before any microtask: an await here is what spends the gesture.
  assert.equal(b.calls.request.length, 1)
})

test("a handler that prevents the default is honoured and nothing is requested", () => {
  const b = browser()
  const ui = render(FullscreenButton, {
    targetRef: b.ref,
    onClick: (event) => event.preventDefault(),
  })
  button(ui).props.onClick({
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true
    },
  })
  assert.equal(b.calls.request.length, 0)
})

// --- the environments where the API is not there ---------------------------

test("an iPhone (no element full-screen at all) gets the CSS fallback", async () => {
  const b = browser({ support: "none" })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(label(ui), "Exit fullscreen")
  assert.equal(b.attributes["data-fullscreen"], "css")
  assert.equal(button(ui).props["data-fullscreen-mode"], "css")
})

test("an iframe without allow=fullscreen is refused asynchronously, and still ends up covered", async () => {
  const b = browser({ request: () => Promise.reject(new Error("permissions policy")) })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.calls.request.length, 1)
  assert.equal(b.attributes["data-fullscreen"], "css")
  assert.equal(label(ui), "Exit fullscreen")
})

test("a synchronous throw from requestFullscreen falls back too", async () => {
  const b = browser({
    request: () => {
      throw new Error("no")
    },
  })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.attributes["data-fullscreen"], "css")
})

test("cssFallback={false} leaves an unsupported browser alone rather than covering the page", async () => {
  const b = browser({ support: "none" })
  const ui = render(FullscreenButton, { targetRef: b.ref, cssFallback: false })
  await click(ui)
  assert.equal(label(ui), "Fullscreen")
  assert.equal(b.attributes["data-fullscreen"], undefined)
})

test("isFullscreenSupported reports the permissions policy, not just the method", () => {
  const yes = browser()
  const no = browser({ fullscreenEnabled: false })
  const absent = browser({ support: "none" })
  assert.equal(isFullscreenSupported(yes.target), true)
  assert.equal(isFullscreenSupported(no.target), false)
  assert.equal(isFullscreenSupported(absent.target), false)
})

// --- the fallback has to actually cover the screen -------------------------

test("the fallback overrides the size the target declares for itself", async () => {
  // The class-based version loses to every one of these.
  const b = browser({
    support: "none",
    inlineStyle: { height: "16rem", "max-width": "28rem", "border-radius": "0.5rem" },
  })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.style.position, "fixed")
  assert.equal(b.style.inset, "0")
  assert.equal(b.style.height, "auto")
  assert.equal(b.style.width, "auto")
  assert.equal(b.style["max-width"], "none")
  assert.equal(b.style["max-height"], "none")
  assert.equal(b.style["border-radius"], "0")
  assert.equal(b.style.margin, "0")
})

test("a transparent target is given the background of the nearest ancestor that paints one", async () => {
  const b = browser({ support: "none", targetBackground: "rgba(0, 0, 0, 0)" })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.style["background-color"], "rgb(9, 9, 11)")
})

test("a target that paints its own background is not repainted", async () => {
  const b = browser({ support: "none", targetBackground: "rgb(255, 255, 255)" })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.style["background-color"], undefined)
})

test("exiting the fallback restores the inline styles that were there, and removes the rest", async () => {
  const b = browser({ support: "none", inlineStyle: { height: "16rem", overflow: "hidden" } })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  await click(ui)
  assert.equal(b.style.height, "16rem")
  assert.equal(b.style.overflow, "hidden")
  assert.equal(b.style.position, undefined)
  assert.equal(b.style.inset, undefined)
  assert.equal(b.attributes["data-fullscreen"], undefined)
  assert.equal(label(ui), "Fullscreen")
})

test("Escape exits the fallback, which has no Escape of its own", async () => {
  const b = browser({ support: "none" })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  const event = b.escape()
  ui.rerender()
  assert.equal(event.prevented, true)
  assert.equal(label(ui), "Fullscreen")
  assert.equal(b.style.position, undefined)
})

test("no keydown listener is installed while the browser owns full screen", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  assert.equal(b.calls.listeners.filter((l) => l.type === "keydown").length, 0)
})

test("leaving native full screen does not tear down a fallback that is up", async () => {
  const b = browser({ request: () => Promise.reject(new Error("refused")) })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  // Some other element's full-screen ends; ours is a CSS cover and must survive it.
  b.setFullscreenElement(null)
  b.fire()
  ui.rerender()
  assert.equal(label(ui), "Exit fullscreen")
  assert.equal(b.style.position, "fixed")
})

// --- not stepping on anyone else ------------------------------------------

test("exit() does nothing when another element owns full screen", () => {
  const b = browser()
  let api = null
  const Probe = (props) => {
    api = useFullscreen(props.targetRef)
    return null
  }
  render(Probe, { targetRef: b.ref })
  // Somebody else owns it. `document.exitFullscreen` is document-wide, so calling it here would
  // yank their full screen out from under them.
  b.setFullscreenElement({ somebody: "else" })
  api.exit()
  assert.deepEqual(b.calls.exit, [])
  // ...and it is not a blanket refusal to ever exit: ours still works.
  b.setFullscreenElement(b.target)
  api.exit()
  assert.deepEqual(b.calls.exit, ["standard"])
})

test("pressing the button while another element owns full screen asks for ours", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  b.setFullscreenElement({ somebody: "else" })
  button(ui).props.onClick({ defaultPrevented: false, preventDefault() {} })
  assert.equal(b.calls.request.length, 1)
  assert.deepEqual(b.calls.exit, [])
})

test("exit uses the prefixed spelling when that is the only one there", () => {
  const b = browser({ support: "webkit" })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  button(ui).props.onClick({ defaultPrevented: false, preventDefault() {} })
  assert.deepEqual(b.calls.exit, ["webkit"])
})

test("older Safari's prefixed request and event are both used", async () => {
  const b = browser({ support: "webkit", request: () => undefined })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.calls.request.length, 1)
  b.setFullscreenElement(b.target)
  b.fire("webkitfullscreenchange")
  ui.rerender()
  assert.equal(label(ui), "Exit fullscreen")
})

// --- cleanup --------------------------------------------------------------

test("unmounting with the fallback up gives the target back, instead of pinning it over the page", async () => {
  const b = browser({ support: "none", inlineStyle: { height: "16rem" } })
  const ui = render(FullscreenButton, { targetRef: b.ref })
  await click(ui)
  assert.equal(b.style.position, "fixed")
  ui.unmount()
  assert.equal(b.style.position, undefined)
  assert.equal(b.style.height, "16rem")
  assert.equal(b.attributes["data-fullscreen"], undefined)
})

test("unmounting does not cancel the browser's own full screen", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  ui.unmount()
  assert.deepEqual(b.calls.exit, [])
})

test("every listener it added is removed on unmount", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  ui.unmount()
  const left = b.calls.listeners.filter(
    (added) => !b.calls.removed.some((gone) => gone.type === added.type && gone.fn === added.fn)
  )
  assert.deepEqual(left, [])
})

// --- what it reports ------------------------------------------------------

test("onFullscreenChange fires on each flip and not on mount", async () => {
  const b = browser()
  const seen = []
  const ui = render(FullscreenButton, {
    targetRef: b.ref,
    onFullscreenChange: (value) => seen.push(value),
  })
  assert.deepEqual(seen, [])
  await click(ui)
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  b.setFullscreenElement(null)
  b.fire()
  ui.rerender()
  assert.deepEqual(seen, [true, false])
})

test("the state is on aria-pressed, not only in the icon", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  assert.equal(button(ui).props["aria-pressed"], false)
  assert.equal(button(ui).props["data-state"], "windowed")
})

test("type=button, so it does not submit the form it sits in", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  assert.equal(button(ui).props.type, "button")
})

test("iconOnly keeps an accessible name and drops only the visible text", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref, iconOnly: true })
  assert.equal(label(ui), "")
  assert.equal(button(ui).props["aria-label"], "Fullscreen")
})

test("the icon is hidden from assistive technology", () => {
  const b = browser()
  const ui = render(FullscreenButton, { targetRef: b.ref })
  const icon = walk(ui.tree).find((node) => node.props?.["aria-hidden"] === "true")
  assert.ok(icon, "the icon should carry aria-hidden")
})

test("labels are overridable", async () => {
  const b = browser()
  const ui = render(FullscreenButton, {
    targetRef: b.ref,
    enterLabel: "Expand chart",
    exitLabel: "Shrink chart",
  })
  assert.equal(label(ui), "Expand chart")
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  assert.equal(label(ui), "Shrink chart")
})

// --- the hook on its own --------------------------------------------------

test("useFullscreen hands back the same behaviour for a control you lay out yourself", () => {
  const b = browser()
  const seen = []
  const Probe = (props) => {
    const state = useFullscreen(props.targetRef)
    seen.push(state)
    return null
  }
  const ui = render(Probe, { targetRef: b.ref })
  const first = seen[seen.length - 1]
  assert.equal(first.isFullscreen, false)
  assert.equal(first.mode, "off")
  assert.equal(first.isSupported, true)
  b.setFullscreenElement(b.target)
  b.fire()
  ui.rerender()
  const next = seen[seen.length - 1]
  assert.equal(next.isFullscreen, true)
  assert.equal(next.mode, "native")
})

test("a null target is survivable — nothing is requested and nothing throws", async () => {
  const ui = render(FullscreenButton, { targetRef: { current: null } })
  await click(ui)
  assert.equal(label(ui), "Fullscreen")
})
