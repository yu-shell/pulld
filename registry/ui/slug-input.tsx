"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Quotes disappear instead of becoming a separator, because they sit inside a
 * word: "don't panic" has to slug to `dont-panic`, not `don-t-panic`. Every
 * other character that is not kept turns into a separator, so `foo/bar` never
 * glues itself into `foobar`.
 */
const DROPPED = new Set([
  "'",
  "‘",
  "’",
  "‚",
  "‛",
  "ʼ",
  '"',
  "“",
  "”",
  "„",
  "‟",
  "`",
  "´",
])

/**
 * Letters Unicode decomposition leaves whole. NFKD only splits a letter that is
 * defined as "base + mark", so a letter with the stroke or the shape baked into
 * it survives normalisation and is then dropped as unknown — which is how
 * hand-rolled slugifiers turn "straße" into "strae" and "Łódź" into "odz".
 */
const TRANSLITERATE: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ħ: "h",
  ŧ: "t",
  ŋ: "ng",
  ĸ: "k",
  ı: "i",
  ə: "e",
  ƒ: "f",
}

const MARK = /^\p{M}$/u
const UNICODE_WORD = /^[\p{L}\p{N}\p{M}]$/u

interface SlugOptions {
  separator: string
  allowUnicode: boolean
  /** 0 or a non-finite value means "no limit". */
  maxLength: number
}

/**
 * Only these two are accepted: the separator is compared character by character
 * while collapsing runs and trimming ends, so a multi-character or word-shaped
 * separator would round-trip into something that is not a slug at all.
 */
function resolveSeparator(separator: string | undefined) {
  return separator === "_" ? "_" : "-"
}

/**
 * Combining marks count as part of a word in Unicode mode on purpose: a
 * Devanagari vowel sign and a Japanese dakuten are marks, and dropping them
 * rewrites the word — が would become か, which is a different reading.
 */
function isKept(ch: string, allowUnicode: boolean) {
  if (ch >= "a" && ch <= "z") return true
  if (ch >= "0" && ch <= "9") return true
  return allowUnicode ? UNICODE_WORD.test(ch) : false
}

function limitOf(maxLength: number) {
  return Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : Infinity
}

/**
 * The whole transform, as one pure function of a string: lowercase, strip
 * accents, transliterate what will not decompose, collapse everything else into
 * single separators.
 *
 * It also returns `map`, the position each UTF-16 offset of the input landed on
 * in the output. That is what keeps the caret still: rewriting the value of a
 * controlled input on every keystroke otherwise throws the caret to the end, so
 * typing a word into the middle of an existing slug is impossible.
 */
function transform(raw: string, opts: SlugOptions) {
  const sep = opts.separator
  const max = limitOf(opts.maxLength)
  const map = new Array<number>(raw.length + 1).fill(0)
  let out = ""
  let full = false
  let i = 0

  while (i < raw.length) {
    const cp = String.fromCodePoint(raw.codePointAt(i) as number)
    map[i] = out.length
    // An offset between the two halves of a surrogate pair is not a place the
    // caret can be, but it still has to hold a number the next lookup can use.
    if (cp.length === 2) map[i + 1] = out.length

    // Lowercase first so the transliteration table only needs lowercase keys,
    // then normalise. Folding to ASCII wants the decomposed form so an accent
    // can be peeled off its letter; keeping the script wants the composed one,
    // because 안 and が are single letters that NFKD would break into pieces.
    // Both forms are compatibility ones, so ﬁ becomes fi and ３ becomes 3.
    for (const ch of cp.toLowerCase().normalize(opts.allowUnicode ? "NFKC" : "NFKD")) {
      if (full || DROPPED.has(ch)) continue
      // A mark is dropped when it is folding away with its letter, and when
      // there is no letter for it to sit on.
      if (MARK.test(ch) && (!opts.allowUnicode || out.length === 0 || out[out.length - 1] === sep))
        continue
      // Transliteration belongs to the ASCII fold; in Unicode mode ß is simply
      // a letter and stays one.
      const mapped = opts.allowUnicode ? undefined : TRANSLITERATE[ch]
      const piece = mapped !== undefined ? mapped : isKept(ch, opts.allowUnicode) ? ch : null
      if (piece === null) {
        // A separator run collapses to one. A leading separator is allowed to
        // stand while typing — trimming it here would make it impossible to
        // type a slug that starts with a word you have not written yet.
        if (out.length === 0 || out[out.length - 1] !== sep) {
          if (out.length < max) out += sep
          else full = true
        }
      } else if (out.length + piece.length <= max) {
        out += piece
      } else {
        // Stop at the cap instead of skipping only what does not fit: letting
        // the next shorter piece through would drop a letter out of the middle
        // of the word rather than cutting the end off.
        full = true
      }
    }
    i += cp.length
  }

  map[raw.length] = out.length
  return { value: out, map }
}

function trimSeparators(value: string, sep: string) {
  let start = 0
  let end = value.length
  while (start < end && value[start] === sep) start++
  while (end > start && value[end - 1] === sep) end--
  return value.slice(start, end)
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Cut to `max`, then back off to the last separator so a generated slug ends on
 * a whole word rather than `…-introducti`. With no separator to back off to,
 * the hard cut is all there is — dropping the only word would leave nothing.
 */
function truncateAtWord(value: string, sep: string, maxLength: number) {
  const max = limitOf(maxLength)
  if (value.length <= max) return value
  let cut = value.slice(0, max)
  // Half a surrogate pair is not a character; it renders as a replacement box.
  if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1)
  // Only back off when the cut landed inside a word. Falling exactly on a
  // separator means the last whole word already fits, and dropping it would
  // throw away a word the limit had room for.
  if (value[cut.length] !== sep) {
    const at = cut.lastIndexOf(sep)
    if (at > 0) cut = cut.slice(0, at)
  }
  return trimSeparators(cut, sep)
}

/** The committed form: no limit while transforming, then trim, then truncate. */
function slugify(source: string, opts: SlugOptions) {
  const { value } = transform(source, { ...opts, maxLength: 0 })
  return truncateAtWord(trimSeparators(value, opts.separator), opts.separator, opts.maxLength)
}

/**
 * The last path segment of a pasted URL, or null when the text is not a URL and
 * should be pasted as-is. Pasting the address of the page you are copying is a
 * normal way to reach for a slug, and `https-example-com-blog-my-post` is not
 * what anyone meant by it.
 */
function urlTail(text: string) {
  const trimmed = text.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null
  const path = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/)[0]
  const segments = path.split("/").filter(Boolean)
  if (!segments.length) return null
  const last = segments[segments.length - 1]
  try {
    return decodeURIComponent(last)
  } catch {
    // A stray % is a valid character in a pasted string but not a valid escape.
    return last
  }
}

/**
 * Whether auto-derivation may still write to the field. It may while the field
 * holds exactly what this component last put there, or nothing at all —
 * anything else belongs to the user or to the record being edited. Deriving it
 * from the value rather than tracking an "is linked" flag means a slug that
 * arrives late from a fetch stops the derivation just as a keystroke does.
 */
function ownsValue(current: string, derived: string | null) {
  return current === "" || current === derived
}

interface SlugInputProps
  extends Omit<
    React.ComponentPropsWithoutRef<"input">,
    "value" | "defaultValue" | "onChange" | "prefix" | "type"
  > {
  /**
   * The title to derive the slug from. It keeps deriving until the field holds
   * something this component did not write — an edit by the user, or a slug
   * loaded from your database — and then never touches it again. That is the
   * point of the component: renaming a published post must not silently change
   * its URL.
   */
  source?: string
  /** Controlled slug. */
  value?: string
  /** Initial slug for uncontrolled use. A non-empty one stops auto-derivation. */
  defaultValue?: string
  /** Fires with the sanitised slug on every keystroke and on blur. */
  onValueChange?: (value: string) => void
  /** Static text shown inside the field before the input, e.g. `example.com/blog/`. */
  prefix?: React.ReactNode
  /** Word separator, `-` (default) or `_`. */
  separator?: "-" | "_"
  /**
   * Keep letters and digits from every script instead of only `a-z0-9`
   * (default false). Without it a title written in Japanese, Chinese, Korean,
   * Greek, Cyrillic, Hebrew or Arabic slugifies to an empty string.
   */
  allowUnicode?: boolean
  /** Cap on the slug length. Derived slugs are cut back to a whole word. */
  maxLength?: number
}

export const SlugInput = React.forwardRef<HTMLInputElement, SlugInputProps>(
  function SlugInput(
    {
      className,
      source,
      value,
      defaultValue,
      onValueChange,
      prefix,
      separator,
      allowUnicode = false,
      maxLength,
      disabled,
      onBlur,
      onPaste,
      onCompositionStart,
      onCompositionEnd,
      ...props
    },
    forwardedRef
  ) {
    const innerRef = React.useRef<HTMLInputElement>(null)
    React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement)

    const generatedId = React.useId()
    const prefixId = `${generatedId}-prefix`
    const hasPrefix = prefix !== undefined && prefix !== null && prefix !== ""

    const sep = resolveSeparator(separator)
    const opts = React.useMemo<SlugOptions>(
      () => ({ separator: sep, allowUnicode, maxLength: maxLength ?? 0 }),
      [sep, allowUnicode, maxLength]
    )

    const isControlled = value !== undefined
    const [internal, setInternal] = React.useState(() =>
      defaultValue ? slugify(defaultValue, opts) : ""
    )
    const current = isControlled ? (value ?? "") : internal

    // The value is read inside effects and event handlers that must not re-run
    // for every keystroke, so it travels through a ref rather than a dependency.
    const currentRef = React.useRef(current)
    currentRef.current = current

    const commit = React.useCallback(
      (next: string) => {
        if (!isControlled) setInternal(next)
        onValueChange?.(next)
      },
      [isControlled, onValueChange]
    )

    // What this component last wrote by itself. Auto-derivation continues only
    // while the field still holds exactly that (or nothing) — no flag to keep in
    // sync, and a slug arriving late from a fetch stops it just as an edit does.
    const derivedRef = React.useRef<string | null>(null)
    const lastSourceRef = React.useRef<string | null>(null)

    React.useEffect(() => {
      const src = source ?? ""
      if (lastSourceRef.current === src) return
      lastSourceRef.current = src
      const cur = currentRef.current
      if (!ownsValue(cur, derivedRef.current)) return
      const next = slugify(src, opts)
      if (next === cur) return
      derivedRef.current = next
      commit(next)
    }, [source, opts, commit])

    // Text mid-composition, shown raw. Sanitising each keystroke of an IME —
    // Japanese, Korean, Vietnamese Telex, pinyin — rewrites the half-finished
    // syllable the IME is still holding and the word comes out mangled, so the
    // field shows exactly what the IME put there until composition ends.
    const [composing, setComposing] = React.useState<string | null>(null)

    // Where the caret has to go after the value the user typed is rewritten.
    const caretRef = React.useRef<number | null>(null)

    React.useLayoutEffect(() => {
      const el = innerRef.current
      const caret = caretRef.current
      caretRef.current = null
      if (!el || caret === null) return
      if (el.value !== current) el.value = current
      el.setSelectionRange(caret, caret)
    })

    function apply(raw: string, caretAt: number) {
      const { value: next, map } = transform(raw, opts)
      const caret = map[Math.min(Math.max(caretAt, 0), map.length - 1)]
      if (next === current) {
        // Nothing changed for React, so no render is coming and the DOM would
        // keep the rejected character on screen. Put it back by hand.
        const el = innerRef.current
        if (el) {
          if (el.value !== next) el.value = next
          el.setSelectionRange(caret, caret)
        }
        return
      }
      caretRef.current = caret
      commit(next)
    }

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
      const el = e.currentTarget
      if (composing !== null) {
        // Keep the controlled value equal to what the IME wrote, or React puts
        // the old text back and the composition is lost.
        setComposing(el.value)
        return
      }
      apply(el.value, el.selectionStart ?? el.value.length)
    }

    function handleCompositionStart(e: React.CompositionEvent<HTMLInputElement>) {
      setComposing(e.currentTarget.value)
      onCompositionStart?.(e)
    }

    function handleCompositionEnd(e: React.CompositionEvent<HTMLInputElement>) {
      const el = e.currentTarget
      setComposing(null)
      apply(el.value, el.selectionStart ?? el.value.length)
      onCompositionEnd?.(e)
    }

    function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
      onPaste?.(e)
      if (e.defaultPrevented) return
      const tail = urlTail(e.clipboardData.getData("text"))
      if (tail === null) return
      e.preventDefault()
      const el = e.currentTarget
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? start
      apply(el.value.slice(0, start) + tail + el.value.slice(end), start + tail.length)
    }

    function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
      // Leaving the field mid-composition still has to commit what is on
      // screen: not every engine fires compositionend before blur.
      const shown = composing ?? current
      if (composing !== null) setComposing(null)
      // The same commit the derived path uses, so a hand-typed slug ends up
      // under the same rules: separators trimmed off both ends, and a length
      // limit that arrived after the typing did still applied.
      const cleaned = slugify(shown, opts)
      // An empty field means "use the title" — leaving it blank is how you ask
      // for the derived slug back after editing it into a corner.
      const next = cleaned === "" ? slugify(source ?? "", opts) : cleaned
      if (cleaned === "") derivedRef.current = next
      if (next !== current) commit(next)
      onBlur?.(e)
    }

    const describedBy =
      [props["aria-describedby"], hasPrefix ? prefixId : null].filter(Boolean).join(" ") ||
      undefined

    return (
      <div
        className={cn(
          "flex h-9 w-full items-center rounded-md border border-input bg-transparent text-sm shadow-sm transition-colors",
          "focus-within:outline-none focus-within:ring-1 focus-within:ring-ring",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        {hasPrefix ? (
          <span
            id={prefixId}
            className="select-none whitespace-nowrap pl-3 text-muted-foreground"
          >
            {prefix}
          </span>
        ) : null}
        <input
          {...props}
          ref={innerRef}
          type="text"
          value={composing ?? current}
          onChange={handleChange}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          onPaste={handlePaste}
          onBlur={handleBlur}
          disabled={disabled}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={describedBy}
          className={cn(
            "h-full w-full min-w-0 flex-1 rounded-md bg-transparent px-3 py-1 outline-none",
            "placeholder:text-muted-foreground disabled:cursor-not-allowed",
            hasPrefix && "pl-1"
          )}
        />
      </div>
    )
  }
)
