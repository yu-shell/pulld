import * as React from "react"

import { cn } from "@/lib/utils"

interface AnsiLogProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  /** Raw output, escape sequences and all — exactly what the process wrote. */
  text: string
  /** Draw a line-number gutter. It is not selectable, so copying gives the log alone. */
  showLineNumbers?: boolean
  /** Keep at most this many lines, from the end (default 5000). A dropped-lines notice is shown. */
  maxLines?: number
  /** Wrap long lines instead of scrolling them horizontally (default false). */
  wrap?: boolean
  /** Accessible name of the scrollable region (default "Log output"). */
  label?: string
}

/** 0–7 are the standard colours, 8–15 their bright variants. */
type AnsiColor =
  | { kind: "index"; index: number }
  | { kind: "rgb"; r: number; g: number; b: number }

interface AnsiStyle {
  fg: AnsiColor | null
  bg: AnsiColor | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
}

interface AnsiSpan {
  text: string
  style: AnsiStyle
}

const PLAIN: AnsiStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
}

/**
 * Foreground tones, ANSI order: black, red, green, yellow, blue, magenta, cyan, white, then the
 * eight bright variants. Every one is a light/dark pair chosen against the panel behind it, which
 * is what makes the whole table safe: the text colour is the *only* thing that ever decides
 * legibility here, because backgrounds below are washes rather than solid blocks. ANSI "white" is
 * really light grey and ANSI "bright black" is really the dimmed-text colour, so those two borrow
 * the theme's own muted token rather than pretending to be white and black.
 */
const FG_CLASS = [
  "text-neutral-800 dark:text-neutral-400",
  "text-red-600 dark:text-red-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-amber-600 dark:text-amber-400",
  "text-blue-600 dark:text-blue-400",
  "text-fuchsia-600 dark:text-fuchsia-400",
  "text-cyan-600 dark:text-cyan-400",
  "text-neutral-500 dark:text-neutral-300",
  "text-muted-foreground",
  "text-red-500 dark:text-red-300",
  "text-emerald-500 dark:text-emerald-300",
  "text-amber-500 dark:text-amber-300",
  "text-blue-500 dark:text-blue-300",
  "text-fuchsia-500 dark:text-fuchsia-300",
  "text-cyan-500 dark:text-cyan-300",
  "text-foreground",
]

/**
 * Backgrounds as a translucent wash of the hue instead of the solid block a terminal paints. A
 * terminal owns the whole surface and can pair any background with any foreground; a log panel
 * sits inside a themed page, and a solid saturated block there both fights the page and drags the
 * text on top of it below contrast — 16 foregrounds against 16 backgrounds is 256 pairs, and
 * several of them fail in one theme or the other. A wash cannot: whatever is on top keeps its
 * contrast against the panel, so the one invariant above holds for every combination.
 */
const BG_WASH_CLASS = [
  "bg-neutral-500/20 dark:bg-neutral-400/25",
  "bg-red-500/20 dark:bg-red-400/25",
  "bg-emerald-500/20 dark:bg-emerald-400/25",
  "bg-amber-500/20 dark:bg-amber-400/25",
  "bg-blue-500/20 dark:bg-blue-400/25",
  "bg-fuchsia-500/20 dark:bg-fuchsia-400/25",
  "bg-cyan-500/20 dark:bg-cyan-400/25",
  "bg-neutral-400/20 dark:bg-neutral-300/25",
  "bg-muted",
  "bg-red-400/25 dark:bg-red-300/25",
  "bg-emerald-400/25 dark:bg-emerald-300/25",
  "bg-amber-400/25 dark:bg-amber-300/25",
  "bg-blue-400/25 dark:bg-blue-300/25",
  "bg-fuchsia-400/25 dark:bg-fuchsia-300/25",
  "bg-cyan-400/25 dark:bg-cyan-300/25",
  "bg-foreground/15",
]

/**
 * The solid pair, used only for reverse video (SGR 7), where a wash would not read as inverted at
 * all. Tones are picked so the theme's `background` token — near-white in light, near-black in
 * dark — clears 4.5:1 on top of them in both directions, which is why light mode reaches for the
 * 600/700 end and dark mode for 300/400.
 */
const BG_SOLID_CLASS = [
  "bg-neutral-700 dark:bg-neutral-400",
  "bg-red-700 dark:bg-red-400",
  "bg-emerald-700 dark:bg-emerald-400",
  "bg-amber-700 dark:bg-amber-400",
  "bg-blue-700 dark:bg-blue-400",
  "bg-fuchsia-700 dark:bg-fuchsia-400",
  "bg-cyan-700 dark:bg-cyan-400",
  "bg-neutral-500 dark:bg-neutral-300",
  "bg-muted-foreground",
  "bg-red-600 dark:bg-red-300",
  "bg-emerald-600 dark:bg-emerald-300",
  "bg-amber-600 dark:bg-amber-300",
  "bg-blue-600 dark:bg-blue-300",
  "bg-fuchsia-600 dark:bg-fuchsia-300",
  "bg-cyan-600 dark:bg-cyan-300",
  "bg-foreground",
]

/** The six levels of the xterm 6×6×6 colour cube, and the start/step of its 24-step grey ramp. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]
const GREY_BASE = 8
const GREY_STEP = 10

const isFinalByte = (ch: string) => ch >= "@" && ch <= "~"

const clampByte = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : Math.trunc(n))

/**
 * An index into the 256-colour palette. 0–15 stay symbolic so they follow the theme through the
 * tables above; everything past that is a fixed point in the cube or the grey ramp and can only be
 * carried through literally.
 */
function paletteColor(index: number): AnsiColor | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null
  if (index < 16) return { kind: "index", index }
  if (index < 232) {
    // The index is a three-digit base-6 number, most significant digit first. Red is that leading
    // digit and cannot exceed 5 on its own, which is why it is the one channel with no modulus.
    const n = index - 16
    return {
      kind: "rgb",
      r: CUBE_LEVELS[Math.floor(n / 36)],
      g: CUBE_LEVELS[Math.floor(n / 6) % 6],
      b: CUBE_LEVELS[n % 6],
    }
  }
  const v = GREY_BASE + (index - 232) * GREY_STEP
  return { kind: "rgb", r: v, g: v, b: v }
}

const toNumber = (part: string) => {
  if (part === "") return 0 // An omitted parameter means zero, so `ESC[;31m` resets then reddens.
  return /^\d+$/.test(part) ? Number(part) : NaN
}

/**
 * The extended-colour argument of SGR 38/48, in either spelling: `38;5;n` / `38;2;r;g;b` with
 * semicolons, or `38:5:n` / `38:2:r:g:b` with colons. The colon form is the one the standard
 * actually specifies, it is what libvte and kitty emit, and it may carry an empty colour-space slot
 * (`38:2::r:g:b`) — so the RGB triple is read from the end rather than from a fixed offset.
 */
function extendedColor(args: string[]): AnsiColor | null {
  const mode = toNumber(args[0] ?? "")
  if (mode === 5) return paletteColor(toNumber(args[1] ?? ""))
  if (mode === 2) {
    const nums = args.slice(1).map(toNumber)
    const rgb = nums.slice(-3)
    if (rgb.length < 3 || rgb.some((n) => !Number.isFinite(n))) return null
    return { kind: "rgb", r: clampByte(rgb[0]), g: clampByte(rgb[1]), b: clampByte(rgb[2]) }
  }
  return null
}

/** Applies one SGR sequence's parameters to a style, returning the new style. */
function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  const parts = params === "" ? ["0"] : params.split(";")
  const next = { ...style }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // A colon-delimited parameter is self-contained: it carries its own arguments, so it is read
    // whole and does not consume the parameters that follow it.
    if (part.includes(":")) {
      const sub = part.split(":")
      const lead = toNumber(sub[0])
      if (lead === 38 || lead === 48) {
        const color = extendedColor(sub.slice(1))
        if (color) {
          if (lead === 38) next.fg = color
          else next.bg = color
        }
      }
      continue
    }
    const n = toNumber(part)
    if (!Number.isFinite(n)) continue
    if (n === 38 || n === 48) {
      // Semicolon form: the arguments are the parameters that follow, and they are consumed here
      // so that a trailing `1` in `38;5;1;1m` is read as bold rather than as another colour.
      const isTruecolor = toNumber(parts[i + 1] ?? "") === 2
      const args = parts.slice(i + 1, i + (isTruecolor ? 5 : 3))
      const color = extendedColor(args)
      if (color) {
        if (n === 38) next.fg = color
        else next.bg = color
      }
      i += args.length
      continue
    }
    if (n === 0) {
      next.fg = null
      next.bg = null
      next.bold = false
      next.dim = false
      next.italic = false
      next.underline = false
      next.inverse = false
      next.strike = false
    } else if (n === 1) next.bold = true
    else if (n === 2) next.dim = true
    else if (n === 3) next.italic = true
    else if (n === 4) next.underline = true
    else if (n === 7) next.inverse = true
    else if (n === 9) next.strike = true
    // 21 is "doubly underlined" in the standard and "bold off" in most terminals; both readings
    // end with less emphasis than before, so it is treated as the latter.
    else if (n === 21 || n === 22) {
      next.bold = false
      next.dim = false
    } else if (n === 23) next.italic = false
    else if (n === 24) next.underline = false
    else if (n === 27) next.inverse = false
    else if (n === 29) next.strike = false
    else if (n >= 30 && n <= 37) next.fg = { kind: "index", index: n - 30 }
    else if (n === 39) next.fg = null
    else if (n >= 40 && n <= 47) next.bg = { kind: "index", index: n - 40 }
    else if (n === 49) next.bg = null
    else if (n >= 90 && n <= 97) next.fg = { kind: "index", index: n - 90 + 8 }
    else if (n >= 100 && n <= 107) next.bg = { kind: "index", index: n - 100 + 8 }
  }
  return next
}

const sameColor = (a: AnsiColor | null, b: AnsiColor | null) => {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  if (a.kind === "index" && b.kind === "index") return a.index === b.index
  if (a.kind === "rgb" && b.kind === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b
  return false
}

/**
 * Compared field by field rather than by reference: `ESC[31m…ESC[0m…ESC[31m` builds two separate
 * style objects that mean the same thing, and comparing references would emit two adjacent spans
 * that a reader cannot tell apart but a diff of the markup can.
 */
const sameStyle = (a: AnsiStyle, b: AnsiStyle) =>
  a.bold === b.bold &&
  a.dim === b.dim &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.inverse === b.inverse &&
  a.strike === b.strike &&
  sameColor(a.fg, b.fg) &&
  sameColor(a.bg, b.bg)

/**
 * Parses raw output into lines of styled spans.
 *
 * The line is held as one cell per column rather than as a growing string, because a carriage
 * return is an instruction to move the cursor, not to start a new line: `50%\r100%` is one line
 * reading "100%", and `Downloading\rDone` is one line reading "Donenoading" on a real terminal —
 * the tail that the shorter write did not cover survives. Progress bars, spinners and `docker
 * pull` all lean on exactly that, and a parser that treats `\r` as "discard the line so far" or,
 * worse, as a line break turns a tidy one-line progress bar into a hundred lines of noise.
 */
function parseAnsi(input: string): AnsiSpan[][] {
  const lines: AnsiSpan[][] = []
  let chars: string[] = []
  let styles: AnsiStyle[] = []
  let column = 0
  let style = PLAIN
  // Whether the line has been drawn on at all. Asking "are there any cells left?" instead would
  // conflate a line that was never started with one whose content was erased — a progress bar
  // ending in `\r ESC[K` and no newline would leave a line on screen and no line in the output.
  let touched = false

  const flush = () => {
    const spans: AnsiSpan[] = []
    for (let i = 0; i < chars.length; i++) {
      const last = spans[spans.length - 1]
      if (last && sameStyle(styles[i], last.style)) last.text += chars[i]
      else spans.push({ text: chars[i], style: styles[i] })
    }
    lines.push(spans)
    chars = []
    styles = []
    column = 0
    touched = false
  }

  // The cursor never sits past the end of the line: it only moves right by writing, which extends
  // the line under it, and the one operation that shortens a line — erase-to-end, below — cuts it
  // off exactly at the cursor. So this can always assign in place, and there is never a hole to
  // backfill. (The gap-fill that used to stand here was unreachable on 200,000 randomised inputs
  // of returns, backspaces and all three erase modes.)
  const write = (ch: string) => {
    touched = true
    chars[column] = ch
    styles[column] = style
    column++
  }

  const eraseInLine = (params: string) => {
    touched = true
    const mode = toNumber(params.split(";")[0] ?? "")
    if (mode === 0) {
      // To the end of the line. Trailing cells are simply dropped: nothing is drawn to the right
      // edge here the way a terminal paints the background out to its own width.
      chars.length = column
      styles.length = column
    } else if (mode === 1 || mode === 2) {
      const to = mode === 2 ? chars.length : Math.min(column + 1, chars.length)
      for (let i = 0; i < to; i++) {
        chars[i] = " "
        styles[i] = PLAIN
      }
    }
  }

  const text = typeof input === "string" ? input : ""

  for (let i = 0; i < text.length; ) {
    const ch = text[i]

    if (ch === "\x1b") {
      const next = text[i + 1]
      if (next === "[") {
        // A control sequence runs until its final byte; the parameter and intermediate bytes in
        // between are what varies. Scanning for that byte is what keeps an unsupported sequence —
        // a cursor move, a colour query, `ESC[?25l` to hide the cursor — from being printed as
        // visible gibberish, which is the failure mode of a parser that only knows about `m`.
        let j = i + 2
        while (j < text.length && !isFinalByte(text[j])) j++
        if (j >= text.length) break // Truncated at the end of a chunk: there is nothing to draw.
        const params = text.slice(i + 2, j)
        if (text[j] === "m") style = applySgr(style, params)
        else if (text[j] === "K") eraseInLine(params)
        i = j + 1
        continue
      }
      if (next === "]") {
        // An operating-system command — a window title, or OSC 8's hyperlinks. The payload is
        // dropped rather than rendered: the link target in an OSC 8 sequence is attacker-supplied
        // whenever the log is, and turning it into a live anchor would put `javascript:` one build
        // step away from a click.
        let j = i + 2
        while (j < text.length) {
          if (text[j] === "\x07") break
          if (text[j] === "\x1b" && text[j + 1] === "\\") break
          j++
        }
        if (j >= text.length) break
        i = text[j] === "\x07" ? j + 1 : j + 2
        continue
      }
      if (next === undefined) break
      // Charset selection (`ESC(B`) takes one more byte than the other two-byte escapes.
      i += next === "(" || next === ")" || next === "#" || next === "%" ? 3 : 2
      continue
    }

    if (ch === "\n") {
      flush()
      i++
      continue
    }
    if (ch === "\r") {
      column = 0
      i++
      continue
    }
    if (ch === "\b") {
      if (column > 0) column--
      i++
      continue
    }
    // Any other C0 control (a bell, a vertical tab, a form feed) and DEL have no printable width,
    // and the replacement glyph a font picks for them is worse than nothing. The tab is the one
    // exception: it is kept as a cell and laid out by the CSS tab-size.
    if (ch !== "\t" && (ch < " " || ch === "\x7f")) {
      i++
      continue
    }

    // By code point, not by UTF-16 unit: an emoji in a build log is a single cell, and writing its
    // halves into two cells would let a later carriage return overwrite one of them and leave a
    // lone surrogate behind.
    const cp = text.codePointAt(i)
    const char = cp === undefined ? text[i] : String.fromCodePoint(cp)
    write(char)
    i += char.length
  }

  // A trailing newline ends the last line rather than starting an empty one, so "done\n" is one
  // line — but "done\n\n" keeps the blank line the second newline really does mean.
  if (touched) flush()
  return lines
}

/** Digits grouped in threes, without Intl: a locale-dependent separator would differ between the
 * server and the browser and break hydration for the sake of one comma. */
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")

/** Perceived lightness, used only to put readable text on a reverse-video block of a colour that
 * came from the log itself and so cannot be checked in advance. */
const isLight = (c: { r: number; g: number; b: number }) =>
  (c.r * 299 + c.g * 587 + c.b * 114) / 1000 > 140

function spanAttrs(style: AnsiStyle) {
  const classes: string[] = []
  const inline: React.CSSProperties = {}

  if (style.inverse) {
    // Reverse video puts the colour in the block and the page's own background colour on top of
    // it, always. The tempting reading — swap the two slots and look each one up as usual — puts a
    // foreground tone on a block that is the panel's opposite: those tones are picked for contrast
    // against the panel, so `ESC[31;7m` lands red on near-black in light mode and red on near-white
    // in dark, around 3:1 both ways. Painting the block instead keeps the colour, keeps the
    // inversion, and holds contrast by construction, because the text is a token the theme already
    // guarantees against `foreground`.
    //
    // A terminal inverting `ESC[41;7m` would instead put red *text* on a white block; here it
    // reads as a red block, which loses that distinction and keeps the colour and the legibility.
    const block = style.fg ?? style.bg
    if (block === null) {
      classes.push("bg-foreground", "text-background")
    } else if (block.kind === "index") {
      classes.push(BG_SOLID_CLASS[block.index], "text-background")
    } else {
      // A 24-bit block out of the log cannot be checked in advance, so the lightness of the colour
      // underneath is what decides whether the text on it is black or white.
      inline.backgroundColor = `rgb(${block.r} ${block.g} ${block.b})`
      inline.color = isLight(block) ? "rgb(0 0 0)" : "rgb(255 255 255)"
    }
  } else {
    if (style.bg !== null) {
      if (style.bg.kind === "index") classes.push(BG_WASH_CLASS[style.bg.index])
      else inline.backgroundColor = `rgb(${style.bg.r} ${style.bg.g} ${style.bg.b} / 0.25)`
    }
    if (style.fg !== null) {
      if (style.fg.kind === "index") classes.push(FG_CLASS[style.fg.index])
      else inline.color = `rgb(${style.fg.r} ${style.fg.g} ${style.fg.b})`
    }
  }

  if (style.bold) classes.push("font-bold")
  if (style.dim) classes.push("opacity-70")
  if (style.italic) classes.push("italic")
  if (style.underline) classes.push("underline")
  if (style.strike) classes.push("line-through")

  return {
    className: classes.length ? cn(...classes) : undefined,
    style: Object.keys(inline).length ? inline : undefined,
  }
}

export const AnsiLog = React.forwardRef<HTMLDivElement, AnsiLogProps>(
  function AnsiLog(
    {
      className,
      text,
      showLineNumbers = false,
      maxLines = 5000,
      wrap = false,
      label = "Log output",
      ...props
    },
    ref
  ) {
    const lines = parseAnsi(text)

    // Kept from the end, because the reason anyone opens a log is at the bottom of it: the failure
    // that stopped the build, not the hundred cache-hit lines that preceded it. The count that was
    // dropped is then said out loud — a viewer that silently shows a suffix reads as a complete log
    // and is the reason someone spends an afternoon looking for a line that was never rendered.
    const limit = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : lines.length
    const dropped = Math.max(0, lines.length - limit)
    const shown = dropped > 0 ? lines.slice(dropped) : lines
    const gutterWidth = String(lines.length).length

    return (
      <div
        ref={ref}
        className={cn("overflow-hidden rounded-lg border bg-muted/50", className)}
        {...props}
      >
        {/* A region that scrolls has to be reachable by keyboard, or the right-hand end of every
            long line is simply unavailable to anyone not using a mouse. */}
        <pre
          tabIndex={0}
          role="group"
          aria-label={label}
          className={cn(
            "overflow-x-auto p-4 font-mono text-[13px] leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          )}
        >
          {dropped > 0 ? (
            <React.Fragment key="dropped">
              {showLineNumbers ? (
                <span
                  aria-hidden="true"
                  className="inline-block select-none pr-4 text-right"
                  style={{ width: `${gutterWidth}ch` }}
                />
              ) : null}
              <span className="italic text-muted-foreground">
                {`… ${groupDigits(dropped)} earlier ${dropped === 1 ? "line" : "lines"} not shown`}
              </span>
              {"\n"}
            </React.Fragment>
          ) : null}
          {shown.map((spans, i) => (
            <React.Fragment key={dropped + i}>
              {showLineNumbers ? (
                // Not selectable, so dragging across the log copies the log and not a column of
                // numbers down its left edge; hidden from assistive technology, which announces
                // lines in order anyway and does not need each one counted at it.
                <span
                  aria-hidden="true"
                  className="inline-block select-none pr-4 text-right text-muted-foreground"
                  style={{ width: `${gutterWidth}ch` }}
                >
                  {dropped + i + 1}
                </span>
              ) : null}
              {spans.map((span, j) => {
                const attrs = spanAttrs(span.style)
                return attrs.className || attrs.style ? (
                  <span key={j} className={attrs.className} style={attrs.style}>
                    {span.text}
                  </span>
                ) : (
                  // Unstyled runs are emitted as bare text. Most of a log is unstyled, and one
                  // span per run of plain output would double the size of the markup for nothing.
                  <React.Fragment key={j}>{span.text}</React.Fragment>
                )
              })}
              {i < shown.length - 1 ? "\n" : null}
            </React.Fragment>
          ))}
        </pre>
      </div>
    )
  }
)
AnsiLog.displayName = "AnsiLog"
