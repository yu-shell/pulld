// The naive version of this component is a banner with one "Accept" button that writes
// `localStorage.cookiesAccepted = true`, and nearly everything that makes a consent UI honest is
// in what that line gets wrong. So the cases below are written to pass against the shipped
// implementation and fail against the versions that look right:
//
//   - a banner rendered from a `decided: false` initial state, which flashes on every single page
//     load for the visitor who already answered,
//   - a gate that renders its child before the answer is known, so the tag fires for the person
//     who is about to refuse,
//   - only storing the grant, so a refusal is forgotten and the refuser is asked again every load,
//   - `if (navigator.doNotTrack)`, which reads `"0"` — "you may track me" — as a refusal, because
//     it is a non-empty string,
//   - `navigator.globalPrivacyControl` read without a feature test, when Chrome does not have the
//     property at all, or read for truthiness, when `false` means "no signal",
//   - writing the signal-derived refusal to storage, so it outlives the setting that produced it,
//   - letting the signal override an explicit choice made in the panel, which makes the switches
//     a lie,
//   - treating a stored answer that predates a newly added category as a complete answer,
//   - a disabled switch for the necessary category, which invites a click and then ignores it,
//   - `role="dialog"` with `aria-modal`, which claims the rest of the page does not exist while
//     the page is still fully usable behind it,
//   - hiding the refusal behind a "Choose" step while the agreement is one click,
//   - a gate that opens on a category nobody configured, so a typo grants itself,
//   - assuming a grant when storage throws.
//
// The store is module-level — one answer per browser — so each test that cares about the state
// before hydration loads its own copy of the module through `fresh()`. That the copies do not see
// each other is the other half of the same property.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "registry", "ui", "cookie-consent.tsx")

const icons = new Proxy({}, { get: () => () => null })

// --- a browser small enough to hold the parts this component touches -------------------------

const windowListeners = new Map()

const eventTarget = (store) => ({
  addEventListener(type, fn) {
    if (!store.has(type)) store.set(type, [])
    store.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    store.set(
      type,
      (store.get(type) ?? []).filter((registered) => registered !== fn)
    )
  },
})

// The harness runs effects the way a commit would but never runs their cleanups between settle
// passes, so every pass leaves another copy of a listener behind. Dispatching to the most recently
// registered one is what a real commit would have left in place.
function dispatch(store, type, event) {
  const handlers = store.get(type) ?? []
  handlers[handlers.length - 1]?.(event)
}

const cell = new Map()
const storage = {
  writes: [],
  removals: [],
  throwOnRead: false,
  throwOnWrite: false,
  getItem(key) {
    if (storage.throwOnRead) throw new Error("storage is blocked")
    return cell.has(key) ? cell.get(key) : null
  },
  setItem(key, value) {
    if (storage.throwOnWrite) throw new Error("storage is full")
    cell.set(key, value)
    storage.writes.push({ key, value })
  },
  removeItem(key) {
    cell.delete(key)
    storage.removals.push(key)
  },
}

globalThis.window = { ...eventTarget(windowListeners), localStorage: storage }
// Only what `open()` reads. HTMLElement has to exist as a constructor because the component asks
// `activeElement instanceof HTMLElement` before trusting it.
class FakeHTMLElement {
  constructor() {
    this.focusCalls = 0
  }
  focus() {
    this.focusCalls += 1
  }
}
globalThis.HTMLElement = FakeHTMLElement
globalThis.document = { activeElement: null }

// `navigator` is an accessor on globalThis with a getter and no setter, so `globalThis.navigator =
// x` is silently discarded — no throw, no effect, and a signal test that did it would pass for the
// wrong reason. defineProperty is the only way to put one there.
function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  })
}

let now = 1_762_300_000_000
Date.now = () => now

function reset() {
  windowListeners.clear()
  cell.clear()
  storage.writes.length = 0
  storage.removals.length = 0
  storage.throwOnRead = false
  storage.throwOnWrite = false
  document.activeElement = null
  now = 1_762_300_000_000
  setNavigator({ userAgent: "test" })
}

/** A copy of the module with its own store, so the state before hydration is reachable. */
function fresh() {
  return loadComponent(SOURCE, { stubs: { "lucide-react": icons } })
}

const KEY = "pulld-cookie-consent"

/** An answer already in storage, in the shape the component writes. */
function seed(cats, { ver = "1", at = now, key = KEY } = {}) {
  cell.set(key, JSON.stringify({ v: ver, at, cats }))
}

const stored = (key = KEY) => (cell.has(key) ? JSON.parse(cell.get(key)) : null)

/** Every node in a rendered tree, function components invoked. */
const nodes = (instance) => walk(instance.tree)

const buttons = (instance) => byTag(nodes(instance), "button")
const textOf = (node) => {
  const out = []
  const visit = (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return
    if (Array.isArray(child)) return child.forEach(visit)
    if (typeof child === "object") return visit(child.props?.children)
    out.push(String(child))
  }
  visit(node.props?.children)
  return out.join(" ")
}
const buttonNamed = (instance, label) =>
  buttons(instance).find((node) => textOf(node).includes(label))

const click = (instance, label) => {
  const button = buttonNamed(instance, label)
  assert.ok(button, `no button labelled ${label}`)
  button.props.onClick()
  instance.rerender()
}

/** A gate component rendered on its own, reading the same module's store. */
function gateFor(mod, category) {
  return render(mod.ConsentGate, { category, children: "tag", fallback: "off" })
}

// --- what is known before anything is read ---------------------------------------------------

test("before hydration nothing is granted and nothing is asked", () => {
  reset()
  const mod = fresh()

  const state = mod.readConsent()
  assert.equal(state.status, "unknown")
  assert.deepEqual(state.granted, {})

  // A gate in this state is closed: the answer is not "no", but acting on "not yet asked" is the
  // same mistake as acting on "no".
  const gate = gateFor(mod, "analytics")
  assert.equal(gate.tree.props.children, "off")
})

test("a returning visitor's banner never renders, not even for one pass", () => {
  reset()
  seed({ analytics: true, marketing: false })
  const mod = fresh()

  // The banner is what a visitor sees again on every load when the pre-mount state is modelled as
  // "undecided" rather than "unknown".
  const banner = render(mod.CookieConsent, {})
  assert.equal(banner.tree, null)
  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().source, "user")
})

test("the banner renders for a visitor who has not answered", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  assert.equal(banner.tree.type, "section")
  assert.equal(banner.tree.props.role, "region")
  assert.equal(banner.tree.props["aria-label"], "Cookie consent")
  // Not a dialog, and nothing claiming the page behind it is gone.
  assert.equal(banner.tree.props["aria-modal"], undefined)
  assert.notEqual(banner.tree.props.role, "dialog")
})

// --- the answer, and the refusal -------------------------------------------------------------

test("a refusal is stored as explicitly as a grant", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  click(banner, "Necessary only")

  // Not an absent key, not a `dismissed` flag: the answer to each question, so the next load has
  // one and does not ask again.
  assert.deepEqual(stored().cats, { analytics: false, marketing: false })
  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().granted.necessary, true)
  assert.equal(mod.readConsent().granted.analytics, false)
})

test("a stored refusal is a complete answer on the next load", () => {
  reset()
  seed({ analytics: false, marketing: false })
  const mod = fresh()

  assert.equal(render(mod.CookieConsent, {}).tree, null)
  assert.equal(mod.readConsent().status, "decided")
})

test("allow-all grants every optional category", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  click(banner, "Allow all")

  assert.deepEqual(stored().cats, { analytics: true, marketing: true })
  assert.equal(stored().at, now)
  assert.equal(mod.readConsent().decidedAt, now)
})

test("the refusal is in the banner itself, not behind the customise step", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  // One click to refuse, the same as to agree. A banner that offers only "Allow all" and
  // "Choose" is the dark pattern this question exists to avoid.
  assert.ok(buttonNamed(banner, "Allow all"))
  assert.ok(buttonNamed(banner, "Necessary only"))
})

test("save records exactly the switches, and nothing a caller invented", () => {
  reset()
  const mod = fresh()
  let consent = null
  const controller = render((props) => {
    consent = mod.useCookieConsent(props)
    return null
  }, {})

  consent.save({ analytics: true, nonsense: true })

  // The optional categories are the question; a key the caller invented is not an answer to it.
  assert.deepEqual(stored().cats, { analytics: true, marketing: false })
  assert.equal("nonsense" in stored().cats, false)
  controller.unmount()
})

// --- the signals -----------------------------------------------------------------------------

test("doNotTrack is a refusal only at the one value that means it", () => {
  reset()
  const mod = fresh()

  setNavigator({ doNotTrack: "1" })
  assert.equal(mod.refusalSignal(), "dnt")

  // The trap: `"0"` means "you may track me" and is a truthy string, so every truthiness test
  // reads an explicit permission as a refusal.
  setNavigator({ doNotTrack: "0" })
  assert.equal(mod.refusalSignal(), null)

  // Measured in Chrome 152: the property is present and null.
  setNavigator({ doNotTrack: null })
  assert.equal(mod.refusalSignal(), null)

  setNavigator({ doNotTrack: "unspecified" })
  assert.equal(mod.refusalSignal(), null)
})

test("globalPrivacyControl is feature-tested, and false is not a refusal", () => {
  reset()
  const mod = fresh()

  setNavigator({ globalPrivacyControl: true })
  assert.equal(mod.refusalSignal(), "gpc")

  // `false` is a browser saying it has no signal to send.
  setNavigator({ globalPrivacyControl: false })
  assert.equal(mod.refusalSignal(), null)

  // Chrome 152 does not have the property at all. Reading it must not throw and must not decide.
  setNavigator({ userAgent: "test" })
  assert.equal(mod.refusalSignal(), null)
})

test("a browser carrying a refusal is not asked, and the refusal is not written down", () => {
  reset()
  setNavigator({ globalPrivacyControl: true })
  const mod = fresh()

  assert.equal(render(mod.CookieConsent, {}).tree, null)
  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().source, "signal")
  assert.equal(mod.readConsent().granted.analytics, false)
  assert.equal(mod.readConsent().granted.necessary, true)

  // Nothing persisted: this is the browser's live setting, not a record of a choice. Writing it
  // would make it outlive the setting.
  assert.equal(stored(), null)
  assert.deepEqual(storage.writes, [])
})

test("a signal that goes away asks again, because nobody had answered", () => {
  reset()
  setNavigator({ doNotTrack: "1" })
  const first = fresh()
  render(first.CookieConsent, {})
  assert.equal(first.readConsent().source, "signal")

  // Next load, signal off. A decision nobody made must not outlive the thing that made it.
  reset()
  const second = fresh()
  const banner = render(second.CookieConsent, {})
  assert.notEqual(banner.tree, null)
  assert.equal(second.readConsent().status, "undecided")
})

test("an explicit choice outranks the signal, or the switches would be a lie", () => {
  reset()
  seed({ analytics: true, marketing: false })
  setNavigator({ globalPrivacyControl: true })
  const mod = fresh()
  render(mod.CookieConsent, {})

  // The person opened the panel on this site and granted analytics. A global default cannot
  // silently undo the specific answer, or there is no way for anybody to ever opt in.
  assert.equal(mod.readConsent().source, "user")
  assert.equal(mod.readConsent().granted.analytics, true)
  assert.equal(mod.readConsent().granted.marketing, false)
})

// --- the shape of the question changing -------------------------------------------------------

test("a category added since the answer makes it an answer to a different question", () => {
  reset()
  seed({ analytics: true, marketing: false })
  const mod = fresh()

  const categories = [
    ...mod.DEFAULT_CATEGORIES,
    { id: "personalisation", label: "Personalisation", description: "Remembers your layout." },
  ]
  const banner = render(mod.CookieConsent, { categories })

  assert.notEqual(banner.tree, null)
  assert.equal(mod.readConsent().status, "undecided")
  // The answers that were given still hold while the rest is asked, so the panel opens on what
  // the person already said rather than on a reset set of refusals.
  assert.equal(mod.readConsent().granted.analytics, true)
  assert.equal(mod.readConsent().granted.personalisation, false)
})

test("a version bump asks again", () => {
  reset()
  seed({ analytics: true, marketing: true }, { ver: "1" })
  const mod = fresh()

  assert.notEqual(render(mod.CookieConsent, { version: 2 }).tree, null)
  assert.equal(mod.readConsent().status, "undecided")
})

test("a record missing a field is not a record", () => {
  reset()
  // Every field is checked, not just the first one that happens to be there. A record with no
  // timestamp would otherwise be accepted and reported as decided at `undefined`.
  cell.set(KEY, JSON.stringify({ v: "1", cats: { analytics: true, marketing: false } }))
  const mod = fresh()
  render(mod.CookieConsent, {})

  assert.equal(mod.readConsent().status, "undecided")
  assert.equal(mod.readConsent().decidedAt, null)
})

test("reconfiguring the categories takes effect", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {
    categories: [{ id: "analytics", label: "Analytics", description: "Counts visits." }],
  })
  click(banner, "Choose")
  assert.equal(nodes(banner).filter((node) => node.props?.role === "switch").length, 1)

  // The status does not change here — undecided before, undecided after — so only comparing the
  // grant maps by key set notices that there is a new question to ask.
  banner.update({
    categories: [
      { id: "analytics", label: "Analytics", description: "Counts visits." },
      { id: "marketing", label: "Marketing", description: "Measures campaigns." },
    ],
  })
  assert.equal(nodes(banner).filter((node) => node.props?.role === "switch").length, 2)
  assert.equal(mod.readConsent().granted.marketing, false)
  banner.unmount()
})

test("a signal switched on mid-session is honoured", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  assert.equal(mod.readConsent().status, "undecided")

  // Undecided and signal-refused share a `decidedAt` of null and differ in everything else, so
  // this is the transition an equality check that treats "any field matches" as unchanged drops.
  setNavigator({ globalPrivacyControl: true })
  dispatch(windowListeners, "storage", { key: null })

  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().source, "signal")
  banner.unmount()
})

test("refusalSignal answers on a server, where there is no navigator", () => {
  reset()
  const mod = fresh()
  Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true })
  assert.equal(mod.refusalSignal(), null)
  reset()
})

test("a stored record that is not one is ignored rather than trusted", () => {
  reset()
  cell.set(KEY, "true")
  const mod = fresh()
  render(mod.CookieConsent, {})
  assert.equal(mod.readConsent().status, "undecided")

  reset()
  cell.set(KEY, '{"v":"1","at":1,"cats":{"analytics":"yes"}}')
  const second = fresh()
  render(second.CookieConsent, {})
  // A non-boolean answer is dropped, which leaves the answer incomplete, which asks again.
  assert.equal(second.readConsent().status, "undecided")
  assert.equal(second.readConsent().granted.analytics, false)
})

// --- the panel -------------------------------------------------------------------------------

test("the necessary category gets words, not a switch that ignores the click", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  click(banner, "Choose")

  const switches = nodes(banner).filter((node) => node.props?.role === "switch")
  assert.equal(switches.length, 2)
  for (const node of switches) {
    assert.equal(node.props.disabled, undefined)
    assert.equal(typeof node.props["aria-checked"], "boolean")
    // Labelled and described by its own category, not by one shared id.
    assert.ok(node.props["aria-labelledby"])
    assert.ok(node.props["aria-describedby"])
  }
  assert.notEqual(
    switches[0].props["aria-labelledby"],
    switches[1].props["aria-labelledby"],
    "two switches sharing one label id announce the same name"
  )
})

test("a footer link opens the mounted banner's panel, not one of its own", () => {
  reset()
  seed({ analytics: true, marketing: false })
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  assert.equal(banner.tree, null, "an answered visitor sees nothing until they ask")

  // The documented use: a "Cookie settings" link somewhere else entirely. Held in the component's
  // own useState, `open()` here opens a panel inside the footer and leaves the banner shut.
  let footer = null
  const link = render(() => {
    footer = mod.useCookieConsent()
    return null
  }, {})
  footer.open()
  banner.rerender()

  assert.notEqual(banner.tree, null, "the banner should be showing its panel")
  const switches = nodes(banner).filter((node) => node.props?.role === "switch")
  assert.equal(switches.length, 2)
  // Opened on the answer that was given, not on a reset set of refusals.
  assert.deepEqual(
    switches.map((node) => node.props["aria-checked"]),
    [true, false]
  )
  link.unmount()
  banner.unmount()
})

test("closing the panel hands focus back to whatever opened it", () => {
  reset()
  seed({ analytics: true, marketing: false })
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  const settingsLink = new FakeHTMLElement()
  document.activeElement = settingsLink
  let footer = null
  const link = render(() => {
    footer = mod.useCookieConsent()
    return null
  }, {})
  footer.open()
  banner.rerender()

  click(banner, "Cancel")
  assert.equal(settingsLink.focusCalls, 1)
  // Nothing changed, and the banner is out of the way again.
  assert.equal(banner.tree, null)
  assert.equal(mod.readConsent().granted.analytics, true)
  link.unmount()
  banner.unmount()
})

test("the switches are toggled and saved as a set", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  click(banner, "Choose")

  const first = nodes(banner).filter((node) => node.props?.role === "switch")[0]
  assert.equal(first.props["aria-checked"], false)
  first.props.onClick()
  banner.rerender()

  const after = nodes(banner).filter((node) => node.props?.role === "switch")[0]
  assert.equal(after.props["aria-checked"], true)

  click(banner, "Save choices")
  assert.deepEqual(stored().cats, { analytics: true, marketing: false })
  // Answering puts the panel away. One that stays open is asking a question already answered.
  assert.equal(banner.tree, null)
})

test("every control is a button rather than a submit", () => {
  const check = (instance) => {
    const all = buttons(instance)
    assert.ok(all.length >= 3)
    for (const node of all) {
      // Without this a banner placed inside a form submits it on every click, including the
      // refusal.
      assert.equal(node.props.type, "button", textOf(node))
    }
  }

  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  check(banner)
  click(banner, "Choose")
  check(banner)
  banner.unmount()

  // Reopened after an answer, which is the only state that has a Cancel to get wrong.
  reset()
  const decided = fresh()
  seed({ analytics: true, marketing: false })
  const reopened = render(decided.CookieConsent, {})
  let footer = null
  const link = render(() => {
    footer = decided.useCookieConsent()
    return null
  }, {})
  footer.open()
  reopened.rerender()
  assert.ok(buttonNamed(reopened, "Cancel"))
  check(reopened)
  link.unmount()
  reopened.unmount()
})

test("the decorative parts are hidden from the accessibility tree", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  // The icon repeats the heading; the switch's knob is the switch's own state said twice.
  const hidden = nodes(banner).filter((node) => "aria-hidden" in (node.props ?? {}))
  assert.ok(hidden.length >= 1)
  for (const node of hidden) assert.equal(node.props["aria-hidden"], "true")

  click(banner, "Choose")
  for (const node of nodes(banner).filter((n) => "aria-hidden" in (n.props ?? {}))) {
    assert.equal(node.props["aria-hidden"], "true")
  }
})

test("the panel takes focus without taking a place in the tab order", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  click(banner, "Choose")

  const panel = nodes(banner).find((node) => node.props?.tabIndex !== undefined)
  assert.ok(panel)
  // -1 is focusable-by-script-only. 0 adds a stop nobody asked for, and a positive value jumps
  // ahead of every other control on the page.
  assert.equal(panel.props.tabIndex, -1)
})

test("no colour is hardcoded past the theme", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  click(banner, "Choose")

  for (const node of nodes(banner)) {
    const className = node.props?.className
    if (typeof className !== "string") continue
    assert.doesNotMatch(className, /#[0-9a-f]{3}|rgb\(|hsl\(/i, className)
  }
})

test("opening the panel moves focus into it", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  click(banner, "Choose")

  const focused = banner.nodes.filter((node) => node.calls.some((call) => call.name === "focus"))
  assert.equal(focused.length, 1, "the panel should be focused once it is shown")
})

// --- the gate --------------------------------------------------------------------------------

test("the gate opens only on a granted category, and a typo is not one", () => {
  reset()
  seed({ analytics: true, marketing: false })
  const mod = fresh()
  render(mod.CookieConsent, {})

  assert.equal(gateFor(mod, "analytics").tree.props.children, "tag")
  assert.equal(gateFor(mod, "marketing").tree.props.children, "off")
  // Nobody configured this one, so it is not granted — the typo does not grant itself.
  assert.equal(gateFor(mod, "analytcs").tree.props.children, "off")
})

test("a required category is granted before anybody answers", () => {
  reset()
  const mod = fresh()
  render(mod.CookieConsent, {})

  assert.equal(gateFor(mod, "necessary").tree.props.children, "tag")
  assert.equal(gateFor(mod, "analytics").tree.props.children, "off")
})

test("every gate in the tree reads the one answer", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  const before = gateFor(mod, "analytics")
  assert.equal(before.tree.props.children, "off")

  click(banner, "Allow all")

  // The gate rendered before the answer follows it, rather than each gate holding its own copy.
  before.rerender()
  assert.equal(before.tree.props.children, "tag")
  assert.equal(gateFor(mod, "analytics").tree.props.children, "tag")
})

test("two copies of the module do not share a store", () => {
  reset()
  const a = fresh()
  const b = fresh()
  render(a.CookieConsent, {})
  const bannerA = render(a.CookieConsent, {})
  click(bannerA, "Allow all")

  assert.equal(a.readConsent().granted.analytics, true)
  assert.equal(b.readConsent().status, "unknown")
})

// --- another tab, and storage that will not cooperate ------------------------------------------

test("an answer given in another tab reaches this one", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  assert.equal(mod.readConsent().status, "undecided")

  seed({ analytics: true, marketing: true })
  dispatch(windowListeners, "storage", { key: KEY })

  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().granted.analytics, true)
  // A gate left shut after the person consented next door is the same bug as one that never opens.
  assert.equal(gateFor(mod, "analytics").tree.props.children, "tag")

  banner.unmount()
})

test("a storage event for something else is not an answer", () => {
  reset()
  const mod = fresh()
  render(mod.CookieConsent, {})
  seed({ analytics: true, marketing: true })

  dispatch(windowListeners, "storage", { key: "some-other-app" })
  assert.equal(mod.readConsent().status, "undecided")

  // A cleared origin (`key: null`) does concern us.
  dispatch(windowListeners, "storage", { key: null })
  assert.equal(mod.readConsent().status, "decided")
})

test("blocked storage asks rather than assuming a grant", () => {
  reset()
  seed({ analytics: true, marketing: true })
  storage.throwOnRead = true
  const mod = fresh()

  assert.notEqual(render(mod.CookieConsent, {}).tree, null)
  assert.equal(mod.readConsent().status, "undecided")
  assert.equal(mod.readConsent().granted.analytics, false)
})

test("a write that fails still applies to this page", () => {
  reset()
  storage.throwOnWrite = true
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})

  click(banner, "Allow all")

  // Losing the answer is recoverable — they get asked again. Dropping the decision for this page
  // because the write failed is not.
  assert.equal(mod.readConsent().status, "decided")
  assert.equal(mod.readConsent().granted.analytics, true)
})

test("reset forgets the answer and asks again", () => {
  reset()
  seed({ analytics: true, marketing: true })
  const mod = fresh()
  let consent = null
  const controller = render(
    (props) => {
      consent = mod.useCookieConsent(props)
      return null
    },
    {}
  )
  assert.equal(consent.status, "decided")

  consent.reset()
  controller.rerender()

  assert.deepEqual(storage.removals, [KEY])
  assert.equal(mod.readConsent().status, "undecided")
  assert.equal(mod.readConsent().granted.analytics, false)
  // Forgetting the answer is not the same as asking for it: the panel stays shut and the banner
  // does the asking.
  assert.equal(consent.isOpen, false)
  controller.unmount()
})

test("the storage listener is removed on unmount", () => {
  reset()
  const mod = fresh()
  const banner = render(mod.CookieConsent, {})
  assert.ok((windowListeners.get("storage") ?? []).length >= 1)

  banner.unmount()
  assert.equal((windowListeners.get("storage") ?? []).length, 0)
})

// --- the decision callback --------------------------------------------------------------------

test("onDecision is handed what may now be used", () => {
  reset()
  const mod = fresh()
  const seen = []
  const banner = render(mod.CookieConsent, {
    onDecision: (granted, source) => seen.push({ granted, source }),
  })

  click(banner, "Necessary only")

  assert.equal(seen.length, 1)
  assert.equal(seen[0].source, "user")
  assert.equal(seen[0].granted.necessary, true)
  assert.equal(seen[0].granted.analytics, false)
})
