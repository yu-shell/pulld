"use client"

import * as React from "react"
import { Loader2, Wifi, WifiOff } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The path the reachability probe asks for by default.
 *
 * A favicon is the one file almost every site already serves, it is same-origin, and it is small
 * enough to ask for repeatedly. Whether it actually exists does not matter — see `checkReachable`
 * for why a 404 counts as reachable — so this stays a safe default even where the file is missing.
 */
export const DEFAULT_PROBE_URL = "/favicon.ico"

/** A probe that has not answered within this many milliseconds is treated as a failure. */
const DEFAULT_TIMEOUT = 5000
/** The first retry after a failed probe waits about this long. */
const DEFAULT_INITIAL_DELAY = 1000
/** However many failures pile up, retries never space out further apart than this. */
const DEFAULT_MAX_DELAY = 30000

export interface ProbeDelayOptions {
  /** Ceiling on the first retry, doubling from there. */
  initialDelay?: number
  /** Ceiling the doubling stops at. */
  maxDelay?: number
  /** Source of the jitter. Injectable so a test can pin the delay; defaults to `Math.random`. */
  random?: () => number
}

/**
 * How long to wait before the next probe, after `attempt` consecutive failures.
 *
 * Doubling on its own is not enough, and the reason is specific to this component. Connections do
 * not fail one user at a time: an access point reboots, an upstream link flaps, a deploy takes an
 * API down — and every tab in every browser starts its backoff on the same tick, stays in lockstep
 * all the way up the curve, and arrives back together at the exact moment the server is least able
 * to absorb it. So half of each delay is fixed and half is drawn at random, which spreads that herd
 * across the window. Half rather than all of it, because full jitter occasionally draws a delay near
 * zero, and a retry that lands immediately is the thing the backoff exists to prevent.
 */
export function nextProbeDelay(attempt: number, options: ProbeDelayOptions = {}): number {
  const {
    initialDelay = DEFAULT_INITIAL_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
    random = Math.random,
  } = options
  const exponent = Math.max(0, Math.floor(attempt))
  // The doubling overflows to Infinity long before any of this matters, and Math.min simply pins
  // an overflowed ceiling to maxDelay, so a long outage needs no separate guard.
  const ceiling = Math.min(maxDelay, initialDelay * 2 ** exponent)
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

export interface ReachabilityOptions {
  /** HTTP method for the probe. HEAD by default — the answer is in the round trip, not the body. */
  method?: string
  /** Milliseconds before an unanswered probe is abandoned. */
  timeout?: number
  /** Aborts the probe from outside, e.g. when the component unmounts. */
  signal?: AbortSignal
}

function withCacheBuster(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}_=${Date.now()}`
}

/**
 * Asks the network whether it can still carry a request, and resolves true when it can.
 *
 * What counts as reachable is deliberately wide: any HTTP response at all, a 404 or a 502 included.
 * The question is whether packets reach a server and come back, and a 404 answers it exactly as
 * well as a 200 — which is what makes a possibly-absent favicon a safe default. Only a failure
 * below HTTP means unreachable: DNS, TLS, a refused or black-holed connection, or the timeout.
 *
 * Two failure modes are handled here that `fetch(url).then(() => true)` is not:
 *
 * `redirect: "error"` is what catches a captive portal. A hotel, café or airport gateway answers
 * for somebody else's server with a redirect to its own login page, and a fetch that follows it
 * comes back with a perfectly good response — this is precisely the state `navigator.onLine` is
 * already reporting as online. Refusing to follow the redirect turns it back into the failure it
 * is. Portals that silently drop traffic instead are caught by the timeout.
 *
 * The timeout is the other one. A connection that black-holes packets does not fail, it hangs, and
 * a probe with no deadline hangs with it — leaving the page reporting whatever it last knew for as
 * long as the socket stays open.
 *
 * One thing it cannot see through: a service worker with a cache-first strategy answers the probe
 * itself, without touching the network, and reports the site as reachable from a plane. `cache:
 * "no-store"` governs the HTTP cache and not the worker. Point `url` at a path the worker does not
 * handle, or hand `useNetworkStatus` a `probe` of your own.
 */
export async function checkReachable(
  url: string = DEFAULT_PROBE_URL,
  options: ReachabilityOptions = {}
): Promise<boolean> {
  const { method = "HEAD", timeout = DEFAULT_TIMEOUT, signal } = options
  if (signal?.aborted) return false

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort)
  const timer = setTimeout(abort, timeout)

  try {
    await fetch(withCacheBuster(url), {
      method,
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal: controller.signal,
    })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export interface NetworkStatusOptions extends Omit<ReachabilityOptions, "signal"> {
  /** Same-origin path the probe asks for. An API health route is the better choice where you have one. */
  url?: string
  /** Ceiling on the first retry after a failure, doubling from there. */
  initialDelay?: number
  /** Ceiling the retry spacing stops growing at. */
  maxDelay?: number
  /**
   * Milliseconds between probes while everything is fine. Off by default, and that default is the
   * point: a component dropped into a page should not invent a request every few seconds forever to
   * re-learn something no one has contradicted. The events below cover a connection that goes away,
   * and `check()` covers the app's own failed request, which is a far better signal than a poll.
   * Turn this on for a screen that must notice an upstream dying while it sits untouched — a wallboard,
   * a trading view, a live dashboard.
   */
  pollInterval?: number
  /** Replaces the built-in probe entirely, e.g. a GraphQL ping or a WebSocket liveness check. */
  probe?: (signal: AbortSignal) => Promise<boolean>
  /** Called on each transition, and only on transitions — good for flushing a queue on reconnect. */
  onStatusChange?: (online: boolean) => void
}

export interface NetworkStatusState {
  /** The best current answer. Starts optimistic; see the note on the first render in `useNetworkStatus`. */
  online: boolean
  /** A probe is in flight. Distinct from being offline: the answer is not known yet. */
  checking: boolean
  /** Consecutive failed probes. Drives the retry spacing, and worth showing after a few. */
  failedAttempts: number
  /** Probes now, whatever the schedule says. Call it when one of your own requests has just failed. */
  check: () => Promise<boolean>
}

/**
 * Whether the page can actually reach the network — which is a different question from the one
 * `navigator.onLine` answers.
 *
 * `navigator.onLine` reports whether the machine has a network interface that is up. That is all.
 * A laptop joined to a café access point whose portal has not been logged into is online by that
 * measure; so is one on a Wi-Fi network whose upstream has died, and one where DNS alone has
 * stopped resolving. Every one of those reads `true` while nothing whatsoever loads, which is why
 * a three-line offline banner built on it stays hidden through exactly the outages users complain
 * about. The `false` direction is trustworthy — the browser is not wrong about having no interface
 * at all — so this hook believes `false` immediately and treats `true` as a claim to be checked.
 *
 * Checking means a real request, and the traffic that costs is kept honest:
 *
 *   - **Mount does not probe.** The page in front of the user arrived over the very network in
 *     question, so its own load is the freshest evidence available, and re-establishing it on
 *     every page view would be a request for nothing.
 *   - **The `online` event probes rather than being believed.** It fires when an interface came up,
 *     not when anything can be reached — joining the portal-guarded Wi-Fi fires it, and so does a
 *     laptop waking onto a dead network. A banner that clears here tells the user they are back
 *     when they are not, so only the probe's answer clears it.
 *   - **The `offline` event lands immediately.** No probe: it is the trustworthy direction.
 *   - **While offline, probes back off with jitter** (see `nextProbeDelay`), and stop entirely when
 *     the interface itself is down, since there is nothing to ask and the event will say when there is.
 *   - **A hidden tab probes nothing.** No one is reading it, and background timers are throttled to a
 *     minute or more anyway, so the loop parks and `visibilitychange` restarts it — which also covers
 *     the machine that slept and woke up somewhere else.
 *
 * The first render is deliberately optimistic even where `navigator.onLine` is already `false`. The
 * server cannot know a client's connection, and a first client render that disagrees with the markup
 * is a hydration mismatch; the effect corrects it before paint is noticed.
 */
export function useNetworkStatus(options: NetworkStatusOptions = {}): NetworkStatusState {
  const {
    url = DEFAULT_PROBE_URL,
    method = "HEAD",
    timeout = DEFAULT_TIMEOUT,
    initialDelay = DEFAULT_INITIAL_DELAY,
    maxDelay = DEFAULT_MAX_DELAY,
    pollInterval = 0,
    probe,
    onStatusChange,
  } = options

  const [state, setState] = React.useState({ online: true, checking: false, failedAttempts: 0 })

  // The two function props are read through refs so that passing them inline — which every caller
  // does — does not tear down the listeners and the retry schedule on every render.
  const probeRef = React.useRef(probe)
  const onStatusChangeRef = React.useRef(onStatusChange)
  probeRef.current = probe
  onStatusChangeRef.current = onStatusChange

  // Mirrors state.online outside React, so the loop can compare against it without becoming a
  // dependency of itself, and so `check()` has something to answer with before the effect has run.
  const onlineRef = React.useRef(true)
  const runRef = React.useRef<((force: boolean) => Promise<boolean>) | null>(null)

  React.useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null
    let inFlight: Promise<boolean> | null = null
    let attempt = 0

    function clearTimer() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    function publish(online: boolean, checking: boolean) {
      if (cancelled) return
      setState((prev) =>
        prev.online === online && prev.checking === checking && prev.failedAttempts === attempt
          ? prev
          : { online, checking, failedAttempts: attempt }
      )
      if (online !== onlineRef.current) {
        onlineRef.current = online
        onStatusChangeRef.current?.(online)
      }
    }

    const isVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden"

    /** The browser is certain there is no network at all. This is the direction it cannot be wrong in. */
    const isInterfaceDown = () => typeof navigator !== "undefined" && navigator.onLine === false

    function schedule(delay: number) {
      clearTimer()
      timer = setTimeout(() => {
        timer = null
        void run(false)
      }, delay)
    }

    function run(force: boolean): Promise<boolean> {
      if (cancelled) return Promise.resolve(onlineRef.current)
      // A second caller during a probe waits on the same request rather than opening another. The
      // `online` event and a returning tab often arrive within the same tick.
      if (inFlight) return inFlight
      clearTimer()

      if (isInterfaceDown()) {
        attempt = 0
        publish(false, false)
        // No retry is scheduled: probing a machine with no interface only wakes the radio to fail,
        // and the `online` listener restarts the loop the moment there is something to ask.
        return Promise.resolve(false)
      }

      if (!force && !isVisible()) {
        publish(onlineRef.current, false)
        return Promise.resolve(onlineRef.current)
      }

      publish(onlineRef.current, true)
      controller = new AbortController()
      const signal = controller.signal
      const custom = probeRef.current

      inFlight = (custom ? custom(signal) : checkReachable(url, { method, timeout, signal }))
        .catch(() => false)
        .then((reachable) => {
          inFlight = null
          if (cancelled) return reachable
          if (reachable) {
            attempt = 0
            publish(true, false)
            if (pollInterval > 0) schedule(pollInterval)
          } else {
            attempt += 1
            publish(false, false)
            schedule(nextProbeDelay(attempt - 1, { initialDelay, maxDelay }))
          }
          return reachable
        })
      return inFlight
    }

    runRef.current = run

    function handleOnline() {
      attempt = 0
      void run(true)
    }

    function handleOffline() {
      attempt = 0
      clearTimer()
      controller?.abort()
      publish(false, false)
    }

    function handleVisibilityChange() {
      if (!isVisible()) return
      // Returning to a tab is when the last answer is most likely to be stale — the machine may have
      // slept, moved network, or simply sat there with its backoff timer throttled. Nothing is asked
      // while things are known to be fine and no poll is configured.
      if (!onlineRef.current || pollInterval > 0) void run(false)
    }

    if (isInterfaceDown()) publish(false, false)
    else if (pollInterval > 0) schedule(pollInterval)

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)
    document.addEventListener("visibilitychange", handleVisibilityChange)

    return () => {
      cancelled = true
      runRef.current = null
      clearTimer()
      controller?.abort()
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [url, method, timeout, initialDelay, maxDelay, pollInterval])

  const check = React.useCallback(
    () => runRef.current?.(true) ?? Promise.resolve(onlineRef.current),
    []
  )

  return { ...state, check }
}

export interface NetworkStatusProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onChange">,
    NetworkStatusOptions {
  /** Fixed to an edge of the viewport, or laid out wherever you put it. */
  position?: "top" | "bottom" | "inline"
  /** Shown for as long as the connection is unreachable. */
  offlineMessage?: React.ReactNode
  /** Shown briefly once a probe succeeds again. */
  restoredMessage?: React.ReactNode
  /** How long the restored message stays. 0 leaves the bar silent on the way back. */
  restoredDuration?: number
  /** Offers a manual retry while offline, ahead of the next scheduled probe. */
  showRetry?: boolean
  /** Label of that button. */
  retryLabel?: string
}

/**
 * The bar that tells someone the page has lost the network, and — this being the harder half —
 * only tells them it is back once that has been verified rather than merely announced.
 *
 * Every colour is a shadcn token, so it follows light and dark. For a bar of your own design, take
 * `useNetworkStatus` and leave this one out; the detection is all in the hook.
 *
 * The wording lives in a `role="status"` region that stays mounted whether or not anything is
 * showing. A live region inserted into the page together with its text is not reliably announced,
 * so a bar that mounts on going offline is silent for exactly the people who cannot see it. It stays
 * `polite`, and not because losing a connection is unimportant: `aria-live` is read when the region
 * registers, so switching it to `assertive` on the offline transition would not take effect — and the
 * message stays on screen until it is resolved, so nothing is missed by waiting for a pause.
 *
 * The icon and the retry button sit outside that region on purpose. Inside it, the button's label
 * would be read out again on every transition, alongside the sentence that actually changed.
 */
export function NetworkStatus({
  position = "top",
  offlineMessage = "You're offline. Trying to reconnect…",
  restoredMessage = "Back online",
  restoredDuration = 3000,
  showRetry = true,
  retryLabel = "Retry",
  url,
  method,
  timeout,
  initialDelay,
  maxDelay,
  pollInterval,
  probe,
  onStatusChange,
  className,
  ...props
}: NetworkStatusProps) {
  const status = useNetworkStatus({
    url,
    method,
    timeout,
    initialDelay,
    maxDelay,
    pollInterval,
    probe,
    onStatusChange,
  })

  const [restored, setRestored] = React.useState(false)
  // Whether there is anything to celebrate on the way back. A page that has been online since it
  // loaded should not flash "Back online" at someone who never went anywhere.
  const wasOffline = React.useRef(false)

  React.useEffect(() => {
    if (!status.online) {
      wasOffline.current = true
      setRestored(false)
      return
    }
    if (!wasOffline.current) return
    wasOffline.current = false
    if (restoredDuration <= 0) return
    setRestored(true)
    const timer = setTimeout(() => setRestored(false), restoredDuration)
    return () => clearTimeout(timer)
  }, [status.online, restoredDuration])

  const message = status.online ? (restored ? restoredMessage : null) : offlineMessage
  const showing = message !== null

  return (
    <div
      className={cn(
        "pointer-events-none flex justify-center",
        position === "top" && "fixed inset-x-0 top-0 z-50 p-3",
        position === "bottom" && "fixed inset-x-0 bottom-0 z-50 p-3",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          showing
            ? cn(
                "pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm",
                status.online
                  ? "border-border bg-background text-foreground"
                  : "border-destructive/40 bg-destructive/10 text-foreground"
              )
            : "sr-only"
        )}
      >
        {showing ? (
          status.online ? (
            <Wifi className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : status.checking ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-destructive" aria-hidden="true" />
          ) : (
            <WifiOff className="h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          )
        ) : null}
        <span role="status" aria-live="polite" className="min-w-0">
          {message}
        </span>
        {/*
          The retry is deliberately not disabled while a probe is in flight. A disabled button loses
          focus to the document body, so a keyboard user who pressed Retry would be thrown back to
          the top of the page by their own click; the spinner beside it already says a probe is
          running, and a second press waits on the same request rather than opening another.
        */}
        {showing && !status.online && showRetry ? (
          <button
            type="button"
            onClick={() => void status.check()}
            aria-busy={status.checking || undefined}
            className="shrink-0 rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  )
}
