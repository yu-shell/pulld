"use client"

import * as React from "react"
import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/** Every string a user reads or hears. Override to translate or to reword. */
export interface InfiniteScrollLabels {
  loadMore: string
  /** Shown in the button while a page is in flight, and announced through the live region. */
  loading: string
  /** Announced after each page arrives — the only feedback a screen-reader user gets. */
  loaded: (added: number, total: number) => string
  /** Shown once `hasMore` turns false. */
  end: string
  error: string
  retry: string
}

const defaultLabels: InfiniteScrollLabels = {
  loadMore: "Load more",
  loading: "Loading more…",
  loaded: (added, total) =>
    `${added} more ${added === 1 ? "item" : "items"} loaded. ${total} in total.`,
  end: "You're all caught up.",
  error: "Couldn't load more.",
  retry: "Retry",
}

export interface InfiniteScrollProps {
  /**
   * Load the next page. Return the promise and the sentinel stays quiet until it settles — that
   * is the whole duplicate-fire guard. A rejection is caught here and turns into the error row.
   */
  onLoadMore: () => void | Promise<unknown>
  /** False when the last page has arrived: the sentinel stops firing and `end` is shown. */
  hasMore: boolean
  /** How many rows are currently rendered. Drives the "N more loaded" announcement. */
  itemCount: number
  /** Busy flag for loaders that don't return a promise (react-query, SWR). ORed with the internal one. */
  loading?: boolean
  /** Force the error row. `true` uses `labels.error`; any other node is shown as the message. */
  error?: React.ReactNode
  /** Load automatically when the sentinel scrolls into view. False = button only. */
  auto?: boolean
  /**
   * How many pages may load automatically before the button has to be pressed again. This is what
   * keeps the page footer reachable and stops a slow connection from swallowing twenty pages;
   * pressing the button grants another run. Infinity restores the usual never-ending behaviour.
   */
  autoLoadLimit?: number
  /** The scrolling ancestor, when the list scrolls inside a box rather than the page. */
  root?: React.RefObject<Element | null>
  /** How early to reach for the next page, as an IntersectionObserver margin. */
  rootMargin?: string
  labels?: Partial<InfiniteScrollLabels>
  className?: string
}

interface AutoLoadState {
  /** The sentinel is in view (or within `rootMargin` of it). */
  visible: boolean
  auto: boolean
  hasMore: boolean
  busy: boolean
  errored: boolean
  /** A load whose end can't be observed is outstanding — see `pausedAt` in the component. */
  paused: boolean
  autoLoads: number
  autoLoadLimit: number
}

/**
 * Whether the sentinel should reach for another page right now. Kept as one pure predicate
 * because every one of these terms is a way the usual hand-rolled version misbehaves: dropping
 * `busy` double-fetches, dropping `errored` retries a broken endpoint forever, and dropping the
 * limit runs the list away from the page footer.
 */
function shouldAutoLoad(s: AutoLoadState): boolean {
  if (!s.visible || !s.auto || !s.hasMore) return false
  if (s.busy || s.errored || s.paused) return false
  return s.autoLoads < s.autoLoadLimit
}

/**
 * The footer of a paginated list: an invisible sentinel that loads the next page as it scrolls
 * into view, a button that always does the same job by hand, and a live region that says what
 * arrived. Render it directly after the rows — it draws no list of its own, so it sits happily at
 * the end of a `<ul>` or a grid.
 *
 * A table is the one exception, and not because of anything here: this renders a `<div>`, and the
 * HTML parser moves a `<div>` written inside `<tbody>` out of the table altogether, landing it
 * *above* the table and taking the hydration pass with it. Put it after the `</table>`, or inside
 * a `<td colSpan>` in a footer row.
 *
 * Three things a hand-rolled IntersectionObserver almost always gets wrong are handled here:
 * the page footer stays reachable (automatic loading yields to the button after `autoLoadLimit`
 * pages), rows that appear are announced instead of arriving in silence, and a page that fails
 * stops the automatic loading rather than hammering a broken endpoint in a loop.
 */
export function InfiniteScroll({
  onLoadMore,
  hasMore,
  itemCount,
  loading = false,
  error,
  auto = true,
  autoLoadLimit = 3,
  root,
  rootMargin = "200px",
  labels: labelOverrides,
  className,
}: InfiniteScrollProps) {
  const labels = { ...defaultLabels, ...labelOverrides }

  const sentinelRef = React.useRef<HTMLDivElement>(null)
  const onLoadMoreRef = React.useRef(onLoadMore)
  onLoadMoreRef.current = onLoadMore

  const [visible, setVisible] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [failed, setFailed] = React.useState(false)
  const [pausedAt, setPausedAt] = React.useState<{ itemCount: number; hasMore: boolean } | null>(null)
  const [autoLoads, setAutoLoads] = React.useState(0)
  const [announcement, setAnnouncement] = React.useState("")

  // Both mirror state for guards that have to hold *within* a tick, before React has re-rendered:
  // `busyRef` for a page in flight, `pausedRef` for one already asked for. Without them a
  // double-invoked effect (StrictMode in development) would ask for the same page twice.
  const busyRef = React.useRef(false)
  const pausedRef = React.useRef<{ itemCount: number; hasMore: boolean } | null>(null)
  const busy = pending || loading
  const errored = failed || Boolean(error)
  const errorMessage = error == null || typeof error === "boolean" ? labels.error : error

  // Derived rather than a second effect that clears a `paused` flag: the effect that pauses and
  // the effect that resumes would land in the same batch on mount, and the resume would win.
  const paused = pausedAt !== null && pausedAt.itemCount === itemCount && pausedAt.hasMore === hasMore

  const load = React.useCallback((snapshot: { itemCount: number; hasMore: boolean }) => {
    if (busyRef.current) return
    const held = pausedRef.current
    if (held && held.itemCount === snapshot.itemCount && held.hasMore === snapshot.hasMore) return

    const settle = (ok: boolean) => {
      busyRef.current = false
      setPending(false)
      if (!ok) setFailed(true)
    }

    let result: void | Promise<unknown>
    try {
      result = onLoadMoreRef.current()
    } catch {
      setFailed(true)
      return
    }
    setFailed(false)

    if (typeof (result as Promise<unknown> | undefined)?.then === "function") {
      busyRef.current = true
      pausedRef.current = null
      setPending(true)
      setPausedAt(null)
      Promise.resolve(result).then(
        () => settle(true),
        () => settle(false)
      )
      return
    }

    // Nothing was returned, so there is no way to know when this page lands: a loader that only
    // bumps a page number and lets a data hook fetch in the background looks finished the instant
    // it returns. Rather than show a spinner that might never stop, hold the *automatic* loading
    // until the list itself changes. The button stays live throughout, so the worst case here is
    // one press instead of a burst of duplicate pages.
    pausedRef.current = snapshot
    setPausedAt(snapshot)
  }, [])

  // The sentinel is rendered even after the last page, so this observer outlives `hasMore`
  // flipping (a new filter can put the list back into having more) and never has to be rebuilt
  // around an element that comes and goes.
  React.useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries[entries.length - 1].isIntersecting),
      { root: root?.current ?? null, rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [root, rootMargin])

  // Deciding from state rather than from inside the observer callback is what makes a short first
  // page work: when the list is shorter than the viewport the sentinel never leaves it, so no
  // second intersection event ever comes — but this effect re-runs the moment the load settles and
  // fires again while the sentinel is still in view, until the viewport is full or the limit hits.
  React.useEffect(() => {
    if (!shouldAutoLoad({ visible, auto, hasMore, busy, errored, paused, autoLoads, autoLoadLimit })) return
    setAutoLoads((n) => n + 1)
    load({ itemCount, hasMore })
  }, [visible, auto, hasMore, busy, errored, paused, autoLoads, autoLoadLimit, itemCount, load])

  const previousCount = React.useRef(itemCount)
  React.useEffect(() => {
    const previous = previousCount.current
    previousCount.current = itemCount
    if (itemCount > previous) {
      setAnnouncement(labels.loaded(itemCount - previous, itemCount))
    } else if (itemCount < previous) {
      // The list was replaced rather than extended (a new query, a cleared filter), so the run of
      // automatic loads starts over instead of the fresh list being stuck behind the old count.
      setAutoLoads(0)
    }
    // labels is rebuilt every render; the announcement is keyed off the count alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemCount])

  function handleClick() {
    if (busy) return
    // An explicit press is a fresh mandate: it re-asks for the page the sentinel is holding,
    // clears a failure and re-arms automatic loading.
    pausedRef.current = null
    setAutoLoads(0)
    load({ itemCount, hasMore })
  }

  return (
    <div className={cn("flex w-full flex-col items-center gap-2 py-4", className)}>
      {/* Not aria-hidden: it holds no content, and hiding it would only add a node for assistive
          tech to skip. Kept a pixel tall so it can actually intersect. */}
      <div ref={sentinelRef} className="h-px w-full" />

      <div role="status" aria-live="polite" className="text-sm">
        {errored ? (
          <span className="text-destructive">{errorMessage}</span>
        ) : !hasMore && itemCount > 0 ? (
          <span className="text-muted-foreground">{labels.end}</span>
        ) : null}
        {/* The button carries the visible busy state; this is how it reaches a screen reader. */}
        <span className="sr-only">{busy ? labels.loading : announcement}</span>
      </div>

      {hasMore ? (
        <button
          type="button"
          onClick={handleClick}
          // aria-disabled rather than disabled: a disabled button loses focus, which would drop
          // the user out of the list every time they pressed this one.
          aria-disabled={busy}
          aria-busy={busy}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-background px-4 text-sm font-medium",
            "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            busy && "pointer-events-none opacity-50"
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {busy ? labels.loading : errored ? labels.retry : labels.loadMore}
        </button>
      ) : null}
    </div>
  )
}
