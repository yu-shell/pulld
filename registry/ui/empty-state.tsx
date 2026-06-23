import * as React from "react"

import { cn } from "@/lib/utils"

interface EmptyStateProps extends React.ComponentPropsWithoutRef<"div"> {
  /** Optional leading icon (e.g. a lucide-react icon element). */
  icon?: React.ReactNode
  title: string
  description?: string
  /** Optional call-to-action, usually a button. */
  action?: React.ReactNode
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center",
        className
      )}
      {...props}
    >
      {icon ? (
        <div className="mb-3 text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-medium">{title}</h3>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
