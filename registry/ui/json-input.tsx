"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Where a document stops being valid JSON, and what is wrong there.
 *
 * `offset` is a character index into the text, so it can be handed straight to
 * `setSelectionRange` to put the caret on the problem. All three positions are nullable
 * for one case only: the runtime rejected the text and this file's own scanner could not
 * say where (see `parseJsonInput`). A null position means "no location to jump to" and is
 * never a guess — a caret sent to the wrong character is worse than one that stays put.
 */
export interface JsonError {
  message: string
  offset: number | null
  /** 1-based. */
  line: number | null
  /** 1-based, counted in characters from the start of the line. */
  column: number | null
}

export type JsonParseResult =
  | { valid: true; value: unknown; error: null }
  | { valid: false; value: undefined; error: JsonError }

type ScanResult = { ok: true } | { ok: false; offset: number; message: string }

const END = "Unexpected end of input"

/**
 * Validates JSON text and reports the offset of the first thing that is wrong.
 *
 * This exists because **the browser cannot tell you where the error is.** `JSON.parse`
 * throws a `SyntaxError` carrying nothing but `message` and `stack` — there is no
 * `position` property on it in any engine — and the message itself is not a stable
 * interface. V8 writes "Expected ',' or ']' after array element in JSON at position 5
 * (line 1 column 6)" for some inputs but "Unexpected token ']', \"[1,2,]\" is not valid
 * JSON" for others, with no position at all in the second form; Firefox writes "at line 1
 * column 6 of the JSON data"; JavaScriptCore writes "JSON Parse error: Expected ']'" and
 * never includes a position. So a component that scrapes the message gets no location on
 * Safari, and no location on Chrome either for a whole class of errors — including the
 * trailing comma, which is the single most common mistake someone makes editing JSON by
 * hand.
 *
 * The grammar is RFC 8259 and it is small enough to walk directly, which is what this
 * does: one pass, no allocation per token, an explicit stack rather than recursion so a
 * deeply nested document cannot overflow it. Messages are written here rather than
 * quoted from the engine, so the same mistake reads the same way in every browser.
 *
 * **`JSON.parse` stays the authority on whether text is valid** — this scanner is only
 * ever consulted to locate a failure that has already happened (see `parseJsonInput`).
 * That is deliberate: a bug here can then cost a worse error message, but it can never
 * make the component reject a document the runtime would have accepted.
 */
export function scanJson(text: string): ScanResult {
  const n = text.length
  let i = 0

  const fail = (offset: number, message: string): ScanResult => ({
    ok: false,
    offset: Math.min(offset, n),
    message,
  })

  // The four characters JSON counts as whitespace. Deliberately not `\s`, which also
  // matches a non-breaking space, a form feed and a vertical tab — none of which
  // `JSON.parse` allows between tokens, so accepting them here would make the scanner
  // disagree with the runtime about perfectly ordinary pasted-from-a-word-processor text.
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++
      else break
    }
  }

  const isDigit = (at: number) => {
    const c = text.charCodeAt(at)
    return c >= 0x30 && c <= 0x39
  }

  const scanString = (): ScanResult => {
    i++ // the opening quote, already checked by the caller
    for (;;) {
      if (i >= n) return fail(n, "Unterminated string — the closing quote is missing")
      const c = text.charCodeAt(i)
      if (c === 0x22) {
        i++
        return { ok: true }
      }
      if (c === 0x5c) {
        const escapeAt = i
        i++
        if (i >= n) return fail(n, "Unterminated string — the closing quote is missing")
        const e = text[i]
        if (e === "u") {
          i++
          for (let k = 0; k < 4; k++) {
            if (i >= n) return fail(n, "Unterminated string — the closing quote is missing")
            if (!/[0-9a-fA-F]/.test(text[i]))
              return fail(i, "A \\u escape needs exactly four hex digits")
            i++
          }
          continue
        }
        if ('"\\/bfnrt'.includes(e)) {
          i++
          continue
        }
        return fail(escapeAt, `Unknown escape \\${e} — valid ones are \\" \\\\ \\/ \\b \\f \\n \\r \\t \\uXXXX`)
      }
      // A raw newline, tab or other control character inside a string is the mistake
      // behind most "it worked in my editor" reports: the text looks fine and JSON.parse
      // refuses it, because JSON requires these to be escaped.
      if (c < 0x20)
        return fail(i, "Control characters must be escaped inside a string (use \\n, \\t, \\uXXXX)")
      i++
    }
  }

  const scanNumber = (): ScanResult => {
    if (text[i] === "-") i++
    if (i >= n || !isDigit(i)) return fail(i, "Expected a digit")
    // A leading zero cannot be followed by more digits: 01 is not a JSON number. Accepting
    // it here would be the scanner's own invention, not something the runtime allows.
    if (text[i] === "0") i++
    else while (i < n && isDigit(i)) i++
    if (i < n && text[i] === ".") {
      i++
      if (i >= n || !isDigit(i)) return fail(i, "Expected a digit after the decimal point")
      while (i < n && isDigit(i)) i++
    }
    if (i < n && (text[i] === "e" || text[i] === "E")) {
      i++
      if (i < n && (text[i] === "+" || text[i] === "-")) i++
      if (i >= n || !isDigit(i)) return fail(i, "Expected a digit in the exponent")
      while (i < n && isDigit(i)) i++
    }
    return { ok: true }
  }

  const scanScalar = (): ScanResult => {
    const c = text[i]
    if (c === '"') return scanString()
    if (c === "-" || isDigit(i)) return scanNumber()
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length
        return { ok: true }
      }
    }
    return fail(i, "Expected a value — an object, array, string, number, true, false or null")
  }

  // The walk is a small state machine over an explicit stack of the containers currently
  // open. Recursion would read more directly but would also turn a pathologically nested
  // document into a crash, and this runs on whatever someone pastes in.
  const stack: Array<"object" | "array"> = []
  let mode: "value" | "objectKeyOrEnd" | "objectKey" | "arrayValueOrEnd" | "afterValue" = "value"

  for (;;) {
    if (mode === "value") {
      ws()
      if (i >= n) return fail(n, END)
      if (text[i] === "{") {
        i++
        stack.push("object")
        mode = "objectKeyOrEnd"
        continue
      }
      if (text[i] === "[") {
        i++
        stack.push("array")
        mode = "arrayValueOrEnd"
        continue
      }
      const scalar = scanScalar()
      if (!scalar.ok) return scalar
      mode = "afterValue"
      continue
    }

    if (mode === "objectKeyOrEnd") {
      ws()
      if (i >= n) return fail(n, END)
      if (text[i] === "}") {
        i++
        stack.pop()
        mode = "afterValue"
        continue
      }
      mode = "objectKey"
      continue
    }

    if (mode === "objectKey") {
      ws()
      if (i >= n) return fail(n, END)
      // Reached after a comma as well as after `{`, so this is also where `{"a":1,}` and
      // an unquoted key land — the two mistakes a hand-edited config file always has.
      if (text[i] !== '"')
        return fail(i, 'Expected a double-quoted property name — JSON keys are always in quotes')
      const key = scanString()
      if (!key.ok) return key
      ws()
      if (i >= n) return fail(n, END)
      if (text[i] !== ":") return fail(i, "Expected ':' after the property name")
      i++
      mode = "value"
      continue
    }

    if (mode === "arrayValueOrEnd") {
      ws()
      if (i >= n) return fail(n, END)
      if (text[i] === "]") {
        i++
        stack.pop()
        mode = "afterValue"
        continue
      }
      mode = "value"
      continue
    }

    // mode === "afterValue"
    if (stack.length === 0) break
    ws()
    if (i >= n) return fail(n, END)
    const open = stack[stack.length - 1]
    const c = text[i]
    if (c === ",") {
      i++
      // After a comma an object owes a key and an array owes a value, which is how the
      // trailing comma is caught at the character that follows it rather than at the
      // comma itself: `[1,2,]` fails on the `]`, where the missing value should have been.
      mode = open === "object" ? "objectKey" : "value"
      continue
    }
    if (open === "object" && c === "}") {
      i++
      stack.pop()
      mode = "afterValue"
      continue
    }
    if (open === "array" && c === "]") {
      i++
      stack.pop()
      mode = "afterValue"
      continue
    }
    return fail(i, open === "object" ? "Expected ',' or '}'" : "Expected ',' or ']'")
  }

  ws()
  // A second value after the first is its own mistake, and a common one: two objects
  // pasted one after the other, or NDJSON dropped into a field that wants one document.
  if (i < n) return fail(i, "Unexpected text after the end of the value")
  return { ok: true }
}

/** 1-based line and column for a character offset. */
function lineColumn(text: string, offset: number | null): { line: number | null; column: number | null } {
  if (offset === null) return { line: null, column: null }
  const upto = text.slice(0, offset)
  const lastBreak = upto.lastIndexOf("\n")
  return { line: upto.split("\n").length, column: offset - lastBreak }
}

/**
 * Last-resort position recovery from an engine's own message, used only when the scanner
 * above found nothing to complain about but the runtime still refused the text. Both
 * known shapes are tried; anything else yields null rather than a guess.
 */
function offsetFromMessage(message: string, text: string): number | null {
  const byPosition = /at position (\d+)/.exec(message)
  if (byPosition) return Math.min(Number(byPosition[1]), text.length)
  const byLine = /at line (\d+) column (\d+)/.exec(message)
  if (byLine) {
    const line = Number(byLine[1])
    const column = Number(byLine[2])
    const lines = text.split("\n")
    if (line < 1 || line > lines.length) return null
    let offset = 0
    for (let k = 0; k < line - 1; k++) offset += lines[k].length + 1
    return Math.min(offset + column - 1, text.length)
  }
  return null
}

/**
 * Parses JSON text into a value, or into an error that knows where it is.
 *
 * `JSON.parse` decides validity, because its answer is the one the caller will live with:
 * whatever this says is valid is exactly what parses at runtime. The scanner is consulted
 * only to locate a failure, and only after one has occurred. If the two ever disagree —
 * the runtime refuses text the scanner is happy with, which is also what a `RangeError`
 * from a document nested thousands of levels deep looks like — the runtime's own message
 * is reported, with a position only if it happens to carry one.
 *
 * Exported as a pure function because the same answer is wanted outside React: a route
 * handler checking what arrived, a CLI validating a config file, a test asserting on a
 * fixture.
 */
export function parseJsonInput(text: string): JsonParseResult {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    const scan = scanJson(text)
    if (!scan.ok) {
      return {
        valid: false,
        value: undefined,
        error: { message: scan.message, offset: scan.offset, ...lineColumn(text, scan.offset) },
      }
    }
    const message = cause instanceof Error ? cause.message : String(cause)
    const offset = offsetFromMessage(message, text)
    return {
      valid: false,
      value: undefined,
      error: { message, offset, ...lineColumn(text, offset) },
    }
  }
  return { valid: true, value, error: null }
}

/**
 * Pretty-prints JSON text, leaving it alone if it does not parse.
 *
 * Returns the input unchanged rather than throwing, so a "Format" action is safe to call
 * on whatever is in the field at the time.
 */
export function formatJson(text: string, indent = 2): string {
  const parsed = parseJsonInput(text)
  if (!parsed.valid) return text
  return JSON.stringify(parsed.value, null, indent)
}

interface JsonInputProps
  extends Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "defaultValue" | "onChange" | "aria-invalid"
  > {
  /**
   * The text in the field, as text. **Store the string, not the parsed object** — see the
   * note on the component below, which is the one thing that makes this component work.
   */
  value?: string
  /** Initial text when the field is uncontrolled. */
  defaultValue?: string
  /** Every keystroke, immediately, with the new text. */
  onValueChange?: (text: string) => void
  /**
   * The parse result, after the reader pauses (`debounceMs`) rather than on every
   * keystroke. Also fires once on mount for the initial text.
   */
  onParse?: (result: JsonParseResult) => void
  /** Spaces per level, used by Tab and by "Format". */
  indent?: number
  /** How long the reader has to stop typing before the text is parsed again. */
  debounceMs?: number
  /** Tab inserts indentation instead of moving focus. Escape then Tab always moves focus. */
  tabIndent?: boolean
  /** Pretty-print on blur when the text is valid. */
  formatOnBlur?: boolean
  /** The status line and the Format / Go to error actions. */
  showToolbar?: boolean
  /**
   * The screen-reader-only description of the keyboard behaviour. Pass your own string to
   * translate it, or null to drop it.
   */
  hint?: string | null
  /** On the wrapper. The field itself takes `textareaClassName`; other props pass to it. */
  className?: string
  textareaClassName?: string
}

/**
 * A textarea for editing JSON that says where the mistake is.
 *
 * For the places a page has to let someone edit a JSON value by hand: a setting in an
 * admin panel, a feature flag's payload, a webhook's test body, a metadata column, the
 * request body in an API client, a job's input in a queue dashboard, a CI or connector
 * config form. It validates as you pause, reports the line and column, puts the caret on
 * the error when you ask, indents with Tab and pretty-prints on demand.
 *
 * **The text is the value.** This is the whole design, and the reason the obvious version
 * of this component does not work. Write the obvious one — parse the text, hand the
 * object to the parent, render `JSON.stringify(object)` back into the field — and the
 * field becomes impossible to type in: the moment you have typed `{"a": 1,` the text does
 * not parse, there is no object to stringify, and whatever the parent hands back replaces
 * what you were typing. Even while it does parse, the round trip rewrites the text under
 * the caret, so `{"a": 1` becomes `{"a":1}` mid-keystroke and the second key can never be
 * reached. So `value` here is a string, parsing is a *check* that never touches the text,
 * and the parsed value is handed over as metadata through `onParse`. Keep the string in
 * your own state and parse it when you submit — `const [text, setText] = useState(...)`,
 * not `JSON.stringify(config)` — and nothing fights the caret.
 *
 * Errors are located by a JSON scanner in this file rather than by reading
 * `SyntaxError.message`, because the message is not an interface: no engine puts a
 * `position` property on the error, Safari's message never contains a position at all,
 * and V8's omits it for a whole class of mistakes including the trailing comma. The
 * scanner is only ever asked *where* a failure is — `JSON.parse` alone decides whether
 * the text is valid — so it can never reject a document the runtime would accept.
 *
 * Nothing is validated mid-keystroke. Text that is half-typed is always broken, and a
 * field that turns red on the second character is a field that is red the whole time it
 * is being used, so the verdict waits for a pause (`debounceMs`, 200ms) and shows nothing
 * in the meantime rather than a stale one. The same pause is what keeps a few hundred
 * kilobytes of payload from being re-parsed on every keypress.
 *
 * Formatting only ever happens when asked — the Format button, or `formatOnBlur` — never
 * while typing, because reformatting replaces the whole value and sends the caret to the
 * end of the document.
 *
 * Tab indents (and Shift+Tab outdents) the selected lines, which would otherwise trap a
 * keyboard user in the field with no way out: **Escape releases it**, so Escape then Tab
 * moves focus on, as WCAG 2.1.2 requires, and the release is announced in the field's
 * own description rather than left to be discovered. Escape is not swallowed, so it still
 * reaches the dialog this editor might be sitting in.
 */
export function JsonInput({
  value,
  defaultValue,
  onValueChange,
  onParse,
  indent = 2,
  debounceMs = 200,
  tabIndent = true,
  formatOnBlur = false,
  showToolbar = true,
  hint,
  className,
  textareaClassName,
  rows = 8,
  disabled,
  readOnly,
  spellCheck = false,
  autoCapitalize = "off",
  autoCorrect = "off",
  autoComplete = "off",
  id,
  onKeyDown,
  onBlur,
  "aria-describedby": ariaDescribedby,
  ...props
}: JsonInputProps) {
  const isControlled = value !== undefined
  const [uncontrolledText, setUncontrolledText] = React.useState(defaultValue ?? "")
  const text = isControlled ? value : uncontrolledText

  // The verdict, together with the exact text it describes. Keeping the text alongside is
  // what lets the status say nothing at all while the reader is mid-edit: comparing it to
  // the current text is the difference between "no opinion yet" and "valid", which a bare
  // result cannot express. Seeded synchronously so a field that opens with a document
  // already in it shows the right answer on the first paint instead of flickering through
  // a pending state.
  const [checked, setChecked] = React.useState<{ text: string; result: JsonParseResult }>(() => {
    const initial = value !== undefined ? value : (defaultValue ?? "")
    return { text: initial, result: parseJsonInput(initial) }
  })
  const checkedTextRef = React.useRef(checked.text)

  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  // A caret position owed to the text that is about to render. Set by the Tab handlers and
  // spent in the layout effect below, never applied on the spot: the value React is about
  // to commit replaces the whole contents of the textarea, and a browser puts the caret at
  // the end of a textarea whose value was replaced — so a setSelectionRange call made in
  // the key handler is overwritten a moment later by the commit it was meant to survive.
  const pendingSelection = React.useRef<[number, number] | null>(null)
  // Whether Escape has released the Tab trap for the next keypress.
  const tabReleased = React.useRef(false)

  const onParseRef = React.useRef(onParse)
  React.useEffect(() => {
    onParseRef.current = onParse
  }, [onParse])

  React.useEffect(() => {
    if (text === checked.text) return
    const id = setTimeout(() => {
      // Re-checked inside the timer because the text may have come back to what was
      // already parsed — typing a character and deleting it again — in which case the
      // verdict on screen is already the right one.
      if (checkedTextRef.current === text) return
      checkedTextRef.current = text
      setChecked({ text, result: parseJsonInput(text) })
    }, debounceMs)
    return () => clearTimeout(id)
  }, [text, checked.text, debounceMs])

  React.useEffect(() => {
    onParseRef.current?.(checked.result)
  }, [checked])

  React.useLayoutEffect(() => {
    const pending = pendingSelection.current
    if (!pending) return
    pendingSelection.current = null
    textareaRef.current?.setSelectionRange(pending[0], pending[1])
  })

  const commit = (next: string) => {
    if (!isControlled) setUncontrolledText(next)
    onValueChange?.(next)
  }

  /** Settles the verdict immediately, for the explicit actions that already know it. */
  const settle = (next: string, result: JsonParseResult) => {
    checkedTextRef.current = next
    setChecked({ text: next, result })
  }

  const format = () => {
    const parsed = parseJsonInput(text)
    if (!parsed.valid) return
    const next = JSON.stringify(parsed.value, null, indent)
    if (next === text) return
    commit(next)
    // Formatting cannot change what the document means, so the verdict is carried over
    // rather than recomputed — and carrying it over is also what stops the Format button
    // from blinking out and back while the debounce runs.
    settle(next, parsed)
    pendingSelection.current = [next.length, next.length]
  }

  const goToError = () => {
    const error = checked.result.valid ? null : checked.result.error
    if (!error || error.offset === null) return
    const node = textareaRef.current
    node?.focus()
    node?.setSelectionRange(error.offset, error.offset)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    if (event.key === "Escape") {
      // Not prevented: Escape belongs to whatever this editor sits inside — a dialog, a
      // command palette — and swallowing it to serve the Tab trap would break that.
      tabReleased.current = true
      return
    }
    if (event.key !== "Tab") {
      tabReleased.current = false
      return
    }
    if (!tabIndent || readOnly || disabled) return
    if (tabReleased.current) {
      tabReleased.current = false
      return
    }

    const node = event.currentTarget
    const start = node.selectionStart ?? text.length
    const end = node.selectionEnd ?? start
    event.preventDefault()

    const pad = " ".repeat(indent)
    const lineStart = text.lastIndexOf("\n", start - 1) + 1
    // A selection that ends exactly at the start of a line stops short of that line. Dragging
    // down to the next line's first column is how everyone selects "these lines", and the
    // line below is usually the one holding the closing brace — indenting it along with the
    // block pushes over a character the reader never selected, and does it again on every Tab.
    const reach = end > start && text[end - 1] === "\n" ? end - 1 : end
    const breakAfter = text.indexOf("\n", reach)
    const lineEnd = breakAfter === -1 ? text.length : breakAfter
    const before = text.slice(0, lineStart)
    const block = text.slice(lineStart, lineEnd)
    const after = text.slice(lineEnd)
    const lines = block.split("\n")

    if (event.shiftKey) {
      let firstRemoved = 0
      let totalRemoved = 0
      const outdented = lines.map((line, index) => {
        const leading = /^ +/.exec(line)
        const remove = Math.min(indent, leading ? leading[0].length : 0)
        if (index === 0) firstRemoved = remove
        totalRemoved += remove
        return line.slice(remove)
      })
      if (totalRemoved === 0) return
      commit(before + outdented.join("\n") + after)
      pendingSelection.current = [
        Math.max(lineStart, start - firstRemoved),
        Math.max(lineStart, end - totalRemoved),
      ]
      return
    }

    // An empty selection inserts at the caret; any selection at all indents every line it
    // touches, which is what makes Tab useful on a block that came back from the Format
    // button one level too shallow.
    if (start === end) {
      commit(text.slice(0, start) + pad + text.slice(start))
      pendingSelection.current = [start + indent, start + indent]
      return
    }
    commit(before + lines.map((line) => pad + line).join("\n") + after)
    pendingSelection.current = [start + indent, end + indent * lines.length]
  }

  const handleBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    onBlur?.(event)
    if (formatOnBlur && !readOnly && !disabled) format()
  }

  const reactId = React.useId()
  const fieldId = id ?? `${reactId}-json-input`
  const statusId = `${fieldId}-status`
  const hintId = `${fieldId}-hint`

  const pending = text !== checked.text
  // An empty field has no verdict. "Unexpected end of input" is true of "" and useless to
  // show: an optional field that is red before it has been touched teaches the reader to
  // ignore the colour.
  const empty = text.trim() === ""
  const error = !pending && !empty && !checked.result.valid ? checked.result.error : null
  const valid = !pending && !empty && checked.result.valid

  const hintText =
    hint === undefined
      ? tabIndent
        ? "Tab indents, Shift+Tab outdents. Press Escape, then Tab, to move focus out of the editor."
        : null
      : hint

  const describedBy =
    [ariaDescribedby, showToolbar ? statusId : null, hintText ? hintId : null]
      .filter(Boolean)
      .join(" ") || undefined

  return (
    <div className={cn("space-y-1.5", className)}>
      <textarea
        {...props}
        id={fieldId}
        ref={textareaRef}
        value={text}
        rows={rows}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => commit(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        // A mobile keyboard that autocapitalises and autocorrects rewrites a key name
        // between the keypress and the change event, and spellcheck underlines every
        // identifier in the document. All four are overridable for the rare field that
        // does want them.
        spellCheck={spellCheck}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(
          "flex w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          // Tabs are never inserted by this component, but a document pasted in can
          // contain them, and the browser default of eight columns makes two levels of
          // nesting unreadable.
          "[tab-size:2]",
          error && "border-destructive focus-visible:ring-destructive",
          textareaClassName
        )}
      />

      {showToolbar && (
        <div className="flex items-start justify-between gap-3">
          {/* Polite rather than assertive, and only ever updated once the reader has
              paused, so a screen reader reports the verdict instead of narrating every
              half-finished state on the way to it. */}
          <p
            id={statusId}
            aria-live="polite"
            className={cn(
              "min-h-5 text-xs",
              error ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {error ? (
              <>
                {error.line !== null && (
                  <span className="font-medium">
                    Line {error.line}, column {error.column}:{" "}
                  </span>
                )}
                {error.message}
              </>
            ) : valid ? (
              "Valid JSON"
            ) : (
              ""
            )}
          </p>

          <div className="flex shrink-0 gap-1">
            {error !== null && error.offset !== null && (
              <button
                type="button"
                onClick={goToError}
                className="inline-flex h-6 items-center rounded-md border border-input bg-transparent px-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Go to error
              </button>
            )}
            {valid && !readOnly && !disabled && (
              <button
                type="button"
                onClick={format}
                className="inline-flex h-6 items-center rounded-md border border-input bg-transparent px-2 text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Format
              </button>
            )}
          </div>
        </div>
      )}

      {hintText && (
        <span id={hintId} className="sr-only">
          {hintText}
        </span>
      )}
    </div>
  )
}
