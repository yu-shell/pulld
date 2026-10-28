"use client"

import * as React from "react"
import { Bell, BellOff, BellRing, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Whether the Notification API exists in this context.
 *
 * `"Notification" in window` rather than `typeof Notification`, because the second one is a
 * reference to a global that genuinely is not declared everywhere this file can be imported —
 * a server render, a worker, a test harness — and `typeof` on an undeclared identifier is the only
 * form that does not throw. The `in` check reads the same and is honest about what it asks.
 *
 * Note what it does not promise. It returning true is entirely compatible with every request being
 * refused without a prompt: measured in a sandboxed frame below, and true of any origin the person
 * has already blocked. Support is the first question, not the whole question.
 */
export function isNotificationSupported(): boolean {
  if (typeof window === "undefined") return false
  if (!("Notification" in window)) return false
  const api = (window as Window & { Notification?: typeof Notification }).Notification
  return typeof api === "function" && typeof api.requestPermission === "function"
}

/**
 * Whether this document has an opaque origin, where the answer is "denied" and always was.
 *
 * Measured, in Chrome 152, from a page whose own permission was `denied`: a `<iframe sandbox="allow-scripts">`
 * reports `location.origin === "null"`, `Notification` is still a function, `Notification.permission`
 * reads `"denied"`, and `requestPermission()` resolves `"denied"` with no prompt. So an embed gets
 * the identical reading to a person who pressed Block — and the advice that fits one is wrong for
 * the other. Telling an embedded widget's user to go and unblock notifications in their site
 * settings sends them looking for a switch that is not there, for an origin that has no settings.
 *
 * The string is `"null"` and not `null`: `location.origin` is serialised, and the opaque origin
 * serialises to those four characters. Comparing against the value `null` is the version of this
 * check that compiles, runs, and is never once true.
 */
export function isOpaqueOrigin(): boolean {
  if (typeof location === "undefined") return false
  return location.origin === "null"
}

/** Whether this document is inside a frame at all. Best-effort: a cross-origin parent can throw. */
function isFramed(): boolean {
  if (typeof window === "undefined") return false
  try {
    return window.self !== window.top
  } catch {
    // A cross-origin parent makes `window.top` unreadable, which is itself the answer.
    return true
  }
}

/**
 * The stored permission, read fresh.
 *
 * `Notification.permission` is an accessor, not a value — measured: its property descriptor on the
 * constructor has a getter and no `value`. That means it is never stale, and it also means nothing
 * will ever tell React that it changed. Every read in this file goes through here, and the state
 * that drives rendering is pushed by the subscription below rather than sampled during render.
 */
function readPermission(): NotificationPermission | null {
  if (!isNotificationSupported()) return null
  return window.Notification.permission
}

/**
 * Reads the live permission object, or null where that cannot be asked.
 *
 * Wrapped in `try` because the Permissions API rejects rather than answers for a descriptor it does
 * not recognise — measured: `navigator.permissions.query({ name: "not-a-real-permission" })` throws
 * a `TypeError`, it does not resolve to anything. Browsers differ on which names they accept, so a
 * rejection here means "this browser will not say", which is an ordinary answer. Every path below
 * works without it; what it buys is the `change` event, and the `change` event is what makes the
 * dead end recoverable.
 */
async function queryNotificationPermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !("permissions" in navigator)) return null
  const permissions: Permissions | undefined = navigator.permissions
  if (!permissions || typeof permissions.query !== "function") return null
  try {
    return await permissions.query({ name: "notifications" as PermissionName })
  } catch {
    return null
  }
}

/**
 * Everything mounted right now that wants to hear about a change.
 *
 * Module scope on purpose. The notification permission is one fact about the origin, not a property
 * of a button — measured: `Notification.permission` and the Permissions API agreed, and two
 * `requestPermission()` calls issued in the same tick both resolved with the same answer. So a page
 * with a button in the header and another in a settings panel has two views of one value, and the
 * one that is not pressed has to update too. Without this it keeps offering to enable notifications
 * that are already on.
 */
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * The one request in flight, shared by every instance.
 *
 * Two buttons pressed in the same moment must not become two prompts, and the second press of one
 * button must not either. Reusing the promise is better than refusing the second call: both callers
 * get the real answer, rather than one of them getting a lie about being busy.
 */
let inFlight: Promise<NotificationRequestOutcome> | null = null

/** What there is to show, and which of the four interfaces to show. */
export type NotificationPermissionStatus =
  /** No Notification API here. Nothing to offer and nothing the person can do about it. */
  | "unsupported"
  /** Nothing stored. A press will put the browser's prompt in front of them — the one chance. */
  | "default"
  /** Allowed. */
  | "granted"
  /** Refused, and the browser will not ask again. See `canAsk`. */
  | "denied"

/** How a request ended. */
export type NotificationRequestOutcome =
  | "granted"
  /** Stored as a refusal. This is the end of the road for this origin. */
  | "denied"
  /** The prompt was closed without an answer, so nothing was stored and asking again still works. */
  | "dismissed"
  /** Never asked: unsupported, or already settled. */
  | "unavailable"

/** How a `notify()` call ended. */
export type NotifyOutcome =
  | "shown"
  /** Not attempted, because the permission is not `granted`. Nothing was constructed. */
  | "not-permitted"
  /** Attempted and the platform reported a failure. */
  | "failed"
  /** Attempted, and the platform said nothing either way inside the wait. */
  | "unknown"
  | "unsupported"

/** Why `denied` is on screen, where that can be told apart. */
export type DeniedReason =
  /** The ordinary one: a stored refusal for this origin, changeable only in site settings. */
  | "blocked"
  /** An opaque-origin embed, which reads `denied` whatever the top-level page's answer is. */
  | "embedded"

export interface UseNotificationPermissionOptions {
  /** Called once the browser's prompt has been answered, or closed. */
  onOutcome?: (outcome: NotificationRequestOutcome) => void
}

export interface NotificationPermissionState {
  /** Which of the four situations this is. `"default"` until the first effect has run. */
  status: NotificationPermissionStatus
  /**
   * Whether a press can still produce a prompt.
   *
   * This is the reason the component exists. Measured, on an origin whose permission was already
   * `denied`: `Notification.requestPermission()` resolved with `"denied"` in **0.3 ms**, showed no
   * prompt, and needed no user gesture to do it — then did the same thing three more times in a
   * row, in under a tenth of a millisecond each. There is no retry, no backoff and no second
   * chance; the call is a lookup wearing the costume of a request. A "Try again" button wired to
   * it is a control that cannot work, and the only honest interface for that state says so and
   * points at the browser's own settings.
   */
  canAsk: boolean
  /** Set when `status` is `"denied"`, to tell a real refusal from an embed that never could ask. */
  deniedReason: DeniedReason | null
  /** Whether a prompt is open right now. */
  isRequesting: boolean
  /** False until the first effect has read the real permission. The button waits for it. */
  isResolved: boolean
  /**
   * Ask. Call it straight from the click handler, with nothing awaited in front of it.
   *
   * Resolves `"unavailable"` without touching the API when there is nothing to ask.
   */
  request: () => Promise<NotificationRequestOutcome>
  /** Show one notification, if and only if that is permitted. See the implementation note. */
  notify: (title: string, options?: NotificationOptions) => Promise<NotifyOutcome>
}

/**
 * The permission, the one call that changes it, and the guard around using it.
 *
 * Four states and not three, because "this browser cannot" and "this person said no" are different
 * situations with different right answers, and the unsupported case is the one that gets dropped —
 * it never produces an error to render, so a component built from error states alone shows a live,
 * hopeful button on the one platform where it can never do anything.
 */
export function useNotificationPermission(
  options: UseNotificationPermissionOptions = {}
): NotificationPermissionState {
  const { onOutcome } = options

  // Deterministic on the server and on the first client render alike, then corrected by the effect
  // below. Reading the real permission during render — or in a `useState` initialiser, which is the
  // same bug with a hat on — is a hydration mismatch on every page that server-renders.
  const [status, setStatus] = React.useState<NotificationPermissionStatus>("default")
  const [deniedReason, setDeniedReason] = React.useState<DeniedReason | null>(null)
  const [isRequesting, setIsRequesting] = React.useState(false)
  const [isResolved, setIsResolved] = React.useState(false)

  const onOutcomeRef = React.useRef(onOutcome)
  onOutcomeRef.current = onOutcome

  const mountedRef = React.useRef(true)
  // Declared before anything that reads it: under StrictMode the cleanup runs and the effects run
  // again, and a later declaration would leave the second pass looking at `false`.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  React.useEffect(() => {
    function read() {
      const permission = readPermission()
      const next: NotificationPermissionStatus = permission === null ? "unsupported" : permission
      setStatus((previous) => (previous === next ? previous : next))
      setDeniedReason(
        next !== "denied" ? null : isOpaqueOrigin() || isFramed() ? "embedded" : "blocked"
      )
      setIsResolved(true)
    }

    // Subscribed before the first read, so an answer arriving from another instance in between is
    // not dropped into the gap. Reading first and subscribing second is the ordinary version of
    // this bug.
    listeners.add(read)
    read()
    return () => {
      listeners.delete(read)
    }
  }, [])

  /**
   * Keeps the dead end honest.
   *
   * A person sent to site settings by the `denied` copy comes back to a page that is still open,
   * and the browser fires `change` on the status object the moment they flip the switch — measured:
   * the object handed back for `{ name: "notifications" }` is a real `PermissionStatus` with an
   * `onchange` slot. Handling it is what turns "change it in your settings" into advice that
   * visibly works. Ignoring it leaves the button dead until a reload, which is the point at which
   * people decide the site is broken.
   */
  React.useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false

    const handleChange = () => {
      // Deliberately re-read `Notification.permission` rather than trusting `status.state`. The two
      // agreed when measured, and this is the one that the rest of the file acts on, so a browser
      // where they ever disagree should move the UI to the value that governs behaviour.
      emit()
    }

    void queryNotificationPermission().then((result) => {
      if (cancelled || !result) return
      status = result
      result.addEventListener("change", handleChange)
    })

    return () => {
      cancelled = true
      status?.removeEventListener("change", handleChange)
    }
  }, [])

  const request = React.useCallback(async (): Promise<NotificationRequestOutcome> => {
    if (!isNotificationSupported()) return "unavailable"
    // Short-circuited here rather than left to the browser, so that nothing in this component ever
    // depends on the 0.3 ms no-op described on `canAsk`. A press that cannot produce a prompt is
    // refused by the component, visibly, instead of being sent to an API that will answer
    // instantly and identically forever.
    if (window.Notification.permission !== "default") return "unavailable"

    if (inFlight) return inFlight

    setIsRequesting(true)
    const run = (async (): Promise<NotificationRequestOutcome> => {
      try {
        // Called with nothing awaited in front of it, and that is why this function does its
        // checks against synchronous reads only. Browsers honour the prompt while the click that
        // led here is still the active user gesture, so an `await` first — asking the Permissions
        // API whether to bother, reading a flag from storage — is what turns a working button into
        // a prompt that never appears.
        //
        // The promise form is the one in use (measured: `requestPermission.length` is 0 and the
        // call returns a real `Promise`), but the callback form is older than the promise and is
        // the only form some browsers ever shipped, where the call returns `undefined` and
        // `await undefined` is `undefined` — which coerces to "not granted" and throws away an
        // answer the person actually gave.
        //
        // Both forms are served by **one** call, and that is the whole subtlety. The obvious
        // repair — await the promise, and if it was undefined call again with a callback — asks
        // twice, which on the browsers it is meant to rescue means two prompts for one press, and
        // the second one spends the single chance that the first was still waiting on. The IDL has
        // carried the callback as an optional trailing argument since the promise was added
        // (`requestPermission(optional NotificationPermissionCallback deprecatedCallback)`), so
        // passing it is legal on both and whichever form this browser implements answers. The
        // guard is for the browser that honours both: first answer wins, the other is dropped.
        const answer: NotificationPermission = await new Promise<NotificationPermission>(
          (resolve) => {
            // No guard against being answered twice, because `resolve` already is one: a browser
            // that honours both signatures calls this with the same answer twice and the second
            // call is a no-op. A flag here would read as though it were protecting something.
            const deliver = resolve
            const returned: Promise<NotificationPermission> | undefined =
              window.Notification.requestPermission(deliver)
            // Deliberately not raced against a timeout. A prompt left open is not a failure — it
            // is somebody deciding — and cutting it off would report a refusal nobody made.
            if (returned && typeof returned.then === "function") {
              returned.then(deliver, () => deliver(window.Notification.permission))
            }
          }
        )

        // The resolved value *is* the resulting permission, so `"default"` means the prompt was
        // closed without an answer: nothing was stored, and asking again is a real offer rather
        // than the no-op that `"denied"` would make it.
        return answer === "granted" ? "granted" : answer === "denied" ? "denied" : "dismissed"
      } catch {
        return "unavailable"
      }
    })()

    inFlight = run
    const outcome = await run
    inFlight = null

    // Published to every instance before this one's own state is touched, so two buttons on one
    // page settle together.
    emit()
    if (mountedRef.current) setIsRequesting(false)
    onOutcomeRef.current?.(outcome)
    return outcome
  }, [])

  /**
   * Shows a notification, and reports what actually happened.
   *
   * The guard is not politeness, it is the whole method. Measured, on a `denied` origin:
   * `new Notification("probe")` **does not throw**. It constructs, returns an object, and nothing
   * appears anywhere. So the natural-looking version —
   *
   * ```ts
   * try { new Notification(title); return true } catch { return false }
   * ```
   *
   * — returns `true` to a caller whose user is seeing nothing at all, and will keep returning it
   * forever. What the platform does instead is fire an `error` event on the notification object:
   * measured, `onerror` fired for the blocked probe within 600 ms, while `onshow` and `onclose`
   * did not. Both facts are used below — the permission is checked before anything is constructed,
   * and the event, not the absence of an exception, is what "shown" means.
   *
   * The service-worker route is preferred where a registration already exists, because
   * `ServiceWorkerRegistration.prototype.showNotification` is the form that survives platforms
   * where the constructor is unavailable (measured present here). Nothing is registered on the
   * caller's behalf: if there is no service worker, the constructor is used, and if there is no
   * constructor either, that is reported rather than guessed at.
   */
  const notify = React.useCallback(
    async (title: string, notificationOptions?: NotificationOptions): Promise<NotifyOutcome> => {
      if (!isNotificationSupported()) return "unsupported"
      if (window.Notification.permission !== "granted") return "not-permitted"

      const registration =
        typeof navigator !== "undefined" && "serviceWorker" in navigator
          ? await navigator.serviceWorker.getRegistration().catch(() => undefined)
          : undefined

      if (registration && typeof registration.showNotification === "function") {
        try {
          await registration.showNotification(title, notificationOptions)
          return "shown"
        } catch {
          return "failed"
        }
      }

      try {
        const notification = new window.Notification(title, notificationOptions)
        return await new Promise<NotifyOutcome>((resolve) => {
          // Bounded, because a platform that fires neither event must not leave the caller's
          // promise pending for the life of the page. What it resolves with then is `"unknown"`
          // and not `"shown"` — reporting success from the absence of evidence is the exact bug
          // this method is written to avoid, and a caller that wants to treat silence as success
          // can, knowingly.
          const timer = setTimeout(() => resolve("unknown"), 1000)
          const settle = (outcome: NotifyOutcome) => () => {
            clearTimeout(timer)
            resolve(outcome)
          }
          notification.addEventListener("show", settle("shown"))
          notification.addEventListener("error", settle("failed"))
        })
      } catch {
        return "failed"
      }
    },
    []
  )

  return {
    status,
    canAsk: status === "default",
    deniedReason,
    isRequesting,
    isResolved,
    request,
    notify,
  }
}

const DEFAULT_MESSAGES: Record<NotificationPermissionStatus | DeniedReason, string> = {
  unsupported: "This browser can't show notifications.",
  default: "",
  granted: "Notifications are on.",
  denied: "",
  blocked:
    "Notifications are blocked for this site. Turn them back on in your browser's site settings — this page can't ask again.",
  embedded: "Notifications aren't available inside this embed.",
}

const BUTTON_CLASS =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50"

export interface NotificationPermissionButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children">,
    UseNotificationPermissionOptions {
  /** Resting label, shown when a press will produce the prompt. */
  label?: string
  /** While the browser's prompt is open. */
  requestingLabel?: string
  /** Once allowed. */
  grantedLabel?: string
  /** Once refused. Not an action — see `canAsk`. */
  deniedLabel?: string
  /** Where notifications do not exist at all. */
  unsupportedLabel?: string
  /** Render nothing once the permission is granted, instead of showing the settled state. */
  hideWhenGranted?: boolean
  /** Drop the visible text and keep it as the accessible name. */
  iconOnly?: boolean
  /** Hide the message under the button. It stays in the live region either way. */
  hideMessage?: boolean
  /** Per-situation wording, merged over the defaults. */
  messages?: Partial<Record<NotificationPermissionStatus | DeniedReason, string>>
  /** Class for the wrapper. `className` goes to the button. */
  containerClassName?: string
}

/**
 * A button that asks for notification permission at a moment you choose, and never twice.
 *
 * It renders nothing until the first effect has read the real permission, so a page that
 * server-renders does not flash an offer at somebody who accepted months ago. After that it is one
 * of four things, and only one of them is a button that does anything.
 *
 * Mount it where the value is obvious — beside the thing that will send the notifications, after
 * the person has done something that implies they want them — and not on load. That placement is
 * the entire product decision here, and it is the caller's: the component's job is to make the
 * cost of getting it wrong visible, by refusing to pretend a refusal can be undone.
 *
 * Every colour is a shadcn token, so it follows light and dark. For a control of your own design,
 * take `useNotificationPermission` and leave this one out; all of the behaviour is in the hook.
 */
export function NotificationPermissionButton({
  label = "Enable notifications",
  requestingLabel = "Waiting for permission…",
  grantedLabel = "Notifications on",
  deniedLabel = "Notifications blocked",
  unsupportedLabel = "Notifications unavailable",
  hideWhenGranted = false,
  iconOnly = false,
  hideMessage = false,
  messages,
  containerClassName,
  onOutcome,
  onClick,
  className,
  ...props
}: NotificationPermissionButtonProps) {
  const { status, canAsk, deniedReason, isRequesting, isResolved, request } =
    useNotificationPermission({ onOutcome })

  // Referenced by id from the button, so it needs one that survives hydration.
  const messageId = React.useId()

  if (!isResolved) return null
  if (status === "granted" && hideWhenGranted) return null

  const actionable = canAsk && !isRequesting

  function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented || !actionable) return
    // Not awaited, and nothing is awaited before it. See the note inside `request`.
    void request()
  }

  const visibleLabel = isRequesting
    ? requestingLabel
    : status === "granted"
      ? grantedLabel
      : status === "denied"
        ? deniedLabel
        : status === "unsupported"
          ? unsupportedLabel
          : label

  // The denied reason is more specific than the status, so it wins where there is one.
  const messageKey: NotificationPermissionStatus | DeniedReason =
    status === "denied" && deniedReason ? deniedReason : status
  const message = messages?.[messageKey] ?? DEFAULT_MESSAGES[messageKey]

  const Icon = isRequesting
    ? Loader2
    : status === "granted"
      ? BellRing
      : status === "default"
        ? Bell
        : BellOff

  // The caller's own description first, the reason last: the reason is the newer and more urgent of
  // the two, and reading it last keeps it from being buried under a static hint.
  const describedBy = [props["aria-describedby"], message ? messageId : null]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={cn("flex flex-col items-start gap-2", containerClassName)}>
      <button
        type="button"
        onClick={handleClick}
        // `aria-disabled` rather than `disabled`, so the control keeps its place in the tab order
        // and can still be reached and read. A real `disabled` button is skipped entirely, which
        // delivers the one explanation of why notifications are off to everybody except the people
        // who most need it. The click handler above is what refuses.
        aria-disabled={actionable ? undefined : true}
        aria-busy={isRequesting || undefined}
        aria-label={iconOnly ? visibleLabel : undefined}
        data-status={status}
        data-denied-reason={deniedReason ?? undefined}
        className={cn(BUTTON_CLASS, iconOnly ? "w-9" : "px-4", className)}
        {...props}
        // After the spread, and the only attribute here that is: this one has to be the merge of
        // the caller's value and ours, so letting `{...props}` have the last word on it is the one
        // ordering that loses information. A control inside a settings form passing its own hint —
        // the ordinary thing to do — would otherwise drop the single line that says why
        // notifications cannot be turned on.
        aria-describedby={describedBy || undefined}
      >
        <Icon className={cn("h-4 w-4", isRequesting && "animate-spin")} aria-hidden="true" />
        {iconOnly ? null : visibleLabel}
      </button>
      {/*
        Mounted from the start and left empty, never conditionally rendered. A live region inserted
        into the document already holding its text is not reliably announced — the region has to
        exist for the browser to notice the text changing inside it — so the version that only
        appears when something goes wrong is silent for exactly the users depending on it.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        className={cn("text-sm text-muted-foreground", (hideMessage || !message) && "sr-only")}
      >
        {message}
      </p>
    </div>
  )
}
