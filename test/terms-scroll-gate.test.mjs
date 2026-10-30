// The "scroll to accept" box everybody writes reads `scrollTop + clientHeight >= scrollHeight`, and
// every case below is written to fail against that version rather than to describe this one:
//
//   - at a browser zoom other than 100% the sum lands a fraction short of the total, so the agree
//     button never enables and the reader has no way out,
//   - a document shorter than its box never scrolls, so the same test locks a four-line policy
//     forever unless it is special-cased,
//   - a box that has not been laid out reports zeroes for all three, which *satisfies* the test:
//     the gate opens for terms that have never been on screen,
//   - and the latch is the other half — a gate that closes again when the reader scrolls back up to
//     re-read a clause is the second most common complaint about this pattern.
//
// None of those are fixed here; they are designed out by marking the end of the document with an
// element and watching it with an IntersectionObserver. So what the tests have to hold in place is
// that the observer is built the one way that works (no `root`, so the viewport measures it and
// every scroll container in between clips it), that the latch is one-way, and that a reset puts it
// back. The observer itself is the browser's; what is asserted here is how it is asked.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

// The real scroll-shadow, loaded rather than stubbed, for the reason breadcrumb-overflow loads the
// real split-button: a stub would turn the assertion that the composition works into an assertion
// about a copy, and the registryDependencies entry would then be decoration.
const scrollShadow = loadComponent(join(ROOT, "registry", "ui", "scroll-shadow.tsx"))

const { TermsScrollGate, useSeenOnce, defaultTermsScrollGateLabels } = loadComponent(
  join(ROOT, "registry", "ui", "terms-scroll-gate.tsx"),
  {
    stubs: {
      "lucide-react": { ArrowDown: icon("arrow-down") },
      "@/registry/ui/scroll-shadow": scrollShadow,
    },
  }
)

const { ScrollShadow } = scrollShadow

// --- the stub observer ---------------------------------------------------------------------------

/**
 * Replaces the global IntersectionObserver with one that records how it was built and what it was
 * asked to watch, and returns the list of instances in creation order.
 *
 * Node has none, which is itself load-bearing in one test below: a component whose gate silently
 * depends on an observer that is not there is a component that never opens.
 */
function stubObservers() {
  const instances = []
  globalThis.IntersectionObserver = class {
    constructor(callback, options) {
      this.callback = callback
      this.options = options
      this.observed = []
      this.disconnected = false
      instances.push(this)
    }
    observe(el) {
      this.observed.push(el)
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true
    }
    takeRecords() {
      return []
    }
  }
  return instances
}

function restoreObservers() {
  delete globalThis.IntersectionObserver
}

/** Delivers entries to the newest observer, the way the browser would. */
const sight = (instances, ...flags) =>
  instances[instances.length - 1].callback(
    flags.map((isIntersecting) => ({ isIntersecting })),
    instances[instances.length - 1]
  )

// --- the latch -----------------------------------------------------------------------------------

/** The hook on its own, with a ref the harness fills with a stand-in node. */
const latch = (props = {}) =>
  render(function Probe({ rootMargin, resetKey }) {
    const ref = { current: {} }
    return { type: "span", props: { "data-seen": useSeenOnce(ref, { rootMargin, resetKey }) } }
  }, props)

test("nothing is seen until the end of the document actually comes into view", () => {
  const instances = stubObservers()
  try {
    const view = latch()
    assert.equal(view.tree.props["data-seen"], false)
    assert.equal(instances.length, 1)

    // An entry arrives on the way out as well as on the way in, so the flag it carries is the
    // question, not the fact that a callback ran at all.
    sight(instances, false)
    view.rerender()
    assert.equal(view.tree.props["data-seen"], false)

    sight(instances, true)
    view.rerender()
    assert.equal(view.tree.props["data-seen"], true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("a batch counts if any entry in it intersects", () => {
  const instances = stubObservers()
  try {
    // Entries are delivered in batches and the newest is not last in any specified order; reading
    // only `entries[0]` or only `entries.at(-1)` drops the sighting roughly half the time.
    const view = latch()
    sight(instances, false, true)
    view.rerender()
    assert.equal(view.tree.props["data-seen"], true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("scrolling back up does not take it away", () => {
  const instances = stubObservers()
  try {
    const view = latch()
    sight(instances, true)
    view.rerender()
    sight(instances, false)
    view.rerender()
    // The reader reached the end and went back to re-read a clause. A gate that closes behind them
    // is the failure this latch exists for.
    assert.equal(view.tree.props["data-seen"], true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("once latched it stops watching, and unmounting lets the observer go", () => {
  const instances = stubObservers()
  try {
    const view = latch()
    sight(instances, true)
    view.rerender()
    // No second observer: the effect's early return is what frees a long page of these after the
    // reader has passed them. (The browser also disconnects the first one here, through the
    // dependency change; this harness runs cleanups only on unmount, so that is asserted there.)
    assert.equal(instances.length, 1)
    view.unmount()
    assert.equal(instances[0].disconnected, true)
  } finally {
    restoreObservers()
  }
})

test("a new document puts the gate back, during the same render", () => {
  const instances = stubObservers()
  try {
    const view = latch({ resetKey: "terms-v1" })
    sight(instances, true)
    view.rerender()
    assert.equal(view.tree.props["data-seen"], true)

    view.update({ resetKey: "terms-v2" })
    // Not one render later: an effect-based reset would let a commit through with the previous
    // document's latch still true, and that commit is one in which the agree button is live for
    // terms that are no longer on screen.
    assert.equal(view.tree.props["data-seen"], false)
    assert.equal(instances.length, 2, "the new document is watched again")

    sight(instances, true)
    view.rerender()
    assert.equal(view.tree.props["data-seen"], true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("the same key is not a new document", () => {
  const instances = stubObservers()
  try {
    const view = latch({ resetKey: "terms-v1" })
    sight(instances, true)
    view.rerender()
    view.update({ resetKey: "terms-v1" })
    assert.equal(view.tree.props["data-seen"], true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("the observer is built with no root, and takes a margin", () => {
  const instances = stubObservers()
  try {
    const view = latch()
    // The design decision, pinned: with the scrolling box as the root, the end marker sits inside
    // that box's own bounds whether or not any of it is on screen, so a caller who forgets to cap
    // the height gets a gate that opens instantly. Measured against the viewport instead — and
    // clipped by every scroll container in between — one observer covers both layouts.
    assert.equal("root" in instances[0].options, false)
    assert.equal(instances[0].options.rootMargin, "0px")
    assert.equal(instances[0].observed.length, 1)
    view.unmount()

    const margined = latch({ rootMargin: "0px 0px -40px 0px" })
    assert.equal(instances[1].options.rootMargin, "0px 0px -40px 0px")
    margined.unmount()
  } finally {
    restoreObservers()
  }
})

test("with no observer to use, the gate opens rather than trapping the reader", () => {
  // Node has none, so this is the unstubbed state. Latching open is the deliberate choice: a gate
  // that can never open leaves the form unsubmittable, and this was never evidence of reading.
  assert.equal(globalThis.IntersectionObserver, undefined, "the harness has none to use")
  const view = latch()
  assert.equal(view.tree.props["data-seen"], true)
  view.unmount()
})

// --- the component -------------------------------------------------------------------------------

/**
 * The element tree without invoking any function component.
 *
 * `walk` from the harness runs them to include their output, which for the real ScrollShadow would
 * mean its hooks running against this dispatcher outside a render pass. What these assertions are
 * about is what this component hands it, so the element is found by identity instead.
 */
const flatten = (node, out = []) => {
  if (node === null || node === undefined || typeof node !== "object") return out
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  out.push(node)
  return flatten(node.props?.children, out)
}

const boxOf = (view) => {
  const found = flatten(view.tree).filter((n) => n.type === ScrollShadow)
  assert.equal(found.length, 1)
  return found[0].props
}

const statusOf = (view) => {
  const found = flatten(view.tree).filter((n) => n.props?.role === "status")
  assert.equal(found.length, 1)
  return found[0].props
}

const DOC = { type: "p", props: { children: "…terms…" } }

test("before the end has been seen the control is told so, and told why", () => {
  stubObservers()
  try {
    const seen = []
    const view = render(TermsScrollGate, {
      "aria-label": "Terms of service",
      children: DOC,
      action: (state) => {
        seen.push(state)
        return { type: "button", props: { "aria-disabled": !state.reached } }
      },
    })

    assert.equal(seen.at(-1).reached, false)
    const status = statusOf(view)
    assert.equal(status.children.at(-1), "Scroll to the end to continue")
    // The status line is what a screen reader user who lands on a control that does nothing has to
    // go on, so the control is handed its id rather than left to invent one.
    assert.equal(seen.at(-1).descriptionId, status.id)
    assert.equal(boxOf(view)["aria-describedby"], status.id)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("reaching the end flips the control and the status together", () => {
  const instances = stubObservers()
  try {
    const seen = []
    const view = render(TermsScrollGate, {
      "aria-label": "Terms",
      children: DOC,
      action: (state) => {
        seen.push(state)
        return null
      },
    })
    sight(instances, true)
    view.rerender()

    assert.equal(seen.at(-1).reached, true)
    const status = statusOf(view)
    assert.equal(status.children.at(-1), "You've reached the end")
    // What was displayed, not what was read: this component cannot tell the difference and the
    // label is not allowed to imply that it can.
    assert.match(status.children.at(-1), /reached the end/)
    assert.equal(status.children[0], null, "the arrow goes once there is nothing left to point at")
    // One live region holding one of two strings, so this is announced once, when it happens —
    // not a percentage read out over the document the reader is trying to read.
    assert.equal(status["aria-live"], "polite")
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("onReachEnd fires once per transition, not once per render", () => {
  const instances = stubObservers()
  try {
    let calls = 0
    const props = {
      "aria-label": "Terms",
      children: DOC,
      resetKey: "v1",
      onReachEnd: () => {
        calls += 1
      },
    }
    const view = render(TermsScrollGate, props)
    assert.equal(calls, 0)

    sight(instances, true)
    view.rerender()
    assert.equal(calls, 1)

    // The harness runs every effect on every pass, which is also what StrictMode's double
    // invocation does in development: an effect keyed on the flag alone fires again here.
    view.rerender()
    view.rerender()
    assert.equal(calls, 1)

    view.update({ ...props, resetKey: "v2" })
    sight(instances, true)
    view.rerender()
    assert.equal(calls, 2, "a new document that is read to the end is a new transition")
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("the name goes to the box that scrolls, not to the wrapper", () => {
  stubObservers()
  try {
    const view = render(TermsScrollGate, {
      "aria-label": "Terms of service",
      className: "max-w-prose",
      boxClassName: "border-destructive",
      viewportClassName: "max-h-96",
      children: DOC,
    })
    const box = boxOf(view)
    assert.equal(box["aria-label"], "Terms of service")
    assert.match(box.className, /border-destructive/)
    // The scrolling element is the thing that takes focus and the thing a reader navigates to, so
    // the name has to be on it. Left on the wrapper it names a div nobody can reach.
    assert.equal(view.tree.props["aria-label"], undefined)
    assert.match(view.tree.props.className, /max-w-prose/)
    assert.match(box.viewportClassName, /max-h-96/)
    // A cap on the height by default: without one the box does not scroll, and the gate then rests
    // entirely on the page being scrolled to the document's last line.
    assert.match(box.viewportClassName, /max-h-72/)
    assert.equal(box.orientation, "vertical")
    // Left for CSS to hang off, the way scroll-shadow leaves its edges: a caller who wants the box
     // itself to change when the end has been reached should not have to re-derive the state.
    assert.equal(view.tree.props["data-reached"], undefined)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("a heading can name the region instead of a label", () => {
  stubObservers()
  try {
    // The usual shape of a consent box is a visible heading above the text, and pointing at it is
    // better than repeating it in an aria-label that can then drift from what is on screen.
    const view = render(TermsScrollGate, { "aria-labelledby": "terms-heading", children: DOC })
    assert.equal(boxOf(view)["aria-labelledby"], "terms-heading")
    assert.equal(view.tree.props["aria-labelledby"], undefined)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("the hint arrow is hidden from assistive technology", () => {
  stubObservers()
  try {
    const view = render(TermsScrollGate, { "aria-label": "Terms", children: DOC })
    // It is pointing at the scroll it is asking for, and the status line beside it already says so
    // in words — announced as well it is one more thing read out over the document.
    assert.equal(statusOf(view).children[0].props["aria-hidden"], "true")
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("a gate that opens immediately still reports that it opened", () => {
  // No observer, so the gate latches open during the first settle rather than on a later callback.
  // The caller still has to hear about it: onReachEnd is how the opening is recorded, and a
  // component that only fires it on a *change* it observed would stay silent in exactly the case
  // where there was nothing to observe.
  assert.equal(globalThis.IntersectionObserver, undefined, "the harness has none to use")
  let calls = 0
  const view = render(TermsScrollGate, {
    "aria-label": "Terms",
    children: DOC,
    onReachEnd: () => {
      calls += 1
    },
  })
  assert.equal(statusOf(view).children.at(-1), defaultTermsScrollGateLabels.reached)
  assert.equal(calls, 1)
  view.rerender()
  assert.equal(calls, 1)
  view.unmount()
})

test("the end marker is the last thing inside the scroller, and says nothing", () => {
  stubObservers()
  try {
    const view = render(TermsScrollGate, { "aria-label": "Terms", children: DOC })
    const children = flatten(boxOf(view).children)
    const marker = children.at(-1)

    assert.equal(marker.props["aria-hidden"], "true")
    // A pixel, because a zero-height element has no area to intersect with — it would never be
    // reported as visible and the gate would never open.
    assert.match(marker.props.className, /\bh-px\b/)
    // And it must not be allowed to collapse: this lands inside whatever layout the caller's
    // content is in, and in a flex column a 1px item with no shrink rule is a 0px item.
    assert.match(marker.props.className, /\bshrink-0\b/)
    assert.equal(marker.props.children, undefined)
    assert.equal(children.indexOf(DOC) < children.indexOf(marker), true)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("scrollToEnd asks for the marker, by every ancestor that needs it", () => {
  stubObservers()
  try {
    let state = null
    const view = render(TermsScrollGate, {
      "aria-label": "Terms",
      children: DOC,
      action: (s) => {
        state = s
        return null
      },
    })
    state.scrollToEnd()

    // The marker's own ref, which the harness filled with a stand-in that records what was called
    // on it. `scrollIntoView` rather than scrolling the box by its own coordinates: the end may be
    // out of view because the box is scrolled, because the page is, or because both are.
    const [node] = view.nodes.filter((n) => n.calls.some((c) => c.name === "scrollIntoView"))
    assert.ok(node, "nothing was asked to scroll")
    assert.deepEqual(node.calls.at(-1).args, [{ block: "end", inline: "nearest" }])
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("labels can be replaced one at a time", () => {
  const instances = stubObservers()
  try {
    const view = render(TermsScrollGate, {
      "aria-label": "Terms",
      children: DOC,
      labels: { more: "Weiterlesen, um fortzufahren" },
    })
    assert.equal(statusOf(view).children.at(-1), "Weiterlesen, um fortzufahren")
    sight(instances, true)
    view.rerender()
    assert.equal(statusOf(view).children.at(-1), defaultTermsScrollGateLabels.reached)
    view.unmount()
  } finally {
    restoreObservers()
  }
})

test("the composition reaches the element that actually scrolls", () => {
  stubObservers()
  try {
    // The one test that renders through the real ScrollShadow rather than stopping at its element,
    // so that "the marker ends up inside the scrolling box" is asserted rather than assumed. It
    // runs ScrollShadow's hooks against this dispatcher out of order, so nothing is re-rendered
    // after this point — see the note on `flatten`.
    const view = render(TermsScrollGate, { "aria-label": "Terms of service", children: DOC })
    const divs = byTag(walk(view.tree), "div")
    const viewport = divs.find((d) => d.props["aria-label"] === "Terms of service")
    assert.ok(viewport, "the scrolling element never got the name")

    const inside = flatten(viewport.props.children)
    assert.ok(inside.some((n) => n.props?.["aria-hidden"] === "true" && n.props?.className?.includes("h-px")))
    // The gate is only as honest as this: the marker has to be clipped by the box the reader
    // scrolls, which means being inside the element that has the overflow on it.
    assert.match(viewport.props.className, /overflow-y-auto/)
    view.unmount()
  } finally {
    restoreObservers()
  }
})
