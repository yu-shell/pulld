"use client"

import * as React from "react"
import { ArrowDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { ScrollShadow } from "@/registry/ui/scroll-shadow"

/** Every string a reader sees or hears. Override to translate or to reword. */
export interface TermsScrollGateLabels {
  /** Shown while the end has not been on screen yet. */
  more: string
  /** Shown once it has. Deliberately about what was displayed, not about what was read. */
  reached: string
}

export const defaultTermsScrollGateLabels: TermsScrollGateLabels = {
  more: "Scroll to the end to continue",
  reached: "You've reached the end",
}

export interface UseSeenOnceOptions {
  /**
   * Grows or shrinks the box the element has to enter, as an IntersectionObserver margin —
   * `"0px 0px -40px 0px"` to require it a little further up the screen, past a sticky footer that
   * would otherwise be covering it.
   */
  rootMargin?: string
  /**
   * Clears the latch when it changes. Use the identity of the thing being watched — a terms
   * version, a document id — so that replacing the content puts the gate back, instead of the
   * reader inheriting the state they earned on the previous document.
   */
  resetKey?: unknown
}

/**
 * Whether an element has been visible on screen at least once, latched.
 *
 * Exported because "did this ever come into view" is the useful half of an
 * IntersectionObserver and almost never what the API gives you — entries arrive on the way in
 * *and* the way out, so a plain `isIntersecting` in state is a different value a second later. A
 * one-way latch is what a view-counter, a lazy initialiser and this gate all actually want.
 *
 * The observer is thrown away the moment it latches, and nothing is observed again until
 * `resetKey` changes, so a long page of these costs nothing after the reader has passed them.
 */
export function useSeenOnce(
  ref: React.RefObject<Element | null>,
  { rootMargin = "0px", resetKey }: UseSeenOnceOptions = {}
): boolean {
  const [seen, setSeen] = React.useState(false)

  // Adjusted during render rather than in an effect: an effect would let one render through with
  // the previous document's latch still true, which for a consent gate is one render in which the
  // button is live for terms that are no longer on screen.
  const [lastKey, setLastKey] = React.useState(resetKey)
  if (!Object.is(resetKey, lastKey)) {
    setLastKey(resetKey)
    setSeen(false)
  }

  React.useEffect(() => {
    if (seen) return
    const el = ref.current
    if (!el) return

    // Nothing to observe with. Latching open is the deliberate choice: a gate that can never
    // open leaves the form unsubmittable, which is a worse failure than a gate that opens
    // early — and this was never evidence of reading in the first place (see {@link
    // TermsScrollGate}). Every browser that ships IntersectionObserver takes the path above.
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true)
      },
      // No `root`, so the element is measured against the viewport and clipped by every scroll
      // container in between. That is what makes one observer cover both layouts this component
      // is dropped into — see the note on the component.
      { rootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, rootMargin, seen])

  return seen
}

/** What the gate hands to the control it is gating. */
export interface TermsScrollGateState {
  /**
   * Whether the end of the document has been on screen. Gate your control on this — and do it
   * with `aria-disabled`, not `disabled`: see {@link TermsScrollGate}.
   */
  reached: boolean
  /**
   * The id of the status line, for `aria-describedby` on the control. This is how a screen
   * reader user who lands on a control that does nothing finds out why.
   */
  descriptionId: string
  /**
   * Brings the end of the document into view. Not rendered as a button here — whether skipping
   * to the end is acceptable is the caller's call, not this component's — but offered, because
   * on a long document it is a kindness and in some flows it is a requirement.
   */
  scrollToEnd: () => void
}

export interface TermsScrollGateProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The document: terms, a policy, release notes, a consent form. */
  children: React.ReactNode
  /**
   * The control being gated, given the gate's state. Rendered under the box.
   *
   * ```tsx
   * action={({ reached, descriptionId }) => (
   *   <Button
   *     aria-disabled={!reached}
   *     aria-describedby={descriptionId}
   *     onClick={reached ? accept : undefined}
   *   >
   *     I agree
   *   </Button>
   * )}
   * ```
   */
  action?: (state: TermsScrollGateState) => React.ReactNode
  /** Fires on each false → true transition, including after a reset. */
  onReachEnd?: () => void
  /** Clears the latch when it changes — a new version of the document. */
  resetKey?: unknown
  /** Passed through to {@link useSeenOnce}, for a sticky footer covering the last line. */
  rootMargin?: string
  /** Classes for the scrolling box itself: its border, its rounding, its background. */
  boxClassName?: string
  /** Classes for the scrolling element: `max-h-72`, padding, `prose`. */
  viewportClassName?: string
  labels?: Partial<TermsScrollGateLabels>
}

/**
 * A document that has to be scrolled to the end before the control under it will do anything —
 * the "scroll to accept" box on a terms page, a consent form, a release note nobody is allowed to
 * have missed.
 *
 * ```tsx
 * <TermsScrollGate
 *   aria-label="Terms of service"
 *   resetKey="terms-2026-03"
 *   action={({ reached, descriptionId }) => (
 *     <Button aria-disabled={!reached} aria-describedby={descriptionId} onClick={reached ? accept : undefined}>
 *       I agree
 *     </Button>
 *   )}
 * >
 *   <h2 className="font-medium">Terms of service</h2>
 *   <p>…</p>
 * </TermsScrollGate>
 * ```
 *
 * **The arithmetic everybody writes for this is the wrong tool, and its failure is the one that
 * matters.** `scrollTop + clientHeight >= scrollHeight` is the obvious test, and it is three
 * different bugs. `scrollTop` is fractional while the other two are rounded integers, so at a
 * browser zoom other than 100% the sum lands a fraction of a pixel short of the total and the
 * agree button never enables, on a page where there is nothing the reader can do about it. A
 * document shorter than its box never scrolls at all, so the same test has to be special-cased or
 * a four-line policy locks the form forever. And a box that has not been laid out — in a dialog
 * that has not opened, a tab that is not selected, anything `display: none` — reports zeroes for
 * all three, which satisfies the test: the gate opens for terms that have never been on screen.
 *
 * So the end of the document is marked with an element and watched with an IntersectionObserver
 * instead, and all three dissolve rather than being fixed. Intersection is computed in layout
 * units with no rounding, a short document's end marker is simply already visible, and an element
 * in an unrendered subtree has no boxes and cannot intersect anything. Content that grows after
 * first paint — an image decoding, a lazily loaded clause, a web font swapping in — is handled by
 * the browser for free, where the arithmetic version needs a resize listener, a ResizeObserver and
 * a wait on `document.fonts.ready` to notice that the end moved.
 *
 * **The observer has no `root`, which is the other half of the design.** With the scrolling box as
 * the root, a caller who forgets to cap its height gets a gate that opens instantly: the end marker
 * is inside the box's own bounds whether or not any of it is on screen. Measured against the
 * viewport, and clipped by every scroll container in between, one observer covers both layouts
 * honestly — the end of a capped box counts when it is scrolled to *and* the box is on screen, and
 * an uncapped document counts when the page is scrolled to its last line. It is also stricter than
 * any `scrollTop` sum: the reader cannot satisfy a box whose bottom edge is below the fold.
 *
 * Once seen it stays seen. A reader who reaches the end and scrolls back up to re-read a clause has
 * not undone anything, and a gate that closes behind them is the second most common complaint about
 * this pattern after the one that never opens. `resetKey` is what puts the gate back, for a new
 * version of the document rather than for a scroll position.
 *
 * **It does not claim anybody read anything.** Displaying the last line is not reading it, this
 * component cannot tell the difference, and the labels are written to say only what is true. It
 * records nothing, proves nothing, and should not be cited as consent on its own: it is an
 * affordance that stops a reader clicking past a document they have not seen. There are readers for
 * whom the end marker becomes visible without any reading at all — a screen reader moving through
 * the content, `Cmd+End`, a find-in-page hit near the bottom — and that is the right bias. Every
 * alternative is a gate that traps somebody.
 *
 * The control stays focusable and reachable throughout, which is why `action` hands you `reached`
 * and a `descriptionId` rather than rendering a button for you: a `disabled` button is removed from
 * the tab order, so a screen reader user finds nothing where the submit should be and gets no
 * explanation of what is missing. `aria-disabled` with the click ignored leaves it discoverable and
 * described by the status line.
 */
export const TermsScrollGate = React.forwardRef<HTMLDivElement, TermsScrollGateProps>(
  function TermsScrollGate(
    {
      children,
      action,
      onReachEnd,
      resetKey,
      rootMargin,
      className,
      boxClassName,
      viewportClassName,
      labels: labelOverrides,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    ref
  ) {
    const labels = { ...defaultTermsScrollGateLabels, ...labelOverrides }
    const endRef = React.useRef<HTMLDivElement>(null)
    const reached = useSeenOnce(endRef, { rootMargin, resetKey })
    const statusId = React.useId()

    const onReachEndRef = React.useRef(onReachEnd)
    onReachEndRef.current = onReachEnd

    // Keyed off the previous value rather than off `reached` alone, so this is one call per
    // transition however many times the effect runs — StrictMode's double invocation in
    // development, or a re-render while the latch is still true.
    const notifiedRef = React.useRef(false)
    React.useEffect(() => {
      if (reached === notifiedRef.current) return
      notifiedRef.current = reached
      if (reached) onReachEndRef.current?.()
    }, [reached])

    const scrollToEnd = React.useCallback(() => {
      // `scrollIntoView` rather than scrolling the box by its own coordinates: the end marker may
      // be out of view because the box is scrolled, because the page is, or because both are, and
      // this walks up and scrolls every ancestor that needs it. "nearest" so a document that is
      // already fully visible is not scrolled for no reason.
      endRef.current?.scrollIntoView({ block: "end", inline: "nearest" })
    }, [])

    return (
      <div
        ref={ref}
        className={cn("flex min-h-0 flex-col gap-2", className)}
        data-reached={reached ? "" : undefined}
        {...props}
      >
        <ScrollShadow
          orientation="vertical"
          className={cn("rounded-md border bg-background", boxClassName)}
          viewportClassName={cn("max-h-72 p-4 text-sm", viewportClassName)}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          // So the reader who tabs into the box — rather than onto the control — hears where they
          // are in it. The same line serves both, which is why there is one of it.
          aria-describedby={statusId}
        >
          {children}
          {/*
            Inside the scroller and after the content, so it is the last thing to come into view.
            A pixel tall because a zero-height element has no area to intersect with, and
            `aria-hidden` because it is a measuring mark with nothing to say.

            `shrink-0`: this lands in whatever layout the caller's content is in, and inside a flex
            column it would otherwise be a flex item free to collapse to nothing.
          */}
          <div ref={endRef} aria-hidden="true" className="h-px w-full shrink-0" />
        </ScrollShadow>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {/*
            A live region holding one of two strings, so reaching the end is announced once, at the
            moment it happens. Nothing here is driven by scroll position — a percentage updating as
            the reader scrolls would be read out over the document they are trying to read.
          */}
          <p
            id={statusId}
            role="status"
            aria-live="polite"
            className={cn(
              "inline-flex items-center gap-1.5 text-xs",
              reached ? "text-muted-foreground" : "font-medium text-foreground"
            )}
          >
            {reached ? null : <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            {reached ? labels.reached : labels.more}
          </p>
          {action?.({ reached, descriptionId: statusId, scrollToEnd })}
        </div>
      </div>
    )
  }
)
