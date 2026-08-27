"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A starting set of UI languages — the tags a product's `locales/` folder usually holds.
 *
 * This list exists because languages are the one thing `Intl` will not enumerate for you.
 * `Intl.supportedValuesOf` answers for calendars, collations, currencies, numbering systems, time
 * zones and units; ask it for `"language"`, `"locale"`, `"region"` or `"script"` and it throws a
 * RangeError. There is no browser-supplied list to read.
 *
 * That absence is the right shape for this control anyway, and it is what separates this from
 * `country-select` and `currency-select`. A currency field offers every currency in the world
 * because a customer may be paid in any of them. A *UI language* field offers what you have
 * actually translated — which is not the world's ~8,000 languages, it is the seven directories on
 * disk, and you already know their names. So pass `languages`. This default is a demo that renders
 * something sensible on install, not a claim about which languages matter.
 *
 * These are BCP-47 tags, not bare ISO 639 codes, because that is what a locale directory is named
 * and what `Accept-Language` carries: `pt-BR` and `pt-PT` are two shipped translations, and the
 * runtime names both ("Brazilian Portuguese", "European Portuguese"). Use hyphens — `pt_BR`, the
 * POSIX and Java spelling, is not a valid tag and is dropped rather than shown raw.
 */
export const DEFAULT_LANGUAGE_TAGS = [
  "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en", "en-GB", "es", "es-419", "fa", "fi", "fr",
  "fr-CA", "he", "hi", "hr", "hu", "id", "it", "ja", "ko", "ms", "nb", "nl", "pl", "pt-BR", "pt-PT",
  "ro", "ru", "sk", "sr", "sv", "th", "tr", "uk", "vi", "zh-Hans", "zh-Hant",
] as const

/**
 * Scripts written right to left, used only where the runtime will not answer the question itself.
 *
 * Not a list of RTL *languages* — that list is long, it changes, and stopping it at Arabic and
 * Hebrew is precisely what hand-rolled i18n gets wrong. A script is the stable thing, and the
 * runtime will tell you which one a language is written in even when it will not tell you which
 * way that script runs.
 *
 * The ten here are not copied from a Unicode table: every living language `Intl` itself calls
 * right-to-left was asked what script it resolves to, and this is the set that came back. Arabic
 * carries most of them (Persian, Urdu, Pashto, Sorani Kurdish, Sindhi, Uyghur, Kashmiri and twenty
 * more), Hebrew carries Hebrew and Yiddish, and the rest are one language each. Historical scripts
 * are left out on purpose: no product ships a Phoenician translation, and a table nobody can reach
 * is a table nobody maintains.
 */
const RTL_SCRIPTS = new Set([
  "Adlm", "Arab", "Armi", "Hebr", "Mand", "Nkoo", "Rohg", "Samr", "Syrc", "Thaa",
])

/**
 * What `tag` is called in `locale`, or the tag itself when the runtime has no name for it.
 *
 * The runtime names the whole tag, not just its first two letters: `pt-BR` comes back as "Brazilian
 * Portuguese", `zh-Hans` as "Simplified Chinese", `es-419` as "Latin American Spanish", and in
 * Japanese the same call gives「ポルトガル語 (ブラジル)」. That is the default `languageDisplay` of
 * `"dialect"`; the alternative, `"standard"`, would say "Portuguese (Brazil)". Dialect is the right
 * one here because it matches how the row will be read aloud and how the rest of the product refers
 * to that translation.
 */
export function getLanguageName(tag: string, locale?: string): string {
  try {
    return new Intl.DisplayNames(locale, { type: "language" }).of(tag) ?? tag
  } catch {
    // `Intl` throws a RangeError on anything that is not a structurally valid tag — "", "x",
    // "pt_BR" with an underscore, and a tag carrying a `-u-` extension.
    return tag
  }
}

/**
 * The language's name **in itself**: 日本語, Deutsch, العربية, 한국어.
 *
 * This is the one line that makes a language picker work, and the one a hand-written picker gets
 * wrong, because every other picker in a product is drawn in the reader's language and this one
 * cannot be. The person reaching for it is, very often, someone who cannot read the language the
 * page is currently in — that is *why* they are opening it. A list that says "Japanese" is useless
 * to them; a list that says 日本語 is not.
 *
 * The trick is only that the display locale and the subject are the same tag.
 */
export function getLanguageEndonym(tag: string): string {
  return getLanguageName(tag, tag)
}

/**
 * Which way `tag` is written: "rtl" for Arabic, Hebrew, Persian, Urdu, Pashto, Sorani Kurdish,
 * Yiddish, Divehi, Sindhi and Uyghur; "ltr" for everything else, including anything unrecognised.
 *
 * Exported because **this component does not set `dir` on your page and cannot**. It returns a
 * language tag; turning that into a right-to-left document is a decision about the whole tree —
 * `<html dir>`, your layout, your icons, your charts — and it belongs to the code that swaps the
 * translation, not to a `<select>`. Without this line people report "I picked Arabic and nothing
 * flipped", so the line ships next to the picker:
 *
 * ```tsx
 * document.documentElement.lang = tag
 * document.documentElement.dir = getLanguageDirection(tag)
 * ```
 *
 * If you use shadcn/ui's own `direction` item, this is what you feed it: `DirectionProvider` takes
 * a `dir` and hands it to the Radix primitives, but it has no idea which languages are RTL. That
 * gap is exactly the width of this function.
 *
 * Asked of the runtime first (`Intl.Locale.prototype.getTextInfo`, and the earlier `textInfo`
 * accessor where that is what exists), and answered from the language's own script when neither is
 * there. The fallback is not a guess: `new Intl.Locale("ckb").maximize()` resolves to
 * `ckb-Arab-IQ`, and Arab is a right-to-left script. Both paths were checked against each other
 * across the RTL languages named above and agreed on every one.
 */
export function getLanguageDirection(tag: string): "ltr" | "rtl" {
  try {
    const locale = new Intl.Locale(tag) as Intl.Locale & {
      getTextInfo?: () => { direction?: string }
      textInfo?: { direction?: string }
    }
    const direction = locale.getTextInfo?.().direction ?? locale.textInfo?.direction
    if (direction === "rtl" || direction === "ltr") return direction
    return RTL_SCRIPTS.has(locale.maximize().script ?? "") ? "rtl" : "ltr"
  } catch {
    return "ltr"
  }
}

/** The tag's language subtag: "pt" from "pt-BR", "zh" from "cmn-Hans-CN". */
function languageSubtag(tag: string): string {
  try {
    return new Intl.Locale(tag).language
  } catch {
    return tag.split("-")[0]
  }
}

/**
 * Whether the runtime knows what this tag is, and therefore whether it can be offered.
 *
 * Two questions, not one, and the second is the one worth writing down. `country-select` and
 * `currency-select` both decide this with `name !== code`: a code the runtime cannot name comes
 * back as itself, so the comparison catches it. Here that test **passes an unknown language
 * through** the moment it carries a region — `Intl` names "xx-US" as "xx (United States)", which is
 * not equal to "xx-US" and would be drawn as a row. So the language subtag is checked too: "xx" on
 * its own is named "xx", the tag is unknown, and it is dropped.
 *
 * Checked in the reader's language rather than in English, so the rule is "a name this reader can
 * read" and not "a name someone somewhere could read".
 */
function isNameable(tag: string, locale: string | undefined): boolean {
  if (getLanguageEndonym(tag) === tag) return false
  const subtag = languageSubtag(tag)
  return getLanguageName(subtag, locale) !== subtag
}

/**
 * Folded for searching: lower-cased, stripped of accents, and stripped of everything that is not a
 * letter or a digit.
 *
 * Endonyms need all three. Accents, in "čeština", "español" and "Türkçe" — a Czech speaker on a
 * US keyboard types "cestina". Punctuation and spaces, in "português (Brasil)" and "norsk bokmål",
 * where the parenthesis sits between the two words someone would type together. Non-Latin endonyms
 * pass through unchanged, which is what makes typing 日本 find 日本語.
 */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "")
}

interface LanguageOption {
  /** The BCP-47 tag, exactly as the caller wrote it — this is the value that leaves the control. */
  tag: string
  /** The language in itself: 日本語. What the row leads with. */
  endonym: string
  /** The language in the reader's language: "Japanese". "" when it is the same word. */
  translated: string
  /** "rtl" for Arabic, Hebrew and the rest — used to draw the endonym, not to change your page. */
  direction: "ltr" | "rtl"
  /** `endonym`, folded. */
  search: string
  /** `translated`, folded. */
  searchTranslated: string
  /** The English name, folded — see `matches`. */
  searchEnglish: string
  /** The tag, folded: "ptbr". */
  searchTag: string
}

/**
 * How well `option` answers `query`, or -1 for no match at all. Higher is better.
 *
 * Four things a person might type, and they are typed by different people. The endonym, by someone
 * looking for their own language. The name in the page's language, by someone choosing on another
 * person's behalf — support staff setting a customer's locale, an admin filling in a seat. The
 * English name, on every non-English site, because English is what the documentation and the
 * `Accept-Language` header say. And the tag itself, by the developer wiring this up, who has "pt-BR"
 * in their head because it is the name of a directory.
 *
 * The tag is worth two bands. An exact one wins outright — typing "da" should put dansk on top and
 * not bury it under every language whose name contains those letters — and a prefix is what finds
 * both halves of a pair: "pt" brings pt-BR and pt-PT, "zh" brings both Chinese scripts.
 */
function matches(option: LanguageOption, query: string, rawQuery: string): number {
  if (option.tag.toLowerCase() === rawQuery) return 5
  // Everything below is tested against the folded query, and an empty one matches everything —
  // which is wrong once the raw query was something rather than nothing. Folding strips
  // punctuation, so a query of "()" folds to "" while the field plainly has a query in it, and
  // every test below would say yes. The guard has to sit above the first of them, the tag, and not
  // just above the ones on names.
  if (!query) return -1
  if (option.searchTag.startsWith(query)) return 4
  if (option.search.startsWith(query)) return 3
  // The other two names share a band. Whether "the reader's word for it starts with this" should
  // outrank "the English word for it starts with this" has no answer worth encoding — the two
  // readers who type them are different people — and splitting them would be a rule nothing could
  // demonstrate. What does matter is that a name *starting* with the query beats one that merely
  // contains it: typing "man" should find Manx before it finds German and Romanian.
  if (option.searchTranslated.startsWith(query) || option.searchEnglish.startsWith(query)) return 2
  if (
    option.search.includes(query) ||
    option.searchTranslated.includes(query) ||
    option.searchEnglish.includes(query) ||
    option.searchTag.includes(query)
  )
    return 1
  return -1
}

export interface LanguageSelectProps {
  /** Controlled BCP-47 tag, e.g. "pt-BR". Pair with `onValueChange`. */
  value?: string
  /** Starting tag for an uncontrolled field. Ignored once `value` is passed. */
  defaultValue?: string
  /** Called with the chosen tag, exactly as it appears in `languages` — never with a name. */
  onValueChange?: (tag: string) => void
  /**
   * The languages to offer: the translations you actually ship. Defaults to
   * `DEFAULT_LANGUAGE_TAGS`, which is a demo — the whole point of this prop is that your list is
   * `Object.keys(messages)`, not a table someone curated. Tags the runtime cannot name are dropped
   * rather than shown raw.
   */
  languages?: readonly string[]
  /**
   * Language the *secondary* names are shown in (default: the runtime's own). It never affects the
   * endonym, which is always the language naming itself.
   */
  locale?: string
  /**
   * Tags pinned above the rest, in the order given — the two or three languages most of your
   * readers use, or the one you detected from `Accept-Language`. They stay in the main list too, so
   * searching still finds them where a reader expects.
   */
  priority?: readonly string[]
  /** Shown on the trigger while nothing is chosen. */
  placeholder?: string
  /** Shown in the filter box. Also its accessible name. */
  searchPlaceholder?: string
  /** Shown when the filter matches nothing. */
  emptyMessage?: string
  /** When set, a hidden input mirrors the tag so it submits with a native form. */
  name?: string
  /**
   * Show the BCP-47 tag beside each language. On by default: it is the string the developer wiring
   * the form is looking for, it is what tells pt-BR from pt-PT at a glance, and it is the only part
   * of the row that is the same in every language.
   */
  tags?: boolean
  disabled?: boolean
  /** Lands on the trigger, so a `<label htmlFor>` names the control. */
  id?: string
  className?: string
  /** Give one of these, or an `id` paired with a visible `<label>`. */
  "aria-label"?: string
  "aria-labelledby"?: string
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
 * A UI language picker: every language named in itself, tagged, and searchable by its own name, its
 * name in the page's language, its English name or its BCP-47 tag.
 *
 * ```tsx
 * const [language, setLanguage] = React.useState("en")
 *
 * return (
 *   <>
 *     <Label htmlFor="language">Language</Label>
 *     <LanguageSelect
 *       id="language"
 *       name="language"
 *       languages={Object.keys(messages)}
 *       value={language}
 *       onValueChange={(tag) => {
 *         setLanguage(tag)
 *         document.documentElement.lang = tag
 *         document.documentElement.dir = getLanguageDirection(tag)
 *       }}
 *     />
 *   </>
 * )
 * ```
 *
 * Three things in that snippet are the reason to reach for this rather than a `<select>` of
 * hardcoded `<option>`s. The list is your translations, because there is no such thing as a
 * complete list of UI languages — `Intl` will not even enumerate them. Each row says 日本語 rather
 * than "Japanese", because someone who cannot read the current page has to be able to find their
 * way out of it. And `getLanguageDirection` is exported alongside, because the picker deliberately
 * does not touch your document: it hands you a tag, and the two lines that use it are yours.
 *
 * Each row is marked with `lang` and `dir`, so a screen reader pronounces 한국어 with a Korean voice
 * instead of spelling it out in English, and العربية is laid out right to left inside a list that
 * is not.
 */
export function LanguageSelect({
  value: valueProp,
  defaultValue,
  onValueChange,
  languages,
  locale,
  priority,
  placeholder = "Select a language",
  searchPlaceholder = "Search languages…",
  emptyMessage = "No language found.",
  name,
  tags = true,
  disabled = false,
  id,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: LanguageSelectProps) {
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
   * No `mounted` gate here, and that is worth a note because both sibling pickers need one.
   *
   * `country-select` and `currency-select` label their trigger with a name in the reader's
   * language, which they cannot know on a server — so they render the bare code until hydration to
   * avoid a mismatch. This trigger is labelled with the endonym, and `DisplayNames("ja").of("ja")`
   * is 日本語 wherever it runs. The label does not depend on who is reading, so the server can draw
   * the real one and there is nothing to flash. Only the secondary names and the collation depend
   * on the runtime's locale, and both live inside a panel that is closed until someone opens it.
   */
  const options = React.useMemo<LanguageOption[]>(() => {
    const collator = new Intl.Collator(locale)
    const seen = new Set<string>()
    return (languages ?? DEFAULT_LANGUAGE_TAGS)
      .filter((tag) => {
        if (seen.has(tag) || !isNameable(tag, locale)) return false
        seen.add(tag)
        return true
      })
      .map((tag) => {
        const endonym = getLanguageEndonym(tag)
        const reader = getLanguageName(tag, locale)
        const english = getLanguageName(tag, "en")
        return {
          tag,
          endonym,
          // Dropped when it would repeat the endonym, which is the common case for the reader's own
          // language and for every row when the page is in English and the list is English names.
          translated: reader === endonym ? "" : reader,
          direction: getLanguageDirection(tag),
          search: fold(endonym),
          searchTranslated: reader === endonym ? "" : fold(reader),
          searchEnglish: fold(english),
          searchTag: fold(tag),
        }
      })
      // Sorted by what the row actually says. Collating endonyms groups the list by script — the
      // Latin-script languages in one alphabetical run, then Greek, Cyrillic, Hebrew, Arabic, the
      // Indic scripts and CJK — and the reader's own collator decides where their script lands: in
      // an Arabic page العربية sorts to the top, in a Japanese one 日本語 follows the Latin block.
      // Sorting by the *translated* name instead would order the list by words most of these
      // readers cannot read.
      .sort((a, b) => collator.compare(a.endonym, b.endonym))
  }, [languages, locale])

  const byTag = React.useMemo(() => {
    const map = new Map<string, LanguageOption>()
    for (const option of options) map.set(option.tag, option)
    return map
  }, [options])

  /** The pinned rows, in the order the caller gave, skipping anything not on offer. */
  const pinned = React.useMemo(() => {
    if (!priority?.length) return []
    return priority.map((tag) => byTag.get(tag)).filter(Boolean) as LanguageOption[]
  }, [priority, byTag])

  /**
   * The rows as drawn: pinned block first while the field is unfiltered, then the rest. Once there
   * is a query the pinning is dropped — a search result ordered by anything other than how well it
   * matched reads as a bug.
   */
  const rows = React.useMemo(() => {
    const raw = query.trim().toLowerCase()
    const folded = fold(query)
    if (!raw) {
      return { pinned, rest: options, all: [...pinned, ...options] }
    }
    const scored: Array<{ option: LanguageOption; score: number }> = []
    for (const option of options) {
      const score = matches(option, folded, raw)
      if (score >= 0) scored.push({ option, score })
    }
    // Stable within a score band: the collator already ordered `options`, and `sort` is stable, so
    // equally good matches stay in list order instead of shuffling as the query grows.
    scored.sort((a, b) => b.score - a.score)
    const all = scored.map((s) => s.option)
    return { pinned: [], rest: all, all }
  }, [options, pinned, query])

  const selected = value ? byTag.get(value) : undefined

  /**
   * What the trigger says. A stored tag that is not on offer — a language you have since stopped
   * shipping, or one saved before `languages` was narrowed — is still named rather than falling
   * back to the placeholder, which would read as "nothing chosen" and quietly lose the answer on
   * the next save.
   */
  const triggerLabel = !value ? placeholder : (selected?.endonym ?? getLanguageEndonym(value))
  const triggerDirection = selected?.direction ?? (value ? getLanguageDirection(value) : "ltr")

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

  function choose(option: LanguageOption) {
    if (!isControlled) setUncontrolled(option.tag)
    onValueChange?.(option.tag)
    closePanel(true)
  }

  // Focus the filter box when the panel opens.
  React.useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  // Start on the chosen language, so opening a field that already says 日本語 lands on it rather
  // than at the top of the list.
  React.useEffect(() => {
    if (!open || !value) return
    const index = rows.all.findIndex((option) => option.tag === value)
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

  // Keep the highlighted row on screen while arrowing. Looked up by id rather than queried off the
  // list, because `useId` mints ids containing colons and a selector would have to be escaped
  // before it parsed.
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
  const renderRow = (option: LanguageOption) => {
    index += 1
    const rowIndex = index
    const isSelected = option.tag === value
    return (
      <li
        key={`${option.tag}-${rowIndex}`}
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
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          {/* `lang` so a screen reader switches voice for this word rather than reading 한국어 as
              three unknown characters; `dir` so an RTL endonym is laid out correctly inside a list
              that is not. Neither touches the page around the control. */}
          <span lang={option.tag} dir={option.direction} className="truncate">
            {option.endonym}
          </span>
          {option.translated ? (
            <span className="truncate text-xs text-muted-foreground">{option.translated}</span>
          ) : null}
        </span>
        {tags ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{option.tag}</span>
        ) : null}
      </li>
    )
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        // Never "submit": this control lives inside forms, and the browser's default would post the
        // form the moment someone opened the language list.
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
        <span
          lang={value ? value : undefined}
          dir={value ? triggerDirection : undefined}
          className="truncate"
        >
          {triggerLabel}
        </span>
        {value && tags ? (
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
            aria-activedescendant={rows.all.length > 0 ? `${generatedId}-opt-${active}` : undefined}
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
              <li
                role="presentation"
                className="px-2 py-4 text-center text-sm text-muted-foreground"
              >
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
