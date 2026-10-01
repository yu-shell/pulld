// The shortcut recorder everyone writes first saves `event.key`, commits on the first keydown it
// sees, and listens on the element. Each of those looks finished the moment you press ⌘K into it.
// The cases below are written to fail against them:
//
//   - `event.key` as the identity, so `Shift+/` is saved as "?" and never matches again,
//   - committing on a modifier, so no combination containing Shift can be recorded at all,
//   - committing on auto-repeat, so leaning on a key records it,
//   - a literal ⌘ in storage, so a setting recorded on a Mac is a different setting on Windows,
//   - a bubble-phase listener on the element, so the app's own hotkey fires mid-recording,
//   - capturing Tab, so the field is a keyboard dead end,
//   - saving ⌘W, which closes the tab with the user's work in it every time they use it,
//   - and keeping held-modifier state across a window blur, where the keyup never arrives.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  MODIFIER_CODES,
  DEFAULT_RESERVED,
  isModifierPress,
  heldModifiers,
  hasModifier,
  physicalModifiers,
  shortcutFromEvent,
  matchesShortcut,
  sameShortcut,
  labelForCode,
  shortcutTokens,
  tokenForm,
  formatShortcut,
  reservedMatch,
  defaultShortcutRecorderLabels,
  ShortcutRecorder,
} = loadComponent(join(ROOT, "registry", "ui", "shortcut-recorder.tsx"), {
  stubs: {
    "@/registry/ui/kbd": {
      Kbd: function Kbd(props) {
        return { type: "kbd", props: { "data-cap": "", ...props } }
      },
    },
  },
})

const APPLE = { apple: true }
const OTHER = { apple: false }

/** A keydown as the browser delivers it, with the two calls a handler can make recorded. */
function press(fields = {}) {
  const e = {
    code: "KeyK",
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    prevented: 0,
    stopped: 0,
    ...fields,
  }
  e.preventDefault = () => {
    e.prevented += 1
  }
  e.stopPropagation = () => {
    e.stopped += 1
  }
  return e
}

// --- what gets stored -----------------------------------------------------------------------------

test("the physical key is stored, not the character the modifier produced", () => {
  // The press that breaks a key-based recorder: the same key reports "?" now and "/" at match time.
  const recorded = shortcutFromEvent(press({ code: "Slash", key: "?", shiftKey: true }), APPLE)
  assert.equal(recorded.code, "Slash")
  assert.equal(recorded.shift, true)
  // The shifted character is not kept as the label either — it is not what is printed on the key.
  assert.equal(recorded.label, undefined)
  assert.ok(matchesShortcut(press({ code: "Slash", key: "?", shiftKey: true }), recorded, APPLE))
})

test("Option on a Mac turns the character into a dead key, so no label is taken from it", () => {
  const recorded = shortcutFromEvent(press({ code: "KeyN", key: "˜", altKey: true }), APPLE)
  assert.equal(recorded.code, "KeyN")
  assert.equal(recorded.label, undefined)
  assert.deepEqual(shortcutTokens(recorded, APPLE), ["Alt", "N"])
})

test("an unmodified press keeps the character as a label, so a non-US layout shows its own key", () => {
  // AZERTY: the key printed A sits where a US keyboard has Q.
  const recorded = shortcutFromEvent(press({ code: "KeyQ", key: "a" }), OTHER)
  assert.equal(recorded.code, "KeyQ")
  assert.equal(recorded.label, "A")
  assert.deepEqual(shortcutTokens(recorded, OTHER), ["A"])
  // The label is for the eye only: matching still goes by the physical key.
  assert.ok(matchesShortcut(press({ code: "KeyQ", key: "a" }), recorded, OTHER))
  assert.ok(!matchesShortcut(press({ code: "KeyA", key: "q" }), recorded, OTHER))
})

test("a modifier on its own is not a combination", () => {
  for (const code of ["ShiftLeft", "ControlRight", "AltLeft", "MetaLeft", "CapsLock"]) {
    assert.ok(MODIFIER_CODES.has(code), code)
    assert.equal(shortcutFromEvent(press({ code, key: "Shift", shiftKey: true }), APPLE), null)
  }
})

test("a modifier is recognised from the key when the event reports no code", () => {
  assert.ok(isModifierPress({ code: "", key: "Meta" }))
  assert.ok(!isModifierPress({ code: "KeyK", key: "k" }))
})

test("auto-repeat does not commit — leaning on a key is not choosing it", () => {
  assert.equal(shortcutFromEvent(press({ repeat: true, metaKey: true }), APPLE), null)
})

test("a press inside an IME composition is not a combination", () => {
  assert.equal(shortcutFromEvent(press({ isComposing: true, code: "KeyA", key: "a" }), APPLE), null)
})

test("a press with no identifiable key is refused rather than stored unmatchable", () => {
  assert.equal(shortcutFromEvent(press({ code: "", key: "a" }), APPLE), null)
  assert.equal(shortcutFromEvent(press({ code: "Unidentified", key: "a" }), APPLE), null)
})

// --- modifiers as roles ---------------------------------------------------------------------------

test("the accelerator is stored as a role, so the same setting works on the other platform", () => {
  const onMac = shortcutFromEvent(press({ code: "KeyK", key: "k", metaKey: true }), APPLE)
  assert.deepEqual(onMac, { code: "KeyK", mod: true, label: "K" })
  // The headline: read back on Windows, it is Ctrl+K and it matches a Ctrl+K press there.
  assert.ok(matchesShortcut(press({ code: "KeyK", ctrlKey: true }), onMac, OTHER))
  assert.ok(!matchesShortcut(press({ code: "KeyK", metaKey: true }), onMac, OTHER))
  assert.deepEqual(physicalModifiers(onMac, OTHER), { meta: false, ctrl: true, alt: false, shift: false })
  assert.deepEqual(physicalModifiers(onMac, APPLE), { meta: true, ctrl: false, alt: false, shift: false })
})

test("Control on a Mac is the literal key, not the accelerator", () => {
  assert.deepEqual(heldModifiers({ ctrlKey: true }, APPLE), { ctrl: true })
  assert.deepEqual(heldModifiers({ metaKey: true }, APPLE), { mod: true })
  // Both held: the accelerator and the literal key, each named once.
  assert.deepEqual(heldModifiers({ metaKey: true, ctrlKey: true }, APPLE), { mod: true, ctrl: true })
})

test("the Windows key is the literal key off Apple platforms", () => {
  assert.deepEqual(heldModifiers({ ctrlKey: true }, OTHER), { mod: true })
  assert.deepEqual(heldModifiers({ metaKey: true }, OTHER), { meta: true })
  assert.deepEqual(heldModifiers({ ctrlKey: true, metaKey: true }, OTHER), { mod: true, meta: true })
})

test("normalizeMod off stores the key that was actually pressed", () => {
  const literal = shortcutFromEvent(press({ metaKey: true }), { apple: true, normalizeMod: false })
  assert.deepEqual(literal, { code: "KeyK", meta: true, label: "K" })
  // And it no longer travels: on Windows it asks for the Windows key.
  assert.ok(!matchesShortcut(press({ ctrlKey: true }), literal, OTHER))
  assert.ok(matchesShortcut(press({ metaKey: true }), literal, OTHER))
})

test("hasModifier tells a bare key from a combination", () => {
  assert.equal(hasModifier({}), false)
  assert.equal(hasModifier({ shift: true }), true)
  assert.equal(hasModifier({ mod: true }), true)
})

test("an extra modifier is a different combination", () => {
  const combo = { code: "KeyK", mod: true }
  assert.ok(!matchesShortcut(press({ code: "KeyK", metaKey: true, shiftKey: true }), combo, APPLE))
  assert.ok(!matchesShortcut(press({ code: "KeyK" }), combo, APPLE))
})

test("sameShortcut compares in role space", () => {
  assert.ok(sameShortcut({ code: "KeyK", mod: true }, { code: "KeyK", meta: true }, APPLE))
  assert.ok(!sameShortcut({ code: "KeyK", mod: true }, { code: "KeyK", meta: true }, OTHER))
})

// --- how it reads ---------------------------------------------------------------------------------

test("codes become the name printed on the key", () => {
  assert.equal(labelForCode("KeyK"), "K")
  assert.equal(labelForCode("Digit7"), "7")
  assert.equal(labelForCode("Numpad3"), "Num 3")
  assert.equal(labelForCode("F12"), "F12")
  assert.equal(labelForCode("Slash"), "/")
  assert.equal(labelForCode("IntlYen"), "¥")
  assert.equal(labelForCode("ArrowUp"), "Up")
  assert.equal(labelForCode("Escape"), "Esc")
  // Nothing invented for a key this table has never met.
  assert.equal(labelForCode("LaunchMail"), "LaunchMail")
})

test("each platform writes the modifiers in its own order", () => {
  const combo = { code: "KeyK", mod: true, ctrl: true, alt: true, shift: true }
  // Apple writes ⌃⌥⇧⌘ with the command key against the letter.
  assert.deepEqual(shortcutTokens(combo, APPLE), ["Ctrl", "Alt", "Shift", "Mod", "K"])
  // Windows and Linux lead with the accelerator.
  assert.deepEqual(shortcutTokens({ code: "KeyK", mod: true, alt: true, shift: true }, OTHER), [
    "Mod",
    "Alt",
    "Shift",
    "K",
  ])
})

test("the tokens are the vocabulary keyboard-shortcuts accepts, so a recording can be handed to it", () => {
  // Its KEY_TABLE is keyed on these lower-cased names; a token it does not know renders as authored,
  // which for "Mod" would mean the word Mod in a key cap on every platform.
  const table = new Set([
    "mod",
    "cmd",
    "command",
    "meta",
    "ctrl",
    "control",
    "alt",
    "option",
    "shift",
    "enter",
    "return",
    "esc",
    "escape",
    "tab",
    "backspace",
    "delete",
    "space",
    "up",
    "down",
    "left",
    "right",
  ])
  const combo = { code: "ArrowUp", mod: true, shift: true }
  for (const token of shortcutTokens(combo, APPLE)) {
    assert.ok(table.has(token.toLowerCase()), `keyboard-shortcuts does not know "${token}"`)
  }
})

test("the caps are drawn per platform and spoken in words", () => {
  assert.deepEqual(tokenForm("Mod", APPLE), { display: "⌘", spoken: "Command" })
  assert.deepEqual(tokenForm("Mod", OTHER), { display: "Ctrl", spoken: "Control" })
  assert.deepEqual(tokenForm("Meta", OTHER), { display: "Win", spoken: "Windows key" })
  assert.deepEqual(tokenForm("Alt", APPLE), { display: "⌥", spoken: "Option" })
  // A single character reads better as a cap.
  assert.deepEqual(tokenForm("k", APPLE), { display: "K", spoken: "K" })
})

test("the spoken form never contains a symbol a screen reader cannot name", () => {
  const combo = { code: "KeyK", mod: true, shift: true }
  assert.equal(formatShortcut(combo, APPLE), "Shift Command K")
  assert.equal(formatShortcut(combo, OTHER), "Control Shift K")
  assert.ok(!/[⌘⌥⇧⌃]/.test(formatShortcut(combo, APPLE)))
})

// --- combos the page cannot have ------------------------------------------------------------------

test("the combination that closes the tab is refused on both platforms", () => {
  const closeTab = { code: "KeyW", mod: true }
  assert.equal(reservedMatch(closeTab, APPLE).owner, "browser")
  assert.equal(reservedMatch(closeTab, OTHER).owner, "browser")
})

test("a Mac-only system combination is free on Windows", () => {
  const quit = { code: "KeyQ", mod: true }
  assert.equal(reservedMatch(quit, APPLE).owner, "system")
  assert.equal(reservedMatch(quit, OTHER), null)
})

test("switching application and switching tab are the same keys with different owners", () => {
  assert.equal(reservedMatch({ code: "Tab", mod: true }, APPLE).owner, "system")
  assert.equal(reservedMatch({ code: "Tab", mod: true }, OTHER).owner, "browser")
  assert.equal(reservedMatch({ code: "Tab", alt: true }, OTHER).owner, "system")
  assert.equal(reservedMatch({ code: "Tab", alt: true }, APPLE), null)
})

test("the reserved check resolves roles too, so a literal recording is caught as well", () => {
  // normalizeMod off on a Mac stores meta rather than mod; it is still ⌘W.
  assert.equal(reservedMatch({ code: "KeyW", meta: true }, APPLE).owner, "browser")
  assert.equal(reservedMatch({ code: "KeyW", ctrl: true }, OTHER).owner, "browser")
})

test("a default the page can prevent is not reserved — taking it over is the point", () => {
  for (const code of ["KeyS", "KeyP", "KeyF", "KeyK", "KeyJ"]) {
    assert.equal(reservedMatch({ code, mod: true }, APPLE), null, code)
    assert.equal(reservedMatch({ code, mod: true }, OTHER), null, code)
  }
})

test("a caller's list replaces the default and can be spread to extend it", () => {
  const own = [{ code: "KeyJ", mod: true, owner: "browser" }]
  assert.equal(reservedMatch({ code: "KeyW", mod: true }, { apple: true, reserved: own }), null)
  assert.equal(reservedMatch({ code: "KeyJ", mod: true }, { apple: true, reserved: own }).owner, "browser")
  const both = [...DEFAULT_RESERVED, ...own]
  assert.equal(reservedMatch({ code: "KeyW", mod: true }, { apple: true, reserved: both }).owner, "browser")
  assert.equal(reservedMatch({ code: "KeyJ", mod: true }, { apple: true, reserved: both }).owner, "browser")
})

// --- the component --------------------------------------------------------------------------------

function eventTarget(store) {
  return {
    addEventListener(type, fn, capture) {
      const key = `${type}:${capture === true || capture?.capture ? "capture" : "bubble"}`
      store.set(key, [...(store.get(key) ?? []), fn])
    },
    removeEventListener(type, fn, capture) {
      const key = `${type}:${capture === true || capture?.capture ? "capture" : "bubble"}`
      store.set(key, (store.get(key) ?? []).filter((registered) => registered !== fn))
    },
  }
}

const documentListeners = new Map()
const windowListeners = new Map()
globalThis.document = eventTarget(documentListeners)
globalThis.window = eventTarget(windowListeners)

// The harness runs effects the way a commit would but never their cleanups between passes, so every
// settle leaves another copy behind. Delivering to the most recent one is what a commit would have
// left in place.
function dispatch(store, key, event) {
  const handlers = store.get(key) ?? []
  assert.ok(handlers.length > 0, `nothing is listening on ${key}`)
  handlers[handlers.length - 1](event)
}

function mount(props = {}) {
  documentListeners.clear()
  windowListeners.clear()
  return render(ShortcutRecorder, { apple: true, ...props })
}

const button = (view) => byTag(walk(view.tree), "button")[0]
const buttons = (view) => byTag(walk(view.tree), "button")
const caps = (view) => byTag(walk(view.tree), "kbd").map((node) => node.props.children)
const status = (view) => walk(view.tree).find((node) => node.props?.role === "status")

/** Starts recording the way a click does, and settles. */
function startRecording(view) {
  button(view).props.onClick()
  view.rerender()
}

test("an empty recorder names itself in words and offers nothing to clear", () => {
  const view = mount()
  assert.equal(button(view).props["aria-label"], "Keyboard shortcut: none set")
  assert.equal(buttons(view).length, 1)
  assert.deepEqual(caps(view), [])
  // The live region exists before there is anything to announce, or the first message is silent.
  assert.ok(status(view))
  view.unmount()
})

test("a recorder with a value draws the caps and names the combination in words", () => {
  const view = mount({ value: { code: "KeyK", mod: true, shift: true } })
  assert.equal(button(view).props["aria-label"], "Keyboard shortcut: Shift Command K")
  assert.deepEqual(caps(view), ["⇧", "⌘", "K"])
  // The caps are decoration — the name above is what is read.
  const capHolder = walk(view.tree).find((node) => node.props?.["aria-hidden"] === "true")
  assert.ok(capHolder)
  assert.equal(buttons(view).length, 2, "a value can be cleared")
  view.unmount()
})

test("recording listens on document in the capture phase, ahead of the app's own hotkeys", () => {
  const view = mount()
  assert.equal(documentListeners.get("keydown:capture"), undefined)
  startRecording(view)
  assert.equal(button(view).props["aria-pressed"], true)
  assert.equal(button(view).props["aria-label"], defaultShortcutRecorderLabels.recording)
  assert.ok((documentListeners.get("keydown:capture") ?? []).length > 0)
  // Not in the bubble phase, where the app's handler would already have run.
  assert.equal(documentListeners.get("keydown:bubble"), undefined)
  assert.ok((windowListeners.get("blur:bubble") ?? []).length > 0)
  view.unmount()
})

test("a held modifier shows what is held and waits for the key it goes with", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "MetaLeft", key: "Meta", metaKey: true }))
  view.rerender()
  assert.deepEqual(changes, [], "a modifier alone is not a shortcut")
  assert.deepEqual(caps(view), ["⌘"])
  assert.equal(button(view).props["aria-pressed"], true)
  view.unmount()
})

test("releasing the modifier leaves the field recording with nothing held", () => {
  const view = mount()
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "ShiftLeft", key: "Shift", shiftKey: true }))
  view.rerender()
  assert.deepEqual(caps(view), ["⇧"])
  dispatch(documentListeners, "keyup:capture", press({ code: "ShiftLeft", key: "Shift", shiftKey: false }))
  view.rerender()
  assert.deepEqual(caps(view), [])
  assert.equal(button(view).props["aria-pressed"], true)
  view.unmount()
})

test("a combination commits, ends recording and is announced in words", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s) })
  startRecording(view)
  const e = press({ code: "KeyK", key: "k", metaKey: true })
  dispatch(documentListeners, "keydown:capture", e)
  view.rerender()
  assert.deepEqual(changes, [{ code: "KeyK", mod: true, label: "K" }])
  assert.equal(button(view).props["aria-pressed"], false)
  assert.equal(status(view).props.children, "Saved Command K")
  // The app never saw the press that was being recorded.
  assert.equal(e.stopped, 1)
  assert.equal(e.prevented, 1)
  view.unmount()
})

test("auto-repeat while recording is ignored outright, not reported as a bad key", () => {
  const changes = []
  const rejections = []
  const view = mount({ onChange: (s) => changes.push(s), onReject: (r) => rejections.push(r) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyK", metaKey: true, repeat: true }))
  view.rerender()
  assert.deepEqual(changes, [])
  assert.equal(button(view).props["aria-pressed"], true)
  // Nothing is said about it either: a key held down for a second would otherwise fill the live
  // region with complaints about a key the user has not finished pressing.
  assert.deepEqual(rejections, [])
  assert.equal(status(view).props.children, "")
  view.unmount()
})

test("Escape cancels without recording Escape", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s) })
  startRecording(view)
  const e = press({ code: "Escape", key: "Escape" })
  dispatch(documentListeners, "keydown:capture", e)
  view.rerender()
  assert.deepEqual(changes, [])
  assert.equal(button(view).props["aria-pressed"], false)
  // Kept from the app — an Escape that also closed the surrounding dialog would be two actions.
  assert.equal(e.stopped, 1)
  view.unmount()
})

test("Tab leaves and still moves focus — the field is not a keyboard dead end", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s) })
  startRecording(view)
  const e = press({ code: "Tab", key: "Tab" })
  dispatch(documentListeners, "keydown:capture", e)
  view.rerender()
  assert.deepEqual(changes, [], "Tab is not recorded")
  assert.equal(button(view).props["aria-pressed"], false)
  // The whole point: its default is left alone, so the browser moves focus out of the field.
  assert.equal(e.prevented, 0)
  assert.equal(e.stopped, 1)
  view.unmount()
})

test("Shift+Tab leaves the same way", () => {
  const view = mount()
  startRecording(view)
  const e = press({ code: "Tab", key: "Tab", shiftKey: true })
  dispatch(documentListeners, "keydown:capture", e)
  view.rerender()
  assert.equal(e.prevented, 0)
  assert.equal(button(view).props["aria-pressed"], false)
  view.unmount()
})

test("a modified Tab is recordable, because it is not the one that moves focus", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s), reserved: [] })
  startRecording(view)
  const e = press({ code: "Tab", key: "Tab", ctrlKey: true, altKey: true })
  dispatch(documentListeners, "keydown:capture", e)
  view.rerender()
  assert.deepEqual(changes, [{ code: "Tab", ctrl: true, alt: true }])
  assert.equal(e.prevented, 1)
  view.unmount()
})

test("the combination that closes the tab is not saved, and says who takes it", () => {
  const changes = []
  const rejections = []
  const view = mount({ onChange: (s) => changes.push(s), onReject: (r) => rejections.push(r) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyW", key: "w", metaKey: true }))
  view.rerender()
  assert.deepEqual(changes, [], "the user's work is not traded for a setting")
  assert.equal(rejections.length, 1)
  assert.equal(rejections[0].kind, "reserved")
  assert.equal(rejections[0].owner, "browser")
  assert.deepEqual(rejections[0].shortcut, { code: "KeyW", mod: true, label: "W" })
  assert.equal(status(view).props.children, "Command W is the browser's own shortcut and cannot be reassigned here.")
  // Still recording: the user gets to try another combination without clicking again.
  assert.equal(button(view).props["aria-pressed"], true)
  view.unmount()
})

test("requireModifier turns down a bare key and says what is missing", () => {
  const changes = []
  const rejections = []
  const view = mount({
    requireModifier: true,
    onChange: (s) => changes.push(s),
    onReject: (r) => rejections.push(r),
  })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyG", key: "g" }))
  view.rerender()
  assert.deepEqual(changes, [])
  assert.equal(rejections[0].kind, "needs-modifier")
  assert.equal(status(view).props.children, defaultShortcutRecorderLabels.needsModifier)
  view.unmount()
})

test("a bare key is recorded by default, for an app whose shortcuts are single letters", () => {
  const changes = []
  const view = mount({ onChange: (s) => changes.push(s) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyG", key: "g" }))
  view.rerender()
  assert.deepEqual(changes, [{ code: "KeyG", label: "G" }])
  view.unmount()
})

test("a press with no identifiable key is reported rather than saved", () => {
  const rejections = []
  const view = mount({ onReject: (r) => rejections.push(r) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "", key: "a" }))
  view.rerender()
  assert.equal(rejections[0].kind, "unidentified")
  assert.equal(rejections[0].shortcut, null)
  assert.equal(button(view).props["aria-pressed"], true)
  view.unmount()
})

test("a window blur ends recording, because the keyup for that press never arrives", () => {
  const view = mount()
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "MetaLeft", key: "Meta", metaKey: true }))
  view.rerender()
  assert.deepEqual(caps(view), ["⌘"])
  dispatch(windowListeners, "blur:bubble", {})
  view.rerender()
  assert.equal(button(view).props["aria-pressed"], false)
  // The held ⌘ is forgotten with it — otherwise a later bare K would be recorded as ⌘K.
  assert.deepEqual(caps(view), [])
  view.unmount()
})

test("recording stops when focus leaves the control", () => {
  const view = mount()
  startRecording(view)
  button(view).props.onBlur()
  view.rerender()
  assert.equal(button(view).props["aria-pressed"], false)
  view.unmount()
})

test("the listeners are gone once the component is unmounted", () => {
  const view = mount()
  startRecording(view)
  view.unmount()
  assert.deepEqual(documentListeners.get("keydown:capture"), [])
  assert.deepEqual(documentListeners.get("keyup:capture"), [])
  assert.deepEqual(windowListeners.get("blur:bubble"), [])
})

test("clearing unsets the combination", () => {
  const changes = []
  const view = mount({ defaultValue: { code: "KeyK", mod: true }, onChange: (s) => changes.push(s) })
  const clear = buttons(view)[1]
  assert.equal(clear.props["aria-label"], defaultShortcutRecorderLabels.clear)
  // WCAG 2.5.3: the visible word has to be inside the spoken name, or speaking the label does not
  // press the button.
  assert.equal(clear.props.children, defaultShortcutRecorderLabels.clearText)
  assert.ok(defaultShortcutRecorderLabels.clear.includes(defaultShortcutRecorderLabels.clearText))
  clear.props.onClick()
  view.rerender()
  assert.deepEqual(changes, [null])
  assert.deepEqual(caps(view), [])
  assert.equal(buttons(view).length, 1)
  view.unmount()
})

test("a controlled recorder shows the prop and never its own idea of the value", () => {
  const changes = []
  const view = mount({ value: null, onChange: (s) => changes.push(s) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyK", key: "k", metaKey: true }))
  view.rerender()
  assert.deepEqual(changes, [{ code: "KeyK", mod: true, label: "K" }])
  // The parent said null and has not said otherwise.
  assert.deepEqual(caps(view), [])
  assert.equal(button(view).props["aria-label"], "Keyboard shortcut: none set")
  view.unmount()
})

test("recording is announced to the parent when it starts and when it ends", () => {
  const states = []
  const view = mount({ onRecordingChange: (r) => states.push(r) })
  startRecording(view)
  dispatch(documentListeners, "keydown:capture", press({ code: "KeyK", key: "k", metaKey: true }))
  view.rerender()
  assert.deepEqual(states, [true, false])
  view.unmount()
})

test("a disabled recorder cannot be started", () => {
  const view = mount({ disabled: true, value: { code: "KeyK", mod: true } })
  for (const b of buttons(view)) assert.equal(b.props.disabled, true)
  view.unmount()
})

test("labels can be replaced one at a time", () => {
  const view = mount({ labels: { field: "ショートカット", empty: "未設定" } })
  assert.equal(button(view).props["aria-label"], "ショートカット: 未設定")
  // The ones not passed keep their defaults.
  startRecording(view)
  assert.equal(button(view).props["aria-label"], defaultShortcutRecorderLabels.recording)
  view.unmount()
})
