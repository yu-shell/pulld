"use client"

import * as React from "react"
import { Check, ChevronDown, X } from "lucide-react"

import { cn } from "@/lib/utils"

export interface MultiSelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface MultiSelectProps {
  options: MultiSelectOption[]
  /** Controlled list of selected values. Pair with `onChange` to own the state. */
  value?: string[]
  /** Initial selection when uncontrolled. */
  defaultValue?: string[]
  /** Called with the next selection whenever an option is toggled or removed. */
  onChange?: (values: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  /** Cap the number of selected values; unselected options disable at the cap. */
  max?: number
  /** Hide the search box (useful for short lists). */
  hideSearch?: boolean
  disabled?: boolean
  className?: string
  /** Accessible name for the control (or wire `aria-labelledby` to a form label). */
  "aria-label"?: string
  "aria-labelledby"?: string
}

export function MultiSelect({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No options found.",
  max,
  hideSearch = false,
  disabled = false,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: MultiSelectProps) {
  const isControlled = value !== undefined
  const [internal, setInternal] = React.useState<string[]>(
    () => (isControlled ? value : defaultValue) ?? []
  )
  const selected = isControlled ? (value as string[]) : internal

  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  // Visually-hidden message so screen readers hear each toggle.
  const [announce, setAnnounce] = React.useState("")

  const id = React.useId()
  const listboxId = `${id}-listbox`
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLUListElement>(null)

  const atCap = max !== undefined && selected.length >= max

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  const byValue = React.useMemo(() => {
    const m = new Map<string, MultiSelectOption>()
    for (const o of options) m.set(o.value, o)
    return m
  }, [options])

  function commit(next: string[], message: string) {
    if (!isControlled) setInternal(next)
    setAnnounce(message)
    onChange?.(next)
  }

  function toggle(option: MultiSelectOption) {
    if (disabled || option.disabled) return
    if (selected.includes(option.value)) {
      commit(
        selected.filter((v) => v !== option.value),
        `${option.label} deselected`
      )
    } else {
      if (atCap) return
      commit([...selected, option.value], `${option.label} selected`)
    }
  }

  const openPanel = React.useCallback(() => {
    if (disabled) return
    setOpen(true)
    setQuery("")
    setActive(0)
  }, [disabled])

  const closePanel = React.useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  // Focus the search box when the panel opens (fall back to the list for hideSearch).
  React.useEffect(() => {
    if (!open) return
    const el = hideSearch ? listRef.current : searchRef.current
    const t = window.setTimeout(() => el?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open, hideSearch])

  // Close on an outside pointer press (capture pointerdown so it beats focus moves).
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) closePanel(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open, closePanel])

  // Clamp the active row when the filter shrinks the list.
  React.useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Keep the active row visible while arrowing through a scrolled list.
  React.useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector(`#${CSS.escape(`${id}-opt-${active}`)}`)
      ?.scrollIntoView({ block: "nearest" })
  }, [active, open, id])

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    if (disabled) return
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault()
      openPanel()
    } else if (e.key === "Backspace" && selected.length > 0) {
      const last = byValue.get(selected[selected.length - 1])
      commit(selected.slice(0, -1), `${last?.label ?? "option"} deselected`)
    }
  }

  function handlePanelKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      const option = filtered[active]
      if (option) toggle(option)
    } else if (e.key === "Escape") {
      e.preventDefault()
      closePanel(true)
    } else if (e.key === "Tab") {
      closePanel(false)
    } else if (e.key === "Backspace" && query === "" && selected.length > 0) {
      const last = byValue.get(selected[selected.length - 1])
      commit(selected.slice(0, -1), `${last?.label ?? "option"} deselected`)
    }
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {/* Trigger is a div combobox (not <button>) so the badge remove buttons stay valid HTML. */}
      <div
        ref={triggerRef}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        aria-disabled={disabled || undefined}
        onClick={() => (open ? closePanel(false) : openPanel())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "flex min-h-9 w-full cursor-pointer flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent py-1 pl-2 pr-8 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          disabled && "pointer-events-none opacity-50"
        )}
      >
        {selected.length === 0 && (
          <span className="px-1 text-muted-foreground">{placeholder}</span>
        )}
        {selected.map((v) => {
          const option = byValue.get(v)
          const label = option?.label ?? v
          return (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded bg-secondary py-0.5 pl-2 pr-1 text-xs font-medium text-secondary-foreground"
            >
              {label}
              <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                aria-label={`Remove ${label}`}
                onClick={(e) => {
                  e.stopPropagation() // keep a badge removal from toggling the panel
                  commit(
                    selected.filter((s) => s !== v),
                    `${label} deselected`
                  )
                }}
                className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </span>
          )
        })}
        <ChevronDown
          className={cn(
            "absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </div>

      {open && (
        <div
          onKeyDown={handlePanelKeyDown}
          className="absolute z-50 mt-1 w-full min-w-[8rem] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          {!hideSearch && (
            <input
              ref={searchRef}
              type="text"
              role="searchbox"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listboxId}
              aria-activedescendant={
                filtered.length > 0 ? `${id}-opt-${active}` : undefined
              }
              className="w-full border-b bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
            />
          )}
          <ul
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-multiselectable="true"
            tabIndex={hideSearch ? 0 : -1}
            aria-activedescendant={
              hideSearch && filtered.length > 0 ? `${id}-opt-${active}` : undefined
            }
            className="max-h-60 overflow-y-auto p-1 focus-visible:outline-none"
          >
            {filtered.length === 0 && (
              <li className="px-2 py-4 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </li>
            )}
            {filtered.map((option, index) => {
              const isSelected = selected.includes(option.value)
              const isBlocked = option.disabled || (atCap && !isSelected)
              return (
                <li
                  key={option.value}
                  id={`${id}-opt-${index}`}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={isBlocked || undefined}
                  onPointerMove={() => setActive(index)}
                  // Keep focus in the search box so arrow keys still work after a click.
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => toggle(option)}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                    index === active && "bg-accent text-accent-foreground",
                    isBlocked && "cursor-not-allowed opacity-50"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "opacity-50"
                    )}
                    aria-hidden="true"
                  >
                    {isSelected && <Check className="h-3 w-3" />}
                  </span>
                  {option.label}
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
    </div>
  )
}
