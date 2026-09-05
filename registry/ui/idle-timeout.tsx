"use client"

import * as React from "react"
import { Clock } from "lucide-react"

import { cn } from "@/lib/utils"

/** Where a session stands relative to its deadline. */
export type IdleState = "active" | "prompted" | "idle"

/**
 * The whole component derives from one number — the timestamp the session ends at — and every
 * question is answered by comparing it to `Date.now()`. Nothing counts elapsed time by adding up
 * ticks, because a tick counter is wrong in exactly the situation this component exists for.
 *
 * A background tab has its timers throttled to once a minute or slower, so a counter that
 * decrements per tick falls behind real time by however long the tab was hidden. The number on
 * screen then reads *high*: it claims two minutes of grace when the session died ninety seconds
 * ago. A deadline cannot drift, because it is not being counted — it is being looked at.
 */
export function idleStateAt(
  deadlineMs: number,
  nowMs: number,
  promptBeforeMs: number
): IdleState {
  const remaining = deadlineMs - nowMs
  if (remaining <= 0) return "idle"
  if (remaining <= promptBeforeMs) return "prompted"
  return "active"
}

/** Longest a timer is ever armed for. See `nextWakeDelay`. */
export const MAX_WAKE_MS = 30_000
/** Cadence of the countdown while the warning is on screen. */
export const PROMPT_TICK_MS = 1_000

/**
 * How long to sleep before looking at the clock again.
 *
 * The timer is never armed for the whole wait, even when the whole wait is known. Three separate
 * things break a long `setTimeout`, and capping it fixes all three at once:
 *
 *   - **Delays above 2³¹−1 ms (about 24.8 days) overflow** and fire immediately, so a session
 *     timeout set in days signs the user out the instant the page loads.
 *   - **The wall clock moves.** A machine that sleeps, an NTP correction, a user changing the
 *     system clock — a timer armed for the old distance now lands in the wrong place, while a
 *     deadline re-read after a short sleep is only ever out by that sleep.
 *   - **Throttling is invisible from inside.** A hidden tab's wake comes late; waking often and
 *     re-reading means late wakes are noticed rather than accumulated.
 *
 * The cost of the cap is one wake every thirty seconds, which is less work than a single mouse
 * move. While the warning is up the cadence is a second, because a countdown is being rendered.
 */
export function nextWakeDelay(
  state: IdleState,
  remainingMs: number,
  promptBeforeMs: number
): number {
  if (state === "idle") return 0
  if (state === "prompted") return PROMPT_TICK_MS
  // Land on the moment the warning is due, unless that is further off than the cap.
  return Math.max(50, Math.min(remainingMs - promptBeforeMs, MAX_WAKE_MS))
}

/**
 * The value a screen reader should hear, or null once the remaining time is not worth saying again.
 *
 * A countdown that announces every second is not an accessibility feature — it is a barrier, since
 * the announcement of one second interrupts the announcement of the last and nothing else on the
 * page can be heard. Announcements are made when this value changes: every minute while there are
 * minutes left, then at thirty and ten seconds, then each of the final five.
 */
export function announceStep(remainingMs: number): number {
  const seconds = Math.ceil(remainingMs / 1000)
  if (seconds <= 5) return seconds
  if (seconds <= 10) return 10
  if (seconds <= 30) return 30
  return Math.ceil(seconds / 60) * 60
}

/** mm:ss, or h:mm:ss once there is an hour to show. */
export function formatRemaining(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/** The sentence a screen reader hears when the announced step changes. */
export function spokenRemaining(remainingMs: number): string {
  const seconds = announceStep(remainingMs)
  if (seconds >= 60) {
    const minutes = Math.round(seconds / 60)
    return `Signing out in ${minutes} minute${minutes === 1 ? "" : "s"}`
  }
  return `Signing out in ${seconds} second${seconds === 1 ? "" : "s"}`
}

/** Events that mean a person is still there. Attached passively, in the capture phase. */
export const DEFAULT_ACTIVITY_EVENTS = [
  "pointerdown",
  "keydown",
  "wheel",
  "touchstart",
  "mousemove",
  "scroll",
] as const

const ACTIVITY_THROTTLE_MS = 1_000
const BROADCAST_THROTTLE_MS = 5_000

export interface IdleTimeoutOptions {
  /** Idle time allowed before the session ends, in milliseconds. */
  timeoutMs: number
  /** How long before the deadline the warning appears (default 60000). */
  promptBeforeMs?: number
  /** Runs once when the deadline passes. Sign out here. */
  onIdle: () => void
  /** Runs when the warning opens. */
  onPrompt?: () => void
  /** Runs when the session is extended, including when another tab extended it. */
  onActive?: () => void
  /** Which events count as activity (default `DEFAULT_ACTIVITY_EVENTS`). */
  events?: readonly string[]
  /** Stop watching entirely — pass true while signed out, or the timer runs on the login screen. */
  disabled?: boolean
  /** Key shared by every tab of the same app. Set it per signed-in user, not per app. */
  channelName?: string
  /** Turn off tab-to-tab agreement (default false — it is on). */
  crossTab?: boolean
}

export interface IdleSession {
  /** Where the session stands as of the render that produced this. */
  state: IdleState
  /**
   * Milliseconds until sign-out, clamped at zero and accurate as of this render. A render happens
   * every second while the warning is up, and roughly every thirty seconds before that.
   */
  remainingMs: number
  /** Push the deadline out and tell the other tabs. This is what the "stay signed in" button calls. */
  extend: () => void
  /** End it now, here and in every other tab. */
  signOutNow: () => void
}

/**
 * What tabs tell each other. The message carries *when the user was last seen*, not when the
 * session ends: the two tabs may have been configured with different timeouts, and the moment a
 * person was at the keyboard is the fact, while the deadline is only each tab's opinion of it.
 */
type SyncMessage = { type: "active"; at: number } | { type: "idle" }

/**
 * Watches for the user going away, warns before the session ends, and keeps every tab agreeing
 * about when that is.
 *
 * The second half is the part a page-local timer cannot do. A person with the app open in three
 * tabs is working in one of them; the other two see no events at all, and each will announce on
 * its own authority that the session has expired. Whichever one the user comes back to has already
 * signed them out of work that was never idle. So activity is broadcast: `BroadcastChannel` where
 * it exists, a `localStorage` write where it does not (the `storage` event fires in the *other*
 * tabs, which is exactly the audience). The merge rule is to take the later of the two sightings,
 * because a tab seeing activity has seen a person, while a tab that has seen none is only reporting
 * that nothing happened in front of it — which is not evidence that nothing happened.
 *
 * **Passive activity does not dismiss the warning.** Once the prompt is up, only `extend()` —
 * a real answer — puts the deadline back. Two reasons, and both matter: a warning that a mouse
 * move clears cannot be read, because reaching for its button clears it; and the question the
 * warning asks is whether a person is still there, which a trackpad brushed by a sleeve does not
 * answer. Before the prompt, every event in `events` counts.
 *
 * What this cannot do is enforce anything. Timers in a hidden tab are throttled, a laptop that
 * sleeps through the deadline signs out when it wakes rather than on time, and any of it can be
 * turned off from the console. **The server's session lifetime is the security boundary; this is
 * the courtesy that stops people losing work to it.** Keep the two in step — a prompt that offers
 * to extend a session the server has already dropped is worse than no prompt.
 */
export function useIdleTimeout({
  timeoutMs,
  promptBeforeMs = 60_000,
  onIdle,
  onPrompt,
  onActive,
  events = DEFAULT_ACTIVITY_EVENTS,
  disabled = false,
  channelName = "idle-timeout",
  crossTab = true,
}: IdleTimeoutOptions): IdleSession {
  // A prompt window longer than the timeout would mean the warning is up before the session
  // starts; clamping keeps the states in the order they are named.
  const promptWindow = Math.min(promptBeforeMs, timeoutMs)

  const [state, setState] = React.useState<IdleState>("active")
  // Re-rendering is what makes the countdown move, and the value held is the second being shown —
  // not a counter — so that a re-evaluation inside the same second is not a re-render. `evaluate`
  // runs on every wake, every peer message and every return to the tab, not only on ticks. What is
  // rendered still comes from the clock; this only decides when to look.
  const [, setSecondShown] = React.useState(0)

  /**
   * When the user was last seen. Zero until the mount effect starts the clock, which keeps the
   * server and the first client render equal.
   *
   * The deadline is derived from this rather than stored, so that changing `timeoutMs` mid-session
   * lands where it should — a session shortened from thirty minutes to five ends five minutes after
   * the last keystroke, not five minutes after the setting changed.
   */
  const lastSeenRef = React.useRef(0)
  /** The deadline `onIdle` has already fired for, so it fires once however often we re-evaluate. */
  const firedForRef = React.useRef(0)
  const lastBroadcastRef = React.useRef(0)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // `undefined` rather than `null` for "no channel", matching `timerRef` — one spelling for absent.
  const channelRef = React.useRef<BroadcastChannel | undefined>(undefined)
  const storageCounterRef = React.useRef(0)

  // Callbacks and the current state are read through refs so that the listeners are installed once.
  // Rebuilding them on every state change would mean re-attaching a mousemove listener from inside
  // the handler for a mousemove.
  const callbacksRef = React.useRef({ onIdle, onPrompt, onActive })
  callbacksRef.current = { onIdle, onPrompt, onActive }
  const stateRef = React.useRef<IdleState>(state)
  stateRef.current = state

  /** Sends to the other tabs, by whichever transport this browser has. */
  const post = React.useCallback(
    (message: SyncMessage) => {
      if (!crossTab) return
      if (channelRef.current) {
        channelRef.current.postMessage(message)
        return
      }
      try {
        // `storage` does not fire when the value is unchanged, so a counter rides along to make
        // every write distinct — two extends landing on the same millisecond are still two events.
        window.localStorage.setItem(
          channelName,
          JSON.stringify({ ...message, n: ++storageCounterRef.current })
        )
      } catch {
        // Private browsing, disabled site data, a full quota. Tab sync is a nicety; the local
        // timeout still works, and there is nothing useful to tell the user here.
      }
    },
    [channelName, crossTab]
  )

  /**
   * Looks at the clock, moves the state to match, and arms the next wake. Everything routes through
   * here — the timer, the activity listeners, a message from another tab, the tab becoming visible
   * — so there is exactly one place where a deadline turns into a state.
   */
  const evaluate = React.useCallback(() => {
    if (timerRef.current !== undefined) clearTimeout(timerRef.current)
    timerRef.current = undefined
    if (disabled || lastSeenRef.current === 0) return

    const now = Date.now()
    const deadline = lastSeenRef.current + timeoutMs
    const remaining = deadline - now
    const next = idleStateAt(deadline, now, promptWindow)

    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
      if (next === "prompted") callbacksRef.current.onPrompt?.()
      if (next === "active") callbacksRef.current.onActive?.()
    } else if (next === "prompted") {
      setSecondShown(Math.ceil(remaining / 1000))
    }

    if (next === "idle") {
      if (firedForRef.current !== deadline) {
        firedForRef.current = deadline
        callbacksRef.current.onIdle()
      }
      return
    }

    timerRef.current = setTimeout(evaluate, nextWakeDelay(next, remaining, promptWindow))
  }, [disabled, promptWindow, timeoutMs])

  // Reached through a ref by everything that is not the timer itself. Depending on `evaluate`
  // directly would put `promptBeforeMs` into the clock effect's dependencies, and changing how
  // early the warning appears would silently restart the session it is warning about.
  const evaluateRef = React.useRef(evaluate)
  evaluateRef.current = evaluate

  const extend = React.useCallback(() => {
    const now = Date.now()
    lastSeenRef.current = now
    lastBroadcastRef.current = now
    post({ type: "active", at: now })
    evaluateRef.current()
  }, [post])

  const signOutNow = React.useCallback(() => {
    // Backdating the sighting by a whole timeout is what "the deadline is now" is spelled as when
    // the deadline is derived; it needs no second flag, and it stays true if `timeoutMs` changes.
    lastSeenRef.current = Date.now() - timeoutMs
    post({ type: "idle" })
    evaluateRef.current()
  }, [post, timeoutMs])

  // --- the clock -------------------------------------------------------------------------------
  // Started in an effect rather than at render, so the server and the first client render agree,
  // and restarted when the length of the session changes.
  React.useEffect(() => {
    if (disabled) {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = undefined
      lastSeenRef.current = 0
      stateRef.current = "active"
      setState("active")
      return
    }
    // Only the first run starts the clock. A later run — `timeoutMs` changed, or React mounting the
    // effect twice as it does in development — re-derives the deadline from the same sighting
    // rather than handing the user a fresh session for having changed a setting.
    if (lastSeenRef.current === 0) {
      lastSeenRef.current = Date.now()
      firedForRef.current = 0
    }
    evaluateRef.current()
    return () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current)
      timerRef.current = undefined
    }
  }, [disabled, timeoutMs])

  // --- activity --------------------------------------------------------------------------------
  React.useEffect(() => {
    if (disabled) return

    const onActivity = () => {
      // The warning is answered, not brushed away. See the note on the hook.
      if (stateRef.current !== "active") return
      const now = Date.now()
      // `mousemove` arrives dozens of times a second and a deadline is measured in minutes, so a
      // second of granularity costs nothing and saves the work.
      if (now - lastSeenRef.current < ACTIVITY_THROTTLE_MS) return
      lastSeenRef.current = now
      // Peers are told at a coarser cadence than the sighting moves: being a few seconds stale
      // about a timeout of minutes changes nothing, and a channel message per mouse move would be
      // a broadcast storm across every open tab.
      if (now - lastBroadcastRef.current >= BROADCAST_THROTTLE_MS) {
        lastBroadcastRef.current = now
        post({ type: "active", at: now })
      }
      // No `evaluate()` here: the state cannot have changed (we are active, and the deadline only
      // moved further away), and the armed timer re-reads the deadline when it fires.
    }

    // Capture, because a component that calls `stopPropagation` on its own pointer events would
    // otherwise make its part of the page look deserted — and because `scroll` does not bubble
    // from a scrolling element at all, so a bubble-phase listener on the document misses every
    // scroll that happens inside a pane.
    const options = { passive: true, capture: true } as const
    for (const type of events) document.addEventListener(type, onActivity, options)
    return () => {
      for (const type of events) document.removeEventListener(type, onActivity, options)
    }
  }, [disabled, events, post])

  // --- waking up -------------------------------------------------------------------------------
  // A hidden tab's timers are throttled to a minute or worse, so its idea of the state is stale by
  // however long it was hidden. Re-reading the deadline the moment the tab is looked at again is
  // what turns "the counter was frozen" into "the counter was right all along".
  React.useEffect(() => {
    if (disabled) return
    const recheck = () => evaluateRef.current()
    document.addEventListener("visibilitychange", recheck)
    window.addEventListener("focus", recheck)
    // Restoring from the back/forward cache resumes a page whose timers were suspended entirely.
    window.addEventListener("pageshow", recheck)
    return () => {
      document.removeEventListener("visibilitychange", recheck)
      window.removeEventListener("focus", recheck)
      window.removeEventListener("pageshow", recheck)
    }
  }, [disabled])

  // --- the other tabs --------------------------------------------------------------------------
  React.useEffect(() => {
    if (disabled || !crossTab) return

    const receive = (message: SyncMessage) => {
      if (message.type === "idle") {
        lastSeenRef.current = Date.now() - timeoutMs
        evaluateRef.current()
        return
      }
      // Later wins. A tab reporting activity has seen a person; a tab that has not is only
      // reporting that nothing happened in front of it, which is not evidence of absence.
      if (message.at > lastSeenRef.current) {
        lastSeenRef.current = message.at
        evaluateRef.current()
      }
    }

    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(channelName)
      channelRef.current = channel
      const onMessage = (event: MessageEvent<SyncMessage>) => receive(event.data)
      channel.addEventListener("message", onMessage)
      return () => {
        channel.removeEventListener("message", onMessage)
        channel.close()
        channelRef.current = undefined
      }
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== channelName || !event.newValue) return
      try {
        receive(JSON.parse(event.newValue) as SyncMessage)
      } catch {
        // Someone else's write under the same key. Ignoring it is the whole handling.
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [channelName, crossTab, disabled, timeoutMs])

  // Read from the deadline at render rather than kept in state. Holding it in state would mean a
  // re-render every thirty seconds to update a number that, before the warning, nothing displays —
  // and it would still be stale for any render that happened between those. Derived from the clock,
  // it is right whenever it is looked at.
  const remainingMs =
    lastSeenRef.current === 0
      ? timeoutMs
      : Math.max(0, lastSeenRef.current + timeoutMs - Date.now())

  return { state, remainingMs, extend, signOutNow }
}

export interface IdleTimeoutProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title" | "children">,
    IdleTimeoutOptions {
  title?: React.ReactNode
  /** Takes the live remaining time so the sentence can carry the number. */
  description?: (remaining: string) => React.ReactNode
  /** The safe choice, which is the one that starts focused. */
  stayLabel?: string
  /** Leaving now, deliberately. Omit to render only the one button. */
  signOutLabel?: string | null
}

/**
 * The warning itself: "you will be signed out in 1:59", a button to stay, and a button to go.
 *
 * It renders nothing until the prompt is due, so it costs a listener and a thirty-second timer to
 * leave mounted for the life of a signed-in layout. Put one at the root of that layout — one
 * instance per tab, not one per screen, or every copy runs its own clock and broadcasts over the
 * others.
 *
 * The dialog is an `alertdialog` because it interrupts rather than being asked for, and focus lands
 * on **stay signed in**: the destructive button on a dialog nobody asked for is answered by
 * whatever key was already on its way to the page. Escape does the same as staying. The countdown
 * is a `role="timer"`, which is not announced as it changes, and a separate polite region carries
 * the time at the intervals `announceStep` picks — a per-second announcement is a barrier rather
 * than an aid, because each one cuts off the last.
 */
export function IdleTimeout({
  timeoutMs,
  promptBeforeMs,
  onIdle,
  onPrompt,
  onActive,
  events,
  disabled,
  channelName,
  crossTab,
  title = "Still there?",
  description = (remaining) => `You will be signed out in ${remaining}.`,
  stayLabel = "Stay signed in",
  signOutLabel = "Sign out now",
  className,
  onKeyDown: onKeyDownProp,
  ...props
}: IdleTimeoutProps) {
  const { state, remainingMs, extend, signOutNow } = useIdleTimeout({
    timeoutMs,
    promptBeforeMs,
    onIdle,
    onPrompt,
    onActive,
    events,
    disabled,
    channelName,
    crossTab,
  })

  const open = state === "prompted"
  const dialogRef = React.useRef<HTMLDivElement>(null)
  const stayRef = React.useRef<HTMLButtonElement>(null)
  const titleId = React.useId()
  const descriptionId = React.useId()

  React.useEffect(() => {
    if (!open) return
    const restore = document.activeElement
    stayRef.current?.focus()
    return () => {
      // Whatever the user was on when the warning cut in is where they belong afterwards.
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus()
    }
  }, [open])

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDownProp?.(event)
    if (event.defaultPrevented) return
    if (event.key === "Escape") {
      event.preventDefault()
      extend()
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

  const remaining = formatRemaining(remainingMs)

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
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="space-y-1.5">
            <h2 id={titleId} className="text-sm font-medium">
              {title}
            </h2>
            <p id={descriptionId} className="text-sm text-muted-foreground">
              {description(remaining)}
            </p>
            <p
              role="timer"
              aria-live="off"
              className="pt-0.5 text-2xl font-semibold tabular-nums tracking-tight"
            >
              {remaining}
            </p>
            {/*
              Re-rendered every second, announced far less often: `spokenRemaining` returns the same
              string for every tick inside a step, React leaves the text node alone when it has not
              changed, and a live region announces on mutation rather than on render.
            */}
            <span className="sr-only" aria-live="polite" aria-atomic="true">
              {spokenRemaining(remainingMs)}
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          {signOutLabel === null ? null : (
            <button
              type="button"
              onClick={signOutNow}
              className="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {signOutLabel}
            </button>
          )}
          <button
            ref={stayRef}
            type="button"
            onClick={extend}
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {stayLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
