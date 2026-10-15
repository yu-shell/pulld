// The version everyone writes first is `title={name}` on every cell, and the version after that
// measures once on mount. The cases below are written to fail against both, and against the
// near-misses around them:
//
//   - a tooltip (and a tab stop) on text that was never clipped, which is the more expensive
//     mistake: a tooltip on every cell is a table that flickers boxes as the pointer crosses it,
//     and a tab stop on every cell is a table a keyboard cannot get past,
//   - the `title` attribute, which cannot be styled or dismissed, never appears on touch, and is a
//     second copy of text the screen reader already has — CSS clips the paint, not the DOM,
//   - and the same mistake made in ARIA instead, by pointing `aria-describedby` at a tooltip that
//     repeats the element's own text,
//   - a width comparison used on a `-webkit-line-clamp` paragraph, where the overflow is vertical
//     and the width test reports "fits" about every clamped paragraph it is ever given,
//   - measuring once, before the web font has swapped in, which answers "it fits" and never
//     revisits it,
//   - no ResizeObserver, so dragging a column narrower clips the text and nothing notices,
//   - a tooltip left on screen after the column was widened under the pointer and there is
//     nothing left to show,
//   - and Escape closing the dialog this sits in rather than the tooltip on top of it.
//
// The harness has no layout, so every measurement is supplied: `textNode()` below is the only
// place scrollWidth and clientWidth come from, and the arithmetic over them is asserted directly
// as a function. The numbers those cases use were measured in a browser — a sub-pixel sweep, a
// font swap and a line clamp — and the findings are recorded in the component source.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const { isOverflowing, useIsOverflowing, OverflowTooltip } = loadComponent(
  join(ROOT, "registry", "ui", "overflow-tooltip.tsx")
)

const observers = []
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback
    this.observed = []
    observers.push(this)
  }
  observe(target) {
    this.observed.push(target)
  }
  disconnect() {
    this.observed.length = 0
  }
}

/** `document.fonts.ready`, held open so a test can decide when the face arrives. */
let resolveFonts
globalThis.document = {
  fonts: {
    get ready() {
      return new Promise((resolve) => {
        resolveFonts = resolve
      })
    },
  },
}

const metrics = ({ over = 0, down = 0 } = {}) => ({
  scrollWidth: 200 + over,
  clientWidth: 200,
  scrollHeight: 40 + down,
  clientHeight: 40,
})

// --- the predicate ---------------------------------------------------------------------------

test("a line is clipped when its text is wider than its box", () => {
  assert.equal(isOverflowing(metrics({ over: 0 })), false)
  assert.equal(isOverflowing(metrics({ over: 220 })), true)
})

test("a pixel of rounding is not a truncation", () => {
  // Measured: a box 0.2px too narrow for its text already reports an overflow of 1, because
  // scrollWidth and clientWidth are integers and the rounding has to go somewhere. A fifth of a
  // pixel off the last glyph is not worth interrupting a table for.
  assert.equal(isOverflowing(metrics({ over: 1 })), false)
  assert.equal(isOverflowing(metrics({ over: 2 })), true)
})

test("the slack is the caller's to set", () => {
  assert.equal(isOverflowing(metrics({ over: 6 }), { threshold: 8 }), false)
  assert.equal(isOverflowing(metrics({ over: 6 }), { threshold: 0 }), true)
})

test("a clamped paragraph overflows downwards, where a width test cannot see it", () => {
  // Measured on a two-line clamp: 0 pixels of horizontal overflow, 51 of vertical. A component
  // that only compares widths says "not truncated" about every clamped paragraph.
  const clamped = metrics({ over: 0, down: 51 })
  assert.equal(isOverflowing(clamped, { lines: 1 }), false, "the width test cannot see it")
  assert.equal(isOverflowing(clamped, { lines: 2 }), true)
})

test("a single line that wraps nowhere is not judged on its height", () => {
  assert.equal(isOverflowing(metrics({ over: 0, down: 51 }), { lines: 1 }), false)
})

test("a clamped paragraph that fits its lines is not clipped either", () => {
  // The vertical axis gets the same pixel of slack as the horizontal one, and the same refusal to
  // call a box that fits an overflow.
  assert.equal(isOverflowing(metrics({ down: 0 }), { lines: 2 }), false)
  assert.equal(isOverflowing(metrics({ down: 1 }), { lines: 2 }), false)
  assert.equal(isOverflowing(metrics({ down: 2 }), { lines: 2 }), true)
})

// --- the component ---------------------------------------------------------------------------

/** A stand-in for the measured element, whose reported size the test controls. */
function textNode({ over = 0, down = 0 } = {}) {
  return {
    scrollWidth: 200 + over,
    clientWidth: 200,
    scrollHeight: 40 + down,
    clientHeight: 40,
  }
}

/**
 * Renders with the inner text node measuring as given.
 *
 * The component holds two refs and only the inner one is measured; the harness fills both with
 * stand-ins in `useRef` order, so the sizes are written onto the one the component reads.
 */
function mount(props = {}, size) {
  observers.length = 0
  const view = render(OverflowTooltip, { children: "Quarterly report 2026 — final", ...props })
  Object.assign(view.nodes[0], textNode(size))
  view.rerender()
  return view
}

const find = (view, predicate) => walk(view.tree).find(predicate)
const tooltip = (view) => find(view, (n) => n.props?.role === "tooltip")
const textSpan = (view) => walk(view.tree).filter((n) => n.type === "span")[1]
const wrapper = (view) => walk(view.tree)[0]

test("text that fits is a plain span: no tab stop, no handlers that do anything", () => {
  const view = mount({}, { over: 0 })
  assert.equal(textSpan(view).props.tabIndex, undefined, "no tab stop on a cell that fits")
  assert.equal(tooltip(view), undefined)

  // The handlers are attached but inert, which is what keeps a table of a thousand cells from
  // opening a thousand tooltips.
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view), undefined, "focus on a cell that fits opens nothing")
})

test("clipped text takes a tab stop, because hovering is not available to everyone", () => {
  const view = mount({}, { over: 220 })
  assert.equal(textSpan(view).props.tabIndex, 0)
  assert.equal(tooltip(view), undefined, "but the tooltip stays shut until asked for")
})

test("a cell that fits carries no focus ring either", () => {
  const fits = mount({}, { over: 0 })
  assert.equal(String(textSpan(fits).props.className).includes("focus-visible:ring"), false)
  const clipped = mount({}, { over: 220 })
  assert(String(textSpan(clipped).props.className).includes("focus-visible:ring"))
})

test("focus opens the tooltip at once, and blur closes it", () => {
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  const tip = tooltip(view)
  assert(tip, "the tooltip is open")
  assert.equal(tip.props.children, "Quarterly report 2026 — final")

  wrapper(view).props.onBlur()
  view.rerender()
  assert.equal(tooltip(view), undefined)
})

test("the pointer waits; the tooltip is not opened on the way past", () => {
  const view = mount({}, { over: 220 })
  const timers = []
  const realSetTimeout = globalThis.window?.setTimeout
  globalThis.window = {
    setTimeout: (fn, ms) => timers.push({ fn, ms }) || 1,
    clearTimeout: () => {},
  }
  try {
    wrapper(view).props.onPointerEnter()
    view.rerender()
    assert.equal(tooltip(view), undefined, "not open yet")
    assert.equal(timers.length, 1, "a delay was scheduled")
    assert.equal(timers[0].ms, 300, "the default rest before a tooltip appears")
    timers[0].fn()
    view.rerender()
    assert(tooltip(view), "open once the pointer has rested")
  } finally {
    if (realSetTimeout) globalThis.window.setTimeout = realSetTimeout
  }
})

test("it never writes a title attribute", () => {
  // `title` cannot be styled or dismissed, does not appear on touch, and is a second copy of text
  // the screen reader already has.
  const view = mount({}, { over: 220 })
  for (const node of walk(view.tree)) {
    assert.equal(node.props?.title, undefined)
  }
})

test("the tooltip is not announced, because the text was never hidden from a screen reader", () => {
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view).props["aria-hidden"], "true")
  // The same mistake in ARIA: describing an element with a copy of its own text.
  for (const node of walk(view.tree)) {
    assert.equal(node.props?.["aria-describedby"], undefined)
  }
})

test("Escape closes the tooltip and stops there", () => {
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()

  let propagated = true
  wrapper(view).props.onKeyDown({
    key: "Escape",
    stopPropagation: () => {
      propagated = false
    },
  })
  view.rerender()
  assert.equal(tooltip(view), undefined)
  assert.equal(propagated, false, "the dialog underneath should not also close")
})

test("Escape with nothing open is left to whatever is underneath", () => {
  const view = mount({}, { over: 220 })
  let propagated = true
  wrapper(view).props.onKeyDown({
    key: "Escape",
    stopPropagation: () => {
      propagated = false
    },
  })
  assert.equal(propagated, true)
})

test("widening the column under an open tooltip closes it", () => {
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert(tooltip(view))

  Object.assign(view.nodes[0], textNode({ over: 0 })) // the column was dragged wider
  observers.forEach((o) => o.callback())
  view.rerender()
  assert.equal(tooltip(view), undefined, "nothing left to show")
  assert.equal(textSpan(view).props.tabIndex, undefined, "and nothing left to tab to")
})

test("a resize is what notices the clipping; nothing else fires", () => {
  const view = mount({}, { over: 0 })
  assert.equal(textSpan(view).props.tabIndex, undefined)
  assert.equal(observers.length >= 1, true, "the element is observed")
  assert(observers.at(-1).observed.includes(view.nodes[0]), "the measured element, not the wrapper")

  Object.assign(view.nodes[0], textNode({ over: 220 })) // a sidebar opened and squeezed the column
  observers.forEach((o) => o.callback())
  view.rerender()
  assert.equal(textSpan(view).props.tabIndex, 0)
})

test("the late-arriving font gets a second measurement", async () => {
  // Measured: a box sized for the fallback face reports that its text fits, and the same box is 8
  // pixels over once the real face swaps in. Measuring once is wrong from then on, and wrong in
  // the direction that says a clipped cell is fine.
  const view = mount({}, { over: 0 })
  assert.equal(textSpan(view).props.tabIndex, undefined, "fits, in the fallback face")

  Object.assign(view.nodes[0], textNode({ over: 8 }))
  resolveFonts()
  await Promise.resolve()
  await Promise.resolve()
  view.rerender()
  assert.equal(textSpan(view).props.tabIndex, 0, "clipped, once the real face arrived")
})

test("disabled gives up the tab stop and the tooltip, keeping the clipping", () => {
  const view = mount({ disabled: true }, { over: 220 })
  assert.equal(textSpan(view).props.tabIndex, undefined)
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view), undefined)
  assert(String(textSpan(view).props.className).includes("truncate"), "still clipped")
})

test("onOverflowChange reports the verdict, and only when it changes", () => {
  const seen = []
  const view = render(OverflowTooltip, {
    children: "Quarterly report",
    onOverflowChange: (v) => seen.push(v),
  })
  Object.assign(view.nodes[0], textNode({ over: 0 }))
  view.rerender()
  assert.deepEqual(seen, [false])

  Object.assign(view.nodes[0], textNode({ over: 220 }))
  observers.forEach((o) => o.callback())
  view.rerender()
  assert.deepEqual(seen, [false, true])
})

test("one line truncates with a class; several clamp with a style the build cannot drop", () => {
  const single = mount({}, { over: 220 })
  assert(String(textSpan(single).props.className).includes("truncate"))
  assert.equal(textSpan(single).props.style, undefined)

  // `line-clamp-7` is not generated unless something in the project already wrote it, so a prop
  // that takes a number has to set the property rather than name a class.
  const many = mount({ lines: 7 }, { down: 90 })
  // The clamp only clips if the box hides what it pushes out.
  assert(String(textSpan(many).props.className).includes("overflow-hidden"))
  assert.deepEqual(textSpan(many).props.style, {
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 7,
  })
  assert.equal(String(textSpan(many).props.className).includes("truncate"), false)
})

test("mixed content needs the full text spelled out, and says nothing without it", () => {
  const highlighted = { type: "mark", props: { children: "Quarterly" } }
  const view = mount({ children: [highlighted, " report 2026"] }, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view), undefined, "no label: nothing invented")

  const labelled = mount(
    { children: [highlighted, " report 2026"], label: "Quarterly report 2026" },
    { over: 220 }
  )
  wrapper(labelled).props.onFocus()
  labelled.rerender()
  assert.equal(tooltip(labelled).props.children, "Quarterly report 2026")
})

test("the tooltip can sit below, for the row at the top of a table", () => {
  const view = mount({ side: "bottom" }, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  const cls = String(tooltip(view).props.className)
  assert(cls.includes("top-full"))
  assert.equal(cls.includes("bottom-full"), false)
})

test("by default it sits above the text", () => {
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert(String(tooltip(view).props.className).includes("bottom-full"))
})

test("a blank label is nothing to show, not an empty box", () => {
  const view = mount({ label: "   " }, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view), undefined)
})

test("an empty label means nothing to show, and is not a request to fall back", () => {
  // `label=""` is what a caller computing the text from data produces for a row that has none.
  // Falling back to the children there would show the clipped string as its own tooltip.
  const view = mount({ label: "", children: "Quarterly report 2026" }, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  assert.equal(tooltip(view), undefined)
})

test("the tooltip does not sit inside the element being measured", () => {
  // It would otherwise be part of what `scrollWidth` reports, and the component would measure the
  // thing it just added.
  const view = mount({}, { over: 220 })
  wrapper(view).props.onFocus()
  view.rerender()
  const inner = textSpan(view)
  assert.equal(
    walk(inner).some((n) => n.props?.role === "tooltip"),
    false
  )
  assert(tooltip(view), "it is a sibling, not a child")
})

test("a caller's own handlers run as well, not instead", () => {
  // Spread after the component's own, a caller's onFocus replaces the one that opens the tooltip
  // and the component quietly stops working.
  const seen = []
  const view = mount(
    {
      onFocus: () => seen.push("focus"),
      onBlur: () => seen.push("blur"),
      onPointerEnter: () => seen.push("enter"),
      onPointerLeave: () => seen.push("leave"),
      onKeyDown: () => seen.push("key"),
    },
    { over: 220 }
  )
  wrapper(view).props.onFocus({})
  view.rerender()
  assert(tooltip(view), "the tooltip still opens")

  wrapper(view).props.onKeyDown({ key: "Escape", stopPropagation: () => {} })
  wrapper(view).props.onBlur({})
  wrapper(view).props.onPointerLeave({})
  view.rerender()
  assert.deepEqual(seen, ["focus", "key", "blur", "leave"])
})

test("it stops observing when it goes away", () => {
  const view = mount({}, { over: 220 })
  view.unmount()
  assert.equal(observers.at(-1).observed.length, 0)
})

// --- the hook on its own ----------------------------------------------------------------------

function HookProbe({ elementRef, options, onResult }) {
  onResult(useIsOverflowing(elementRef, options))
  return null
}

test("the hook answers for a box laid out by somebody else", () => {
  observers.length = 0
  const el = textNode({ over: 220 })
  let result = null
  render(HookProbe, {
    elementRef: { current: el },
    options: undefined,
    onResult: (r) => {
      result = r
    },
  })
  assert.equal(result, true)
  assert(observers.at(-1).observed.includes(el))
})

test("the hook defaults to the horizontal axis", () => {
  observers.length = 0
  let result = null
  render(HookProbe, {
    elementRef: { current: textNode({ over: 0, down: 51 }) },
    options: undefined,
    onResult: (r) => {
      result = r
    },
  })
  assert.equal(result, false, "a clamped height is not a default-axis overflow")
})
