#!/usr/bin/env node
// Generate llms.txt from registry.json (+ pro) so AI tools/agents can discover the components
// and how to install them (shadcn itself also publishes an llms.txt).
// Output: public/llms.txt. SITE_BASE overrides the URL.
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE = (process.env.SITE_BASE || "https://pulld.pages.dev").replace(/\/$/, "")
const reg = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"))
const items = reg.items ?? []

const lines = []
lines.push("# pulld")
lines.push("")
lines.push(
  "> AI-installable, shadcn-compatible component registry. Production-ready React/Tailwind " +
    "components that an AI coding agent (Claude Code, Cursor, v0) or the shadcn CLI can install " +
    "by name. Every component is typed, accessible, and theme-aware. Free atoms plus paid Pro blocks."
)
lines.push("")
lines.push("## Install")
lines.push("")
lines.push("Add the namespace to your project's components.json, then add by name:")
lines.push("")
lines.push('```json')
lines.push('{ "registries": { "@pulld": "' + BASE + '/r/{name}.json" } }')
lines.push('```')
lines.push("")
lines.push("```bash")
lines.push("npx shadcn@latest add @pulld/" + (items[0]?.name || "copy-button"))
lines.push("# or directly by URL:")
lines.push("npx shadcn@latest add " + BASE + "/r/" + (items[0]?.name || "copy-button") + ".json")
lines.push("```")
lines.push("")
lines.push("## Components")
lines.push("")
for (const it of items) {
  lines.push(`- [${it.name}](${BASE}/r/${it.name}.json): ${it.description || it.title || it.name}`)
}

const proPath = join(ROOT, "pro", "registry.json")
if (existsSync(proPath)) {
  const pro = JSON.parse(readFileSync(proPath, "utf8")).items ?? []
  if (pro.length) {
    lines.push("")
    lines.push("## Pro blocks (license required)")
    lines.push("")
    lines.push(
      "Composed, production-ready blocks. Install with a license key: " +
        "`npx shadcn@latest add \"" + BASE + "/r/pro/<name>.json?key=YOUR_KEY\"`."
    )
    lines.push("")
    for (const it of pro) {
      lines.push(`- [${it.name}](${BASE}/r/pro/${it.name}.json): ${it.description || it.title || it.name}`)
    }
  }
}
lines.push("")

writeFileSync(join(ROOT, "public", "llms.txt"), lines.join("\n"))
console.log(`OK\tpublic/llms.txt generated: ${items.length} components (base ${BASE})`)
