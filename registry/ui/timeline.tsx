import * as React from "react"

import { cn } from "@/lib/utils"

type TimelineColor =
  | "muted"
  | "primary"
  | "success"
  | "warning"
  | "destructive"

// Marker fill per accent. `muted`/`primary`/`destructive` ride shadcn tokens so
// they follow the theme; `success`/`warning` use solid mid-tone status colors
// (same convention as pulld's stat-card) since shadcn ships no such token.
const DOT_COLOR: Record<TimelineColor, string> = {
  muted: "bg-muted-foreground/40",
  primary: "bg-primary",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  destructive: "bg-destructive",
}

export interface TimelineItem {
  /** Main heading for the event. */
  title: React.ReactNode
  /**
   * Human-readable timestamp shown above the title, e.g. "3m ago" or
   * "Mar 4, 2026".
   */
  time?: string
  /** Machine-readable value for the rendered <time> element (e.g. an ISO date). */
  dateTime?: string
  /** Optional details rendered under the title. */
  description?: React.ReactNode
  /**
   * Optional element (e.g. a lucide-react icon) rendered inside the marker
   * instead of the default dot.
   */
  icon?: React.ReactNode
  /** Accent color for the marker. Defaults to "muted". */
  color?: TimelineColor
}

interface TimelineProps extends React.ComponentPropsWithoutRef<"ol"> {
  /** Events in the order they should appear, top to bottom. */
  items: TimelineItem[]
}

/**
 * Vertical timeline: a list of events, each a marker on a connecting line with
 * an optional time, title, and description.
 */
export const Timeline = React.forwardRef<HTMLOListElement, TimelineProps>(
  function Timeline({ items, className, ...props }, ref) {
    const lastIndex = items.length - 1

    return (
      <ol ref={ref} className={cn("relative", className)} {...props}>
        {items.map((item, i) => {
          const isLast = i === lastIndex
          const color = item.color ?? "muted"

          return (
            <li key={i} className="relative flex gap-4 pb-8 last:pb-0">
              {/* Connector: centered on the marker and drawn behind it. Runs
                  from this marker's center down to the next marker's center;
                  omitted on the last item. The marker's solid fill masks it
                  where they overlap. */}
              {!isLast ? (
                <span
                  aria-hidden="true"
                  className="absolute left-3 top-3 h-full w-px -translate-x-1/2 bg-border"
                />
              ) : null}

              {/* Marker: an icon badge when an icon is given, otherwise a dot.
                  The ring / bg-background halo separates it from the line. */}
              <span className="relative z-10 flex h-6 w-6 shrink-0 items-center justify-center">
                {item.icon ? (
                  <span
                    aria-hidden="true"
                    className="flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5"
                  >
                    {item.icon}
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "h-3 w-3 rounded-full ring-4 ring-background",
                      DOT_COLOR[color]
                    )}
                  />
                )}
              </span>

              {/* Content */}
              <div className="flex-1 pt-0.5">
                {item.time ? (
                  <time
                    dateTime={item.dateTime}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {item.time}
                  </time>
                ) : null}
                <p className="text-sm font-medium leading-tight text-foreground">
                  {item.title}
                </p>
                {item.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.description}
                  </p>
                ) : null}
              </div>
            </li>
          )
        })}
      </ol>
    )
  }
)
