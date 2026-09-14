"use client"

import * as React from "react"
import { Printer } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * What the browser was willing to tell us, which is less than you would like.
 *
 * There is no event for "paper came out of the printer" and none for "the dialog was cancelled":
 * `afterprint` fires for both, so a button that settles on "Printed!" is guessing, and every
 * "mark as printed" flag built on it eventually lies. `done` means the dialog closed and nothing
 * more. `unavailable` is a browser with no printing at all — the in-app webviews that open links
 * inside social apps are the common case. `failed` is a region that could not be serialised.
 */
export type PrintOutcome = "done" | "unavailable" | "failed"

/**
 * Marks the printable document's body so {@link printRegion} can tell it from a blank frame.
 *
 * Deliberately not the marker `recovery-codes` uses: the two print different things and neither
 * should ever accept the other's document.
 */
const PRINT_MARKER = "data-pulld-print"

/**
 * How long an unanswered print is given before the frame is torn down anyway.
 *
 * Long on purpose. Removing the frame while a print dialog is still open cancels the job, so this
 * only ever fires when `afterprint` never arrives at all.
 */
const CLEANUP_MS = 60_000

/**
 * How long the stylesheets get before the sheet is printed without them.
 *
 * An iframe's `load` event already waits for its stylesheets, which is the whole reason the styles
 * survive the copy. But "waits for" has no upper bound: one unreachable CDN in the page's `<head>`
 * and `load` never fires, leaving a button that does nothing forever with no error to explain it.
 * Printing an unstyled sheet is a bad outcome; printing nothing is a worse one.
 */
const STYLE_TIMEOUT_MS = 3_000

/** Escapes a value that is about to become part of a document rather than part of the DOM. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** `querySelectorAll` that also returns `root` itself when it matches, which it does not. */
function collect(root: Element, selector: string): Element[] {
  const found = Array.from(root.querySelectorAll(selector))
  return root.matches(selector) ? [root, ...found] : found
}

/**
 * The page's own CSS, in the two forms it comes in.
 *
 * `href`s are re-linked rather than inlined: a cross-origin sheet — a font service, a CDN build —
 * throws `SecurityError` the moment its `cssRules` are read, so any implementation that serialises
 * the CSSOM silently drops exactly the stylesheets it cannot see. Linking copies them by reference
 * and sidesteps the question. Constructable stylesheets (`adoptedStyleSheets`) have no href to
 * copy and must be serialised, but they are always same-origin, so reading them is safe.
 */
export function collectStyleSources(doc: Document): {
  hrefs: string[]
  css: string[]
} {
  const hrefs: string[] = []
  const css: string[] = []

  for (const node of Array.from(doc.querySelectorAll("link[rel~='stylesheet'], style"))) {
    if (node.tagName === "LINK") {
      const href = (node as HTMLLinkElement).href
      // `media="print"` sheets are kept: they are the ones meant for this.
      if (href) hrefs.push(href)
    } else {
      css.push(node.textContent ?? "")
    }
  }

  const adopted = (doc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets
  for (const sheet of adopted ?? []) {
    try {
      css.push(Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n"))
    } catch {
      // Unreadable sheets are skipped rather than thrown over.
    }
  }

  return { hrefs, css }
}

/**
 * Copies live form state onto the clone, which does not have any.
 *
 * `cloneNode` copies attributes, and what the user typed is not an attribute — `input.value` is a
 * property that leaves the `value` attribute at whatever the markup said. So a filled-in form
 * serialises back to the empty form it started as: the order printed as a record of what was
 * submitted comes out blank, and it looks finished. Checkboxes, selected options and textareas all
 * fail the same way, each through a different property.
 *
 * The two trees are walked by index rather than by matching nodes, which is safe because the clone
 * is a structural copy and `querySelectorAll` returns document order on both sides.
 */
export function freezeFormState(source: Element, clone: Element): void {
  const fields = "input, textarea, select"
  const live = collect(source, fields)
  const copies = collect(clone, fields)

  for (let i = 0; i < live.length && i < copies.length; i++) {
    const from = live[i]
    const to = copies[i]

    if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
      if (from.type === "checkbox" || from.type === "radio") {
        if (from.checked) to.setAttribute("checked", "")
        else to.removeAttribute("checked")
      } else {
        to.setAttribute("value", from.value)
      }
    } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
      to.textContent = from.value
    } else if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
      for (let o = 0; o < from.options.length && o < to.options.length; o++) {
        if (from.options[o].selected) to.options[o].setAttribute("selected", "")
        else to.options[o].removeAttribute("selected")
      }
    }
  }
}

/**
 * Replaces cloned canvases with a picture of what they were showing.
 *
 * A canvas is an element plus a bitmap, and cloning copies only the element — the copy is a
 * correctly sized blank rectangle. Charts, sparklines and a signature captured on a contract all
 * print as white space unless the pixels are carried over by hand.
 *
 * A canvas that has been drawn with a cross-origin image is tainted and `toDataURL` throws on it.
 * That is left as the blank rectangle it already was: one missing picture is not a reason for the
 * whole sheet to fail.
 */
export function freezeCanvases(source: Element, clone: Element): void {
  const live = collect(source, "canvas")
  const copies = collect(clone, "canvas")

  for (let i = 0; i < live.length && i < copies.length; i++) {
    const from = live[i]
    const to = copies[i]
    if (!(from instanceof HTMLCanvasElement)) continue

    try {
      const image = to.ownerDocument.createElement("img")
      image.src = from.toDataURL()
      image.width = from.width
      image.height = from.height
      image.style.cssText = to.getAttribute("style") ?? ""
      image.className = to.className
      image.alt = to.getAttribute("aria-label") ?? ""
      to.replaceWith(image)
    } catch {
      // Tainted canvas: leave the blank element rather than losing the sheet.
    }
  }
}

/** The rules that make a screen region behave on paper. See {@link buildPrintableDocument}. */
const BASE_PRINT_CSS = `
@page { margin: 12mm; }
:root { color-scheme: light; }
html, body { margin: 0; padding: 0; background: #fff; }
/* Browsers drop background colours and images when printing, so anything colour-coded on screen —
   a status pill, a highlighted row, a chart's fills — comes out white on white. */
*, *::before, *::after {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
/* A region that scrolls on screen must not scroll on paper: a scroll box keeps its height, and
   everything below the fold is simply absent from a sheet that looks complete. */
[${PRINT_MARKER}] * {
  max-height: none !important;
  max-width: none !important;
  overflow: visible !important;
}
`

/**
 * Builds the standalone document that gets printed.
 *
 * The `<base>` is load-bearing. A `srcdoc` frame has no URL of its own, so every relative `src` and
 * `href` in the copied markup resolves against nothing and the logo, the avatars and the product
 * shots all fail to load — on a sheet that otherwise looks right.
 *
 * The title matters more than it looks: it is what the browser puts in the "Save as PDF" filename
 * box, so `invoice-1041` beats whatever the page happened to be called.
 */
export function buildPrintableDocument({
  title,
  bodyHtml,
  baseHref,
  hrefs = [],
  css = [],
  pageStyle = "",
  lang = "en",
  dir,
}: {
  title: string
  bodyHtml: string
  baseHref: string
  hrefs?: string[]
  css?: string[]
  pageStyle?: string
  lang?: string
  dir?: string
}): string {
  const links = hrefs
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join("\n")
  const inline = css.map((text) => `<style>${text}</style>`).join("\n")

  return `<!doctype html>
<html lang="${escapeHtml(lang)}"${dir ? ` dir="${escapeHtml(dir)}"` : ""}>
<head>
<meta charset="utf-8">
<base href="${escapeHtml(baseHref)}">
<title>${escapeHtml(title)}</title>
${links}
${inline}
<style>${BASE_PRINT_CSS}</style>
${pageStyle ? `<style>${pageStyle}</style>` : ""}
</head>
<body ${PRINT_MARKER}>
${bodyHtml}
</body>
</html>`
}

/**
 * Prints `html` as a document of its own, and resolves once the browser is done with it.
 *
 * The frame recipe is the part that has to be exactly right, and each line below is a browser that
 * behaves differently:
 *
 * - The frame is 0x0 and transparent, never `display: none` — a frame that is not being displayed
 *   has nothing to print, and browsers say so by printing a blank page.
 * - `srcdoc` is assigned before the frame is inserted, so the only `load` event is the sheet's.
 *   Inserting first fires one for the initial `about:blank`; the marker check refuses that
 *   document even if the order is ever changed back.
 * - Printing happens on `load` rather than immediately, because that event is what waits for the
 *   copied stylesheets to arrive. {@link STYLE_TIMEOUT_MS} is the bound on that wait.
 * - Cleanup waits for `afterprint`. `print()` blocks until the dialog closes in Chrome and Firefox
 *   but returns immediately in Safari, where tearing down on the next line pulls the document out
 *   from under a dialog that is still open.
 */
export function printRegion(html: string): Promise<PrintOutcome> {
  if (typeof window === "undefined" || typeof window.print !== "function") {
    return Promise.resolve("unavailable")
  }

  return new Promise((resolve) => {
    const frame = document.createElement("iframe")
    frame.setAttribute("aria-hidden", "true")
    frame.setAttribute("tabindex", "-1")
    frame.setAttribute("title", "Print preview")
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none"

    let printed = false
    let settled = false
    let styleTimer = 0
    let cleanupTimer = 0

    const finish = (outcome: PrintOutcome) => {
      if (settled) return
      settled = true
      window.clearTimeout(styleTimer)
      window.clearTimeout(cleanupTimer)
      frame.remove()
      resolve(outcome)
    }

    const send = () => {
      if (printed || settled) return
      const frameWindow = frame.contentWindow
      if (!frameWindow?.document.querySelector(`[${PRINT_MARKER}]`)) return
      printed = true
      window.clearTimeout(styleTimer)
      cleanupTimer = window.setTimeout(() => finish("done"), CLEANUP_MS)
      frameWindow.addEventListener("afterprint", () => finish("done"))
      try {
        frameWindow.focus()
        frameWindow.print()
      } catch {
        finish("failed")
      }
    }

    frame.srcdoc = html
    frame.onload = send
    // The fallback has to settle the promise even when it cannot print. `send` refuses a document
    // without the marker, and a refusal that scheduled nothing after it would leave the caller
    // awaiting a promise that never resolves — and the button disabled for good.
    styleTimer = window.setTimeout(() => {
      if (printed || settled) return
      if (frame.contentWindow?.document.querySelector(`[${PRINT_MARKER}]`)) send()
      else finish("failed")
    }, STYLE_TIMEOUT_MS)
    document.body.appendChild(frame)
  })
}

export interface PrintButtonProps
  extends Omit<React.ComponentPropsWithoutRef<"button">, "children"> {
  /** The region to print. Everything inside it goes on the sheet; nothing else does. */
  target: React.RefObject<HTMLElement | null>
  /** Becomes the sheet's `<title>`, and the default filename under "Save as PDF". */
  documentTitle?: string
  /** Label shown while the button is at rest. */
  children?: React.ReactNode
  /** Extra CSS for the printed document, appended after the page's own. */
  pageStyle?: string
  /** Called before the region is serialised — the place to expand rows or reveal hidden detail. */
  onBeforePrint?: () => void
  /** Called once the dialog closes. `done` does not distinguish printing from cancelling. */
  onPrintEnd?: (outcome: PrintOutcome) => void
}

/**
 * Prints one region of the page instead of the page.
 *
 * `window.print()` prints the document, which is almost never what the button next to an invoice
 * is for: the nav, the sidebar and the cookie banner come with it. The alternative usually reached
 * for is a print stylesheet that hides everything else, which pushes a global `@media print` rule
 * into the app and breaks the next time the layout changes.
 */
export function PrintButton({
  target,
  documentTitle,
  children = "Print",
  pageStyle,
  onBeforePrint,
  onPrintEnd,
  onClick,
  className,
  disabled,
  ...props
}: PrintButtonProps) {
  const [status, setStatus] = React.useState<"idle" | "working" | PrintOutcome>("idle")
  const alive = React.useRef(true)

  React.useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  React.useEffect(() => {
    if (status !== "unavailable" && status !== "failed") return
    const id = window.setTimeout(() => setStatus("idle"), 2500)
    return () => window.clearTimeout(id)
  }, [status])

  async function handleClick(event: React.MouseEvent<HTMLButtonElement>) {
    onClick?.(event)
    if (event.defaultPrevented || status === "working") return

    const region = target.current
    if (!region) {
      setStatus("failed")
      onPrintEnd?.("failed")
      return
    }

    setStatus("working")
    onBeforePrint?.()

    let html: string
    try {
      const clone = region.cloneNode(true) as HTMLElement
      freezeFormState(region, clone)
      freezeCanvases(region, clone)

      const { hrefs, css } = collectStyleSources(document)
      html = buildPrintableDocument({
        title: documentTitle ?? document.title,
        bodyHtml: clone.outerHTML,
        baseHref: document.baseURI,
        hrefs,
        css,
        pageStyle,
        lang: document.documentElement.lang || "en",
        dir: document.documentElement.dir || undefined,
      })
    } catch {
      if (alive.current) setStatus("failed")
      onPrintEnd?.("failed")
      return
    }

    const outcome = await printRegion(html)
    // The dialog can sit open for minutes, which is long enough to navigate away from the page
    // that opened it.
    if (alive.current) setStatus(outcome === "done" ? "idle" : outcome)
    onPrintEnd?.(outcome)
  }

  const message =
    status === "working"
      ? "Preparing to print"
      : status === "unavailable"
        ? "Printing is not available in this browser"
        : status === "failed"
          ? "Could not prepare the sheet"
          : null

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || status === "working"}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        className
      )}
      {...props}
    >
      {/* The icon never depends on feature detection, so the server and the first client render
          agree and nothing has to hydrate twice. */}
      <Printer className="h-4 w-4" aria-hidden="true" />
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
      <span aria-hidden={message && status !== "working" ? true : undefined}>
        {status === "unavailable" || status === "failed" ? message : children}
      </span>
    </button>
  )
}
