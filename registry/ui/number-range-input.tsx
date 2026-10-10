"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The two ends of a range, as numbers. `null` means that end is open.
 *
 * **`null` is not `0`.** "1000 and up" is a range with no upper end, and the only honest way
 * to say that is a null — a `0` there is a real bound that happens to be zero, which is what
 * a temperature or a profit filter actually means by it. Every function in this file keeps
 * the two apart, and the component never turns an empty field into a zero.
 */
export interface NumberRange {
  min: number | null
  max: number | null
}

/** The two ends as they are written in the fields, which is what the component actually stores. */
export interface NumberRangeText {
  min: string
  max: string
}

/**
 * What is wrong, where, and in codes rather than sentences.
 *
 * `scope` is the half of the field the problem belongs to, and it is the thing a screen
 * reader gets wrong when a component does not track it: `"pair"` means neither number is
 * wrong on its own and it is their order that is the problem, so both inputs are marked
 * invalid. `"min"` or `"max"` marks one input and leaves the other alone.
 *
 * No message text here on purpose. This keeps the checking usable from a route handler or a
 * test with no opinion about language, and leaves the wording to `messages` on the component.
 */
export interface RangeIssue {
  scope: "min" | "max" | "pair"
  code: "not-a-number" | "below-allowed" | "above-allowed" | "missing" | "crossed"
  /** The outer limit that was broken, for `below-allowed` and `above-allowed`. */
  allowed?: number
}

/** The answer to "is this range usable, and if not what is wrong with it". */
export interface RangeVerdict {
  /** The parsed ends. Unparseable text yields `null`, the same as an empty field. */
  value: NumberRange
  /** The text the verdict describes, so a caller can tell a stale verdict from a current one. */
  text: NumberRangeText
  /** Highest priority first; `issues[0]` is the one worth putting on screen. */
  issues: RangeIssue[]
  ok: boolean
}

export interface NumberRangeBounds {
  /** The smallest value either end may take — the catalogue's floor, not the chosen range. */
  min?: number
  /** The largest value either end may take. */
  max?: number
}

/**
 * Every sentence this component can say, so all of them can be translated.
 *
 * `{min}`, `{max}` and `{allowed}` are substituted. The two numbers are substituted **as they
 * were typed**, never reformatted — see `summarise` below for why that matters.
 */
export interface NumberRangeMessages {
  notANumber: string
  belowAllowed: string
  aboveAllowed: string
  missing: string
  crossed: string
  swapped: string
  /** Both ends set. */
  between: string
  /** Lower end only. */
  atLeast: string
  /** Upper end only. */
  atMost: string
}

const DEFAULT_MESSAGES: NumberRangeMessages = {
  notANumber: "Enter a number.",
  belowAllowed: "Enter {allowed} or more.",
  aboveAllowed: "Enter {allowed} or less.",
  missing: "Enter both ends of the range.",
  crossed: "The first number must not be greater than the second.",
  swapped: "The two numbers were swapped.",
  between: "{min} to {max}",
  atLeast: "{min} and up",
  atMost: "Up to {max}",
}

/** `{name}` substitution. Deliberately not a template literal so `messages` can be data. */
function fill(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    key in vars ? vars[key] : whole
  )
}

/**
 * Reads one field's text as a number.
 *
 * Returns `null` for an empty field and `NaN` for text that is not a number, which are two
 * different facts: the first is a legitimate open end and the second is a mistake to report.
 * Collapsing them — which is what `Number("")` does, since it answers `0` — is how a filter
 * ends up asking for "zero and up" because somebody cleared the box.
 *
 * `decimalSeparator` decides the grammar, and it has to be told rather than guessed. With `"."`
 * the grouping character is `,`, so `1,234.5` is 1234.5; with `","` it is the other way round and
 * `1.234,5` is the same number. **Guessing would be dangerous rather than merely wrong**: read
 * `1,5` as grouped and it becomes 15, a price filter off by a factor of ten with nothing on
 * screen to suggest it. Nothing here infers the separator from the runtime locale either,
 * because `Intl` on the server and `Intl` in the browser can disagree and a field that parses
 * differently in the two passes is a hydration mismatch. Pass it down from wherever the rest of
 * the page gets its locale.
 *
 * The grammar is strict on purpose. `1.` and `.5` pass, because they are what a half-typed
 * decimal looks like and a field that rejects them cannot be typed into. `1e3`, `Infinity`,
 * `0x10` and a bare `-` do not, because `Number` accepts all four and none of them is a figure
 * anyone meant to put in a price box.
 *
 * Group separators are only accepted **where a group separator can go** — `1,234,567` yes,
 * `1,5` no. Stripping the character wherever it appears is the version of this that looks
 * finished and is the dangerous one: in a dot-decimal field a reader who writes `1,5` meaning
 * one and a half gets 15, a bound off by a factor of ten with nothing on screen to suggest it.
 * Refusing it costs them a correction; accepting it costs them the wrong answer silently.
 */
export function parseBound(text: string, decimalSeparator: "." | "," = "."): number | null {
  const group = decimalSeparator === "." ? "," : "."
  // Surrounding whitespace is noise from a paste and carries no meaning. `trim` covers the
  // no-break and narrow no-break spaces too, both being Unicode space separators.
  const trimmed = text.trim()
  if (trimmed === "") return null
  // What is left of a space is a *group* separator — it is how fr-FR writes 1 234,5, and Intl
  // emits the narrow no-break one for it — so it is rewritten to the group character and judged
  // by position with the rest. Letting it through unchecked instead is the same factor-of-ten
  // mistake in a different costume: "1 2 3 4" would read as 1234.
  let bare = ""
  for (const char of trimmed) {
    const isGroupSpace =
      char === " " || char === "\u00a0" || char === "\u202f" || char === "_"
    bare += isGroupSpace ? group : char
  }

  const sign = bare[0] === "+" || bare[0] === "-" ? bare[0] : ""
  const digits = sign ? bare.slice(1) : bare

  // Split on the decimal separator, which can appear at most once. More than one means the text
  // is using the other convention's grouping, and there is no way to tell that from a typo.
  const parts = digits.split(decimalSeparator)
  if (parts.length > 2) return Number.NaN
  const whole = parts[0]
  const fraction = parts.length === 2 ? parts[1] : ""

  // Nothing is grouped after the decimal point in any convention, so a separator there is junk.
  // The `Number` call at the end would refuse it too, since the fraction is concatenated as it
  // stands — this says the rule out loud, and keeps it true if that construction ever changes.
  if (!/^\d*$/.test(fraction)) return Number.NaN
  // Either ungrouped digits, or digits in groups of three. An empty whole part is allowed only
  // for the ".5" shorthand, which is why the fraction has to carry something in that case.
  const grouped = new RegExp(`^\\d{1,3}(${group === "." ? "\\." : ","}\\d{3})+$`)
  if (whole === "") {
    if (fraction === "") return Number.NaN
  } else if (!/^\d+$/.test(whole) && !grouped.test(whole)) {
    return Number.NaN
  }

  const value = Number(
    `${sign}${whole.split(group).join("")}${fraction === "" ? "" : `.${fraction}`}`
  )
  return Number.isFinite(value) ? value : Number.NaN
}

/**
 * Checks a pair of typed ends and reports everything wrong with them, worst first.
 *
 * Exported as a plain function because the same question is asked away from the keyboard: the
 * route handler that receives `?min=&max=` has to reach the same verdict the field showed, and a
 * second implementation of the rules there is a second set of rules.
 *
 * **Equal ends are a range, not a mistake.** `min === max` is "exactly 500" and passes; only
 * `min > max` is crossed. The `>=` that looks equivalent while writing this rejects every
 * exact-value filter.
 *
 * The order of `issues` is the priority order, and it puts each end's own problem ahead of the
 * pair's: text that is not a number cannot be compared to anything, so saying "the first number
 * must not be greater than the second" about it would be noise on top of a mistake.
 */
export function checkRange(
  text: NumberRangeText,
  {
    bounds,
    requireBoth = false,
    decimalSeparator = ".",
  }: {
    bounds?: NumberRangeBounds
    requireBoth?: boolean
    decimalSeparator?: "." | ","
  } = {}
): RangeVerdict {
  const issues: RangeIssue[] = []
  const parsed: NumberRange = { min: null, max: null }
  const missing: Array<"min" | "max"> = []

  for (const side of ["min", "max"] as const) {
    const raw = parseBound(text[side], decimalSeparator)
    if (raw === null) {
      missing.push(side)
      continue
    }
    if (Number.isNaN(raw)) {
      issues.push({ scope: side, code: "not-a-number" })
      continue
    }
    parsed[side] = raw
    if (bounds?.min !== undefined && raw < bounds.min) {
      issues.push({ scope: side, code: "below-allowed", allowed: bounds.min })
    } else if (bounds?.max !== undefined && raw > bounds.max) {
      issues.push({ scope: side, code: "above-allowed", allowed: bounds.max })
    }
  }

  if (requireBoth) {
    for (const side of missing) issues.push({ scope: side, code: "missing" })
  }

  if (parsed.min !== null && parsed.max !== null && parsed.min > parsed.max) {
    issues.push({ scope: "pair", code: "crossed" })
  }

  return { value: parsed, text, issues, ok: issues.length === 0 }
}

/**
 * The one-line description of a settled range, built from the typed text.
 *
 * From the text rather than from `value` so the numbers on screen and the numbers read aloud are
 * the same characters. Round-tripping through `Number` would rewrite `1,000` as `1000` and
 * `07` as `7`, and reformatting with `Intl` would need a locale, which is the hydration mismatch
 * described on `parseBound`. Returns `""` for a field with nothing in it: a range that has not
 * been set yet has nothing to announce, and a status line that always says something is a status
 * line people stop reading.
 */
export function summarise(
  text: NumberRangeText,
  messages: NumberRangeMessages = DEFAULT_MESSAGES
): string {
  const min = text.min.trim()
  const max = text.max.trim()
  if (min && max) return fill(messages.between, { min, max })
  if (min) return fill(messages.atLeast, { min })
  if (max) return fill(messages.atMost, { max })
  return ""
}

/** The sentence for one issue. */
function describe(issue: RangeIssue, messages: NumberRangeMessages): string {
  const allowed = issue.allowed === undefined ? "" : String(issue.allowed)
  switch (issue.code) {
    case "not-a-number":
      return messages.notANumber
    case "below-allowed":
      return fill(messages.belowAllowed, { allowed })
    case "above-allowed":
      return fill(messages.aboveAllowed, { allowed })
    case "missing":
      return messages.missing
    case "crossed":
      return messages.crossed
  }
}

const EMPTY: NumberRangeText = { min: "", max: "" }

/**
 * Whether two pairs of text say the same thing.
 *
 * By content, never by object identity. The text is a value, and a value object is rebuilt on
 * every keystroke — type an `x` and delete it again and the pair is a different object carrying
 * the same two strings. Compared by identity, that reads as a change: the field goes back to
 * showing no verdict about text it has already judged, and the pending query fires a second time
 * for a range nobody altered.
 */
function sameText(a: NumberRangeText, b: NumberRangeText) {
  return a.min === b.min && a.max === b.max
}

/** The text a `NumberRange` prop would be written as, used only when it replaces what was typed. */
function textFor(value: number | null | undefined): string {
  return value === null || value === undefined ? "" : String(value)
}

type InputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "min" | "max" | "type" | "name" | "aria-invalid"
>

interface NumberRangeInputProps extends InputProps {
  /**
   * The field's name, as a `<legend>`. Required, because two number boxes side by side are
   * meaningless without it — "Minimum" and "Maximum" alone do not say minimum of what.
   */
  label: string
  /** Keep the legend for screen readers but take it off the screen. */
  hideLabel?: boolean
  /** The chosen range. Pass this with `onValueChange` for a controlled field. */
  value?: NumberRange
  /** The starting range when the field is uncontrolled. */
  defaultValue?: NumberRange
  /** Every keystroke, immediately, with both the parsed ends and the raw text. */
  onValueChange?: (value: NumberRange, text: NumberRangeText) => void
  /**
   * Once the typing has stopped (`debounceMs`) or focus has left the field — the moment to run
   * the query. Gate on `verdict.ok`; a crossed or half-typed range settles too.
   */
  onCommit?: (verdict: RangeVerdict) => void
  /** The outer limits either end may take. Not the chosen range — see `NumberRangeBounds`. */
  bounds?: NumberRangeBounds
  /** Treat a one-sided range as incomplete. Off by default, because one-sided ranges are real. */
  requireBoth?: boolean
  /**
   * What to do when the ends are the wrong way round. `"flag"` says so and changes nothing.
   * `"swap"` puts them right, but only once focus has left the field, and announces that it did.
   */
  crossBehavior?: "flag" | "swap"
  /** `"."` or `","`. Must be told, not guessed — see `parseBound`. */
  decimalSeparator?: "." | ","
  /** How long the typing has to stop before the range is judged. */
  debounceMs?: number
  /** Accessible names for the two inputs. */
  minLabel?: string
  maxLabel?: string
  minPlaceholder?: string
  maxPlaceholder?: string
  /** The mark between the two inputs. Decorative, so it is hidden from screen readers. */
  separator?: React.ReactNode
  /** `name` for each input, when the field is inside a form that posts itself. */
  nameMin?: string
  nameMax?: string
  /** Show the status line that carries the error and the summary. */
  showStatus?: boolean
  /** Overrides for any of the sentences. */
  messages?: Partial<NumberRangeMessages>
  /** On the `<fieldset>`. The inputs take `inputClassName`; other props reach both inputs. */
  className?: string
  inputClassName?: string
}

/**
 * Two number fields that behave as one: a low end, a high end, and one verdict over the pair.
 *
 * For every place a page asks for "from X to Y" in numbers — a price filter on a catalogue or
 * search page, stock or quantity on hand, a score or rating band, an age range, a salary band on
 * a job posting, a threshold pair on an alert rule, a size or weight filter, a row-count or
 * amount filter on a report, a latency or duration window on a dashboard query, a discount or
 * margin band, a year range.
 *
 * **Nothing is judged while you are typing.** This is the whole design, and the obvious version
 * of the component does not survive it. Replace `50` with `500` in the lower box and the field
 * passes through `5`, `50`, `500`: at `5` the lower end is below where it started and at every
 * keystroke the pair is briefly inconsistent. A field that validates on change is therefore red
 * for most of the time anyone is using it, and one that *corrects* on change is worse — it moves
 * the digits out from under the caret. So the verdict waits for a pause (`debounceMs`, 300ms) or
 * for focus to leave, shows nothing in the meantime rather than a stale answer, and `onCommit`
 * fires on the same beat so a live query does not go out for the `5` on the way to `500`.
 *
 * **Crossed ends are reported, not quietly fixed.** Swapping them the moment they cross takes the
 * number you are halfway through typing and puts it in the other box, which reads as the field
 * eating your input. The default says so and changes nothing; `crossBehavior="swap"` is available
 * for filter bars that prefer it and it waits for focus to leave the whole field, then says that
 * it swapped — a correction nobody is told about is a correction a screen reader user cannot see.
 *
 * **An empty end is open, not zero.** "1000 and up" is a complete, committable range, so an
 * empty box is `null` rather than `0` and the field is valid with one end set. `requireBoth`
 * turns that off where both really are needed.
 *
 * **The two boxes are one field.** They sit in a `<fieldset>` with the field's name as its
 * `<legend>`, and the status line is attached to *both* inputs with `aria-describedby`, so the
 * error reaches a screen reader from whichever box the reader is in — attach it to one and half
 * the field is silent about what is wrong. Which box is marked `aria-invalid` follows the
 * problem's scope: a bad number marks that box, a crossed pair marks both, because neither
 * number is wrong on its own.
 *
 * **The text belongs to the field, even when the range does not.** `value` makes this controlled
 * over the two *numbers*; the characters stay here, because no number can hold `07`, `1.` or a
 * half-typed `abc` that still has to be shown back and explained. `value` replaces the text
 * whenever `value` changes — a preset button, a reset — and a parent that answers a render late,
 * as anything storing the range in the URL does, is left to catch up rather than treated as
 * having refused the keystroke.
 *
 * The inputs are `type="text"` with `inputMode="decimal"`, not `type="number"`. A number input
 * **throws away what it cannot parse** — type `12e` and `input.value` is the empty string, so the
 * component cannot show it back, cannot say what is wrong with it, and the reader watches their
 * text disappear. It also steps the value when a scroll gesture passes over it while focused,
 * and it refuses the half-typed `1.` this field has to accept. `inputMode` still brings up the
 * numeric keypad on a phone.
 *
 * Distinct from the neighbours: `number-input` is a single value with stepper buttons,
 * `date-range-preset` is a range of dates chosen from named spans, and official shadcn/ui's
 * `slider` renders a thumb per value so it can hold two — but it is a thing you drag inside a
 * fixed track, which cannot express an open end and cannot be typed an exact figure into.
 */
export function NumberRangeInput({
  label,
  hideLabel = false,
  value,
  defaultValue,
  onValueChange,
  onCommit,
  bounds,
  requireBoth = false,
  crossBehavior = "flag",
  decimalSeparator = ".",
  debounceMs = 300,
  minLabel = "Minimum",
  maxLabel = "Maximum",
  minPlaceholder,
  maxPlaceholder,
  separator = "–",
  nameMin,
  nameMax,
  showStatus = true,
  messages: messageOverrides,
  className,
  inputClassName,
  disabled,
  readOnly,
  // A phone keyboard that autocapitalises and autocorrects can rewrite a figure between the
  // keypress and the change event, and a spellchecker underlines every number it sees. All four
  // are defaults rather than fixed, for the rare field that wants the browser's help.
  spellCheck = false,
  autoCapitalize = "off",
  autoCorrect = "off",
  autoComplete = "off",
  id,
  onBlur,
  onKeyDown,
  "aria-describedby": ariaDescribedby,
  ...props
}: NumberRangeInputProps) {
  const messages = React.useMemo(
    () => ({ ...DEFAULT_MESSAGES, ...messageOverrides }),
    [messageOverrides]
  )
  const isControlled = value !== undefined

  // Pulled apart into numbers because `bounds` is almost always written inline — `bounds={{ min:
  // 0, max: 10000 }}` — which is a new object on every render of the parent. Anything that
  // depends on that object's identity restarts on every one of those renders, and the debounce
  // below is the thing that must not: restarted often enough it never elapses, and the field
  // stops ever reaching a verdict. Two numbers cannot do that.
  const boundsMin = bounds?.min
  const boundsMax = bounds?.max
  const judge = (next: NumberRangeText) =>
    checkRange(next, {
      bounds: { min: boundsMin, max: boundsMax },
      requireBoth,
      decimalSeparator,
    })

  const seed = value ?? defaultValue
  const seedText: NumberRangeText = seed
    ? { min: textFor(seed.min), max: textFor(seed.max) }
    : EMPTY

  const [text, setText] = React.useState<NumberRangeText>(seedText)

  // The settled verdict, carrying the text it was reached about. Keeping the text alongside is
  // what lets the field say nothing at all mid-edit: comparing it to the current text separates
  // "no opinion yet" from "valid", which a bare verdict cannot express. Seeded synchronously so a
  // field that opens with a range already in it is right on the first paint.
  const [settled, setSettled] = React.useState<RangeVerdict>(() => judge(seedText))
  const [swapped, setSwapped] = React.useState(false)

  // Read inside the debounce timer and the blur handler, which both run after the render that
  // scheduled them — reading `text` through this ref keeps them from settling a verdict about
  // text that has already been replaced.
  const textRef = React.useRef(text)
  textRef.current = text
  const settledTextRef = React.useRef(settled.text)
  const fieldsetRef = React.useRef<HTMLFieldSetElement | null>(null)


  // The last `value` this field was given, so a *change* to it can be told apart from merely
  // being rendered again.
  const lastValueRef = React.useRef<NumberRange | null>(
    value ? { min: value.min ?? null, max: value.max ?? null } : null
  )

  // Let a controlled parent replace the text — when, and only when, the range it is holding
  // actually changes.
  //
  // Two different mistakes are being avoided here, and avoiding one is what causes the other.
  // Writing `String(value.min)` back on every render is the first: `07` becomes `7` and `1.`
  // becomes `1`, both under the caret, which is what makes the obvious controlled number field
  // impossible to type a decimal into. Comparing the parsed text against the incoming number
  // fixes that much — the text survives while it still means the same number.
  //
  // The second is subtler and only shows up with a parent that answers late. A filter's state
  // usually lives in the URL, and `useSearchParams` with a `router.push` does not come back in
  // the same render: for one pass the field is holding `07` while `value.min` is still the old
  // `null`. Reconciling on that pass reads "the parent disagrees" and wipes the keystroke — and
  // since every keystroke has such a pass, the field cannot be typed in at all. The two cases
  // are indistinguishable from the value alone, so the trigger is the prop *changing* rather
  // than the prop's content, and a parent that is simply behind is left to catch up.
  //
  // The contract that follows, and it is the one documented on the component: the text belongs to
  // this field, and `value` replaces it whenever `value` changes. A parent that ignores
  // `onValueChange` altogether is not a controlled field refusing a keystroke — it is a field
  // nobody is controlling.
  React.useEffect(() => {
    if (!isControlled || !value) return
    const incoming: NumberRange = { min: value.min ?? null, max: value.max ?? null }
    const last = lastValueRef.current
    if (last && last.min === incoming.min && last.max === incoming.max) return
    lastValueRef.current = incoming
    setText((previous) => {
      let next = previous
      for (const side of ["min", "max"] as const) {
        const parsed = parseBound(previous[side], decimalSeparator)
        const says = parsed === null || Number.isNaN(parsed) ? null : parsed
        if (says !== incoming[side]) {
          next = next === previous ? { ...previous } : next
          next[side] = textFor(incoming[side])
        }
      }
      return next
    })
  }, [isControlled, value?.min, value?.max, decimalSeparator])

  const settle = (next: NumberRangeText) => {
    const verdict = judge(next)
    settledTextRef.current = next
    setSettled(verdict)
    onCommit?.(verdict)
    return verdict
  }
  // Reached from inside the timer, which was scheduled by an earlier render and must not call
  // that render's copy of `settle` — its `onCommit` and its bounds may both be a prop change out
  // of date by the time it fires.
  const settleRef = React.useRef(settle)
  settleRef.current = settle

  React.useEffect(() => {
    if (sameText(text, settled.text)) return
    const timer = setTimeout(() => {
      // Checked again in the timer because the text may have come back to what is already
      // settled — a character typed and deleted again — in which case the verdict on screen is
      // the right one and firing `onCommit` for it would send the same query twice.
      if (sameText(settledTextRef.current, textRef.current)) return
      settleRef.current(textRef.current)
    }, debounceMs)
    return () => clearTimeout(timer)
    // The two pairs by their strings rather than by their objects, so an unchanged field does
    // not reschedule the timer on every render of whatever is above it.
  }, [text.min, text.max, settled.text.min, settled.text.max, debounceMs])

  const commit = (next: NumberRangeText) => {
    setSwapped(false)
    // Set even when the field is controlled, which is the part that looks wrong and is not. A
    // number cannot hold `07`, `1.` or `abc`, so a controlled parent's `NumberRange` cannot be
    // the source of what is on screen without eating all three. The text is this component's own
    // state either way; the parent owns the *numbers*, and the effect above puts the text back in
    // line whenever the parent's answer disagrees with what the text says — including when it
    // refuses the change outright, which is how a controlled field says no.
    setText(next)
    onValueChange?.(judge(next).value, next)
  }

  const handleChange = (side: "min" | "max", raw: string) => {
    commit({ ...text, [side]: raw })
  }

  const handleBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    onBlur?.(event)
    // Moving from one box to the other is movement *inside* the field, so it must not settle:
    // tabbing from the lower end to fill in the upper one would otherwise flash "the first number
    // must not be greater than the second" about a range that is one keystroke from being right.
    const to = event.relatedTarget as Node | null
    if (to && fieldsetRef.current?.contains(to)) return

    let next = textRef.current
    const verdict = judge(next)
    if (
      crossBehavior === "swap" &&
      !readOnly &&
      !disabled &&
      verdict.issues.some((issue) => issue.code === "crossed")
    ) {
      next = { min: next.max, max: next.min }
      setText(next)
      setSwapped(true)
      onValueChange?.(judge(next).value, next)
    }
    settle(next)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    // Enter settles without waiting for the pause, because someone who presses it has finished.
    // Not prevented: this field is usually in a form, and swallowing Enter would stop it
    // submitting.
    if (event.key === "Enter") settle(textRef.current)
  }

  const reactId = React.useId()
  const fieldId = id ?? `${reactId}-number-range`
  const minId = `${fieldId}-min`
  const maxId = `${fieldId}-max`
  const statusId = `${fieldId}-status`

  const pending = !sameText(text, settled.text)
  // One sentence at a time on screen — the highest priority one — because a status line that
  // lists everything at once is a status line nobody finishes reading.
  const issue = pending ? null : (settled.issues[0] ?? null)
  const statusText = [
    // Always first when it applies, including on top of an error: a range whose ends were moved
    // and which is *still* wrong needs to say both, or the reader is left wondering why the
    // number they typed is in the other box.
    swapped ? messages.swapped : "",
    issue ? describe(issue, messages) : pending ? "" : summarise(settled.text, messages),
  ]
    .filter(Boolean)
    .join(" ")

  // Every issue, not just the one on screen. Both boxes can be wrong at once — two unparseable
  // figures is the ordinary way that happens — and marking only the box whose message won the
  // status line leaves a screen reader telling the reader that the other one is fine.
  const invalid = (side: "min" | "max") =>
    !pending && settled.issues.some((i) => i.scope === side || i.scope === "pair")

  // Attached to both inputs, not just the one at fault: the reader may be in either box when the
  // error appears, and an input that describes nothing tells them nothing is wrong.
  const describedBy =
    [ariaDescribedby, showStatus ? statusId : null].filter(Boolean).join(" ") || undefined

  const field = (side: "min" | "max") => (
    <input
      {...props}
      id={side === "min" ? minId : maxId}
      name={side === "min" ? nameMin : nameMax}
      // See the note on the component: type="number" discards text it cannot parse, so the
      // reader's mistake would vanish instead of being explained.
      type="text"
      inputMode="decimal"
      spellCheck={spellCheck}
      autoCapitalize={autoCapitalize}
      autoCorrect={autoCorrect}
      autoComplete={autoComplete}
      value={text[side]}
      placeholder={side === "min" ? minPlaceholder : maxPlaceholder}
      aria-label={side === "min" ? minLabel : maxLabel}
      aria-invalid={invalid(side) ? true : undefined}
      aria-describedby={describedBy}
      disabled={disabled}
      readOnly={readOnly}
      onChange={(event) => handleChange(side, event.target.value)}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm tabular-nums shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        invalid(side) && "border-destructive focus-visible:ring-destructive",
        inputClassName
      )}
    />
  )

  return (
    <fieldset
      ref={fieldsetRef}
      className={cn("min-w-0 space-y-1.5", className)}
      disabled={disabled}
    >
      <legend className={cn("text-sm font-medium leading-none", hideLabel && "sr-only")}>
        {label}
      </legend>
      <div className="flex items-center gap-2">
        {field("min")}
        <span aria-hidden="true" className="shrink-0 text-sm text-muted-foreground">
          {separator}
        </span>
        {field("max")}
      </div>
      {showStatus && (
        // Polite, and only ever written to once the typing has stopped, so a screen reader
        // reports the verdict instead of narrating every half-finished state on the way to it.
        <p
          id={statusId}
          aria-live="polite"
          className={cn(
            "min-h-5 text-xs",
            issue ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {statusText}
        </p>
      )}
    </fieldset>
  )
}
