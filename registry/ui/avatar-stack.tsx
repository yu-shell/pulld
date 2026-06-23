import * as React from "react"

import { cn } from "@/lib/utils"

interface AvatarStackProps extends React.ComponentPropsWithoutRef<"div"> {
  avatars: { src?: string; alt: string }[]
  /** Max avatars to show before collapsing the rest into a "+N" badge. */
  max?: number
}

export function AvatarStack({
  avatars,
  max = 4,
  className,
  ...props
}: AvatarStackProps) {
  const shown = avatars.slice(0, max)
  const overflow = avatars.length - shown.length

  return (
    <div className={cn("flex -space-x-2", className)} {...props}>
      {shown.map((a, i) => (
        <span
          key={i}
          className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-full border-2 border-background bg-muted text-xs font-medium text-muted-foreground"
        >
          {a.src ? (
            <img
              src={a.src}
              alt={a.alt}
              className="h-full w-full object-cover"
            />
          ) : (
            <span role="img" aria-label={a.alt}>
              {a.alt.charAt(0).toUpperCase()}
            </span>
          )}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-muted text-xs font-medium text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </div>
  )
}
