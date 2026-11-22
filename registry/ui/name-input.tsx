"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A person's name, in the fields and the order the reader's own locale writes them.
 *
 * The reason this is a component and not two inputs labelled First name and Last name is that
 * both halves of that layout are assumptions, and each one locks somebody out.
 *
 * The **order** is not universal. Derived from CLDR, eleven languages write the family name first
 * — Hungarian, Japanese, Khmer, Korean, Mongolian, Sinhala, Tamil, Telugu, Vietnamese, Cantonese
 * and Chinese (`SURNAME_FIRST_LANGUAGES`, produced by `node scripts/person-name-data.mjs`). The
 * design note for this component had that list as "Japan, China, Korea, Hungary", which is four
 * right answers and seven missing ones; a Tamil or Khmer speaker meets exactly the same reversed
 * form as a Japanese one. The list is derived rather than written down because there is no way to
 * notice the omission by reading the component, and `--check` re-derives it against upstream.
 *
 * The **split itself** does not hold either. W3C's "Personal names around the world" is explicit:
 * do not require a family name, because in parts of Southern India, Malaysia and Indonesia a large
 * number of people have a given name only — and when a form demands one anyway, people "enter
 * garbage data like '.' or 'Mr.' in the family name field just to escape the form". A required
 * family name is the same defect as a required state in `address-input`: it does not collect the
 * missing data, it corrupts the data that was there. So the family name is **optional by default**,
 * and `allowSingleName` offers the reader one field instead of two.
 *
 * The **autofill tokens** are the part that looks done and is not. HTML defines `name` as the
 * *full* name — the spec's own example is "Sir Timothy John Berners-Lee, OM, KBE, FRS, FREng,
 * FRSA" — so putting `autocomplete="name"` on a split field asks the browser to fill the whole
 * name into the half of the form meant for one part of it. The split fields take `given-name`,
 * `additional-name` and `family-name`; `name` is used here only in single-field mode, where it is
 * the correct token rather than a near-enough one.
 *
 * The **phonetic fields** Japanese forms carry (セイ／メイ) have no token at all. Measured against
 * the HTML standard, `phonetic`, `furigana` and `kana` appear zero times in the autofill section,
 * and CLDR's person-name fields (`given`, `given2`, `surname`, `generation`, `title`) have no
 * phonetic member either. The tempting fix is the nearest token — but `autocomplete="given-name"`
 * on a reading field tells the browser to fill the *written* name into it, so a reader who
 * autofills gets kanji in the furigana box and has to clear it by hand. These fields therefore
 * carry `autocomplete="off"`: there is no right token, and the nearest wrong one actively breaks
 * the field.
 *
 * What it deliberately does not do:
 *
 *   - **No character validation.** Not a letters-only rule, not a two-characters-minimum, not a
 *     "no numbers" rule. W3C's list of what this breaks is long — apostrophes and hyphens
 *     (O'Brien, Demna-Whitfield), spaces inside one name (Rose Marie), capitals that are not the
 *     first letter (McNamara), words that are not capitalised (van der Waals) — and a name that
 *     looks wrong to a regex is usually a name. Only emptiness of required fields is checked.
 *   - **No normalising.** The value is stored exactly as typed. No trimming into state, no title
 *     casing, no uppercasing: W3C asks forms to "preserve the case the user enters", and a form
 *     that renders `MCNAMARA` back at someone has not tidied their name, it has misspelt it.
 *   - **No length limit.** No `maxLength` on any field, because names are longer than the form
 *     designer's own.
 *   - **No title placement engine.** `honorific` is opt-in and the prefix renders first, which is
 *     what the token means. CLDR puts the title *last* in surname-first locales, and resolving
 *     that properly is a formatting problem, not a form problem.
 *
 * ```tsx
 * const [name, setName] = React.useState(emptyName)
 *
 * <NameInput value={name} onChange={setName} locale="ja-JP" phonetic />
 * ```
 *
 * Validate on submit with the same rules the fields show on blur:
 *
 * ```tsx
 * const errors = validateName(name)
 * if (Object.keys(errors).length) return setShowErrors(true)
 * ```
 */

/**
 * The locale the order is resolved in before hydration. See `activeLocale` in the component.
 *
 * CLDR's `und` — the root locale, what it answers when it is given nothing — lists itself as
 * given-first, so this default is the measured one rather than an Anglocentric guess.
 */
const HYDRATION_LOCALE = "en-US"

/**
 * The languages whose forms write the family name first, derived from CLDR by
 * `node scripts/person-name-data.mjs`. Run it with `--check` to diff this against upstream.
 */
export const SURNAME_FIRST_LANGUAGES = [
  "hu",
  "ja",
  "km",
  "ko",
  "mn",
  "si",
  "ta",
  "te",
  "vi",
  "yue",
  "zh",
] as const

/** Which part of the name a form writes first. */
export type NameOrder = "givenFirst" | "surnameFirst"

/** The parts of a name this component collects, named as HTML autofill names them. */
export type NameField =
  | "honorificPrefix"
  | "given"
  | "additional"
  | "surname"
  | "phoneticSurname"
  | "phoneticGiven"
  | "fullName"

/**
 * A whole name. Every field is always present, even the ones the current options do not render, so
 * a partly-filled name is fully representable and a controlled parent can store it without
 * dropping keystrokes.
 *
 * `singleName` is part of the value rather than component state because it is the reader's answer
 * to a question about themselves, and it decides which of the other fields is their actual name. A
 * parent that stores the name and not that flag has stored a row it cannot read back.
 */
export type NameValue = Record<NameField, string> & { singleName: boolean }

/**
 * The language subtag of a locale, lowercased — `ja-JP` is `ja`, `zh-Hant-MO` is `zh`.
 *
 * Hand-parsed rather than passed through `Intl`: this runs on whatever a caller puts in `locale`,
 * including a malformed tag, and the fallback that matters is "treat it as unknown and use the
 * default order", not an exception out of a form's render.
 */
export function languageOf(locale: string | undefined): string {
  const match = /^[A-Za-z]{2,3}/.exec(String(locale ?? "").trim())
  return match ? match[0].toLowerCase() : ""
}

/**
 * Whether a locale writes the family name before the given name.
 *
 * Asked of the *reader's* locale, which is a different question from the one CLDR's per-locale
 * lists answer. Those say which order a locale uses when it *displays* a name from somewhere else,
 * and the two disagree: `en` reorders a Hungarian name to Viktor Orbán, so asking `en` about `hu`
 * returns given-first. A form is not displaying a foreign name, it is collecting the reader's own,
 * so what matters is whether a locale writes *itself* surname-first — and `hu` does. That
 * distinction is the whole derivation; see scripts/person-name-data.mjs.
 */
export function nameOrderFor(locale: string | undefined): NameOrder {
  const language = languageOf(locale)
  return (SURNAME_FIRST_LANGUAGES as readonly string[]).includes(language)
    ? "surnameFirst"
    : "givenFirst"
}

/**
 * The default English labels, by field.
 *
 * Exported so a caller overriding one can start from the rest. The phonetic labels read "(phonetic)"
 * rather than "Furigana" because the fields are not Japanese-only — Hong Kong and Taiwan forms ask
 * for a romanised reading in the same slot — and a Japanese form should pass `labels` with セイ and
 * メイ, which is one object rather than a locale-detection branch nobody can test.
 */
export const FIELD_LABELS: Record<string, string> = {
  honorificPrefix: "Title",
  given: "Given name",
  additional: "Middle name",
  surname: "Family name",
  phoneticSurname: "Family name (phonetic)",
  phoneticGiven: "Given name (phonetic)",
  fullName: "Full name",
  singleName: "I have a single name",
}

/** One rendered field: what it is, what it says, whether it may be empty, what fills it. */
export type NameFieldSpec = {
  field: NameField
  label: string
  required: boolean
  /** The autofill token, or `"off"` for the phonetic fields, which have none. */
  autoComplete: string
}

/**
 * Which fields may not be left empty, by default.
 *
 * Only the given name in split mode, and only the full name in single-field mode — both named
 * here rather than inferred, so the list is one prop a caller can read and replace. The family
 * name is **not** in it on purpose: see the W3C finding in the component's note above. Requiring it
 * does not produce family names, it produces `.` and `Mr.`
 */
export const DEFAULT_REQUIRED: readonly NameField[] = ["given", "fullName"]

export type NameFieldsOptions = {
  /** The reader's locale, which decides the order. Left out, `HYDRATION_LOCALE`. */
  locale?: string
  /** Pins the order, ignoring `locale`. For a form that already knows its audience. */
  order?: NameOrder
  /** Render a title field (`honorific-prefix`). Off by default. */
  honorific?: boolean
  /** Render a middle-name field (`additional-name`). Off by default. */
  additional?: boolean
  /** Render the phonetic reading fields. Off by default; see the note on tokens above. */
  phonetic?: boolean
  /** The reader said they have one name, so one field replaces the split ones. */
  singleName?: boolean
  /** Which fields may not be empty. Defaults to `DEFAULT_REQUIRED`. */
  required?: readonly NameField[]
  /** Overrides for `FIELD_LABELS`, by field name. */
  labels?: Partial<Record<string, string>>
  /** An autofill section prefix: `"shipping"`, `"billing"`, `"section-<name>"`. */
  autoCompleteSection?: string
}

/** The autofill token each field takes, with the phonetic pair opted out rather than guessed. */
const AUTOCOMPLETE: Record<NameField, string> = {
  honorificPrefix: "honorific-prefix",
  given: "given-name",
  additional: "additional-name",
  surname: "family-name",
  // No token exists, and the nearest one fills the written name into the reading field.
  phoneticSurname: "off",
  phoneticGiven: "off",
  fullName: "name",
}

/** The order the fields are resolved in, with an explicit `order` beating the locale. */
export function resolveOrder(options: NameFieldsOptions = {}): NameOrder {
  return options.order ?? nameOrderFor(options.locale ?? HYDRATION_LOCALE)
}

/**
 * The fields to render, in the order this locale writes them.
 *
 * The middle name sits between the other two in both orders, which is CLDR's own shape: the
 * given-first pattern is `{given} {given2} {surname}` and the surname-first one is
 * `{surname} {given2} {given}`. The phonetic pair follows the written fields as its own row, in
 * the same order, which is how Japanese forms lay it out — 姓 名 above セイ メイ.
 */
export function fieldsFor(options: NameFieldsOptions = {}): NameFieldSpec[] {
  const { honorific = false, additional = false, phonetic = false, singleName = false } = options
  const required = options.required ?? DEFAULT_REQUIRED
  const labels = options.labels
  const section = options.autoCompleteSection?.trim()

  const spec = (field: NameField): NameFieldSpec => {
    const token = AUTOCOMPLETE[field]
    return {
      field,
      label: labels?.[field] ?? FIELD_LABELS[field] ?? field,
      required: required.includes(field),
      // `off` is not an autofill field name and does not take a section prefix — "shipping off" is
      // not a thing the spec defines, and a browser reading it as an unknown token would fall back
      // to its own guess, which is the behaviour the `off` was there to stop.
      autoComplete: section && token !== "off" ? `${section} ${token}` : token,
    }
  }

  const order = resolveOrder(options)
  const prefix: NameField[] = honorific ? ["honorificPrefix"] : []

  if (singleName) return [...prefix, "fullName" as NameField].map(spec)

  const middle: NameField[] = additional ? ["additional"] : []
  const written: NameField[] =
    order === "surnameFirst" ? ["surname", ...middle, "given"] : ["given", ...middle, "surname"]
  const reading: NameField[] = !phonetic
    ? []
    : order === "surnameFirst"
      ? ["phoneticSurname", "phoneticGiven"]
      : ["phoneticGiven", "phoneticSurname"]

  return [...prefix, ...written, ...reading].map(spec)
}

/** Every field, for the helpers that have to touch all of them. */
const NAME_FIELDS: NameField[] = [
  "honorificPrefix",
  "given",
  "additional",
  "surname",
  "phoneticSurname",
  "phoneticGiven",
  "fullName",
]

/** A blank name, ready to put in state. */
export function emptyName(): NameValue {
  return {
    honorificPrefix: "",
    given: "",
    additional: "",
    surname: "",
    phoneticSurname: "",
    phoneticGiven: "",
    fullName: "",
    singleName: false,
  }
}

/** Whether two names agree on every field, so a controlled re-render is not a change. */
function sameName(a: NameValue, b: NameValue): boolean {
  if (a.singleName !== b.singleName) return false
  return NAME_FIELDS.every((field) => (a[field] ?? "") === (b[field] ?? ""))
}

/** Fills in whatever a caller left out, so the internal value always has every field. */
function completeName(partial: Partial<NameValue> | undefined): NameValue {
  return { ...emptyName(), ...partial } as NameValue
}

export type NameMessages = {
  required?: (label: string) => string
}

const DEFAULT_MESSAGES: Required<NameMessages> = {
  required: (label) => `${label} is required`,
}

/**
 * The problems with a name, by field, empty when there are none.
 *
 * Emptiness of the required fields, and nothing else — no character class, no minimum length, no
 * "looks like a placeholder" heuristic. That is not an omission to fill in later: every such rule
 * rejects a real name somewhere, and the reader whose name it rejects is the one who most needs the
 * form to work. Only the fields the current options actually render are checked, so a phonetic
 * field left over from a form that no longer asks for one is not an error.
 *
 * Exported so a submit handler runs exactly what the fields showed on blur rather than a second
 * opinion.
 */
export function validateName(
  value: Partial<NameValue>,
  options: NameFieldsOptions & { messages?: NameMessages } = {}
): Partial<Record<NameField, string>> {
  const name = completeName(value)
  const messages = { ...DEFAULT_MESSAGES, ...options.messages }
  const errors: Partial<Record<NameField, string>> = {}
  for (const spec of fieldsFor({ ...options, singleName: options.singleName ?? name.singleName })) {
    if (!spec.required) continue
    if ((name[spec.field] ?? "").trim() === "") errors[spec.field] = messages.required(spec.label)
  }
  return errors
}

/**
 * The name as one string, assembled in the locale's order.
 *
 * For a confirmation screen, an email, a label — the places a split name has to go back together.
 * Trimming happens here and not in the stored value, which is the difference between presenting a
 * name tidily and editing what someone typed.
 */
export function formatName(value: Partial<NameValue>, options: NameFieldsOptions = {}): string {
  const name = completeName(value)
  const parts = name.singleName
    ? [name.fullName]
    : resolveOrder(options) === "surnameFirst"
      ? [name.surname, name.additional, name.given]
      : [name.given, name.additional, name.surname]
  return [name.honorificPrefix, ...parts]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
}

/** The runtime's own locale, or `null` where there is no `Intl` to ask. */
function runtimeLocale(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale || null
  } catch {
    return null
  }
}

export interface NameInputProps {
  /** The name, when the parent owns it. Every field should be present; missing ones read empty. */
  value?: NameValue
  defaultValue?: Partial<NameValue>
  onChange?: (value: NameValue) => void
  /** The reader's locale, which decides the order. Left out, the runtime's, resolved after mount. */
  locale?: string
  /** Pins the order, ignoring `locale`. */
  order?: NameOrder
  /** Render a title field. Off by default. */
  honorific?: boolean
  /** Render a middle-name field. Off by default. */
  additional?: boolean
  /** Render the phonetic reading fields (セイ／メイ). Off by default. */
  phonetic?: boolean
  /** Offer "I have a single name", which replaces the split fields with one. On by default. */
  allowSingleName?: boolean
  /** Which fields may not be empty. Defaults to `DEFAULT_REQUIRED` — the family name is not in it. */
  required?: readonly NameField[]
  /** Overrides for `FIELD_LABELS`, by field name. */
  labels?: Partial<Record<string, string>>
  messages?: NameMessages
  /** An autofill section prefix: `"shipping"`, `"billing"`, `"section-<name>"`. */
  autoCompleteSection?: string
  /** Show every error at once, not only for fields that have been visited. For submit. */
  showErrors?: boolean
  /** An accessible name for the group of fields. Defaults to "Name". */
  legend?: string
  disabled?: boolean
  /** Prefix for each input's `name`, so the name posts with a plain form. */
  namePrefix?: string
  id?: string
  className?: string
}

/**
 * Renders the reader's name in their locale's own fields and order.
 *
 * The fields are a `role="group"` rather than a `<fieldset>` so the component drops into a form
 * that already has one without nesting legends, and the group carries the accessible name either
 * way. Nothing here is a combobox: a name is free text, and the browser can only autofill a real
 * `<input>`.
 */
export const NameInput = React.forwardRef<HTMLDivElement, NameInputProps>(function NameInput(
  {
    value,
    defaultValue,
    onChange,
    locale,
    order,
    honorific = false,
    additional = false,
    phonetic = false,
    allowSingleName = true,
    required,
    labels,
    messages,
    autoCompleteSection,
    showErrors = false,
    legend,
    disabled = false,
    namePrefix,
    id,
    className,
  },
  forwardedRef
) {
  const isControlled = value !== undefined
  const [fields, setFields] = React.useState<NameValue>(() =>
    completeName(isControlled ? value : defaultValue)
  )
  const [touched, setTouched] = React.useState<Partial<Record<NameField, boolean>>>({})

  const fieldsRef = React.useRef(fields)
  fieldsRef.current = fields

  // Re-seed from the prop only when it disagrees with what is on screen. A parent that rebuilds the
  // object on every render still passes an equal name, and echoing that back would reset the field
  // being typed in; comparing by field rather than by identity is what makes a controlled name
  // typable at all. This registry has shipped that bug once, in date-input.
  React.useEffect(() => {
    if (value === undefined) return
    const next = completeName(value)
    if (!sameName(next, fieldsRef.current)) setFields(next)
  }, [value])

  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])

  // The order is resolved after mount unless the caller pinned it, because the server's locale is
  // the server's: `Intl` on the server and `Intl` in the browser disagree, and an order that
  // disagrees across hydration is not a cosmetic mismatch — React would keep the server's field
  // sequence while the labels came from the client's, which is how a form ends up asking for the
  // family name in the box that posts the given one. Until then the order is HYDRATION_LOCALE's,
  // which is CLDR's own root default.
  const activeLocale = locale ?? (mounted ? (runtimeLocale() ?? HYDRATION_LOCALE) : HYDRATION_LOCALE)

  const reactId = React.useId()
  const base = id ?? reactId
  const fieldId = (field: string) => `${base}-${field}`
  const errorId = (field: string) => `${base}-${field}-error`
  const legendId = `${base}-legend`
  const singleNameId = `${base}-single-name`

  const options = React.useMemo<NameFieldsOptions>(
    () => ({
      locale: activeLocale,
      order,
      honorific,
      additional,
      phonetic,
      singleName: fields.singleName,
      required,
      labels,
      autoCompleteSection,
    }),
    [
      activeLocale,
      order,
      honorific,
      additional,
      phonetic,
      fields.singleName,
      required,
      labels,
      autoCompleteSection,
    ]
  )

  const specs = React.useMemo(() => fieldsFor(options), [options])
  const errors = React.useMemo(
    () => validateName(fields, { ...options, messages }),
    [fields, options, messages]
  )

  // One commit path, and it always writes the local state — the value carries every field, so a
  // half-filled name round-trips through a controlled parent without losing anything.
  function commit(next: NameValue) {
    setFields(next)
    onChange?.(next)
  }

  function setField(field: NameField, next: string) {
    commit({ ...fields, [field]: next })
  }

  /**
   * Switching to one field carries the split fields into it, and switching back leaves them.
   *
   * Nothing is cleared either way. Someone who typed their name into two boxes, found the
   * checkbox, and ticked it should not have to type it again — and someone who ticks it by mistake
   * should get their two boxes back as they left them. The carry only fills an empty full-name
   * field, so it cannot overwrite a name the reader has already corrected here.
   */
  function toggleSingleName(singleName: boolean) {
    const next: NameValue = { ...fields, singleName }
    if (singleName && next.fullName.trim() === "") {
      const assembled = formatName({ ...fields, singleName: false }, { ...options, honorific: false })
      if (assembled !== "") next.fullName = assembled
    }
    setTouched({})
    commit(next)
  }

  return (
    <div
      ref={forwardedRef}
      role="group"
      aria-labelledby={legend ? legendId : undefined}
      aria-label={legend ? undefined : "Name"}
      className={cn("flex flex-col gap-4", className)}
    >
      {legend ? (
        <span id={legendId} className="text-sm font-medium">
          {legend}
        </span>
      ) : null}

      {specs.map((spec) => {
        const message = errors[spec.field]
        const show = Boolean(message) && (showErrors || touched[spec.field] === true)
        return (
          <div key={spec.field} className="flex flex-col gap-1.5">
            <label htmlFor={fieldId(spec.field)} className="text-sm font-medium">
              {spec.label}
              {spec.required ? null : (
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              )}
            </label>
            <input
              id={fieldId(spec.field)}
              name={namePrefix ? `${namePrefix}.${spec.field}` : undefined}
              type="text"
              value={fields[spec.field] ?? ""}
              disabled={disabled}
              autoComplete={spec.autoComplete}
              // Names are not words a dictionary has, and a red underline under every surname
              // teaches the reader that their own name is a mistake.
              spellCheck={false}
              aria-required={spec.required}
              aria-invalid={show ? true : undefined}
              aria-describedby={show ? errorId(spec.field) : undefined}
              onChange={(event) => setField(spec.field, event.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, [spec.field]: true }))}
              className={cn(
                "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                show && "border-destructive focus-visible:ring-destructive"
              )}
            />
            {show ? (
              <p id={errorId(spec.field)} role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ) : null}
          </div>
        )
      })}

      {allowSingleName ? (
        <div className="flex items-center gap-2">
          <input
            id={singleNameId}
            name={namePrefix ? `${namePrefix}.singleName` : undefined}
            type="checkbox"
            checked={fields.singleName}
            disabled={disabled}
            onChange={(event) => toggleSingleName(event.target.checked)}
            className={cn(
              // The same checkbox column-visibility renders, so the two match wherever both appear.
              "size-4 shrink-0 cursor-pointer rounded border-input accent-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          />
          <label htmlFor={singleNameId} className="text-sm text-muted-foreground">
            {labels?.singleName ?? FIELD_LABELS.singleName}
          </label>
        </div>
      ) : null}
    </div>
  )
})
