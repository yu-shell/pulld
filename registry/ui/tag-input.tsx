"use client"

import * as React from "react"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

interface TagInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange"
  > {
  /** Controlled list of tags. Pair with `onChange` to own the state. */
  value?: string[]
  /** Initial tags when uncontrolled. */
  defaultValue?: string[]
  /** Called with the next list whenever a tag is added or removed. */
  onChange?: (tags: string[]) => void
  /** Cap the number of tags; adding stops once the cap is reached. */
  max?: number
  /** Allow the same tag twice (default false; the existing match is case-insensitive). */
  allowDuplicates?: boolean
  /** Reject a candidate before it is added — return false to skip it. */
  validate?: (tag: string) => boolean
  /** Class for the inner <input>; the wrapper uses `className`. */
  inputClassName?: string
}

export const TagInput = React.forwardRef<HTMLInputElement, TagInputProps>(
  function TagInput(
    {
      className,
      inputClassName,
      value,
      defaultValue,
      onChange,
      max,
      allowDuplicates = false,
      validate,
      disabled,
      onKeyDown,
      onPaste,
      ...props
    },
    forwardedRef
  ) {
    const innerRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(
      forwardedRef,
      () => innerRef.current as HTMLInputElement
    )

    const isControlled = value !== undefined
    const [internal, setInternal] = React.useState<string[]>(
      () => (isControlled ? value : defaultValue) ?? []
    )
    const tags = isControlled ? (value as string[]) : internal

    const [draft, setDraft] = React.useState("")
    // Visually-hidden message so screen readers hear each add/remove.
    const [announce, setAnnounce] = React.useState("")

    function commit(next: string[], message: string) {
      if (!isControlled) setInternal(next)
      setAnnounce(message)
      onChange?.(next)
    }

    function addTag(raw: string) {
      const tag = raw.trim()
      if (!tag || disabled) return
      if (max !== undefined && tags.length >= max) return
      if (
        !allowDuplicates &&
        tags.some((t) => t.toLowerCase() === tag.toLowerCase())
      )
        return
      if (validate && !validate(tag)) return
      commit([...tags, tag], `Added ${tag}`)
    }

    function removeAt(index: number) {
      if (disabled) return
      const removed = tags[index]
      commit(
        tags.filter((_, i) => i !== index),
        `Removed ${removed}`
      )
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      onKeyDown?.(e)
      if (e.defaultPrevented) return
      if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
        // Keep Enter from submitting an enclosing form and "," from being typed.
        e.preventDefault()
        addTag(draft)
        setDraft("")
      } else if (e.key === "Backspace" && draft === "" && tags.length > 0) {
        removeAt(tags.length - 1)
      }
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      onPaste?.(e)
      if (e.defaultPrevented) return
      const text = e.clipboardData.getData("text")
      // Only intercept multi-value pastes; a single value falls through to typing.
      if (/[,\n]/.test(text)) {
        e.preventDefault()
        text
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean)
          .forEach(addTag)
        setDraft("")
      }
    }

    return (
      <div
        className={cn(
          "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-sm transition-colors focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
        onClick={() => {
          if (!disabled) innerRef.current?.focus()
        }}
      >
        {tags.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="inline-flex items-center gap-1 rounded bg-secondary py-0.5 pl-2 pr-1 text-xs font-medium text-secondary-foreground"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeAt(index)}
              disabled={disabled}
              aria-label={`Remove ${tag}`}
              tabIndex={-1}
              className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          ref={innerRef}
          type="text"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          className={cn(
            "h-7 min-w-[6rem] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
            inputClassName
          )}
          {...props}
        />
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
      </div>
    )
  }
)
