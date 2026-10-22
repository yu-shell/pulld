"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/** Stands in for `resetKeys` when the caller passes none, so the comparison never sees undefined. */
const NO_KEYS: readonly unknown[] = []

/**
 * Whether two `resetKeys` lists say the same thing.
 *
 * Element-wise rather than by identity, and this is the whole difference between a boundary that
 * works and one that flaps. `resetKeys={[userId]}` builds a fresh array on every render of the
 * parent, so an identity comparison reports a change every time the parent renders — the boundary
 * clears the error, the child mounts, throws for the same reason it threw before, and the parent
 * renders again. Comparing the contents means "changed" means the caller changed something.
 */
function sameKeys(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false
  }
  return true
}

/**
 * A readable message for something thrown that was not an Error.
 *
 * `throw "nope"` and `throw { code: 500 }` are legal, and a rejected promise handed to
 * `showBoundary` carries whatever the library rejected with. `String(value)` is not safe on its
 * own either: it throws a TypeError of its own on a symbol, which would replace the application's
 * error with one from the boundary.
 */
function describe(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return `A value that is not an Error was thrown: ${String(value)}`
  } catch {
    return "A value that is not an Error was thrown"
  }
}

/**
 * The thrown value as an Error, without discarding what was actually thrown.
 *
 * Two cases need the conversion. A non-Error value has no `message` for a fallback to show, and a
 * fallback written against `error.message` would render "undefined" rather than fail — the worse
 * of the two outcomes. And an Error from another realm — an iframe, a worker, a `vm` context in a
 * test — fails `instanceof Error` while being an error in every way that matters, so it is matched
 * on having a string `message` instead of being thrown away as "not an Error".
 *
 * The original is kept on `cause` either way, because a logger wants the object the application
 * threw and not this wrapper.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value
  const errorLike =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { message?: unknown }).message === "string"
  const error = new Error(errorLike ? (value as { message: string }).message : describe(value))
  // Not `new Error(message, { cause })`: that overload needs the ES2022 lib, and this file has to
  // typecheck inside whatever target the project installing it already has. Assigning the property
  // afterwards is the same thing at runtime.
  ;(error as Error & { cause?: unknown }).cause = value
  return error
}

/** What the nearest boundary exposes to everything below it. */
export interface ErrorBoundaryContextValue {
  /** The error it is currently showing a fallback for, or null while the children are rendering. */
  error: Error | null
  /** Clears the error and renders the children again. */
  reset: () => void
}

export const ErrorBoundaryContext = React.createContext<ErrorBoundaryContextValue | null>(null)

/** What a fallback is handed: the error it stands in for, and the way back. */
export interface ErrorBoundaryFallbackProps {
  /** The error, normalised — a non-Error throw arrives wrapped, with the original on `cause`. */
  error: Error
  /** Clears the error and renders the children again. Fires `onReset` with reason "manual". */
  reset: () => void
  /**
   * Whether the crash unmounted something that had already been on screen.
   *
   * False when the children threw on their first render — nothing the user was looking at went
   * away, so nothing about their position was lost. True otherwise, which is the case where a
   * focused element has just been removed from the document and the browser has dropped focus to
   * the body; see `ErrorFallback`, which uses this to decide whether to take focus.
   */
  recoverFocus: boolean
}

/** Why the boundary cleared its error. */
export type ErrorBoundaryResetReason = "manual" | "keys"

export interface ErrorBoundaryProps {
  children?: React.ReactNode
  /**
   * What to render instead of the children.
   *
   * A node, or a function given {@link ErrorBoundaryFallbackProps}. Omit it for the built-in
   * {@link ErrorFallback}; pass `null` to render nothing, which is what a decorative widget in a
   * dashboard usually wants.
   *
   * Whatever it renders is outside this boundary's reach: React does not let a boundary catch an
   * error thrown by its own render, so a fallback that throws goes to the boundary above this one,
   * and if there is none the page is blank after all. Keep it to markup.
   */
  fallback?: React.ReactNode | ((props: ErrorBoundaryFallbackProps) => React.ReactNode)
  /**
   * Values that clear the error when they change — a route, a record id, a retry counter.
   *
   * Compared element by element, so the ordinary `resetKeys={[pathname]}` does not count as a
   * change on every render of the parent. Changing them does not re-run anything by itself: it
   * renders the children again, which throw again unless whatever made them throw is also gone.
   */
  resetKeys?: readonly unknown[]
  /**
   * Called once per error, in the commit that shows the fallback — the place to report it.
   *
   * `componentStack` is React's own list of the components above the throw, and it is null when
   * the error came in through {@link useErrorBoundary} rather than out of a render. Both it and
   * `error.message` routinely carry the thing being rendered — an email address, an order, an id —
   * so treat the pair as user data when the destination is somebody else's service.
   */
  onError?: (error: Error, info: { componentStack: string | null }) => void
  /** Called after the error is cleared, with the error that was showing and what cleared it. */
  onReset?: (details: { reason: ErrorBoundaryResetReason; error: Error }) => void
}

interface ErrorBoundaryState {
  error: Error | null
  /** The `resetKeys` the last render was given, so a change can be noticed without prevProps. */
  keys: readonly unknown[]
}

/**
 * Catches a render error from anywhere below it and shows a fallback in place of that subtree,
 * instead of letting React unmount the whole application — one dashboard widget, a third-party
 * embed, a route, a row of a list.
 *
 * It is a class because React gives no other way: `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent, so this is the one component in a modern codebase
 * that cannot be a function. Writing it yourself is a dozen lines; the dozen lines are not the
 * reason to install one. These are:
 *
 * - **Clearing the error is not recovering.** Rendering the fallback unmounts the children, so a
 *   reset does mount them fresh and their state is genuinely gone — but the reason they threw is
 *   usually in the props or in a store, and that has not moved. `onReset` is where the caller
 *   drops the bad response, bumps the query key, or navigates; `resetKeys` is where it says what
 *   counts as the cause having changed.
 * - **A reset loop is easy to write by accident.** Keys are compared element by element and
 *   snapshotted as they are seen, so passing a fresh array literal does not reset anything, and a
 *   child that throws again under the same keys stops rather than cycling.
 * - **Half the errors in an application never reach a boundary.** An event handler, a `setTimeout`,
 *   a rejected promise and the server render are all outside the render path React watches.
 *   {@link useErrorBoundary} is the way to hand those in deliberately.
 * - **Focus is lost when the subtree goes.** The element that had it is no longer in the document,
 *   so the browser puts focus on the body and a keyboard user is silently returned to the top of
 *   the page. The built-in fallback takes focus back, and only in that case.
 *
 * What it cannot do is catch errors thrown during its own render, which includes the fallback, and
 * it does nothing on the server: `componentDidCatch` is a commit-phase lifecycle and the server
 * never commits. It is also not a quiet one in development — React logs an error it recovers from
 * either way, which is why this component does not log one of its own.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  /**
   * Whether the children have ever been on screen. See `recoverFocus`: a child that throws on its
   * first render took nothing away from the user, and a fallback should not pull focus for it.
   */
  private childrenCommitted = false

  /**
   * The raw value `onError` has already been called for, boxed so that a thrown `null` or
   * `undefined` is still distinguishable from "nothing reported yet". Cleared on reset, so the
   * same error thrown again after a retry is a second report rather than a silent one.
   */
  private reportedFor: { value: unknown } | null = null

  /** Set by `reset()` so the `onReset` that follows can say it was a person and not the keys. */
  private pendingReason: ErrorBoundaryResetReason | null = null

  /**
   * Handed to the context, and replaced only when the error changes.
   *
   * A fresh object every render would re-render every consumer below on every render of this one,
   * which for the healthy path is every render of the subtree the boundary is wrapping.
   */
  private contextValue: ErrorBoundaryContextValue

  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { error: null, keys: props.resetKeys ?? NO_KEYS }
    this.contextValue = { error: null, reset: this.reset }
  }

  static getDerivedStateFromError(value: unknown): Partial<ErrorBoundaryState> {
    return { error: toError(value) }
  }

  /**
   * Notices a `resetKeys` change — and, just as importantly, does not notice the one that was
   * already in place when the children threw.
   *
   * This runs before every render, including the re-render that `getDerivedStateFromError` causes,
   * which is what makes the snapshot right. A parent that re-renders with new keys *and* throws in
   * the same pass updates the snapshot on the way in, so by the time the error lands the keys on
   * record are the ones that were current when it was thrown. Comparing against `prevProps` in
   * `componentDidUpdate` instead would read that same pass as "the keys changed while an error was
   * showing", clear the error, and arrive back here one render later with the same throw.
   */
  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState
  ): Partial<ErrorBoundaryState> | null {
    const keys = props.resetKeys ?? NO_KEYS
    if (sameKeys(keys, state.keys)) return null
    if (state.error === null) return { keys }
    return { error: null, keys }
  }

  componentDidMount(): void {
    if (this.state.error === null) this.childrenCommitted = true
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // React hands over the value as it was thrown; `state.error` is the normalised one the fallback
    // is about to be given, and the two are the same object whenever an actual Error was thrown.
    if (this.reportedFor !== null && Object.is(this.reportedFor.value, error)) return
    this.reportedFor = { value: error }
    this.props.onError?.(this.state.error ?? toError(error), {
      componentStack: info.componentStack ?? null,
    })
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    if (this.state.error !== null) return
    this.childrenCommitted = true
    if (prevState.error === null) return
    this.reportedFor = null
    const reason = this.pendingReason ?? "keys"
    this.pendingReason = null
    this.props.onReset?.({ reason, error: prevState.error })
  }

  /**
   * Bound as a field rather than in the constructor so the identity is stable: it goes into the
   * context value and into the fallback's props, and a new function each render would make both
   * look like they had changed.
   */
  reset = (): void => {
    if (this.state.error === null) return
    this.pendingReason = "manual"
    this.setState({ error: null, keys: this.props.resetKeys ?? NO_KEYS })
  }

  render(): React.ReactNode {
    const { children, fallback } = this.props
    const { error } = this.state

    if (this.contextValue.error !== error) {
      this.contextValue = { error, reset: this.reset }
    }

    let content: React.ReactNode
    if (error === null) {
      content = children
    } else {
      const props: ErrorBoundaryFallbackProps = {
        error,
        reset: this.reset,
        recoverFocus: this.childrenCommitted,
      }
      if (typeof fallback === "function") content = fallback(props)
      else if (fallback === undefined) content = <ErrorFallback {...props} />
      else content = fallback
    }

    return (
      <ErrorBoundaryContext.Provider value={this.contextValue}>
        {content}
      </ErrorBoundaryContext.Provider>
    )
  }
}

export interface ErrorFallbackProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "title">,
    ErrorBoundaryFallbackProps {
  /** The headline. Keep it about the part of the page that is missing, not about the exception. */
  title?: string
  /** The retry button's label. Pass null for a fallback with no way back. */
  resetLabel?: string | null
  /**
   * Whether to render `error.message`.
   *
   * Off, because the message is written for whoever is reading the logs: it names internals, and
   * on a server-rendered page it can name another request's data. React already prints the error
   * and its component stack to the console in development, so turning this on is for the rare
   * build where the console is not reachable.
   */
  showMessage?: boolean
}

/**
 * The fallback used when `ErrorBoundary` is given none: a bordered notice with a retry button.
 *
 * Exported so a custom fallback can keep the same shape —
 * `fallback={(p) => <ErrorFallback {...p} title="Chart unavailable" />}`.
 */
export function ErrorFallback({
  error,
  reset,
  recoverFocus,
  title = "Something went wrong",
  resetLabel = "Try again",
  showMessage = false,
  className,
  ...props
}: ErrorFallbackProps) {
  const ref = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!recoverFocus) return
    const node = ref.current
    if (!node) return
    const doc = node.ownerDocument
    const active = doc.activeElement
    // Only when the browser has nowhere to put focus. If focus is still on something real it is
    // somewhere else on the page and belongs to whoever is using it; it is when the focused element
    // went down with the subtree that the browser falls back to the body, and a keyboard user is
    // then at the top of the document with no sign that anything happened.
    if (active && active !== doc.body) return
    node.focus()
  }, [recoverFocus])

  return (
    <div
      ref={ref}
      // Announced on arrival because it arrives — a live region that is inserted already populated
      // is read, which is exactly this case. Focusable only programmatically, so recovering focus
      // does not also add a tab stop to the page.
      role="alert"
      tabIndex={-1}
      className={cn(
        "flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-card p-6 text-card-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className
      )}
      {...props}
    >
      <div className="flex items-center gap-2 text-destructive">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4 shrink-0"
        >
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <p className="text-sm font-medium">{title}</p>
      </div>
      {showMessage && error.message ? (
        <p className="text-sm break-words text-muted-foreground">{error.message}</p>
      ) : null}
      {resetLabel === null ? null : (
        <button
          type="button"
          onClick={reset}
          className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-transparent px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {resetLabel}
        </button>
      )}
    </div>
  )
}

export interface UseErrorBoundary<TError> {
  /**
   * Hands an error to the nearest boundary from somewhere React is not watching — a click handler,
   * a timer, a rejected promise, a subscription callback.
   */
  showBoundary: (error: TError) => void
  /** Clears the nearest boundary, if there is one. A no-op outside any boundary. */
  resetBoundary: () => void
}

/**
 * The way to get an error that happened outside rendering to the boundary above you.
 *
 * This is the gap that makes people think their boundary is broken. React catches what is thrown
 * while it renders, and nothing else: `onClick={() => { throw e }}`, a `.catch` that rethrows, a
 * `setTimeout`, an `await` after the component has already returned — none of them are a render,
 * so the boundary never hears about them and the user is left looking at a page that quietly did
 * nothing. Calling `showBoundary(error)` stores it and rethrows it from this component's next
 * render, which is a render, so the boundary catches it with a real component stack and `onError`
 * reports it like any other.
 *
 * ```tsx
 * const { showBoundary } = useErrorBoundary()
 * React.useEffect(() => {
 *   load().then(setData, showBoundary)
 * }, [showBoundary])
 * ```
 *
 * No state has to be cleared afterwards: the boundary replaces this component with the fallback,
 * so the component holding the error unmounts, and a reset mounts a fresh one.
 */
export function useErrorBoundary<TError = unknown>(): UseErrorBoundary<TError> {
  const context = React.useContext(ErrorBoundaryContext)
  const [thrown, setThrown] = React.useState<{ value: TError } | null>(null)
  const reset = context?.reset

  const handle = React.useMemo(
    () => ({
      showBoundary: (error: TError) => setThrown({ value: error }),
      resetBoundary: () => {
        setThrown(null)
        reset?.()
      },
    }),
    [reset]
  )

  // After the hooks, never between them: a throw placed above `useMemo` would leave this render
  // having called two hooks where the last one called three, and a component that leaves a render
  // half-done is a worse thing to ship than the error it is reporting.
  //
  // Boxed rather than stored bare, so that `showBoundary(null)` — which a rejected promise can
  // genuinely produce — is still a throw and not a component that looks fine forever.
  if (thrown !== null) throw thrown.value
  return handle
}

/**
 * Wraps a component in a boundary — the ordinary way to protect a route or a page-level component
 * whose own file is the only place you can reach.
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  boundaryProps?: Omit<ErrorBoundaryProps, "children">
): React.ComponentType<P> {
  function Wrapped(props: P) {
    return (
      <ErrorBoundary {...boundaryProps}>
        <Component {...props} />
      </ErrorBoundary>
    )
  }
  Wrapped.displayName = `withErrorBoundary(${Component.displayName || Component.name || "Component"})`
  return Wrapped
}
