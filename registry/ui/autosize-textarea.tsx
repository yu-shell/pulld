"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface AutosizeTextareaProps extends React.ComponentPropsWithoutRef<"textarea"> {
  /** Smallest height, in rows, the field shrinks back to when empty. Defaults to 2. */
  minRows?: number
  /** Tallest height, in rows, before the field stops growing and scrolls instead. */
  maxRows?: number
}

// useLayoutEffect measures before paint so the field never flashes at the wrong
// height, but it warns during SSR — fall back to useEffect on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * A textarea that grows with its content and stops at maxRows. Use it for chat
 * and AI prompt composers, comment and reply boxes, commit or PR descriptions,
 * bios, and any "message" field where a fixed height either wastes space or hides
 * what was typed. shadcn/ui's textarea is fixed-height; this measures the real
 * line height so it honours your own font and padding, keeps the native element
 * (so form libraries, labels, and validation work unchanged), and adds no
 * dependencies.
 */
export const AutosizeTextarea = React.forwardRef<
  HTMLTextAreaElement,
  AutosizeTextareaProps
>(function AutosizeTextarea(
  { className, minRows = 2, maxRows, value, onChange, rows, ...props },
  forwardedRef
) {
  const innerRef = React.useRef<HTMLTextAreaElement>(null)
  React.useImperativeHandle(
    forwardedRef,
    () => innerRef.current as HTMLTextAreaElement
  )

  const resize = React.useCallback(() => {
    const el = innerRef.current
    if (!el) return

    const styles = window.getComputedStyle(el)
    const fontSize = parseFloat(styles.fontSize)
    // line-height resolves to "normal" unless it is set explicitly; approximate it.
    const lineHeight = parseFloat(styles.lineHeight) || fontSize * 1.5
    const padding =
      parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom)
    // scrollHeight covers content + padding, so border-box heights need the border too.
    const extra =
      styles.boxSizing === "border-box"
        ? padding +
          parseFloat(styles.borderTopWidth) +
          parseFloat(styles.borderBottomWidth)
        : 0

    const min = lineHeight * minRows + extra
    const max = maxRows ? lineHeight * maxRows + extra : Number.POSITIVE_INFINITY

    // Collapse first so scrollHeight reports the content height rather than the
    // height we set on the previous keystroke — otherwise it can only grow.
    el.style.height = "auto"
    const target = el.scrollHeight - padding + extra
    el.style.height = `${Math.min(Math.max(target, min), max)}px`
    el.style.overflowY = target > max ? "auto" : "hidden"
  }, [minRows, maxRows])

  // Re-measure on every controlled value change, and once on mount.
  useIsomorphicLayoutEffect(resize, [resize, value])

  // A narrower field rewraps its text, which changes the height it needs.
  React.useEffect(() => {
    window.addEventListener("resize", resize)
    return () => window.removeEventListener("resize", resize)
  }, [resize])

  function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange?.(event)
    // Uncontrolled fields get no value prop to react to, so measure here too.
    resize()
  }

  return (
    <textarea
      ref={innerRef}
      // Renders at roughly the right height before hydration measures it.
      rows={rows ?? minRows}
      value={value}
      onChange={handleChange}
      className={cn(
        "flex w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
})
