// A position bar is a control whose failures are all plausible. A bar that never fills looks like a
// clip that is not buffering; a thumb that lags the finger looks like a slow network; a seek that
// does nothing looks like a stalled source. Every case below is written against a version that got
// one of these wrong:
//
//   - reading `buffered` with `Array.from` or a spread, which answers `[]` or throws rather than
//     giving the ranges, and reads downstream as "nothing buffered" — a legitimate state, so the
//     bar simply never fills and nothing reports an error,
//   - taking the buffer as `ranges[last].end`, which promises a clip that will stall the moment the
//     playhead reaches the hole left by skipping ahead,
//   - computing a time from the pointer before metadata arrives, so `pointerX / width * NaN` is
//     assigned to `currentTime`, which **throws** rather than seeking (measured) and unwinds the
//     handler — so the `pointerup` that would end the drag never runs and the bar sticks to the
//     pointer for good,
//   - clamping the seek into `[0, duration]` and calling that the guard, which is backwards: the
//     element clamps finite values itself and refuses only the non-finite ones,
//   - rendering the drag straight from `media.currentTime`, so every frame paints the thumb behind
//     the finger and it crawls out from under the pointer on a slow source,
//   - publishing `aria-valuenow="0"` with no maximum while the length is unknown, which states that
//     playback is at 0% of a clip nobody has measured,
//   - announcing the position as a bare number, which is read out as "72" — of seconds, percent or
//     steps, with no way to tell,
//   - committing the last `pointermove` instead of the release's own coordinate, so a quick flick
//     lands seconds short of where the user let go,
//   - letting a second finger move or end a drag the first one started,
//   - returning early from the drag teardown when the track cannot be measured, which leaves a drag
//     that only a page reload ends,
//   - keeping the previous clip's length after the source is replaced.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  MediaScrubber,
  useMediaScrubber,
  isSeekableDuration,
  isLiveDuration,
  clampTime,
  readTimeRanges,
  bufferedEndAt,
  canSeekRanges,
  fractionOfDuration,
  timeFromPointer,
  keyboardSeekTarget,
  shouldCommitTime,
  seekMedia,
  formatTimecode,
  spokenTimecode,
  defaultMediaScrubberLabels,
  DEFAULT_SEEK_STEP,
  DEFAULT_SEEK_STEP_LARGE,
} = loadComponent(join(ROOT, "registry", "ui", "media-scrubber.tsx"))

// --- isSeekableDuration ------------------------------------------------------
// The guard every other function defers to. Both rejected values are ones a real element reports.

test("a duration is only usable when it is finite and positive", () => {
  assert.equal(isSeekableDuration(3), true)
  assert.equal(isSeekableDuration(0.25), true)
  // `NaN` is what `duration` reads before metadata loads — measured at readyState 0.
  assert.equal(isSeekableDuration(Number.NaN), false)
  // `Infinity` is a live stream, and also every clip from MediaRecorder.
  assert.equal(isSeekableDuration(Number.POSITIVE_INFINITY), false)
  assert.equal(isSeekableDuration(0), false)
  assert.equal(isSeekableDuration(-5), false)
  assert.equal(isSeekableDuration(null), false)
  assert.equal(isSeekableDuration(undefined), false)
})

test("an unbounded length is distinguished from a length that has not arrived", () => {
  // The two want opposite treatment: one is a position about to exist, the other never will.
  assert.equal(isLiveDuration(Number.POSITIVE_INFINITY), true)
  assert.equal(isLiveDuration(Number.NaN), false)
  assert.equal(isLiveDuration(120), false)
})

// --- clampTime ---------------------------------------------------------------

test("a time is clamped into the clip, and a non-finite one answers zero", () => {
  assert.equal(clampTime(5, 10), 5)
  assert.equal(clampTime(-5, 10), 0)
  assert.equal(clampTime(999, 10), 10)
  // A clamp, so the infinities land on the bounds. NaN has no position on the line, so it answers
  // 0 — the safe direction, since a seek to the start is recoverable and a throw out of an event
  // handler is not.
  assert.equal(clampTime(Number.NaN, 10), 0)
  assert.equal(clampTime(Number.POSITIVE_INFINITY, 10), 10)
  assert.equal(clampTime(Number.NEGATIVE_INFINITY, 10), 0)
})

test("a clamped time is always finite, whatever goes in", () => {
  // The invariant the pointer and keyboard paths depend on: everything they compute passes through
  // here before it reaches the element, which throws on a non-finite assignment.
  for (const time of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 5, -5, 0]) {
    for (const duration of [10, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      assert.equal(Number.isFinite(clampTime(time, duration)), true, `clampTime(${time}, ${duration})`)
    }
  }
})

test("with no usable duration a finite time passes through rather than collapsing to zero", () => {
  // The upper bound is unknown, not zero. Clamping to zero here would send a playing clip back to
  // the start every time the duration was momentarily unreadable.
  assert.equal(clampTime(42, Number.NaN), 42)
  assert.equal(clampTime(42, Number.POSITIVE_INFINITY), 42)
  assert.equal(clampTime(-1, Number.NaN), 0)
})

// --- readTimeRanges ----------------------------------------------------------

/**
 * A stand-in with exactly the surface a real `TimeRanges` has: `length`, `start(i)`, `end(i)`, and
 * nothing else. Measured on Chromium — `Array.isArray` false, `.map` undefined, no `Symbol.iterator`.
 * Written this way so a reader that reaches for an array method fails here the way it fails in a
 * browser, instead of passing against a convenient array.
 */
const timeRanges = (pairs) => ({
  length: pairs.length,
  start: (i) => pairs[i][0],
  end: (i) => pairs[i][1],
})

test("TimeRanges is read by index, because it is not iterable and has no array methods", () => {
  const ranges = timeRanges([
    [0, 12],
    [64, 71],
  ])
  // The shape the component has to cope with, pinned so the stand-in cannot drift into an array.
  assert.equal(typeof ranges[Symbol.iterator], "undefined")
  assert.equal(typeof ranges.map, "undefined")
  assert.equal(Array.isArray(ranges), false)
  assert.equal(ranges[0], undefined)
  // And `Array.from` on it — the obvious thing to write — succeeds and lies. Measured against a
  // real `TimeRanges` holding one range: it reads the length, finds no indices, and answers
  // `[undefined]`. An array of the right length, full of nothing, so a `.length` check passes and
  // the code believes it has the ranges.
  assert.deepEqual(Array.from(ranges), [undefined, undefined])
  assert.equal(Array.from(ranges).length, 2)
  // The spread at least fails loudly.
  assert.throws(() => [...ranges], TypeError)

  assert.deepEqual(readTimeRanges(ranges), [
    { start: 0, end: 12 },
    { start: 64, end: 71 },
  ])
})

test("a missing TimeRanges is empty rather than a crash", () => {
  assert.deepEqual(readTimeRanges(null), [])
  assert.deepEqual(readTimeRanges(undefined), [])
  assert.deepEqual(readTimeRanges(timeRanges([])), [])
})

test("a range with a non-finite bound is dropped, not carried into the arithmetic", () => {
  const ranges = timeRanges([
    [0, 5],
    [Number.NaN, 9],
    [10, Number.POSITIVE_INFINITY],
    [12, 14],
  ])
  assert.deepEqual(readTimeRanges(ranges), [
    { start: 0, end: 5 },
    { start: 12, end: 14 },
  ])
})

test("the range count is re-read each pass, so a buffer shrinking mid-loop cannot overrun", () => {
  // The network writes `buffered` while this reads it. A cached count indexes past the end and
  // throws IndexSizeError in a browser; here the stand-in would hand back undefined and produce a
  // NaN range, which is the same bug one step later.
  const pairs = [
    [0, 5],
    [6, 9],
    [10, 14],
  ]
  const shrinking = {
    get length() {
      return pairs.length
    },
    start: (i) => {
      // Half way through, the first range is evicted — the real behaviour of a media buffer.
      if (i === 1) pairs.pop()
      return pairs[i]?.[0] ?? Number.NaN
    },
    end: (i) => pairs[i]?.[1] ?? Number.NaN,
  }
  assert.deepEqual(readTimeRanges(shrinking), [
    { start: 0, end: 5 },
    { start: 6, end: 9 },
  ])
})

// --- bufferedEndAt -----------------------------------------------------------
// The headline case: the buffer grows holes as soon as anyone skips ahead.

test("the buffer is read from the range containing the playhead, not the last range", () => {
  const ranges = [
    { start: 0, end: 12 },
    { start: 64, end: 71 },
  ]
  // At 3s the honest answer is 12 — the clip stalls there. `ranges[last].end` would say 71 and
  // promise sixty-eight seconds that are not downloaded.
  assert.equal(bufferedEndAt(ranges, 3), 12)
  // And once the playhead is inside the far range, that one is the answer.
  assert.equal(bufferedEndAt(ranges, 65), 71)
})

test("a playhead in a hole reports no buffer ahead of it", () => {
  const ranges = [
    { start: 0, end: 12 },
    { start: 64, end: 71 },
  ]
  // Returning the time itself lets the caller draw `end - time` as a width with no special case.
  assert.equal(bufferedEndAt(ranges, 30), 30)
  assert.equal(bufferedEndAt([], 30), 30)
})

test("a playhead exactly on a range boundary counts as inside it", () => {
  const ranges = [{ start: 0, end: 12 }]
  // Treating the boundary as outside makes the buffered bar flicker to zero once per range as
  // playback crosses the seam. Note the `end` side is unobservable on a single range — falling
  // through returns `time`, which *is* `end` there — so the `start` side is what pins the comparison.
  assert.equal(bufferedEndAt(ranges, 12), 12)
  assert.equal(bufferedEndAt(ranges, 0), 12)
})

test("the first range containing the playhead wins, which is all a normalised list can offer", () => {
  // `TimeRanges` is defined to be normalised — disjoint and non-adjacent — so a real element never
  // reports these two separately. But this is an exported helper that takes a plain array, and
  // leaving the answer to whichever comparison happened to be written is how it drifts: with `end`
  // treated as outside, the playhead at 12 falls through to the second range and reports 20,
  // claiming eight contiguous seconds from a list that was never meant to be read that way.
  const adjacent = [
    { start: 0, end: 12 },
    { start: 12, end: 20 },
  ]
  assert.equal(bufferedEndAt(adjacent, 12), 12)
})

test("a non-finite playhead reports zero buffer rather than NaN", () => {
  assert.equal(bufferedEndAt([{ start: 0, end: 12 }], Number.NaN), 0)
})

// --- canSeekRanges -----------------------------------------------------------

test("a seekable list says nothing useful when empty, and is believed when not", () => {
  assert.equal(canSeekRanges([]), false)
  assert.equal(canSeekRanges([{ start: 0, end: 0 }]), false)
  assert.equal(canSeekRanges([{ start: 0, end: 30 }]), true)
})

// --- fractionOfDuration ------------------------------------------------------

test("a position is a fraction between zero and one, and zero when the length is unknown", () => {
  assert.equal(fractionOfDuration(5, 10), 0.5)
  assert.equal(fractionOfDuration(0, 10), 0)
  assert.equal(fractionOfDuration(10, 10), 1)
  assert.equal(fractionOfDuration(99, 10), 1)
  assert.equal(fractionOfDuration(-1, 10), 0)
  assert.equal(fractionOfDuration(5, Number.NaN), 0)
  // The Infinity trap: `5 / Infinity` is 0, so without the guard a live stream silently pins the
  // bar to the left edge and looks like a clip that never starts.
  assert.equal(fractionOfDuration(5, Number.POSITIVE_INFINITY), 0)
  assert.equal(fractionOfDuration(Number.NaN, 10), 0)
  // A zero-length clip. Without the positivity half of the guard this divides by zero and answers
  // 1, filling the bar completely for a clip with nothing in it.
  assert.equal(fractionOfDuration(5, 0), 0)
  assert.equal(fractionOfDuration(5, -10), 0)
})

// --- timeFromPointer ---------------------------------------------------------

test("the time under the pointer is read from the track's box", () => {
  const rect = { left: 100, width: 200 }
  assert.equal(timeFromPointer({ clientX: 100, rect, duration: 60 }), 0)
  assert.equal(timeFromPointer({ clientX: 200, rect, duration: 60 }), 30)
  assert.equal(timeFromPointer({ clientX: 300, rect, duration: 60 }), 60)
})

test("a pointer outside the track is clamped into the clip", () => {
  const rect = { left: 100, width: 200 }
  assert.equal(timeFromPointer({ clientX: 40, rect, duration: 60 }), 0)
  assert.equal(timeFromPointer({ clientX: 900, rect, duration: 60 }), 60)
})

test("a right-to-left track runs the other way", () => {
  const rect = { left: 100, width: 200 }
  assert.equal(timeFromPointer({ clientX: 300, rect, duration: 60, rtl: true }), 0)
  assert.equal(timeFromPointer({ clientX: 100, rect, duration: 60, rtl: true }), 60)
  assert.equal(timeFromPointer({ clientX: 200, rect, duration: 60, rtl: true }), 30)
})

test("an unmeasured track and an unknown length both answer zero rather than NaN", () => {
  // Both are ordinary first-render states, and a NaN from here reaches the element's setter and
  // throws.
  assert.equal(timeFromPointer({ clientX: 150, rect: { left: 0, width: 0 }, duration: 60 }), 0)
  assert.equal(timeFromPointer({ clientX: 150, rect: { left: 0, width: 200 }, duration: Number.NaN }), 0)
  assert.equal(
    timeFromPointer({ clientX: 150, rect: { left: 0, width: 200 }, duration: Number.POSITIVE_INFINITY }),
    0
  )
})

// --- keyboardSeekTarget ------------------------------------------------------

test("arrow keys step by five seconds and page keys by thirty", () => {
  const at = (key, currentTime = 60) => keyboardSeekTarget({ key, currentTime, duration: 300 })
  assert.equal(at("ArrowRight"), 60 + DEFAULT_SEEK_STEP)
  assert.equal(at("ArrowLeft"), 60 - DEFAULT_SEEK_STEP)
  assert.equal(at("PageUp"), 60 + DEFAULT_SEEK_STEP_LARGE)
  assert.equal(at("PageDown"), 60 - DEFAULT_SEEK_STEP_LARGE)
})

test("Home and End are the ends of the clip", () => {
  assert.equal(keyboardSeekTarget({ key: "Home", currentTime: 60, duration: 300 }), 0)
  assert.equal(keyboardSeekTarget({ key: "End", currentTime: 60, duration: 300 }), 300)
})

test("the steps are clamped, so holding an arrow at either end does not run past it", () => {
  assert.equal(keyboardSeekTarget({ key: "ArrowLeft", currentTime: 2, duration: 300 }), 0)
  assert.equal(keyboardSeekTarget({ key: "ArrowRight", currentTime: 298, duration: 300 }), 300)
})

test("the horizontal arrows mirror under RTL and the vertical ones do not", () => {
  const at = (key) => keyboardSeekTarget({ key, currentTime: 60, duration: 300, rtl: true })
  assert.equal(at("ArrowLeft"), 65)
  assert.equal(at("ArrowRight"), 55)
  // Up and Down have no writing direction. Mirroring them is a bug that only reaches the users
  // least able to work around it.
  assert.equal(at("ArrowUp"), 65)
  assert.equal(at("ArrowDown"), 55)
})

test("a key this does not handle answers null, so the caller leaves it alone", () => {
  // Null rather than the unchanged time: it is what lets the handler skip preventDefault and keep
  // Tab and Escape working on a focused slider.
  assert.equal(keyboardSeekTarget({ key: "Tab", currentTime: 60, duration: 300 }), null)
  assert.equal(keyboardSeekTarget({ key: "Escape", currentTime: 60, duration: 300 }), null)
  assert.equal(keyboardSeekTarget({ key: "a", currentTime: 60, duration: 300 }), null)
})

test("no usable duration means no key does anything", () => {
  for (const key of ["ArrowRight", "Home", "End", "PageUp"]) {
    assert.equal(keyboardSeekTarget({ key, currentTime: 0, duration: Number.NaN }), null)
    assert.equal(keyboardSeekTarget({ key, currentTime: 0, duration: Number.POSITIVE_INFINITY }), null)
  }
})

test("a non-finite current time is treated as the start rather than poisoning the step", () => {
  assert.equal(keyboardSeekTarget({ key: "ArrowRight", currentTime: Number.NaN, duration: 300 }), 5)
})

// --- shouldCommitTime --------------------------------------------------------

test("a reading finer than one step across the track is not worth a render", () => {
  // 1000 steps over 300s is 0.3s per step.
  assert.equal(shouldCommitTime(60, 60.05, 300), false)
  assert.equal(shouldCommitTime(60, 60.4, 300), true)
  assert.equal(shouldCommitTime(60, 60, 300), false)
})

test("both ends are always committed, however small the move", () => {
  // "finished" and "all but finished" are different states to anything reading the label.
  assert.equal(shouldCommitTime(299.99, 300, 300), true)
  assert.equal(shouldCommitTime(0.01, 0, 300), true)
})

test("a non-finite reading is never committed, and a non-finite previous always is", () => {
  assert.equal(shouldCommitTime(60, Number.NaN, 300), false)
  // The first reading after metadata arrives: anything is better than NaN.
  assert.equal(shouldCommitTime(Number.NaN, 12, 300), true)
})

test("with no usable duration there is no step size, so every change commits", () => {
  assert.equal(shouldCommitTime(60, 60.05, Number.NaN), true)
  assert.equal(shouldCommitTime(60, 60, Number.NaN), false)
})

// --- seekMedia ---------------------------------------------------------------

test("a finite time is assigned to the element, including out-of-range ones", () => {
  const media = { currentTime: 0 }
  assert.equal(seekMedia(media, 42), true)
  assert.equal(media.currentTime, 42)
  // Deliberately not clamped here: the element clamps finite values itself (measured — 999 on a 3s
  // clip reads back as 3), and clamping twice means this file carries a second opinion about the
  // duration.
  assert.equal(seekMedia(media, 999), true)
  assert.equal(media.currentTime, 999)
})

test("a non-finite time is refused and never reaches the setter", () => {
  // The real element throws TypeError on this assignment (measured), which unwinds whatever handler
  // is running. A throwing `pointerup` leaves the drag permanently stuck.
  let assigned = 0
  const media = {
    get currentTime() {
      return 7
    },
    set currentTime(value) {
      assigned++
      if (!Number.isFinite(value)) throw new TypeError("non-finite")
    },
  }
  assert.equal(seekMedia(media, Number.NaN), false)
  assert.equal(seekMedia(media, Number.POSITIVE_INFINITY), false)
  assert.equal(assigned, 0)
})

test("seeking a media element that is not there is a no-op", () => {
  assert.equal(seekMedia(null, 5), false)
  assert.equal(seekMedia(undefined, 5), false)
})

// --- formatTimecode / spokenTimecode ----------------------------------------

test("a timecode reads as a clock, with hours only when there are hours", () => {
  assert.equal(formatTimecode(7), "0:07")
  assert.equal(formatTimecode(72), "1:12")
  assert.equal(formatTimecode(3723), "1:02:03")
  assert.equal(formatTimecode(600), "10:00")
  assert.equal(formatTimecode(72, { forceHours: true }), "0:01:12")
})

test("seconds are floored, so the reading never shows a time the clip has not reached", () => {
  assert.equal(formatTimecode(59.9), "0:59")
  assert.equal(formatTimecode(0.9), "0:00")
})

test("an unknown time is a placeholder rather than NaN:NaN", () => {
  // This is the state of every scrubber on its first paint.
  assert.equal(formatTimecode(Number.NaN), "--:--")
  assert.equal(formatTimecode(Number.POSITIVE_INFINITY), "--:--")
  assert.equal(formatTimecode(Number.NaN, { placeholder: "—" }), "—")
  assert.equal(formatTimecode(-5), "0:00")
})

test("a spoken time names its units and gets the plurals right", () => {
  // A slider with no valuetext is announced as its bare number, which for a position is ambiguous
  // between seconds, percent and steps.
  assert.equal(spokenTimecode(72), "1 minute 12 seconds")
  assert.equal(spokenTimecode(61), "1 minute 1 second")
  assert.equal(spokenTimecode(7), "7 seconds")
  assert.equal(spokenTimecode(1), "1 second")
  assert.equal(spokenTimecode(3723), "1 hour 2 minutes 3 seconds")
  assert.equal(spokenTimecode(7200), "2 hours 0 minutes 0 seconds")
})

test("a zero position still says something, and an unknown one says so", () => {
  assert.equal(spokenTimecode(0), "0 seconds")
  assert.equal(spokenTimecode(Number.NaN), "unknown")
  assert.equal(spokenTimecode(Number.POSITIVE_INFINITY), "unknown")
})

// --- the hook and the component ---------------------------------------------

/** A media element with exactly the surface the hook touches, plus a way to fire its events. */
function fakeMedia({ duration = Number.NaN, currentTime = 0, buffered = [], seekable = [], paused = true } = {}) {
  const listeners = new Map()
  const media = {
    currentTime,
    duration,
    paused,
    ended: false,
    buffered: timeRanges(buffered),
    seekable: timeRanges(seekable),
    seeks: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
    fire(type) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    listenerTypes: () => [...listeners].filter(([, set]) => set.size > 0).map(([type]) => type).sort(),
  }
  // Record seeks the way the component issues them, while keeping the readback the element gives.
  let time = currentTime
  Object.defineProperty(media, "currentTime", {
    get: () => time,
    set: (value) => {
      if (!Number.isFinite(value)) throw new TypeError("non-finite")
      media.seeks.push(value)
      time = value
    },
  })
  return media
}

const TRACK_RECT = { left: 100, width: 200, top: 0, height: 6, right: 300, bottom: 6 }

/**
 * Mounts the component against a fake element and gives the track a box.
 *
 * The box has to be installed after the first render: the harness has no layout, so it fills the
 * track's ref with a stand-in that has no `getBoundingClientRect` at all — which is exactly the
 * server's answer, and the component is required to cope with it (see the "unmeasurable" cases).
 */
function mount(props = {}, { rect = TRACK_RECT, measured = true, direction = "ltr" } = {}) {
  const media = props.media ?? fakeMedia(props.mediaInit)
  const mediaRef = { current: media }
  // `direction` goes through the harness, which installs the `getComputedStyle` the component reads.
  // Setting the global before mounting does not work: `render` replaces it.
  const instance = render(MediaScrubber, { mediaRef, ...props.componentProps }, { direction })
  const track = instance.nodes[0]
  if (measured && track) track.getBoundingClientRect = () => rect
  const slider = () => walk(instance.tree).find((n) => n.props?.role === "slider")
  return {
    media,
    instance,
    track,
    slider,
    sliderProps: () => slider().props,
    texts: () =>
      walk(instance.tree)
        .filter((n) => typeof n.props?.children === "string")
        .map((n) => n.props.children),
    rerender: () => instance.rerender(),
  }
}

const pointer = (overrides = {}) => ({
  button: 0,
  pointerId: 1,
  clientX: 0,
  preventDefault() {},
  currentTarget: {
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
  },
  ...overrides,
})

test("the track is a focusable horizontal slider", () => {
  const ui = mount({ mediaInit: { duration: 300, seekable: [[0, 300]] } })
  const props = ui.sliderProps()
  assert.equal(props.role, "slider")
  assert.equal(props["aria-orientation"], "horizontal")
  // Focusable even when it cannot be used, so a keyboard user can reach it and hear why.
  assert.equal(props.tabIndex, 0)
  assert.equal(props["aria-label"], defaultMediaScrubberLabels.slider)
})

test("while the length is unknown no value is published and the slider says it is disabled", () => {
  const ui = mount()
  const props = ui.sliderProps()
  // All three withheld together: valuenow alone would mean 0% against ARIA's implied maximum of
  // 100 — a confident claim about a position nobody has measured.
  assert.equal(props["aria-valuenow"], undefined)
  assert.equal(props["aria-valuemin"], undefined)
  assert.equal(props["aria-valuemax"], undefined)
  assert.equal(props["aria-disabled"], true)
  assert.equal(props["aria-valuetext"], "unknown")
})

test("once metadata arrives the position is published and announced in words", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 72, seekable: [[0, 300]] } })
  const props = ui.sliderProps()
  assert.equal(props["aria-valuemin"], 0)
  assert.equal(props["aria-valuemax"], 300)
  assert.equal(props["aria-valuenow"], 72)
  assert.equal(props["aria-valuetext"], "1 minute 12 seconds of 5 minutes 0 seconds")
  assert.equal(props["aria-disabled"], undefined)
})

test("a duration that arrives later is picked up from durationchange", () => {
  const ui = mount()
  assert.equal(ui.sliderProps()["aria-valuenow"], undefined)
  ui.media.duration = 300
  ui.media.fire("durationchange")
  ui.rerender()
  assert.equal(ui.sliderProps()["aria-valuemax"], 300)
})

test("replacing the source forgets the previous clip's length", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 100, seekable: [[0, 300]] } })
  assert.equal(ui.sliderProps()["aria-valuemax"], 300)
  ui.media.duration = Number.NaN
  ui.media.fire("emptied")
  ui.rerender()
  // Without an `emptied` listener the bar keeps showing the old length against a new clip.
  assert.equal(ui.sliderProps()["aria-valuemax"], undefined)
  assert.equal(ui.sliderProps()["aria-valuenow"], undefined)
})

test("a live stream is announced as live and cannot be seeked", () => {
  const ui = mount({ mediaInit: { duration: Number.POSITIVE_INFINITY, seekable: [] } })
  const props = ui.sliderProps()
  assert.equal(props["aria-valuetext"], defaultMediaScrubberLabels.live)
  assert.equal(props["aria-disabled"], true)
  props.onPointerDown(pointer({ clientX: 200 }))
  assert.deepEqual(ui.media.seeks, [])
})

test("a measured duration rescues a clip whose own duration is Infinity", () => {
  // The MediaRecorder case: the file never learns its length, but whoever recorded it measured one.
  const ui = mount({
    mediaInit: { duration: Number.POSITIVE_INFINITY, seekable: [] },
    componentProps: { duration: 7.5 },
  })
  const props = ui.sliderProps()
  assert.equal(props["aria-valuemax"], 7.5)
  assert.equal(props["aria-disabled"], undefined)
  props.onPointerDown(pointer({ clientX: 200 }))
  assert.deepEqual(ui.media.seeks, [3.75])
})

test("pressing the track seeks to the pressed position", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  assert.deepEqual(ui.media.seeks, [30])
})

test("only the primary button starts a drag", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 200, button: 2 }))
  // A right-click opening a context menu must not start a drag with no release to end it.
  assert.deepEqual(ui.media.seeks, [])
})

test("the press captures the pointer and takes focus", () => {
  const captured = []
  let focused = 0
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(
    pointer({
      clientX: 200,
      pointerId: 9,
      currentTarget: {
        setPointerCapture: (id) => captured.push(id),
        releasePointerCapture() {},
        focus: () => focused++,
      },
    })
  )
  // Capture, because the gesture is a flick along a bar a few pixels tall and will leave it.
  assert.deepEqual(captured, [9])
  // Focus, so a user who drags and then reaches for an arrow key moves the clip, not the page.
  assert.equal(focused, 1)
})

test("the displayed position follows the pointer during a drag, not the element", () => {
  const ui = mount({ mediaInit: { duration: 60, currentTime: 0, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 150 }))
  ui.rerender()
  // The element is deliberately left reporting something else: a real one keeps answering the old
  // position until its seek completes.
  ui.media.currentTime = 0
  ui.media.fire("timeupdate")
  ui.rerender()
  ui.sliderProps().onPointerMove(pointer({ clientX: 250 }))
  ui.rerender()
  // 250 is three quarters along a track from 100 to 300 => 45s of 60.
  assert.equal(ui.sliderProps()["aria-valuenow"], 45)
})

test("a second pointer can neither move nor end a drag the first one started", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 150, pointerId: 1 }))
  ui.rerender()
  ui.sliderProps().onPointerMove(pointer({ clientX: 300, pointerId: 2 }))
  ui.rerender()
  ui.sliderProps().onPointerUp(pointer({ clientX: 300, pointerId: 2 }))
  ui.rerender()
  // The rogue pointer moved nothing, and the drag is still the first pointer's.
  assert.equal(ui.sliderProps()["aria-valuenow"], 15)
  ui.sliderProps().onPointerUp(pointer({ clientX: 200, pointerId: 1 }))
  ui.rerender()
  assert.equal(ui.media.seeks.at(-1), 30)
})

test("the release commits its own coordinate, not the last move's", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  const props = () => ui.sliderProps()
  props().onPointerDown(pointer({ clientX: 110 }))
  ui.rerender()
  props().onPointerMove(pointer({ clientX: 150 }))
  ui.rerender()
  // Pointer moves are coalesced, so the last one before release is routinely dropped. Trusting it
  // lands the seek short of where the user let go.
  props().onPointerUp(pointer({ clientX: 290 }))
  ui.rerender()
  assert.equal(ui.media.seeks.at(-1), 57)
})

test("a cancelled gesture abandons the drag instead of committing a position nobody chose", () => {
  const ui = mount({ mediaInit: { duration: 60, currentTime: 10, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 150 }))
  ui.rerender()
  const seeksAfterPress = ui.media.seeks.length
  ui.sliderProps().onPointerCancel(pointer({ clientX: 290 }))
  ui.rerender()
  // Cancel is the browser taking the gesture (a scroll, a back-swipe), not a release.
  assert.equal(ui.media.seeks.length, seeksAfterPress)
  assert.equal(ui.sliderProps()["aria-disabled"], undefined)
})

test("a drag is let go even when the track cannot be measured", () => {
  // Returning early from the teardown is what leaves a drag only a page reload ends.
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 150 }))
  ui.rerender()
  ui.track.getBoundingClientRect = () => ({ left: 0, width: 0 })
  ui.sliderProps().onPointerUp(pointer({ clientX: 290 }))
  ui.rerender()
  // No position was committed from the unmeasurable track — the press's 15s is all there is.
  assert.deepEqual(ui.media.seeks, [15])
  // ...and the next press still works, which it would not if the drag were still open under the
  // first pointer's id.
  ui.track.getBoundingClientRect = () => TRACK_RECT
  ui.sliderProps().onPointerDown(pointer({ clientX: 200, pointerId: 5 }))
  assert.equal(ui.media.seeks.at(-1), 30)
})

test("an unmeasurable track refuses the press rather than seeking to zero", () => {
  const ui = mount({ mediaInit: { duration: 60, currentTime: 30, seekable: [[0, 60]] } }, { measured: false })
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  // Seeking to 0 because the layout has not happened would send a half-played clip to the start.
  assert.deepEqual(ui.media.seeks, [])
})

test("dragging on release does not seek until the pointer is let go", () => {
  const ui = mount({
    mediaInit: { duration: 60, seekable: [[0, 60]] },
    componentProps: { scrub: "release" },
  })
  ui.sliderProps().onPointerDown(pointer({ clientX: 150 }))
  ui.rerender()
  ui.sliderProps().onPointerMove(pointer({ clientX: 250 }))
  ui.rerender()
  // For video over a slow network every intermediate seek is a keyframe fetch nobody sees.
  assert.deepEqual(ui.media.seeks, [])
  // The bar still tracks the finger, though.
  assert.equal(ui.sliderProps()["aria-valuenow"], 45)
  ui.sliderProps().onPointerUp(pointer({ clientX: 250 }))
  assert.deepEqual(ui.media.seeks, [45])
})

test("arrow and page keys seek, and say they handled the key", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 60, seekable: [[0, 300]] } })
  for (const [key, expected] of [
    ["ArrowRight", 65],
    ["ArrowLeft", 55],
    ["PageUp", 90],
    ["PageDown", 30],
    ["Home", 0],
    ["End", 300],
  ]) {
    let prevented = 0
    ui.sliderProps().onKeyDown({
      key,
      preventDefault: () => prevented++,
      currentTarget: {},
    })
    // Arrow and Page keys scroll the page and Home/End jump it; all of them must stop here.
    assert.equal(prevented, 1, `${key} should preventDefault`)
    assert.equal(ui.media.seeks.at(-1), expected, `${key} should seek to ${expected}`)
  }
})

test("a key the slider does not handle is left for the page", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 60, seekable: [[0, 300]] } })
  for (const key of ["Tab", "Escape", "Enter", "k"]) {
    let prevented = 0
    ui.sliderProps().onKeyDown({ key, preventDefault: () => prevented++, currentTarget: {} })
    // Swallowing every key press on a focused slider takes Tab and Escape with it.
    assert.equal(prevented, 0, `${key} should not be prevented`)
  }
  assert.deepEqual(ui.media.seeks, [])
})

test("the keyboard does nothing while the length is unknown", () => {
  const ui = mount()
  let prevented = 0
  ui.sliderProps().onKeyDown({ key: "ArrowRight", preventDefault: () => prevented++, currentTarget: {} })
  assert.equal(prevented, 0)
  assert.deepEqual(ui.media.seeks, [])
})

test("keyboard steps continue from the dragged position, not the element's", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 0, seekable: [[0, 300]] } })
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  ui.rerender()
  ui.sliderProps().onKeyDown({ key: "ArrowRight", preventDefault() {}, currentTarget: {} })
  // 200 is half way => 150s, then one step on.
  assert.equal(ui.media.seeks.at(-1), 155)
})

test("the buffered bar stops at the hole in front of the playhead", () => {
  const ui = mount({
    mediaInit: {
      duration: 100,
      currentTime: 3,
      seekable: [[0, 100]],
      buffered: [
        [0, 12],
        [64, 71],
      ],
    },
  })
  const widths = walk(ui.instance.tree)
    .filter((n) => typeof n.props?.style?.width === "string")
    .map((n) => n.props.style.width)
  // The buffered fill is 12% — the end of the range containing the playhead. Reading the last range
  // would paint 71% and promise a clip that will in fact stall at 12s.
  assert.ok(widths.includes("12%"), `expected a 12% buffered fill, got ${widths.join(", ")}`)
  assert.ok(widths.includes("3%"), `expected a 3% progress fill, got ${widths.join(", ")}`)
})

test("the buffer growing is picked up from progress, which timeupdate does not imply", () => {
  const ui = mount({
    mediaInit: { duration: 100, currentTime: 0, seekable: [[0, 100]], buffered: [[0, 10]] },
  })
  ui.media.buffered = timeRanges([[0, 40]])
  // A paused element downloads without advancing, so `timeupdate` never comes.
  ui.media.fire("progress")
  ui.rerender()
  const widths = walk(ui.instance.tree)
    .filter((n) => typeof n.props?.style?.width === "string")
    .map((n) => n.props.style.width)
  assert.ok(widths.includes("40%"), `expected a 40% buffered fill, got ${widths.join(", ")}`)
})

test("the readings beside the bar are hidden from screen readers", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 72, seekable: [[0, 300]] } })
  const labelled = walk(ui.instance.tree).filter((n) => typeof n.props?.children === "string")
  assert.deepEqual(
    labelled.map((n) => n.props.children),
    ["1:12", "5:00"]
  )
  // The slider already announces the position through aria-valuetext; left readable, these two make
  // every seek announce the time twice.
  for (const node of labelled) assert.equal(node.props["aria-hidden"], "true")
})

test("the readings can be turned off", () => {
  const ui = mount({
    mediaInit: { duration: 300, currentTime: 72, seekable: [[0, 300]] },
    componentProps: { withTimes: false },
  })
  assert.deepEqual(
    walk(ui.instance.tree).filter((n) => typeof n.props?.children === "string"),
    []
  )
})

test("an unloaded clip shows a placeholder for the length it does not know", () => {
  const ui = mount()
  // The elapsed side is a real reading — playback genuinely has not started — so it prints. The
  // total is the unknown one, and the alternative is the literal string "NaN:NaN".
  assert.deepEqual(ui.texts(), ["0:00", "--:--"])
})

test("a live clip labels its length rather than printing one", () => {
  const ui = mount({ mediaInit: { duration: Number.POSITIVE_INFINITY } })
  assert.deepEqual(ui.texts(), ["0:00", defaultMediaScrubberLabels.live])
})

test("announced strings can be replaced", () => {
  const ui = mount({
    mediaInit: { duration: 60, currentTime: 30, seekable: [[0, 60]] },
    componentProps: {
      labels: { slider: "Position", position: (p) => `at ${p}` },
    },
  })
  const props = ui.sliderProps()
  assert.equal(props["aria-label"], "Position")
  assert.equal(props["aria-valuetext"], "at 30 seconds")
})

test("a seek from this control reports the committed time", () => {
  const seen = []
  const ui = mount({
    mediaInit: { duration: 60, seekable: [[0, 60]] },
    componentProps: { onSeek: (t) => seen.push(t) },
  })
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  assert.deepEqual(seen, [30])
})

test("the element is subscribed for every state the bar draws", () => {
  // Asserted as the registration set rather than by firing each event, because this harness re-runs
  // effects on every settle — so the hook's initial `syncAll()` re-reads the element after any
  // rerender and would mask a listener that was never attached. A mutation run confirmed that:
  // deleting the `emptied`, `progress` and `durationchange` subscriptions left every
  // behaviour test green. This is the assertion that sees them go.
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  assert.deepEqual(ui.media.listenerTypes(), [
    // the buffer growing, which `timeupdate` does not imply
    "progress",
    // the source being torn down or replaced, after which every reading is stale
    "emptied",
    // `NaN` becoming a number, and a stream's length being revised
    "durationchange",
    "ended",
    "loadedmetadata",
    "pause",
    "play",
    "playing",
    // the element's own seeks, including ones issued from somewhere else entirely
    "seeked",
    "seeking",
    "timeupdate",
  ].sort())
})

test("the element's listeners are all removed on unmount", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  assert.ok(ui.media.listenerCount() > 0)
  ui.instance.unmount()
  // A scrubber left subscribed to a replaced player keeps it alive and keeps answering for it.
  assert.equal(ui.media.listenerCount(), 0)
})

test("the track is not interactive when the element says nothing is seekable", () => {
  // An element that reports ranges is believed; this one says there is a length but no seekable
  // window, which is a live edge with no DVR.
  const ui = mount({ mediaInit: { duration: 300, seekable: [[30, 30]] } })
  assert.equal(ui.sliderProps()["aria-disabled"], true)
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  assert.deepEqual(ui.media.seeks, [])
})

test("a right-to-left track seeks the other way", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } }, { direction: "rtl" })
  ui.sliderProps().onPointerDown(pointer({ clientX: 250 }))
  // Three quarters along an RTL track is a quarter of the way through the clip.
  assert.equal(ui.media.seeks.at(-1), 15)
})

test("the keyboard mirrors on a right-to-left track too", () => {
  const ui = mount({ mediaInit: { duration: 300, currentTime: 60, seekable: [[0, 300]] } }, { direction: "rtl" })
  ui.sliderProps().onKeyDown({ key: "ArrowLeft", preventDefault() {}, currentTarget: {} })
  assert.equal(ui.media.seeks.at(-1), 65)
})

test("the drag does not animate its own width", () => {
  const ui = mount({ mediaInit: { duration: 60, currentTime: 0, seekable: [[0, 60]] } })
  const fill = () =>
    walk(ui.instance.tree).find((n) => typeof n.props?.className === "string" && n.props.className.includes("bg-primary"))
  assert.match(fill().props.className, /transition-\[width\]/)
  ui.sliderProps().onPointerDown(pointer({ clientX: 200 }))
  ui.rerender()
  // During a drag the width *is* the pointer position, and a transition on it reads as the control
  // sticking behind the finger.
  assert.doesNotMatch(fill().props.className, /transition-\[width\]/)
})

test("the gesture is claimed from the browser so a drag on a phone is not a scroll", () => {
  const ui = mount({ mediaInit: { duration: 60, seekable: [[0, 60]] } })
  // Without `touch-none` the browser takes the gesture and fires pointercancel, so the scrubber
  // works with a mouse and does nothing at all on a touch screen.
  assert.match(ui.sliderProps().className, /touch-none/)
})
