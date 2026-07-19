"use client"

import * as React from "react"
import { Pencil } from "lucide-react"

import { cn } from "@/lib/utils"

interface InlineEditProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onSubmit"
  > {
  /** Text shown when not editing and used as the starting point for the draft. */
  value: string
  /** Called with the trimmed draft when the user commits an actual change. */
  onSave: (value: string) => void
  /** Accessible label for both the edit trigger and the input (e.g. "Project name"). */
  label: string
  /** Muted text shown in place of an empty value (e.g. "Add a title"). */
  placeholder?: string
  /** Commit the draft when the input loses focus; set false to require Enter. Defaults to true. */
  saveOnBlur?: boolean
}

/**
 * Click-to-edit text: shows a value as plain text with a pencil affordance, then
 * swaps to an input in place when activated. Enter (or blur) commits, Escape
 * reverts to the original. Use it to rename a title, board, or file, edit a table
 * cell, or tweak a profile/settings field without opening a separate dialog or
 * form. shadcn/ui ships no inline edit; this is keyboard-accessible, theme-aware
 * via shadcn tokens, and has no extra dependencies.
 */
export function InlineEdit({
  value,
  onSave,
  label,
  placeholder = "Empty",
  saveOnBlur = true,
  className,
  disabled,
  onKeyDown,
  ...props
}: InlineEditProps) {
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const inputRef = React.useRef<HTMLInputElement>(null)

  // Focus and select the input once it mounts so typing replaces the value.
  React.useEffect(() => {
    if (!editing) return
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [editing])

  function startEditing() {
    if (disabled) return
    setDraft(value)
    setEditing(true)
  }

  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next !== value) onSave(next)
  }

  function cancel() {
    setEditing(false)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancel()
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        disabled={disabled}
        className={cn(
          "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className
        )}
        {...props}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={saveOnBlur ? commit : cancel}
      />
    )
  }

  const isEmpty = value.trim() === ""

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`Edit ${label}`}
      onClick={startEditing}
      className={cn(
        "group inline-flex h-9 w-full items-center gap-2 rounded-md border border-transparent px-3 py-1 text-left text-sm transition-colors hover:border-input hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
    >
      <span className={cn("truncate", isEmpty && "text-muted-foreground")}>
        {isEmpty ? placeholder : value}
      </span>
      <Pencil
        className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        aria-hidden="true"
      />
    </button>
  )
}
