// The most-installed component in this registry, and the one with the least to go wrong — which is
// exactly why it had no tests until now and why the thing that was wrong with it survived. The
// cases below are written against the specific wrong versions:
//
//   - leaving out `type="button"`, so a copy button inside a form submits it,
//   - announcing the result by swapping the icon, which no screen reader reports,
//   - leaving both icons in the accessibility tree, so something reads "check" out loud,
//   - treating the clipboard write as if it always succeeds,
//   - leaving the reset timer running after unmount,
//   - and attaching the copy to `onClick` *before* spreading the caller's props onto the same
//     element, so a caller who passes an `onClick` of their own — for analytics, for a toast —
//     silently replaces the copy with it. The button still looks right, still announces "Copied",
//     and the clipboard is never written. Every other button in this registry (share-button,
//     csv-export-button, print-button, fullscreen-button, geolocation-button) composes the two
//     instead, and this component's own description promises that "event handlers all pass
//     through", so the pass-through is the contract being tested here, not a preference.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// One stable component per icon name, tagged so the tree can be asked which one was drawn. A bare
// `() => null` for every name would make Check and Copy indistinguishable, which is the one thing
// these tests need to tell apart.
const iconCache = new Map()
const icons = new Proxy(
  {},
  {
    get: (_target, name) => {
      if (!iconCache.has(name)) {
        const Icon = () => null
        Icon.iconName = name
        iconCache.set(name, Icon)
      }
      return iconCache.get(name)
    },
  }
)

const { CopyButton } = loadComponent(join(ROOT, "registry", "ui", "copy-button.tsx"), {
  stubs: { "lucide-react": icons },
})

const VALUE = "npx shadcn@latest add https://pulld.pages.dev/r/copy-button.json"

/**
 * Installs the two globals the component reaches for and returns the recorders, so a test can say
 * what the clipboard does and then read back what was asked of it. `writeText` is the deferred
 * half: a test resolves or rejects it when it wants the outcome to land.
 */
function browser({ writeText } = {}) {
  const saved = {
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  }
  const calls = { writeText: [], timers: [], cleared: [] }
  let nextTimer = 1

  globalThis.window = {
    setTimeout: (fn, ms) => {
      calls.timers.push({ fn, ms, id: nextTimer })
      return nextTimer++
    },
    clearTimeout: (id) => calls.cleared.push(id),
  }
  Object.defineProperty(globalThis, "navigator", {
    value: {
      clipboard: {
        writeText: (value) => {
          calls.writeText.push(value)
          return writeText ? writeText(value) : Promise.resolve()
        },
      },
    },
    configurable: true,
    writable: true,
  })

  calls.restore = () => {
    globalThis.window = saved.window
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator)
    else delete globalThis.navigator
  }
  return calls
}

/** Presses the button the way a user would, and lets the clipboard promise settle. */
async function click(instance, event = {}) {
  const target = { ...event, defaultPrevented: false, preventDefault() {} }
  instance.tree.props.onClick(target)
  // Two turns: one for the clipboard promise, one for the handler chained onto it.
  await Promise.resolve()
  await Promise.resolve()
  instance.rerender()
  return target
}

/** The name on the control, the text in the live region, and which icon is drawn. */
function state(instance) {
  const nodes = walk(instance.tree)
  const live = byTag(nodes, "span").find((s) => s.props.className?.includes("sr-only"))
  const drawn = nodes.filter((n) => typeof n.type === "function" && n.type.iconName)
  return {
    label: instance.tree.props["aria-label"],
    live: live?.props.children ?? null,
    liveRegion: live?.props["aria-live"] ?? null,
    icons: drawn.map((n) => n.type.iconName),
    hidden: drawn.map((n) => n.props["aria-hidden"]),
  }
}

// --- the pass-through the spread was eating --------------------------------

test("the caller's own onClick runs beside the copy instead of replacing it", async () => {
  const calls = browser()
  const seen = []
  try {
    const r = render(CopyButton, { value: VALUE, onClick: (e) => seen.push(e) })
    await click(r)
    // The failure this pins: props are spread after the component's own handler, so an onClick
    // arriving through them wins outright. The analytics call fires, the user sees nothing wrong,
    // and the clipboard is never written.
    assert.equal(seen.length, 1, "the caller's handler did not run")
    assert.deepEqual(calls.writeText, [VALUE], "the caller's onClick replaced the copy")
    assert.equal(state(r).live, "Copied")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a caller who prevents the default takes the copy over rather than fighting it", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, {
      value: VALUE,
      onClick: (e) => e.preventDefault(),
    })
    const target = { defaultPrevented: false, preventDefault() { target.defaultPrevented = true } }
    r.tree.props.onClick(target)
    await Promise.resolve()
    r.rerender()
    assert.deepEqual(calls.writeText, [], "preventDefault did not stop the copy")
    assert.equal(state(r).live, "Copy", "the button claimed a copy it was told not to make")
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- the clipboard --------------------------------------------------------

test("the value is written to the clipboard and the tick replaces the clipboard icon", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    assert.deepEqual(state(r).icons, ["Copy"])
    await click(r)
    assert.deepEqual(calls.writeText, [VALUE])
    assert.deepEqual(state(r).icons, ["Check"])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a rejected write leaves the button resting instead of flashing a success it did not get", async () => {
  // What `writeText` does on an insecure origin, inside a sandboxed iframe, and when the document
  // is not focused — all three of which happen on somebody else's machine and not on the author's.
  const calls = browser({ writeText: () => Promise.reject(new Error("NotAllowedError")) })
  try {
    const r = render(CopyButton, { value: VALUE })
    await click(r)
    assert.deepEqual(calls.writeText, [VALUE])
    assert.deepEqual(state(r).icons, ["Copy"], "it showed a tick for a write that failed")
    assert.equal(state(r).live, "Copy")
    assert.deepEqual(calls.timers, [], "a reset was scheduled for a state never entered")
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- what a screen reader gets --------------------------------------------

test("the result is announced through a live region, not by swapping the icon", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    // Mounted holding its resting text before anything changes. A region inserted into the
    // document already holding its new text is not reliably announced.
    assert.equal(state(r).liveRegion, "polite")
    assert.equal(state(r).live, "Copy")
    await click(r)
    assert.equal(state(r).live, "Copied")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("both icons are hidden, so nothing reads 'check' out loud", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    assert.deepEqual(state(r).hidden, ["true"])
    await click(r)
    assert.deepEqual(state(r).hidden, ["true"])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the built-in name says what the button does, and the caller's own replaces it", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    assert.equal(state(r).label, "Copy to clipboard")
    await click(r)
    assert.equal(state(r).label, "Copied")

    const named = render(CopyButton, { value: VALUE, "aria-label": "Copy API key" })
    assert.equal(state(named).label, "Copy API key")
    await click(named)
    assert.equal(state(named).label, "Copy API key", "the caller's name was overwritten")
    assert.equal(state(named).live, "Copied", "the result stopped being announced")
    r.unmount()
    named.unmount()
  } finally {
    calls.restore()
  }
})

// --- the form, and the timer ----------------------------------------------

test("it is a type=button, so a copy button inside a form does not submit it", () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    assert.equal(r.tree.props.type, "button")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the tick goes back by itself, after the timeout the caller asked for", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE, timeout: 500 })
    await click(r)
    assert.equal(calls.timers.at(-1).ms, 500, "the default was used instead of the prop")
    calls.timers.at(-1).fn()
    r.rerender()
    assert.deepEqual(state(r).icons, ["Copy"])
    assert.equal(state(r).live, "Copy")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the reset timer is cleared on unmount, not left to fire on a dead component", async () => {
  const calls = browser()
  try {
    const r = render(CopyButton, { value: VALUE })
    await click(r)
    const scheduled = calls.timers.at(-1).id
    r.unmount()
    assert.ok(
      calls.cleared.includes(scheduled),
      "a button unmounted mid-countdown left its timer running"
    )
  } finally {
    calls.restore()
  }
})
