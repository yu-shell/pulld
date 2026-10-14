// One build of the generated catalogue page, for the tests that read it. Not a test file itself
// (the `_` prefix keeps it out of the `test/**/*.test.mjs` glob) — it exists so the two files that
// assert against the page drive one build instead of two that share a path.
//
// Both used to run scripts/build-landing.mjs with its own repo root, which writes the real
// public/index.html: the 782 KB artifact `npm run deploy` uploads. That is one path with two
// writers. `node --test` schedules test FILES concurrently — availableParallelism - 1, which is
// nine here — so the two builds overlap, and the page each one then reads can be the other's
// half-written copy. Measured by polling the path while two builds ran: 36 of 36 reads landed on a
// partial file, at sizes from 0 bytes up, and one of them had no `id="pro"` in it — the exact
// string test/pro-license-link.test.mjs looks for in it. The suite has not actually been seen to
// fail this way (thirty consecutive runs of the two files together were green), which is the
// defining property of a race rather than a reason to keep one: the gate it would fail is the one
// that decides whether a day's work is deployed, and a red that has nothing to do with the change
// is the most expensive kind.
//
// So the build goes to a private temp root, the way test/build-index.test.mjs,
// test/inject-base.test.mjs, test/build-pro.test.mjs and test/registry-deps.test.mjs already run
// the scripts they test — this was the only script in scripts/ whose tests ran it in place. The
// page is still generated rather than read off public/index.html as it stands, for the reason
// test/landing-cards.test.mjs gives (a stale artifact looks exactly as correct as a current one),
// and still generated from the real registry.json, so every assertion is about the catalogue that
// ships. What changes is that running the tests no longer writes to the tree's own build output.
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

// Everything build-landing.mjs reads: its own helper module, the catalogue, and the private Pro
// registry when the machine has one. public/ it does not create — it writes straight into it — so
// the temp root has to carry the directory too.
const SCRIPTS = ["build-landing.mjs", "_landing-markup.mjs"]

/**
 * Whether this machine has the private Pro registry (`/pro/` is gitignored). The Pro section only
 * renders when it is present, so the assertions about that section skip without it — and a
 * checkout without it has no Pro blocks for the paywall to refuse either.
 */
export const hasProRegistry = () => existsSync(join(ROOT, "pro", "registry.json"))

let cached = null

/**
 * The generated landing page, as HTML. Built once per test process, on first call.
 *
 * Cached because both callers want the same page and the build is the slow part of either file;
 * the cache is per-process, so it is the single build within one test file, never shared state
 * between the files that race here.
 */
export function landingHtml() {
  if (cached !== null) return cached
  // realpath, because macOS's tmpdir() is a symlink — the same reason the sibling script tests
  // resolve it before handing the path to a child process.
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "pulld-landing-")))
  try {
    mkdirSync(join(tmp, "scripts"), { recursive: true })
    mkdirSync(join(tmp, "public"), { recursive: true })
    for (const f of SCRIPTS) copyFileSync(join(ROOT, "scripts", f), join(tmp, "scripts", f))
    copyFileSync(join(ROOT, "registry.json"), join(tmp, "registry.json"))
    if (hasProRegistry()) {
      mkdirSync(join(tmp, "pro"), { recursive: true })
      copyFileSync(join(ROOT, "pro", "registry.json"), join(tmp, "pro", "registry.json"))
    }

    const out = execFileSync(process.execPath, [join(tmp, "scripts", "build-landing.mjs")], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 60000,
    })

    const written = join(tmp, "public", "index.html")
    if (!existsSync(written)) {
      throw new Error(`build-landing.mjs wrote no page:\n${out}`)
    }
    cached = readFileSync(written, "utf8")
    return cached
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
