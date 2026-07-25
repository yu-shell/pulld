"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

interface TypeToConfirmProps
  extends Omit<React.ComponentPropsWithoutRef<"form">, "onSubmit"> {
  /**
   * The exact text the user has to type back, normally the resource's own name
   * ("acme-prod"). A name is what makes the gesture deliberate — a generic word
   * like DELETE becomes muscle memory and gets typed into the wrong dialog.
   */
  phrase: string
  /** Runs on submit, once what was typed matches `phrase`. */
  onConfirm: () => void
  /** Label above the field. Defaults to "Type <phrase> to confirm". */
  label?: React.ReactNode
  /**
   * The sentence under the field. It explains why the button is disabled, and
   * is what the field points at with `aria-describedby`.
   */
  description?: React.ReactNode
  /** Text of the destructive submit button. */
  actionLabel?: string
  /** Button text while the request runs. */
  pendingLabel?: string
  /** Mirror of your mutation's in-flight state; locks the field and button. */
  pending?: boolean
  /** Compare exactly. Turn off to let "delete" pass for "DELETE". */
  caseSensitive?: boolean
}

/**
 * The confirmation step in front of an irreversible action: the user has to
 * type the resource's name before the destructive button turns on. Drop it into
 * an alert dialog or a "danger zone" card.
 *
 * Both sides are trimmed before comparing, so a pasted name that picked up a
 * trailing space still matches, and an empty `phrase` never matches at all —
 * otherwise an untouched field would arm a delete. The field opts out of
 * autocomplete, autocorrect, autocapitalisation and spellcheck: on a phone the
 * first letter would otherwise be capitalised and an exact match made
 * impossible to type.
 *
 * The button is genuinely `disabled` rather than `aria-disabled`. A disabled
 * control is skipped by screen readers, which is normally a reason to avoid it,
 * but here nothing is hidden by that: the label states exactly what to type,
 * the description says the button is waiting for it, and a live region
 * announces the moment it turns on. For an action that cannot be undone,
 * refusing the click outright beats a button that looks armed and explains
 * itself only after it has been pressed.
 */
export function TypeToConfirm({
  phrase,
  onConfirm,
  label,
  description,
  actionLabel = "Delete",
  pendingLabel = "Deleting…",
  pending = false,
  caseSensitive = true,
  className,
  ...props
}: TypeToConfirmProps) {
  const inputId = React.useId()
  const descriptionId = React.useId()
  const [typed, setTyped] = React.useState("")

  const normalize = (value: string) =>
    caseSensitive ? value.trim() : value.trim().toLowerCase()

  const matches = phrase.trim() !== "" && normalize(typed) === normalize(phrase)
  const armed = matches && !pending

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!armed) return
    onConfirm()
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={pending || undefined}
      className={cn("flex flex-col gap-2", className)}
      {...props}
    >
      <label htmlFor={inputId} className="text-sm text-muted-foreground">
        {label ?? (
          <>
            Type{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] font-medium text-foreground">
              {phrase}
            </code>{" "}
            to confirm
          </>
        )}
      </label>

      <input
        id={inputId}
        type="text"
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        disabled={pending}
        aria-describedby={descriptionId}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />

      <p id={descriptionId} className="text-xs text-muted-foreground">
        {description ?? (
          <>
            This can&apos;t be undone. {actionLabel} stays disabled until the
            text matches.
          </>
        )}
      </p>

      {/*
        Mounted at all times and empty until it has something to say: a live
        region inserted together with its text is not reliably announced, so a
        region that appeared only on match would swallow the very update it
        exists for.
      */}
      <p role="status" className="sr-only">
        {armed ? `${phrase} matches. ${actionLabel} is now enabled.` : ""}
      </p>

      <button
        type="submit"
        disabled={!armed}
        className="inline-flex h-9 w-full items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive disabled:pointer-events-none disabled:opacity-50"
      >
        {pending ? pendingLabel : actionLabel}
      </button>
    </form>
  )
}
