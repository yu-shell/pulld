// Unit tests for the pure validator behind `npm run verify` (scripts/verify-registry.mjs).
// Dependency-free: uses Node's built-in test runner (`node --test`), so the gate stays install-free.
// verify-registry guards the registry before deploy, so its own logic is a correctness-sensitive
// path — these tests pin the rules (unique names, existing files, discoverable descriptions) and,
// in particular, the duplicate-name guard that a silent name collision would otherwise slip past.
import { test } from "node:test"
import assert from "node:assert/strict"
import { verifyRegistry } from "../scripts/verify-registry.mjs"

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
    { fileExists: () => true, builtNames: ["copy-button", "registry"] }
  )
  assert.ok(hasMsg(r, "build output public/r/toast.json is missing"))
  assert.ok(hasMsg(r, "build output: 2 files"))
})

test("no build output yields an INFO line, not a warning", () => {
  const r = verifyRegistry({ name: "pulld", items: [okItem()] }, { fileExists: () => true, builtNames: null })
  assert.equal(r.warn, 0)
  assert.ok(hasMsg(r, "public/r not generated"))
})
