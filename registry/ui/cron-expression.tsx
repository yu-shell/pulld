import * as React from "react"

import { cn } from "@/lib/utils"

export interface CronField {
  /** Sorted, de-duplicated list of the values this field matches. */
  values: number[]
  /**
   * The field was written starting with `*` (or the Quartz `?`). This is syntax, not coverage,
   * and it is load-bearing rather than cosmetic: the day-of-month / day-of-week rule keys off the
   * literal star, so `*` and `0-6` behave differently in the day-of-week field even though the
   * two cover the same seven days. See `dayMatches` below.
   */
  star: boolean
  /** Lowest legal value for this field (0 for minutes, 1 for day-of-month, …). */
  min: number
  /** Highest legal value for this field. Day-of-week is 0–6 here; an input of 7 folds to 0. */
  max: number
}

export interface CronSchedule {
  minute: CronField
  hour: CronField
  dayOfMonth: CronField
  month: CronField
  dayOfWeek: CronField
}

export type CronParseResult =
  | {
      ok: true
      schedule: CronSchedule
      /** The five-field form, with any `@macro` expanded and whitespace collapsed. */
      normalized: string
    }
  | { ok: false; error: string }

interface FieldSpec {
  label: string
  min: number
  max: number
  /** Highest value accepted on input, when it differs from `max` (day-of-week accepts 7). */
  inputMax?: number
  /** Three-letter aliases, in value order starting at `min`. */
  names?: readonly string[]
  /** Quartz writes `?` for "no specific value" in the two day fields. */
  allowQuestion?: boolean
}

const MONTH_ALIASES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const

const DAY_ALIASES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const SPECS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31, allowQuestion: true },
  { label: "month", min: 1, max: 12, names: MONTH_ALIASES },
  {
    label: "day-of-week",
    min: 0,
    max: 6,
    inputMax: 7,
    names: DAY_ALIASES,
    allowQuestion: true,
  },
]

/**
 * The nicknames every cron implementation understands. `@reboot` is deliberately absent: it is a
 * start-up trigger, not a calendar rule, and reporting it as a parse error is more useful than
 * inventing a schedule for it.
 */
const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

/** `L`, `W` and `#` are Quartz extensions. `JUL` must not trip this, hence the letter guards. */
const QUARTZ_ONLY = /(^|[^A-Z])[LW](?![A-Z])|#/i

const MS_PER_MINUTE = 60_000

/** How far ahead `nextCronRuns` will look before giving up. */
const HORIZON_YEARS = 8

/**
 * Above this many distinct wall-clock times, the sentence stops listing them and describes the
 * two fields separately instead — "At 09:00 and 17:00" is clearer than any field-by-field
 * phrasing, but the same treatment of `0 9-17 * * *` would spell out nine times in a row.
 */
const MAX_CLOCK_TIMES = 8

const pad2 = (n: number) => String(n).padStart(2, "0")

function ordinal(n: number) {
  const teens = n % 100
  if (teens >= 11 && teens <= 13) return `${n}th`
  switch (n % 10) {
    case 1:
      return `${n}st`
    case 2:
      return `${n}nd`
    case 3:
      return `${n}rd`
    default:
      return `${n}th`
  }
}

function listPhrase(parts: string[]) {
  if (parts.length <= 1) return parts[0] ?? ""
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`
}

/** One value of one field: a number, or a three-letter alias. Returns null when it is neither. */
function parseValue(token: string, spec: FieldSpec): number | null {
  const upper = token.toUpperCase()
  if (spec.names) {
    const index = spec.names.indexOf(upper)
    if (index >= 0) return spec.min + index
  }
  if (!/^\d{1,2}$/.test(token)) return null
  const value = Number(token)
  if (value < spec.min || value > (spec.inputMax ?? spec.max)) return null
  return value
}

/**
 * Sunday is both 0 and 7. Folding happens here, after a range has been expanded, rather than at
 * the point each endpoint is read: `5-7` has to mean Friday, Saturday, Sunday, and folding the
 * endpoint first would turn it into the backwards range `5-0`.
 */
const fold = (value: number, spec: FieldSpec) => (value > spec.max ? spec.min : value)

function parseTerm(term: string, spec: FieldSpec): number[] | string {
  if (term === "") return `${spec.label} has an empty entry`

  const slash = term.split("/")
  if (slash.length > 2) return `${spec.label} "${term}" has more than one step`
  const [rangeText, stepText] = slash

  let step = 1
  if (stepText !== undefined) {
    if (!/^\d{1,4}$/.test(stepText))
      return `${spec.label} step "${stepText}" is not a whole number`
    step = Number(stepText)
    if (step < 1) return `${spec.label} step must be 1 or more`
  }

  let from: number
  let to: number
  if (rangeText === "*" || (rangeText === "?" && spec.allowQuestion)) {
    from = spec.min
    // `spec.max`, not `inputMax`: the extra day-of-week value 7 folds onto 0, which a range
    // starting at 0 already contains, so it cannot add a day here at any step. It is only
    // reachable — and only load-bearing — in the explicit branch below, where `5/1` has to
    // reach Sunday.
    to = spec.max
  } else {
    const dash = rangeText.split("-")
    if (dash.length > 2) return `${spec.label} "${rangeText}" has more than one range`
    const start = parseValue(dash[0], spec)
    if (start === null) return `"${dash[0]}" is not a valid ${spec.label}`
    from = start
    if (dash.length === 1) {
      // `5/15` is the widespread shorthand for "from 5, then every 15th" — it only means a lone
      // value when no step was given.
      to = stepText === undefined ? start : (spec.inputMax ?? spec.max)
    } else {
      const end = parseValue(dash[1], spec)
      if (end === null) return `"${dash[1]}" is not a valid ${spec.label}`
      if (end < start) return `${spec.label} range "${rangeText}" runs backwards`
      to = end
    }
  }

  const values: number[] = []
  for (let value = from; value <= to; value += step) values.push(fold(value, spec))
  return values
}

function parseField(text: string, spec: FieldSpec): CronField | string {
  const values = new Set<number>()
  for (const term of text.split(",")) {
    const parsed = parseTerm(term, spec)
    if (typeof parsed === "string") {
      return QUARTZ_ONLY.test(text)
        ? `${parsed} — L, W and # are Quartz extensions that five-field cron does not have`
        : parsed
    }
    for (const value of parsed) values.add(value)
  }
  return {
    values: [...values].sort((a, b) => a - b),
    // Vixie cron sets its star flag from the first character of the field, which is why `*/2`
    // counts as a star and `0-59` does not. Matching that exactly is what keeps `dayMatches`
    // faithful for expressions like `0 0 13 * 0-6`.
    star: text.startsWith("*") || (spec.allowQuestion === true && text.startsWith("?")),
    min: spec.min,
    max: spec.max,
  }
}

/**
 * Parse a five-field cron expression (or an `@macro`) into the set of values each field matches.
 * Errors are returned rather than thrown, so an expression typed into a form can be reported
 * inline while the user is still editing it.
 */
export function parseCron(expression: string): CronParseResult {
  const trimmed = String(expression ?? "").trim()
  if (trimmed === "") return { ok: false, error: "The expression is empty" }

  if (trimmed.startsWith("@")) {
    const macro = trimmed.toLowerCase()
    if (macro === "@reboot")
      return {
        ok: false,
        error: "@reboot runs once at start-up and has no calendar schedule",
      }
    const expanded = MACROS[macro]
    if (!expanded)
      return {
        ok: false,
        error: `Unknown nickname "${trimmed}" — the known ones are ${Object.keys(MACROS).join(", ")}`,
      }
    return parseCron(expanded)
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== SPECS.length) {
    const extra =
      parts.length === 6 || parts.length === 7
        ? " — six- and seven-field expressions carry a seconds (and year) field, which is Quartz/Spring syntax rather than crontab syntax"
        : ""
    return {
      ok: false,
      error: `Expected 5 fields (minute hour day-of-month month day-of-week) but found ${parts.length}${extra}`,
    }
  }

  const fields: CronField[] = []
  for (let i = 0; i < SPECS.length; i++) {
    const field = parseField(parts[i], SPECS[i])
    if (typeof field === "string") return { ok: false, error: field }
    fields.push(field)
  }

  return {
    ok: true,
    schedule: {
      minute: fields[0],
      hour: fields[1],
      dayOfMonth: fields[2],
      month: fields[3],
      dayOfWeek: fields[4],
    },
    normalized: parts.join(" "),
  }
}

type Shape =
  | { kind: "all" }
  | { kind: "one"; value: number }
  | { kind: "range"; from: number; to: number }
  | { kind: "step"; step: number; from: number; to: number }
  | { kind: "list"; values: number[] }

/** The gap between values when it is the same all the way along, otherwise null. */
function uniformStep(field: CronField): number | null {
  const values = field.values
  if (values.length < 2) return null
  const step = values[1] - values[0]
  for (let i = 2; i < values.length; i++) {
    if (values[i] - values[i - 1] !== step) return null
  }
  return step
}

/**
 * Below this many values, "every nth" is a worse description than the list it stands for. Any two
 * values have a uniform gap, so without the floor `1,15` describes as "every 14th day of the
 * month from the 1st through the 15th" — true, and useless.
 */
const MIN_STEP_VALUES = 3

/**
 * Recover the shape of a field from its values, so the sentence can say "every 15 minutes"
 * instead of reading out four numbers. Coverage, not syntax: `0-59` describes as "all".
 *
 * `allowStep` is off for the two fields whose values have names. `1,3,5` in day-of-week is a
 * uniform step, but "every 2nd day of the week from Monday through Friday" invites exactly the
 * misreading the sentence exists to prevent, and there are only ever seven names to list.
 */
function shapeOf(field: CronField, allowStep = true): Shape {
  const values = field.values
  if (values.length === field.max - field.min + 1) return { kind: "all" }
  if (values.length === 1) return { kind: "one", value: values[0] }
  const step = uniformStep(field)
  if (step === null) return { kind: "list", values }
  const from = values[0]
  const to = values[values.length - 1]
  if (step === 1) return { kind: "range", from, to }
  if (!allowStep || values.length < MIN_STEP_VALUES) return { kind: "list", values }
  return { kind: "step", step, from, to }
}

interface Nouns {
  all: string
  one: string
  plural: string
  unit: string
  /** Repeated before the far end of a range: "the 1st through the 7th", but "09 through 17". */
  article?: string
}

function spanPhrase(shape: Shape, format: (value: number) => string, nouns: Nouns): string {
  const article = nouns.article ?? ""
  switch (shape.kind) {
    case "all":
      return nouns.all
    case "one":
      return `${nouns.one} ${format(shape.value)}`
    case "range":
      return `${nouns.plural} ${format(shape.from)} through ${article}${format(shape.to)}`
    case "step":
      return `every ${ordinal(shape.step)} ${nouns.unit} from ${article}${format(shape.from)} through ${article}${format(shape.to)}`
    case "list":
      return `${nouns.plural} ${listPhrase(shape.values.map(format))}`
  }
}

function timePhrase(schedule: CronSchedule): string {
  const minute = shapeOf(schedule.minute)
  const hour = shapeOf(schedule.hour)

  // A handful of wall-clock times is what most expressions are, and it is what people read
  // fastest. Only fall back to describing the two fields separately when the cross product would
  // turn into a wall of numbers.
  if (
    minute.kind !== "all" &&
    hour.kind !== "all" &&
    schedule.hour.values.length * schedule.minute.values.length <= MAX_CLOCK_TIMES
  ) {
    const times: string[] = []
    // Both value lists are sorted ascending, and hours are the outer loop, so the times come out
    // in chronological order without a further sort.
    for (const h of schedule.hour.values) {
      for (const m of schedule.minute.values) times.push(`${pad2(h)}:${pad2(m)}`)
    }
    return `At ${listPhrase(times)}`
  }

  // `*/n` — a step that starts at the bottom of the range and runs off the end of it. Read from
  // the values rather than from the shape, because `*/30` is only two values and the shape layer
  // deliberately calls that a list.
  const minuteStep = uniformStep(schedule.minute)
  const wholeHourStep =
    minute.kind !== "all" &&
    minuteStep !== null &&
    minuteStep > 1 &&
    schedule.minute.values[0] === schedule.minute.min &&
    schedule.minute.values[schedule.minute.values.length - 1] + minuteStep >
      schedule.minute.max

  const minuteClause =
    minute.kind === "all"
      ? "Every minute"
      : wholeHourStep
        ? `Every ${minuteStep} minutes`
        : `At ${spanPhrase(minute, String, {
            all: "every minute",
            one: "minute",
            plural: "minutes",
            unit: "minute",
          })}`

  // "Every minute during hours 09 through 17" but "At minute 5 past hours 09 through 17": the
  // two minute clauses are different parts of speech and take different prepositions.
  const continuous = minute.kind === "all" || wholeHourStep
  if (hour.kind === "all") return continuous ? minuteClause : `${minuteClause} past every hour`

  const hours = spanPhrase(hour, pad2, {
    all: "every hour",
    one: "hour",
    plural: "hours",
    unit: "hour",
  })
  return continuous ? `${minuteClause} during ${hours}` : `${minuteClause} past ${hours}`
}

function dayPhrase(schedule: CronSchedule): string {
  const dom = shapeOf(schedule.dayOfMonth)
  const dow = shapeOf(schedule.dayOfWeek, false)
  const domText = spanPhrase(dom, ordinal, {
    all: "every day of the month",
    one: "the",
    plural: "the",
    unit: "day of the month",
    article: "the ",
  })
  const dowText = spanPhrase(dow, (value) => DAY_NAMES[value], {
    all: "every day of the week",
    one: "",
    plural: "",
    unit: "day of the week",
  }).trim()

  // Cron's oldest trap, and it is syntactic: with a star in neither day field the two are ORed;
  // with a star in either, they are ANDed. Both sides are named even when one covers every day,
  // because "on the 13th or on every day of the week" is how a reader sees that this schedule is
  // in fact daily — collapsing it to "on the 13th" would state the opposite of what runs.
  if (usesDayOrRule(schedule)) return `, on ${domText} or on ${dowText}`

  // Coverage decides whether a field is worth mentioning, and it is a separate question from the
  // star: `*/10` carries the star flag but still restricts the month to four days.
  if (dom.kind === "all" && dow.kind === "all") return ""
  if (dom.kind === "all") return `, on ${dowText}`
  if (dow.kind === "all") return `, on ${domText}`
  return `, on ${domText} that also fall on ${dowText}`
}

/** True when both day fields are set and cron will therefore run on whichever of them matches. */
export function usesDayOrRule(schedule: CronSchedule) {
  return !schedule.dayOfMonth.star && !schedule.dayOfWeek.star
}

/** Turn a parsed schedule into one English sentence. Timezone-free on purpose: the fields
 *  themselves carry no zone — only an actual run time does. */
export function describeCron(schedule: CronSchedule): string {
  const month = shapeOf(schedule.month, false)
  const monthText =
    month.kind === "all"
      ? ""
      : `, in ${spanPhrase(month, (value) => MONTH_NAMES[value - 1], {
          all: "every month",
          one: "",
          plural: "",
          unit: "month",
        }).trim()}`
  return `${timePhrase(schedule)}${dayPhrase(schedule)}${monthText}.`
}

interface Matcher {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  orDays: boolean
}

const toMatcher = (schedule: CronSchedule): Matcher => ({
  minute: new Set(schedule.minute.values),
  hour: new Set(schedule.hour.values),
  dayOfMonth: new Set(schedule.dayOfMonth.values),
  month: new Set(schedule.month.values),
  dayOfWeek: new Set(schedule.dayOfWeek.values),
  orDays: usesDayOrRule(schedule),
})

function dayMatches(matcher: Matcher, date: Date) {
  const byDate = matcher.dayOfMonth.has(date.getUTCDate())
  const byWeek = matcher.dayOfWeek.has(date.getUTCDay())
  return matcher.orDays ? byDate || byWeek : byDate && byWeek
}

function toDate(value: Date | number | string): Date | null {
  // One constructor covers all three: since ES2015 `new Date(aDate)` copies the instant, so
  // there is nothing for an `instanceof` branch to decide.
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The next `count` instants the schedule fires, strictly after `from`, in UTC.
 *
 * Everything is computed in UTC, which is both the honest answer and the common one: GitHub
 * Actions, Vercel Cron and Cloudflare Triggers all schedule in UTC. A local-time answer would
 * need the zone's whole DST history to be right, and a schedule that reads 02:30 daily fires
 * twice on one day of the year and not at all on another.
 *
 * The search steps by the coarsest field that fails rather than minute by minute, so an
 * expression that only matches once every four years costs a few thousand comparisons instead of
 * two million. It gives up after `HORIZON_YEARS`, which is how an impossible date — February 30,
 * or February 29 in a month field that excludes leap years — returns fewer runs than asked for
 * rather than looping.
 */
export function nextCronRuns(
  schedule: CronSchedule,
  from: Date | number | string,
  count = 3
): Date[] {
  const start = toDate(from)
  const wanted = Math.floor(count)
  if (!start) return []

  const matcher = toMatcher(schedule)
  const runs: Date[] = []
  // Cron fires on minute boundaries, and a run at the very instant of `from` has already
  // happened, so the search opens at the next whole minute.
  let cursor = Math.floor(start.getTime() / MS_PER_MINUTE) * MS_PER_MINUTE + MS_PER_MINUTE
  const deadline = Date.UTC(
    start.getUTCFullYear() + HORIZON_YEARS,
    start.getUTCMonth(),
    start.getUTCDate(),
    start.getUTCHours(),
    start.getUTCMinutes()
  )

  while (runs.length < wanted && cursor <= deadline) {
    const date = new Date(cursor)
    const year = date.getUTCFullYear()
    const monthIndex = date.getUTCMonth()
    const day = date.getUTCDate()
    const hour = date.getUTCHours()
    const minute = date.getUTCMinutes()

    // Each branch moves the cursor strictly forward to the start of the next candidate unit, so
    // the loop always terminates; Date.UTC normalises the overflow at every level for us.
    if (!matcher.month.has(monthIndex + 1)) {
      cursor = Date.UTC(year, monthIndex + 1, 1)
      continue
    }
    if (!dayMatches(matcher, date)) {
      cursor = Date.UTC(year, monthIndex, day + 1)
      continue
    }
    if (!matcher.hour.has(hour)) {
      cursor = Date.UTC(year, monthIndex, day, hour + 1)
      continue
    }
    if (!matcher.minute.has(minute)) {
      cursor = Date.UTC(year, monthIndex, day, hour, minute + 1)
      continue
    }
    runs.push(date)
    cursor += MS_PER_MINUTE
  }
  return runs
}

/**
 * Fixed format rather than Intl: a locale-dependent string is a hydration mismatch waiting to
 * happen, because the server's default locale is not the visitor's. Callers who want a localised
 * run list can pass `formatRun`.
 */
function formatUtc(date: Date) {
  return `${DAY_ABBR[date.getUTCDay()]} ${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`
}

export interface CronExpressionProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** The expression: five fields, or a nickname such as `@daily`. */
  value: string
  /**
   * Reference instant for the run list. Omit it and no runs are listed — nothing here reads the
   * clock, so the same props always render the same markup. Pass a stable value (a timestamp
   * fetched with the data, not `new Date()` inside a client component) to keep it that way.
   */
  from?: Date | number | string
  /** How many upcoming runs to list when `from` is given (default 3). */
  runs?: number
  /** Show the expression itself above the sentence (default true). */
  showExpression?: boolean
  /** Heading above the run list (default "Next runs (UTC)"). */
  runsLabel?: string
  /** Format one run. The default is locale-independent: "Wed 2026-08-12 09:00 UTC". */
  formatRun?: (date: Date) => string
}

export const CronExpression = React.forwardRef<HTMLDivElement, CronExpressionProps>(
  (
    {
      value,
      from,
      runs = 3,
      showExpression = true,
      runsLabel = "Next runs (UTC)",
      formatRun = formatUtc,
      className,
      ...props
    },
    ref
  ) => {
    const parsed = parseCron(value)
    const raw = String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
    const expanded = parsed.ok && parsed.normalized !== raw ? parsed.normalized : null
    const reference = from === undefined ? null : toDate(from)
    const upcoming =
      parsed.ok && reference ? nextCronRuns(parsed.schedule, reference, runs) : []
    const wanted = Math.floor(runs)

    return (
      <div
        ref={ref}
        data-invalid={parsed.ok ? undefined : "true"}
        className={cn("space-y-1.5 text-sm", className)}
        {...props}
      >
        {showExpression ? (
          <p className="font-mono text-xs">
            <span className="sr-only">Cron expression: </span>
            <code className="rounded border bg-muted px-1.5 py-0.5 text-foreground">
              {raw || "(empty)"}
            </code>
            {expanded ? (
              <span className="ml-1.5 text-muted-foreground">= {expanded}</span>
            ) : null}
          </p>
        ) : null}

        {parsed.ok ? (
          <p className="text-foreground">{describeCron(parsed.schedule)}</p>
        ) : (
          // The word "Invalid" carries the state, not the colour: a red sentence and a black one
          // are the same sentence to anyone who cannot tell them apart (WCAG 1.4.1).
          <p className="text-destructive">
            <span className="font-medium">Invalid cron expression:</span> {parsed.error}.
          </p>
        )}

        {parsed.ok && usesDayOrRule(parsed.schedule) ? (
          <p className="text-xs text-muted-foreground">
            Both day fields are set, so cron runs on whichever one matches — not only on days
            that satisfy both.
          </p>
        ) : null}

        {/* `runs={0}` means "do not list runs", which is not the same claim as "there are none". */}
        {parsed.ok && from !== undefined && wanted > 0 ? (
          <div className="pt-0.5">
            <p className="text-xs font-medium text-muted-foreground">{runsLabel}</p>
            {!reference ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Cannot list runs: the reference time is not a valid date.
              </p>
            ) : upcoming.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">
                No run in the next {HORIZON_YEARS} years.
              </p>
            ) : (
              <>
                <ol className="mt-1 space-y-0.5 font-mono text-xs text-foreground">
                  {upcoming.map((run) => (
                    <li key={run.getTime()}>
                      <time dateTime={run.toISOString()}>{formatRun(run)}</time>
                    </li>
                  ))}
                </ol>
                {upcoming.length < wanted ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    No further run in the next {HORIZON_YEARS} years.
                  </p>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>
    )
  }
)
CronExpression.displayName = "CronExpression"
