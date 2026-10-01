"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { Kbd } from "@/registry/ui/kbd"

/**
 * One recorded key combination, in a shape that survives being written to a database and read back
 * on another machine.
 *
 * `code` is `KeyboardEvent.code` — the physical key, not the character it produced. Recording the
 * character instead is the mistake that looks fine until somebody records `Shift+/`: the event
 * arrives with `key: "?"`, so the setting says "?" and never matches again, because at match time
 * the unshifted event carries `key: "/"`. The same goes for `Alt+n` on a Mac, which produces `"˜"`.
 * `code` is stable under every modifier, so the recording and the match agree.
 *
 * Modifiers are stored as *roles*, not as physical keys. `mod` is the platform's accelerator — ⌘ on
 * Apple platforms, Ctrl everywhere else — so a combo recorded on a Mac is still the right combo on
 * Windows. `ctrl` and `meta` are the literal keys, used when the accelerator is not what was
 * pressed (Ctrl+K on a Mac) or when `normalizeMod` is off.
 */
export interface Shortcut {
  /** `KeyboardEvent.code`, e.g. `"KeyK"`, `"Slash"`, `"ArrowUp"`. */
  code: string
  /** The platform accelerator: ⌘ on Apple platforms, Ctrl elsewhere. */
  mod?: boolean
  /** Literal Control, when it is not the accelerator. */
  ctrl?: boolean
  /** Literal ⌘ / Windows key, when it is not the accelerator. */
  meta?: boolean
  alt?: boolean
  shift?: boolean
  /**
   * What was printed on the key the user actually pressed, when that could be read off the event
   * honestly — so a French keyboard shows `A` where the code says `KeyQ`. Display only: matching
   * never looks at it.
   */
  label?: string
}

/** Which platform's key names to speak and draw. */
export interface PlatformOptions {
  /** True on macOS, iOS and iPadOS. Defaults to false so server and client render the same markup. */
  apple?: boolean
}

/** The modifiers a combo needs physically held, once `mod` is resolved for a platform. */
export interface PhysicalModifiers {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/**
 * Codes that are a modifier rather than a key to record. A press of one of these is "not a
 * combination yet": committing on it would make Shift alone a shortcut, which means no combination
 * involving Shift could ever be recorded — the field would close before the second key arrived.
 *
 * CapsLock is here because it latches rather than being held, and the lock keys because an event
 * from them says the lock changed, not that the user chose a key.
 */
export const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
])

/** `KeyboardEvent.key` values that mean a modifier, for events that report no usable `code`. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Fn",
  "FnLock",
])

/** Only the fields of a keyboard event this component reads. */
export interface KeyPress {
  code?: string
  key?: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
}

/** True when the press is a modifier being held rather than a key being chosen. */
export function isModifierPress(e: KeyPress): boolean {
  if (e.code && MODIFIER_CODES.has(e.code)) return true
  return !!e.key && MODIFIER_KEYS.has(e.key)
}

/**
 * The modifiers currently held, as roles.
 *
 * `normalizeMod` folds the platform accelerator into `mod`; with it off, the literal keys are
 * reported and a Mac recording stays a Mac recording.
 */
export function heldModifiers(
  e: KeyPress,
  { apple = false, normalizeMod = true }: PlatformOptions & { normalizeMod?: boolean } = {}
): Pick<Shortcut, "mod" | "ctrl" | "meta" | "alt" | "shift"> {
  const accelerator = apple ? !!e.metaKey : !!e.ctrlKey
  const out: Pick<Shortcut, "mod" | "ctrl" | "meta" | "alt" | "shift"> = {}
  if (normalizeMod && accelerator) out.mod = true
  if (e.ctrlKey && !(normalizeMod && !apple && accelerator)) out.ctrl = true
  if (e.metaKey && !(normalizeMod && apple && accelerator)) out.meta = true
  if (e.altKey) out.alt = true
  if (e.shiftKey) out.shift = true
  return out
}

/** True when at least one modifier is held. */
export function hasModifier(mods: Pick<Shortcut, "mod" | "ctrl" | "meta" | "alt" | "shift">): boolean {
  return !!(mods.mod || mods.ctrl || mods.meta || mods.alt || mods.shift)
}

/**
 * Resolves a combo's modifier roles to the keys that have to be physically down on this platform.
 *
 * Both matching and the reserved-combo check go through here, so "⌘K recorded on a Mac" and
 * "Ctrl+K on Windows" are the same combo exactly once, in one place.
 */
export function physicalModifiers(
  shortcut: Pick<Shortcut, "mod" | "ctrl" | "meta" | "alt" | "shift">,
  { apple = false }: PlatformOptions = {}
): PhysicalModifiers {
  return {
    meta: !!shortcut.meta || (!!shortcut.mod && apple),
    ctrl: !!shortcut.ctrl || (!!shortcut.mod && !apple),
    alt: !!shortcut.alt,
    shift: !!shortcut.shift,
  }
}

/**
 * Builds the combo a press describes, or null when the press is not one.
 *
 * Null comes back for a modifier held on its own, for an auto-repeat (holding a key down would
 * otherwise commit it the moment the repeat started), for a press that is part of an IME
 * composition, and for an event with no usable `code` — a soft keyboard that reports
 * `code: ""` can be recorded, but the combo it produces could never match anything, so saving it
 * would hand the user a shortcut that silently does nothing.
 */
export function shortcutFromEvent(
  e: KeyPress,
  { apple = false, normalizeMod = true }: PlatformOptions & { normalizeMod?: boolean } = {}
): Shortcut | null {
  if (e.repeat || e.isComposing) return null
  if (isModifierPress(e)) return null
  if (!e.code || e.code === "Unidentified") return null

  const shift = !!e.shiftKey
  const alt = !!e.altKey
  // The character on the event is only the character on the user's keyboard while nothing is
  // reshaping it. Shift turns `/` into `?`, and Option on a Mac turns `n` into a dead key, so in
  // those cases the code table's US-layout name is the honest answer and this is left unset.
  const label =
    !shift && !alt && typeof e.key === "string" && [...e.key].length === 1
      ? e.key.toUpperCase()
      : undefined

  return { code: e.code, ...heldModifiers(e, { apple, normalizeMod }), ...(label ? { label } : {}) }
}

/** True when `event` is the press this combo was recorded for. */
export function matchesShortcut(e: KeyPress, shortcut: Shortcut, options: PlatformOptions = {}): boolean {
  if (!e.code || e.code !== shortcut.code) return false
  const need = physicalModifiers(shortcut, options)
  return (
    !!e.metaKey === need.meta &&
    !!e.ctrlKey === need.ctrl &&
    !!e.altKey === need.alt &&
    !!e.shiftKey === need.shift
  )
}

/** True when two combos are the same combination on this platform. */
export function sameShortcut(a: Shortcut, b: Shortcut, options: PlatformOptions = {}): boolean {
  if (a.code !== b.code) return false
  const left = physicalModifiers(a, options)
  const right = physicalModifiers(b, options)
  return (
    left.meta === right.meta &&
    left.ctrl === right.ctrl &&
    left.alt === right.alt &&
    left.shift === right.shift
  )
}

// --- what the keys are called ---------------------------------------------------------------------

/** Codes whose name is not derivable, mapped to a token `kbd` and keyboard-shortcuts both know. */
const CODE_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Ins",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlBackslash: "\\",
  IntlRo: "\\",
  IntlYen: "¥",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadMultiply: "Num *",
  NumpadDivide: "Num /",
  NumpadDecimal: "Num .",
}

/** The US-layout name of a physical key, for display when the event's own character was not usable. */
export function labelForCode(code: string): string {
  const known = CODE_LABELS[code]
  if (known) return known
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `Num ${numpad[1]}`
  const fn = /^F(\d{1,2})$/.exec(code)
  if (fn) return `F${fn[1]}`
  return code
}

/** Drawn form and spoken form of one token, per platform. */
type TokenForm = { apple: readonly [string, string]; other: readonly [string, string] }

/**
 * Mirrors the table in keyboard-shortcuts on purpose: the tokens this returns are meant to be
 * handed straight to that component's `keys`, so the two have to name keys the same way.
 */
const TOKEN_FORMS: Record<string, TokenForm> = {
  mod: { apple: ["⌘", "Command"], other: ["Ctrl", "Control"] },
  ctrl: { apple: ["⌃", "Control"], other: ["Ctrl", "Control"] },
  meta: { apple: ["⌘", "Command"], other: ["Win", "Windows key"] },
  alt: { apple: ["⌥", "Option"], other: ["Alt", "Alt"] },
  shift: { apple: ["⇧", "Shift"], other: ["Shift", "Shift"] },
  enter: { apple: ["↩", "Enter"], other: ["Enter", "Enter"] },
  esc: { apple: ["Esc", "Escape"], other: ["Esc", "Escape"] },
  tab: { apple: ["⇥", "Tab"], other: ["Tab", "Tab"] },
  backspace: { apple: ["⌫", "Backspace"], other: ["Backspace", "Backspace"] },
  delete: { apple: ["⌦", "Delete"], other: ["Del", "Delete"] },
  space: { apple: ["Space", "Space"], other: ["Space", "Space"] },
  up: { apple: ["↑", "Up arrow"], other: ["↑", "Up arrow"] },
  down: { apple: ["↓", "Down arrow"], other: ["↓", "Down arrow"] },
  left: { apple: ["←", "Left arrow"], other: ["←", "Left arrow"] },
  right: { apple: ["→", "Right arrow"], other: ["→", "Right arrow"] },
}

/**
 * The combo as tokens, in the order that platform writes them.
 *
 * Apple writes ⌃⌥⇧⌘ with the command key against the letter; Windows and Linux write
 * Ctrl+Alt+Shift+Key with the accelerator first. Emitting one fixed order would be visibly wrong on
 * one of the two. The tokens themselves are the vocabulary keyboard-shortcuts accepts, so a recorded
 * combo can go straight into its `keys` array.
 */
export function shortcutTokens(shortcut: Shortcut, { apple = false }: PlatformOptions = {}): string[] {
  const tokens: string[] = []
  if (apple) {
    if (shortcut.ctrl) tokens.push("Ctrl")
    if (shortcut.alt) tokens.push("Alt")
    if (shortcut.shift) tokens.push("Shift")
    if (shortcut.mod) tokens.push("Mod")
    if (shortcut.meta) tokens.push("Meta")
  } else {
    if (shortcut.mod) tokens.push("Mod")
    if (shortcut.ctrl) tokens.push("Ctrl")
    if (shortcut.meta) tokens.push("Meta")
    if (shortcut.alt) tokens.push("Alt")
    if (shortcut.shift) tokens.push("Shift")
  }
  tokens.push(shortcut.label || labelForCode(shortcut.code))
  return tokens
}

/** Drawn and spoken form of one token. */
export function tokenForm(token: string, { apple = false }: PlatformOptions = {}): {
  display: string
  spoken: string
} {
  const entry = TOKEN_FORMS[token.trim().toLowerCase()]
  if (entry) {
    const [display, spoken] = apple ? entry.apple : entry.other
    return { display, spoken }
  }
  const display = [...token].length === 1 ? token.toUpperCase() : token
  return { display, spoken: display }
}

/**
 * The combo in words, for a screen reader and for a rejection message.
 *
 * A screen reader meeting "⌘" announces "place of interest sign" or nothing at all, so the drawn
 * caps are never the accessible name — this is.
 */
export function formatShortcut(shortcut: Shortcut, options: PlatformOptions = {}): string {
  return shortcutTokens(shortcut, options)
    .map((token) => tokenForm(token, options).spoken)
    .join(" ")
}

// --- combos that cannot be taken ------------------------------------------------------------------

/**
 * A combination the page is not allowed to have.
 *
 * The honest framing matters here. While recording, this component takes every press away from the
 * page so the app's own hotkeys do not fire mid-recording — but `preventDefault` does not reach the
 * browser's own ⌘W or the system's ⌘Tab, and it never will. Nothing a component does can stop the
 * tab closing. What it can do is refuse to *save* such a combo, so the user is not left with a
 * setting that destroys their work every time they use it, and say which layer took it.
 */
export interface ReservedCombo {
  code: string
  mod?: boolean
  ctrl?: boolean
  meta?: boolean
  alt?: boolean
  shift?: boolean
  /** Who takes the press: the browser's own UI, or the operating system. */
  owner: "browser" | "system"
  /** Set when the combo is only reserved on one platform. */
  platform?: "apple" | "other"
}

/**
 * The combinations a browser tab cannot be given, as a starting point.
 *
 * Deliberately short: every entry is a combo that is both unpreventable in a normal tab and costly
 * when it fires — a closed tab, a quit app, a switched window. Keys that merely have a default the
 * page *can* prevent (⌘S, ⌘P, ⌘F) are not here, because taking those over is exactly what an app
 * with a shortcut settings screen is for.
 */
export const DEFAULT_RESERVED: readonly ReservedCombo[] = [
  // Closes the tab or the window, under both accelerators, with the work in it.
  { code: "KeyW", mod: true, owner: "browser" },
  { code: "KeyW", mod: true, shift: true, owner: "browser" },
  // Opens a tab or a window over the app.
  { code: "KeyT", mod: true, owner: "browser" },
  { code: "KeyT", mod: true, shift: true, owner: "browser" },
  { code: "KeyN", mod: true, owner: "browser" },
  { code: "KeyN", mod: true, shift: true, owner: "browser" },
  // Moves between tabs on Windows and Linux; switches application on a Mac.
  { code: "Tab", mod: true, platform: "other", owner: "browser" },
  { code: "Tab", mod: true, platform: "apple", owner: "system" },
  { code: "Tab", alt: true, platform: "other", owner: "system" },
  { code: "F4", alt: true, platform: "other", owner: "system" },
  // Quits, hides or minimises the browser; the page is never consulted.
  { code: "KeyQ", mod: true, platform: "apple", owner: "system" },
  { code: "KeyQ", mod: true, shift: true, platform: "apple", owner: "system" },
  { code: "KeyH", mod: true, platform: "apple", owner: "system" },
  { code: "KeyM", mod: true, platform: "apple", owner: "system" },
  { code: "Space", mod: true, platform: "apple", owner: "system" },
  // Opens the browser's own settings.
  { code: "Comma", mod: true, platform: "apple", owner: "browser" },
]

/** The reserved entry a combo collides with, or null when it is free. */
export function reservedMatch(
  shortcut: Shortcut,
  { apple = false, reserved = DEFAULT_RESERVED }: PlatformOptions & { reserved?: readonly ReservedCombo[] } = {}
): ReservedCombo | null {
  const need = physicalModifiers(shortcut, { apple })
  for (const combo of reserved) {
    if (combo.platform === "apple" && !apple) continue
    if (combo.platform === "other" && apple) continue
    if (combo.code !== shortcut.code) continue
    const theirs = physicalModifiers(combo, { apple })
    if (
      theirs.meta === need.meta &&
      theirs.ctrl === need.ctrl &&
      theirs.alt === need.alt &&
      theirs.shift === need.shift
    ) {
      return combo
    }
  }
  return null
}

/** Why a press was not saved. */
export interface ShortcutRejection {
  kind: "reserved" | "needs-modifier" | "unidentified"
  /** The combo that was turned down. Absent when the press produced no usable combo at all. */
  shortcut: Shortcut | null
  /** The sentence shown to the user and announced. */
  reason: string
  /** Who takes the press, for a `"reserved"` rejection. */
  owner?: "browser" | "system"
}

export interface ShortcutRecorderLabels {
  /** Names the control for a screen reader; the recorded combo is appended to it. */
  field: string
  /** Stands in for the combo in that name while nothing is recorded. */
  empty: string
  /** Shown in place of the caps while nothing is recorded. */
  placeholder: string
  /** Shown in place of the caps while recording, before any modifier is held. */
  prompt: string
  /** The control's accessible name while recording. */
  recording: string
  /** The clear button's accessible name. */
  clear: string
  /** The clear button's visible text. Kept inside `clear`, so speaking the label matches the text. */
  clearText: string
  /** Announced once a combo is saved; the combo in words follows it. */
  saved: string
  /** Shown when the press was a bare key and `requireModifier` is on. */
  needsModifier: string
  /** Shown when the press carried no identifiable key. */
  unidentified: string
  /** Shown when the browser keeps the combo; the combo in words precedes it. */
  reservedByBrowser: string
  /** Shown when the operating system keeps the combo. */
  reservedBySystem: string
}

export const defaultShortcutRecorderLabels: ShortcutRecorderLabels = {
  field: "Keyboard shortcut",
  empty: "none set",
  placeholder: "Not set",
  prompt: "Press keys…",
  recording: "Recording a keyboard shortcut. Press the combination you want, Escape to cancel, Tab to leave.",
  clear: "Clear this keyboard shortcut",
  clearText: "Clear",
  saved: "Saved",
  needsModifier: "Add ⌘, Ctrl, Alt or Shift to make a shortcut.",
  unidentified: "That key could not be identified. Try another one.",
  reservedByBrowser: "is the browser's own shortcut and cannot be reassigned here.",
  reservedBySystem: "belongs to the operating system and cannot be reassigned here.",
}

export interface ShortcutRecorderProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange" | "defaultValue" | "children"> {
  /** The recorded combo. Pass it to control the component; omit to let it own its state. */
  value?: Shortcut | null
  /** Starting combo when uncontrolled. */
  defaultValue?: Shortcut | null
  /** Called with the new combo, or null when it is cleared. */
  onChange?: (shortcut: Shortcut | null) => void
  /** Called when a press was turned down, with the sentence the user was shown. */
  onReject?: (rejection: ShortcutRejection) => void
  /** Called when recording starts and stops, for a parent that dims the rest of the form. */
  onRecordingChange?: (recording: boolean) => void
  /**
   * Store the platform accelerator as `mod` rather than as the literal ⌘ or Ctrl, so the setting
   * means the same thing on the next machine. On by default.
   */
  normalizeMod?: boolean
  /** Turn down bare keys, for an app whose shortcuts all carry a modifier. Off by default. */
  requireModifier?: boolean
  /** Combos that cannot be saved. Spread `DEFAULT_RESERVED` to add to it rather than replace it. */
  reserved?: readonly ReservedCombo[]
  /** Override platform detection. Leave unset outside tests. */
  apple?: boolean
  disabled?: boolean
  /** Show the button that unsets the combo. On by default. */
  clearable?: boolean
  labels?: Partial<ShortcutRecorderLabels>
}

/**
 * The field that records a keyboard shortcut: the user presses the combination they want and it is
 * captured as a setting. For a shortcut settings screen, a key-binding editor, an accessibility
 * panel, or anywhere a command's keys are configurable.
 *
 * Recording has to take the keyboard away from everything else for as long as it lasts, which is the
 * whole difficulty. The listener is on `document` in the capture phase, because the app's own hotkey
 * library is listening too and a bubble-phase handler on this element would let ⌘K open the command
 * palette while the user was trying to record ⌘K. Capture gets there first and the press stops
 * there. What capture cannot do is reach the layer above the page: ⌘W still closes the tab and ⌘Tab
 * still switches application, whatever this component calls `preventDefault` on. That is why there
 * is a reserved list instead of a promise — see {@link DEFAULT_RESERVED}.
 *
 * Two keys keep their meaning while recording, on purpose. Escape cancels, because a field that
 * swallows the universal escape hatch is a trap. Tab leaves and moves focus, because a recorder that
 * captured Tab would be a keyboard dead end — the press is kept from the app, but its default is
 * allowed, so focus moves exactly as it would anywhere else. Both are documented in the control's
 * accessible name, which is what a screen reader reads on entering it.
 *
 * Auto-repeat is ignored: holding a key down delivers a stream of presses, and committing on the
 * first would record whatever key the user happened to be leaning on. A press while an IME is
 * composing is ignored for the same reason.
 *
 * Window blur ends recording. This is not tidiness — the keyup for the press that moved focus away
 * is never delivered, so a component that kept its own modifier state across a blur would come back
 * believing ⌘ was still held and record ⌘K from a bare K.
 *
 * The caps are `aria-hidden` and the control is named in words ("Keyboard shortcut: Command Shift
 * K"), because a screen reader meeting ⌘ announces "place of interest sign" or nothing at all.
 * Rejections and saves land in a live region rather than only in colour.
 */
export const ShortcutRecorder = React.forwardRef<HTMLDivElement, ShortcutRecorderProps>(
  function ShortcutRecorder(
    {
      value: valueProp,
      defaultValue = null,
      onChange,
      onReject,
      onRecordingChange,
      normalizeMod = true,
      requireModifier = false,
      reserved = DEFAULT_RESERVED,
      apple: appleProp,
      disabled = false,
      clearable = true,
      labels: labelsProp,
      className,
      ...props
    },
    ref
  ) {
    const labels = { ...defaultShortcutRecorderLabels, ...labelsProp }

    const [uncontrolled, setUncontrolled] = React.useState<Shortcut | null>(defaultValue)
    const isControlled = valueProp !== undefined
    const value = isControlled ? valueProp : uncontrolled

    // `navigator` does not exist on the server, so platform detection runs in an effect: branching
    // on it during render would either crash SSR or hydrate to different markup than was sent. The
    // first paint writes the Ctrl form and swaps to ⌘ once mounted.
    const [detectedApple, setDetectedApple] = React.useState(false)
    React.useEffect(() => {
      if (appleProp !== undefined) return
      setDetectedApple(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent))
    }, [appleProp])
    const apple = appleProp ?? detectedApple

    const [recording, setRecording] = React.useState(false)
    const [pending, setPending] = React.useState<string[]>([])
    const [message, setMessage] = React.useState("")

    // Read through refs so the document listener is registered once per recording session rather
    // than on every render an inline callback prop would cause.
    const onChangeRef = React.useRef(onChange)
    onChangeRef.current = onChange
    const onRejectRef = React.useRef(onReject)
    onRejectRef.current = onReject
    const onRecordingChangeRef = React.useRef(onRecordingChange)
    onRecordingChangeRef.current = onRecordingChange

    const stopRecording = React.useCallback(() => {
      setRecording(false)
      setPending([])
    }, [])

    const startRecording = React.useCallback(() => {
      setMessage("")
      setPending([])
      setRecording(true)
    }, [])

    // Announce start and stop to the parent without making the effect below depend on the callback.
    const wasRecording = React.useRef(recording)
    React.useEffect(() => {
      if (wasRecording.current === recording) return
      wasRecording.current = recording
      onRecordingChangeRef.current?.(recording)
    }, [recording])

    const commit = React.useCallback(
      (next: Shortcut | null) => {
        if (!isControlled) setUncontrolled(next)
        onChangeRef.current?.(next)
      },
      [isControlled]
    )

    const reject = React.useCallback((rejection: ShortcutRejection) => {
      setMessage(rejection.reason)
      onRejectRef.current?.(rejection)
    }, [])

    React.useEffect(() => {
      if (!recording) return

      const onKeyDown = (e: KeyboardEvent) => {
        if (e.isComposing) return

        // Tab keeps its meaning: the app does not see it, but the browser moves focus with it, so
        // the field is not a keyboard dead end.
        if (e.code === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.stopPropagation()
          stopRecording()
          return
        }

        e.preventDefault()
        e.stopPropagation()

        if (e.repeat) return

        if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
          stopRecording()
          return
        }

        if (isModifierPress(e)) {
          // Not a combination yet — show what is held and wait for the key it goes with.
          setPending(
            shortcutTokens({ code: "", ...heldModifiers(e, { apple, normalizeMod }) }, { apple }).slice(0, -1)
          )
          return
        }

        const shortcut = shortcutFromEvent(e, { apple, normalizeMod })
        if (!shortcut) {
          reject({ kind: "unidentified", shortcut: null, reason: labels.unidentified })
          return
        }

        if (requireModifier && !hasModifier(shortcut)) {
          reject({ kind: "needs-modifier", shortcut, reason: labels.needsModifier })
          return
        }

        const collision = reservedMatch(shortcut, { apple, reserved })
        if (collision) {
          const words = formatShortcut(shortcut, { apple })
          reject({
            kind: "reserved",
            shortcut,
            owner: collision.owner,
            reason: `${words} ${
              collision.owner === "browser" ? labels.reservedByBrowser : labels.reservedBySystem
            }`,
          })
          return
        }

        commit(shortcut)
        setMessage(`${labels.saved} ${formatShortcut(shortcut, { apple })}`)
        stopRecording()
      }

      const onKeyUp = (e: KeyboardEvent) => {
        if (!isModifierPress(e)) return
        e.stopPropagation()
        setPending(
          shortcutTokens({ code: "", ...heldModifiers(e, { apple, normalizeMod }) }, { apple }).slice(0, -1)
        )
      }

      // The press that moved focus away never delivers its keyup, so the held-modifier state would
      // be a lie from here on. Recording ends instead of carrying it.
      const onBlur = () => stopRecording()

      document.addEventListener("keydown", onKeyDown, true)
      document.addEventListener("keyup", onKeyUp, true)
      window.addEventListener("blur", onBlur)
      return () => {
        document.removeEventListener("keydown", onKeyDown, true)
        document.removeEventListener("keyup", onKeyUp, true)
        window.removeEventListener("blur", onBlur)
      }
    }, [
      recording,
      apple,
      normalizeMod,
      requireModifier,
      reserved,
      commit,
      reject,
      stopRecording,
      labels.needsModifier,
      labels.unidentified,
      labels.reservedByBrowser,
      labels.reservedBySystem,
      labels.saved,
    ])

    const words = value ? formatShortcut(value, { apple }) : labels.empty
    const caps = recording
      ? pending
      : value
        ? shortcutTokens(value, { apple })
        : []

    return (
      <div ref={ref} className={cn("flex flex-col gap-1", className)} {...props}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled}
            aria-label={recording ? labels.recording : `${labels.field}: ${words}`}
            aria-pressed={recording}
            onClick={() => (recording ? stopRecording() : startRecording())}
            onBlur={stopRecording}
            className={cn(
              "inline-flex h-9 min-w-[7.5rem] items-center gap-1 rounded-md border bg-background px-3 text-sm shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              "disabled:cursor-not-allowed disabled:opacity-50",
              recording ? "border-ring ring-2 ring-ring" : "hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <span aria-hidden="true" className="flex items-center gap-1">
              {caps.map((token, i) => (
                <Kbd key={`${token}-${i}`}>{tokenForm(token, { apple }).display}</Kbd>
              ))}
              {recording ? (
                <span className="text-muted-foreground">{pending.length ? "…" : labels.prompt}</span>
              ) : null}
              {!recording && !value ? (
                <span className="text-muted-foreground">{labels.placeholder}</span>
              ) : null}
            </span>
          </button>

          {clearable && value && !recording ? (
            <button
              type="button"
              disabled={disabled}
              aria-label={labels.clear}
              onClick={() => {
                commit(null)
                setMessage("")
              }}
              className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {labels.clearText}
            </button>
          ) : null}
        </div>

        {/* Present from the first render so a later message is announced rather than merely added. */}
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {message}
        </p>
      </div>
    )
  }
)
