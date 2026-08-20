"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface TimeZoneSelectProps
  extends Omit<
    React.ComponentPropsWithoutRef<"select">,
    "value" | "defaultValue" | "onChange" | "children"
  > {
  /** Controlled IANA time zone id, e.g. "Europe/Berlin". Pair with `onValueChange`. */
  value?: string
  /** Starting zone for an uncontrolled select. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen IANA id. Never called with a display label. */
  onValueChange?: (timeZone: string) => void
  /**
   * Shown as an empty first option, e.g. "Select a time zone". Omit it and the select starts
   * on whatever `value`/`defaultValue` says. Its option carries the empty string, so `required`
   * still fails an untouched field.
   */
  placeholder?: string
  /**
   * The instant the offsets are read at (default: when the component mounts). Offsets are a
   * function of the date, not a property of the zone — Europe/Berlin is +01:00 in January and
   * +02:00 in July — so a picker for a meeting in three months should pass that meeting's date
   * rather than show today's offsets against it.
   */
  referenceDate?: Date
  /**
   * The zones to offer, in place of every zone the runtime knows. Pass this to narrow the list
   * to the places a product actually operates in, or to supply one on a runtime without
   * `Intl.supportedValuesOf`.
   */
  timeZones?: readonly string[]
}

/** Just enough of the ES2022 signature to feature-detect without widening the lib target. */
interface IntlWithSupportedValues {
  supportedValuesOf?: (key: "timeZone") => string[]
}

/** "GMT+05:30", "GMT-04:00", or a bare "GMT" for zones sitting exactly on the meridian. */
const OFFSET_PATTERN = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/

/**
 * The visitor's own zone, or "UTC" where the runtime will not say.
 *
 * Exported because seeding the field with it is the common case and it is not the component's
 * job to guess: pass it to `defaultValue` from a client effect or from state, **not** from a
 * render that also runs on the server — the server's zone is the machine's, and rendering the
 * two against each other is the classic hydration mismatch.
 */
export function getLocalTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/**
 * Every zone the runtime knows, plus UTC.
 *
 * `Intl.supportedValuesOf("timeZone")` returns 418 canonical ids on current runtimes and, on
 * several of them, **UTC is not one of them** — every entry is `Region/City`. It is the one zone
 * a scheduling or logging UI is most likely to want, so it is added rather than left to chance,
 * and de-duplicated in case a runtime does include it.
 */
function listTimeZones(): string[] {
  const supportedValuesOf = (Intl as IntlWithSupportedValues).supportedValuesOf
  let zones: string[] = []
  if (typeof supportedValuesOf === "function") {
    try {
      zones = supportedValuesOf.call(Intl, "timeZone")
    } catch {
      zones = []
    }
  }
  // Old runtimes (pre-2022) reach here with nothing. Degrading to the visitor's own zone keeps
  // the field truthful and submittable instead of empty; a caller who has to serve those
  // browsers passes `timeZones` and gets the full experience back.
  if (zones.length === 0) zones = [getLocalTimeZone()]
  return zones.includes("UTC") ? zones : ["UTC", ...zones]
}

/**
 * Minutes east of UTC at `date`, or null for a zone this runtime cannot format.
 *
 * Read through `longOffset` rather than computed from two Date objects: the arithmetic version
 * has to round, which quietly loses the zones that are not on a whole hour — India at +05:30,
 * Chatham at +12:45, Marquesas at -09:30.
 */
function offsetMinutesAt(timeZone: string, date: Date): number | null {
  let offset: string | undefined
  try {
    offset = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value
  } catch {
    return null
  }
  if (!offset) return null
  const parsed = OFFSET_PATTERN.exec(offset)
  if (!parsed) return null
  if (!parsed[1]) return 0
  const minutes = Number(parsed[2]) * 60 + Number(parsed[3])
  return parsed[1] === "-" ? -minutes : minutes
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const absolute = Math.abs(minutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0")
  const rest = String(absolute % 60).padStart(2, "0")
  return `UTC${sign}${hours}:${rest}`
}

/**
 * The part of the id worth reading, with the region stripped and underscores opened up:
 * "America/New_York" reads "New York", "America/Argentina/Salta" reads "Argentina – Salta".
 *
 * Deliberately city-first, with the offset appended by the caller rather than prefixed. A native
 * select has type-ahead — press "n" and the browser jumps to the first option starting with "n" —
 * and that is the only search a native control gets. Labelling these "(UTC-04:00) New York", the
 * way most pickers do, points every one of the 418 entries at "(" and throws the feature away.
 */
function zoneLabel(timeZone: string): string {
  const parts = timeZone.split("/")
  return (parts.length > 1 ? parts.slice(1) : parts).join(" – ").replace(/_/g, " ")
}

interface ZoneOption {
  zone: string
  /** What the option renders: the city, then the offset in parentheses. */
  text: string
  /** Sorted on, so a group reads alphabetically the way type-ahead walks it. */
  label: string
}

interface ZoneGroup {
  region: string
  options: ZoneOption[]
}

function buildOptions(zones: readonly string[], at: Date) {
  const loose: ZoneOption[] = []
  const groups = new Map<string, ZoneOption[]>()
  // The zones that made it into an option, which is not the same as the zones that came in —
  // anything unformattable is dropped below, and the orphan test has to see it as absent.
  const offered = new Set<string>()

  for (const zone of zones) {
    const offset = offsetMinutesAt(zone, at)
    // A zone the runtime cannot format is one it cannot resolve either, so offering it would
    // hand back an id that throws downstream. Dropping it is the honest outcome.
    if (offset === null) continue
    const label = zoneLabel(zone)
    const option: ZoneOption = { zone, label, text: `${label} (${formatOffset(offset)})` }
    offered.add(zone)
    const slash = zone.indexOf("/")
    if (slash === -1) {
      loose.push(option)
      continue
    }
    const region = zone.slice(0, slash).replace(/_/g, " ")
    const bucket = groups.get(region)
    if (bucket) bucket.push(option)
    else groups.set(region, [option])
  }

  const byLabel = (a: ZoneOption, b: ZoneOption) => a.label.localeCompare(b.label)
  loose.sort(byLabel)
  const grouped: ZoneGroup[] = [...groups.entries()]
    .map(([region, options]) => ({ region, options: options.sort(byLabel) }))
    .sort((a, b) => a.region.localeCompare(b.region))

  // `offered` is carried alongside the options so the "is the current value in here" test below
  // is a lookup rather than a walk of all 418 on every render of every parent.
  return { loose, grouped, offered }
}

/**
 * A time zone picker: every IANA zone the browser knows, grouped by region and labelled with the
 * offset it is actually on at a given date.
 *
 * ```tsx
 * const [zone, setZone] = React.useState("")
 *
 * React.useEffect(() => setZone(getLocalTimeZone()), [])
 *
 * return (
 *   <>
 *     <Label htmlFor="tz">Time zone</Label>
 *     <TimeZoneSelect id="tz" value={zone} onValueChange={setZone} placeholder="Select a time zone" />
 *   </>
 * )
 * ```
 *
 * It is a native `<select>`, so keyboard support, type-ahead, the mobile wheel and form
 * submission come from the platform rather than from a listbox reimplementation — which for a
 * list this long is the difference between usable and not.
 *
 * Sizing goes on a parent: `className` lands on the select, which fills its wrapper, and the
 * chevron is positioned against that wrapper.
 */
export const TimeZoneSelect = React.forwardRef<HTMLSelectElement, TimeZoneSelectProps>(
  function TimeZoneSelect(
    {
      className,
      value: valueProp,
      defaultValue,
      onValueChange,
      placeholder,
      referenceDate,
      timeZones,
      ...props
    },
    ref
  ) {
    /**
     * The option list is built after mount, never during the server render, and this is the
     * whole reason the flag exists.
     *
     * Three things here are properties of the machine rather than of the props: the zone list
     * (the server's ICU build and the browser's can disagree), the offsets (they come from a
     * tzdata that either side may have patched more recently), and "now" if no `referenceDate`
     * is given. Rendering any of them on both sides invites a hydration mismatch on a page that
     * was otherwise deterministic. Before mount the select therefore renders only what the props
     * already say — the current value, labelled with its raw id — so the field is present,
     * correct and submittable, and the labelled list swaps in on hydration.
     */
    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => {
      setMounted(true)
    }, [])

    const isControlled = valueProp !== undefined
    const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? "")
    const value = isControlled ? valueProp : uncontrolled

    // A Date is a new object every render, so the instant is what the memo can depend on.
    const referenceTime = referenceDate ? referenceDate.getTime() : null
    const options = React.useMemo(() => {
      if (!mounted) return null
      const at = referenceTime === null ? new Date() : new Date(referenceTime)
      return buildOptions(timeZones ?? listTimeZones(), at)
    }, [mounted, referenceTime, timeZones])

    /**
     * A value the list does not contain is added back as its own option. Two ways a column of
     * stored zones gets there: the runtime lists canonical ids, so a legacy form saved years ago
     * is missing (current runtimes still answer to "US/Pacific" but do not offer it), and a
     * narrowed `timeZones` will not contain the zone a user picked before it was narrowed.
     * Without this the select falls to its first option and the mismatch reads, silently and
     * on save, as the user having chosen Abidjan.
     */
    const orphan = options && value && !options.offered.has(value) ? value : null

    /**
     * Only when nothing else names the control. An `aria-label` here would override a visible
     * `<Label htmlFor>` and announce the generic word instead of the caller's own, and an `id`
     * is what that pairing needs, so its presence is taken as the label existing.
     */
    const needsFallbackLabel =
      props["aria-label"] === undefined &&
      props["aria-labelledby"] === undefined &&
      props.id === undefined

    return (
      <div className="relative">
        <select
          ref={ref}
          // Controlled even when the caller is not, because the options arrive in a second pass:
          // replacing the children of an uncontrolled select drops the DOM's selection, and the
          // field would reset itself on hydration.
          value={value}
          onChange={(event) => {
            const next = event.currentTarget.value
            if (!isControlled) setUncontrolled(next)
            onValueChange?.(next)
          }}
          aria-label={needsFallbackLabel ? "Time zone" : undefined}
          className={cn(
            "flex h-9 w-full appearance-none items-center rounded-md border border-input bg-transparent py-1 pl-3 pr-8 text-sm shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            // The closed select shows the placeholder in muted text like an empty input, while
            // the options themselves stay at full contrast on the open list.
            value === "" && "text-muted-foreground",
            "[&>optgroup]:text-foreground [&>option]:text-foreground",
            className
          )}
          {...props}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options === null ? (
            value ? (
              <option value={value}>{value}</option>
            ) : null
          ) : (
            <>
              {orphan ? <option value={orphan}>{orphan}</option> : null}
              {options.loose.map((option) => (
                <option key={option.zone} value={option.zone}>
                  {option.text}
                </option>
              ))}
              {options.grouped.map((group) => (
                <optgroup key={group.region} label={group.region}>
                  {group.options.map((option) => (
                    <option key={option.zone} value={option.zone}>
                      {option.text}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          )}
        </select>

        {/* Inline, so one glyph costs no icon dependency. */}
        <svg
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    )
  }
)
