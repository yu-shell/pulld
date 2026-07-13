import * as React from "react"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * A single plan feature. Pass a string for an included feature, or an object to
 * mark it excluded (rendered muted with a strikethrough and an accessible
 * "not included" label).
 */
export type PricingFeature = string | { text: string; included?: boolean }

interface PricingCardProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
  /** Plan name, e.g. "Pro". Rendered as the card heading. */
  name: string
  /** The price, e.g. "$29" or a custom node. Kept flexible for "Free"/"Custom". */
  price: React.ReactNode
  /** Billing period shown next to the price, e.g. "/mo". */
  period?: string
  /** Short plan description under the name. */
  description?: string
  /** Feature list. Strings are included; objects can be marked excluded. */
  features?: PricingFeature[]
  /** Call-to-action, usually a link or button rendered under the features. */
  cta?: React.ReactNode
  /**
   * Highlight this plan: adds a primary ring and shows a badge. Use for the
   * recommended tier in a pricing row.
   */
  featured?: boolean
  /** Badge content shown when `featured` (or whenever provided). Defaults to "Most popular". */
  badge?: React.ReactNode
  /** Accessible heading level for the plan name. Defaults to `h3`. */
  headingLevel?: "h2" | "h3" | "h4"
}

function normalize(feature: PricingFeature): { text: string; included: boolean } {
  return typeof feature === "string"
    ? { text: feature, included: true }
    : { text: feature.text, included: feature.included !== false }
}

/**
 * A pricing plan card: plan name, price with billing period, an optional
 * description, a checked/unchecked feature list, and a call-to-action. Set
 * `featured` to highlight the recommended tier with a ring and a badge. Compose
 * several side by side for a pricing page or upsell/paywall row. shadcn/ui ships
 * no pricing card. Theme-aware via shadcn tokens with dark mode.
 */
export function PricingCard({
  name,
  price,
  period,
  description,
  features,
  cta,
  featured = false,
  badge,
  headingLevel = "h3",
  className,
  ...props
}: PricingCardProps) {
  const Heading = headingLevel
  const badgeContent = badge ?? (featured ? "Most popular" : null)

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-lg border bg-card p-6 text-card-foreground",
        featured && "border-primary ring-1 ring-primary",
        className
      )}
      {...props}
    >
      {badgeContent ? (
        <span className="absolute -top-3 left-6 inline-flex items-center rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
          {badgeContent}
        </span>
      ) : null}

      <Heading className="text-lg font-semibold tracking-tight">{name}</Heading>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight">{price}</span>
        {period ? (
          <span className="text-sm text-muted-foreground">{period}</span>
        ) : null}
      </div>

      {features && features.length > 0 ? (
        <ul className="mt-6 flex-1 space-y-3 text-sm">
          {features.map((feature, i) => {
            const { text, included } = normalize(feature)
            return (
              <li key={i} className="flex items-start gap-2">
                {included ? (
                  <Check
                    className="mt-0.5 h-4 w-4 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                ) : (
                  <Minus
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <span className={cn(!included && "text-muted-foreground line-through")}>
                  {!included ? <span className="sr-only">Not included: </span> : null}
                  {text}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}

      {cta ? <div className="mt-6">{cta}</div> : null}
    </div>
  )
}
