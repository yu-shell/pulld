"use client"

import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

export interface Step {
  /** Short label shown beneath the step marker. */
  label: string
  /** Optional secondary line, e.g. a hint or status. */
  description?: string
}

type StepStatus = "complete" | "current" | "upcoming"

interface StepIndicatorProps
  extends Omit<React.ComponentPropsWithoutRef<"ol">, "onClick"> {
  /** Ordered steps, rendered left to right. */
  steps: Step[]
  /**
   * Zero-based index of the active step. Everything before it is treated as
   * complete, everything after it as upcoming.
   */
  current: number
  /**
   * Make already-reached steps (complete + current) navigable. Fires with the
   * step index. Upcoming steps stay non-interactive. Omit for a display-only
   * indicator.
   */
  onStepClick?: (index: number) => void
  /** Accessible name for the progress list, e.g. "Checkout" or "Onboarding". */
  "aria-label"?: string
}

const STATUS_LABEL: Record<StepStatus, string> = {
  complete: "Completed",
  current: "Current step",
  upcoming: "Not completed",
}

export const StepIndicator = React.forwardRef<
  HTMLOListElement,
  StepIndicatorProps
>(function StepIndicator(
  { className, steps, current, onStepClick, "aria-label": ariaLabel, ...props },
  ref
) {
  const lastIndex = steps.length - 1

  return (
    <ol
      ref={ref}
      aria-label={ariaLabel}
      className={cn("flex w-full", className)}
      {...props}
    >
      {steps.map((step, i) => {
        const status: StepStatus =
          i < current ? "complete" : i === current ? "current" : "upcoming"
        const isLast = i === lastIndex
        // Reached steps can be revisited; upcoming ones can't.
        const clickable = Boolean(onStepClick) && status !== "upcoming"

        const marker = (
          <span
            className={cn(
              "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-medium transition-colors",
              status === "complete" &&
                "border-transparent bg-primary text-primary-foreground",
              status === "current" &&
                "border-primary bg-background text-primary",
              status === "upcoming" &&
                "border-muted-foreground/30 bg-background text-muted-foreground",
              clickable &&
                "transition-transform group-hover:scale-105 group-focus-visible:scale-105"
            )}
          >
            {status === "complete" ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              i + 1
            )}
          </span>
        )

        const labelBlock = (
          <span className="mt-2 flex max-w-[9rem] flex-col items-center gap-0.5 px-1 text-center">
            <span
              className={cn(
                "text-sm font-medium leading-tight",
                status === "upcoming"
                  ? "text-muted-foreground"
                  : "text-foreground"
              )}
            >
              {step.label}
            </span>
            {step.description ? (
              <span className="text-xs leading-tight text-muted-foreground">
                {step.description}
              </span>
            ) : null}
          </span>
        )

        return (
          <li
            key={i}
            aria-current={status === "current" ? "step" : undefined}
            className="relative flex flex-1 flex-col items-center"
          >
            {/* Connector to the next marker: spans from this marker's centre
                one full (equal-width) cell to the right, i.e. the next centre.
                Markers sit above it (z-10, solid bg) so the ends are masked. */}
            {!isLast ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-1/2 top-4 h-0.5 w-full -translate-y-1/2",
                  i < current ? "bg-primary" : "bg-border"
                )}
              />
            ) : null}

            {clickable ? (
              <button
                type="button"
                onClick={() => onStepClick?.(i)}
                aria-label={`Go to step ${i + 1}: ${step.label}`}
                className="group flex flex-col items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                {marker}
                {labelBlock}
              </button>
            ) : (
              <div className="flex flex-col items-center">
                {marker}
                {labelBlock}
              </div>
            )}

            <span className="sr-only">{STATUS_LABEL[status]}</span>
          </li>
        )
      })}
    </ol>
  )
})
