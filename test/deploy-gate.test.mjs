// `npm run deploy` has to run `npm run verify` before it uploads, and nothing may regenerate
// public/ after that.
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
