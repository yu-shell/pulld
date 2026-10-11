"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Where an arrow key lands in a menu, wrapping at both ends.
 *
 * Exported and separate because the wrap is the one rule that makes this a menu rather than a list,
 * and it is the opposite of what the components beside it in this registry do. `country-select`,
 * `language-select` and `multi-select` all clamp — `Math.min(active + 1, length - 1)` — which is
 * right for a listbox of 249 countries, where wrapping from Zimbabwe to Afghanistan is a 249-row
 * jump nobody asked for. A menu is three or four items and the convention is the other one: Down on
 * the last item returns to the first, Up on the first goes to the last, so a person arrowing
 * through the options never reaches a key that does nothing. Clamping a three-item menu makes the
 * last item a dead end, which reads as the keyboard having broken rather than as the end of a list.
 *
 * `from` below 0 means nothing is active yet, and the direction decides the entry point: Down opens
 * at the top, Up opens at the bottom. That is the same single rule the trigger needs, so the
 * trigger's two keys and the menu's two keys are one function and cannot drift apart.
 */
export function nextMenuIndex(count: number, from: number, delta: number): number {
  if (!Number.isFinite(count) || count < 1) return -1
  const span = Math.floor(count)
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  if (!Number.isFinite(from) || from < 0) return step < 0 ? span - 1 : 0
  // Two modulos rather than one: a negative remainder is what `%` returns in JavaScript, and Up
  // from position 0 is exactly that case.
  return (((Math.trunc(from) + step) % span) + span) % span
}

export interface SplitButtonLabels {
  /**
   * The arrow's accessible name, built from the default action's label.
   *
   * A function rather than a string because the name has to carry the default action: a toolbar
   * with three split buttons has three arrows, and three announcements of "More options" tell a
   * screen-reader user only that there are three of something.
   */
  more: (label: string) => string
}

export const defaultSplitButtonLabels: SplitButtonLabels = {
  more: (label) => `More ${label} options`,
}

export interface SplitButtonAction {
  /** Stable key for the item. The label is used when this is absent. */
  id?: string
  /** The item's text, and its accessible name. */
  label: string
  /** Run when the item is chosen. Not called for a disabled item. */
  onSelect: () => void
  /**
   * Unavailable, but still shown and still reachable with the keyboard — see
   * {@link SplitButtonProps.actions} for why this is `aria-disabled` rather than `disabled`.
   */
  disabled?: boolean
  /** Decorative icon before the label. Hidden from screen readers by this component. */
  icon?: React.ReactNode
}

export type SplitButtonVariant = "primary" | "outline" | "destructive"

/**
 * The classes shared by both halves, per variant.
 *
 * The seam is the part worth reading. Official shadcn/ui ships `button-group`, and it is the piece
 * of this problem that already exists: `[&>*:not(:first-child)]:rounded-l-none`,
 * `[&>*:not(:first-child)]:border-l-0`, `[&>*:not(:last-child)]:rounded-r-none` and
 * `[&>*]:focus-visible:relative [&>*]:focus-visible:z-10` between them collapse the doubled corner
 * radius and the doubled border, and lift whichever child has focus so its ring is not painted
 * over by the sibling that comes after it in the DOM.
 *
 * That last one is worth measuring rather than believing, because the lift looks like a stacking
 * nicety and is actually the difference between a ring and three quarters of one. Measured in
 * Chrome on two adjacent buttons with a 2px ring drawn as a box-shadow spread on the first:
 *
 * | the focused half          | ring drawn on        |
 * | ------------------------- | -------------------- |
 * | as it is                  | three sides          |
 * | `relative` + `z-10`       | four sides           |
 *
 * The ring extends 2px past the first button's border box, the sibling's border box begins at
 * exactly that edge, and `document.elementFromPoint` at that pixel answers with the sibling — so
 * the sibling's background, painted later in DOM order, covers the segment. Nothing is clipped and
 * nothing errors; the ring simply stops where the other half starts, on the one side that says
 * which of the two buttons focus is on.
 *
 * Two things are left over, and both are why the divider below is written out per variant instead
 * of inherited. The first is that the `border-l-0` rule has nothing to remove on a filled button:
 * of official's own `button` variants only `outline` carries a border, so `default`, `destructive`
 * and `secondary` enter a button group with no border at all and the rule removes nothing. Two
 * filled halves then butt together as one unbroken block of colour — rendered side by side in a
 * browser they read as one wide button with a chevron floating in it — and the place to press for
 * the default action and the place to press for the menu are not distinguishable — the single most
 * visible way a hand-built split button comes out wrong, and it comes out wrong *because* the group
 * did its job. So a filled split button needs a divider drawn in the foreground colour at low
 * alpha, which is what `seam` carries here; an outlined one needs the opposite, a single shared
 * border rather than two.
 *
 * The second is that `inline-flex` plus logical radius utilities (`rounded-e-none` on the default
 * action, `rounded-s-none` on the arrow) mirror themselves on an RTL page, where the physical
 * `rounded-l-none`/`rounded-r-none` pair does not. A flex row already follows `dir`, so the arrow
 * moves to the left on an Arabic or Hebrew page on its own; without logical radii the flat corners
 * stay on the sides they had in English and the unit comes apart.
 */
const VARIANT: Record<SplitButtonVariant, { base: string; seam: string }> = {
  primary: {
    base: "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring",
    seam: "border-s border-s-primary-foreground/25",
  },
  outline: {
    base: "border border-input bg-background hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring",
    // The arrow keeps its own inline-start border and the default action drops its inline-end one,
    // so the line between them is one pixel rather than two.
    seam: "border-s",
  },
  destructive: {
    base: "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive",
    seam: "border-s border-s-destructive-foreground/25",
  },
}

const HALF_BASE =
  "inline-flex h-9 items-center justify-center gap-2 text-sm font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:relative focus-visible:z-10 " +
  "disabled:pointer-events-none disabled:opacity-50"

export interface SplitButtonProps
  extends Omit<
    React.ComponentPropsWithoutRef<"button">,
    "children" | "disabled" | "aria-haspopup" | "aria-expanded"
  > {
  /**
   * What the default action is called, in words.
   *
   * Required, and it is the prop that decides whether the arrow is usable by anyone not looking at
   * the screen. The arrow has no text of its own — it is a chevron — so left to itself it announces
   * the word "button", one position away from another button that also announces "button", and
   * nothing says which one saves. From this it becomes "More Save options". It is also the default
   * action's own visible text unless `children` says otherwise, so the usual call site passes it
   * once and gets both.
   */
  label: string
  /** The default action's content, when it needs more than `label` — an icon, a count, a badge. */
  children?: React.ReactNode
  /**
   * The variants behind the arrow. An empty list renders no arrow at all: a split button whose menu
   * has nothing in it is a button, and an arrow that opens an empty panel is a dead end.
   *
   * An item's `disabled` becomes `aria-disabled` and not the `disabled` attribute, deliberately. A
   * `disabled` button is removed from the focus order, so arrowing down a menu of four items where
   * the third is unavailable would walk 1, 2, 4 — and the one thing the person learns from that is
   * nothing: the item they were looking for appears not to exist, rather than to exist and be
   * unavailable right now. Keeping it focusable is what the ARIA practices ask for, and it is the
   * difference between "Squash and merge, dimmed" and silence.
   */
  actions: readonly SplitButtonAction[]
  variant?: SplitButtonVariant
  /** Which edge of the unit the menu lines up with. Mirrors itself on an RTL page. */
  align?: "start" | "end"
  /**
   * `type` for the default action only.
   *
   * The arrow is always `type="button"` and this cannot change it. A split button lives in a form
   * more often than not — Save / Save and close is the canonical one — and a `<button>` inside a
   * form defaults to `type="submit"`, so an arrow that inherited the default would post the form
   * the moment somebody went looking for the second option. The default action is the half that may
   * legitimately want to submit, so `type` reaches it and stops there.
   */
  type?: "button" | "submit" | "reset"
  /** Both halves unavailable. */
  disabled?: boolean
  /**
   * The default action alone unavailable, with the menu still open for business.
   *
   * This is the combination the pattern exists for: a form that cannot be saved yet but can be
   * saved as a draft, a pull request that cannot be merged but can still be closed, an export whose
   * default format is unavailable for this account. `disabled` would take the variants down with
   * it.
   */
  actionDisabled?: boolean
  /** The arrow alone unavailable, with the default action still pressable. */
  menuDisabled?: boolean
  /** Told when the menu opens and closes, for a caller that needs to know. */
  onOpenChange?: (open: boolean) => void
  labels?: Partial<SplitButtonLabels>
  /** On the wrapper. The halves take `buttonClassName` / `triggerClassName`; other props reach the default action. */
  className?: string
  buttonClassName?: string
  triggerClassName?: string
  menuClassName?: string
  itemClassName?: string
}

/**
 * One default action with its variants folded under the arrow beside it.
 *
 * For every place a screen has an obvious thing to do and two or three near-relatives of it: Save
 * and Save as draft, Merge and Squash and merge and Rebase and merge, Deploy and Deploy to staging
 * and Roll back, Export CSV and Export XLSX, Send and Schedule send, Invite and Copy invite link,
 * Publish and Publish privately, Download and Download as PDF, Reply and Reply all, Run and Run
 * with options, Approve and Approve with comment.
 *
 * **It is one thing to look at and two things to press.** That sentence is the whole component, and
 * every part of it below is a consequence:
 *
 *   - Two buttons means focus stops twice, so the arrow needs a name of its own that says what it
 *     belongs to (see {@link SplitButtonProps.label}).
 *   - The arrow is the half that owns the menu, so `aria-haspopup="menu"`, `aria-expanded` and
 *     `aria-controls` go on it and not on the wrapper or the default action.
 *   - Down and Up on the *default action* open the menu too, and land inside it. Opening while
 *     leaving focus on the default action is the version that looks right and is useless: the keys
 *     that drive a menu are handled inside the menu, so the next Down does nothing. Handing focus
 *     to the arrow first is the other near-miss — the menu is already open at that point, so the
 *     person's next Down walks from the arrow into the menu and the first item is skipped.
 *   - Escape, choosing an item, and Tab all put focus back on the half that opened the menu, which
 *     is not always the arrow. A menu that unmounts while it still holds focus drops focus to
 *     `<body>`, and from there the next Tab starts at the top of the page.
 *   - An outside press is the exception: the person has already said where they want to be, and
 *     pulling focus back to the arrow would take it away from whatever they just pressed.
 *
 * The visual half of the problem is official shadcn/ui's `button-group`, and this does not depend on
 * it: see {@link VARIANT} for what that component already solves, the two things it leaves, and why
 * the seam here is drawn per variant.
 *
 * Nothing is portalled and nothing measures the viewport. The menu is absolutely positioned inside
 * the wrapper, which is what a two-to-five item menu under a button needs; a menu that has to flip
 * above the trigger near the bottom of a scroll container, or escape an `overflow: hidden`
 * ancestor, wants a positioning library and that is a different component.
 */
export function SplitButton({
  label,
  children,
  actions,
  variant = "primary",
  align = "end",
  type = "button",
  disabled,
  actionDisabled,
  menuDisabled,
  onOpenChange,
  labels: labelOverrides,
  className,
  buttonClassName,
  triggerClassName,
  menuClassName,
  itemClassName,
  ...props
}: SplitButtonProps) {
  const labels = React.useMemo(
    () => ({ ...defaultSplitButtonLabels, ...labelOverrides }),
    [labelOverrides]
  )
  const generatedId = React.useId()
  const menuId = `${generatedId}-menu`
  const triggerId = `${generatedId}-trigger`

  const [open, setOpen] = React.useState(false)
  // Which item has focus, as a position rather than an id: the menu is given as an array and a
  // position is what an arrow key moves. -1 is "the menu is closed".
  const [active, setActive] = React.useState(-1)

  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const actionRef = React.useRef<HTMLButtonElement | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  // Which half to give focus back to. Set when the menu opens, read when it closes.
  const openerRef = React.useRef<"action" | "trigger">("trigger")

  /**
   * One ref object per position, created lazily.
   *
   * Object refs rather than `ref={(node) => …}` for a reason that is half about the browser and
   * half about this repository's tests: a callback ref fires on every commit with a new function
   * identity, so React detaches and reattaches it, and the test harness here only fills ref objects
   * — a menu wired with callback refs has focus behaviour that cannot be asserted at all, which is
   * how `date-range-preset` ended up with an untested roving tabindex.
   */
  const itemRefs = React.useRef<Array<React.RefObject<HTMLButtonElement | null>>>([])
  const itemRef = (index: number) => {
    while (itemRefs.current.length <= index) {
      itemRefs.current.push(React.createRef<HTMLButtonElement>())
    }
    return itemRefs.current[index]
  }

  const count = actions.length
  const hasMenu = count > 0
  const menuOpen = open && hasMenu

  // Reported from an effect rather than from the setter. A state updater has to be pure — React
  // calls it twice in development's strict mode on purpose — so a caller's `onOpenChange` placed
  // inside one is told twice for every open. Here the previous value is kept in a ref and the
  // report happens after the commit that actually changed it.
  const notifiedOpen = React.useRef(false)
  React.useEffect(() => {
    if (notifiedOpen.current === open) return
    notifiedOpen.current = open
    onOpenChange?.(open)
  }, [open, onOpenChange])

  const openMenu = (from: "action" | "trigger", at: number) => {
    if (disabled || menuDisabled || !hasMenu) return
    openerRef.current = from
    setActive(at)
    setOpen(true)
  }

  /**
   * Closes the menu, and says whether focus comes back.
   *
   * `restoreFocus` is the whole reason this takes an argument. Escape, Tab and choosing an item are
   * all the person still working inside the control, and the element they are standing on is about
   * to be removed from the document — a browser does not move focus when that happens, it drops to
   * `<body>`, which for a keyboard user means the next Tab starts again from the top of the page
   * and for a screen-reader user means nothing says where they are. A press outside is the opposite
   * situation: they have already chosen where to be, and taking focus back to the arrow would undo
   * their click.
   */
  const closeMenu = React.useCallback((restoreFocus: boolean) => {
    setActive(-1)
    setOpen(false)
    if (!restoreFocus) return
    const opener = openerRef.current === "action" ? actionRef : triggerRef
    opener.current?.focus()
  }, [])

  /**
   * Moves real focus onto the active item, rather than pointing at it with `aria-activedescendant`.
   *
   * The two are not interchangeable here. A listbox may keep focus on the input and name the active
   * row — that is what `country-select` does, and it has to, because the person is still typing into
   * the filter box. A menu has no input: the items *are* the interface, each one is a `<button>`, and
   * the ARIA practices for a menu describe moving focus. It also decides what Enter and Space mean
   * without this component arranging anything, because the focused element is the real button.
   *
   * Keyed on `active` as well as `open` so one effect covers both opening (which lands on the first
   * or last item) and every arrow key after it.
   */
  React.useEffect(() => {
    // Bounded by the live count, not just by `active >= 0`. `actions` is a prop and can shrink under
    // an open menu, and this effect is declared before the one that clamps `active`, so without the
    // bound the commit in which the list shrank asks a ref that is no longer attached to anything —
    // a focus call into a detached node, followed by the right one a render later.
    if (!menuOpen || active < 0 || active >= count) return
    itemRef(active).current?.focus()
    // itemRef mutates a ref and is stable; listing it would mean memoising a function whose whole
    // job is to be called during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen, active, count])

  // Close on an outside pointer press, in the capture phase so it beats a focus move.
  React.useEffect(() => {
    if (!menuOpen) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [menuOpen, closeMenu])

  // A menu that is open while its own arrow becomes unavailable has no way to be closed by the
  // person looking at it: the arrow no longer answers a press, and the items it was opened for may
  // be unavailable too.
  React.useEffect(() => {
    if (menuOpen && (disabled || menuDisabled)) closeMenu(false)
  }, [menuOpen, disabled, menuDisabled, closeMenu])

  // The menu is given as a prop, so it can shrink underneath an open menu — a filter, a permission
  // check, a refetch. Without this the active position points past the end and the focus effect
  // asks a ref that holds nothing.
  React.useEffect(() => {
    if (!menuOpen) return
    setActive((current) => (current >= count ? count - 1 : current))
  }, [menuOpen, count])

  function choose(index: number) {
    const action = actions[index]
    if (!action || action.disabled) return
    // Closed first, so the focus restore below is not fighting whatever the handler does — a
    // handler that opens a dialog would otherwise have focus pulled out from under it.
    closeMenu(true)
    action.onSelect()
  }

  function handleActionKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    props.onKeyDown?.(event)
    if (event.defaultPrevented || !hasMenu || disabled || menuDisabled) return
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    // Without this the page scrolls as well as the menu opening.
    event.preventDefault()
    openMenu("action", nextMenuIndex(count, -1, event.key === "ArrowDown" ? 1 : -1))
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault()
        openMenu("trigger", nextMenuIndex(count, -1, event.key === "ArrowDown" ? 1 : -1))
        break
      case "Escape":
        if (menuOpen) {
          event.preventDefault()
          closeMenu(true)
        }
        break
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        setActive((current) => nextMenuIndex(count, current, 1))
        break
      case "ArrowUp":
        event.preventDefault()
        setActive((current) => nextMenuIndex(count, current, -1))
        break
      case "Home":
        event.preventDefault()
        setActive(0)
        break
      case "End":
        event.preventDefault()
        setActive(count - 1)
        break
      case "Escape":
        event.preventDefault()
        closeMenu(true)
        break
      case "Tab":
        // Not prevented: Tab means leave, and the browser's own answer for where to go next is the
        // right one. Focus is moved back onto the opener first so that answer is computed from an
        // element that is still in the document — the menu is about to be removed, and a Tab from a
        // detached element starts over at the top of the page.
        closeMenu(true)
        break
    }
  }

  const half = VARIANT[variant]
  const actionOff = Boolean(disabled || actionDisabled)
  const menuOff = Boolean(disabled || menuDisabled)

  return (
    <div ref={rootRef} className={cn("relative inline-flex w-fit", className)}>
      <button
        {...props}
        ref={actionRef}
        type={type}
        disabled={actionOff}
        onKeyDown={handleActionKeyDown}
        className={cn(
          HALF_BASE,
          half.base,
          "rounded-md px-4",
          // Flat only on the side the arrow is on, and only when there is an arrow.
          hasMenu && "rounded-e-none",
          hasMenu && variant === "outline" && "border-e-0",
          buttonClassName
        )}
      >
        {children ?? label}
      </button>

      {hasMenu ? (
        <button
          ref={triggerRef}
          id={triggerId}
          // Never "submit", whatever `type` says — see SplitButtonProps.type.
          type="button"
          disabled={menuOff}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          aria-label={labels.more(label)}
          onClick={() => (menuOpen ? closeMenu(true) : openMenu("trigger", 0))}
          onKeyDown={handleTriggerKeyDown}
          className={cn(
            HALF_BASE,
            half.base,
            half.seam,
            "rounded-md rounded-s-none px-2",
            triggerClassName
          )}
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-4 transition-transform duration-200 motion-reduce:transition-none",
              menuOpen && "rotate-180"
            )}
          />
        </button>
      ) : null}

      {menuOpen ? (
        <div
          id={menuId}
          role="menu"
          // The attribute official shadcn/ui's own collapsing components key their keyframes off, so
          // `menuClassName="data-[state=open]:animate-in"` works in a project that has installed any
          // of them.
          data-state="open"
          // Named by the arrow, so the menu is announced as the thing the arrow said it would open
          // rather than as an unnamed menu.
          aria-labelledby={triggerId}
          onKeyDown={handleMenuKeyDown}
          className={cn(
            "absolute top-full z-50 mt-1 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md",
            align === "end" ? "end-0" : "start-0",
            menuClassName
          )}
        >
          {actions.map((action, index) => (
            <button
              key={action.id ?? action.label}
              ref={itemRef(index)}
              role="menuitem"
              type="button"
              // aria-disabled rather than disabled, so the item keeps its place in the arrow walk —
              // see SplitButtonProps.actions.
              aria-disabled={action.disabled || undefined}
              // Roving: one tab stop for the whole menu, on the item that has focus.
              tabIndex={index === active ? 0 : -1}
              onClick={() => choose(index)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none transition-colors",
                "focus:bg-accent focus:text-accent-foreground",
                action.disabled
                  ? "pointer-events-none opacity-50"
                  : "hover:bg-accent hover:text-accent-foreground",
                itemClassName
              )}
            >
              {action.icon ? (
                <span aria-hidden="true" className="flex size-4 items-center justify-center">
                  {action.icon}
                </span>
              ) : null}
              <span className="truncate">{action.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
