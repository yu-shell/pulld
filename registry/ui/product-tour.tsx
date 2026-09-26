"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

// Measures before paint so the card never appears at the centre of the screen for one frame before
// jumping to its target. Falls back to useEffect on the server, where useLayoutEffect warns.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/** Which side of its target a step's card sits on. `"auto"` picks the side with room. */
export type TourPlacement = "auto" | "top" | "bottom" | "left" | "right"

/**
 * What a step points at.
 *
 * A selector is the usual form because it survives the element being replaced — which is the normal
 * life of a React node, and the reason a tour cannot hold on to the element itself across a step.
 * An `Element` is accepted for the case where the page already has a ref to it, and a function for
 * the case where finding it is more than a selector (the third row of a table, the active tab's
 * panel).
 *
 * Whichever form is used, it is resolved again on every frame the tour is open rather than once per
 * step: see `ProductTour`.
 */
export type TourTarget = string | Element | (() => Element | null | undefined)

/** One stop on the tour. */
export interface TourStep {
  /**
   * Stable identity, used as the value passed to `onStepChange` and stored for resume.
   *
   * It should outlive a copy edit — `"invite-teammates"` rather than `"step-3"`, which stops meaning
   * the same thing the moment a step is inserted before it.
   */
  id: string
  /**
   * The element this step is about. Leave it out for a step that is about the product rather than a
   * control — the welcome card, the closing card — and the step shows centred with no spotlight.
   */
  target?: TourTarget
  /** Heading of the card. Becomes its accessible name. */
  title?: string
  /** Body of the card. */
  content?: React.ReactNode
  /** Preferred side. Defaults to `"auto"`. */
  placement?: TourPlacement
  /**
   * Whether the target stays usable while this step is showing. Off by default.
   *
   * On, the spotlight is a real hole: clicks reach the target and `Tab` walks its controls before
   * the card's. Off, the target is lit but inert, which is right for "this is where your usage
   * appears" and wrong for "open this menu" — a step that asks for an action the overlay is
   * swallowing is the one bug in a tour that makes a person abandon it.
   *
   * It also decides `aria-modal` on the card: see the render below.
   */
  interactive?: boolean
  /** Breathing room between the target and the edge of the spotlight, in px. Overrides the tour's. */
  padding?: number
}

/** A rectangle in viewport coordinates, as `getBoundingClientRect` gives them. */
export interface TourRect {
  top: number
  left: number
  width: number
  height: number
}

interface Size {
  width: number
  height: number
}

/** The part of a key event this needs — satisfied by a DOM `KeyboardEvent` as much as a React one. */
interface KeyLike {
  key: string
  shiftKey?: boolean
  preventDefault: () => void
}

const clamp = (value: number, min: number, max: number) =>
  max < min ? min : value < min ? min : value > max ? max : value

/**
 * The overlay, as rectangles: the lit hole, and the dimmed pieces around it.
 *
 * Four rectangles rather than one with a hole cut in it, and the reason is hit-testing rather than
 * looks. The two shortcuts are a `box-shadow: 0 0 0 9999px` spread — where the shadow is not a hit
 * area at all, so the page around the target stays fully clickable while the target itself is
 * blocked, i.e. exactly backwards — and a `clip-path` polygon, which does hit-test as drawn but
 * makes "is this region clickable" a property of a path string rather than of an element. With four
 * rectangles the answer is an element each: they take the clicks, the gap between them does not
 * exist to take anything, and making the target inert again is one more rectangle over the hole
 * (which is what a non-interactive step renders).
 *
 * The pieces tile the viewport exactly — no seam, and no overlap, which would show as a darker band
 * where two translucent rectangles meet. That holds while the target hangs off the edge of the
 * screen too, because the hole is intersected with the viewport before the surround is built from
 * it.
 *
 * `null` for the hole means there is nothing to light up — no target, a target that has left the
 * document, one that is `display: none` (a zero-sized rect), or one scrolled entirely out of view —
 * and then the whole viewport is dimmed. Treating those as "no hole" rather than as a rectangle is
 * what keeps the tour from lighting up the top-left corner, which is where a zero rect sits, or the
 * place the target used to be.
 */
export function spotlight(
  target: TourRect | null,
  viewport: Size,
  padding = 6
): { hole: TourRect | null; dim: TourRect[] } {
  const full: TourRect = { top: 0, left: 0, width: viewport.width, height: viewport.height }
  if (!target || target.width <= 0 || target.height <= 0) return { hole: null, dim: [full] }

  const top = clamp(target.top - padding, 0, viewport.height)
  const bottom = clamp(target.top + target.height + padding, 0, viewport.height)
  const left = clamp(target.left - padding, 0, viewport.width)
  const right = clamp(target.left + target.width + padding, 0, viewport.width)
  if (bottom <= top || right <= left) return { hole: null, dim: [full] }

  const hole: TourRect = { top, left, width: right - left, height: bottom - top }
  const dim = [
    { top: 0, left: 0, width: viewport.width, height: top },
    { top: bottom, left: 0, width: viewport.width, height: viewport.height - bottom },
    { top, left: 0, width: left, height: hole.height },
    { top, left: right, width: viewport.width - right, height: hole.height },
  ].filter((rect) => rect.width > 0 && rect.height > 0)
  return { hole, dim }
}

const SIDES: ReadonlyArray<Exclude<TourPlacement, "auto">> = ["bottom", "top", "right", "left"]

/** Room between the hole and the edge of the viewport, on each side. */
function roomAround(hole: TourRect, viewport: Size, gap: number, margin: number) {
  return {
    top: hole.top - gap - margin,
    bottom: viewport.height - (hole.top + hole.height) - gap - margin,
    left: hole.left - gap - margin,
    right: viewport.width - (hole.left + hole.width) - gap - margin,
  }
}

/**
 * Where the card goes, given the hole it belongs to and how big the card turned out to be.
 *
 * Pure and exported, because placement is the part of a tour that is wrong in a way nobody notices
 * until a laptop or a phone is involved: the side with room on the designer's monitor is the side
 * with none on a 13-inch one, and a card that lands half off the bottom of the window has no "Next"
 * button on it. Three rules, in this order:
 *
 *  1. A requested side is honoured when the card fits there, and abandoned when it does not — a
 *     `placement: "right"` obeyed on a narrow window puts the card off the screen. The fallback is
 *     not the opposite side but the side with the most room, so a target near the top of a short
 *     window gets its card below rather than clipped above.
 *  2. The cross axis is clamped into the viewport, never centred blindly. Centring a 320px card on a
 *     target 40px from the left edge hangs 120px of it outside the window.
 *  3. When nothing fits — a target nearly as large as the window, which is what a "this whole panel"
 *     step is on a phone — the card is placed inside the viewport anyway and allowed to overlap the
 *     target. Being readable beats being adjacent, and the arrow is dropped in that case so it never
 *     points at something the card is sitting on top of.
 *
 * With no hole, the card is centred and there is nothing to point at.
 */
export function placeBubble({
  hole,
  bubble,
  viewport,
  placement = "auto",
  gap = 10,
  margin = 8,
}: {
  hole: TourRect | null
  bubble: Size
  viewport: Size
  placement?: TourPlacement
  gap?: number
  margin?: number
}): {
  placement: Exclude<TourPlacement, "auto"> | "center"
  left: number
  top: number
  /** Offset of the arrow along the card's cross axis, or `null` when there is nothing to point at. */
  arrow: number | null
} {
  const maxLeft = viewport.width - bubble.width - margin
  const maxTop = viewport.height - bubble.height - margin

  if (!hole) {
    return {
      placement: "center",
      left: clamp((viewport.width - bubble.width) / 2, margin, maxLeft),
      top: clamp((viewport.height - bubble.height) / 2, margin, maxTop),
      arrow: null,
    }
  }

  const room = roomAround(hole, viewport, gap, margin)
  const needed = (side: Exclude<TourPlacement, "auto">) =>
    side === "top" || side === "bottom" ? bubble.height : bubble.width

  let chosen: Exclude<TourPlacement, "auto"> | null = null
  if (placement !== "auto" && room[placement] >= needed(placement)) chosen = placement
  if (!chosen) chosen = SIDES.find((candidate) => room[candidate] >= needed(candidate)) ?? null
  const fits = chosen !== null
  // Nothing fits: the side with the most room is the one the card overlaps the target least on.
  const side =
    chosen ?? SIDES.reduce((best, candidate) => (room[candidate] > room[best] ? candidate : best))

  const vertical = side === "top" || side === "bottom"
  const left = vertical
    ? clamp(hole.left + hole.width / 2 - bubble.width / 2, margin, maxLeft)
    : clamp(
        side === "left" ? hole.left - gap - bubble.width : hole.left + hole.width + gap,
        margin,
        maxLeft
      )
  const top = vertical
    ? clamp(
        side === "top" ? hole.top - gap - bubble.height : hole.top + hole.height + gap,
        margin,
        maxTop
      )
    : clamp(hole.top + hole.height / 2 - bubble.height / 2, margin, maxTop)

  // The arrow tracks the centre of the target, held far enough from the card's own corners that it
  // never grows out of a rounded one. Dropped when the card had to overlap the target, and when
  // clamping left the card no longer reaching the side it was placed on.
  const ARROW_INSET = 16
  const adjacent =
    side === "bottom"
      ? top >= hole.top + hole.height
      : side === "top"
        ? top + bubble.height <= hole.top
        : side === "right"
          ? left >= hole.left + hole.width
          : left + bubble.width <= hole.left
  const span = vertical ? bubble.width : bubble.height
  const arrow =
    fits && adjacent && span >= ARROW_INSET * 2
      ? clamp(
          vertical ? hole.left + hole.width / 2 - left : hole.top + hole.height / 2 - top,
          ARROW_INSET,
          span - ARROW_INSET
        )
      : null

  return { placement: side, left, top, arrow }
}

// Everything a browser will stop on when Tab is pressed, before visibility is taken into account.
const TABBABLE = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex^="-"])',
].join(",")

/** The tab stops inside `root` — plus `root` itself if it is one — skipping what a browser skips. */
export function tabbablesIn(root: Element | null): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== "function") return []
  const found = Array.from(root.querySelectorAll(TABBABLE)) as HTMLElement[]
  // A target can be the control rather than contain one: the step points at a single button, and a
  // scope built only from descendants would leave the person nothing to tab to.
  if (root.matches?.(TABBABLE)) found.unshift(root as HTMLElement)
  return found.filter(
    (node) =>
      !node.hasAttribute("inert") &&
      node.getAttribute("aria-hidden") !== "true" &&
      // The cheap stand-in for "is it rendered": a node in a `display: none` subtree, or inside a
      // closed `details`, has no boxes at all. More honest than reading computed styles up the tree,
      // and it is what the browser's own tab order agrees with.
      (typeof node.getClientRects !== "function" || node.getClientRects().length > 0)
  )
}

/**
 * The element a step is about, right now, or null.
 *
 * A node React has already unmounted still answers `getBoundingClientRect` — with the rectangle it
 * had when it was detached. Lighting that up is the "spotlight over nothing" bug, so a target that
 * is no longer in the document is no target.
 */
function resolveTarget(target: TourTarget | undefined): Element | null {
  if (!target) return null
  if (typeof target === "string") {
    if (typeof document === "undefined") return null
    return document.querySelector(target)
  }
  const element = typeof target === "function" ? target() : target
  return element && element.isConnected !== false ? element : null
}

/**
 * The rectangle a target occupies right now, or null when it has none worth pointing at.
 *
 * One rule, in one place, because "missing" has to mean the same thing everywhere it is asked. An
 * element that is in the document and has no box — inside a `display: none` subtree, in a closed
 * `details`, a collapsed sidebar item — is not something a tour can point at, so it counts as missing
 * exactly like an absent one. Splitting that decision across a `getBoundingClientRect` guard in one
 * place and a `!== null` check on the element in another is how a tour ends up lighting nothing while
 * insisting the target is present.
 */
function boxOf(element: Element | null): TourRect | null {
  const rect = element?.getBoundingClientRect?.()
  if (!rect || rect.width <= 0 || rect.height <= 0) return null
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
}

const sameRect = (a: TourRect | null, b: TourRect | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height)

/** Whether a rectangle is wholly inside the viewport. */
const fullyVisible = (rect: TourRect, viewport: Size) =>
  rect.top >= 0 &&
  rect.left >= 0 &&
  rect.top + rect.height <= viewport.height &&
  rect.left + rect.width <= viewport.width

/** Why the tour ended, and where the person was when it did. */
export interface TourFinish {
  /** `"completed"` when the last step's button was pressed; `"dismissed"` for Escape or the ×. */
  reason: "completed" | "dismissed"
  /** The step showing at the time — what resume should be stored as. */
  stepId: string
  /** Its index in `steps`. */
  index: number
}

export interface ProductTourProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "role"> {
  /** The stops, in order. */
  steps: readonly TourStep[]
  /** Controlled visibility. */
  open?: boolean
  /** Starting visibility for an uncontrolled tour. Ignored once `open` is passed. */
  defaultOpen?: boolean
  /** Called when the tour opens or closes. Pair it with `open`. */
  onOpenChange?: (open: boolean) => void
  /** Controlled current step, by `id`. */
  stepId?: string
  /**
   * The step an uncontrolled tour starts on — i.e. resume.
   *
   * An id that is not in `steps` starts at the beginning rather than showing nothing, because the
   * one way that happens in production is a position saved before the tour was rewritten, and a
   * person coming back to a rewritten tour should see it rather than see nothing.
   */
  defaultStepId?: string
  /** Called with the step now showing. */
  onStepChange?: (stepId: string, index: number) => void
  /**
   * Called once when the tour ends, with why and where.
   *
   * This is the whole of the persistence boundary. Nothing here writes to `localStorage`: which
   * store a "seen it" flag belongs in is the application's decision and usually the server's — a
   * flag in browser storage is per-device, so the tour runs again on the phone, it is wiped with a
   * cleared cache, and on a shared machine it belongs to whoever logged in first. Keep
   * `finish.stepId` and hand it back as `defaultStepId` to resume.
   */
  onFinish?: (finish: TourFinish) => void
  /** Room between a target and the edge of its spotlight, in px. A step can override it. */
  padding?: number
  /** Distance from the spotlight to the card, in px. */
  gap?: number
  /** Smallest distance the card keeps from the edge of the window, in px. */
  viewportMargin?: number
  /** Whether a target out of view is scrolled into view when its step opens. */
  scrollTargetIntoView?: boolean
  /**
   * How long a step's target may be missing before `onTargetMissing` is called, in ms.
   *
   * A target is routinely absent for a moment — the panel it lives in is code-split, the route is
   * still resolving, the list is still fetching — so the tour waits rather than reporting. The timer
   * is what separates that from a step pointing at something which is never coming, usually because
   * a selector went stale in a refactor.
   */
  targetTimeout?: number
  /**
   * Called once per step when its target has still not appeared after `targetTimeout`.
   *
   * The card is showing centred by then, which is legible but is no longer a tour. What to do about
   * it belongs to the application, the only party that knows whether the step is skippable: advance
   * past it, end the tour, or leave it and log that the selector needs fixing.
   */
  onTargetMissing?: (step: TourStep, index: number) => void
  /** Accessible name of the card for a step with no `title`. */
  label?: string
  /** The "2 of 5" line. Return an empty string to leave it out. */
  progressLabel?: (index: number, total: number) => string
  /** Text of the button that goes back a step. */
  backLabel?: string
  /** Text of the button that goes on a step. */
  nextLabel?: string
  /** Text of the button that ends the tour on the last step. */
  finishLabel?: string
  /** Accessible name of the × that abandons the tour. */
  skipLabel?: string
  /** Whether Escape abandons the tour. */
  closeOnEscape?: boolean
  /** Classes for the dimmed surround. */
  scrimClassName?: string
}

const defaultProgressLabel = (index: number, total: number) => `${index + 1} of ${total}`

/**
 * A guided tour: a card that walks through the real screen, lighting up the control it is talking
 * about.
 *
 * ```tsx
 * const [open, setOpen] = React.useState(!user.seenTour)
 *
 * <ProductTour
 *   open={open}
 *   onOpenChange={setOpen}
 *   defaultStepId={user.tourStepId ?? undefined}
 *   onStepChange={(id) => saveProgress(id)}
 *   onFinish={({ reason, stepId }) => saveSeen({ reason, stepId })}
 *   steps={[
 *     { id: "welcome", title: "Welcome", content: "Here is the short version." },
 *     { id: "search", target: "[data-tour='search']", title: "Find anything", content: "…" },
 *     { id: "new", target: "#new-project", title: "Start something", content: "…", interactive: true },
 *   ]}
 * />
 * ```
 *
 * Mount it near the root of the app. The overlay is `position: fixed`, which is measured against the
 * nearest ancestor carrying a `transform`, `filter` or `perspective` rather than against the window —
 * inside one of those the tour would be trapped in a corner of the page. There is no portal because
 * an item in this registry is one file with no `react-dom` import, and the root is where a tour
 * belongs anyway.
 *
 * What it does not own is the decision to run: whether this person has seen the tour, and where they
 * left off, are the application's to store (see `onFinish`).
 */
export const ProductTour = React.forwardRef<HTMLDivElement, ProductTourProps>(function ProductTour(
  {
    className,
    steps,
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    stepId: stepIdProp,
    defaultStepId,
    onStepChange,
    onFinish,
    padding = 6,
    gap = 10,
    viewportMargin = 8,
    scrollTargetIntoView = true,
    targetTimeout = 4000,
    onTargetMissing,
    label = "Product tour",
    progressLabel = defaultProgressLabel,
    backLabel = "Back",
    nextLabel = "Next",
    finishLabel = "Done",
    skipLabel = "Skip the tour",
    closeOnEscape = true,
    scrimClassName,
    ...props
  },
  ref
) {
  const total = steps.length
  const indexOfId = (id: string | undefined) => {
    if (id === undefined) return 0
    const at = steps.findIndex((candidate) => candidate.id === id)
    return at === -1 ? 0 : at
  }

  const isOpenControlled = openProp !== undefined
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = (isOpenControlled ? openProp : uncontrolledOpen) && total > 0

  const isStepControlled = stepIdProp !== undefined
  const [uncontrolledIndex, setUncontrolledIndex] = React.useState(() => indexOfId(defaultStepId))
  const index = clamp(
    isStepControlled ? indexOfId(stepIdProp) : uncontrolledIndex,
    0,
    Math.max(total - 1, 0)
  )
  const step: TourStep | undefined = steps[index]

  /**
   * Rewinds an uncontrolled tour to its resume point each time it opens.
   *
   * Without this, a tour dismissed on step 4 and opened again starts on step 4 even though the
   * caller asked for `defaultStepId` — last run's state is still sitting there. Written as an
   * adjustment during render rather than in an effect so the first painted step is the right one.
   */
  const [lastOpen, setLastOpen] = React.useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open && !isStepControlled) setUncontrolledIndex(indexOfId(defaultStepId))
  }

  const [targetRect, setTargetRect] = React.useState<TourRect | null>(null)
  const [cardSize, setCardSize] = React.useState<Size>({ width: 320, height: 160 })
  const [viewport, setViewport] = React.useState<Size>({ width: 0, height: 0 })

  const cardRef = React.useRef<HTMLDivElement>(null)
  const targetNode = React.useRef<Element | null>(null)
  const scrolledFor = React.useRef<number | null>(null)
  React.useImperativeHandle(ref, () => cardRef.current as HTMLDivElement)

  const hasRect = targetRect !== null

  /**
   * Keeps the spotlight on the target, every frame, for as long as the tour is open.
   *
   * The alternative — measure once per step, then again on `scroll` and `resize` — is what makes
   * tours point at empty space, and the cases it misses are not exotic. A panel that slides open
   * with a CSS transition moves the target through a hundred positions and fires no event at all. A
   * web font swapping in reflows the line the target sits on. An image finishing its download pushes
   * it down the page. A sibling collapsing pulls it up. Observers cover some of that and not the
   * animation, which is the case a tour meets first, because a tour usually begins by opening
   * something.
   *
   * So the loop is the design rather than a fallback, and it is cheap: one `getBoundingClientRect`
   * on the target, one on the card, and a comparison. React is only told when a number actually
   * changed, so a still page settles into a loop that renders nothing. It runs while a tour is on
   * screen and no longer.
   *
   * The target is resolved inside the loop as well, not captured when the step began. That is what
   * makes "not there yet" and "gone" the same state as "no target" — the hole is simply not drawn —
   * instead of a rectangle left over from something that has moved or been unmounted.
   */
  useIsomorphicLayoutEffect(() => {
    if (!open || !step || typeof document === "undefined") return

    let live = true
    let frame = 0

    const measure = () => {
      if (!live) return
      const element = resolveTarget(step.target)
      targetNode.current = element
      setTargetRect((previous) => {
        const next = boxOf(element)
        return sameRect(previous, next) ? previous : next
      })

      const card = cardRef.current?.getBoundingClientRect?.()
      if (card && card.width > 0) {
        setCardSize((previous) =>
          previous.width === card.width && previous.height === card.height
            ? previous
            : { width: card.width, height: card.height }
        )
      }

      const width = window.innerWidth
      const height = window.innerHeight
      setViewport((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height }
      )

      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(measure)
    }

    measure()
    return () => {
      live = false
      if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
    }
    // `step.target` and not `step`: the steps are written as an inline array, so the step object is
    // a new one on every render of the host page, and depending on it would tear the loop down and
    // build it up again each time. What the loop reads is the target, and `index` covers the rest.
  }, [open, index, step?.target])

  /**
   * Moves focus onto the card at every step.
   *
   * To the card and not to a button on it, so a screen reader reads the step before its controls;
   * the card is `tabIndex={-1}` for exactly this. It has to happen on every step, because the card
   * is one element whose contents change, and content quietly replacing itself tells a screen reader
   * nothing.
   *
   * Keyed on the index rather than on the step object for the same reason as the loop above:
   * otherwise a re-render of the host page would yank focus back off whatever the person had tabbed
   * to.
   */
  React.useEffect(() => {
    if (!open) return
    cardRef.current?.focus?.()
  }, [open, index])

  /**
   * Brings the target into view, once per step, when it is not already.
   *
   * Once per step, not once per frame: re-running it would fight the person's own scrolling, and on
   * an interactive step they may well have to scroll to use the target. Waiting for a rectangle
   * rather than acting at the step change is what makes it work for a target that arrives late,
   * which is the ordinary case for a code-split panel.
   */
  React.useEffect(() => {
    if (!open || !scrollTargetIntoView) return
    if (!targetRect || scrolledFor.current === index) return
    scrolledFor.current = index
    if (fullyVisible(targetRect, viewport)) return
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    targetNode.current?.scrollIntoView?.({
      block: "center",
      inline: "nearest",
      behavior: reduced ? "auto" : "smooth",
    })
  }, [open, index, targetRect, viewport, scrollTargetIntoView])

  React.useEffect(() => {
    if (!open) scrolledFor.current = null
  }, [open])

  /**
   * Reports a target that is never coming, once per step.
   *
   * Restarted by the step change and cancelled the moment a rectangle arrives, so a step that
   * resolves inside the window says nothing — which is the common case, and the reason this is a
   * timer rather than a check.
   */
  React.useEffect(() => {
    if (!open || !step?.target || !onTargetMissing || hasRect) return
    if (typeof window === "undefined") return
    // The timer re-establishes its own premise before reporting. Its cleanup cancels it the moment a
    // rectangle arrives, so this should never be reachable with the target present — but "should
    // never" across a fast enough sequence of renders is how a tour comes to report a step that is
    // on screen and working, and the check costs one selector lookup.
    const timer = window.setTimeout(() => {
      if (boxOf(resolveTarget(step.target)) === null) onTargetMissing(step, index)
    }, targetTimeout)
    return () => window.clearTimeout(timer)
    // `step` is deliberately not a dependency: see the loop above. The step it reports is the one
    // this effect was set up for, which is what the caller needs to know.
  }, [open, index, hasRect, targetTimeout, onTargetMissing])

  const setOpenState = (next: boolean) => {
    if (!isOpenControlled) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const goTo = (next: number) => {
    const at = clamp(next, 0, total - 1)
    if (!isStepControlled) setUncontrolledIndex(at)
    onStepChange?.(steps[at].id, at)
  }

  const finish = (reason: TourFinish["reason"]) => {
    if (step) onFinish?.({ reason, stepId: step.id, index })
    setOpenState(false)
  }

  const isLast = index >= total - 1
  const handleNext = () => (isLast ? finish("completed") : goTo(index + 1))

  /**
   * Keeps Tab inside what the step is about.
   *
   * For a step whose target is inert the scope is the card alone, which is an ordinary modal trap.
   * For an interactive step it cannot be: the person has been told to operate the target, so the
   * target's own controls are in scope — and they come first, ahead of Back and Next. Putting the
   * card's buttons first instead means the thing a person has just been asked to click is several
   * tab stops past a button called "Next", and the reflex of pressing Enter on the first stop skips
   * the step they were halfway through doing.
   *
   * `preventDefault` on every Tab, including the ones that move within the scope, because the whole
   * point is that the order is this one and not the document's.
   */
  const handleKey = (event: KeyLike) => {
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault()
      finish("dismissed")
      return
    }
    if (event.key !== "Tab") return
    const stops = [
      ...(step?.interactive ? tabbablesIn(targetNode.current) : []),
      ...tabbablesIn(cardRef.current),
    ]
    if (stops.length === 0) return
    event.preventDefault()
    const active = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)
    const at = active ? stops.indexOf(active) : -1
    const delta = event.shiftKey ? -1 : 1
    // Focus on the card itself rather than on a stop — which is where every step starts it — enters
    // the scope at its first stop going forwards and its last going backwards.
    const to =
      at === -1 ? (event.shiftKey ? stops.length - 1 : 0) : (at + delta + stops.length) % stops.length
    stops[to]?.focus?.()
  }

  /**
   * The handler, always the current one, for the document listener below to call.
   *
   * Written through a ref updated after every render rather than captured by the listener, so the
   * listener can be attached once per opening while still closing over this render's steps, index and
   * callbacks. Assigned in an effect and not during render, because a render can be thrown away.
   */
  const keyHandler = React.useRef(handleKey)
  React.useEffect(() => {
    keyHandler.current = handleKey
  })

  /**
   * Listens on the document, which is the only place this can work.
   *
   * The obvious thing is `onKeyDown` on the card, and it holds together exactly until the first Tab
   * does what it was built to do: on an interactive step focus moves to the target, the target is
   * outside the card's subtree, and every Tab after that never reaches the handler at all — so the
   * scope the step promised is one stop deep and the page behind takes the rest. A capture-phase
   * listener on the document sees the key wherever focus has got to, which is what makes the scope a
   * scope rather than a first move.
   *
   * Attached only while the tour is open, so a closed tour is not listening to the page's typing.
   */
  React.useEffect(() => {
    if (!open || typeof document === "undefined") return
    const onKeyDown = (event: KeyboardEvent) => keyHandler.current(event)
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open])

  const headingId = React.useId()
  const bodyId = React.useId()

  // The viewport is measured in a layout effect, i.e. before the first paint but after the first
  // render, and every position here is derived from it. Rendering the overlay before it is known puts
  // a card in the top-left corner of the page — harmless in the browser, where the effect corrects it
  // before anything is painted, but it is also what the server would send, and the client would then
  // be hydrating a card that belongs somewhere else. A tour is a client-side thing; it starts once
  // there is a window to place it in.
  if (!open || !step || viewport.width === 0) return null

  const { hole, dim } = spotlight(targetRect, viewport, step.padding ?? padding)
  const placed = placeBubble({
    hole,
    bubble: cardSize,
    viewport,
    placement: step.placement ?? "auto",
    gap,
    margin: viewportMargin,
  })
  const progress = progressLabel(index, total)
  // Only a step that has something lit can be interactive: with no hole there is nothing to reach
  // through, and claiming otherwise would drop `aria-modal` from a card that really is modal.
  const interactive = step.interactive === true && hole !== null

  const px = (value: number) => `${Math.round(value)}px`
  const arrowSide =
    placed.placement === "bottom"
      ? "top"
      : placed.placement === "top"
        ? "bottom"
        : placed.placement === "right"
          ? "left"
          : placed.placement === "left"
            ? "right"
            : null
  const arrowStyle: React.CSSProperties =
    arrowSide === "top"
      ? { top: -5, left: px((placed.arrow ?? 0) - 4), borderWidth: "1px 0 0 1px" }
      : arrowSide === "bottom"
        ? { bottom: -5, left: px((placed.arrow ?? 0) - 4), borderWidth: "0 1px 1px 0" }
        : arrowSide === "left"
          ? { left: -5, top: px((placed.arrow ?? 0) - 4), borderWidth: "0 0 1px 1px" }
          : { right: -5, top: px((placed.arrow ?? 0) - 4), borderWidth: "1px 1px 0 0" }

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {/*
        The dimmed surround. Each piece takes pointer events, so the page around the spotlight is
        not clickable; the gap between them is where the target is, and a gap intercepts nothing.
        Clicking the dim does nothing at all rather than ending the tour — a person who has read four
        steps and clicked slightly wide of the card has not asked to lose the rest of it.
      */}
      {dim.map((rect, at) => (
        <div
          key={at}
          aria-hidden="true"
          /*
            A literal black rather than a token, which is the one place in this file that is right.
            `bg-foreground/50` reads as "the ink colour at half strength" and inverts with the theme,
            so in dark mode it washes the page out *lighter* — a scrim has to darken in both. This is
            what shadcn's own dialog overlay does, and what command-palette in this registry does.
          */
          className={cn("pointer-events-auto absolute bg-black/50", scrimClassName)}
          style={{
            top: px(rect.top),
            left: px(rect.left),
            width: px(rect.width),
            height: px(rect.height),
          }}
        />
      ))}

      {/*
        Over the hole, for a step whose target is only being pointed at. Without it the hole is a
        hole in the clicks as well as in the dimming, and a person can press a button the tour has
        not reached yet — from a screen that looks like it is not accepting input.
      */}
      {hole && !interactive ? (
        <div
          aria-hidden="true"
          data-tour-blocker=""
          className="pointer-events-auto absolute"
          style={{
            top: px(hole.top),
            left: px(hole.left),
            width: px(hole.width),
            height: px(hole.height),
          }}
        />
      ) : null}

      {/* The ring around the target. Never takes events: on an interactive step it sits over a live hole. */}
      {hole ? (
        <div
          aria-hidden="true"
          data-tour-spotlight=""
          className="pointer-events-none absolute rounded-md ring-2 ring-ring"
          style={{
            top: px(hole.top),
            left: px(hole.left),
            width: px(hole.width),
            height: px(hole.height),
          }}
        />
      ) : null}

      <div
        /*
          A new element per step, which is what makes the step change audible. Reuse one node and the
          focus() below is a no-op whenever focus is already on the card — and that is not a corner
          case: Safari does not focus a button when it is clicked, so a person clicking "Next" there
          leaves focus on the card, and a screen reader is told nothing at all about the step that
          replaced the one it read out. Remounting means focus always moves, and moving into a named
          dialog is the announcement.
        */
        key={step.id}
        ref={cardRef}
        role="dialog"
        /*
          True only while the rest of the page really is unreachable. On an interactive step it would
          be a lie with teeth: `aria-modal="true"` makes a screen reader hide everything outside this
          card, so the control the step has just told the person to press is not in the accessibility
          tree for them to press. The dim rectangles and the tab scope are what enforce the modality
          claimed here.
        */
        aria-modal={interactive ? undefined : true}
        aria-labelledby={step.title ? headingId : undefined}
        aria-label={step.title ? undefined : label}
        aria-describedby={step.content ? bodyId : undefined}
        tabIndex={-1}
        data-placement={placed.placement}
        className={cn(
          "pointer-events-auto absolute w-[min(20rem,calc(100vw-1rem))] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg focus-visible:outline-none",
          className
        )}
        style={{ top: px(placed.top), left: px(placed.left) }}
        {...props}
      >
        {placed.arrow !== null && arrowSide ? (
          <span
            aria-hidden="true"
            className="absolute h-2 w-2 rotate-45 border bg-popover"
            style={arrowStyle}
          />
        ) : null}

        {step.title ? (
          <h2 id={headingId} className="pr-8 text-sm font-semibold leading-none tracking-tight">
            {step.title}
          </h2>
        ) : null}
        {step.content ? (
          <div id={bodyId} className={cn("text-sm text-muted-foreground", step.title && "mt-2")}>
            {step.content}
          </div>
        ) : null}

        <div className="mt-4 flex items-center gap-2">
          {progress ? (
            <span className="text-xs tabular-nums text-muted-foreground">{progress}</span>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {index > 0 ? (
              <button
                type="button"
                onClick={() => goTo(index - 1)}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {backLabel}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleNext}
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {isLast ? finishLabel : nextLabel}
            </button>
          </div>
        </div>

        {/*
          Last in the DOM although it sits in the top-right corner, so the tab order inside the card
          is Back, Next, Skip rather than Skip, Back, Next — the thing a person is least likely to
          want should not be the first stop — and a screen reader reads the step and its controls
          before being offered the way out.
        */}
        <button
          type="button"
          aria-label={skipLabel}
          onClick={() => finish("dismissed")}
          className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
})
