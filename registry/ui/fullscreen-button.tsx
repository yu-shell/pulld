"use client"

import * as React from "react"
import { Maximize, Minimize } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Which mechanism is showing the target full-screen right now.
 *
 * `"native"` is never written by a click. It is only ever written by the `fullscreenchange`
 * handler after re-reading `document.fullscreenElement`, which is the one thing that makes this
 * component correct: the user can leave full-screen at any moment with Escape, F11 or the
 * browser's own chrome, and none of those go through this button. A component that flips its own
 * boolean when pressed shows "Exit full screen" forever after the first Escape, and no amount of
 * clicking fixes it because the button and the browser now disagree about the world.
 *
 * `"css"` is the opposite: there is no event behind it, so that half is owned state and Escape has
 * to be wired by hand.
 */
type FullscreenMode = "off" | "native" | "css"

/** The prefixed spellings older Safari ships instead of the standard ones. */
interface PrefixedDocument extends Document {
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => void
}

interface PrefixedElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void
}

/**
 * The inline styles the CSS fallback writes onto the target, and the reason each one is there.
 *
 * Inline rather than a class list because these have to beat whatever the target already wears:
 * a panel with `h-64 max-w-md rounded-lg` keeps its 256px height under `position: fixed; inset: 0`
 * — an explicit height wins over an over-constrained box — so a fallback built from classes
 * produces a small rounded card pinned to the top-left corner instead of a full screen. Every
 * property's previous inline value is saved and restored on exit, so nothing is guessed on the way
 * back out.
 */
const CSS_FULLSCREEN_STYLE: Readonly<Record<string, string>> = {
  position: "fixed",
  inset: "0",
  margin: "0",
  // `auto` so the inset drives the size instead of a declared width/height.
  width: "auto",
  height: "auto",
  "max-width": "none",
  "max-height": "none",
  // A min-width wider than the viewport would scroll the page sideways.
  "min-width": "0",
  "min-height": "0",
  // Rounded corners would let the page show through at the four corners.
  "border-radius": "0",
  "z-index": "50",
  overflow: "auto",
}

/** The document that owns `target` — not the global one, which is a different document in an iframe. */
function documentOf(target: HTMLElement | null): Document | null {
  if (target) return target.ownerDocument ?? null
  return typeof document === "undefined" ? null : document
}

/** The element the browser considers full-screen, or null. */
function fullscreenElementOf(doc: Document): Element | null {
  const prefixed = doc as PrefixedDocument
  return doc.fullscreenElement ?? prefixed.webkitFullscreenElement ?? null
}

/**
 * Whether this element can be shown full-screen by the browser at all.
 *
 * False on an iPhone, where Safari has element full-screen for `<video>` and nothing else — the
 * method is simply absent — and false inside an iframe that was embedded without
 * `allow="fullscreen"`, where the method exists and the request is refused.
 */
export function isFullscreenSupported(target: HTMLElement | null): boolean {
  const doc = documentOf(target)
  if (!doc) return false
  const el = (target ?? doc.documentElement) as PrefixedElement | null
  if (!el) return false
  const hasMethod =
    typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function"
  if (!hasMethod) return false
  // `fullscreenEnabled` is how a document reports the permissions policy. Only trust it when the
  // browser actually implements it; an older engine that leaves it undefined is not saying "no".
  const enabled = doc.fullscreenEnabled
  return enabled === undefined ? true : enabled
}

/** `rgba(0, 0, 0, 0)` and `transparent` are what a computed style says when nothing is painted. */
function isTransparent(color: string): boolean {
  return !color || color === "transparent" || /,\s*0\s*\)$/.test(color)
}

/**
 * A colour to paint behind the target while the CSS fallback is up, or null if it paints itself.
 *
 * The real API puts an opaque backdrop behind the full-screen element; `position: fixed` does not,
 * so a chart with a transparent background would be laid over the page it came from and the old
 * layout would read straight through it. The colour is taken from the nearest ancestor that paints
 * one — a resolved `rgb()` from the live page, which stays right in both themes without this
 * component having to know which token the design uses.
 */
function backdropFor(target: HTMLElement): string | null {
  const view = target.ownerDocument?.defaultView
  if (!view || typeof view.getComputedStyle !== "function") return null
  if (!isTransparent(view.getComputedStyle(target).backgroundColor)) return null
  let node = target.parentElement
  while (node) {
    const color = view.getComputedStyle(node).backgroundColor
    if (!isTransparent(color)) return color
    node = node.parentElement
  }
  return null
}

interface UseFullscreenOptions {
  /**
   * Cover the viewport with CSS where the browser has no element full-screen, or refuses it.
   * Defaults to true: an iPhone is not an edge case, and a button that does nothing at all there
   * is worse than one that expands the panel by other means.
   */
  cssFallback?: boolean
  /**
   * Called when the target enters or leaves full screen, however it happened — Escape included.
   *
   * Not `onChange`: that is a native attribute of `<button>`, and a prop by that name would be
   * spread onto the element as React's change handler as well as read here.
   */
  onFullscreenChange?: (isFullscreen: boolean) => void
}

interface UseFullscreenResult {
  /** True while the target is full-screen by either mechanism. */
  isFullscreen: boolean
  /** Which mechanism is doing it — `"css"` means the fallback is up rather than the real thing. */
  mode: FullscreenMode
  /**
   * Whether the browser can do this natively. Starts as `true` so the server and the first client
   * render agree, then settles on mount; read it to hide your own control, not to pick a label.
   */
  isSupported: boolean
  /** Ask for full screen. Call it inside the click, with nothing awaited first. */
  enter: () => void
  /** Leave full screen, whichever mechanism is up. */
  exit: () => void
  /** Enter or leave, depending on where the browser says we are right now. */
  toggle: () => void
}

/**
 * The whole behaviour, for a control you lay out yourself.
 *
 * `targetRef` points at the element to expand — a chart, a table, a map, a preview pane. Put your
 * button *inside* that element: everything outside it is not rendered while it is full-screen, so
 * a button that lives beside the chart vanishes the moment it is pressed, taking the keyboard
 * focus with it and leaving Escape as the only way back.
 */
export function useFullscreen(
  targetRef: React.RefObject<HTMLElement | null>,
  { cssFallback = true, onFullscreenChange }: UseFullscreenOptions = {}
): UseFullscreenResult {
  const [mode, setMode] = React.useState<FullscreenMode>("off")
  const [isSupported, setIsSupported] = React.useState(true)

  // The inline values the fallback overwrote, so exiting restores the target exactly.
  const savedStyle = React.useRef<Record<string, string> | null>(null)

  const onChangeRef = React.useRef(onFullscreenChange)
  React.useEffect(() => {
    onChangeRef.current = onFullscreenChange
  }, [onFullscreenChange])

  const clearCss = React.useCallback(() => {
    const target = targetRef.current
    const saved = savedStyle.current
    savedStyle.current = null
    if (!target || !saved) return
    for (const [prop, value] of Object.entries(saved)) {
      if (value) target.style.setProperty(prop, value)
      else target.style.removeProperty(prop)
    }
    target.removeAttribute("data-fullscreen")
  }, [targetRef])

  const applyCss = React.useCallback(() => {
    const target = targetRef.current
    if (!target || savedStyle.current) return
    const saved: Record<string, string> = {}
    const wanted = { ...CSS_FULLSCREEN_STYLE } as Record<string, string>
    const backdrop = backdropFor(target)
    if (backdrop) wanted["background-color"] = backdrop
    for (const [prop, value] of Object.entries(wanted)) {
      saved[prop] = target.style.getPropertyValue(prop)
      target.style.setProperty(prop, value)
    }
    savedStyle.current = saved
    // A hook for the caller's own styling, and the same name the real thing answers to in CSS.
    target.setAttribute("data-fullscreen", "css")
    setMode("css")
  }, [targetRef])

  const exit = React.useCallback(() => {
    if (savedStyle.current) {
      clearCss()
      setMode("off")
      return
    }
    const target = targetRef.current
    const doc = documentOf(target)
    if (!doc) return
    // Only ours. Another component on the page may own the current full-screen element, and
    // calling exit on the document would yank it out from under them.
    if (!target || fullscreenElementOf(doc) !== target) return
    const prefixed = doc as PrefixedDocument
    if (typeof doc.exitFullscreen === "function") void doc.exitFullscreen()
    else prefixed.webkitExitFullscreen?.()
  }, [clearCss, targetRef])

  const enter = React.useCallback(() => {
    const target = targetRef.current as PrefixedElement | null
    if (!target) return
    const request =
      typeof target.requestFullscreen === "function"
        ? target.requestFullscreen
        : target.webkitRequestFullscreen

    if (typeof request !== "function") {
      if (cssFallback) applyCss()
      return
    }

    // Called with nothing awaited ahead of it. `requestFullscreen` is only granted while the click
    // is still the active user gesture, so a version that measures the element or fetches
    // something first rejects with NotAllowedError — on a button that worked in development,
    // because the await was fast there.
    let result: Promise<void> | void
    try {
      result = request.call(target)
    } catch {
      if (cssFallback) applyCss()
      return
    }
    if (result && typeof result.then === "function") {
      result.then(undefined, () => {
        // The refusal arrives after the gesture is spent — an iframe without `allow="fullscreen"`
        // is the common one — so the fallback is the only thing left that can still work.
        if (cssFallback) applyCss()
      })
    }
    // Nothing is set here on success: `fullscreenchange` is what says we got it.
  }, [applyCss, cssFallback, targetRef])

  const toggle = React.useCallback(() => {
    const target = targetRef.current
    const doc = documentOf(target)
    const active = !!savedStyle.current || (!!doc && !!target && fullscreenElementOf(doc) === target)
    if (active) exit()
    else enter()
  }, [enter, exit, targetRef])

  // The subscription. This is the only writer of `"native"`.
  React.useEffect(() => {
    const target = targetRef.current
    const doc = documentOf(target)
    if (!doc) return

    setIsSupported(isFullscreenSupported(target))

    const sync = () => {
      const current = targetRef.current
      const isNative = !!current && fullscreenElementOf(doc) === current
      setMode((prev) => {
        if (isNative) return "native"
        // Leaving native full-screen must not clear a fallback that is legitimately up.
        return prev === "css" ? "css" : "off"
      })
    }

    // Read once on mount too: this component can be mounted into an element that is already
    // full-screen — a remount behind a changed `key`, or a panel that renders late.
    sync()
    doc.addEventListener("fullscreenchange", sync)
    doc.addEventListener("webkitfullscreenchange", sync)
    return () => {
      doc.removeEventListener("fullscreenchange", sync)
      doc.removeEventListener("webkitfullscreenchange", sync)
    }
  }, [targetRef])

  // Escape, for the fallback only. The real API has its own, and doubling it up would exit twice.
  React.useEffect(() => {
    if (mode !== "css") return
    const doc = documentOf(targetRef.current)
    if (!doc) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      clearCss()
      setMode("off")
    }
    doc.addEventListener("keydown", onKeyDown)
    return () => doc.removeEventListener("keydown", onKeyDown)
  }, [clearCss, mode, targetRef])

  // Unmounting with the fallback up would leave the target pinned over the page for good. Native
  // full-screen is deliberately left alone: the browser drops it when the element goes away, and
  // forcing an exit because a button unmounted would be the button overruling the user.
  React.useEffect(() => clearCss, [clearCss])

  const isFullscreen = mode !== "off"
  const reported = React.useRef(isFullscreen)
  React.useEffect(() => {
    if (reported.current === isFullscreen) return
    reported.current = isFullscreen
    onChangeRef.current?.(isFullscreen)
  }, [isFullscreen])

  return { isFullscreen, mode, isSupported, enter, exit, toggle }
}

interface FullscreenButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children">,
    UseFullscreenOptions {
  /** The element to expand. Put this button inside it — see `useFullscreen`. */
  targetRef: React.RefObject<HTMLElement | null>
  /** Label while the target is windowed. */
  enterLabel?: string
  /** Label while the target is full-screen. */
  exitLabel?: string
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
}

/**
 * A button that shows one element full-screen, and keeps telling the truth about it afterwards.
 */
export function FullscreenButton({
  targetRef,
  enterLabel = "Fullscreen",
  exitLabel = "Exit fullscreen",
  iconOnly = false,
  cssFallback,
  onFullscreenChange,
  onClick,
  className,
  ...props
}: FullscreenButtonProps) {
  const { isFullscreen, mode, toggle } = useFullscreen(targetRef, { cssFallback, onFullscreenChange })

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    // Straight into the gesture — see the note in `enter`.
    toggle()
  }

  const label = isFullscreen ? exitLabel : enterLabel
  const Icon = isFullscreen ? Minimize : Maximize

  return (
    <button
      type="button"
      onClick={handleClick}
      // The state is carried by `aria-pressed` rather than by the icon, which a screen reader does
      // not report, and it is re-derived from the document on every change — so it is still right
      // after the user presses Escape.
      aria-pressed={isFullscreen}
      aria-label={iconOnly ? label : undefined}
      data-state={isFullscreen ? "fullscreen" : "windowed"}
      data-fullscreen-mode={mode}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        iconOnly ? "w-9" : "px-4",
        className
      )}
      {...props}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {iconOnly ? null : label}
    </button>
  )
}
