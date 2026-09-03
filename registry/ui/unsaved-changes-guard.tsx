"use client"

import * as React from "react"
import { TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Warns before the browser itself takes the page away — a closed tab, a reload, a typed URL, a
 * link to another site.
 *
 * Three things about `beforeunload` are not obvious, and a handler that misses any of them is
 * silently useless:
 *
 *   - **Both `preventDefault()` and `returnValue` are needed.** The spec settled on
 *     `preventDefault()`; older engines only look at `returnValue` being set to something. Neither
 *     alone covers every browser in use, and there is no cost to doing both.
 *   - **Custom wording is discarded.** Every current browser shows its own sentence and throws the
 *     string away, so there is nothing to pass in. That is also why this hook is separate from the
 *     dialog below: the message you actually control is the in-app one.
 *   - **It does not fire on a page the user has never touched.** Browsers require sticky activation
 *     — a click, a key, a tap — before they will interrupt a departure. A form that was filled in
 *     has that by definition; a page that was only scrolled does not.
 *
 * The listener is attached only while `when` is true rather than being left on with an early
 * return. Some browsers refuse the back/forward cache to a page that has a `beforeunload` listener
 * registered at all, so an always-on listener slows every back button on the site to protect the
 * one screen that needed it.
 *
 * `bypassRef` is an escape hatch for a caller that is itself about to navigate on purpose: while
 * its `current` is true the warning stays quiet. `useUnsavedChanges` uses it so that the browser's
 * own prompt does not stack on top of the dialog the user has already answered.
 */
export function useBeforeUnload(when: boolean, bypassRef?: React.RefObject<boolean>): void {
  React.useEffect(() => {
    if (!when) return
    const handler = (event: BeforeUnloadEvent) => {
      if (bypassRef?.current) return
      event.preventDefault()
      // Assigned for engines that predate `preventDefault()` being enough. The value is never shown.
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handler)
    return () => window.removeEventListener("beforeunload", handler)
  }, [when, bypassRef])
}

/** How a blocked departure was started. */
export type PendingNavigationKind = "link" | "back"

export interface PendingNavigation {
  /** Whether the user followed a link or used the browser's back/forward control. */
  kind: PendingNavigationKind
  /** Where it was heading, when that is known. */
  href: string | null
}

export interface NavigationGuard {
  /** The departure waiting on an answer, or null when nothing is pending. */
  pending: PendingNavigation | null
  /** Let it happen. */
  proceed: () => void
  /** Stay on the page. */
  cancel: () => void
}

export interface UnsavedChangesOptions {
  /** Whether there is anything to lose. Wire this to your form's dirty state. */
  when: boolean
  /** Intercept clicks on same-origin links. */
  interceptLinks?: boolean
  /** Intercept the back and forward buttons, where the browser allows it (see below). */
  interceptBack?: boolean
}

/** The slice of the Navigation API this component uses, declared locally so no lib update is needed. */
interface NavigateEventLike extends Event {
  readonly navigationType: "push" | "replace" | "reload" | "traverse"
  readonly hashChange: boolean
  readonly downloadRequest: string | null
  readonly destination: { readonly url: string; readonly key: string }
}

interface NavigationLike extends EventTarget {
  traverseTo(key: string): unknown
}

function getNavigation(): NavigationLike | null {
  if (typeof window === "undefined") return null
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation
  return nav && typeof nav.traverseTo === "function" ? nav : null
}

function findAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  const found = target.closest("a[href]")
  return found instanceof HTMLAnchorElement ? found : null
}

/**
 * Holds a departure until the user has answered for it.
 *
 * The reason this is not four lines of `beforeunload` is that `beforeunload` never fires for the
 * way people actually leave a form. Clicking a `next/link` or a React Router `Link` is not an
 * unload: the document stays, the router swaps what is rendered, and the half-filled form is gone
 * without the browser having been involved at all. A guard built on `beforeunload` alone protects
 * the tab button and nothing else — every route change inside the app walks straight past it.
 *
 * So two more mechanisms are needed, and each is used where it is the better one:
 *
 *   - **Links** are caught by a `click` listener on `document` in the capture phase, which runs
 *     before React's own root listener and therefore before any router's handler. Both
 *     `preventDefault()` and `stopPropagation()` are called: routers differ on whether they check
 *     `defaultPrevented`, and stopping the event before it reaches the React root is the part that
 *     is true of all of them. Answering "discard" replays the original click on the same anchor,
 *     so the router handles it exactly as it would have — which is why this path is used for links
 *     in preference to the Navigation API, whose `navigate()` would leave the router behind and
 *     load the document afresh.
 *   - **Back and forward** are caught with the Navigation API's `navigate` event, which is the only
 *     thing in a browser that can refuse a traversal. `popstate` cannot: it is announced after the
 *     history entry has already changed, and the usual workaround — pushing a sentinel entry to
 *     have something to pop — leaves a duplicate entry behind and a back press that appears to do
 *     nothing for the rest of the session. Refusing to ship that is why `interceptBack` is honest
 *     about its reach: where `window.navigation` is missing, back is simply not intercepted, and
 *     the way to cover it is your router's own blocker (see `guard` on `UnsavedChangesGuard`).
 *
 * What is deliberately *not* intercepted: navigation the app starts itself (`router.push` in a
 * submit handler), because the redirect after a successful save is exactly that and blocking it
 * would trap the user on a form they have already submitted; cross-origin links, which
 * `beforeunload` covers and which cannot be replayed without reimplementing `target` and `rel`;
 * hash-only links, which change nothing about the document; and downloads and modified clicks
 * (middle-click, cmd/ctrl-click), which open elsewhere and leave the page where it is.
 */
export function useUnsavedChanges({
  when,
  interceptLinks = true,
  interceptBack = true,
}: UnsavedChangesOptions): NavigationGuard {
  const [pending, setPending] = React.useState<PendingNavigation | null>(null)

  // Read through refs so that the listeners are installed once and not torn down and rebuilt every
  // time the form's dirty flag flips — which, on a form, is every keystroke that matters.
  const whenRef = React.useRef(when)
  whenRef.current = when

  /**
   * What it would take to resume the held departure: the anchor whose click was cancelled, so it
   * can be replayed verbatim, or the history key the traversal was heading for. Kept beside
   * `pending` rather than in it, because neither is anything the dialog renders.
   */
  const targetRef = React.useRef<
    { kind: "link"; anchor: HTMLAnchorElement } | { kind: "back"; key: string } | undefined
  >(undefined)
  /** True for the single replayed click, so the interceptor lets its own replay through. */
  const replayingRef = React.useRef(false)
  /** The traversal that has been allowed, matched by key because `traverseTo` resolves later. */
  const allowedKeyRef = React.useRef<string | undefined>(undefined)
  /** Set once the user has answered "discard", so the browser does not ask the same question again. */
  const bypassRef = React.useRef(false)

  useBeforeUnload(when, bypassRef)

  const clearPending = React.useCallback(() => {
    targetRef.current = undefined
    setPending(null)
  }, [])

  React.useEffect(() => {
    if (!interceptLinks) return

    function onClick(event: MouseEvent) {
      if (replayingRef.current) return
      if (!whenRef.current) return
      if (event.defaultPrevented) return
      // Anything but a plain primary click opens somewhere else and leaves this page alone.
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      const anchor = findAnchor(event.target)
      if (!anchor) return
      if (anchor.hasAttribute("download")) return
      if (anchor.target && anchor.target !== "_self") return

      // `anchor.href` is already resolved, but a `javascript:` or `mailto:` href is not a
      // navigation this guard has any business holding, and `new URL` is how they are told apart.
      let url: URL
      try {
        url = new URL(anchor.href, window.location.href)
      } catch {
        return
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return
      // Leaving the site entirely is the browser's own departure, and `beforeunload` has it.
      if (url.origin !== window.location.origin) return
      // A link to where we already are, or to a fragment of it, keeps the document and the form.
      if (url.pathname === window.location.pathname && url.search === window.location.search) return

      event.preventDefault()
      event.stopPropagation()
      targetRef.current = { kind: "link", anchor }
      setPending({ kind: "link", href: url.href })
    }

    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [interceptLinks])

  React.useEffect(() => {
    if (!interceptBack) return
    const navigation = getNavigation()
    if (!navigation) return

    function onNavigate(event: Event) {
      const navigate = event as NavigateEventLike
      if (navigate.navigationType !== "traverse") return
      if (!whenRef.current) return
      if (navigate.hashChange) return
      if (navigate.downloadRequest !== null) return
      const key = navigate.destination.key
      if (!key) return
      // The traversal this hook let through arrives here as a fresh event; matching on the key is
      // what tells it apart from the user pressing back a second time.
      if (allowedKeyRef.current === key) {
        allowedKeyRef.current = undefined
        return
      }
      // Not every traversal can be refused, and which ones is a browser's decision, so it is asked
      // rather than assumed. An uncancellable one falls through untouched.
      if (!navigate.cancelable) return
      navigate.preventDefault()
      targetRef.current = { kind: "back", key }
      setPending({ kind: "back", href: navigate.destination.url })
    }

    navigation.addEventListener("navigate", onNavigate)
    return () => navigation.removeEventListener("navigate", onNavigate)
  }, [interceptBack])

  // Warnings come back the next time the user does anything on the page. If the departure they
  // agreed to did happen, this listener leaves with the page; if something else cancelled it and
  // they are still here typing, the unsaved work is at risk again and the browser should say so.
  React.useEffect(() => {
    function rearm() {
      bypassRef.current = false
    }
    document.addEventListener("pointerdown", rearm, true)
    document.addEventListener("keydown", rearm, true)
    return () => {
      document.removeEventListener("pointerdown", rearm, true)
      document.removeEventListener("keydown", rearm, true)
    }
  }, [])

  const proceed = React.useCallback(() => {
    const target = targetRef.current
    clearPending()
    bypassRef.current = true
    if (!target) return

    if (target.kind === "link") {
      const { anchor } = target
      if (anchor.isConnected) {
        replayingRef.current = true
        try {
          anchor.click()
        } finally {
          replayingRef.current = false
        }
      } else {
        // The anchor was unmounted while the dialog was open — rare, but a route that re-renders
        // under it can do it. The destination is still known, at the cost of a full page load.
        window.location.assign(anchor.href)
      }
      return
    }

    allowedKeyRef.current = target.key
    getNavigation()?.traverseTo(target.key)
  }, [clearPending])

  return { pending, proceed, cancel: clearPending }
}

export interface UnsavedChangesGuardProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title" | "children">,
    UnsavedChangesOptions {
  /**
   * Replaces the built-in link and back interception with a blocker of your own, which is how a
   * router that has one covers the cases a page cannot see — programmatic navigation, and back in
   * a browser without the Navigation API. React Router:
   *
   * ```tsx
   * const blocker = useBlocker(dirty)
   * <UnsavedChangesGuard
   *   when={dirty}
   *   guard={{
   *     pending: blocker.state === "blocked" ? { kind: "link", href: null } : null,
   *     proceed: () => blocker.proceed?.(),
   *     cancel: () => blocker.reset?.(),
   *   }}
   * />
   * ```
   *
   * `when` still drives the browser-level warning, so the tab button stays covered either way.
   */
  guard?: NavigationGuard
  title?: React.ReactNode
  description?: React.ReactNode
  /** The destructive choice. */
  discardLabel?: string
  /** The safe choice, which is the one that starts focused. */
  keepLabel?: string
}

/**
 * The confirmation a user sees when they are about to walk away from unsaved work.
 *
 * It renders nothing at all until something has been held, so it costs a pair of listeners to
 * leave mounted for the lifetime of a form.
 *
 * The dialog is an `alertdialog` because it interrupts rather than being asked for, and focus lands
 * on **keep editing**, not on discard. A confirmation whose destructive button is pre-focused is
 * answered by the same Enter press that was already on its way to the page, which is the failure
 * the dialog exists to prevent. Escape does the same as keep editing; there is no close button,
 * because a dismissal that is neither answer would leave the navigation in limbo.
 *
 * Colours are shadcn tokens throughout, so it follows light and dark with the rest of the app.
 */
export function UnsavedChangesGuard({
  when,
  guard,
  interceptLinks,
  interceptBack,
  title = "Leave without saving?",
  description = "Your changes have not been saved yet. If you leave now they will be lost.",
  discardLabel = "Discard changes",
  keepLabel = "Keep editing",
  className,
  onKeyDown: onKeyDownProp,
  ...props
}: UnsavedChangesGuardProps) {
  // A supplied guard owns the in-app half; the built-in interception stands down so a single click
  // is not held twice. The hook is still called, because `when` and the unload warning are its job.
  const internal = useUnsavedChanges({
    when,
    interceptLinks: guard ? false : interceptLinks,
    interceptBack: guard ? false : interceptBack,
  })
  const { pending, proceed, cancel } = guard ?? internal

  const dialogRef = React.useRef<HTMLDivElement>(null)
  const keepRef = React.useRef<HTMLButtonElement>(null)
  const open = pending !== null

  React.useEffect(() => {
    if (!open) return
    const restore = document.activeElement
    keepRef.current?.focus()
    return () => {
      // The element that was focused when the dialog opened is the link or the form field the user
      // was on, and a keyboard user who cancels needs to be put back there rather than at the top.
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus()
    }
  }, [open])

  const titleId = React.useId()
  const descriptionId = React.useId()

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDownProp?.(event)
    if (event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key !== "Tab") return
    // Modal: Tab stays inside the dialog.
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? []
    )
    if (focusables.length === 0) {
      event.preventDefault()
      return
    }
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!open) return null

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        {...props}
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "w-full max-w-md rounded-xl border bg-background text-foreground shadow-2xl outline-none",
          className
        )}
      >
        <div className="flex gap-3 p-5">
          <TriangleAlert
            className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div className="space-y-1.5">
            <h2 id={titleId} className="text-sm font-medium">
              {title}
            </h2>
            <p id={descriptionId} className="text-sm text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button
            ref={keepRef}
            type="button"
            onClick={cancel}
            className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            onClick={proceed}
            className="inline-flex h-9 items-center rounded-md bg-destructive px-3 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {discardLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
