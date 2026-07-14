import * as React from "react"

import { cn } from "@/lib/utils"

interface FeatureCardProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
  /**
   * Leading icon, usually a lucide-react icon element. Rendered inside a
   * tinted square and marked decorative (`aria-hidden`) since the title
   * carries the meaning.
   */
  icon?: React.ReactNode
  /** Feature name, rendered as the card heading. */
  title: React.ReactNode
  /** Short supporting copy under the title. */
  description?: React.ReactNode
  /**
   * Make the whole card a link. When set, the card renders as an `<a>` with a
   * hover and `focus-visible` ring so the entire surface is the click target.
   */
  href?: string
  /** Accessible heading level for the title. Defaults to `h3`. */
  headingLevel?: "h2" | "h3" | "h4"
}

/**
 * An icon + title + description feature card for a "why us" / features grid on
 * a landing or marketing page. Set `href` to turn the whole card into a link
 * with hover and focus-visible states. Compose several in a responsive grid to
 * build a feature section. shadcn/ui ships no feature card. The icon is treated
 * as decorative; the title is a configurable heading level. Theme-aware via
 * shadcn tokens with dark mode.
 */
export function FeatureCard({
  icon,
  title,
  description,
  href,
  headingLevel = "h3",
  className,
  ...props
}: FeatureCardProps) {
  const Heading = headingLevel

  const body = (
    <>
      {icon ? (
        <span
          className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary [&_svg]:h-5 [&_svg]:w-5"
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}
      <Heading className="font-semibold tracking-tight">{title}</Heading>
      {description ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
      ) : null}
    </>
  )

  if (href) {
    return (
      <a
        href={href}
        className={cn(
          "block rounded-lg border bg-card p-6 text-card-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          className
        )}
      >
        {body}
      </a>
    )
  }

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-6 text-card-foreground",
        className
      )}
      {...props}
    >
      {body}
    </div>
  )
}
