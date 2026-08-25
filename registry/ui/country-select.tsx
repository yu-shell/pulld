"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Every officially assigned ISO 3166-1 alpha-2 code (249 of them), and nothing else.
 *
 * Codes only, deliberately. The names come from `Intl.DisplayNames`, which every current runtime
 * carries, so this component ships a 249-entry list of two-letter strings rather than a table of
 * 249 country names that would have to be re-translated for every language and re-checked every
 * time a country renames itself.
 *
 * The list is curated rather than generated at runtime because `Intl.DisplayNames` answers for far
 * more than countries: it will happily name `EU` (European Union), `UN` (United Nations), `EZ`
 * (Eurozone), `QO` (Outlying Oceania) and `001` (world). None of those belong in a field that asks
 * where someone lives or where a parcel is going, and the only place to draw that line is here.
 *
 * Territories with no permanent population — `AQ`, `BV`, `HM`, `TF`, `UM`, `GS` — are included
 * because they are officially assigned and some address and customs forms do accept them. Narrow
 * the list with `countries` rather than forking the file.
 */
export const COUNTRY_CODES = [
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ",
  "BA", "BB", "BD", "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS",
  "BT", "BV", "BW", "BY", "BZ", "CA", "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN",
  "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE",
  "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA", "GB", "GD", "GE", "GF",
  "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK", "HM",
  "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM",
  "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC",
  "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK",
  "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA",
  "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ", "OM", "PA", "PE", "PF", "PG",
  "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RU", "RW",
  "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS",
  "ST", "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO",
  "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI",
  "VN", "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
] as const

/**
 * A narrowed alpha-2 code, for callers building their own lists: `const SHIPPING: CountryCode[] =
 * ["US", "CA"]` catches a typo at compile time. The component's own props stay `string`, because a
 * value read back out of a database predates any type and still has to render.
 */
export type CountryCode = (typeof COUNTRY_CODES)[number]

export interface CountrySelectProps {
  /** Controlled ISO 3166-1 alpha-2 code, e.g. "JP". Pair with `onValueChange`. */
  value?: string
  /** Starting code for an uncontrolled field. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen alpha-2 code. Never called with a display name. */
  onValueChange?: (code: string) => void
  /**
   * Language the country names are shown in (default: the runtime's own). Passing this explicitly
   * is what makes a server-rendered page deterministic — see the note on `mounted` below.
   */
  locale?: string
  /**
   * The codes to offer, in place of all 249. Pass the countries you actually ship to, or the ones
   * a licence covers. Codes the runtime cannot name are dropped rather than shown raw.
   */
  countries?: readonly string[]
  /**
   * Codes pinned above the alphabet, in the order given — the two or three countries most of your
   * signups come from. They stay in the main list too, so searching still finds them where a
   * reader expects.
   */
  priority?: readonly string[]
  /** Shown on the trigger while nothing is chosen. */
  placeholder?: string
  /** Shown in the filter box. Also its accessible name. */
  searchPlaceholder?: string
  /** Shown when the filter matches nothing. */
  emptyMessage?: string
  /** When set, a hidden input mirrors the code so it submits with a native form. */
  name?: string
  /**
   * Render the flag emoji beside each name. Off by default: flag glyphs are absent on Windows,
   * where every one of them falls back to the two letters of the code instead — fine as a hint,
   * useless as the only label, which is why the name is always shown as well.
   */
  flags?: boolean
  disabled?: boolean
  /** Lands on the trigger, so a `<label htmlFor>` names the control. */
  id?: string
  className?: string
  /** Give one of these, or an `id` paired with a visible `<label>`. */
  "aria-label"?: string
  "aria-labelledby"?: string
}

/**
 * The country's name in `locale`, or the code itself when the runtime has no name for it.
 *
 * Exported because the name is needed outside the field too — an order summary, a confirmation
 * email, a read-only profile row — and going through the same function keeps those spellings
 * identical to the one the user picked from.
 */
export function getCountryName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: "region" }).of(code) ?? code
  } catch {
    return code
  }
}

/** The flag emoji for an alpha-2 code, built from the two regional indicator symbols. */
export function getCountryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return ""
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  )
}

/**
 * Folded for searching: lower-cased, stripped of accents, and stripped of everything that is not a
 * letter or a digit.
 *
 * All three matter for countries specifically. Accents, because nobody types the circumflex in
 * "Côte d'Ivoire" and few keyboards make it easy. Punctuation, because that same name holds a
 * typographic apostrophe (U+2019) that no keyboard produces at all — searching "cote divoire" has
 * to reach it. Spaces, because "unitedstates" and "United States" should be the same query.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
}

interface CountryOption {
  code: string
  /** What the row renders, in the reader's language. */
  name: string
  /** `name`, folded. */
  search: string
  /** The English name, folded — see `matches`. */
  searchEnglish: string
}

/**
 * How well `option` answers `query`, or -1 for no match at all. Higher is better.
 *
 * Three haystacks, because a country has three names a person might type. The one in front of them
 * ("日本"), the English one ("Japan" — typed constantly on non-English sites, because it is what
 * the passport and the shipping label say), and the code itself ("JP"). A picker that searches only
 * the rendered label fails a Japanese user typing "japan" and fails everyone typing the code.
 */
function matches(option: CountryOption, query: string, rawQuery: string): number {
  // An exact code is unambiguous and wins outright: "in" should not bury India under Indonesia.
  if (rawQuery.length === 2 && option.code.toLowerCase() === rawQuery) return 4
  if (option.search.startsWith(query)) return 3
  if (option.searchEnglish.startsWith(query)) return 2
  if (option.search.includes(query) || option.searchEnglish.includes(query)) return 1
  return -1
}

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    className={cn(
      "pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-transform",
      open && "rotate-180"
    )}
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
)

const CheckIcon = () => (
  <svg
    className="h-4 w-4"
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
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

/**
 * A country picker: all 249 ISO countries, named in the reader's language, sorted the way that
 * language sorts, and searchable by local name, English name or code.
 *
 * ```tsx
 * const [country, setCountry] = React.useState("")
 *
 * return (
 *   <>
 *     <Label htmlFor="country">Country</Label>
 *     <CountrySelect
 *       id="country"
 *       name="country"
 *       value={country}
 *       onValueChange={setCountry}
 *       priority={["US", "GB", "CA"]}
 *       placeholder="Select a country"
 *     />
 *   </>
 * )
 * ```
 *
 * Two things here are easy to get wrong by hand and are the reason this is a component rather than
 * a `<select>` with 249 hard-coded options. Sorting goes through `Intl.Collator`, because a plain
 * `sort()` orders by code point and drops every country whose name starts with an accent — Åland
 * Islands, Österreich — below Zimbabwe, at the very bottom where nobody scrolls. And the filter
 * reads three names per country, so a Japanese page still finds 日本 when someone types "japan".
 *
 * The value is always the alpha-2 code, never a display name, so what you store stays stable when
 * the reader's language changes or a country is renamed upstream.
 */
export function CountrySelect({
  value: valueProp,
  defaultValue,
  onValueChange,
  locale,
  countries,
  priority,
  placeholder = "Select a country",
  searchPlaceholder = "Search countries…",
  emptyMessage = "No country found.",
  name,
  flags = false,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: CountrySelectProps) {
  const isControlled = valueProp !== undefined
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? "")
  const value = isControlled ? valueProp : uncontrolled

  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)

  const generatedId = React.useId()
  const triggerId = id ?? generatedId
  const listboxId = `${generatedId}-listbox`
  const rootRef = React.useRef<HTMLDivElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  /**
   * Names are resolved after mount unless the caller pinned the language, and only then.
   *
   * `Intl.DisplayNames(undefined)` reads the runtime's own locale, and the server's locale is the
   * server's — a page rendered in en-US on the server and read in ja-JP hydrates with a different
   * word in the trigger, which is the classic mismatch. Passing `locale` removes the disagreement,
   * so that case renders the real name on the first pass and never flashes. Left to the runtime,
   * the trigger shows the code until hydration: present, correct, submittable, just terser.
   */
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])
  const namesReady = mounted || locale !== undefined

  const options = React.useMemo<CountryOption[]>(() => {
    if (!namesReady) return []
    const english = (code: string) => getCountryName(code, "en")
    const collator = new Intl.Collator(locale)
    return (countries ?? COUNTRY_CODES)
      .map((code) => {
        const name = getCountryName(code, locale)
        return {
          code,
          name,
          search: fold(name),
          searchEnglish: fold(english(code)),
        }
      })
      // A code the runtime cannot name comes back as the code itself. Offering it would put two
      // raw letters in a list of country names, so it is dropped the way timezone-select drops a
      // zone it cannot format.
      .filter((option) => option.name !== option.code)
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [countries, locale, namesReady])

  const byCode = React.useMemo(() => {
    const map = new Map<string, CountryOption>()
    for (const option of options) map.set(option.code, option)
    return map
  }, [options])

  /** The pinned rows, in the order the caller gave, skipping anything not on offer. */
  const pinned = React.useMemo(() => {
    if (!priority?.length) return []
    return priority.map((code) => byCode.get(code)).filter(Boolean) as CountryOption[]
  }, [priority, byCode])

  /**
   * The rows as drawn: pinned block first while the field is unfiltered, then the alphabet. Once
   * there is a query the pinning is dropped — a search result ordered by anything other than how
   * well it matched reads as a bug.
   */
  const rows = React.useMemo(() => {
    const raw = query.trim().toLowerCase()
    const folded = fold(query)
    if (!folded) {
      return {
        pinned,
        rest: options,
        all: [...pinned, ...options],
      }
    }
    const scored: Array<{ option: CountryOption; score: number }> = []
    for (const option of options) {
      const score = matches(option, folded, raw)
      if (score >= 0) scored.push({ option, score })
    }
    // Stable within a score band: the collator already ordered `options`, and `sort` is stable, so
    // equally good matches stay alphabetical instead of shuffling as the query grows.
    scored.sort((a, b) => b.score - a.score)
    const all = scored.map((s) => s.option)
    return { pinned: [], rest: all, all }
  }, [options, pinned, query])

  const selected = value ? byCode.get(value) : undefined

  /**
   * What the trigger says. A stored code that is not on offer — a country dropped from a narrowed
   * `countries`, or one saved before the list was narrowed — shows as its own name rather than
   * falling back to the placeholder, which would read as "nothing chosen" and quietly lose the
   * answer on the next save.
   */
  const triggerLabel = !value
    ? placeholder
    : selected
      ? selected.name
      : namesReady
        ? getCountryName(value, locale)
        : value

  const openPanel = React.useCallback(() => {
    if (disabled) return
    setOpen(true)
    setQuery("")
    setActive(0)
  }, [disabled])

  const closePanel = React.useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  function choose(option: CountryOption) {
    if (!isControlled) setUncontrolled(option.code)
    onValueChange?.(option.code)
    closePanel(true)
  }

  // Focus the filter box when the panel opens.
  React.useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // Start on the chosen country, so opening a field that already says Japan lands on Japan rather
  // than on Afghanistan 100 rows above it.
  React.useEffect(() => {
    if (!open || !value) return
    const index = rows.all.findIndex((option) => option.code === value)
    if (index >= 0) setActive(index)
    // Only when the panel opens: re-running this as the query changes would drag the highlight
    // back to the selected row after every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close on an outside pointer press (capture, so it beats focus moves).
  React.useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closePanel(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [open, closePanel])

  // Clamp the highlight when the filter shrinks the list under it.
  React.useEffect(() => {
    setActive((current) => Math.min(current, Math.max(0, rows.all.length - 1)))
  }, [rows.all.length])

  // Keep the highlighted row on screen while arrowing through 249 of them. Looked up by id rather
  // than queried off the list, because `useId` mints ids containing colons and a selector would
  // have to be escaped before it parsed.
  React.useEffect(() => {
    if (!open) return
    document.getElementById(`${generatedId}-opt-${active}`)?.scrollIntoView({ block: "nearest" })
  }, [active, open, generatedId])

  function handleTriggerKeyDown(event: React.KeyboardEvent) {
    if (disabled) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      openPanel()
    }
  }

  function handlePanelKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        setActive((a) => Math.max(0, Math.min(a + 1, rows.all.length - 1)))
        break
      case "ArrowUp":
        event.preventDefault()
        setActive((a) => Math.max(a - 1, 0))
        break
      case "Home":
        event.preventDefault()
        setActive(0)
        break
      case "End":
        event.preventDefault()
        setActive(Math.max(0, rows.all.length - 1))
        break
      case "Enter": {
        event.preventDefault()
        const option = rows.all[active]
        if (option) choose(option)
        break
      }
      case "Escape":
        event.preventDefault()
        closePanel(true)
        break
      case "Tab":
        closePanel(false)
        break
    }
  }

  let index = -1
  const renderRow = (option: CountryOption) => {
    index += 1
    const rowIndex = index
    const isSelected = option.code === value
    return (
      <li
        key={`${option.code}-${rowIndex}`}
        id={`${generatedId}-opt-${rowIndex}`}
        role="option"
        aria-selected={isSelected}
        onPointerMove={() => setActive(rowIndex)}
        // Keep focus in the filter box so the arrow keys still work after a click.
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => choose(option)}
        className={cn(
          "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
          rowIndex === active && "bg-accent text-accent-foreground"
        )}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          {isSelected ? <CheckIcon /> : null}
        </span>
        {flags ? (
          <span aria-hidden="true" className="text-base leading-none">
            {getCountryFlag(option.code)}
          </span>
        ) : null}
        <span className="truncate">{option.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">{option.code}</span>
      </li>
    )
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        // Never "submit": this control lives inside forms, and the browser's default would post
        // the form the moment someone opened the country list.
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        disabled={disabled}
        onClick={() => (open ? closePanel(false) : openPanel())}
        onKeyDown={handleTriggerKeyDown}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent py-1 pl-3 pr-8 text-left text-sm shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          !value && "text-muted-foreground"
        )}
      >
        {flags && value ? (
          <span aria-hidden="true" className="text-base leading-none">
            {getCountryFlag(value)}
          </span>
        ) : null}
        <span className="truncate">{triggerLabel}</span>
        <ChevronIcon open={open} />
      </button>

      {open ? (
        <div
          onKeyDown={handlePanelKeyDown}
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
            autoComplete="off"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listboxId}
            aria-activedescendant={
              rows.all.length > 0 ? `${generatedId}-opt-${active}` : undefined
            }
            className="w-full border-b bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
          />
          <ul
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel ?? placeholder}
            tabIndex={-1}
            className="max-h-60 overflow-y-auto p-1 focus-visible:outline-none"
          >
            {rows.all.length === 0 ? (
              // Not an option, so it stays out of the listbox's owned children.
              <li role="presentation" className="px-2 py-4 text-center text-sm text-muted-foreground">
                {emptyMessage}
              </li>
            ) : null}
            {rows.pinned.length > 0 ? (
              <>
                {rows.pinned.map(renderRow)}
                <li role="presentation" className="my-1 border-t" />
              </>
            ) : null}
            {rows.rest.map(renderRow)}
          </ul>
        </div>
      ) : null}

      {name ? <input type="hidden" name={name} value={value} /> : null}
    </div>
  )
}
