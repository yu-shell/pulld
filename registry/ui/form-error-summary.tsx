"use client"

import * as React from "react"
import { CircleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

export interface FormErrorSummaryItem {
  /**
   * `id` of the invalid control, or of the wrapper for a grouped control (radio
   * group, custom select). Omit it for form-level errors that belong to no
   * single field — those render as plain text instead of a link.
   */
  fieldId?: string
  /** The message, worded the same as the field's own inline error. */
  message: string
}

interface FormErrorSummaryProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
  /**
   * The failed validations, in the order the fields appear in the form. An
   * empty list renders nothing, so the summary can be rendered unconditionally.
   */
  errors: FormErrorSummaryItem[]
  /** Heading. Defaults to a sentence that counts the problems. */
  title?: React.ReactNode
  /** Heading level, so the summary fits the outline of the page it sits in. */
  headingLevel?: 2 | 3 | 4
  /** Move focus to the summary when it appears. */
  focusOnError?: boolean
  /**
   * Bump on every submit attempt (react-hook-form's `formState.submitCount`) so
   * a retry that fails the same way still moves focus back here.
   */
  focusKey?: number | string
}

const FOCUSABLE = [
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",")

/**
 * Focuses the field a message points at. `fieldId` may name the control itself
 * or a wrapper — radio groups, checkbox groups and custom comboboxes describe
 * their error on a container, so fall back to the first focusable thing inside
 * it. Returns false when nothing focusable is found, which lets the link fall
 * back to plain fragment navigation.
 */
function focusField(fieldId: string) {
  const el = document.getElementById(fieldId)
  if (!el) return false
  const target = el.matches(FOCUSABLE)
    ? el
    : el.querySelector<HTMLElement>(FOCUSABLE)
  if (!target) return false
  target.focus()
  return true
}

/**
 * The block that appears above a form after a failed submit: "There are 3
 * problems with your submission", then one link per error that focuses the
 * field it came from.
 *
 * It announces by moving focus to itself, not through a live region. A live
 * region would read the messages out but leave focus where it was, so the links
 * that lead to the offending fields are somewhere the user then has to hunt
 * for; doing both instead announces the same text twice. Focus lands on a
 * container labelled by the heading, so the count is read first and the list is
 * the very next thing in reading order.
 *
 * The container therefore uses a plain `focus:` ring rather than
 * `focus-visible:` — focus arrives programmatically here, which browsers do not
 * reliably treat as visible, and a sighted keyboard user would otherwise have
 * no idea where their focus went.
 */
export function FormErrorSummary({
  errors,
  title,
  headingLevel = 2,
  focusOnError = true,
  focusKey,
  className,
  ...props
}: FormErrorSummaryProps) {
  const ref = React.useRef<HTMLDivElement>(null)
  const titleId = React.useId()
  const count = errors.length
  const Heading = `h${headingLevel}` as const

  // What counts as "a new failed attempt". With `focusKey` that is the submit
  // itself, so submitting twice with the same errors still re-focuses; without
  // it, only a change in the messages can be detected.
  const attempt =
    focusKey !== undefined
      ? String(focusKey)
      : errors.map((error) => `${error.fieldId ?? ""}:${error.message}`).join("|")

  React.useEffect(() => {
    if (!focusOnError || count === 0) return
    ref.current?.focus()
  }, [attempt, count, focusOnError])

  if (count === 0) return null

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-labelledby={titleId}
      className={cn(
        "rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-destructive",
        className
      )}
      {...props}
    >
      <Heading
        id={titleId}
        className="flex items-center gap-2 font-medium text-destructive"
      >
        <CircleAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
        {title ??
          (count === 1
            ? "There is 1 problem with your submission"
            : `There are ${count} problems with your submission`)}
      </Heading>
      <ul className="mt-2 list-disc space-y-1 pl-10 text-destructive">
        {errors.map(({ fieldId, message }, index) => (
          <li key={`${fieldId ?? "form"}-${index}`}>
            {fieldId ? (
              <a
                href={`#${fieldId}`}
                onClick={(event) => {
                  if (focusField(fieldId)) event.preventDefault()
                }}
                className="rounded-sm underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
              >
                {message}
              </a>
            ) : (
              message
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
