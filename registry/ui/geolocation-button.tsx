"use client"

import * as React from "react"
import { Loader2, LocateFixed, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * `GeolocationPositionError.code` values, written out rather than read off the instance.
 *
 * The constants live on the error object the browser hands you, so `err.PERMISSION_DENIED` works —
 * but only when the thing you are holding really is a `GeolocationPositionError`. Anything that
 * hands this component a plain object shaped like one (a test, a polyfill, a wrapper that
 * serialised the error across a boundary) has the code and not the constants, and a comparison
 * against `err.PERMISSION_DENIED` then compares `1` with `undefined` and silently takes the wrong
 * branch. The numbers are fixed by the specification and are never going to move.
 */
const PERMISSION_DENIED = 1
const POSITION_UNAVAILABLE = 2
const TIMEOUT = 3

/**
 * The Geolocation entry point, or null where there isn't one.
 *
 * Hand-written because TypeScript declares `readonly geolocation: Geolocation` on `Navigator` —
 * not optional — so `navigator.geolocation.getCurrentPosition(...)` type-checks and then throws
 * a TypeError on anything that hasn't got it.
 */
function geolocationOf(): Geolocation | null {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null
  const api: Geolocation | undefined = navigator.geolocation
  return api && typeof api.getCurrentPosition === "function" ? api : null
}

/**
 * Whether the API exists here at all.
 *
 * Deliberately *not* a check for whether it will work. Read the note on `insecureContext` below:
 * this returning true is compatible with every single call failing, which is the whole reason the
 * usual feature-detect is not enough.
 */
export function isGeolocationSupported(): boolean {
  return geolocationOf() !== null
}

/**
 * Whether this page is a non-secure context, where the API is present and permanently broken.
 *
 * This is the one that costs an afternoon. Geolocation is gated on secure contexts, so the
 * reasonable assumption is that `navigator.geolocation` is simply absent over plain http and a
 * feature-detect catches it. It is not absent. The specification does not mark the attribute
 * `[SecureContext]` — the IDL is a plain `readonly attribute Geolocation geolocation` — and the
 * gate lives inside the algorithm instead: "request a position" checks for a non-secure context
 * and calls back with **PERMISSION_DENIED**.
 *
 * So on the http staging box on an internal IP, the object is there, the feature-detect passes,
 * the call is made, no prompt ever appears, and what comes back is the same code a user gets for
 * pressing Block. A component that maps that code to "you have blocked location access, change it
 * in your browser settings" sends everyone hunting through a settings screen for a switch that is
 * not the problem and cannot fix it. Checked before calling so the message can say the true thing.
 */
function insecureContext(): boolean {
  // `isSecureContext` is itself missing on old enough browsers, and "missing" must not read as
  // "insecure" — that would refuse to work on the very browsers this is meant to degrade for.
  return typeof window !== "undefined" && window.isSecureContext === false
}

/**
 * Whether Permissions Policy forbids geolocation in this document, where that can be asked.
 *
 * The second producer of an unexplained PERMISSION_DENIED, and it sits one step above the
 * secure-context check in the same algorithm. The default allowlist for the feature is `'self'`,
 * so an `<iframe>` embedding this page without `allow="geolocation"` is refused, as is any origin
 * serving `Permissions-Policy: geolocation=()`. Neither is something the person looking at the
 * screen can do anything about, and neither shows a prompt.
 *
 * The accessor is not in the DOM typings and is absent in some browsers, so this is best-effort:
 * false means "not known to be blocked", never "allowed".
 */
function blockedByPermissionsPolicy(): boolean {
  if (typeof document === "undefined") return false
  type Policy = { allowsFeature?: (feature: string) => boolean }
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy }
  const policy = doc.permissionsPolicy ?? doc.featurePolicy
  if (!policy || typeof policy.allowsFeature !== "function") return false
  try {
    return !policy.allowsFeature("geolocation")
  } catch {
    return false
  }
}

/**
 * Reads the stored permission without prompting, or null where that cannot be asked.
 *
 * This is the lever the whole component turns on. `getCurrentPosition` is the only other way to
 * learn the permission state and it *acts* — it can put a prompt in front of someone who never
 * asked for one. `permissions.query` answers the same question silently, which is what makes it
 * possible to tell the four different things PERMISSION_DENIED means apart.
 *
 * Guarded twice over. `navigator.permissions` is declared non-optional by TypeScript and is
 * genuinely absent in older browsers, and a browser that *has* the Permissions API may still not
 * recognise this particular descriptor, in which case `query` rejects with a TypeError instead of
 * answering. The API also arrived late here — Safari only shipped `query` in 16 — so not knowing
 * is an ordinary answer rather than an error, and every path below has to work without it.
 */
async function queryGeolocationPermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !("permissions" in navigator)) return null
  const permissions: Permissions | undefined = navigator.permissions
  if (!permissions || typeof permissions.query !== "function") return null
  try {
    return await permissions.query({ name: "geolocation" })
  } catch {
    return null
  }
}

/**
 * Why a request failed — worked out, not guessed.
 *
 * Four of these arrive as the identical `PERMISSION_DENIED`, and they need four different things
 * from four different people: `denied` is the user's own stored choice, `dismissed` is a prompt
 * closed without an answer, `insecure-context` and `blocked-by-policy` are the developer's to fix
 * and are invisible to the user.
 */
export type GeolocationFailureCause =
  | "unsupported"
  | "insecure-context"
  | "blocked-by-policy"
  | "denied"
  | "dismissed"
  | "unavailable"
  | "timeout"

export interface GeolocationFailure {
  cause: GeolocationFailureCause
  /** The browser's own code, or null when this was settled before any call was made. */
  code: number | null
  /** Wording safe to show as-is. Override per cause with the `messages` prop. */
  message: string
  /**
   * Whether asking again, right now, can produce a different answer.
   *
   * False for `denied` is the point of the component. Once the stored state is "denied" the
   * specification has `getCurrentPosition` call back with PERMISSION_DENIED **without prompting**,
   * so a "Try again" button is a button that cannot work: it will return the same error, instantly,
   * for as long as the page is open. The only way out runs through the browser's own site settings,
   * which is why the copy for that case points there — and why the permission `change` listener
   * below exists, so that coming back from those settings costs nothing.
   */
  retryable: boolean
}

/** Where a request has got to. `prompting` is the browser's permission dialog being answered. */
export type GeolocationPhase = "idle" | "prompting" | "locating" | "success" | "error"

const RETRYABLE: Record<GeolocationFailureCause, boolean> = {
  unsupported: false,
  "insecure-context": false,
  "blocked-by-policy": false,
  denied: false,
  dismissed: true,
  unavailable: true,
  timeout: true,
}

const DEFAULT_MESSAGES: Record<GeolocationFailureCause, string> = {
  unsupported: "This browser can't share your location.",
  "insecure-context":
    "Location needs a secure (https) connection, so the browser refused without asking.",
  "blocked-by-policy": "This page isn't permitted to use location.",
  denied:
    "Location is blocked for this site. Allow it in your browser's site settings — this page can't ask again.",
  dismissed: "The location request was dismissed.",
  unavailable: "Your location couldn't be determined.",
  timeout: "Finding your location took too long.",
}

export interface UseGeolocationOptions {
  /** Ask the device for its best fix. Costs battery and time; off by default. */
  enableHighAccuracy?: boolean
  /**
   * How long the device may spend acquiring a fix, in milliseconds.
   *
   * Defaulted, and never left alone, because **the browser's own default is `Infinity`**. Omit it
   * and a phone indoors, in a lift, in a basement or in aeroplane mode neither succeeds nor fails:
   * it hangs, and the spinner is still turning when the user gives up. Note what it does *not*
   * cover — see `phase`.
   */
  timeout?: number
  /**
   * How old a cached fix may be, in milliseconds. 0 (the browser's default) always measures afresh.
   *
   * Worth raising for an address form or a store finder, where a reading from a minute ago is the
   * same reading and arrives instantly instead of waking the GPS. One catch: the cache is only
   * consulted when this is greater than 0, and a cached fix is only reused when its accuracy mode
   * matches, so flipping `enableHighAccuracy` throws away what was cached.
   */
  maximumAge?: number
  /**
   * Follow the device instead of taking one reading.
   *
   * The watch is registered with `watchPosition` and handed back with `clearWatch` on unmount, on
   * `clear()`, and before any restart. Skipping that is the component's other quiet cost: an
   * abandoned watch keeps the location hardware awake for the life of the page — a battery drain
   * with no symptom on screen, since the map that wanted it has long since been navigated away
   * from.
   */
  watch?: boolean
  /** Called with each fix. */
  onPosition?: (position: GeolocationPosition) => void
  /**
   * Called when a request fails.
   *
   * Not `onError`: that is a native DOM attribute React defines on every element, so a prop by that
   * name collides with it as soon as these options are spread onto the `<button>`.
   */
  onFailure?: (failure: GeolocationFailure) => void
}

export interface UseGeolocationResult {
  /**
   * Where the request has got to.
   *
   * `prompting` and `locating` are split because the browser treats them differently and saying so
   * is the difference between a truthful spinner and a stuck one. `timeout` covers acquisition
   * only: by the specification, "the time spent waiting for the document to become visible and for
   * obtaining permission to use the API is not included". A permission dialog sitting unanswered is
   * therefore unbounded however small a timeout is passed — correctly so, since someone deciding
   * whether to hand over their location is not a fault and must not be cut off and reported as
   * one. What that leaves is a spinner obliged to say which wait it is: `prompting` means the ball
   * is in the user's court, `locating` means it is the device's.
   */
  phase: GeolocationPhase
  /** The most recent fix, or null. Kept across a later failure. */
  position: GeolocationPosition | null
  /** The last failure, or null. Cleared when a request starts or succeeds. */
  failure: GeolocationFailure | null
  /** The stored permission, or "unknown" where the Permissions API can't say. */
  permission: PermissionState | "unknown"
  /** Whether the API exists. Starts true so the server and first client render agree. */
  isSupported: boolean
  /** Ask for a position. Ignored while one is already in flight. */
  request: () => void
  /** Drop the fix and any error, release a watch, and go back to idle. */
  clear: () => void
}

/**
 * The whole behaviour, for a control you lay out yourself.
 */
export function useGeolocation({
  enableHighAccuracy = false,
  timeout = 10_000,
  maximumAge = 0,
  watch = false,
  onPosition,
  onFailure,
}: UseGeolocationOptions = {}): UseGeolocationResult {
  const [phase, setPhase] = React.useState<GeolocationPhase>("idle")
  const [position, setPosition] = React.useState<GeolocationPosition | null>(null)
  const [failure, setFailure] = React.useState<GeolocationFailure | null>(null)
  const [permission, setPermission] = React.useState<PermissionState | "unknown">("unknown")
  const [isSupported, setIsSupported] = React.useState(true)

  const watchIdRef = React.useRef<number | null>(null)
  // Every request gets a number, and a callback that is not the current one is dropped. Results
  // arrive asynchronously and there is no way to cancel a `getCurrentPosition` already in flight,
  // so without this a stale fix from an abandoned attempt can land on top of a fresh error.
  const requestRef = React.useRef(0)
  const inFlightRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const permissionRef = React.useRef<PermissionState | "unknown">("unknown")
  const failureRef = React.useRef<GeolocationFailure | null>(null)

  const onPositionRef = React.useRef(onPosition)
  const onFailureRef = React.useRef(onFailure)

  // Declared before everything that reads it: under StrictMode the cleanups run and the effects run
  // again, and if this came last the second pass would see `false` and quietly refuse to work.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    onPositionRef.current = onPosition
  }, [onPosition])

  React.useEffect(() => {
    onFailureRef.current = onFailure
  }, [onFailure])

  React.useEffect(() => {
    permissionRef.current = permission
  }, [permission])

  React.useEffect(() => {
    failureRef.current = failure
  }, [failure])

  React.useEffect(() => {
    setIsSupported(isGeolocationSupported())
  }, [])

  const stopWatch = React.useCallback(() => {
    const id = watchIdRef.current
    if (id === null) return
    watchIdRef.current = null
    geolocationOf()?.clearWatch(id)
  }, [])

  const fail = React.useCallback((cause: GeolocationFailureCause, code: number | null) => {
    const next: GeolocationFailure = {
      cause,
      code,
      message: DEFAULT_MESSAGES[cause],
      retryable: RETRYABLE[cause],
    }
    failureRef.current = next
    setFailure(next)
    setPhase("error")
    onFailureRef.current?.(next)
  }, [])

  /**
   * Reads the current permission and keeps the dead end honest.
   *
   * The `change` event is the reason this is a subscription rather than one read. A user sent to
   * site settings by the `denied` message comes back to a page that is still open, and the browser
   * fires `change` on the status object the moment they flip the switch. Handling it is what turns
   * "allow it in your settings" into advice that visibly works; ignoring it leaves the button dead
   * until a reload, which is the point at which people conclude the site is broken and leave.
   */
  React.useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false

    const handleChange = () => {
      if (!status) return
      const next = status.state
      setPermission(next)
      permissionRef.current = next
      if (next === "denied") return
      // No longer blocked. A `denied` message on screen is now false, and leaving it there is worse
      // than never having shown it. Only that one is cleared: a timeout or an unavailable position
      // has nothing to do with permission and is still true.
      if (failureRef.current?.cause === "denied") {
        failureRef.current = null
        setFailure(null)
        setPhase("idle")
      }
    }

    void queryGeolocationPermission().then((result) => {
      if (cancelled || !result) return
      status = result
      setPermission(result.state)
      permissionRef.current = result.state
      result.addEventListener("change", handleChange)
    })

    return () => {
      cancelled = true
      status?.removeEventListener("change", handleChange)
    }
  }, [])

  // Handing the watch back is not optional and nothing else will do it: the registration belongs to
  // the browser, not to this component, so navigating away inside a single-page app leaves it
  // running with no control left that could stop it.
  React.useEffect(() => stopWatch, [stopWatch])

  const request = React.useCallback(() => {
    if (inFlightRef.current) return

    const api = geolocationOf()
    if (!api) {
      setIsSupported(false)
      fail("unsupported", null)
      return
    }
    // Both of these produce PERMISSION_DENIED with no prompt and no way for the user to help.
    // Settled here, before calling, so the reason survives instead of being flattened into a code
    // that means four things.
    if (insecureContext()) {
      fail("insecure-context", null)
      return
    }
    if (blockedByPermissionsPolicy()) {
      fail("blocked-by-policy", null)
      return
    }

    const id = requestRef.current + 1
    requestRef.current = id
    inFlightRef.current = true
    failureRef.current = null
    setFailure(null)
    // "prompt" is the one state that reliably means a dialog is about to appear. Where the
    // Permissions API could not answer, claiming to know would be the lie, so it says "locating".
    setPhase(permissionRef.current === "prompt" ? "prompting" : "locating")

    const current = () => mountedRef.current && requestRef.current === id

    const handlePosition = (next: GeolocationPosition) => {
      inFlightRef.current = false
      if (!current()) return
      setPosition(next)
      failureRef.current = null
      setFailure(null)
      setPhase("success")
      onPositionRef.current?.(next)
    }

    const handleError = (error: GeolocationPositionError) => {
      inFlightRef.current = false
      if (!current()) return
      if (error.code === POSITION_UNAVAILABLE) return fail("unavailable", error.code)
      if (error.code === TIMEOUT) return fail("timeout", error.code)

      // PERMISSION_DENIED, which is four different things.
      //
      // The two checked before the call are checked again, because a document can be moved into a
      // frame that forbids the feature between the two moments, and because a browser reaching this
      // code path when the pre-checks could not run (no `allowsFeature`) still deserves the right
      // answer. Then the stored state decides the rest, and it has to be read now rather than taken
      // from React state: pressing Block both fails this call and fires `change`, and there is no
      // guarantee the event has been delivered yet.
      if (insecureContext()) return fail("insecure-context", error.code)
      if (blockedByPermissionsPolicy()) return fail("blocked-by-policy", error.code)

      void queryGeolocationPermission().then((status) => {
        if (!current()) return
        if (!status) {
          // Nothing can tell these apart here, so the copy for `denied` carries the day — it is the
          // only one of the two that stays broken, and advice to check site settings is harmless to
          // somebody who merely closed the dialog.
          return fail("denied", error.code)
        }
        setPermission(status.state)
        permissionRef.current = status.state
        if (status.state === "denied") return fail("denied", error.code)
        // Refused while the stored answer is "granted" can only come from above the user — a frame
        // or a header — so sending them to their own settings would be wrong.
        if (status.state === "granted") return fail("blocked-by-policy", error.code)
        // Still "prompt": nothing was stored, so the dialog was closed rather than answered. This
        // is the one denial worth offering a retry for, and asking again really does re-prompt.
        fail("dismissed", error.code)
      })
    }

    const options: PositionOptions = { enableHighAccuracy, timeout, maximumAge }

    if (watch) {
      stopWatch()
      watchIdRef.current = api.watchPosition(handlePosition, handleError, options)
      // A watch stays open and keeps reporting, so "in flight" ends once it is registered —
      // otherwise the first fix would be the only one this component ever accepted.
      inFlightRef.current = false
    } else {
      api.getCurrentPosition(handlePosition, handleError, options)
    }
  }, [enableHighAccuracy, fail, maximumAge, stopWatch, timeout, watch])

  const clear = React.useCallback(() => {
    // Bumping the id first orphans anything still in flight, so a fix that lands after this does
    // not quietly undo it.
    requestRef.current += 1
    inFlightRef.current = false
    stopWatch()
    setPosition(null)
    failureRef.current = null
    setFailure(null)
    setPhase("idle")
  }, [stopWatch])

  return { phase, position, failure, permission, isSupported, request, clear }
}

export interface GeolocationButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children">,
    UseGeolocationOptions {
  /** Resting label. */
  label?: string
  /** While the browser's permission dialog is open. */
  promptingLabel?: string
  /** While the device is working out where it is. */
  locatingLabel?: string
  /** After a fix arrives. */
  successLabel?: string
  /** Offered only where asking again can actually change the answer. */
  retryLabel?: string
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
  /** Hide the message under the button. It stays in the live region either way. */
  hideMessage?: boolean
  /** Per-cause wording, merged over the defaults. */
  messages?: Partial<Record<GeolocationFailureCause, string>>
  /** Class for the wrapper. `className` goes to the button. */
  containerClassName?: string
}

/**
 * A "use my current location" button that tells the truth about why it didn't.
 */
export function GeolocationButton({
  label = "Use my location",
  promptingLabel = "Waiting for permission…",
  locatingLabel = "Finding your location…",
  successLabel = "Location found",
  retryLabel = "Try again",
  iconOnly = false,
  hideMessage = false,
  messages,
  containerClassName,
  enableHighAccuracy,
  timeout,
  maximumAge,
  watch,
  onPosition,
  onFailure,
  onClick,
  className,
  ...props
}: GeolocationButtonProps) {
  const { phase, failure, isSupported, request } = useGeolocation({
    enableHighAccuracy,
    timeout,
    maximumAge,
    watch,
    onPosition,
    onFailure,
  })

  // The message is referenced by id from the button, so it needs one that survives hydration.
  const messageId = React.useId()

  const busy = phase === "prompting" || phase === "locating"
  // The only two states where pressing it again is a real offer. A failure marked non-retryable
  // keeps the control reachable and says why, rather than dangling an action that cannot work.
  const actionable = isSupported && !busy && failure?.retryable !== false

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented || !actionable) return
    request()
  }

  const message = failure ? (messages?.[failure.cause] ?? failure.message) : ""

  const visibleLabel =
    phase === "prompting"
      ? promptingLabel
      : phase === "locating"
        ? locatingLabel
        : phase === "success"
          ? successLabel
          : failure?.retryable
            ? retryLabel
            : label

  const Icon = busy ? Loader2 : failure && !failure.retryable ? TriangleAlert : LocateFixed

  return (
    <div className={cn("flex flex-col items-start gap-2", containerClassName)}>
      <button
        type="button"
        onClick={handleClick}
        // `aria-disabled` rather than `disabled`, so the control keeps its place in the tab order
        // and can still be reached and read. A real `disabled` button is skipped entirely, which
        // means the one explanation of why location is unavailable is delivered to everyone except
        // the people who most need it. The click handler above is what refuses.
        aria-disabled={actionable ? undefined : true}
        aria-busy={busy || undefined}
        aria-label={iconOnly ? visibleLabel : undefined}
        // Points at the message so the reason is part of the button's description wherever one
        // exists, rather than only being announced once as it appears.
        aria-describedby={message ? messageId : undefined}
        data-phase={phase}
        data-cause={failure?.cause}
        className={cn(
          "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50",
          iconOnly ? "w-9" : "px-4",
          className
        )}
        {...props}
      >
        <Icon className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
        {iconOnly ? null : visibleLabel}
      </button>
      {/*
        Mounted from the start and left empty, never conditionally rendered. A live region that is
        inserted into the document already holding its text is not reliably announced — the region
        has to exist for the browser to notice the text changing inside it — so the version that
        only appears when something goes wrong is silent for exactly the users depending on it.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        className={cn(
          "text-sm text-muted-foreground",
          (hideMessage || !message) && "sr-only"
        )}
      >
        {message}
      </p>
    </div>
  )
}
