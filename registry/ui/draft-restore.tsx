"use client"

import * as React from "react"
import { FileClock } from "lucide-react"

import { cn } from "@/lib/utils"
import { TimeAgo } from "@/registry/ui/time-ago"

const STORAGE_PREFIX = "pulld-draft:"
const DEFAULT_MAX_AGE = 7 * 24 * 60 * 60 * 1000
const DEFAULT_DELAY = 500

/** A draft that was found in storage and is worth offering back. */
export interface DraftRecord<T> {
  /** The value that was saved. */
  value: T
  /** When it was saved, as epoch milliseconds. */
  savedAt: number
}

export interface UseDraftOptions<T> {
  /**
   * Stable id for this form. Part of the storage key, so two forms on the same
   * origin must not share one — `"issue-comment"`, `"profile"`, `"invoice-new"`.
   */
  id: string
  /** The form's current value: a string for one field, an object for a whole form. */
  value: T
  /**
   * What the form arrived showing — an edit form's saved copy, or `""` for a new
   * one. Defaults to the first `value` seen, which is already right for both
   * unless the form's data arrives from a fetch after mount; pass it then.
   *
   * A stored draft equal to this is deleted rather than offered, which is what
   * makes a forgotten `clear()` after a successful save self-correcting.
   */
  baseline?: T
  /**
   * Bump when the form's shape changes so old drafts are dropped instead of
   * restored into fields that moved or no longer exist.
   */
  version?: string | number
  /**
   * Added to the storage key. Pass the signed-in user's id on anything that can
   * be used by more than one account: without it the next person to sign in on
   * the same browser is offered the previous one's unsent text.
   */
  scope?: string
  /** Drafts older than this are deleted rather than offered. Default 7 days. */
  maxAge?: number
  /** How long typing has to settle before a write. Default 500ms. */
  delay?: number
  /** Set false to stop saving entirely (an unauthenticated or read-only view). */
  enabled?: boolean
  /**
   * Whether a value is worth keeping. The default treats `null`, `undefined`,
   * a blank or whitespace-only string and an empty array as nothing to save.
   */
  isEmpty?: (value: T) => boolean
  /** Called by `restore()` with the saved value, for you to put back in the form. */
  onRestore?: (value: T) => void
}

export interface Draft<T> {
  /** The draft worth offering, or null when there is none. Always null until mounted. */
  pending: DraftRecord<T> | null
  /** Hands `pending.value` to `onRestore` and stands the offer down. */
  restore: () => void
  /**
   * Forgets the draft: deletes it from storage and stands the offer down.
   *
   * Call it when a submit succeeds — this is the one thing the caller has to do,
   * because a form that resets to empty after sending looks exactly like a form
   * somebody emptied by hand, and nothing in here can tell those apart. It is
   * also what the Discard button calls.
   */
  clear: () => void
  /** Writes the current value now rather than after `delay`. */
  flush: () => void
  /** The localStorage key in use, exposed for tests and for clearing it yourself. */
  storageKey: string
}

interface StoredDraft {
  v: unknown
  at: number
  ver: string
}

function defaultIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * JSON, or undefined for a value JSON cannot carry.
 *
 * `JSON.stringify` answers undefined for `undefined`, a function and a symbol,
 * and throws on a cycle or a bigint. Each of those means "there is nothing to
 * store", and they are all answered the same way here so the write path has one
 * guard instead of a try/catch at every call.
 */
function toJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? undefined : json
  } catch {
    return undefined
  }
}

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    // Blocked storage and some private modes throw on the property itself.
    return null
  }
}

function removeItem(store: Storage, key: string): void {
  try {
    store.removeItem(key)
  } catch {
    // Nothing to do about a storage that will not take a write.
  }
}

/**
 * Keeps a form's work in localStorage while it is being typed, and offers it back
 * on the next visit.
 *
 * Nothing is read during render, so the server and the first client render agree
 * and `pending` is null until an effect has run — the offer appears a frame after
 * mount rather than flashing for somebody who has no draft.
 */
export function useDraft<T>({
  id,
  value,
  baseline,
  version,
  scope,
  maxAge = DEFAULT_MAX_AGE,
  delay = DEFAULT_DELAY,
  enabled = true,
  isEmpty = defaultIsEmpty,
  onRestore,
}: UseDraftOptions<T>): Draft<T> {
  const storageKey = STORAGE_PREFIX + (scope ? `${scope}:` : "") + id
  const token = version === null || version === undefined ? "1" : String(version)

  // The value the form arrived with, for callers that do not pass a baseline.
  const mountValue = React.useRef(value)
  const base = baseline === undefined ? mountValue.current : baseline
  const baseJson = toJson(base)
  // The value is compared and stored as JSON, so it is also what the debounce is
  // keyed on. Keying it on the value itself works for a single field and fails for
  // a whole form: `value={{ title, body }}` is a new object on every render, which
  // restarts the timer on every render, so a form that re-renders while being typed
  // into — which is every controlled form — would never reach the end of one delay
  // and would never save anything at all.
  const valueJson = toJson(value)

  const [pending, setPending] = React.useState<DraftRecord<T> | null>(null)
  const pendingRef = React.useRef(pending)
  pendingRef.current = pending

  // Whether the value has ever differed from the baseline during this mount. A
  // draft is only pruned for "the form is back to how it started" once this is
  // true, because on the very first commit the form is always back to how it
  // started — pruning then would delete the draft that is being offered.
  const dirtied = React.useRef(false)
  // Whether the offer has been answered. Once it has, it is not raised again for
  // the life of the mount, so a late-arriving baseline cannot resurrect it.
  const answered = React.useRef(false)
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // The latest value and the decision about it, for handlers that fire outside
  // render — the pagehide flush reads these rather than a closed-over value.
  const latest = React.useRef({ value, baseJson, isEmpty, enabled, storageKey, token })
  latest.current = { value, baseJson, isEmpty, enabled, storageKey, token }

  const write = React.useCallback(() => {
    const { value: v, baseJson: bj, isEmpty: empty, enabled: on, storageKey: key, token: ver } =
      latest.current
    if (!on) return
    const store = getStorage()
    if (!store) return
    const json = toJson(v)
    if (json === undefined) return
    if (empty(v) || json === bj) {
      if (dirtied.current) removeItem(store, key)
      return
    }
    try {
      store.setItem(key, JSON.stringify({ v, at: Date.now(), ver } satisfies StoredDraft))
    } catch {
      // A full or blocked storage loses the draft and nothing else.
    }
  }, [])

  const clear = React.useCallback(() => {
    answered.current = true
    dirtied.current = false
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const store = getStorage()
    if (store) removeItem(store, storageKey)
    setPending(null)
  }, [storageKey])

  const restore = React.useCallback(() => {
    answered.current = true
    // Read through the ref rather than handing `setPending` an updater that calls
    // `onRestore`: an updater has to be pure, and React is free to run it twice.
    const current = pendingRef.current
    if (current) onRestore?.(current.value)
    setPending(null)
  }, [onRestore])

  // Look for a draft. Anything unreadable, from another version, past its age or
  // equal to what the form already shows is deleted instead of offered.
  React.useEffect(() => {
    if (!enabled || answered.current) return
    const store = getStorage()
    if (!store) return
    let raw: string | null = null
    try {
      raw = store.getItem(storageKey)
    } catch {
      return
    }
    if (raw === null) return

    let record: StoredDraft | null = null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === "object") record = parsed as StoredDraft
    } catch {
      record = null
    }
    if (
      !record ||
      typeof record.at !== "number" ||
      record.ver !== token ||
      Date.now() - record.at > maxAge ||
      toJson(record.v) === baseJson
    ) {
      removeItem(store, storageKey)
      // An offer already standing has to come down with it. A baseline that
      // arrives from a fetch after mount reaches this branch for a draft that was
      // being offered a moment ago, and leaving it up would ask about work that
      // has just been deleted.
      setPending(null)
      return
    }
    // Answered with the same record rather than a fresh object, so an effect that
    // re-runs — React double-invoking it, or a dependency that changed and landed
    // on the same draft — does not re-render the form for nothing.
    setPending((current) =>
      current && current.savedAt === record.at && toJson(current.value) === toJson(record.v)
        ? current
        : { value: record.v as T, savedAt: record.at }
    )
  }, [storageKey, token, maxAge, baseJson, enabled])

  // Save after typing settles.
  //
  // `isEmpty` is read through the ref rather than listed as a dependency: it is
  // ordinarily written inline at the call site, so a new function arrives every
  // render, and depending on it would restart the timer on every render instead
  // of on every change — a form that re-renders for any other reason would then
  // never reach the end of a single delay, and nothing would ever be saved.
  React.useEffect(() => {
    if (!enabled) return
    if (valueJson !== undefined && !latest.current.isEmpty(value) && valueJson !== baseJson) {
      dirtied.current = true
    }
    timer.current = setTimeout(write, delay)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `value` through `valueJson`
  }, [valueJson, baseJson, delay, enabled, write])

  // A tab being closed or backgrounded mid-sentence would otherwise lose whatever
  // was typed inside the last `delay`. `visibilitychange` is the one that fires on
  // mobile, where a tab is backgrounded rather than unloaded and `pagehide` may
  // never come.
  React.useEffect(() => {
    if (!enabled) return
    const onPageHide = () => write()
    const onVisibility = () => {
      if (document.visibilityState === "hidden") write()
    }
    window.addEventListener("pagehide", onPageHide)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [enabled, write])

  // Two tabs on one form share a key and the last write wins. The case worth
  // catching is the other tab submitting: it clears the draft, and an offer still
  // standing here is for work that has already been sent.
  React.useEffect(() => {
    if (!enabled) return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== storageKey) return
      if (event.newValue === null) setPending(null)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [storageKey, enabled])

  return { pending, restore, clear, flush: write, storageKey }
}

export interface DraftRestoreProps<T>
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The value returned by `useDraft`. */
  draft: Draft<T>
  /** Leading text before the timestamp. */
  label?: string
  restoreLabel?: string
  discardLabel?: string
  /** Called after the user restores, in addition to `useDraft`'s `onRestore`. */
  onRestore?: () => void
  /** Called after the user discards. */
  onDiscard?: () => void
}

/**
 * The inline "you have an unsent draft — restore it?" notice for a form.
 *
 * A notice rather than a dialog: coming back to a page with an old draft on it is
 * not an emergency, and a modal would make somebody answer a question about work
 * they may not even remember before they can read their own form.
 *
 * The live region is mounted whether or not there is a draft, and only its text
 * comes and goes. A region that mounts with its message already inside it is
 * registered too late to announce that message, which is what rendering the whole
 * notice conditionally produces — and this notice always appears after mount, so
 * that would be every time. The buttons sit outside the region: their labels are
 * not news, and a screen reader is about to reach them anyway.
 */
export function DraftRestore<T>({
  draft,
  label = "You have an unsent draft",
  restoreLabel = "Restore",
  discardLabel = "Discard",
  onRestore,
  onDiscard,
  className,
  ...props
}: DraftRestoreProps<T>) {
  const { pending } = draft

  function handleRestore() {
    draft.restore()
    onRestore?.()
  }

  function handleDiscard() {
    draft.clear()
    onDiscard?.()
  }

  return (
    <div
      className={cn(
        // The caller's classes go on with the chrome, not instead of it. Spacing is
        // the usual thing to pass here, and a `mb-4` left on while there is nothing
        // to show would hold a gap open above every form that has no draft.
        pending &&
          "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border bg-muted/50 px-3 py-2 text-sm",
        pending && className
      )}
      {...props}
    >
      {pending ? (
        <FileClock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
      <div
        role="status"
        aria-live="polite"
        className={cn("min-w-0 flex-1 text-muted-foreground", !pending && "sr-only")}
      >
        {pending ? (
          <>
            <span className="text-foreground">{label}</span>{" "}
            <TimeAgo date={pending.savedAt} className="text-inherit" />
          </>
        ) : null}
      </div>
      {pending ? (
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={handleRestore}
            className="rounded-md px-2 py-1 font-medium text-foreground underline underline-offset-2 transition-colors hover:bg-foreground/5 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {restoreLabel}
          </button>
          <button
            type="button"
            onClick={handleDiscard}
            className="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {discardLabel}
          </button>
        </span>
      ) : null}
    </div>
  )
}
