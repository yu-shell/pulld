// The breadcrumb everybody writes first either wraps onto a second line — which is what official
// shadcn/ui's `flex flex-wrap` list does, measured at 45.2px tall in a 320px header and 70.8px in a
// 240px one — or folds the wrong end. The cases below are written to fail against that version and
// against the near-misses around it:
//
//   - a prefix strategy borrowed from `toolbar-overflow`, which keeps the start and folds the tail,
//     so the trail reads "Home / Workspaces / Acme Corp / …" and the page you are on is gone,
//   - one gap counted per join instead of two, which under-reads a five-crumb trail by 24px and
//     keeps a level that does not fit (between two crumbs sits a separator, and the gap applies on
//     both sides of it),
//   - an ellipsis charged for even when the whole trail fits, so a trail that fits exactly loses a
//     level to a control that was never needed, and the opposite: a control added after the decision,
//   - a fold that keeps `total - 1` trailing crumbs, where the ellipsis hides nothing at all and
//     charges the row for itself anyway,
//   - the row's index taken from the row rather than from the trail, which takes `aria-current` off
//     the current page on exactly the trails that are wide enough not to fold,
//   - a current page rendered as a link, so "you are here" is announced as somewhere to go,
//   - the folded crumb that was holding focus, which a browser does not follow: focus drops to
//     `<body>` and the next Tab starts from the top of the page,
//   - the overcorrection, focus pulled to the ellipsis because a window was resized,
//   - a probe copy that truncates like the live current page, so the arithmetic runs on the width
//     the crumb was given rather than the width it wants,
//   - `paddingLeft` read on an RTL page, which places the menu a padding's width into the wrong end,
//   - and a layout object rebuilt on every measurement, which is a new identity, which is a render,
//     which is another measurement.
//
// What the harness can see of focus is the call, not the caret: "the trail asked this node to take
// focus" is asserted here, and whether the browser honoured it belongs to a browser. It has no
// layout either, so the measurement is supplied — `applyLayout` is the only place widths come from,
// and the arithmetic that consumes them is asserted directly as a function.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icon = (name) =>
  function Icon(props) {
    return { type: "svg", props: { "data-icon": name, ...props } }
  }

// The real split-button, loaded rather than stubbed. The menu's wrap rule is imported from it, and a
// stub would turn the one assertion that the composition works into an assertion about the copy —
// the registryDependencies entry would then be decoration.
const splitButton = loadComponent(join(ROOT, "registry", "ui", "split-button.tsx"), {
  stubs: { "lucide-react": { ChevronDown: icon("chevron") } },
})

const {
  fitBreadcrumbs,
  breadcrumbMenuOffset,
  isCrumbFolded,
  defaultBreadcrumbOverflowLabels,
  BreadcrumbOverflow,
} = loadComponent(join(ROOT, "registry", "ui", "breadcrumb-overflow.tsx"), {
  stubs: {
    "lucide-react": { ChevronRight: icon("chevron-right"), MoreHorizontal: icon("more") },
    "@/registry/ui/split-button": splitButton,
  },
})

// The pointerdown registration is the only handle on "closes on an outside press, and does not take
// focus back when it does", so it is captured rather than swallowed.
const pointerListeners = []
globalThis.document = {
  activeElement: null,
  addEventListener: (type, handler, capture) => {
    if (type === "pointerdown") pointerListeners.push({ handler, capture })
  },
  // Matched on the capture flag as well as the handler, the way the DOM does: a listener added in
  // the capture phase and removed without the flag is never removed at all, and a stub that ignored
  // the flag would report that leak as clean.
  removeEventListener: (type, handler, capture) => {
    if (type !== "pointerdown") return
    const at = pointerListeners.findIndex(
      (entry) => entry.handler === handler && Boolean(entry.capture) === Boolean(capture)
    )
    if (at >= 0) pointerListeners.splice(at, 1)
  },
}
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}

const box = (width) => ({ getBoundingClientRect: () => ({ width }) })

// The trail the component cases use: five levels, the last one the page you are on.
const ITEMS = [
  { label: "Home", href: "/" },
  { label: "Workspaces", href: "/w" },
  { label: "Acme Corp", href: "/w/acme" },
  { label: "Billing", href: "/w/acme/billing" },
  { label: "Invoice #10418", href: "/w/acme/billing/10418" },
]

// The widths those five crumbs actually measure in Chrome at 14px, with the 14px chevron and the
// 24px ellipsis — so the numbers in these cases are the ones a real header produces.
const REAL_WIDTHS = [38.25, 79.06, 71.94, 38.86, 99.27]
const REAL_SEP = 14
const REAL_TRIGGER = 24

function ui(props = {}, options = {}) {
  pointerListeners.length = 0
  const instance = render(BreadcrumbOverflow, { items: ITEMS, ...props }, options)
  const nodes = () => walk(instance.tree)
  const api = {
    instance,
    get tree() {
      return instance.tree
    },
    /** The landmark — what the menu hangs off, and what never clips. */
    nav: () => instance.tree,
    navNode: () => instance.tree.props.ref.current,
    /** The trail itself: the element that clips, measures and carries the gap. */
    listEl: () => byTag(nodes(), "ol")[0],
    listNode: () => api.listEl()?.props?.ref?.current,
    probe: () => nodes().find((n) => n.props?.style?.position === "absolute"),
    probeNode: () => api.probe()?.props?.ref?.current,
    /** Every crumb the person can see, in row order: links and the current page alike. */
    rowCrumbs: () =>
      nodes().filter(
        (n) =>
          (n.type === "a" || n.type === "span") &&
          n.props?.role !== "menuitem" &&
          n.props?.["aria-hidden"] !== "true" &&
          typeof n.props?.className === "string" &&
          n.props.className.includes("rounded-sm") &&
          !n.props.className.includes("size-4")
      ),
    rowLinks: () => byTag(nodes(), "a").filter((n) => n.props.role !== "menuitem"),
    current: () => nodes().find((n) => n.props?.["aria-current"] === "page"),
    trigger: () =>
      byTag(nodes(), "button").find(
        (b) => b.props["aria-haspopup"] === "menu" && b.props["aria-hidden"] !== "true"
      ),
    probeKids: () => {
      const probe = api.probe()
      return probe ? [].concat(probe.props.children).flat(Infinity).filter(Boolean) : []
    },
    separators: () => nodes().filter((n) => n.props?.role === "presentation"),
    /**
     * The row as somebody reads it: the list's own children in order, naming each one, with the
     * probe left out. The separators are `aria-hidden`, so a filter over every walked node cannot
     * tell them from the probe's copies — this reads the structure instead.
     */
    spine: () =>
      []
        .concat(api.listEl().props.children)
        .flat(Infinity)
        .filter(Boolean)
        .filter((n) => n.props?.style?.position !== "absolute")
        .map((node) => {
          const child = [].concat(node.props?.children).flat(Infinity).filter(Boolean)[0]
          if (node.props?.role === "presentation") return "separator"
          if (child?.props?.["aria-haspopup"] === "menu") return "more"
          return textOf(child)
        }),
    menu: () => byRole(nodes(), "menu")[0],
    menuItems: () => byRole(nodes(), "menuitem"),
    focusCalls: (node) => (node?.props?.ref?.current?.calls ?? []).filter((c) => c.name === "focus"),
    pressTrigger(key) {
      let prevented = false
      api.trigger().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    pressMenu(key) {
      let prevented = false
      api.menu().props.onKeyDown({ key, preventDefault: () => (prevented = true) })
      instance.rerender()
      return prevented
    },
    openMenu() {
      api.trigger().props.onClick()
      instance.rerender()
      return api
    },
    pressOutside() {
      for (const entry of [...pointerListeners]) entry.handler({ target: {} })
      instance.rerender()
      return api
    },
  }
  return api
}

/**
 * Hands the component a layout, which the harness otherwise has none of.
 *
 * The widths go on the probe, in the order the component reads them — every crumb, then one
 * separator, then the ellipsis — and the container width on the list. `getComputedStyle` is replaced
 * rather than extended because `render` installs its own (answering `direction` alone) at the start
 * of every pass.
 */
function applyLayout(
  api,
  {
    available,
    gap = 0,
    widths = REAL_WIDTHS,
    separatorWidth = 0,
    triggerWidth = REAL_TRIGGER,
    direction = "ltr",
    paddingLeft = 0,
    paddingRight = 0,
  }
) {
  const list = api.listNode()
  const probe = api.probeNode()
  list.clientWidth = available
  probe.children = [...widths.map(box), box(separatorWidth), box(triggerWidth)]
  globalThis.getComputedStyle = () => ({
    direction,
    paddingLeft: `${paddingLeft}px`,
    paddingRight: `${paddingRight}px`,
    columnGap: `${gap}px`,
  })
  api.instance.rerender()
  return api
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === "boolean") return ""
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (typeof node === "object") return textOf(node.props?.children)
  return ""
}

// --- the arithmetic ------------------------------------------------------------------------------

test("two crumbs have no middle, so nothing folds however narrow the box is", () => {
  // Folding here could only mean hiding the root or hiding the page you are on, and this component
  // does neither. A naive loop that folds "everything that does not fit" returns 1 and renders a
  // trail of an ellipsis and a title, which says nothing about where you are.
  assert.equal(fitBreadcrumbs([40, 60], 0, 6, 14, 24), 2)
  assert.equal(fitBreadcrumbs([40], 0, 6, 14, 24), 1)
  assert.equal(fitBreadcrumbs([], 100, 6, 14, 24), 0)
})

test("a trail that fits exactly is not charged for an ellipsis that is not there", () => {
  // Three crumbs of 30 with two joins of 26 need 142. Charging for the ellipsis here folds the
  // middle to make room for a control whose only job would have been to hold it.
  assert.equal(fitBreadcrumbs([30, 30, 30], 142, 6, 14, 24), 3)
})

test("one pixel too many folds the middle, and the ellipsis is paid for from that moment", () => {
  // 141 of room for a trail that needs 142. The folded shape is root + ellipsis + current page: two
  // joins at 26, so 30 + 24 + 30 + 52 = 136, which fits.
  assert.equal(fitBreadcrumbs([30, 30, 30], 141, 6, 14, 24), 1)
})

test("a join costs a gap on each side of the separator, not one gap", () => {
  // The real five-crumb trail: 327.38 of crumbs and four joins. At 2 gaps per join that is
  // 327.38 + 104 = 431.38; counting one gap per join says 407.38, a difference of 24 — so a
  // container of 420 fits the trail only under the wrong arithmetic.
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, 431.38, 6, REAL_SEP, REAL_TRIGGER), 5, "exactly full")
  assert.equal(
    fitBreadcrumbs(REAL_WIDTHS, 420, 6, REAL_SEP, REAL_TRIGGER),
    3,
    "24px short under the correct arithmetic, and the one-gap version would keep all five"
  )
})

test("the tail is kept from the end, so what survives is nearest the page you are on", () => {
  // Room for root + ellipsis + two crumbs. The two have to be Billing and the invoice — the levels
  // just above where you are — and not Workspaces and Acme Corp, which is what a prefix strategy
  // keeps.
  const widths = [38.25, 79.06, 71.94, 38.86, 99.27]
  const kept = fitBreadcrumbs(widths, 38.25 + 24 + 38.86 + 99.27 + 3 * 26, 6, REAL_SEP, REAL_TRIGGER)
  assert.equal(kept, 2)
})

test("the fold never keeps every crumb behind an ellipsis that hides nothing", () => {
  // One crumb short of fitting: the answer must drop to 3 kept (one level folded) rather than 4,
  // which would be the whole trail plus a control hiding none of it — and the row would be wider
  // than the trail it was trying to shrink, by the ellipsis and one more join.
  const needed = REAL_WIDTHS.reduce((a, b) => a + b, 0) + 4 * 26
  const kept = fitBreadcrumbs(REAL_WIDTHS, needed - 1, 6, REAL_SEP, REAL_TRIGGER)
  assert.equal(kept, 3)
  assert.ok(kept <= REAL_WIDTHS.length - 2, "never total - 1")
})

test("the page you are on is kept even when it alone does not fit", () => {
  // 10px of room for a 99px title. The row degrades by shortening that crumb's text — CSS does that
  // part — rather than by hiding the one crumb that says where you are.
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, 10, 6, REAL_SEP, REAL_TRIGGER), 1)
})

test("a container that measures nothing, or nonsense, folds to the floor rather than crashing", () => {
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, 0, 6, REAL_SEP, REAL_TRIGGER), 1)
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, Number.NaN, 6, REAL_SEP, REAL_TRIGGER), 1)
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, -200, 6, REAL_SEP, REAL_TRIGGER), 1)
})

test("a width that cannot be measured counts as zero rather than poisoning the sum", () => {
  // `getBoundingClientRect` on a detached node answers 0, and a NaN anywhere in the arithmetic makes
  // every comparison false — which reads as "it all fits" and folds nothing, forever.
  assert.equal(fitBreadcrumbs([30, Number.NaN, 30], 142, 6, 14, 24), 3)
  assert.equal(fitBreadcrumbs([30, -400, 30], 142, 6, 14, 24), 3, "and so does a negative one")
  // With no gap a join is the separator alone: 90 of crumbs and 2 joins of 14 is 118, and that is
  // what a list with no gap utility actually renders.
  assert.equal(fitBreadcrumbs([30, 30, 30], 118, Number.NaN, 14, 24), 3, "a `normal` gap is no gap")
  assert.equal(fitBreadcrumbs([30, 30, 30], 117, Number.NaN, 14, 24), 1, "and it is still arithmetic")
})

test("half a pixel of overflow is not a reason to fold a level", () => {
  const needed = REAL_WIDTHS.reduce((a, b) => a + b, 0) + 4 * 26
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, needed - 0.4, 6, REAL_SEP, REAL_TRIGGER), 5)
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, needed - 0.6, 6, REAL_SEP, REAL_TRIGGER), 3)
})

// --- where the menu goes -------------------------------------------------------------------------

test("the menu's offset is the root plus one join, which is what the browser measured", () => {
  // The numbers from Chrome: 4px of padding, a 38.25px root, a 6px gap and a 14px chevron put the
  // live control at 68.25px from the list's inline start, and this returns 68.25.
  assert.equal(breadcrumbMenuOffset(38.25, 6, 14, 4), 68.25)
})

test("the offset survives a gap that parsed to NaN", () => {
  // `columnGap` is the string `normal` on a list with no gap utility. Letting that through produces
  // `insetInlineStart: NaNpx`, which the browser drops — and the menu then sits at the far start,
  // under the root rather than under the control.
  assert.equal(breadcrumbMenuOffset(38.25, Number.NaN, 14, 4), 56.25)
  assert.ok(Number.isFinite(breadcrumbMenuOffset(Number.NaN, Number.NaN, Number.NaN, Number.NaN)))
})

test("the root and the page you are on are never folded, whatever the count", () => {
  assert.equal(isCrumbFolded(0, 1, 5), false, "the root")
  assert.equal(isCrumbFolded(4, 1, 5), false, "the current page")
  assert.equal(isCrumbFolded(1, 1, 5), true)
  assert.equal(isCrumbFolded(3, 1, 5), true)
  assert.equal(isCrumbFolded(3, 2, 5), false, "kept by the tail")
  assert.equal(isCrumbFolded(2, 5, 5), false, "nothing folded at all")
})

// --- the row ------------------------------------------------------------------------------------

test("an empty trail renders nothing", () => {
  const api = ui({ items: [] })
  assert.equal(api.tree, null)
})

test("the server renders the whole trail, because the server cannot measure", () => {
  // The first client render has to match it, so "not measured yet" shows everything and the layout
  // effect folds it before paint. A component that starts at "nothing fits" flashes a lone ellipsis
  // into every SSR'd page.
  const api = ui()
  assert.equal(api.trigger(), undefined, "no control")
  assert.equal(api.menu(), undefined, "no menu")
  assert.equal(api.rowCrumbs().length, 5)
  assert.equal(api.separators().filter((s) => s !== undefined).length, 5, "four in the row, one in the probe")
})

test("a narrow header folds the middle and leaves both ends in place", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const labels = api.rowCrumbs().map((n) => textOf(n))
  assert.deepEqual(labels, ["Home", "Invoice #10418"])
  assert.ok(api.trigger(), "and an ellipsis between them")
  // Row order is what somebody reads, and it is read off the list's own children: root, separator,
  // ellipsis, separator, current page. A fold that put the control at the end would pass every other
  // assertion in this file and still say the wrong thing about where the missing levels went.
  assert.deepEqual(api.spine(), ["Home", "separator", "more", "separator", "Invoice #10418"])
})

test("the folded levels are in the menu, in trail order", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.deepEqual(api.menuItems().map(textOf), ["Workspaces", "Acme Corp", "Billing"])
})

test("the current page carries aria-current whether or not the trail folded", () => {
  // The regression that started this file: the row's own index is not the trail's index, and
  // deriving one from the other is right for the folded shape and off by one for the whole trail —
  // so the attribute the pattern exists to carry goes missing on the wide headers, where nothing
  // looks wrong.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.rowCrumbs().length, 5, "nothing folded")
  assert.equal(textOf(api.current()), "Invoice #10418")
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(textOf(api.current()), "Invoice #10418", "and the same after the fold")
})

test("the page you are on is not a link, even when it was given an href", () => {
  // `aria-current="page"` is the convention for "you are here"; rendering it as a link offers
  // somewhere to go and puts a tab stop on it. Official's own page element goes further and adds
  // `role="link"` with `aria-disabled`, which announces a dimmed link for something that is not one.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  const current = api.current()
  assert.equal(current.type, "span")
  assert.equal(current.props.href, undefined)
  assert.equal(current.props.role, undefined)
  assert.deepEqual(
    api.rowLinks().map(textOf),
    ["Home", "Workspaces", "Acme Corp", "Billing"],
    "every other crumb is a link"
  )
})

test("a crumb with no page of its own is text in the row and still a rung in the menu", () => {
  const items = [
    { label: "Home", href: "/" },
    { label: "Archive" },
    { label: "2026", href: "/a/2026" },
    { label: "Invoice", href: "/a/2026/1" },
  ]
  const api = ui({ items })
  applyLayout(api, { available: 160, gap: 6, separatorWidth: REAL_SEP, widths: [38, 60, 40, 60] })
  api.openMenu()
  const archive = api.menuItems().find((n) => textOf(n) === "Archive")
  assert.ok(archive, "it is in the menu")
  assert.equal(archive.type, "span", "but not a link")
  assert.equal(archive.props.tabIndex, 0, "and still takes focus, so the list is not shorter than it looks")
})

// --- the probe ----------------------------------------------------------------------------------

test("the probe carries every crumb, one separator and the ellipsis, in that order", () => {
  // `measure` reads them positionally. A probe that renders the separators between its copies puts
  // a 14px chevron where the component expects a crumb, and every width after it is wrong.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const kids = api.probeKids()
  assert.equal(kids.length, 7, "five crumbs, a separator, a control")
  assert.equal(textOf(kids[0]), "Home")
  assert.equal(textOf(kids[4]), "Invoice #10418")
  assert.equal(kids[5].props.role, "presentation")
  assert.equal(kids[6].props["aria-haspopup"], undefined, "the copy is not a menu button")
})

test("the probe is hidden from assistive technology and holds nothing focusable", () => {
  // An `aria-hidden` element that can still be focused is the one combination assistive technology
  // cannot explain, so the copies are given no href at all rather than tabIndex -1.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.probe().props["aria-hidden"], "true")
  for (const kid of api.probeKids()) {
    assert.equal(kid.props.href, undefined)
    assert.notEqual(kid.type, "a")
  }
})

test("the probe's copy of the current page does not truncate", () => {
  // The live one does — that is how a trail with no room left shortens its title instead of being
  // cut off. A copy that truncates reports the width it was given rather than the width it wants,
  // and the arithmetic then folds against a number that folding itself produced.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const copy = api.probeKids()[4]
  assert.ok(copy.props.className.includes("whitespace-nowrap"))
  assert.ok(!copy.props.className.includes("truncate"))
  assert.ok(api.current().props.className.includes("truncate"), "and the live one does")
})

test("a probe mid-commit is not measured", () => {
  // The children arrive a commit after a crumb is added. Reading them anyway measures five crumbs'
  // worth of room against four crumbs' widths, and the extra level folds for one frame.
  const api = ui()
  const list = api.listNode()
  list.clientWidth = 200
  api.probeNode().children = [box(30), box(30)]
  globalThis.getComputedStyle = () => ({ direction: "ltr", paddingLeft: "0px", paddingRight: "0px", columnGap: "6px" })
  api.instance.rerender()
  assert.equal(api.trigger(), undefined, "nothing was folded on a partial measurement")
})

// --- the measurement ----------------------------------------------------------------------------

test("a trail inside a closed tab keeps the answer it already had", () => {
  // Everything measures zero in a `display: none` subtree, which is not "nothing fits". Acting on it
  // folds the trail to a lone ellipsis while nobody is looking, and it stays that way once shown.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.rowCrumbs().length, 5)
  applyLayout(api, { available: 0, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.rowCrumbs().length, 5, "unchanged")
})

test("the list's padding is taken out of the room the crumbs have", () => {
  // clientWidth is content plus padding, so a caller's `px-6` would otherwise be measured as room
  // the crumbs can use, and the last level before the fold would be cut off by exactly the padding.
  const needed = REAL_WIDTHS.reduce((a, b) => a + b, 0) + 4 * 26
  const api = ui()
  applyLayout(api, { available: needed, gap: 6, separatorWidth: REAL_SEP, paddingLeft: 0, paddingRight: 0 })
  assert.equal(api.rowCrumbs().length, 5, "exactly full with no padding")
  applyLayout(api, { available: needed, gap: 6, separatorWidth: REAL_SEP, paddingLeft: 12, paddingRight: 12 })
  assert.ok(api.rowCrumbs().length < 5, "and over-full once there is padding")
})

test("on an RTL page the menu is offset from the right-hand padding", () => {
  // The inline start is the right edge there. Reading `paddingLeft` puts the menu a padding's width
  // into the wrong end of the trail — the mirror of the `scrollLeft` sign problem `scroll-shadow`
  // has to handle, and it shows up only on the pages that asked for the other direction.
  const api = ui()
  applyLayout(api, {
    available: 200,
    gap: 6,
    separatorWidth: REAL_SEP,
    direction: "rtl",
    paddingLeft: 40,
    paddingRight: 4,
  })
  api.openMenu()
  assert.equal(api.menu().props.style.insetInlineStart, "68.25px")
})

test("equal measurements do not keep the component re-rendering", () => {
  // The answer is an object here, so React's bail-out on an equal value has to be kept by hand. A
  // fresh object every measurement is a new identity, which is a render, which is another
  // measurement — the loop this component exists to remove, reintroduced one line from the end.
  const api = ui()
  const seen = []
  const api2 = ui({ onFoldChange: (n) => seen.push(n) })
  applyLayout(api2, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  applyLayout(api2, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  applyLayout(api2, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.deepEqual(seen, [3], "told once, not once per measurement")
  assert.ok(api.tree)
})

test("the fold is reported when it changes, and 0 means the whole trail is there", () => {
  const seen = []
  const api = ui({ onFoldChange: (n) => seen.push(n) })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  applyLayout(api, { available: 420, gap: 6, separatorWidth: REAL_SEP })
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  assert.deepEqual(seen, [3, 1, 0])
})

// --- focus --------------------------------------------------------------------------------------

test("a crumb folded while it holds focus moves focus to the ellipsis", () => {
  // A browser does not move focus when the element holding it leaves the document: it drops to
  // `<body>`, so the next Tab starts again from the top of the page. The ellipsis is where that
  // crumb now is.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  api.rowLinks()[2].props.onFocus()
  api.instance.rerender()
  api.listNode().contains = () => true
  globalThis.document.activeElement = {}
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.focusCalls(api.trigger()).length, 1)
  globalThis.document.activeElement = null
})

test("a fold with nobody in the trail leaves focus where it is", () => {
  // A window being dragged narrower is not a reason to take focus from whatever somebody is doing
  // elsewhere on the page.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  api.rowLinks()[2].props.onFocus()
  api.instance.rerender()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.focusCalls(api.trigger()).length, 0)
})

test("a crumb that kept its place is not rescued", () => {
  // Only the folded ones are in the menu. Pulling focus to the ellipsis from a crumb still on screen
  // moves somebody away from the link they were about to follow.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  api.rowLinks()[0].props.onFocus()
  api.instance.rerender()
  api.listNode().contains = () => true
  globalThis.document.activeElement = {}
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.focusCalls(api.trigger()).length, 0)
  globalThis.document.activeElement = null
})

test("focus leaving a crumb is forgotten, so a later fold does not rescue a stale position", () => {
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  const link = api.rowLinks()[2]
  link.props.onFocus()
  api.instance.rerender()
  link.props.onBlur()
  api.listNode().contains = () => true
  globalThis.document.activeElement = {}
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.focusCalls(api.trigger()).length, 0)
  globalThis.document.activeElement = null
})

// --- the menu -----------------------------------------------------------------------------------

test("Down opens the menu on its first level and Up on its last", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.pressTrigger("ArrowDown"), true, "and the page does not scroll as well")
  assert.equal(api.menuItems()[0].props.tabIndex, 0)
  api.pressMenu("Escape")
  api.pressTrigger("ArrowUp")
  const items = api.menuItems()
  assert.equal(items[items.length - 1].props.tabIndex, 0)
})

test("the menu wraps, using split-button's own rule", () => {
  // Imported rather than written twice, so the two menus in this registry cannot drift apart. The
  // real split-button is loaded above for this one assertion.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.equal(api.menuItems()[0].props.tabIndex, 0)
  api.pressMenu("ArrowUp")
  const items = api.menuItems()
  assert.equal(items[items.length - 1].props.tabIndex, 0, "Up from the first wraps to the last")
  assert.equal(splitButton.nextMenuIndex(3, 0, -1), 2, "which is split-button's answer")
})

test("Home and End reach the ends of the menu", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  api.pressMenu("End")
  assert.equal(api.menuItems()[2].props.tabIndex, 0)
  api.pressMenu("Home")
  assert.equal(api.menuItems()[0].props.tabIndex, 0)
})

test("a horizontal arrow inside the menu is swallowed", () => {
  // It means nothing in a vertical menu, and letting it through scrolls a horizontally scrollable
  // ancestor underneath somebody who is reading.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.equal(api.pressMenu("ArrowRight"), true)
  assert.equal(api.menuItems()[0].props.tabIndex, 0, "and nothing moved")
})

test("Escape closes the menu and gives focus back to the ellipsis", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const trigger = api.trigger()
  const before = api.focusCalls(trigger).length
  assert.equal(api.pressMenu("Escape"), true)
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
})

test("Tab closes the menu from an element still in the document", () => {
  // Not prevented: Tab means leave. But a Tab out of a node that is being removed starts over at the
  // top of the page, so focus is moved onto the control first and the browser computes its answer
  // from there.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.equal(api.pressMenu("Tab"), false)
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, 1)
})

test("an outside press closes the menu and does not take focus back", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  api.pressOutside()
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before, "the person has already said where they want to be")
})

test("the pointerdown listener is removed with the capture flag it was added with", () => {
  // A capture-phase listener removed without the flag is never removed at all, and the page then
  // carries a dead handler for the rest of its life. The stub matches on the flag the way the DOM
  // does, so a removal that forgot it leaves the listener behind and this fails. Asserted at
  // unmount because that is where this harness runs cleanups — a pass through it is the same effect
  // settling rather than a commit.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.equal(pointerListeners.length, 1)
  api.instance.unmount()
  assert.equal(pointerListeners.length, 0)
})

test("a menu whose control goes away closes itself", () => {
  // The trail widened and everything fits. A menu with no control left cannot be closed by the
  // person looking at it.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.ok(api.menu())
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.menu(), undefined)
  assert.equal(api.trigger(), undefined)
})

test("the active position cannot point past a menu that shrank underneath it", () => {
  // `items` is a prop and the trail re-measures while the menu is open, so the folded set can shrink.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  api.pressMenu("End")
  assert.equal(api.menuItems().length, 3)
  applyLayout(api, { available: 420, gap: 6, separatorWidth: REAL_SEP })
  const items = api.menuItems()
  assert.equal(items.length, 1, "three of the five crumbs fit once the container widens")
  assert.equal(items.filter((n) => n.props.tabIndex === 0).length, 1, "one tab stop, and it exists")
})

test("choosing a level closes the menu, and keeps focus only when the page is not being replaced", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  // A real navigation: the browser takes focus with it, so reaching for the control on the way out
  // would be a focus call into a document that is leaving.
  api.menuItems()[0].props.onClick({ defaultPrevented: false })
  api.instance.rerender()
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before)

  const seen = []
  const api2 = ui({
    items: ITEMS.map((item) => ({
      ...item,
      onNavigate: (event) => {
        seen.push(item.label)
        event.preventDefault()
      },
    })),
  })
  applyLayout(api2, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api2.openMenu()
  const trigger2 = api2.trigger()
  const was = api2.focusCalls(trigger2).length
  // A client router says so by preventing the default, and then nothing has moved focus.
  let prevented = false
  api2.menuItems()[0].props.onClick({
    preventDefault: () => (prevented = true),
    get defaultPrevented() {
      return prevented
    },
  })
  api2.instance.rerender()
  assert.deepEqual(seen, ["Workspaces"])
  assert.equal(api2.focusCalls(api2.trigger()).length, was + 1)
})

// --- names and markup ---------------------------------------------------------------------------

test("the control's name carries how many levels are behind it", () => {
  // Official's ellipsis carries the word "More" and no number — and carries it in an `sr-only` span
  // inside an `aria-hidden` element, so assistive technology is told nothing at all.
  assert.equal(defaultBreadcrumbOverflowLabels.more(1), "Show 1 hidden level")
  assert.equal(defaultBreadcrumbOverflowLabels.more(3), "Show 3 hidden levels")
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.trigger().props["aria-label"], "Show 3 hidden levels")
})

test("the landmark is named, and the name can be changed for a page with two trails", () => {
  const api = ui()
  assert.equal(api.nav().props["aria-label"], "Breadcrumb")
  const api2 = ui({ label: "Folder path" })
  assert.equal(api2.nav().props["aria-label"], "Folder path")
})

test("the separators are punctuation, not levels", () => {
  // A screen reader reading "greater than" between every crumb is the noise this removes.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  for (const sep of api.separators()) {
    assert.equal(sep.props["aria-hidden"], "true")
    assert.equal(sep.props.role, "presentation")
  }
})

test("a caller's separator is used in the row and in the probe alike", () => {
  // The probe measures what the row renders. A probe that keeps the default chevron measures a
  // separator the row does not have, and every join in the arithmetic is off by the difference.
  const api = ui({ separator: "/" })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const separators = api.separators()
  assert.ok(separators.length >= 2)
  for (const sep of separators) assert.equal(textOf(sep), "/")
})

test("the list clips and the landmark does not, which is what lets the menu be painted", () => {
  // Measured on this exact pair in Chrome: a panel at `top-full` inside the clipping list was hit by
  // 0 of 15 points scanned down its own rectangle, and the same panel on the landmark by 15 of 15.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.ok(api.listEl().props.className.includes("overflow-hidden"))
  assert.ok(api.nav().props.className.includes("relative"))
  assert.ok(!api.nav().props.className.includes("overflow-hidden"))
  api.openMenu()
  const menu = api.menu()
  const kids = [].concat(api.nav().props.children).flat(Infinity).filter(Boolean)
  assert.ok(kids.includes(menu), "the menu is a child of the landmark, not of the list")
})

test("the crumbs cannot shrink, so the row really does overflow and really does fold", () => {
  // Flex items shrink by default: measured, two of five crumbs were squeezed until their own text
  // wrapped (39.2px against the 19.6px line) and the row still overflowed by 26px. The current page
  // is the one exception, and it is why `min-w-0` is on it and nowhere else.
  const api = ui()
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  const crumbs = api.rowCrumbs()
  for (const crumb of crumbs.slice(0, -1)) {
    assert.ok(crumb.props.className.includes("shrink-0"), textOf(crumb))
    assert.ok(crumb.props.className.includes("whitespace-nowrap"), textOf(crumb))
  }
  assert.ok(api.current().props.className.includes("min-w-0"))
  assert.ok(!api.listEl().props.className.includes("flex-wrap "), "and the list does not wrap")
  assert.ok(api.listEl().props.className.includes("flex-nowrap"))
})

test("an icon is decorative in the row and in the menu", () => {
  const api = ui({
    items: ITEMS.map((item, i) => (i === 0 ? { ...item, icon: "H" } : item)),
  })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const hidden = walk(api.tree).filter(
    (n) => n.props?.["aria-hidden"] === "true" && textOf(n) === "H"
  )
  assert.ok(hidden.length >= 1, "the icon is hidden from screen readers, the label is not")
  assert.equal(textOf(api.rowCrumbs()[0]), "HHome")
})

// --- what the mutation run found missing --------------------------------------------------------
//
// Everything below was added because `node scripts/mutate.mjs` changed one token in the source and
// the suite above still passed. Each one names the mutant it kills: the rule is real, and nothing
// was holding it in place.

test("exactly the tolerance is not overflow, and a hair past it is", () => {
  // `<=` against `<` on the slack comparison. Half a pixel is the line itself, and a trail sitting
  // exactly on it must stay whole — the slack exists because widths are fractional, not to fold on
  // the boundary.
  const needed = REAL_WIDTHS.reduce((a, b) => a + b, 0) + 4 * 26
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, needed - 0.5, 6, REAL_SEP, REAL_TRIGGER), 5)
  assert.equal(fitBreadcrumbs(REAL_WIDTHS, needed - 0.51, 6, REAL_SEP, REAL_TRIGGER), 3)
})

test("the same tolerance applies to each level the tail tries to keep", () => {
  // `>` against `>=` inside the loop. A candidate that overflows by exactly half a pixel is kept,
  // so the rule the whole-trail comparison follows is the rule every step follows.
  const widths = [30, 30, 30, 30, 30]
  // root + control + two tail crumbs is 30 + 24 + 60 and three joins of 26 — 192 exactly.
  assert.equal(fitBreadcrumbs(widths, 192, 6, 14, 24), 2)
  assert.equal(fitBreadcrumbs(widths, 191.5, 6, 14, 24), 2, "exactly the tolerance over")
  assert.equal(fitBreadcrumbs(widths, 191.49, 6, 14, 24), 1)
})

test("the folded shape pays for both of its joins", () => {
  // `2 * join` against one. Root, control and current page is three boxes and therefore two joins;
  // charging one makes a 26px hole in the budget, which is a whole level at these widths.
  const widths = [30, 30, 30, 30, 30]
  // 30 + 24 + 30 + 2 * 26 = 136 for the floor shape; one pixel less and nothing more can be kept.
  assert.equal(fitBreadcrumbs(widths, 136, 6, 14, 24), 1)
  assert.equal(fitBreadcrumbs(widths, 161, 6, 14, 24), 1, "25 more is still short of a third join")
  assert.equal(fitBreadcrumbs(widths, 192, 6, 14, 24), 2, "and 192 pays for it")
})

test("a crumb a pixel wide is a crumb", () => {
  // `> 0` against `> 1` in the width guard. Icon-only crumbs and single-glyph labels are narrow, and
  // rounding them to nothing hands the arithmetic room that is not there.
  assert.equal(fitBreadcrumbs([1, 1, 1], 2 * 26 + 3, 0, 26, 24), 3)
  assert.equal(fitBreadcrumbs([1, 1, 1], 2 * 26 + 2, 0, 26, 24), 1)
})

test("the separator and the control are read from their own places in the probe", () => {
  // `probed[total + 1]` against `probed[total]`. The two are adjacent and both plausible, so a
  // positional read that is one off measures the separator as the control — which is only visible
  // when the two differ by enough to change the answer.
  const api = ui()
  // Keeping one crumb of the tail costs 38.25 + control + 99.27 + two joins: 213.52 with the 24px
  // control and 203.52 with the 14px separator read in its place. Keeping two costs 278.38 and
  // 268.38. So at 270 the right reading keeps one level and the one-off reading keeps two — a
  // difference nothing else in this file would notice, since both answers are plausible rows.
  applyLayout(api, {
    available: 270,
    gap: 6,
    separatorWidth: REAL_SEP,
    triggerWidth: REAL_TRIGGER,
  })
  assert.deepEqual(api.spine(), ["Home", "separator", "more", "separator", "Invoice #10418"])
})

test("a probe without its control copy yet is not measured", () => {
  // `< total + 2` against `< total + 1`. The crumbs and the separator can be attached a commit
  // before the control is, and reading past the end then measures `undefined`.
  const api = ui()
  api.listNode().clientWidth = 200
  api.probeNode().children = [...REAL_WIDTHS.map(box), box(REAL_SEP)]
  globalThis.getComputedStyle = () => ({
    direction: "ltr",
    paddingLeft: "0px",
    paddingRight: "0px",
    columnGap: "6px",
  })
  api.instance.rerender()
  assert.equal(api.trigger(), undefined)
})

test("the kept tail carries its own position in the trail, not its position in the row", () => {
  // `total - kept + offset` against `total - kept - offset`. With one crumb kept the two agree, so
  // this needs a fold that keeps more than one — and what goes wrong is `aria-current`, which ends
  // up on a crumb somewhere in the middle of the row.
  const api = ui()
  applyLayout(api, { available: 420, gap: 6, separatorWidth: REAL_SEP })
  assert.deepEqual(api.spine(), [
    "Home",
    "separator",
    "more",
    "separator",
    "Acme Corp",
    "separator",
    "Billing",
    "separator",
    "Invoice #10418",
  ])
  assert.equal(textOf(api.current()), "Invoice #10418")
})

test("the root is never rescued, because the root is never folded", () => {
  // `index: 0` against anything else for the root. A root recorded as the crumb next to it is
  // reported folded the next time the container narrows, and focus is taken off a link that is still
  // on screen.
  const api = ui()
  applyLayout(api, { available: 420, gap: 6, separatorWidth: REAL_SEP })
  api.rowLinks()[0].props.onFocus()
  api.instance.rerender()
  api.listNode().contains = () => true
  globalThis.document.activeElement = {}
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.focusCalls(api.trigger()).length, 0)
  globalThis.document.activeElement = null
})

test("a per-part class that changes a width is on the probe's copy too", () => {
  // The defect this file's mutation run actually found: the copies were given the component's own
  // classes and not the caller's, so `separatorClassName` and `triggerClassName` widened the row
  // without widening the measurement — and the arithmetic then kept a level that does not fit.
  const api = ui({
    separatorClassName: "px-2",
    triggerClassName: "size-9",
    currentClassName: "font-semibold",
  })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const kids = api.probeKids()
  assert.ok(kids[5].props.className.includes("px-2"), "the separator copy")
  assert.ok(kids[6].props.className.includes("size-9"), "the control copy")
  assert.ok(kids[4].props.className.includes("font-semibold"), "and the current page's copy")
})

test("the control says whether its menu is open and what it points at", () => {
  // The two attributes a screen reader reads off a disclosure. Renaming either leaves the component
  // looking identical on screen.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.trigger().props["aria-expanded"], false)
  assert.equal(api.trigger().props["aria-controls"], undefined)
  api.openMenu()
  assert.equal(api.trigger().props["aria-expanded"], true)
  assert.equal(api.trigger().props["aria-controls"], api.menu().props.id)
  assert.equal(api.menu().props["aria-labelledby"], api.trigger().props.id)
  assert.equal(api.menu().props["data-state"], "open", "the hook official's animations key off")
})

test("pressing the control again closes the menu and keeps focus on it", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  api.openMenu()
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
})

test("Escape works from the control as well as from inside the menu", () => {
  // Focus is on the control the whole time it is open on a pointer press, so this is the Escape that
  // most people actually press.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const before = api.focusCalls(api.trigger()).length
  assert.equal(api.pressTrigger("Escape"), true)
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(api.trigger()).length, before + 1)
})

test("Escape on a closed control is left to whatever is behind it", () => {
  // A dialog with a breadcrumb in its header: swallowing Escape here would stop the dialog closing.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.pressTrigger("Escape"), false)
})

test("Down and Up walk the menu, and a horizontal arrow on either side goes nowhere", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  api.pressMenu("ArrowDown")
  assert.equal(api.menuItems()[1].props.tabIndex, 0, "Down moved one level")
  api.pressMenu("ArrowUp")
  assert.equal(api.menuItems()[0].props.tabIndex, 0)
  assert.equal(api.pressMenu("ArrowLeft"), true)
  assert.equal(api.pressMenu("ArrowRight"), true)
  assert.equal(api.menuItems()[0].props.tabIndex, 0, "and neither of them moved anything")
})

test("the menu has exactly one tab stop, and the others are -1 rather than 0", () => {
  // A roving tabindex written with `1` instead of `-1` puts every level in the tab order, and `-0`
  // compares equal to `0` — so this asks with Object.is rather than with equality.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const stops = api.menuItems().map((n) => n.props.tabIndex)
  assert.deepEqual(stops, [0, -1, -1])
  for (const stop of stops.slice(1)) assert.ok(Object.is(stop, -1), `${stop} is not -1`)
})

test("the first level is asked to take focus when the menu opens", () => {
  // Focus follows the active position rather than `aria-activedescendant` pointing at it, so the
  // guard on that effect has to admit position 0 — which is every pointer press.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.equal(api.focusCalls(api.menuItems()[0]).length, 1)
})

test("the folded levels are links to where they go", () => {
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  assert.deepEqual(
    api.menuItems().map((n) => [String(n.type), n.props.href]),
    [
      ["a", "/w"],
      ["a", "/w/acme"],
      ["a", "/w/acme/billing"],
    ]
  )
})

test("a crumb in the row is a link when it has somewhere to go and text when it does not", () => {
  const api = ui({
    items: [{ label: "Home", href: "/" }, { label: "Archive" }, { label: "Invoice", href: "/i" }],
  })
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  const crumbs = api.rowCrumbs()
  assert.deepEqual(
    crumbs.map((n) => [String(n.type), n.props.href]),
    [
      ["a", "/"],
      ["span", undefined],
      ["span", undefined],
    ]
  )
})

test("opening and closing is reported once each", () => {
  const seen = []
  const api = ui({ onOpenChange: (open) => seen.push(open) })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.deepEqual(seen, [], "a fold is not an open")
  api.openMenu()
  api.instance.rerender()
  api.instance.rerender()
  assert.deepEqual(seen, [true], "told once, not once per render")
  api.pressMenu("Escape")
  assert.deepEqual(seen, [true, false])
})

test("the probe's control is not focusable", () => {
  // It is a `<button>` so that the width comes off the same element type as the real one, which
  // makes it focusable unless it is taken out of the tab order — and an `aria-hidden` element that
  // can be focused is the one combination assistive technology cannot explain.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const copy = api.probeKids()[6]
  assert.equal(copy.type, "button")
  assert.ok(Object.is(copy.props.tabIndex, -1))
  assert.equal(copy.props["aria-hidden"], "true")
  for (const kid of api.probeKids()) assert.equal(kid.props["aria-hidden"], "true")
})

test("a menu that loses its control closes without reaching for focus", () => {
  // The control is gone, so there is nothing to put focus on: calling for it would be a focus call
  // into a node that has left the document, and the person is still reading the page.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  api.openMenu()
  const trigger = api.trigger()
  const before = api.focusCalls(trigger).length
  applyLayout(api, { available: 2000, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.menu(), undefined)
  assert.equal(api.focusCalls(trigger).length, before)
})

test("the control cannot submit the form it is sitting in", () => {
  // A `<button>` with no `type` is a submit button. A breadcrumb in the header of a form — a wizard,
  // a filter panel, an editor — would then submit it when somebody pressed the ellipsis, and the
  // page would navigate instead of opening a menu.
  const api = ui()
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  assert.equal(api.trigger().props.type, "button")
  assert.equal(api.probeKids()[6].props.type, "button")
})

test("every icon is decoration, in the row, in the control and in the menu", () => {
  // The chevron, the three dots and a caller's own icon all say nothing a screen reader needs: the
  // labels beside them carry the meaning, and announcing the glyph as well doubles every level.
  const api = ui({ items: ITEMS.map((item, i) => (i === 1 ? { ...item, icon: "W" } : item)) })
  applyLayout(api, { available: 200, gap: 6, separatorWidth: REAL_SEP })
  const dots = [].concat(api.trigger().props.children).flat(Infinity).filter(Boolean)[0]
  assert.equal(dots.props["aria-hidden"], "true", "the three dots")
  api.openMenu()
  const wrapper = walk(api.tree).find(
    (n) => textOf(n) === "W" && n.props?.className?.includes?.("size-4")
  )
  assert.equal(wrapper.props["aria-hidden"], "true", "a caller's icon in the menu")
  assert.equal(textOf(api.menuItems()[0]), "WWorkspaces", "and its label is still read")
})
