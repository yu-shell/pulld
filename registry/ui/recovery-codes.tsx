"use client"

import * as React from "react"
import { Download, Printer } from "lucide-react"

import { cn } from "@/lib/utils"
import { CopyButton } from "@/registry/ui/copy-button"

/** One recovery code, and whether it has already been spent. */
export interface RecoveryCode {
  /** The code itself, exactly as the server issued it. */
  code: string
  /** Already redeemed. Shown struck through, and left out of every export. */
  used?: boolean
}

/**
 * What `codes` accepts. A freshly issued set is a list of strings; a set being reviewed later
 * carries the used flag, so both spellings are allowed rather than forcing the common case to wrap
 * every string in an object.
 */
export type RecoveryCodeInput = string | RecoveryCode

/** Which controls the toolbar offers. */
export type RecoveryCodeAction = "copy" | "download" | "print"

const ACTION_ORDER: RecoveryCodeAction[] = ["copy", "download", "print"]

/**
 * Puts the two accepted shapes into one, trimming as it goes.
 *
 * Trimming matters more here than it looks: these strings usually arrive from a JSON payload and
 * end up being typed back in by hand, and a trailing newline picked up somewhere in the middle
 * would be copied to the clipboard and printed onto paper without ever being visible on screen.
 * An entry that is empty once trimmed is dropped — there is nothing a person could type.
 */
export function normalizeCodes(codes: readonly RecoveryCodeInput[]): RecoveryCode[] {
  return codes
    .map((entry) =>
      typeof entry === "string"
        ? { code: entry.trim(), used: false }
        : { code: entry.code.trim(), used: entry.used === true }
    )
    .filter((entry) => entry.code.length > 0)
}

/** The local calendar date as `YYYY-MM-DD`. */
export function isoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  // Deliberately not `toISOString().slice(0, 10)`: that converts to UTC first, so anyone west of
  // Greenwich printing a sheet in the evening gets tomorrow's date on it.
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** What every export is built from. */
export interface RecoveryCodeSheet {
  /** The unused codes, in display order. */
  codes: readonly string[]
  /** Heading for the sheet — the app or account these belong to. */
  title: string
  /** Stamped under the heading so a sheet found in a drawer can be dated. */
  generatedAt?: Date
  /** The line of guidance printed under the codes. */
  note?: string | null
}

/**
 * The body of the downloaded `.txt`.
 *
 * Lines are joined with CRLF rather than LF. The file exists to be opened by a person in whatever
 * their machine hands them, and a LF-only text file is still rendered as one long line by a fair
 * amount of Windows tooling; CRLF is read correctly by every editor on every platform, so it is the
 * ending that cannot be wrong. The clipboard is the opposite case and gets plain LF — see
 * {@link RecoveryCodes}.
 */
export function formatCodesText({
  codes,
  title,
  generatedAt = new Date(),
  note,
}: RecoveryCodeSheet): string {
  const lines = [title, `Generated ${isoDate(generatedAt)}`, ""]
  for (const code of codes) lines.push(code)
  if (note) lines.push("", note)
  return lines.join("\r\n") + "\r\n"
}

/** Escapes a string for interpolation into HTML text or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Marks the sheet's root element so {@link printDocument} can tell it from a blank frame. */
const SHEET_MARKER = "data-recovery-codes"

/**
 * Builds the standalone document that gets printed.
 *
 * Every colour is stated as black on white. The sheet must not inherit the page's theme: browsers
 * drop background colours when printing but keep text colours, so a dark-mode card sent to a
 * printer comes out as pale grey text on white paper — legible on screen, close to blank on paper,
 * and nobody finds out until they need the codes.
 *
 * The codes are escaped even though a server issues them. This string becomes a document; treating
 * the one value that crosses into it as data rather than markup is the cheap half of that, and it
 * also means a caller free-typing a `title` like `Acme <staging>` gets a sheet instead of a mess.
 */
export function buildPrintDocument({
  codes,
  title,
  generatedAt = new Date(),
  note,
}: RecoveryCodeSheet): string {
  const items = codes.map((code) => `<li>${escapeHtml(code)}</li>`).join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 16mm; }
  :root { color-scheme: light; }
  body { margin: 0; color: #000; background: #fff; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { margin: 0 0 2px; font-size: 16px; }
  .meta { margin: 0 0 16px; font-size: 12px; color: #444; }
  ul { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 32px; margin: 0; padding: 0; list-style: none; }
  li { padding-bottom: 3px; border-bottom: 1px dashed #bbb; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.04em; break-inside: avoid; }
  .note { max-width: 62ch; margin: 20px 0 0; font-size: 12px; color: #444; }
</style>
</head>
<body ${SHEET_MARKER}>
<h1>${escapeHtml(title)}</h1>
<p class="meta">Generated ${isoDate(generatedAt)} &middot; ${codes.length} code${codes.length === 1 ? "" : "s"}</p>
<ul>${items}</ul>
${note ? `<p class="note">${escapeHtml(note)}</p>` : ""}
</body>
</html>`
}

/** Firefox needs the object URL to outlive the click's own task before it is released. */
const REVOKE_DELAY_MS = 40

/**
 * Saves `text` as a file the browser downloads.
 *
 * The two things a hand-rolled version leaves out are both here. The anchor is put into the
 * document before it is clicked, because Firefox ignores a click on an element that is not in the
 * tree. And the object URL is revoked afterwards: an un-revoked one keeps its blob — which is to
 * say, the recovery codes — alive for the whole life of the document, addressable by anyone who
 * gets hold of the URL. Revoking is deferred rather than immediate, because releasing it in the
 * same task as the click cancels the download it was created for.
 */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}

/**
 * How long an unanswered print is given before the frame holding the codes is torn down anyway.
 *
 * Long on purpose. Removing the frame while a print sheet is still open cancels the job, and a
 * cancelled print is a worse outcome than the markup living a little longer, so this only ever
 * fires when `afterprint` never arrives at all.
 */
const PRINT_CLEANUP_MS = 60_000

/**
 * Prints `html` as a document of its own, and resolves once the browser is done with it.
 *
 * This exists because `window.print()` is the wrong call, and wrong in a way nobody notices until
 * the codes are needed. It prints the page, not the codes: the nav, the sidebar and the rest of the
 * settings screen come with them, and when the codes are inside a scrolling dialog — which is
 * exactly where a freshly issued set is shown — the printed sheet is clipped to whatever part of
 * that dialog happened to be scrolled into view. Half the codes are simply missing, on paper that
 * looks finished.
 *
 * A detached document sidesteps all of it, and the details below are the ones that make the recipe
 * hold up rather than working on one browser:
 *
 * - The frame is 0×0 and transparent, never `display: none` — a frame that is not being displayed
 *   has nothing to print, and browsers say so by printing a blank page.
 * - `srcdoc` is assigned before the frame is inserted, so the only `load` event is the sheet's.
 *   Inserting first fires one for the initial `about:blank`, and printing on that gives blank
 *   paper; the marker check below refuses that document even if the order is ever changed back.
 * - Cleanup waits for `afterprint`. In Chrome and Firefox `print()` blocks until the dialog is
 *   dismissed, but in Safari it returns immediately, and code that removed the frame on the next
 *   line would be pulling the document out from under a dialog that is still open.
 */
export function printDocument(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.setAttribute("tabindex", "-1")
    frame.setAttribute("title", "Print preview")
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none"

    let settled = false
    let timer = 0
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      frame.remove()
      resolve()
    }

    frame.srcdoc = html
    frame.onload = () => {
      const frameWindow = frame.contentWindow
      if (!frameWindow?.document.querySelector(`[${SHEET_MARKER}]`)) return
      frameWindow.addEventListener("afterprint", finish)
      timer = window.setTimeout(finish, PRINT_CLEANUP_MS)
      frameWindow.focus()
      frameWindow.print()
    }
    document.body.appendChild(frame)
  })
}

export interface RecoveryCodesProps extends React.ComponentPropsWithoutRef<"div"> {
  /** The codes to show. Plain strings, or objects carrying a `used` flag. */
  codes: readonly RecoveryCodeInput[]
  /** Heading above the list, and the default heading on the saved and printed sheet. */
  label?: string
  /** Overrides the heading written onto the saved and printed sheet — usually the app or account. */
  sheetTitle?: string
  /** Guidance shown under the list and repeated on every export. Pass `null` to drop it. */
  note?: string | null
  /** Name of the downloaded file. */
  filename?: string
  /** Which controls to offer, in toolbar order. */
  actions?: readonly RecoveryCodeAction[]
  /**
   * Fired when the user asks for the codes to leave the screen — the signal to unlock an "I have
   * saved these" button. It reports the request, not its outcome: nothing here can know whether a
   * download was kept or a print dialog was answered.
   */
  onExport?: (action: RecoveryCodeAction) => void
}

const DEFAULT_NOTE =
  "Each code can be used once. Keep them somewhere only you can reach — anyone holding one can sign in without your second factor."

/**
 * The sheet of two-factor recovery codes: the list itself, and the three ways out of the screen —
 * copy, download, print — with spent codes struck through.
 *
 * Every export covers the unused codes only. A saved file containing codes that have already been
 * redeemed is worse than no file: it is the right length, so the person counting on it does not
 * find out until one of them is refused. The header states how many are left whenever any have
 * been spent, so the narrowing is visible rather than silent.
 *
 * The clipboard gets the bare codes, one per line, because the place they are being pasted is a
 * password manager's notes field and the heading would be noise there. The file and the sheet get
 * the heading and the date, because those get filed away and have to be identifiable later.
 *
 * Nothing here renders a date, so the component is safe to server-render: the timestamp is taken
 * when a button is pressed, not while rendering, which is the difference between a printed sheet
 * and a hydration mismatch.
 */
export function RecoveryCodes({
  codes,
  label = "Recovery codes",
  sheetTitle,
  note = DEFAULT_NOTE,
  filename = "recovery-codes.txt",
  actions = ACTION_ORDER,
  onExport,
  className,
  ...props
}: RecoveryCodesProps) {
  const labelId = React.useId()

  const entries = normalizeCodes(codes)
  const unused = entries.filter((entry) => !entry.used).map((entry) => entry.code)
  const spentCount = entries.length - unused.length
  const title = sheetTitle ?? label

  // LF, not the file's CRLF: this is going into a text field, where a stray carriage return is a
  // character the next form to read the codes back will not expect.
  const clipboardText = unused.join("\n")
  const sheet = (): RecoveryCodeSheet => ({ codes: unused, title, note })

  const offered = ACTION_ORDER.filter((action) => actions.includes(action))
  const nothingLeft = unused.length === 0
  const countLabel = `${unused.length} recovery code${unused.length === 1 ? "" : "s"}`

  return (
    <div className={cn("w-full rounded-lg border border-border", className)} {...props}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2">
        <p id={labelId} className="text-sm font-medium text-foreground">
          {label}
        </p>
        {spentCount > 0 ? (
          <p className="text-xs tabular-nums text-muted-foreground">
            {unused.length} of {entries.length} unused
          </p>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {offered.map((action) =>
            action === "copy" ? (
              // The notification is taken off the wrapper rather than by handing copy-button an
              // onClick. That component spreads its props after its own handler, so an onClick
              // passed to it would replace the clipboard write instead of running beside it — the
              // button would still look and sound exactly right and copy nothing. The click bubbles
              // from the button itself, so keyboard activation is included, and a disabled button
              // emits none at all.
              <span key={action} className="inline-flex" onClick={() => onExport?.("copy")}>
                <CopyButton
                  value={clipboardText}
                  disabled={nothingLeft}
                  aria-label={`Copy ${countLabel}`}
                  title="Copy"
                />
              </span>
            ) : (
              <button
                key={action}
                type="button"
                disabled={nothingLeft}
                aria-label={
                  action === "download" ? `Download ${countLabel}` : `Print ${countLabel}`
                }
                title={action === "download" ? "Download" : "Print"}
                onClick={() => {
                  if (action === "download") {
                    downloadTextFile(filename, formatCodesText(sheet()))
                  } else {
                    void printDocument(buildPrintDocument(sheet()))
                  }
                  onExport?.(action)
                }}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                {action === "download" ? (
                  <Download className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Printer className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )
          )}
        </div>
      </div>

      {/* `role="list"` is put back by hand because Safari drops list semantics from a <ul> whose
          list-style is none, which would leave a screen reader with no count of how many codes
          there are — the one number that matters on this screen. */}
      <ul
        role="list"
        aria-labelledby={labelId}
        className="grid grid-cols-1 gap-x-6 gap-y-1 p-3 sm:grid-cols-2"
      >
        {entries.map((entry, index) => (
          <li
            key={index}
            className={cn(
              "font-mono text-sm tracking-wide text-foreground",
              entry.used && "text-muted-foreground line-through"
            )}
          >
            {entry.code}
            {/* A line through the text is a paint decision and reaches nobody using a screen
                reader, so the state is also said in words. */}
            {entry.used ? <span className="sr-only"> (used)</span> : null}
          </li>
        ))}
      </ul>

      {note ? (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{note}</p>
      ) : null}
    </div>
  )
}
