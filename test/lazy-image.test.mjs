// The naive version of this component is `<img loading="lazy" onLoad={...}>` with a `loaded`
// boolean, and every case below is written to pass against the shipped implementation and fail
// against a version that looks right:
//
//   - a status driven by `onLoad` alone, which never arrives for an image the browser had already
//     finished with before React attached the handler (hydration, and a second visit to a cached
//     URL) — the placeholder then stays forever on the fastest images,
//   - a status read from `complete` alone, which reports a 404 as a successful load because
//     `complete` is true after a failure too,
//   - that same reading applied before there is a `src`, which reports "error" for an image nobody
//     has asked to load yet,
//   - an `onError` that answers every error by assigning the fallback, which is a loop as soon as
//     the fallback is itself missing,
//   - a fallback that is not rearmed when `src` changes, so one broken image in a gallery leaves
//     every later one showing the placeholder,
//   - a `src` change handled in an effect rather than during render, which shows the previous
//     picture's "loaded" state under the new URL for one commit,
//   - space reserved with the `width`/`height` attributes alone, which compute to
//     `aspect-ratio: auto W / H` and so still reshape the box when the declared ratio is wrong,
//   - a skeleton left under the picture, which shows through anything transparent,
//   - `aria-busy` left on a broken image, which is not busy,
//   - an IntersectionObserver added on top of native laziness, which fetches twice.
//
// The browser facts these rest on were measured in the preview browser rather than recalled; the
// figures are in the component's own comments.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { LazyImage, useLazyImage, readImageStatus, nextSourceAfterError, reserveRatio } =
  loadComponent(join(ROOT, "registry", "ui", "lazy-image.tsx"))

const SRC = "/photo.jpg"
const FALLBACK = "/placeholder.jpg"

/** The one element this renders. Its absence is itself a case worth failing on. */
const img = (view) => {
  const found = byTag(walk(view.tree), "img")
  assert.equal(found.length, 1, "the component must stay a single <img> with no wrapper")
  return found[0].props
}

// --- the decision, without a DOM ---------------------------------------------------------------

test("an element says nothing until it is complete", () => {
  assert.equal(readImageStatus({ complete: false, naturalWidth: 0 }, SRC), null)
  assert.equal(readImageStatus(null, SRC), null)
  assert.equal(readImageStatus(undefined, SRC), null)
})

test("a complete element with pixels loaded, and one without them failed", () => {
  assert.equal(readImageStatus({ complete: true, naturalWidth: 120 }, SRC), "loaded")
  // Measured: a 404 leaves complete true and naturalWidth 0. Reading `complete` alone calls this
  // one a success, which is how a broken image ends up announced as loaded.
  assert.equal(readImageStatus({ complete: true, naturalWidth: 0 }, SRC), "error")
  // One pixel is still an image. Spacer and tracking pixels are a pixel wide, and the boundary has
  // to sit under them rather than on them.
  assert.equal(readImageStatus({ complete: true, naturalWidth: 1 }, SRC), "loaded")
  // Nothing decoded and nothing reported is a failure, not a success: anything that treats a
  // missing width as "probably fine" announces a broken image as loaded.
  assert.equal(readImageStatus({ complete: true }, SRC), "error")
})

test("an element with no src is not a failure, however complete it claims to be", () => {
  // Measured: an <img> with no src at all, and one with src="", both report complete === true and
  // naturalWidth === 0 — identical to a 404. Without the src in this decision every image renders
  // as "error" for its first commit.
  assert.equal(readImageStatus({ complete: true, naturalWidth: 0 }, undefined), null)
  assert.equal(readImageStatus({ complete: true, naturalWidth: 0 }, ""), null)
})

test("the fallback is offered once and then never again", () => {
  assert.equal(nextSourceAfterError(SRC, FALLBACK), FALLBACK)
  // The second failure is the fallback's own. Measured: swapping src from one 404 to another fires
  // error again, so anything that keeps answering with the fallback never stops.
  assert.equal(nextSourceAfterError(FALLBACK, FALLBACK), null)
  assert.equal(nextSourceAfterError(SRC, undefined), null)
})

test("a declared ratio becomes the explicit form, never `auto`", () => {
  // `auto W / H` is what the width/height attributes compute to, and `auto` is the part that lets
  // the box reshape later. Nothing here may produce it.
  assert.equal(reserveRatio(120, 90, undefined), "120 / 90")
  assert.equal(reserveRatio("120", "90", undefined), "120 / 90")
  assert.equal(reserveRatio(undefined, undefined, "16 / 9"), "16 / 9")
  assert.equal(reserveRatio(undefined, undefined, 1.5), "1.5")
  // An explicit ratio is the caller overriding the file's own shape, so it wins.
  assert.equal(reserveRatio(120, 90, "1 / 1"), "1 / 1")
})

test("nothing is reserved when nothing usable was declared", () => {
  assert.equal(reserveRatio(undefined, undefined, undefined), undefined)
  assert.equal(reserveRatio(120, undefined, undefined), undefined)
  // A zero would divide the box to nothing, and a percentage is not a ratio.
  assert.equal(reserveRatio(120, 0, undefined), undefined)
  assert.equal(reserveRatio("100%", "auto", undefined), undefined)
  // One side non-finite is enough to make the pair useless, and it arrives looking like a number —
  // a height worked out by dividing by zero is `Infinity`, which is truthy.
  assert.equal(reserveRatio(120, Infinity, undefined), undefined)
  assert.equal(reserveRatio(Infinity, 90, undefined), undefined)
})

// --- the element ---------------------------------------------------------------------------------

/** Seeds the stand-in the component is holding with what a real element would be reporting. */
const asLoaded = (node) => Object.assign(node, { complete: true, naturalWidth: 120 })
const asBroken = (node) => Object.assign(node, { complete: true, naturalWidth: 0 })

test("an image that was already complete at mount settles without any event", () => {
  const view = render(LazyImage, { src: SRC, alt: "", width: 120, height: 90 })
  assert.equal(img(view)["aria-busy"], true, "it starts out busy")

  // No load event is fired here on purpose: this is the hydration case, where the browser finished
  // with the image before React attached a handler and no event is ever coming.
  asLoaded(view.nodes[0])
  view.rerender()

  const props = img(view)
  assert.equal(props["aria-busy"], undefined)
  assert.ok(!props.className.includes("animate-pulse"), "the skeleton must come off")
  view.unmount()
})

test("a fallback that fails too settles instead of looping", () => {
  const view = render(LazyImage, { src: SRC, fallbackSrc: FALLBACK, alt: "" })
  // Both URLs broken: the element reports naturalWidth 0 whichever one is set, so the status is
  // re-decided on every commit and nothing may send it round again. One rerender walks the whole
  // path — src fails, the fallback is tried, the fallback fails — and has to come to rest.
  asBroken(view.nodes[0])
  view.rerender()
  const props = img(view)
  assert.equal(props.src, FALLBACK, "it stays on the last thing it tried")
  assert.equal(props["aria-busy"], undefined)
  assert.ok(props.className.includes("bg-muted"))
  view.unmount()
})

test("without a fallback a failure is simply the end state", () => {
  const view = render(LazyImage, { src: SRC, alt: "" })
  asBroken(view.nodes[0])
  view.rerender()
  const props = img(view)
  assert.equal(props.src, SRC)
  assert.equal(props["aria-busy"], undefined, "a broken image is not busy")
  assert.ok(props.className.includes("bg-muted"))
  view.unmount()
})

test("a new src starts over and rearms the fallback", () => {
  const view = render(LazyImage, { src: SRC, fallbackSrc: FALLBACK, alt: "" })
  asBroken(view.nodes[0])
  view.rerender()
  assert.equal(img(view).src, FALLBACK)

  // A gallery pages to the next picture. The previous one's exhausted fallback must not be
  // inherited, and the new URL must not be shown as loaded for even one commit.
  Object.assign(view.nodes[0], { complete: false, naturalWidth: 0 })
  view.update({ src: "/next.jpg", fallbackSrc: FALLBACK, alt: "" })
  const fresh = img(view)
  assert.equal(fresh.src, "/next.jpg")
  assert.equal(fresh["aria-busy"], true)

  asBroken(view.nodes[0])
  view.rerender()
  assert.equal(img(view).src, FALLBACK, "the fallback is available again for the new src")
  view.unmount()
})

test("the load event is not believed over the element", () => {
  const view = render(LazyImage, { src: SRC, alt: "" })
  // Some failures arrive as a load event rather than an error one; naturalWidth is the only thing
  // that tells them apart, so the handler re-reads the target instead of trusting the event.
  img(view).onLoad({ currentTarget: { complete: true, naturalWidth: 0 } })
  view.rerender()
  assert.ok(img(view).className.includes("bg-muted"))
  assert.equal(img(view)["aria-busy"], undefined)
  view.unmount()
})

test("a load event settles an image the element had not caught up with", () => {
  const seen = []
  const view = render(LazyImage, { src: SRC, alt: "", onStatusChange: (s) => seen.push(s) })
  img(view).onLoad({ currentTarget: { complete: true, naturalWidth: 120 } })
  view.rerender()
  assert.equal(img(view)["aria-busy"], undefined)
  // The reported status is checked by name, not merely "no longer loading": every state that is
  // not `loading` drops aria-busy, so that assertion alone cannot tell success from anything else.
  assert.deepEqual(seen, ["loading", "loaded"])
  view.unmount()
})

test("an error moves to the fallback as a fresh attempt", () => {
  const view = render(LazyImage, { src: SRC, fallbackSrc: FALLBACK, alt: "" })
  assert.equal(img(view).src, SRC)

  // Through the event, which is the order a browser really does this in: the error arrives while
  // the element is still the one that failed, and assigning the fallback puts it back in flight.
  // (Seeding the stand-in as broken instead would have it still reporting the first URL's failure
  // when the effect re-reads it, and the fallback would be judged on that — see the test above.)
  img(view).onError()
  view.rerender()
  const props = img(view)
  assert.equal(props.src, FALLBACK)
  assert.equal(props["aria-busy"], true, "the fallback is being fetched, so it is busy again")
  view.unmount()
})

test("it defers its own fetch, and says so with the attribute rather than an observer", () => {
  const view = render(LazyImage, { src: SRC, alt: "" })
  const props = img(view)
  assert.equal(props.loading, "lazy")
  assert.equal(props.decoding, "async")
  assert.equal(props.fetchPriority, undefined)
  // Measured 5,000px below the fold: the native attribute really does defer, so an
  // IntersectionObserver on top of it would only fetch the same bytes a second time.
  assert.equal(globalThis.IntersectionObserver, undefined, "the harness has none to use")
  view.unmount()
})

test("the one that is already on screen opts out", () => {
  const view = render(LazyImage, { src: SRC, alt: "", eager: true })
  const props = img(view)
  assert.equal(props.loading, "eager")
  assert.equal(props.fetchPriority, "high")
  // Left at the browser's default: sync decoding can hold up the very paint this is meant to help,
  // and that was not measured.
  assert.equal(props.decoding, undefined)
  view.unmount()
})

test("the box is pinned from the first frame", () => {
  const view = render(LazyImage, { src: SRC, alt: "", width: 120, height: 90 })
  const props = img(view)
  assert.equal(props.style.aspectRatio, "120 / 90")
  // The attributes go through as well: they are what a page with no CSS at all has to go on.
  assert.equal(props.width, 120)
  assert.equal(props.height, 90)
  // Pinning the ratio is only half of it — a file of a different shape would be stretched to fill
  // the box unless the fit is stated.
  assert.ok(props.className.includes("object-cover"))
  view.unmount()
})

test("every fit maps to its own utility, and only its own", () => {
  // Pinning the box makes the fit load-bearing rather than cosmetic, so each value is checked
  // rather than just the default: a mapping that silently falls through leaves `object-fill`'s
  // stretch in place for somebody who explicitly asked for `contain`.
  const expected = {
    cover: "object-cover",
    contain: "object-contain",
    fill: "object-fill",
    none: "object-none",
    "scale-down": "object-scale-down",
  }
  for (const [fit, utility] of Object.entries(expected)) {
    const view = render(LazyImage, { src: SRC, alt: "", fit })
    const classes = img(view).className.split(/\s+/)
    assert.ok(classes.includes(utility), `${fit} must set ${utility}`)
    for (const other of Object.values(expected)) {
      if (other === utility) continue
      assert.ok(!classes.includes(other), `${fit} must not also set ${other}`)
    }
    view.unmount()
  }
})

test("the caller's own style wins over the reserved ratio", () => {
  const view = render(LazyImage, {
    src: SRC,
    alt: "",
    width: 120,
    height: 90,
    style: { aspectRatio: "1 / 1" },
  })
  assert.equal(img(view).style.aspectRatio, "1 / 1")
  view.unmount()
})

test("a preview is drawn in the box, and is gone once the picture is there", () => {
  const preview = "data:image/png;base64,AAAA"
  const view = render(LazyImage, { src: SRC, alt: "", placeholder: preview })
  const loading = img(view)
  assert.equal(loading.style.backgroundImage, `url(${JSON.stringify(preview)})`)
  // A preview of a different shape to the box is the normal case, and the box is pinned — without
  // these two it is drawn at its own size in the corner instead of filling what it stands in for.
  assert.equal(loading.style.backgroundSize, "cover")
  assert.equal(loading.style.backgroundPosition, "center")
  assert.ok(
    !loading.className.includes("animate-pulse"),
    "a preview and a pulsing skeleton must not both be drawn"
  )

  asLoaded(view.nodes[0])
  view.rerender()
  const loaded = img(view)
  assert.equal(loaded.style.backgroundImage, undefined)
  assert.equal(loaded.style.backgroundSize, undefined)
  assert.equal(loaded.style.backgroundPosition, undefined)
  assert.ok(!loaded.className.includes("bg-muted"), "a transparent png would show it through")
  view.unmount()
})

test("the skeleton pulses only when there is no preview to draw instead", () => {
  const view = render(LazyImage, { src: SRC, alt: "" })
  const classes = img(view).className
  assert.ok(classes.includes("animate-pulse"))
  assert.ok(classes.includes("bg-muted"))
  assert.equal(img(view).style.backgroundSize, undefined)
  view.unmount()
})

test("the status is reported as it changes, and not again for the same value", () => {
  const seen = []
  const view = render(LazyImage, { src: SRC, alt: "", onStatusChange: (s) => seen.push(s) })
  assert.deepEqual(seen, ["loading"])

  asLoaded(view.nodes[0])
  view.rerender()
  view.rerender()
  assert.deepEqual(seen, ["loading", "loaded"])
  view.unmount()
})

test("the hook carries the whole lifecycle for an img of your own", () => {
  const Probe = (props) => {
    const load = useLazyImage(props)
    return { type: "img", props: { src: load.currentSrc, "data-status": load.status, ref: load.ref } }
  }
  const view = render(Probe, { src: SRC, fallbackSrc: FALLBACK })
  assert.equal(view.tree.props["data-status"], "loading")

  asBroken(view.nodes[0])
  view.rerender()
  assert.equal(view.tree.props.src, FALLBACK)
  view.unmount()
})

test("the alt text is passed through, including the empty string that means decoration", () => {
  const described = render(LazyImage, { src: SRC, alt: "A harbour at dusk" })
  assert.equal(img(described).alt, "A harbour at dusk")
  described.unmount()

  const decorative = render(LazyImage, { src: SRC, alt: "" })
  assert.equal(img(decorative).alt, "", "an empty alt is a decision and has to survive")
  decorative.unmount()
})
