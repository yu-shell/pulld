// The naive version of this component is `localStorage.setItem` in an onChange and `getItem` in a
// useState initialiser, and almost everything that makes it usable is in what those two lines get
// wrong. So the cases below are written to pass against the shipped implementation and fail against
// the versions that look right:
//
//   - a read in the useState initialiser (the server has no localStorage, and the client's first
//     render then disagrees with the HTML it is hydrating),
//   - a draft offered forever because the submit path forgot to clear it,
//   - a write on every keystroke, with no settling,
//   - a debounce with nothing flushing it, so closing the tab mid-sentence loses the sentence,
//   - a flush on `beforeunload` only, which never fires on a backgrounded mobile tab,
//   - no expiry, so a draft from six months ago is still offered,
//   - no version, so an old draft is restored into fields that have since moved,
//   - a key with no user in it, so the next account on the browser is offered the last one's text,
//   - a "the form matches the baseline, delete the draft" prune that runs on the first commit —
//     when the form always matches the baseline — and so deletes the draft it was about to offer,
//   - an `isEmpty` prop listed as an effect dependency, which restarts the debounce on every
//     render and therefore never finishes one,
//   - a live region rendered only once it has something to say, which is too late to say it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })
const timeAgo = { TimeAgo: (props) => ({ type: "time", props }) }

const { useDraft, DraftRestore } = loadComponent(join(ROOT, "registry", "ui", "draft-restore.tsx"), {
  stubs: { "lucide-react": icons, "@/registry/ui/time-ago": timeAgo },
})

// --- a browser small enough to hold the parts this component touches -------------------------
const windowListeners = new Map()
const documentListeners = new Map()

const eventTarget = (store) => ({
  addEventListener(type, fn) {
    if (!store.has(type)) store.set(type, [])
    store.get(type).push(fn)
  },
  removeEventListener(type, fn) {
    store.set(type, (store.get(type) ?? []).filter((registered) => registered !== fn))
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
  reads: [],
  writes: [],
  removals: [],
  throwOnRead: false,
  throwOnWrite: false,
  getItem(key) {
    storage.reads.push(key)
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
globalThis.document = { ...eventTarget(documentListeners), visibilityState: "visible" }

// --- a clock the test owns -------------------------------------------------------------------
let now = 1_700_000_000_000
const timers = new Map()
let nextTimerId = 1

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
Date.now = () => now
globalThis.setTimeout = (fn, ms) => {
  const id = nextTimerId++
  timers.set(id, { fn, at: now + (Number(ms) || 0) })
  return id
}
globalThis.clearTimeout = (id) => timers.delete(id)

function advance(ms) {
  const target = now + ms
  for (let guard = 0; guard < 10_000; guard++) {
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

const DAY = 24 * 60 * 60 * 1000

function reset() {
  windowListeners.clear()
  documentListeners.clear()
  cell.clear()
  storage.reads.length = 0
  storage.writes.length = 0
  storage.removals.length = 0
  storage.throwOnRead = false
  storage.throwOnWrite = false
  storage.throwOnGetter = false
  timers.clear()
  now = 1_700_000_000_000
  document.visibilityState = "visible"
}

/** A draft already in storage, as the component writes it. */
function seed(key, value, { at = now, ver = "1" } = {}) {
  cell.set(key, JSON.stringify({ v: value, at, ver }))
}

const stored = (key) => (cell.has(key) ? JSON.parse(cell.get(key)) : null)

// --- a probe that exercises the hook ----------------------------------------------------------
// Records what the hook answered on every render pass, alongside how many reads had happened by
// then, which is how "nothing is read during render" is asserted rather than argued.
let passes = []
let latest = null

function Probe(options) {
  const draft = useDraft(options)
  passes.push({ reads: storage.reads.length, pending: draft.pending })
  latest = draft
  return null
}

function mount(options) {
  passes = []
  latest = null
  const instance = render(Probe, options)
  return instance
}

// --- the read: what is offered, and what is thrown away instead -------------------------------

test("a saved draft is offered back, and not before the component has mounted", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  mount({ id: "comment", value: "" })

  // The first pass is the one that has to agree with the server's HTML. A read in a useState
  // initialiser puts the draft in that pass and makes the markup differ from what was hydrated.
  assert.equal(passes[0].pending, null)
  assert.equal(passes[0].reads, 0)

  assert.deepEqual(latest.pending, { value: "half a thought", savedAt: now })
})

test("a draft equal to what the form already shows is deleted rather than offered", () => {
  // This is the forgotten clear(): the article was edited, saved successfully, and the draft was
  // left behind. The server now hands back the very text the draft holds, so there is nothing to
  // restore — and continuing to offer it is the "restore?" prompt that haunts people.
  reset()
  seed("pulld-draft:article", "the published text")
  mount({ id: "article", value: "the published text" })

  assert.equal(latest.pending, null)
  assert.deepEqual(storage.removals, ["pulld-draft:article"])
})

test("a draft older than maxAge is deleted rather than offered", () => {
  reset()
  seed("pulld-draft:comment", "from last month", { at: now - 30 * DAY })
  mount({ id: "comment", value: "" })

  assert.equal(latest.pending, null)
  assert.deepEqual(storage.removals, ["pulld-draft:comment"])
})

test("a draft exactly at maxAge is still offered; one past it is not", () => {
  reset()
  seed("pulld-draft:a", "edge", { at: now - 7 * DAY })
  mount({ id: "a", value: "" })
  assert.equal(latest.pending.value, "edge")

  reset()
  seed("pulld-draft:a", "edge", { at: now - 7 * DAY - 1 })
  mount({ id: "a", value: "" })
  assert.equal(latest.pending, null)
})

test("a draft written against another version of the form is dropped", () => {
  reset()
  seed("pulld-draft:signup", { email: "a@b.c" }, { ver: "1" })
  mount({ id: "signup", value: {}, version: 2 })

  assert.equal(latest.pending, null)
  assert.deepEqual(storage.removals, ["pulld-draft:signup"])
})

test("unreadable storage is cleaned out instead of crashing the form", () => {
  reset()
  cell.set("pulld-draft:comment", "{ not json")
  mount({ id: "comment", value: "" })

  assert.equal(latest.pending, null)
  assert.deepEqual(storage.removals, ["pulld-draft:comment"])
})

test("a record with no timestamp is not trusted", () => {
  reset()
  cell.set("pulld-draft:comment", JSON.stringify({ v: "x", ver: "1" }))
  mount({ id: "comment", value: "" })

  assert.equal(latest.pending, null)
})

test("scope keys the draft per account, so the next person to sign in is not offered it", () => {
  reset()
  seed("pulld-draft:u1:comment", "mine")
  mount({ id: "comment", value: "", scope: "u1" })
  assert.equal(latest.pending.value, "mine")

  reset()
  seed("pulld-draft:u1:comment", "mine")
  mount({ id: "comment", value: "", scope: "u2" })
  assert.equal(latest.pending, null, "a draft under another scope must not be reachable")
  assert.deepEqual(storage.removals, [], "and must not be deleted either — it is not ours")
})

test("a blocked storage leaves the form working", () => {
  reset()
  storage.throwOnRead = true
  storage.throwOnWrite = true
  mount({ id: "comment", value: "typing" })
  advance(1000)

  assert.equal(latest.pending, null)
})

// --- the write: when, and when not ------------------------------------------------------------

test("nothing is written until typing settles", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })

  instance.update({ id: "comment", value: "h" })
  instance.update({ id: "comment", value: "he" })
  instance.update({ id: "comment", value: "hel" })
  assert.deepEqual(storage.writes, [], "a write per keystroke is a synchronous write per keystroke")

  advance(100)
  assert.deepEqual(storage.writes, [], "and the default delay is a delay, not zero")

  advance(400)
  assert.equal(stored("pulld-draft:comment").v, "hel")
})

test("the draft that is being offered is not deleted by the first commit", () => {
  // The prune is "the form shows what it started with, so there is nothing to keep" — and on the
  // first commit the form always shows what it started with. A prune without the guard deletes the
  // draft it is in the middle of offering, and the offer dies on reload.
  reset()
  seed("pulld-draft:article", "unsent edit")
  mount({ id: "article", value: "the published text" })
  advance(5000)

  assert.equal(latest.pending.value, "unsent edit")
  assert.equal(stored("pulld-draft:article").v, "unsent edit", "still there to be offered again")
  assert.deepEqual(storage.removals, [])
})

test("typing back to the baseline deletes the draft", () => {
  reset()
  const instance = mount({ id: "article", value: "published" })

  instance.update({ id: "article", value: "published and then some" })
  advance(500)
  assert.equal(stored("pulld-draft:article").v, "published and then some")

  instance.update({ id: "article", value: "published" })
  advance(500)
  assert.equal(stored("pulld-draft:article"), null, "the user undid their way back; keep nothing")
})

test("an empty form is not saved", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })
  instance.update({ id: "comment", value: "   " })
  advance(500)

  assert.deepEqual(storage.writes, [])
})

test("a value that went null or undefined is nothing to save", () => {
  // A field that has been cleared can arrive as either, and neither is a draft.
  for (const emptied of [null, undefined]) {
    reset()
    const instance = mount({ id: "comment", value: "" })
    instance.update({ id: "comment", value: emptied })
    advance(500)

    assert.deepEqual(storage.writes, [], `${String(emptied)} was saved as a draft`)
  }
})

test("a list emptied back out deletes the draft rather than saving the empty list", () => {
  reset()
  const instance = mount({ id: "tags", value: [] })

  instance.update({ id: "tags", value: ["urgent"] })
  advance(500)
  assert.deepEqual(stored("pulld-draft:tags").v, ["urgent"])

  instance.update({ id: "tags", value: [] })
  advance(500)
  assert.equal(stored("pulld-draft:tags"), null)
})

// A re-render that changed nothing must not restart the debounce. Both cases below let the clock
// run between the re-renders, because a version that does restart it still writes if every render
// happens before any time passes — and then the test would pass against the bug it is here for.

test("a whole-form object value, rebuilt on every render, is still saved", () => {
  // `value={{ title, body }}` is a new object every render. Keyed on the value itself, the debounce
  // is restarted by every render — and a controlled form re-renders on every keystroke, so a form
  // being typed into never reaches the end of a single delay and nothing is ever written.
  reset()
  const instance = mount({ id: "doc", value: { title: "", body: "" } })

  instance.update({ id: "doc", value: { title: "t", body: "b" } })
  advance(300)
  instance.update({ id: "doc", value: { title: "t", body: "b" } })
  advance(300)

  assert.deepEqual(stored("pulld-draft:doc")?.v, { title: "t", body: "b" })
})

test("a custom isEmpty written inline still reaches the end of a debounce", () => {
  // Listing `isEmpty` as a dependency looks harmless and is not: it arrives as a new function on
  // every render, so the timer is cleared and restarted by renders that changed nothing.
  reset()
  const value = { title: "t" }
  const instance = mount({ id: "doc", value: { title: "" }, isEmpty: (v) => !v.title })

  instance.update({ id: "doc", value, isEmpty: (v) => !v.title })
  advance(300)
  instance.update({ id: "doc", value, isEmpty: (v) => !v.title })
  advance(300)

  assert.deepEqual(stored("pulld-draft:doc")?.v, { title: "t" })
})

test("an object value that changed content is saved as the new content", () => {
  reset()
  const instance = mount({ id: "doc", value: { title: "t" } })
  instance.update({ id: "doc", value: { title: "t2" } })
  advance(500)

  assert.deepEqual(stored("pulld-draft:doc").v, { title: "t2" })
})

test("a value JSON cannot carry is skipped rather than throwing", () => {
  reset()
  const cyclic = {}
  cyclic.self = cyclic
  mount({ id: "doc", value: cyclic })
  advance(500)

  assert.deepEqual(storage.writes, [])
})

test("enabled: false neither reads nor writes", () => {
  reset()
  seed("pulld-draft:comment", "there")
  const instance = mount({ id: "comment", value: "", enabled: false })
  instance.update({ id: "comment", value: "typing", enabled: false })
  advance(500)

  assert.equal(latest.pending, null)
  assert.deepEqual(storage.reads, [])
  assert.deepEqual(storage.writes, [])
})

// --- the flush: the characters typed inside the last delay ------------------------------------

test("closing the tab inside the debounce window still saves what was typed", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })
  instance.update({ id: "comment", value: "the last sentence" })

  assert.deepEqual(storage.writes, [], "still inside the window")
  dispatch(windowListeners, "pagehide", {})

  assert.equal(stored("pulld-draft:comment").v, "the last sentence")
})

test("a backgrounded tab saves too, which is the only signal a phone gives", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })
  instance.update({ id: "comment", value: "typed on a phone" })

  document.visibilityState = "hidden"
  dispatch(documentListeners, "visibilitychange", {})

  assert.equal(stored("pulld-draft:comment").v, "typed on a phone")
})

test("becoming visible again is not a reason to write", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })
  instance.update({ id: "comment", value: "x" })

  document.visibilityState = "visible"
  dispatch(documentListeners, "visibilitychange", {})

  assert.deepEqual(storage.writes, [])
})

test("flush() writes the current value without waiting", () => {
  reset()
  const instance = mount({ id: "comment", value: "" })
  instance.update({ id: "comment", value: "now please" })
  latest.flush()

  assert.equal(stored("pulld-draft:comment").v, "now please")
})

// --- answering the offer ----------------------------------------------------------------------

test("restore hands the saved value back and stands the offer down", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const restored = []
  const instance = mount({ id: "comment", value: "", onRestore: (v) => restored.push(v) })

  latest.restore()
  instance.rerender()

  assert.deepEqual(restored, ["half a thought"])
  assert.equal(latest.pending, null)
})

test("restore keeps the stored copy, because restoring is not submitting", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const instance = mount({ id: "comment", value: "" })

  latest.restore()
  instance.rerender()

  assert.equal(stored("pulld-draft:comment").v, "half a thought")
})

test("clear cancels a save that was already on its way", () => {
  // The submit landed inside the debounce window, which is the common case for anything sent with
  // a keyboard shortcut. A pending timer left running writes the draft back a few hundred
  // milliseconds after it was cleared, and the next visit offers to restore work already sent —
  // the exact haunting this component exists to prevent, reintroduced at the last moment.
  //
  // Mounted straight onto the typed value rather than updated into it, because the harness keeps no
  // effect cleanups between updates: a real commit clears the previous timer before setting the
  // next, and here they pile up, so a second timer nothing cancelled would hide the bug.
  reset()
  mount({ id: "comment", value: "sent with cmd-enter", baseline: "" })

  latest.clear()
  advance(500)

  assert.equal(stored("pulld-draft:comment"), null)
  assert.deepEqual(storage.writes, [])
})

test("a draft discarded here is not offered again for the life of the mount", () => {
  reset()
  seed("pulld-draft:article", "unsent edit")
  const instance = mount({ id: "article", value: "", baseline: "" })

  latest.clear()
  // Something puts a draft back under the same key — this tab's own debounce in a version that
  // forgot to cancel it, or another tab still editing.
  seed("pulld-draft:article", "unsent edit")
  instance.update({ id: "article", value: "", baseline: "fetched text" })

  assert.equal(latest.pending, null)
})

test("unmounting leaves nothing behind that can still write", () => {
  // Three listeners and a timer, each set up in its own effect and so each with its own cleanup to
  // get wrong. Anything that outlives the form acts on behalf of a component that is gone.
  // Mounted straight onto the typed value so exactly one timer is outstanding — see the note on
  // clear() above.
  reset()
  const instance = mount({ id: "comment", value: "typed", baseline: "" })
  instance.unmount()
  storage.writes.length = 0

  for (const [store, type] of [
    [windowListeners, "pagehide"],
    [documentListeners, "visibilitychange"],
    [windowListeners, "storage"],
  ]) {
    assert.deepEqual(store.get(type) ?? [], [], `a ${type} listener outlived the form`)
  }

  document.visibilityState = "hidden"
  dispatch(windowListeners, "pagehide", {})
  dispatch(documentListeners, "visibilitychange", {})
  advance(500)

  assert.deepEqual(storage.writes, [], "a save was still queued when the form went away")
})

test("clear deletes the draft and stands the offer down", () => {
  reset()
  seed("pulld-draft:comment", "sent already")
  const instance = mount({ id: "comment", value: "" })

  latest.clear()
  instance.rerender()

  assert.equal(latest.pending, null)
  assert.equal(stored("pulld-draft:comment"), null)
})

test("an answered offer is not raised again when a late baseline arrives", () => {
  // An edit form whose data comes from a fetch gets its baseline after mount, which re-runs the
  // read. The answer is tested with restore rather than clear, because clear empties the cell as
  // well and an empty cell would pass this on its own: after a restore the draft is still sitting
  // in storage, so only the guard keeps it from being offered a second time.
  reset()
  seed("pulld-draft:article", "unsent edit")
  const instance = mount({ id: "article", value: "", baseline: "" })
  assert.equal(latest.pending.value, "unsent edit")

  latest.restore()
  instance.update({ id: "article", value: "unsent edit", baseline: "fetched text" })

  assert.ok(stored("pulld-draft:article"), "the draft is still there to be re-offered")
  assert.equal(latest.pending, null, "but it has been answered")
})

test("a baseline arriving after mount still drops a draft that matches it", () => {
  reset()
  seed("pulld-draft:article", "fetched text")
  const instance = mount({ id: "article", value: "", baseline: "" })
  assert.equal(latest.pending.value, "fetched text", "nothing to compare against yet")

  instance.update({ id: "article", value: "fetched text", baseline: "fetched text" })

  assert.equal(latest.pending, null)
  assert.ok(storage.removals.includes("pulld-draft:article"))
})

// --- two tabs ---------------------------------------------------------------------------------

// A `storage` event is the consequence of another tab having already changed the shared cell, so
// these move the cell too. An event alone, with the draft still sitting there, is a state no
// browser produces — and testing against it would pin behaviour that cannot happen.
function otherTabRemoves(key) {
  cell.delete(key)
  dispatch(windowListeners, "storage", { key, newValue: null })
}

test("another tab submitting the form takes this tab's offer down", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const instance = mount({ id: "comment", value: "" })
  assert.ok(latest.pending)

  otherTabRemoves("pulld-draft:comment")
  instance.rerender()

  assert.equal(latest.pending, null)
})

test("another tab saving a newer draft does not take the offer down", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const instance = mount({ id: "comment", value: "" })

  const newer = JSON.stringify({ v: "newer", at: now, ver: "1" })
  cell.set("pulld-draft:comment", newer)
  dispatch(windowListeners, "storage", { key: "pulld-draft:comment", newValue: newer })
  instance.rerender()

  assert.ok(latest.pending, "only a removal means the work is gone")
})

test("a storage event for some other key is ignored", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const instance = mount({ id: "comment", value: "" })

  cell.delete("theme")
  dispatch(windowListeners, "storage", { key: "theme", newValue: null })
  instance.rerender()

  assert.ok(latest.pending)
})

test("storage.clear() in another tab takes the offer down", () => {
  reset()
  seed("pulld-draft:comment", "half a thought")
  const instance = mount({ id: "comment", value: "" })

  cell.clear()
  dispatch(windowListeners, "storage", { key: null, newValue: null })
  instance.rerender()

  assert.equal(latest.pending, null)
})

// --- the notice -------------------------------------------------------------------------------

const fakeDraft = (pending) => {
  const calls = []
  return {
    pending,
    restore: () => calls.push("restore"),
    clear: () => calls.push("clear"),
    flush: () => {},
    storageKey: "pulld-draft:x",
    calls,
  }
}

test("the live region is mounted before it has anything to say", () => {
  // A region that mounts at the same moment as its text is registered too late to announce it, and
  // this notice only ever appears after mount — so rendering the whole thing conditionally would
  // mean it is never announced at all.
  const instance = render(DraftRestore, { draft: fakeDraft(null) })
  const regions = walk(instance.tree).filter((n) => n.props?.role === "status")

  assert.equal(regions.length, 1)
  assert.equal(regions[0].props["aria-live"], "polite")
  assert.ok(String(regions[0].props.className).includes("sr-only"))
})

test("with nothing to show, the notice has no chrome and no caller spacing", () => {
  // `className` is where spacing is passed, and a margin left on while there is nothing to show
  // holds a gap open above every form that has no draft.
  const instance = render(DraftRestore, { draft: fakeDraft(null), className: "mb-4" })

  assert.equal(instance.tree.props.className, "")
  assert.deepEqual(byTag(walk(instance.tree), "button"), [])
})

test("with a draft, the notice says when it was saved and offers both ways out", () => {
  const instance = render(DraftRestore, {
    draft: fakeDraft({ value: "x", savedAt: now }),
    className: "mb-4",
  })
  const nodes = walk(instance.tree)
  const buttons = byTag(nodes, "button")

  assert.equal(buttons.length, 2)
  assert.deepEqual(
    buttons.map((b) => b.props.children),
    ["Restore", "Discard"]
  )
  for (const button of buttons) {
    assert.equal(button.props.type, "button", "a bare button in a form submits it")
    assert.ok(String(button.props.className).includes("focus-visible:ring"))
  }
  assert.ok(instance.tree.props.className.includes("mb-4"))
  assert.equal(nodes.filter((n) => n.type === "time").length, 1, "the timestamp is composed")

  const hidden = nodes.filter((n) => n.props?.["aria-hidden"] !== undefined)
  assert.equal(hidden.length, 1, "one decorative thing: the icon")
  assert.equal(hidden[0].props["aria-hidden"], "true", "an icon read out as its name is noise")
})

test("the timestamp is outside the live region, so it is not announced every minute", () => {
  const instance = render(DraftRestore, { draft: fakeDraft({ value: "x", savedAt: now }) })
  const region = walk(instance.tree).find((n) => n.props?.role === "status")

  assert.ok(region, "the region is there")
  const inRegion = walk(region.props.children)
  assert.equal(inRegion.filter((n) => n.type === "button").length, 0, "no controls inside it")
})

test("the buttons answer the offer, and tell the caller", () => {
  const events = []
  const draft = fakeDraft({ value: "x", savedAt: now })
  const instance = render(DraftRestore, {
    draft,
    onRestore: () => events.push("onRestore"),
    onDiscard: () => events.push("onDiscard"),
  })
  const [restoreButton, discardButton] = byTag(walk(instance.tree), "button")

  restoreButton.props.onClick()
  discardButton.props.onClick()

  assert.deepEqual(draft.calls, ["restore", "clear"], "Discard forgets the draft, it does not hide it")
  assert.deepEqual(events, ["onRestore", "onDiscard"])
})

test("every label can be translated", () => {
  const instance = render(DraftRestore, {
    draft: fakeDraft({ value: "x", savedAt: now }),
    label: "下書きが残っています",
    restoreLabel: "復元",
    discardLabel: "破棄",
  })
  const nodes = walk(instance.tree)

  assert.deepEqual(
    byTag(nodes, "button").map((b) => b.props.children),
    ["復元", "破棄"]
  )
  assert.ok(
    nodes.some((n) => n.props?.children === "下書きが残っています"),
    "the message is the caller's too"
  )
})

test.after(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
})
