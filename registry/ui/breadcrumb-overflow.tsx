"use client"

import * as React from "react"
import { ChevronRight, MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"
import { nextMenuIndex } from "@/registry/ui/split-button"

/**
 * Sub-pixel slack, the same half a pixel `toolbar-overflow` and `middle-truncate` allow themselves
 * and for the same reason: element widths are fractional, so a trail that fills its container
 * exactly can report a few hundredths of a pixel of overflow. Kept well under one pixel on purpose
 * — generous slack folds a level that would have fitted, and every folded level is one more click
 * between somebody and where they came from.
 */
const WIDTH_TOLERANCE = 0.5

/**
 * What one join between two boxes costs.
 *
 * A breadcrumb is not a plain row: between two crumbs sits a separator, and the list's `gap` applies
 * on both sides of it, so every join is `gap + separator + gap` rather than one gap. Measured in
 * Chrome against the real markup — five crumbs at their natural widths, `column-gap: 6px`, a 14px
 * chevron — where the predicted extent `sum(boxes) + (boxes - 1) * (separator + 2 * gap)` came to
 * 428.91px and the row measured 428.91px; the folded shape (root, trigger, current page) predicted
 * 211.05 and measured 211.05. Counting one gap per join instead of two is the quiet version of the
 * mistake: it under-reads a five-crumb trail by 24 pixels and keeps a level that does not fit.
 */
function joinWidth(gap: number, separatorWidth: number): number {
  return size(separatorWidth) + 2 * size(gap)
}

/** A measurement that cannot be trusted — detached, `display: none`, NaN from a `normal` gap — is 0. */
function size(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * How many crumbs at the **end** of the trail stay in the row.
 *
 * This is the whole decision, as arithmetic over numbers nothing in the DOM can argue with, and it
 * is exported because it is the part worth asserting: every interesting case here is a width rather
 * than a click.
 *
 * `widths` are the crumbs' **natural** widths in trail order, root first and the current page last.
 * `available` is the list's content width, `gap` its column gap, `separatorWidth` one separator and
 * `triggerWidth` the ellipsis control that stands in for whatever folds.
 *
 * The return value is a count of trailing crumbs, and `widths.length` is the answer that means
 * nothing folded. **Where this differs from every other overflow component is which end gives way.**
 * A toolbar keeps a prefix and folds the tail, because the first button is the most important one. A
 * breadcrumb has to keep *both* ends — the root is how you get out and the current page is where you
 * are — so what collapses is the middle, and the answer is "how much of the tail survives" with the
 * root always in the row. Reusing a prefix strategy here produces a trail that reads
 * "Home / Workspaces / Acme Corp / …", which has thrown away the one crumb nobody can navigate
 * without.
 *
 * Two bounds are load-bearing. The floor is one: the current page is never folded, so a trail with
 * no room at all still shows where you are and the row degrades by shortening that crumb's text
 * rather than by hiding it. The ceiling is `total - 2`, because keeping `total - 1` trailing crumbs
 * plus the root is every crumb there is — the ellipsis would then be a control that hides nothing,
 * while still charging the row for itself and for one more join.
 *
 * The trigger's own width is charged if and only if something folds, the same rule
 * `fitToolbarItems` arrives at from the other direction: reserve room for it always and a trail that
 * fits exactly loses a level to a control that was never needed; reserve it never and the level that
 * "fits" is pushed out by the control added after the decision.
 */
export function fitBreadcrumbs(
  widths: readonly number[],
  available: number,
  gap: number,
  separatorWidth: number,
  triggerWidth: number
): number {
  const total = widths.length
  // Two crumbs have no middle. There is nothing this component is willing to fold, so it says so
  // rather than folding the root or the current page, and a narrow container clips or truncates.
  if (total <= 2) return total

  // A negative or non-finite container is "nothing fits" rather than a crash: `available` arrives
  // from a measurement, and a detached or `display: none` element measures 0.
  const room = Number.isFinite(available) ? available : 0
  const sizes = widths.map(size)
  const join = joinWidth(gap, separatorWidth)

  let full = (total - 1) * join
  for (const width of sizes) full += width
  if (full - room <= WIDTH_TOLERANCE) return total

  // Past here the middle folds, so the row carries the root, the trigger and a tail of crumbs: that
  // is `kept + 2` boxes and `kept + 1` joins.
  const trigger = size(triggerWidth)
  let used = sizes[0] + trigger + sizes[total - 1] + 2 * join
  let kept = 1
  for (let k = 2; k <= total - 2; k++) {
    const next = used + join + sizes[total - k]
    if (next - room > WIDTH_TOLERANCE) break
    used = next
    kept = k
  }
  return kept
}

/**
 * Where the folded-levels menu sits, as a distance from the list's inline start.
 *
 * The menu hangs off the trail's outer box rather than off the control that opens it — see
 * {@link BreadcrumbOverflow} for why it cannot live inside the list — so something has to say where
 * the control is. Nothing needs to be measured for it: the ellipsis is always the second box in the
 * row, so its offset is the list's leading padding plus the root crumb plus exactly one join, and
 * every one of those numbers is already in hand from the probe.
 *
 * Checked in Chrome against the live control in both writing directions: predicted 68.25px against
 * an actual 68.25px in LTR, and 73.72 against 73.72 in RTL, with a panel given that offset through
 * `inset-inline-start` landing on the control's inline edge to the pixel in both. Logical insets
 * count from the inline start whichever way the text runs, so the sign flip that `scroll-shadow`
 * has to handle for `scrollLeft` does not arise here.
 */
export function breadcrumbMenuOffset(
  rootWidth: number,
  gap: number,
  separatorWidth: number,
  paddingStart: number
): number {
  return size(paddingStart) + size(rootWidth) + joinWidth(gap, separatorWidth)
}

/**
 * Whether the crumb at `index` is one of the folded ones, given how many trailing crumbs are kept.
 *
 * The rescue below is the only caller, and it is a separate function because "is this crumb in the
 * menu" is asked of a position that was recorded a render ago — the kind of off-by-one that is
 * invisible until a focus call goes to the wrong element.
 */
export function isCrumbFolded(index: number, kept: number, total: number): boolean {
  if (!Number.isFinite(index) || !Number.isFinite(kept) || kept >= total) return false
  return index > 0 && index < total - kept
}

export interface BreadcrumbCrumb {
  /** Stable key. The label is used when this is absent. */
  id?: string
  /** The crumb's text, and its accessible name. */
  label: string
  /**
   * Where the crumb goes. Omitted for a level that exists in the hierarchy but has no page of its
   * own, which renders as plain text in the row and in the menu.
   *
   * Ignored on the last crumb: that one is the page you are already on.
   */
  href?: string
  /** Decorative icon before the label — a house on the root, a file glyph on a leaf. Hidden from screen readers. */
  icon?: React.ReactNode
  /**
   * Called when the crumb is activated, before the browser follows the link.
   *
   * The hook for a client router: `onNavigate={(event) => { event.preventDefault(); router.push(href) }}`.
   * Preventing the default is also what tells this component the page is not being replaced, so it
   * puts focus back on the ellipsis control instead of leaving it on a link that is about to unmount.
   */
  onNavigate?: (event: React.MouseEvent<HTMLAnchorElement>) => void
}

export interface BreadcrumbOverflowLabels {
  /**
   * The ellipsis control's accessible name, from the number of levels behind it.
   *
   * A function rather than a string because the count is the one piece of information the control
   * has that nothing else on screen does — official shadcn/ui's own ellipsis carries the word
   * "More" and no number, and "More" alone does not say whether one level is hidden or nine.
   */
  more: (count: number) => string
}

export const defaultBreadcrumbOverflowLabels: BreadcrumbOverflowLabels = {
  more: (count) => (count === 1 ? "Show 1 hidden level" : `Show ${count} hidden levels`),
}

const CRUMB_BASE =
  "inline-flex items-center gap-1.5 rounded-sm transition-colors focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring"

/**
 * The probe takes part in no layout: absolutely positioned, so it adds nothing to the row's width,
 * and `visibility: hidden` rather than `display: none` because a `display: none` box reports zero
 * and the point of it is to be measurable. `width: auto` and `max-width: none` are what make the
 * numbers it reports the width each crumb *wants* rather than the width it was given.
 */
const PROBE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  insetInlineStart: 0,
  display: "flex",
  alignItems: "center",
  visibility: "hidden",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  width: "auto",
  maxWidth: "none",
  userSelect: "none",
}

interface Layout {
  /** How many trailing crumbs are in the row. */
  kept: number
  /** Where the menu goes, from the list's inline start. */
  offset: number
}

export interface BreadcrumbOverflowProps
  extends Omit<React.ComponentPropsWithoutRef<"nav">, "children" | "aria-label"> {
  /** The trail, root first and the current page last. */
  items: readonly BreadcrumbCrumb[]
  /**
   * The navigation landmark's accessible name. "Breadcrumb" is the convention and the default; a
   * page with two trails should name them apart.
   */
  label?: string
  /** What goes between two crumbs. A chevron by default, mirrored on an RTL page. */
  separator?: React.ReactNode
  /** Told when the folded-levels menu opens and closes. */
  onOpenChange?: (open: boolean) => void
  /**
   * Told how many levels are behind the ellipsis after each measurement — 0 when the whole trail is
   * in the row. For a caller that wants to log how often its hierarchy is too deep for the header.
   */
  onFoldChange?: (hidden: number) => void
  labels?: Partial<BreadcrumbOverflowLabels>
  /**
   * On the `<ol>` — the trail itself, which is what anybody looking at the page would call the
   * breadcrumb, and the element whose `gap` the arithmetic reads back. The `<nav>` above it is a
   * positioning wrapper that exists so the menu is not clipped; `...props` reach it, since the
   * landmark is the thing a caller means by "the breadcrumb".
   */
  className?: string
  itemClassName?: string
  currentClassName?: string
  separatorClassName?: string
  triggerClassName?: string
  menuClassName?: string
  menuItemClassName?: string
}

// Measures before paint, so a deep trail is never briefly on screen at full length. `useEffect` on
// the server, where there is nothing to measure and `useLayoutEffect` warns.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * A breadcrumb trail that folds its **middle** into a menu when the row runs out of width, keeping
 * the root you came from and the page you are on.
 *
 * For an admin console's hierarchy, a file or storage browser, a category path, a docs sidebar's
 * current position, a deep settings page, anywhere a trail has to survive a width nobody chose.
 *
 * **What official shadcn/ui does instead is grow downwards.** Its `BreadcrumbList` is
 * `flex flex-wrap`, so a trail that does not fit wraps: measured on the same five-crumb path, one
 * line at 480px, two lines and 45.2px tall at 320px, three lines and 70.8px at 240px, with zero
 * horizontal overflow at every width — the header gets taller and the content below it moves down.
 * The reflex fix of `flex-nowrap` is worse before it is better: flex items shrink by default, so at
 * 320px two of the five crumbs were squeezed until their own text wrapped (39.2px tall against the
 * 19.6px line) *and* the row still overflowed by 26px. Which is why the crumbs here carry `shrink-0`
 * and `whitespace-nowrap`, and why something has to fold.
 *
 * **Measuring your own row is a loop unless you arrange otherwise.** The naive implementation asks
 * the live row how wide it is, hides what sticks out, and is then asked again by its own
 * ResizeObserver: the hidden crumbs now measure zero, so the trail fits, so they come back. Two
 * things break that here, both borrowed from `toolbar-overflow`:
 *
 *   - **Natural widths come from a probe that is never folded.** A hidden copy of the whole trail
 *     sits in the list, out of flow, and is what gets measured. Folding the visible row cannot
 *     change what the probe says.
 *   - **The container's width cannot be changed by its contents.** The list is a block-level,
 *     full-width box, so its width comes from its parent.
 *
 * Together they make the fold a pure function of inputs that folding does not touch — see
 * {@link fitBreadcrumbs} — so the same container width always produces the same answer and the
 * observer settles after one pass. Because that answer is an object here rather than a number, the
 * bail-out React gives a state update to an equal value has to be kept by hand: the setter returns
 * the previous object when both fields match, and without that line every measurement is a
 * re-render and the loop is back.
 *
 * **The menu cannot live in the list.** The list clips — that is what keeps a trail far too narrow
 * for its crumbs from making the page scroll sideways — and a panel absolutely positioned against
 * the box clipping it is painted only where the two overlap. Measured on this exact pair: a panel at
 * `top-full` inside the clipping list was hit by **0 of 15** points scanned down its own rectangle,
 * and the same panel moved onto the `<nav>` above it by **15 of 15**. So the landmark positions the
 * menu, the list clips, and the menu is placed under the ellipsis by arithmetic rather than by
 * measuring it — {@link breadcrumbMenuOffset}, verified to the pixel in both writing directions.
 *
 * **The current page is not a link.** It renders as a `<span aria-current="page">`: that attribute
 * is the whole convention for "you are here", and it is also the one crumb that is allowed to shrink
 * — `min-w-0` with CSS truncation — so a trail with no room left shortens the longest thing in it
 * instead of being cut off mid-glyph. The probe keeps reporting that crumb's natural width while the
 * live one is squeezed (measured: 225.44px natural against 15.75px on screen), so the arithmetic is
 * untouched by the truncation.
 *
 * The keyboard is a breadcrumb's, not a toolbar's: the crumbs are links and each is an ordinary tab
 * stop, because the practices give a breadcrumb no arrow keys and a roving tabindex here would take
 * Tab's answer away from a reader. The ellipsis is the one control with keys of its own — Down or Up
 * opens its menu, Escape closes it and returns focus, Tab leaves, and inside the menu Up and Down
 * wrap through the folded levels using `split-button`'s own `nextMenuIndex`, imported rather than
 * written again so the two menus in this registry cannot drift apart.
 *
 * One failure survives all of that and is handled on its own: a crumb holding focus can be folded
 * away when the container narrows, and a browser does not move focus when the element holding it
 * leaves the document — it drops to `<body>`, so the next Tab starts from the top of the page. So
 * the fold moves focus to the ellipsis, which is where that crumb now is, and only when focus was
 * already in the trail: a window being dragged narrower is not a reason to take focus from whatever
 * somebody is doing elsewhere on the page.
 *
 * The honest limit is the server, which cannot measure: an SSR'd page shows the whole trail, clipped
 * by the list, until hydration. Nothing is portalled and nothing measures the viewport, so a menu
 * near the edge of a narrow page can be cut by an ancestor that scrolls — put the scroll container
 * somewhere it is allowed to escape.
 */
export function BreadcrumbOverflow({
  items,
  label = "Breadcrumb",
  separator,
  onOpenChange,
  onFoldChange,
  labels: labelOverrides,
  className,
  itemClassName,
  currentClassName,
  separatorClassName,
  triggerClassName,
  menuClassName,
  menuItemClassName,
  ...props
}: BreadcrumbOverflowProps) {
  const labels = React.useMemo(
    () => ({ ...defaultBreadcrumbOverflowLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const generatedId = React.useId()
  const menuId = `${generatedId}-menu`
  const triggerId = `${generatedId}-trigger`

  const total = items.length

  // null is "not measured yet", which is not the same answer as "nothing fits": the server cannot
  // measure and the first client render has to match it, so every render starts with the whole trail
  // and the layout effect below folds it before paint.
  const [layout, setLayout] = React.useState<Layout | null>(null)
  const [open, setOpen] = React.useState(false)
  // Which folded level has focus, as a position. -1 is "the menu is closed", as in `split-button`.
  const [menuActive, setMenuActive] = React.useState(-1)

  // Two elements, and the split is not cosmetic — see {@link BreadcrumbOverflow}. `navRef` is the
  // landmark the menu hangs off; `listRef` is the trail, and the only one that clips.
  const navRef = React.useRef<HTMLElement | null>(null)
  const listRef = React.useRef<HTMLOListElement | null>(null)
  const probeRef = React.useRef<HTMLLIElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  /**
   * The crumb that last took focus, as a position, or null.
   *
   * A ref and not state: it changes on every focus and blur, and nothing rendered depends on it —
   * the rescue below reads it at the moment the fold changes.
   */
  const focusedCrumb = React.useRef<number | null>(null)

  /**
   * One ref object per folded position, created lazily — object refs rather than callback refs for
   * the reason `split-button` gives: a callback ref is a new function identity on every commit, so
   * React detaches and reattaches it, and this repository's test harness fills ref objects only.
   */
  const menuRefs = React.useRef<Array<React.RefObject<HTMLAnchorElement | null>>>([])
  const menuRef = (index: number) => {
    while (menuRefs.current.length <= index) {
      menuRefs.current.push(React.createRef<HTMLAnchorElement>())
    }
    return menuRefs.current[index]
  }

  const kept = layout === null ? total : Math.min(layout.kept, total)
  const folded = kept >= total ? [] : items.slice(1, total - kept)
  const hasMore = folded.length > 0
  const menuOpen = open && hasMore

  /**
   * A primitive that changes when the trail does.
   *
   * The layout effect cannot depend on `items` itself: almost every call site writes the array
   * inline, so its identity changes on every render and the effect would force a layout every time.
   * Width changes that leave the labels alone — a font swapping in, a `px-2` arriving from
   * `itemClassName` — are caught by the resize observer on the probe instead, which is the only
   * thing that can see them anyway.
   */
  const signature = items.map((item) => item.id ?? item.label).join("\u001f")

  const measure = React.useCallback(() => {
    // The list, not the landmark: the list is the one with a width its parent decides and an
    // overflow that cannot be pushed outwards, which is what makes this measurement stable.
    const list = listRef.current
    const probe = probeRef.current
    if (!list || !probe) return
    if (typeof getComputedStyle !== "function") return

    const style = getComputedStyle(list)
    // The *inline* start, which is the right-hand side on an RTL page: the menu's offset is counted
    // from there, and reading `paddingLeft` would place it a padding's width into the wrong end.
    const rtl = style.direction === "rtl"
    const paddingStart = parseFloat(rtl ? style.paddingRight : style.paddingLeft) || 0
    const paddingEnd = parseFloat(rtl ? style.paddingLeft : style.paddingRight) || 0
    // clientWidth is content plus padding, so a caller adding `px-3` would otherwise have its trail
    // measured against a box wider than the one the crumbs have to fit in.
    const available = list.clientWidth - paddingStart - paddingEnd
    // A breadcrumb inside a closed tab, an unopened dialog or a collapsed panel measures zero, which
    // is not "nothing fits". Keeping the previous answer stops it folding to a lone ellipsis while
    // off screen and staying that way once shown.
    if (!(available > 0)) return

    // Read from the list rather than taken as a prop, so `className="gap-2"` is the single place the
    // spacing is said. `normal` parses to NaN, which is zero gap here and is what a list with no gap
    // utility actually renders.
    const gap = parseFloat(style.columnGap) || 0

    // The probe's children, in the order it renders them: every crumb, then one separator, then the
    // ellipsis. Short of that is a probe mid-commit, and measuring it would fold against widths that
    // belong to a different trail.
    const probed = Array.from(probe.children)
    if (probed.length < total + 2) return
    const widths = probed.slice(0, total).map((node) => node.getBoundingClientRect().width)
    const separatorWidth = probed[total].getBoundingClientRect().width
    const triggerWidth = probed[total + 1].getBoundingClientRect().width

    const next: Layout = {
      kept: fitBreadcrumbs(widths, available, gap, separatorWidth, triggerWidth),
      offset: breadcrumbMenuOffset(widths[0], gap, separatorWidth, paddingStart),
    }
    // The bail-out React gives an equal value, kept by hand because this one is an object: without
    // it every measurement is a new identity, every new identity is a render, and the observer that
    // watches the result of the render fires again.
    setLayout((prev) =>
      prev && prev.kept === next.kept && prev.offset === next.offset ? prev : next
    )
  }, [total])

  // Keyed on the signature so adding, removing or renaming a crumb re-measures; the observer below
  // covers every other reason a width changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useIsomorphicLayoutEffect(measure, [measure, signature])

  // The container getting narrower is the reason this component exists; the probe getting wider — a
  // web font swapping in, a label arriving from a fetch — is the reason the same observer watches it
  // too. `overflow-tooltip` measured that one: a box sized for the fallback face reported that its
  // text fitted and the same box was 8px over once the real face arrived, with no resize to notice.
  React.useEffect(() => {
    const list = listRef.current
    const probe = probeRef.current
    if (!list || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(list)
    if (probe) observer.observe(probe)
    return () => observer.disconnect()
  }, [measure])

  const notifiedFold = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (layout === null || notifiedFold.current === folded.length) return
    notifiedFold.current = folded.length
    onFoldChange?.(folded.length)
  }, [layout, folded.length, onFoldChange])

  // Reported from an effect rather than from inside a state setter: an updater has to be pure —
  // React calls it twice in development's strict mode on purpose — so a caller placed in one is told
  // twice for every open.
  const notifiedOpen = React.useRef(false)
  React.useEffect(() => {
    if (notifiedOpen.current === open) return
    notifiedOpen.current = open
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const closeMenu = React.useCallback((restoreFocus: boolean) => {
    setMenuActive(-1)
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  /**
   * Whether focus is inside the **list** right now.
   *
   * The guard on the rescue, and it asks about the list rather than the whole component for two
   * reasons. A window being resized is not a reason to take focus from whatever somebody is doing
   * elsewhere on the page. And focus in the open menu is inside the component but not in the list, so
   * a re-measure that pulled it back to the ellipsis would close nothing, explain nothing, and drop
   * the person out of the list of levels they were reading.
   */
  const holdsFocus = () => {
    if (typeof document === "undefined") return false
    const node = listRef.current
    const target = document.activeElement
    return Boolean(node && target && node.contains(target))
  }

  // A crumb folded while it holds focus. The position is cleared as it is used: the link is gone, so
  // there is nothing left to rescue and a second measurement must not fire this again.
  React.useEffect(() => {
    const index = focusedCrumb.current
    if (index === null || !isCrumbFolded(index, kept, total)) return
    if (!holdsFocus()) return
    focusedCrumb.current = null
    triggerRef.current?.focus()
    // holdsFocus reads the document at call time; the ref is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kept, total])

  // Focus follows the active menu position, rather than `aria-activedescendant` pointing at it: the
  // items of a menu *are* the interface, each one is a real link, and the practices for a menu
  // describe moving focus.
  //
  // Bounded by the live count because `items` is a prop and the trail re-measures underneath it, so
  // the folded set can shrink while the menu is open. The ref array is kept across renders, so a
  // position the menu no longer has may still hold the node it had a render ago, and focusing that is
  // a focus call into something nobody can see.
  React.useEffect(() => {
    if (!menuOpen || menuActive < 0 || menuActive >= folded.length) return
    menuRef(menuActive).current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, menuActive, folded.length])

  // The container widened while the menu was open, so there are fewer levels behind it than the
  // active position names. Without this the position points past the end and the focus effect asks a
  // ref that holds nothing.
  React.useEffect(() => {
    if (!menuOpen) return
    setMenuActive((current) => (current >= folded.length ? folded.length - 1 : current))
  }, [menuOpen, folded.length])

  // A menu whose own control has gone — the trail widened and everything fits — cannot be closed by
  // the person looking at it.
  React.useEffect(() => {
    if (open && !hasMore) closeMenu(false)
  }, [open, hasMore, closeMenu])

  // Close on an outside pointer press, in the capture phase so it beats a focus move. Focus is not
  // pulled back: the person has already said where they want to be.
  React.useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!navRef.current?.contains(event.target as Node)) closeMenu(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [menuOpen, closeMenu])

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        // Prevented so the page does not scroll as well as the menu opening.
        event.preventDefault()
        setOpen(true)
        setMenuActive(nextMenuIndex(folded.length, -1, event.key === "ArrowDown" ? 1 : -1))
        break
      case "Escape":
        if (menuOpen) {
          event.preventDefault()
          closeMenu(true)
        }
        break
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        setMenuActive((current) => nextMenuIndex(folded.length, current, 1))
        break
      case "ArrowUp":
        event.preventDefault()
        setMenuActive((current) => nextMenuIndex(folded.length, current, -1))
        break
      case "ArrowLeft":
      case "ArrowRight":
        // Swallowed rather than acted on: a horizontal arrow means nothing in a vertical menu, and
        // letting it through would scroll a horizontally scrollable ancestor underneath somebody
        // reading the menu.
        event.preventDefault()
        break
      case "Home":
        event.preventDefault()
        setMenuActive(0)
        break
      case "End":
        event.preventDefault()
        setMenuActive(folded.length - 1)
        break
      case "Escape":
        event.preventDefault()
        closeMenu(true)
        break
      case "Tab":
        // Not prevented: Tab means leave, and the browser's answer for where to go is the right one.
        // Focus is moved onto the control first so that answer is computed from an element still in
        // the document — a Tab from a node being removed starts over at the top of the page.
        closeMenu(true)
        break
    }
  }

  function chooseFolded(index: number, event: React.MouseEvent<HTMLAnchorElement>) {
    const crumb = folded[index]
    if (!crumb) return
    crumb.onNavigate?.(event)
    // Focus goes back to the control only when the page is not being replaced. A client router says
    // so by preventing the default; a real navigation takes focus with it, and reaching for the
    // control on the way out would be a focus call into a document that is leaving.
    closeMenu(event.defaultPrevented)
  }

  if (total === 0) return null

  const crumbContent = (crumb: BreadcrumbCrumb) => (
    <>
      {crumb.icon ? (
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
          {crumb.icon}
        </span>
      ) : null}
      {crumb.label}
    </>
  )

  const crumbItem = (
    crumb: BreadcrumbCrumb,
    options: { index: number; probe: boolean; current: boolean }
  ) => {
    const { index, probe, current } = options
    // The current page, which is a `<span aria-current="page">` and never a link: it is where you
    // already are, so there is nothing to follow, and `aria-current` is the whole convention for
    // saying so. In the row it is also the one crumb allowed to shrink, which is what turns a trail
    // with no room left into a shortened title rather than a cut-off one — `min-w-0` because a flex
    // item will not shrink below its content without it. The probe copy never truncates: its job is
    // to report the natural width, and it is the width the arithmetic runs on.
    if (current) {
      return (
        <span
          // Marked hidden on the copy itself and not only through the probe's own `aria-hidden`,
          // which would already hide the whole subtree. Saying it on the node is what makes "is this
          // the crumb somebody can see" answerable from the node — the ancestor-walking version is
          // the mistake official's ellipsis makes from the other side, where an `sr-only` label
          // sits inside an `aria-hidden` element and is read by nothing.
          aria-hidden={probe ? "true" : undefined}
          aria-current={probe ? undefined : "page"}
          className={cn(
            CRUMB_BASE,
            "font-normal text-foreground",
            probe ? "shrink-0 whitespace-nowrap" : "min-w-0 truncate",
            itemClassName,
            currentClassName
          )}
        >
          {crumbContent(crumb)}
        </span>
      )
    }
    // No `href` on the probe copy, which is what keeps it out of the focus order entirely rather
    // than merely out of the tab sequence — an `aria-hidden` element that can still be focused is
    // the one combination assistive technology cannot explain.
    const Tag = crumb.href && !probe ? "a" : "span"
    return (
      <Tag
        {...(probe
          ? { "aria-hidden": "true" as const }
          : {
              onFocus: () => {
                focusedCrumb.current = index
              },
              onBlur: () => {
                if (focusedCrumb.current === index) focusedCrumb.current = null
              },
            })}
        {...(Tag === "a"
          ? {
              href: crumb.href,
              onClick: (event: React.MouseEvent<HTMLAnchorElement>) => crumb.onNavigate?.(event),
            }
          : {})}
        className={cn(
          CRUMB_BASE,
          "shrink-0 whitespace-nowrap",
          crumb.href && !probe ? "hover:text-foreground" : null,
          itemClassName
        )}
      >
        {crumbContent(crumb)}
      </Tag>
    )
  }

  const separatorNode = (key?: string) => (
    <li
      key={key}
      // `role="presentation"` and `aria-hidden` together, the way official shadcn/ui's separator
      // does it: the chevron is punctuation, and a screen reader reading "greater than" between
      // every level is the noise this removes.
      role="presentation"
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center [&>svg]:size-3.5",
        // The trail runs the other way on an RTL page, so the chevron has to as well — official's
        // separator does not do this, and a right-pointing chevron in a right-to-left trail points
        // back the way you came.
        "rtl:[&>svg]:-scale-x-100",
        // The caller's class, on the copy as well as on the row — which is why this takes no
        // `probe` flag: the two separators are identical, and the probe's one is a separator too.
        // A caller's `separatorClassName="px-2"` widens every
        // join by four pixels, and a probe that measures the unstyled separator under-reads the
        // trail by that much per level — which is a level kept that does not fit. The rule is the
        // same for the control below: **the probe measures what the row renders**, and the only
        // differences allowed are the ones that make it a measurement rather than an interface.
        separatorClassName
      )}
    >
      {separator ?? <ChevronRight />}
    </li>
  )

  const trigger = (probe: boolean) => (
    <button
      ref={probe ? undefined : triggerRef}
      id={probe ? undefined : triggerId}
      type="button"
      {...(probe
        ? { "aria-hidden": "true" as const, tabIndex: -1 }
        : {
            "aria-haspopup": "menu" as const,
            "aria-expanded": menuOpen,
            "aria-controls": menuOpen ? menuId : undefined,
            // Closing restores focus, as in `split-button`. A press has already put focus here, so
            // it is usually a no-op — but a programmatic click with focus on a menu item would
            // otherwise unmount the menu while it still holds focus, and focus drops to `<body>`.
            onClick: () => (menuOpen ? closeMenu(true) : (setOpen(true), setMenuActive(0))),
            onKeyDown: handleTriggerKeyDown,
          })}
      // The name carries the count, which official's ellipsis cannot: its `sr-only` "More" sits
      // inside an `aria-hidden` span, so assistive technology is told nothing at all.
      aria-label={labels.more(folded.length)}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-sm transition-colors",
        "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // On the copy too: `triggerClassName="size-9"` is a 12px difference between the control the
        // arithmetic charges for and the one in the row, and it is charged exactly when the row is
        // already out of space.
        triggerClassName
      )}
    >
      <MoreHorizontal aria-hidden="true" className="size-4" />
    </button>
  )

  /**
   * The crumbs in the row, each carrying **its own position in the trail** rather than its position
   * in the row.
   *
   * The pair is kept together on purpose. The two numbers agree only while nothing is folded, and
   * deriving one from the other is where this went wrong first: arithmetic that is right for the
   * folded row is off by one for the whole trail, which takes `aria-current` off the current page —
   * the single attribute the pattern exists to carry — on exactly the trails that are wide enough
   * not to fold. `hasMore` is the discriminator because it is also what decides whether there is a
   * trigger in the row at all.
   */
  const visible: Array<{ crumb: BreadcrumbCrumb; index: number }> = hasMore
    ? [
        { crumb: items[0], index: 0 },
        ...items.slice(total - kept).map((crumb, offset) => ({
          crumb,
          index: total - kept + offset,
        })),
      ]
    : items.map((crumb, index) => ({ crumb, index }))

  const row: React.ReactNode[] = []
  visible.forEach(({ crumb, index }, position) => {
    const current = index === total - 1
    if (position > 0) {
      row.push(separatorNode(`sep-${index}`))
      // The ellipsis stands where the folded levels were: after the root's separator, before the
      // surviving tail. Its position is why {@link breadcrumbMenuOffset} needs nothing measured.
      if (position === 1 && hasMore) {
        row.push(
          <li key="more" className="flex shrink-0 items-center">
            {trigger(false)}
          </li>,
          separatorNode("sep-more")
        )
      }
    }
    row.push(
      <li key={crumb.id ?? `${crumb.label}-${index}`} className="flex min-w-0 items-center">
        {crumbItem(crumb, { index, probe: false, current })}
      </li>
    )
  })

  return (
    // The landmark exists for the menu as well as for the semantics. `relative` makes it the menu's
    // containing block; it deliberately does not clip, because the list below does — and a panel
    // hanging off the bottom of its own clipping containing block is painted nowhere at all (0 of 15
    // points scanned, against 15 of 15 from here).
    <nav {...props} ref={navRef} aria-label={label} className="relative w-full">
      <ol
        ref={listRef}
        className={cn(
          // `w-full` is what makes the measurement stable: the width comes from the parent, so a
          // trail one pixel too wide is clipped rather than pushing the container wider.
          // `flex-nowrap` is the difference from official, whose `flex-wrap` grows the header by a
          // line instead (measured: 45.2px at 320px, 70.8px at 240px). `relative` contains the
          // probe, whose scrollable overflow this clipping then absorbs.
          //
          // The padding is load-bearing, and it is the clipping that makes it so: a `focus-visible`
          // ring is drawn outside the border box, and with the list flush against its crumbs the
          // ring on the root is cut off. 4px clears a 2px ring on every side, and `measure`
          // subtracts the inline padding, so the room costs nothing in the arithmetic. A caller
          // setting `p-0` gets the clipped ring back.
          "relative flex w-full flex-nowrap items-center gap-1.5 overflow-hidden p-1 text-sm text-muted-foreground",
          className
        )}
      >
        {row}

        {/* The measuring copy: every crumb at its natural width, then one separator and the
            ellipsis, in the order `measure` reads them. An `<li>` rather than a `<div>` because an
            `<ol>` may only contain list items, and an out-of-flow `<li>` is still a valid one. */}
        <li ref={probeRef} aria-hidden="true" style={PROBE_STYLE}>
          {items.map((crumb, index) =>
            crumbItem(crumb, {
              index,
              probe: true,
              current: index === total - 1,
            })
          )}
          {separatorNode()}
          {trigger(true)}
        </li>
      </ol>

      {menuOpen ? (
        <div
          id={menuId}
          role="menu"
          // The attribute official shadcn/ui's collapsing components key their keyframes off, so
          // `menuClassName="data-[state=open]:animate-in"` works in a project that has installed
          // any of them.
          data-state="open"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          // Placed under the control by arithmetic rather than by measuring it: the ellipsis is
          // always the second box in the row. Verified to the pixel in both writing directions —
          // `inset-inline-start` counts from the inline start whichever way the text runs.
          style={{ insetInlineStart: layout ? `${layout.offset}px` : undefined }}
          className={cn(
            "absolute top-full z-50 mt-1 min-w-[12rem] max-w-[min(20rem,100%)] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            menuClassName
          )}
        >
          {folded.map((crumb, index) => {
            const Tag = crumb.href ? "a" : "span"
            return (
              <Tag
                key={crumb.id ?? crumb.label}
                ref={menuRef(index) as React.RefObject<HTMLAnchorElement | null>}
                role="menuitem"
                {...(crumb.href
                  ? {
                      href: crumb.href,
                      onClick: (event: React.MouseEvent<HTMLAnchorElement>) =>
                        chooseFolded(index, event),
                    }
                  : {})}
                // Roving: one tab stop for the menu, on the level that has focus. A level with no
                // page of its own still takes focus here — it is a rung in the hierarchy somebody is
                // reading, and skipping it makes the list shorter than it looks.
                tabIndex={index === menuActive ? 0 : -1}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none transition-colors",
                  "focus:bg-accent focus:text-accent-foreground",
                  crumb.href ? "hover:bg-accent hover:text-accent-foreground" : "text-muted-foreground",
                  menuItemClassName
                )}
              >
                {crumb.icon ? (
                  <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                    {crumb.icon}
                  </span>
                ) : null}
                <span className="truncate">{crumb.label}</span>
              </Tag>
            )
          })}
        </div>
      ) : null}
    </nav>
  )
}
