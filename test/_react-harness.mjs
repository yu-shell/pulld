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
// event handler does to state, and how the tree changes when props change. What it cannot see:
// layout, focus actually moving, paint, and anything a browser decides. Assert the first kind here
// and leave the second kind to a browser.
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

// The methods a component may call on a ref'd node. Assigned onto every stand-in ref, so reaching
// for one is a no-op rather than a TypeError.
const domStandIn = {
  focus() {},
  blur() {},
  select() {},
  scrollIntoView() {},
  setSelectionRange() {},
  contains: () => false,
  querySelector: () => null,
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

  const settle = () => {
    for (let pass = 0; pass < maxPasses; pass++) {
      slot = 0
      refIndex = 0
      effects = []
      dirty = false
      tree = Component(props, null)
      for (const ref of refs) if (ref.current === null) ref.current = { ...domStandIn }
      for (const fn of effects) fn()
      if (!dirty) return tree
    }
    throw new Error("render did not settle — a state update is looping")
  }

  settle()
  return {
    get tree() {
      return tree
    },
    /** Re-render after an event handler asked for state to change. */
    rerender: () => settle(),
    /** Re-render this instance with new props, keeping its state. */
    update: (nextProps) => {
      props = nextProps
      return settle()
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
