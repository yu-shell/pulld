"use client"

import * as React from "react"
import { Loader2, Search } from "lucide-react"

import { cn } from "@/lib/utils"

export interface CommandItem {
  id: string
  label: string
  group?: string
  /** Extra text matched against the query (synonyms, ids, etc.). */
  keywords?: string
  /** Keys shown on the right, e.g. ["⌘", "P"]. */
  shortcut?: string[]
  icon?: React.ReactNode
  onSelect?: () => void
}

interface CommandPaletteProps {
  /** Static commands. Ignored when `source` is provided. */
  items?: CommandItem[]
  /**
   * Async source for the current query — return the items to show. This is the
   * integration point for server-side or semantic search. The function identity
   * may change between renders; it is read from a ref, so an inline arrow is safe.
   *
   * For hosted semantic search with no infra to run, use the `pulldSearchSource`
   * helper exported below — `source={pulldSearchSource({ queryKey: "pk_..." })}`.
   */
  source?: (query: string) => Promise<CommandItem[]>
  placeholder?: string
  emptyMessage?: string
  /** Key combined with Cmd/Ctrl to toggle the palette. Default "k". */
  hotkey?: string
  /** localStorage key to remember recently selected items. Omit to disable. */
  recentsKey?: string
  /** Max results rendered at once (older entries are hidden behind a hint). */
  maxResults?: number
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    if (ms <= 0) {
      setV(value)
      return
    }
    const id = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(id)
  }, [value, ms])
  return v
}

// Subsequence fuzzy score: null when not a match, otherwise lower = better.
function fuzzyScore(text: string, q: string): number | null {
  if (!q) return 0
  const t = text.toLowerCase()
  const query = q.toLowerCase()
  let from = 0
  let score = 0
  let prev = -1
  for (const c of query) {
    const idx = t.indexOf(c, from)
    if (idx === -1) return null
    score += idx - from
    if (prev !== -1 && idx !== prev + 1) score += 1
    prev = idx
    from = idx + 1
  }
  return score
}

// Highlight the same subsequence positions the scorer matched on.
function highlight(label: string, query: string): React.ReactNode {
  const q = query.trim().toLowerCase()
  if (!q) return label
  const lower = label.toLowerCase()
  const marks = new Array<boolean>(label.length).fill(false)
  let from = 0
  for (const c of q) {
    const idx = lower.indexOf(c, from)
    if (idx === -1) return label // not a subsequence (e.g. async result) → no highlight
    marks[idx] = true
    from = idx + 1
  }
  const parts: React.ReactNode[] = []
  let i = 0
  while (i < label.length) {
    const on = marks[i]
    let j = i
    while (j < label.length && marks[j] === on) j++
    const chunk = label.slice(i, j)
    parts.push(
      on ? (
        <mark key={i} className="bg-transparent font-semibold text-foreground">
          {chunk}
        </mark>
      ) : (
        <React.Fragment key={i}>{chunk}</React.Fragment>
      )
    )
    i = j
  }
  return <>{parts}</>
}

export function CommandPalette({
  items = [],
  source,
  placeholder = "Type a command or search…",
  emptyMessage = "No results.",
  hotkey = "k",
  recentsKey,
  maxResults = 50,
  open: openProp,
  onOpenChange,
}: CommandPaletteProps) {
  const [openState, setOpenState] = React.useState(false)
  const open = openProp ?? openState
  const setOpen = React.useCallback(
    (v: boolean) => {
      onOpenChange?.(v)
      if (openProp === undefined) setOpenState(v)
    },
    [onOpenChange, openProp]
  )

  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const [asyncItems, setAsyncItems] = React.useState<CommandItem[] | null>(null)
  const [loading, setLoading] = React.useState(false)
  const debouncedQuery = useDebounced(query, source ? 180 : 0)

  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)
  const openedRef = React.useRef(false)
  const reqId = React.useRef(0)

  // Keep the latest `source` in a ref so an inline arrow doesn't re-fire the fetch effect.
  const sourceRef = React.useRef(source)
  React.useEffect(() => {
    sourceRef.current = source
  }, [source])
  const hasSource = !!source

  // Global hotkey to toggle (ignore auto-repeat so a held key doesn't flicker it).
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.repeat) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === hotkey.toLowerCase()) {
        e.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [hotkey, open, setOpen])

  // Focus the input on open; lock body scroll; restore the previous focus on close.
  React.useEffect(() => {
    if (open) {
      openedRef.current = true
      restoreRef.current = document.activeElement as HTMLElement | null
      setQuery("")
      setActive(0)
      const prevOverflow = document.body.style.overflow
      document.body.style.overflow = "hidden"
      const id = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => {
        window.clearTimeout(id)
        document.body.style.overflow = prevOverflow
      }
    }
    if (openedRef.current) {
      openedRef.current = false
      const el = restoreRef.current
      if (el && el.isConnected) el.focus()
    }
  }, [open])

  // Async source, keyed only on the query + open (source read from ref); stale-guarded.
  React.useEffect(() => {
    const src = sourceRef.current
    if (!src || !open) return
    const myId = ++reqId.current
    setLoading(true)
    Promise.resolve(src(debouncedQuery))
      .then((res) => {
        if (reqId.current === myId) {
          setAsyncItems(res)
          setLoading(false)
        }
      })
      .catch(() => {
        if (reqId.current === myId) {
          setAsyncItems([])
          setLoading(false)
        }
      })
  }, [debouncedQuery, open])

  const recents = React.useMemo<string[]>(() => {
    if (!recentsKey || typeof window === "undefined") return []
    try {
      const v = JSON.parse(window.localStorage.getItem(recentsKey) || "[]")
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentsKey, open])

  const results = React.useMemo<CommandItem[]>(() => {
    if (hasSource) return asyncItems ?? []
    if (!query) {
      const byId = new Map(items.map((i) => [i.id, i]))
      const recent = recents
        .map((id) => byId.get(id))
        .filter((x): x is CommandItem => Boolean(x))
      const rest = items.filter((i) => !recents.includes(i.id))
      return [...recent, ...rest]
    }
    return items
      .map((i) => ({ i, s: fuzzyScore(`${i.label} ${i.keywords ?? ""}`, query) }))
      .filter((x): x is { i: CommandItem; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .map((x) => x.i)
  }, [items, asyncItems, hasSource, query, recents])

  // Only render up to maxResults; everything (nav, aria) is based on this list.
  const shown = results.slice(0, Math.max(1, maxResults))
  // Clamp the active index during render so aria-activedescendant always resolves.
  const safeActive = shown.length ? Math.min(Math.max(0, active), shown.length - 1) : 0

  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${safeActive}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [safeActive])

  const select = React.useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return
      if (recentsKey) {
        try {
          const next = [item.id, ...recents.filter((id) => id !== item.id)].slice(0, 6)
          window.localStorage.setItem(recentsKey, JSON.stringify(next))
        } catch {
          /* ignore */
        }
      }
      setOpen(false)
      item.onSelect?.()
    },
    [recents, recentsKey, setOpen]
  )

  // All keys handled on the dialog so they work regardless of which child has focus.
  function onDialogKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setActive((a) => (shown.length ? (a + 1) % shown.length : 0))
        break
      case "ArrowUp":
        e.preventDefault()
        setActive((a) => (shown.length ? (a - 1 + shown.length) % shown.length : 0))
        break
      case "Enter":
        e.preventDefault()
        select(shown[safeActive])
        break
      case "Escape":
        e.preventDefault()
        setOpen(false)
        break
      case "Home":
        e.preventDefault()
        setActive(0)
        break
      case "End":
        e.preventDefault()
        setActive(shown.length - 1)
        break
      case "Tab":
        // Trap focus: the palette is driven by arrows, so keep focus on the input.
        e.preventDefault()
        inputRef.current?.focus()
        break
      default:
        break
    }
  }

  if (!open) return null

  const groups = new Map<string, CommandItem[]>()
  for (const it of shown) {
    const g = it.group ?? ""
    const arr = groups.get(g)
    if (arr) arr.push(it)
    else groups.set(g, [it])
  }

  let flatIndex = -1

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false)
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[15vh]"
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onDialogKeyDown}
        className="w-full max-w-xl overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            placeholder={placeholder}
            role="combobox"
            aria-expanded
            aria-controls="pulld-cmd-list"
            aria-activedescendant={shown.length ? `pulld-cmd-${safeActive}` : undefined}
            aria-autocomplete="list"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : null}
        </div>

        <div className="sr-only" role="status" aria-live="polite">
          {loading
            ? "Searching…"
            : `${results.length} result${results.length === 1 ? "" : "s"}`}
        </div>

        <div
          ref={listRef}
          id="pulld-cmd-list"
          role="listbox"
          aria-label="Results"
          aria-busy={loading}
          className="max-h-80 overflow-y-auto p-2"
        >
          {shown.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              {loading ? "Searching…" : emptyMessage}
            </div>
          ) : (
            [...groups.entries()].map(([group, gItems]) => (
              <div key={group || "_"} role="group" aria-label={group || undefined}>
                {group ? (
                  <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                    {group}
                  </div>
                ) : null}
                {gItems.map((it) => {
                  flatIndex += 1
                  const i = flatIndex
                  const isActive = i === safeActive
                  return (
                    <div
                      key={it.id}
                      id={`pulld-cmd-${i}`}
                      data-idx={i}
                      role="option"
                      aria-selected={isActive}
                      onMouseMove={() => setActive(i)}
                      onClick={() => select(it)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm",
                        isActive ? "bg-accent text-accent-foreground" : "text-foreground"
                      )}
                    >
                      {it.icon ? (
                        <span className="shrink-0 text-muted-foreground">{it.icon}</span>
                      ) : null}
                      <span className="flex-1 truncate">{highlight(it.label, query)}</span>
                      {it.shortcut?.length ? (
                        <span className="flex shrink-0 gap-1">
                          {it.shortcut.map((k, j) => (
                            <kbd
                              key={j}
                              className="rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ))
          )}
          {results.length > shown.length ? (
            <div className="px-3 py-2 text-center text-xs text-muted-foreground">
              Showing {shown.length} of {results.length} — keep typing to narrow.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/** A single result from the pulld Search query endpoint. */
interface PulldSearchResult {
  id: string
  label: string
  url: string
  snippet: string
  score: number
}

/**
 * Optional: a drop-in `source` backed by pulld Search — hosted semantic (meaning-based)
 * search with no infra to run. Subscribe at https://pulld.pages.dev, index your content,
 * then wire it in one line:
 *
 *   <CommandPalette source={pulldSearchSource({ queryKey: "pk_your_public_key" })} />
 *
 * It calls the public query endpoint and maps each result to a command item that
 * navigates to the result's URL on select. `queryKey` is the public, read-only key
 * (safe to ship in client code); pass `onSelect` to handle results yourself (e.g.
 * client-side routing) instead of a full-page navigation.
 *
 * To make results appear you must first index your content. Full integration guide
 * (keys, ingest, keeping the index in sync): https://pulld.pages.dev/search-integration.md
 */
export function pulldSearchSource(opts: {
  queryKey: string
  /** Override the endpoint, e.g. when serving pulld Search from your own domain. */
  endpoint?: string
  /** Max results to request (default 8). */
  limit?: number
  onSelect?: (result: PulldSearchResult) => void
}): (query: string) => Promise<CommandItem[]> {
  const endpoint = opts.endpoint ?? "https://pulld.pages.dev/api/search/query"
  const limit = opts.limit ?? 8
  return async (query) => {
    // Fail soft: a search backend hiccup yields no results rather than breaking the palette.
    try {
      const url = `${endpoint}?key=${encodeURIComponent(opts.queryKey)}&q=${encodeURIComponent(
        query
      )}&limit=${limit}`
      const res = await fetch(url)
      if (!res.ok) return []
      const data = (await res.json()) as { results?: PulldSearchResult[] }
      return (data.results ?? []).map((r) => ({
        id: r.id,
        label: r.label,
        keywords: r.snippet,
        onSelect: opts.onSelect
          ? () => opts.onSelect!(r)
          : r.url
            ? () => {
                window.location.href = r.url
              }
            : undefined,
      }))
    } catch {
      return []
    }
  }
}
