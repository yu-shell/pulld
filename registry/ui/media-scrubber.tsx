"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Seconds moved by one arrow key press.
 *
 * Five is the step every player with a keyboard path has converged on, and it is not arbitrary: a
 * one-second step makes a keyboard user press an arrow ninety times to cross a short podcast, and a
 * ten-second step cannot land on a word.
 */
export const DEFAULT_SEEK_STEP = 5

/** Seconds moved by Page Up / Page Down. */
export const DEFAULT_SEEK_STEP_LARGE = 30

/**
 * How many positions across the track the playhead is allowed to stop at while playing.
 *
 * This is the render budget, and it exists because of where the position comes from. The element
 * announces progress through `timeupdate`, which the spec pins at no more often than every 250ms,
 * so a bar driven by that event alone advances four times a second and visibly stutters. The fix is
 * to read `currentTime` on every animation frame instead — but committing that to React state sixty
 * times a second re-renders the component for motion finer than a pixel.
 *
 * So the frame loop reads continuously and commits only when the playhead would land on a different
 * one of these positions. 1000 is finer than the pixel width of any track this is drawn at, so the
 * motion is smooth at the cost of at most a thousand renders across the whole clip, whatever its
 * length. Note that it bounds renders *per clip*, not per second: a three-second clip and a
 * three-hour one each cost a thousand.
 */
export const DEFAULT_TIME_STEPS = 1000

/** The shape of one entry in a `TimeRanges`, as a plain object. */
export interface TimeRange {
  readonly start: number
  readonly end: number
}

/**
 * Whether a duration can be used as the denominator of a position.
 *
 * Every arithmetic path in this file is guarded by this rather than by a range check, because the
 * two values a media element actually reports when it does not know the length are the two that
 * survive range checks and then poison everything downstream:
 *
 *   - `NaN` before metadata has loaded, which is what `duration` reads on first paint — measured on
 *     Chromium at `readyState` 0. `NaN` compares false against every bound, so `if (d > 0)` and
 *     `if (d < max)` both decline to catch it, and `time / NaN` is `NaN`.
 *   - `Infinity` for a live stream, and for any file whose header was written before its length was
 *     known. That is not an edge case here: a clip from `MediaRecorder` reports `Infinity` for its
 *     whole life (see `audio-recorder` in this registry, which prints the duration it measured
 *     while recording precisely because the file cannot answer). `time / Infinity` is 0, so a
 *     position bar silently pins to the left edge instead of failing.
 *
 * What makes this worth a guard of its own rather than a clamp is the measured behaviour of the
 * setter. Assigning a finite out-of-range time is *clamped* by the element — on a 3s clip,
 * `currentTime = 999` reads back as 3 and `currentTime = -5` reads back as 0 — but assigning `NaN`
 * or `Infinity` **throws `TypeError`** ("the provided double value is non-finite"). So the element
 * forgives the mistake a range check catches and refuses the one it misses, and a handler that
 * computes `pointerX / width * duration` before metadata arrives throws out of the event rather
 * than seeking to the wrong place. See {@link seekMedia}.
 */
export function isSeekableDuration(duration: number | null | undefined): duration is number {
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0
}

/**
 * Whether a media element reports an unbounded length — live, or a file with no length in its
 * header.
 *
 * Kept apart from "not seekable yet" because the two want opposite treatment in the UI: metadata
 * that has not arrived is a position that is about to exist, and an unbounded duration is a
 * position that never will.
 */
export function isLiveDuration(duration: number | null | undefined): boolean {
  return duration === Number.POSITIVE_INFINITY
}

/**
 * `time` brought inside `[0, duration]`.
 *
 * Guarantees a finite result for any input, which is what the pointer and keyboard paths rely on:
 * everything they compute passes through here before it reaches the element, and the element throws
 * on a non-finite assignment (see {@link isSeekableDuration}). `-Infinity` lands on 0 and
 * `+Infinity` on the duration, as a clamp should; `NaN` has no position on the line at all, so it
 * answers 0 — the one arbitrary choice here, and the safe direction, since a seek to the start is
 * recoverable and a throw out of an event handler is not.
 *
 * An unusable duration leaves the upper bound unknown rather than zero, so a finite time passes
 * through: clamping to 0 here would send a playing clip back to the start every time the duration
 * was momentarily unreadable.
 */
export function clampTime(time: number, duration: number): number {
  if (Number.isNaN(time)) return 0
  if (time <= 0) return 0
  if (!isSeekableDuration(duration)) return Number.isFinite(time) ? time : 0
  return time > duration ? duration : time
}

/**
 * A `TimeRanges` copied into a plain array.
 *
 * The copy is the point. `TimeRanges` is not a collection in any sense JavaScript recognises —
 * measured on Chromium, `buffered` is `[object TimeRanges]` with `Array.isArray` false, `.map`
 * `undefined`, **no `Symbol.iterator`**, and no index properties (`buffered[0]` is `undefined`).
 * So all three obvious ways to read it are wrong, and the quietest one is the one most likely to be
 * written:
 *
 *   - `[...buffered]` throws `TypeError: buffered is not iterable`, which at least says so.
 *   - `buffered.map(...)` throws too.
 *   - `Array.from(buffered)` **succeeds and lies**. It reads the `length` and finds no indices, so
 *     a buffer holding one range comes back as `[undefined]` — an array of the right length, full
 *     of nothing. A `.length` check on it passes, so the code believes it has the ranges, and the
 *     failure surfaces later and elsewhere as "cannot read properties of undefined (reading 'end')".
 *
 * The only working access is `length` with `start(i)` / `end(i)`, which is what this does once so
 * that nothing else in the file has to.
 *
 * Ranges carrying a non-finite bound are dropped rather than passed on, so the arithmetic in
 * {@link bufferedEndAt} cannot be handed a `NaN` edge from a source this file does not control.
 */
export function readTimeRanges(ranges: TimeRanges | null | undefined): TimeRange[] {
  if (!ranges) return []
  const out: TimeRange[] = []
  // `length` is re-read on each pass on purpose: the buffer is written by the network, so a range
  // can disappear between the first index and the last, and a cached count would index past the end
  // and throw `IndexSizeError`.
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i)
    const end = ranges.end(i)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    out.push({ start, end })
  }
  return out
}

/**
 * How far the media is continuously buffered forward from `time`.
 *
 * Returns `time` itself when nothing covers it, so the caller can draw `bufferedEndAt - time` as a
 * width without a special case for "not buffered".
 *
 * The reason this is a search rather than `ranges[ranges.length - 1].end` is that `buffered` holds
 * a *set* of ranges, and the set grows holes as soon as anyone skips ahead: play ten seconds, jump
 * to the middle, and the buffer is `[0, 12]` and `[64, 71]` with nothing in between. Reading the
 * last end then reports 71 seconds buffered while the playhead sits at 3 with a gap in front of it,
 * and the bar promises a clip that will in fact stall — the one thing a buffer indicator exists to
 * warn about. Only the range that *contains* the playhead says anything true about what can be
 * played without waiting.
 */
export function bufferedEndAt(ranges: readonly TimeRange[], time: number): number {
  if (!Number.isFinite(time)) return 0
  for (const range of ranges) {
    // The playhead sitting exactly on a boundary counts as inside: `end` is exclusive to the
    // network but a position on it is covered, and treating it as outside makes the buffered bar
    // flicker to zero once per range as playback crosses the seam.
    if (time >= range.start && time <= range.end) return range.end
  }
  return time
}

/**
 * Whether two range lists describe the same ranges.
 *
 * Needed because {@link readTimeRanges} necessarily builds a new array every time it is called, and
 * the event that calls it is `progress` — which fires repeatedly all the way through a download,
 * mostly to report that the same ranges now hold a few more bytes. Storing the new array
 * unconditionally re-renders the component several times a second for a bar that has not moved, and
 * a scrubber is on screen for the whole length of the media.
 */
export function sameRanges(a: readonly TimeRange[], b: readonly TimeRange[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].start !== b[i].start || a[i].end !== b[i].end) return false
  }
  return true
}

/**
 * Whether a non-empty `seekable` describes anything a seek could land in.
 *
 * Only meaningful when the element has reported ranges at all: `seekable` is measured as `length` 0
 * both before metadata loads and for a live stream with no DVR window, so emptiness says "no answer
 * yet" and "nothing is seekable" in the same breath and cannot distinguish them. Callers decide
 * what an empty list means (see `interactive` in {@link useMediaScrubber}); this answers only the
 * case where there is a list to read.
 */
export function canSeekRanges(ranges: readonly TimeRange[]): boolean {
  return ranges.some((range) => range.end > range.start)
}

/** `time` as a 0–1 position along a track of `duration`, or 0 when there is no usable duration. */
export function fractionOfDuration(time: number, duration: number): number {
  if (!isSeekableDuration(duration) || !Number.isFinite(time)) return 0
  if (time <= 0) return 0
  return time >= duration ? 1 : time / duration
}

/** Whether `node` is laid out right-to-left, which flips both the track and the arrow keys. */
export function isRtlElement(node: Element | null | undefined): boolean {
  if (!node || typeof getComputedStyle !== "function") return false
  return getComputedStyle(node).direction === "rtl"
}

export interface PointerTimeOptions {
  /** The pointer's viewport x, straight off the event. */
  clientX: number
  /** The track's box, from `getBoundingClientRect()`. */
  rect: { left: number; width: number }
  duration: number
  /** Whether the track runs right-to-left. */
  rtl?: boolean
}

/**
 * The time under the pointer.
 *
 * Answers 0 for a zero-width track rather than `NaN` from the division — a track measured before it
 * has been laid out is the ordinary first-render state, not a bug, and `NaN` from here would reach
 * the element's setter and throw (see {@link isSeekableDuration}).
 */
export function timeFromPointer({ clientX, rect, duration, rtl = false }: PointerTimeOptions): number {
  if (!isSeekableDuration(duration) || !(rect.width > 0)) return 0
  const offset = clientX - rect.left
  const ratio = rtl ? 1 - offset / rect.width : offset / rect.width
  return clampTime(ratio * duration, duration)
}

export interface KeyboardSeekOptions {
  key: string
  currentTime: number
  duration: number
  step?: number
  largeStep?: number
  /** Whether the track runs right-to-left, which swaps the two horizontal arrows. */
  rtl?: boolean
}

/**
 * The time a key press should move to, or `null` when the key is not one this handles.
 *
 * `null` rather than the unchanged time is what lets the caller decide whether to call
 * `preventDefault`: swallowing every key press on a focused slider takes Tab and Escape with it.
 *
 * Up and Down are bound alongside Left and Right because `role="slider"` is a one-dimensional
 * widget whichever way it is drawn, and a user who reaches for Up on a horizontal bar is not making
 * a mistake. They are *not* flipped under RTL — vertical keys have no writing direction, and
 * mirroring them is a bug that only shows up for the users least able to work around it.
 */
export function keyboardSeekTarget({
  key,
  currentTime,
  duration,
  step = DEFAULT_SEEK_STEP,
  largeStep = DEFAULT_SEEK_STEP_LARGE,
  rtl = false,
}: KeyboardSeekOptions): number | null {
  if (!isSeekableDuration(duration)) return null
  const base = Number.isFinite(currentTime) ? currentTime : 0
  const back = rtl ? "ArrowRight" : "ArrowLeft"
  const forward = rtl ? "ArrowLeft" : "ArrowRight"

  switch (key) {
    case back:
    case "ArrowDown":
      return clampTime(base - step, duration)
    case forward:
    case "ArrowUp":
      return clampTime(base + step, duration)
    case "PageDown":
      return clampTime(base - largeStep, duration)
    case "PageUp":
      return clampTime(base + largeStep, duration)
    case "Home":
      return 0
    case "End":
      return duration
    default:
      return null
  }
}

/**
 * Whether a new reading is far enough from the committed one to be worth a render.
 *
 * `steps` is the number of distinct positions the track has; see {@link DEFAULT_TIME_STEPS}. The
 * two ends are always committed even when they round to the same step as the previous reading,
 * because "finished" and "all but finished" are different states to anything reading the label —
 * and `ended` is the one a player's UI usually branches on.
 */
export function shouldCommitTime(
  previous: number,
  next: number,
  duration: number,
  steps: number = DEFAULT_TIME_STEPS
): boolean {
  if (!Number.isFinite(next)) return false
  if (!Number.isFinite(previous)) return true
  if (next === previous) return false
  if (!isSeekableDuration(duration) || !(steps > 0)) return true
  if (next <= 0 || next >= duration) return true
  return Math.round((previous / duration) * steps) !== Math.round((next / duration) * steps)
}

/**
 * Sets `media.currentTime`, and says whether it went through.
 *
 * The finiteness check is the whole function. Assigning a non-finite time throws `TypeError` out of
 * the setter (measured), and the call sites are pointer and key handlers, so the throw does not
 * surface as a failed seek — it unwinds the handler, which means the `pointerup` that would have
 * ended the drag never finishes and the scrubber is left stuck to the pointer. Guarding here rather
 * than at each call site keeps that from being re-litigated per handler.
 *
 * Out-of-range finite times are passed through deliberately: the element clamps them itself, and
 * clamping twice would mean this file carries a second opinion about the duration.
 */
export function seekMedia(
  media: Pick<HTMLMediaElement, "currentTime"> | null | undefined,
  time: number
): boolean {
  if (!media || !Number.isFinite(time)) return false
  media.currentTime = time
  return true
}

/**
 * `seconds` as a clock reading: `0:07`, `1:12`, `1:02:03`.
 *
 * Non-finite input gives the placeholder rather than `NaN:NaN`, which is the state the component is
 * in on its first paint every single time.
 *
 * Seconds are floored, not rounded, so the reading never shows a time the media has not reached —
 * a clip ending at `0:59.6` that displays `1:00` beside a bar that has not filled looks broken, and
 * rounding up past a `duration` label is worse.
 */
export function formatTimecode(
  seconds: number,
  { placeholder = "--:--", forceHours = false }: { placeholder?: string; forceHours?: boolean } = {}
): string {
  if (!Number.isFinite(seconds)) return placeholder
  const total = Math.floor(Math.max(0, seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return hours > 0 || forceHours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

/**
 * `seconds` as words: `1 minute 12 seconds`.
 *
 * This is what `aria-valuetext` carries, and it is the reason a scrubber needs more than
 * `aria-valuenow`. A slider with no `valuetext` is announced as its number — "72" — and for a
 * position in a clip that is not merely terse but ambiguous: 72 of what? Percent, seconds, minutes
 * and "72nd of 180 steps" are all plausible readings of the same announcement, and the user cannot
 * tell which. Spelling out the unit is the only way the control says where it is.
 *
 * Units are written out rather than punctuated because a screen reader reads `1:02:03` as "one
 * oh two oh three" or "one colon zero two" depending on which one it is and what language it thinks
 * it is in. Zero-valued leading units are dropped — "0 hours 1 minute" is noise — but a zero
 * position still has to say something, so it reads "0 seconds".
 */
export function spokenTimecode(
  seconds: number,
  { placeholder = "unknown" }: { placeholder?: string } = {}
): string {
  if (!Number.isFinite(seconds)) return placeholder
  const total = Math.floor(Math.max(0, seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const parts: string[] = []
  const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`
  if (hours > 0) parts.push(unit(hours, "hour"))
  if (minutes > 0 || hours > 0) parts.push(unit(minutes, "minute"))
  parts.push(unit(secs, "second"))
  return parts.join(" ")
}

export interface MediaScrubberLabels {
  /** The slider's accessible name. */
  slider: string
  /** Builds the `aria-valuetext`, given both sides already spoken. */
  position: (spokenPosition: string, spokenDuration: string | null) => string
  /** Announced in place of a position while the length is unknown. */
  live: string
}

export const defaultMediaScrubberLabels: MediaScrubberLabels = {
  slider: "Seek",
  position: (position, duration) => (duration ? `${position} of ${duration}` : position),
  live: "Live",
}

export interface UseMediaScrubberOptions {
  /**
   * A length to use instead of the element's own.
   *
   * For the `Infinity` case that is not live: a recording from `MediaRecorder` never learns its own
   * length, but whoever recorded it measured one. Without this the scrubber for a voice note is
   * permanently inert, which is the state `audio-recorder` in this registry works around by
   * printing its measured duration beside a native control it cannot fix.
   */
  duration?: number
  /** Seconds per arrow key. Defaults to {@link DEFAULT_SEEK_STEP}. */
  step?: number
  /** Seconds per Page Up / Page Down. Defaults to {@link DEFAULT_SEEK_STEP_LARGE}. */
  largeStep?: number
  /**
   * Whether dragging seeks continuously or only on release. Defaults to `"live"`.
   *
   * `"release"` is for video over a slow network, where every intermediate seek is a keyframe fetch
   * the user never sees.
   */
  scrub?: "live" | "release"
  /**
   * Whether to read the position on every animation frame while playing. Defaults to `true`.
   *
   * Turning it off leaves the bar on `timeupdate` alone, which is correct but steps four times a
   * second. See {@link DEFAULT_TIME_STEPS}.
   */
  smooth?: boolean
  /** Positions across the track worth a render. Defaults to {@link DEFAULT_TIME_STEPS}. */
  timeSteps?: number
  /** Overrides for the announced strings. */
  labels?: Partial<MediaScrubberLabels>
  /** Called with the committed time whenever a seek is issued from this control. */
  onSeek?: (time: number) => void
}

export interface MediaScrubberState {
  /** The element's own position, ignoring any drag in progress. */
  currentTime: number
  /** What the control should display: the dragged position while dragging, else {@link currentTime}. */
  displayTime: number
  /** The effective length — the `duration` option when given, else the element's. */
  duration: number
  /** Whether {@link duration} can be used as a denominator. */
  hasDuration: boolean
  /** Whether the element reports an unbounded length and no override was given. */
  live: boolean
  buffered: TimeRange[]
  seekable: TimeRange[]
  paused: boolean
  ended: boolean
  /** Whether the element is working on a seek of its own. */
  seeking: boolean
  /** Whether a pointer is currently dragging this control. */
  dragging: boolean
  /** 0–1 position of {@link displayTime}. */
  progress: number
  /** 0–1 position of the end of the buffer continuous with {@link displayTime}. */
  bufferedProgress: number
  /** Whether this control can issue a seek at all. */
  interactive: boolean
}

export interface UseMediaScrubberResult extends MediaScrubberState {
  /** Props for the element carrying `role="slider"`. Spread onto the track. */
  sliderProps: MediaScrubberSliderProps
  /** Attach to the track element so the pointer handlers can measure it. */
  trackRef: React.RefObject<HTMLDivElement | null>
  /** Seek the element, with the finiteness guard. */
  seek: (time: number) => void
  labels: MediaScrubberLabels
}

export interface MediaScrubberSliderProps {
  role: "slider"
  tabIndex: number
  "aria-label": string
  "aria-orientation": "horizontal"
  "aria-valuemin": number | undefined
  "aria-valuemax": number | undefined
  "aria-valuenow": number | undefined
  "aria-valuetext": string
  "aria-disabled": boolean | undefined
  onPointerDown: React.PointerEventHandler<HTMLElement>
  onPointerMove: React.PointerEventHandler<HTMLElement>
  onPointerUp: React.PointerEventHandler<HTMLElement>
  onPointerCancel: React.PointerEventHandler<HTMLElement>
  onKeyDown: React.KeyboardEventHandler<HTMLElement>
}

const NO_RANGES: TimeRange[] = []

/**
 * Tracks a media element's position and turns a track element into a seek control.
 *
 * The element stays the caller's: this subscribes to one they already have, rather than rendering
 * an `<audio>` or `<video>` of its own. A scrubber that owns the media element is a player, and a
 * player is the wrong unit — it decides the transport controls, the layout and the sources, none of
 * which a position bar has an opinion about.
 *
 * ### The two states, and why there are two
 *
 * While a drag is in progress the displayed position comes from the pointer, not from the element.
 * This is the one piece of state in the file that duplicates something the platform already knows,
 * and it is not an optimisation. Seeking is asynchronous: the element accepts `currentTime`, starts
 * work, and keeps reporting the *old* position until the seek completes. Render straight from
 * `currentTime` during a drag and every frame paints a thumb slightly behind the finger, which then
 * snaps forward — so the thumb lags, wobbles, and crawls out from under the pointer on a slow
 * source. The pointer is the truth about where the user is pointing; the element is the truth about
 * what is playing. They are only the same thing once the drag ends, and that is when this hands the
 * position back.
 *
 * What it deliberately does *not* do is run its own clock. The frame loop re-reads
 * `media.currentTime` every time; it never adds elapsed milliseconds to a previous reading. An
 * accumulated clock drifts against the audio immediately (the two are driven by different hardware)
 * and diverges without bound in a throttled background tab.
 */
export function useMediaScrubber(
  mediaRef: React.RefObject<HTMLMediaElement | null>,
  {
    duration: durationOverride,
    step = DEFAULT_SEEK_STEP,
    largeStep = DEFAULT_SEEK_STEP_LARGE,
    scrub = "live",
    smooth = true,
    timeSteps = DEFAULT_TIME_STEPS,
    labels: labelOverrides,
    onSeek,
  }: UseMediaScrubberOptions = {}
): UseMediaScrubberResult {
  const trackRef = React.useRef<HTMLDivElement | null>(null)

  const [currentTime, setCurrentTime] = React.useState(0)
  const [elementDuration, setElementDuration] = React.useState(Number.NaN)
  const [buffered, setBuffered] = React.useState<TimeRange[]>(NO_RANGES)
  const [seekable, setSeekable] = React.useState<TimeRange[]>(NO_RANGES)
  const [paused, setPaused] = React.useState(true)
  const [ended, setEnded] = React.useState(false)
  const [seeking, setSeeking] = React.useState(false)
  const [dragTime, setDragTime] = React.useState<number | null>(null)

  // The pointer that owns the drag. Everything else is ignored: a second finger landing on the
  // track, or the first one being released, must not move or end a drag it did not start.
  const dragPointer = React.useRef<number | null>(null)

  const duration = isSeekableDuration(durationOverride) ? durationOverride : elementDuration
  const hasDuration = isSeekableDuration(duration)
  const live = !hasDuration && isLiveDuration(elementDuration)
  const dragging = dragTime !== null
  const displayTime = dragging ? dragTime : currentTime
  // A usable length is the floor; `seekable` can only take that away, and only when it has
  // something to say. An empty `seekable` is not evidence of anything (see {@link canSeekRanges}) —
  // and it is the reading for a `MediaRecorder` clip, which is exactly the case the `duration`
  // override exists to rescue, so treating empty as "cannot seek" would disable the one control
  // that override was added for.
  const interactive = hasDuration && (seekable.length === 0 || canSeekRanges(seekable))

  const onSeekRef = React.useRef(onSeek)
  React.useEffect(() => {
    onSeekRef.current = onSeek
  }, [onSeek])

  const seek = React.useCallback(
    (time: number) => {
      if (seekMedia(mediaRef.current, time)) onSeekRef.current?.(time)
    },
    [mediaRef]
  )

  // One subscription for everything the element reports. Each event is here because it is the only
  // one that fires for a state this control draws:
  //   - `durationchange` is the only notice that `NaN` became a number, and it fires again when a
  //     stream's length is revised. `loadedmetadata` alone misses the revision.
  //   - `progress` is the buffer growing. `timeupdate` does not imply it and vice versa: a paused
  //     element downloads without advancing, and a fully buffered one advances without downloading.
  //   - `seeking`/`seeked` bracket the element's own work, including seeks from somewhere else
  //     entirely (a transport button, a chapter link, the keyboard on a native control).
  //   - `emptied` is the source being torn down or replaced, after which every reading is stale and
  //     the duration is `NaN` again. Without it a scrubber keeps showing the last clip's length.
  React.useEffect(() => {
    const media = mediaRef.current
    if (!media) return

    const readTime = () => setCurrentTime(media.currentTime)
    const readDuration = () => setElementDuration(media.duration)
    // Both go through the identity bail-out, so an unchanged buffer costs no render. See
    // {@link sameRanges} — `progress` alone fires often enough for this to matter.
    const keepSame = (next: TimeRange[]) => (previous: TimeRange[]) =>
      sameRanges(previous, next) ? previous : next
    const readBuffered = () => setBuffered(keepSame(readTimeRanges(media.buffered)))
    const readSeekable = () => setSeekable(keepSame(readTimeRanges(media.seekable)))
    const readPlayback = () => {
      setPaused(media.paused)
      setEnded(media.ended)
    }

    const syncAll = () => {
      readTime()
      readDuration()
      readBuffered()
      readSeekable()
      readPlayback()
    }

    // The element may already be loaded and playing when this mounts — a remount, a tab coming
    // back, or simply a scrubber added beside a running player. Reading once up front is what makes
    // the first paint show the real position instead of zero.
    syncAll()

    const onSeekingStart = () => {
      setSeeking(true)
      readTime()
    }
    const onSeeked = () => {
      setSeeking(false)
      readTime()
      readBuffered()
    }
    const onEmptied = () => {
      setCurrentTime(0)
      setElementDuration(Number.NaN)
      setBuffered(keepSame(NO_RANGES))
      setSeekable(keepSame(NO_RANGES))
      setSeeking(false)
      readPlayback()
    }

    const listeners: Array<[string, EventListener]> = [
      ["timeupdate", readTime],
      ["durationchange", readDuration],
      ["loadedmetadata", syncAll],
      ["progress", readBuffered],
      ["seeking", onSeekingStart],
      ["seeked", onSeeked],
      ["play", readPlayback],
      ["playing", readPlayback],
      ["pause", readPlayback],
      ["ended", readPlayback],
      ["emptied", onEmptied],
    ]
    for (const [type, listener] of listeners) media.addEventListener(type, listener)
    return () => {
      for (const [type, listener] of listeners) media.removeEventListener(type, listener)
    }
  }, [mediaRef])

  // The frame loop. Runs only while the element is actually advancing, so a paused player costs
  // nothing, and stops while dragging because the displayed position belongs to the pointer then —
  // committing readings underneath a drag is exactly the fight described on the hook.
  React.useEffect(() => {
    if (!smooth || paused || ended || dragging) return
    if (typeof requestAnimationFrame !== "function") return
    const media = mediaRef.current
    if (!media) return

    let frame = requestAnimationFrame(function tick() {
      setCurrentTime((previous) =>
        shouldCommitTime(previous, media.currentTime, duration, timeSteps) ? media.currentTime : previous
      )
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [smooth, paused, ended, dragging, duration, timeSteps, mediaRef])

  // `null` for "there is no measurement", kept distinct from the time 0 that a measurement of a
  // zero-width track legitimately produces. The caller has to be able to tell them apart: seeking
  // to 0 because the track has not been laid out yet would send a half-played clip back to the
  // start on the first press.
  const timeAtPointer = React.useCallback(
    (clientX: number): number | null => {
      const track = trackRef.current
      // Optional call rather than a plain one: a track rendered on the server, or under a test
      // renderer with no layout, has no `getBoundingClientRect` to call at all.
      const rect = track?.getBoundingClientRect?.()
      if (!rect || !(rect.width > 0)) return null
      return timeFromPointer({
        clientX,
        rect: { left: rect.left, width: rect.width },
        duration,
        rtl: isRtlElement(track),
      })
    },
    [duration]
  )

  const onPointerDown = React.useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      // Primary button only. A right-click opening a context menu must not start a drag that then
      // has no release to end it, and a middle-click must not seek.
      if (!interactive || event.button !== 0) return
      const time = timeAtPointer(event.clientX)
      if (time === null) return
      dragPointer.current = event.pointerId
      setDragTime(time)
      // Capture, so a drag that leaves the track — which it will, because the gesture is a flick
      // along a bar a few pixels tall — keeps delivering here instead of to whatever is underneath.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      // The track takes focus on press so the keyboard path continues from where the pointer left
      // off. Without it, a user who drags and then reaches for an arrow key moves the page instead.
      event.currentTarget.focus?.()
      if (scrub === "live") seek(time)
    },
    [interactive, timeAtPointer, scrub, seek]
  )

  const onPointerMove = React.useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => {
      if (dragPointer.current !== event.pointerId) return
      const time = timeAtPointer(event.clientX)
      if (time === null) return
      setDragTime(time)
      if (scrub === "live") seek(time)
    },
    [timeAtPointer, scrub, seek]
  )

  const endDrag = React.useCallback(
    (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
      if (dragPointer.current !== event.pointerId) return
      dragPointer.current = null
      // The release event's own coordinate, not the last `pointermove`'s. Moves are coalesced, so
      // the final one before release is routinely dropped — committing it lands the seek a few
      // pixels behind where the user let go, which on an hour-long recording is seconds.
      //
      // An unmeasurable track skips the commit but never the teardown below: returning early here
      // is what leaves a drag that can only be ended by reloading the page.
      const time = commit ? timeAtPointer(event.clientX) : null
      if (time !== null) seek(time)
      event.currentTarget.releasePointerCapture?.(event.pointerId)
      // Cleared last. The element needs a frame to report the new position, and dropping the drag
      // value before then paints one frame of the old position — a visible snap backwards at the
      // end of every drag.
      setDragTime(null)
    },
    [seek, timeAtPointer]
  )

  const onPointerUp = React.useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => endDrag(event, true),
    [endDrag]
  )

  // Cancel is not a release: the gesture was taken over by the browser (a scroll, a back-swipe, the
  // page being hidden). Committing a position the user never chose is the wrong answer, so the drag
  // is abandoned and the element keeps whatever it had.
  const onPointerCancel = React.useCallback<React.PointerEventHandler<HTMLElement>>(
    (event) => endDrag(event, false),
    [endDrag]
  )

  const onKeyDown = React.useCallback<React.KeyboardEventHandler<HTMLElement>>(
    (event) => {
      if (!interactive) return
      const target = keyboardSeekTarget({
        key: event.key,
        currentTime: displayTime,
        duration,
        step,
        largeStep,
        rtl: isRtlElement(event.currentTarget),
      })
      if (target === null) return
      // Only for keys that were handled — Arrow and Page keys scroll the page, Home and End jump it,
      // and all of them must stop here. Tab and Escape must not.
      event.preventDefault()
      seek(target)
    },
    [interactive, displayTime, duration, step, largeStep, seek]
  )

  const labels = React.useMemo(
    () => ({ ...defaultMediaScrubberLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const progress = fractionOfDuration(displayTime, duration)
  const bufferedProgress = Math.max(
    progress,
    fractionOfDuration(bufferedEndAt(buffered, displayTime), duration)
  )

  const sliderProps: MediaScrubberSliderProps = {
    role: "slider",
    // Focusable even when it cannot be used, so a keyboard user can reach it and hear why. A control
    // that vanishes from the tab order while a clip loads is a control that moves under the user.
    tabIndex: 0,
    "aria-label": labels.slider,
    "aria-orientation": "horizontal",
    // All three value attributes are withheld together while the length is unknown, because they
    // only mean anything as a set. A `slider` with no `aria-valuemax` is defined to have one of 100,
    // so publishing `valuenow="0"` on its own states that playback is at 0% — a precise, confident
    // claim about a position nobody knows yet. An `aria-disabled` slider carrying no value says the
    // true thing instead, and `aria-valuetext` still carries the reason in words.
    "aria-valuemin": hasDuration ? 0 : undefined,
    "aria-valuemax": hasDuration ? duration : undefined,
    "aria-valuenow": hasDuration ? displayTime : undefined,
    "aria-valuetext": hasDuration
      ? labels.position(spokenTimecode(displayTime), spokenTimecode(duration))
      : live
        ? labels.live
        : labels.position(spokenTimecode(Number.NaN), null),
    "aria-disabled": interactive ? undefined : true,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onKeyDown,
  }

  return {
    currentTime,
    displayTime,
    duration,
    hasDuration,
    live,
    buffered,
    seekable,
    paused,
    ended,
    seeking,
    dragging,
    progress,
    bufferedProgress,
    interactive,
    sliderProps,
    trackRef,
    seek,
    labels,
  }
}

export interface MediaScrubberProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children">,
    UseMediaScrubberOptions {
  /** The media element to follow and seek. */
  mediaRef: React.RefObject<HTMLMediaElement | null>
  /** Whether to show the elapsed and total readings under the bar. Defaults to `true`. */
  withTimes?: boolean
}

/**
 * A playback position bar for a media element the caller owns.
 *
 * ```tsx
 * const audio = React.useRef<HTMLAudioElement>(null)
 * return (
 *   <>
 *     <audio ref={audio} src={src} />
 *     <MediaScrubber mediaRef={audio} />
 *   </>
 * )
 * ```
 *
 * For any layout other than this one, call {@link useMediaScrubber} directly and spread its
 * `sliderProps` onto whatever draws the track — the hook is the whole behaviour, and this component
 * is one arrangement of it.
 */
export function MediaScrubber({
  mediaRef,
  duration: durationOverride,
  step,
  largeStep,
  scrub,
  smooth,
  timeSteps,
  labels: labelOverrides,
  onSeek,
  withTimes = true,
  className,
  ...props
}: MediaScrubberProps) {
  const {
    sliderProps,
    trackRef,
    progress,
    bufferedProgress,
    displayTime,
    duration,
    hasDuration,
    live,
    dragging,
    labels,
  } = useMediaScrubber(mediaRef, {
    duration: durationOverride,
    step,
    largeStep,
    scrub,
    smooth,
    timeSteps,
    labels: labelOverrides,
    onSeek,
  })

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
      <div
        {...sliderProps}
        ref={trackRef}
        className={cn(
          // `touch-none` is what makes a drag along the bar a drag and not a page scroll: without
          // it the browser claims the gesture and fires `pointercancel`, so the scrubber works with
          // a mouse and does nothing at all on a phone.
          "group relative h-6 w-full touch-none select-none",
          "focus-visible:outline-none",
          sliderProps["aria-disabled"] ? "cursor-default" : "cursor-pointer"
        )}
      >
        {/* The visible bar is inset inside a 24px-tall box: the pointer target has to be big enough
            to hit, and a 4px bar is not. Hit area and drawn height are deliberately different.

            The focus ring is drawn here rather than on the thumb. The thumb is the prettier place
            for it, but it is hidden whenever there is no position to point at — and that is exactly
            the state the track is still deliberately focusable in, so a keyboard user tabbing onto
            an unloaded clip would land on a control with no visible focus at all. The bar is the
            one part that is always drawn. */}
        <div
          className={cn(
            "absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-secondary",
            "ring-ring ring-offset-2 ring-offset-background group-focus-visible:ring-2"
          )}
        >
          <div
            className="absolute inset-y-0 left-0 bg-muted-foreground/40 transition-[width] duration-200 ease-out"
            style={{ width: `${bufferedProgress * 100}%` }}
          />
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full bg-primary",
              // Only the untouched bar animates its width. During a drag the width *is* the pointer
              // position, and a transition on it adds a lag the user reads as the control sticking.
              !dragging && "transition-[width] duration-100 ease-out"
            )}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background bg-primary shadow-sm",
            "transition-[opacity,scale]",
            dragging ? "scale-110" : "scale-100",
            // Hidden until there is a position to point at, so an unloaded clip shows a plain bar
            // instead of a thumb parked at zero that cannot be moved.
            hasDuration ? "opacity-100" : "opacity-0"
          )}
          style={{ left: `${progress * 100}%` }}
        />
      </div>
      {withTimes ? (
        <div className="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
          {/* `aria-hidden`, because the slider already announces its position through
              `aria-valuetext`. Left readable, these two make every seek announce the time twice. */}
          <span aria-hidden="true">{formatTimecode(displayTime)}</span>
          <span aria-hidden="true">{live ? labels.live : formatTimecode(duration)}</span>
        </div>
      ) : null}
    </div>
  )
}
