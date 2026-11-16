// `npm run deploy` has to run every check in `npm run check` before it uploads, nothing may
// regenerate public/ after the verify among them, and a rebuild inside deploy has to carry
// SITE_BASE. The verify half is the oldest rule here and the essay below is about it; the last
// section generalises it to the rest of the gate.
//
// verify-registry.mjs is the only check in this project whose subject is the artifact rather than
// the source: it compares registry.json against what is sitting in public/r, public/index.html and
// public/llms.txt right now. Every other signal is about the tree. `npm run typecheck` resolves an
// import against this checkout, where the file is obviously present, and `shadcn build` copies the
// source faithfully — so a `registryDependencies` list that omits an import type-checks, builds,
// and installs into a customer's project as a file whose import resolves to nothing. verify's
// comments say as much: "The only place the two sides meet is here."
//
// It was not on the path to customers. `deploy` ran registry:build, then build:pro, then
// `wrangler pages deploy`, and nothing in that chain asked verify anything. There is no CI (no
// .github at all) and no git hook, so `npm run check` typed by hand was the whole gate — and the
// hazards verify names are specifically deploy's: a renamed component leaves public/r/<old>.json
// behind, `shadcn build` never removes it, public/r is gitignored so no fresh checkout resets it,
// and "then `npm run deploy` uploads public/ wholesale and it keeps being served, with the old
// code, at a URL the registry no longer lists". That sentence was already in verify-registry.mjs,
// describing a deploy that could not see it. Measured: verify reads files only, no network, 0.25s.
//
// The gate is `verify` and deliberately not `check`. `check` re-runs `registry:build`, which runs
// scripts/inject-base.mjs — the step that rewrites a dependency on one of this registry's own
// components into its absolute `${SITE_BASE}/r/<name>.json` URL, and which does nothing at all
// when SITE_BASE is unset ("If SITE_BASE is unset, do nothing"). A bare `check` wedged into deploy
// would therefore rebuild public/ without SITE_BASE and strip those URLs back to bare names
// immediately before the upload, reintroducing by hand the exact drift scripts/_registry-deps.mjs
// was written to end. The third test below is that reasoning made mechanical, so the convenient
// one-word substitution fails here instead of in somebody's install.
//
// Read off package.json rather than off a list pasted here, for the reason _registry-deps.mjs
// exists: which scripts regenerate public/ is a fact package.json already states, and a fact
// written twice is a fact that drifts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {}

/** The shell steps of one npm script, in order. */
const stepsOf = (command) =>
  String(command || "")
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean)

/**
 * One script's command with every `npm run <name>` replaced by that script's own command, so a
 * step can be asked what it ultimately runs. Depth-bounded rather than cycle-tracked: npm itself
 * would loop on a cyclic script, so the bound is a guard against this helper hanging, not a
 * behaviour anything depends on.
 */
const expand = (command, depth = 0) =>
  depth > 6
    ? String(command || "")
    : String(command || "").replace(/npm run ([\w:-]+)/g, (whole, name) =>
        scripts[name] ? expand(scripts[name], depth + 1) : whole
      )

// inject-base.mjs is what makes a step SITE_BASE-dependent, and it only ever runs as part of
// registry:build — which is also the step that writes public/r, public/index.html and public/llms.txt,
// the three files verify reads. So "reaches inject-base" is both "regenerates what verify checks"
// and "needs SITE_BASE", which is why one predicate answers both tests below.
const regeneratesPublic = (step) => expand(step).includes("scripts/inject-base.mjs")

const deploySteps = stepsOf(scripts.deploy)
const uploadAt = deploySteps.findIndex((s) => /wrangler.*pages deploy/.test(s))
const verifyAt = deploySteps.findIndex((s) => expand(s).includes("scripts/verify-registry.mjs"))

test("the deploy script is being read at all", () => {
  // A test that cannot find the upload step passes without checking anything.
  assert.ok(scripts.deploy, "package.json has no `deploy` script")
  assert.ok(uploadAt >= 0, `no \`wrangler pages deploy\` step in: ${scripts.deploy}`)
  assert.ok(
    deploySteps.some(regeneratesPublic),
    `no step of \`deploy\` regenerates public/ — the predicate below matches nothing: ${scripts.deploy}`
  )
})

test("deploy runs verify before uploading", () => {
  assert.ok(
    verifyAt >= 0,
    "`deploy` uploads public/ without running verify — a registryDependencies list that omits an " +
      "import, or a stale public/r/<old>.json, would ship unseen"
  )
  assert.ok(
    verifyAt < uploadAt,
    `verify runs after the upload in \`deploy\`, which checks the previous deploy: ${scripts.deploy}`
  )
})

test("nothing regenerates public/ after the verify gate in deploy", () => {
  const after = deploySteps.slice(verifyAt + 1).filter(regeneratesPublic)
  assert.deepEqual(
    after,
    [],
    "a rebuild after verify means verify checked files the upload then replaced — move the gate last"
  )
})

for (const [i, step] of deploySteps.entries()) {
  if (!regeneratesPublic(step)) continue
  test(`deploy step ${i + 1} passes SITE_BASE when it regenerates public/ (${step})`, () => {
    assert.match(
      step,
      /SITE_BASE=\S/,
      "scripts/inject-base.mjs does nothing without SITE_BASE, so this step would publish bare " +
        "dependency names that shadcn resolves against ui.shadcn.com instead of this registry"
    )
  })
}

// --- every check in `check` is on the path to production, not just verify ---
//
// The gate above put verify in front of the upload because verify is the only check whose subject
// is the artifact. The other two steps of `check` — `node --test` and `tsc --noEmit` — were left
// out, and that is a hole rather than a symmetry, because `wrangler pages deploy` uploads more
// than public/: Pages compiles the project-root `functions/` directory alongside it, so every
// Pages Function ships with the same command.
//
// That is the code with the least to fall back on. functions/ is excluded from tsconfig, and
// functions/_pro-gate.js says so in as many words — its handlers have `node --test` coverage
// "precisely because functions/ is excluded from tsconfig and that is its only automated check".
// The handlers under it are the Polar webhook that provisions and revokes paid access, the Pro
// license gate, and the search endpoints, one of which answers an uncredentialed caller with a
// secret `admin_key`. Their only automated check was a command that `deploy` never ran.
//
// Nothing else would have caught it: there is no CI (no .github at all) and no git hook, so
// `npm run check` typed by hand was the whole gate — and a deploy typed straight after an edit
// skipped it while reporting success, which is the same silence the top of this file describes for
// a stale public/r/<old>.json. Measured on this checkout: `node --test` is 5.5s over 3,504 tests
// and `tsc --noEmit` 1.8s, against a deploy that already spends two `npx --yes` package
// resolutions and an upload. There was no budget reason to leave them out.
//
// Derived from `check` rather than written here as the two step names, for the reason the top of
// this file gives: which commands make up the gate is a fact package.json already states, and a
// fact written twice is a fact that drifts. A step added to `check` from now on has to reach
// production too — unless it regenerates public/, which `deploy` deliberately keeps its own
// SITE_BASE-carrying copy of (the loop above is what holds that copy honest).
//
// Only "before the upload" is asserted, because that is the invariant. Their placement first in
// `deploy` is a courtesy: a red tree should not cost two package resolutions and a landing-page
// build before anyone is told.
const checkSteps = stepsOf(scripts.check)

test("the check script is being read at all", () => {
  // Same hazard as the deploy guard: a list that comes back empty would retire every rule below.
  assert.ok(scripts.check, "package.json has no `check` script")
  assert.ok(checkSteps.length >= 3, `expected the steps of \`check\`, found: ${scripts.check}`)
  assert.ok(
    checkSteps.some(regeneratesPublic),
    `no step of \`check\` regenerates public/ — the predicate matches nothing: ${scripts.check}`
  )
  assert.ok(
    checkSteps.some((s) => !regeneratesPublic(s)),
    `every step of \`check\` reads as a public/ rebuild, which would exempt all of them: ${scripts.check}`
  )
})

for (const step of checkSteps) {
  // deploy runs its own SITE_BASE-carrying rebuild instead of this one; see the loop above.
  if (regeneratesPublic(step)) continue
  test(`deploy runs \`${step}\` before uploading`, () => {
    const wanted = expand(step)
    const at = deploySteps.findIndex((s) => expand(s).includes(wanted))
    assert.ok(
      at >= 0,
      `\`${step}\` (${wanted}) is part of \`check\` but nothing in \`deploy\` runs it, so an upload ` +
        `can ship code this command is the only check on — functions/ above all: ${scripts.deploy}`
    )
    assert.ok(
      at < uploadAt,
      `\`${step}\` runs after the upload in \`deploy\`, which checks a tree that already shipped: ${scripts.deploy}`
    )
  })
}
