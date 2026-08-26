"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Codes `Intl` offers that are not money anyone can be paid in.
 *
 * `Intl.supportedValuesOf("currency")` is close to a clean ISO 4217 list — closer than the region
 * list `country-select` had to curate, which happily names the European Union and the world. Only
 * two entries here are not a currency: `XDR`, the IMF's Special Drawing Rights, and `XSU`, the
 * Sucre, both units of account that exist to settle balances between central banks. Neither is a
 * thing to price a subscription in, so neither is offered.
 *
 * Nothing else is excluded, deliberately. Historical codes stay — `SLL`, `ZWL`, `HRK`, `CUC` — and
 * they stay labelled, because the runtime spells the range out for you: `SLL` arrives as "Sierra
 * Leonean Leone (1964—2022)". An invoice written in 2021 is still denominated in the currency it
 * was written in, and a ledger that cannot name it cannot show it. Pass `currencies` when a field
 * should only offer what you actually accept today.
 */
export const NON_TENDER_CURRENCY_CODES = ["XDR", "XSU"] as const

/**
 * The ISO 4217 codes the runtime knows, minus the two above.
 *
 * Read at runtime rather than shipped as a table, and that is a bigger deal for currencies than it
 * would be for countries: currencies get replaced. `ZWG` (Zimbabwean Gold) arrived in 2024, `XCG`
 * (Caribbean guilder) in 2025, `SLE` replaced `SLL` in 2022. A table baked into a component in 2023
 * is missing all three today; the browser's own list is not, because the browser updates it.
 *
 * Reached through a cast so the file compiles against a `lib` of `es2020`, where the API is not yet
 * declared, and guarded so it cannot throw where the API is absent. The API is ES2022 and
 * present in every current runtime, so the guard is belt-and-braces rather than a real scenario —
 * but a picker that throws is worse than one that is empty, and `currencies` is there either way.
 */
function listSupportedCurrencies(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  try {
    const all = supported ? supported.call(Intl, "currency") : []
    return all.filter((code) => !(NON_TENDER_CURRENCY_CODES as readonly string[]).includes(code))
  } catch {
    return []
  }
}

export interface CurrencySelectProps {
  /** Controlled ISO 4217 code, e.g. "JPY". Pair with `onValueChange`. */
  value?: string
  /** Starting code for an uncontrolled field. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen ISO 4217 code. Never called with a display name or a symbol. */
  onValueChange?: (code: string) => void
  /**
   * Language the currency names are shown in (default: the runtime's own). Passing this explicitly
   * is what makes a server-rendered page deterministic — see the note on `mounted` below.
   */
  locale?: string
  /**
   * The codes to offer, in place of everything the runtime knows. Pass the currencies you actually
   * price, bill or pay out in. Codes the runtime cannot name are dropped rather than shown raw.
   */
  currencies?: readonly string[]
  /**
   * Codes pinned above the alphabet, in the order given — the two or three currencies most of your
   * revenue is in. They stay in the main list too, so searching still finds them where a reader
   * expects.
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
   * Show the currency symbol beside the code. On by default, unlike the flags in `country-select`:
   * a symbol is ordinary text that every font covers, and for the ~20 currencies that have a
   * distinct one it is the glyph a reader recognises before they read anything. The name and the
   * code are always shown too, so turning it off costs nothing but the glyph.
   */
  symbols?: boolean
  disabled?: boolean
  /** Lands on the trigger, so a `<label htmlFor>` names the control. */
  id?: string
  className?: string
  /** Give one of these, or an `id` paired with a visible `<label>`. */
  "aria-label"?: string
  "aria-labelledby"?: string
}

/**
 * The currency's name in `locale`, or the code itself when the runtime has no name for it.
 *
 * Exported because the name is needed outside the field too — an invoice header, a plan comparison,
 * a read-only billing row — and going through the same function keeps those spellings identical to
 * the one the user picked from.
 */
export function getCurrencyName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: "currency" }).of(code) ?? code
  } catch {
    // `Intl` throws a RangeError on anything that is not three letters, including "" and "JP".
    return code
  }
}

/**
 * The currency's symbol, or "" when it does not have one distinct from its code.
 *
 * Most currencies do not: of the ~160 the runtime knows, only about twenty format to something
 * other than their own three letters, and those twenty are the ones anyone would recognise — $ € £
 * ¥ ₹ ₩ ₪ ₱ ₫ and the handful of qualified dollars. Returning "" for the rest is the point; the row
 * shows the code there instead of repeating it twice.
 *
 * This uses the default `currencyDisplay`, not `narrowSymbol`, and that choice is load-bearing in a
 * picker. `narrowSymbol` renders AUD, CAD, NZD, SGD, HKD and USD all as a bare "$" — fine beside an
 * amount whose currency you already know, useless in a list whose whole job is telling them apart.
 * The default keeps them qualified: A$, CA$, NZ$, HK$, $.
 */
export function getCurrencySymbol(code: string, locale?: string): string {
  try {
    const symbol = new Intl.NumberFormat(locale, { style: "currency", currency: code })
      .formatToParts(1)
      .find((part) => part.type === "currency")?.value
    return !symbol || symbol === code ? "" : symbol
  } catch {
    return ""
  }
}

/**
 * How many decimal places this currency is written with: 2 for most, 0 for JPY, KRW, VND, ISK and
 * some thirty others, 3 for the Gulf dinars (BHD, JOD, KWD, LYD, OMR, TND).
 *
 * This is the number a hand-rolled currency field gets wrong, because 2 looks like a safe default
 * and is wrong for about a quarter of the list. It matters most at the payment boundary: Stripe,
 * Adyen and PayPal all take an amount in the currency's *minor* unit, so the conversion is
 * `Math.round(amount * 10 ** getCurrencyFractionDigits(code))` — and hardcoding 2 there bills a
 * Japanese customer a hundred times what they agreed to.
 *
 * Feed the chosen code straight to `currency-input`'s `currency` prop and the displayed field gets
 * the same treatment; this export is for the arithmetic on your own side of it.
 */
export function getCurrencyFractionDigits(code: string): number {
  try {
    return (
      new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions()
        .maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/**
 * Folded for searching: lower-cased, stripped of accents, and stripped of everything that is not a
 * letter or a digit.
 *
 * Currency names carry all three problems. Accents, in "Costa Rican Colón" and "Nicaraguan
 * Córdoba". Punctuation, in "São Tomé & Príncipe Dobra" and "Trinidad & Tobago Dollar", where the
 * ampersand sits between two words a person will type with a space or with "and". Spaces, so
 * "swissfranc" and "Swiss Franc" are the same query.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
}

interface CurrencyOption {
  code: string
  /** What the row renders, in the reader's language. */
  name: string
  /** The symbol, or "" when this currency has none distinct from its code. */
  symbol: string
  /** `name`, folded. */
  search: string
  /** The English name, folded — see `matches`. */
  searchEnglish: string
}

/**
 * How well `option` answers `query`, or -1 for no match at all. Higher is better.
 *
 * Four haystacks, because a currency has four names a person might type. The one in front of them
 * ("日本円"), the English one ("Japanese Yen" — typed constantly on non-English sites, because it is
 * what the pricing page and the payment processor say), the code ("JPY", which is what the API
 * takes and therefore what a developer has in their head), and the symbol.
 *
 * The symbol has to be read before folding, because it is the one query that survives folding as
 * nothing at all: `fold("¥")` is "". Without this line, typing a symbol would fold to an empty
 * query and quietly show the entire list, which reads as the filter being broken.
 */
function matches(option: CurrencyOption, query: string, rawQuery: string): number {
  // An exact code is unambiguous and wins outright: "sek" should not bury the Swedish Krona under
  // every currency whose name happens to contain those letters.
  if (rawQuery.length === 3 && option.code.toLowerCase() === rawQuery) return 4
  if (option.symbol && option.symbol.toLowerCase() === rawQuery) return 3
  // Below here every test is on the folded query, and an empty one matches everything — which is
  // exactly wrong once the raw query was something (a symbol) rather than nothing.
  if (!query) return -1
  if (option.search.startsWith(query)) return 2
  if (option.searchEnglish.startsWith(query)) return 1
  if (option.search.includes(query) || option.searchEnglish.includes(query)) return 0
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
 * A currency picker: every ISO 4217 currency the runtime knows, named in the reader's language,
 * sorted the way that language sorts, and searchable by local name, English name, code or symbol.
 *
 * ```tsx
 * const [currency, setCurrency] = React.useState("USD")
 *
 * return (
 *   <>
 *     <Label htmlFor="currency">Currency</Label>
 *     <CurrencySelect
 *       id="currency"
 *       name="currency"
 *       value={currency}
 *       onValueChange={setCurrency}
 *       priority={["USD", "EUR", "GBP"]}
 *     />
 *     <CurrencyInput currency={currency} value={amount} onValueChange={setAmount} />
 *   </>
 * )
 * ```
 *
 * That last pairing is the reason to reach for this rather than a `<select>` of three hardcoded
 * options. The code you get back is what `currency-input` needs to place the symbol and round to
 * the right precision, and what `Intl.NumberFormat` needs everywhere else you print a price — and
 * precision is where hand-written money code breaks, because two decimals is wrong for about a
 * quarter of the world's currencies (see `getCurrencyFractionDigits`).
 *
 * The value is always the ISO 4217 code, never a name or a symbol, so what you store stays stable
 * when the reader's language changes.
 */
export function CurrencySelect({
  value: valueProp,
  defaultValue,
  onValueChange,
  locale,
  currencies,
  priority,
  placeholder = "Select a currency",
  searchPlaceholder = "Search currencies…",
  emptyMessage = "No currency found.",
  name,
  symbols = true,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: CurrencySelectProps) {
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
   *
   * It does one more thing here than it does in `country-select`. The option list is read from the
   * runtime rather than from a table, so the server's list and the browser's could genuinely
   * differ; gating the whole build on this keeps that difference off the server-rendered HTML,
   * where the panel is closed and only the trigger's own label is drawn.
   */
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    setMounted(true)
  }, [])
  const namesReady = mounted || locale !== undefined

  const options = React.useMemo<CurrencyOption[]>(() => {
    if (!namesReady) return []
    const english = (code: string) => getCurrencyName(code, "en")
    const collator = new Intl.Collator(locale)
    return (currencies ?? listSupportedCurrencies())
      .map((code) => {
        const name = getCurrencyName(code, locale)
        return {
          code,
          name,
          symbol: getCurrencySymbol(code, locale),
          search: fold(name),
          searchEnglish: fold(english(code)),
        }
      })
      // A code the runtime cannot name comes back as the code itself. Offering it would put three
      // raw letters in a list of currency names, so it is dropped the way timezone-select drops a
      // zone it cannot format.
      .filter((option) => option.name !== option.code)
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [currencies, locale, namesReady])

  const byCode = React.useMemo(() => {
    const map = new Map<string, CurrencyOption>()
    for (const option of options) map.set(option.code, option)
    return map
  }, [options])

  /** The pinned rows, in the order the caller gave, skipping anything not on offer. */
  const pinned = React.useMemo(() => {
    if (!priority?.length) return []
    return priority.map((code) => byCode.get(code)).filter(Boolean) as CurrencyOption[]
  }, [priority, byCode])

  /**
   * The rows as drawn: pinned block first while the field is unfiltered, then the alphabet. Once
   * there is a query the pinning is dropped — a search result ordered by anything other than how
   * well it matched reads as a bug.
   */
  const rows = React.useMemo(() => {
    const raw = query.trim().toLowerCase()
    const folded = fold(query)
    // Emptiness is decided on the raw query, not the folded one: "¥" folds away to nothing but is
    // very much a search.
    if (!raw) {
      return {
        pinned,
        rest: options,
        all: [...pinned, ...options],
      }
    }
    const scored: Array<{ option: CurrencyOption; score: number }> = []
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
   * What the trigger says. A stored code that is not on offer — a currency dropped from a narrowed
   * `currencies`, or one saved before the list was narrowed — shows as its own name rather than
   * falling back to the placeholder, which would read as "nothing chosen" and quietly lose the
   * answer on the next save. That case is more than hypothetical here: a ledger row written in a
   * currency you have since stopped accepting still has to render.
   */
  const triggerName = !value
    ? placeholder
    : selected
      ? selected.name
      : namesReady
        ? getCurrencyName(value, locale)
        : value
  const triggerSymbol = !value
    ? ""
    : selected
      ? selected.symbol
      : namesReady
        ? getCurrencySymbol(value, locale)
        : ""

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

  function choose(option: CurrencyOption) {
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

  // Start on the chosen currency, so opening a field that already says Japanese Yen lands on it
  // rather than on the top of the alphabet 80 rows above.
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

  // Keep the highlighted row on screen while arrowing through 160 of them. Looked up by id rather
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
  const renderRow = (option: CurrencyOption) => {
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
        <span className="truncate">{option.name}</span>
        {symbols && option.symbol ? (
          // Decoration beside a name and a code that already say which currency this is, and one
          // that a screen reader would otherwise read out as a bare "$".
          <span aria-hidden="true" className="ml-auto shrink-0 text-xs text-muted-foreground">
            {option.symbol}
          </span>
        ) : null}
        <span
          className={cn(
            "shrink-0 font-mono text-xs text-muted-foreground",
            !(symbols && option.symbol) && "ml-auto"
          )}
        >
          {option.code}
        </span>
      </li>
    )
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        // Never "submit": this control lives inside forms, and the browser's default would post
        // the form the moment someone opened the currency list.
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
        {symbols && triggerSymbol ? (
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            {triggerSymbol}
          </span>
        ) : null}
        <span className="truncate">{triggerName}</span>
        {value ? (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{value}</span>
        ) : null}
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
