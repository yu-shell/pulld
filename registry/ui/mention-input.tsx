"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface MentionItem {
  /** Stable identifier handed back to `onMentionSelect` — the thing you actually store. */
  id: string
  /** What the row reads as, and what gets typed in unless `value` says otherwise. */
  label: string
  /**
   * The text inserted after the trigger, when it differs from the label. Reach for it whenever the
   * label has a space in it: `{ label: "Ada Lovelace", value: "ada" }` types `@ada`, which is a
   * token the parser can find again — `@Ada Lovelace` is not.
   */
  value?: string
  /** Second line on the row: a handle, an email, a team. Matched last when filtering. */
  description?: string
  disabled?: boolean
}

export interface MentionQuery {
  trigger: string
  /** What has been typed after the trigger, without it. */
  query: string
  /** Index of the trigger character in the field's value. */
  start: number
  /** The caret — the end of the range a chosen item replaces. */
  end: number
}

export interface FindMentionQueryOptions {
  /** The character that opens the menu. `"@"` for people, `"#"` for issues, `":"` for emoji. */
  trigger?: string
  /** How far back the search runs, which is also the longest query it will report. */
  maxQueryLength?: number
  /** Let a query span spaces (for full names). A newline still ends it. */
  allowSpaces?: boolean
}

type EditableField = HTMLTextAreaElement | HTMLInputElement

// Letters, digits and underscore — the characters a trigger glued to the end of one must not follow.
const WORDISH = /[\p{L}\p{N}_]/u

const NO_ITEMS: never[] = []

// Distinguishes "no query has been reported yet" from "the query is gone"; a real key always holds
// two separators, and the empty string is the closed menu.
const UNREPORTED = "\u0000unreported"

/**
 * Reads the mention being typed at `caret`, or null if there isn't one.
 *
 * Pure, so the two rules that decide whether a menu should be open at all can be tested without a
 * browser: a trigger only counts at a word boundary (otherwise every email address in the box opens
 * the menu), and the query ends at the first space (otherwise one stray `@` turns the rest of the
 * paragraph into a search term).
 */
export function findMentionQuery(
  value: string,
  caret: number,
  { trigger = "@", maxQueryLength = 32, allowSpaces = false }: FindMentionQueryOptions = {}
): MentionQuery | null {
  if (!trigger || caret < 0 || caret > value.length) return null

  // Bounded so a 40 KB comment costs the same as a short one, and so the bound is also the answer to
  // "how long may a query get".
  const floor = Math.max(0, caret - maxQueryLength - trigger.length)
  for (let i = caret - trigger.length; i >= floor; i--) {
    if (value.startsWith(trigger, i)) {
      const before = i > 0 ? value[i - 1] : ""
      // The email test. `name@example.com` has a trigger in it and must never open a menu, so a
      // trigger welded to the end of a word is not a trigger. Neither is the second `@` of `@@`.
      if (before && (WORDISH.test(before) || trigger.includes(before))) return null
      return { trigger, query: value.slice(i + trigger.length, caret), start: i, end: caret }
    }
    const ch = value[i + trigger.length - 1]
    if (ch === undefined) return null
    // A line break always ends the query; a space does unless the caller allows one.
    if (ch === "\n" || ch === "\r") return null
    if (!allowSpaces && /\s/.test(ch)) return null
  }
  return null
}

/** Lower-cases and drops accents, so "jose" finds "José" and "Ångström" answers to "angstrom". */
function fold(text: string): string {
  // NFD splits a letter from its accent; \p{M} is the accent. Nothing downstream removes marks, so
  // this line is doing the work rather than repeating it.
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/**
 * The matcher used when no `filter` is given: accent-insensitive, and ranked so a match at the start
 * of a word beats one buried inside it — "@love" puts Ada Lovelace above Clover. The description is
 * searched too, but last, so an email or a team name still finds someone without swamping the list.
 */
export function defaultMentionFilter<T extends MentionItem>(items: T[], query: string): T[] {
  const q = fold(query.trim())
  if (!q) return items
  const ranked: Array<{ item: T; rank: number; index: number }> = []
  items.forEach((item, index) => {
    const name = fold(`${item.label} ${item.value ?? ""}`)
    const detail = fold(item.description ?? "")
    const rank =
      name.startsWith(q) || name.includes(` ${q}`)
        ? 0
        : name.includes(q)
          ? 1
          : detail.includes(q)
            ? 2
            : -1
    if (rank >= 0) ranked.push({ item, rank, index })
  })
  // Stable within a rank: the order you passed the items in is the order equals come back in.
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index)
  return ranked.map((entry) => entry.item)
}

/**
 * Replaces `[start, end)` with `text` through the browser's own editing pipeline, and returns
 * whether that pipeline was available.
 *
 * This is the part every hand-rolled mention box gets wrong. Writing the new string with `setState`
 * looks identical on screen and quietly empties the undo stack: one Cmd+Z after picking a name wipes
 * the whole comment instead of stepping back over the insert, because as far as the browser is
 * concerned nobody typed anything. `execCommand("insertText")` is deprecated and still the only way
 * to put text into a field as though a person had, so the undo entry exists — and it fires `input`,
 * so React hears about it like any keystroke.
 *
 * The fallback writes through the prototype's value setter rather than the element, because React
 * installs its own `value` property on the node to track changes; assigning to the element updates
 * that tracker as a side effect and the `input` event that follows is discarded as "no change",
 * leaving a controlled field showing text its owner never received.
 */
export function insertMentionText(
  el: EditableField,
  start: number,
  end: number,
  text: string
): boolean {
  el.focus()
  el.setSelectionRange(start, end)
  const doc = el.ownerDocument
  let inserted = false
  try {
    inserted = typeof doc?.execCommand === "function" && doc.execCommand("insertText", false, text)
  } catch {
    inserted = false
  }
  if (inserted) return true

  const next = `${el.value.slice(0, start)}${text}${el.value.slice(end)}`
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set
  if (setter) setter.call(el, next)
  else el.value = next
  const caret = start + text.length
  el.setSelectionRange(caret, caret)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  return false
}

export interface CaretPosition {
  /** Top of the caret's line, in the field's own border-box coordinates. */
  top: number
  left: number
  /** Height of one line — how far below `top` the menu has to start to clear the text. */
  height: number
}

// Everything that moves text around inside the box. Copied onto the mirror so it wraps identically;
// miss one and the measured caret drifts a little further with every line.
const MIRROR_PROPS = [
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size",
  "font-size-adjust",
  "font-family",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "text-align",
  "text-rendering",
  "tab-size",
  "direction",
  "overflow-wrap",
  "word-break",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
]

/**
 * Where the caret is inside a textarea or input, relative to that element's own top-left corner.
 *
 * The browser will not tell you. There is no API for the caret's pixel position in a form field —
 * `selectionStart` is an index into a string, and nothing converts one to the other. So the text up
 * to that index is laid out a second time, in a hidden element wearing the field's font, padding,
 * border, width and wrapping, with a marker span where the caret would be; the marker's offset is
 * the answer. Skip this and the menu has to be pinned to a corner of the field, which is wrong the
 * moment somebody types an `@` on the third line and the suggestions appear next to the first.
 *
 * Returns null off the browser, and wherever the element is not a real node — the server render and
 * the first client pass both have to survive it.
 */
export function measureCaretPosition(el: EditableField, index: number): CaretPosition | null {
  if (typeof window === "undefined" || typeof el?.getBoundingClientRect !== "function") return null
  const doc = el.ownerDocument
  if (!doc?.body) return null

  const style = window.getComputedStyle(el)
  const mirror = doc.createElement("div")
  for (const prop of MIRROR_PROPS) mirror.style.setProperty(prop, style.getPropertyValue(prop))
  // A copied border-width lays out as nothing on its own: a border with no style is not there.
  mirror.style.borderStyle = "solid"
  mirror.style.borderColor = "transparent"
  // getComputedStyle resolves `width` to the content box whichever box-sizing is in force, so the
  // mirror is declared content-box and handed exactly that width, plus the same padding and border.
  // Copying box-sizing instead would shrink the text's column by the padding and rewrap every line.
  mirror.style.boxSizing = "content-box"
  mirror.style.width = style.width
  mirror.style.height = "auto"
  mirror.style.position = "absolute"
  mirror.style.top = "0"
  mirror.style.left = "-9999px"
  mirror.style.visibility = "hidden"
  mirror.style.pointerEvents = "none"
  // A textarea wraps and keeps its spaces; a single-line input does neither.
  mirror.style.whiteSpace = el.tagName === "TEXTAREA" ? "pre-wrap" : "pre"

  try {
    mirror.textContent = el.value.slice(0, index)
    const marker = doc.createElement("span")
    // Something has to sit after a trailing newline or that last line box never exists and the
    // caret is measured one line high. The rest of the text goes in so the marker wraps where the
    // real caret does.
    marker.textContent = el.value.slice(index) || "."
    mirror.appendChild(marker)
    doc.body.appendChild(mirror)

    const fontSize = parseFloat(style.fontSize) || 16
    return {
      // offsetTop and offsetLeft are measured from the padding edge, so the border is added back to
      // land in the field's border-box coordinates — the ones the menu is positioned in. Scroll is
      // subtracted because the field's text moves under a caret that stays where it is.
      top: marker.offsetTop + (parseFloat(style.borderTopWidth) || 0) - el.scrollTop,
      left: marker.offsetLeft + (parseFloat(style.borderLeftWidth) || 0) - el.scrollLeft,
      height: parseFloat(style.lineHeight) || fontSize * 1.5,
    }
  } finally {
    mirror.remove()
  }
}

export interface MentionLabels {
  /** Accessible name for the suggestion list. */
  listbox: string
  loading: string
  empty: string
  /** Spoken once when the menu opens with results — not on every keystroke. */
  results: (count: number) => string
}

export const defaultMentionLabels: MentionLabels = {
  listbox: "Mention suggestions",
  loading: "Loading…",
  empty: "No matches",
  results: (count) => `${count} ${count === 1 ? "suggestion" : "suggestions"}`,
}

export interface UseMentionInputOptions<T extends MentionItem> {
  items: T[]
  trigger?: string
  /** `false` to keep `items` exactly as given (you are filtering on the server). */
  filter?: ((items: T[], query: string) => T[]) | false
  maxItems?: number
  maxQueryLength?: number
  allowSpaces?: boolean
  /** Keeps the menu open with a loading row while your fetch is in flight. */
  loading?: boolean
  /** Keep the menu open on no matches instead of closing it. */
  showEmpty?: boolean
  labels?: Partial<MentionLabels>
  /** Called with the query as it changes, and with null when the menu closes — where async lookups go. */
  onQueryChange?: (query: MentionQuery | null) => void
  onMentionSelect?: (item: T, query: MentionQuery) => void
  /** The text typed in. Defaults to the trigger, the item's value or label, and a trailing space. */
  toInsertText?: (item: T, trigger: string) => string
}

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

function sameQuery(a: MentionQuery | null, b: MentionQuery | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.trigger === b.trigger && a.start === b.start && a.end === b.end && a.query === b.query
}

/**
 * The whole mention behaviour, without any markup — spread `fieldProps` onto a `<textarea>` you own
 * (pulld's autosize-textarea, a react-hook-form field, an `<input>`) and render the list yourself.
 *
 * `fieldProps` takes `onInput` rather than `onChange` precisely so it does not collide with the
 * value plumbing you already have: React fires both for the same keystroke, so your `onChange` stays
 * yours.
 */
export function useMentionInput<T extends MentionItem>({
  items,
  trigger = "@",
  filter,
  maxItems = 8,
  maxQueryLength = 32,
  allowSpaces = false,
  loading = false,
  showEmpty = false,
  labels,
  onQueryChange,
  onMentionSelect,
  toInsertText,
}: UseMentionInputOptions<T>) {
  const fieldRef = React.useRef<EditableField | null>(null)
  const panelRef = React.useRef<HTMLDivElement | null>(null)
  // The trigger position the writer dismissed with Escape, so typing on does not reopen it. -1 is
  // "nothing dismissed": a real position is an index, and never negative.
  const dismissedRef = React.useRef(-1)
  const composingRef = React.useRef(false)

  const [query, setQuery] = React.useState<MentionQuery | null>(null)
  const [active, setActive] = React.useState<{ key: string; index: number }>({ key: "", index: 0 })
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null)
  const [announcement, setAnnouncement] = React.useState("")

  const text = { ...defaultMentionLabels, ...labels }
  const reactId = React.useId()
  const listboxId = `${reactId}-mentions`
  const optionId = React.useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId])

  const setField = React.useCallback((node: EditableField | null) => {
    fieldRef.current = node
  }, [])

  const refresh = React.useCallback(
    (from?: EditableField | null) => {
      const el = from ?? fieldRef.current
      const caret = el?.selectionStart
      let next =
        el && typeof caret === "number"
          ? findMentionQuery(el.value, caret, { trigger, maxQueryLength, allowSpaces })
          : null
      if (!next) dismissedRef.current = -1
      else if (dismissedRef.current === next.start) next = null
      setQuery((prev) => (sameQuery(prev, next) ? prev : next))
    },
    [trigger, maxQueryLength, allowSpaces]
  )

  const shown = React.useMemo(() => {
    if (!query) return NO_ITEMS
    const list = filter === false ? items : (filter ?? defaultMentionFilter)(items, query.query)
    return maxItems > 0 ? list.slice(0, maxItems) : list
  }, [query, items, filter, maxItems])

  const open = query !== null && (shown.length > 0 || loading || showEmpty)

  // Latest-callback refs: the effects below fire on state, not on how often the parent re-renders.
  const queryChangeRef = React.useRef(onQueryChange)
  const selectRef = React.useRef(onMentionSelect)
  React.useEffect(() => {
    queryChangeRef.current = onQueryChange
    selectRef.current = onMentionSelect
  })

  // One string identifies the mention being typed, which is all three of the things that have to be
  // compared: two different `@`s in the same box are different queries even when the text matches.
  const queryKey = query ? `${query.trigger}\u0000${query.start}\u0000${query.query}` : ""

  // Report the query as it changes, but not the emptiness it starts life with: an async consumer
  // would otherwise answer a question nobody asked, on every mount.
  const reportedRef = React.useRef(UNREPORTED)
  React.useEffect(() => {
    if (reportedRef.current === queryKey) return
    const first = reportedRef.current === UNREPORTED
    reportedRef.current = queryKey
    if (!first) queryChangeRef.current?.(query)
  }, [queryKey, query])

  // The highlight belongs to one query rather than to the component, so it is derived rather than
  // reset: a new mention starts at the top instead of at whatever row the last one reached, and a
  // list that shrinks under it pulls it back inside without a second render to correct itself.
  const activeIndex =
    active.key === queryKey ? Math.min(active.index, Math.max(0, shown.length - 1)) : 0
  const setActiveIndex = React.useCallback(
    (index: number) => setActive({ key: queryKey, index }),
    [queryKey]
  )

  const measure = React.useCallback(() => {
    const el = fieldRef.current
    if (!el || !query) return null
    const caret = measureCaretPosition(el, query.start)
    if (!caret) return null
    const panel = panelRef.current
    const panelHeight = panel?.offsetHeight ?? 0
    const panelWidth = panel?.offsetWidth ?? 0
    // A caret scrolled out of a tall field would otherwise drag the menu out of the box with it.
    const caretTop = Math.min(Math.max(caret.top, 0), el.clientHeight)
    const rect = el.getBoundingClientRect()
    const below = window.innerHeight - (rect.top + caretTop + caret.height)
    const above = rect.top + caretTop
    // Flip above the line only when the menu genuinely does not fit below and does fit above —
    // otherwise a field near the bottom of a short page trades one clipped menu for another.
    const flip = panelHeight > 0 && below < panelHeight && above > panelHeight
    const maxLeft = panelWidth > 0 ? Math.max(0, el.clientWidth - panelWidth) : Number.POSITIVE_INFINITY
    return {
      top: el.offsetTop + (flip ? caretTop - panelHeight : caretTop + caret.height),
      left: el.offsetLeft + Math.min(Math.max(caret.left, 0), maxLeft),
    }
  }, [query])

  // Measured before paint, so the menu is never seen at the last mention's position.
  useIsomorphicLayoutEffect(() => {
    const next = open ? measure() : null
    setPosition((prev) =>
      prev === next || (prev && next && prev.top === next.top && prev.left === next.left)
        ? prev
        : next
    )
  }, [open, measure])

  // Scrolling the field moves the text under the caret, and resizing rewraps it. Both move the
  // anchor without changing a thing this component holds in state.
  React.useEffect(() => {
    const el = fieldRef.current
    if (!open || !el || typeof window === "undefined") return
    let frame = 0
    const remeasure = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const next = measure()
        setPosition((prev) =>
          prev === next || (prev && next && prev.top === next.top && prev.left === next.left)
            ? prev
            : next
        )
      })
    }
    el.addEventListener("scroll", remeasure)
    window.addEventListener("resize", remeasure)
    return () => {
      window.cancelAnimationFrame(frame)
      el.removeEventListener("scroll", remeasure)
      window.removeEventListener("resize", remeasure)
    }
  }, [open, measure])

  // Announced on the way in and on the way to empty, never on every keystroke: a live region tied to
  // a count that changes as fast as typing does reads the count out instead of the letters.
  const bandRef = React.useRef("closed")
  const labelsRef = React.useRef(text)
  labelsRef.current = text
  React.useEffect(() => {
    // Keyed to the query rather than to the panel: running out of matches usually closes the menu,
    // and a writer who cannot see it vanish is otherwise told nothing at all about the name they
    // just typed. That silence is the one moment they most need a word.
    const band = query === null
      ? "closed"
      : loading && shown.length === 0
        ? "loading"
        : shown.length === 0
          ? "empty"
          : "results"
    if (band === bandRef.current) return
    bandRef.current = band
    const spoken = labelsRef.current
    setAnnouncement(
      band === "closed"
        ? ""
        : band === "loading"
          ? spoken.loading
          : band === "empty"
            ? spoken.empty
            : spoken.results(shown.length)
    )
  }, [query, loading, shown.length])

  const select = React.useCallback(
    (item: T) => {
      const el = fieldRef.current
      if (!el || !query || item.disabled) return
      const inserted = toInsertText
        ? toInsertText(item, query.trigger)
        : `${query.trigger}${item.value ?? item.label} `
      insertMentionText(el, query.start, query.end, inserted)
      // The default insertion ends in a space, which closes the menu on its own. A custom one might
      // not, and reopening the menu on the name somebody just picked is the wrong answer to that.
      dismissedRef.current = query.start
      setQuery(null)
      selectRef.current?.(item, query)
    },
    [query, toInsertText]
  )

  const dismiss = React.useCallback(() => {
    if (query) dismissedRef.current = query.start
    setQuery(null)
  }, [query])

  const move = React.useCallback(
    (delta: number) => {
      let next = activeIndex
      // Wraps, and steps over rows that cannot be chosen rather than parking the highlight on one.
      for (let step = 0; step < shown.length; step++) {
        next = (next + delta + shown.length) % shown.length
        if (!shown[next]?.disabled) {
          setActiveIndex(next)
          return
        }
      }
    },
    [shown, activeIndex, setActiveIndex]
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.defaultPrevented) return
      // The IME owns these keys while a conversion is open: Enter commits the reading, the arrows
      // walk the candidate window. Taking either turns a Japanese, Chinese or Korean writer's field
      // into one that cannot finish a word — and `keyCode === 229` is the browsers that say so
      // without setting isComposing on the keydown.
      if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      if (!open) return
      const item = shown[activeIndex]
      if (event.key === "ArrowDown") {
        event.preventDefault()
        move(1)
      } else if (event.key === "ArrowUp") {
        event.preventDefault()
        move(-1)
      } else if (event.key === "Escape") {
        event.preventDefault()
        dismiss()
      } else if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        // Shift+Enter is still a new line, and Tab still leaves the field when nothing is highlighted.
        if (!item || item.disabled) return
        event.preventDefault()
        select(item)
      }
    },
    [open, shown, activeIndex, move, dismiss, select]
  )

  const fieldProps = {
    ref: setField,
    role: "combobox" as const,
    "aria-expanded": open,
    "aria-controls": open ? listboxId : undefined,
    "aria-autocomplete": "list" as const,
    "aria-haspopup": "listbox" as const,
    "aria-activedescendant": open && shown.length > 0 ? optionId(activeIndex) : undefined,
    onInput: (event: React.FormEvent<EditableField>) => refresh(event.currentTarget),
    onSelect: (event: React.SyntheticEvent<EditableField>) => refresh(event.currentTarget),
    onClick: (event: React.MouseEvent<EditableField>) => refresh(event.currentTarget),
    onBlur: () => setQuery(null),
    onKeyDown: handleKeyDown,
    onCompositionStart: () => {
      composingRef.current = true
    },
    onCompositionEnd: (event: React.CompositionEvent<EditableField>) => {
      composingRef.current = false
      // The committed reading is only in the value now, so the query is only right now.
      refresh(event.currentTarget)
    },
  }

  const listboxProps = {
    ref: panelRef,
    id: listboxId,
    role: "listbox" as const,
    "aria-label": text.listbox,
    // Pressing an option must not blur the field: the caret is the anchor for the insert.
    onMouseDown: (event: React.MouseEvent) => event.preventDefault(),
  }

  return {
    fieldRef,
    panelRef,
    query,
    open,
    items: shown,
    activeIndex,
    setActiveIndex,
    select,
    dismiss,
    refresh,
    position,
    announcement,
    labels: text,
    listboxId,
    optionId,
    fieldProps,
    listboxProps,
  }
}

export interface MentionInputProps
  extends Omit<React.ComponentPropsWithoutRef<"textarea">, "value" | "defaultValue"> {
  /** The people, issues or emoji that can be mentioned. */
  items: MentionItem[]
  trigger?: string
  filter?: ((items: MentionItem[], query: string) => MentionItem[]) | false
  maxItems?: number
  maxQueryLength?: number
  allowSpaces?: boolean
  loading?: boolean
  showEmpty?: boolean
  labels?: Partial<MentionLabels>
  onQueryChange?: (query: MentionQuery | null) => void
  onMentionSelect?: (item: MentionItem, query: MentionQuery) => void
  toInsertText?: (item: MentionItem, trigger: string) => string
  renderItem?: (item: MentionItem, state: { active: boolean; index: number }) => React.ReactNode
  value?: string
  defaultValue?: string
  /** Class for the wrapper. The field and the menu have their own. */
  className?: string
  textareaClassName?: string
  panelClassName?: string
}

/**
 * A textarea where typing `@` opens a list of people to mention, anchored under the caret rather
 * than under the field. Use it for comment and review boxes, chat and DM composers, issue and task
 * descriptions, AI prompt boxes that can reference a document, and anywhere `#` should pull up
 * issues or `:` emoji instead — the trigger is a prop.
 *
 * Controlled with `value` and `onChange`, or uncontrolled with `defaultValue`; either way the native
 * textarea is what gets rendered, so labels, form libraries and validation keep working. For a field
 * you lay out yourself, `useMentionInput` returns the same behaviour as props to spread.
 */
export const MentionInput = React.forwardRef<HTMLTextAreaElement, MentionInputProps>(
  function MentionInput(
    {
      items,
      trigger = "@",
      filter,
      maxItems,
      maxQueryLength,
      allowSpaces,
      loading,
      showEmpty,
      labels,
      onQueryChange,
      onMentionSelect,
      toInsertText,
      renderItem,
      value,
      defaultValue,
      onChange,
      onInput,
      onSelect,
      onClick,
      onBlur,
      onKeyDown,
      onCompositionStart,
      onCompositionEnd,
      className,
      textareaClassName,
      panelClassName,
      ...props
    },
    forwardedRef
  ) {
    const isControlled = value !== undefined
    const [internal, setInternal] = React.useState(defaultValue ?? "")
    const text = isControlled ? value : internal

    const mention = useMentionInput({
      items,
      trigger,
      filter,
      maxItems,
      maxQueryLength,
      allowSpaces,
      loading,
      showEmpty,
      labels,
      onQueryChange,
      onMentionSelect,
      toInsertText,
    })
    const { fieldProps, listboxProps, open, activeIndex, optionId } = mention
    const { ref: setField, ...fieldAria } = fieldProps
    const { ref: setPanel, ...listboxAria } = listboxProps

    const setRefs = React.useCallback(
      (node: HTMLTextAreaElement | null) => {
        setField(node)
        if (typeof forwardedRef === "function") forwardedRef(node)
        else if (forwardedRef) forwardedRef.current = node
      },
      [setField, forwardedRef]
    )

    // Keep the highlighted row in view while arrowing through a menu taller than its box.
    React.useEffect(() => {
      if (!open) return
      const row = mention.panelRef.current?.children?.[activeIndex] as HTMLElement | undefined
      row?.scrollIntoView?.({ block: "nearest" })
    }, [open, activeIndex, mention.panelRef])

    function handleChange(event: React.ChangeEvent<HTMLTextAreaElement>) {
      if (!isControlled) setInternal(event.target.value)
      onChange?.(event)
    }

    return (
      <div className={cn("relative", className)}>
        <textarea
          {...props}
          {...fieldAria}
          ref={setRefs}
          value={text}
          onChange={handleChange}
          onInput={(event) => {
            onInput?.(event)
            fieldAria.onInput(event)
          }}
          onSelect={(event) => {
            onSelect?.(event)
            fieldAria.onSelect(event)
          }}
          onClick={(event) => {
            onClick?.(event)
            fieldAria.onClick(event)
          }}
          onBlur={(event) => {
            onBlur?.(event)
            fieldAria.onBlur()
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            fieldAria.onKeyDown(event)
          }}
          onCompositionStart={(event) => {
            onCompositionStart?.(event)
            fieldAria.onCompositionStart()
          }}
          onCompositionEnd={(event) => {
            onCompositionEnd?.(event)
            fieldAria.onCompositionEnd(event)
          }}
          className={cn(
            "flex min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            textareaClassName
          )}
        />

        {open && (
          <div
            {...listboxAria}
            ref={setPanel}
            style={mention.position ? { top: mention.position.top, left: mention.position.left } : undefined}
            className={cn(
              "absolute z-50 max-h-56 min-w-[12rem] max-w-[18rem] overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
              // Until the caret has been measured — the server pass, the first paint — the menu sits
              // under the field rather than nowhere.
              !mention.position && "left-0 top-full mt-1",
              panelClassName
            )}
          >
            {mention.items.length === 0 ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                {loading ? mention.labels.loading : mention.labels.empty}
              </div>
            ) : (
              mention.items.map((item, index) => (
                <div
                  key={item.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === activeIndex}
                  aria-disabled={item.disabled || undefined}
                  onClick={() => mention.select(item)}
                  onMouseEnter={() => !item.disabled && mention.setActiveIndex(index)}
                  className={cn(
                    "flex cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm",
                    index === activeIndex && "bg-accent text-accent-foreground",
                    item.disabled && "pointer-events-none opacity-50"
                  )}
                >
                  {renderItem ? (
                    renderItem(item, { active: index === activeIndex, index })
                  ) : (
                    <>
                      <span className="truncate">{item.label}</span>
                      {item.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        <span aria-live="polite" className="sr-only">
          {mention.announcement}
        </span>
      </div>
    )
  }
)
