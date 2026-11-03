// A marquee is written the same wrong way almost every time, and the cases below are written to
// fail against that version rather than to describe this one:
//
//   - duplicate the content and give the clones `aria-hidden`, which hides them from a screen reader
//     and leaves every link inside them a tab stop: four copies of three logo links is twelve tab
//     stops, nine of them leading somewhere the accessibility tree says is not there,
//   - take the distance of one loop from `offsetWidth` plus a gap read out of CSS, which is a
//     rounded integer plus a number nobody checked — measured half a pixel wrong, which is a jump at
//     the seam on every loop,
//   - size the speed as a duration, so three logos and thirty logos set to the same "20s" travel at
//     a tenth of each other's pace and every addition to the list silently retunes the animation,
//   - render `ceil(viewport / step) + 1` copies, dropping the gap from the arithmetic, which leaves
//     a strip of emptiness at the trailing edge at the moment of fullest travel,
//   - rebuild the animation whenever anything changes, which restarts the loop from the top on a
//     resize or a web font,
//   - and treat `prefers-reduced-motion` as a flag that stops the animation, which leaves a list
//     with its end cut off rather than a list.
//
// What the harness can and cannot see matters here. It has no layout, so a component that measures
// reads "not measured yet" unless the test supplies the numbers: the tree hands its refs to the
// harness's stand-in nodes, so `layout()` below defines `clientWidth` and a row of copy rectangles
// onto them, and `animate` as well — "the component asked for an animation of this duration over
// this distance" is the first kind of assertion, and "the band is moving" is the second kind, left
// to a browser. The harness also runs every effect on every pass and only runs cleanups at unmount,
// which is why the component refuses to rebuild an animation whose inputs have not changed; that
// rule is asserted here directly.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SOURCE = join(ROOT, "registry", "ui", "marquee.tsx")

// Named, unlike the usual `() => null` proxy, because which of the two icons is showing is part of
// what the button says: an icon that disagrees with the accessible name is a button that lies to
// half its users.
const icons = new Proxy(
  {},
  {
    get: (_target, name) =>
      function Icon(props) {
        return { type: "svg", props: { ...props, "data-icon": String(name).toLowerCase() } }
      },
  }
)

const { Marquee, marqueeCopyCount } = loadComponent(SOURCE, { stubs: { "lucide-react": icons } })

// --- the copy count -----------------------------------------------------------------------------

/** What `n` copies actually reach, in px: the gap trails every copy but the last. */
const extent = (n, step, gap) => n * step - gap

/** The distance that has to be covered: one loop of travel plus the box. */
const needed = (step, viewportWidth) => step + viewportWidth

/** The version that drops the gap, which is what this is written to catch. */
const withoutGap = (step, viewportWidth) => Math.ceil(viewportWidth / step) + 1

test("copy count covers a whole loop, gap included", () => {
  // The combination measured in a browser where dropping the gap leaves a visible strip of
  // emptiness: a 40px gap, a 300px box, a 316.4375px step.
  const step = 316.4375
  const copyWidth = step - 40
  const count = marqueeCopyCount({ step, copyWidth, viewportWidth: 300 })

  assert.ok(
    extent(count, step, 40) >= needed(step, 300),
    `${count} copies reach ${extent(count, step, 40)}, short of ${needed(step, 300)}`
  )
  // and the version without the gap does not, which is the whole point of the case
  assert.ok(extent(withoutGap(step, 300), step, 40) < needed(step, 300))
  assert.equal(count, withoutGap(step, 300) + 1)
})

test("copy count covers a whole loop across a sweep of gaps and box widths", () => {
  let dropped = 0
  for (const gap of [0, 1, 8, 24, 40, 64]) {
    for (const copyWidth of [37, 218.5, 240, 244.4375, 600]) {
      // 480 against a 240 copy with no gap is the case where the box is an exact multiple of the
      // step, which is where an off-by-one in the arithmetic hides: it is still covered, just with a
      // copy more than it needed.
      for (const viewportWidth of [0, 120, 243, 300, 420, 480, 486, 500, 657, 900, 1920]) {
        const step = copyWidth + gap
        const count = marqueeCopyCount({ step, copyWidth, viewportWidth })
        assert.ok(
          extent(count, step, gap) >= needed(step, viewportWidth) - 1e-9,
          `gap ${gap}, copy ${copyWidth}, box ${viewportWidth}: ${count} copies reach ` +
            `${extent(count, step, gap)}, short of ${needed(step, viewportWidth)}`
        )
        assert.ok(count >= 2, "two copies is the floor — the second one is the ruler")
        // And no more than it takes. Every extra copy is another render of the children, so an
        // arithmetic slip that rounds the count upwards is a cost rather than a bug — which is
        // exactly the kind that never gets noticed.
        if (count > 2) {
          assert.ok(
            extent(count - 1, step, gap) < needed(step, viewportWidth),
            `gap ${gap}, copy ${copyWidth}, box ${viewportWidth}: ${count - 1} copies would have done`
          )
        }
        if (extent(withoutGap(step, viewportWidth), step, gap) < needed(step, viewportWidth)) {
          dropped++
        }
      }
    }
  }
  // Not a property of this component, but of the sweep: if no combination here caught the dropped
  // gap, the sweep would be passing for free and the case above would be the only real one.
  assert.ok(dropped > 0, "the sweep no longer contains a case the gapless count gets wrong")
})

test("nothing measured, nothing to measure, and nothing finite all answer two", () => {
  // A box inside a closed dialog or an unselected tab measures zero on every axis, and so does
  // empty content. `ceil(width / 0)` is Infinity, and Infinity copies is a render that never
  // returns, so the guard is not cosmetic.
  assert.equal(marqueeCopyCount({ step: 0, copyWidth: 0, viewportWidth: 0 }), 2)
  assert.equal(marqueeCopyCount({ step: 240, copyWidth: 0, viewportWidth: 800 }), 2)
  assert.equal(marqueeCopyCount({ step: 0, copyWidth: 200, viewportWidth: 800 }), 2)
  assert.equal(marqueeCopyCount({ step: -240, copyWidth: 200, viewportWidth: 800 }), 2)
  assert.equal(marqueeCopyCount({ step: 240, copyWidth: 200, viewportWidth: Infinity }), 2)
  assert.equal(marqueeCopyCount({ step: 240, copyWidth: 200, viewportWidth: NaN }), 2)
  // A negative box width is not a reason to render a negative number of copies.
  assert.equal(marqueeCopyCount({ step: 240, copyWidth: 200, viewportWidth: -800 }), 2)
})

test("a single pixel is a measurement, not a rounding error", () => {
  // The guards ask whether anything was measured at all, which is not the same as asking whether
  // enough was measured to be worth bothering with. A one-pixel strip travelling past a ten-pixel
  // box is a silly marquee that works, and a threshold anywhere above zero is a marquee that
  // silently does nothing for content a browser reports in fractions.
  assert.equal(marqueeCopyCount({ step: 1, copyWidth: 1, viewportWidth: 10 }), 11)
  assert.equal(marqueeCopyCount({ step: 0.5, copyWidth: 0.5, viewportWidth: 2 }), 5)
})

// --- the rendered tree --------------------------------------------------------------------------

const LOGOS = ["Acme", "Globex", "Initech"]

/** The children every test uses: three links, so the clones' tab stops are visible to the test. */
const logoLinks = () =>
  LOGOS.map((name) => ({ type: "a", key: name, props: { href: `/${name}`, children: name } }))

/** The viewport, spacer and track stand-ins, in the order the component creates its refs. */
const nodesOf = (instance) => {
  const [viewport, spacer, track] = instance.nodes
  return { viewport, spacer, track }
}

/**
 * Where the first copy sits on the page.
 *
 * Not zero, deliberately. With the first copy at the origin, `second.left - first.left` and
 * `second.left + first.left` are the same number, and a component that added its two rectangles
 * together instead of subtracting them would pass every case below. A marquee halfway down a page
 * is never at the origin, and a marquee mid-travel is at wherever the animation has got to — the
 * browser reported −109.56 for a track whose resting position was 0 — so the offset is also the
 * honest fixture.
 */
const TRACK_ORIGIN = 1000

/**
 * Gives the stand-ins a layout, and the track an `animate` that records what it was asked for.
 *
 * The copies are placed at whole multiples of `step` from `TRACK_ORIGIN`, with fractional widths.
 * `offsetLeft` and `offsetWidth` are left undefined on purpose, so a component reaching for either
 * gets NaN and falls back to two copies.
 */
function layout(instance, { viewportWidth = 420, step = 243, copyWidth = 219 } = {}) {
  const { viewport, spacer, track } = nodesOf(instance)
  viewport.clientWidth = viewportWidth
  track.children = Array.from({ length: 32 }, (_, index) => ({
    getBoundingClientRect: () => ({ left: TRACK_ORIGIN + index * step, width: copyWidth }),
  }))
  const created = []
  track.animate = (keyframes, options) => {
    const animation = {
      currentTime: 0,
      calls: [],
      pause() {
        this.calls.push("pause")
      },
      play() {
        this.calls.push("play")
      },
      cancel() {
        this.calls.push("cancel")
      },
    }
    created.push({ keyframes, options, animation })
    return animation
  }
  return { created, viewport, spacer, track }
}

const root = (tree) => tree
const trackOf = (tree) =>
  walk(tree).find((node) => node.props?.className?.includes("absolute inset-y-0"))
const spacerOf = (tree) =>
  walk(tree).find((node) => node.props?.className?.includes("invisible"))
const buttonOf = (tree) => byTag(walk(tree), "button")[0]
const linksIn = (node) => byTag(walk(node), "a")

test("the clones are inert as well as hidden, and only the first copy is neither", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const copies = trackOf(instance.tree).props.children

  assert.ok(copies.length >= 2, "a seamless loop needs something arriving behind what leaves")
  assert.equal(copies[0].props["aria-hidden"], undefined)
  assert.equal(copies[0].props.inert, undefined)
  for (const clone of copies.slice(1)) {
    assert.equal(clone.props["aria-hidden"], "true")
    assert.equal(clone.props.inert, true, "aria-hidden alone leaves every link inside it focusable")
  }

  // The count that matters to a keyboard user: one copy's worth of tab stops, whatever the
  // duplication. Measured in a browser, aria-hidden on its own leaves the clones focusable.
  const reachable = copies
    .filter((copy) => copy.props.inert !== true)
    .reduce((total, copy) => total + linksIn(copy).length, 0)
  assert.equal(reachable, LOGOS.length)
})

test("the spacer is for sizing only: hidden, inert, and intrinsically wide", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const spacer = spacerOf(instance.tree)

  assert.equal(spacer.props["aria-hidden"], "true")
  assert.equal(spacer.props.inert, true)
  // w-max is load-bearing: a spacer narrow enough to squeeze its items wraps them, and measured a
  // wrapped spacer reported 60px of height where the copies were 24px.
  assert.match(spacer.props.className, /\bw-max\b/)
  assert.match(spacer.props.className, /\binvisible\b/)
  // The track is out of flow so that the copy count cannot feed back into the width the count is
  // computed from — measured, a box sized by its track ran 210 → 444 → 912 → 1848px as the count
  // doubled, with nothing to stop it.
  assert.match(trackOf(instance.tree).props.className, /\babsolute\b/)
  assert.match(root(instance.tree).props.className, /\brelative\b/)
  assert.match(root(instance.tree).props.className, /\boverflow-hidden\b/)
})

test("the copy count comes from the measured step, as a difference of rectangles", () => {
  const instance = render(Marquee, { children: logoLinks() })
  // Before layout: two copies, which is the "not measured yet" answer and the server's answer.
  assert.equal(trackOf(instance.tree).props.children.length, 2)

  layout(instance, { viewportWidth: 900, step: 243, copyWidth: 219 })
  instance.rerender()

  const expected = marqueeCopyCount({ step: 243, copyWidth: 219, viewportWidth: 900 })
  assert.equal(trackOf(instance.tree).props.children.length, expected)
  assert.ok(expected > 2, "a 900px box needs more than the floor")
})

test("the copy count follows the box, not only the content", () => {
  const instance = render(Marquee, { children: logoLinks() })
  layout(instance, { viewportWidth: 300, step: 243, copyWidth: 219 })
  instance.rerender()
  const narrow = trackOf(instance.tree).props.children.length

  // The one change that moves the count while leaving the step and the copy width exactly where
  // they were: the box gets wider. A bail-out that compares the wrong subset of the measurement
  // keeps the old count here and leaves a strip of emptiness behind the content.
  nodesOf(instance).viewport.clientWidth = 1600
  instance.rerender()
  const wide = trackOf(instance.tree).props.children.length

  assert.equal(narrow, marqueeCopyCount({ step: 243, copyWidth: 219, viewportWidth: 300 }))
  assert.equal(wide, marqueeCopyCount({ step: 243, copyWidth: 219, viewportWidth: 1600 }))
  assert.ok(wide > narrow)
})

test("a box with no layout stays at the floor rather than animating to a measurement of zero", () => {
  // Each of the three is reached on its own, because a chain of guards short-circuits: a fixture
  // that is zero on every axis at once only ever exercises the first of them.
  for (const measurements of [
    { viewportWidth: 0, step: 0, copyWidth: 0 },
    { viewportWidth: 420, step: 0, copyWidth: 219 },
    { viewportWidth: 420, step: 243, copyWidth: 0 },
  ]) {
    const instance = render(Marquee, { children: logoLinks() })
    const { created } = layout(instance, measurements)
    instance.rerender()

    assert.equal(trackOf(instance.tree).props.children.length, 2)
    assert.equal(
      created.length,
      0,
      `nothing to travel, so nothing to animate: ${JSON.stringify(measurements)}`
    )
  }
})

test("a track with nothing to measure against is not measured", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { track } = nodesOf(instance)
  nodesOf(instance).viewport.clientWidth = 420
  // One copy in the track and no second one to take the distance from. The guard is what keeps this
  // from being a TypeError on a rectangle that is not there.
  track.children = [{ getBoundingClientRect: () => ({ left: TRACK_ORIGIN, width: 219 }) }]
  const created = []
  track.animate = (...args) => {
    created.push(args)
    return { currentTime: 0, pause() {}, play() {}, cancel() {} }
  }
  instance.rerender()

  assert.equal(created.length, 0)
  assert.equal(trackOf(instance.tree).props.children.length, 2)
})

// --- the animation ------------------------------------------------------------------------------

test("the animation travels one step, in the measured direction, at the asked-for speed", () => {
  const instance = render(Marquee, { children: logoLinks(), speed: 100 })
  const { created } = layout(instance, { step: 250, copyWidth: 226 })
  instance.rerender()

  assert.equal(created.length, 1)
  const { keyframes, options } = created[0]
  assert.deepEqual(keyframes, [
    { transform: "translateX(0px)" },
    { transform: "translateX(-250px)" },
  ])
  // 250px at 100px/s is 2.5s. A duration prop would have made this number independent of the
  // distance, which is the bug: the same duration over twice the content is half the speed.
  assert.equal(options.duration, 2500)
  assert.equal(options.iterations, Infinity)
  assert.equal(options.easing, "linear")
})

test("speed is pixels per second, so adding content does not change how fast it reads", () => {
  const short = render(Marquee, { children: logoLinks(), speed: 50 })
  const shortLayout = layout(short, { step: 200, copyWidth: 176 })
  short.rerender()

  const long = render(Marquee, { children: logoLinks(), speed: 50 })
  const longLayout = layout(long, { step: 2000, copyWidth: 1976 })
  long.rerender()

  const pace = ({ created, step }) => step / created[0].options.duration
  assert.equal(
    pace({ created: shortLayout.created, step: 200 }),
    pace({ created: longLayout.created, step: 2000 })
  )
  assert.equal(longLayout.created[0].options.duration, 10 * shortLayout.created[0].options.duration)
})

test("travelling right starts a step to the left, in the keyframes and at rest", () => {
  const instance = render(Marquee, { children: logoLinks(), direction: "right", speed: 100 })
  const { created } = layout(instance, { step: 250, copyWidth: 226 })
  instance.rerender()

  assert.deepEqual(created[0].keyframes, [
    { transform: "translateX(-250px)" },
    { transform: "translateX(0px)" },
  ])
  // The resting transform for the frame between measuring the distance and starting the animation
  // that uses it. Without it the track sits at 0 for a frame and then jumps a whole step.
  assert.equal(trackOf(instance.tree).props.style.transform, "translateX(-250px)")
})

test("travelling left needs no resting transform", () => {
  const instance = render(Marquee, { children: logoLinks() })
  layout(instance, { step: 250, copyWidth: 226 })
  instance.rerender()
  assert.equal(trackOf(instance.tree).props.style.transform, undefined)
})

test("there is no resting transform until a distance has been measured", () => {
  // Before any layout the distance is unknown, and a transform of a guessed distance is a band that
  // starts somewhere arbitrary — including the server's HTML, where this renders too.
  const instance = render(Marquee, { children: logoLinks(), direction: "right" })
  assert.equal(trackOf(instance.tree).props.style.transform, undefined)

  // A one-pixel step is still a measurement, so it does get one.
  layout(instance, { step: 1, copyWidth: 1, viewportWidth: 10 })
  instance.rerender()
  assert.equal(trackOf(instance.tree).props.style.transform, "translateX(-1px)")
})

test("a one-pixel measurement still animates, and so does a speed of one", () => {
  const instance = render(Marquee, { children: logoLinks(), speed: 1 })
  const { created } = layout(instance, { step: 1, copyWidth: 1, viewportWidth: 10 })
  instance.rerender()

  assert.equal(created.length, 1)
  assert.equal(created[0].options.duration, 1000)
  assert.deepEqual(created[0].keyframes, [
    { transform: "translateX(0px)" },
    { transform: "translateX(-1px)" },
  ])
})

test("an effect that runs again with the same numbers leaves the animation alone", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { created } = layout(instance)
  instance.rerender()
  assert.equal(created.length, 1)

  // Several more passes with nothing changed. Rebuilding the animation is a restart, and a restart
  // is visible — so the rule is the component's, not the dependency array's.
  instance.rerender()
  instance.update({ children: logoLinks() })
  assert.equal(created.length, 1)
  assert.deepEqual(created[0].animation.calls, [])
})

test("a changed distance rebuilds the animation at the phase the old one had reached", () => {
  const instance = render(Marquee, { children: logoLinks(), speed: 100 })
  const first = layout(instance, { step: 200, copyWidth: 176 })
  instance.rerender()
  assert.equal(first.created.length, 1)
  assert.equal(first.created[0].options.duration, 2000)

  // Three quarters of the way through the loop, then the content gets wider — a web font arriving,
  // a logo added, the box resized.
  first.created[0].animation.currentTime = 1500
  const { track } = nodesOf(instance)
  track.children = Array.from({ length: 32 }, (_, index) => ({
    getBoundingClientRect: () => ({ left: index * 400, width: 376 }),
  }))
  instance.rerender()

  assert.equal(first.created.length, 2, "a new distance is a new animation")
  const rebuilt = first.created[1]
  assert.equal(rebuilt.options.duration, 4000)
  // Measured in a browser: a rebuilt animation starts at zero, which put the track back at
  // translateX(0) from −134.219, while carrying the fraction across reproduced −134.219 exactly.
  assert.equal(rebuilt.animation.currentTime, 3000)
  assert.ok(
    first.created[0].animation.calls.includes("cancel"),
    "the animation it replaces comes off the track"
  )
})

test("a currentTime that is not a number restarts the loop rather than carrying a nonsense phase", () => {
  const instance = render(Marquee, { children: logoLinks(), speed: 100 })
  const { created } = layout(instance, { step: 200, copyWidth: 176 })
  instance.rerender()

  // `Animation.currentTime` is typed `CSSNumberish` and is a plain number for everything created
  // the way this is. If some engine ever hands back a unit value instead, the phase is unknowable
  // and the only safe answer is the top of the loop — not a fraction computed from an object.
  created[0].animation.currentTime = { value: 1500, unit: "ms" }
  const { track } = nodesOf(instance)
  track.children = Array.from({ length: 32 }, (_, index) => ({
    getBoundingClientRect: () => ({ left: TRACK_ORIGIN + index * 400, width: 376 }),
  }))
  instance.rerender()

  assert.equal(created.length, 2)
  assert.equal(created[1].animation.currentTime, 0)
})

// --- stopping -----------------------------------------------------------------------------------

test("a hovering mouse stops it and leaving starts it again", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { created } = layout(instance)
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")

  root(instance.tree).props.onPointerEnter({ pointerType: "mouse" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")
  assert.ok(created[0].animation.calls.includes("pause"))

  root(instance.tree).props.onPointerLeave({ pointerType: "mouse" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")
  assert.ok(created[0].animation.calls.includes("play"))
})

test("a tap does not stop it for the rest of the visit", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { created } = layout(instance)
  instance.rerender()

  // A touch pointer enters and never leaves: there is no pointer left to move away. Honouring it
  // would stop the band until the page is reloaded, and a touch visitor has the button instead.
  root(instance.tree).props.onPointerEnter({ pointerType: "touch" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")
  assert.deepEqual(created[0].animation.calls, [])
})

test("a cancelled pointer gesture does not leave it stopped", () => {
  const instance = render(Marquee, { children: logoLinks() })
  layout(instance)
  instance.rerender()

  root(instance.tree).props.onPointerEnter({ pointerType: "pen" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")

  root(instance.tree).props.onPointerCancel({ pointerType: "pen" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")
})

test("focus landing inside stops it, and the caller's handlers still run", () => {
  const seen = []
  const instance = render(Marquee, {
    children: logoLinks(),
    onFocus: () => seen.push("focus"),
    onBlur: () => seen.push("blur"),
    onPointerEnter: () => seen.push("enter"),
    onPointerLeave: () => seen.push("leave"),
  })
  layout(instance)
  instance.rerender()

  root(instance.tree).props.onFocus({})
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")

  root(instance.tree).props.onBlur({})
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")

  root(instance.tree).props.onPointerEnter({ pointerType: "mouse" })
  root(instance.tree).props.onPointerLeave({ pointerType: "mouse" })
  assert.deepEqual(seen, ["focus", "blur", "enter", "leave"])
})

test("pauseOnHover and pauseOnFocus can be turned off without taking the button away", () => {
  const instance = render(Marquee, {
    children: logoLinks(),
    pauseOnHover: false,
    pauseOnFocus: false,
  })
  layout(instance)
  instance.rerender()

  root(instance.tree).props.onPointerEnter({ pointerType: "mouse" })
  root(instance.tree).props.onFocus({})
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")
  assert.ok(buttonOf(instance.tree), "WCAG 2.2.2 wants a way to stop it that is not hover")
})

test("the button holds the pause after the pointer and focus have gone", () => {
  const changes = []
  const instance = render(Marquee, {
    children: logoLinks(),
    onPausedChange: (next) => changes.push(next),
  })
  const { created } = layout(instance)
  instance.rerender()

  const button = buttonOf(instance.tree)
  assert.equal(button.props["aria-label"], "Pause")
  assert.equal(button.props.type, "button")

  button.props.onClick()
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")
  assert.equal(buttonOf(instance.tree).props["aria-label"], "Resume")
  assert.ok(created[0].animation.calls.includes("pause"))

  // Hover comes and goes; the held pause survives both, which is the difference between the button
  // and the hover.
  root(instance.tree).props.onPointerEnter({ pointerType: "mouse" })
  root(instance.tree).props.onPointerLeave({ pointerType: "mouse" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")

  buttonOf(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "running")
  assert.deepEqual(changes, [true, false])
})

test("the icon and the accessible name say the same thing", () => {
  const instance = render(Marquee, { children: logoLinks() })
  layout(instance)
  instance.rerender()

  const iconOf = (tree) =>
    walk(tree).find((node) => node.props?.["data-icon"] !== undefined)?.props
  // The icon is decoration and the name is the button, in both states: an icon read out beside the
  // name says "pause pause", and an icon left unhidden in only one of the two states is the version
  // that gets shipped because the other one was the one tested.
  assert.equal(iconOf(instance.tree)["data-icon"], "pause")
  assert.equal(iconOf(instance.tree)["aria-hidden"], "true")
  assert.equal(buttonOf(instance.tree).props["aria-label"], "Pause")

  buttonOf(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(iconOf(instance.tree)["data-icon"], "play")
  assert.equal(iconOf(instance.tree)["aria-hidden"], "true")
  assert.equal(buttonOf(instance.tree).props["aria-label"], "Resume")
})

test("a held pause supplied from outside is not overridden by the button", () => {
  const changes = []
  const instance = render(Marquee, {
    children: logoLinks(),
    paused: true,
    onPausedChange: (next) => changes.push(next),
  })
  const { created } = layout(instance)
  instance.rerender()

  assert.equal(root(instance.tree).props["data-state"], "paused")
  assert.equal(buttonOf(instance.tree).props["aria-label"], "Resume")
  assert.ok(created[0].animation.calls.includes("pause"), "it never moves before the first paint")

  // The button asks; the owner of the prop decides. Nothing here flips to running on its own.
  buttonOf(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")
  assert.deepEqual(changes, [false])

  instance.update({ children: logoLinks(), paused: false, onPausedChange: (n) => changes.push(n) })
  assert.equal(root(instance.tree).props["data-state"], "running")
})

test("paused={false} overrides a pause the button had already held", () => {
  // The handover case: it ran uncontrolled, somebody pressed the button, and only then did the
  // caller start supplying the prop. `false` from the owner of the state has to win over the state
  // this component was keeping before it had an owner, or the prop is advisory rather than
  // controlling and the two disagree for the rest of the page's life.
  const instance = render(Marquee, { children: logoLinks() })
  layout(instance)
  instance.rerender()

  buttonOf(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")

  instance.update({ children: logoLinks(), paused: false })
  assert.equal(root(instance.tree).props["data-state"], "running")
  assert.equal(buttonOf(instance.tree).props["aria-label"], "Pause")
})

test("controls={false} leaves the hover and focus pauses in place", () => {
  const instance = render(Marquee, { children: logoLinks(), controls: false })
  layout(instance)
  instance.rerender()

  assert.equal(buttonOf(instance.tree), undefined)
  root(instance.tree).props.onPointerEnter({ pointerType: "mouse" })
  instance.rerender()
  assert.equal(root(instance.tree).props["data-state"], "paused")
})

test("the labels are the caller's", () => {
  const instance = render(Marquee, {
    children: logoLinks(),
    pauseLabel: "一時停止",
    resumeLabel: "再開",
  })
  layout(instance)
  instance.rerender()

  assert.equal(buttonOf(instance.tree).props["aria-label"], "一時停止")
  buttonOf(instance.tree).props.onClick()
  instance.rerender()
  assert.equal(buttonOf(instance.tree).props["aria-label"], "再開")
})

// --- the gap ------------------------------------------------------------------------------------

test("the default gap is a gap", () => {
  // A default of zero would make every example in the documentation a solid run of logos, and it is
  // the kind of default nobody notices is wrong because it still works.
  const instance = render(Marquee, { children: logoLinks() })
  assert.equal(trackOf(instance.tree).props.style.gap, 24)
  assert.equal(spacerOf(instance.tree).props.style.gap, 24)
})

test("the gap reaches the track, the copies and the spacer, so one rhythm runs through all of them", () => {
  const instance = render(Marquee, { children: logoLinks(), gap: 40 })
  const tree = instance.tree

  assert.equal(trackOf(tree).props.style.gap, 40)
  assert.equal(spacerOf(tree).props.style.gap, 40)
  for (const copy of trackOf(tree).props.children) assert.equal(copy.props.style.gap, 40)
  // The seam depends on the gap between the last item of one copy and the first of the next being
  // the same as the gap inside a copy; a gap on the copies alone would make the seam wider.
})

test("each copy refuses to shrink, which is what lets the track be wider than the box", () => {
  const instance = render(Marquee, { children: logoLinks() })
  for (const copy of trackOf(instance.tree).props.children) {
    assert.match(copy.props.className, /\bshrink-0\b/)
  }
  assert.match(trackOf(instance.tree).props.className, /\bw-max\b/)
})

test("a caller's className and style survive, and its own props reach the box", () => {
  const instance = render(Marquee, {
    children: logoLinks(),
    className: "border-y py-4",
    style: { background: "red" },
    "aria-label": "Our customers",
  })
  const box = root(instance.tree)
  assert.match(box.props.className, /border-y py-4/)
  assert.equal(box.props.style.background, "red")
  assert.equal(box.props["aria-label"], "Our customers")
})

test("the box clips without becoming something that can be scrolled", () => {
  const instance = render(Marquee, { children: logoLinks(), style: { background: "red" } })
  const box = root(instance.tree)

  // `overflow: hidden` makes a scroll container, and the browser scrolls one to reveal a focused
  // descendant: measured, tabbing to the last link of the visible copy in a box narrower than that
  // copy scrolled the box to 284 and left it there, sliding the whole band sideways for good.
  // `clip` clips the same way without the scrolling, and the class stays as the fallback for an
  // engine that drops the declaration.
  assert.equal(box.props.style.overflow, "clip")
  assert.match(box.props.className, /\boverflow-hidden\b/)
  assert.equal(box.props.style.background, "red", "and a caller's own style still arrives")
})

// --- reduced motion -----------------------------------------------------------------------------

/**
 * Runs `body` with the component loaded against a browser that asks for less motion.
 *
 * Loaded inside the stub rather than at the top of the file, because the choice between
 * `useLayoutEffect` and `useEffect` is made at module scope from `typeof window`: a component that
 * believes it is on a server never reads the media query at all. `window` stays defined for the
 * body too, since that is where the effects run.
 */
function withMotionQuery(initialMatches, body) {
  const previous = globalThis.window
  const query = {
    matches: initialMatches,
    listeners: [],
    addEventListener(type, listener) {
      this.listeners.push({ type, listener })
    },
    removeEventListener(type, listener) {
      this.listeners = this.listeners.filter((l) => l.type !== type || l.listener !== listener)
    },
    /** What the browser does when the visitor changes the setting while the page is open. */
    set(matches) {
      this.matches = matches
      for (const { type, listener } of this.listeners) if (type === "change") listener({ matches })
    },
  }
  globalThis.window = {
    matchMedia: (text) => (text.includes("prefers-reduced-motion") ? query : { matches: false }),
  }
  try {
    body(loadComponent(SOURCE, { stubs: { "lucide-react": icons } }), query)
  } finally {
    globalThis.window = previous
  }
}

const withReducedMotion = (body) => withMotionQuery(true, body)

test("reduced motion gets a wrapping list, not a stopped marquee", () => {
  withReducedMotion(({ Marquee: Reduced }) => {
    const instance = render(Reduced, { children: logoLinks(), gap: 40 })
    const tree = instance.tree

    // A stopped marquee is a list with its end cut off: measured in a browser, six items in a 300px
    // box left 233px outside it. The wrapping list measured 0px of overflow with every item inside.
    const list = tree.props.children
    assert.match(list.props.className, /\bflex-wrap\b/)
    assert.equal(list.props.style.gap, 40)
    // Still clipped at the box, for the one item too wide to wrap: a page-wide horizontal scrollbar
    // is not a kinder outcome than a cut-off logo.
    assert.match(tree.props.className, /\boverflow-hidden\b/)
    assert.equal(spacerOf(tree), undefined, "nothing to size: there is no out-of-flow track")
    assert.equal(trackOf(tree), undefined)
    assert.equal(buttonOf(tree), undefined, "nothing is moving, so there is nothing to stop")

    // One copy, so one set of tab stops, and no clone to hide from anybody.
    assert.equal(linksIn(tree).length, LOGOS.length)
    assert.equal(
      walk(tree).filter((node) => node.props?.inert === true).length,
      0,
      "the shrink-0 that the seam needs is exactly what stops a row wrapping, so none of it is here"
    )
  })
})

test("reduced motion keeps the caller's own handlers and props", () => {
  withReducedMotion(({ Marquee: Reduced }) => {
    const seen = []
    const instance = render(Reduced, {
      children: logoLinks(),
      className: "border-y",
      "aria-label": "Our customers",
      onFocus: () => seen.push("focus"),
      onPointerEnter: () => seen.push("enter"),
    })

    // The handlers are destructured out of the props for the moving version, where each is wrapped,
    // so the still version has to hand them back explicitly or they are dropped for exactly the
    // visitors who asked for less motion.
    instance.tree.props.onFocus({})
    instance.tree.props.onPointerEnter({ pointerType: "mouse" })
    assert.deepEqual(seen, ["focus", "enter"])
    assert.match(instance.tree.props.className, /border-y/)
    assert.equal(instance.tree.props["aria-label"], "Our customers")
  })
})

test("reduced motion starts no animation even if a measurement arrives", () => {
  withReducedMotion(({ Marquee: Reduced }) => {
    const instance = render(Reduced, { children: logoLinks() })
    const animate = []
    for (const node of instance.nodes) {
      node.animate = (...args) => animate.push(args)
      node.clientWidth = 420
      node.children = Array.from({ length: 4 }, (_, index) => ({
        getBoundingClientRect: () => ({ left: index * 243, width: 219 }),
      }))
    }
    instance.rerender()
    assert.equal(animate.length, 0)
  })
})

test("turning the setting on mid-visit stops it, and turning it off starts it", () => {
  withMotionQuery(false, ({ Marquee: Watched }, query) => {
    const instance = render(Watched, { children: logoLinks() })
    const { created } = layout(instance)
    instance.rerender()
    assert.equal(created.length, 1, "it was moving to begin with")
    assert.ok(trackOf(instance.tree), "the animated tree")

    // Changing the operating system's motion preference does not reload the page, so a component
    // that only reads the query once keeps animating for the rest of the visit. The count is not
    // pinned because the harness re-runs every effect on every pass without the cleanup in between;
    // what is pinned is the event name, which is the part a browser has an opinion about.
    assert.ok(query.listeners.length > 0, "the query is subscribed to")
    assert.ok(
      query.listeners.every(({ type }) => type === "change"),
      "by the name the browser actually fires"
    )
    query.set(true)
    instance.rerender()
    assert.equal(trackOf(instance.tree), undefined, "the wrapping list, not a stopped track")
    assert.match(instance.tree.props.children.props.className, /\bflex-wrap\b/)
    // That the animation already on the track is cancelled is React's cleanup doing its job, which
    // this harness only runs at unmount — see the note at the top. What is visible here is that
    // nothing new is started, which is the part this component decides.
    assert.equal(created.length, 1)

    query.set(false)
    instance.rerender()
    assert.ok(trackOf(instance.tree), "and back, without a reload")

    instance.unmount()
    assert.equal(query.listeners.length, 0, "a listener on a dead component is a leak")
  })
})

// --- a face arriving late -----------------------------------------------------------------------

/** A `document` whose fonts are still loading, and the handle to say they have arrived. */
function withPendingFonts(body) {
  const previous = globalThis.document
  let settle
  const ready = new Promise((resolve) => {
    settle = resolve
  })
  globalThis.document = { fonts: { ready } }
  try {
    return body(settle, ready)
  } finally {
    globalThis.document = previous
  }
}

test("a web font arriving after the first measurement re-measures", async () => {
  await withPendingFonts(async (fontsHaveArrived, ready) => {
    const instance = render(Marquee, { children: logoLinks() })
    const { track } = nodesOf(instance)
    let rects = 0
    nodesOf(instance).viewport.clientWidth = 420
    track.children = Array.from({ length: 32 }, (_, index) => ({
      getBoundingClientRect: () => {
        rects++
        return { left: TRACK_ORIGIN + index * 243, width: 219 }
      },
    }))
    instance.rerender()

    // A face swapping in changes the width of every glyph without changing a single box, so no
    // observer reports it and the band would keep travelling the distance the fallback face needed.
    const before = rects
    fontsHaveArrived()
    await ready
    assert.ok(rects > before, "the measurement was taken again once the font was there")
  })
})

test("a font arriving after the component has gone is not measured", async () => {
  await withPendingFonts(async (fontsHaveArrived, ready) => {
    const instance = render(Marquee, { children: logoLinks() })
    const { track } = nodesOf(instance)
    let rects = 0
    nodesOf(instance).viewport.clientWidth = 420
    track.children = Array.from({ length: 32 }, (_, index) => ({
      getBoundingClientRect: () => {
        rects++
        return { left: TRACK_ORIGIN + index * 243, width: 219 }
      },
    }))
    instance.rerender()

    instance.unmount()
    const after = rects
    fontsHaveArrived()
    await ready
    // Measuring a node the component no longer holds is a state update on a dead component, and the
    // promise outlives it by as long as the font takes.
    assert.equal(rects, after)
  })
})

// --- teardown -----------------------------------------------------------------------------------

test("unmounting takes the animation off the track", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { created } = layout(instance)
  instance.rerender()
  assert.equal(created.length, 1)

  instance.unmount()
  assert.ok(
    created[0].animation.calls.includes("cancel"),
    "an animation left running on a detached node is a loop nobody can stop"
  )
})

test("no speed, no animation", () => {
  for (const speed of [0, -40]) {
    const instance = render(Marquee, { children: logoLinks(), speed })
    const { created } = layout(instance)
    instance.rerender()
    assert.equal(created.length, 0, `speed ${speed} is not a speed`)
    // and the content is still all there, at rest
    assert.equal(linksIn(trackOf(instance.tree).props.children[0]).length, LOGOS.length)
  }
})

test("a browser with no Web Animations API renders the content and moves nothing", () => {
  const instance = render(Marquee, { children: logoLinks() })
  const { track } = nodesOf(instance)
  track.clientWidth = 420
  track.children = Array.from({ length: 4 }, (_, index) => ({
    getBoundingClientRect: () => ({ left: index * 243, width: 219 }),
  }))
  nodesOf(instance).viewport.clientWidth = 420
  // No `animate` defined on the stand-in at all, which is what an engine without it looks like.
  instance.rerender()

  assert.ok(trackOf(instance.tree).props.children.length >= 2)
  assert.equal(linksIn(trackOf(instance.tree).props.children[0]).length, LOGOS.length)
})
