#!/usr/bin/env node
// Dependency-free self-check. Verifies that each item in registry.json:
//  - has the required fields (name/type/files)
//  - has a unique name and no repeated file paths within an item
//  - references source files that actually exist
//  - declares, in registryDependencies, every component of ours that its source imports
//  - declares, in dependencies, every npm package its source imports
//  - has a title/description of sufficient length for discoverability
//  - has a real preview on the generated landing page, rather than the generic fallback box
//  - is listed in the generated public/llms.txt, the index AI agents read the catalogue from
// and, if a build output exists in public/r, that it corresponds to the items. The source tree is
// checked in the same both-ways spirit: a .tsx under registry/ that no item claims is flagged too.
//
// The validation is exposed as a pure function (verifyRegistry) so it can be unit-tested without
// touching the filesystem; the CLI below wires it to the real registry.json and public/r.

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cardId, PREVIEW_OPEN, PREVIEW_PLACEHOLDER } from "./_landing-markup.mjs"

// The build outputs in public/r that are not components. `shadcn build` writes the catalogue
// index under CATALOGUE_INDEX alongside the per-item files (inject-base.mjs skips it for the same
// reason), and scripts/build-index.mjs writes the same catalogue again under OFFICIAL_INDEX —
// the path clients built against ui.shadcn.com probe. Neither has a registry item, and neither
// ever will; everything else in that directory without one is a stale artifact still being served.
export const CATALOGUE_INDEX = "registry"
export const OFFICIAL_INDEX = "index"
export const NON_COMPONENT_OUTPUTS = new Set([CATALOGUE_INDEX, OFFICIAL_INDEX])

// The components of this registry that one source imports. components.json maps the `ui` alias to
// @/registry/ui, so that is the spelling every self-composed import carries in the source, and the
// shadcn CLI rewrites it to the consumer's own `ui` alias on install. Matching the string literal
// rather than an `import ... from` line keeps `import()` and `export ... from` in scope for free —
// every form that makes the consumer need the file. The pattern is built per call rather than
// shared: a global regex carries `lastIndex` between uses, and one stray `.test()` on a shared one
// would make later scans start mid-file and silently find nothing.
const localImports = (src) => {
  const names = new Set()
  for (const [, name] of src.matchAll(/["'`]@\/registry\/ui\/([a-z0-9-]+)["'`]/g)) names.add(name)
  return names
}

// The name a registryDependencies entry declares. registry.json spells these bare, but an absolute
// URL to our own /r/<name>.json is equally installable — it is what the build outputs carry after
// inject-base.mjs — so both spellings have to count as declaring the same component.
const declaredName = (dep) =>
  typeof dep === "string"
    ? dep.replace(/^https?:\/\/[^?#]*\/r\//, "").replace(/\.json([?#].*)?$/, "")
    : ""

// react and react-dom are the runtime a shadcn consumer necessarily already has; official
// shadcn's own items do not list them in `dependencies` either, so importing one is not an
// undeclared dependency.
export const ASSUMED_PACKAGES = new Set(["react", "react-dom"])

// The npm packages one source imports — the other half of what `localImports` deliberately
// ignores. A specifier that is neither relative nor an alias into this repo (`@/…`) resolves to
// something the consumer's own node_modules has to carry, and `dependencies` is the only field
// that makes `shadcn add` install it.
//
// Matched at statement granularity rather than by bare string literal, which is the difference
// from `localImports` above: `@/registry/ui/<name>` is a spelling prose never contains, but
// package names are ordinary words and these sources carry long prose comments. So a match has to
// both begin a line with `import`/`export` (or close a multi-line clause with `}`) and end that
// line at the specifier — two conditions a sentence containing the word "from", a `// import …`
// example, or a ` * import …` doc-comment line does not satisfy together. Built per call for the
// same reason as `localImports`: a shared global regex carries `lastIndex` between uses.
const externalImports = (src) => {
  const statements = [
    // import … from "x" / export … from "x", on one line.
    /^[ \t]*(?:import|export)[^\n]*?\bfrom[ \t]*(["'])([^"'\n]+)\1[ \t]*;?[ \t]*$/gm,
    // Side-effect import: import "x".
    /^[ \t]*import[ \t]*(["'])([^"'\n]+)\1[ \t]*;?[ \t]*$/gm,
    // The closing line of a multi-line named import: } from "x".
    /^[ \t]*\}[ \t]*from[ \t]*(["'])([^"'\n]+)\1[ \t]*;?[ \t]*$/gm,
  ]
  const names = new Set()
  for (const re of statements) {
    for (const [, , spec] of src.matchAll(re)) {
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("@/")) continue
      // A subpath import still installs the package: "lucide-react/icons" is lucide-react.
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      if (pkg && !ASSUMED_PACKAGES.has(pkg)) names.add(pkg)
    }
  }
  return names
}

// The package a `dependencies` entry names. shadcn lets an entry pin a range ("lucide-react@^0.4"),
// and a scoped package carries an @ of its own, so only a later @ is a version.
const packageOf = (dep) => {
  const s = String(dep ?? "").trim()
  const at = s.lastIndexOf("@")
  return at > 0 ? s.slice(0, at) : s
}

// The component names public/llms.txt lists. Read off the generated file rather than off
// build-llms.mjs's builder, for the same reason the landing-page check reads the built HTML: the
// file is the artifact that gets deployed, and a generator that never ran leaves yesterday's file
// in place looking exactly as correct as a current one.
//
// An entry is `- [<name>](<base>/r/<name>.json): <summary>`. Pro blocks are written the same way a
// section further down, under `/r/pro/<name>.json`, and are deliberately not matched: they come
// from pro/registry.json, which this verifier never sees, so counting them would report every Pro
// block as an entry no item in registry.json ships.
const llmsNames = (text) => {
  const names = new Set()
  const entry = /^- \[[^\]\n]+\]\([^)\s]*\/r\/([a-z0-9-]+)\.json\)/gm
  for (const [, name] of String(text ?? "").matchAll(entry)) names.add(name)
  return names
}

export const VALID_TYPES = new Set([
  "registry:ui",
  "registry:block",
  "registry:component",
  "registry:hook",
  "registry:lib",
  "registry:page",
  "registry:file",
  "registry:style",
  "registry:theme",
])

// Pure validator. Returns { messages: [{level, msg}], alert, warn } and never touches the disk or
// process state — callers inject `fileExists(path)` (relative to the repo root), `sourceFiles` (the
// component sources actually present under registry/, or null when they were not enumerated),
// `readSource(path)` (the text of one item file, or null when sources are not being read) and,
// when a build exists, `builtNames` (the list of names under public/r, or null when no build output
// is present), `landingHtml` (the generated public/index.html, or null when it has not been built)
// and `llmsTxt` (the generated public/llms.txt, or null for the same reason).
export function verifyRegistry(
  reg,
  {
    fileExists = () => true,
    builtNames = null,
    sourceFiles = null,
    readSource = null,
    landingHtml = null,
    llmsTxt = null,
  } = {}
) {
  const messages = []
  let warn = 0
  let alert = 0
  const push = (level, msg) => messages.push({ level, msg })
  const fail = (msg) => {
    alert++
    push("ALERT", msg)
  }
  const warning = (msg) => {
    warn++
    push("WARN", msg)
  }

  if (!Array.isArray(reg?.items) || reg.items.length === 0) {
    fail("registry.json has no items")
  } else {
    push("OK", `registry "${reg.name}" — items: ${reg.items.length}`)
  }

  // Names must be unique: shadcn builds one public/r/<name>.json per item and consumers install by
  // name, so a collision would silently clobber a component (and the build-output check below would
  // still pass because one file exists). Catch it here instead.
  const seenNames = new Set()

  for (const item of reg?.items ?? []) {
    const id = item.name ?? "(no name)"
    if (!item.name) {
      fail(`item is missing name`)
    } else if (seenNames.has(item.name)) {
      fail(`${id}: duplicate item name — names must be unique (build output/install-by-name collide)`)
    } else {
      seenNames.add(item.name)
    }
    if (!VALID_TYPES.has(item.type)) fail(`${id}: invalid type "${item.type}"`)
    if (!Array.isArray(item.files) || item.files.length === 0)
      fail(`${id}: files is empty`)

    const seenPaths = new Set()
    for (const f of item.files ?? []) {
      if (!f.path) {
        fail(`${id}: missing file.path`)
        continue
      }
      if (seenPaths.has(f.path)) {
        fail(`${id}: duplicate file.path → ${f.path}`)
        continue
      }
      seenPaths.add(f.path)
      if (!fileExists(f.path)) fail(`${id}: source file does not exist → ${f.path}`)
    }

    // Discoverability: a description should be specific about when to use the component,
    // hence the minimum length.
    if (!item.title) warning(`${id}: missing title`)
    if (!item.description) {
      warning(`${id}: missing description (AI cannot match it)`)
    } else if (item.description.length < 60) {
      warning(`${id}: description is short (${item.description.length} chars) — consider clarifying when to use it`)
    }
  }

  // The names this registry ships. Both checks below ask the same question of it — "is this one of
  // ours?" for a dependency, and "does an item still claim this?" for a build output.
  const itemNames = new Set((reg?.items ?? []).map((i) => i?.name).filter(Boolean))

  // registryDependencies, checked against what the sources actually import — the one field whose
  // correctness is invisible from inside this repo. `shadcn add` fetches an item plus the
  // components its registryDependencies name, and nothing else; an import that list omits ships a
  // file whose import resolves to nothing in the consumer's project. The install reports success
  // and their next build fails. Every signal here stays green through it: `npm run typecheck`
  // resolves the import against this tree, where the file is obviously present, and `shadcn build`
  // copies the source faithfully, so the wrong thing is published intact. The only place the two
  // sides meet is here.
  //
  // Read both ways, like the source tree and public/r below. Declaring a component nobody imports
  // only makes consumers install one they do not use, so that half warns rather than fails.
  if (readSource) {
    for (const item of reg?.items ?? []) {
      const id = item.name ?? "(no name)"
      const imported = new Set()
      const packages = new Set()
      for (const f of item.files ?? []) {
        const src = f?.path ? readSource(f.path) : null
        if (typeof src !== "string") continue
        for (const dep of localImports(src)) imported.add(dep)
        for (const pkg of externalImports(src)) packages.add(pkg)
      }
      // A component importing its own file is the item itself, not a dependency on one.
      imported.delete(item.name)
      const declared = new Set((item.registryDependencies ?? []).map(declaredName).filter(Boolean))

      for (const dep of imported) {
        if (declared.has(dep)) continue
        if (itemNames.has(dep)) {
          fail(
            `${id}: imports @/registry/ui/${dep} but registryDependencies does not list it — ` +
              `\`shadcn add ${id}\` installs this file without ${dep} and the consumer's build ` +
              `fails on the import → add "${dep}" to its registryDependencies`
          )
        } else {
          fail(
            `${id}: imports @/registry/ui/${dep}, which no item in registry.json ships — nothing ` +
              `installs it alongside ${id} → add an item for ${dep} or drop the import`
          )
        }
      }
      for (const dep of declared) {
        if (!itemNames.has(dep) || imported.has(dep)) continue
        warning(
          `${id}: registryDependencies lists "${dep}" but no file imports it — consumers install ` +
            `a component ${id} does not use → drop it from registryDependencies`
        )
      }

      // The npm half of the same blind spot. `dependencies` is what makes `shadcn add` run the
      // consumer's package manager; an import it omits ships a file whose package is simply not
      // there. It fails exactly like an undeclared registryDependency and hides in exactly the
      // same place: lucide-react is in this repo's own devDependencies, so `npm run typecheck`
      // resolves the import against a tree that has it, and `shadcn build` copies the source
      // faithfully. Every signal stays green and the consumer's build is the first thing to say
      // "Cannot find module". Thirty-one items currently declare lucide-react and thirty-one
      // sources import it — that correspondence has been held by hand until now.
      const declaredPkgs = new Set((item.dependencies ?? []).map(packageOf).filter(Boolean))
      for (const pkg of packages) {
        if (declaredPkgs.has(pkg)) continue
        fail(
          `${id}: imports "${pkg}" but dependencies does not list it — \`shadcn add ${id}\` ` +
            `installs this file without the package and the consumer's build fails on the ` +
            `import → add "${pkg}" to its dependencies`
        )
      }
      // Over-declaring only installs a package the consumer does not need, so it warns — the same
      // asymmetry as the registryDependencies pair above.
      for (const pkg of declaredPkgs) {
        if (packages.has(pkg)) continue
        warning(
          `${id}: dependencies lists "${pkg}" but no file imports it — consumers install an npm ` +
            `package ${id} does not use → drop it from dependencies`
        )
      }
    }
  }

  // The source tree, checked the way public/r is: both directions, not just the one the build
  // happens to notice. `files[].path → does it exist` is already covered above; this is the
  // reverse, and nothing else in the pipeline looks at it. A component written into registry/ but
  // never added to registry.json is not built, not served, not on the landing page, not in
  // llms.txt and not installable — it is finished work that ships to nobody, and every signal the
  // project has stays green while it sits there. Found in the wild: registry/ui/color-picker.tsx,
  // 636 lines, complete, uncommitted and unreferenced, invisible to `npm run check`.
  if (sourceFiles) {
    const claimed = new Set()
    for (const item of reg?.items ?? []) {
      for (const f of item.files ?? []) if (f.path) claimed.add(f.path)
    }
    for (const path of sourceFiles) {
      if (claimed.has(path)) continue
      warning(
        `${path}: orphan source — no item in registry.json references it, so it is never built ` +
          `and cannot be installed → add an item for it or delete the file`
      )
    }
  }

  // If a build output exists (public/r), check it corresponds to the items (otherwise INFO).
  // "Corresponds" runs both ways. The missing direction is the obvious one; the extra direction
  // matters more, because nothing else in the pipeline looks at it: `shadcn build` writes the
  // items it is given and never removes anything else, and public/r is gitignored, so the
  // directory is long-lived local state rather than something a fresh checkout resets. Rename or
  // drop a component and public/r/<old>.json survives every subsequent build — then `npm run
  // deploy` uploads public/ wholesale and it keeps being served, with the old code, at a URL the
  // registry no longer lists. The landing page and llms.txt are both regenerated from
  // registry.json, so nothing on the site points at it and nothing shows it is there; an agent or
  // a CLI that cached the name goes on installing a component this project stopped shipping.
  if (builtNames) {
    const built = new Set(builtNames)
    for (const name of itemNames) {
      if (!built.has(name))
        warning(`${name}: build output public/r/${name}.json is missing → npx shadcn build`)
    }
    // Exempting the two catalogue indexes from the stale check above also left them exempt from
    // the missing check, so the only two build outputs with no registry item behind them were the
    // only ones nothing verified in either direction. public/r/index.json in particular is written
    // by scripts/build-index.mjs, a separate step from `shadcn build`, and it is the path clients
    // built against ui.shadcn.com probe — one client asked for it 1,107 times in thirty days. If
    // that step is skipped the deploy serves no catalogue there and every other signal stays green.
    for (const name of NON_COMPONENT_OUTPUTS) {
      if (!built.has(name))
        warning(
          `${name}: catalogue index public/r/${name}.json is missing — clients probing that path ` +
            `see no catalogue → npm run registry:build`
        )
    }
    for (const name of built) {
      if (NON_COMPONENT_OUTPUTS.has(name) || itemNames.has(name)) continue
      warning(
        `${name}: stale build output — public/r/${name}.json has no item in registry.json and ` +
          `would still be deployed and served → rm public/r/${name}.json (shadcn build leaves it)`
      )
    }
    // Reported as a correspondence rather than a file count: the old total counted every file in
    // public/r, so the catalogue index and any stale artifact both inflated it, and the one number
    // meant to say "the build matches the registry" was the number that hid when it did not.
    const componentsBuilt = [...built].filter((name) => itemNames.has(name)).length
    push("OK", `build output: ${componentsBuilt} of ${itemNames.size} items built`)
  } else {
    push("INFO", "public/r not generated → run `npx shadcn build`")
  }

  // The landing page, checked the way public/r is: against what was generated, both ways.
  //
  // Every component gets a card on public/index.html and every card a small hand-built preview
  // (scripts/build-landing.mjs's PREVIEWS map). A component with no entry there still renders —
  // it falls back to a generic box — so the page looks finished, the build succeeds, and the
  // catalogue quietly gains another component wearing the same thumbnail as every other one that
  // was forgotten. Nothing fails, nothing is missing, nothing says so. That is the whole reason
  // the rule "a new component brings a preview" has been carried as prose in the daily routine's
  // notes, written there as mandatory and as a recurrence guard — a rule stated that way is only
  // as good as whoever last read it, and this one is checkable.
  //
  // Read off the built HTML rather than off the PREVIEWS map, because the map is not the question
  // being asked. An entry keyed under a name the registry no longer ships satisfies the map and
  // still leaves the page showing the box; the page is the artifact that goes out, so the page is
  // what is asked.
  //
  // WARN rather than ALERT, on the rule the rest of this file follows: nothing a consumer installs
  // is affected — installs arrive through the CLI, and this page is not on that path — so the cost
  // is a thumbnail on a page, not a build that fails in somebody else's project. WARN=0 is the
  // normal state here, so one line is enough to be seen on the run that produced it.
  if (landingHtml) {
    for (const name of itemNames) {
      const mark = `id="${cardId(name)}">`
      const at = landingHtml.indexOf(mark)
      if (at === -1) {
        warning(
          `${name}: no card on the landing page — public/index.html predates this item, so the ` +
            `catalogue page does not list it at all → npm run registry:build`
        )
        continue
      }
      // The preview box is the first thing inside a card, so it is read from immediately after the
      // id rather than searched for anywhere after it: a forward search would run into the NEXT
      // card's box and judge this component on that one's contents. Bounded, because the two
      // markers are 41 characters between them and the page is half a megabyte.
      const head = landingHtml.slice(at + mark.length, at + mark.length + 128).replace(/^\s+/, "")
      if (!head.startsWith(PREVIEW_OPEN)) {
        warning(
          `${name}: landing-page card does not open with a preview box — public/index.html no ` +
            `longer has the shape this check reads, so the preview rule is going unverified → ` +
            `reconcile scripts/_landing-markup.mjs with scripts/build-landing.mjs`
        )
        continue
      }
      if (head.slice(PREVIEW_OPEN.length).startsWith(PREVIEW_PLACEHOLDER)) {
        warning(
          `${name}: landing-page card shows the generic placeholder box — no PREVIEWS entry in ` +
            `scripts/build-landing.mjs, so the catalogue gives it the same thumbnail as every ` +
            `other component missing one → add a small "${name}" mock-up to PREVIEWS`
        )
      }
    }
  } else {
    push("INFO", "public/index.html not generated → run `npm run registry:build`")
  }

  // public/llms.txt, checked the way public/r and the landing page are: against what was
  // generated, both ways.
  //
  // It was the last generated file under public/ with no correspondence check, and the one whose
  // readers are least able to complain about it. llms.txt is the index an AI agent loads to find
  // out what this registry has — the README points at it, and agents arriving through it are the
  // audience the descriptions in registry.json are written for. A component missing from it is
  // not installed less often; it is never considered.
  //
  // Nothing else notices. Measured on the real tree: with one entry deleted from llms.txt and
  // nothing else touched, `npm run verify` printed ALERT=0 WARN=0 and exited 0. The file is
  // gitignored, so like public/r it is long-lived local state that `npm run deploy` uploads
  // wholesale — a stale copy is not reset by a fresh build of anything else. And the step that
  // writes it is one `import.meta.url` guard away from not running at all, which prints nothing
  // and leaves the previous file; test/cli-main-guard.test.mjs exists because exactly that
  // shipped once.
  //
  // WARN rather than ALERT, on the rule the rest of this file follows: nothing a consumer
  // installs breaks — /r/<name>.json still serves the component to anyone who asks for it by
  // name — so the cost is discovery, not a build that fails in somebody else's project.
  if (llmsTxt !== null) {
    const listed = llmsNames(llmsTxt)
    if (itemNames.size && listed.size === 0) {
      // Reported once, naming the root cause, rather than as one "not listed" line per item: a
      // format this check cannot read makes every component look individually missing, and the
      // one thing to go and look at is the generator, not 105 components.
      warning(
        `public/llms.txt lists no components in the shape this check reads — it was either ` +
          `generated before the catalogue had items or build-llms.mjs no longer writes entries ` +
          `as \`- [name](…/r/name.json)\`, and the index is going unverified either way → ` +
          `reconcile with scripts/build-llms.mjs`
      )
    } else {
      for (const name of itemNames) {
        if (listed.has(name)) continue
        warning(
          `${name}: not listed in public/llms.txt — the AI-readable index predates this item, so ` +
            `an agent reading it never learns the component exists → npm run registry:build`
        )
      }
      for (const name of listed) {
        if (itemNames.has(name)) continue
        warning(
          `${name}: stale entry in public/llms.txt — no item in registry.json ships it, and the ` +
            `index still sends agents to /r/${name}.json → npm run registry:build`
        )
      }
    }
  } else {
    push("INFO", "public/llms.txt not generated → run `npm run registry:build`")
  }

  push("RESULT", `ALERT=${alert} WARN=${warn}`)
  return { messages, alert, warn }
}

// --- CLI: run against the real registry.json and public/r ---
function main() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

  let reg
  try {
    reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  } catch (e) {
    console.log(`ALERT\tcannot read/parse registry.json: ${e.message}`)
    process.exit(1)
  }

  const rDir = join(ROOT, "public", "r")
  const builtNames = existsSync(rDir)
    ? readdirSync(rDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""))
    : null

  // Every component source under registry/, as repo-relative paths — the same shape as the
  // `files[].path` the items carry, so the two sets compare directly.
  const walk = (dir, prefix) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${prefix}/${entry.name}`
      if (entry.isDirectory()) return walk(join(dir, entry.name), path)
      return entry.name.endsWith(".tsx") ? [path] : []
    })
  }
  const sourceFiles = existsSync(join(ROOT, "registry")) ? walk(join(ROOT, "registry"), "registry") : null

  // A file the item claims but that is not there is already reported by fileExists; returning null
  // here keeps that one failure to one message instead of a second, vaguer one about its imports.
  const readSource = (p) => {
    try {
      return readFileSync(join(ROOT, p), "utf8")
    } catch {
      return null
    }
  }

  // The generated catalogue page, when `npm run registry:build` has produced one. It is
  // gitignored like public/r, so a fresh checkout that has not built yet gets the INFO line
  // rather than 101 warnings about a page that was never written.
  const landingPath = join(ROOT, "public", "index.html")
  const landingHtml = existsSync(landingPath) ? readFileSync(landingPath, "utf8") : null

  // The generated AI-readable index, on the same terms as the page above: gitignored, so an
  // un-built checkout gets the INFO line instead of one warning per component.
  const llmsPath = join(ROOT, "public", "llms.txt")
  const llmsTxt = existsSync(llmsPath) ? readFileSync(llmsPath, "utf8") : null

  const { messages, alert } = verifyRegistry(reg, {
    fileExists: (p) => existsSync(join(ROOT, p)),
    builtNames,
    sourceFiles,
    readSource,
    landingHtml,
    llmsTxt,
  })
  for (const m of messages) console.log(`${m.level}\t${m.msg}`)
  process.exit(alert ? 1 : 0)
}

// Only run the CLI when invoked directly (`node scripts/verify-registry.mjs`), not when imported
// by the unit tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
