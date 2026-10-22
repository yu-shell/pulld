// The twelve-line error boundary everyone writes is a class with `getDerivedStateFromError` and a
// `<p>Something went wrong</p>`, and every case below is written to pass against the shipped
// component and fail against a version of that shape:
//
//   - `resetKeys` compared by array identity, so the ordinary `resetKeys={[id]}` literal reports a
//     change on every render of the parent and the boundary cycles,
//   - the keys compared against `prevProps` in `componentDidUpdate`, so a parent that changes them
//     in the very render that throws resets straight back into the same throw,
//   - a reset that fires `onReset` even when there was no error to clear,
//   - a non-Error throw stored as-is, so a fallback reading `error.message` renders nothing,
//   - an Error from another realm treated as "not an Error" and its message thrown away,
//   - `String(value)` on the thrown value, which throws its own TypeError on a symbol and replaces
//     the application's error with one from the boundary,
//   - `onError` called again for an error already reported, and never again after a retry,
//   - a context value rebuilt every render, so every consumer under a healthy boundary re-renders
//     whenever the boundary does,
//   - a fallback that pulls focus even when the children threw on their first render, and one that
//     pulls it away from an element the user is still in,
//   - `showBoundary` storing the value bare, so `showBoundary(null)` is a component that looks fine
//     forever,
//   - the error message shown to the end user by default.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  ErrorBoundary,
  ErrorBoundaryContext,
  ErrorFallback,
  useErrorBoundary,
  withErrorBoundary,
} = loadComponent(join(ROOT, "registry", "ui", "error-boundary.tsx"))

const STACK = { componentStack: "\n    at Child\n    at ErrorBoundary" }

// --- a commit loop for a class component ------------------------------------------------------
// The shared harness renders function components by calling them, which a class is not. Rather
// than re-implement the component, this drives the real one the way React's commit does: derive
// state from props before each render, render, then run the lifecycle for that commit — mount the
// first time and update afterwards — and keep going while `setState` has left anything queued.
// `componentDidCatch` fires after `componentDidUpdate` of the same commit, which is the order
// React uses (the error callback rides the update queue, which is drained after the lifecycle).
//
// Nothing here paints, so what it can see is the element tree the component returned, the state it
// holds, and which lifecycle it ran. That is all this component's behaviour is.
const NOTHING_THROWN = Symbol("nothing thrown")

function drive(Class, initialProps, { throwsOnMount = NOTHING_THROWN } = {}) {
  let props = initialProps
  const instance = new Class(props)
  let state = instance.state
  let queue = []
  let tree = null
  let mounted = false

  instance.setState = (patch) => queue.push(patch)

  const renderPass = () => {
    const derived = Class.getDerivedStateFromProps
      ? Class.getDerivedStateFromProps(props, state)
      : null
    if (derived) state = { ...state, ...derived }
    instance.props = props
    instance.state = state
    tree = instance.render()
  }

  const commit = (prevProps, prevState) => {
    if (!mounted) {
      mounted = true
      instance.componentDidMount?.()
      return
    }
    instance.componentDidUpdate?.(prevProps, prevState)
  }

  const drain = () => {
    for (let pass = 0; queue.length; pass++) {
      if (pass > 10) throw new Error("render did not settle - a state update is looping")
      const beforeProps = props
      const beforeState = state
      const patches = queue
      queue = []
      for (const patch of patches) {
        state = { ...state, ...(typeof patch === "function" ? patch(state, props) : patch) }
      }
      renderPass()
      commit(beforeProps, beforeState)
    }
  }

  const raise = (value, info, prevProps, prevState) => {
    state = { ...state, ...Class.getDerivedStateFromError(value) }
    renderPass()
    commit(prevProps, prevState)
    instance.componentDidCatch?.(value, info)
    drain()
  }

  renderPass()
  if (throwsOnMount !== NOTHING_THROWN) {
    state = { ...state, ...Class.getDerivedStateFromError(throwsOnMount) }
    renderPass()
    commit(props, state)
    instance.componentDidCatch?.(throwsOnMount, STACK)
    drain()
  } else {
    commit(props, state)
    drain()
  }

  return {
    get tree() {
      return tree
    },
    get state() {
      return state
    },
    get instance() {
      return instance
    },
    /** What the boundary rendered inside its provider - the children, or the fallback. */
    get content() {
      return tree.props.children
    },
    /**
     * Runs something that calls `setState` from outside React - a click on the retry button - and
     * then lets the re-render it asked for happen, the way `act` does.
     */
    act(fn) {
      const result = fn()
      drain()
      return result
    },
    /** Re-render with new props, the way a parent re-rendering would. */
    update(next) {
      const prevProps = props
      const prevState = state
      props = next
      renderPass()
      commit(prevProps, prevState)
      drain()
    },
    /** A descendant throwing during render. */
    throwFromChild(value, info = STACK) {
      raise(value, info, props, state)
    },
    /**
     * A parent that changes props and whose child throws in the same pass - the case that decides
     * whether the keys on record are the ones from before the throw or the ones it threw under.
     */
    updateAndThrow(next, value, info = STACK) {
      const prevProps = props
      const prevState = state
      props = next
      renderPass()
      raise(value, info, prevProps, prevState)
    },
  }
}

const children = { type: "p", props: { children: "ok" } }

// --- what it renders --------------------------------------------------------------------------

test("renders the children inside its provider while there is no error", () => {
  const boundary = drive(ErrorBoundary, { children })
  assert.equal(boundary.tree.type, ErrorBoundaryContext.Provider)
  assert.equal(boundary.content, children)
  assert.equal(boundary.tree.props.value.error, null)
})

test("swaps in the built-in fallback when a child throws", () => {
  const boundary = drive(ErrorBoundary, { children })
  const error = new Error("boom")
  boundary.throwFromChild(error)

  assert.equal(boundary.content.type, ErrorFallback)
  assert.equal(boundary.content.props.error, error)
  // The children are no longer in the returned tree, which is the whole reason a reset mounts them
  // fresh: React unmounts what a commit does not render.
  assert.notEqual(boundary.content, children)
})

test("renders a given node as the fallback, and nothing at all for null", () => {
  const node = { type: "span", props: { children: "offline" } }
  const withNode = drive(ErrorBoundary, { children, fallback: node })
  withNode.throwFromChild(new Error("boom"))
  assert.equal(withNode.content, node)

  const silent = drive(ErrorBoundary, { children, fallback: null })
  silent.throwFromChild(new Error("boom"))
  assert.equal(silent.content, null)
})

test("calls a function fallback with the error, the reset and whether focus was lost", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, {
    children,
    fallback: (props) => {
      seen.push(props)
      return { type: "span", props: {} }
    },
  })
  const error = new Error("boom")
  boundary.throwFromChild(error)

  assert.equal(seen.length, 1)
  assert.equal(seen[0].error, error)
  assert.equal(typeof seen[0].reset, "function")
  assert.equal(seen[0].recoverFocus, true)
})

test("keeps one context value while the error does not change", () => {
  const boundary = drive(ErrorBoundary, { children })
  const first = boundary.tree.props.value
  boundary.update({ children })
  assert.equal(boundary.tree.props.value, first)

  boundary.throwFromChild(new Error("boom"))
  const errored = boundary.tree.props.value
  assert.notEqual(errored, first)
  assert.equal(errored.error.message, "boom")
})

// --- what gets normalised ---------------------------------------------------------------------

test("passes a real Error through untouched", () => {
  const error = new Error("boom")
  assert.equal(ErrorBoundary.getDerivedStateFromError(error).error, error)
})

test("wraps a thrown string, keeping it as the message and on cause", () => {
  const { error } = ErrorBoundary.getDerivedStateFromError("nope")
  assert.ok(error instanceof Error)
  assert.equal(error.message, "nope")
  assert.equal(error.cause, "nope")
})

test("reads the message off an error from another realm rather than discarding it", () => {
  // What an Error from an iframe, a worker or a vm context looks like from here: every property an
  // Error has, and `instanceof Error` false because the constructor is a different one.
  const foreign = { name: "TypeError", message: "x is not a function", stack: "..." }
  const { error } = ErrorBoundary.getDerivedStateFromError(foreign)
  assert.equal(error.message, "x is not a function")
  assert.equal(error.cause, foreign)
})

test("survives a thrown symbol, which String() refuses to convert", () => {
  const thrown = Symbol("nope")
  const { error } = ErrorBoundary.getDerivedStateFromError(thrown)
  assert.ok(error instanceof Error)
  assert.match(error.message, /not an Error/)
  assert.equal(error.cause, thrown)
})

test("wraps a thrown null into something a fallback can read", () => {
  const { error } = ErrorBoundary.getDerivedStateFromError(null)
  assert.ok(error instanceof Error)
  assert.match(error.message, /not an Error/)
  assert.equal(error.cause, null)
})

// --- resetKeys --------------------------------------------------------------------------------

test("a fresh array of the same values is not a change", () => {
  const onReset = []
  const boundary = drive(ErrorBoundary, {
    children,
    resetKeys: ["a", 1],
    onReset: (d) => onReset.push(d),
  })
  boundary.throwFromChild(new Error("boom"))

  // The literal a parent writes inline: a new array, the same contents.
  boundary.update({ children, resetKeys: ["a", 1], onReset: (d) => onReset.push(d) })
  assert.equal(boundary.state.error.message, "boom")
  assert.deepEqual(onReset, [])
})

test("a changed key clears the error and reports why", () => {
  const onReset = []
  const props = (id) => ({
    children,
    resetKeys: [id],
    onReset: (d) => onReset.push(d),
  })
  const boundary = drive(ErrorBoundary, props("a"))
  boundary.throwFromChild(new Error("boom"))
  boundary.update(props("b"))

  assert.equal(boundary.state.error, null)
  assert.equal(boundary.content, children)
  assert.equal(onReset.length, 1)
  assert.equal(onReset[0].reason, "keys")
  assert.equal(onReset[0].error.message, "boom")
})

test("keys changed in the very render that throws do not reset it straight back", () => {
  const onReset = []
  const props = (id) => ({
    children,
    resetKeys: [id],
    onReset: (d) => onReset.push(d),
  })
  const boundary = drive(ErrorBoundary, props("a"))
  // The ordinary shape of this: the id changes, the child re-renders against the new id, and the
  // new id is what it chokes on. Resetting here would mount the same child against the same id.
  boundary.updateAndThrow(props("b"), new Error("boom"))

  assert.equal(boundary.state.error.message, "boom")
  assert.deepEqual(boundary.state.keys, ["b"])
  assert.deepEqual(onReset, [])
})

test("a child that throws again under the same keys stops instead of cycling", () => {
  const boundary = drive(ErrorBoundary, { children, resetKeys: ["a"] })
  boundary.throwFromChild(new Error("first"))
  boundary.update({ children, resetKeys: ["b"] })
  assert.equal(boundary.state.error, null)

  boundary.throwFromChild(new Error("second"))
  assert.equal(boundary.state.error.message, "second")
  // Still ["b"], so the next commit has nothing to compare as changed.
  boundary.update({ children, resetKeys: ["b"] })
  assert.equal(boundary.state.error.message, "second")
})

test("a key list that grows is a change even when the shared values match", () => {
  const boundary = drive(ErrorBoundary, { children, resetKeys: ["a"] })
  boundary.throwFromChild(new Error("boom"))
  boundary.update({ children, resetKeys: ["a", "b"] })
  assert.equal(boundary.state.error, null)
})

test("tracks the keys while healthy, so the first error already has them on record", () => {
  const boundary = drive(ErrorBoundary, { children, resetKeys: ["a"] })
  boundary.update({ children, resetKeys: ["b"] })
  assert.deepEqual(boundary.state.keys, ["b"])
  assert.equal(boundary.state.error, null)
})

// --- reset ------------------------------------------------------------------------------------

test("reset clears the error, mounts the children again and says it was manual", () => {
  const onReset = []
  const boundary = drive(ErrorBoundary, { children, onReset: (d) => onReset.push(d) })
  boundary.throwFromChild(new Error("boom"))

  boundary.act(() => boundary.instance.reset())
  assert.equal(boundary.state.error, null)
  assert.equal(boundary.content, children)
  assert.equal(onReset.length, 1)
  assert.equal(onReset[0].reason, "manual")
  assert.equal(onReset[0].error.message, "boom")
})

test("reset with nothing to clear does nothing at all", () => {
  const onReset = []
  const boundary = drive(ErrorBoundary, { children, onReset: (d) => onReset.push(d) })
  boundary.act(() => boundary.instance.reset())
  assert.deepEqual(onReset, [])
  assert.equal(boundary.content, children)
})

test("the reset handed to the fallback is the same function every time", () => {
  const boundary = drive(ErrorBoundary, { children })
  boundary.throwFromChild(new Error("boom"))
  const first = boundary.content.props.reset
  boundary.update({ children })
  assert.equal(boundary.content.props.reset, first)
})

// --- onError ----------------------------------------------------------------------------------

test("reports the error once, with the component stack React supplied", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e, i) => seen.push([e, i]) })
  const error = new Error("boom")
  boundary.throwFromChild(error)

  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], error)
  assert.equal(seen[0][1].componentStack, STACK.componentStack)
})

test("reports the normalised error when what was thrown was not one", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e) => seen.push(e) })
  boundary.throwFromChild("nope")

  assert.equal(seen.length, 1)
  assert.ok(seen[0] instanceof Error)
  assert.equal(seen[0].message, "nope")
})

test("does not report the same error twice", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e) => seen.push(e) })
  const error = new Error("boom")
  boundary.throwFromChild(error)
  boundary.throwFromChild(error)
  assert.equal(seen.length, 1)
})

test("reports again when the same error comes back after a retry", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e) => seen.push(e) })
  const error = new Error("boom")
  boundary.throwFromChild(error)
  boundary.act(() => boundary.instance.reset())
  boundary.throwFromChild(error)
  assert.equal(seen.length, 2)
})

test("passes null rather than undefined when React gave no component stack", () => {
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e, i) => seen.push(i) })
  boundary.throwFromChild(new Error("boom"), {})
  assert.deepEqual(seen, [{ componentStack: null }])
})

test("passes the stack through as it came, and only normalises the absence", () => {
  // null is what React signals "no stack" with; undefined is the field not being there at all.
  // Everything else is React's, including an empty one, and is reported rather than rewritten.
  const seen = []
  const boundary = drive(ErrorBoundary, { children, onError: (e, i) => seen.push(i.componentStack) })
  boundary.throwFromChild(new Error("boom"), { componentStack: "" })
  assert.deepEqual(seen, [""])
})

// --- whether focus was lost ---------------------------------------------------------------------

test("a child that throws on its first render took nothing away from the user", () => {
  const boundary = drive(ErrorBoundary, { children }, { throwsOnMount: new Error("boom") })
  assert.equal(boundary.content.props.recoverFocus, false)
})

test("a child that throws after it had been on screen did", () => {
  const boundary = drive(ErrorBoundary, { children })
  boundary.throwFromChild(new Error("boom"))
  assert.equal(boundary.content.props.recoverFocus, true)
})

test("a child that mounts on a retry and then throws did too", () => {
  const boundary = drive(ErrorBoundary, { children }, { throwsOnMount: new Error("first") })
  assert.equal(boundary.content.props.recoverFocus, false)
  boundary.act(() => boundary.instance.reset())
  boundary.throwFromChild(new Error("second"))
  assert.equal(boundary.content.props.recoverFocus, true)
})

// --- the built-in fallback ------------------------------------------------------------------

const fallbackProps = (over = {}) => ({
  error: new Error("connection refused"),
  reset: () => {},
  recoverFocus: false,
  ...over,
})

/**
 * Runs `fn` with the stand-in document reporting `active` as its focused element.
 *
 * Every stand-in node the harness creates shares one `ownerDocument` object, which is how the page
 * the component reads can be set here at all. Restored afterwards so the next test sees the plain
 * one.
 */
function withActiveElement(active, fn) {
  const probe = render(ErrorFallback, fallbackProps())
  const doc = probe.nodes[0].ownerDocument
  const had = Object.prototype.hasOwnProperty.call(doc, "activeElement")
  const previous = doc.activeElement
  doc.activeElement = active
  try {
    return fn()
  } finally {
    if (had) doc.activeElement = previous
    else delete doc.activeElement
  }
}

test("is an alert carrying a heading and a way back", () => {
  const { tree } = render(ErrorFallback, fallbackProps())
  const nodes = walk(tree)
  assert.equal(tree.props.role, "alert")
  // Focusable to be focused, not to be tabbed to: an extra tab stop on every error notice is a
  // page that is harder to get through than it was before.
  assert.equal(tree.props.tabIndex, -1)

  const paragraphs = byTag(nodes, "p").map((n) => n.props.children)
  assert.deepEqual(paragraphs, ["Something went wrong"])

  const buttons = byTag(nodes, "button")
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0].props.children, "Try again")
  assert.equal(buttons[0].props.type, "button")
})

test("hides the exception message from the person reading the page", () => {
  const { tree } = render(ErrorFallback, fallbackProps())
  const text = byTag(walk(tree), "p").map((n) => n.props.children)
  assert.ok(!text.includes("connection refused"))
})

test("shows it when asked", () => {
  const { tree } = render(ErrorFallback, fallbackProps({ showMessage: true }))
  const text = byTag(walk(tree), "p").map((n) => n.props.children)
  assert.ok(text.includes("connection refused"))
})

test("shows no empty line for an error with no message", () => {
  const error = new Error("")
  const { tree } = render(ErrorFallback, fallbackProps({ error, showMessage: true }))
  const text = byTag(walk(tree), "p").map((n) => n.props.children)
  assert.deepEqual(text, ["Something went wrong"])
})

test("takes its wording from the caller", () => {
  const { tree } = render(
    ErrorFallback,
    fallbackProps({ title: "Chart unavailable", resetLabel: "Reload chart" })
  )
  const nodes = walk(tree)
  assert.equal(byTag(nodes, "p")[0].props.children, "Chart unavailable")
  assert.equal(byTag(nodes, "button")[0].props.children, "Reload chart")
})

test("drops the button when there is no way back to offer", () => {
  const { tree } = render(ErrorFallback, fallbackProps({ resetLabel: null }))
  assert.equal(byTag(walk(tree), "button").length, 0)
})

test("the button resets the boundary", () => {
  let resets = 0
  const { tree } = render(ErrorFallback, fallbackProps({ reset: () => (resets += 1) }))
  byTag(walk(tree), "button")[0].props.onClick()
  assert.equal(resets, 1)
})

test("keeps the icon out of the accessibility tree and lets it inherit the theme", () => {
  const { tree } = render(ErrorFallback, fallbackProps())
  const svg = byTag(walk(tree), "svg")
  assert.equal(svg.length, 1)
  assert.equal(svg[0].props["aria-hidden"], "true")
  // Drawn from the text colour rather than a colour of its own, which is what makes it follow
  // `text-destructive` and the theme behind it; unfilled, or the outline renders as a blob.
  assert.equal(svg[0].props.stroke, "currentColor")
  assert.equal(svg[0].props.fill, "none")
})

test("themes through tokens rather than colours of its own", () => {
  const { tree } = render(ErrorFallback, fallbackProps({ className: "mt-4" }))
  const classes = walk(tree)
    .map((n) => n.props?.className)
    .filter(Boolean)
    .join(" ")
  assert.match(classes, /\bborder-destructive\/40\b/)
  assert.match(classes, /\bbg-card\b/)
  assert.match(classes, /\btext-card-foreground\b/)
  assert.match(classes, /focus-visible:ring-ring/)
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(classes), classes)
  assert.match(tree.props.className, /\bmt-4\b/)
})

test("takes focus back when the crash left the browser with nowhere to put it", () => {
  withActiveElement(null, () => {
    const result = render(ErrorFallback, fallbackProps({ recoverFocus: true }))
    const called = result.nodes[0].calls.filter((c) => c.name === "focus")
    assert.equal(called.length, 1)
  })
})

test("leaves focus alone when the children never made it on screen", () => {
  withActiveElement(null, () => {
    const result = render(ErrorFallback, fallbackProps({ recoverFocus: false }))
    assert.deepEqual(
      result.nodes[0].calls.filter((c) => c.name === "focus"),
      []
    )
  })
})

test("leaves focus alone when the user is still somewhere real", () => {
  // Focus survived the crash, somewhere else on the page. Pulling it here would move the user.
  withActiveElement({ tagName: "INPUT" }, () => {
    const result = render(ErrorFallback, fallbackProps({ recoverFocus: true }))
    assert.deepEqual(
      result.nodes[0].calls.filter((c) => c.name === "focus"),
      []
    )
  })
})

// --- useErrorBoundary ---------------------------------------------------------------------------

test("showBoundary rethrows the value from the next render, where a boundary can see it", () => {
  let handle = null
  const Probe = () => {
    handle = useErrorBoundary()
    return { type: "span", props: {} }
  }
  const result = render(Probe, {})
  const failure = new Error("fetch failed")
  handle.showBoundary(failure)

  assert.throws(() => result.rerender(), (thrown) => thrown === failure)
})

test("showBoundary(null) still reaches the boundary", () => {
  // A rejected promise can carry anything, null included. Stored bare, this is a component that
  // looks healthy forever and an error that is never shown.
  let handle = null
  const Probe = () => {
    handle = useErrorBoundary()
    return { type: "span", props: {} }
  }
  const result = render(Probe, {})
  handle.showBoundary(null)

  assert.throws(
    () => result.rerender(),
    (thrown) => thrown === null
  )
})

test("nothing is thrown until showBoundary is called", () => {
  const Probe = () => {
    useErrorBoundary()
    return { type: "span", props: {} }
  }
  const result = render(Probe, {})
  assert.doesNotThrow(() => result.rerender())
})

test("resetBoundary clears the boundary above, and is harmless without one", () => {
  let resets = 0
  let handle = null
  const Probe = () => {
    handle = useErrorBoundary()
    return { type: "span", props: {} }
  }

  render(Probe, {})
  assert.doesNotThrow(() => handle.resetBoundary())
  assert.equal(resets, 0)

  // The harness reads a context's default value, which is how the provider's value is supplied
  // here: there is no provider tree above a component it renders directly.
  const previous = ErrorBoundaryContext._currentValue
  ErrorBoundaryContext._currentValue = { error: new Error("boom"), reset: () => (resets += 1) }
  try {
    render(Probe, {})
    handle.resetBoundary()
  } finally {
    ErrorBoundaryContext._currentValue = previous
  }
  assert.equal(resets, 1)
})

// --- withErrorBoundary --------------------------------------------------------------------------

test("wraps a component in a boundary and says so in its name", () => {
  const Widget = () => ({ type: "span", props: {} })
  const Wrapped = withErrorBoundary(Widget, { fallback: null })

  assert.equal(Wrapped.displayName, "withErrorBoundary(Widget)")
  const element = Wrapped({ id: 7 })
  assert.equal(element.type, ErrorBoundary)
  assert.equal(element.props.fallback, null)
  assert.equal(element.props.children.type, Widget)
  assert.equal(element.props.children.props.id, 7)
})

test("names an anonymous component something rather than nothing", () => {
  const Wrapped = withErrorBoundary((() => () => null)())
  assert.equal(Wrapped.displayName, "withErrorBoundary(Component)")
})
