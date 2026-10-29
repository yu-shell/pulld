import * as React from "react"

/**
 * The two one-dimensional symbologies here.
 *
 * `"code128"` holds any ASCII text and is what a warehouse, a ticket or a shipping label uses;
 * `"ean13"` holds exactly thirteen digits and is the barcode on retail packaging. They are not
 * interchangeable and nothing picks between them for you: the same thirteen digits are a valid
 * payload for both, and a Code 128 symbol carrying a retail number will not be accepted by a till.
 */
export type Symbology = "code128" | "ean13"

/** A finished symbol: the bar pattern, and the parameters that produced it. */
export interface Barcode {
  symbology: Symbology
  /**
   * The string the scanner will hand back. For `"ean13"` this is thirteen digits including the
   * check digit, which is not necessarily what was passed in — twelve digits in means the
   * thirteenth was computed here.
   */
  value: string
  /** `modules[i]` is true where a bar is dark. One module is the narrowest bar the symbol uses. */
  modules: boolean[]
  /** Light modules required either side before a scanner can find the symbol. */
  quietZone: number
  /**
   * Half-open module ranges whose bars are drawn longer than the rest.
   *
   * EAN-13's three guard patterns, which on a retail label drop below the data bars and frame the
   * two groups of digits. Empty for Code 128, which has no such convention.
   */
  guards: readonly (readonly [number, number])[]
  /** Code 128 only: the symbol values, start and check and stop included. */
  symbols?: number[]
  /** EAN-13 only: the thirteenth digit, computed or confirmed. */
  checkDigit?: number
}

// --- Code 128 --------------------------------------------------------------------------------------
//
// Each of the 107 symbol values is six elements wide — bar, space, bar, space, bar, space — and the
// widths always total 11 modules. The stop value is the exception, seven elements and 13 modules,
// which is how a scanner knows the symbol ended rather than guessing from a quiet zone it may not
// have been given.
//
// This table is the one thing in this file that cannot be derived, and a single wrong row here is
// invisible in the output: the symbol renders, prints, and is read as a different character or
// refused for a check digit that no longer adds up. Four structural facts hold for every row and are
// asserted in the test suite, which is cheap and catches the transcription mistakes that matter —
// every row totals 11 modules, every element is 1 to 4 modules, every row is distinct, and the three
// bars of every row sum to an even number. That last one is the format's own self-checking property,
// so a row that breaks it is not a row of Code 128 at all.

const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
] as const

/** Start values. Which one is used is a consequence of the packing chosen below, not a setting. */
const START_A = 103
const START_B = 104
const START_C = 105
const STOP = 106

/** Switch to the named set for everything that follows. The value depends on the set you are in. */
const TO_C_FROM_AB = 99
const TO_B = 100 // from A, and from C
const TO_A = 101 // from B, and from C
/** Borrow one character from the other set and come straight back. Same value in A and in B. */
const SHIFT = 98

/** The three packings, in the order ties are broken. B first: it holds the printable ASCII range. */
const CODE_SETS = ["B", "A", "C"] as const
export type Code128Set = (typeof CODE_SETS)[number]

const isDigit = (code: number) => code >= 48 && code <= 57

/**
 * The value that encodes one character in set A or B, or -1 if that set cannot hold it.
 *
 * A covers 0–95: the printable characters up to the backtick, plus the control characters, which it
 * reaches by mapping them above the printables rather than below. B covers 32–127, so it gains lower
 * case and loses the control characters. Every ASCII character is therefore in at least one of them,
 * and only `[\]^_` and the digits and capitals are in both.
 */
function valueInSet(code: number, set: "A" | "B"): number {
  if (set === "A") {
    if (code >= 32 && code <= 95) return code - 32
    if (code >= 0 && code <= 31) return code + 64
    return -1
  }
  if (code >= 32 && code <= 127) return code - 32
  return -1
}

/**
 * Pack `text` into the fewest symbols, by exhaustive search rather than by rule of thumb.
 *
 * Where to switch sets is the whole problem of encoding Code 128, and it is not a local decision.
 * Code C takes two digits per symbol, so a run of digits halves — but entering it costs a symbol and
 * leaving it costs another, which means a four-digit run inside text is a wash and a two-digit run is
 * a loss. The spec's recommended procedure is a set of lookahead rules that gets this nearly right;
 * the search below gets it exactly right for the same amount of code, by asking what the cheapest
 * encoding of the rest of the string is from each state and memoising the answer.
 *
 * Shortest matters beyond tidiness. Every symbol is 11 modules, so two wasted symbols on a label
 * printed at the usual density is about three millimetres of extra bar — the difference between a
 * symbol that fits the space the label stock gives it and one that is quietly scaled down until its
 * narrowest bar lands under the scanner's resolution.
 */
function packCode128(text: string): number[] {
  const n = text.length
  const codes: number[] = []
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i)
    if (code > 127) {
      throw new RangeError(
        `Code 128 holds ASCII only; ${JSON.stringify(text[i])} at index ${i} is U+${code
          .toString(16)
          .toUpperCase()
          .padStart(4, "0")}`,
      )
    }
    codes.push(code)
  }

  // best[i][set] — symbols needed to encode from i to the end, having arrived in `set`. The payload
  // only; the start, check and stop symbols are added by the caller and cost the same either way.
  const best = new Map<string, number>()
  const move = new Map<string, { emit: number[]; next: number; set: Code128Set }>()

  const solve = (i: number, set: Code128Set): number => {
    if (i >= n) return 0
    const key = `${i}${set}`
    const seen = best.get(key)
    if (seen !== undefined) return seen
    // Guard against the search re-entering the same state: a switch always consumes a character
    // before the next decision, so no cycle can form, but memoising a sentinel first keeps a future
    // edit from turning this into a hang rather than a wrong answer.
    best.set(key, Number.POSITIVE_INFINITY)

    let bestCost = Number.POSITIVE_INFINITY
    let bestMove: { emit: number[]; next: number; set: Code128Set } | null = null
    const consider = (cost: number, emit: number[], next: number, nextSet: Code128Set) => {
      if (cost >= bestCost) return
      bestCost = cost
      bestMove = { emit, next, set: nextSet }
    }

    // Stay where we are.
    if (set === "C") {
      if (i + 1 < n && isDigit(codes[i]) && isDigit(codes[i + 1])) {
        consider(1 + solve(i + 2, "C"), [Number(text.slice(i, i + 2))], i + 2, "C")
      }
    } else {
      const own = valueInSet(codes[i], set)
      if (own >= 0) consider(1 + solve(i + 1, set), [own], i + 1, set)
      // Borrow one character from the other letter set. Two symbols rather than the two a switch
      // costs plus the switch back, so this wins for exactly one odd character in a run.
      const other = set === "A" ? "B" : "A"
      const borrowed = valueInSet(codes[i], other)
      if (own < 0 && borrowed >= 0) {
        consider(2 + solve(i + 1, set), [SHIFT, borrowed], i + 1, set)
      }
    }

    // Or switch, and consume straight away in the set we land in. Switching without consuming is
    // never shorter, so it is not a move the search needs to represent.
    for (const target of CODE_SETS) {
      if (target === set) continue
      const to = target === "C" ? TO_C_FROM_AB : target === "A" ? TO_A : TO_B
      if (target === "C") {
        if (i + 1 < n && isDigit(codes[i]) && isDigit(codes[i + 1])) {
          consider(2 + solve(i + 2, "C"), [to, Number(text.slice(i, i + 2))], i + 2, "C")
        }
        continue
      }
      const value = valueInSet(codes[i], target)
      if (value >= 0) consider(2 + solve(i + 1, target), [to, value], i + 1, target)
    }

    best.set(key, bestCost)
    if (bestMove) move.set(key, bestMove)
    return bestCost
  }

  let startSet: Code128Set = "B"
  let startCost = Number.POSITIVE_INFINITY
  for (const set of CODE_SETS) {
    const cost = solve(0, set)
    if (cost < startCost) {
      startCost = cost
      startSet = set
    }
  }
  if (!Number.isFinite(startCost)) {
    // Unreachable for ASCII input, which every character already passed. Here so that a future
    // change to the sets fails loudly rather than emitting a symbol with characters missing.
    throw new RangeError("Code 128 cannot encode this text")
  }

  const symbols = [startSet === "A" ? START_A : startSet === "C" ? START_C : START_B]
  let at = 0
  let set = startSet
  while (at < n) {
    const step = move.get(`${at}${set}`)
    if (!step) throw new RangeError("Code 128 cannot encode this text")
    symbols.push(...step.emit)
    at = step.next
    set = step.set
  }
  return symbols
}

/**
 * The check symbol: the start value plus each payload value times its position, modulo 103.
 *
 * Weighted by position, so it catches two characters swapped — which an unweighted sum would not,
 * and which is the mistake a smudged or partly-read symbol most often produces. Position counts from
 * one at the first payload symbol; the start value is added unweighted.
 */
export function code128CheckSymbol(symbols: readonly number[]): number {
  let sum = symbols[0]
  for (let i = 1; i < symbols.length; i++) sum += symbols[i] * i
  return sum % 103
}

export interface EncodeCode128Result extends Barcode {
  symbology: "code128"
  symbols: number[]
}

/**
 * Encode `text` as Code 128, choosing the packing that produces the shortest symbol.
 *
 * Throws on an empty string and on anything outside ASCII — including the accented characters and
 * curly quotes that arrive from a spreadsheet, which is the common way a label pipeline fails. There
 * is a mechanism in the format for the upper half of Latin-1 (FNC4) but scanners disagree about it
 * to the point that the output is not dependable, so this declines rather than printing a symbol
 * that reads differently on different hardware.
 */
export function encodeCode128(text: string): EncodeCode128Result {
  if (!text) throw new RangeError("Code 128 needs at least one character")
  const payload = packCode128(text)
  const symbols = [...payload, code128CheckSymbol(payload), STOP]

  const modules: boolean[] = []
  for (const symbol of symbols) {
    const pattern = CODE128_PATTERNS[symbol]
    for (let e = 0; e < pattern.length; e++) {
      const width = Number(pattern[e])
      // Elements alternate, and every pattern starts with a bar. The stop value has seven of them
      // rather than six, which is why this reads the length of the pattern instead of assuming it.
      for (let w = 0; w < width; w++) modules.push(e % 2 === 0)
    }
  }

  return {
    symbology: "code128",
    value: text,
    modules,
    // Ten modules, which is the format's minimum and is specified as a multiple of the module rather
    // than a distance: print the same symbol smaller and the required margin shrinks with it.
    quietZone: 10,
    guards: [],
    symbols,
  }
}

// --- EAN-13 ----------------------------------------------------------------------------------------
//
// Ninety-five modules, fixed: a guard, six digits, a centre guard, six more digits, a guard. Every
// digit is seven modules wide, and that is the whole reason the symbology can carry thirteen digits
// in twelve digits' worth of space — the thirteenth is not drawn anywhere. It is encoded in the
// *parity* of the left six, each of which is printed from one of two alternative patterns, and the
// pattern of choices across those six positions spells out the first digit. Read the left half
// without reading its parity and you get a twelve-digit number from a thirteen-digit symbol, which
// is why a home-grown reader of these usually works on half the products in a shop.
//
// Only the odd-parity left patterns are tabulated. The other two sets are derived, because they are
// derivable and a derived table cannot drift out of step with the one it came from: the right-hand
// pattern of a digit is the bitwise complement of its left-hand one, and the even-parity left
// pattern is that complement reversed.

const EAN_LEFT_ODD = [
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
] as const

const complement = (pattern: string) => [...pattern].map((bit) => (bit === "1" ? "0" : "1")).join("")

/** The right half of the symbol. Even parity, and it starts with a bar where the left half starts with a space. */
const EAN_RIGHT = EAN_LEFT_ODD.map(complement)

/** The alternative left patterns. Even parity, same first-and-last-element rule as the odd ones. */
const EAN_LEFT_EVEN = EAN_RIGHT.map((pattern) => [...pattern].reverse().join(""))

/**
 * Which of the left six digits are drawn even-parity, per value of the first digit.
 *
 * `true` is even. A leading zero is six odd patterns, which is exactly what makes a UPC-A symbol and
 * an EAN-13 symbol beginning with zero the same picture — the twelve-digit American number and the
 * thirteen-digit international one are the same barcode, read by different conventions.
 */
const EAN_FIRST_DIGIT_PARITY = [
  "OOOOOO", "OOEOEE", "OOEEOE", "OOEEEO", "OEOOEE",
  "OEEOOE", "OEEEOO", "OEOEOE", "OEOEEO", "OEEOEO",
] as const

const EAN_START_GUARD = "101"
const EAN_CENTRE_GUARD = "01010"
const EAN_END_GUARD = "101"

/**
 * The thirteenth digit of an EAN-13, from the first twelve.
 *
 * Positions alternate weight one and three from the left. Weighting is what makes it catch a
 * transposition: with every digit weighted the same, swapping two of them leaves the sum untouched,
 * and two digits swapped is precisely what happens when a number is read off a box by hand.
 */
export function ean13CheckDigit(digits: string): number {
  if (!/^\d{12}$/.test(digits)) throw new RangeError("EAN-13's check digit is computed from exactly 12 digits")
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}

export interface EncodeEan13Result extends Barcode {
  symbology: "ean13"
  checkDigit: number
}

/**
 * Encode twelve or thirteen digits as EAN-13.
 *
 * Twelve digits in means the check digit is computed and appended. Thirteen means it is *verified*,
 * and a mismatch throws rather than being corrected: a number typed or pasted with one digit wrong
 * is a real product somewhere, and silently repairing the check digit would print a symbol that
 * scans perfectly as the wrong item. The thrown message carries the digit that was expected, which
 * is the one piece of information needed to tell a typo from a bad check digit in the source data.
 *
 * Spaces and hyphens are accepted and ignored, because the numbers arrive grouped the way they are
 * printed. Nothing else is: a leading `+` or a decimal point means the value went through something
 * that treated it as a number, and the digits can no longer be trusted.
 */
export function encodeEan13(input: string): EncodeEan13Result {
  const digits = input.replace(/[\s-]/g, "")
  if (!/^\d{12,13}$/.test(digits)) {
    throw new RangeError(`EAN-13 needs 12 or 13 digits; got ${JSON.stringify(input)}`)
  }
  const body = digits.slice(0, 12)
  const check = ean13CheckDigit(body)
  if (digits.length === 13 && Number(digits[12]) !== check) {
    throw new RangeError(`EAN-13 check digit for ${body} is ${check}, not ${digits[12]}`)
  }
  const value = body + check

  const parity = EAN_FIRST_DIGIT_PARITY[Number(value[0])]
  let bits = EAN_START_GUARD
  for (let i = 0; i < 6; i++) {
    const digit = Number(value[i + 1])
    bits += parity[i] === "E" ? EAN_LEFT_EVEN[digit] : EAN_LEFT_ODD[digit]
  }
  bits += EAN_CENTRE_GUARD
  for (let i = 0; i < 6; i++) bits += EAN_RIGHT[Number(value[i + 7])]
  bits += EAN_END_GUARD

  return {
    symbology: "ean13",
    value,
    modules: [...bits].map((bit) => bit === "1"),
    // Eleven, which is the wider of the two margins the standard asks for and is applied to both
    // sides here. The left one has to be wider because the first digit is printed in it.
    quietZone: 11,
    guards: [
      [0, EAN_START_GUARD.length],
      [45, 50],
      [92, 95],
    ],
    checkDigit: check,
  }
}

// --- drawing ---------------------------------------------------------------------------------------

export interface EncodeBarcodeOptions {
  symbology?: Symbology
}

/** Encode by symbology. Throws for a payload the symbology cannot carry; see the two encoders. */
export function encodeBarcode(value: string, { symbology = "code128" }: EncodeBarcodeOptions = {}): Barcode {
  return symbology === "ean13" ? encodeEan13(value) : encodeCode128(value)
}

export interface BarcodePathOptions {
  /** Width of one module. Whole numbers only if the result is going to be printed; see the note on the component. */
  moduleWidth: number
  /** Height of the data bars. */
  height: number
  /** How much further the guard bars run, in user units. Zero for a symbology with no guards. */
  guardDrop?: number
  /**
   * Light modules to offset the bars by. Defaults to what the symbology requires.
   *
   * It has to be the same number the surrounding canvas was sized with. Drawing the bars at the
   * symbology's own margin while the canvas is measured from a wider or narrower one puts the
   * symbol off centre, and at the narrow end puts its stop pattern outside the viewBox — where it
   * is clipped away, leaving a symbol that looks complete and ends in the middle of a character.
   */
  quietZone?: number
}

/**
 * One SVG path for every bar in the symbol.
 *
 * Adjacent dark modules are merged into a single rectangle first. Drawn one module at a time they
 * would meet along edges that the renderer antialiases, and a hairline of background colour down the
 * middle of a wide bar is exactly the kind of artefact a cheap laser scanner reports as two bars.
 */
export function barcodePath(
  barcode: Barcode,
  { moduleWidth, height, guardDrop = 0, quietZone = barcode.quietZone }: BarcodePathOptions,
): string {
  const extended = (index: number) => barcode.guards.some(([from, to]) => index >= from && index < to)
  const parts: string[] = []
  let run = 0
  while (run < barcode.modules.length) {
    if (!barcode.modules[run]) {
      run++
      continue
    }
    // A run is broken where the bar's height changes as well as where it ends, so that a guard bar
    // never merges with the data bar beside it.
    const tall = extended(run)
    let end = run + 1
    while (end < barcode.modules.length && barcode.modules[end] && extended(end) === tall) end++
    const x = (quietZone + run) * moduleWidth
    const width = (end - run) * moduleWidth
    const barHeight = tall ? height + guardDrop : height
    parts.push(`M${x} 0h${width}v${barHeight}h-${width}z`)
    run = end
  }
  return parts.join("")
}

// --- the component ---------------------------------------------------------------------------------

// Encoding is pure, so a result can be shared between renders without a hook — which is the point. A
// component reaching for useMemo would need "use client", and this one has no state, no events and
// no effects: left as a plain function it renders on the server and ships no JavaScript at all for
// what is a static picture. Bounded, because the common case is a handful of symbols on a label sheet
// and the worst case is a field someone is typing a product number into.
const CACHE_LIMIT = 32
const cache = new Map<string, Barcode>()

function encodeCached(value: string, symbology: Symbology): Barcode {
  const key = `${symbology}|${value}`
  const hit = cache.get(key)
  if (hit) return hit
  const barcode = encodeBarcode(value, { symbology })
  cache.set(key, barcode)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return barcode
}

/** The printed digits of an EAN-13, in the groups the standard prints them in. */
const groupEan13 = (value: string) => [value.slice(0, 1), value.slice(1, 7), value.slice(7)] as const

const isPrintableAscii = (text: string) => /^[\x20-\x7e]*$/.test(text)

export interface BarcodeProps
  extends Omit<
    React.ComponentPropsWithoutRef<"svg">,
    // `width` and `height` are taken over below: a barcode's size is not a free choice of two
    // numbers, it is a module width and a bar height, and the overall size follows from them.
    "children" | "role" | "width" | "height"
  > {
  /** Code 128: any ASCII text. EAN-13: twelve or thirteen digits, grouping characters allowed. */
  value: string
  /** Defaults to `"code128"`. Never inferred from the payload — see the note below. */
  symbology?: Symbology
  /**
   * Width of the narrowest bar, in pixels. Defaults to 2.
   *
   * The one number that decides whether the symbol can be read, and the reason this component does
   * not scale itself to its container. A scanner resolves the narrowest element or it resolves
   * nothing, so a symbol laid out at 2px per module and then fitted into a card 70% as wide is not a
   * smaller barcode, it is a broken one — and it still looks perfect. Whole numbers only: at 1.5px a
   * module every other bar lands on a half pixel and the renderer spreads it over two, which turns
   * the width ratios the decoder measures into something between 1:2 and 1:3.
   */
  moduleWidth?: number
  /**
   * Height of the data bars, in pixels. Defaults to 60.
   *
   * Guard bars and the printed digits are added below this, so the element is taller than this
   * number for an EAN-13 or whenever the digits are shown. Height is not free either: a scanner
   * sweeping at an angle crosses a short symbol's bars diagonally and reads the wrong widths, which
   * is why retail symbols are as tall as they are.
   */
  height?: number
  /** Light modules either side. Defaults to what the symbology requires — 10 for Code 128, 11 for EAN-13. */
  quietZone?: number
  /**
   * Print the value below the bars. Defaults to true.
   *
   * For EAN-13 this is the standard layout and not decoration: the first digit sits outside the
   * symbol on the left, the other two groups of six sit under their own halves, and the guard bars
   * drop between them. It is what lets a cashier key the number in when the symbol will not scan,
   * which is the one moment it matters.
   */
  showText?: boolean
  /**
   * Print this instead of the value.
   *
   * For a payload that is not meant to be read as it is encoded — a Code 128 symbol carrying control
   * characters, or a number a person should see grouped. Note that a line which disagrees with the
   * bars is a real hazard on a label, so this is for formatting the same information, not for
   * labelling the symbol with something else.
   */
  text?: string
  /** What a screen reader announces. Defaults to `"Barcode"`. */
  label?: string
  /**
   * Include the value in that announcement. Defaults to true.
   *
   * The opposite default to a QR code, deliberately. What a 1D symbol carries is almost always a
   * short identifier somebody may need to say out loud or type — a product number, an asset tag, a
   * ticket reference — rather than a URL or a secret, and an EAN-13 is announced in its printed
   * groups so that it is read as digits rather than as one enormous number.
   */
  announceValue?: boolean
  /** Overrides the bars' fill, e.g. `"fill-foreground"`. Read the note on colour first. */
  barClassName?: string
  /** Overrides the ground's fill. `"fill-transparent"` lets the surface behind show through. */
  backgroundClassName?: string
  /** Overrides the printed line, for a different face or size. */
  textClassName?: string
  /** Rendered instead when the value cannot be encoded. Defaults to nothing. */
  fallback?: React.ReactNode
}

/**
 * A scannable one-dimensional barcode, drawn as SVG.
 *
 * ```tsx
 * <Barcode value="PKG-4417-A" />
 *
 * <Barcode value="4006381333931" symbology="ean13" />
 *
 * <Barcode value="0012345678905" symbology="ean13" moduleWidth={3} height={80} />
 * ```
 *
 * Both encoders are in this file — Code 128 in all three of its code sets with the switching solved
 * exactly, EAN-13 with its parity-encoded first digit — so there are no dependencies at all, not
 * even an icon. `encodeCode128`, `encodeEan13` and `barcodePath` are exported for a symbol you want
 * to rasterise on a server, send to a label printer, or draw yourself.
 *
 * **The symbology is a choice you have to make, and it is never guessed from the payload.** Thirteen
 * digits are a valid Code 128 payload and a valid EAN-13 one, and a component that quietly switched
 * would turn a shipping reference into a retail product code the first time one happened to be
 * thirteen digits long. Code 128 for anything of your own — orders, assets, tickets, locations.
 * EAN-13 only for a number issued by GS1 for a product that will cross a till.
 *
 * **It renders at its natural size and nothing here will shrink it to fit.** A barcode is read by
 * measuring its narrowest bar, so fitting one into a container is the single most common way a
 * symbol that looks finished turns out to be unreadable. Give it room, or raise `moduleWidth` and
 * give it more — and when it must go on paper, lay it out in whole pixels and print at the printer's
 * own resolution rather than letting a browser rescale it.
 *
 * **The colours are functional, so they do not follow the theme.** Decoders assume dark bars on a
 * light ground, and the margin either side has to be light for the symbol to be found at all, so the
 * ground is drawn white and the bars black in both themes — which is what a parcel label and a
 * boarding pass do in dark mode, and reads as deliberate rather than broken. `barClassName` and
 * `backgroundClassName` are there for a symbol you have tested with the hardware your users have;
 * keep the contrast high and the bars the darker of the two.
 *
 * It carries `role="img"` and a name, and reads the value out by default. But a barcode is a thing
 * another device points at, so for someone using a screen reader it is not a route to anything on
 * its own: put the number on the page as selectable text as well, which for an EAN-13 the printed
 * line already does.
 */
export function Barcode({
  value,
  symbology = "code128",
  moduleWidth = 2,
  height = 60,
  quietZone,
  showText = true,
  text,
  label = "Barcode",
  announceValue = true,
  barClassName,
  backgroundClassName,
  textClassName,
  fallback = null,
  className,
  ...props
}: BarcodeProps) {
  let barcode: Barcode | null = null
  if (value) {
    try {
      barcode = encodeCached(value, symbology)
    } catch {
      // An unencodable value renders the fallback rather than throwing, so one bad row in a label
      // sheet does not take the page with it. Call the encoders directly to handle it yourself —
      // which is what a print job should do, since a missing symbol is worth stopping for.
      barcode = null
    }
  }
  if (!barcode) return <>{fallback}</>

  const margin = quietZone ?? barcode.quietZone
  const modules = margin * 2 + barcode.modules.length
  const width = modules * moduleWidth

  // Guards drop five modules below the data bars, which is where the digits go: the drop is what
  // separates the two groups of six and marks the halves of the symbol.
  const guardDrop = barcode.guards.length ? 5 * moduleWidth : 0
  const fontSize = 7 * moduleWidth
  const textBand = showText ? 8 * moduleWidth : 0
  const totalHeight = height + Math.max(guardDrop, textBand)
  const baseline = height + 6.5 * moduleWidth

  const printed = text ?? barcode.value
  // A Code 128 payload with control characters in it has no honest printed form, so the line is
  // dropped rather than filled with the replacement glyphs the font happens to have — unless a
  // `text` was given, which is the way to say what it should read.
  const showLine = showText && (text !== undefined || isPrintableAscii(printed))
  const groups = barcode.symbology === "ean13" ? groupEan13(printed) : null

  // Grouped the way it is printed, so it is heard as digits rather than as one twelve-figure
  // number. A payload with control characters in it has no spoken form either, for the same reason
  // it has no printed one, so there the name stands on its own rather than carrying characters a
  // reader will voice as nothing at all.
  const announced = barcode.symbology === "ean13" ? groupEan13(barcode.value).join(" ") : barcode.value
  const name = announceValue && isPrintableAscii(announced) ? `${label}: ${announced}` : label

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${width} ${totalHeight}`}
      width={width}
      height={totalHeight}
      // Integer coordinates on a grid of rectangles: without this the renderer antialiases every
      // bar edge, and the grey half-pixel it leaves is read as part of the bar by some scanners and
      // as part of the space by others — which is the same as getting the widths wrong.
      shapeRendering="crispEdges"
      role="img"
      aria-label={name}
      className={className}
      {...props}
    >
      {/* Drawn rather than left to the page, because the quiet zone has to be light for the symbol
          to be found at all — and a transparent one takes the colour of whatever is behind it. */}
      <rect width={width} height={totalHeight} className={backgroundClassName ?? "fill-white"} />
      <path
        // `margin`, not the symbology's own quiet zone: the two have to agree, or the bars are
        // drawn from one origin inside a canvas measured from another.
        d={barcodePath(barcode, { moduleWidth, height, guardDrop, quietZone: margin })}
        className={barClassName ?? "fill-black"}
      />
      {showLine &&
        (groups ? (
          <>
            {/* The first digit is printed outside the symbol, in the left margin — which is part of
                why that margin is the wider of the two. */}
            <text
              x={(margin - 1) * moduleWidth}
              y={baseline}
              textAnchor="end"
              fontSize={fontSize}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              className={textClassName ?? barClassName ?? "fill-black"}
            >
              {groups[0]}
            </text>
            {/* Each group is stretched to span its own half of the symbol. Forcing the span rather
                than trusting a font's metrics is what keeps the digits under their own bars in a
                project whose mono face is not the one this was written against. */}
            <text
              x={(margin + 4) * moduleWidth}
              y={baseline}
              textLength={40 * moduleWidth}
              lengthAdjust="spacing"
              fontSize={fontSize}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              className={textClassName ?? barClassName ?? "fill-black"}
            >
              {groups[1]}
            </text>
            <text
              x={(margin + 51) * moduleWidth}
              y={baseline}
              textLength={40 * moduleWidth}
              lengthAdjust="spacing"
              fontSize={fontSize}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              className={textClassName ?? barClassName ?? "fill-black"}
            >
              {groups[2]}
            </text>
          </>
        ) : (
          <text
            x={width / 2}
            y={baseline}
            textAnchor="middle"
            fontSize={fontSize}
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            className={textClassName ?? barClassName ?? "fill-black"}
          >
            {printed}
          </text>
        ))}
    </svg>
  )
}
