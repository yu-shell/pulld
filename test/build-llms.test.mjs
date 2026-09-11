// llms.txt — the index an agent loads to find out what this registry has.
//
// It is generated from registry.json and referenced from the README as the AI-readable index, but
// nothing verified it: build-llms.mjs was top-level script code, so there was no function to call
// and no test to write. These pin the two things that can quietly break it — the structure a
// reader navigates by, and the size budget that made the index unloadable once the AEO
// descriptions grew (83 components came to 292 KB, 96.7% of it descriptions).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { summarize, buildLlms } from "../scripts/build-llms.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = "https://pulld.pages.dev"

const registry = {
  name: "pulld",
  items: [
    {
      name: "copy-button",
      type: "registry:ui",
      title: "Copy Button",
      description:
        "A one-click copy control that writes a string to the clipboard. Reach for it wherever a " +
        "value on the page is there to be taken somewhere else: an install command, an API key, a " +
        "share link. Common asks: \"copy button\", \"copy to clipboard react\".",
    },
    {
      name: "kbd",
      type: "registry:ui",
      title: "Kbd",
      description: "Inline keyboard key rendered as a real <kbd> element.",
    },
  ],
}

test("each component is one markdown line: link, then the opening sentence only", () => {
  const out = buildLlms(registry, { base: BASE })
  assert.ok(
    out.includes(
      "- [copy-button](https://pulld.pages.dev/r/copy-button.json): " +
        "A one-click copy control that writes a string to the clipboard."
    ),
    "the entry should stop after the first sentence"
  )
  assert.ok(!out.includes("Common asks"), "the full AEO text belongs in the item, not the index")
})

test("a description with no sentence to trim survives whole", () => {
  const out = buildLlms(registry, { base: BASE })
  assert.ok(
    out.includes(
      "- [kbd](https://pulld.pages.dev/r/kbd.json): Inline keyboard key rendered as a real <kbd> element."
    )
  )
})

// The one that motivated requiring a capital after the mark: keyboard-shortcuts opens "The help
// sheet that opens when the user presses ? — a modal listing every keyboard shortcut…", where the
// question mark is part of the sentence. Splitting on any `?` cut the entry to a fragment that
// never said what the component was.
test("a ? or . inside a sentence is not the end of it", () => {
  assert.equal(
    summarize("The help sheet that opens when the user presses ? — a modal listing them all. Next."),
    "The help sheet that opens when the user presses ? — a modal listing them all."
  )
  assert.equal(summarize("Costs $1.50 per run. Next."), "Costs $1.50 per run.")
})

test("an unbroken description is truncated on a word boundary rather than inlined whole", () => {
  const long = "word ".repeat(200).trim()
  const s = summarize(long)
  assert.ok(s.length <= 401, `expected a bounded summary, got ${s.length}`)
  assert.ok(s.endsWith("…"))
  assert.ok(!s.includes("wor…"), "should cut at a space, not mid-word")
})

test("whitespace is collapsed so one item stays one markdown line", () => {
  assert.equal(summarize("A field\nthat  grows. Then scrolls."), "A field that grows.")
})

test("no description falls back to the title, then the name", () => {
  const out = buildLlms(
    { items: [{ name: "a", title: "Alpha" }, { name: "b" }] },
    { base: BASE }
  )
  assert.ok(out.includes(`- [a](${BASE}/r/a.json): Alpha`))
  assert.ok(out.includes(`- [b](${BASE}/r/b.json): b`))
})

test("pro blocks are listed under /r/pro and only when there are any", () => {
  const pro = [{ name: "dashboard-overview", description: "A dashboard shell. Details follow." }]
  const withPro = buildLlms(registry, { base: BASE, pro })
  assert.ok(withPro.includes("## Pro blocks (license required)"))
  assert.ok(
    withPro.includes(
      `- [dashboard-overview](${BASE}/r/pro/dashboard-overview.json): A dashboard shell.`
    )
  )
  assert.ok(!buildLlms(registry, { base: BASE }).includes("## Pro blocks"))
})

test("the sections a reader navigates by are all present", () => {
  const out = buildLlms(registry, { base: BASE })
  for (const h of ["# pulld", "## Install", "## Components", "## pulld Search"]) {
    assert.ok(out.includes(h), `missing section ${h}`)
  }
  // The index says where the unabridged descriptions are, since it no longer carries them.
  assert.ok(out.includes(`${BASE}/r/index.json`))
})

test("a trailing slash on the base never doubles in a URL", () => {
  const out = buildLlms(registry, { base: "https://pulld.pages.dev/" })
  assert.ok(out.includes("https://pulld.pages.dev/r/copy-button.json"))
  assert.ok(!out.includes("//r/copy-button.json"))
})

// The budget this file exists to hold. Run against the real registry, so the day a description is
// written without a sentence break — or the index starts inlining them again — this fails instead
// of the file quietly growing back past what a reader will load.
test("the real catalogue produces an index small enough to load", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
  const out = buildLlms(reg, { base: BASE })
  assert.ok(reg.items.length > 50, "sanity: the real registry was read")
  assert.ok(
    out.length < 64 * 1024,
    `llms.txt is ${Math.round(out.length / 1024)} KB — an index this size gets truncated by the ` +
      `readers it exists for; keep entries to their opening sentence`
  )
  // Every component still appears — a smaller file that dropped components would be worse.
  for (const it of reg.items) assert.ok(out.includes(`](${BASE}/r/${it.name}.json):`), it.name)
})
