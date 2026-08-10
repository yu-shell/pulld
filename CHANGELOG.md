# Changelog

Notable changes to pulld components. Updates apply to new installs; the shadcn CLI
copies code into your project, so existing installs are never changed automatically.

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
