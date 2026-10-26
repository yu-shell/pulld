#!/usr/bin/env node
// Mutation testing for one component and its test file: does the suite actually hold the source in
// place, or does it only happen to pass?
//
// It exists because this has been worth doing on every component — it has found a real defect or a
// real hole in the tests nearly every time — and it was re-improvised by hand each time, which
// means the operator set drifted from day to day and the counts could not be compared. A figure
// that cannot be compared with the previous one is not a measurement.
//
// How it works: the source is tokenised with the TypeScript scanner, so only real code is mutated —
// comments and the long class-name strings are trivia and literals the scanner hands back whole,
// never a `<` inside a sentence. One token is changed per run, the file is written in place, the
// test file is run, and the original is written back. In place because the test loads the component
// from its real path; the original is held in memory and restored in a `finally` and again on
// signals, so an interrupted run leaves the file as it found it.
//
// Usage: node scripts/mutate.mjs registry/ui/<name>.tsx test/<name>.test.mjs [--list]
//
// Read the survivors, never the score. A survivor is one of three things, and only the first is a
// problem worth fixing:
//   - a hole in the tests: the rule is real and nothing asserts it,
//   - an equivalent mutant: the behaviour cannot change, because something downstream re-imposes
//     the same rule (a clamp after an index, a guard after a parse),
//   - an artifact of the harness: it runs every effect on every pass, so a dependency array has no
//     observable consequence here and a mutation inside one is invisible by construction.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { pathToFileURL } from "node:url"
import ts from "typescript"

/** The binary operators, and what each is replaced with. One occurrence is changed per run. */
const BINARY = new Map([
  ["<", "<="],
  ["<=", "<"],
  [">", ">="],
  [">=", ">"],
  ["===", "!=="],
  ["!==", "==="],
  ["==", "!="],
  ["&&", "||"],
  ["||", "&&"],
  ["+", "-"],
  ["-", "+"],
  ["??", "||"],
])

const NUMBERS = new Map([
  ["0", "1"],
  ["1", "0"],
  ["2", "1"],
])

// A string literal short enough to be a role, a key name, an attribute value or a variant — the
// kind of constant a test should be pinning. The long ones are class lists, which carry spaces and
// are left alone: a mutation there is a styling question, and `cn` would swallow it anyway.
const isPinnableString = (text) => /^[A-Za-z][A-Za-z-]{0,23}$/.test(text)

/** Whether this literal is the value of a `className` / `class` attribute or property. */
const isClassNameValue = (node) => {
  const parent = node.parent
  const named =
    (ts.isJsxAttribute(parent) && parent.name) ||
    (ts.isPropertyAssignment(parent) && parent.name) ||
    null
  const name = named && ts.isIdentifier(named) ? named.text : named?.getText?.()
  return name === "className" || name === "class"
}

/**
 * Every (start, end, replacement) this file offers, in source order.
 *
 * Taken from the parsed tree rather than from the scanner, which is the second attempt and the
 * reason this is worth a comment. A bare `ts.createScanner` walk looks right and derails on the
 * first template literal in the file: the scanner hands back `TemplateHead`, the substitution's
 * contents, then a plain `}` — closing a substitution needs `reScanTemplateToken`, which only the
 * parser knows to call — so the *next* backtick in the file opens a fresh template, and from there
 * every backtick in the prose is read as code. The effect is not a crash but a quiet one: 42 of 74
 * "mutations" landed inside doc comments, every one of them survived, and the score read 22%
 * instead of what it was. The tree cannot do that, because a comment is not a node.
 */
export function mutationsFor(source, fileName = "input.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  )
  const out = []
  const add = (start, end, from, to, kind) => {
    if (from !== to) out.push({ start, end, from, to, kind })
  }

  const visit = (node) => {
    if (ts.isBinaryExpression(node)) {
      const token = node.operatorToken
      const text = token.getText(sourceFile)
      if (BINARY.has(text)) {
        add(token.getStart(sourceFile), token.getEnd(), text, BINARY.get(text), "operator")
      }
    } else if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(node.operand)
    ) {
      // Dropping the sign, so a sentinel like -1 becomes a real position.
      const start = node.getStart(sourceFile)
      add(start, start + 1, "-", "", "sign")
    } else if (ts.isNumericLiteral(node)) {
      const text = node.getText(sourceFile)
      add(node.getStart(sourceFile), node.getEnd(), text, NUMBERS.get(text) ?? "0", "number")
    } else if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
      const text = node.getText(sourceFile)
      add(node.getStart(sourceFile), node.getEnd(), text, text === "true" ? "false" : "true", "boolean")
    } else if (
      ts.isStringLiteral(node) &&
      isPinnableString(node.text) &&
      // Not a literal in a type: `align?: "start" | "end"` and the members of an `Omit<…>` are
      // erased before anything runs, so changing one cannot change behaviour and the "mutant" is
      // guaranteed to survive. Counting those drags the score down by a third and hides the
      // survivors that mean something. The type side is checked by `tsc`, which is a different
      // tool and already in `npm run check`.
      !ts.isLiteralTypeNode(node.parent) &&
      !ts.isTypeNode(node.parent) &&
      // Not a class name either. `className="truncate"` is a styling decision, a test that pinned
      // it would be asserting the stylesheet, and `cn` concatenates whatever it is handed — so these
      // survive by design and only crowd out the survivors that mean something.
      !isClassNameValue(node)
    ) {
      add(node.getStart(sourceFile) + 1, node.getEnd() - 1, node.text, "mutated", "string")
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(sourceFile, visit)
  return out.sort((a, b) => a.start - b.start)
}

const lineOf = (source, index) => source.slice(0, index).split("\n").length

/**
 * How long one mutant's suite may take before it is treated as hung.
 *
 * It needs a deadline at all because a mutation can make the code loop forever, and a run of 350
 * then stops at the first one: the day this was added, one mutant turned the chunk-splitter's
 * backstop into `while (to + start > limit)` and the run sat on it for seventeen minutes.
 * Generous against the suite's own runtime (a few hundred milliseconds), so a slow machine is
 * never mistaken for a loop.
 */
const RUN_TIMEOUT_MS = 20_000

/**
 * Runs the test file once.
 *
 * Directly rather than through `node --test`, which forks a runner process that forks a worker per
 * file: three processes, of which only the first receives the timeout's kill. The other two outlive
 * it, and a hanging mutant leaves a spinning orphan behind for every run. Executing the file itself
 * puts the tests in the one process the deadline can actually end — node's test runner reports and
 * sets the exit code the same way either way, which is all this reads.
 */
function runSuite(testPath) {
  return spawnSync(process.execPath, [testPath], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  })
}

function main(argv) {
  const [sourcePath, testPath, ...flags] = argv
  if (!sourcePath || !testPath) {
    console.error("usage: node scripts/mutate.mjs <source.tsx> <test.test.mjs> [--list]")
    return 2
  }
  // A sidecar left behind means the previous run was killed before it could put the file back, so
  // what is on disk now is a mutant. Repair it before reading, or every mutation this run reports
  // is measured against code nobody wrote.
  const leftover = `${sourcePath}.mutate-backup`
  if (existsSync(leftover)) {
    const saved = readFileSync(leftover, "utf8")
    if (saved !== readFileSync(sourcePath, "utf8")) {
      writeFileSync(sourcePath, saved)
      console.error(`restored ${sourcePath} from an interrupted run`)
    }
    rmSync(leftover, { force: true })
  }

  const original = readFileSync(sourcePath, "utf8")
  const mutations = mutationsFor(original)

  if (flags.includes("--list")) {
    for (const m of mutations) {
      console.log(`${sourcePath}:${lineOf(original, m.start)}  ${m.from} -> ${m.to}`)
    }
    console.log(`${mutations.length} mutations`)
    return 0
  }

  // The baseline matters: a suite that is already red says nothing about any mutant.
  const baseline = runSuite(testPath)
  if (baseline.status !== 0) {
    console.error(`the suite is already failing — fix that first\n${baseline.stdout?.slice(-2000)}`)
    return 1
  }

  // The original is also written beside the source, because holding it only in memory makes the
  // restore conditional on this process living long enough to run it. It does not always: a kill
  // that lands between writing a mutant and writing the original back leaves the mutant in the
  // file, type-valid and silent, and the next reader has no way to know. The sidecar turns that
  // into something the next run repairs by itself.
  const backupPath = `${sourcePath}.mutate-backup`
  writeFileSync(backupPath, original)
  const restore = () => {
    writeFileSync(sourcePath, original)
    rmSync(backupPath, { force: true })
  }
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      restore()
      process.exit(130)
    })
  }

  const survivors = []
  const hung = []
  try {
    for (const [index, m] of mutations.entries()) {
      writeFileSync(sourcePath, original.slice(0, m.start) + m.to + original.slice(m.end))
      const run = runSuite(testPath)
      const timedOut = run.error?.code === "ETIMEDOUT"
      const killed = run.status !== 0
      const line = lineOf(original, m.start)
      if (timedOut) hung.push({ ...m, line })
      else if (!killed) survivors.push({ ...m, line })
      process.stdout.write(
        `${timedOut ? "T" : killed ? "." : "S"}${(index + 1) % 50 === 0 ? ` ${index + 1}/${mutations.length}\n` : ""}`
      )
    }
  } finally {
    restore()
  }

  console.log(
    `\n\n${mutations.length} mutants, ${mutations.length - survivors.length} killed, ${survivors.length} survived` +
      (hung.length ? `, of which ${hung.length} by hanging` : "")
  )
  // Counted as killed — a suite that never finishes has certainly noticed — but listed, because a
  // mutant that loops forever is pointing at a loop whose termination rests on the token it changed.
  for (const h of hung) {
    console.log(`  HUNG     ${sourcePath}:${h.line}  ${h.from} -> ${h.to || "(removed)"}`)
  }
  for (const s of survivors) {
    // The context is the point: two `||` on one line are two mutants, and which one lived is the
    // whole question. Printed with the replacement spliced in, so the survivor reads as the code
    // the tests accepted.
    const from = original.lastIndexOf("\n", s.start) + 1
    const to = original.indexOf("\n", s.end)
    const mutated = original.slice(from, s.start) + s.to + original.slice(s.end, to < 0 ? undefined : to)
    console.log(`  SURVIVED ${sourcePath}:${s.line}  ${s.from} -> ${s.to || "(removed)"}`)
    console.log(`           ${mutated.trim().slice(0, 100)}`)
  }
  return 0
}

// pathToFileURL rather than a template, because `import.meta.url` is percent-encoded and argv[1]
// is a plain path: one space in the checkout path would make this comparison fail and the script
// exit 0 having done nothing. test/cli-main-guard.test.mjs holds the whole of scripts/ to it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
