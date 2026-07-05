# Changelog

Notable changes to pulld components. Updates apply to new installs; the shadcn CLI
copies code into your project, so existing installs are never changed automatically.

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
