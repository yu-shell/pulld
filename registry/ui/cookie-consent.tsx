"use client"

import * as React from "react"
import { Cookie } from "lucide-react"

import { cn } from "@/lib/utils"

const STORAGE_KEY = "pulld-cookie-consent"

/** Whether the decision is known yet, and whether it has been made. */
export type ConsentStatus = "unknown" | "undecided" | "decided"

/** Who answered. A signal is the browser's standing refusal, not a choice anybody made here. */
export type ConsentSource = "user" | "signal"

export interface ConsentCategory {
  /** Stable key. This is what `ConsentGate` and `useConsent` are asked about. */
  id: string
  /** Shown as the switch's label. */
  label: string
  /** One sentence saying what is actually stored or sent. Shown under the label. */
  description: string
  /**
   * Granted whether or not anybody answers, and shown without a switch.
   *
   * For the cookies a site cannot work without — a session, a CSRF token, the record of these
   * very choices. There is no switch because an off position would be a lie.
   */
  required?: boolean
}

export interface ConsentState {
  status: ConsentStatus
  /**
   * Whether each category may be used right now. Empty while the status is `unknown`.
   *
   * Read it through `useConsent` rather than directly: a missing key has to count as a refusal,
   * and `granted[id]` is `undefined` for a category nobody has configured.
   */
  granted: Readonly<Record<string, boolean>>
  /** How the current answer was arrived at, or null when there is no answer. */
  source: ConsentSource | null
  /** When the person answered, as epoch milliseconds. Null unless `source` is `"user"`. */
  decidedAt: number | null
}

const UNKNOWN: ConsentState = Object.freeze({
  status: "unknown",
  granted: Object.freeze({}),
  source: null,
  decidedAt: null,
})

interface StoredConsent {
  /** Config version this answer was given against. */
  v: string
  /** Epoch milliseconds. */
  at: number
  /** Every optional category's answer, including the refusals. */
  cats: Record<string, boolean>
}

// --- the signals -----------------------------------------------------------------------------

/**
 * The browser's standing refusal to be tracked, or null when it is not carrying one.
 *
 * Both are feature-detected rather than assumed. Measured in Chrome 152 (2026-11-05):
 * `globalPrivacyControl` is **not on `navigator` at all**, while `doNotTrack` **is** there and
 * reads `null`. So neither can be read without checking, and neither absence means anything.
 *
 * `doNotTrack` is compared against the string `"1"` and nothing else, because the value that
 * means the opposite — `"0"`, "you may track me" — is a non-empty string and therefore truthy.
 * `if (navigator.doNotTrack)` reads an explicit permission as a refusal, which is the one way to
 * get this backwards while looking right.
 *
 * `globalPrivacyControl` is compared against `true` for the same shape of reason: it is specified
 * as a boolean, and `false` is a browser saying it has no signal to send, not a browser consenting.
 */
export function refusalSignal(): "gpc" | "dnt" | null {
  if (typeof navigator === "undefined") return null
  const nav = navigator as Navigator & {
    globalPrivacyControl?: boolean
    doNotTrack?: string | null
  }
  if (nav.globalPrivacyControl === true) return "gpc"
  if (nav.doNotTrack === "1") return "dnt"
  return null
}

// --- the store -------------------------------------------------------------------------------
//
// One decision per browser, held outside React, because that is what it is: every gate in the
// tree is asking the same question and there is exactly one answer. A module-level store also
// means `ConsentGate` works wherever it is dropped, with no provider to wrap the app in — the
// thing people forget, and forgetting it here would mean a gate that renders its child because
// no context was found.
//
// On the server this module is shared between requests, which would be a leak if anything ever
// wrote to it there. Nothing does: `hydrate` only ever runs from an effect, so a server render
// sees `UNKNOWN` and nothing else, and every client starts from `UNKNOWN` too.

let state: ConsentState = UNKNOWN

// Whether the panel of switches is showing, which belongs here for the same reason the answer
// does: the "Cookie settings" link that reopens it is in a footer, nowhere near the banner it has
// to open. Held in a component's own `useState` instead — which is the obvious place — that link
// opens a panel inside the footer and leaves the mounted banner shut.
let panelOpen = false

// The element to hand focus back to when the panel closes. Not part of the snapshot: it is one
// node, not state anything renders from.
let opener: HTMLElement | null = null

// What the hooks hold. Rebuilt only when something changed, because the hooks keep it in
// `useState` and an equal-but-new object on every pass would be an endless render.
let snapshot: { consent: ConsentState; panelOpen: boolean } = { consent: state, panelOpen }
const listeners = new Set<() => void>()

function notify() {
  snapshot = { consent: state, panelOpen }
  for (const listener of [...listeners]) listener()
}

function sameGrants(a: Readonly<Record<string, boolean>>, b: Readonly<Record<string, boolean>>) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/**
 * Replaces the snapshot, but only when something actually changed.
 *
 * The identity has to be stable across an unchanged recompute, because the subscribing hooks keep
 * the snapshot in `useState`: handing them an equal-but-new object on every pass would be an
 * endless render. It is also why `granted` is compared by value rather than by reference.
 */
function setState(next: ConsentState) {
  if (
    next.status === state.status &&
    next.source === state.source &&
    next.decidedAt === state.decidedAt &&
    sameGrants(next.granted, state.granted)
  ) {
    return
  }
  state = next
  notify()
}

function setPanelOpen(next: boolean) {
  if (next === panelOpen) return
  panelOpen = next
  notify()
}

/** The element that opened the panel, cleared as it is handed over. */
function takeOpener(): HTMLElement | null {
  const element = opener
  opener = null
  return element
}

/** The current decision, without React. Referentially stable until it changes. */
export function readConsent(): ConsentState {
  return state
}

/**
 * Called whenever the store changes, which is the decision — including an answer from another tab
 * — and the panel opening or closing. Returns an unsubscribe. Read the current value with
 * `readConsent`; this is the notification, not the value.
 */
export function subscribeConsent(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// --- storage ---------------------------------------------------------------------------------

function readStored(storageKey: string): StoredConsent | null {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(storageKey)
  } catch {
    // Blocked or partitioned storage. Treated as "nothing stored", which means asking again —
    // the only safe direction, since the alternative is assuming a grant nobody gave.
    return null
  }
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const record = parsed as Partial<StoredConsent>
    if (typeof record.v !== "string" || typeof record.at !== "number") return null
    if (!record.cats || typeof record.cats !== "object") return null
    const cats: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(record.cats)) {
      if (typeof value === "boolean") cats[key] = value
    }
    return { v: record.v, at: record.at, cats }
  } catch {
    return null
  }
}

/** Whether the answer was written down. False means it applies to this page and no further. */
function writeStored(storageKey: string, record: StoredConsent): boolean {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(record))
    return true
  } catch {
    // Losing the answer is recoverable — they get asked again next load. Acting on an answer we
    // never got is not, and neither is putting the banner back in front of somebody who just
    // answered it: see `unsaved`.
    return false
  }
}

// The question an unsaved answer was given about, or null when the last answer was written down.
//
// Storage that refuses a write is not rare — a private window, a partitioned third-party context,
// a full quota — and for those visitors *every* answer is in this state. Without this, the next
// read of storage finds nothing and puts the banner back in front of somebody who has just
// answered it, which is how a blocked-storage visitor ends up answering on every single render.
// It is keyed by the question so that changing the question still asks: an answer that could not
// be saved is not a reason to skip a new category or a bumped version.
let unsaved: string | null = null

// --- resolving the configuration --------------------------------------------------------------

export const DEFAULT_CATEGORIES: readonly ConsentCategory[] = Object.freeze([
  Object.freeze({
    id: "necessary",
    label: "Strictly necessary",
    description:
      "Needed for the site to work at all: signing in, keeping you signed in, security, and remembering the choices on this screen.",
    required: true,
  }),
  Object.freeze({
    id: "analytics",
    label: "Analytics",
    description: "Lets us count visits and see which pages are used, in aggregate.",
  }),
  Object.freeze({
    id: "marketing",
    label: "Marketing",
    description: "Lets us measure campaigns and show you ads elsewhere based on this visit.",
  }),
])

export interface UseCookieConsentOptions {
  /**
   * The categories to ask about. The first `required` one is listed without a switch.
   *
   * Defaults to strictly necessary / analytics / marketing. Keep the ids stable: they are the
   * keys in storage, and renaming one throws away the answer it held.
   */
  categories?: readonly ConsentCategory[]
  /**
   * Bump when the *meaning* of a category changes, to ask everybody again.
   *
   * Adding a category does not need it — an answer that does not cover every current category is
   * already treated as unfinished — but repurposing one does, because the old answer was given
   * about something else.
   */
  version?: string | number
  /** localStorage key. Change it only to run two independent banners on one origin. */
  storageKey?: string
  /** Called after every answer, with the categories that may now be used. */
  onDecision?: (granted: Readonly<Record<string, boolean>>, source: ConsentSource) => void
}

interface ResolvedConfig {
  categories: readonly ConsentCategory[]
  optional: string[]
  version: string
  storageKey: string
}

function resolveConfig(options: UseCookieConsentOptions): ResolvedConfig {
  const categories = options.categories ?? DEFAULT_CATEGORIES
  return {
    categories,
    optional: categories.filter((c) => !c.required).map((c) => c.id),
    version: options.version == null ? "1" : String(options.version),
    storageKey: options.storageKey ?? STORAGE_KEY,
  }
}

/** Identifies the question being asked, so an answer to a different one is not reused. */
function questionOf(config: ResolvedConfig) {
  return [config.version, config.storageKey, ...config.optional].join("\u0000")
}

/** Required categories are granted in every state but `unknown`; optional ones start refused. */
function grantsFrom(config: ResolvedConfig, answers: Record<string, boolean>) {
  const granted: Record<string, boolean> = {}
  for (const category of config.categories) {
    granted[category.id] = category.required ? true : answers[category.id] === true
  }
  return granted
}

/**
 * Works out the current state from storage and the browser, and puts it in the store.
 *
 * Idempotent on purpose — it runs on mount, on every config change, and again whenever another
 * tab writes — so `setState` discards an unchanged result rather than notifying anybody.
 */
function hydrate(config: ResolvedConfig) {
  const stored = readStored(config.storageKey)
  const answered =
    stored !== null &&
    stored.v === config.version &&
    // An answer has to cover every category currently being asked about. One added since means
    // the stored answer is not an answer to this question, so the ones it does hold become the
    // defaults in the panel and the banner comes back.
    config.optional.every((id) => id in stored.cats)

  if (answered && stored) {
    setState({
      status: "decided",
      granted: grantsFrom(config, stored.cats),
      source: "user",
      decidedAt: stored.at,
    })
    return
  }

  // An answer this session that storage would not keep. It is still the person's answer to this
  // question, so it stands until something else answers it.
  if (
    unsaved === questionOf(config) &&
    state.status === "decided" &&
    state.source === "user"
  ) {
    return
  }

  // Nobody has answered. A browser carrying a refusal has already answered for everything
  // optional, and asking it again is the nagging the signal exists to stop.
  //
  // It is not written to storage, because it is not a record of anything: it is this browser's
  // setting, read fresh each load. If it is turned off later, the banner appears, which is right —
  // a decision nobody made should not outlive the thing that made it.
  if (refusalSignal()) {
    setState({
      status: "decided",
      granted: grantsFrom(config, {}),
      source: "signal",
      decidedAt: null,
    })
    return
  }

  setState({
    status: "undecided",
    granted: grantsFrom(config, stored?.cats ?? {}),
    source: null,
    decidedAt: null,
  })
}

// --- the hooks -------------------------------------------------------------------------------

function useStore() {
  const [held, setHeld] = React.useState(() => snapshot)
  React.useEffect(() => {
    // Catch a change that landed between this render and this subscription — hydration from a
    // sibling, or another tab — then follow the store.
    setHeld(snapshot)
    return subscribeConsent(() => setHeld(snapshot))
  }, [])
  return held
}

/**
 * Whether `category` may be used right now.
 *
 * False until the answer is known, so nothing fires on the strength of not having asked yet. A
 * category nobody configured is false too, which is what makes a typo fail closed.
 */
export function useConsent(category: string): boolean {
  return useStore().consent.granted[category] === true
}

export interface CookieConsentController extends ConsentState {
  /** The categories being asked about, resolved. */
  categories: readonly ConsentCategory[]
  /** Whether the panel of switches is showing. */
  isOpen: boolean
  /**
   * Shows the panel of switches, pre-filled with the current answers.
   *
   * This is the "Cookie settings" link in a footer. A decision has to stay changeable, and under
   * the GDPR withdrawing has to be as easy as giving — so this is not optional furniture.
   */
  open: () => void
  /** Hides the panel without changing anything. */
  close: () => void
  /** Grants everything and closes. */
  acceptAll: () => void
  /** Refuses everything optional and closes. This is also the withdrawal path. */
  denyAll: () => void
  /** Records exactly these answers for the optional categories, and closes. */
  save: (answers: Record<string, boolean>) => void
  /** Forgets the answer, so the banner comes back. For a "re-ask me" control, and for tests. */
  reset: () => void
}

/**
 * Owns the stored decision, and the controls for changing it.
 *
 * `CookieConsent` calls this, so mounting that component anywhere is enough. Build your own UI on
 * it instead if you like — but mount exactly one of them, and mount it unconditionally: until
 * something hydrates the store every `ConsentGate` is closed, which is the right way round to
 * fail, and also an easy thing to be confused by.
 */
export function useCookieConsent(options: UseCookieConsentOptions = {}): CookieConsentController {
  const { onDecision } = options
  const config = resolveConfig(options)
  const { version, storageKey } = config
  const optionalKey = config.optional.join("\u0000")

  const held = useStore()

  const configRef = React.useRef(config)
  configRef.current = config

  React.useEffect(() => {
    const current = configRef.current
    hydrate(current)
    // Another tab answering is this tab's answer too; a gate that stays shut after the person
    // consented next door is the same bug as one that never opens.
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === current.storageKey) hydrate(current)
    }
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("storage", onStorage)
    }
    // Re-run when the question changes, not when the caller passes a fresh array of the same
    // categories: `optionalKey` is the content of that array.
  }, [version, storageKey, optionalKey])

  const commit = React.useCallback(
    (answers: Record<string, boolean>) => {
      const current = configRef.current
      const cats: Record<string, boolean> = {}
      for (const id of current.optional) cats[id] = answers[id] === true
      const at = Date.now()
      const saved = writeStored(current.storageKey, { v: current.version, at, cats })
      unsaved = saved ? null : questionOf(current)
      setState({
        status: "decided",
        granted: grantsFrom(current, cats),
        source: "user",
        decidedAt: at,
      })
      setPanelOpen(false)
      onDecision?.(readConsent().granted, "user")
    },
    [onDecision]
  )

  const acceptAll = React.useCallback(() => {
    const answers: Record<string, boolean> = {}
    for (const id of configRef.current.optional) answers[id] = true
    commit(answers)
  }, [commit])

  const denyAll = React.useCallback(() => commit({}), [commit])

  const reset = React.useCallback(() => {
    const current = configRef.current
    try {
      window.localStorage.removeItem(current.storageKey)
    } catch {
      // Nothing was stored, or storage is blocked. Either way the state below is what applies.
    }
    // Forgetting the answer has to forget the unsaved one too, or a blocked-storage visitor can
    // never get the question back.
    unsaved = null
    setPanelOpen(false)
    hydrate(current)
  }, [])

  return {
    ...held.consent,
    categories: config.categories,
    isOpen: held.panelOpen,
    // Remembers what had focus so the banner can hand it back — the footer link that opened it,
    // which is still there once the panel closes.
    open: React.useCallback(() => {
      // No `typeof document` guard: this is only ever reached from a click, so there is a document
      // by construction, and a guard that cannot fail is a line that cannot be tested.
      const active = document.activeElement
      opener = active instanceof HTMLElement ? active : null
      setPanelOpen(true)
    }, []),
    close: React.useCallback(() => setPanelOpen(false), []),
    acceptAll,
    denyAll,
    save: commit,
    reset,
  }
}

// --- the gate --------------------------------------------------------------------------------

export interface ConsentGateProps {
  /** The category whose grant this content waits for. */
  category: string
  /** Rendered once that category is granted, and not before. */
  children?: React.ReactNode
  /** Rendered while it is not — a placeholder, or a note explaining what is switched off. */
  fallback?: React.ReactNode
}

/**
 * Renders `children` only while `category` is granted.
 *
 * **This is the half that makes the banner mean anything, and it only reaches what React renders.**
 * A tag in your document `<head>`, a `<script>` in a root layout outside a gate, or a module
 * imported for its side effects has already run by the time anybody is asked, and no banner can
 * un-send a request. Move the tag inside the gate — `<ConsentGate category="analytics"><Script
 * src="…" /></ConsentGate>` — and the deferral is real: the element is not rendered, so the script
 * is not fetched. Leave it where it was and this component is decoration over a site that tracks
 * people who said no.
 *
 * Unmounting on withdrawal is just as real for a script already loaded: removing a `<script>`
 * element does not unload what it installed. Withdrawal stops the next page, not this one — reload
 * after `denyAll` if that matters.
 */
export function ConsentGate({ category, children, fallback = null }: ConsentGateProps) {
  return <>{useConsent(category) ? children : fallback}</>
}

// --- the UI ----------------------------------------------------------------------------------

export interface CookieConsentProps
  extends UseCookieConsentOptions,
    Omit<React.ComponentPropsWithoutRef<"section">, "children" | "onChange" | "title"> {
  /** Heading on the banner. */
  title?: React.ReactNode
  /** The sentence under it. Say what the categories are for, not that cookies exist. */
  description?: React.ReactNode
  /** Your privacy policy link, rendered beside the buttons. */
  policy?: React.ReactNode
  /** Accessible name for the region. */
  label?: string
}

function Switch({
  checked,
  onChange,
  labelId,
  describedBy,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  labelId: string
  describedBy: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-[1.125rem]" : "translate-x-0.5"
        )}
      />
    </button>
  )
}

/**
 * Asks which categories of cookie may be used, remembers the answer — refusals included — and
 * hands it to `ConsentGate` and `useConsent`.
 *
 * Mount it once, unconditionally, near the root. It renders nothing until the answer is known, so
 * a returning visitor never sees the banner flash; it renders nothing while the browser is sending
 * a refusal signal, because that is already an answer; and it is a labelled region rather than a
 * modal dialog, so it never traps focus or holds up the first paint of the page behind it.
 */
export function CookieConsent({
  categories,
  version,
  storageKey,
  onDecision,
  title = "Cookies on this site",
  description = "We use cookies that the site needs to work. With your agreement we would also like to count visits and measure our campaigns. You can change this at any time.",
  policy,
  label = "Cookie consent",
  className,
  ...props
}: CookieConsentProps) {
  const consent = useCookieConsent({ categories, version, storageKey, onDecision })
  const baseId = React.useId()
  const panelRef = React.useRef<HTMLDivElement | null>(null)

  const [draft, setDraft] = React.useState<Record<string, boolean>>({})
  const [lastOpen, setLastOpen] = React.useState(false)

  // The switches start from whatever is granted now, so opening the panel after a decision shows
  // that decision rather than a fresh set of refusals.
  if (consent.isOpen !== lastOpen) {
    setLastOpen(consent.isOpen)
    if (consent.isOpen) {
      const next: Record<string, boolean> = {}
      for (const category of consent.categories) {
        if (!category.required) next[category.id] = consent.granted[category.id] === true
      }
      setDraft(next)
    }
  }

  const close = () => {
    consent.close()
    // Only for a panel opened from somewhere that still exists — the footer link. After an answer
    // the whole region unmounts and there is nothing of ours to go back to, which is the browser's
    // business rather than something to fake.
    takeOpener()?.focus()
  }

  React.useEffect(() => {
    if (consent.isOpen) panelRef.current?.focus()
  }, [consent.isOpen])

  // Not "undecided || isOpen" — a decided visitor who opens the panel from a footer link gets the
  // panel, and an undecided one gets the banner, but nobody gets a banner they have answered.
  const showing = consent.status === "undecided" || consent.isOpen
  if (!showing) return null

  const buttonBase =
    "inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

  return (
    <section
      role="region"
      aria-label={label}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 border-t bg-background p-4 text-foreground shadow-lg sm:inset-x-4 sm:bottom-4 sm:mx-auto sm:max-w-2xl sm:rounded-lg sm:border",
        className
      )}
      {...props}
    >
      {consent.isOpen ? (
        <div ref={panelRef} tabIndex={-1} className="focus-visible:outline-none">
          <h2 id={`${baseId}-title`} className="text-sm font-semibold">
            Choose which cookies to allow
          </h2>
          <ul className="mt-3 space-y-3">
            {consent.categories.map((category) => {
              const labelId = `${baseId}-${category.id}-label`
              const descriptionId = `${baseId}-${category.id}-description`
              return (
                <li key={category.id} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p id={labelId} className="text-sm font-medium">
                      {category.label}
                    </p>
                    <p id={descriptionId} className="text-sm text-muted-foreground">
                      {category.description}
                    </p>
                  </div>
                  {category.required ? (
                    // A disabled switch invites the person to try, then ignores them. Saying it
                    // in words is both truer and reachable.
                    <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                      Always on
                    </span>
                  ) : (
                    <Switch
                      checked={draft[category.id] === true}
                      onChange={(next) =>
                        setDraft((current) => ({ ...current, [category.id]: next }))
                      }
                      labelId={labelId}
                      describedBy={descriptionId}
                    />
                  )}
                </li>
              )
            })}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => consent.save(draft)}
              className={cn(buttonBase, "bg-primary text-primary-foreground hover:bg-primary/90")}
            >
              Save choices
            </button>
            <button
              type="button"
              onClick={consent.acceptAll}
              className={cn(buttonBase, "border hover:bg-accent hover:text-accent-foreground")}
            >
              Allow all
            </button>
            <button
              type="button"
              onClick={consent.denyAll}
              className={cn(buttonBase, "border hover:bg-accent hover:text-accent-foreground")}
            >
              Necessary only
            </button>
            {consent.status === "decided" ? (
              <button
                type="button"
                onClick={close}
                className={cn(buttonBase, "px-2 text-muted-foreground hover:text-foreground")}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <Cookie className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            {policy ? <p className="mt-1 text-sm">{policy}</p> : null}
          </div>
          {/* Equal weight on purpose. A refusal that is harder to find than the agreement is a
              dark pattern, and the regulators that require the question also require this. */}
          <div className="flex shrink-0 flex-wrap gap-2">
            <button
              type="button"
              onClick={consent.acceptAll}
              className={cn(buttonBase, "bg-primary text-primary-foreground hover:bg-primary/90")}
            >
              Allow all
            </button>
            <button
              type="button"
              onClick={consent.denyAll}
              className={cn(buttonBase, "border hover:bg-accent hover:text-accent-foreground")}
            >
              Necessary only
            </button>
            <button
              type="button"
              onClick={consent.open}
              className={cn(buttonBase, "px-2 text-muted-foreground hover:text-foreground")}
            >
              Choose
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
