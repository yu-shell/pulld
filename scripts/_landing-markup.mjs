// One source of truth for the pieces of landing-page markup that something other than
// scripts/build-landing.mjs has to recognise.
//
// The catalogue page gives every component a card, and every card a small visual preview built by
// hand in build-landing.mjs's PREVIEWS map. A component with no entry there is not an error — it
// renders, and it renders the generic box the placeholder below opens — so nothing has ever
// stopped one shipping that way. The rule that a new component brings a preview has lived only as
// prose in the daily routine's notes, where it is already written as mandatory and as a
// recurrence guard, which is to say it has been missed before. A rule a script can check does not
// belong in prose: scripts/verify-registry.mjs checks it against the generated page, and to do
// that it has to recognise a card and the placeholder inside one.
//
// Kept here rather than spelled a second time in the check, for the reason build-index.mjs exports
// INDEX_FILE instead of letting inject-base.mjs carry its own copy: the generator and the check
// have to agree, and a string written twice is a string that drifts. build-landing.mjs cannot
// export them itself — it is a flat top-level script with no main guard, so importing it would run
// the whole build.
//
// The matching CSS (`.preview`, `.pv-ph`) stays in build-landing.mjs's style block. A selector
// going out of step changes how the box looks, which is not the question the check asks.

/** The `id` the landing page gives one component's card. */
export const cardId = (name) => `c-${name}`

/** Opens the preview box, which is the first thing inside every card. */
export const PREVIEW_OPEN = `<div class="preview">`

/** Opens the generic box a component with no PREVIEWS entry falls back to. */
export const PREVIEW_PLACEHOLDER = `<span class="pv-ph">`
