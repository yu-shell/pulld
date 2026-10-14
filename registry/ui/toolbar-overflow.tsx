"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"
import { nextMenuIndex } from "@/registry/ui/split-button"

/**
 * Sub-pixel slack, the same half a pixel `middle-truncate` allows itself and for the same reason:
 * element widths and content-box widths are both fractional, so a row that fills its container
 * exactly can report a few hundredths of a pixel of overflow. Kept well under one pixel on purpose
 * — generous slack folds an item that would have fitted, which is the one outcome this component
 * exists to avoid.
 */
const WIDTH_TOLERANCE = 0.5

/** The stop that is the overflow trigger rather than one of the items. */
export const TOOLBAR_MORE = -1

/**
 * How many leading items stay in the row.
 *
 * This is the whole decision, as arithmetic over numbers that nothing in the DOM can argue with,
 * and it is separate from the component for two reasons. The first is that it is the part worth
 * asserting: every interesting case here is a width, not a click. The second is that keeping it a
 * function of its arguments alone is what stops the component oscillating — see
 * {@link ToolbarOverflow} for the loop this shape rules out.
 *
 * `widths` are the items' **natural** widths, in the caller's order, which is also the priority
 * order: the row keeps a prefix and folds the tail. `available` is the container's content width,
 * `gap` the row's column gap, `moreWidth` the natural width of the trigger.
 *
 * The trigger's own width is the part that is easy to get wrong, and it is wrong in both
 * directions. Reserve room for it always and a toolbar whose items fit exactly loses its last item
 * to a button that was never needed; reserve it never and the last item that "fits" is pushed out
 * by the trigger added after the decision — the row then overflows by exactly the width of the
 * thing that was supposed to prevent overflow. So it is charged if and only if something folds,
 * which is why this asks whether everything fits *before* it asks how much fits.
 *
 * The gap count changes with it. `n` items alone have `n - 1` gaps between them; `k` items plus a
 * trigger have `k` — the trigger is a box in the row like any other, and the gap in front of it is
 * real. Counting `k - 1` there is the quiet version of the same mistake, one gap wide.
 */
export function fitToolbarItems(
  widths: readonly number[],
  available: number,
  gap: number,
  moreWidth: number
): number {
  const count = widths.length
  if (count === 0) return 0

  // A negative or non-finite container is "nothing fits" rather than a crash: `available` arrives
  // from a measurement, and a detached or display:none element measures 0.
  const room = Number.isFinite(available) ? available : 0
  const step = Number.isFinite(gap) && gap > 0 ? gap : 0
  const sizes = widths.map((w) => (Number.isFinite(w) && w > 0 ? w : 0))

  let total = step * (count - 1)
  for (const width of sizes) total += width
  if (total - room <= WIDTH_TOLERANCE) return count

  // Past here something folds, so the row carries the trigger too and every candidate pays for it.
  const trigger = Number.isFinite(moreWidth) && moreWidth > 0 ? moreWidth : 0
  let used = trigger
  let kept = 0
  // `count - 1` rather than `count`: keeping all of them is the case above, and reaching it here
  // would mean charging for a trigger that is not rendered.
  for (let i = 0; i < count - 1; i++) {
    const next = used + step + sizes[i]
    if (next - room > WIDTH_TOLERANCE) break
    used = next
    kept = i + 1
  }
  return kept
}

/**
 * Where a horizontal arrow key lands in the row, clamping at both ends.
 *
 * The stops are the visible items followed by the trigger, and `TOOLBAR_MORE` names the last one
 * because its index moves every time the container resizes — `visible` today is `visible - 1`
 * tomorrow, and a caller holding the number rather than the sentinel is holding a stale answer.
 *
 * Clamping, where the menu that opens underneath wraps. That is not an inconsistency: the ARIA
 * practices describe a toolbar's arrows as moving between its controls with wrapping optional, and
 * the two popups differ in what the person can see. A three-item menu clamped makes its last item a
 * key that does nothing, and since the menu appeared a moment ago there is nothing on screen to say
 * why — it reads as the keyboard having broken. A toolbar's ends are the ends of a row that is
 * visibly there, so Right doing nothing on the last control reads as the edge of the row. The wrap
 * rule for the menu is imported from `split-button` rather than written again here, so the two
 * menus in this registry cannot drift apart.
 *
 * `delta` of 0 is how Home and End are expressed: Home is "from the first stop, don't move" and End
 * is "from the trigger, don't move", which resolves to the last item when nothing is folded.
 */
export function nextToolbarStop(
  visible: number,
  hasMore: boolean,
  from: number,
  delta: number
): number {
  const span = Number.isFinite(visible) ? Math.max(0, Math.trunc(visible)) : 0
  const stops = span + (hasMore ? 1 : 0)
  // No stops at all: an empty toolbar renders nothing, and this is what its keys answer.
  if (stops < 1) return TOOLBAR_MORE
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  const current =
    from === TOOLBAR_MORE
      ? // The trigger sits after the last visible item; without one, "the end" is that item.
        span - (hasMore ? 0 : 1)
      : Math.min(Math.max(Math.trunc(Number.isFinite(from) ? from : 0), 0), stops - 1)
  const next = Math.min(Math.max(current + step, 0), stops - 1)
  return hasMore && next === span ? TOOLBAR_MORE : next
}

/**
 * The stop that should hold the row's single tab stop, given the one that holds it now.
 *
 * Returns `active` unchanged when there is nothing to rescue, so the caller acts on a change and
 * not on every measurement.
 *
 * Two things go wrong when the container narrows, and only one of them is about focus. The visible
 * one is that the item holding focus is folded away: its button leaves the document, and a browser
 * does not move focus when that happens — it drops to `<body>`, so the next Tab starts again from
 * the top of the page. The quieter one happens whether or not anybody is looking: a roving tabindex
 * puts `tabIndex={0}` on exactly one control, and if that control is now in the menu then **no
 * element in the row has it**, so Tab skips the entire toolbar. That second failure needs no focus
 * to be present and no screen reader to notice, which is why the tab stop is moved on every
 * measurement and focus is only *called* when focus was already inside — see {@link
 * ToolbarOverflow}, where moving focus unasked would take it from whatever the person was doing
 * elsewhere on the page while the window happened to be resizing.
 *
 * The reverse case is the same rule read backwards: the row widens, everything fits, the trigger is
 * gone, and the tab stop is on a control that no longer exists. It lands on the last item in the
 * row, which is the position the trigger occupied.
 */
export function rescueToolbarStop(active: number, visible: number, total: number): number {
  const count = Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0
  if (count === 0) return TOOLBAR_MORE
  const span = Math.min(Math.max(Number.isFinite(visible) ? Math.trunc(visible) : 0, 0), count)
  const hasMore = span < count

  if (active === TOOLBAR_MORE) return hasMore ? TOOLBAR_MORE : Math.max(0, span - 1)
  const index = Math.min(Math.max(Math.trunc(Number.isFinite(active) ? active : 0), 0), count - 1)
  // `index >= span` means the item is folded, and a folded item implies a trigger exists to receive
  // the tab stop: there is no way to be past the visible prefix without the prefix being short.
  return index >= span ? TOOLBAR_MORE : index
}

/**
 * Whether an element is laid out right-to-left.
 *
 * Read from the node at the moment of the key press rather than cached, because `direction` is
 * inherited and can change underneath — an `<html dir>` toggle, one Arabic toolbar in an otherwise
 * English page — and a stale answer sends Right to the left for the rest of the session.
 */
function isRtl(node: Element | null | undefined): boolean {
  if (!node || typeof getComputedStyle !== "function") return false
  return getComputedStyle(node).direction === "rtl"
}

// Measures before paint, so the full row is never briefly visible before it folds. It warns during
// SSR, where there is nothing to measure.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

export interface ToolbarOverflowItem {
  /** Stable key. The label is used when this is absent. */
  id?: string
  /** The control's text, and its accessible name. */
  label: string
  /** Run when the control is pressed. Not called for a disabled item. */
  onSelect: () => void
  /** Decorative icon before the label. Hidden from screen readers by this component. */
  icon?: React.ReactNode
  /**
   * Unavailable, but still shown and still reachable with the arrow keys.
   *
   * `aria-disabled` rather than the `disabled` attribute, the same choice `split-button` makes: a
   * `disabled` button is out of the focus order, so arrowing a toolbar of five whose third is
   * unavailable walks 1, 2, 4, 5 — and what the person learns from that is not that the control is
   * unavailable but that it does not exist.
   */
  disabled?: boolean
  /**
   * Show the icon alone in the row, with the label as the accessible name and the native tooltip.
   *
   * For the formatting toolbars this pattern comes from, where bold and italic are a B and an I. The
   * menu always shows the text, whatever this says, because a row of icons folded into a menu of
   * icons is a menu of unlabelled squares.
   */
  hideLabel?: boolean
}

export interface ToolbarOverflowLabels {
  /**
   * The trigger's accessible name, from the number folded and the toolbar's own name.
   *
   * A function rather than a string because the name has to carry both. A page with a formatting
   * toolbar and a table toolbar has two triggers, and two announcements of "More" tell a
   * screen-reader user only that there are two of something — the same reason `split-button` builds
   * its arrow's name from the action beside it. The count is in there because it is the one piece of
   * information the trigger has that nothing else on screen does.
   */
  more: (count: number, label: string) => string
}

export const defaultToolbarOverflowLabels: ToolbarOverflowLabels = {
  more: (count, label) => `${count} more ${label} actions`,
}

const CONTROL_BASE =
  // shrink-0 is load-bearing rather than cosmetic: a flex item that may shrink does, so without it
  // the browser squeezes every control into an unreadable sliver and the row never overflows, which
  // means nothing ever folds and this component silently does nothing.
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md " +
  "px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring hover:bg-accent hover:text-accent-foreground"

/**
 * The probe takes part in no layout: absolutely positioned, so it contributes nothing to the row's
 * width, and `visibility: hidden` rather than `display: none` because a display:none box reports
 * zero and the point of it is to be measurable.
 */
const PROBE_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  display: "flex",
  visibility: "hidden",
  pointerEvents: "none",
  whiteSpace: "nowrap",
  width: "auto",
  maxWidth: "none",
  userSelect: "none",
}

export interface ToolbarOverflowProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "role" | "aria-label"> {
  /**
   * What the toolbar is called — "Formatting", "Table", "Row actions".
   *
   * Required, because a `role="toolbar"` with no accessible name is announced as "toolbar" and the
   * practices ask for a name. It is also where the trigger's name comes from, so the usual call
   * site passes it once and gets both.
   */
  label: string
  /**
   * The controls, most important first. **The order is the priority:** the row keeps a prefix and
   * folds the tail.
   *
   * There is deliberately no per-item priority flag. Allowing one would make the visible set an
   * arbitrary subset rather than a prefix, which turns the arithmetic into a knapsack and — the part
   * that actually matters — makes the menu a list of items in no relation to the row, so the place
   * an item went is no longer where the person last saw it. Putting the important ones first says
   * the same thing and keeps both halves in one order.
   */
  items: readonly ToolbarOverflowItem[]
  /** Which edge of the toolbar the overflow menu lines up with. Mirrors itself on an RTL page. */
  align?: "start" | "end"
  /** Told when the overflow menu opens and closes. */
  onOpenChange?: (open: boolean) => void
  /**
   * Told how many controls are in the row after each measurement, for a caller that wants to know —
   * a tooltip that should not be attached to a control nobody can see, an analytics note about how
   * often the toolbar is cramped.
   */
  onVisibleCountChange?: (visible: number) => void
  labels?: Partial<ToolbarOverflowLabels>
  /**
   * On the row — the element with `role="toolbar"`, which is what anybody looking at the page would
   * call the toolbar. The outer box above it is a positioning wrapper with no styles of its own and
   * is deliberately not reachable: it exists so the menu is not clipped, and giving it a width or a
   * padding is how the measurement starts lying. `...props` reach the row too, for the same reason.
   *
   * This is also where the spacing is said: `className="gap-2"` is read back out of the row's
   * computed style and used in the arithmetic, so the gap is written once rather than twice.
   */
  className?: string
  itemClassName?: string
  triggerClassName?: string
  menuClassName?: string
  menuItemClassName?: string
}

/**
 * A row of controls that folds whatever will not fit into a menu at its end — the pattern usually
 * called priority+.
 *
 * For an editor's formatting bar, a table's action column, an article's share row, an admin
 * header, a card's footer actions, a nav that has dropped to a narrow screen: anywhere a row of
 * buttons has to survive a width nobody chose.
 *
 * **Measuring your own row is a loop unless you arrange otherwise,** and that is the whole design.
 * The reflex implementation asks the live row how wide it is, hides what sticks out, and is then
 * asked again by its own ResizeObserver: the hidden controls now measure zero, so the row fits, so
 * they come back, so it overflows, so they are hidden — a flicker that no amount of debouncing
 * fixes, because every pass is a legitimate answer to a question that should not have been asked.
 * Two things break it here:
 *
 *   - **Natural widths come from a probe that is never folded.** A hidden copy of the full set sits
 *     in the row, out of layout, and is what gets measured. Folding the visible row cannot change
 *     what the probe says.
 *   - **The container's width cannot be changed by its contents.** The row is a block-level,
 *     full-width box with `overflow-hidden`, so its width comes from its parent and a row that is
 *     one pixel too wide is clipped rather than pushing anything wider. (A `w-fit` or `inline-flex`
 *     row is the one way to reintroduce the loop, because then the width being measured is the
 *     content's own.)
 *
 * Together they make the visible count a pure function of inputs that folding does not touch — see
 * {@link fitToolbarItems} — so the same container width always produces the same count, React bails
 * out of a state update to an equal value, and the observer settles after one pass. The loop is not
 * damped; it is removed.
 *
 * The flash is a separate problem with a separate answer: the measurement runs in a layout effect,
 * which is after layout and before paint, so the full row is never painted and then collapsed. The
 * honest limit is the server, which cannot measure — an SSR'd page shows the row clipped by
 * `overflow-hidden` until hydration, rather than wrapped or overflowing.
 *
 * The keyboard is two conventions meeting at the trigger. The row is a toolbar: one tab stop,
 * Left/Right between controls (swapped on an RTL page), Home and End to the ends, clamping. The
 * menu is a menu: Up/Down with wrapping, Escape back to the trigger, and choosing an item returns
 * focus there too. They meet at the trigger, which is the last stop in the row and the thing Down
 * opens — so Right, Right, Down walks out of the row and into the menu, and Escape, Left walks back.
 * A horizontal arrow pressed inside the open menu is swallowed rather than left to bubble: letting
 * it through moves the row's tab stop underneath a menu the person is still reading, and Escape then
 * returns focus somewhere they never left.
 *
 * That clipping is also why this renders two boxes rather than one. The row clips, and an
 * absolutely positioned panel whose containing block is the thing clipping it is painted only where
 * the two overlap — a panel at `top-full` is entirely below the row, so it would be painted nowhere.
 * So the menu hangs off an outer box that positions without clipping, and the row inside it keeps
 * both the clipping and the `role="toolbar"`. The probe stays in the row on purpose: an out-of-flow
 * element still contributes scrollable overflow, and being clipped is what stops a toolbar far too
 * narrow for its controls from making the page scroll sideways.
 *
 * Nothing is portalled and nothing measures the viewport; the menu is absolutely positioned against
 * that outer box. Distinct from `scroll-shadow`, which says there is more in a scrollable row rather
 * than folding it, and from `bulk-action-bar`, which is a fixed set of actions over a selection.
 */
export function ToolbarOverflow({
  label,
  items,
  align = "end",
  onOpenChange,
  onVisibleCountChange,
  labels: labelOverrides,
  className,
  itemClassName,
  triggerClassName,
  menuClassName,
  menuItemClassName,
  ...props
}: ToolbarOverflowProps) {
  const labels = React.useMemo(
    () => ({ ...defaultToolbarOverflowLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const generatedId = React.useId()
  const menuId = `${generatedId}-menu`
  const triggerId = `${generatedId}-trigger`

  const total = items.length

  // null is "not measured yet", which is not the same answer as "nothing fits": the server cannot
  // measure and the first client render has to match it, so every render starts with the whole row
  // and the layout effect below narrows it before paint.
  const [measured, setMeasured] = React.useState<number | null>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  // Which menu item has focus, as a position. -1 is "the menu is closed", as in `split-button`.
  const [menuActive, setMenuActive] = React.useState(-1)

  // Two elements, and the split is not cosmetic — see {@link ToolbarOverflow}. `rootRef` is the
  // outer box the menu is positioned against; `rowRef` is the toolbar itself, and the only one that
  // clips.
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const rowRef = React.useRef<HTMLDivElement | null>(null)
  const probeRef = React.useRef<HTMLDivElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)

  /**
   * One ref object per position, created lazily — object refs rather than callback refs for the
   * reason `split-button` gives: a callback ref is a new function identity on every commit, so
   * React detaches and reattaches it, and this repository's test harness fills ref objects only, so
   * a roving tabindex wired with callbacks has focus behaviour that cannot be asserted at all.
   */
  const itemRefs = React.useRef<Array<React.RefObject<HTMLButtonElement | null>>>([])
  const itemRef = (index: number) => {
    while (itemRefs.current.length <= index) {
      itemRefs.current.push(React.createRef<HTMLButtonElement>())
    }
    return itemRefs.current[index]
  }
  const menuRefs = React.useRef<Array<React.RefObject<HTMLButtonElement | null>>>([])
  const menuRef = (index: number) => {
    while (menuRefs.current.length <= index) {
      menuRefs.current.push(React.createRef<HTMLButtonElement>())
    }
    return menuRefs.current[index]
  }

  const visible = measured === null ? total : Math.min(measured, total)
  const hidden = items.slice(visible)
  const hasMore = hidden.length > 0
  const menuOpen = open && hasMore

  /**
   * A primitive that changes when the set of controls does.
   *
   * The layout effect below cannot depend on `items` itself: almost every call site writes the array
   * inline, so its identity changes on every render and the effect would force a layout every time.
   * Width changes that leave the labels alone — a font swapping in, a `px-4` arriving from
   * `itemClassName` — are caught by the resize observer on the probe instead, which is the only
   * thing that can see them anyway.
   */
  const signature = items.map((item) => `${item.id ?? item.label}\u0000${item.hideLabel ? 1 : 0}`).join("\u001f")

  const measure = React.useCallback(() => {
    // The row, not the outer box: the row is the one with a width the parent decides and an overflow
    // that cannot be pushed outwards, which is what makes this measurement stable.
    const row = rowRef.current
    const probe = probeRef.current
    if (!row || !probe) return
    if (typeof getComputedStyle !== "function") return

    const style = getComputedStyle(row)
    // clientWidth is content plus padding, so a caller adding `px-3` would otherwise have its row
    // measured against a box wider than the one the controls have to fit in.
    const available =
      row.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0)
    // A toolbar inside a closed tab, an unopened dialog or a collapsed accordion measures zero,
    // which is not "nothing fits". Keeping the previous answer stops it folding to a lone trigger
    // while off screen and staying that way once shown.
    if (!(available > 0)) return

    // Read from the row rather than taken as a prop, so `className="gap-2"` is the single place the
    // spacing is said. `normal` parses to NaN, which is zero gap here and is what a row with no gap
    // utility actually renders.
    const gap = parseFloat(style.columnGap) || 0

    const probed = Array.from(probe.children)
    if (probed.length === 0) return
    const widths: number[] = []
    for (let i = 0; i < probed.length - 1; i++) {
      widths.push(probed[i].getBoundingClientRect().width)
    }
    const moreWidth = probed[probed.length - 1].getBoundingClientRect().width

    setMeasured(fitToolbarItems(widths, available, gap, moreWidth))
  }, [])

  // Keyed on the signature so adding, removing or renaming a control re-measures; the two observers
  // below cover every other reason a width changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useIsomorphicLayoutEffect(measure, [measure, signature])

  // The container getting narrower is the reason this component exists; the probe getting wider — a
  // web font swapping in, a label arriving from a fetch — is the reason the same observer watches it
  // too. A font swap changes every glyph without changing the container, so watching the row alone
  // would leave the fold wherever the fallback font put it.
  React.useEffect(() => {
    const row = rowRef.current
    const probe = probeRef.current
    if (!row || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(row)
    if (probe) observer.observe(probe)
    return () => observer.disconnect()
  }, [measure])

  const notifiedCount = React.useRef<number | null>(null)
  React.useEffect(() => {
    if (measured === null || notifiedCount.current === visible) return
    notifiedCount.current = visible
    onVisibleCountChange?.(visible)
  }, [measured, visible, onVisibleCountChange])

  // Reported from an effect rather than from inside the state setter: an updater has to be pure —
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
   * Whether focus is inside the **row** right now.
   *
   * The guard on moving focus during a rescue, and it asks about the row rather than the whole
   * component for a second reason beyond the obvious one. The obvious one is that a window being
   * resized is not a reason to take focus from whatever somebody is doing elsewhere on the page, so
   * a toolbar that folds while nobody is in it moves its tab stop silently. The second is the open
   * menu: focus there is inside the component but not in the row, and a re-measure that pulled it
   * back to the trigger would close nothing, explain nothing, and drop the person out of the list
   * they were reading. Asking the row answers both at once.
   */
  const holdsFocus = () => {
    if (typeof document === "undefined") return false
    const node = rowRef.current
    const target = document.activeElement
    return Boolean(node && target && node.contains(target))
  }

  // Moved on every measurement, focused only when focus was already here — the two halves of the
  // rule, for the two different failures. See rescueToolbarStop.
  React.useEffect(() => {
    const rescued = rescueToolbarStop(active, visible, total)
    if (rescued === active) return
    const inside = holdsFocus()
    setActive(rescued)
    if (!inside) return
    if (rescued === TOOLBAR_MORE) triggerRef.current?.focus()
    else itemRef(rescued).current?.focus()
    // itemRef mutates a ref and is stable; holdsFocus reads the document at call time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, visible, total])

  // Focus follows the active menu position, rather than `aria-activedescendant` pointing at it: the
  // items of a menu *are* the interface, each one is a real `<button>`, and the practices for a menu
  // describe moving focus.
  //
  // Bounded by the live count because `items` is a prop and the row re-measures underneath it, so
  // the hidden set can shrink while the menu is open. The bound is about asking the right position
  // rather than about crashing: the ref array is kept and reused across renders, so a position the
  // menu no longer has may still be holding the node it had a render ago, and focusing that is a
  // focus call into something nobody can see.
  React.useEffect(() => {
    if (!menuOpen || menuActive < 0 || menuActive >= hidden.length) return
    menuRef(menuActive).current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, menuActive, hidden.length])

  // The menu is given as a prop and the row re-measures underneath it, so the hidden set can shrink
  // while it is open. Without this the active position points past the end and the focus effect asks
  // a ref that holds nothing.
  React.useEffect(() => {
    if (!menuOpen) return
    setMenuActive((current) => (current >= hidden.length ? hidden.length - 1 : current))
  }, [menuOpen, hidden.length])

  // A menu whose own trigger has gone — the row widened and everything fits — cannot be closed by
  // the person looking at it.
  React.useEffect(() => {
    if (open && !hasMore) closeMenu(false)
  }, [open, hasMore, closeMenu])

  // Close on an outside pointer press, in the capture phase so it beats a focus move. Focus is not
  // pulled back: the person has already said where they want to be.
  React.useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [menuOpen, closeMenu])

  function goTo(stop: number) {
    setActive(stop)
    if (stop === TOOLBAR_MORE) triggerRef.current?.focus()
    else itemRef(stop).current?.focus()
  }

  function run(item: ToolbarOverflowItem) {
    if (item.disabled) return
    item.onSelect()
  }

  function chooseHidden(index: number) {
    const item = hidden[index]
    if (!item || item.disabled) return
    // Closed before the handler runs, so the focus restore is not fighting a handler that opens a
    // dialog of its own.
    closeMenu(true)
    item.onSelect()
  }

  function handleRowKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    props.onKeyDown?.(event)
    // The menu handles its own keys and prevents them; anything it prevented is not the row's.
    if (event.defaultPrevented) return
    // Asked of the row and not of the outer box. Direction is inherited, so the two usually agree —
    // but `...props` land on the row, so a caller writing `dir="rtl"` on this component sets it
    // there, and the outer box above it would still answer with the page's direction.
    const rtl = isRtl(rowRef.current)
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault()
        goTo(nextToolbarStop(visible, hasMore, active, rtl ? -1 : 1))
        break
      case "ArrowLeft":
        event.preventDefault()
        goTo(nextToolbarStop(visible, hasMore, active, rtl ? 1 : -1))
        break
      case "Home":
        event.preventDefault()
        goTo(nextToolbarStop(visible, hasMore, 0, 0))
        break
      case "End":
        event.preventDefault()
        goTo(nextToolbarStop(visible, hasMore, TOOLBAR_MORE, 0))
        break
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        // Prevented twice over: without it the page scrolls as well as the menu opening, and the
        // row's own handler would read the same key as a move between controls.
        event.preventDefault()
        setOpen(true)
        setMenuActive(nextMenuIndex(hidden.length, -1, event.key === "ArrowDown" ? 1 : -1))
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
        setMenuActive((current) => nextMenuIndex(hidden.length, current, 1))
        break
      case "ArrowUp":
        event.preventDefault()
        setMenuActive((current) => nextMenuIndex(hidden.length, current, -1))
        break
      case "ArrowLeft":
      case "ArrowRight":
        // Swallowed rather than acted on. A horizontal arrow means nothing in a vertical menu, and
        // it must not reach the row — moving the toolbar's tab stop under an open menu leaves Escape
        // returning focus to a control the person never left. The structure already prevents that,
        // since the menu is a sibling of the row rather than inside it and nothing bubbles from one
        // to the other; this is the second line, and it also stops a horizontally scrollable
        // ancestor scrolling while somebody arrows down a menu.
        event.preventDefault()
        break
      case "Home":
        event.preventDefault()
        setMenuActive(0)
        break
      case "End":
        event.preventDefault()
        setMenuActive(hidden.length - 1)
        break
      case "Escape":
        event.preventDefault()
        closeMenu(true)
        break
      case "Tab":
        // Not prevented: Tab means leave, and the browser's answer for where to go is the right one.
        // Focus is moved onto the trigger first so that answer is computed from an element still in
        // the document — a Tab from a node that is being removed starts over at the top of the page.
        closeMenu(true)
        break
    }
  }

  if (total === 0) return null

  const control = (
    item: ToolbarOverflowItem,
    options: { index: number; probe: boolean }
  ) => (
    <button
      key={`${item.id ?? item.label}-${options.probe ? "probe" : "row"}`}
      ref={options.probe ? undefined : itemRef(options.index)}
      type="button"
      // The probe is a measurement, not an interface: hidden from assistive technology, out of the
      // tab order, and inert to a press. It is a `<button>` and not a `<span>` for the one reason
      // that matters to a measurement — a UA stylesheet gives `button` its own font, padding and
      // border, Tailwind's preflight normalises some of it and this component cannot assume
      // preflight is there, and a width taken from the wrong element type is worse than none.
      {...(options.probe ? { "aria-hidden": "true", tabIndex: -1 } : {})}
      {...(options.probe
        ? {}
        : {
            tabIndex: active === options.index ? 0 : -1,
            "aria-disabled": item.disabled || undefined,
            onFocus: () => setActive(options.index),
            onClick: () => run(item),
          })}
      aria-label={item.hideLabel ? item.label : undefined}
      // The browser's own tooltip, so an icon-only control says what it is to a mouse as well as to
      // a screen reader. A styled tooltip is a different component.
      title={item.hideLabel ? item.label : undefined}
      className={cn(
        CONTROL_BASE,
        item.disabled ? "pointer-events-none opacity-50" : null,
        itemClassName
      )}
    >
      {item.icon ? (
        <span aria-hidden="true" className="flex size-4 items-center justify-center">
          {item.icon}
        </span>
      ) : null}
      {item.hideLabel ? null : <span>{item.label}</span>}
    </button>
  )

  const trigger = (probe: boolean) => (
    <button
      ref={probe ? undefined : triggerRef}
      id={probe ? undefined : triggerId}
      type="button"
      {...(probe
        ? { "aria-hidden": "true", tabIndex: -1 }
        : {
            tabIndex: active === TOOLBAR_MORE ? 0 : -1,
            "aria-haspopup": "menu" as const,
            "aria-expanded": menuOpen,
            "aria-controls": menuOpen ? menuId : undefined,
            onFocus: () => setActive(TOOLBAR_MORE),
            // Closing restores focus, as in `split-button`. A press has already put focus on the
            // trigger, so it is usually a no-op — but a programmatic click with focus on a menu item
            // would otherwise unmount the menu while it still holds focus, and focus drops to
            // `<body>` from there.
            onClick: () => (menuOpen ? closeMenu(true) : (setOpen(true), setMenuActive(0))),
            onKeyDown: handleTriggerKeyDown,
          })}
      aria-label={labels.more(hidden.length, label)}
      className={cn(CONTROL_BASE, "px-2", triggerClassName)}
    >
      <MoreHorizontal aria-hidden="true" className="size-4" />
    </button>
  )

  return (
    // The outer box exists for the menu, and only for the menu. `relative` makes it the menu's
    // containing block; it deliberately does not clip, because the row below does — and an
    // absolutely positioned panel hanging off the bottom of its own clipping containing block is
    // painted only where it happens to overlap it. Measured in Chrome on this exact pair: with the
    // menu inside the clipping box, a vertical scan of 15 points down the panel hit it 11 times and
    // the 11 were exactly the slice inside the box; moved out to here, 15 of 15. A panel placed at
    // `top-full` is entirely below the row, so inside it would have been painted nowhere at all.
    <div ref={rootRef} className="relative w-full">
      <div
        {...props}
        ref={rowRef}
        role="toolbar"
        aria-label={label}
        // Explicit, though horizontal is the default for the role: this component only knows how to
        // fold along one axis, and the attribute is what says so to a screen reader deciding which
        // arrow keys to promise.
        aria-orientation="horizontal"
        onKeyDown={handleRowKeyDown}
        className={cn(
          // `w-full` and `overflow-hidden` are the pair that makes the measurement stable: the width
          // comes from the parent, and a row one pixel too wide is clipped rather than pushing the
          // container wider — see the note on the component for the loop this removes. `relative`
          // contains the probe, whose scrollable overflow this clipping then absorbs, so a toolbar
          // far too narrow for its controls cannot make the page scroll sideways.
          //
          // The padding is load-bearing too, and it is this clipping that makes it so: a
          // `focus-visible` ring is drawn outside the control's border box, and with the row flush
          // against its controls the ring on the first and last of them is cut off. 4px clears a 2px
          // ring on every side, and `measure` subtracts the row's padding, so the room costs nothing
          // in the arithmetic. A caller setting `p-0` gets the clipped ring back.
          "relative flex w-full items-center gap-1 overflow-hidden p-1",
          className
        )}
      >
        {items.slice(0, visible).map((item, index) => control(item, { index, probe: false }))}
        {hasMore ? trigger(false) : null}

        {/* The measuring copy: every control plus the trigger, at its natural width, never folded. */}
        <div ref={probeRef} aria-hidden="true" style={PROBE_STYLE}>
          {items.map((item, index) => control(item, { index, probe: true }))}
          {trigger(true)}
        </div>
      </div>

      {menuOpen ? (
        <div
          id={menuId}
          role="menu"
          // The attribute official shadcn/ui's collapsing components key their keyframes off, so
          // `menuClassName="data-[state=open]:animate-in"` works in a project that has installed any
          // of them.
          data-state="open"
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          className={cn(
            "absolute top-full z-50 mt-1 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            align === "end" ? "end-0" : "start-0",
            menuClassName
          )}
        >
          {hidden.map((item, index) => (
            <button
              key={item.id ?? item.label}
              ref={menuRef(index)}
              role="menuitem"
              type="button"
              aria-disabled={item.disabled || undefined}
              // Roving: one tab stop for the menu, on the item that has focus.
              tabIndex={index === menuActive ? 0 : -1}
              onClick={() => chooseHidden(index)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none transition-colors",
                "focus:bg-accent focus:text-accent-foreground",
                item.disabled
                  ? "pointer-events-none opacity-50"
                  : "hover:bg-accent hover:text-accent-foreground",
                menuItemClassName
              )}
            >
              {item.icon ? (
                <span aria-hidden="true" className="flex size-4 items-center justify-center">
                  {item.icon}
                </span>
              ) : null}
              {/* The label is always shown here, whatever `hideLabel` says: a menu of bare icons is
                  a menu of unlabelled squares. */}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}

    </div>
  )
}
