"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * What each mask character means, and what may be typed where it stands.
 *
 * Three is the whole default vocabulary, because a mask is a shape and not a validator: `#` for a
 * digit, `A` for a letter, `*` for either. Every other character in a mask is a literal that the
 * field writes for the person rather than asking them to type it — the dash in a postal code, the
 * spaces in an IBAN, the slashes in a part number.
 *
 * None of these carry the `g` flag, and none ever should. A global regular expression keeps a
 * `lastIndex` between calls, so the same pattern tested twice against the same character answers
 * `true` and then `false` — a mask that accepts every other keystroke, which reads as a flaky
 * keyboard rather than as a bug in a table.
 *
 * Pass `tokens` to add to or replace this. A vehicle identification number excludes I, O and Q so
 * they cannot be misread as 1 and 0, and no general table knows that: `tokens={{ V: /[A-HJ-NPR-Z0-9]/ }}`
 * with a mask of seventeen `V`s is the whole of it. Merge rather than replace when you still want
 * the defaults: `tokens={{ ...MASK_TOKENS, V: /[A-HJ-NPR-Z0-9]/ }}`.
 */
export const MASK_TOKENS: Readonly<Record<string, RegExp>> = {
  "#": /[0-9]/,
  A: /[A-Za-z]/,
  "*": /[A-Za-z0-9]/,
}

/** How a character is folded before it is offered to a slot. */
export type MaskTransform = "none" | "uppercase" | "lowercase"

/** One position in a compiled mask: somewhere to type, or a separator the field writes itself. */
export type MaskToken =
  | { kind: "fill"; key: string; test: RegExp }
  | { kind: "literal"; char: string }

/** English names for the default tokens, singular and plural, for `describeMask`. */
const TOKEN_NAMES: Readonly<Record<string, readonly [string, string]>> = {
  "#": ["digit", "digits"],
  A: ["letter", "letters"],
  "*": ["letter or digit", "letters or digits"],
}

/**
 * Turns a mask string into the list of positions it describes.
 *
 * A backslash escapes the character after it, so a mask can contain a literal `#`, `A` or `*` —
 * `"\\#####"` is a hash followed by four digits. This is the only reason the mask language needs an
 * escape at all, and leaving it out would make those three characters permanently unreachable as
 * separators.
 *
 * A trailing lone backslash is taken literally rather than treated as an error, because a mask is
 * usually being assembled from something a person is still typing into a settings field, and
 * throwing halfway through would take the form down.
 */
export function compileMask(
  mask: string,
  tokens: Readonly<Record<string, RegExp>> = MASK_TOKENS
): MaskToken[] {
  const compiled: MaskToken[] = []
  for (let i = 0; i < mask.length; i++) {
    const char = mask[i]
    if (char === "\\" && i + 1 < mask.length) {
      compiled.push({ kind: "literal", char: mask[++i] })
      continue
    }
    const test = tokens[char]
    if (test) compiled.push({ kind: "fill", key: char, test })
    else compiled.push({ kind: "literal", char })
  }
  return compiled
}

/** Folds one character the way `transform` asks. */
function fold(char: string, transform: MaskTransform): string {
  if (transform === "uppercase") return char.toUpperCase()
  if (transform === "lowercase") return char.toLowerCase()
  return char
}

/**
 * Reads `text` through the mask, keeping the characters that fit a slot and dropping the rest.
 *
 * This one walk is the whole component. Typing a character, pasting a finished string, and being
 * handed a stored value by a parent are the same operation with different text, which is why there
 * is no paste handler here: pasting `123-4567` into `###-####` arrives as an ordinary change event
 * whose text already carries the dash, and the dash is consumed by the literal that was going to be
 * written there anyway. The hand-rolled version of this — strip the separators, then re-insert them
 * — is what doubles them up, because it cannot tell a separator the person pasted from one it is
 * about to add.
 *
 * Three rules, in the order they are tried at each position:
 *
 * - A literal slot consumes the character when it is that literal, and otherwise consumes nothing
 *   and moves on. That second half is what lets someone type `1234567` straight through and get
 *   `123-4567`: the dash is never typed, so the slot writes it.
 * - A fill slot takes the character when the token accepts it, after folding.
 * - Anything else is discarded. A letter typed where a digit goes does not slide sideways into the
 *   next slot that would take it — silently reordering what someone typed is worse than ignoring a
 *   keystroke they can see did nothing.
 *
 * `upTo` is a caret offset into `text`; `rawAtUpTo` comes back as the number of kept characters
 * that lay before it. See `commit` for why the caret has to be counted in this unit.
 */
function readThroughMask(
  text: string,
  compiled: MaskToken[],
  transform: MaskTransform,
  upTo: number = Number.POSITIVE_INFINITY
): { raw: string; rawAtUpTo: number } {
  let raw = ""
  let rawAtUpTo = 0
  let at = 0
  let slot = 0
  while (slot < compiled.length && at < text.length) {
    const token = compiled[slot]
    if (token.kind === "literal") {
      if (text[at] === token.char) at++
      slot++
      continue
    }
    const candidate = fold(text[at], transform)
    if (token.test.test(candidate)) {
      raw += candidate
      at++
      slot++
      // `at` now points past the character just taken, so it lay before the caret when `at <= upTo`.
      if (at <= upTo) rawAtUpTo = raw.length
    } else {
      at++
    }
  }
  return { raw, rawAtUpTo }
}

/**
 * Lays `raw` out across the mask, stopping before any separator that has not been earned.
 *
 * A field holding three digits of `###-####` shows `123`, not `123-`. The eager version reads as a
 * shape hint, but it puts a character on screen that nobody typed and that backspace then has to
 * pretend to delete, and the placeholder carries that hint without either problem.
 */
function layout(raw: string, compiled: MaskToken[]): string {
  let out = ""
  let at = 0
  for (const token of compiled) {
    if (at >= raw.length) break
    if (token.kind === "literal") {
      out += token.char
      continue
    }
    out += raw[at++]
  }
  return out
}

/** How many characters the mask has room for. */
function fillCount(compiled: MaskToken[]): number {
  let n = 0
  for (const token of compiled) if (token.kind === "fill") n++
  return n
}

/**
 * The offset in a laid-out string just after its `n`th typed character.
 *
 * Counted this way because the separators move. Typing the fourth digit of `###-####` turns `123`
 * into `123-4`, which inserts two characters where one was typed; an offset restored by arithmetic
 * lands in the wrong place and an offset restored by "put it at the end" — what a hand-rolled mask
 * does — makes the field impossible to correct in the middle. "Just after the nth typed character"
 * survives both.
 */
function caretAfterFill(display: string, n: number, compiled: MaskToken[]): number {
  if (n <= 0) return 0
  let seen = 0
  let at = 0
  for (const token of compiled) {
    if (at >= display.length) break
    at++
    if (token.kind === "fill" && ++seen === n) return at
  }
  return display.length
}

/**
 * The mask applied to any string, for showing a stored value somewhere it is not being edited — a
 * confirmation step, an admin table, a receipt, an export.
 *
 * Total on purpose: it accepts the raw value, the already-formatted value, or something in between
 * a person pasted into a spreadsheet, and gives back the one right rendering. That is what makes it
 * safe to call on a row out of a database without first knowing which form was stored.
 */
export function formatWithMask(
  value: string,
  mask: string,
  options: { tokens?: Readonly<Record<string, RegExp>>; transform?: MaskTransform } = {}
): string {
  const compiled = compileMask(mask, options.tokens ?? MASK_TOKENS)
  return layout(readThroughMask(value, compiled, options.transform ?? "none").raw, compiled)
}

/**
 * The separators taken back out — the value to store and to send.
 *
 * The other half of the pair above, and the one a server wants: `unmask("123-4567", "###-####")` is
 * `"1234567"`. Exported because the same answer is needed outside React — in a route handler
 * checking what arrived, in a migration normalising a column that was written both ways.
 */
export function unmask(
  value: string,
  mask: string,
  options: { tokens?: Readonly<Record<string, RegExp>>; transform?: MaskTransform } = {}
): string {
  const compiled = compileMask(mask, options.tokens ?? MASK_TOKENS)
  return readThroughMask(value, compiled, options.transform ?? "none").raw
}

/**
 * Whether the value fills the mask completely.
 *
 * The component reports this with every change rather than acting on it. A field that refuses to
 * blur until it is full, or that turns red on the second keystroke, is a field that fights the
 * person typing into it; whether an incomplete serial number is an error is a question about the
 * form, and it is answered on submit.
 */
export function isMaskComplete(
  value: string,
  mask: string,
  options: { tokens?: Readonly<Record<string, RegExp>>; transform?: MaskTransform } = {}
): boolean {
  const compiled = compileMask(mask, options.tokens ?? MASK_TOKENS)
  const total = fillCount(compiled)
  if (total === 0) return false
  return readThroughMask(value, compiled, options.transform ?? "none").raw.length === total
}

/**
 * The mask said out loud — `"###-####"` becomes `"3 digits, then 4 digits"`.
 *
 * A mask is a visual convention, and `___-____` in a placeholder is invisible to someone using a
 * screen reader: it is read as underscores, or skipped, and either way the shape of the thing they
 * are being asked for never arrives. The component wires this into the field's description so it
 * does.
 *
 * English only, and mechanically so. A field in another language should pass its own `hint`; a
 * generated sentence in the wrong language is worse than none, because it sounds authored.
 */
export function describeMask(
  mask: string,
  options: { tokens?: Readonly<Record<string, RegExp>>; names?: Readonly<Record<string, readonly [string, string]>> } = {}
): string {
  const compiled = compileMask(mask, options.tokens ?? MASK_TOKENS)
  const names = options.names ?? TOKEN_NAMES
  const runs: { key: string; count: number }[] = []
  // Runs break on a literal as well as on a change of token, so `##-##` reads as two groups of two
  // rather than as one group of four — the grouping is the point of saying it at all.
  let previousWasFill = false
  for (const token of compiled) {
    if (token.kind !== "fill") {
      previousWasFill = false
      continue
    }
    const last = runs[runs.length - 1]
    if (last && previousWasFill && last.key === token.key) last.count++
    else runs.push({ key: token.key, count: 1 })
    previousWasFill = true
  }
  return runs
    .map(({ key, count }) => {
      const [one, many] = names[key] ?? ["character", "characters"]
      return `${count} ${count === 1 ? one : many}`
    })
    .join(", then ")
}

/** The mask with every slot shown as `placeholderChar` — `###-####` becomes `___-____`. */
function maskPlaceholder(compiled: MaskToken[], placeholderChar: string): string {
  let out = ""
  for (const token of compiled) out += token.kind === "literal" ? token.char : placeholderChar
  return out
}

export interface MaskedInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "type" | "pattern"
  > {
  /**
   * The shape to type into. `#` is a digit, `A` a letter, `*` either, `\` escapes the next
   * character, and everything else is a separator the field writes itself: `"###-####"`,
   * `"AA-####"`, `"****-****-****-****"`.
   */
  mask: string
  /** Extra or replacement slot characters. Spread `MASK_TOKENS` in to keep the three defaults. */
  tokens?: Readonly<Record<string, RegExp>>
  /** Folds what is typed — `"uppercase"` for product keys, VINs and IBANs (default `"none"`). */
  transform?: MaskTransform
  /**
   * Controlled value, with or without separators — both are read through the mask, so a column
   * written in either form comes back up correctly. Pair with `onValueChange`.
   */
  value?: string
  /** Starting value for an uncontrolled field. Ignored once `value` is passed. */
  defaultValue?: string
  /**
   * Called on every keystroke with the value stripped of separators, plus the formatted string and
   * whether the mask is now full.
   *
   * The stripped value is first because it is the one that should be stored: a mask is a reading
   * aid for one form on one screen, and a database column that has absorbed it can no longer be
   * compared, indexed or re-rendered under a different convention.
   */
  onValueChange?: (value: string, meta: { formatted: string; complete: boolean }) => void
  /** Submits the value without separators with a native form. */
  name?: string
  /** Submits the formatted value alongside it, when the separators are part of what you store. */
  formattedName?: string
  /**
   * The accessible description of the shape. Defaults to `describeMask(mask)`; pass your own for a
   * field that is not in English, or `null` when a visible hint of your own already says it.
   */
  hint?: string | null
  /** The character standing in for a slot in the default placeholder (default `"_"`). */
  placeholderChar?: string
  className?: string
}

/**
 * A text field that holds one fixed shape — a postal code, a product key, a serial or part number,
 * an employee or account number, a VIN, an IBAN.
 *
 * ```tsx
 * const [key, setKey] = React.useState("")
 *
 * return (
 *   <>
 *     <Label htmlFor="key">Product key</Label>
 *     <MaskedInput
 *       id="key"
 *       name="product_key"
 *       mask="****-****-****-****"
 *       transform="uppercase"
 *       value={key}
 *       onValueChange={setKey}
 *     />
 *   </>
 * )
 * ```
 *
 * Three things go wrong in every hand-rolled version, and they are the three this exists for.
 *
 * The caret is the first and the worst. Reformatting on each keystroke replaces the whole value, so
 * the caret goes to the end — which nobody notices while typing a fresh code left to right, and
 * which makes the field unusable the moment someone goes back to fix the third character. It is
 * tracked here in typed characters rather than offsets, because the separators move underneath it.
 *
 * Pasting is the second. An already-formatted string pasted into a field that strips and re-inserts
 * separators comes out with two of each. Here the pasted text is read through the mask like
 * anything else, and a separator it already carries is consumed by the slot that was going to write
 * one.
 *
 * What gets submitted is the third. The field shows `123-4567` and reports `1234567`, and the
 * formatted string is available beside it rather than instead of it. A controlled parent that
 * stores what it is handed stores the value, not the presentation.
 *
 * Deliberately not here: any judgement about whether the contents are real. A mask is a shape, and
 * a shape is not a checksum — an IBAN has a mod-97 check, a VIN has a check digit, a credit card
 * has Luhn, and each belongs to the form that knows which one it is asking for. `isMaskComplete`
 * says whether every slot is filled and stops there.
 *
 * This is also not the right component for a format some other field here already owns. Dates,
 * times, phone numbers, currency amounts and one-time codes each carry rules a mask cannot express
 * — a month that only goes to twelve, a calling code that decides how many digits follow, a decimal
 * separator that changes with the locale, a box per digit — and `date-input`, `time-input`,
 * `phone-input`, `currency-input` and `otp-input` exist for exactly that reason.
 */
export const MaskedInput = React.forwardRef<HTMLInputElement, MaskedInputProps>(
  function MaskedInput(
    {
      mask,
      tokens = MASK_TOKENS,
      transform = "none",
      value,
      defaultValue,
      onValueChange,
      name,
      formattedName,
      hint,
      placeholderChar = "_",
      placeholder,
      className,
      disabled = false,
      // Off by default, and overridable. A masked field is usually collecting something the browser
      // has no entry for, and a heuristic autofill that drops an unformatted value into it is read
      // through the mask as if it had been pasted. The mobile keyboard's own helpfulness is worse:
      // autocapitalise and autocorrect rewrite a serial number into a word between the keypress and
      // the change event. A field that does have an entry — a postal code — should pass its own
      // `autoComplete="postal-code"`.
      autoCapitalize = "off",
      autoComplete = "off",
      autoCorrect = "off",
      spellCheck = false,
      onKeyDown,
      ...props
    },
    forwardedRef
  ) {
    // Compiled every render rather than memoised. A mask is a handful of characters, and the cache
    // key would have to include the identity of the regular expressions in `tokens` — which a
    // caller writing them inline changes on every render anyway, so the memo would never hit while
    // still being able to go stale.
    const compiled = compileMask(mask, tokens)
    const slots = fillCount(compiled)

    const valueIsControlled = value !== undefined

    const [innerValue, setInnerValue] = React.useState<string>(
      () => readThroughMask(valueIsControlled ? value ?? "" : defaultValue ?? "", compiled, transform).raw
    )

    const raw = innerValue
    const display = layout(raw, compiled)

    const generatedId = React.useId()
    const hintId = `${generatedId}-hint`
    const hintText = hint === undefined ? describeMask(mask, { tokens }) : hint

    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement)

    /**
     * The value this component has decided on — re-synced from state each render, and written by
     * the effects below as soon as they decide on a new one.
     *
     * That second half matters because both effects run in the same pass when a parent changes the
     * mask and the value together, which is the ordinary way a country-dependent postal code field
     * behaves. Without it, the mask effect would read the value the *previous* render held, re-clip
     * that, and emit it over the one the value effect had just accepted.
     */
    const stateRef = React.useRef(raw)
    stateRef.current = raw

    /**
     * The last value handed to `onValueChange`, and the previous props, so the effects below can
     * tell "the parent changed its mind" from "the parent has not re-rendered yet".
     *
     * That distinction is the whole of the controlled-mode problem. Between a keystroke and the
     * parent's re-render the `value` prop is genuinely stale, and a field that re-seeds from a stale
     * prop erases the keystroke that produced it. Comparing the prop against its own previous value
     * separates the two cases, and it is done here rather than left to a dependency array: deps
     * decide when React *may* skip an effect, not when it must, so a component that is only correct
     * while its effect is skipped breaks the first time something re-runs it.
     */
    const lastEmittedRef = React.useRef(raw)
    const prevValueRef = React.useRef(value)
    const prevMaskRef = React.useRef(mask)

    /** Re-seed from `value`, but only on a change the parent actually made. */
    React.useEffect(() => {
      if (!valueIsControlled) return
      if (value === prevValueRef.current) return
      prevValueRef.current = value
      const incoming = readThroughMask(value ?? "", compiled, transform).raw
      lastEmittedRef.current = incoming
      if (incoming === stateRef.current) return
      stateRef.current = incoming
      setInnerValue(incoming)
    })

    /**
     * A mask that changes takes the value with it.
     *
     * Forms do this — a postal code field whose shape follows the country above it — and the value
     * left behind is measured in the old mask's slots. Re-reading it through the new one is what
     * keeps a five-digit code from sitting invisibly in state behind a four-slot field, and the
     * parent is told because the value it is storing has genuinely changed.
     */
    React.useEffect(() => {
      if (mask === prevMaskRef.current) return
      prevMaskRef.current = mask
      const next = readThroughMask(stateRef.current, compiled, transform).raw
      if (next === stateRef.current) return
      stateRef.current = next
      setInnerValue(next)
      lastEmittedRef.current = next
      onValueChange?.(next, { formatted: layout(next, compiled), complete: next.length === slots })
    })

    /** Where the caret goes once React has re-rendered with the reformatted text. */
    const caretRef = React.useRef<number | null>(null)
    React.useLayoutEffect(() => {
      const at = caretRef.current
      if (at === null) return
      caretRef.current = null
      inputRef.current?.setSelectionRange?.(at, at)
    })

    /**
     * The single write path. `setInnerValue` runs whether or not the value is controlled — see the
     * effect above for why — and the caret is queued in typed characters before the text is
     * reformatted, since the offset it will need does not exist until then.
     */
    function commit(nextRaw: string, caretFill: number) {
      const clipped = nextRaw.slice(0, slots)
      setInnerValue(clipped)
      const formatted = layout(clipped, compiled)
      caretRef.current = caretAfterFill(formatted, Math.min(caretFill, clipped.length), compiled)
      lastEmittedRef.current = clipped
      onValueChange?.(clipped, { formatted, complete: clipped.length === slots })
    }

    function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
      const text = event.target.value
      const caret = event.target.selectionStart ?? text.length
      const { raw: next, rawAtUpTo } = readThroughMask(text, compiled, transform, caret)
      commit(next, rawAtUpTo)
    }

    /**
     * Backspace and Delete are handled here rather than left to the browser because the separators
     * were never typed and should not have to be deleted.
     *
     * Without this, backspacing over the dash in `123-4567` removes it, the reformat puts it
     * straight back, and the key appears to do nothing — the single most common complaint about
     * masked inputs. Deleting a typed character instead means the caret lands one place earlier and
     * the separator follows it, which is what the key looked like it was going to do.
     */
    function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
      onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (event.key !== "Backspace" && event.key !== "Delete") return
      const el = event.currentTarget
      const start = el.selectionStart ?? 0
      // A selection deletes what is selected; the browser does that correctly and `handleChange`
      // reformats what is left.
      if (start !== (el.selectionEnd ?? start)) return
      const before = readThroughMask(el.value, compiled, transform, start).rawAtUpTo
      if (event.key === "Backspace") {
        if (before === 0) return
        event.preventDefault()
        commit(raw.slice(0, before - 1) + raw.slice(before), before - 1)
      } else {
        if (before >= raw.length) return
        event.preventDefault()
        commit(raw.slice(0, before) + raw.slice(before + 1), before)
      }
    }

    const describedBy = [hintText ? hintId : null, props["aria-describedby"]]
      .filter(Boolean)
      .join(" ")

    return (
      <>
        <input
          {...props}
          ref={inputRef}
          // "text" rather than "number": a part number is a string that happens to contain digits,
          // and a number input would offer a spinner, drop a leading zero, and refuse to hold the
          // separators at all.
          type="text"
          // A numeric keypad on a phone whenever every slot is a digit, and the ordinary keyboard
          // the moment one of them is not. Worth deriving rather than asking for: a postal code
          // field that opens the full keyboard is a small tax paid by everyone who fills the form.
          inputMode={
            slots > 0 && compiled.every((t) => t.kind === "literal" || t.key === "#")
              ? "numeric"
              : "text"
          }
          value={display}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder ?? maskPlaceholder(compiled, placeholderChar)}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete}
          autoCorrect={autoCorrect}
          spellCheck={spellCheck}
          aria-describedby={describedBy || undefined}
          className={cn(
            "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        />

        {hintText ? (
          <span id={hintId} className="sr-only">
            Format: {hintText}
          </span>
        ) : null}

        {name ? <input type="hidden" name={name} value={raw} /> : null}
        {formattedName ? <input type="hidden" name={formattedName} value={display} /> : null}
      </>
    )
  }
)
