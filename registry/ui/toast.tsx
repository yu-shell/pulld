"use client"

import * as React from "react"
import {
  CheckCircle2,
  Info,
  Loader2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A self-contained toast/notification system. No provider or context required —
 * call `toast(...)` from anywhere (event handlers, async code, outside React) and
 * render a single `<Toaster />` at your app root (outside any `transform`ed or
 * `overflow-hidden` container, since it positions itself with `position: fixed`).
 *
 * Features: imperative API with `success`/`error`/`info`/`warning`/`loading` and a
 * promise helper; auto-dismiss with pause-on-hover/focus; swipe-to-dismiss; six
 * positions; accessible live regions (assertive for errors, polite otherwise);
 * enter/exit animation that respects `prefers-reduced-motion`.
 */

export type ToastType = "default" | "success" | "error" | "info" | "warning" | "loading"

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastOptions {
  /** Reuse an id to update an existing toast in place (used by `toast.promise`). */
  id?: string
  description?: React.ReactNode
  /** Auto-dismiss after this many ms. `Infinity` keeps it until dismissed. */
  duration?: number
  action?: ToastAction
}

interface ToastRecord {
  id: string
  type: ToastType
  title: React.ReactNode
  description?: React.ReactNode
  duration: number
  action?: ToastAction
  /** false once dismissed — kept mounted briefly so the exit can animate. */
  open: boolean
}

// --- module store (framework-agnostic, so `toast()` works without React context) ---

const DEFAULT_DURATION = 4000
const EXIT_MS = 220 // keep in sync with the CSS transition below
const MAX_TOASTS = 5

let records: ToastRecord[] = []
let counter = 0
const listeners = new Set<() => void>()
const removalTimers = new Map<string, ReturnType<typeof setTimeout>>()

function emit(next: ToastRecord[]) {
  records = next
  for (const l of listeners) l()
}

function cancelRemoval(id: string) {
  const t = removalTimers.get(id)
  if (t) {
    clearTimeout(t)
    removalTimers.delete(id)
  }
}

function scheduleRemoval(id: string) {
  cancelRemoval(id)
  removalTimers.set(
    id,
    setTimeout(() => {
      removalTimers.delete(id)
      emit(records.filter((r) => r.id !== id))
    }, EXIT_MS)
  )
}

function upsert(rec: ToastRecord) {
  // A re-used id may be mid-exit; cancel its pending removal so it stays put.
  cancelRemoval(rec.id)
  const i = records.findIndex((r) => r.id === rec.id)
  if (i >= 0) {
    const next = records.slice()
    next[i] = rec
    emit(next)
  } else {
    // Cap the queue: once over budget, drop the oldest toast (overflow is removed
    // immediately, without an exit animation — it's a hard cap, not a dismissal).
    const next = [...records, rec]
    emit(next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next)
  }
}

function create(type: ToastType, title: React.ReactNode, opts: ToastOptions = {}) {
  const id = opts.id ?? `toast-${++counter}`
  const duration =
    opts.duration ?? (type === "loading" ? Number.POSITIVE_INFINITY : DEFAULT_DURATION)
  upsert({
    id,
    type,
    title,
    description: opts.description,
    duration,
    action: opts.action,
    open: true,
  })
  return id
}

function dismiss(id?: string) {
  if (id == null) {
    // Dismiss everything that's currently open.
    for (const r of records) if (r.open) scheduleRemoval(r.id)
    emit(records.map((r) => (r.open ? { ...r, open: false } : r)))
    return
  }
  const r = records.find((x) => x.id === id)
  if (!r || !r.open) return
  scheduleRemoval(id)
  emit(records.map((x) => (x.id === id ? { ...x, open: false } : x)))
}

type PromiseMessages<T> = {
  loading: React.ReactNode
  success: React.ReactNode | ((value: T) => React.ReactNode)
  error: React.ReactNode | ((err: unknown) => React.ReactNode)
}

export const toast = Object.assign(
  (title: React.ReactNode, opts?: ToastOptions) => create("default", title, opts),
  {
    success: (title: React.ReactNode, opts?: ToastOptions) => create("success", title, opts),
    error: (title: React.ReactNode, opts?: ToastOptions) => create("error", title, opts),
    info: (title: React.ReactNode, opts?: ToastOptions) => create("info", title, opts),
    warning: (title: React.ReactNode, opts?: ToastOptions) => create("warning", title, opts),
    loading: (title: React.ReactNode, opts?: ToastOptions) => create("loading", title, opts),
    dismiss,
    /** Drive a toast from a promise: loading → success/error, updated in place. */
    promise<T>(promise: Promise<T>, messages: PromiseMessages<T>) {
      const id = create("loading", messages.loading, {
        duration: Number.POSITIVE_INFINITY,
      })
      promise.then(
        (value) =>
          create("success", resolveMessage(messages.success, value), { id }),
        (err) => create("error", resolveMessage(messages.error, err), { id })
      )
      return promise
    },
  }
)

function resolveMessage<T>(
  msg: React.ReactNode | ((arg: T) => React.ReactNode),
  arg: T
): React.ReactNode {
  return typeof msg === "function"
    ? (msg as (arg: T) => React.ReactNode)(arg)
    : msg
}

// --- store subscription for the renderer ---

const EMPTY: ToastRecord[] = []
function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
function getSnapshot() {
  return records
}
function getServerSnapshot() {
  return EMPTY
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const onChange = () => setReduced(mq.matches)
    onChange()
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])
  return reduced
}

// --- rendering ---

export type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"

export interface ToasterProps {
  position?: ToastPosition
  /** Gap between stacked toasts, in px. */
  gap?: number
}

const POSITION_CLASSES: Record<ToastPosition, string> = {
  "top-left": "top-0 left-0 items-start",
  "top-center": "top-0 left-1/2 -translate-x-1/2 items-center",
  "top-right": "top-0 right-0 items-end",
  "bottom-left": "bottom-0 left-0 items-start",
  "bottom-center": "bottom-0 left-1/2 -translate-x-1/2 items-center",
  "bottom-right": "bottom-0 right-0 items-end",
}

export function Toaster({ position = "bottom-right", gap = 12 }: ToasterProps) {
  const list = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const isTop = position.startsWith("top")

  return (
    // An <ol> (not a <section>) so the <li> toasts nest in a valid list; the
    // aria-label names the region for assistive tech. `m-0 list-none` keeps it
    // reset even without Tailwind's preflight.
    <ol
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed z-[100] m-0 flex w-full max-w-[400px] list-none flex-col p-4",
        // newest toast sits closest to the screen edge
        isTop ? "flex-col" : "flex-col-reverse",
        POSITION_CLASSES[position]
      )}
      style={{ gap }}
    >
      {list.map((record) => (
        <ToastItem key={record.id} record={record} fromTop={isTop} />
      ))}
    </ol>
  )
}

const ICONS: Partial<Record<ToastType, React.ReactNode>> = {
  success: <CheckCircle2 className="size-5 text-emerald-500" />,
  error: <XCircle className="size-5 text-destructive" />,
  warning: <TriangleAlert className="size-5 text-amber-500" />,
  info: <Info className="size-5 text-sky-500" />,
  loading: <Loader2 className="size-5 animate-spin text-muted-foreground" />,
}

const SWIPE_THRESHOLD = 80

function ToastItem({ record, fromTop }: { record: ToastRecord; fromTop: boolean }) {
  const { id, type, title, description, action, duration, open } = record
  const reduced = usePrefersReducedMotion()

  // Enter animation: start offset, then settle on the next frame.
  const [entered, setEntered] = React.useState(false)
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Auto-dismiss timer with pause-on-hover/focus. Tracks remaining time so a
  // resumed toast doesn't restart from the full duration.
  const remaining = React.useRef(duration)
  const startedAt = React.useRef(0)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const paused = React.useRef(false)
  // True while the pointer is over the toast or focus is inside it — the countdown
  // stays paused the whole time, including across a promise loading → success swap.
  const over = React.useRef(false)

  const clearTimer = React.useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
  }, [])

  const run = React.useCallback(() => {
    clearTimer()
    if (!open || !Number.isFinite(remaining.current)) return
    startedAt.current = Date.now()
    timer.current = setTimeout(() => dismiss(id), remaining.current)
  }, [open, id, clearTimer])

  // (Re)start whenever the toast is (re)opened or its duration changes (e.g. a
  // promise toast going loading → success). If the user is interacting with it,
  // keep it paused instead of auto-dismissing under their cursor.
  React.useEffect(() => {
    remaining.current = duration
    if (over.current) {
      paused.current = true
      clearTimer()
    } else {
      paused.current = false
      run()
    }
    return clearTimer
  }, [duration, open, type, run, clearTimer])

  const pause = React.useCallback(() => {
    if (paused.current || !Number.isFinite(remaining.current)) return
    paused.current = true
    clearTimer()
    remaining.current -= Date.now() - startedAt.current
  }, [clearTimer])

  const resume = React.useCallback(() => {
    // Only actually resume once the pointer/focus has truly left the toast.
    if (!paused.current || over.current) return
    paused.current = false
    run()
  }, [run])

  const onEnter = React.useCallback(() => {
    over.current = true
    pause()
  }, [pause])
  const onLeave = React.useCallback(() => {
    over.current = false
    resume()
  }, [resume])

  // Swipe-to-dismiss.
  const [dx, setDx] = React.useState(0)
  const dragging = React.useRef(false)
  const pointerStart = React.useRef(0)

  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return
    dragging.current = true
    pointerStart.current = e.clientX
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pause()
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return
    setDx(e.clientX - pointerStart.current)
  }
  function endDrag(e: React.PointerEvent) {
    if (!dragging.current) return
    dragging.current = false
    const moved = e.clientX - pointerStart.current
    if (Math.abs(moved) > SWIPE_THRESHOLD) {
      // Reset the swipe offset so the exit animates via the opacity/translateY
      // branch instead of freezing at the half-swiped position.
      setDx(0)
      dismiss(id)
    } else {
      setDx(0)
      resume()
    }
  }

  const isDragging = dragging.current
  const visible = entered && open
  const enterOffset = fromTop ? -16 : 16

  const transform = dx !== 0 ? `translateX(${dx}px)` : `translateY(${visible ? 0 : enterOffset}px)`
  const opacity = dx !== 0 ? Math.max(0, 1 - Math.abs(dx) / (SWIPE_THRESHOLD * 2)) : visible ? 1 : 0
  const transition =
    reduced || isDragging
      ? "none"
      : "transform .22s cubic-bezier(.21,1.02,.73,1), opacity .22s ease"

  const assertive = type === "error" || type === "warning"

  return (
    <li className="pointer-events-auto w-full list-none" style={{ transform, opacity, transition }}>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={(e) => {
          // Ignore focus moving between the toast's own buttons; resume only once
          // focus has truly left the toast.
          if (!e.currentTarget.contains(e.relatedTarget as Node)) onLeave()
        }}
        className={cn(
          "flex items-start gap-3 rounded-lg border bg-background p-4 pr-10 shadow-lg",
          "relative touch-pan-y select-none"
        )}
      >
        {ICONS[type] ? <span className="mt-0.5 shrink-0">{ICONS[type]}</span> : null}
        <div
          key={type}
          role={assertive ? "alert" : "status"}
          aria-live={assertive ? "assertive" : "polite"}
          aria-atomic="true"
          className="min-w-0 flex-1"
        >
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          ) : null}
          {action ? (
            <button
              type="button"
              onClick={() => {
                action.onClick()
                dismiss(id)
              }}
              className="mt-2 inline-flex h-7 items-center rounded-md border bg-transparent px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {action.label}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismiss(id)}
          className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
    </li>
  )
}
