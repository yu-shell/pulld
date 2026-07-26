"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Kbd } from "@/registry/ui/kbd"

export interface Shortcut {
  /**
   * The keys in press order, e.g. `["Mod", "K"]`. `"Mod"` renders as ⌘ on Apple
   * platforms and Ctrl everywhere else. The literal token `"then"` renders as
   * plain text rather than a key cap, so chords read as `G then P`.
   */
  keys: string[]
  /** What the shortcut does, in the user's words ("Open search"). */
  description: string
  /** Section heading. Groups appear in the order they first occur. */
  group?: string
}

interface KeyboardShortcutsProps {
  /** Every shortcut to document. An empty list means the sheet never opens. */
  shortcuts: Shortcut[]
  /**
   * The character that toggles the sheet, compared against `event.key`.
   * Default `"?"`. Pass `null` to drive it only through `open`.
   */
  hotkey?: string | null
  /** Controlled open state. Omit to let the component own it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title?: string
  closeLabel?: string
  className?: string
}

/** display + spoken form of a key, per platform. */
type KeyForm = { apple: readonly [string, string]; other: readonly [string, string] }

const KEY_TABLE: Record<string, KeyForm> = {
  mod: { apple: ["⌘", "Command"], other: ["Ctrl", "Control"] },
  cmd: { apple: ["⌘", "Command"], other: ["⌘", "Command"] },
  command: { apple: ["⌘", "Command"], other: ["⌘", "Command"] },
  meta: { apple: ["⌘", "Command"], other: ["Win", "Windows key"] },
  ctrl: { apple: ["⌃", "Control"], other: ["Ctrl", "Control"] },
  control: { apple: ["⌃", "Control"], other: ["Ctrl", "Control"] },
  alt: { apple: ["⌥", "Option"], other: ["Alt", "Alt"] },
  option: { apple: ["⌥", "Option"], other: ["⌥", "Option"] },
  shift: { apple: ["⇧", "Shift"], other: ["Shift", "Shift"] },
  enter: { apple: ["↩", "Enter"], other: ["Enter", "Enter"] },
  return: { apple: ["↩", "Return"], other: ["Enter", "Enter"] },
  esc: { apple: ["Esc", "Escape"], other: ["Esc", "Escape"] },
  escape: { apple: ["Esc", "Escape"], other: ["Esc", "Escape"] },
  tab: { apple: ["⇥", "Tab"], other: ["Tab", "Tab"] },
  backspace: { apple: ["⌫", "Backspace"], other: ["Backspace", "Backspace"] },
  delete: { apple: ["⌦", "Delete"], other: ["Del", "Delete"] },
  space: { apple: ["Space", "Space"], other: ["Space", "Space"] },
  up: { apple: ["↑", "Up arrow"], other: ["↑", "Up arrow"] },
  down: { apple: ["↓", "Down arrow"], other: ["↓", "Down arrow"] },
  left: { apple: ["←", "Left arrow"], other: ["←", "Left arrow"] },
  right: { apple: ["→", "Right arrow"], other: ["→", "Right arrow"] },
}

function keyForm(raw: string, apple: boolean): { display: string; spoken: string } {
  const entry = KEY_TABLE[raw.trim().toLowerCase()]
  if (entry) {
    const [display, spoken] = apple ? entry.apple : entry.other
    return { display, spoken }
  }
  // Single letters read better as caps; anything longer passes through as authored.
  const display = raw.length === 1 ? raw.toUpperCase() : raw
  return { display, spoken: display }
}

/** Text entry swallows the hotkey — "?" belongs in the message, not in the help sheet. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/**
 * The "press ? to see every shortcut" help sheet — a modal listing your
 * keyboard shortcuts, grouped, with the key caps rendered per platform.
 *
 * It documents shortcuts; it does not bind them. Your app already owns the
 * handlers, and a component that also registered them would fight whatever
 * hotkey library you use. The one key it does own is the one that opens it.
 *
 * Platform detection runs in an effect rather than during render: `navigator`
 * does not exist on the server, so branching on it inline would either crash
 * or hydrate to different markup than the server sent. The first paint uses
 * the Ctrl form and swaps to ⌘ once mounted, which is invisible in practice
 * and keeps hydration clean.
 *
 * Key caps are `aria-hidden` and each row carries an `sr-only` spoken form,
 * because a screen reader meeting "⌘" announces "place of interest sign" or
 * nothing at all. The row reads "Open search, Command K" instead.
 *
 * Opening moves focus into the dialog, which is what announces it — no live
 * region is involved, and adding one would read the whole sheet twice.
 */
export function KeyboardShortcuts({
  shortcuts,
  hotkey = "?",
  open: openProp,
  onOpenChange,
  title = "Keyboard shortcuts",
  closeLabel = "Close",
  className,
}: KeyboardShortcutsProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const isControlled = openProp !== undefined
  const open = isControlled ? openProp : uncontrolledOpen

  const [isApple, setIsApple] = React.useState(false)
  React.useEffect(() => {
    setIsApple(/mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent))
  }, [])

  // Read through refs so the hotkey listener is registered once, not on every
  // render an inline `onOpenChange` arrow would cause.
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const openRef = React.useRef(open)
  openRef.current = open
  const isControlledRef = React.useRef(isControlled)
  isControlledRef.current = isControlled

  const setOpen = React.useCallback((next: boolean) => {
    if (!isControlledRef.current) setUncontrolledOpen(next)
    onOpenChangeRef.current?.(next)
  }, [])

  const enabled = hotkey != null && shortcuts.length > 0
  React.useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== hotkey) return
      // A modified press is somebody else's shortcut.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
      setOpen(!openRef.current)
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [enabled, hotkey, setOpen])

  const dialogRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (!open) return
    const restore = document.activeElement
    dialogRef.current?.focus()
    return () => {
      if (restore instanceof HTMLElement) restore.focus()
    }
  }, [open])

  const headingId = React.useId()

  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key !== "Tab") return
    // Modal: keep Tab inside the sheet.
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    )
    if (focusables.length === 0) {
      e.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === dialogRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  // An empty sheet is a misconfiguration, not a state worth rendering.
  if (!open || shortcuts.length === 0) return null

  const groups = new Map<string, Shortcut[]>()
  for (const s of shortcuts) {
    const g = s.group ?? ""
    const arr = groups.get(g)
    if (arr) arr.push(s)
    else groups.set(g, [s])
  }

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className={cn(
          "w-full max-w-lg overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl outline-none",
          className
        )}
      >
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
          <h2 id={headingId} className="text-sm font-medium">
            {title}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={closeLabel}
            className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Focusable so a keyboard user can scroll a long list (WCAG 2.1.1). */}
        <div
          tabIndex={0}
          role="group"
          aria-label={title}
          className="max-h-[60vh] overflow-y-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {[...groups.entries()].map(([group, rows]) => (
            <section key={group || "_"} className="mb-4 last:mb-0">
              {group ? (
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                  {group}
                </h3>
              ) : null}
              <dl className="divide-y">
                {rows.map((s, i) => {
                  const forms = s.keys.map((k) =>
                    k.trim().toLowerCase() === "then"
                      ? { display: "then", spoken: "then", literal: true }
                      : { ...keyForm(k, isApple), literal: false }
                  )
                  return (
                    <div
                      key={`${s.description}-${i}`}
                      className="flex items-center justify-between gap-6 py-2"
                    >
                      <dt className="text-sm">{s.description}</dt>
                      <dd className="shrink-0">
                        <span className="sr-only">
                          {forms.map((f) => f.spoken).join(" ")}
                        </span>
                        <span aria-hidden="true" className="flex items-center gap-1">
                          {forms.map((f, j) =>
                            f.literal ? (
                              <span key={j} className="text-xs text-muted-foreground">
                                {f.display}
                              </span>
                            ) : (
                              <Kbd key={j}>{f.display}</Kbd>
                            )
                          )}
                        </span>
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
