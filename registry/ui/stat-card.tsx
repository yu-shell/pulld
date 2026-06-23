import * as React from "react"
import { ArrowDownRight, ArrowUpRight } from "lucide-react"

import { cn } from "@/lib/utils"

interface StatCardProps extends React.ComponentPropsWithoutRef<"div"> {
  label: string
  value: React.ReactNode
  /** Percentage change. Positive renders green/up, negative red/down. */
  delta?: number
  hint?: string
}

export function StatCard({
  label,
  value,
  delta,
  hint,
  className,
  ...props
}: StatCardProps) {
  const hasDelta = typeof delta === "number"
  const positive = hasDelta && delta >= 0

  return (
    <div
      className={cn("rounded-lg border bg-card p-4", className)}
      {...props}
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        {hasDelta ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-xs font-medium",
              positive ? "text-emerald-600" : "text-red-600"
            )}
          >
            {positive ? (
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            ) : (
              <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
            )}
            {Math.abs(delta)}%
          </span>
        ) : null}
      </div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}
