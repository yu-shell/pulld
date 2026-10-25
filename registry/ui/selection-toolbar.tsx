"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A rectangle in viewport coordinates, as `getClientRects` gives them.
 *
 * Structural rather than `DOMRect` so the placement below can be exercised with plain numbers.
 */
export interface SelectionRect {
  top: number
  left: number
  bottom: number
  right: number
  width: number
  height: number
}

/** Which side of the selected text the toolbar ended up on. Mirrored to `data-side`. */
export type ToolbarSide = "above" | "below"

export interface Placement {
  /** Viewport coordinates, for `position: fixed`. */
  left: number
  top: number
  side: ToolbarSide
}

/**
 * Whether a selection is one this toolbar can point at.
 *
 * Both halves carry weight, and the second is the one that is easy to leave out. Text selected
 * inside an `<input>` or `<textarea>` fires `selectionchange` on the document like any other
 * selection, **and the document's own selection reports that field's text** — measured in
 * Chromium 152: focusing an input and calling `setSelectionRange(0, 5)` left
 * `getSelection().toString()` reading `"focus"`, with `rangeCount` 1 and `anchorNode` the body.
 * A toolbar keyed on "the selection is not empty" therefore opens every time someone drags
 * across a search box.
 *
 * What that selection does not have is a shape. `isCollapsed` is true and `getClientRects()` is
 * empty, because the field's selection belongs to the field rather than to the document — so
 * there is nowhere to put a toolbar even if opening it were right. Those two are the test, and
 * the text never is.
 */
export function selectionIsPresentable(snapshot: {
  collapsed: boolean
  rectCount: number
}): boolean {
  return !snapshot.collapsed && snapshot.rectCount > 0
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high)

export interface PlaceToolbarOptions {
  /** One rect per line of the selection, in document order. See `placeToolbar`. */
  rects: readonly SelectionRect[]
  /** The toolbar's own measured size. Zero before it has been measured, which is a valid first pass. */
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  /** Distance between the toolbar and the line it points at. */
  gap: number
  /** Closest the toolbar may come to a viewport edge. */
  margin: number
}

/**
 * Where to put the toolbar for a given selection.
 *
 * **It is anchored to a line, not to the selection's bounding box**, and that is the whole reason
 * this is a function rather than two lines at the call site. A selection spanning two lines
 * returns two rects — measured: selecting 60 characters of a 260px column gave rects at
 * `left: 29 → 284.9` and `left: 29 → 153` — and the union of those two is the width of the
 * *column*. Centring on the union therefore centres the toolbar on the paragraph rather than on
 * any text the user can see highlighted, and it is worst exactly when it is most visible: for a
 * backward selection starting mid-line, the union ran `29 → 284.9` while the only highlighted
 * text on that line started at `101.8`.
 *
 * The first line is the anchor, not the line the caret is on. Chromium does expose
 * `Selection.direction`, but it answered `"none"` for a real mouse drag in the same session where
 * it answered `"forward"` for a keyboard selection, so which end the caret sits at is not
 * dependable; and a toolbar that opens under the pointer that just released is a toolbar that
 * gets clicked by accident. Document order is both knowable and steady.
 *
 * Above is preferred because the text *below* a selection is what the reader is moving toward.
 * When there is no room above, the toolbar flips under the last line. When there is no room on
 * either side — a selection taller than the viewport — it is clamped inside the viewport and will
 * overlap the text, on the grounds that a toolbar covering a word is better than one off-screen.
 */
export function placeToolbar({
  rects,
  width,
  height,
  viewportWidth,
  viewportHeight,
  gap,
  margin,
}: PlaceToolbarOptions): Placement | null {
  if (rects.length === 0) return null

  const first = rects[0]
  const last = rects[rects.length - 1]

  const aboveTop = first.top - gap - height
  const fitsAbove = aboveTop >= margin
  const anchor = fitsAbove ? first : last
  const side: ToolbarSide = fitsAbove ? "above" : "below"

  // `Math.max(margin, ...)` keeps the clamp well-ordered when the toolbar is larger than the
  // space it is being fitted into; without it the high bound falls below the low one and the
  // result is the far edge rather than the near one.
  const top = clamp(
    fitsAbove ? aboveTop : last.bottom + gap,
    margin,
    Math.max(margin, viewportHeight - height - margin)
  )
  const left = clamp(
    anchor.left + anchor.width / 2 - width / 2,
    margin,
    Math.max(margin, viewportWidth - width - margin)
  )

  return { left, top, side }
}

/**
 * Whether two placements say the same thing.
 *
 * Used to hold the previous object when nothing moved. A component that re-measures on every
 * commit and writes the result back to state re-renders forever unless the unchanged case returns
 * the identical object, because React bails out on identity and not on shape.
 */
export function samePlacement(a: Placement | null, b: Placement | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.left === b.left && a.top === b.top && a.side === b.side
}

export interface SelectionToolbarOptions {
  /**
   * Limits the toolbar to selections inside this element. Omit it to serve the whole page.
   *
   * Point it at the article or editor the actions make sense for: "quote this" is wrong for text
   * selected in the site navigation.
   */
  rootRef?: React.RefObject<HTMLElement | null>
  /** Stop watching entirely. The toolbar renders nothing and no listeners are attached. */
  disabled?: boolean
  /** Distance between the toolbar and the line it points at (default 8). */
  gap?: number
  /** Closest the toolbar may come to a viewport edge (default 8). */
  margin?: number
}

export interface SelectionToolbarState {
  open: boolean
  /** The selected text as it was when the toolbar opened. See the note in `useSelectionToolbar`. */
  text: string
  /** A clone of the selected range, for an action that needs the nodes rather than the string. */
  range: Range | null
  /** Null for the one commit between opening and being measured. */
  placement: Placement | null
  close: () => void
  /** Attach to the toolbar element; its size is half of the placement. */
  toolbarRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Watches the document selection and works out where a toolbar for it belongs.
 *
 * The event is `selectionchange` on the document, and it is the only source — not `mouseup`.
 * A selection made with Shift and the arrow keys produces **no mouseup at all** (measured: five
 * Shift+ArrowRight presses, zero mouseup events), so a toolbar built on mouseup is a toolbar
 * keyboard users never see.
 *
 * **There is no debounce, deliberately.** `selectionchange` has a reputation for firing in floods,
 * and it does not: the browser queues it rather than dispatching it synchronously, and coalesces
 * everything that happened in one task into a single event. Measured, in the same session — three
 * programmatic selection changes in one task produced **1** event; five Shift+ArrowRight presses
 * produced **2**; a full click-drag across two lines produced **3**. The handler is already
 * bounded by the frame rate, and a debounce on top of that only makes the toolbar lag the
 * highlight it is pointing at.
 *
 * Closing needs no listener of its own either: the mousedown that begins the next drag collapses
 * the selection, which is itself a `selectionchange` with nothing selected.
 */
export function useSelectionToolbar({
  rootRef,
  disabled = false,
  gap = 8,
  margin = 8,
}: SelectionToolbarOptions = {}): SelectionToolbarState {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState("")
  const [placement, setPlacement] = React.useState<Placement | null>(null)
  // Held in a ref rather than state: it is read during measurement, and a new object on every
  // `selectionchange` during a drag would re-render for a value nothing renders.
  const rangeRef = React.useRef<Range | null>(null)
  const toolbarRef = React.useRef<HTMLDivElement | null>(null)

  const close = React.useCallback(() => {
    rangeRef.current = null
    setOpen(false)
    setPlacement(null)
  }, [])

  const reposition = React.useCallback(() => {
    const range = rangeRef.current
    if (range === null) return

    // Re-read rather than remembered. The rects are viewport coordinates, so they are stale the
    // moment anything scrolls — and the range is the thing that knows where it is now.
    const rects: SelectionRect[] =
      typeof range.getClientRects === "function" ? Array.from(range.getClientRects()) : []
    if (rects.length === 0) {
      // The text the toolbar was pointing at has been removed from the page, or collapsed into a
      // field. Either way there is nothing left to point at.
      close()
      return
    }

    const box = toolbarRef.current?.getBoundingClientRect?.()
    const next = placeToolbar({
      rects,
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      gap,
      margin,
    })
    setPlacement((previous) => (samePlacement(previous, next) ? previous : next))
  }, [close, gap, margin])

  // --- watching the selection --------------------------------------------------------------
  React.useEffect(() => {
    if (disabled) return

    const read = () => {
      const selection = document.getSelection()
      if (selection === null || selection.rangeCount === 0) {
        close()
        return
      }
      const range = selection.getRangeAt(0)
      const root = rootRef?.current
      if (root && !root.contains(range.commonAncestorContainer)) {
        close()
        return
      }
      if (
        !selectionIsPresentable({
          collapsed: selection.isCollapsed,
          rectCount: range.getClientRects().length,
        })
      ) {
        close()
        return
      }
      // Cloned: the live range the selection hands back is mutated in place as the drag continues,
      // so an action that ran later would act on wherever the selection ended rather than on what
      // the toolbar was opened for.
      rangeRef.current = range.cloneRange()
      setText(selection.toString())
      setOpen(true)
    }

    document.addEventListener("selectionchange", read)
    return () => document.removeEventListener("selectionchange", read)
  }, [close, disabled, rootRef])

  // --- keeping it in place -------------------------------------------------------------------
  // Runs after every commit while the toolbar is up, with no dependency list on purpose: the first
  // commit is the one that creates the element whose width the placement is centred on, so the
  // measurement has to happen after a render rather than before one. It terminates because
  // `reposition` hands back the previous placement object when nothing moved.
  React.useLayoutEffect(() => {
    if (open) reposition()
  })

  React.useEffect(() => {
    if (!open) return

    const onViewportChange = () => reposition()
    // Capture phase. A scroll event from a nested scroller does not bubble, so a listener on the
    // window hears only the document scrolling — measured: scrolling an inner pane by 30px moved
    // the selection rect by exactly 30px, and of three listeners (window bubble, window capture,
    // document bubble) **only the capture one heard it**. A selection inside a scrollable pane is
    // the ordinary case for a chat log or a diff view, not an exotic one.
    window.addEventListener("scroll", onViewportChange, true)
    window.addEventListener("resize", onViewportChange)
    // Pinch-zoom moves the visual viewport under the layout viewport without a scroll or resize
    // event, which is the mobile version of the toolbar drifting away from its text.
    const visual = window.visualViewport
    visual?.addEventListener("resize", onViewportChange)
    visual?.addEventListener("scroll", onViewportChange)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    document.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("scroll", onViewportChange, true)
      window.removeEventListener("resize", onViewportChange)
      visual?.removeEventListener("resize", onViewportChange)
      visual?.removeEventListener("scroll", onViewportChange)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [close, open, reposition])

  return { open, text, range: rangeRef.current, placement, close, toolbarRef }
}

export interface SelectionAction {
  /** Stable identity for the list. */
  id: string
  /** The button's accessible name. Shown as text unless `icon` is given and `iconOnly` is set. */
  label: string
  icon?: React.ReactNode
  /** Render the icon alone, with `label` kept as the accessible name. */
  iconOnly?: boolean
  /**
   * Receives what was selected when the toolbar opened, not what is selected now. See the note on
   * `SelectionToolbar` for why those differ.
   */
  onSelect: (selection: { text: string; range: Range | null }) => void
  /** Leave the toolbar up after this action — for a toggle, say. Default false. */
  keepOpen?: boolean
}

export interface SelectionToolbarProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children">,
    SelectionToolbarOptions {
  actions: readonly SelectionAction[]
  /** Accessible name for the toolbar itself. */
  label?: string
}

/**
 * A small toolbar that appears over text the moment it is selected — quote it, copy it, highlight
 * it, share it, ask about it.
 *
 * Render it **immediately after the content it serves**, because that is what puts it in the tab
 * order right after the text: a reader who selected with Shift and the arrow keys then reaches the
 * actions with one Tab. It is `position: fixed`, so where it sits in the markup costs nothing
 * visually and buys that.
 *
 * **Mousedown is prevented on the whole toolbar, and the reason is not the one usually given.**
 * Pressing a button does not destroy the selection — measured through mousedown, mouseup and click
 * on a plain button, inside a `contenteditable` and outside one, the selection was intact at every
 * step. What moves is *focus*: without the guard, `document.activeElement` went from the editor to
 * the button and the caret left the text; with `preventDefault` on mousedown it stayed on the
 * editor, and the click still fired. So the guard earns its place in an editor, where the person
 * is going to keep typing, and it is harmless on an article where nobody was focused anyway.
 *
 * **The text is captured when the toolbar opens**, not read when a button is pressed, and that is
 * not an optimisation. Focusing an `<input>` wipes the document selection outright — measured: a
 * selection reading "Alpha bravo charlie" became `""` and collapsed the instant an input took
 * focus, while focusing a `<button>` left it untouched. An action that opens a comment box or a
 * share dialog with a field in it has therefore destroyed the thing it was about before its own
 * handler can read it. The buttons here are buttons for the same reason.
 *
 * What is *not* covered: touch. On a phone the OS draws its own selection handles and a context
 * menu over the same text, and this toolbar will sit among them. That was not measurable on a
 * desktop browser and so is not claimed — if you ship this to a touch layout, look at it on a real
 * device before deciding the gap is wide enough.
 */
export function SelectionToolbar({
  actions,
  rootRef,
  disabled,
  gap,
  margin,
  label = "Selection actions",
  className,
  style,
  onMouseDown: onMouseDownProp,
  onKeyDown: onKeyDownProp,
  ...props
}: SelectionToolbarProps) {
  const { open, text, range, placement, close, toolbarRef } = useSelectionToolbar({
    rootRef,
    disabled,
    gap,
    margin,
  })

  // One tab stop for the whole toolbar, arrows between the buttons: the toolbar pattern, and the
  // reason it exists is that a five-button toolbar appearing mid-article would otherwise add five
  // tab stops to every paragraph.
  const [activeIndex, setActiveIndex] = React.useState(0)
  const buttonsRef = React.useRef<(HTMLButtonElement | null)[]>([])

  // Adjusted during render rather than in an effect. An effect would reset the roving tab stop one
  // commit *after* the toolbar reopened, so the first arrow key of a new selection would move from
  // whichever button the last selection left behind; and a toolbar whose keyboard position depends
  // on a dependency array is a toolbar that breaks the moment one is edited.
  const [openedFor, setOpenedFor] = React.useState(open)
  if (open !== openedFor) {
    setOpenedFor(open)
    if (open) setActiveIndex(0)
  }

  const focusAt = (index: number) => {
    setActiveIndex(index)
    buttonsRef.current[index]?.focus?.()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDownProp?.(event)
    if (event.defaultPrevented || actions.length === 0) return
    const last = actions.length - 1
    if (event.key === "ArrowRight") {
      event.preventDefault()
      focusAt(activeIndex === last ? 0 : activeIndex + 1)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      focusAt(activeIndex === 0 ? last : activeIndex - 1)
    } else if (event.key === "Home") {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === "End") {
      event.preventDefault()
      focusAt(last)
    }
  }

  const onMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    onMouseDownProp?.(event)
    // See the note on this component. Bubbled from the buttons, and prevented here so every
    // control inside gets the same treatment without each having to remember.
    if (!event.defaultPrevented) event.preventDefault()
  }

  if (!open || actions.length === 0) return null

  return (
    <div
      {...props}
      ref={toolbarRef}
      role="toolbar"
      aria-label={label}
      aria-orientation="horizontal"
      data-side={placement?.side}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        left: placement?.left ?? 0,
        top: placement?.top ?? 0,
        // Hidden rather than unrendered for the one commit before it has been measured: the
        // measurement needs the element, and `visibility: hidden` keeps it out of both the
        // accessibility tree and the tab order while it is still in the wrong place.
        visibility: placement === null ? "hidden" : "visible",
        ...style,
      }}
      className={cn(
        "z-50 flex items-center gap-0.5 rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
        className
      )}
    >
      {actions.map((action, index) => (
        <button
          key={action.id}
          ref={(node) => {
            buttonsRef.current[index] = node
          }}
          type="button"
          tabIndex={index === activeIndex ? 0 : -1}
          aria-label={action.iconOnly ? action.label : undefined}
          onClick={() => {
            action.onSelect({ text, range })
            if (!action.keepOpen) close()
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded px-2 text-sm font-medium text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover"
        >
          {action.icon ? (
            <span aria-hidden="true" className="inline-flex shrink-0">
              {action.icon}
            </span>
          ) : null}
          {action.iconOnly ? null : action.label}
        </button>
      ))}
    </div>
  )
}
