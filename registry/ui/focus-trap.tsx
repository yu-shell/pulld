"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Keeps keyboard focus inside one subtree — for the overlays you built yourself.
 *
 * Radix's dialog, sheet and drawer already confine focus, so this is not for them. It is for the
 * overlay that is yours: a command palette, an inspector panel over a canvas, a side sheet, a
 * full-screen confirm step, a popover positioned by hand. Those get built because the primitive
 * did not fit, and then the keyboard walks straight out the back of them into the page underneath.
 *
 * Everything below is one of five answers to "how does focus leave a box":
 *
 *   1. **Tab, in an order that is not the DOM's.** A positive `tabindex` anywhere in the subtree
 *      reorders the browser's own sequence, so a trap that walks a `querySelectorAll` result in
 *      document order moves focus somewhere the browser would not have.
 *   2. **Tab, onto something that only looks focusable.** `disabled`, `inert` on an ancestor, a
 *      `display: none` subtree, a closed `<details>`, `visibility: hidden`, `type="hidden"` — a
 *      static selector match says yes to all of them and the browser says no to every one.
 *   3. **Not Tab at all.** A click outside, a programmatic `focus()` from some other component's
 *      effect, an autofocusing field that mounts late. No key was pressed, so a keydown handler
 *      never runs.
 *   4. **Closing.** Focus has to go back to whatever opened the overlay, and that element is
 *      sometimes gone — the row whose "Delete" button opened the dialog is the row the dialog
 *      deleted.
 *   5. **Nesting.** A popover inside a dialog. Two traps both listening on the document fight over
 *      every Tab, and the outer one winning means the inner one is decorative.
 *
 * The pieces are exported as plain functions, because the hard part is the tab-stop predicate and
 * it is worth being able to call it — and test it — on its own.
 */

/**
 * The elements a tab stop can be, before any of the conditions that disqualify one.
 *
 * Deliberately wider than it needs to be, and then narrowed by {@link isTabbable}. The tempting
 * version does both at once — `button:not([disabled])`, `[tabindex]:not([tabindex^="-"])` — and
 * that last clause is a string comparison standing in for an integer parse. `tabindex=" -1 "` is a
 * negative tab index that does not start with a minus sign, so the selector keeps it and the
 * browser skips it. Collect on tag and attribute presence; decide in code.
 */
export const TABBABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",")

/**
 * An HTML integer attribute, or `null` for "no usable value".
 *
 * Both obvious readings of `tabindex` are wrong, in opposite directions, and each has a case that
 * matters. Measured, in Node:
 *
 *   - `Number("")` is **0**, not `NaN`. An empty `tabindex=""` is not a valid integer, so the
 *     browser ignores the attribute — but `Number` reads it as an explicit zero, which inverts the
 *     answer for `<div tabindex="">`: ignored means "not a tab stop", zero means "is one".
 *   - `Number.parseInt("3abc")` is **3** and `Number.parseInt("1e2")` is **1**, where the spec
 *     calls both values invalid. `parseInt` also takes `"0x10"` as 0 and `"2.7"` as 2.
 *
 * So the value is validated against the spec's integer grammar first (optional sign, digits, ASCII
 * whitespace allowed either side) and only then parsed. `"+3"` and `" 3 "` are valid and come back
 * as 3; `""`, `"3abc"`, `"1e2"`, `"2.7"`, `"0x10"` and `"abc"` all come back as `null`.
 */
export function readTabIndex(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  if (!/^[ \t\n\f\r]*[+-]?\d+[ \t\n\f\r]*$/.test(raw)) return null
  const value = Number.parseInt(raw, 10)
  return Number.isNaN(value) ? null : value
}

/** The `tabindex` an element declares, or `null` if it declares none that parses. */
function declaredTabIndex(node: Element): number | null {
  return readTabIndex(node.getAttribute?.("tabindex"))
}

/**
 * Whether `node` is somewhere the browser would put focus when Tab is pressed.
 *
 * Each clause below is a case where the selector matched and the browser disagrees. The order is
 * cheapest first; the last two are the ones that need to look at rendering.
 *
 * `aria-hidden="true"` is the one judgement call here rather than a rule. It does not actually stop
 * the browser focusing an element — a focusable node inside an `aria-hidden` subtree is reachable
 * by keyboard and invisible to a screen reader, which is a bug wherever it occurs. Treating it as
 * not-a-stop is the reading that does not land a screen-reader user on a control their software
 * will not announce.
 */
export function isTabbable(node: Element): boolean {
  if (!node) return false

  // A negative tab index is focusable but not tabbable — that is the whole point of `-1`, and it is
  // what the trap's own container uses to be a focus target without becoming a stop inside itself.
  const declared = declaredTabIndex(node)
  if (declared !== null && declared < 0) return false

  // `disabled` on a form control. Not a concern for `a[href]`, where the attribute means nothing,
  // and harmless to check there.
  if (node.hasAttribute?.("disabled")) return false

  // A hidden input is a transport for a value, not a control.
  if (node.getAttribute?.("type")?.toLowerCase() === "hidden") return false

  // `inert` is inherited by the whole subtree, so the element's own attribute is not the question —
  // a dialog marking the page behind it inert does so on one wrapper far above these nodes.
  if (node.closest?.("[inert]")) return false
  if (node.closest?.('[aria-hidden="true"]')) return false

  // "Is it rendered" in the cheapest honest form: a node in a `display: none` subtree, or inside a
  // closed `<details>`, generates no boxes at all. Agreeing with the browser's own tab order is
  // what makes this better than walking computed styles up the tree.
  //
  // Absent on a node that was never in a document — the server's answer, and a test's — and that
  // case reads as "not measured" rather than "not rendered".
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false

  // `visibility: hidden` is the case the box check cannot see, and it is not an edge case: a
  // collapsed accordion panel or an off-state tab panel is routinely written this way, and such an
  // element **generates boxes** — it takes up its space, it is merely not painted. So
  // `getClientRects()` is non-empty and the browser still skips it. Checked last because it is the
  // only clause that costs a style resolution.
  if (typeof getComputedStyle === "function") {
    const visibility = getComputedStyle(node)?.visibility
    if (visibility === "hidden" || visibility === "collapse") return false
  }

  return true
}

/**
 * The browser's sequential focus navigation order for a set of elements already in document order.
 *
 * Elements with a positive `tabindex` come first, ascending by value; everything else keeps
 * document order behind them. This is the rule that makes a positive `tabindex` a mistake in most
 * code — it jumps the queue globally — and the rule a trap has to reproduce, since a trap that
 * takes over Tab has taken over the order too.
 *
 * The sort is relied upon to be stable, so two elements with `tabindex="2"` stay in the order they
 * appear in the document. `Array.prototype.sort` has been stable by specification since ES2019
 * (verified here: twelve items keyed `i % 3` come out with each group in its original order).
 */
export function orderByTabIndex<T extends Element>(nodes: readonly T[]): T[] {
  const jumpers: { node: T; index: number; at: number }[] = []
  const inOrder: T[] = []
  nodes.forEach((node, at) => {
    const declared = declaredTabIndex(node)
    if (declared !== null && declared > 0) jumpers.push({ node, index: declared, at })
    else inOrder.push(node)
  })
  jumpers.sort((a, b) => a.index - b.index || a.at - b.at)
  return [...jumpers.map((entry) => entry.node), ...inOrder]
}

/**
 * The tab stops inside `root`, in the order Tab would visit them — plus `root` itself if it is one.
 *
 * Never cached. A trap over a form that loads asynchronously, or a list that grows, has stops that
 * did not exist when it opened; a list taken once at mount cannot reach them, and the person who
 * tabs past the end of the stale list is sent back to its start with half the dialog unreachable.
 * Recomputed on every Tab instead, which is one `querySelectorAll` per keystroke.
 */
export function tabbablesIn(root: Element | null | undefined): HTMLElement[] {
  if (!root || typeof root.querySelectorAll !== "function") return []
  const found = Array.from(root.querySelectorAll(TABBABLE_SELECTOR)) as HTMLElement[]
  // A root can be the control rather than contain one — a trap placed directly on a single button —
  // and a scope of descendants only would have nothing in it.
  if (root.matches?.(TABBABLE_SELECTOR)) found.unshift(root as HTMLElement)
  return orderByTabIndex(found.filter(isTabbable))
}

/**
 * The index to move to, or `null` when there is nowhere to go.
 *
 * Two arithmetic traps, both measured: `(0 - 1) % 3` is **-1** in JavaScript, not 2, so the naive
 * wrap sends Shift+Tab from the first stop to index −1 and focus goes nowhere; and `% 0` is
 * **NaN**, so an empty scope produces `stops[NaN]`. Adding `count` before the modulo fixes the
 * first and the `count <= 0` guard fixes the second.
 *
 * `at < 0` is the ordinary case on the first Tab, when focus is on the container itself rather than
 * on a stop: forwards that enters at the first stop, backwards at the last.
 */
export function nextStop(count: number, at: number, delta: number): number | null {
  if (count <= 0) return null
  if (at < 0) return delta < 0 ? count - 1 : 0
  return (at + delta + count) % count
}

/**
 * The traps currently mounted and active, outermost first.
 *
 * Every trap listens on the document, because that is the only place a trap can listen: the moment
 * focus is anywhere other than inside the container, a listener bound to the container stops
 * seeing keys. Which means that with a popover open inside a dialog, both of them see every Tab,
 * and both try to move focus — the dialog pulling it back to the dialog's first stop, the popover
 * to the popover's. Focus ends up wherever the second listener ran, and Shift+Tab becomes
 * unpredictable.
 *
 * So only the last one to open acts. Module scope is the right place for this because it is a fact
 * about the page, not about any one component, and nesting is between two different instances. It
 * is only ever touched inside effects, so a server render never populates it.
 */
const TRAPS: object[] = []

const isTopmost = (id: object) => TRAPS.length > 0 && TRAPS[TRAPS.length - 1] === id

/** Where focus goes when the trap opens. A function is called at open time and may return null. */
export type InitialFocus = "first" | "container" | "none" | (() => HTMLElement | null)

/**
 * Where focus goes when the trap closes. `true` means "back where it was"; a function names a
 * target, which is how you survive the case where "where it was" has been removed.
 */
export type ReturnFocus = boolean | (() => HTMLElement | null)

export interface FocusTrapOptions {
  /** Off leaves the subtree alone, so an overlay can stay mounted while closed. Default `true`. */
  active?: boolean
  /**
   * Which escape routes to close.
   *
   * `"all"` (default) also pulls focus back when it lands outside without a Tab — a click on the
   * page behind, another component's `focus()` call, a field that autofocuses as it mounts. That is
   * what a modal overlay means, and it is the half a keydown handler cannot do.
   *
   * `"tab"` handles only the key. Use it for something modeless, where clicking the page behind is
   * allowed and yanking focus back from it would be an argument with the person using it.
   */
  confine?: "tab" | "all"
  /** Default `"first"`: the first stop inside, falling back to the container. */
  initialFocus?: InitialFocus
  /** Default `true`. */
  returnFocus?: ReturnFocus
  /** Called on Escape. Without it, Escape is left to whatever else is listening. */
  onEscape?: () => void
}

/**
 * Confines focus to `ref`'s subtree while `active`.
 *
 * The hook rather than the component is the point of entry for an overlay you have already built —
 * put it on the element you already render, instead of wrapping it in another `div` that changes
 * your layout.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  { active = true, confine = "all", initialFocus = "first", returnFocus = true, onEscape }: FocusTrapOptions = {}
): void {
  /**
   * The options, always this render's, for the listeners below to read.
   *
   * Kept in a ref updated after every render rather than listed as effect dependencies, so that
   * passing `onEscape={() => setOpen(false)}` — a new function identity every render, which is how
   * everybody writes it — does not tear the trap down and rebuild it on each render. Rebuilding
   * would re-run the open sequence, and the open sequence moves focus: the person would be returned
   * to the first field every time anything above them re-rendered.
   */
  const latest = React.useRef({ confine, initialFocus, returnFocus, onEscape })
  React.useEffect(() => {
    latest.current = { confine, initialFocus, returnFocus, onEscape }
  })

  // This instance's identity in TRAPS. An object rather than a string, so two traps are never
  // mistaken for each other however they were rendered.
  const idRef = React.useRef<object>({})

  React.useEffect(() => {
    if (!active || typeof document === "undefined") return
    const id = idRef.current
    TRAPS.push(id)

    // Read before anything is focused, which is the only moment it is still true.
    const openedFrom = document.activeElement as HTMLElement | null

    const container = ref.current
    const wanted = latest.current.initialFocus
    if (container && wanted !== "none") {
      const target =
        typeof wanted === "function"
          ? wanted()
          : wanted === "container"
            ? container
            : (tabbablesIn(container)[0] ?? container)
      target?.focus?.()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTopmost(id)) return
      if (event.key === "Escape") {
        const escape = latest.current.onEscape
        if (!escape) return
        event.preventDefault()
        escape()
        return
      }
      if (event.key !== "Tab") return
      const node = ref.current
      if (!node) return
      const stops = tabbablesIn(node)
      // Prevented even when the move stays inside, because the order being this one and not the
      // document's is the entire behaviour — and prevented when there is nowhere to go at all,
      // since letting that Tab through is precisely the leak this exists to stop. An overlay whose
      // only control has just become disabled still holds the keyboard.
      event.preventDefault()
      if (stops.length === 0) {
        node.focus?.()
        return
      }
      const focused = document.activeElement as HTMLElement | null
      const at = focused ? stops.indexOf(focused) : -1
      const to = nextStop(stops.length, at, event.shiftKey ? -1 : 1)
      if (to !== null) stops[to]?.focus?.()
    }

    /**
     * The half that has nothing to do with keys.
     *
     * Focus arriving outside the container is pulled back to its first stop. Capture phase and on
     * the document for the same reason as the keys: by the time this matters, focus is somewhere
     * else entirely.
     *
     * This cannot loop. Pulling focus back fires another `focusin`, and that one is inside the
     * container, so it returns at the containment check. If the pull fails — nothing inside can
     * take focus — no `focusin` is dispatched at all.
     */
    const onFocusIn = (event: FocusEvent) => {
      if (latest.current.confine !== "all") return
      if (!isTopmost(id)) return
      const node = ref.current
      if (!node) return
      const target = event.target as Node | null
      if (target && node.contains?.(target)) return
      const stops = tabbablesIn(node)
      ;(stops[0] ?? node).focus?.()
    }

    document.addEventListener("keydown", onKeyDown, true)
    document.addEventListener("focusin", onFocusIn, true)

    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.removeEventListener("focusin", onFocusIn, true)
      // `lastIndexOf` and a splice rather than a pop: a trap is not always the one on top when it
      // closes. Two overlays dismissed by the same state change unmount in render order, which is
      // outermost first.
      const at = TRAPS.lastIndexOf(id)
      if (at !== -1) TRAPS.splice(at, 1)

      const how = latest.current.returnFocus
      const target = typeof how === "function" ? how() : how ? openedFrom : null
      /**
       * Nothing is focused if the target has left the document, and that is the common case rather
       * than a defensive check: the button that opened a confirm dialog is often inside the row the
       * dialog was confirming the deletion of. Calling `focus()` on a detached node silently moves
       * focus to the body, which drops the keyboard at the top of the page — worse than leaving it
       * alone, and indistinguishable from it in a test. Pass a function to `returnFocus` to name
       * somewhere that will still exist, such as the list the row was in.
       */
      if (target && (target.isConnected ?? true)) target.focus?.()
    }
    // `ref` is stable and the options are read through `latest`, so this runs on open and close and
    // at no other time — see the note on `latest` above.
  }, [active, ref])
}

export interface FocusTrapProps extends React.ComponentPropsWithoutRef<"div">, FocusTrapOptions {}

/**
 * A `div` that holds the keyboard.
 *
 * `tabIndex={-1}` is on it by default and is load-bearing twice over: it makes the container itself
 * a place focus can be put — needed when the subtree has no stops yet, or none left — while
 * `isTabbable` reads that same `-1` as "not a stop", so the container never becomes a stop within
 * its own scope. Override it through props if you have a reason.
 */
export function FocusTrap({
  active,
  confine,
  initialFocus,
  returnFocus,
  onEscape,
  className,
  ...props
}: FocusTrapProps) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  useFocusTrap(ref, { active, confine, initialFocus, returnFocus, onEscape })
  return <div ref={ref} tabIndex={-1} className={cn("outline-none", className)} {...props} />
}
