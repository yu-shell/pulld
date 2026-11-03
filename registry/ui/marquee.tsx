"use client"

import * as React from "react"
import { Pause, Play } from "lucide-react"

import { cn } from "@/lib/utils"

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)"

/** Pixels of travel per second when the caller has not said. */
const DEFAULT_SPEED = 48

/** Space between items, in px, when the caller has not said. */
const DEFAULT_GAP = 24

/**
 * The fewest copies ever rendered.
 *
 * Two, because the second copy is the ruler: the distance one loop travels is measured as the
 * distance from the start of the first copy to the start of the second, and a track holding one
 * copy has nothing to measure against. It is also the floor of what a seamless loop needs —
 * something has to be arriving behind the content that is leaving.
 */
const MIN_COPIES = 2

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * `Animation.currentTime` in milliseconds.
 *
 * The DOM type is `CSSNumberish`, which is a plain number for every animation created the way this
 * one is — a numeric duration on a document timeline — and a `CSSNumericValue` only on a timeline
 * measuring something other than time. Falling back to zero rather than unwrapping a unit value
 * keeps the type honest, and the cost of being wrong is that a rebuilt animation starts at the top
 * of its loop, which is what it would have done without any of this.
 */
const millis = (time: Animation["currentTime"]): number =>
  typeof time === "number" ? time : 0

/**
 * Whether this visitor has asked for less motion, read from the media query rather than from state.
 *
 * Used to decide whether to start an animation, where the answer is needed before any state has
 * settled. Which tree to render is a separate question answered from state — see `reduced` below.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  return window.matchMedia(REDUCED_MOTION).matches
}

export interface MarqueeCopyCountOptions {
  /** Distance from the start of one copy to the start of the next, gap included, in px. */
  step: number
  /** Width of a single copy, in px, not counting the gap that follows it. */
  copyWidth: number
  /** Width of the visible box the copies travel through, in px. */
  viewportWidth: number
}

/**
 * How many copies of the content it takes to keep the box full for a whole loop.
 *
 * One loop moves the track left by exactly `step`, at which point every copy stands where the one
 * before it stood and the jump back to the start is invisible. For the box to stay full throughout,
 * the copies have to reach `step + viewportWidth`: by the end of the travel the first `step` pixels
 * have left the box and what remains has to cover all of it.
 *
 * `n` copies reach `n * step - gap`, not `n * step`, because the gap trails every copy but the
 * last. So the requirement is `n * step - gap >= step + viewportWidth`, which is
 * `n = ceil((viewportWidth + gap) / step) + 1`.
 *
 * **The gap is the term that gets dropped, and dropping it shows.** `ceil(viewportWidth / step) + 1`
 * is what this was first written as, and it is right almost everywhere: swept over 27 combinations
 * of gap and box width it was short in one. In that one — a 40px gap, a 300px box, a 316.44px step
 * — it left **23.56px of emptiness** at the trailing edge at the moment of fullest travel, once per
 * loop. The exact form was short in none of the 27.
 *
 * The gap is not a parameter because it need not be: it is `step - copyWidth`, and both of those
 * are measured off the rendered track. A gap taken from a prop or read back from CSS would disagree
 * with the layout the moment anything else set one.
 */
export function marqueeCopyCount({
  step,
  copyWidth,
  viewportWidth,
}: MarqueeCopyCountOptions): number {
  // Nothing has been laid out, or there is nothing to lay out. A box inside a closed dialog or an
  // unselected tab measures zero on every axis, exactly as empty content does, and neither is a
  // division worth doing: `ceil(width / 0)` is Infinity, and a copy count of Infinity is a render
  // that never returns.
  if (!(step > 0) || !(copyWidth > 0) || !Number.isFinite(viewportWidth)) return MIN_COPIES
  const gap = Math.max(step - copyWidth, 0)
  // A negative box width needs no clamp of its own: the arithmetic returns something below two and
  // the floor takes it from there.
  return Math.max(Math.ceil((viewportWidth + gap) / step) + 1, MIN_COPIES)
}

/** What was measured off the track, and what it implies. */
interface Geometry {
  /** Start-to-start distance between copies, gap included, in px. 0 until measured. */
  step: number
  /** Width of one copy, in px. 0 until measured, and 0 for a box with no layout. */
  copyWidth: number
  /** Copies to render. */
  copies: number
}

const UNMEASURED: Geometry = { step: 0, copyWidth: 0, copies: MIN_COPIES }

export interface MarqueeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The items to run past. Cloned, so keep them presentational — see the note on the component. */
  children: React.ReactNode
  /** Travel in pixels per second. Defaults to 48. */
  speed?: number
  /** Which way the content travels. Defaults to "left". */
  direction?: "left" | "right"
  /** Space between items, in px. Defaults to 24. */
  gap?: number
  /** Stop while a pointer that can hover is over it. Defaults to true. */
  pauseOnHover?: boolean
  /** Stop while focus is inside it. Defaults to true. */
  pauseOnFocus?: boolean
  /** Render the pause button. Defaults to true — it is the only way to stop this without a mouse. */
  controls?: boolean
  /** Hold the pause from outside. Leave it out to let the button own that state. */
  paused?: boolean
  /** Told when the pause is turned on or off. */
  onPausedChange?: (paused: boolean) => void
  /** Accessible name of the button while the content is moving. */
  pauseLabel?: string
  /** Accessible name of the button while it is held stopped. */
  resumeLabel?: string
}

/**
 * A row of content that runs past without a seam.
 *
 * For the places where a list is longer than the space given to it and the point is the list rather
 * than any one entry: a wall of customer logos, a strip of press mentions or integrations, the
 * speaker line-up on a conference page, a status band along the top of a dashboard, a notice
 * scrolling across a lobby display, a ticker of recent signups.
 *
 * **The seam is the whole problem, and the only way to hide it is to duplicate the content.** One
 * copy sliding left eventually drags its own end into view, so the content is rendered several
 * times over and the track travels exactly the distance from one copy to the next — at which point
 * every copy stands where the one before it stood, and the jump back to the start has nothing to
 * give it away. Measured on a Web Animations loop, the computed transform at the end of an
 * iteration is identical to the transform at the start.
 *
 * **The duplicates are `aria-hidden` *and* `inert`, and both are needed.** `aria-hidden` alone
 * leaves a clone's links and buttons focusable — measured — so a wall of three logo links rendered
 * in four copies hands a keyboard user twelve tab stops, nine of which lead somewhere a screen
 * reader has been told is not there. `inert` takes them out of the tab order too, and keeps a clone
 * from swallowing a click meant for the real thing.
 *
 * **Speed is pixels per second, not a duration**, because a duration is not a speed: three logos
 * and thirty logos both set to "20s" travel at a tenth of each other's pace, so every addition to
 * the list silently retunes the animation. Here the duration is computed from the distance that was
 * measured, so adding a logo does not change how fast the band reads.
 *
 * **Under `prefers-reduced-motion: reduce` this is a different component, not a stopped one.** A
 * stopped marquee is a list with its end cut off — measured on a 300px box, 233px of the content
 * sits outside it — so reduce gets a plain wrapping list instead, which measured 0px of overflow
 * with every item inside the box. The fallback has to be a different tree rather than a flag
 * because of the layout: the copies must refuse to shrink for the track to be wider than the box,
 * and refusing to shrink is exactly what stops them wrapping.
 *
 * **Hover and focus stop it, but the button is the part that matters.** Moving content that runs
 * for more than five seconds needs a way to stop it (WCAG 2.2.2), and hover is not a way for
 * anyone without a mouse. So `controls` defaults to true, the button is reachable by keyboard
 * whether or not it is visible, and where there is no hover to reveal it with it is visible from
 * the start. Pass `controls={false}` only when something else on the page stops this.
 *
 * It animates through the Web Animations API rather than CSS keyframes because the distance is a
 * measurement, and keyframes carrying a measured distance would have to be generated per instance —
 * which a registry component cannot do to someone else's stylesheet. The animation is declarative
 * either way, so this is not a `requestAnimationFrame` loop and does not depend on a frame callback
 * firing; what either does in a backgrounded tab is not something this was able to measure.
 *
 * Content is cloned, so a child that holds state or costs something to render is rendered several
 * times over. Logos, names and short text are the intended cargo.
 */
export const Marquee = React.forwardRef<HTMLDivElement, MarqueeProps>(function Marquee(
  {
    children,
    speed = DEFAULT_SPEED,
    direction = "left",
    gap = DEFAULT_GAP,
    pauseOnHover = true,
    pauseOnFocus = true,
    controls = true,
    paused,
    onPausedChange,
    pauseLabel = "Pause",
    resumeLabel = "Resume",
    className,
    style,
    onPointerEnter,
    onPointerLeave,
    onPointerCancel,
    onFocus,
    onBlur,
    ...props
  },
  forwardedRef
) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const spacerRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(forwardedRef, () => viewportRef.current as HTMLDivElement)

  const [geometry, setGeometry] = React.useState<Geometry>(UNMEASURED)
  const [heldInternally, setHeldInternally] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const [focusWithin, setFocusWithin] = React.useState(false)

  const held = paused ?? heldInternally

  /**
   * Reduced motion as state rather than as a read of the media query during render, because it
   * selects between two different trees and the server has no media query to select with — reading
   * it in render would disagree with the HTML being hydrated. A layout effect rather than a passive
   * one, so the swap to the static list lands before the first paint and the clipped row that the
   * animated tree is until it starts is never shown to somebody who asked for less motion.
   */
  const [reduced, setReduced] = React.useState(false)
  useIsomorphicLayoutEffect(() => {
    setReduced(prefersReducedMotion())
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return
    const query = window.matchMedia(REDUCED_MOTION)
    if (typeof query.addEventListener !== "function") return
    const onChange = () => setReduced(query.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  const measure = React.useCallback(() => {
    const viewport = viewportRef.current
    const track = trackRef.current
    if (!viewport || !track) return
    const first = track.children[0]
    const second = track.children[1]
    if (!first || !second) return

    const firstRect = first.getBoundingClientRect()
    // A *difference* between two boxes, never either box's own position. The track is under a
    // transform that is usually mid-travel, so a copy's absolute left is wherever the animation has
    // got to — measured at −109.56 where at rest it was 0 — while the distance between two copies
    // reads the same at rest and mid-animation to four decimals.
    //
    // It is also the only reading that includes the gap without asking anyone what the gap is, and
    // the only one with sub-pixel truth: `offsetLeft` is a rounded integer, and taking the step from
    // `offsetLeft` differences came out 0.5px and 0.4375px wrong in the two layouts measured. That
    // error is a jump at the seam, every loop, for nothing.
    const step = second.getBoundingClientRect().left - firstRect.left
    const copyWidth = firstRect.width
    const copies = marqueeCopyCount({ step, copyWidth, viewportWidth: viewport.clientWidth })
    setGeometry((previous) =>
      previous.step === step && previous.copyWidth === copyWidth && previous.copies === copies
        ? previous
        : { step, copyWidth, copies }
    )
  }, [])

  // `children` is a dependency because new content is a new width, and the observers below only
  // notice that one paint later. Re-measuring on a parent's render costs one forced layout and
  // settles on the same numbers, so it is idempotent rather than free.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useIsomorphicLayoutEffect(measure, [measure, reduced, children])

  React.useEffect(() => {
    if (reduced || typeof ResizeObserver === "undefined") return
    const viewport = viewportRef.current
    const spacer = spacerRef.current
    if (!viewport || !spacer) return

    // The box and one copy's worth of content — between them, everything the copy count depends on.
    // Deliberately *not* the track: the track's width is a function of the count, so an observer on
    // it would be an observer on this component's own last answer. The spacer stands in for the
    // content precisely because it is one copy's worth whatever the count is.
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(spacer)
    return () => observer.disconnect()
  }, [measure, reduced])

  React.useEffect(() => {
    if (reduced) return
    // A face arriving after the first measurement changes the width of every glyph without changing
    // any box, so no observer reports it — the same reason fit-text and overflow-tooltip both wait
    // on this separately.
    let cancelled = false
    const fonts = typeof document !== "undefined" ? document.fonts : undefined
    fonts?.ready.then(() => {
      if (!cancelled) measure()
    })
    return () => {
      cancelled = true
    }
  }, [measure, reduced])

  const stopped = held || (pauseOnHover && hovered) || (pauseOnFocus && focusWithin)

  /** The animation currently on the track, with what it was built from. */
  const liveRef = React.useRef<{
    animation: Animation
    duration: number
    signature: string
  } | null>(null)
  /** Where in its loop the last animation was, as a fraction, so a rebuilt one can resume there. */
  const phaseRef = React.useRef<number | null>(null)
  const stoppedRef = React.useRef(stopped)
  stoppedRef.current = stopped
  /** The stopped-ness the animation on the track was last put into. */
  const appliedRef = React.useRef<boolean | null>(null)

  /** Takes the animation off the track, remembering where in its loop it had got to. */
  const release = React.useCallback(() => {
    const live = liveRef.current
    if (!live) return
    liveRef.current = null
    phaseRef.current = (millis(live.animation.currentTime) % live.duration) / live.duration
    live.animation.cancel()
  }, [])

  React.useEffect(() => {
    const track = trackRef.current
    const { step, copyWidth } = geometry
    // `reduced` is state, and state set in a layout effect does not reach the passive effects of the
    // commit that set it — this one would run once with `reduced` still false and animate for a
    // frame before the next commit cancelled it. The media query has no such lag, so it is asked
    // again here, where the answer decides whether anything moves at all.
    if (!track || reduced || prefersReducedMotion()) return
    if (!(step > 0) || !(copyWidth > 0) || !(speed > 0)) return
    if (typeof track.animate !== "function") return

    // An animation is a function of these three numbers and nothing else, so an effect that runs
    // again with all three unchanged must leave the one already on the track alone: rebuilding it is
    // a restart, and a restart is visible. Stated here rather than left to the dependency array
    // because the array says when this *may* run, not what it is allowed to do when it does.
    const signature = `${direction} ${step} ${speed}`
    if (liveRef.current?.signature === signature) return
    release()

    const duration = (step / speed) * 1000
    const from = direction === "left" ? 0 : -step
    const to = direction === "left" ? -step : 0
    const animation = track.animate(
      [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
      { duration, iterations: Infinity, easing: "linear" }
    )
    // Resumed at the phase the previous animation reached, because a rebuilt animation starts at
    // zero and that is a jump: measured, a fresh animation put the track back at translateX(0) from
    // −134.219, while carrying the fraction across reproduced −134.219 exactly. Everything that
    // changes the distance rebuilds the animation — a resize, a web font, an added logo — and none
    // of those is a moment to snap the band back to the top of its loop.
    if (phaseRef.current !== null) animation.currentTime = phaseRef.current * duration
    // Stopped here rather than left to the effect below, which runs a paint later: a marquee
    // mounting under a pointer that is already over it would otherwise move for one frame.
    if (stoppedRef.current) animation.pause()
    appliedRef.current = stoppedRef.current
    liveRef.current = { animation, duration, signature }

    return release
  }, [geometry, reduced, speed, direction, release])

  React.useEffect(() => {
    const animation = liveRef.current?.animation
    if (!animation) return
    // Only on a change, and a freshly built animation counts as already applied — it was created in
    // the state it was wanted in. Asking a running animation to play again is harmless, but "only
    // when it changes" is the rule being described and it belongs in the component rather than in a
    // dependency array that a test harness is free to ignore.
    if (appliedRef.current === stopped) return
    appliedRef.current = stopped
    // pause() holds the transform where it is and play() carries on from there rather than from the
    // start — measured resuming at 806ms from a pause taken at 700ms — which is the whole reason
    // hover can stop this without losing the reader's place.
    if (stopped) animation.pause()
    else animation.play()
  }, [stopped])

  const toggleHeld = () => {
    const next = !held
    if (paused === undefined) setHeldInternally(next)
    onPausedChange?.(next)
  }

  if (reduced) {
    return (
      // The five handlers are passed back one by one because they were destructured out of `props`
      // for the branch below, where each is wrapped. Leaving them out here would drop a caller's own
      // onFocus or onPointerEnter for exactly the visitors who asked for less motion, which is the
      // kind of hole that no amount of looking at the moving version would show.
      <div
        ref={viewportRef}
        className={cn("overflow-hidden", className)}
        style={style}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerCancel}
        onFocus={onFocus}
        onBlur={onBlur}
        {...props}
      >
        {/*
          One copy, allowed to wrap, and nothing in here refusing to shrink. The animated tree cannot
          be reused with the animation switched off: its copies are `shrink-0`, which is what lets
          the track be wider than the box at all, and a row that will not shrink does not wrap —
          measured, the same six items in a 300px box overflowed it by 233px either way until the
          `shrink-0` came off, at which point they wrapped to three rows with nothing cut.
        */}
        <div className="flex flex-wrap items-center" style={{ gap }}>
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      className={cn("group relative overflow-hidden", className)}
      style={{
        // `clip` rather than `hidden`, because `hidden` makes this a scroll container and a
        // scrolled one is a broken one: the track is positioned against this box, so any scroll
        // offset slides the band sideways and the animation keeps running from the wrong place.
        // Nothing asks it to scroll except the browser itself — measured, tabbing to the last link
        // of the visible copy in a box narrower than that copy scrolled this box to 284 and left it
        // there. `clip` is the same clipping without the scroll container: the same focus left it
        // at 0, and did not scroll the page either. The class above stays as the fallback, since an
        // engine that does not know `clip` drops this declaration and keeps `hidden`.
        overflow: "clip",
        ...style,
      }}
      // Whether anything is moving, for a caller who wants to style the stopped state and for
      // anyone asking the question from the outside. The three ways to stop this — the button, a
      // hovering pointer, focus landing inside — are one state as far as the animation is concerned,
      // and this is that state rather than any one of its causes.
      data-state={stopped ? "paused" : "running"}
      onPointerEnter={(event) => {
        // Touch is left out on purpose. A tap fires pointerenter with no pointer left to leave
        // afterwards, and a band stopped for the rest of a visit because a thumb brushed a logo is
        // worse than one that never stopped. A touch visitor gets the button, which is visible from
        // the start where there is no hover.
        if (event.pointerType !== "touch") setHovered(true)
        onPointerEnter?.(event)
      }}
      onPointerLeave={(event) => {
        setHovered(false)
        onPointerLeave?.(event)
      }}
      onPointerCancel={(event) => {
        setHovered(false)
        onPointerCancel?.(event)
      }}
      onFocus={(event) => {
        setFocusWithin(true)
        onFocus?.(event)
      }}
      onBlur={(event) => {
        setFocusWithin(false)
        onBlur?.(event)
      }}
      {...props}
    >
      {/*
        Sizing, and nothing else: out of sight, out of the accessibility tree, and inert so its copy
        of any link is not a tab stop.

        It is here because the track cannot be allowed to size this box. The track is as wide as the
        copy count, so a box taking its width from its content gets wider every time the count goes
        up, and a wider box needs a higher count — measured inside an `inline-flex` parent, that ran
        210px → 444px → 912px → 1848px as the count doubled, with nothing to stop it. With the track
        out of flow and one copy's worth of content in flow, the width came out identical at 1, 2, 4,
        8 and 16 copies in all four parent layouts tried.

        The height is the same bargain from the other side: an absolutely positioned track leaves
        none, and taking the height from a measurement would mean the box is the wrong height until
        JavaScript has run. This way it is right in the server's HTML. `w-max` rather than the
        default is load-bearing for that — a spacer narrow enough to squeeze its items reported 60px
        of height where the copies were 24px, because squeezed items wrap and wrapped items are
        taller.
      */}
      <div
        ref={spacerRef}
        className="invisible flex w-max items-center"
        aria-hidden="true"
        inert
        style={{ gap }}
      >
        {children}
      </div>
      <div
        ref={trackRef}
        className="absolute inset-y-0 left-0 flex w-max items-center"
        style={{
          gap,
          // Where the animation will hold it, applied for the frame between measuring the distance
          // and starting the animation that uses it. Travelling rightwards starts a step to the
          // left, so without this the track sits at 0 for a frame and then jumps. An animation wins
          // over an inline transform — measured, −456 against the −912 written here — so this is
          // only ever the resting position.
          transform:
            direction === "right" && geometry.step > 0
              ? `translateX(${-geometry.step}px)`
              : undefined,
        }}
      >
        {Array.from({ length: geometry.copies }, (_, index) => (
          <div
            key={index}
            // shrink-0 is what makes the seam possible: each copy keeps its own width inside a track
            // wider than the box, rather than being squeezed to fit it.
            className="flex shrink-0 items-center"
            aria-hidden={index === 0 ? undefined : "true"}
            inert={index === 0 ? undefined : true}
            style={{ gap }}
          >
            {children}
          </div>
        ))}
      </div>
      {controls ? (
        <button
          type="button"
          onClick={toggleHeld}
          aria-label={held ? resumeLabel : pauseLabel}
          // Out of the way until it is wanted, but never out of reach: keyboard focus reveals it,
          // and on a device with no hover to reveal it with it is visible from the start. It is the
          // only way to stop this without a pointer, so it cannot be the hover-only affordance that
          // code-block's copy button can afford to be.
          className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-input bg-background/80 text-foreground opacity-0 backdrop-blur-sm transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {held ? (
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </div>
  )
})
