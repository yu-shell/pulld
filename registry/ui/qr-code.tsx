import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * How much of the code can be destroyed and still read: roughly 7%, 15%, 25% and 30%.
 *
 * The instinct is that higher is simply better. It is not free — the correction lives in the same
 * grid as the data, so raising the level on a payload that already nearly fills a version pushes it
 * to a larger one, and a larger version means smaller modules at the same printed size, which is
 * itself a reason codes fail to scan. `"M"` is the working default. Go to `"Q"` or `"H"` only when
 * something is going to happen to the code — a logo dropped in the middle, a label that will be
 * handled, a screen that will be photographed at an angle — and let it grow.
 */
export type ErrorCorrectionLevel = "L" | "M" | "Q" | "H"

/** The three ways a payload can be packed. Chosen for you; exposed because the result names it. */
export type QrMode = "numeric" | "alphanumeric" | "byte"

/** A finished code: the grid, and the parameters that produced it. */
export interface QrMatrix {
  /** Modules per side, always `4 * version + 17`. Excludes the quiet zone. */
  size: number
  /** 1–40. Larger holds more and draws finer. */
  version: number
  /** The level actually used, which `boost` may have raised above the one requested. */
  errorCorrection: ErrorCorrectionLevel
  /** 0–7. The pattern XORed over the data to break up runs and blocks. */
  mask: number
  /** How the payload was packed. */
  mode: QrMode
  /** `modules[y][x]` — true is a dark module. Row-major, origin top-left. */
  modules: boolean[][]
}

// --- the spec's two tables -------------------------------------------------------------------------
//
// Everything else about a version is computed below rather than tabulated. These two cannot be: they
// are the block structure chosen by ISO/IEC 18004 for each version and level, and they are simply
// facts to be looked up. Index 0 is padding so that the version can index directly.

const EC_CODEWORDS_PER_BLOCK: Record<ErrorCorrectionLevel, readonly number[]> = {
  //  0  1   2   3   4   5   6   7   8   9  10  11  12  13  14  15  16  17  18  19  20  21  22  23  24  25  26  27  28  29  30  31  32  33  34  35  36  37  38  39  40
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
}

const EC_BLOCKS: Record<ErrorCorrectionLevel, readonly number[]> = {
  //  0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
}

/** The five bits `aria`-invisible to everything but a scanner: the level's own code in the format info. */
const FORMAT_EC_BITS: Record<ErrorCorrectionLevel, number> = { L: 1, M: 0, Q: 3, H: 2 }

const EC_LEVELS: readonly ErrorCorrectionLevel[] = ["L", "M", "Q", "H"]

export const MIN_QR_VERSION = 1
export const MAX_QR_VERSION = 40

/** The 45 characters alphanumeric mode can pack two-to-eleven-bits. Note: upper case only. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:"

/**
 * Modules in the grid that are not function patterns, before error correction is taken out.
 *
 * Computed rather than tabulated. The area is the square, less the three finder patterns with their
 * separators and the format information beside them, less the two timing lines, less the alignment
 * patterns (which overlap the timing lines, hence the correction), less the version blocks from 7 up.
 */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Total codewords in the version, data and error correction together. */
function totalCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8)
}

/** Codewords left for the payload once error correction has taken its share. */
function dataCodewords(version: number, ecl: ErrorCorrectionLevel): number {
  return totalCodewords(version) - EC_CODEWORDS_PER_BLOCK[ecl][version] * EC_BLOCKS[ecl][version]
}

/**
 * Where the alignment patterns go, as coordinates that apply to both axes.
 *
 * The spec prints this as a table of forty rows and it is reproducible as arithmetic, with exactly
 * one exception at version 32 — which is why the exception is written out rather than smoothed over:
 * every generator that "simplified" the formula and dropped it produces a version 32 code that no
 * reader will touch, and version 32 is rare enough that nobody notices until a payload happens to
 * land on it.
 */
function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const size = version * 4 + 17
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos)
  return positions.sort((a, b) => a - b)
}

// --- GF(256) and Reed–Solomon ------------------------------------------------------------------------
//
// The error correction is a Reed–Solomon code over the field with 256 elements, which is what lets a
// scanner read a code through a thumb, a crease or a coffee ring. Bytes are field elements; addition
// is XOR; multiplication is carry-less multiplication reduced modulo the field's primitive polynomial
// x^8 + x^4 + x^3 + x^2 + 1.

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    // Double, and fold back into the field whenever doubling has pushed a bit out of the top.
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** Coefficients of the divisor polynomial for `degree` correction bytes, highest power first. */
function generatorPolynomial(degree: number): Uint8Array {
  // Starts as the constant 1 and is multiplied by (x - r) for successive powers r of the generator
  // element 2. Stored without its leading coefficient, which is always 1.
  const result = new Uint8Array(degree)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root)
      if (j + 1 < degree) result[j] ^= result[j + 1]
    }
    root = gfMultiply(root, 2)
  }
  return result
}

/** The correction bytes for one block: the remainder of the data divided by the generator. */
function remainderBytes(data: Uint8Array, generator: Uint8Array): Uint8Array {
  const result = new Uint8Array(generator.length)
  for (const byte of data) {
    const factor = byte ^ result[0]
    result.copyWithin(0, 1)
    result[result.length - 1] = 0
    for (let i = 0; i < result.length; i++) result[i] ^= gfMultiply(generator[i], factor)
  }
  return result
}

// --- packing the payload -----------------------------------------------------------------------------

function isNumeric(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return value.length > 0
}

function isAlphanumeric(value: string): boolean {
  for (const char of value) if (!ALPHANUMERIC.includes(char)) return false
  return value.length > 0
}

/**
 * The mode that packs `value` smallest.
 *
 * Numeric fits three digits into ten bits and alphanumeric two characters into eleven, against eight
 * bits per byte otherwise — so a phone number or a ticket reference of the same length can land two
 * or three versions lower, which is the difference between a code that scans across a room and one
 * that does not. The catch, and the reason a "this looks alphanumeric" guess written by hand keeps
 * producing unreadable codes: alphanumeric mode has no lower case and only nine punctuation marks.
 * `HTTPS://EXAMPLE.COM` qualifies and `https://example.com` does not, so nearly every URL is byte
 * mode and must be.
 */
function pickMode(value: string): QrMode {
  if (isNumeric(value)) return "numeric"
  if (isAlphanumeric(value)) return "alphanumeric"
  return "byte"
}

/** Bits in the character-count field, which widens twice as versions grow. */
function countBits(mode: QrMode, version: number): number {
  const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2
  if (mode === "numeric") return [10, 12, 14][tier]
  if (mode === "alphanumeric") return [9, 11, 13][tier]
  return [8, 16, 16][tier]
}

/** The unit `countBits` counts: digits, characters, or bytes after UTF-8 encoding. */
function unitCount(mode: QrMode, value: string, bytes: Uint8Array): number {
  return mode === "byte" ? bytes.length : value.length
}

function payloadBits(mode: QrMode, count: number): number {
  if (mode === "numeric") return 10 * Math.floor(count / 3) + [0, 4, 7][count % 3]
  if (mode === "alphanumeric") return 11 * Math.floor(count / 2) + 6 * (count % 2)
  return 8 * count
}

class BitBuffer {
  readonly bits: number[] = []

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1)
  }
}

function writeSegment(buffer: BitBuffer, mode: QrMode, value: string, bytes: Uint8Array): void {
  if (mode === "numeric") {
    for (let i = 0; i < value.length; i += 3) {
      const chunk = value.slice(i, i + 3)
      buffer.append(Number(chunk), chunk.length * 3 + 1)
    }
    return
  }
  if (mode === "alphanumeric") {
    let i = 0
    for (; i + 2 <= value.length; i += 2) {
      buffer.append(ALPHANUMERIC.indexOf(value[i]) * 45 + ALPHANUMERIC.indexOf(value[i + 1]), 11)
    }
    if (i < value.length) buffer.append(ALPHANUMERIC.indexOf(value[i]), 6)
    return
  }
  for (const byte of bytes) buffer.append(byte, 8)
}

const MODE_INDICATOR: Record<QrMode, number> = { numeric: 1, alphanumeric: 2, byte: 4 }

/**
 * Data codewords for one version and level: the payload, terminated, padded, and split into blocks
 * with correction bytes appended, then interleaved back into the single stream the grid is filled
 * from.
 *
 * The interleaving is the part worth stating plainly, because it is invisible in the output and
 * silent when wrong. From version 3 the codewords are cut into several blocks that are corrected
 * independently, and they are not written into the grid one block after another — a byte is taken
 * from each block in turn. That is the whole reason a code survives a coffee ring: physical damage
 * lands on one region of the grid, and interleaving spreads that region across every block so no
 * single block takes more errors than it can correct. Written block-by-block instead, the code still
 * scans perfectly while it is clean, and stops scanning the first time anything touches it.
 */
function assembleCodewords(
  bits: number[],
  version: number,
  ecl: ErrorCorrectionLevel
): Uint8Array {
  const capacity = dataCodewords(version, ecl) * 8
  const padded = bits.slice()
  // Terminator, then out to a byte boundary, then the two alternating pad codewords the spec names.
  for (let i = 0; i < 4 && padded.length < capacity; i++) padded.push(0)
  while (padded.length % 8 !== 0) padded.push(0)
  for (let pad = 0xec; padded.length < capacity; pad ^= 0xec ^ 0x11) {
    for (let i = 7; i >= 0; i--) padded.push((pad >>> i) & 1)
  }

  const data = new Uint8Array(padded.length / 8)
  for (let i = 0; i < padded.length; i++) data[i >>> 3] |= padded[i] << (7 - (i & 7))

  const blockCount = EC_BLOCKS[ecl][version]
  const ecLength = EC_CODEWORDS_PER_BLOCK[ecl][version]
  const rawCount = totalCodewords(version)
  const shortBlocks = blockCount - (rawCount % blockCount)
  const shortLength = Math.floor(rawCount / blockCount)
  const generator = generatorPolynomial(ecLength)

  const blocks: { data: Uint8Array; ec: Uint8Array }[] = []
  for (let i = 0, offset = 0; i < blockCount; i++) {
    const length = shortLength - ecLength + (i < shortBlocks ? 0 : 1)
    const chunk = data.subarray(offset, offset + length)
    offset += length
    blocks.push({ data: chunk, ec: remainderBytes(chunk, generator) })
  }

  const result = new Uint8Array(rawCount)
  let at = 0
  const longest = shortLength - ecLength + 1
  for (let i = 0; i < longest; i++) {
    for (const block of blocks) if (i < block.data.length) result[at++] = block.data[i]
  }
  for (let i = 0; i < ecLength; i++) {
    for (const block of blocks) result[at++] = block.ec[i]
  }
  return result
}

// --- drawing the grid ---------------------------------------------------------------------------------

const MASK_FUNCTIONS: readonly ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly reserved: boolean[][]

  constructor(readonly version: number, readonly ecl: ErrorCorrectionLevel) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark
    this.reserved[y][x] = true
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)

    const positions = alignmentPositions(this.version)
    const last = positions.length - 1
    for (let i = 0; i <= last; i++) {
      for (let j = 0; j <= last; j++) {
        // The three corners are already finder patterns; an alignment pattern there would erase one.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
        this.drawAlignment(positions[i], positions[j])
      }
    }

    // Reserves the format area as well as filling it; the real bits are written once a mask is chosen.
    this.drawFormatBits(0)
    this.drawVersionBits()
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || x >= this.size || y < 0 || y >= this.size) continue
        const ring = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunction(x, y, ring !== 2 && ring !== 4)
      }
    }
  }

  private drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  /**
   * The fifteen format bits, twice.
   *
   * Two copies, in two corners, because these fifteen bits say which mask was applied and at which
   * level — without them the grid cannot be unmasked and nothing else in it can be read. They carry
   * their own BCH correction and are then XORed with a fixed pattern, which is what stops an all-zero
   * choice (level M, mask 0) from producing a blank region that a scanner would read as background.
   */
  drawFormatBits(mask: number): void {
    const data = (FORMAT_EC_BITS[this.ecl] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = (((data << 10) | rem) ^ 0x5412) & 0x7fff
    const bit = (i: number) => ((bits >>> i) & 1) !== 0

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i))
    this.setFunction(8, 7, bit(6))
    this.setFunction(8, 8, bit(7))
    this.setFunction(7, 8, bit(8))
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i))

    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i))
    // Always dark, in every code ever made, and a scanner uses it to orient itself.
    this.setFunction(8, this.size - 8, true)
  }

  private drawVersionBits(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, dark)
      this.setFunction(b, a, dark)
    }
  }

  /**
   * Pours the codewords into everything the function patterns left over.
   *
   * Two modules wide, starting at the bottom right, snaking up and then down and skipping the sixth
   * column outright because the vertical timing line lives there. Getting the turn wrong produces a
   * grid that looks entirely plausible and decodes to nothing.
   */
  drawCodewords(data: Uint8Array): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (this.reserved[y][x] || i >= data.length * 8) continue
          this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
          i++
        }
      }
    }
  }

  /** XORs the mask over the data modules only. Applying it twice puts the grid back. */
  applyMask(mask: number): void {
    const fn = MASK_FUNCTIONS[mask]
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.reserved[y][x] && fn(x, y)) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  /**
   * The spec's four penalties, low is better.
   *
   * A mask is not decoration and not a hash of the content: it exists so that the data region does
   * not accidentally grow long runs, large blocks, or something shaped like a finder pattern, any of
   * which makes a scanner lose the grid. All eight are tried and the least bad is kept, which is why
   * two codes for nearly identical text can look completely different.
   */
  penalty(): number {
    const n = this.size
    let score = 0

    for (let y = 0; y < n; y++) {
      for (const horizontal of [true, false]) {
        let runColor = false
        let runLength = 0
        for (let i = 0; i < n; i++) {
          const dark = horizontal ? this.modules[y][i] : this.modules[i][y]
          if (dark === runColor) {
            runLength++
            if (runLength === 5) score += 3
            else if (runLength > 5) score += 1
          } else {
            runColor = dark
            runLength = 1
          }
        }
      }
    }

    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.modules[y][x]
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          score += 3
        }
      }
    }

    // 1:1:3:1:1 with four light modules on one side — the proportions of a finder pattern. A scanner
    // that finds one of these in the data has been told the code is somewhere it is not.
    const FINDER = [true, false, true, true, true, false, true]
    const matches = (read: (i: number) => boolean, i: number): boolean => {
      for (let k = 0; k < 7; k++) if (read(i + k) !== FINDER[k]) return false
      const before = [-4, -3, -2, -1].every((d) => i + d < 0 || !read(i + d))
      const after = [7, 8, 9, 10].every((d) => i + d >= n || !read(i + d))
      return before || after
    }
    for (let line = 0; line < n; line++) {
      const row = (i: number) => this.modules[line][i]
      const column = (i: number) => this.modules[i][line]
      for (let i = 0; i + 7 <= n; i++) {
        if (matches(row, i)) score += 40
        if (matches(column, i)) score += 40
      }
    }

    let dark = 0
    for (const row of this.modules) for (const cell of row) if (cell) dark++
    const total = n * n
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10

    return score
  }
}

// --- the public encoder ---------------------------------------------------------------------------------

export interface EncodeQrOptions {
  /** Defaults to `"M"`. May be raised by `boost`. */
  errorCorrection?: ErrorCorrectionLevel
  /**
   * Use the strongest level that still fits the chosen version, rather than exactly the one asked
   * for. Defaults to `true`.
   *
   * The grid is sized in whole versions, so a payload almost always leaves slack in the last one it
   * fits into — and that slack is only ever spent on padding bytes otherwise. Spending it on error
   * correction instead costs nothing: the code is the same size, drawn at the same scale, and
   * survives more damage. Turn it off only when something downstream depends on the level being
   * exactly what was requested.
   */
  boost?: boolean
  /**
   * Smallest version to consider, 1–40. Defaults to 1.
   *
   * Worth setting for a code whose payload changes while it is on screen — a rotating token, a
   * cart total, a field someone is typing into. Left at 1, the grid changes size the moment the
   * text crosses a capacity boundary, so the code visibly jumps and rescales mid-scan.
   */
  minVersion?: number
  /** Largest version to consider, 1–40. Defaults to 40. */
  maxVersion?: number
  /** Force a mask 0–7 instead of scoring all eight. For tests and reproducible output. */
  mask?: number
}

/**
 * Encodes `value` into a grid of modules. Pure, synchronous, and dependency-free, so it runs the
 * same in a browser, on a server, in a worker, or in a test.
 *
 * Throws a `RangeError` when the text cannot be made to fit `maxVersion` at the requested level —
 * the one failure that is worth being loud about, since the alternative is a truncated code that
 * scans and gives back the wrong string.
 */
export function encodeQr(value: string, options: EncodeQrOptions = {}): QrMatrix {
  const {
    errorCorrection = "M",
    boost = true,
    minVersion = MIN_QR_VERSION,
    maxVersion = MAX_QR_VERSION,
    mask: forcedMask,
  } = options

  if (minVersion < MIN_QR_VERSION || maxVersion > MAX_QR_VERSION || minVersion > maxVersion) {
    throw new RangeError(`qr-code: version range ${minVersion}–${maxVersion} is outside 1–40`)
  }
  if (forcedMask !== undefined && (forcedMask < 0 || forcedMask > 7 || !Number.isInteger(forcedMask))) {
    throw new RangeError(`qr-code: mask must be an integer 0–7, got ${forcedMask}`)
  }

  const mode = pickMode(value)
  // UTF-8, with no ECI header in front of it. The spec's default byte encoding is ISO-8859-1 and
  // declaring UTF-8 properly would be an ECI segment — which the phone cameras people actually scan
  // with handle less reliably than they handle bare UTF-8, because bare UTF-8 is what every
  // generator has emitted for twenty years and every reader now sniffs for.
  const bytes = new TextEncoder().encode(value)
  const count = unitCount(mode, value, bytes)

  let version = 0
  let bits = 0
  for (let candidate = minVersion; candidate <= maxVersion; candidate++) {
    const needed = 4 + countBits(mode, candidate) + payloadBits(mode, count)
    if (needed <= dataCodewords(candidate, errorCorrection) * 8) {
      version = candidate
      bits = needed
      break
    }
  }
  if (version === 0) {
    const limit = Math.floor((dataCodewords(maxVersion, errorCorrection) * 8 - 4 - countBits(mode, maxVersion)) / 8)
    throw new RangeError(
      `qr-code: ${count} ${mode === "byte" ? "bytes" : "characters"} do not fit a version ${maxVersion} code at level ${errorCorrection} (about ${limit} bytes). Lower errorCorrection, or shorten the value — a long URL usually wants a redirect.`
    )
  }

  let level = errorCorrection
  if (boost) {
    for (const candidate of EC_LEVELS.slice(EC_LEVELS.indexOf(errorCorrection) + 1)) {
      if (bits <= dataCodewords(version, candidate) * 8) level = candidate
    }
  }

  const buffer = new BitBuffer()
  buffer.append(MODE_INDICATOR[mode], 4)
  buffer.append(count, countBits(mode, version))
  writeSegment(buffer, mode, value, bytes)

  const grid = new Grid(version, level)
  grid.drawFunctionPatterns()
  grid.drawCodewords(assembleCodewords(buffer.bits, version, level))

  let mask = forcedMask ?? 0
  if (forcedMask === undefined) {
    let best = Infinity
    for (let candidate = 0; candidate < 8; candidate++) {
      grid.applyMask(candidate)
      grid.drawFormatBits(candidate)
      const score = grid.penalty()
      if (score < best) {
        best = score
        mask = candidate
      }
      grid.applyMask(candidate)
    }
  }
  grid.applyMask(mask)
  grid.drawFormatBits(mask)

  return { size: grid.size, version, errorCorrection: level, mask, mode, modules: grid.modules }
}

/**
 * The dark modules as one SVG path, with the quiet zone folded into the coordinates.
 *
 * One path rather than a rectangle per module — a version 40 code is 31,329 modules and roughly half
 * of them are dark, and fifteen thousand `<rect>` elements is a document that takes longer to lay out
 * than the code took to encode. Runs along each row are merged into a single subpath for the same
 * reason.
 */
export function qrPath(matrix: QrMatrix, margin = 4): string {
  const parts: string[] = []
  for (let y = 0; y < matrix.size; y++) {
    let run = 0
    for (let x = 0; x <= matrix.size; x++) {
      const dark = x < matrix.size && matrix.modules[y][x]
      if (dark) {
        run++
        continue
      }
      if (run > 0) {
        parts.push(`M${x - run + margin} ${y + margin}h${run}v1h-${run}z`)
        run = 0
      }
    }
  }
  return parts.join("")
}

// --- payload builders for the two things people put in a code ----------------------------------------

export interface WifiPayloadOptions {
  ssid: string
  password?: string
  /** Defaults to `"WPA"` when a password is given and `"nopass"` when it is not. */
  security?: "WPA" | "WEP" | "nopass"
  /** Set for a network that does not broadcast its name. */
  hidden?: boolean
}

/**
 * The `WIFI:` string a phone camera offers to join a network from.
 *
 * Worth a function because of the escaping, which is where hand-built versions fail and fail
 * confusingly: the format separates its fields with `;` and `:`, so a password containing either —
 * and a generated one very often does — silently truncates the payload, and the person is left
 * typing in a password that the sign says is right. A value made only of hex digits is also quoted,
 * since the format allows a raw hex key and would otherwise read `1234abcd` as bytes rather than as
 * the eight characters somebody meant.
 */
export function wifiPayload({ ssid, password, security, hidden }: WifiPayloadOptions): string {
  const escape = (raw: string) => {
    const escaped = raw.replace(/([\\;,:"])/g, "\\$1")
    return /^[0-9a-fA-F]+$/.test(raw) ? `"${escaped}"` : escaped
  }
  const type = security ?? (password ? "WPA" : "nopass")
  const fields = [`T:${type}`, `S:${escape(ssid)}`]
  if (password && type !== "nopass") fields.push(`P:${escape(password)}`)
  if (hidden) fields.push("H:true")
  return `WIFI:${fields.join(";")};;`
}

export interface OtpauthUriOptions {
  /** The shared secret, base32, no padding. */
  secret: string
  /** Who the code belongs to — usually an email address or username. */
  account: string
  /** Your product's name. Shown as the heading in the authenticator app. */
  issuer?: string
  type?: "totp" | "hotp"
  algorithm?: "SHA1" | "SHA256" | "SHA512"
  digits?: number
  /** Seconds per code, `totp` only. */
  period?: number
  /** Starting counter, `hotp` only. */
  counter?: number
}

/**
 * The `otpauth://` URI an authenticator app enrols from.
 *
 * Two traps, both of which produce a code that enrols cleanly and then generates numbers the server
 * rejects. The issuer has to appear twice — once as a prefix on the label and once as a query
 * parameter — because different apps read different ones, and an app that finds only the label
 * prefix will still show the account under the right heading while one that reads only the parameter
 * will not. And the label is two components joined by a colon, so each half is escaped separately:
 * escaping the whole thing turns the separator into `%3A` and the account name becomes part of the
 * issuer, while escaping neither breaks on the first address containing a `+` or a space.
 */
export function otpauthUri({
  secret,
  account,
  issuer,
  type = "totp",
  algorithm,
  digits,
  period,
  counter,
}: OtpauthUriOptions): string {
  const label = issuer
    ? `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    : encodeURIComponent(account)
  const params = new URLSearchParams({ secret })
  if (issuer) params.set("issuer", issuer)
  if (algorithm) params.set("algorithm", algorithm)
  if (digits !== undefined) params.set("digits", String(digits))
  if (type === "totp" && period !== undefined) params.set("period", String(period))
  if (type === "hotp" && counter !== undefined) params.set("counter", String(counter))
  return `otpauth://${type}/${label}?${params.toString()}`
}

// --- the component -----------------------------------------------------------------------------------

// Encoding is pure, so the result can be shared between renders without a hook — which is the point.
// A component that reached for useMemo would need "use client", and this one has no state, no events
// and no effects: left as a plain function it renders on the server and ships no JavaScript at all
// for what is, after all, a static picture. Small and bounded, because the common case is one code on
// screen and the worst case is a payload that changes on every keystroke.
const CACHE_LIMIT = 24
const cache = new Map<string, QrMatrix>()

function encodeCached(value: string, options: EncodeQrOptions): QrMatrix {
  // The text goes last, after the five option fields. Those are an enum, a boolean, two numbers and
  // an optional number, none of which can contain the separator — so with the free-form text at the
  // end there is no pair of different inputs that can produce the same key, which in a cache would
  // mean handing back somebody else's code.
  const key = `${options.errorCorrection}|${options.boost}|${options.minVersion}|${options.maxVersion}|${options.mask}|${value}`
  const hit = cache.get(key)
  if (hit) return hit
  const matrix = encodeQr(value, options)
  cache.set(key, matrix)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return matrix
}

export interface QrCodeProps
  extends Omit<
      React.ComponentPropsWithoutRef<"svg">,
      // `mask` is taken over for the QR mask pattern below; SVG's own `mask` presentation attribute
      // would be a clipping reference, which is not something you want on a code anyway.
      "children" | "role" | "mask"
    >,
    EncodeQrOptions {
  /** The text the code carries. A URL, a `wifiPayload()`, an `otpauthUri()`, a reference number. */
  value: string
  /**
   * Light modules of quiet zone around the code. Defaults to 4, which is what the spec requires.
   *
   * The one setting that turns a correct code into an unreadable one without changing how it looks.
   * A scanner locates the code by finding its border, so a code butted against other content has no
   * border to find — it renders perfectly, it looks finished, and phones simply refuse to see it.
   * Nothing catches this except pointing a real camera at it, which is why the default is the
   * required value and why lowering it should mean the surface around it is already light and empty.
   */
  margin?: number
  /** What a screen reader announces. Defaults to `"QR code"`. */
  label?: string
  /**
   * Put the encoded text into that announcement. Defaults to `false`.
   *
   * Off, because the text is usually either useless read aloud — sixty characters of URL, letter by
   * letter — or actively wrong to speak, which is the case for the Wi-Fi password and the 2FA secret
   * that are the two things most often in a code. Give it a purposeful `label` instead, and put the
   * payload on the page as text somebody can select.
   */
  announceValue?: boolean
  /** Light modules on a dark ground. See the note on colour below before reaching for it. */
  invert?: boolean
  /** Overrides the dark modules' fill, e.g. `"fill-primary"`. */
  moduleClassName?: string
  /** Overrides the ground's fill. `"fill-transparent"` lets the surface behind show through. */
  backgroundClassName?: string
  /** Rendered instead when `value` is empty or too long to encode. Defaults to nothing. */
  fallback?: React.ReactNode
}

/**
 * A scannable QR code, drawn as SVG.
 *
 * ```tsx
 * <QrCode value="https://example.com/invite/8f2a" className="size-40" label="Invite link" />
 *
 * <QrCode value={wifiPayload({ ssid: "Cafe Guest", password: "hunter2;drop" })} errorCorrection="Q" />
 *
 * <QrCode
 *   value={otpauthUri({ issuer: "Acme", account: "ada@example.com", secret })}
 *   className="size-44"
 *   label="Scan with your authenticator app"
 * />
 * ```
 *
 * The encoder is here in this file — three packing modes, all four correction levels, versions 1 to
 * 40, Reed–Solomon over GF(256), and all eight masks scored — so the component has no dependencies
 * at all, not even an icon. `encodeQr` is exported for a code you want to draw yourself, rasterise on
 * a server, or put on a label.
 *
 * **It is SVG, not canvas, and that is an accessibility decision as much as a rendering one.** A
 * canvas is a bitmap: to anything that is not an eye it is a blank rectangle of the right size, and
 * it resamples badly the moment the code is scaled or printed. Vector modules stay exact at any size,
 * and the element can carry a role and a name. But naming it is not the same as making it usable —
 * a QR code is a thing you point a second device at, so for someone using a screen reader it is
 * generally not a route to anything. Put the payload on the page as well: a real link, or a code with
 * a copy button beside it. The `label` here says what the picture is; it cannot say it out loud in a
 * form anybody can act on.
 *
 * **The colours are functional, so they do not follow the theme by default.** Dark modules on a
 * light ground is what the format specifies and what decoders assume; inverted codes are read by
 * some phones, by fewer cheap scanners, and by no printer. So the ground is white and the modules
 * are black in both themes — which is what a boarding pass, a wallet app and a bank statement all do
 * in dark mode, and it reads as deliberate rather than broken. `moduleClassName` and
 * `backgroundClassName` are there for a themed code that you have tested with the readers your users
 * actually have; keep the contrast high and the modules the darker of the two.
 */
export function QrCode({
  value,
  errorCorrection = "M",
  boost = true,
  minVersion = MIN_QR_VERSION,
  maxVersion = MAX_QR_VERSION,
  mask,
  margin = 4,
  label = "QR code",
  announceValue = false,
  invert = false,
  moduleClassName,
  backgroundClassName,
  fallback = null,
  className,
  ...props
}: QrCodeProps) {
  let matrix: QrMatrix | null = null
  if (value) {
    try {
      matrix = encodeCached(value, { errorCorrection, boost, minVersion, maxVersion, mask })
    } catch {
      // Too long for maxVersion at this level. Rendering the fallback keeps a layout from collapsing
      // around a thrown error; call encodeQr directly if you would rather handle it yourself.
      matrix = null
    }
  }
  if (!matrix) return <>{fallback}</>

  const dimension = matrix.size + margin * 2

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${dimension} ${dimension}`}
      width={dimension}
      height={dimension}
      // Integer coordinates on a grid of squares: without this the browser antialiases every module
      // edge, and at small sizes the seams between adjacent rows show as pale lines through the code.
      shapeRendering="crispEdges"
      role="img"
      aria-label={announceValue ? `${label}: ${value}` : label}
      className={cn("max-w-full", className)}
      {...props}
    >
      {/* Drawn rather than left to the page, because the quiet zone has to be light for the code to
          be found at all — and a transparent one takes whatever colour the surface behind it is. */}
      <rect
        width={dimension}
        height={dimension}
        className={backgroundClassName ?? (invert ? "fill-black" : "fill-white")}
      />
      <path
        d={qrPath(matrix, margin)}
        className={moduleClassName ?? (invert ? "fill-white" : "fill-black")}
      />
    </svg>
  )
}
