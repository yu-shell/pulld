# Changelog

Notable changes to pulld components. Updates apply to new installs; the shadcn CLI
copies code into your project, so existing installs are never changed automatically.

## 2026-08-02 — quality sweep

- a11y(inline-edit): keyboard focus no longer falls to the top of the page when an
  edit ends. Enter and Escape unmount the input while it still holds focus, dropping
  focus to `<body>` and sending the next Tab back to the start of the document; focus
  now returns to the edit trigger. Blur exits are deliberately excluded, since focus
  has already gone where the user put it. Also forwards `onChange` and `onBlur`: both
  are in the component's public props type but were overwritten by its own handlers,
  so a consumer's handlers never fired (`onKeyDown` already forwarded — these match it
  now).

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
