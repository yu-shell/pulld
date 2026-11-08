"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The separators worth guessing between, in the order they are tried.
 *
 * Four, not "any single character": every extra candidate is another chance to win a tie against
 * the right answer on a file that happens to contain it. These four are what spreadsheets and
 * database exports actually emit — comma, the semicolon Excel writes in locales where the comma is
 * the decimal mark, tab, and the pipe that shows up in hand-rolled exports.
 */
export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const

export type CsvDelimiter = (typeof CSV_DELIMITERS)[number] | (string & {})

export interface CsvParseOptions {
  delimiter?: string
  /** The character that protects a cell. RFC 4180 says `"`; some exports use `'`. */
  quote?: string
  /** Stop after this many records. The rest of the text is not examined. */
  limit?: number
}

export interface CsvParseResult {
  rows: string[][]
  /** True when `limit` cut the read short, so this is a sample and not the file. */
  truncated: boolean
  /** True when the text ended inside a quoted cell — a sign of a wrong quote character or a cut file. */
  unterminatedQuote: boolean
}

/**
 * A resumable RFC 4180 reader.
 *
 * Resumable because of how a large file has to be read. A chunk boundary lands wherever the byte
 * offset says it does, which includes the middle of a quoted cell: slicing
 * `id,note\n1,"a,b\nc"\n2,ok` in half gives a first half of `id,note\n1,"` whose quote never closes,
 * so a parser that starts fresh on each chunk reads the second half as a different file. The quote
 * flag, the half-built cell and the half-built row therefore live across calls rather than inside
 * one.
 *
 * Splitting on newlines first is the thing this exists to avoid. In that same text the record count
 * is 3, and `text.split("\n")` returns 4 — the quoted newline inside `note` becomes a record
 * boundary, which puts every following row one column over. It is a file that opens without
 * complaint and is wrong from that row down.
 */
export function createCsvParser(options: CsvParseOptions = {}) {
  const delimiter = options.delimiter ?? ","
  const quote = options.quote ?? '"'

  let cell = ""
  let row: string[] = []
  let inQuotes = false
  /** True when the previous chunk ended on a CR, whose LF may be the first byte of this one. */
  let pendingCr = false
  /** True once a quote has opened this cell, so a quote after the closing one is literal text. */
  let quoted = false

  function endCell() {
    row.push(cell)
    cell = ""
    quoted = false
  }

  function endRow(out: string[][]) {
    endCell()
    out.push(row)
    row = []
  }

  return {
    /** Feeds one chunk of text and returns whatever records completed inside it. */
    push(chunk: string): string[][] {
      const out: string[][] = []
      for (let i = 0; i < chunk.length; i += 1) {
        const char = chunk[i]

        // A CRLF split across two chunks: the LF arriving first here is the tail of a line break
        // already acted on, not an empty record.
        if (pendingCr) {
          pendingCr = false
          if (char === "\n") continue
        }

        if (inQuotes) {
          if (char === quote) {
            if (chunk[i + 1] === quote) {
              cell += quote
              i += 1
            } else {
              inQuotes = false
            }
          } else {
            cell += char
          }
          continue
        }

        if (char === quote && cell === "") {
          inQuotes = true
          quoted = true
        } else if (char === delimiter) {
          endCell()
        } else if (char === "\n") {
          endRow(out)
        } else if (char === "\r") {
          pendingCr = true
          endRow(out)
        } else {
          cell += char
        }
      }
      return out
    },

    /** Closes the last record, if the text did not end on a line break. */
    end(): string[][] {
      const out: string[][] = []
      if (cell !== "" || row.length > 0 || quoted) endRow(out)
      return out
    },

    /** True while the reader is inside a quoted cell. */
    get open() {
      return inQuotes
    },
  }
}

/** Reads `text` into records. Blank trailing lines are dropped; a blank line in the middle is not. */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const limit = options.limit ?? Infinity
  const parser = createCsvParser(options)
  const rows: string[][] = []
  let truncated = false

  // Fed in slices rather than whole, so this function exercises the same boundary-crossing path the
  // chunked reader does. A parser only tested on one call is a parser only tested on easy input.
  const step = 4096
  for (let at = 0; at < text.length; at += step) {
    for (const record of parser.push(text.slice(at, at + step))) {
      if (rows.length >= limit) {
        truncated = true
        break
      }
      rows.push(record)
    }
    if (truncated) break
  }
  if (!truncated) {
    for (const record of parser.end()) {
      if (rows.length >= limit) {
        truncated = true
        break
      }
      rows.push(record)
    }
  }

  while (rows.length > 0) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === "") rows.pop()
    else break
  }

  return { rows, truncated, unterminatedQuote: parser.open }
}

export interface CsvShape {
  /** The most common record width. */
  columns: number
  /** The share of records that are that wide, 0 to 1. */
  agreement: number
  records: number
}

/** How rectangular `text` looks when read with `delimiter`. */
export function csvShape(
  text: string,
  delimiter: string,
  options: { quote?: string; sample?: number } = {}
): CsvShape {
  const { rows } = parseCsv(text, {
    delimiter,
    quote: options.quote,
    limit: options.sample ?? 20,
  })
  const real = rows.filter((row) => !(row.length === 1 && row[0].trim() === ""))
  if (real.length === 0) return { columns: 0, agreement: 0, records: 0 }

  const tally = new Map<number, number>()
  for (const row of real) tally.set(row.length, (tally.get(row.length) ?? 0) + 1)

  let columns = 0
  let hits = 0
  for (const [width, count] of tally) {
    if (count > hits || (count === hits && width > columns)) {
      columns = width
      hits = count
    }
  }
  return { columns, agreement: hits / real.length, records: real.length }
}

export interface DelimiterGuess {
  delimiter: string
  columns: number
  agreement: number
  /** False when the guess rests on one record, or on a file that came out one column wide. */
  confident: boolean
}

/**
 * Guesses the separator by reading the file with each candidate and keeping the one that comes out
 * rectangular.
 *
 * Counting occurrences in the first line is the obvious version and it is wrong in both directions.
 * It overcounts a separator that appears inside quoted data — `id,note` / `1,"a;b;c;d;e"` has five
 * semicolons and one comma per record, so counting picks the semicolon and the file reads as five
 * ragged columns — and it undercounts whenever the header is the one line with no quoting in it.
 *
 * Reading the file properly and scoring the result is therefore the method, but *how* it is scored
 * decided this: the first version here ranked by `columns * agreement`, which picked the semicolon
 * on that same file (5 columns at 0.5 agreement beats 2 at 1.0) and lost to naive counting on the
 * very case it was written for. Agreement has to come first and width only break ties, because a
 * wrong separator does not produce a narrower table — it produces a ragged one. With agreement
 * leading, all ten of the sample files measured against this, including both quoted-data traps and
 * a European file whose cells hold decimal commas, resolve to the separator they were written with.
 *
 * A one-column result is never returned as a guess, because that is the shape a wrong separator
 * makes: reading a semicolon file with a comma yields one column on every row and no error at all.
 * The file is not rejected — a single-column CSV is a real thing — but `confident` is false, which
 * is what puts the chooser in front of the reader instead of a silent decision.
 */
export function sniffDelimiter(
  text: string,
  options: { candidates?: readonly string[]; quote?: string; sample?: number } = {}
): DelimiterGuess {
  const candidates = options.candidates ?? CSV_DELIMITERS
  const fallback = candidates[0] ?? ","
  let best: DelimiterGuess | null = null

  for (const delimiter of candidates) {
    const shape = csvShape(text, delimiter, options)
    if (shape.columns < 2) continue
    const guess: DelimiterGuess = {
      delimiter,
      columns: shape.columns,
      agreement: shape.agreement,
      confident: shape.agreement >= 0.9 && shape.records >= 2,
    }
    if (
      best === null ||
      guess.agreement > best.agreement + 1e-9 ||
      (Math.abs(guess.agreement - best.agreement) < 1e-9 && guess.columns > best.columns)
    ) {
      best = guess
    }
  }

  if (best) return best
  const flat = csvShape(text, fallback, options)
  return {
    delimiter: fallback,
    columns: flat.columns,
    agreement: flat.agreement,
    confident: false,
  }
}

/**
 * Reads a prefix of `blob` as text, without pulling the whole file into memory.
 *
 * The decoder is kept across chunks and fed with `{ stream: true }`, which is not optional. A byte
 * slice cuts wherever it cuts, and a cut inside a multi-byte character is silent: measured, slicing
 * `名前,住所` at byte 8 — the second byte of `住` — and decoding that slice on its own yields
 * `"名前,�"`, a replacement character, with no exception thrown. A streaming decoder holds the
 * partial bytes back and the two halves rejoin to exactly the original text.
 *
 * The BOM is handled by not fighting the platform: `new TextDecoder("utf-8")` strips a leading
 * U+FEFF by default (`ignoreBOM` defaults to false), and that matters because `"﻿id" === "id"`
 * is false — a surviving BOM silently unmatches the first header against the field it belongs to.
 * It is stripped again below anyway, for the callers who hand over text they decoded themselves.
 */
export async function readCsvPreview(
  blob: Blob,
  options: {
    bytes?: number
    records?: number
    delimiter?: string
    quote?: string
    chunkBytes?: number
  } = {}
): Promise<{
  rows: string[][]
  truncated: boolean
  unterminatedQuote: boolean
  bytesRead: number
  delimiter: string
}> {
  const bytes = Math.max(1, options.bytes ?? 64 * 1024)
  const wanted = Math.max(1, options.records ?? 11)
  const chunkBytes = Math.max(1, options.chunkBytes ?? 16 * 1024)

  const head = blob.slice(0, Math.min(bytes, blob.size))
  const buffer = await head.arrayBuffer()
  const view = new Uint8Array(buffer)
  const decoder = new TextDecoder("utf-8")

  let text = ""
  for (let at = 0; at < view.length; at += chunkBytes) {
    text += decoder.decode(view.subarray(at, Math.min(at + chunkBytes, view.length)), {
      stream: true,
    })
  }
  text += decoder.decode()
  text = stripBom(text)

  const delimiter = options.delimiter ?? sniffDelimiter(text, { quote: options.quote }).delimiter
  const parsed = parseCsv(text, { delimiter, quote: options.quote, limit: wanted })

  // A prefix that ran out mid-record would otherwise contribute a short last row that looks like a
  // ragged file rather than like the edge of the window.
  const cutMidRecord = head.size < blob.size && !parsed.truncated
  const rows = cutMidRecord && parsed.rows.length > 1 ? parsed.rows.slice(0, -1) : parsed.rows

  return {
    rows,
    truncated: parsed.truncated || head.size < blob.size,
    unterminatedQuote: parsed.unterminatedQuote,
    bytesRead: head.size,
    delimiter,
  }
}

/** Removes a leading U+FEFF, which is not part of the first header's name. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export interface HeaderGuess {
  header: boolean
  /**
   * Always false. Kept as a field so the uncertainty is in the return type rather than in a comment
   * somebody has to find.
   */
  certain: false
  reason: string
}

/**
 * Guesses whether the first record is a header, and says so as a guess.
 *
 * This cannot be decided from the data, and the component shows a toggle because of it rather than
 * in spite of it. `Tokyo,Osaka,Kyoto` is a credible header and a credible first row of data, and
 * a sheet of monthly figures whose columns are `2026-01-01,2026-02-01,2026-03-01` has a header made
 * entirely of values. The only evidence that actually settles it runs one way: a first record whose
 * every cell reads as a number is not a header, because nobody names a column `42`. Everything else
 * is a lean, and the toggle is where the reader overrules it.
 */
export function looksLikeHeader(rows: readonly string[][]): HeaderGuess {
  const first = rows[0]
  if (!first || first.length === 0) {
    return { header: false, certain: false, reason: "There is no first record to read." }
  }

  const cells = first.map((cell) => cell.trim())
  if (cells.every((cell) => cell === "")) {
    return { header: false, certain: false, reason: "The first record is empty." }
  }
  if (cells.every((cell) => cell !== "" && isPlainNumber(cell))) {
    return {
      header: false,
      certain: false,
      reason: "Every cell in the first record is a number, so it reads as data.",
    }
  }

  const named = cells.filter((cell) => cell !== "").length
  const unique = new Set(cells.filter((cell) => cell !== "")).size
  if (unique < named) {
    return {
      header: true,
      certain: false,
      reason: "The first record repeats a name, which happens in headers more often than in data.",
    }
  }

  const rest = rows.slice(1)
  if (rest.length > 0) {
    // A column that is numeric below and not numeric on top is the ordinary shape of a header.
    let differs = 0
    for (let column = 0; column < first.length; column += 1) {
      const below = rest.map((row) => (row[column] ?? "").trim()).filter((cell) => cell !== "")
      if (below.length === 0) continue
      const belowNumeric = below.every((cell) => isPlainNumber(cell))
      const topNumeric = isPlainNumber(cells[column] ?? "")
      if (belowNumeric && !topNumeric) differs += 1
    }
    if (differs > 0) {
      return {
        header: true,
        certain: false,
        reason: `${differs} column${differs === 1 ? "" : "s"} hold numbers below a first cell that is not one.`,
      }
    }
  }

  return {
    header: true,
    certain: false,
    reason: "Assumed, because most exports carry a header. Change it if this file does not.",
  }
}

export type CsvValueKind = "text" | "number" | "integer" | "date" | "boolean"

/**
 * True for text that is a number somebody typed, which is narrower than `Number` accepts.
 *
 * Measured, `Number("")` and `Number(" ")` are both 0 — an empty cell in a quantity column becomes
 * the quantity zero, which is a value nobody entered and the single most expensive thing on this
 * list. `Number("0x10")` is 16, `Number("0b101")` is 5 and `Number("1e3")` is 1000; none of those is
 * something a person put in a spreadsheet, and all three would import as a number no one can trace.
 * `Infinity` and `NaN` parse too.
 *
 * `1,50` is refused on purpose rather than read as one and a half. In a semicolon-separated export
 * from a European locale that is a decimal comma, and in a comma-separated one it is a thousands
 * separator — the same four characters meaning two different numbers, decidable only by knowing
 * where the file came from. Guessing picks wrong for half the world, so the cell is reported as not
 * a number and the caller is left to say what its files mean.
 */
export function isPlainNumber(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === "") return false
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(trimmed)) return false
  return Number.isFinite(Number(trimmed))
}

export function isPlainInteger(text: string): boolean {
  const trimmed = text.trim()
  return /^[+-]?\d+$/.test(trimmed) && Number.isFinite(Number(trimmed))
}

/**
 * True only for an unambiguous ISO calendar date that is also a real day.
 *
 * `Date.parse` is the wrong instrument here three times over, each measured:
 *
 *   - `Date.parse("42")` is a valid date — the last day of 2041 in this timezone — and
 *     `Date.parse("1699")` is the first of January 1699. A column of quantities or short ids
 *     therefore reads as a column of dates, which is how a numeric field arrives as a timestamp.
 *   - `Date.parse("2026-02-30")` does not fail. It returns the 2nd of March: the overflow rolls
 *     forward silently, so "parses" is not the same question as "is a day".
 *   - `Date.parse("2026-11-08")` is midnight UTC while `Date.parse("2026/11/08")` is midnight local
 *     — nine hours apart where this was measured — so two spellings of one day land on two
 *     different instants, and `11/08` versus `08/11` cannot be told apart at all without knowing
 *     the file's convention.
 *
 * So the shape is matched first and then verified by rebuilding the date and checking the parts came
 * back unchanged, which is what rejects the 30th of February. Anything else — slashes, dots, month
 * names, day-first — is reported as text, and a caller who knows their files' convention converts
 * it themselves. Refusing to guess is the feature: a date guessed wrong is wrong by months.
 */
export function isPlainDate(text: string): boolean {
  const trimmed = text.trim()
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (!parts) return false
  const year = Number(parts[1])
  const month = Number(parts[2])
  const day = Number(parts[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const built = new Date(Date.UTC(year, month - 1, day))
  return (
    built.getUTCFullYear() === year &&
    built.getUTCMonth() === month - 1 &&
    built.getUTCDate() === day
  )
}

/** The spellings of yes and no that an export is likely to contain. */
const TRUTHY = new Set(["true", "yes", "y", "1", "t"])
const FALSY = new Set(["false", "no", "n", "0", "f"])

export function isPlainBoolean(text: string): boolean {
  const lower = text.trim().toLowerCase()
  return TRUTHY.has(lower) || FALSY.has(lower)
}

export function matchesKind(text: string, kind: CsvValueKind): boolean {
  switch (kind) {
    case "number":
      return isPlainNumber(text)
    case "integer":
      return isPlainInteger(text)
    case "date":
      return isPlainDate(text)
    case "boolean":
      return isPlainBoolean(text)
    default:
      return true
  }
}

export interface CsvCellProblem {
  /** The record's index in the rows that were checked, 0 being the first data record. */
  row: number
  value: string
}

export interface ColumnCheck {
  kind: CsvValueKind
  checked: number
  /** Cells that were blank. Blank is not a type error; it is a different thing to decide about. */
  empty: number
  problems: CsvCellProblem[]
}

/**
 * Checks one column's cells against a kind, and reports the rows that failed.
 *
 * Per row, not per column, because that is how the failure arrives. A column of a thousand dates
 * where three are `n/a` is not a text column and not a date column — it is a date column with three
 * rows to fix, and a check that answers only "is this column dates?" says no and hides the three
 * rows that are the entire problem. The row numbers are the output.
 *
 * `limit` caps how many are kept, since the point is to show the reader which rows to look at, and a
 * column that is wrong in ten thousand rows is wrong in a way the first few already demonstrate.
 */
export function checkColumn(
  values: readonly string[],
  kind: CsvValueKind,
  options: { limit?: number } = {}
): ColumnCheck {
  const limit = options.limit ?? 5
  const problems: CsvCellProblem[] = []
  let empty = 0

  values.forEach((value, row) => {
    if (value.trim() === "") {
      empty += 1
      return
    }
    if (!matchesKind(value, kind) && problems.length < limit) problems.push({ row, value })
  })

  return { kind, checked: values.length, empty, problems }
}

export interface ImportField {
  /** The key this field is written out under. */
  name: string
  label?: string
  required?: boolean
  kind?: CsvValueKind
  /** Extra header spellings that should match this field. */
  synonyms?: readonly string[]
}

/** Lowercases and drops everything that is not a letter or digit, so `First Name` meets `first_name`. */
export function normalizeHeader(text: string): string {
  return stripBom(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
}

/** A column index per field name, or null for "no column feeds this field". */
export type CsvMapping = Record<string, number | null>

/**
 * Suggests a column for each field by name, and leaves the rest alone.
 *
 * Exact normalised equality first, across every field, before any looser rule gets a turn — a
 * contains-match run field by field lets an early field take a column that a later field names
 * outright, and `name` swallowing `company_name` is the version of this bug that reaches
 * production. A column is claimed once; the second field that wants it is left unassigned for the
 * reader to settle, which is the whole reason the chooser is on screen.
 */
export function autoMatchFields(
  headers: readonly string[],
  fields: readonly ImportField[]
): CsvMapping {
  const normalised = headers.map(normalizeHeader)
  const taken = new Set<number>()
  const mapping: CsvMapping = {}
  for (const field of fields) mapping[field.name] = null

  const names = (field: ImportField) =>
    [field.name, field.label ?? "", ...(field.synonyms ?? [])]
      .map(normalizeHeader)
      .filter((name) => name !== "")

  for (const field of fields) {
    const wanted = names(field)
    const at = normalised.findIndex((header, index) => !taken.has(index) && wanted.includes(header))
    if (at !== -1) {
      mapping[field.name] = at
      taken.add(at)
    }
  }

  for (const field of fields) {
    if (mapping[field.name] !== null) continue
    const wanted = names(field)
    const at = normalised.findIndex(
      (header, index) =>
        !taken.has(index) &&
        header !== "" &&
        wanted.some((name) => header.includes(name) || name.includes(header))
    )
    if (at !== -1) {
      mapping[field.name] = at
      taken.add(at)
    }
  }

  return mapping
}

export interface MappingReport {
  /** Required fields with no column behind them. */
  missingRequired: string[]
  /** Optional fields with no column behind them. */
  missingOptional: string[]
  /** Column indices no field is reading. */
  ignoredColumns: number[]
  /** Column indices more than one field is reading, with the fields that share them. */
  reusedColumns: { column: number; fields: string[] }[]
  complete: boolean
}

/**
 * What is unresolved about a mapping, from both sides.
 *
 * Both sides, because the correspondence is not one-to-one in either direction and a screen that
 * reports only one half is the usual way an import loses data quietly. A file can carry columns
 * nobody asked for — an internal id, a legacy note, a column of empties — while required fields sit
 * empty, and both are true at once. Columns left out are listed rather than warned about: skipping
 * a column is a normal decision, and the reader only needs to be told it was taken. Required fields
 * left empty are the ones that block.
 *
 * Reuse is reported and not forbidden. One column feeding both `name` and `display_name` is a real
 * thing to want; the same column landing in `email` and `phone` is a mistake. Nothing here can tell
 * the two apart, so both are shown and neither is undone.
 */
export function mappingReport(
  mapping: CsvMapping,
  fields: readonly ImportField[],
  columnCount: number
): MappingReport {
  const missingRequired: string[] = []
  const missingOptional: string[] = []
  const byColumn = new Map<number, string[]>()

  for (const field of fields) {
    const column = mapping[field.name]
    if (column === null || column === undefined || column < 0 || column >= columnCount) {
      if (field.required) missingRequired.push(field.name)
      else missingOptional.push(field.name)
      continue
    }
    byColumn.set(column, [...(byColumn.get(column) ?? []), field.name])
  }

  const ignoredColumns: number[] = []
  for (let column = 0; column < columnCount; column += 1) {
    if (!byColumn.has(column)) ignoredColumns.push(column)
  }

  const reusedColumns = [...byColumn.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([column, names]) => ({ column, fields: names }))
    .sort((a, b) => a.column - b.column)

  return {
    missingRequired,
    missingOptional,
    ignoredColumns,
    reusedColumns,
    complete: missingRequired.length === 0,
  }
}

/**
 * Turns records into objects using the mapping.
 *
 * Strings out, always. Converting here would mean deciding what `1,50` and `08/11/2026` mean, which
 * is exactly what this file refuses to guess at; `matchesKind` says whether a cell is what the field
 * wants and the caller converts knowing their own locale. A field whose column is short on a
 * particular row gets `""` rather than `undefined`, so every object has every key and a `JSON.parse`
 * on the other end does not have to care which rows were ragged.
 */
export function applyMapping(
  rows: readonly string[][],
  mapping: CsvMapping,
  fields: readonly ImportField[]
): Record<string, string>[] {
  return rows.map((row) => {
    const out: Record<string, string> = {}
    for (const field of fields) {
      const column = mapping[field.name]
      out[field.name] =
        column === null || column === undefined ? "" : (row[column] ?? "")
    }
    return out
  })
}

export interface CsvColumnMapperMessages {
  delimiterLabel: string
  headerLabel: string
  previewCaption: (records: number, truncated: boolean) => string
  columnName: (index: number) => string
  /** Tells two columns of the same name apart in the chooser. */
  duplicateColumn: (name: string, index: number) => string
  ignore: string
  missingRequired: (fields: string[]) => string
  ignoredColumns: (names: string[]) => string
  reusedColumn: (name: string, fields: string[]) => string
  typeProblems: (field: string, kind: CsvValueKind, rows: number[], checked: number) => string
  emptyCells: (field: string, count: number, checked: number) => string
  unterminatedQuote: string
  oneColumn: string
  sampleOnly: (records: number) => string
  empty: string
  confirm: string
}

const DEFAULT_MESSAGES: CsvColumnMapperMessages = {
  delimiterLabel: "Separator",
  headerLabel: "First row is a header",
  previewCaption: (records, truncated) =>
    `${records} ${records === 1 ? "record" : "records"}${truncated ? " from the start of the file" : ""}`,
  columnName: (index) => `Column ${index + 1}`,
  duplicateColumn: (name, index) => `${name} (column ${index + 1})`,
  ignore: "— not imported —",
  missingRequired: (fields) =>
    `${fields.length === 1 ? "A required field has" : `${fields.length} required fields have`} no column yet: ${fields.join(", ")}.`,
  ignoredColumns: (names) =>
    `Not imported: ${names.join(", ")}. That is fine if those columns are not wanted.`,
  reusedColumn: (name, fields) => `${name} feeds ${fields.join(" and ")}.`,
  typeProblems: (field, kind, rows, checked) =>
    `${field} expects ${kind === "integer" ? "a whole number" : `a ${kind}`}: ${rows.length} of the ${checked} rows shown ${rows.length === 1 ? "does" : "do"} not read that way (row ${rows.join(", row ")}).`,
  emptyCells: (field, count, checked) =>
    `${field} is blank in ${count} of the ${checked} rows shown.`,
  unterminatedQuote: "A quoted cell is never closed — check the separator and quote character.",
  oneColumn: "This read as a single column, which usually means the separator is wrong.",
  sampleOnly: (records) =>
    `Checks cover the ${records} ${records === 1 ? "record" : "records"} read so far, not the whole file.`,
  empty: "Nothing to map yet.",
  confirm: "Import",
}

export interface CsvColumnMapperProps {
  /** The file to read. Only a prefix of it is read; the whole file is never held here. */
  file?: Blob | null
  /** CSV text, for callers who already have it. One of `file` or `text`. */
  text?: string
  fields: readonly ImportField[]
  /** Controlled mapping of field name to column index. */
  value?: CsvMapping
  onValueChange?: (mapping: CsvMapping, report: MappingReport) => void
  onConfirm?: (result: {
    mapping: CsvMapping
    delimiter: string
    hasHeader: boolean
    headers: string[]
    report: MappingReport
  }) => void
  /** Forces the separator instead of guessing it. */
  delimiter?: string
  quote?: string
  /** Forces the header decision instead of guessing it. */
  hasHeader?: boolean
  /** Data records to show and check (default 10). */
  previewRecords?: number
  /** How much of a `file` to read (default 64 KiB). */
  sampleBytes?: number
  messages?: Partial<CsvColumnMapperMessages>
  disabled?: boolean
  className?: string
  id?: string
}

/**
 * The screen between "a CSV arrived" and "rows went into the database".
 *
 * It reads a prefix of the file, shows what it found, and lets the reader correct every guess it
 * made: the separator, whether the first row is names, and which column feeds which field. Nothing
 * it decides is hidden, because each of those guesses is wrong on some real file and a wrong one
 * that is not visible becomes a silent import of the wrong data.
 */
export function CsvColumnMapper({
  file,
  text,
  fields,
  value,
  onValueChange,
  onConfirm,
  delimiter,
  quote,
  hasHeader,
  previewRecords = 10,
  sampleBytes = 64 * 1024,
  messages,
  disabled,
  className,
  id,
}: CsvColumnMapperProps) {
  const say = React.useMemo(() => ({ ...DEFAULT_MESSAGES, ...messages }), [messages])

  const generatedId = React.useId()
  const rootId = id ?? generatedId
  const statusId = `${rootId}-status`

  const [source, setSource] = React.useState<string>(() => stripBom(text ?? ""))
  const [fileTruncated, setFileTruncated] = React.useState(false)
  const [reading, setReading] = React.useState(false)

  React.useEffect(() => {
    if (text !== undefined) {
      setSource(stripBom(text))
      setFileTruncated(false)
      return
    }
    if (!file) {
      setSource("")
      setFileTruncated(false)
      return
    }
    let live = true
    setReading(true)
    // Read for the sample window only. A fifty-megabyte export has no business in component state,
    // and the mapping decision needs the first handful of records, not the file.
    void (async () => {
      try {
        const head = file.slice(0, Math.min(sampleBytes, file.size))
        const buffer = await head.arrayBuffer()
        const decoder = new TextDecoder("utf-8")
        const view = new Uint8Array(buffer)
        let read = ""
        const step = 16 * 1024
        for (let at = 0; at < view.length; at += step) {
          read += decoder.decode(view.subarray(at, Math.min(at + step, view.length)), {
            stream: true,
          })
        }
        read += decoder.decode()
        if (!live) return
        setSource(stripBom(read))
        setFileTruncated(head.size < file.size)
      } catch {
        if (!live) return
        setSource("")
        setFileTruncated(false)
      } finally {
        if (live) setReading(false)
      }
    })()
    return () => {
      live = false
    }
  }, [file, text, sampleBytes])

  const guess = React.useMemo(
    () => sniffDelimiter(source, { quote }),
    [source, quote]
  )
  const [chosenDelimiter, setChosenDelimiter] = React.useState<string | null>(null)
  const activeDelimiter = delimiter ?? chosenDelimiter ?? guess.delimiter

  const parsed = React.useMemo(
    () =>
      parseCsv(source, {
        delimiter: activeDelimiter,
        quote,
        limit: previewRecords + 1,
      }),
    [source, activeDelimiter, quote, previewRecords]
  )

  const headerGuess = React.useMemo(() => looksLikeHeader(parsed.rows), [parsed.rows])
  const [chosenHeader, setChosenHeader] = React.useState<boolean | null>(null)
  const activeHeader = hasHeader ?? chosenHeader ?? headerGuess.header

  const columnCount = React.useMemo(
    () => parsed.rows.reduce((widest, row) => Math.max(widest, row.length), 0),
    [parsed.rows]
  )

  const headers = React.useMemo(() => {
    const names: string[] = []
    for (let column = 0; column < columnCount; column += 1) {
      const written = activeHeader ? (parsed.rows[0]?.[column] ?? "").trim() : ""
      names.push(written === "" ? say.columnName(column) : written)
    }
    return names
  }, [parsed.rows, columnCount, activeHeader, say])

  /**
   * Names for the chooser, with repeats told apart.
   *
   * A file with two columns both called `Email` is ordinary — it comes out of a merge, or out of a
   * sheet where somebody copied a column — and two options reading `Email` are two options the
   * reader cannot choose between, even though the values behind them differ. The suffix is added
   * only to the duplicates, and only for display: matching still runs on the written names, since
   * `Email (column 2)` normalises to something no field is called.
   */
  const optionLabels = React.useMemo(() => {
    const seen = new Map<string, number>()
    for (const name of headers) seen.set(name, (seen.get(name) ?? 0) + 1)
    return headers.map((name, column) =>
      (seen.get(name) ?? 0) > 1 ? say.duplicateColumn(name, column) : name
    )
  }, [headers, say])

  const dataRows = React.useMemo(
    () => (activeHeader ? parsed.rows.slice(1) : parsed.rows).slice(0, previewRecords),
    [parsed.rows, activeHeader, previewRecords]
  )

  const suggested = React.useMemo(
    () => autoMatchFields(headers, fields),
    [headers, fields]
  )
  const [edited, setEdited] = React.useState<CsvMapping>({})

  /**
   * The suggestion, with the reader's own choices laid over it.
   *
   * Only the fields actually chosen are held, rather than a copy of the whole mapping taken at the
   * first edit. The difference shows the moment the columns change underneath: picking a separator
   * or flipping the header toggle rebuilds the suggestion, and a stored full mapping would freeze
   * every untouched field at whatever the old columns suggested — so a file reread with the right
   * separator would keep pointing fields at the wrong ones. A chosen field stays chosen; an
   * untouched field keeps following the suggestion.
   */
  const mapping = React.useMemo<CsvMapping>(() => {
    if (value) return value
    const base: CsvMapping = { ...suggested }
    for (const field of fields) {
      const choice = edited[field.name]
      if (choice !== undefined) base[field.name] = choice
    }
    return base
  }, [suggested, edited, value, fields])

  const report = React.useMemo(
    () => mappingReport(mapping, fields, columnCount),
    [mapping, fields, columnCount]
  )

  const checks = React.useMemo(() => {
    const out: { field: ImportField; column: number; check: ColumnCheck }[] = []
    for (const field of fields) {
      const column = mapping[field.name]
      if (column === null || column === undefined) continue
      const kind = field.kind ?? "text"
      const values = dataRows.map((row) => row[column] ?? "")
      const check = checkColumn(values, kind)
      if (check.problems.length > 0 || (kind !== "text" && check.empty > 0)) {
        out.push({ field, column, check })
      }
    }
    return out
  }, [fields, mapping, dataRows])

  function choose(fieldName: string, column: number | null) {
    setEdited((previous) => ({ ...previous, [fieldName]: column }))
    const next: CsvMapping = { ...mapping, [fieldName]: column }
    onValueChange?.(next, mappingReport(next, fields, columnCount))
  }

  const nothing = source.trim() === "" || parsed.rows.length === 0

  // Nothing is wrong yet when there is nothing to be wrong about. Every required field is unmapped
  // before a file arrives, and saying so then is a complaint about a decision the reader has not
  // been given the chance to make — the same reasoning that leaves an untouched empty input alone.
  const problems: string[] = []
  if (!nothing && parsed.unterminatedQuote) problems.push(say.unterminatedQuote)
  if (!nothing && columnCount === 1) problems.push(say.oneColumn)
  if (!nothing && report.missingRequired.length > 0) {
    problems.push(
      say.missingRequired(
        report.missingRequired.map(
          (name) => fields.find((field) => field.name === name)?.label ?? name
        )
      )
    )
  }

  const notes: string[] = []
  if (!nothing && report.ignoredColumns.length > 0) {
    notes.push(say.ignoredColumns(report.ignoredColumns.map((column) => headers[column])))
  }
  for (const reuse of report.reusedColumns) {
    notes.push(
      say.reusedColumn(
        headers[reuse.column],
        reuse.fields.map((name) => fields.find((field) => field.name === name)?.label ?? name)
      )
    )
  }
  for (const { field, check } of checks) {
    const label = field.label ?? field.name
    if (check.problems.length > 0) {
      notes.push(
        say.typeProblems(
          label,
          check.kind,
          check.problems.map((problem) => problem.row + 1),
          check.checked
        )
      )
    }
    if (check.empty > 0) notes.push(say.emptyCells(label, check.empty, check.checked))
  }
  if (dataRows.length > 0 && (parsed.truncated || fileTruncated)) {
    notes.push(say.sampleOnly(dataRows.length))
  }

  return (
    <div
      className={cn("flex w-full flex-col gap-4 text-sm", className)}
      role="group"
      aria-label="Match columns to fields"
      aria-busy={reading || undefined}
    >
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {say.delimiterLabel}
          </span>
          <select
            value={activeDelimiter}
            disabled={disabled || delimiter !== undefined || nothing}
            onChange={(event) => setChosenDelimiter(event.target.value)}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {CSV_DELIMITERS.map((option) => (
              <option key={option} value={option}>
                {option === "\t" ? "Tab" : option}
              </option>
            ))}
            {(CSV_DELIMITERS as readonly string[]).includes(activeDelimiter) ? null : (
              <option value={activeDelimiter}>{activeDelimiter}</option>
            )}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={activeHeader}
            disabled={disabled || hasHeader !== undefined || nothing}
            onChange={(event) => setChosenHeader(event.target.checked)}
            className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="text-xs font-medium text-muted-foreground">{say.headerLabel}</span>
        </label>

        {!nothing && !headerGuess.certain ? (
          <span className="text-xs text-muted-foreground">{headerGuess.reason}</span>
        ) : null}
      </div>

      {nothing ? (
        <p className="text-sm text-muted-foreground">{say.empty}</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <caption className="sr-only">
                {say.previewCaption(dataRows.length, parsed.truncated || fileTruncated)}
              </caption>
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  {headers.map((name, column) => (
                    <th
                      key={column}
                      scope="col"
                      className={cn(
                        "whitespace-nowrap px-2 py-1.5 font-medium",
                        report.ignoredColumns.includes(column)
                          ? "text-muted-foreground/60"
                          : "text-foreground"
                      )}
                    >
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, index) => (
                  <tr key={index} className="border-b border-border last:border-0">
                    {headers.map((_, column) => (
                      <td
                        key={column}
                        className="max-w-[16rem] truncate px-2 py-1.5 text-muted-foreground"
                      >
                        {row[column] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="flex flex-col gap-2">
            {fields.map((field) => {
              const column = mapping[field.name]
              const selectId = `${rootId}-${normalizeHeader(field.name) || "field"}`
              const missing = report.missingRequired.includes(field.name)
              return (
                <li key={field.name} className="flex flex-wrap items-center gap-2">
                  <label
                    htmlFor={selectId}
                    className="min-w-[8rem] text-xs font-medium text-foreground"
                  >
                    {field.label ?? field.name}
                    {field.required ? (
                      <span aria-hidden="true" className="text-destructive">
                        {" *"}
                      </span>
                    ) : null}
                    {field.required ? <span className="sr-only"> (required)</span> : null}
                  </label>
                  <select
                    id={selectId}
                    value={column === null || column === undefined ? "" : String(column)}
                    disabled={disabled}
                    aria-invalid={missing || undefined}
                    aria-describedby={missing ? statusId : undefined}
                    onChange={(event) =>
                      choose(field.name, event.target.value === "" ? null : Number(event.target.value))
                    }
                    className={cn(
                      "h-9 min-w-[12rem] rounded-md border border-input bg-transparent px-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                      missing && "border-destructive focus-visible:ring-destructive"
                    )}
                  >
                    <option value="">{say.ignore}</option>
                    {optionLabels.map((name, index) => (
                      <option key={index} value={String(index)}>
                        {name}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>

          {onConfirm ? (
            <div>
              <button
                type="button"
                disabled={disabled || !report.complete}
                onClick={() =>
                  onConfirm({
                    mapping,
                    delimiter: activeDelimiter,
                    hasHeader: activeHeader,
                    headers,
                    report,
                  })
                }
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {say.confirm}
              </button>
            </div>
          ) : null}
        </>
      )}

      {/*
        Outside the branch above, and therefore mounted from the first render on.
        A live region that arrives in the same commit as its first message is not announced — the
        technology watches a region it is already observing for changes, and a region that did not
        exist a moment ago has no change to report. A file read asynchronously would hit exactly
        that: nothing on screen until the bytes land, then the whole subtree appearing at once with
        its messages already inside it. So the region ships empty and stays put, and only its
        contents change.
      */}
      <div
        id={statusId}
        aria-live="polite"
        className={cn(
          "flex flex-col gap-1",
          problems.length === 0 && notes.length === 0 && "sr-only"
        )}
      >
        {problems.map((message, index) => (
          <p key={`problem-${index}`} className="text-xs text-destructive">
            {message}
          </p>
        ))}
        {notes.map((message, index) => (
          <p key={`note-${index}`} className="text-xs text-muted-foreground">
            {message}
          </p>
        ))}
      </div>
    </div>
  )
}
