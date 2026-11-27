// focus-trap is a component with no appearance: everything it does is decide where focus goes, and
// every way it can be wrong is a keyboard user getting stranded. The cases below are written to
// fail against the versions that go wrong:
//
//   - a tab-stop list taken from `querySelectorAll` in document order, which ignores a positive
//     `tabindex` and so moves focus somewhere the browser would not have.
//   - a selector that decides `tabindex` with `:not([tabindex^="-"])`, which keeps `" -1 "`.
//   - `Number(attr)` for the tab index, which reads `tabindex=""` as an explicit 0, and
//     `parseInt(attr)` which reads `"1e2"` as 1.
//   - a stop list that trusts a selector match: `disabled`, an `inert` ancestor, no boxes at all,
//     and `visibility: hidden` — which has boxes, so the usual rectangle check passes it.
//   - `(at - 1) % count` for the backwards wrap, which is -1 on the first stop.
//   - a trap that only handles Tab, so a click or another component's `focus()` walks out of it.
//   - a nested trap where both instances act on the same Tab.
//   - a stop list cached at open time, which cannot reach controls that mounted later.
//   - `focus()` on the element the overlay was opened from after that element has been removed,
//     which drops focus on the body instead of leaving it alone.
//
// What the harness can see of focus is the call, not the caret: "the trap asked this node to take
// focus" is asserted here, and whether the browser honoured it belongs to a browser.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  TABBABLE_SELECTOR,
  readTabIndex,
  isTabbable,
  orderByTabIndex,
  tabbablesIn,
  nextStop,
  useFocusTrap,
  FocusTrap,
} = loadComponent(join(ROOT, "registry/ui/focus-trap.tsx"))

// --- stand-ins --------------------------------------------------------------------------------

/**
 * One element, recording what the trap asked of it.
 *
 * `attrs` are its own attributes; `ancestors` are attribute bags standing in for the chain above
 * it, which is what `closest` walks. `rects` empty means "generates no boxes" — a `display: none`
 * subtree or a closed `<details>`.
 */
function el({ attrs = {}, ancestors = [], rects = [{ top: 0 }], matches = true, name = "el" } = {}) {
  const chain = [attrs, ...ancestors]
  const node = {
    name,
    calls: [],
    isConnected: true,
    getAttribute: (key) => (key in attrs ? attrs[key] : null),
    hasAttribute: (key) => key in attrs,
    getClientRects: () => rects,
    closest: (selector) => {
      const hit = chain.some((bag) =>
        selector === "[inert]" ? "inert" in bag : bag["aria-hidden"] === "true"
      )
      return hit ? node : null
    },
    matches: () => matches,
    focus: () => node.calls.push("focus"),
  }
  return node
}

/** A container whose children are `stops`, or whatever `querySelectorAll` is made to return. */
function container(stops = [], { self = false, queryAll } = {}) {
  const node = {
    name: "container",
    calls: [],
    isConnected: true,
    querySelectorAll: queryAll ?? (() => stops),
    matches: () => self,
    getAttribute: () => null,
    hasAttribute: () => false,
    closest: () => null,
    getClientRects: () => [{ top: 0 }],
    contains: (other) => other === node || stops.includes(other),
    focus: () => node.calls.push("focus"),
  }
  return node
}

/** A document that records its listeners and can deliver an event to them. */
function fakeDocument(activeElement = null) {
  const listeners = []
  return {
    activeElement,
    listeners,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (at !== -1) listeners.splice(at, 1)
    },
    types: () => listeners.map((l) => l.type).sort(),
    deliver(type, event) {
      for (const l of [...listeners]) if (l.type === type) l.fn(event)
      return event
    },
  }
}

const key = (name, { shiftKey = false } = {}) => {
  const event = { key: name, shiftKey, prevented: 0, preventDefault: () => (event.prevented += 1) }
  return event
}

/** Runs `fn` with a stand-in document (and optionally `getComputedStyle`) installed. */
function withDocument(doc, fn, computedStyle) {
  const hadDoc = "document" in globalThis
  const previousDoc = globalThis.document
  const previousStyle = globalThis.getComputedStyle
  globalThis.document = doc
  if (computedStyle) globalThis.getComputedStyle = computedStyle
  try {
    return fn()
  } finally {
    if (hadDoc) globalThis.document = previousDoc
    else delete globalThis.document
    globalThis.getComputedStyle = previousStyle
  }
}

/** Mounts the hook against a container of our own, so the stop list is under the test's control. */
const trapOn = (ref, options) =>
  render((props) => {
    useFocusTrap(props.ref, props.options)
    return null
  }, { ref, options })

// --- reading tabindex -------------------------------------------------------------------------

test("tabindex is read as an HTML integer, not with Number or parseInt", () => {
  // Valid: optional sign, ASCII whitespace either side.
  assert.equal(readTabIndex("3"), 3)
  assert.equal(readTabIndex(" 3 "), 3)
  assert.equal(readTabIndex("+3"), 3)
  assert.equal(readTabIndex("-1"), -1)
  assert.equal(readTabIndex("0"), 0)

  // The case `Number` gets wrong, and it inverts the answer: `Number("")` is 0, which would make
  // `<div tabindex="">` an explicit tab stop. The attribute is invalid, so it is ignored.
  assert.equal(Number(""), 0, "the premise: an empty string is zero to Number")
  assert.equal(readTabIndex(""), null)

  // The cases `parseInt` gets wrong, in the other direction: it finds a number in a value the spec
  // calls invalid.
  assert.equal(Number.parseInt("3abc", 10), 3, "the premise: parseInt stops at the first non-digit")
  assert.equal(readTabIndex("3abc"), null)
  assert.equal(Number.parseInt("1e2", 10), 1, "the premise: parseInt reads 1e2 as 1")
  assert.equal(readTabIndex("1e2"), null)
  assert.equal(readTabIndex("2.7"), null)
  assert.equal(readTabIndex("0x10"), null)
  assert.equal(readTabIndex("abc"), null)

  // No attribute at all.
  assert.equal(readTabIndex(null), null)
  assert.equal(readTabIndex(undefined), null)
})

test("a negative tabindex with whitespace is still negative", () => {
  // The selector shorthand `[tabindex]:not([tabindex^="-"])` keeps this one, because the value does
  // not *start* with a minus sign. The browser skips it.
  assert.ok(TABBABLE_SELECTOR.includes("[tabindex]"), "collected on attribute presence")
  assert.ok(
    !TABBABLE_SELECTOR.includes('tabindex^="-"'),
    "a string comparison must not stand in for the integer parse"
  )
  assert.equal(isTabbable(el({ attrs: { tabindex: " -1 " } })), false)
  assert.equal(isTabbable(el({ attrs: { tabindex: "-1" } })), false)
  assert.equal(isTabbable(el({ attrs: { tabindex: "0" } })), true)
  assert.equal(isTabbable(el({ attrs: { tabindex: "3" } })), true)
})

// --- what counts as a stop --------------------------------------------------------------------

test("a selector match is not a tab stop on its own", () => {
  assert.equal(isTabbable(el()), true, "the control case")
  assert.equal(isTabbable(el({ attrs: { disabled: "" } })), false, "disabled")
  assert.equal(isTabbable(el({ attrs: { type: "hidden" } })), false, "a hidden input")
  assert.equal(isTabbable(el({ attrs: { type: "HIDDEN" } })), false, "attribute values fold case")
  assert.equal(isTabbable(el({ rects: [] })), false, "no boxes: display:none or a closed details")
})

test("inert and aria-hidden are inherited, so the element's own attributes are not the question", () => {
  // A dialog marks the page behind it inert on one wrapper far above these nodes.
  assert.equal(isTabbable(el({ ancestors: [{ inert: "" }] })), false, "an inert ancestor")
  assert.equal(isTabbable(el({ attrs: { inert: "" } })), false, "or its own")
  assert.equal(
    isTabbable(el({ ancestors: [{ "aria-hidden": "true" }] })),
    false,
    "focusable but unannounceable is not somewhere to put a keyboard"
  )
  assert.equal(
    isTabbable(el({ ancestors: [{ "aria-hidden": "false" }] })),
    true,
    "and the attribute has to say true"
  )
})

test("visibility:hidden is skipped although it generates boxes", () => {
  // The case a rectangle check cannot see, and not an exotic one: a collapsed accordion panel or an
  // off-state tab panel is routinely written this way. It takes up its space — so it has boxes —
  // and the browser still skips it.
  const hidden = el({ rects: [{ top: 0, width: 80, height: 20 }] })
  const shown = el({ rects: [{ top: 0, width: 80, height: 20 }] })
  const style = (node) => ({ visibility: node === hidden ? "hidden" : "visible" })

  const previous = globalThis.getComputedStyle
  globalThis.getComputedStyle = style
  try {
    assert.ok(hidden.getClientRects().length > 0, "the premise: it has boxes")
    assert.equal(isTabbable(hidden), false)
    assert.equal(isTabbable(shown), true)
    globalThis.getComputedStyle = (node) => ({ visibility: node === hidden ? "collapse" : "visible" })
    assert.equal(isTabbable(hidden), false, "collapse too")
  } finally {
    globalThis.getComputedStyle = previous
  }
})

// --- the order ---------------------------------------------------------------------------------

test("a positive tabindex jumps the queue, ascending, and ties keep document order", () => {
  const a = el({ name: "a" })
  const b = el({ name: "b", attrs: { tabindex: "2" } })
  const c = el({ name: "c" })
  const d = el({ name: "d", attrs: { tabindex: "1" } })
  const e = el({ name: "e", attrs: { tabindex: "2" } })

  // Document order in, the browser's sequential focus navigation order out.
  assert.deepEqual(
    orderByTabIndex([a, b, c, d, e]).map((n) => n.name),
    ["d", "b", "e", "a", "c"]
  )
})

test("tabindex 0 does not jump the queue", () => {
  const a = el({ name: "a" })
  const b = el({ name: "b", attrs: { tabindex: "0" } })
  assert.deepEqual(
    orderByTabIndex([a, b]).map((n) => n.name),
    ["a", "b"],
    "an explicit 0 means the same as being naturally tabbable"
  )
})

test("the wrap arithmetic has no negative index and no modulo by zero", () => {
  assert.equal((0 - 1) % 3, -1, "the premise: the naive backwards wrap is negative")
  assert.equal(nextStop(3, 0, -1), 2, "and this one wraps to the end")
  assert.equal(nextStop(3, 2, 1), 0)
  assert.equal(nextStop(3, 1, 1), 2)

  assert.ok(Number.isNaN((0 + 1 + 0) % 0), "the premise: an empty scope gives NaN")
  assert.equal(nextStop(0, -1, 1), null)
  assert.equal(nextStop(0, 0, -1), null)

  // Focus on the container rather than on a stop, which is where the first Tab starts.
  assert.equal(nextStop(3, -1, 1), 0, "forwards enters at the first stop")
  assert.equal(nextStop(3, -1, -1), 2, "backwards at the last")
})

// --- collecting the stops ----------------------------------------------------------------------

test("the container counts as a stop when it is one itself", () => {
  const inner = el({ name: "inner" })
  const asStop = container([inner], { self: true })
  assert.deepEqual(
    tabbablesIn(asStop).map((n) => n.name),
    ["container", "inner"],
    "a trap placed directly on a control would otherwise have an empty scope"
  )
  // The default container carries tabindex -1, so it is focusable without being a stop.
  const notAStop = container([inner], { self: false })
  assert.deepEqual(tabbablesIn(notAStop).map((n) => n.name), ["inner"])
})

test("a root that cannot be queried yields nothing rather than throwing", () => {
  assert.deepEqual(tabbablesIn(null), [])
  assert.deepEqual(tabbablesIn(undefined), [])
  assert.deepEqual(tabbablesIn({}), [], "a ref holding something that is not an element yet")
  assert.equal(isTabbable(null), false)
  assert.equal(isTabbable(undefined), false)
})

test("the stop list is recomputed, so controls that mount later are reachable", () => {
  const first = el({ name: "first" })
  const late = el({ name: "late" })
  let stops = [first]
  const node = container([], { queryAll: () => stops })

  assert.deepEqual(tabbablesIn(node).map((n) => n.name), ["first"])
  stops = [first, late] // the async form finished loading
  assert.deepEqual(
    tabbablesIn(node).map((n) => n.name),
    ["first", "late"],
    "a list cached at open time would leave half the dialog unreachable"
  )
})

// --- the trap ----------------------------------------------------------------------------------

test("it listens on the document, in the capture phase, and stops when it closes", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const ref = { current: container([el()]) }
    const instance = trapOn(ref, {})

    assert.deepEqual(doc.types(), ["focusin", "keydown"])
    assert.ok(
      doc.listeners.every((l) => l.capture === true),
      "a bubbling listener never sees the key once focus has left the container"
    )

    instance.unmount()
    assert.equal(doc.listeners.length, 0, "a closed trap is not listening to the page's typing")
  })
})

test("an inactive trap listens to nothing", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const ref = { current: container([el()]) }
    trapOn(ref, { active: false }).unmount()
    assert.equal(doc.listeners.length, 0)
  })
})

test("opening puts focus on the first stop, and the container when there is none", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const first = el({ name: "first" })
    const withStops = container([first, el()])
    trapOn({ current: withStops }, {}).unmount()
    assert.deepEqual(first.calls, ["focus"])

    const empty = container([])
    trapOn({ current: empty }, {}).unmount()
    assert.deepEqual(empty.calls, ["focus"], "the container is the fallback, hence its tabindex -1")
  })
})

test("initialFocus can name a target, or decline to move focus at all", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const first = el({ name: "first" })
    const chosen = el({ name: "chosen" })
    const node = container([first, chosen])

    trapOn({ current: node }, { initialFocus: () => chosen }).unmount()
    assert.deepEqual(chosen.calls, ["focus"])
    assert.deepEqual(first.calls, [], "the first stop was not touched")

    const quiet = el({ name: "quiet" })
    const quietNode = container([quiet])
    trapOn({ current: quietNode }, { initialFocus: "none" }).unmount()
    assert.deepEqual(quiet.calls, [])
    assert.deepEqual(quietNode.calls, [])

    const onlyNode = container([el()], { self: true })
    trapOn({ current: onlyNode }, { initialFocus: "container" }).unmount()
    assert.deepEqual(onlyNode.calls, ["focus"])
  })
})

test("Tab walks the scope in the browser's order and wraps at both ends", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const a = el({ name: "a" })
    const b = el({ name: "b" })
    const jumper = el({ name: "jumper", attrs: { tabindex: "1" } })
    const node = container([a, b, jumper])
    const instance = trapOn({ current: node }, {})

    // The positive tabindex is first in the browser's order, so it is where opening lands.
    assert.deepEqual(jumper.calls, ["focus"], "a document-order trap would have focused `a`")

    doc.activeElement = jumper
    const forward = doc.deliver("keydown", key("Tab"))
    assert.equal(forward.prevented, 1, "the order is this one, not the document's")
    assert.deepEqual(a.calls, ["focus"])

    doc.activeElement = b
    doc.deliver("keydown", key("Tab"))
    assert.deepEqual(jumper.calls, ["focus", "focus"], "past the last stop is the first one again")

    doc.activeElement = jumper
    doc.deliver("keydown", key("Tab", { shiftKey: true }))
    assert.deepEqual(b.calls, ["focus"], "and backwards off the front is the last one")

    instance.unmount()
  })
})

test("Tab is held even when the scope has nowhere to go", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    // Every control inside has just become disabled. Letting this Tab through is the leak.
    const node = container([el({ attrs: { disabled: "" } })])
    const instance = trapOn({ current: node }, {})
    node.calls.length = 0

    const event = doc.deliver("keydown", key("Tab"))
    assert.equal(event.prevented, 1)
    assert.deepEqual(node.calls, ["focus"])
    instance.unmount()
  })
})

test("a trap whose container has gone handles the key without acting on it", () => {
  // The window between the overlay's node being detached and the effect's cleanup running. An
  // unguarded handler reads `null.querySelectorAll` here and the keystroke throws.
  const doc = fakeDocument()
  withDocument(doc, () => {
    const ref = { current: container([el()]) }
    const instance = trapOn(ref, {})
    ref.current = null

    const event = doc.deliver("keydown", key("Tab"))
    assert.equal(event.prevented, 0, "with no scope there is no order to impose")
    doc.deliver("focusin", { target: el({ name: "outside" }) })
    instance.unmount()
  })
})

test("Escape is reported only when somebody is listening for it", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    let escapes = 0
    const node = container([el()])
    const instance = trapOn({ current: node }, { onEscape: () => (escapes += 1) })
    const handled = doc.deliver("keydown", key("Escape"))
    assert.equal(escapes, 1)
    assert.equal(handled.prevented, 1)
    instance.unmount()

    const other = container([el()])
    const quiet = trapOn({ current: other }, {})
    const ignored = doc.deliver("keydown", key("Escape"))
    assert.equal(ignored.prevented, 0, "without a handler, Escape belongs to whatever else listens")
    quiet.unmount()
  })
})

test("focus arriving from outside without a key is pulled back", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const first = el({ name: "first" })
    const node = container([first])
    const instance = trapOn({ current: node }, {})
    first.calls.length = 0

    // No key was pressed: a click on the page behind, or another component's focus() call.
    const outside = el({ name: "outside" })
    doc.deliver("focusin", { target: outside })
    assert.deepEqual(first.calls, ["focus"], "a keydown-only trap leaks here")

    // And the pull itself does not re-enter: the next focusin is inside the container.
    first.calls.length = 0
    doc.deliver("focusin", { target: first })
    assert.deepEqual(first.calls, [], "focus already inside is left alone")
    instance.unmount()
  })
})

test("confine:tab leaves focus alone when it lands outside", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const first = el({ name: "first" })
    const node = container([first])
    const instance = trapOn({ current: node }, { confine: "tab" })
    first.calls.length = 0

    doc.deliver("focusin", { target: el({ name: "outside" }) })
    assert.deepEqual(first.calls, [], "a modeless overlay must not argue with a click")

    // The key half still works.
    doc.activeElement = first
    const event = doc.deliver("keydown", key("Tab"))
    assert.equal(event.prevented, 1)
    instance.unmount()
  })
})

test("nested traps: only the innermost acts on a key", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const outerStop = el({ name: "outerStop" })
    const innerStop = el({ name: "innerStop" })
    const outer = trapOn({ current: container([outerStop]) }, {})
    const inner = trapOn({ current: container([innerStop]) }, {})
    outerStop.calls.length = 0
    innerStop.calls.length = 0

    doc.deliver("keydown", key("Tab"))
    assert.deepEqual(innerStop.calls, ["focus"])
    assert.deepEqual(
      outerStop.calls,
      [],
      "both listeners see the key; two of them acting is how Tab becomes unpredictable"
    )

    // The popover closes and the dialog has the keyboard again.
    inner.unmount()
    innerStop.calls.length = 0
    outerStop.calls.length = 0
    doc.deliver("keydown", key("Tab"))
    assert.deepEqual(outerStop.calls, ["focus"])
    assert.deepEqual(innerStop.calls, [])
    outer.unmount()
  })
})

test("nested traps unmounting outermost-first still leaves the right one on top", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const outerStop = el({ name: "outerStop" })
    const innerStop = el({ name: "innerStop" })
    const outer = trapOn({ current: container([outerStop]) }, {})
    const inner = trapOn({ current: container([innerStop]) }, {})

    // Two overlays dismissed by one state change unmount in render order, which is outermost first.
    outer.unmount()
    innerStop.calls.length = 0
    doc.deliver("keydown", key("Tab"))
    assert.deepEqual(innerStop.calls, ["focus"], "a pop() would have removed the wrong trap")
    inner.unmount()
  })
})

test("closing returns focus to where it came from", () => {
  const openedFrom = el({ name: "openedFrom" })
  const doc = fakeDocument(openedFrom)
  withDocument(doc, () => {
    trapOn({ current: container([el()]) }, {}).unmount()
    assert.deepEqual(openedFrom.calls, ["focus"])
  })
})

test("a return target that has left the document is left alone", () => {
  // The button that opened a confirm dialog was inside the row the dialog deleted. Calling focus()
  // on it silently moves focus to the body, which drops the keyboard at the top of the page.
  const removed = el({ name: "removed" })
  const doc = fakeDocument(removed)
  withDocument(doc, () => {
    const instance = trapOn({ current: container([el()]) }, {})
    removed.isConnected = false
    instance.unmount()
    assert.deepEqual(removed.calls, [])
  })
})

test("returnFocus can be declined, or pointed somewhere that will still exist", () => {
  const openedFrom = el({ name: "openedFrom" })
  const doc = fakeDocument(openedFrom)
  withDocument(doc, () => {
    trapOn({ current: container([el()]) }, { returnFocus: false }).unmount()
    assert.deepEqual(openedFrom.calls, [])

    const list = el({ name: "list" })
    trapOn({ current: container([el()]) }, { returnFocus: () => list }).unmount()
    assert.deepEqual(list.calls, ["focus"])
    assert.deepEqual(openedFrom.calls, [], "the named target replaces the remembered one")

    // A function may decline too, by returning null.
    trapOn({ current: container([el()]) }, { returnFocus: () => null }).unmount()
    assert.deepEqual(openedFrom.calls, [])
  })
})

test("the Escape handler that runs is the current one, not the one captured at open", () => {
  // Why it matters: `onEscape={() => setOpen(false)}` is a new function identity on every render,
  // while the effect that registered the document listener ran once when the trap opened. A
  // listener closing over the first render's props goes on calling that render's callback.
  //
  // What this cannot see: that the effect did not re-run. The harness ignores dependency arrays and
  // replays every effect on each pass, so "the listeners were not rebuilt" is not assertable here.
  // That is the other half of why the options are held in a ref — rebuilding re-runs the open
  // sequence, which moves focus — and checking it belongs to a browser.
  const doc = fakeDocument()
  withDocument(doc, () => {
    const ref = { current: container([el()]) }
    const seen = []
    const instance = render((props) => {
      useFocusTrap(props.ref, { onEscape: props.onEscape })
      return null
    }, { ref, onEscape: () => seen.push("first render") })

    instance.update({ ref, onEscape: () => seen.push("latest render") })
    doc.deliver("keydown", key("Escape"))

    assert.ok(seen.length > 0, "Escape reached a handler")
    assert.deepEqual(
      [...new Set(seen)],
      ["latest render"],
      "a stale closure would call the callback the trap opened with"
    )
    instance.unmount()
  })
})

// --- the component ----------------------------------------------------------------------------

test("FocusTrap renders a focusable container that is not a stop within its own scope", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const instance = render(FocusTrap, { children: null })
    const { props } = instance.tree
    assert.equal(instance.tree.type, "div")
    assert.equal(props.tabIndex, -1, "so focus has somewhere to go when the subtree has no stops")
    assert.ok(props.className.includes("outline-none"))
    assert.equal(
      isTabbable({ getAttribute: () => "-1", hasAttribute: () => false, closest: () => null }),
      false,
      "and that same -1 keeps it out of its own stop list"
    )
    instance.unmount()
  })
})

test("FocusTrap merges className and passes the rest through, options excepted", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const instance = render(FocusTrap, {
      className: "fixed inset-0",
      role: "dialog",
      "aria-modal": "true",
      id: "palette",
      active: true,
      confine: "tab",
      initialFocus: "none",
      returnFocus: false,
      onEscape: () => {},
    })
    const { props } = instance.tree
    assert.ok(props.className.includes("outline-none") && props.className.includes("fixed inset-0"))
    assert.equal(props.role, "dialog")
    assert.equal(props["aria-modal"], "true")
    assert.equal(props.id, "palette")
    for (const leaked of ["active", "confine", "initialFocus", "returnFocus", "onEscape"]) {
      assert.ok(!(leaked in props), `${leaked} is an option, not a DOM attribute`)
    }
    instance.unmount()
  })
})

test("FocusTrap with active false does not take the keyboard", () => {
  const doc = fakeDocument()
  withDocument(doc, () => {
    const instance = render(FocusTrap, { active: false, children: null })
    assert.equal(doc.listeners.length, 0, "an overlay can stay mounted while closed")
    instance.unmount()
  })
})
