"use client"

import * as React from "react"
import { Lightbulb, LightbulbOff } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The Screen Wake Lock entry point, or null where there isn't one.
 *
 * Hand-written because TypeScript will not help here and will in fact actively mislead. Since
 * TS 5.x, `lib.dom.d.ts` declares `readonly wakeLock: WakeLock` on `Navigator` — not optional —
 * so `navigator.wakeLock.request("screen")` type-checks perfectly and then throws
 * `TypeError: Cannot read properties of undefined` at runtime on every browser that hasn't got
 * it, and on every page served over plain http, because this is a secure-context API and the
 * property is simply absent off HTTPS. A component that trusts the type breaks on localhost's
 * http sibling — the staging box on an internal IP — with an error that looks nothing like
 * "unsupported".
 */
function wakeLockOf(): WakeLock | null {
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return null
  const api: WakeLock | undefined = navigator.wakeLock
  return api && typeof api.request === "function" ? api : null
}

/** Whether the screen wake lock can be asked for here at all — browser support plus secure context. */
export function isWakeLockSupported(): boolean {
  return wakeLockOf() !== null
}

interface UseWakeLockOptions {
  /** Ask for the lock as soon as the component mounts. */
  defaultEnabled?: boolean
  /**
   * Called when the setting flips, including when a refusal switches it back off by itself.
   *
   * Not `onChange`: that is a native attribute of `<button>`, so a prop by that name would be
   * spread onto the element as React's change handler as well as read here.
   */
  onEnabledChange?: (enabled: boolean) => void
  /**
   * Called when the browser refuses the lock while the page is visible.
   *
   * Not `onError`, for the same reason the one above is not `onChange`: `onError` is a native DOM
   * attribute that React defines on every element, so a prop by that name collides with it the
   * moment these options are spread onto the `<button>` — the compiler rejects the interface
   * outright, and a version that silenced it would hand React's error handler to this callback and
   * call it with a SyntheticEvent instead of an Error.
   */
  onWakeLockError?: (error: Error) => void
}

interface UseWakeLockResult {
  /**
   * What the user asked for. This is the toggle's own state, and it survives the tab being
   * hidden — the setting is still "keep the screen on" even in the minutes where no lock is held.
   */
  isEnabled: boolean
  /**
   * Whether a lock is being held *right now*.
   *
   * Separate from `isEnabled` on purpose, and the reason this component exists. Collapsing the two
   * into one boolean is what makes every hand-rolled version lie: see the note on the visibility
   * effect below. Read this one if you want to surface "the screen will sleep after all" — it goes
   * false whenever the browser takes the lock back, whatever the reason.
   */
  isActive: boolean
  /**
   * Whether the API is here. Starts `true` so the server and the first client render agree, then
   * settles on mount; read it to hide your own control rather than to pick a label.
   */
  isSupported: boolean
  /** The last refusal, or null. Cleared as soon as a lock is obtained. */
  error: Error | null
  /** Ask to keep the screen on. */
  enable: () => void
  /** Let the screen sleep again. */
  disable: () => void
  /** Flip the setting. */
  toggle: () => void
}

/**
 * The whole behaviour, for a control you lay out yourself.
 *
 * Note what this does *not* need, because it is the opposite of the Fullscreen API and the
 * difference is load-bearing: `wakeLock.request()` does not require a user gesture. It requires
 * the document to be **visible**. That is exactly what makes the re-acquire below possible —
 * there is no click to hang it on when somebody switches back to the tab — and it is also why the
 * request can fail from an effect that a click would have got through.
 */
export function useWakeLock({
  defaultEnabled = false,
  onEnabledChange,
  onWakeLockError,
}: UseWakeLockOptions = {}): UseWakeLockResult {
  const [isEnabled, setIsEnabled] = React.useState(defaultEnabled)
  const [isActive, setIsActive] = React.useState(false)
  const [isSupported, setIsSupported] = React.useState(true)
  const [error, setError] = React.useState<Error | null>(null)

  const sentinelRef = React.useRef<WakeLockSentinel | null>(null)
  // One request at a time. `request()` is async and a hidden/visible flap can call this twice
  // before the first settles, which would leave a second sentinel held with nothing pointing at
  // it — a lock that outlives the toggle and can never be released.
  const pendingRef = React.useRef(false)
  const enabledRef = React.useRef(isEnabled)
  const mountedRef = React.useRef(true)

  // Declared before everything else that reads it. Under StrictMode's deliberate mount/unmount/
  // remount, the cleanup below runs and then the other effects run again; if this one came last,
  // the second pass would see `mountedRef.current === false` and quietly refuse to take the lock,
  // so the component would work in production and do nothing in development.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const onEnabledChangeRef = React.useRef(onEnabledChange)
  React.useEffect(() => {
    onEnabledChangeRef.current = onEnabledChange
  }, [onEnabledChange])

  const onErrorRef = React.useRef(onWakeLockError)
  React.useEffect(() => {
    onErrorRef.current = onWakeLockError
  }, [onWakeLockError])

  const release = React.useCallback(async () => {
    const sentinel = sentinelRef.current
    sentinelRef.current = null
    setIsActive(false)
    if (!sentinel || sentinel.released) return
    try {
      await sentinel.release()
    } catch {
      // Already gone — the browser dropped it between the check and the call.
    }
  }, [])

  const acquire = React.useCallback(async () => {
    const api = wakeLockOf()
    if (!api) {
      // Not "wait and see": there is no API on this origin and there never will be during this
      // page's life. Refusing the setting is the honest answer, because the alternative is a
      // toggle stuck in the on position over a screen that dims on schedule.
      setIsSupported(false)
      setIsEnabled(false)
      const failure = new Error(
        "Screen Wake Lock is unavailable here. It needs a supporting browser and a secure context (https, or localhost)."
      )
      setError(failure)
      onErrorRef.current?.(failure)
      return
    }
    if (pendingRef.current) return
    const held = sentinelRef.current
    if (held && !held.released) return
    // Asking while hidden is a guaranteed NotAllowedError. Skip it and let the visibility handler
    // ask once we are back on screen.
    if (typeof document === "undefined" || document.visibilityState !== "visible") return

    pendingRef.current = true
    try {
      const sentinel = await api.request("screen")
      // The request is async, so the world may have moved on: the user can have switched the
      // toggle off, or navigated away entirely, while it was in flight. Dropping it here is what
      // keeps a lock from surviving the component that owns it.
      if (!mountedRef.current || !enabledRef.current) {
        void sentinel.release().catch(() => {})
        return
      }
      sentinelRef.current = sentinel
      setIsActive(true)
      setError(null)
      sentinel.addEventListener(
        "release",
        () => {
          // The only writer of "the lock is gone", and it fires for reasons that never pass
          // through this component: the tab was hidden, the window was minimised, the battery got
          // low, the OS took it back. A sentinel is single-use — once released it stays released —
          // so the reference is dropped and the next acquire starts a fresh one.
          if (sentinelRef.current === sentinel) sentinelRef.current = null
          setIsActive(false)
        },
        { once: true }
      )
    } catch (err) {
      const failure = err instanceof Error ? err : new Error(String(err))
      // A NotAllowedError raised because the tab went away mid-request is not a refusal, it is a
      // race, and the visibility handler is already going to retry it. Reporting that one would
      // put an error in front of the user every time they switched tabs.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      setIsActive(false)
      setError(failure)
      onErrorRef.current?.(failure)
      // Refused while visible — a permissions policy on the iframe (`allow="screen-wake-lock"` was
      // not granted), or a browser that has decided no. Retrying on a timer would spin, so the
      // setting goes back off and the button stops claiming something untrue.
      setIsEnabled(false)
    } finally {
      pendingRef.current = false
    }
  }, [])

  React.useEffect(() => {
    setIsSupported(isWakeLockSupported())
  }, [])

  // Intent in, action out.
  React.useEffect(() => {
    enabledRef.current = isEnabled
    if (isEnabled) void acquire()
    else void release()
  }, [acquire, isEnabled, release])

  // The core of the whole component.
  //
  // The browser releases a screen wake lock whenever the document stops being visible, and it does
  // it silently — no callback into your code, nothing in the console. Switch to another tab for
  // ten seconds, come back, and a toggle that only tracked its own click still reads "Screen stays
  // on" while the phone dims in the user's hands. The lock has to be taken again on the way back,
  // and the way back is this event.
  React.useEffect(() => {
    if (!isEnabled || typeof document === "undefined") return
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void acquire()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [acquire, isEnabled])

  // Unmounting has to hand the lock back. Nothing else will: the sentinel is owned by the
  // document, not by this component, so navigating from the recipe to the checkout inside a
  // single-page app would otherwise leave the screen pinned awake with no control left to turn it
  // off.
  React.useEffect(() => {
    return () => {
      void release()
    }
  }, [release])

  const reported = React.useRef(isEnabled)
  React.useEffect(() => {
    if (reported.current === isEnabled) return
    reported.current = isEnabled
    onEnabledChangeRef.current?.(isEnabled)
  }, [isEnabled])

  const enable = React.useCallback(() => setIsEnabled(true), [])
  const disable = React.useCallback(() => setIsEnabled(false), [])
  const toggle = React.useCallback(() => setIsEnabled((prev) => !prev), [])

  return { isEnabled, isActive, isSupported, error, enable, disable, toggle }
}

interface WakeLockToggleProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children">,
    UseWakeLockOptions {
  /** Label while the screen is being kept on. */
  onLabel?: string
  /** Label while the screen is free to sleep. */
  offLabel?: string
  /** Label where the API is missing. Kept as the accessible name so the control can explain itself. */
  unsupportedLabel?: string
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
}

/**
 * A toggle that stops the screen going dark, and keeps on being true about it.
 */
export function WakeLockToggle({
  onLabel = "Screen stays on",
  offLabel = "Keep screen on",
  unsupportedLabel = "Keeping the screen on isn't supported here",
  iconOnly = false,
  defaultEnabled,
  onEnabledChange,
  onWakeLockError,
  onClick,
  className,
  ...props
}: WakeLockToggleProps) {
  const { isEnabled, isActive, isSupported, toggle } = useWakeLock({
    defaultEnabled,
    onEnabledChange,
    onWakeLockError,
  })

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented) return
    if (!isSupported) return
    toggle()
  }

  const label = !isSupported ? unsupportedLabel : isEnabled ? onLabel : offLabel
  const Icon = isEnabled ? Lightbulb : LightbulbOff

  return (
    <button
      type="button"
      onClick={handleClick}
      // `aria-pressed` carries the setting, because that is what the user operates and what
      // persists across the hidden stretches where no lock is held. An icon swap is not something
      // a screen reader reports, so it cannot be the only signal.
      aria-pressed={isEnabled}
      // `aria-disabled` rather than `disabled`: a real disabled button leaves the tab order, so a
      // keyboard or screen-reader user never reaches it and never hears why it is not available.
      // This one stays focusable and says so, and the click handler above is what refuses.
      aria-disabled={isSupported ? undefined : true}
      aria-label={iconOnly ? label : undefined}
      data-state={isEnabled ? "on" : "off"}
      // The honest one, for styling or a test: "on" with `data-active="false"` is a setting whose
      // lock is not currently held.
      data-active={isActive ? "true" : "false"}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50 disabled:pointer-events-none disabled:opacity-50",
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
