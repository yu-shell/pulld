"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface TocItem {
  /** The heading's `id` in the document — the anchor target, written without the "#". */
  id: string
  /** Text shown in the list. */
  title: string
  /** Heading depth (2 for `h2`, 3 for `h3` …). Only the depth *relative* to the shallowest
   *  item matters, so a page whose headings start at `h3` is not indented as a whole. */
  level?: number
}

interface TocProps extends Omit<React.ComponentPropsWithoutRef<"nav">, "children"> {
  /** Headings in document order. Most MDX pipelines already hand you exactly this shape. */
  items: TocItem[]
  /** Height of a sticky site header, in pixels. Sets the line at which a section becomes the
   *  current one, and how far above the heading a click lands. Defaults to 0. */
  offset?: number
  /** Accessible name for the nav landmark. Defaults to "On this page". */
  label?: string
}

// useLayoutEffect resolves the highlight before paint, so the list never flashes with the
// wrong entry marked; it warns during SSR, so fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/** Indent steps are capped so an `h6` under an `h2` cannot push its label out of a sidebar. */
const MAX_INDENT_STEPS = 3
const INDENT_STEP_PX = 12

/** How long the list stops following the page after a click. See `lockedRef` below. */
const SETTLE_MS = 120

function normalizeLevel(level: number | undefined): number {
  const n = Number(level)
  return Number.isFinite(n) ? n : 2
}

/**
 * The scrollable ancestor that actually moves, or null when that is the page itself.
 *
 * An app shell that scrolls an inner `<main>` rather than the window is common enough that
 * assuming the window would leave the highlight frozen in exactly those layouts.
 */
function findScroller(el: Element | null): Element | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
  }
  return null
}

/**
 * Whether the reader has hit the end of the scrollable area.
 *
 * This is the fix for the oldest bug in hand-rolled scrollspies: the final section is usually
 * shorter than the viewport, so its heading never reaches the activation line and the last
 * entry can never light up no matter how far you scroll. At the bottom there is nothing left
 * to scroll to, so the last heading is by definition the one being read.
 *
 * Content that does not scroll at all is not "at the bottom" — every heading is on screen and
 * the reader is at the top, so the ordinary rule gives the better answer.
 */
function isAtBottom(scroller: Element | null): boolean {
  const el = scroller ?? document.scrollingElement ?? document.documentElement
  const furthest = el.scrollHeight - el.clientHeight
  if (furthest <= 0) return false
  return furthest - el.scrollTop <= 2
}

/**
 * Index of the entry to mark, given each heading's distance from the top of the viewport.
 * A `null` top means the heading is not in the document — those entries are skipped rather
 * than shifting every index after them.
 *
 * The last heading at or above the line wins, so a section stays current for as long as it is
 * being read — including after its own heading has scrolled off the top, which is exactly
 * when a naive "is the heading visible?" test goes blank. The 1px tolerance absorbs sub-pixel
 * layout, which otherwise reports a heading resting exactly on the line as being below it.
 */
function pickActive(
  tops: Array<number | null>,
  line: number,
  atBottom: boolean
): number {
  let first = -1
  let last = -1
  let active = -1
  for (let index = 0; index < tops.length; index++) {
    const top = tops[index]
    if (top === null) continue
    if (first === -1) first = index
    last = index
    if (top - line <= 1) active = index
  }

  if (first === -1) return -1
  if (atBottom) return last
  // Above the first heading — in a page's intro, before any section has started. Marking the
  // first entry beats marking none, which reads as a list that has stopped working.
  return active === -1 ? first : active
}

/**
 * A table of contents for the page being read, with the current section highlighted as the
 * reader scrolls. Use it for the "On this page" rail beside docs, guides, changelogs, long
 * blog posts, API references, legal pages and reports.
 *
 * The list is plain anchors rendered from `items`, so it is server-rendered and works before
 * — and without — JavaScript; the highlight is the only part that needs the client.
 */
export const Toc = React.forwardRef<HTMLElement, TocProps>(function Toc(
  { className, items, offset = 0, label = "On this page", ...props },
  forwardedRef
) {
  // -1 until measured. The server cannot know the scroll position and the first client render
  // has to match what it sent, so the highlight is applied by the layout effect below —
  // before paint, so it is never visibly absent.
  const [activeIndex, setActiveIndex] = React.useState(-1)

  // While set, the list shows this id and stops following the page. A click starts a scroll
  // that can take hundreds of milliseconds, and every heading it travels past would otherwise
  // light up in turn — leaving the entry that was actually clicked as the one thing not
  // highlighted while the animation runs.
  const lockedRef = React.useRef<string | null>(null)
  const settleTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = React.useRef<number | null>(null)

  // Walking the ancestors with getComputedStyle is too much to redo on every frame of a
  // scroll, so the answer is kept until the heading it was derived from is replaced.
  const scrollerRef = React.useRef<Element | null>(null)
  const scrollerSourceRef = React.useRef<Element | null>(null)

  // Serialised rather than joined into one string: ids are compared whole, so an id that
  // happens to contain the separator cannot smear two entries into one.
  const idsKey = JSON.stringify(items.map((item) => item.id))

  // `items` is captured from the render that last changed the ids — the only field measuring
  // reads — so a fresh array carrying the same ids does not need to rebuild this.
  const measure = React.useCallback(() => {
    const elements = items.map((item) => document.getElementById(item.id))

    const locked = lockedRef.current
    if (locked !== null) {
      const lockedIndex = items.findIndex((item) => item.id === locked)
      if (lockedIndex !== -1) {
        setActiveIndex(lockedIndex)
        return
      }
      lockedRef.current = null
    }

    const firstPresent = elements.find((el): el is HTMLElement => el !== null) ?? null
    if (firstPresent !== scrollerSourceRef.current) {
      scrollerSourceRef.current = firstPresent
      scrollerRef.current = findScroller(firstPresent)
    }

    // Distances are taken from the top of whatever is scrolling. For the page that is the
    // viewport; for a nested scroller it is that box, which may sit well down the screen —
    // measuring those headings against the viewport instead would hold the highlight back by
    // however far the box starts below the top of the window.
    const scroller = scrollerRef.current
    const lineTop = scroller ? scroller.getBoundingClientRect().top : 0
    const tops = elements.map((el) =>
      el ? el.getBoundingClientRect().top - lineTop : null
    )
    setActiveIndex(pickActive(tops, offset, isAtBottom(scroller)))
    // idsKey stands in for items: only the ids are read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, offset])

  useIsomorphicLayoutEffect(measure, [measure])

  React.useEffect(() => {
    const schedule = () => {
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        measure()
      })
    }

    const onScroll = () => {
      if (lockedRef.current !== null) {
        // Wait for the scroll to stop before following the page again. Each event pushes the
        // deadline out, so the lock outlives a smooth scroll of any length.
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
        settleTimerRef.current = setTimeout(() => {
          lockedRef.current = null
          measure()
        }, SETTLE_MS)
      }
      schedule()
    }

    // A scroll event does not bubble, but it does travel down the capture path, so a single
    // listener on the window covers the page and any nested scroller inside it.
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", schedule)
    return () => {
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", schedule)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    }
  }, [measure])

  // Taking the page over mid-animation should hand control straight back, rather than leave
  // the reader scrolling with the list still pinned to whatever they last clicked.
  React.useEffect(() => {
    const release = () => {
      if (lockedRef.current === null) return
      lockedRef.current = null
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      measure()
    }
    const options = { capture: true, passive: true } as const
    window.addEventListener("wheel", release, options)
    window.addEventListener("touchstart", release, options)
    return () => {
      window.removeEventListener("wheel", release, options)
      window.removeEventListener("touchstart", release, options)
    }
  }, [measure])

  // Headings move when an image above them loads or a web font swaps in, neither of which
  // fires a scroll or a resize.
  React.useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return
    let cancelled = false
    document.fonts.ready.then(() => {
      if (!cancelled) measure()
    })
    return () => {
      cancelled = true
    }
  }, [measure])

  function handleClick(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    // Leave anything but a plain left click alone, so opening a section in a new tab or
    // window keeps working — the href is a real one.
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    const target = document.getElementById(id)
    // Let the browser attempt the fragment itself rather than swallow the click.
    if (!target) return
    event.preventDefault()

    lockedRef.current = id

    const scroller = findScroller(target)
    const behavior: ScrollBehavior = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches
      ? "auto"
      : "smooth"

    // The browser's own fragment jump lands the heading flush with the top of the viewport,
    // where a sticky header sits on top of it. Doing the scroll here is what `offset` buys.
    if (scroller) {
      const top =
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        offset
      scroller.scrollTo({ top, behavior })
    } else {
      const top = target.getBoundingClientRect().top + window.scrollY - offset
      window.scrollTo({ top, behavior })
    }

    // Preventing the default also cancels the focus move the browser would have done, which
    // is how a keyboard reader gets *into* the section: without this, tabbing on from the
    // link carries on through the rest of the contents instead of the text just scrolled to.
    // The attribute is borrowed rather than kept, so the page is left as it was found.
    if (!target.hasAttribute("tabindex")) {
      target.setAttribute("tabindex", "-1")
      target.addEventListener("blur", () => target.removeAttribute("tabindex"), {
        once: true,
      })
    }
    target.focus({ preventScroll: true })

    // replaceState rather than pushState: the URL stays shareable, but reading one long page
    // does not bury the page the reader arrived from under a dozen back-button steps.
    if (typeof history !== "undefined" && history.replaceState) {
      history.replaceState(null, "", `#${id}`)
    }

    setActiveIndex(items.findIndex((item) => item.id === id))
  }

  if (items.length === 0) return null

  const shallowest = Math.min(...items.map((item) => normalizeLevel(item.level)))

  return (
    <nav
      ref={forwardedRef}
      aria-label={label}
      className={cn("text-sm", className)}
      {...props}
    >
      <ol className="space-y-1">
        {items.map((item, index) => {
          const isActive = index === activeIndex
          const steps = Math.min(
            Math.max(normalizeLevel(item.level) - shallowest, 0),
            MAX_INDENT_STEPS
          )
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                onClick={(event) => handleClick(event, item.id)}
                // aria-current="location" — the reader is not on some other page, they are at
                // a place within this one. Announced, unlike a colour change on its own.
                aria-current={isActive ? "location" : undefined}
                // Inline rather than a `pl-${n}` class: the depth is a runtime value, and a
                // dynamic class name is invisible to Tailwind's scanner — it would work in
                // dev and then silently vanish from the production build.
                style={{ paddingLeft: steps * INDENT_STEP_PX }}
                className={cn(
                  "block rounded-sm py-0.5 leading-snug transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isActive
                    ? "font-medium text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {item.title}
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
})
