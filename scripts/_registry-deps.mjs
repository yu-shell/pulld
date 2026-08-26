// One source of truth for how a dependency on *this* registry's own component is published.
//
// shadcn resolves a bare `registryDependencies` name against the official registry
// (ui.shadcn.com), so a pulld component that composes another pulld component has to name it by
// URL — otherwise the CLI fetches somebody else's component under that name, or nothing at all.
// That is what scripts/inject-base.mjs has done to the per-item files since the beginning.
//
// The two catalogue files never got the same treatment, so the same dependency shipped spelled two
// different ways in the same deploy: public/r/code-block.json said
// "https://pulld.pages.dev/r/copy-button.json" while public/r/registry.json and public/r/index.json
// — the catalogue, and the catalogue again at the path clients built against official probe — both
// said "copy-button". Six components compose another pulld component today, and two of the names
// they compose (`spinner`, `kbd`) are also the names of components official shadcn ships, so a
// client reading the catalogue does not even get a miss it could report: it gets a different
// component with the right name.
//
// Keeping the rule here means the three outputs cannot drift apart again — the same reason
// functions/_traffic.js holds "who fetched this" and scripts/_installs.mjs holds "what counts".
//
// The no-base case is deliberately a no-op rather than a relative path. `/r/copy-button.json` is
// not something a CLI can resolve, so emitting one would turn "resolves against the wrong
// registry" into "resolves nowhere"; the bare name at least still names the component. inject-base
// already exits early without SITE_BASE for this reason, and this keeps buildIndex agreeing with
// it (its `meta.url` can fall back to a relative URL because nothing installs from it).

/** The names this registry ships, as a Set — what makes a dependency "our own". */
export const localNamesOf = (registry) =>
  new Set((registry?.items ?? []).map((i) => i?.name).filter(Boolean))

/**
 * Rewrites the entries of one `registryDependencies` list that name a component of this registry
 * into the URL that serves it. Anything else — a name we do not ship (official's `button`), an
 * already-absolute URL, a non-string — is returned untouched.
 *
 * Returns a new array; without `base` the original list is returned as-is (see the note above).
 */
export function expandLocalDeps(deps, localNames, base) {
  const site = String(base || "").replace(/\/$/, "")
  if (!site || !Array.isArray(deps)) return deps
  return deps.map((dep) =>
    typeof dep === "string" && localNames.has(dep) ? `${site}/r/${dep}.json` : dep
  )
}
