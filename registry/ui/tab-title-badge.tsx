"use client"

import * as React from "react"

/**
 * Put "(3)" in front of the tab title while the reader is somewhere else, and take it back off
 * without stealing the title from the page.
 *
 * Everything below was written against a probe page driven in a real browser (Chromium / macOS,
 * 2026-10-27), because the obvious four-line version — remember `document.title` on mount, write
 * `"(" + count + ") " + remembered`, put the remembered one back on unmount — is wrong in four
 * separate ways that all look fine on a single static page:
 *
 *   - The remembered title goes stale. In a single-page app the router writes a new title on every
 *     navigation, so the value captured at mount belongs to whatever page was open *then*;
 *     restoring it on unmount puts the old page's title back over the new page.
 *   - Writing the same string still counts as a change. Measured: assigning `document.title` a
 *     value it already holds fires a mutation record all the same. So "re-apply the badge whenever
 *     the title changes" re-enters its own observer forever — in the probe it looped until a
 *     counter cut it off.
 *   - The change does not arrive where a first guess puts it. `document.title = x` replaces the
 *     text node inside `<title>`, which is a **childList** record on that element, not
 *     `characterData`; and a framework that swaps the whole `<title>` element (what title-managing
 *     libraries do) produces a childList record on `<head>` and leaves an observer bound to the old
 *     element watching a node that is no longer in the document. One observer on `<head>` with
 *     `subtree` catches both; neither narrower choice catches the other case.
 *   - Two of these on one page fight over the same string. There is one `document.title`, so a
 *     second instance is not a second badge, it is a second writer — hence the module-scope owner
 *     below, the same shape pulld's fullscreen-button and read-aloud use for the other page-wide
 *     APIs.
 *
 * What is deliberately *not* here: stamping the number onto the favicon. The mechanics work (an SVG
 * favicon draws onto a canvas at an explicit size, and `toDataURL` returns a PNG for a same-origin
 * icon — both measured), but a swapped `<link rel="icon">` produced no icon fetch and no visible
 * change anywhere it could be observed, so shipping it would mean shipping an effect nobody had
 * seen happen.
 */

/** The template tokens, so the regex-free substitution below has one spelling. */
const BADGE_TOKEN = "{badge}"
const TITLE_TOKEN = "{title}"

/** `"(3) Inbox"` — the convention every mail client and chat app already taught people to read. */
export const DEFAULT_TEMPLATE = `(${BADGE_TOKEN}) ${TITLE_TOKEN}`

export interface FormatBadgeOptions {
  /** How many unseen things there are. Anything below 1 is nothing to announce. */
  count?: number
  /** Show this exact text instead of a number — `"New"`, `"●"`, `"2 failed"`. Wins over `count`. */
  label?: string
  /** Counts above this are written as `"99+"`. */
  max?: number
}

/**
 * The badge text, or `null` when there is nothing to show.
 *
 * Separate and pure so the awkward values can be pinned without a document: a count of zero, a
 * negative count from a subtraction that went past the end, a fraction from a progress figure that
 * was never meant to be a count.
 */
export function formatBadge({ count, label, max = 99 }: FormatBadgeOptions): string | null {
  if (label != null && label !== "") return label
  if (count == null || !Number.isFinite(count)) return null
  // Truncation, not rounding: 1.7 unread items is one item and a bug somewhere upstream, and
  // showing "2" would invent one that does not exist.
  const whole = Math.trunc(count)
  if (whole < 1) return null
  if (max > 0 && whole > max) return `${max}+`
  return String(whole)
}

/**
 * Put the badge and the page's own title into the template.
 *
 * Literal substitution, with no cleverness about a template that leaves `{title}` out: a caller who
 * writes `"{badge} unread"` gets exactly that, and gets to decide that the page title is not worth
 * the space. The one thing it will not do is leave the token sitting in the tab.
 */
export function applyTemplate(template: string, badge: string, title: string): string {
  return template.split(BADGE_TOKEN).join(badge).split(TITLE_TOKEN).join(title)
}

/**
 * Which of `visibilitychange` and `focus` decides that the reader is here.
 *
 * `"visible"` is the Page Visibility rule: the tab is the frontmost tab of a window that is not
 * minimised. That is the usual meaning of "they are looking", and it is the default because it is
 * what the badge is for — the tab is in the background, so put the news where a background tab can
 * show it.
 *
 * `"focus"` additionally requires the window itself to be in front. The difference is real and
 * easy to miss: a tab stays `visible` while its whole window sits behind the editor, so under the
 * default rule a message that arrives while the reader is in another application clears itself
 * without ever being seen. Choose this one when a cleared badge is meant to mean "they read it".
 */
export type SeenRule = "visible" | "focus"

export interface UseTabTitleBadgeOptions extends FormatBadgeOptions {
  /**
   * How the badge joins the page's own title. Both `{badge}` and `{title}` are substituted.
   * Examples: `"({badge}) {title}"`, `"{badge} • {title}"`, `"{title} — {badge} new"`.
   */
  template?: string
  /** What counts as the reader being here. See `SeenRule`. */
  seenRule?: SeenRule
  /**
   * Keep the badge up even while the reader is looking at the page.
   *
   * Off by default, which is the whole point of the component: a tab the reader is already reading
   * does not need to be shouted at, and a number that stays in the title while they watch the
   * thing it counts is the oldest way to look broken.
   */
  showWhileSeen?: boolean
  /**
   * Alternate between the badged title and the page's own title every N milliseconds. `0` is off,
   * and off is the default — a blinking tab is a strong thing to do to somebody.
   *
   * The alternation is driven by a timer, and a background tab is exactly where browsers slow
   * timers down to once a second or less. Nothing here depends on the rate: each tick asks for a
   * title and the single writer below settles it, so a throttled tab blinks slowly rather than
   * landing on the wrong string.
   */
  blinkMs?: number
  /**
   * Called when the reader arrives while a badge is showing — zero your own counter here.
   *
   * The badge is a view of your state, not a copy of it: this hook never decides that something has
   * been read. If the count stays where it was, the badge comes back the next time they leave.
   */
  onSeen?: () => void
}

export interface TabTitleBadgeState {
  /** The page's own title, as last written by anything that is not this hook. */
  baseTitle: string
  /** The badge text, or `null` when nothing is showing. */
  badge: string | null
  /** Whether the reader is here, by the rule `seenRule` selects. */
  isSeen: boolean
  /**
   * Whether this instance is the one driving the tab title.
   *
   * `false` means another one claimed it first. There is one title, so the second instance holds
   * still rather than fighting; read this if you would rather surface the clash than let it be
   * quiet.
   */
  isOwner: boolean
}

/**
 * One owner per document, claimed by whichever instance mounts first.
 *
 * Module scope, like the page-wide APIs in pulld's fullscreen-button and read-aloud: the thing
 * being owned is not this component's state, it is the document's one title.
 */
let titleOwner: symbol | null = null

/** True when the document is being looked at under `rule`. SSR-safe: no document, nobody looking. */
function readIsSeen(rule: SeenRule): boolean {
  if (typeof document === "undefined") return false
  if (document.visibilityState !== "visible") return false
  // `hasFocus()` is the only part of this that distinguishes a window in front from a window
  // merely un-minimised.
  if (rule === "focus") return typeof document.hasFocus === "function" ? document.hasFocus() : true
  return true
}

/**
 * The whole behaviour. Renders nothing, because what it changes is the tab, not the page.
 */
export function useTabTitleBadge({
  count,
  label,
  max,
  template = DEFAULT_TEMPLATE,
  seenRule = "visible",
  showWhileSeen = false,
  blinkMs = 0,
  onSeen,
}: UseTabTitleBadgeOptions = {}): TabTitleBadgeState {
  const badge = formatBadge({ count, label, max })

  // Starts "being looked at" so that the server's render and the first client render agree, and so
  // that a page which hydrates in the foreground never flashes a badge at a reader who is right
  // there. Settles on mount.
  const [isSeen, setIsSeen] = React.useState(true)
  const [baseTitle, setBaseTitle] = React.useState("")
  const [isOwner, setIsOwner] = React.useState(false)
  // Which half of the blink is showing. Meaningless while `blinkMs` is 0.
  const [blinkOn, setBlinkOn] = React.useState(true)

  // The exact string this hook last put in the tab. The discriminator for "did that change come
  // from us?", and it has to be the value rather than a flag: two writes in one task arrive as one
  // observer callback carrying two records, so counting callbacks mis-attributes them, while
  // comparing the title to what was written cannot.
  const writtenRef = React.useRef<string | null>(null)
  const baseRef = React.useRef("")
  const ownerRef = React.useRef<symbol | null>(null)

  const onSeenRef = React.useRef(onSeen)
  React.useEffect(() => {
    onSeenRef.current = onSeen
  }, [onSeen])

  /**
   * The one place `document.title` is assigned.
   *
   * The equality check is not an optimisation. Assigning a title the value it already holds still
   * fires the mutation observer below, so a writer without this guard answers its own notification
   * with another write and never stops.
   */
  const write = React.useCallback((next: string) => {
    if (typeof document === "undefined") return
    writtenRef.current = next
    if (document.title !== next) document.title = next
  }, [])

  // Claim the title, and hand it back. Written as its own effect so the claim outlives the prop
  // changes that re-run the effect below, and so React's development double-mount releases and
  // re-claims in order rather than leaving the document owned by a hook that is gone.
  React.useEffect(() => {
    if (typeof document === "undefined") return
    // Already ours. Checked before the claim rather than relying on this effect running exactly
    // once: re-entering it must not look like a second instance arriving and stand this one down
    // from a title it is already driving.
    if (ownerRef.current !== null && titleOwner === ownerRef.current) return
    if (titleOwner !== null) {
      setIsOwner(false)
      return
    }
    const token = Symbol("tab-title-badge")
    titleOwner = token
    ownerRef.current = token
    setIsOwner(true)
    const initial = document.title
    baseRef.current = initial
    setBaseTitle(initial)
    return () => {
      // The restore is what makes this safe to unmount mid-badge: the page gets its own title back,
      // whatever the router has made it since this mounted.
      if (typeof document !== "undefined" && document.title !== baseRef.current) {
        document.title = baseRef.current
      }
      writtenRef.current = null
      if (titleOwner === token) titleOwner = null
      ownerRef.current = null
      setIsOwner(false)
    }
  }, [])

  // Who is here. Both events, because the two rules need different ones and listening to both costs
  // nothing: `visibilitychange` for the tab, `focus`/`blur` for the window.
  React.useEffect(() => {
    if (typeof document === "undefined") return
    const settle = () => setIsSeen(readIsSeen(seenRule))
    settle()
    document.addEventListener("visibilitychange", settle)
    window.addEventListener("focus", settle)
    window.addEventListener("blur", settle)
    return () => {
      document.removeEventListener("visibilitychange", settle)
      window.removeEventListener("focus", settle)
      window.removeEventListener("blur", settle)
    }
  }, [seenRule])

  // "They came back while something was waiting." Fired from the transition rather than from the
  // event, so a window that is alt-tabbed over twice does not report the same arrival twice.
  const wasSeenRef = React.useRef(true)
  React.useEffect(() => {
    const was = wasSeenRef.current
    wasSeenRef.current = isSeen
    if (!isOwner || was || !isSeen || badge === null) return
    onSeenRef.current?.()
  }, [badge, isOwner, isSeen])

  const wanted = isOwner && badge !== null && (showWhileSeen || !isSeen)

  // The blink timer. Only runs while something is actually showing, so an idle page holds no
  // interval, and it always leaves the badged half on the way out.
  //
  // Held in a ref and cleared before any new one is started, rather than created fresh each time
  // this effect runs: two intervals on the same swing do not blink twice as visibly, they toggle
  // twice per period and cancel out, which reads as a badge that never blinks at all.
  const blinkRef = React.useRef<{ id: ReturnType<typeof setInterval>; ms: number } | null>(null)
  const stopBlink = React.useCallback(() => {
    if (blinkRef.current === null) return
    clearInterval(blinkRef.current.id)
    blinkRef.current = null
  }, [])

  // Stopping the swing is its own effect as well as part of the one below, because the one below
  // returns no cleanup on the run that finds a timer it is happy with — and an interval whose only
  // owner is a cleanup that was never registered outlives the page it was blinking for.
  React.useEffect(() => stopBlink, [stopBlink])

  React.useEffect(() => {
    const stop = stopBlink
    if (!wanted || blinkMs <= 0) {
      stop()
      setBlinkOn(true)
      return
    }
    // Already swinging at this rate. Restarting it here would reset the phase on every unrelated
    // render, so a page that re-renders often would hold the badge up and never show the other half.
    if (blinkRef.current?.ms === blinkMs) return
    stop()
    blinkRef.current = { id: setInterval(() => setBlinkOn((on) => !on), blinkMs), ms: blinkMs }
    return () => {
      stop()
      setBlinkOn(true)
    }
  }, [blinkMs, stopBlink, wanted])

  // What the tab should say, kept where anything that writes can reach it.
  //
  // A ref rather than a closure, and this is the whole reason the component does not deadlock: the
  // observer below outlives the renders that change the badge, so a version that closed over
  // `badge` and `blinkOn` would have one writer asking for the badged title and another — created a
  // render earlier — asking for the plain one. Each would see the other's write as somebody else's,
  // answer it, and the two would trade the title back and forth inside microtasks, which starves
  // the event loop so completely that no timer ever runs again. Every writer reading the same ref
  // cannot disagree.
  const viewRef = React.useRef({ wanted: false, badge: null as string | null, template, blinkOn: true })

  const desiredTitle = React.useCallback(() => {
    const view = viewRef.current
    if (!view.wanted || view.badge === null || !view.blinkOn) return baseRef.current
    return applyTemplate(view.template, view.badge, baseRef.current)
  }, [])

  // Adopt whatever anyone else puts in the title as the page's own. This is the part that makes the
  // component more than a one-liner: the title is shared, the router writes it whenever it likes,
  // and the only honest base title is the most recent one that did not come from here.
  //
  // One observer, on `<head>`, with `subtree`. A plain assignment arrives as a childList record on
  // `<title>`; a library that swaps the element arrives as a childList record on `<head>` and would
  // be missed entirely by an observer bound to the element that was replaced.
  React.useEffect(() => {
    if (typeof document === "undefined" || !isOwner) return
    const observer = new MutationObserver(() => {
      const current = document.title
      if (current === writtenRef.current) return
      // Somebody else owns this string now — a route change, a title library, a stray assignment.
      // Their value is the page's own title from here on, and the badge goes back on top of it.
      baseRef.current = current
      setBaseTitle(current)
      write(desiredTitle())
    })
    observer.observe(document.head, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [desiredTitle, isOwner, write])

  // And keep it up to date as the badge, the blink and the reader's attention change.
  React.useEffect(() => {
    if (typeof document === "undefined" || !isOwner) return
    viewRef.current = { wanted, badge, template, blinkOn }
    write(desiredTitle())
  }, [badge, blinkOn, desiredTitle, isOwner, template, wanted, write])

  return { baseTitle, badge, isSeen, isOwner }
}

export interface TabTitleBadgeProps extends UseTabTitleBadgeOptions {
  /**
   * Called on every change, for a page that wants to mirror the tab somewhere else — a heading, a
   * document-level live region, a test.
   */
  onStateChange?: (state: TabTitleBadgeState) => void
}

/**
 * The declarative form: drop it in a layout and feed it a count.
 *
 * It renders nothing at all. There is no element to show, because what it writes is the one piece
 * of this page that lives outside it — put the same number in the page itself with a badge, a
 * heading, or pulld's stat-card.
 *
 * ```tsx
 * <TabTitleBadge count={unread} onSeen={() => markAllRead()} />
 * ```
 */
export function TabTitleBadge({ onStateChange, ...options }: TabTitleBadgeProps) {
  const state = useTabTitleBadge(options)

  const onStateChangeRef = React.useRef(onStateChange)
  React.useEffect(() => {
    onStateChangeRef.current = onStateChange
  }, [onStateChange])

  const { baseTitle, badge, isSeen, isOwner } = state
  React.useEffect(() => {
    onStateChangeRef.current?.({ baseTitle, badge, isSeen, isOwner })
  }, [baseTitle, badge, isSeen, isOwner])

  return null
}
