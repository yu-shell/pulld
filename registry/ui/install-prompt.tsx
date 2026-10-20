"use client"

import * as React from "react"
import { Download, Share } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The event Chromium fires once it has decided a page is installable.
 *
 * It is not in lib.dom — the specification never shipped outside Chromium — so
 * `addEventListener("beforeinstallprompt", ...)` hands you a plain `Event` with none of the three
 * members that matter. Declared locally rather than as a global augmentation, so installing this
 * file into an app that already declares it somewhere cannot collide.
 */
export interface BeforeInstallPromptEvent extends Event {
  /** The install targets the browser would offer. Usually `["web"]`, and empty on some desktops. */
  readonly platforms: readonly string[]
  /** Resolves once the person has answered the browser's own install dialog. */
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>
  /** Opens that dialog. Honoured only during a user gesture, and only once per event. */
  prompt(): Promise<void>
}

/**
 * The property on `window` where a captured event is parked.
 *
 * It is a named constant because two separate programs have to meet on it: the snippet in `<head>`
 * (see `earlyCaptureScript`) and this module. A typo in either is not an error anywhere — it is a
 * button that silently never appears, on somebody else's machine.
 */
export const INSTALL_CAPTURE_KEY = "__installPromptCapture"

interface InstallCapture {
  /** The most recent `beforeinstallprompt`, held until it is spent. */
  event: BeforeInstallPromptEvent | null
  /** Whether `appinstalled` has fired in this document. */
  installed: boolean
}

/**
 * The snippet to inline in `<head>`, ahead of the application's own JavaScript.
 *
 * This is the part that decides whether any of the rest works, and it is the answer to the single
 * most common report about PWA install buttons — "it never shows up on my machine, but it does on
 * yours". `beforeinstallprompt` fires once, early, and does not replay: Chrome dispatches it as
 * soon as its own heuristics are satisfied, which on a warm cache is routinely before a React
 * bundle has been parsed, never mind hydrated. A listener added in `useEffect` is not late by a
 * frame, it is late by the whole load, and it will keep passing in development — where the bundle
 * arrives first — while failing in production. Registering at module scope (this file does, below)
 * moves it earlier by however long hydration takes, and that is enough on most loads. It is not
 * enough on all of them, and nothing inside the bundle can be: the fix has to run before the bundle
 * exists, which means a few lines of inline script.
 *
 * Next.js (app router), in `app/layout.tsx` inside `<head>`:
 *
 * ```tsx
 * <script dangerouslySetInnerHTML={{ __html: earlyCaptureScript() }} />
 * ```
 *
 * Vite and plain HTML, in `index.html` before the module script:
 *
 * ```html
 * <script>
 *   // paste the output of earlyCaptureScript() here
 * </script>
 * ```
 *
 * It is written against no framework and touches nothing but one property it owns, so it is safe
 * to ship whether or not this component is on the page. Leaving it out is supported — the module
 * scope listener still catches the common case — so treat it as the difference between "usually
 * works" and "works".
 */
export function earlyCaptureScript(): string {
  const key = JSON.stringify(INSTALL_CAPTURE_KEY)
  return (
    `(function(w){var c=w[${key}]=w[${key}]||{event:null,installed:false};` +
    `w.addEventListener("beforeinstallprompt",function(e){e.preventDefault();c.event=e});` +
    `w.addEventListener("appinstalled",function(){c.event=null;c.installed=true})})(window)`
  )
}

const listeners = new Set<() => void>()
let capturing = false

/** The shared parking space, created on first use. Null on the server, where there is no window. */
function capture(): InstallCapture | null {
  if (typeof window === "undefined") return null
  const host = window as unknown as Record<string, InstallCapture | undefined>
  const existing = host[INSTALL_CAPTURE_KEY]
  if (existing) return existing
  const fresh: InstallCapture = { event: null, installed: false }
  host[INSTALL_CAPTURE_KEY] = fresh
  return fresh
}

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * Attaches the two window listeners, once per document.
 *
 * Safe to call repeatedly — the hook calls it on every mount — because the whole point is that the
 * listeners outlive any component. They are deliberately never removed: an unmounting button must
 * not throw away an event that will not be sent again, and two listeners on one window cost
 * nothing. The capture they write to is on `window` rather than in this module so that a page which
 * somehow loads two copies of this file (two bundles, a micro-frontend) still shares one event —
 * module state would give each copy its own, and the second would believe there is nothing to
 * install.
 */
function startCapturing(): void {
  if (capturing) return
  const store = capture()
  if (!store) return
  capturing = true
  window.addEventListener("beforeinstallprompt", (event) => {
    // Without this the browser shows its own install affordance as well, which is the thing an
    // app renders its own button in order to place and time itself.
    event.preventDefault()
    store.event = event as BeforeInstallPromptEvent
    emit()
  })
  window.addEventListener("appinstalled", () => {
    // The event is spent the moment the app is installed, and the browser will not send another.
    store.event = null
    store.installed = true
    emit()
  })
}

// At module scope on purpose — see `earlyCaptureScript`. This runs when the chunk is evaluated,
// which is before hydration and therefore before any effect this component could schedule.
startCapturing()

/**
 * The display modes a document is in when it is running as an installed app rather than in a tab.
 *
 * All four, not just `standalone`: a manifest can ask for `fullscreen` or `minimal-ui`, and an
 * installed desktop app that draws into its own title bar reports `window-controls-overlay`. A
 * check against `standalone` alone offers to install the app to somebody already inside it.
 */
const INSTALLED_DISPLAY_MODES = [
  "standalone",
  "fullscreen",
  "minimal-ui",
  "window-controls-overlay",
] as const

/**
 * Whether this document is already running as an installed app.
 *
 * Note what it does not answer: whether the app is installed. Those are different questions, and
 * only the first one is knowable from a browser tab. A person who installed the app yesterday and
 * is reading the site in Chrome today is in `display-mode: browser` like anybody else. Chromium
 * covers that case from the other side — it does not fire `beforeinstallprompt` for an app it has
 * already installed — so the button stays away regardless. iOS has no equivalent, which is the
 * honest limit of the `"instructions"` state below.
 */
export function isRunningInstalled(): boolean {
  if (typeof window === "undefined") return false
  // iOS exposes it as a property on navigator and has never implemented the media feature.
  const nav = window.navigator as Navigator & { standalone?: boolean }
  if (nav.standalone === true) return true
  if (typeof window.matchMedia !== "function") return false
  return INSTALLED_DISPLAY_MODES.some((mode) => window.matchMedia(`(display-mode: ${mode})`).matches)
}

/**
 * Whether this is an iOS-family browser, where the install event does not exist at all.
 *
 * Sniffing the user agent, which is normally the wrong instrument, and here is the only one: the
 * question is precisely "which browser am I", because the capability it stands in for — adding a
 * site to the home screen — is reachable from a menu this page cannot see, feature-detect or open.
 * Every browser on iOS is WebKit underneath and all of them route it through the share sheet, so
 * the branch is the platform and not the brand.
 *
 * The second test is iPadOS 13 and later, which reports itself as a Macintosh. A touchscreen is
 * what separates it from a real one: desktop Safari reports `maxTouchPoints` of 0.
 */
export function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false
  const ua = navigator.userAgent
  if (/iphone|ipod|ipad/i.test(ua)) return true
  return /macintosh/i.test(ua) && navigator.maxTouchPoints > 1
}

/** What, if anything, there is to offer right now. */
export type InstallAvailability =
  /** A captured event is in hand: a press opens the browser's install dialog. */
  | "available"
  /** The platform installs web apps but has no API for it — show the manual steps instead. */
  | "instructions"
  /** This document is already running as an installed app. */
  | "installed"
  /** Nothing to offer, and nothing to say about it. */
  | "unavailable"

/** How a press ended. `"unavailable"` covers a spent event and a dialog the browser refused to open. */
export type InstallOutcome = "accepted" | "dismissed" | "unavailable"

export interface UseInstallPromptOptions {
  /**
   * Report `"instructions"` on platforms that can install but cannot be asked. Pass `false` to
   * treat those as `"unavailable"` and show nothing at all.
   */
  instructions?: boolean
  /** Called once the person has answered the browser's dialog. */
  onOutcome?: (outcome: InstallOutcome) => void
}

export interface InstallPromptState {
  /** What there is to offer. Always `"unavailable"` on the first render — see below. */
  status: InstallAvailability
  /**
   * Opens the browser's install dialog and resolves with the answer.
   *
   * Call it directly from the click handler. See the comment in the body for why nothing may be
   * awaited in front of it.
   */
  promptToInstall: () => Promise<InstallOutcome>
}

/**
 * Whether an install can be offered, and the one function that offers it.
 *
 * The first render always reports `"unavailable"`, on the server and on the client alike, and the
 * effect corrects it a frame later. That is the opposite default to the one a connection indicator
 * takes — there, assuming the worst would flash an offline banner at everybody — because here the
 * pessimistic answer is the one that renders nothing. Reading `matchMedia` or the parked event
 * during render instead would be a hydration mismatch on every page that server-renders, and
 * reading it in a `useState` initialiser is the same bug wearing a different hat.
 *
 * Three states and not two, because "cannot install" and "can install, but not by asking" need
 * different interfaces, and collapsing them is how an iPhone ends up being shown nothing at all on
 * the platform where adding to the home screen is most useful.
 */
export function useInstallPrompt(options: UseInstallPromptOptions = {}): InstallPromptState {
  const { instructions = true, onOutcome } = options

  const [status, setStatus] = React.useState<InstallAvailability>("unavailable")

  // Read through a ref so that passing the callback inline — which every caller does — does not
  // tear the subscription down and build it up again on every render.
  const onOutcomeRef = React.useRef(onOutcome)
  onOutcomeRef.current = onOutcome

  React.useEffect(() => {
    function read() {
      const store = capture()
      const next: InstallAvailability =
        store?.installed === true || isRunningInstalled()
          ? "installed"
          : store?.event
            ? "available"
            : instructions && isIosLike()
              ? "instructions"
              : "unavailable"
      setStatus((previous) => (previous === next ? previous : next))
    }

    // Subscribed before the first read, so an event arriving in between is not dropped into the
    // gap. Reading first and subscribing second is the ordinary version of this bug.
    listeners.add(read)
    startCapturing()
    read()

    // A document can enter an installed display mode without being reloaded — accepting the
    // browser's dialog in a desktop window is the usual way — so the media query is watched rather
    // than sampled once.
    const media =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(display-mode: standalone)")
        : null
    media?.addEventListener("change", read)

    return () => {
      listeners.delete(read)
      media?.removeEventListener("change", read)
    }
  }, [instructions])

  const promptToInstall = React.useCallback(async (): Promise<InstallOutcome> => {
    const store = capture()
    const event = store?.event
    if (!store || !event) return "unavailable"

    // Spent before anything is awaited, for two reasons that look like one. `prompt()` on an event
    // that has already been prompted rejects, and a second click can land while `userChoice` is
    // still unresolved — the dialog does not block this page's event loop. Published immediately
    // after, so the button reflects the spent event even if the call below never resolves.
    store.event = null
    emit()

    try {
      // Called with nothing awaited in front of it. The browser honours `prompt()` only while the
      // click that led here is still the active user gesture, so an `await` first — reading a flag,
      // asking an API whether to offer this — is what turns a working button into NotAllowedError.
      // Inside the `try` rather than ahead of it: a browser that throws from `prompt()` instead of
      // returning a rejected promise would otherwise leave the click with an unhandled rejection.
      await event.prompt()
      const { outcome } = await event.userChoice
      onOutcomeRef.current?.(outcome)
      return outcome
    } catch {
      // A refused or already-spent prompt. Not reported as a dismissal: nobody declined anything.
      onOutcomeRef.current?.("unavailable")
      return "unavailable"
    }
  }, [])

  return { status, promptToInstall }
}

export interface InstallPromptProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange">,
    UseInstallPromptOptions {
  /** Label of the install button. */
  label?: React.ReactNode
  /** Label of the button that reveals the manual steps. */
  instructionsLabel?: React.ReactNode
  /** The manual steps. Replace them to re-word, translate, or describe a different browser. */
  steps?: React.ReactNode
}

const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

const DEFAULT_STEPS = (
  <ol className="m-0 list-decimal space-y-1 pl-4">
    <li>
      Tap the <span className="font-medium text-foreground">Share</span> button in the browser
      toolbar.
    </li>
    <li>
      Choose <span className="font-medium text-foreground">Add to Home Screen</span>.
    </li>
    <li>
      Tap <span className="font-medium text-foreground">Add</span>.
    </li>
  </ol>
)

/**
 * The install button, rendered only when there is genuinely something to install.
 *
 * It returns `null` whenever there is not — already installed, not installable, or the event has
 * been spent — so it can be left mounted wherever it belongs in the layout instead of being
 * wrapped in a condition the page has to work out for itself. Because the first render is always
 * the empty one, nothing flashes in and back out again on a page that server-renders.
 *
 * The root stays a `<div>` in both states, so a page does not re-flow when a device turns out to
 * be the one that needs the steps rather than the button.
 *
 * Every colour is a shadcn token, so it follows light and dark. For a button of your own design,
 * take `useInstallPrompt` and leave this one out; all of the detection is in the hook.
 *
 * One thing it deliberately does not do: remember a refusal. Chromium may fire
 * `beforeinstallprompt` again on the next visit, and whether somebody who said no yesterday should
 * be asked today is a product decision with no safe default — a shopping site and an internal tool
 * want opposite answers. Use `onOutcome` to record it and stop rendering this, or compose it with
 * a dismissal that is already remembered, the way `announcement-bar` does.
 */
export function InstallPrompt({
  label = "Install app",
  instructionsLabel = "Add to Home Screen",
  steps = DEFAULT_STEPS,
  instructions = true,
  onOutcome,
  className,
  ...props
}: InstallPromptProps) {
  const { status, promptToInstall } = useInstallPrompt({ instructions, onOutcome })
  const [open, setOpen] = React.useState(false)
  const panelId = React.useId()

  if (status === "installed" || status === "unavailable") return null

  return (
    <div className={cn("inline-flex flex-col items-start gap-2", className)} {...props}>
      {status === "available" ? (
        <button type="button" onClick={() => void promptToInstall()} className={BUTTON_CLASS}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {label}
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen((previous) => !previous)}
            aria-expanded={open}
            aria-controls={panelId}
            className={BUTTON_CLASS}
          >
            <Share className="h-4 w-4" aria-hidden="true" />
            {instructionsLabel}
          </button>
          {/*
            Rendered whether or not it is open, and hidden with the attribute rather than by being
            left out of the tree: `aria-controls` above has to point at an element that exists, and
            a panel that only appears once it is needed cannot be found by the control that names
            it. No display utility is set on this element, so the attribute's own `display: none`
            is what takes effect.
          */}
          <div
            id={panelId}
            hidden={!open}
            className="max-w-xs rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground"
          >
            {steps}
          </div>
        </>
      )}
    </div>
  )
}
