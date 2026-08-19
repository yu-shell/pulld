// Unit tests for the pure validator behind `npm run verify` (scripts/verify-registry.mjs).
// Dependency-free: uses Node's built-in test runner (`node --test`), so the gate stays install-free.
// verify-registry guards the registry before deploy, so its own logic is a correctness-sensitive
// path — these tests pin the rules (unique names, existing files, discoverable descriptions) and,
// in particular, the duplicate-name guard that a silent name collision would otherwise slip past.
import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyRegistry, CATALOGUE_INDEX, OFFICIAL_INDEX } from "../scripts/verify-registry.mjs"

// A minimal item that passes every check (valid type, one existing file, title, long-enough desc).
const okItem = (over = {}) => ({
  name: "copy-button",
  type: "registry:ui",
  title: "Copy Button",
  description: "A button that copies text to the clipboard and confirms with a check icon. Fifty plus.",
  files: [{ path: "registry/ui/copy-button.tsx", type: "registry:ui" }],
  ...over,
})

const msgs = (r) => r.messages.map((m) => `${m.level}\t${m.msg}`)
const hasMsg = (r, sub) => msgs(r).some((line) => line.includes(sub))

test("valid registry produces no alerts and no warnings", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem()] }, { fileExists: () => true })
  assert.equal(r.alert, 0)
  assert.equal(r.warn, 0)
  // Ends with a machine-readable RESULT tally.
  assert.ok(hasMsg(r, "RESULT\tALERT=0 WARN=0"))
})

test("empty / missing items is an alert", () => {
  assert.equal(verifyRegistry({ name: "pulld", items: [] }).alert, 1)
  assert.ok(hasMsg(verifyRegistry({ name: "pulld" }), "registry.json has no items"))
})

test("duplicate item name is an alert (silent collision guard)", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem(), okItem()] },
    { fileExists: () => true }
  )
  assert.ok(r.alert >= 1)
  assert.ok(hasMsg(r, "duplicate item name"))
})

test("distinct names do not trip the duplicate guard", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem(), okItem({ name: "toast" })] },
    { fileExists: () => true }
  )
  assert.equal(r.alert, 0)
})

test("missing name is an alert", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem({ name: undefined })] }, { fileExists: () => true })
  assert.ok(hasMsg(r, "item is missing name"))
  assert.ok(r.alert >= 1)
})

test("invalid type is an alert", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem({ type: "registry:widget" })] }, { fileExists: () => true })
  assert.ok(hasMsg(r, 'invalid type "registry:widget"'))
})

test("empty files list is an alert", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem({ files: [] })] }, { fileExists: () => true })
  assert.ok(hasMsg(r, "files is empty"))
})

test("a source file that does not exist is an alert", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem()] }, { fileExists: () => false })
  assert.ok(hasMsg(r, "source file does not exist"))
  assert.ok(r.alert >= 1)
})

test("a repeated file.path within one item is an alert", () => {
  const dup = okItem({
    files: [
      { path: "registry/ui/copy-button.tsx", type: "registry:ui" },
      { path: "registry/ui/copy-button.tsx", type: "registry:ui" },
    ],
  })
  const r = verifyRegistry({ name: "pulld", items: [dup] }, { fileExists: () => true })
  assert.ok(hasMsg(r, "duplicate file.path"))
})

test("missing title and missing description are warnings, not alerts", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem({ title: undefined, description: undefined })] },
    { fileExists: () => true }
  )
  assert.equal(r.alert, 0)
  assert.equal(r.warn, 2)
  assert.ok(hasMsg(r, "missing title"))
  assert.ok(hasMsg(r, "missing description"))
})

test("a too-short description is a warning", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem({ description: "Too short." })] },
    { fileExists: () => true }
  )
  assert.equal(r.alert, 0)
  assert.ok(hasMsg(r, "description is short"))
})

test("build output: a missing built file warns and the count is reported", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem(), okItem({ name: "toast" })] },
    { fileExists: () => true, builtNames: ["copy-button", CATALOGUE_INDEX] }
  )
  assert.ok(hasMsg(r, "build output public/r/toast.json is missing"))
  // One of the two items was built. The catalogue index is a build output too, but it is not an
  // item, and counting it made the tally read as full coverage when half the registry was missing.
  assert.ok(hasMsg(r, "build output: 1 of 2 items built"))
})

// The other direction, which nothing else in the pipeline looks at. `shadcn build` writes the
// items it is given and removes nothing, and public/r is gitignored — so a component that is
// renamed or dropped leaves its old JSON behind, `npm run deploy` uploads public/ wholesale, and
// the URL keeps serving code the registry no longer lists. Confirmed by planting a file in
// public/r and rebuilding: it survives.
test("build output: a built file with no registry item is flagged as stale", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    { fileExists: () => true, builtNames: ["copy-button", "copy-btn"] }
  )
  assert.equal(r.alert, 0, "a stale artifact is recoverable with rm; it must not fail the gate")
  assert.ok(hasMsg(r, "copy-btn: stale build output"))
  assert.ok(hasMsg(r, "rm public/r/copy-btn.json"))
  // The stale file is not an item, so it must not pad the tally either.
  assert.ok(hasMsg(r, "build output: 1 of 1 items built"))
})

test("build output: the catalogue index is never stale", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    { fileExists: () => true, builtNames: ["copy-button", CATALOGUE_INDEX, OFFICIAL_INDEX] }
  )
  assert.equal(r.warn, 0)
  assert.ok(!hasMsg(r, "stale build output"))
})

test("no build output yields an INFO line, not a warning", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem()] }, { fileExists: () => true, builtNames: null })
  assert.equal(r.warn, 0)
  assert.ok(hasMsg(r, "public/r not generated"))
  // Including the catalogue indexes: nothing was built, so nothing is missing yet.
  assert.ok(!hasMsg(r, "catalogue index"))
})

// The same both-ways idea one step upstream, on the source tree. `files[].path → does it exist`
// is covered above; this is the reverse, and it is the direction nothing else in the pipeline
// looks at. A component written into registry/ but never added to registry.json is not built, not
// served, not on the landing page or in llms.txt, and not installable — while every check the
// project runs stays green. Found in the wild: registry/ui/color-picker.tsx, 636 lines, complete,
// uncommitted and unreferenced by anything.
test("source tree: a .tsx with no registry item is flagged as orphaned", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    {
      fileExists: () => true,
      sourceFiles: ["registry/ui/copy-button.tsx", "registry/ui/color-picker.tsx"],
    }
  )
  assert.equal(r.alert, 0, "an unshipped source is recoverable; it must not fail the deploy gate")
  assert.ok(hasMsg(r, "registry/ui/color-picker.tsx: orphan source"))
  // The claimed one must not be swept up with it.
  assert.ok(!hasMsg(r, "registry/ui/copy-button.tsx: orphan source"))
})

test("source tree: a file claimed by any item is not orphaned, whichever item claims it", () => {
  const r = verifyRegistry(
    {
      name: "pulld",
      items: [okItem(), okItem({ name: "toast", files: [{ path: "registry/ui/toast.tsx", type: "registry:ui" }] })],
    },
    { fileExists: () => true, sourceFiles: ["registry/ui/copy-button.tsx", "registry/ui/toast.tsx"] }
  )
  assert.equal(r.warn, 0)
})

test("source tree: not enumerated means no opinion, not a clean bill of health", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem()] }, { fileExists: () => true, sourceFiles: null })
  assert.equal(r.warn, 0)
  assert.ok(!hasMsg(r, "orphan source"))
})

// build-index.mjs writes the catalogue a second time, under the name official shadcn uses, so
// clients that probe /r/index.json can see this registry at all. Like the catalogue index it has
// no item and never will.
test("build output: the official-shaped index is never stale", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    { fileExists: () => true, builtNames: ["copy-button", CATALOGUE_INDEX, OFFICIAL_INDEX] }
  )
  assert.equal(r.warn, 0)
  assert.ok(!hasMsg(r, "stale build output"))
  // Exempting it must not pad the coverage tally either.
  assert.ok(hasMsg(r, "build output: 1 of 1 items built"))
})

test("build output: exempting the two indexes does not exempt everything else", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    {
      fileExists: () => true,
      builtNames: ["copy-button", CATALOGUE_INDEX, OFFICIAL_INDEX, "renamed-away"],
    }
  )
  assert.ok(hasMsg(r, "renamed-away: stale build output"))
})

// The direction that was missing. Both catalogue indexes are skipped by the stale check because
// neither will ever have a registry item — and that exemption silently covered their absence too,
// leaving the one build-output problem `verify` could not see. `index` is the expensive one: it is
// written by a step of its own (scripts/build-index.mjs), and it is the path clients built against
// ui.shadcn.com reach for, so losing it means those clients see no catalogue at all.
test("build output: a missing catalogue index warns, in the direction the exemption used to hide", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    { fileExists: () => true, builtNames: ["copy-button", CATALOGUE_INDEX] }
  )
  assert.equal(r.alert, 0, "a missing index is recoverable with a rebuild; it must not fail the gate")
  assert.ok(hasMsg(r, `${OFFICIAL_INDEX}: catalogue index public/r/${OFFICIAL_INDEX}.json is missing`))
  assert.ok(hasMsg(r, "npm run registry:build"))
  // The one that IS present must not be reported as missing.
  assert.ok(!hasMsg(r, `${CATALOGUE_INDEX}: catalogue index`))
  assert.equal(r.warn, 1)
})

test("build output: both indexes missing are reported separately, and neither pads the tally", () => {
  const r = verifyRegistry(
    { name: "pulld", items: [okItem()] },
    { fileExists: () => true, builtNames: ["copy-button"] }
  )
  assert.ok(hasMsg(r, `${CATALOGUE_INDEX}: catalogue index`))
  assert.ok(hasMsg(r, `${OFFICIAL_INDEX}: catalogue index`))
  assert.equal(r.warn, 2)
  assert.ok(hasMsg(r, "build output: 1 of 1 items built"))
})
