"use client"

import * as React from "react"
import { ClipboardPaste, Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

/** The clipboard's name for unformatted text. */
export const TEXT_TYPE = "text/plain"

/** The clipboard's name for the rich-text flavour that rides along with it. */
export const HTML_TYPE = "text/html"

/**
 * Extensions for the types a clipboard actually carries. Everything else is derived from the
 * subtype, so an unlisted `image/avif` still lands on `.avif` rather than on a guess.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
}

/**
 * A file extension for a MIME type, without the dot.
 *
 * Parameters are dropped first (`image/png; charset=binary` is still a png), then the subtype is
 * stripped of the `x-` prefix and of any `+xml`-style suffix. Anything that does not come out as a
 * plausible extension becomes `bin`, because a name ending in `.application/octet-stream` is worse
 * than one ending in nothing useful.
 */
export function extensionForType(type: string | null | undefined): string {
  const clean = String(type ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase()
  if (EXTENSION_BY_TYPE[clean]) return EXTENSION_BY_TYPE[clean]
  const subtype = clean.split("/")[1]
  if (!subtype) return "bin"
  const base = subtype.replace(/^x-/, "").replace(/\+.*$/, "")
  return /^[a-z0-9]{1,8}$/.test(base) ? base : "bin"
}

/**
 * The stems browsers invent when the clipboard hands over a picture that was never a file.
 *
 * Deliberately short. `photo` and `screenshot` are **not** here: a real file called `photo.jpg`,
 * copied out of a file manager, has a name its owner chose, and renaming it would be this component
 * destroying information rather than supplying it. Everything in this list is a name no human typed.
 */
const GENERIC_STEMS = new Set(["", "image", "unknown", "blob"])

/** Whether a clipboard-supplied filename is a placeholder rather than something a person chose. */
export function isGenericName(name: string | null | undefined): boolean {
  if (!name) return true
  const dot = name.lastIndexOf(".")
  const stem = (dot === -1 ? name : name.slice(0, dot)).trim().toLowerCase()
  return GENERIC_STEMS.has(stem)
}

/**
 * The `20260929-143012` part of a generated filename, in local time.
 *
 * Local rather than UTC on purpose: this ends up in a filename a person reads back, and a screenshot
 * taken at half past two in the afternoon should not be called `0530`.
 */
export function stampFor(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** The name given to a pasted image that arrived without one. */
export function pastedName(type: string | null | undefined, stamp: string, sequence: number): string {
  return `pasted-${stamp}-${sequence}.${extensionForType(type)}`
}

function extOf(name: string) {
  const dot = name.lastIndexOf(".")
  return dot === -1 ? "" : name.slice(dot).toLowerCase()
}

/** Match a file against an `accept` string (mime, mime wildcard, or .ext) — `<input accept>` syntax. */
export function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true
  const type = (file.type || "").toLowerCase()
  const ext = extOf(file.name || "")
  return accept
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .some((token) => {
      if (token.startsWith(".")) return ext === token
      if (token.endsWith("/*")) return type.startsWith(token.slice(0, -1))
      return type === token
    })
}

/** Why a pasted file was skipped, so you can tell the person instead of dropping it silently. */
export interface PasteRejection {
  file: File
  reason: "type" | "size" | "too-many"
}

/** The caps a paste is measured against. They apply to files; pasted text is never capped. */
export interface PasteLimits {
  accept?: string
  maxSize?: number
  maxFiles?: number
}

/** Split the files a paste carried into the ones to hand on and the ones to explain. */
export function screenFiles(
  files: File[],
  { accept, maxSize, maxFiles }: PasteLimits
): { accepted: File[]; rejected: PasteRejection[] } {
  const accepted: File[] = []
  const rejected: PasteRejection[] = []
  for (const file of files) {
    if (!matchesAccept(file, accept)) rejected.push({ file, reason: "type" })
    else if (maxSize !== undefined && file.size > maxSize) rejected.push({ file, reason: "size" })
    else accepted.push(file)
  }
  if (maxFiles !== undefined && accepted.length > maxFiles) {
    for (const file of accepted.slice(maxFiles)) rejected.push({ file, reason: "too-many" })
    return { accepted: accepted.slice(0, maxFiles), rejected }
  }
  return { accepted, rejected }
}

/**
 * Identity for de-duplication: name, size and type — and deliberately **not** `lastModified`.
 *
 * The same screenshot is normally present in both `items` and `files`, but `getAsFile()` mints a
 * fresh `File` on each call and some engines stamp it with `Date.now()` at that moment, so two reads
 * of one picture differ by a millisecond or two. Keying on the timestamp would let that pair through
 * as two files and the person would see their screenshot twice.
 */
const identityOf = (file: File) => `${file.name}\u0000${file.size}\u0000${file.type}`

/** Merge the file lists a single paste exposes, keeping the first sighting of each file. */
export function dedupeFiles(...groups: (File[] | null | undefined)[]): File[] {
  const out: File[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const file of group ?? []) {
      if (!file) continue
      const key = identityOf(file)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(file)
    }
  }
  return out
}

/** The parts of a `DataTransfer` this reads, narrowed so a stand-in can be handed to it. */
export interface ClipboardSource {
  types?: ArrayLike<string> | readonly string[]
  files?: ArrayLike<File>
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>
  getData?(type: string): string
}

/** Everything one paste carried, before any of it has been screened or renamed. */
export interface RawPaste {
  files: File[]
  text: string | null
  html: string | null
  /** Every flavour the clipboard advertised, verbatim — including the `Files` pseudo-type. */
  types: string[]
}

const EMPTY_PASTE: RawPaste = { files: [], text: null, html: null, types: [] }

/**
 * `getData` is synchronous and safe to call during the event; it throws in some engines once the
 * transfer has been neutered, which is a reason to shrug rather than to lose the whole paste.
 */
function readString(source: ClipboardSource, type: string): string | null {
  try {
    return source.getData?.(type) || null
  } catch {
    return null
  }
}

/**
 * Read one `paste` event's clipboard, synchronously.
 *
 * Both file lists are read, because they disagree: a screenshot — a picture that was never a file on
 * disk — shows up in `items` and, in some browsers, nowhere else, so code that reads `files` alone
 * silently ignores the single most common thing anyone pastes. They are then de-duplicated, since
 * most browsers put an ordinary copied file in both.
 *
 * The strings come from `getData` rather than from `items[i].getAsString`, which hands its result to
 * a callback on a later turn — by which time the event's `DataTransfer` is empty and the callback
 * fires with nothing. Everything here happens before this function returns, for the same reason.
 */
export function readClipboard(source: ClipboardSource | null | undefined): RawPaste {
  if (!source) return EMPTY_PASTE
  const fromItems: File[] = []
  for (const item of Array.from(source.items ?? [])) {
    if (item?.kind !== "file") continue
    const file = item.getAsFile?.()
    if (file) fromItems.push(file)
  }
  return {
    files: dedupeFiles(fromItems, Array.from(source.files ?? [])),
    text: readString(source, TEXT_TYPE),
    html: readString(source, HTML_TYPE),
    types: Array.from(source.types ?? []),
  }
}

/** One entry of `navigator.clipboard.read()`, narrowed the same way as `ClipboardSource`. */
export interface ClipboardItemLike {
  types: readonly string[]
  getType(type: string): Promise<Blob>
}

/**
 * Read the result of `navigator.clipboard.read()` into the same shape a `paste` event produces.
 *
 * The blobs come out unnamed on purpose: a `ClipboardItem` has no filename to offer at all, so
 * handing them on with an empty name lets the one naming pass in `normalizeFiles` treat them exactly
 * like a browser's `image.png` instead of there being a second, subtly different naming path.
 *
 * A type that fails to read is skipped rather than aborting: a clipboard holding one unreadable
 * flavour alongside a picture should still yield the picture.
 */
export async function readClipboardItems(
  items: readonly ClipboardItemLike[] | null | undefined
): Promise<RawPaste> {
  const files: File[] = []
  const types: string[] = []
  let text: string | null = null
  let html: string | null = null

  for (const item of items ?? []) {
    for (const type of item?.types ?? []) {
      types.push(type)
      try {
        const blob = await item.getType(type)
        if (type === TEXT_TYPE) {
          if (text === null) text = (await blob.text()) || null
        } else if (type === HTML_TYPE) {
          if (html === null) html = (await blob.text()) || null
        } else {
          files.push(new File([blob], "", { type: blob.type || type }))
        }
      } catch {
        // This flavour is unreadable. The rest of the clipboard still is.
      }
    }
  }
  return { files, text, html, types }
}

/** A file from a paste, together with what the clipboard called it before this renamed it. */
export interface PastedFile {
  file: File
  /** True when the clipboard offered no usable name and this supplied one. */
  renamed: boolean
  /** Whatever the clipboard called it — `image.png`, or null when it gave no name at all. */
  originalName: string | null
}

/**
 * Give pasted pictures names that can coexist.
 *
 * Every screenshot arrives as `image.png`. One is fine; the second one lands in the list beside a
 * file of the same name, and from there on "which `image.png`?" is a question the UI cannot answer
 * and an upload that keys on filename quietly overwrites. `sequence` continues across pastes rather
 * than restarting, so two pastes inside the same second cannot produce the same name either.
 *
 * Files that came with a real name keep it, untouched.
 */
export function normalizeFiles(
  files: File[],
  { stamp, sequence = 1, rename = true }: { stamp: string; sequence?: number; rename?: boolean }
): PastedFile[] {
  let next = sequence
  return files.map((file) => {
    const originalName = file.name || null
    if (!rename || !isGenericName(file.name)) return { file, renamed: false, originalName }
    const named = new File([file], pastedName(file.type, stamp, next++), {
      type: file.type,
      lastModified: file.lastModified,
    })
    return { file: named, renamed: true, originalName }
  })
}

/** Where a paste came from: the keyboard, or the button that asks the clipboard directly. */
export type PasteSource = "event" | "clipboard-api"

/** One paste, screened and named, with every flavour it carried still available. */
export interface PastePayload {
  files: PastedFile[]
  /** The `text/plain` flavour. A spreadsheet puts tab-separated rows here. */
  text: string | null
  /** The `text/html` flavour. A spreadsheet puts a real `<table>` here. */
  html: string | null
  types: string[]
  source: PasteSource
}

/**
 * The sentence announced after a paste. Empty when the paste carried nothing at all, which the
 * component reports with its own label instead.
 */
export function describePaste(
  payload: Pick<PastePayload, "files" | "text" | "html">,
  rejected: PasteRejection[]
): string {
  const parts: string[] = []
  const count = payload.files.length
  if (count) parts.push(`${count} file${count === 1 ? "" : "s"} pasted`)
  else if (payload.text) parts.push("Text pasted")
  else if (payload.html) parts.push("Formatted text pasted")
  if (rejected.length) parts.push(`${rejected.length} skipped`)
  return parts.join(", ")
}

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
])

/** The shape of an event target this needs to classify, without requiring a real DOM. */
interface TargetLike {
  tagName?: string
  type?: string
  isContentEditable?: boolean
  readOnly?: boolean
  disabled?: boolean
  tabIndex?: number
}

/**
 * Whether a paste that landed on this element belongs to the element rather than to the region.
 *
 * A paste area that also holds a caption field, or that listens on the document, will be handed
 * pastes meant for a text box — and swallowing one means the person watches their text not appear.
 * A read-only or disabled field is not one of those: nothing can be pasted into it, so the region
 * takes that paste.
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const el = target as TargetLike
  if (el.isContentEditable) return true
  const tag = String(el.tagName ?? "").toUpperCase()
  if (tag === "TEXTAREA") return !el.readOnly && !el.disabled
  if (tag === "INPUT") {
    if (NON_TEXT_INPUTS.has(String(el.type ?? "text").toLowerCase())) return false
    return !el.readOnly && !el.disabled
  }
  return false
}

const FOCUSABLE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA"])

/**
 * Whether a click landed on something that takes focus in its own right.
 *
 * Clicking the region focuses it, so that the very next Ctrl+V has somewhere to go. Doing that
 * unconditionally would also fire when the click was on the Paste button inside it, moving focus off
 * the control the person just used.
 */
export function isFocusableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false
  const el = target as TargetLike
  if (FOCUSABLE_TAGS.has(String(el.tagName ?? "").toUpperCase())) return true
  return typeof el.tabIndex === "number" && el.tabIndex >= 0
}

/** A refusal from `navigator.clipboard.read()` that is about permission rather than about failure. */
export function isPermissionError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === "NotAllowedError" || name === "SecurityError"
}

/** Every string a person reads or hears. Override any of them to reword or to translate. */
export interface PasteAreaLabels {
  /** The region's accessible name. */
  label: string
  /** The instruction shown inside the region. */
  hint: string
  /** The button that reads the clipboard without a keystroke. */
  button: string
  /** While that read is in flight. */
  reading: string
  /** The paste carried nothing this component could use. */
  empty: string
  /** The browser refused to hand over the clipboard. */
  denied: string
  /** Reading the clipboard failed for some other reason. */
  failed: string
}

const defaultLabels: PasteAreaLabels = {
  label: "Paste area",
  hint: "Paste a screenshot, an image or a file here",
  button: "Paste from clipboard",
  reading: "Reading the clipboard…",
  empty: "Nothing to paste",
  denied: "Clipboard permission denied — use Ctrl+V instead",
  failed: "Could not read the clipboard",
}

export interface PasteAreaProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onPaste"> {
  /** Called once per paste that carried something usable. */
  onPaste: (payload: PastePayload) => void
  /** Called with the files that were skipped and why. */
  onReject?: (rejections: PasteRejection[]) => void
  /** Same syntax as an `<input accept>` attr, e.g. `"image/*,.pdf"`. Files only. */
  accept?: string
  /** Skip files larger than this many bytes. */
  maxSize?: number
  /** Keep at most this many files out of a single paste. */
  maxFiles?: number
  /**
   * Also take pastes that happen while nothing in this region is focused.
   *
   * The usual reason a paste area "does nothing" is that a `paste` event only reaches whatever has
   * focus, and a page someone has just loaded has focus on the body. Turn this on for a screen whose
   * whole job is to receive one thing, leave it off when the page has other paste targets.
   */
  global?: boolean
  /** Keep the clipboard-reading button out of the tree, e.g. when supplying your own control. */
  hideButton?: boolean
  /** Keep whatever name the clipboard supplied, even when it is a placeholder (default false). */
  keepGenericNames?: boolean
  disabled?: boolean
  labels?: Partial<PasteAreaLabels>
}

/**
 * A region that receives whatever is on the clipboard: a screenshot, an image, a file, a table
 * copied out of a spreadsheet, or plain text.
 *
 * Two ways in, because the two clipboard mechanisms are available under opposite conditions. The
 * `paste` event needs no permission and works everywhere, but only reaches the focused element —
 * which is why this region is focusable and why `global` exists. `navigator.clipboard.read()` can be
 * called whenever, but prompts for permission, is not implemented everywhere, and in some engines
 * only resolves inside a user gesture — which is why it sits behind a button, and why the button
 * appears only after mount, once there is a `navigator` to ask.
 */
export const PasteArea = React.forwardRef<HTMLDivElement, PasteAreaProps>(function PasteArea(
  {
    onPaste,
    onReject,
    accept,
    maxSize,
    maxFiles,
    global: listenGlobally = false,
    hideButton = false,
    keepGenericNames = false,
    disabled = false,
    labels,
    className,
    children,
    ...props
  },
  forwardedRef
) {
  const text = { ...defaultLabels, ...labels }

  const regionRef = React.useRef<HTMLDivElement | null>(null)
  React.useImperativeHandle(forwardedRef, () => regionRef.current as HTMLDivElement)

  const [message, setMessage] = React.useState("")
  const [reading, setReading] = React.useState(false)
  /**
   * Whether this browser can be asked for the clipboard directly.
   *
   * Settled in an effect, never during render: the server has no `navigator`, so a button rendered
   * from this check would be in the client's first tree and absent from the server's HTML, and React
   * throws the whole tree away and re-renders it rather than reconciling that.
   */
  const [canRead, setCanRead] = React.useState(false)
  React.useEffect(() => {
    setCanRead(
      typeof navigator !== "undefined" && typeof navigator.clipboard?.read === "function"
    )
  }, [])

  const busyRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  React.useEffect(
    () => () => {
      mountedRef.current = false
    },
    []
  )

  /** Continues across pastes, so two pastes in one second cannot mint the same filename. */
  const sequenceRef = React.useRef(1)

  const hintId = `${React.useId()}-hint`

  /**
   * Screen, name and hand on one paste. Returns whether anything was taken, which is what decides
   * if the browser's own handling of the event is worth preventing.
   */
  const deliver = React.useCallback(
    (raw: RawPaste, source: PasteSource): boolean => {
      const { accepted, rejected } = screenFiles(raw.files, { accept, maxSize, maxFiles })
      const files = normalizeFiles(accepted, {
        stamp: stampFor(new Date()),
        sequence: sequenceRef.current,
        rename: !keepGenericNames,
      })
      sequenceRef.current += files.filter((entry) => entry.renamed).length

      const payload: PastePayload = {
        files,
        text: raw.text,
        html: raw.html,
        types: raw.types,
        source,
      }
      const took = files.length > 0 || raw.text !== null || raw.html !== null

      if (rejected.length) onReject?.(rejected)
      if (took) onPaste(payload)
      setMessage(describePaste(payload, rejected) || text.empty)
      return took
    },
    [accept, keepGenericNames, maxFiles, maxSize, onPaste, onReject, text.empty]
  )

  const handlePaste = React.useCallback(
    (event: {
      clipboardData: ClipboardSource | null
      target: unknown
      preventDefault: () => void
    }) => {
      if (disabled) return
      // The paste belongs to a text box, here or elsewhere on the page. Leave it alone.
      if (isEditableTarget(event.target)) return
      if (deliver(readClipboard(event.clipboardData), "event")) event.preventDefault()
    },
    [deliver, disabled]
  )

  /**
   * The document listener, kept behind a ref that is replaced every render so that turning `global`
   * on does not re-subscribe the document on each keystroke elsewhere in the tree.
   */
  const globalHandler = React.useRef<(event: ClipboardEvent) => void>(() => {})
  React.useEffect(() => {
    globalHandler.current = handlePaste
  })
  React.useEffect(() => {
    if (!listenGlobally || disabled) return
    if (typeof document === "undefined" || !document.addEventListener) return
    const listener = (event: ClipboardEvent) => globalHandler.current(event)
    document.addEventListener("paste", listener)
    return () => document.removeEventListener("paste", listener)
  }, [listenGlobally, disabled])

  const readClipboardDirectly = React.useCallback(async () => {
    if (disabled || busyRef.current) return
    busyRef.current = true
    setReading(true)
    setMessage(text.reading)
    try {
      const items = await navigator.clipboard.read()
      const raw = await readClipboardItems(items as unknown as ClipboardItemLike[])
      if (!mountedRef.current) return
      deliver(raw, "clipboard-api")
    } catch (error) {
      if (!mountedRef.current) return
      setMessage(isPermissionError(error) ? text.denied : text.failed)
    } finally {
      busyRef.current = false
      if (mountedRef.current) setReading(false)
    }
  }, [deliver, disabled, text.denied, text.failed, text.reading])

  /** Focus the region so the next Ctrl+V has somewhere to land — unless the click had its own target. */
  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (disabled || isFocusableTarget(event.target)) return
      regionRef.current?.focus()
    },
    [disabled]
  )

  const showButton = canRead && !hideButton

  return (
    <div
      ref={regionRef}
      role="group"
      tabIndex={disabled ? -1 : 0}
      aria-label={text.label}
      aria-describedby={hintId}
      aria-disabled={disabled || undefined}
      onClick={handleClick}
      /*
        Left off entirely in global mode. A `paste` event bubbles to the document, so keeping both
        this handler and the document listener would deliver every paste made while the region is
        focused twice — two copies of the screenshot, from one Ctrl+V.
      */
      onPaste={listenGlobally ? undefined : handlePaste}
      className={cn(
        "flex min-h-32 w-full flex-col items-center justify-center gap-2 rounded-lg border-2",
        "border-dashed border-input bg-transparent p-6 text-center text-sm text-muted-foreground",
        "transition-colors focus-visible:outline-none focus-visible:border-ring",
        "focus-visible:ring-1 focus-visible:ring-ring",
        disabled ? "cursor-not-allowed opacity-50" : "cursor-text hover:border-ring/60",
        className
      )}
      {...props}
    >
      {children ?? (
        <>
          <ClipboardPaste className="h-6 w-6" aria-hidden="true" />
          <div id={hintId}>{text.hint}</div>
        </>
      )}
      {showButton ? (
        <button
          type="button"
          onClick={readClipboardDirectly}
          /*
            `aria-disabled`, not `disabled`: a disabled button drops focus the moment it is pressed,
            which would throw a keyboard user out of the region they are pasting into.
          */
          aria-disabled={reading || disabled}
          className={cn(
            "mt-1 inline-flex items-center gap-1.5 rounded-md border border-input bg-background",
            "px-2.5 py-1.5 text-sm font-medium text-foreground shadow-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "focus-visible:ring-offset-2",
            reading || disabled
              ? "cursor-not-allowed opacity-50"
              : "hover:bg-accent hover:text-accent-foreground"
          )}
        >
          {reading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <ClipboardPaste className="size-4" aria-hidden="true" />
          )}
          {text.button}
        </button>
      ) : null}
      {/*
        Rendered unconditionally so the region exists in the DOM before it has anything to say — one
        inserted at the same moment as its text is commonly announced late, or not at all. Visible
        rather than `sr-only`, because "Clipboard permission denied" is the answer to "why did
        nothing happen", and sighted people ask that too.
      */}
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {message}
      </span>
    </div>
  )
})
