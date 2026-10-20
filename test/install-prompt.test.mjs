// `beforeinstallprompt` is the one event in this registry that cannot be waited for: it fires once,
// it fires early, and it does not replay. Everything below is written against the specific wrong
// versions:
//
//   - adding the listener in `useEffect`, which on a warm cache runs after Chromium has already
//     dispatched the event — the bug behind "it never shows up on my machine, but it does on
//     yours", and the one that passes in development because the bundle arrives first,
//   - treating availability as a boolean, which collapses "cannot install" into "can install but
//     not by asking" and shows an iPhone nothing at all on the platform where adding to the home
//     screen matters most,
//   - reading only `(display-mode: standalone)`, which offers to install the app to somebody
//     already running it in `fullscreen`, `minimal-ui` or `window-controls-overlay`,
//   - forgetting that iOS spells the same question `navigator.standalone`,
//   - awaiting anything before `prompt()`, which spends the user gesture and turns a working
//     button into NotAllowedError,
//   - keeping the event after it has been prompted, so a second click rejects,
//   - reporting a rejected prompt as a dismissal, when nobody declined anything,
//   - pointing `aria-controls` at a panel that is only in the tree once it is open,
//   - and a typo in either half of the two-program contract with `earlyCaptureScript`, which is not
//     an error anywhere — it is a button that silently never appears, on somebody else's machine.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

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
const mediaListeners = new Map()
let matchingModes = new Set()

// Set up before the component is loaded, because the whole point of this file is that the listeners
// are attached at module scope rather than from an effect. A `window` that appears afterwards would
// be testing a component that does not exist.
globalThis.window = {
  ...eventTarget(windowListeners),
  // Keyed by query *and* event type, so registering the wrong type is a test failure rather than a
  // listener that is simply never fired.
  matchMedia(query) {
    return {
      get matches() {
        return matchingModes.has(query)
      },
      addEventListener(type, fn) {
        const key = `${query}|${type}`
        mediaListeners.set(key, [...(mediaListeners.get(key) ?? []), fn])
      },
      removeEventListener(type, fn) {
        const key = `${query}|${type}`
        mediaListeners.set(key, (mediaListeners.get(key) ?? []).filter((r) => r !== fn))
      },
    }
  },
  navigator: { userAgent: "node", maxTouchPoints: 0 },
}

/** Fires a media query's change handlers, the way entering an installed window does. */
function fireMedia(query, type = "change") {
  const handlers = mediaListeners.get(`${query}|${type}`) ?? []
  handlers[handlers.length - 1]?.()
  return handlers.length
}

/** How many media handlers are still registered — zero after unmount, or the effect leaked one. */
function mediaHandlerCount() {
  return [...mediaListeners.values()].reduce((n, fns) => n + fns.length, 0)
}

/** Runs `fn` with a global removed, which is the only way to reach the server-side guards. */
function withoutGlobal(name, fn) {
  const saved = globalThis[name]
  delete globalThis[name]
  try {
    return fn()
  } finally {
    Object.defineProperty(globalThis, name, { value: saved, configurable: true, writable: true })
  }
}

/** Flattens an element's text, so the install button can be told apart from the steps toggle. */
function labelOf(node) {
  const out = []
  const visit = (child) => {
    if (child == null || typeof child === "boolean") return
    if (typeof child === "string" || typeof child === "number") out.push(String(child))
    else if (Array.isArray(child)) child.forEach(visit)
    else if (child.props) visit(child.props.children)
  }
  visit(node.props?.children)
  return out.join("")
}

function setNavigator(value) {
  globalThis.window.navigator = value
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  })
}

setNavigator({ userAgent: "node", maxTouchPoints: 0 })

const { InstallPrompt, useInstallPrompt, earlyCaptureScript, isRunningInstalled, isIosLike, INSTALL_CAPTURE_KEY } =
  loadComponent(join(ROOT, "registry", "ui", "install-prompt.tsx"), {
    stubs: { "lucide-react": icons },
  })

/** The store created at module scope, held so `resetCapture` can restore identity. */
const ORIGINAL_STORE = globalThis.window[INSTALL_CAPTURE_KEY]

/** The handler registered last — the one a real commit would have left in place. */
function dispatch(type, event) {
  const handlers = windowListeners.get(type) ?? []
  return handlers[handlers.length - 1]?.(event)
}

/**
 * Clears the parked event between tests by mutating the store rather than replacing it.
 *
 * Replacing `window[INSTALL_CAPTURE_KEY]` would leave the listeners writing to the object they
 * closed over while the hook reads the new one — an event captured into a store nobody reads, which
 * is a fair description of the bug this component exists to prevent.
 */
function resetCapture() {
  // Put the original object back first: a test that exercises the creation path leaves a different
  // one on `window`, and the listeners would then be writing where the hook no longer reads.
  globalThis.window[INSTALL_CAPTURE_KEY] = ORIGINAL_STORE
  ORIGINAL_STORE.event = null
  ORIGINAL_STORE.installed = false
  matchingModes = new Set()
  mediaListeners.clear()
  setNavigator({ userAgent: "node", maxTouchPoints: 0 })
}

function makeEvent({ outcome = "accepted", prompt } = {}) {
  const event = {
    platforms: ["web"],
    prevented: 0,
    promptCalls: 0,
    preventDefault() {
      event.prevented++
    },
    userChoice: Promise.resolve({ outcome, platform: "web" }),
    prompt() {
      event.promptCalls++
      if (prompt) return prompt()
      return Promise.resolve()
    },
  }
  return event
}

/** Renders the hook on its own, which is how the outcome of a press can be awaited. */
function renderHook(options = {}) {
  let api = null
  const view = render(function Probe(props) {
    api = useInstallPrompt(props)
    return null
  }, options)
  return { get api() { return api }, view }
}

const IOS = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", maxTouchPoints: 5 }

test("an event dispatched before anything mounts is still there when it does", () => {
  resetCapture()
  // Fired while no component exists — the case an effect-registered listener misses entirely.
  dispatch("beforeinstallprompt", makeEvent())

  const view = render(InstallPrompt, {})
  const buttons = byTag(walk(view.tree), "button")
  assert.equal(buttons.length, 1, "捕まえ損ねると、この時点でボタンが無い")
  // 件数だけでは足りない。iOS の手順トグルも button を 1 つ出すので、どちらが出たかまで見る。
  assert.equal(labelOf(buttons[0]), "Install app")
  assert.equal(buttons[0].props["aria-expanded"], undefined, "インストールボタンは何も開かない")
  view.unmount()
})

test("the captured event is prevented, so the browser's own bar does not also appear", () => {
  resetCapture()
  const event = makeEvent()
  dispatch("beforeinstallprompt", event)
  assert.equal(event.prevented, 1)
})

test("nothing is rendered when there is nothing to install", () => {
  resetCapture()
  const view = render(InstallPrompt, {})
  assert.equal(view.tree, null)
  view.unmount()
})

test("iOS is given written steps rather than nothing, because the event does not exist there", () => {
  resetCapture()
  setNavigator(IOS)

  const view = render(InstallPrompt, {})
  const nodes = walk(view.tree)
  const button = byTag(nodes, "button")[0]
  assert.ok(button, "iOS では手順への導線が出る")
  assert.equal(labelOf(button), "Add to Home Screen", "押せないのに Install と書いてはいけない")
  assert.equal(button.props.type, "button", "周囲のフォームを送信しない")
  assert.equal(button.props["aria-expanded"], false)
  assert.ok(
    nodes.some((n) => n.props?.["aria-hidden"] === "true"),
    "共有アイコンも装飾なので aria-hidden"
  )

  const panel = nodes.find((n) => n.props?.id === button.props["aria-controls"])
  assert.ok(panel, "aria-controls は実在する要素を指していなければならない")
  assert.equal(panel.props.hidden, true, "閉じている間は hidden 属性で隠す（木から外さない）")
  view.unmount()
})

test("the steps can be refused, and then iOS gets nothing at all", () => {
  resetCapture()
  setNavigator(IOS)
  const view = render(InstallPrompt, { instructions: false })
  assert.equal(view.tree, null)
  view.unmount()
})

test("pressing the steps toggle flips aria-expanded and reveals the panel", () => {
  resetCapture()
  setNavigator(IOS)

  const view = render(InstallPrompt, {})
  byTag(walk(view.tree), "button")[0].props.onClick()
  view.rerender()

  const nodes = walk(view.tree)
  const button = byTag(nodes, "button")[0]
  assert.equal(button.props["aria-expanded"], true)
  const panel = nodes.find((n) => n.props?.id === button.props["aria-controls"])
  assert.equal(panel.props.hidden, false)
  view.unmount()
})

test("all four installed display modes count as installed, not standalone alone", () => {
  for (const mode of ["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"]) {
    resetCapture()
    matchingModes = new Set([`(display-mode: ${mode})`])
    assert.equal(isRunningInstalled(), true, `${mode} は既にインストール済みとして読む`)
  }
})

test("an installed app is not offered an install, even with an event in hand", () => {
  resetCapture()
  dispatch("beforeinstallprompt", makeEvent())
  matchingModes = new Set(["(display-mode: standalone)"])

  const view = render(InstallPrompt, {})
  assert.equal(view.tree, null)
  view.unmount()
})

test("iOS reports an installed app through navigator.standalone, which has no media feature", () => {
  resetCapture()
  setNavigator({ ...IOS, standalone: true })
  assert.equal(isRunningInstalled(), true)
  assert.equal(isIosLike(), true)
})

test("an iPad reporting itself as a Macintosh is still iOS", () => {
  resetCapture()
  setNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 })
  assert.equal(isIosLike(), true, "iPadOS 13 以降は Macintosh と自称する。分かれ目はタッチの有無")

  setNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 })
  assert.equal(isIosLike(), false, "本物のデスクトップ Safari は maxTouchPoints が 0")
})

test("appinstalled spends the event and the button goes away", () => {
  resetCapture()
  dispatch("beforeinstallprompt", makeEvent())
  const view = render(InstallPrompt, {})
  assert.equal(byTag(walk(view.tree), "button").length, 1)

  dispatch("appinstalled")
  view.rerender()
  assert.equal(view.tree, null)
  view.unmount()
})

test("prompt is called with nothing awaited in front of it", () => {
  resetCapture()
  const event = makeEvent()
  dispatch("beforeinstallprompt", event)
  const { api, view } = renderHook()

  const pending = api.promptToInstall()
  // Asserted before awaiting: the browser honours prompt() only while the click is still the
  // active user gesture, so anything awaited first is what breaks the button in production.
  assert.equal(event.promptCalls, 1, "await を挟んでから呼ぶと NotAllowedError になる")
  return pending.then(() => view.unmount())
})

test("the event is spent, so a second press does not prompt again", async () => {
  resetCapture()
  const event = makeEvent()
  dispatch("beforeinstallprompt", event)
  const { api, view } = renderHook()

  assert.equal(await api.promptToInstall(), "accepted")
  assert.equal(await api.promptToInstall(), "unavailable")
  assert.equal(event.promptCalls, 1, "使い終えたイベントで prompt() を呼ぶと reject される")
  view.unmount()
})

test("the answer is reported, accepted and dismissed alike", async () => {
  for (const outcome of ["accepted", "dismissed"]) {
    resetCapture()
    const reported = []
    dispatch("beforeinstallprompt", makeEvent({ outcome }))
    const { api, view } = renderHook({ onOutcome: (o) => reported.push(o) })

    assert.equal(await api.promptToInstall(), outcome)
    assert.deepEqual(reported, [outcome])
    view.unmount()
  }
})

test("a rejected prompt is unavailable, not a dismissal — nobody declined anything", async () => {
  resetCapture()
  const reported = []
  dispatch("beforeinstallprompt", makeEvent({ prompt: () => Promise.reject(new Error("NotAllowedError")) }))
  const { api, view } = renderHook({ onOutcome: (o) => reported.push(o) })

  assert.equal(await api.promptToInstall(), "unavailable")
  assert.deepEqual(reported, ["unavailable"], "閉じてもいない人に dismissed と記録してはいけない")
  view.unmount()
})

test("a prompt that throws instead of rejecting does not escape the press", async () => {
  resetCapture()
  dispatch("beforeinstallprompt", makeEvent({ prompt: () => { throw new Error("boom") } }))
  const { api, view } = renderHook()

  // The specification says prompt() returns a rejected promise, but a browser that throws outright
  // would otherwise leave `onClick` holding an unhandled rejection.
  assert.equal(await api.promptToInstall(), "unavailable")
  view.unmount()
})

test("earlyCaptureScript parks the event exactly where this module looks for it", () => {
  resetCapture()
  const scriptListeners = new Map()
  const fakeWindow = eventTarget(scriptListeners)

  // Run the snippet the way a <head> script would, against its own window.
  new Function("window", `return (function(){${earlyCaptureScript()}})()`)(fakeWindow)

  const event = makeEvent()
  scriptListeners.get("beforeinstallprompt").at(-1)(event)

  const store = fakeWindow[INSTALL_CAPTURE_KEY]
  assert.ok(store, "スニペットと本体は INSTALL_CAPTURE_KEY で待ち合わせる。綴り違いはどこにもエラーを出さない")
  assert.equal(store.event, event)
  assert.equal(event.prevented, 1)

  scriptListeners.get("appinstalled").at(-1)()
  assert.equal(store.event, null)
  assert.equal(store.installed, true)
})

test("earlyCaptureScript reuses a store that is already there rather than replacing it", () => {
  const existing = { event: "kept", installed: false }
  const fakeWindow = { ...eventTarget(new Map()), [INSTALL_CAPTURE_KEY]: existing }
  new Function("window", `return (function(){${earlyCaptureScript()}})()`)(fakeWindow)
  assert.equal(fakeWindow[INSTALL_CAPTURE_KEY], existing, "二度読み込まれても捕まえたイベントを捨てない")
})

test("the icons are hidden from assistive technology and the focus ring is focus-visible", () => {
  resetCapture()
  dispatch("beforeinstallprompt", makeEvent())
  const view = render(InstallPrompt, {})
  const button = byTag(walk(view.tree), "button")[0]

  assert.equal(button.props.type, "button", "周囲のフォームを送信しない")
  assert.match(button.props.className, /focus-visible:ring-2/)
  const decorative = walk(view.tree).filter((n) => n.props?.["aria-hidden"] === "true")
  assert.ok(decorative.length >= 1, "装飾アイコンは aria-hidden")
  view.unmount()
})

test("the hook offers the steps by default, so a caller gets them without asking", () => {
  resetCapture()
  setNavigator(IOS)
  const { api, view } = renderHook()
  assert.equal(api.status, "instructions")
  view.unmount()
})

test("a Macintosh with a single touch point is not an iPad", () => {
  resetCapture()
  setNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 1 })
  assert.equal(isIosLike(), false, "境界は 1 より大きいこと。1 は iPad の目印にならない")
})

test("entering an installed window updates the UI without a reload", () => {
  resetCapture()
  dispatch("beforeinstallprompt", makeEvent())
  const view = render(InstallPrompt, {})
  assert.equal(byTag(walk(view.tree), "button").length, 1)

  // Accepting the dialog in a desktop window changes the display mode on a document that is never
  // reloaded, so the media query has to be watched rather than sampled once at mount.
  matchingModes = new Set(["(display-mode: standalone)"])
  // Presence, not an exact count: the harness runs each effect on every settling pass without
  // running the previous cleanup, so identical listeners pile up. Zero is the failure that matters.
  const fired = fireMedia("(display-mode: standalone)")
  assert.ok(fired >= 1, "display-mode の change を購読していなければ、ここで誰も居ない")
  view.rerender()
  assert.equal(view.tree, null)

  view.unmount()
  assert.equal(mediaHandlerCount(), 0, "unmount で media のリスナーを外す")
})

test("an install seen once keeps the offer away, even if another event arrives", () => {
  resetCapture()
  dispatch("appinstalled")
  // The browser will not send another beforeinstallprompt for an app it has installed, but a stale
  // one already in flight must not bring the button back.
  dispatch("beforeinstallprompt", makeEvent())
  const { api, view } = renderHook()
  assert.equal(api.status, "installed")
  view.unmount()
})

test("a store created from scratch starts with nothing installed and nothing to install", () => {
  resetCapture()
  // Reaches the creation branch of `capture()` — the state a first-ever read has to produce.
  delete globalThis.window[INSTALL_CAPTURE_KEY]
  const { api, view } = renderHook()
  assert.equal(api.status, "unavailable")
  view.unmount()
  resetCapture()
})

test("the window listeners are attached once, however many times a component mounts", () => {
  resetCapture()
  for (let i = 0; i < 3; i++) render(InstallPrompt, {}).unmount()
  assert.equal(
    (windowListeners.get("beforeinstallprompt") ?? []).length,
    1,
    "一度きりの掛け金が外れると、マウントごとにリスナーが積み上がる"
  )
})

test("the server-side guards answer without a window or a navigator", () => {
  resetCapture()
  setNavigator(IOS)
  assert.equal(withoutGlobal("window", () => isRunningInstalled()), false)
  assert.equal(withoutGlobal("navigator", () => isIosLike()), false)

  // A browser with no matchMedia is not an installed app either.
  const saved = globalThis.window.matchMedia
  globalThis.window.matchMedia = undefined
  setNavigator({ userAgent: "node", maxTouchPoints: 0 })
  try {
    assert.equal(isRunningInstalled(), false)
  } finally {
    globalThis.window.matchMedia = saved
  }
})

test("the hook renders on the server, where there is no window to park anything on", () => {
  resetCapture()
  // Server-rendered first, which is the whole reason the initial state is the empty one. Reading
  // the parked event during render instead would be a hydration mismatch on every such page.
  const status = withoutGlobal("window", () => {
    const { api, view } = renderHook()
    const read = api.status
    view.unmount()
    return read
  })
  assert.equal(status, "unavailable")
})

test("a browser without matchMedia is handled rather than called anyway", () => {
  resetCapture()
  const saved = globalThis.window.matchMedia
  globalThis.window.matchMedia = undefined
  try {
    const { api, view } = renderHook()
    assert.equal(api.status, "unavailable", "matchMedia が無い環境でも落ちずに答える")
    view.unmount()
  } finally {
    globalThis.window.matchMedia = saved
  }
})
