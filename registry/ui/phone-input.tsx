"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { CountrySelect } from "@/registry/ui/country-select"

/**
 * The ITU-T E.164 country calling code for every ISO 3166-1 country that has one, without the `+`.
 *
 * This is the one table this family of components could not avoid shipping. `country-select`,
 * `currency-select`, `timezone-select` and `language-select` all read their data out of `Intl` at
 * runtime rather than carrying a list, and none of that works here: `Intl.supportedValuesOf`
 * rejects every phone-shaped key, `Intl.Locale` exposes no telephony property, and
 * `Intl.DisplayNames` names regions and currencies but not calling codes. No runtime knows that
 * Japan is +81.
 *
 * Carrying it is a smaller liability than it looks. Calling codes are close to frozen — the last
 * new one was South Sudan's +211 in 2011 — where currency codes changed twice in the last two
 * years, so this table does not rot the way a currency table would.
 *
 * Three ISO countries are deliberately absent, because no calling code is assigned to them at all:
 * `AQ` (Antarctica, whose stations dial through whichever operator runs them), `HM` and `UM`. They
 * exist in `country-select`, which answers a different question — an address can name a place that
 * has no telephone service.
 *
 * The value here is the *calling code*, never a calling code plus an area code. That distinction
 * matters most across the North American Numbering Plan: the Bahamas is +1, not +1-242, because 242
 * is part of the ten-digit national number a Bahamian would dial. Twenty-five countries share +1
 * this way, and four share +44, which is why the country a person picks is kept as its own piece of
 * state and never inferred from the digits alone.
 */
export const DIAL_CODES: Readonly<Record<string, string>> = {
  AD: "376", AE: "971", AF: "93", AG: "1", AI: "1", AL: "355", AM: "374", AO: "244",
  AR: "54", AS: "1", AT: "43", AU: "61", AW: "297", AX: "358", AZ: "994", BA: "387",
  BB: "1", BD: "880", BE: "32", BF: "226", BG: "359", BH: "973", BI: "257", BJ: "229",
  BL: "590", BM: "1", BN: "673", BO: "591", BQ: "599", BR: "55", BS: "1", BT: "975",
  BV: "47", BW: "267", BY: "375", BZ: "501", CA: "1", CC: "61", CD: "243", CF: "236",
  CG: "242", CH: "41", CI: "225", CK: "682", CL: "56", CM: "237", CN: "86", CO: "57",
  CR: "506", CU: "53", CV: "238", CW: "599", CX: "61", CY: "357", CZ: "420", DE: "49",
  DJ: "253", DK: "45", DM: "1", DO: "1", DZ: "213", EC: "593", EE: "372", EG: "20",
  EH: "212", ER: "291", ES: "34", ET: "251", FI: "358", FJ: "679", FK: "500", FM: "691",
  FO: "298", FR: "33", GA: "241", GB: "44", GD: "1", GE: "995", GF: "594", GG: "44",
  GH: "233", GI: "350", GL: "299", GM: "220", GN: "224", GP: "590", GQ: "240", GR: "30",
  GS: "500", GT: "502", GU: "1", GW: "245", GY: "592", HK: "852", HN: "504", HR: "385",
  HT: "509", HU: "36", ID: "62", IE: "353", IL: "972", IM: "44", IN: "91", IO: "246",
  IQ: "964", IR: "98", IS: "354", IT: "39", JE: "44", JM: "1", JO: "962", JP: "81",
  KE: "254", KG: "996", KH: "855", KI: "686", KM: "269", KN: "1", KP: "850", KR: "82",
  KW: "965", KY: "1", KZ: "7", LA: "856", LB: "961", LC: "1", LI: "423", LK: "94",
  LR: "231", LS: "266", LT: "370", LU: "352", LV: "371", LY: "218", MA: "212", MC: "377",
  MD: "373", ME: "382", MF: "590", MG: "261", MH: "692", MK: "389", ML: "223", MM: "95",
  MN: "976", MO: "853", MP: "1", MQ: "596", MR: "222", MS: "1", MT: "356", MU: "230",
  MV: "960", MW: "265", MX: "52", MY: "60", MZ: "258", NA: "264", NC: "687", NE: "227",
  NF: "672", NG: "234", NI: "505", NL: "31", NO: "47", NP: "977", NR: "674", NU: "683",
  NZ: "64", OM: "968", PA: "507", PE: "51", PF: "689", PG: "675", PH: "63", PK: "92",
  PL: "48", PM: "508", PN: "64", PR: "1", PS: "970", PT: "351", PW: "680", PY: "595",
  QA: "974", RE: "262", RO: "40", RS: "381", RU: "7", RW: "250", SA: "966", SB: "677",
  SC: "248", SD: "249", SE: "46", SG: "65", SH: "290", SI: "386", SJ: "47", SK: "421",
  SL: "232", SM: "378", SN: "221", SO: "252", SR: "597", SS: "211", ST: "239", SV: "503",
  SX: "1", SY: "963", SZ: "268", TC: "1", TD: "235", TF: "262", TG: "228", TH: "66",
  TJ: "992", TK: "690", TL: "670", TM: "993", TN: "216", TO: "676", TR: "90", TT: "1",
  TV: "688", TW: "886", TZ: "255", UA: "380", UG: "256", US: "1", UY: "598", UZ: "998",
  VA: "39", VC: "1", VE: "58", VG: "1", VI: "1", VN: "84", VU: "678", WF: "681",
  WS: "685", YE: "967", YT: "262", ZA: "27", ZM: "260", ZW: "263",
}

/**
 * The countries this field can offer, alphabetical by code — every ISO country with a calling code.
 *
 * Pass it, or a narrowing of it, to `country-select` elsewhere in the same form so the two controls
 * agree on what exists.
 */
export const PHONE_COUNTRIES: readonly string[] = Object.keys(DIAL_CODES).sort()

/**
 * The country shown when a calling code is shared and nothing else says which one it is.
 *
 * Thirteen codes belong to more than one country, and a number alone cannot say which: +1 is the
 * United States and twenty-four other places, +44 is the United Kingdom and three Crown
 * dependencies. When a value arrives from a database with no country beside it, one of them has to
 * be shown, and showing the most populous is the guess that is right most often. Keep the country
 * next to the number — `countryName` below writes it into the same form — and this table is never
 * consulted.
 */
const PRIMARY_COUNTRY: Readonly<Record<string, string>> = {
  "1": "US", "7": "RU", "39": "IT", "44": "GB", "47": "NO", "61": "AU", "64": "NZ",
  "212": "MA", "262": "RE", "358": "FI", "500": "FK", "590": "GP", "599": "CW",
}

/** Every distinct calling code, for the longest-prefix match in `splitPhoneNumber`. */
const DIAL_CODE_SET = new Set(Object.values(DIAL_CODES))

/** E.164 caps a whole number — calling code and national digits together — at fifteen digits. */
const E164_MAX_DIGITS = 15

/** The calling code for an ISO 3166-1 alpha-2 code, without the `+`, or "" if it has none. */
export function getDialCode(country: string): string {
  return DIAL_CODES[country.toUpperCase()] ?? ""
}

/**
 * Splits an E.164 number into its calling code and the national digits after it.
 *
 * Exported because the split is needed wherever a stored number is shown rather than edited — a
 * confirmation screen, an SMS log, an admin table — and doing it by hand goes wrong on the codes
 * that are one digit (+1, +7) and the ones that are three (+263), which cannot be told apart
 * without the list. The longest code that matches wins, so +1 never swallows a +1-shaped prefix of
 * a longer code.
 *
 * A string with no leading `+` is not an international number and is not guessed at: its digits
 * come back as the national part with an empty calling code, which is what lets a field keep
 * accepting a local number a parent handed it unchanged.
 */
export function splitPhoneNumber(value: string): { dialCode: string; national: string } {
  const digits = value.replace(/\D/g, "")
  if (!value.trim().startsWith("+")) return { dialCode: "", national: digits }
  for (let length = 3; length >= 1; length--) {
    const head = digits.slice(0, length)
    if (DIAL_CODE_SET.has(head)) return { dialCode: head, national: digits.slice(length) }
  }
  return { dialCode: "", national: digits }
}

/**
 * The E.164 string for a country and a national number, or "" when there are no national digits.
 *
 * "" rather than "+81" for an empty number on purpose: a calling code with nothing after it is not
 * a phone number, and a parent that stored it would later have to strip it back off before deciding
 * whether the field was filled in.
 */
export function toE164(country: string, national: string): string {
  const dialCode = getDialCode(country)
  const digits = national.replace(/\D/g, "")
  if (!dialCode || !digits) return ""
  return `+${dialCode}${digits}`.slice(0, E164_MAX_DIGITS + 1)
}

/**
 * The visitor's own country, from the runtime's locale — `getRegionCountry()` on a browser set to
 * ja-JP gives "JP".
 *
 * Not the default, deliberately: the server's locale is the server's, so seeding the field from the
 * runtime would render one country on the server and another after hydration, and unlike a
 * mislabelled row that mismatch changes the value that gets submitted. Pass it as `defaultCountry`
 * from an effect, or from a country you already resolved from the request, when you want it.
 */
export function getRegionCountry(locale?: string): string {
  try {
    const tag = locale ?? new Intl.DateTimeFormat().resolvedOptions().locale
    const region = new Intl.Locale(tag).maximize().region
    return region && DIAL_CODES[region] ? region : ""
  } catch {
    return ""
  }
}

/**
 * The national digits, spaced for reading.
 *
 * Groups of three, which is what E.123 uses for international notation, with a trailing lone digit
 * folded into the group before it so a ten-digit number reads "415 555 0132" rather than
 * "415 555 013 2".
 *
 * It is not the national convention, and that is a decision rather than an oversight: writing
 * 90-1234-5678 in Japan, 07911 123456 in the UK and (415) 555-0132 in the US needs a per-country
 * rule for all 246 of them, which is libphonenumber's job and half a megabyte of it. Pass `format`
 * for a form that only ever collects one country's numbers.
 */
export function formatPhoneDigits(digits: string, format?: string): string {
  const clean = digits.replace(/\D/g, "")
  if (!clean) return ""
  if (format !== undefined) {
    if (format === "") return clean
    let out = ""
    let at = 0
    for (const ch of format) {
      if (at >= clean.length) break
      if (ch === "#") out += clean[at++]
      else out += ch
    }
    // Digits past the end of the mask are kept rather than dropped: a mask is a reading aid, and
    // silently swallowing what someone typed is worse than a number that outgrows its shape.
    return at < clean.length ? `${out} ${clean.slice(at)}` : out
  }
  const groups: string[] = []
  for (let i = 0; i < clean.length; i += 3) groups.push(clean.slice(i, i + 3))
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    groups[groups.length - 2] += groups.pop()
  }
  return groups.join(" ")
}

/** How many digits `text` holds — the unit the caret is tracked in, since separators move. */
function countDigits(text: string): number {
  let n = 0
  for (const ch of text) if (ch >= "0" && ch <= "9") n++
  return n
}

/** The offset in `text` just after its `n`th digit, for putting the caret back after a reformat. */
function caretAfterDigits(text: string, n: number): number {
  if (n <= 0) return 0
  let seen = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch >= "0" && ch <= "9" && ++seen === n) return i + 1
  }
  return text.length
}

/** `digits` without the one at `index`. */
function removeDigitAt(digits: string, index: number): string {
  return digits.slice(0, index) + digits.slice(index + 1)
}

export interface PhoneInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "type" | "name" | "prefix"
  > {
  /** Controlled number in E.164 ("+819012345678"). "" is an empty field. Pair with `onValueChange`. */
  value?: string
  /** Starting number for an uncontrolled field. Ignored once `value` is passed. */
  defaultValue?: string
  /**
   * Called with the E.164 number on every keystroke, and "" while the national part is empty.
   *
   * It fires with partial numbers as they are typed, the way any text field does — this component
   * assembles and never judges. Nothing here can tell a finished number from half of one, because
   * that answer is per-country and lives in libphonenumber; validate on submit, or on the server.
   */
  onValueChange?: (value: string) => void
  /** Controlled ISO 3166-1 alpha-2 country, e.g. "JP". Pair with `onCountryChange`. */
  country?: string
  /** Country an uncontrolled field starts on (default "US"; see `getRegionCountry`). */
  defaultCountry?: string
  /** Called with the alpha-2 code when the country changes, including when a pasted number moves it. */
  onCountryChange?: (country: string) => void
  /** The countries to offer, in place of all 246. Anything without a calling code is dropped. */
  countries?: readonly string[]
  /** Countries pinned above the alphabet, in the order given — where your sign-ups come from. */
  priority?: readonly string[]
  /** Language the country names are shown in (default: the runtime's own). */
  locale?: string
  /** Show the flag emoji beside each country. Off by default — Windows ships no flag glyphs. */
  flags?: boolean
  /**
   * Digit mask for the national number, e.g. "## #### ####". "#" is a digit slot and every other
   * character is a literal separator. Omit for groups of three; pass "" for no grouping at all.
   */
  format?: string
  /** Submits the E.164 number with a native form. */
  name?: string
  /**
   * Submits the chosen country alongside it. Worth setting: +1 and +44 are shared by twenty-nine
   * countries, so the number alone cannot be re-rendered on the country a person actually picked.
   */
  countryName?: string
  /** Accessible name for the country control (default "Country calling code"). */
  countryLabel?: string
  /** Lands on the number input, so a `<label htmlFor>` names the field. */
  id?: string
  className?: string
  disabled?: boolean
}

/**
 * A phone number field: a country picker, its calling code shown as a prefix, and a number input
 * that emits one E.164 string.
 *
 * ```tsx
 * const [phone, setPhone] = React.useState("")
 *
 * return (
 *   <>
 *     <Label htmlFor="phone">Mobile number</Label>
 *     <PhoneInput
 *       id="phone"
 *       name="phone"
 *       countryName="phone_country"
 *       value={phone}
 *       onValueChange={setPhone}
 *       defaultCountry="JP"
 *       priority={["JP", "US", "GB"]}
 *     />
 *   </>
 * )
 * ```
 *
 * What it does and does not claim is the whole design. It assembles `+` + calling code + the digits
 * typed, caps the result at E.164's fifteen digits, and spaces those digits for reading. It does not
 * decide whether the number is real, because that is a per-country rule for 246 countries and the
 * library that knows them is far larger than everything in this registry put together. A field that
 * pretends otherwise fails people in the countries whose rules it got wrong, which is the failure
 * mode worth avoiding.
 *
 * The country is its own state rather than something read back out of the number. Twenty-five
 * countries share +1 and four share +44, so a stored "+12425550100" cannot say whether its owner is
 * in the Bahamas or misdialled from Nevada; keeping the country separate — and submitting it with
 * `countryName` — is what lets the field come back up on the country the person actually chose.
 */
export const PhoneInput = React.forwardRef<HTMLInputElement, PhoneInputProps>(
  function PhoneInput(
    {
      value,
      defaultValue,
      onValueChange,
      country,
      defaultCountry = "US",
      onCountryChange,
      countries,
      priority,
      locale,
      flags = false,
      format,
      name,
      countryName,
      countryLabel = "Country calling code",
      placeholder = "Phone number",
      id,
      className,
      disabled = false,
      "aria-label": ariaLabel,
      ...props
    },
    forwardedRef
  ) {
    const valueIsControlled = value !== undefined
    const countryIsControlled = country !== undefined

    // Read only by the state initialisers below, which run once. Recomputing it on later renders
    // costs one regex and changes nothing, so it does not need to be a hook.
    const seed = splitPhoneNumber(valueIsControlled ? value ?? "" : defaultValue ?? "")

    const [innerCountry, setInnerCountry] = React.useState<string>(() => {
      const fromSeed = seed.dialCode
        ? countryForDial(seed.dialCode)
        : ""
      const start = (countryIsControlled ? country : "") || fromSeed || defaultCountry
      // A narrowed `countries` that leaves out the starting country would otherwise open on a
      // country the caller excluded, and submit it.
      if (countries && !countries.includes(start)) {
        return countries.find((code) => DIAL_CODES[code]) ?? start
      }
      return start
    })
    const [national, setNational] = React.useState<string>(() => seed.national)

    const activeCountry = countryIsControlled ? country ?? "" : innerCountry
    const dialCode = getDialCode(activeCountry)

    const emitted = toE164(activeCountry, national)

    const generatedId = React.useId()
    const inputId = id ?? `${generatedId}-number`
    const prefixId = `${generatedId}-dial`

    const inputRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement)

    // Read inside the effects below, so they compare against what is on screen right now rather
    // than against whatever the closure captured when the prop last changed.
    const stateRef = React.useRef({ national, emitted, activeCountry })
    stateRef.current = { national, emitted, activeCountry }

    /**
     * The last value handed to `onValueChange`, and the previous props, so the effects below can
     * tell "the parent changed its mind" from "the parent has not re-rendered yet".
     *
     * That distinction is the whole of the controlled-mode problem, and this registry has already
     * shipped the wrong answer to it once, in `date-input`. What is on screen here — a country and
     * some digits — is richer than the one string that comes back out, so between a keystroke and
     * the parent's re-render the prop is genuinely stale, and a field that re-seeds from a stale
     * prop erases the keystroke that produced it.
     *
     * Comparing the prop against its own previous value is what separates the two cases, and it is
     * deliberately done here rather than left to a dependency array: deps decide when React *may*
     * skip an effect, not when it must, so a component that is only correct while its effect is
     * skipped is a component that breaks the first time something re-runs it.
     */
    const lastEmittedRef = React.useRef(emitted)
    const prevValueRef = React.useRef(value)
    const prevCountryRef = React.useRef(country)

    /** Re-seed from `value`, but only on a change the parent actually made. */
    React.useEffect(() => {
      if (!valueIsControlled) return
      if (value === prevValueRef.current) return
      prevValueRef.current = value
      const incoming = value ?? ""
      lastEmittedRef.current = incoming
      if (incoming === stateRef.current.emitted) return
      const next = splitPhoneNumber(incoming)
      const code = next.dialCode || getDialCode(stateRef.current.activeCountry)
      setNational(next.national.slice(0, Math.max(0, E164_MAX_DIGITS - code.length)))
      // A number whose calling code is not the one on screen moves the country with it. Leaving the
      // country alone when it already carries that code is what keeps a Bahamian +1 number from
      // snapping to the United States on its first round trip.
      if (next.dialCode && next.dialCode !== getDialCode(stateRef.current.activeCountry)) {
        const resolved = countryForDial(next.dialCode)
        if (resolved) {
          if (!countryIsControlled) setInnerCountry(resolved)
          onCountryChange?.(resolved)
        }
      }
    })

    /**
     * The same pull-back for a controlled country. The parent can move the country without touching
     * the number, and the value has to follow the new calling code — nothing else would tell it.
     */
    React.useEffect(() => {
      if (!countryIsControlled) return
      if (country === prevCountryRef.current) return
      prevCountryRef.current = country
      const next = toE164(country ?? "", stateRef.current.national)
      if (next === lastEmittedRef.current) return
      lastEmittedRef.current = next
      onValueChange?.(next)
    })

    /**
     * Where the caret goes once React has re-rendered with the reformatted text.
     *
     * Counted in digits, not characters, because the separators move: typing the tenth digit of a
     * number turns "415 555 013" into "415 555 0132" in one place and "12 345 678" into
     * "123 456 789" in another. Restoring "after the nth digit" survives both; restoring an offset
     * does not, and putting the caret back at the end — what a naive masked input does — makes the
     * field impossible to correct in the middle.
     */
    const caretRef = React.useRef<number | null>(null)
    React.useLayoutEffect(() => {
      const at = caretRef.current
      if (at === null) return
      caretRef.current = null
      inputRef.current?.setSelectionRange?.(at, at)
    })

    const display = formatPhoneDigits(national, format)

    /**
     * The single write path. `setNational` runs whether or not the value is controlled — see the
     * effect above for why — and the caret is queued in digits before the text is reformatted.
     */
    function commit(digits: string, caretDigits: number, nextCountry?: string) {
      const country_ = nextCountry ?? activeCountry
      const clipped = digits.slice(0, Math.max(0, E164_MAX_DIGITS - getDialCode(country_).length))
      setNational(clipped)
      if (nextCountry && nextCountry !== activeCountry) {
        if (!countryIsControlled) setInnerCountry(nextCountry)
        onCountryChange?.(nextCountry)
      }
      caretRef.current = caretAfterDigits(
        formatPhoneDigits(clipped, format),
        Math.min(caretDigits, clipped.length)
      )
      lastEmittedRef.current = toE164(country_, clipped)
      onValueChange?.(lastEmittedRef.current)
    }

    function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
      const raw = event.target.value
      const caret = event.target.selectionStart ?? raw.length
      const before = countDigits(raw.slice(0, caret))

      // Someone pasting "+81 90-1234-5678" into the number half means the whole number, not a
      // national one that happens to start with 81. Only a leading `+` says so — anything else is
      // taken as digits under the country already chosen.
      if (raw.trim().startsWith("+")) {
        const parsed = splitPhoneNumber(raw)
        if (parsed.dialCode) {
          const resolved =
            getDialCode(activeCountry) === parsed.dialCode
              ? activeCountry
              : countryForDial(parsed.dialCode)
          commit(parsed.national, parsed.national.length, resolved || undefined)
          return
        }
      }

      const digits = raw.replace(/\D/g, "")
      commit(digits, before)
    }

    /**
     * Backspace and Delete are handled here rather than left to the browser because the separators
     * are not typed and should not have to be deleted. Without this, backspacing over the space in
     * "415 555" removes it, the reformat puts it straight back, and the key appears to do nothing —
     * the single most common complaint about masked inputs.
     */
    function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
      props.onKeyDown?.(event)
      if (event.defaultPrevented) return
      if (event.key !== "Backspace" && event.key !== "Delete") return
      const el = event.currentTarget
      const start = el.selectionStart ?? 0
      // A selection deletes what is selected; the browser handles that correctly and `handleChange`
      // reformats what is left.
      if (start !== (el.selectionEnd ?? start)) return
      const before = countDigits(el.value.slice(0, start))
      if (event.key === "Backspace") {
        if (before === 0) return
        event.preventDefault()
        commit(removeDigitAt(national, before - 1), before - 1)
      } else {
        if (before >= national.length) return
        event.preventDefault()
        commit(removeDigitAt(national, before), before)
      }
    }

    function handleCountryChange(next: string) {
      if (!countryIsControlled) setInnerCountry(next)
      onCountryChange?.(next)
      // The digits stay; only the code in front of them changed. Re-clip in case the new code is
      // longer and the number no longer fits inside E.164's fifteen.
      const clipped = national.slice(0, Math.max(0, E164_MAX_DIGITS - getDialCode(next).length))
      if (clipped !== national) setNational(clipped)
      lastEmittedRef.current = toE164(next, clipped)
      onValueChange?.(lastEmittedRef.current)
    }

    const offered = React.useMemo(() => {
      const list = countries ?? PHONE_COUNTRIES
      return list.filter((code) => DIAL_CODES[code])
    }, [countries])

    return (
      <div
        role="group"
        aria-label={ariaLabel ?? placeholder}
        // Two columns rather than a narrow country button: the picker this composes is a full
        // combobox whose panel is as wide as its trigger, so squeezing the trigger down to a flag
        // and a code would truncate every country name in the list underneath it.
        className={cn("grid grid-cols-[minmax(8rem,1fr)_1fr] items-start gap-2", className)}
      >
        <CountrySelect
          value={activeCountry}
          onValueChange={handleCountryChange}
          countries={offered}
          priority={priority}
          locale={locale}
          flags={flags}
          disabled={disabled}
          aria-label={countryLabel}
          placeholder="Country"
        />

        <div
          className={cn(
            "flex h-9 w-full items-center rounded-md border border-input bg-transparent text-sm shadow-sm transition-colors",
            "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
            disabled && "cursor-not-allowed opacity-50"
          )}
        >
          {dialCode ? (
            <span
              id={prefixId}
              className="select-none whitespace-nowrap pl-3 text-muted-foreground tabular-nums"
            >
              +{dialCode}
            </span>
          ) : null}
          <input
            {...props}
            ref={inputRef}
            id={inputId}
            // "tel" rather than "number": a phone number is a string of digits, not a quantity, and
            // a number input would offer a spinner and drop a leading zero.
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            value={display}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder}
            // Named by the caller's own `<label htmlFor>` when they passed an `id`; otherwise this
            // is the only name the field would have, and a placeholder is not one.
            aria-label={ariaLabel ?? (id ? undefined : placeholder)}
            // Points at the "+81", so the calling code is announced with the field rather than
            // being a piece of visual context a screen reader never reaches.
            aria-describedby={
              dialCode ? [prefixId, props["aria-describedby"]].filter(Boolean).join(" ") : props["aria-describedby"]
            }
            className={cn(
              "h-full w-full min-w-0 flex-1 rounded-md bg-transparent px-3 py-1 tabular-nums outline-none",
              "placeholder:text-muted-foreground disabled:cursor-not-allowed",
              dialCode && "pl-1"
            )}
          />
        </div>

        {name ? <input type="hidden" name={name} value={emitted} /> : null}
        {countryName ? <input type="hidden" name={countryName} value={activeCountry} /> : null}
      </div>
    )
  }
)

/**
 * The country to show for a bare calling code: the one `PRIMARY_COUNTRY` names when the code is
 * shared, and otherwise the only country that has it.
 */
function countryForDial(dialCode: string): string {
  const primary = PRIMARY_COUNTRY[dialCode]
  if (primary) return primary
  for (const code of PHONE_COUNTRIES) if (DIAL_CODES[code] === dialCode) return code
  return ""
}
