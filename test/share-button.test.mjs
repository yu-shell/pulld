// A share button is a component whose failures all happen on somebody else's device. It works on
// the phone it was written on, and then a desktop Firefox user gets nothing at all, a user who
// closed the sheet gets an error, and the version that fetches a short link first stops working in
// production only. So the cases below are written against those specific wrong versions:
//
//   - assuming `navigator.share` exists, so the click throws where it does not,
//   - ...and the half-fix that checks `share` but ignores `canShare` rejecting the payload,
//   - awaiting anything before calling `share`, which spends the user gesture and rejects
//     with NotAllowedError on a button that worked in development,
//   - catching `AbortError` as a failure, so closing the sheet reports "Sharing failed",
//   - treating a genuine rejection as fatal instead of falling back to the clipboard,
//   - reading the page URL at render, so a client-routed page shares the URL it was mounted on,
//   - feature-detecting during render, which makes the server and the client disagree,
//   - announcing the result by swapping the icon, which no screen reader reports,
//   - leaving out `type="button"`, so a share button inside a form submits it,
//   - leaving the reset timer running after unmount.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const { ShareButton } = loadComponent(join(ROOT, "registry", "ui", "share-button.tsx"), {
  stubs: { "lucide-react": icons },
})

const PAGE = "https://example.com/posts/hello"

/**
 * Installs the two globals the component reaches for and returns the recorders, so a test can say
 * what the browser supports and then read back what was asked of it. `share` and `writeText` are
 * the deferred halves: a test resolves or rejects them when it wants the outcome to land.
 */
function browser({ share, canShare, writeText } = {}) {
  const saved = {
    window: globalThis.window,
    navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
  }
  const calls = { share: [], writeText: [], timers: [], cleared: [] }
  let nextTimer = 1

  globalThis.window = {
    location: { href: PAGE },
    setTimeout: (fn, ms) => {
      calls.timers.push({ fn, ms, id: nextTimer })
      return nextTimer++
    },
    clearTimeout: (id) => calls.cleared.push(id),
  }

  const nav = {}
  if (share) {
    nav.share = (data) => {
      calls.share.push(data)
      return share(data)
    }
  }
  if (canShare) {
    nav.canShare = (data) => canShare(data)
  }
  nav.clipboard = {
    writeText: (value) => {
      calls.writeText.push(value)
      return writeText ? writeText(value) : Promise.resolve()
    },
  }
  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true })

  calls.restore = () => {
    globalThis.window = saved.window
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator)
    else delete globalThis.navigator
  }
  return calls
}

/** Presses the button the way a user would, and lets any promise it started settle. */
async function click(instance, event = {}) {
  const target = { ...event, defaultPrevented: false, preventDefault() {} }
  instance.tree.props.onClick(target)
  // Two turns: one for the share/clipboard promise, one for the handler chained onto it.
  await Promise.resolve()
  await Promise.resolve()
  instance.rerender()
  return target
}

/** The two pieces of text the button carries: what is announced, and what is drawn. */
function text(instance) {
  const spans = byTag(walk(instance.tree), "span")
  const live = spans.find((s) => s.props.className?.includes("sr-only"))
  const visible = spans.find((s) => s !== live)
  return { live: live?.props.children ?? null, visible: visible?.props.children ?? null }
}

// --- the half that only breaks elsewhere -----------------------------------

test("a browser with no share sheet copies the link instead of throwing", async () => {
  const calls = browser() // no navigator.share at all: desktop Firefox, or any insecure origin
  try {
    const r = render(ShareButton, { url: PAGE })
    await click(r)
    assert.deepEqual(calls.writeText, [PAGE])
    assert.equal(text(r).visible, "Link copied")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a payload canShare rejects falls back too, rather than calling share anyway", async () => {
  const calls = browser({
    share: () => Promise.resolve(),
    canShare: () => false,
  })
  try {
    const r = render(ShareButton, { url: PAGE })
    await click(r)
    assert.deepEqual(calls.share, [], "share was called on a payload the browser had refused")
    assert.deepEqual(calls.writeText, [PAGE])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a browser that has share but no canShare is not treated as unsupported", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, { url: PAGE })
    await click(r)
    assert.equal(calls.share.length, 1)
    assert.deepEqual(calls.writeText, [], "it copied instead of using the sheet it had")
    assert.equal(text(r).visible, "Shared")
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- the user gesture ------------------------------------------------------

test("share is called during the click itself, not after an await", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, { url: PAGE })
    const target = { defaultPrevented: false, preventDefault() {} }
    r.tree.props.onClick(target)
    // Nothing has been awaited yet. A version that resolved the URL, hit an API, or simply
    // `await`ed one tick before sharing would still have an empty list here — and would reject
    // with NotAllowedError in a real browser, where the gesture is already spent.
    assert.equal(calls.share.length, 1, "share was not called synchronously within the handler")
    await Promise.resolve()
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- cancel is not a failure -----------------------------------------------

test("closing the share sheet says nothing at all", async () => {
  const abort = Object.assign(new Error("Share canceled"), { name: "AbortError" })
  const calls = browser({ share: () => Promise.reject(abort) })
  const outcomes = []
  try {
    const r = render(ShareButton, { url: PAGE, onShare: (o) => outcomes.push(o) })
    await click(r)
    assert.deepEqual(outcomes, ["cancelled"])
    assert.equal(text(r).live, null, "a dismissed sheet announced something")
    assert.equal(text(r).visible, "Share", "a dismissed sheet left an error on the button")
    assert.deepEqual(calls.writeText, [], "a deliberate cancel was 'recovered' by copying")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a real share failure falls back to the clipboard", async () => {
  const calls = browser({
    share: () => Promise.reject(Object.assign(new Error("nope"), { name: "NotAllowedError" })),
  })
  const outcomes = []
  try {
    const r = render(ShareButton, { url: PAGE, onShare: (o) => outcomes.push(o) })
    await click(r)
    assert.deepEqual(calls.writeText, [PAGE])
    assert.deepEqual(outcomes, ["copied"])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a clipboard that also refuses says so instead of claiming success", async () => {
  const calls = browser({ writeText: () => Promise.reject(new Error("denied")) })
  const outcomes = []
  try {
    const r = render(ShareButton, { url: PAGE, onShare: (o) => outcomes.push(o) })
    await click(r)
    assert.deepEqual(outcomes, ["failed"])
    assert.equal(text(r).live, "Could not share")
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- what gets shared ------------------------------------------------------

test("the default URL is read when pressed, not when mounted", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, {})
    // The kind of thing a client-side route change does between mount and click.
    globalThis.window.location.href = "https://example.com/posts/second"
    await click(r)
    assert.deepEqual(calls.share, [{ url: "https://example.com/posts/second" }])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("title and text reach the sheet, and absent ones are left out of the payload", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, { url: PAGE, shareTitle: "Hello" })
    await click(r)
    assert.deepEqual(calls.share, [{ url: PAGE, title: "Hello" }])
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("a caller that prevents the default click is obeyed", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, {
      url: PAGE,
      onClick: (event) => {
        event.defaultPrevented = true
      },
    })
    await click(r)
    assert.deepEqual(calls.share, [])
    assert.deepEqual(calls.writeText, [])
    r.unmount()
  } finally {
    calls.restore()
  }
})

// --- the button itself -----------------------------------------------------

test("it is a button that does not submit the form around it", () => {
  const calls = browser()
  try {
    const r = render(ShareButton, { url: PAGE })
    assert.equal(r.tree.type, "button")
    assert.equal(r.tree.props.type, "button")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the render is the same whatever the browser supports, so hydration matches", () => {
  const withSheet = browser({ share: () => Promise.resolve() })
  let supported
  try {
    const r = render(ShareButton, { url: PAGE })
    supported = JSON.stringify(text(r))
    r.unmount()
  } finally {
    withSheet.restore()
  }
  const without = browser()
  try {
    const r = render(ShareButton, { url: PAGE })
    assert.equal(JSON.stringify(text(r)), supported)
    r.unmount()
  } finally {
    without.restore()
  }
})

test("the result is announced in a live region, not by the icon", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, { url: PAGE })
    const live = byTag(walk(r.tree), "span").find((s) => s.props.className?.includes("sr-only"))
    assert.equal(live.props["aria-live"], "polite")
    await click(r)
    assert.equal(text(r).live, "Shared")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the icons are hidden from screen readers", () => {
  const calls = browser()
  try {
    const r = render(ShareButton, { url: PAGE })
    const rendered = walk(r.tree).filter((n) => typeof n.type === "function")
    assert.ok(rendered.length > 0, "no icon was rendered")
    for (const icon of rendered) assert.equal(String(icon.props["aria-hidden"]), "true")
    r.unmount()
  } finally {
    calls.restore()
  }
})

test("the reset timer is cleared on unmount", async () => {
  const calls = browser({ share: () => Promise.resolve() })
  try {
    const r = render(ShareButton, { url: PAGE })
    await click(r)
    assert.equal(calls.timers.length, 1, "no reset was scheduled after a successful share")
    r.unmount()
    assert.deepEqual(calls.cleared, [calls.timers[0].id])
  } finally {
    calls.restore()
  }
})
