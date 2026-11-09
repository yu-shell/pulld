"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * One shared place to say something to a screen reader when nothing on screen moved.
 *
 * Mount `<LiveAnnouncer />` once at the app root and call `announce("17 results")` from
 * anywhere — an event handler, an async callback, a router subscription, code that is not
 * React at all. There is no provider and no context, so the call site does not have to be
 * a component or sit under one.
 *
 * Four things about live regions decide this component's shape, and each one is a way the
 * obvious implementation silently says nothing:
 *
 *  1. **A region has to be in the accessibility tree before the text arrives.** Rendering
 *     `<div aria-live="polite">{message}</div>` only when there is a message inserts the
 *     region and its content in one mutation, and that is reliably ignored. So the regions
 *     here are always mounted and always empty until something is said, and a call that
 *     arrives before the announcer has mounted is held and written on a later task rather
 *     than rendered into the announcer's own first commit.
 *
 *  2. **The same string written twice in a row is not read twice.** The region's content
 *     did not change, so there is nothing to announce — which is why "Copied" works once
 *     and then goes quiet. Rather than appending invisible padding to make the text differ
 *     (the reader may read it, and the text is no longer the message), each politeness owns
 *     *two* regions and messages alternate between them: the receiving one always goes from
 *     empty to the message. Emptying the other one says nothing, because `aria-relevant`
 *     defaults to `additions text` and a removal is not in that set.
 *
 *  3. **`polite` and `assertive` need separate regions.** The politeness is read when the
 *     region is registered, so flipping one region's `aria-live` per message is unreliable.
 *     They are four static regions: two polite, two assertive.
 *
 *  4. **`role="status"` is not the same as `aria-live="polite"`.** The role also carries an
 *     implicit `aria-atomic="true"` (present the region as a whole), while a bare
 *     `aria-live` leaves `aria-atomic` at `false` (present only what changed). Both are
 *     written out explicitly below so neither depends on a mapping being implemented.
 *
 * What it deliberately does not do: serialise a burst. Two messages of the same politeness
 * in one task collapse to the last one — the queue holds one message per politeness, not a
 * list — because a region holds one value and a reader polling after both writes would only
 * ever have seen the second. "Loading…" immediately followed by "17 results" should say the
 * latter, not both.
 *
 * Route changes are the usual first use, and the usual mistake is to do it twice: moving
 * focus to the new page's heading already announces the page. Announce the title *or* move
 * focus, not both.
 */

export type AnnouncerPoliteness = "polite" | "assertive"

/** One politeness channel: two regions, written alternately so repeats still register. */
export interface AnnouncerChannel {
  /** The two regions' text. At most one is non-empty. */
  slots: readonly [string, string]
  /** Which slot the next message goes into — always the one not currently holding it. */
  next: 0 | 1
}

export interface AnnouncerState {
  polite: AnnouncerChannel
  assertive: AnnouncerChannel
}

/** How long a message stays in its region before being emptied. */
export const DEFAULT_CLEAR_AFTER_MS = 7000

export const EMPTY_CHANNEL: AnnouncerChannel = { slots: ["", ""], next: 0 }

/**
 * Puts `message` in the channel's empty slot and empties the other one.
 *
 * Pure, and the whole of point 2 above: the slot that receives the text goes from empty to
 * the message every time, so announcing the same string twice in a row is two changes
 * rather than none.
 */
export function writeChannel(
  channel: AnnouncerChannel,
  message: string
): AnnouncerChannel {
  const slots: [string, string] = ["", ""]
  slots[channel.next] = message
  return { slots, next: channel.next === 0 ? 1 : 0 }
}

/**
 * Empties both of a channel's regions without moving `next`.
 *
 * `next` is left where it is so the slot that just spoke stays the one skipped. That keeps
 * the invariant — the next write lands in a slot that did not just hold text — true after a
 * clear as well as after a write.
 */
export function clearChannel(channel: AnnouncerChannel): AnnouncerChannel {
  return { slots: ["", ""], next: channel.next }
}

export function channelHasText(channel: AnnouncerChannel): boolean {
  return channel.slots.some((text) => text !== "")
}

// --- module store (so `announce()` works with no provider, context or React at all) ------

const EMPTY_STATE: AnnouncerState = {
  polite: EMPTY_CHANNEL,
  assertive: EMPTY_CHANNEL,
}

let state: AnnouncerState = EMPTY_STATE
/**
 * What is owed, at most one message per politeness.
 *
 * A map rather than a list, for two reasons that happen to be the same shape: a region
 * holds one value, so a burst collapses anyway (see the note at the top of the file), and
 * on a server — where this module lives as long as the process and nothing ever mounts to
 * drain it — a list would be a queue that only grows.
 */
let queued: { polite?: string; assertive?: string } = {}
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(next: AnnouncerState) {
  state = next
  for (const listener of listeners) listener()
}

/**
 * Writes whatever is owed into the regions.
 *
 * Deferred by a task rather than run inline, which is what makes point 1 hold: a component
 * that announces from its own mount effect can run before the announcer's, and writing then
 * would put text into the announcer's first commit — the region and its content appearing
 * together, the one case that is reliably ignored. By the next task the empty regions have
 * been committed.
 */
function flush() {
  flushTimer = null
  // Nothing is mounted to say it. What is owed is kept, not dropped: whichever announcer
  // mounts next drains it (see `subscribe`).
  if (listeners.size === 0) return

  const batch = queued
  queued = {}
  let next = state
  if (batch.polite !== undefined) {
    next = { ...next, polite: writeChannel(next.polite, batch.polite) }
  }
  if (batch.assertive !== undefined) {
    next = { ...next, assertive: writeChannel(next.assertive, batch.assertive) }
  }
  if (next !== state) emit(next)
}

function scheduleFlush() {
  if (flushTimer === null) flushTimer = setTimeout(flush, 0)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  // A message said before any announcer existed is still owed. This is the other half of
  // point 1 — held at `announce` time, written once there is a committed region for it.
  if (queued.polite !== undefined || queued.assertive !== undefined) scheduleFlush()
  return () => {
    listeners.delete(listener)
    // The last announcer leaving takes its regions with it, so a remount should start
    // silent rather than re-presenting whatever was in them. Anything owed survives.
    if (listeners.size === 0) state = EMPTY_STATE
  }
}

/**
 * Says `message` to assistive technology without moving focus or changing the page.
 *
 * Safe to call from anywhere, including before `<LiveAnnouncer />` has mounted. Blank
 * messages are dropped — a region emptied and refilled with nothing is not a thing to say.
 *
 * `assertive` interrupts whatever is being read. Reserve it for something the reader has to
 * act on now (a session about to expire, a submission that failed); everything else is
 * `polite` and waits for a pause.
 */
export function announce(
  message: string,
  politeness: AnnouncerPoliteness = "polite"
): void {
  if (typeof message !== "string" || message.trim() === "") return
  if (politeness === "assertive") queued.assertive = message
  else queued.polite = message
  scheduleFlush()
}

/**
 * Drops anything owed and empties every region.
 *
 * Emptying says nothing (see point 2), so this is how to cancel an announcement that is no
 * longer true — a route change landing before the previous page's "loaded" was read.
 */
export function clearAnnouncements(): void {
  queued = {}
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  emit(EMPTY_STATE)
}

function clearPoliteness(politeness: AnnouncerPoliteness) {
  emit(
    politeness === "assertive"
      ? { ...state, assertive: clearChannel(state.assertive) }
      : { ...state, polite: clearChannel(state.polite) }
  )
}

/**
 * `announce`, for call sites that would rather import a hook.
 *
 * It returns the same module function every render, so it is stable as a dependency and as
 * a prop. It exists because `announce` is importable directly and some codebases still
 * prefer the hook shape — there is no context behind it.
 */
export function useAnnounce(): typeof announce {
  return announce
}

// --- the component --------------------------------------------------------------------

export interface LiveAnnouncerProps {
  /**
   * Milliseconds before a message is removed from its region, per politeness.
   *
   * It is removed so a reader that walks the page later does not meet a stale sentence
   * sitting in the tree; the removal itself is silent. Leave room for the message to have
   * been read — a second or two is cutting it fine. `0` keeps messages indefinitely, which
   * is fine if every announcement is soon replaced by the next one.
   */
  clearAfter?: number
  className?: string
}

/**
 * The four live regions, visually hidden. Mount exactly one, at the app root.
 *
 * It must stay in the accessibility tree, so it is hidden with `sr-only` (clipped, still
 * announced) and never with `hidden`, `display: none`, `visibility: hidden` or
 * `aria-hidden` — any of those and nothing written here is ever read.
 */
export function LiveAnnouncer({
  clearAfter = DEFAULT_CLEAR_AFTER_MS,
  className,
}: LiveAnnouncerProps) {
  const [snapshot, setSnapshot] = React.useState<AnnouncerState>(() => state)

  React.useEffect(() => {
    const unsubscribe = subscribe(() => setSnapshot(state))
    // A flush can land between this component reading `state` for its initial value and
    // this effect running. Re-reading costs a bail-out when nothing changed and saves a
    // dropped announcement when it did.
    setSnapshot(state)
    return unsubscribe
  }, [])

  // One timer per politeness rather than one for both: a polite message's timer firing must
  // not take an assertive one that arrived a moment ago down with it.
  useClearTimer("polite", snapshot.polite, clearAfter)
  useClearTimer("assertive", snapshot.assertive, clearAfter)

  return (
    <div className={cn("sr-only", className)}>
      {(["polite", "assertive"] as const).map((politeness) =>
        snapshot[politeness].slots.map((text, index) => (
          <div
            key={`${politeness}-${index}`}
            // Role, politeness and atomicity all written out: `role` implies the other two,
            // but which implications are honoured varies, and a region that is polite in
            // one reader and absent in another is the failure this component exists to stop.
            role={politeness === "assertive" ? "alert" : "status"}
            aria-live={politeness}
            aria-atomic="true"
          >
            {text}
          </div>
        ))
      )}
    </div>
  )
}

function useClearTimer(
  politeness: AnnouncerPoliteness,
  channel: AnnouncerChannel,
  clearAfter: number
) {
  const hasText = channelHasText(channel)
  React.useEffect(() => {
    if (!clearAfter || !hasText) return
    const timer = setTimeout(() => clearPoliteness(politeness), clearAfter)
    return () => clearTimeout(timer)
    // `channel` identity, not just `hasText`: every write is a new object, so a second
    // message restarts the timer instead of being emptied on the first one's schedule.
  }, [politeness, channel, hasText, clearAfter])
}
