"use client"

import * as React from "react"

import { Bold, Code, Italic, Link as LinkIcon, List, ListOrdered, Quote, Strikethrough } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Everything the formatting layer needs to know about the field, and nothing about the DOM.
 *
 * `start` and `end` are the field's own `selectionStart` / `selectionEnd`. A textarea always reports
 * them in order, so nothing here sorts them — but anything *writing* a range back has to, because
 * `setSelectionRange(11, 6)` does not select backwards: measured in Chrome 152, it collapses to
 * `(6, 6)` and the text is silently gone from the selection. `selectionDirection` is no help either;
 * it answered `"none"` for a plain forward programmatic set in the same session.
 */
export interface FieldState {
  value: string
  start: number
  end: number
}

/**
 * One replacement, expressed as a range and the text that takes its place.
 *
 * It is an edit rather than a finished string on purpose, and the reason is the undo stack. The
 * write has to go through `document.execCommand("insertText")` to stay undoable (see `writeEdit`),
 * and that command inserts *at the selection* — so the thing it needs is the range to put the
 * selection on and the text to drop in, not the document that should result. `applyEdit` produces
 * the resulting string for anyone who wants it, tests included.
 *
 * `from`/`to` index the old value; `selectionStart`/`selectionEnd` index the new one.
 */
export interface Edit {
  from: number
  to: number
  text: string
  selectionStart: number
  selectionEnd: number
}

/** The string an edit produces. */
export function applyEdit(value: string, edit: Edit): string {
  return value.slice(0, edit.from) + edit.text + value.slice(edit.to)
}

/** Nothing to do — the field is already in the state the action would put it in. */
const noEdit = (state: FieldState): Edit => ({
  from: state.start,
  to: state.start,
  text: "",
  selectionStart: state.start,
  selectionEnd: state.start,
})

const ordered = (state: FieldState) => ({
  start: Math.min(state.start, state.end),
  end: Math.max(state.start, state.end),
})

/**
 * A pair of markers that surround the selection — bold, italic, inline code, strikethrough.
 *
 * `blockBefore`/`blockAfter` replace them when the selection spans lines, which is the one place
 * markdown itself changes shape: three backticks and a newline are a code *block*, and wrapping a
 * four-line function in single backticks produces one long broken inline span rather than the thing
 * the button's icon promised.
 */
export interface WrapSpec {
  kind: "wrap"
  before: string
  after: string
  blockBefore?: string
  blockAfter?: string
}

/**
 * A marker that goes at the head of every line the selection touches — bullets, numbers, quotes.
 *
 * `match` is what recognises one that is already there, and it is a pattern rather than the literal
 * `prefix` because an ordered list's prefix is not a constant: `2. ` has to be recognised by a
 * button whose own prefix is `1. `.
 */
export interface LinePrefixSpec {
  kind: "linePrefix"
  prefix: string
  match: RegExp
  /** Renumber the block from 1 instead of repeating `prefix`. */
  renumber?: boolean
}

/** `[text](url)`, which is neither of the above: two slots, and which one gets the caret varies. */
export interface LinkSpec {
  kind: "link"
}

/**
 * The marker runs that may sit between a selection and the marker being toggled.
 *
 * Longest first, so `**` is read as one token and not as two `*`. This is what lets the bold button
 * find its own markers through a layer of italics — see `markerRun` and `toggleWrap`.
 */
const NESTABLE_MARKERS = ["**", "~~", "__", "*", "_", "`"]
const MARKER_CHAR = /[*_~`]/

/** The maximal run of marker characters on each side of a range. */
function markerRun(value: string, start: number, end: number) {
  let from = start
  while (from > 0 && MARKER_CHAR.test(value[from - 1])) from -= 1
  let to = end
  while (to < value.length && MARKER_CHAR.test(value[to])) to += 1
  return { left: value.slice(from, start), right: value.slice(end, to), leftFrom: from }
}

/** Splits a run of markers into whole tokens, or `null` if it contains something that is not one. */
function tokenizeMarkers(run: string): string[] | null {
  const tokens: string[] = []
  let i = 0
  while (i < run.length) {
    const token = NESTABLE_MARKERS.find((marker) => run.startsWith(marker, i))
    if (!token) return null
    tokens.push(token)
    i += token.length
  }
  return tokens
}

/**
 * Finds `before`/`after` already surrounding the selection, possibly outside other markers.
 *
 * **The adjacent case is not the only one, and treating it as the only one is what produces
 * `**_**bravo**_**`.** Bold a word, italicise it, then press bold again: the bold markers are still
 * there but the italic ones now stand between them and the selection, so a check that looks only at
 * the characters touching the selection concludes there is no bold to remove and adds a second pair
 * *inside* the first. The result is markup no parser and no person can read, produced by pressing a
 * button twice.
 *
 * So the run of marker characters on each side is tokenised and the pairing is required to balance:
 * whatever markers sit between `before` and the selection must appear in mirror order on the other
 * side, with `after` outside them. That requirement is what keeps this from firing on
 * `**bold**text` — where `**` touches the selection on the left and nothing closes it on the right.
 * Markers are their own mirror, so reversing the token order is the whole of it.
 *
 * Returns the outermost match, so bold comes off bold rather than off the italics inside it.
 */
function findSurrounding(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string
): { from: number; to: number; inner: string; close: string } | null {
  if (before.length === 0) return null

  // Touching the selection, checked as plain text. This has to come first and has to be its own
  // branch, because the run below is a run of *marker characters* and a fence is `` ```\n `` — the
  // newline in it belongs to no run, so the loop can never find it however far it looks.
  const openFrom = start - before.length
  const closeTo = end + after.length
  if (
    openFrom >= 0 &&
    closeTo <= value.length &&
    value.slice(openFrom, start) === before &&
    value.slice(end, closeTo) === after
  ) {
    return { from: openFrom, to: closeTo, inner: "", close: "" }
  }

  const run = markerRun(value, start, end)

  for (let i = 0; i + before.length <= run.left.length; i += 1) {
    if (!run.left.startsWith(before, i)) continue
    const inner = run.left.slice(i + before.length)
    const tokens = tokenizeMarkers(inner)
    if (tokens === null) continue
    const close = tokens.reverse().join("")
    if (!run.right.startsWith(close + after)) continue
    return {
      from: run.leftFrom + i,
      to: end + close.length + after.length,
      inner,
      close,
    }
  }
  return null
}

export type ActionSpec = WrapSpec | LinePrefixSpec | LinkSpec

/**
 * Toggles a pair of markers around the selection.
 *
 * **Already-formatted is two different arrangements, and a toggle that tests only one of them
 * doubles the markers instead of removing them.** After this function adds `**`, the selection it
 * hands back covers `bravo` and not `**bravo**` — the highlight should still be on the word the
 * person highlighted — so a second press sees the markers *outside* the selection. But somebody who
 * drags across `**bravo**` by hand has them *inside* it. Both are "this is already bold", so both
 * are checked: inside first, then the characters immediately flanking the selection.
 *
 * An empty selection inserts the pair and puts the caret between them, which is the one case where
 * the caret matters more than the selection: the next thing that happens is typing.
 */
export function toggleWrap(state: FieldState, spec: WrapSpec): Edit {
  const { start, end } = ordered(state)
  const selected = state.value.slice(start, end)
  const multiline = selected.includes("\n")
  const before = multiline && spec.blockBefore !== undefined ? spec.blockBefore : spec.before
  const after = multiline && spec.blockAfter !== undefined ? spec.blockAfter : spec.after

  // Inside the selection.
  if (
    selected.length >= before.length + after.length &&
    selected.startsWith(before) &&
    selected.endsWith(after)
  ) {
    const inner = selected.slice(before.length, selected.length - after.length)
    return {
      from: start,
      to: end,
      text: inner,
      selectionStart: start,
      selectionEnd: start + inner.length,
    }
  }

  // Around the selection, with anything nested in between left where it is.
  const surrounding = findSurrounding(state.value, start, end, before, after)
  if (surrounding) {
    const text = surrounding.inner + selected + surrounding.close
    return {
      from: surrounding.from,
      to: surrounding.to,
      text,
      selectionStart: surrounding.from + surrounding.inner.length,
      selectionEnd: surrounding.from + surrounding.inner.length + selected.length,
    }
  }

  const text = before + selected + after
  return {
    from: start,
    to: end,
    text,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length,
  }
}

/**
 * The whole lines a selection touches.
 *
 * The end is the half that bites. A selection made by dragging down one line and releasing at the
 * left edge of the next ends at that next line's column 0 — it is visibly one line of highlight,
 * and treating the line it merely touches as selected puts a bullet on a line nobody chose. So a
 * selection ending exactly at a line start is measured against the character before it.
 */
export function lineBlock(value: string, start: number, end: number): { from: number; to: number } {
  const from = value.lastIndexOf("\n", start - 1) + 1
  const probe = end > start && value[end - 1] === "\n" ? end - 1 : end
  const newline = value.indexOf("\n", probe)
  return { from, to: newline === -1 ? value.length : newline }
}

/**
 * Toggles a line marker on every line the selection touches.
 *
 * **The mixed case decides what this feels like, and "remove unless every line has it" is the
 * answer that matches what the button looks like.** Selecting four lines where one is already a
 * bullet and pressing the list button should produce four bullets; a per-line toggle produces three
 * bullets and one plain line and makes the button feel broken. So the block comes off only when
 * every line it contains already carries the marker, and otherwise the marker is brought to all of
 * them — one press to normalise, a second to clear.
 *
 * Blank lines are left alone and excluded from that vote. A blank line inside a list is ordinary,
 * and counting it as "not prefixed" would mean a selection containing one could never be cleared.
 *
 * Adding strips the marker first and re-adds it, which is how renumbering falls out for free: a
 * block whose lines read `3.` `7.` `7.` comes back `1.` `2.` `3.`, and for a bullet the strip-then-
 * add is simply idempotent.
 */
export function toggleLinePrefix(state: FieldState, spec: LinePrefixSpec): Edit {
  const { start, end } = ordered(state)
  const block = lineBlock(state.value, start, end)
  const lines = state.value.slice(block.from, block.to).split("\n")

  const content = lines.filter((line) => line.trim() !== "")
  const allPrefixed = content.length > 0 && content.every((line) => spec.match.test(line))

  let counter = 0
  const next = lines.map((line) => {
    if (line.trim() === "") return line
    const bare = line.replace(spec.match, "")
    if (allPrefixed) return bare
    counter += 1
    return (spec.renumber ? `${counter}. ` : spec.prefix) + bare
  })

  const text = next.join("\n")
  const delta = text.length - (block.to - block.from)

  // A caret stays a caret. Selecting the line somebody only put their cursor on would be a
  // surprising answer to pressing a button, and the next thing they do is keep typing.
  if (state.start === state.end) {
    const moved = Math.min(Math.max(start + delta, block.from), block.from + text.length)
    return { from: block.from, to: block.to, text, selectionStart: moved, selectionEnd: moved }
  }

  return {
    from: block.from,
    to: block.to,
    text,
    selectionStart: block.from,
    selectionEnd: block.from + text.length,
  }
}

const LOOKS_LIKE_URL = /^(?:[a-z][a-z0-9+.-]*:|www\.)/i
const WHOLE_LINK = /^\[([^\]]*)\]\(([^()]*)\)$/

/**
 * Wraps the selection in `[text](url)`, putting the caret in whichever slot is still empty.
 *
 * **Which slot that is depends on what was selected, and guessing wrong costs the person the thing
 * they had already done.** Somebody who selected a pasted URL wants it to become the target, with
 * the caret waiting in the label; somebody who selected a few words wants those to be the label,
 * with the caret waiting in the parentheses. Dropping the selection into the label either way means
 * the URL case has to be retyped.
 *
 * No placeholder text goes in the empty slot. `[text](url)` with the literal word `url` selected
 * reads as helpful right up until somebody clicks elsewhere instead of typing, and then it is a
 * broken link in their comment that looks deliberate.
 *
 * A selection that is already a whole link unwraps back to its label, so the button toggles.
 */
export function insertLink(state: FieldState): Edit {
  const { start, end } = ordered(state)
  const selected = state.value.slice(start, end)

  const whole = WHOLE_LINK.exec(selected)
  if (whole) {
    const label = whole[1]
    return {
      from: start,
      to: end,
      text: label,
      selectionStart: start,
      selectionEnd: start + label.length,
    }
  }

  // The label is the empty slot in both of these: a selected URL belongs in the target, and a
  // selection of nothing has no label yet either. The caret goes where the typing has to happen.
  if (selected.length === 0 || LOOKS_LIKE_URL.test(selected)) {
    const text = `[](${selected})`
    return { from: start, to: end, text, selectionStart: start + 1, selectionEnd: start + 1 }
  }

  const text = `[${selected}]()`
  const caret = start + selected.length + 3
  return { from: start, to: end, text, selectionStart: caret, selectionEnd: caret }
}

/** The edit an action would make, or a no-op edit when it has nothing to change. */
export function editFor(state: FieldState, spec: ActionSpec): Edit {
  if (spec.kind === "wrap") return toggleWrap(state, spec)
  if (spec.kind === "linePrefix") return toggleLinePrefix(state, spec)
  if (spec.kind === "link") return insertLink(state)
  return noEdit(state)
}

export type MarkdownActionName =
  | "bold"
  | "italic"
  | "strikethrough"
  | "code"
  | "link"
  | "bulletList"
  | "orderedList"
  | "quote"

export interface MarkdownAction {
  name: string
  /** The button's accessible name, and its tooltip. */
  label: string
  spec: ActionSpec
  icon?: React.ReactNode
  /** A single character combined with the platform's modifier, as in `b` for Mod+B. */
  shortcut?: string
}

/**
 * The eight that earn a place in a comment box, with the markers CommonMark agrees on.
 *
 * `_` for emphasis rather than `*`, because `*italic*` inside `**bold**` produces a run of five
 * asterisks that neither a person nor a lenient parser reads reliably, while `**_both_**` is
 * unambiguous. Underscores are the safer half of a pair that has to nest.
 */
export const MARKDOWN_ACTIONS: Record<MarkdownActionName, MarkdownAction> = {
  bold: {
    name: "bold",
    label: "Bold",
    shortcut: "b",
    icon: <Bold className="size-4" />,
    spec: { kind: "wrap", before: "**", after: "**" },
  },
  italic: {
    name: "italic",
    label: "Italic",
    shortcut: "i",
    icon: <Italic className="size-4" />,
    spec: { kind: "wrap", before: "_", after: "_" },
  },
  strikethrough: {
    name: "strikethrough",
    label: "Strikethrough",
    icon: <Strikethrough className="size-4" />,
    spec: { kind: "wrap", before: "~~", after: "~~" },
  },
  code: {
    name: "code",
    label: "Code",
    shortcut: "e",
    icon: <Code className="size-4" />,
    spec: {
      kind: "wrap",
      before: "`",
      after: "`",
      blockBefore: "```\n",
      blockAfter: "\n```",
    },
  },
  link: {
    name: "link",
    label: "Link",
    shortcut: "k",
    icon: <LinkIcon className="size-4" />,
    spec: { kind: "link" },
  },
  bulletList: {
    name: "bulletList",
    label: "Bulleted list",
    icon: <List className="size-4" />,
    spec: { kind: "linePrefix", prefix: "- ", match: /^[-*+] / },
  },
  orderedList: {
    name: "orderedList",
    label: "Numbered list",
    icon: <ListOrdered className="size-4" />,
    spec: { kind: "linePrefix", prefix: "1. ", match: /^\d+[.)] /, renumber: true },
  },
  quote: {
    name: "quote",
    label: "Quote",
    icon: <Quote className="size-4" />,
    spec: { kind: "linePrefix", prefix: "> ", match: /^> ?/ },
  },
}

const DEFAULT_ACTIONS: readonly MarkdownActionName[] = [
  "bold",
  "italic",
  "code",
  "link",
  "bulletList",
  "orderedList",
  "quote",
]

/**
 * Puts an edit into a real field, keeping it on the browser's own undo stack.
 *
 * **`document.execCommand` is deprecated and it is still the only correct way to do this, which is
 * an uncomfortable thing to ship and worse to work around.** The obvious modern call,
 * `textarea.setRangeText`, writes the value and does not record an undo entry: measured in Chrome
 * 152, a `setRangeText` edit followed by `execCommand("undo")` left the text exactly as the edit had
 * made it — and `undo` *returned `true`*, so the failure cannot even be detected from the return
 * value. The same edit through `execCommand("insertText")` was reverted by the same undo call, in
 * every focus arrangement tried (no blur, a blur before the write, a blur after it), and two
 * consecutive writes came back as two separate undo steps. A multi-line replacement is one step.
 *
 * So `insertText` is tried first and `setRangeText` is the fallback for the day it is removed, with
 * `queryCommandSupported` asked first rather than relying on the return value — Chrome 152 answers
 * `true` to both `queryCommandSupported("insertText")` and `queryCommandEnabled("insertText")`. A
 * field that lands on the fallback still works; it just joins every other implementation in costing
 * the person their undo history.
 *
 * The caveat on all of this: these are `execCommand("undo")` measurements. A real Cmd+Z could not be
 * tested — synthesised key events did not drive the undo stack even for plain typed text — so that
 * is not claimed here beyond what the proxy shows.
 *
 * Returns whether the undo-preserving path was the one taken.
 */
export function writeEdit(field: HTMLTextAreaElement | HTMLInputElement, edit: Edit): boolean {
  field.focus()
  field.setSelectionRange(edit.from, edit.to)

  let undoable = false
  const supported =
    typeof document !== "undefined" &&
    typeof document.queryCommandSupported === "function" &&
    document.queryCommandSupported("insertText")

  if (supported) {
    try {
      undoable = document.execCommand("insertText", false, edit.text)
    } catch {
      undoable = false
    }
  }

  if (!undoable) {
    if (typeof field.setRangeText === "function") {
      field.setRangeText(edit.text, edit.from, edit.to)
    } else {
      field.value = applyEdit(field.value, edit)
    }
    // `setRangeText` does not fire `input`, and a controlled React textarea learns about a change
    // through exactly that event. Without it the component's own value prop snaps the text back on
    // the next render — the edit lands and then visibly undoes itself.
    field.dispatchEvent(new Event("input", { bubbles: true }))
  }

  field.setSelectionRange(edit.selectionStart, edit.selectionEnd)
  return undoable
}

export interface MarkdownToolbarProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /**
   * The field this formats. Point it at your own `<textarea>` — a plain one, shadcn's `Textarea`,
   * or this registry's `autosize-textarea`.
   */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /** Which buttons, in order. Names from `MARKDOWN_ACTIONS`, or whole actions of your own. */
  actions?: readonly (MarkdownActionName | MarkdownAction)[]
  /** Accessible name for the toolbar. */
  label?: string
  /**
   * The field's full text after an edit.
   *
   * A controlled textarea does not need this — every write here goes out as an `input` event, so
   * the field's own `onChange` has already fired with the same string by the time this does. It is
   * for mirroring an uncontrolled field into state, and for the case where the two are wired to
   * different places. Calling both is idempotent.
   */
  onValueChange?: (value: string) => void
  /** Bind Mod+B / Mod+I / Mod+K and friends on the field. Default true. */
  shortcuts?: boolean
  disabled?: boolean
}

const resolve = (action: MarkdownActionName | MarkdownAction): MarkdownAction =>
  typeof action === "string" ? MARKDOWN_ACTIONS[action] : action

/**
 * Whether an element is laid out right-to-left.
 *
 * Read at the moment of the key press rather than cached: `direction` is inherited and can change
 * underneath, and a stale answer sends Right to the left for the rest of the session.
 */
function isRtl(node: Element | null | undefined): boolean {
  if (!node || typeof getComputedStyle !== "function") return false
  return getComputedStyle(node).direction === "rtl"
}

/**
 * A row of formatting buttons for a `<textarea>` — bold, italic, code, link, lists, quote.
 *
 * Put it directly above the field it serves and hand it that field's ref. It renders only the
 * toolbar, so the textarea stays yours: your rows, your placeholder, your validation, your
 * `autosize-textarea` if you want one.
 *
 * ```tsx
 * const ref = React.useRef<HTMLTextAreaElement>(null)
 * const [body, setBody] = React.useState("")
 * return (
 *   <div className="rounded-md border">
 *     <MarkdownToolbar textareaRef={ref} onValueChange={setBody} />
 *     <textarea ref={ref} value={body} onChange={(e) => setBody(e.target.value)} />
 *   </div>
 * )
 * ```
 *
 * **Mousedown is prevented across the whole toolbar, and the usual explanation for that is wrong.**
 * Pressing a button does not cost you the selection: measured in Chrome 152 through a real click on
 * an unguarded button, `selectionStart`/`selectionEnd` were still `6`/`11` over `bravo` at
 * mousedown, at click, and after the write — a textarea's selection belongs to the field and
 * survives it losing focus, and `execCommand` found the field and even handed focus back on its
 * own. What the guard actually removes is a focus round trip: the unguarded click fired
 * `blur` once and `focus` twice on the textarea, the guarded one fired neither. Those events are
 * load-bearing in real forms — save-the-draft, run-validation, close-the-composer all hang off
 * blur — so a toolbar without the guard makes every button press look like the person left the
 * field. That is the claim, and it is smaller and more specific than "the selection is lost".
 *
 * One tab stop for the row with the arrow keys moving inside it, which is the toolbar pattern: eight
 * buttons above a comment box would otherwise be eight stops between the page and the box every
 * keyboard user crosses on the way to typing. The shortcuts are bound on the field rather than on
 * the toolbar, because that is where the person's hands are.
 *
 * **What this is not: a markdown editor.** It writes markers into plain text and never parses, so
 * there is no preview, no syntax highlighting, no round-tripping through an AST, and the toggles
 * read the characters immediately around the selection rather than a document model — nesting that
 * a real parser would resolve is left to the person. That is the trade the atom is for; if you need
 * the other thing you need a different dependency, not this file.
 */
export function MarkdownToolbar({
  textareaRef,
  actions = DEFAULT_ACTIONS,
  label = "Formatting",
  onValueChange,
  shortcuts = true,
  disabled = false,
  className,
  onMouseDown: onMouseDownProp,
  onKeyDown: onKeyDownProp,
  ...props
}: MarkdownToolbarProps) {
  const resolved = React.useMemo(
    () => actions.map(resolve).filter((action): action is MarkdownAction => Boolean(action)),
    [actions]
  )

  const [active, setActive] = React.useState(0)
  const buttonsRef = React.useRef<(HTMLButtonElement | null)[]>([])
  const rowRef = React.useRef<HTMLDivElement | null>(null)

  // Clamped during render rather than in an effect: a shorter `actions` array would otherwise leave
  // the roving tab stop past the end for one commit, and that commit is the one where no button has
  // `tabIndex={0}` and the toolbar cannot be reached by Tab at all.
  const index = resolved.length === 0 ? 0 : Math.min(active, resolved.length - 1)

  const run = React.useCallback(
    (action: MarkdownAction) => {
      const field = textareaRef.current
      if (!field || disabled) return
      const edit = editFor(
        { value: field.value, start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0 },
        action.spec
      )
      writeEdit(field, edit)
      onValueChange?.(field.value)
    },
    [disabled, onValueChange, textareaRef]
  )

  // Bound on the field, not on the toolbar, and through `addEventListener` because the field is not
  // rendered here. Attached in the capture phase so a shortcut is handled before anything the
  // consumer put on the textarea decides to act on the same chord.
  React.useEffect(() => {
    const field = textareaRef.current
    if (!field || !shortcuts || disabled) return

    const byShortcut = new Map(
      resolved
        .filter((action) => action.shortcut)
        .map((action) => [action.shortcut!.toLowerCase(), action])
    )
    if (byShortcut.size === 0) return

    const onKeyDown = (event: KeyboardEvent) => {
      // Either modifier, rather than the platform's own. A page cannot know which keyboard is in
      // front of it, Ctrl+B is what a Windows keyboard on a Mac sends, and neither chord means
      // anything else inside a textarea.
      if (!event.metaKey && !event.ctrlKey) return
      if (event.altKey) return
      const action = byShortcut.get(event.key.toLowerCase())
      if (!action) return
      event.preventDefault()
      run(action)
    }

    field.addEventListener("keydown", onKeyDown, true)
    return () => field.removeEventListener("keydown", onKeyDown, true)
  }, [disabled, resolved, run, shortcuts, textareaRef])

  const focusAt = (next: number) => {
    setActive(next)
    buttonsRef.current[next]?.focus?.()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDownProp?.(event)
    if (event.defaultPrevented || resolved.length === 0) return
    const last = resolved.length - 1
    const step = isRtl(rowRef.current) ? -1 : 1
    const move = (by: number) => {
      event.preventDefault()
      const next = index + by
      focusAt(next < 0 ? last : next > last ? 0 : next)
    }

    switch (event.key) {
      case "ArrowRight":
        move(step)
        break
      case "ArrowLeft":
        move(-step)
        break
      case "Home":
        event.preventDefault()
        focusAt(0)
        break
      case "End":
        event.preventDefault()
        focusAt(last)
        break
    }
  }

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    onMouseDownProp?.(event)
    // See the note on this component: this is about the blur, not about the selection.
    if (!event.defaultPrevented) event.preventDefault()
  }

  if (resolved.length === 0) return null

  return (
    <div
      {...props}
      ref={rowRef}
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      aria-disabled={disabled || undefined}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      className={cn("flex items-center gap-0.5", className)}
    >
      {resolved.map((action, i) => (
        <button
          key={action.name}
          ref={(node) => {
            buttonsRef.current[i] = node
          }}
          type="button"
          // One stop for the row. The buttons that are not it stay reachable with the arrows.
          tabIndex={i === index ? 0 : -1}
          disabled={disabled}
          title={action.label}
          aria-label={action.label}
          aria-keyshortcuts={action.shortcut ? `Meta+${action.shortcut.toUpperCase()}` : undefined}
          onFocus={() => setActive(i)}
          onClick={() => run(action)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50"
        >
          {action.icon ? (
            <span aria-hidden="true" className="inline-flex">
              {action.icon}
            </span>
          ) : (
            <span aria-hidden="true" className="text-xs font-medium">
              {action.label.slice(0, 1)}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
