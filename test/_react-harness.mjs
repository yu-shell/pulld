// Renders a real registry component so its behaviour can be asserted, without adding react-dom.
// Not a test file itself (the `_` prefix keeps it out of the `test/**/*.test.mjs` glob).
//
// The components in this registry have never had tests, for a practical reason: react-dom is not a
// dependency here and adding one to test a one-file component is a poor trade. The consequence was
// that anything with hooks — every interactive component — could only be checked by reading it, and
// reading does not catch a roving tabindex that has two tab stops or an arrow key that walks the
// wrong way on an RTL page.
//
// The way out is that the parts worth testing are reachable without a DOM. A component function is
// a function: given props it returns an element tree. The only thing standing in the way is the
// hook dispatcher, and since these components reach their hooks through the `React` namespace
// object (`import * as React from "react"`), the dispatcher can be supplied by handing the module a
// substitute namespace at require time. The real source is transpiled and run — never re-implemented,
// because a re-implementation only ever tests the copy.
//
// What this can see: the rendered tree (roles, aria, tabindex, class names, children), what an
// event handler does to state, how the tree changes when props change, and which methods a
// component called on a node it was holding (see `nodes` below). What it cannot see: layout, focus
// or a caret actually moving, paint, and anything a browser decides. Assert the first kind here and
// leave the second kind to a browser — "the component asked for the caret to go to offset 5" is the
// first kind; "the caret is at offset 5" is the second.
import { readFileSync } from "node:fs"
import ts from "typescript"
import * as React from "react"
import * as JsxRuntime from "react/jsx-runtime"

/**
 * Loads one component source and returns its exports, with hooks wired to the dispatcher below.
 *
 * `stubs` maps a module specifier to the object a require of it should return; `@/lib/utils` and
 * the two react entry points are already handled.
 */
export function loadComponent(sourcePath, { stubs = {} } = {}) {
  const js = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText

  const require_ = (id) => {
    if (id === "react") return fakeReact
    if (id === "react/jsx-runtime") return JsxRuntime
    if (id === "@/lib/utils") return { cn: (...a) => a.flat(Infinity).filter(Boolean).join(" ") }
    if (id in stubs) return stubs[id]
    throw new Error(`the harness has no stub for "${id}"`)
  }

  const mod = { exports: {} }
  new Function("require", "exports", "module", js)(require_, mod.exports, mod)
  return mod.exports
}

// The methods a component may call on a ref'd node, and what they answer. Assigned onto every
// stand-in ref, so reaching for one is a no-op rather than a TypeError.
//
// The imperative ones are recorded rather than merely swallowed. Nothing here can make a caret or a
// focus ring actually move, but *asking* for it is the component's own behaviour and worth pinning:
// a masked field that restores the caret to the end of the text instead of to the character just
// typed is broken in a way that only this call reveals. The recording is per-node and additive —
// every one of them still returns undefined, so a component cannot tell the difference.
const RECORDED = [
  "focus",
  "blur",
  "select",
  "scrollIntoView",
  "setSelectionRange",
  // Registering a listener on your own node is an imperative call like the rest, and for some
  // components it is the behaviour worth pinning rather than an implementation detail. A wheel or
  // touchstart listener has to be added here rather than through a React prop, because React adds
  // those passively and a passive listener's preventDefault is ignored — so "it added a wheel
  // listener with passive: false" is the whole difference between a component that works and one
  // that zooms while the page scrolls out from under it. Nothing is ever delivered through them.
  "addEventListener",
  "removeEventListener",
]

const domStandIn = {
  contains: () => false,
  querySelector: () => null,
  // A component that observes the node it is holding — a scroll listener, a ResizeObserver over its
  // children, a wait on the document's fonts — is doing something ordinary too, and the calls it
  // makes to set that up should be no-ops here rather than the reason it cannot be rendered at all.
  // `addEventListener` and `removeEventListener` are no-ops too, but recorded ones: see RECORDED
  // above. Nothing is delivered through any of them — the harness has no layout, so a measurement
  // taken here reads as "not measured yet", which is exactly the server's answer and worth
  // asserting on its own.
  children: [],
  ownerDocument: { fonts: null },
}

/**
 * The refs the tree actually hands to an element, without invoking any function component.
 *
 * Only these get a stand-in. Filling every null ref instead — which is what this did first — gives
 * a DOM object to refs that were never about the DOM, and `useRef<number | null>(null)` is the
 * ordinary way to write "nothing queued yet": a caret offset, the frame id to cancel, the value a
 * callback last fired for. Six components in this registry hold one. Every `=== null` guard on them
 * took the wrong branch here and only here, so the component under test was not the component that
 * ships, and a test could be written against behaviour that exists nowhere else.
 *
 * Refs left null stay null, which is also what the first render sees in a browser — nothing is
 * attached until the commit. `walk` is not reused because it invokes function components to include
 * their output, and doing that mid-render would run their hooks against this dispatcher out of
 * order. A ref passed down to a child component is still visible here: it sits on that child's
 * element either way.
 */
function collectAttachedRefs(node, found = new Set()) {
  if (node === null || node === undefined || typeof node !== "object") return found
  if (Array.isArray(node)) {
    for (const child of node) collectAttachedRefs(child, found)
    return found
  }
  // React 19 keeps `ref` in props; older runtimes lift it onto the element.
  const ref = node.props?.ref ?? node.ref
  if (ref && typeof ref === "object" && "current" in ref) found.add(ref)
  return collectAttachedRefs(node.props?.children, found)
}

/** One stand-in node, with its own `calls` log: `[{ name, args }, ...]` in the order they came. */
function makeStandIn() {
  const node = { ...domStandIn, calls: [] }
  for (const name of RECORDED) {
    node[name] = (...args) => {
      node.calls.push({ name, args })
    }
  }
  return node
}

// --- the dispatcher --------------------------------------------------------
// One render at a time, which is all a single component needs. State lives in `slots` and survives
// across passes so a re-render sees what the last one set; `dirty` says whether another pass is owed.
let slots, slot, refs, refIndex, effects, dirty

const fakeReact = {
  ...React,
  useState(init) {
    const i = slot++
    if (!(i in slots)) slots[i] = typeof init === "function" ? init() : init
    return [
      slots[i],
      (next) => {
        const value = typeof next === "function" ? next(slots[i]) : next
        // Bailing out on an unchanged value matters: without it the render-time state adjustment
        // pattern (`if (prop !== last) setLast(prop)`) never settles.
        if (!Object.is(value, slots[i])) {
          slots[i] = value
          dirty = true
        }
      },
    ]
  },
  useRef(init) {
    const i = refIndex++
    if (!(i in refs)) refs[i] = { current: init }
    return refs[i]
  },
  // Recomputed every pass. Memoisation is an optimisation, and asserting on a cache would pin an
  // implementation detail rather than a behaviour.
  useMemo: (fn) => fn(),
  useEffect: (fn) => effects.push(fn),
  useLayoutEffect: (fn) => effects.push(fn),
  useId: () => "harness-id",
  useCallback: (fn) => fn,
  forwardRef: (fn) => fn,
  // Nothing here has a real DOM node to expose, and the harness cannot see focus move anyway, so
  // the imperative handle is accepted and dropped rather than left to the real dispatcher (which
  // throws outside a render).
  useImperativeHandle: () => {},
}

/**
 * Renders `Component` to a settled tree, running effects the way a commit would.
 *
 * `direction` answers `getComputedStyle(...).direction`, which is how a component reads the writing
 * direction at event time. Refs left at null are given a stand-in object, so a handler guarded by
 * `ref.current ? ... : fallback` takes the mounted branch. The stand-in carries no-op versions of
 * the DOM methods a component calls on a node it is holding — focusing it, selecting its text,
 * scrolling it into view. None of them is observable here (see the note at the top of this file),
 * but a component that calls one is doing something ordinary, and it should not have to write
 * `?.focus?.()` to stay testable.
 */
export function render(Component, initialProps, { direction = "ltr", maxPasses = 12 } = {}) {
  slots = []
  refs = []
  effects = []
  globalThis.getComputedStyle = () => ({ direction })
  let props = initialProps
  let tree = null

  // Every cleanup an effect has handed back, in the order they were created. A commit would run the
  // previous one before re-running its effect; this does not, because a pass here is not a commit —
  // it is the same effect settling — and tearing down between passes would undo the very work being
  // settled. They are kept instead so `unmount` can run all of them, which is what a component
  // holding a timer or a listener needs before the test process can end.
  const cleanups = []

  const settle = () => {
    for (let pass = 0; pass < maxPasses; pass++) {
      slot = 0
      refIndex = 0
      effects = []
      dirty = false
      tree = Component(props, null)
      for (const ref of collectAttachedRefs(tree)) {
        if (ref.current === null) ref.current = makeStandIn()
      }
      for (const fn of effects) {
        const cleanup = fn()
        if (typeof cleanup === "function") cleanups.push(cleanup)
      }
      if (!dirty) return tree
    }
    throw new Error("render did not settle — a state update is looping")
  }

  settle()
  return {
    get tree() {
      return tree
    },
    /**
     * The stand-in nodes this instance handed to refs the component left null, in creation order —
     * the same order as the `useRef` calls that produced them. Each carries a `calls` log of the
     * imperative DOM methods the component invoked on it.
     */
    get nodes() {
      return refs.map((ref) => ref.current).filter((node) => Array.isArray(node?.calls))
    },
    /** Re-render after an event handler asked for state to change. */
    rerender: () => settle(),
    /** Re-render this instance with new props, keeping its state. */
    update: (nextProps) => {
      props = nextProps
      return settle()
    },
    /**
     * Runs every cleanup this instance collected, newest first, the way unmounting would.
     *
     * Only components that leave something running need it — a pending timer keeps the node process
     * alive after the test has passed, and one that reschedules itself keeps it alive forever.
     */
    unmount: () => {
      while (cleanups.length) cleanups.pop()()
    },
  }
}

/** Flattens an element tree to a list, invoking function components so their output is included. */
export function walk(node, out = []) {
  if (node === null || node === undefined || typeof node === "boolean") return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node !== "object") return out
  out.push(node)
  if (typeof node.type === "function") return walk(node.type(node.props), out)
  return walk(node.props?.children, out)
}

export const byRole = (nodes, role) => nodes.filter((n) => n.props?.role === role)
export const byTag = (nodes, tag) => nodes.filter((n) => n.type === tag)
