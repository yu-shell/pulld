# Changelog

Notable changes to pulld components. Updates apply to new installs; the shadcn CLI
copies code into your project, so existing installs are never changed automatically.

## 2026-08-17

- feat(color-picker): new component. A hex/rgb/hsl text box with native hue,
  saturation and lightness sliders, optional alpha and preset swatches. HSL is the
  state of record and the hex is derived, so a colour dragged down to black still
  remembers its hue on the way back up — including under a controlled parent that
  echoes the value back. The conversion keeps full precision and rounds once, so a
  pasted hex returns byte-identical; verified over all 16,777,216 sRGB colours.
  Reads hex in all four widths, `rgb()`/`hsl()` in the comma and space-with-slashed
  -alpha forms and percentages; out-of-range channels clamp and hues wrap the way a
  browser reads them, with blur rewriting the entry so the reading is visible.
  Colour names are refused by name rather than guessed at. One file, no dependencies
  beyond React.
- docs(progress-ring): the description now states the two things that actually
  separate it from official shadcn/ui — that official has no radial progress at all
  (its `progress` is a linear bar requiring `@radix-ui/react-progress`), and that
  this one has no npm dependencies and no `"use client"`, so it renders inside a
  Server Component. Also documents that `indeterminate` drops `aria-valuenow`
  rather than reporting a number it does not have.

## 2026-08-16

- fix(sortable-list): the layout effect that puts focus back on the drag handle now
  falls back to `useEffect` on the server, the idiom five other components in the
  catalogue already use. A `"use client"` component is still server-rendered in the
  Next.js App Router, and `useLayoutEffect` running there logs "useLayoutEffect does
  nothing on the server" for every list on the page — confirmed against
  `react-dom@18.3.1`, and confirmed absent from 19.2.7, which dropped the warning. So
  this is noise React 18 installs were eating and React 19 installs were not; the
  browser behaviour is identical either way.
- fix(virtual-list): the same fix, across all four of its layout effects — the
  ResizeObserver setup, the per-render re-observe, the scroll-anchor correction and
  the `defaultScrollOffset` restore. This one was the loudest of the two, since it
  warned four times per mounted list.
- docs(infinite-scroll): the description and the component's own doc comment both
  claimed it "works the same under a `<ul>`, a table or a grid". Two of the three are
  right. It renders a `<div>`, and the HTML parser foster-parents a `<div>` written
  inside `<tbody>` out of the table entirely and inserts it *before* the table —
  verified with parse5 against the spec's parsing algorithm — so a server-rendered
  page would show the Load more footer above the table and mismatch on hydration.
  `<ul>` is unaffected: invalid per spec, but nothing gets reparented. Both texts now
  say to put it after the closing table tag, or inside a `<td colSpan>` footer row.
  No code change — the component was never the part that was wrong.
- feat(verify): `npm run verify` now flags a `.tsx` under `registry/` that no item in
  `registry.json` claims. The reverse direction — item points at a file that is not
  there — was already checked; this one was not, and nothing else in the pipeline
  looks at it, so a finished component can sit in the tree unbuilt, unserved, absent
  from the landing page and llms.txt, and uninstallable, with every check green.
  Which is exactly what was found this week: `registry/ui/color-picker.tsx`, 636
  lines, complete, unreferenced. A WARN rather than an ALERT — it is recoverable and
  must not block a deploy.

## 2026-08-15

- feat(duration-input): new. A text field that takes a length of time written the way
  people write one — `90m`, `1h30m`, `2d 4h 15m`, `1:30`, `1.5h`, `500ms`,
  `90 minutes` — reads it into milliseconds, and echoes the reading back in words
  underneath it, for timeouts, TTLs, session lifetimes, retry and polling intervals,
  SLA targets and estimates. It settles the two things hand-rolled duration parsers
  get wrong: the whole run of letters is read before any lookup, so `500ms` can never
  come out as 500 minutes; and two colon fields are read as `mm:ss` while three are
  `hh:mm:ss`, with blur rewriting the entry to its canonical short form so `1:30`
  visibly becomes `1m 30s`. Months and years are refused by name rather than given an
  invented length, which also settles the `m`/`M` question — parsing is
  case-insensitive and `M` is minutes. `minMs`/`maxMs` mark the field `aria-invalid`
  with a polite live message naming the bound in words; a value that is unusable or
  out of range is withheld from `onValueChange` and from the form, so nothing handed
  to the caller or the server needs validating twice; text that does not parse stays
  on screen instead of being deleted out from under the reader. Giving the field a
  `name` posts the milliseconds through a hidden input. `parseDuration` and
  `formatDuration` are exported for the rest of the app to share. No dependencies
  beyond React.
- docs(segmented-control): description rewritten against the AEO rubric. The old text
  compared the component only to Tabs and Switch, which left out the two neighbours
  official shadcn/ui ships alongside them: `toggle-group` and `button-group`. Checked
  against their published source rather than from memory — `tabs` and `toggle-group`
  each require a Radix package, and `button-group` is a layout wrapper with no
  selection of its own, against one file with no dependencies and true
  `radiogroup`/`radio` semantics here. Spells out the keyboard contract (arrows move
  and select in one press and wrap, Home/End, disabled segments stepped over, roving
  tabindex keeping the group a single tab stop) and the triggers an agent would match.

## 2026-08-14

- feat(scroll-progress): new. A bar that fills as the reader scrolls — the reading
  indicator across the top of an article and the "how much is left?" cue on anything
  long. Decorative by design: the scrollbar already tells assistive technology where
  the reader is, so the element is `aria-hidden` rather than a `progressbar`
  announcing a stream of numbers over whatever is being read. `useScrollProgress` is
  exported so indicators this component does not draw share one number instead of a
  second implementation that disagrees at the edges.

## 2026-08-13

- feat(ratio-bar): new. One horizontal bar showing how a whole divides up, with a
  legend that names and quantifies every part — storage by file type, a plan quota,
  spend by category, a language bar. The percentages are apportioned by largest
  remainder rather than rounded one at a time, so three equal parts read 34/33/33 and
  the column always totals exactly 100; a part too small to round to a whole percent
  reads `<1%` and a part that is nearly but not quite everything reads `>99%`, rather
  than the two lies those cases would otherwise tell. Slice widths are left to
  flexbox (`flex-grow` on the exact share, with a two-pixel minimum), so a sliver
  stays visible and the width it needs comes out of the largest slices, which is what
  the flexbox min-width rules already guarantee. Pass `total` to switch from "parts
  of a whole" to "used out of a capacity" and the gap is drawn and listed. Negative,
  NaN and Infinity values count as zero instead of collapsing the layout. Nothing is
  carried by colour alone and the bar itself is `aria-hidden`. No dependencies, no
  hooks, no `"use client"`.
- docs(confirm-button): description rewritten against the AEO rubric — what the armed
  state does and how it disarms, the `type="button"` default that keeps a form from
  submitting, the live-region announcement, and how it differs from official
  `alert-dialog` (a portalled, focus-trapping modal that pulls in
  `@radix-ui/react-alert-dialog`) and official `button` (a destructive variant with no
  confirmation behaviour), checked against their published source rather than from
  memory. Points at `type-to-confirm` for actions where a second click is not enough.

## 2026-08-12

- feat(cron-expression): new. Renders a cron expression as an English sentence and,
  given a reference instant, the next times it fires. The day-of-month and
  day-of-week fields are ORed when neither is a literal star and ANDed when either
  one is, so `0 0 13 * 5` reads and behaves as "the 13th **or** every Friday" and
  `0 0 13 * 0-6` as every day — the rule keys off syntax rather than coverage, and
  the component says so on screen when it applies. Sunday folds from 7 to 0 after a
  range is expanded, so `5-7` is Friday through Sunday. Next runs are computed in
  UTC by stepping whichever field fails rather than a minute at a time, so a
  February-29 schedule costs thousands of comparisons instead of millions and
  February 30 ends empty instead of hanging. Run times are formatted without `Intl`
  to keep server and client markup identical. Nothing reads the clock. No
  dependencies, no hooks, no `"use client"`.
- docs(loading-button): description rewritten against the AEO rubric — the
  double-submit problem it exists for, the two form gotchas (`type="submit"`, and a
  disabled button leaving the tab order), and what official `button` and `spinner`
  actually provide, checked against their published source rather than from memory.

## 2026-08-11

- feat(ansi-log): new. Renders raw terminal output — escape sequences and all — as
  styled, theme-aware HTML. A carriage return moves the cursor rather than breaking
  the line, so a progress bar that redraws itself stays one line. 16 named colours
  as light/dark pairs, the 256-colour cube, truecolor, and translucent background
  washes so text can never land on a saturated slab below contrast. Unimplemented
  sequences are consumed rather than printed. No dependencies, no hooks, no
  `"use client"`. (Entry added on 2026-08-12; the component shipped on 08-11.)

## 2026-08-10

- feat(calendar-heatmap): new. A year of daily counts as a grid of shaded squares —
  the contribution-graph shape, for commits, orders, sign-ins, workouts or any other
  per-day total. Days are held as integers (days since the epoch, UTC) rather than
  `Date` objects, so the grid cannot rotate by a row west of Greenwich, and the
  window is anchored to the last date in the data rather than to `Date.now()`, so
  the server and the browser always render the same markup. Shading is by quartile
  of the days that had activity, so one busy day does not flatten the year. Real
  table semantics with a screen-reader name on every square. No dependencies, no
  hooks, no `"use client"`.
- docs(announcement-bar): description rewritten against the AEO rubric — concrete
  triggers, the hydration/flash problem it solves, and what `alert`, `alert-dialog`
  and `sonner` actually do instead (checked against their published source, not
  from memory).

## 2026-08-09 — quality sweep

- fix(bento-grid): a `colSpan` of 3 or 4 no longer invents a column at the tablet
  breakpoint. Every layout the grid offers is two columns wide at `md` and only
  reaches three or four at `lg`, but the spans were emitted as a bare
  `md:col-span-3`/`md:col-span-4` — and CSS Grid does not clamp a span that overruns
  the explicit grid, it adds the missing tracks to the implicit grid (§8.5). Those
  tracks are `auto`, so the first cell that landed in one was sized by its own
  content: measured in Chrome, a `md:col-span-3` cell in a two-column grid collapsed
  the two real `1fr` columns from 448px to 95px and handed the phantom third 403px.
  Each span is now capped per breakpoint to the tracks that tier actually has, so the
  cell fills the row at `md` and widens at `lg`. Rendered output at `lg` is
  unchanged. The prop docs and the registry description said the opposite — that CSS
  Grid clamped an over-wide span — and have been corrected.
- a11y(upload-list): a queue that empties and refills no longer announces files that
  were already finished when they arrived. The component promises that "the first
  render is treated as the starting state", so a list mounting with finished rows
  stays quiet — but the flag holding that promise was only ever set, never reset, so
  the guarantee applied to the first batch and no other. Re-opening a picker on
  attachments that are already `done` announced them as if they had just uploaded.
  Emptying the queue also unmounts the live region while leaving its last message in
  state, so the next batch remounted the region with stale text. Both now reset when
  the queue goes empty.

## 2026-08-02 — quality sweep

- a11y(inline-edit): keyboard focus no longer falls to the top of the page when an
  edit ends. Enter and Escape unmount the input while it still holds focus, dropping
  focus to `<body>` and sending the next Tab back to the start of the document; focus
  now returns to the edit trigger. Blur exits are deliberately excluded, since focus
  has already gone where the user put it. Also forwards `onChange` and `onBlur`: both
  are in the component's public props type but were overwritten by its own handlers,
  so a consumer's handlers never fired (`onKeyDown` already forwarded — these match it
  now).
- fix(countdown): `onComplete` fires once per deadline. The "already fired" latch
  lived inside the timer effect, so changing the `interval` prop after the countdown
  finished re-armed the effect, reset the latch, and fired `onComplete` again for the
  same target. The latch now records which target it fired for — a new `to` still
  fires again, a re-arm does not.
- fix(autosize-textarea): the field re-measures when its own width changes, not only
  when the window resizes. A collapsing sidebar, an opening panel, or a tab becoming
  visible rewraps the text without ever resizing the window, which left the height
  stale. It now observes the element itself (`ResizeObserver`, reacting to width only
  so its own height writes cannot feed back), falling back to the window listener
  where that API is unavailable.
- fix(currency-input): amounts are parsed in the notation the field displays. The
  `locale` prop drove formatting, but parsing was hardcoded to a `.` decimal, so in
  comma-decimal locales the component misread its own output — de-DE "1.234,50" came
  back as 1.2345 and "1234,50" as 123450. The group and decimal characters now come
  from `Intl.NumberFormat` for the configured locale. en-US, ja-JP and en-IN parse
  exactly as before; a plain `.` is still taken as the decimal except in locales that
  group with it.

## 2026-07-26 — quality sweep

- fix(feature-card): props passed alongside `href` now reach the rendered `<a>`.
  The link branch never spread `...props`, so `id`, `data-*`, `aria-*`, `style` and
  event handlers were silently dropped on linked cards while working fine on plain
  ones. The props type widened from `ComponentPropsWithoutRef<"div">` to
  `HTMLAttributes<HTMLElement>` to cover both elements the card renders.
- fix(progress-ring): center content that is present but falsy — `children={0}`,
  for instance a remaining-items count — now renders. The center was gated with
  `??` on a truthiness test, so a `0` or `""` child fell through to nothing. It now
  tests for null/undefined, matching how `gauge` gates its center.
- fix(multi-select): the "no options found" row is now `role="presentation"`, so
  the `role="listbox"` no longer owns a child that isn't an option. Also floors the
  active-option index at 0: pressing ArrowDown while the filtered list was empty
  drove it to -1, which left no row highlighted (and Enter inert) once options
  reappeared without a keystroke in the search box — reachable with `hideSearch`
  or async-loaded options.

## 2026-07-19 — quality sweep

- fix(file-dropzone): in single-file mode, dropping several valid files at once now
  reports the discarded ones through `onReject` with reason `"too-many"` instead of
  silently dropping all but the last. The accepted file is unchanged; only the
  previously-missing reject notifications (and an accurate "Added 1 file, N skipped"
  announcement) are added.

## 2026-07-12 — quality sweep

- fix(tag-input): pasting a comma/newline-separated list now adds every value.
  The paste loop called `addTag` per value, but each add read the tag list from a
  render that hadn't updated yet, so `[...tags, tag]` overwrote prior adds and only
  the last value survived. Adds are now threaded through one working list and
  committed once.
- a11y(toast): the `<Toaster>` container is now an `<ol>` instead of a `<section>`,
  so its `<li>` toasts nest in a valid list for assistive tech (an `<li>` outside a
  list is invalid HTML). The `aria-label="Notifications"` region name is preserved.

## 2026-07-05 — quality sweep

- fix(command-palette): keyboard selection now matches the highlighted row when
  results use `group`. Navigation indexed the score-ordered list while rendering
  re-bucketed by group, so for scattered groups the highlighted / aria-active /
  scrolled row and the row Enter selected diverged. Results are now clustered by
  group (first-seen order) before slicing, so nav order == render order.
- docs(spinner): drop the stale "shadcn/ui ships no spinner primitive" line from
  the registry description — shadcn now ships an official `spinner`. Metadata
  only; the component code is unchanged.

## 2026-06-23 — quality sweep

- a11y(stat-card): add dark-mode contrast variants for the delta (emerald/red 400
  in dark) and a screen-reader direction label so +N% and −N% are distinguishable
  without relying on color (WCAG 1.4.1).
- a11y(avatar-stack): add role="img" to the initial-letter fallback so its
  aria-label is reliably announced (aria-label on a bare span is not honored
  by all screen readers).

## 2026-06-23

- Initial release: copy-button, kbd, empty-state, stat-card, theme-toggle,
  avatar-stack, password-input, spinner, code-block, loading-button, confirm-button.
- Pro: dashboard-overview.
