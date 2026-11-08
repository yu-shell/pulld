// A column mapper looks finished in fifty lines: split on newlines, split on commas, show a
// dropdown per field. The cases below are written to fail against that and against the
// implementations it grows into:
//
//   - `text.split("\n")`, which turns a quoted newline into a record boundary and lands every
//     following row one column over,
//   - a separator guessed by counting characters in the first line, which the quoted data defeats
//     in both directions,
//   - a separator guessed by "most columns wins", which is the first thing this file tried and which
//     loses to naive counting on the case it was written for,
//   - `Number(cell)` as a numeric test, which reads a blank cell as the number zero,
//   - `Date.parse(cell)` as a date test, which reads `42` as a year and rolls the 30th of February
//     into March,
//   - a mapping screen that reports missing fields but not ignored columns, or the reverse,
//   - and a preview built by reading the whole file.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  CSV_DELIMITERS,
  createCsvParser,
  parseCsv,
  csvShape,
  sniffDelimiter,
  readCsvPreview,
  stripBom,
  looksLikeHeader,
  isPlainNumber,
  isPlainInteger,
  isPlainDate,
  isPlainBoolean,
  matchesKind,
  checkColumn,
  normalizeHeader,
  autoMatchFields,
  mappingReport,
  applyMapping,
  CsvColumnMapper,
} = loadComponent(join(ROOT, "registry", "ui", "csv-column-mapper.tsx"))

const FIELDS = [
  { name: "email", label: "Email", required: true },
  { name: "full_name", label: "Full name", required: true },
  { name: "signed_up", label: "Signed up", kind: "date" },
  { name: "seats", label: "Seats", kind: "integer" },
]

// ---------------------------------------------------------------- parsing

test("a quoted newline is one cell, not two records", () => {
  const { rows } = parseCsv('id,note\n1,"line one\nline two"\n2,ok')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1], ["1", "line one\nline two"])
  assert.deepEqual(rows[2], ["2", "ok"])
})

test("a quoted delimiter stays inside its cell", () => {
  const { rows } = parseCsv('"Smith, John","Acme, Inc.",42')
  assert.deepEqual(rows[0], ["Smith, John", "Acme, Inc.", "42"])
})

test("doubled quotes are one literal quote", () => {
  const { rows } = parseCsv('a\n"he said ""hi"""')
  assert.deepEqual(rows[1], ['he said "hi"'])
})

test("CRLF records do not leave a stray carriage return or an empty row", () => {
  const { rows } = parseCsv("a,b\r\n1,2\r\n3,4\r\n")
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ])
})

test("a lone CR is a record separator too", () => {
  const { rows } = parseCsv("a,b\r1,2")
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ])
})

test("a blank line inside the file is kept, a trailing one is not", () => {
  const { rows } = parseCsv("a,b\n\n1,2\n\n")
  assert.deepEqual(rows, [["a", "b"], [""], ["1", "2"]])
})

test("an empty quoted cell survives as an empty string", () => {
  const { rows } = parseCsv('a,b,c\n1,"",3')
  assert.deepEqual(rows[1], ["1", "", "3"])
})

test("a row of only empty cells is not mistaken for a trailing blank line", () => {
  const { rows } = parseCsv("a,b\n,\n1,2")
  assert.deepEqual(rows, [
    ["a", "b"],
    ["", ""],
    ["1", "2"],
  ])
})

test("text ending inside a quote is reported rather than silently closed", () => {
  const cut = parseCsv('id,note\n1,"half a cel')
  assert.equal(cut.unterminatedQuote, true)
  const whole = parseCsv('id,note\n1,"a cell"')
  assert.equal(whole.unterminatedQuote, false)
})

test("limit stops the read and says the result is a sample", () => {
  const text = Array.from({ length: 50 }, (_, i) => `${i},row`).join("\n")
  const { rows, truncated } = parseCsv(text, { limit: 5 })
  assert.equal(rows.length, 5)
  assert.equal(truncated, true)
  assert.equal(parseCsv(text).truncated, false)
})

test("a non-default quote character is honoured", () => {
  const { rows } = parseCsv("a,b\n'x,y',z", { quote: "'" })
  assert.deepEqual(rows[1], ["x,y", "z"])
})

// The chunk boundary is the whole reason the parser is resumable, so it gets its own cases rather
// than relying on parseCsv's internal slicing.
test("the parser carries quote state across a chunk boundary", () => {
  const text = 'id,note\n1,"a,b\nc"\n2,ok'
  for (let cut = 1; cut < text.length; cut += 1) {
    const parser = createCsvParser()
    const rows = [...parser.push(text.slice(0, cut)), ...parser.push(text.slice(cut)), ...parser.end()]
    assert.deepEqual(
      rows,
      [
        ["id", "note"],
        ["1", "a,b\nc"],
        ["2", "ok"],
      ],
      `split at ${cut} changed the records`
    )
  }
})

test("a CRLF split between the CR and the LF does not produce an empty record", () => {
  const parser = createCsvParser()
  const rows = [...parser.push("a,b\r"), ...parser.push("\n1,2"), ...parser.end()]
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ])
})

test("a file whose last record has no line break is still returned", () => {
  const parser = createCsvParser()
  const rows = [...parser.push("a,b\n1,2"), ...parser.end()]
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[1], ["1", "2"])
})

test("a trailing empty quoted cell is not dropped by end()", () => {
  const parser = createCsvParser()
  const rows = [...parser.push('a,b\n1,""'), ...parser.end()]
  assert.deepEqual(rows[1], ["1", ""])
})

// ---------------------------------------------------------------- sniffing

test("the separator is found for each candidate's own file", () => {
  assert.equal(sniffDelimiter("id,name,qty\n1,apple,3\n2,pear,4").delimiter, ",")
  assert.equal(sniffDelimiter("id;name;price\n1;apple;1,50\n2;pear;2,75").delimiter, ";")
  assert.equal(sniffDelimiter("id\tname\tqty\n1\tapple\t3\n2\tpear\t4").delimiter, "\t")
  assert.equal(sniffDelimiter("id|name|qty\n1|apple|3\n2|pear|4").delimiter, "|")
})

test("a separator hiding inside quoted data does not win", () => {
  // Counting characters in the first line picks "," here and ";" below; "most columns wins" picks
  // the opposite of the right answer in both. Agreement has to lead.
  assert.equal(sniffDelimiter('id,note\n1,"a;b;c;d;e"\n2,"f;g;h;i;j"').delimiter, ",")
  assert.equal(sniffDelimiter('id;note\n1;"a,b,c,d,e"\n2;"f,g,h,i,j"').delimiter, ";")
})

test("a bare separator-lookalike in the text does not win", () => {
  assert.equal(sniffDelimiter("id,note\n1,hello; world\n2,bye; now").delimiter, ",")
  assert.equal(sniffDelimiter("id\tname\n1\tSmith, John\n2\tDoe, Jane").delimiter, "\t")
})

test("a single-column file is not reported as a confident guess", () => {
  const guess = sniffDelimiter("email\na@b.c\nd@e.f")
  assert.equal(guess.columns, 1)
  assert.equal(guess.confident, false)
})

test("a ragged file is not reported as a confident guess", () => {
  const guess = sniffDelimiter("a,b,c\n1,2\n3,4,5,6")
  assert.equal(guess.confident, false)
  assert.ok(guess.agreement < 0.9)
})

test("one record alone is not a confident guess", () => {
  assert.equal(sniffDelimiter("a,b,c").confident, false)
  assert.equal(sniffDelimiter("a,b,c\n1,2,3").confident, true)
})

test("reading a semicolon file with a comma collapses it to one column", () => {
  // The failure this component exists to make visible: no error, no exception, one column.
  const { rows } = parseCsv("id;name;qty\n1;a;3", { delimiter: "," })
  assert.deepEqual(rows.map((row) => row.length), [1, 1])
})

test("csvShape reports agreement rather than just a width", () => {
  assert.deepEqual(csvShape("a,b\n1,2\n3,4", ","), { columns: 2, agreement: 1, records: 3 })
  const ragged = csvShape("a,b,c\n1,2\n3,4,5", ",")
  assert.equal(ragged.columns, 3)
  assert.ok(ragged.agreement < 1)
})

test("an empty text sniffs without throwing and claims nothing", () => {
  const guess = sniffDelimiter("")
  assert.equal(guess.confident, false)
  assert.ok(CSV_DELIMITERS.includes(guess.delimiter))
})

// ---------------------------------------------------------------- BOM and chunked reads

test("a leading BOM is removed, because it would unmatch the first header", () => {
  assert.equal("﻿id" === "id", false)
  assert.equal(stripBom("﻿id,name"), "id,name")
  assert.equal(stripBom("id,name"), "id,name")
  assert.equal(normalizeHeader("﻿Email"), "email")
})

test("readCsvPreview decodes a multi-byte character split across chunks", async () => {
  // Without a streaming decoder this is the measured failure: a cut inside a multi-byte character
  // yields U+FFFD with no exception.
  const bytes = new TextEncoder().encode("名前,住所\n田中,東京\n佐藤,大阪\n")
  const blob = new Blob([bytes])
  const preview = await readCsvPreview(blob, { chunkBytes: 1, records: 10 })
  assert.equal(preview.rows[0][0], "名前")
  assert.ok(!JSON.stringify(preview.rows).includes("\\ufffd"))
  assert.deepEqual(preview.rows[1], ["田中", "東京"])
})

test("readCsvPreview reads only the window it was given and says so", async () => {
  const text = Array.from({ length: 2000 }, (_, i) => `${i},name-${i},x`).join("\n")
  const blob = new Blob([text])
  const preview = await readCsvPreview(blob, { bytes: 256, records: 5 })
  assert.ok(preview.bytesRead <= 256, `read ${preview.bytesRead} bytes`)
  assert.ok(preview.bytesRead < blob.size)
  assert.equal(preview.truncated, true)
  assert.ok(preview.rows.length > 0)
})

test("readCsvPreview drops the record the window cut in half", async () => {
  const blob = new Blob(["id,name\n1,aaaa\n2,bbbb\n3,cccc\n"])
  // 14 bytes lands inside "1,aaaa", so that partial record must not be shown as a short row.
  const preview = await readCsvPreview(blob, { bytes: 14, records: 10 })
  for (const row of preview.rows) assert.equal(row.length, 2)
  assert.equal(preview.truncated, true)
})

test("readCsvPreview sniffs the separator when it is not told one", async () => {
  const preview = await readCsvPreview(new Blob(["a;b;c\n1;2;3\n4;5;6\n"]))
  assert.equal(preview.delimiter, ";")
  assert.deepEqual(preview.rows[1], ["1", "2", "3"])
})

// ---------------------------------------------------------------- header guessing

test("a first record of only numbers is not a header", () => {
  const guess = looksLikeHeader([["1", "2", "3"], ["4", "5", "6"]])
  assert.equal(guess.header, false)
  assert.equal(guess.certain, false)
})

test("a first record over numeric columns is a header", () => {
  const guess = looksLikeHeader([
    ["id", "qty"],
    ["1", "3"],
    ["2", "4"],
  ])
  assert.equal(guess.header, true)
})

test("a header made of dates is still offered as a header, and never as certain", () => {
  // Measured real data: a monthly sheet whose column names are dates. No heuristic settles this,
  // which is why the toggle exists.
  const guess = looksLikeHeader([
    ["2026-01-01", "2026-02-01"],
    ["10", "20"],
  ])
  assert.equal(guess.certain, false)
  assert.equal(typeof guess.reason, "string")
  assert.ok(guess.reason.length > 0)
})

test("a repeated name in the first record leans header", () => {
  assert.equal(looksLikeHeader([["name", "name"], ["a", "b"]]).header, true)
})

test("no rows and an empty first row are answered rather than thrown on", () => {
  assert.equal(looksLikeHeader([]).header, false)
  assert.equal(looksLikeHeader([[]]).header, false)
  assert.equal(looksLikeHeader([["", ""]]).header, false)
})

test("every header guess is uncertain, including the confident-looking ones", () => {
  const samples = [
    [["id", "name"], ["1", "a"]],
    [["1", "2"], ["3", "4"]],
    [["Tokyo", "Osaka"], ["1", "2"]],
    [],
  ]
  for (const rows of samples) assert.equal(looksLikeHeader(rows).certain, false)
})

// ---------------------------------------------------------------- type checks

test("a blank cell is not the number zero", () => {
  // Number("") is 0 and Number(" ") is 0; reading either as a quantity invents a value.
  assert.equal(Number(""), 0)
  assert.equal(isPlainNumber(""), false)
  assert.equal(isPlainNumber("   "), false)
})

test("numbers no one typed into a spreadsheet are refused", () => {
  for (const text of ["1e3", "0x10", "0b101", "Infinity", "-Infinity", "NaN", "1_000", "1.2.3"]) {
    assert.equal(isPlainNumber(text), false, `${text} should not read as a number`)
  }
  for (const text of ["42", "-42", "+42", "0", ".5", "1.25", "  12  "]) {
    assert.equal(isPlainNumber(text), true, `${text} should read as a number`)
  }
})

test("a decimal comma is refused rather than guessed at", () => {
  // "1,50" is one and a half in a European export and one thousand and fifty elsewhere. Both
  // readings are wrong half the time, so neither is taken.
  assert.equal(isPlainNumber("1,50"), false)
  assert.equal(isPlainNumber("1,234"), false)
})

test("integers and numbers are different questions", () => {
  assert.equal(isPlainInteger("3"), true)
  assert.equal(isPlainInteger("3.0"), false)
  assert.equal(isPlainNumber("3.0"), true)
  assert.equal(isPlainInteger(""), false)
})

test("a bare number is not a date, though Date.parse says it is", () => {
  // Measured: Date.parse("42") is a day in 2041 and Date.parse("1699") is in 1699. A column of
  // quantities or short ids must not read as dates.
  assert.ok(!Number.isNaN(Date.parse("42")))
  assert.equal(isPlainDate("42"), false)
  assert.equal(isPlainDate("1699"), false)
  assert.equal(isPlainDate("20261108"), false)
})

test("a day that does not exist is not a date, though Date.parse rolls it forward", () => {
  assert.equal(new Date(Date.parse("2026-02-30")).getUTCMonth(), 2) // rolled into March
  assert.equal(isPlainDate("2026-02-30"), false)
  assert.equal(isPlainDate("2026-13-01"), false)
  assert.equal(isPlainDate("2026-00-10"), false)
  assert.equal(isPlainDate("2026-11-00"), false)
  // 2026 is not a leap year, so this one is a rolled-forward 1st of March to Date.parse and not a
  // day at all here. Checking the parts come back unchanged is what separates the two.
  assert.equal(new Date(Date.parse("2026-02-29")).getUTCDate(), 1)
  assert.equal(isPlainDate("2026-02-29"), false)
})

test("leap years are decided by the calendar, not by the pattern", () => {
  assert.equal(isPlainDate("2024-02-29"), true)
  assert.equal(isPlainDate("2023-02-29"), false)
})

test("ambiguous and locale-shaped dates are reported as text, not guessed", () => {
  for (const text of ["11/08/2026", "08/11/2026", "08.11.2026", "Nov 8 2026", "2026/11/08"]) {
    assert.equal(isPlainDate(text), false, `${text} should not read as a date`)
  }
  assert.equal(isPlainDate("2026-11-08"), true)
})

test("booleans cover the spellings an export actually carries", () => {
  for (const text of ["true", "TRUE", "yes", "Y", "1", "false", "no", "n", "0"]) {
    assert.equal(isPlainBoolean(text), true, `${text} should read as a boolean`)
  }
  assert.equal(isPlainBoolean("maybe"), false)
  assert.equal(isPlainBoolean(""), false)
})

test("text accepts anything, which is what makes it the default", () => {
  assert.equal(matchesKind("whatever", "text"), true)
  assert.equal(matchesKind("", "text"), true)
})

test("a column is checked per row, and the failing rows are named", () => {
  // The case the roadmap names: a thousand dates with three that are not.
  const values = Array.from({ length: 1000 }, (_, i) => (i === 10 || i === 500 || i === 999 ? "n/a" : "2026-01-01"))
  const check = checkColumn(values, "date", { limit: 10 })
  assert.equal(check.checked, 1000)
  assert.equal(check.problems.length, 3)
  assert.deepEqual(check.problems.map((p) => p.row), [10, 500, 999])
  assert.equal(check.problems[0].value, "n/a")
})

test("blank cells are counted apart from type failures", () => {
  const check = checkColumn(["1", "", "  ", "x"], "integer")
  assert.equal(check.empty, 2)
  assert.deepEqual(check.problems.map((p) => p.value), ["x"])
})

test("the problem list is capped without losing the count of what was checked", () => {
  const check = checkColumn(Array.from({ length: 100 }, () => "x"), "number", { limit: 3 })
  assert.equal(check.problems.length, 3)
  assert.equal(check.checked, 100)
})

// ---------------------------------------------------------------- matching and reporting

test("headers match fields across spelling and punctuation", () => {
  assert.equal(normalizeHeader("First Name"), "firstname")
  assert.equal(normalizeHeader("first_name"), "firstname")
  assert.equal(normalizeHeader("  FIRST-NAME  "), "firstname")
  assert.equal(normalizeHeader("メール"), "メール")
  assert.equal(normalizeHeader("---"), "")
})

test("an exact name beats a containing one, whatever order the fields are in", () => {
  // `name` must not swallow `company_name` just because it is declared first.
  const mapping = autoMatchFields(
    ["company_name", "name"],
    [
      { name: "name" },
      { name: "company_name" },
    ]
  )
  assert.equal(mapping.name, 1)
  assert.equal(mapping.company_name, 0)
})

test("a column is claimed once", () => {
  const mapping = autoMatchFields(["email"], [{ name: "email" }, { name: "email_address" }])
  assert.equal(mapping.email, 0)
  assert.equal(mapping.email_address, null)
})

test("labels and synonyms both match", () => {
  const mapping = autoMatchFields(
    ["E-Mail", "Full Name", "Seats"],
    [
      { name: "email", synonyms: ["e mail"] },
      { name: "full_name", label: "Full Name" },
      { name: "seats" },
    ]
  )
  assert.equal(mapping.email, 0)
  assert.equal(mapping.full_name, 1)
  assert.equal(mapping.seats, 2)
})

test("a field with no column is null rather than absent", () => {
  const mapping = autoMatchFields(["a"], [{ name: "zzz" }])
  assert.ok("zzz" in mapping)
  assert.equal(mapping.zzz, null)
})

test("the report names both the fields with no column and the columns with no field", () => {
  // Both sides at once is the point: a screen that shows one half is how an import loses a column.
  const mapping = { email: 0, full_name: null, signed_up: null, seats: null }
  const report = mappingReport(mapping, FIELDS, 4)
  assert.deepEqual(report.missingRequired, ["full_name"])
  assert.deepEqual(report.missingOptional, ["signed_up", "seats"])
  assert.deepEqual(report.ignoredColumns, [1, 2, 3])
  assert.equal(report.complete, false)
})

test("a complete mapping still reports the columns left out", () => {
  const report = mappingReport({ email: 0, full_name: 1, signed_up: null, seats: null }, FIELDS, 3)
  assert.equal(report.complete, true)
  assert.deepEqual(report.missingRequired, [])
  assert.deepEqual(report.ignoredColumns, [2])
})

test("one column feeding two fields is reported and not undone", () => {
  const report = mappingReport({ email: 0, full_name: 0, signed_up: null, seats: null }, FIELDS, 1)
  assert.deepEqual(report.reusedColumns, [{ column: 0, fields: ["email", "full_name"] }])
  assert.equal(report.complete, true)
})

test("a column index past the end of the file counts as unmapped", () => {
  // A file reread with a different separator has fewer columns; a stale index must not pass.
  const report = mappingReport({ email: 9, full_name: 1, signed_up: null, seats: null }, FIELDS, 2)
  assert.deepEqual(report.missingRequired, ["email"])
  assert.equal(report.complete, false)
})

test("applyMapping writes every key, including for a short row", () => {
  const rows = [
    ["a@b.c", "Ada", "2026-01-01", "3"],
    ["d@e.f"],
  ]
  const mapping = { email: 0, full_name: 1, signed_up: 2, seats: 3 }
  const out = applyMapping(rows, mapping, FIELDS)
  assert.deepEqual(out[0], { email: "a@b.c", full_name: "Ada", signed_up: "2026-01-01", seats: "3" })
  assert.deepEqual(out[1], { email: "d@e.f", full_name: "", signed_up: "", seats: "" })
})

test("applyMapping leaves values as strings rather than converting them", () => {
  const out = applyMapping([["1,50", "08/11/2026"]], { a: 0, b: 1 }, [{ name: "a" }, { name: "b" }])
  assert.equal(out[0].a, "1,50")
  assert.equal(out[0].b, "08/11/2026")
})

// ---------------------------------------------------------------- the component

const CSV = "Email,Full Name,Signed Up,Seats\na@b.c,Ada,2026-01-01,3\nd@e.f,Grace,2026-02-02,5\n"

function parts(instance) {
  const nodes = walk(instance.tree)
  const selects = byTag(nodes, "select")
  return {
    group: byRole(nodes, "group")[0],
    delimiter: selects[0],
    fieldSelects: selects.slice(1),
    checkbox: byTag(nodes, "input").find((n) => n.props.type === "checkbox"),
    headerCells: byTag(nodes, "th").map((n) => n.props.children),
    bodyRows: byTag(nodes, "tr").length,
    cells: byTag(nodes, "td").map((n) => n.props.children),
    labels: byTag(nodes, "label"),
    paragraphs: byTag(nodes, "p").map((n) => n.props.children),
    button: byTag(nodes, "button")[0],
    caption: byTag(nodes, "caption")[0],
    nodes,
  }
}

const text = (node) =>
  typeof node === "string"
    ? node
    : Array.isArray(node)
      ? node.map(text).join("")
      : node && typeof node === "object" && "props" in node
        ? text(node.props?.children)
        : ""

function say(instance) {
  return parts(instance).paragraphs.map(text).join(" | ")
}

test("the header row becomes the column names and is not shown as data", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  const p = parts(instance)
  assert.deepEqual(p.headerCells, ["Email", "Full Name", "Signed Up", "Seats"])
  assert.ok(!p.cells.includes("Full Name"))
  assert.ok(p.cells.includes("Ada"))
})

test("turning the header toggle off moves the names into the data", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  parts(instance).checkbox.props.onChange({ target: { checked: false } })
  instance.rerender()
  const p = parts(instance)
  assert.deepEqual(p.headerCells, ["Column 1", "Column 2", "Column 3", "Column 4"])
  assert.ok(p.cells.includes("Email"))
})

test("fields are matched to columns on first render", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  assert.deepEqual(
    parts(instance).fieldSelects.map((n) => n.props.value),
    ["0", "1", "2", "3"]
  )
})

test("a required field with no column is announced and marked invalid", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Other\na@b.c,x\nd@e.f,y\n",
    fields: FIELDS,
  })
  const p = parts(instance)
  assert.equal(p.fieldSelects[1].props["aria-invalid"], true)
  assert.match(say(instance), /Full name/)
})

test("columns nobody reads are listed, with their names", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Full Name,Legacy Id\na@b.c,Ada,7\nd@e.f,Grace,8\n",
    fields: [FIELDS[0], FIELDS[1]],
  })
  assert.match(say(instance), /Not imported: Legacy Id/)
})

test("choosing a column updates the selection and the report together", () => {
  const seen = []
  const instance = render(CsvColumnMapper, {
    text: "Email,Other\na@b.c,x\nd@e.f,y\n",
    fields: FIELDS,
    onValueChange: (mapping, report) => seen.push({ mapping, report }),
  })
  parts(instance).fieldSelects[1].props.onChange({ target: { value: "1" } })
  instance.rerender()
  assert.equal(parts(instance).fieldSelects[1].props.value, "1")
  assert.equal(seen.at(-1).mapping.full_name, 1)
  assert.deepEqual(seen.at(-1).report.missingRequired, [])
})

test("choosing the ignore option unmaps the field", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  parts(instance).fieldSelects[3].props.onChange({ target: { value: "" } })
  instance.rerender()
  assert.equal(parts(instance).fieldSelects[3].props.value, "")
  assert.match(say(instance), /Not imported: Seats/)
})

test("a choice survives a change of separator rather than being overwritten by the suggestion", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Other\na@b.c,x\nd@e.f,y\n",
    fields: FIELDS,
  })
  parts(instance).fieldSelects[1].props.onChange({ target: { value: "1" } })
  instance.rerender()
  parts(instance).delimiter.props.onChange({ target: { value: ";" } })
  instance.rerender()
  assert.equal(parts(instance).fieldSelects[1].props.value, "1")
})

test("two columns of the same name are told apart in the chooser", () => {
  // A merged export with two `Email` columns gives two options the reader cannot choose between.
  const instance = render(CsvColumnMapper, {
    text: "Email,Email,Full Name\na@b.c,alt@b.c,Ada\nd@e.f,alt@e.f,Grace\n",
    fields: [FIELDS[0], FIELDS[1]],
  })
  const options = parts(instance)
    .fieldSelects[0].props.children.flat()
    .map((n) => text(n))
  assert.ok(options.includes("Email (column 1)"), options.join(" / "))
  assert.ok(options.includes("Email (column 2)"), options.join(" / "))
  // The written name is what matching sees, so the first Email still matches the email field.
  assert.equal(parts(instance).fieldSelects[0].props.value, "0")
})

test("a unique name is not given a disambiguating suffix", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  const options = parts(instance)
    .fieldSelects[0].props.children.flat()
    .map((n) => text(n))
  assert.ok(options.includes("Email"))
  assert.ok(!options.some((label) => label.includes("(column")))
})

test("an untouched field follows a new suggestion when the columns change under it", () => {
  // The reason only chosen fields are held: freezing the whole mapping at the first edit would
  // leave untouched fields pointing at the columns the old separator produced.
  //
  // This text is rectangular read either way — three columns with a comma, two with a semicolon —
  // so the guess lands on the comma and switching it rebuilds every header name.
  const two = [
    { name: "email", label: "Email", required: true },
    { name: "seats", label: "Seats", kind: "integer" },
  ]
  const instance = render(CsvColumnMapper, {
    text: "X,Email;Seats,Y\n1,a@b.c;3,2\n4,d@e.f;5,6\n",
    fields: two,
  })
  assert.equal(parts(instance).delimiter.props.value, ",")
  assert.equal(parts(instance).fieldSelects[0].props.value, "1") // email, suggested
  assert.equal(parts(instance).fieldSelects[1].props.value, "") // seats, nothing matched

  // The reader maps seats by hand, then corrects the separator.
  parts(instance).fieldSelects[1].props.onChange({ target: { value: "0" } })
  instance.rerender()
  parts(instance).delimiter.props.onChange({ target: { value: ";" } })
  instance.rerender()

  const after = parts(instance)
  assert.equal(after.delimiter.props.value, ";")
  assert.equal(after.fieldSelects[1].props.value, "0", "a chosen field keeps the reader's choice")
  assert.equal(
    after.fieldSelects[0].props.value,
    "0",
    "an untouched field follows the suggestion for the new columns instead of staying at 1"
  )
})

test("a wrong separator is called out rather than shown as one column", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email;Full Name\na@b.c;Ada\nd@e.f;Grace\n",
    fields: FIELDS,
    delimiter: ",",
  })
  assert.match(say(instance), /single column/)
})

test("the separator is guessed when it is not given", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email;Full Name\na@b.c;Ada\nd@e.f;Grace\n",
    fields: FIELDS,
  })
  assert.equal(parts(instance).delimiter.props.value, ";")
  assert.deepEqual(parts(instance).headerCells, ["Email", "Full Name"])
})

test("a given separator locks the chooser instead of letting it drift from the data", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS, delimiter: "," })
  assert.equal(parts(instance).delimiter.props.disabled, true)
})

test("rows that do not read as the field's type are named by row number", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Full Name,Signed Up,Seats\na@b.c,Ada,2026-01-01,3\nd@e.f,Grace,not-a-date,5\n",
    fields: FIELDS,
  })
  assert.match(say(instance), /Signed up expects a date: 1 of the 2 rows shown/)
  assert.match(say(instance), /row 2/)
})

test("a blank cell in a typed column is reported as blank, not as a type failure", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Full Name,Signed Up,Seats\na@b.c,Ada,2026-01-01,\nd@e.f,Grace,2026-02-02,5\n",
    fields: FIELDS,
  })
  assert.match(say(instance), /Seats is blank in 1 of the 2 rows shown/)
  assert.ok(!/Seats expects/.test(say(instance)))
})

test("the checks say they only cover what was read", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `a${i}@b.c,Name ${i},2026-01-01,1`).join("\n")
  const instance = render(CsvColumnMapper, {
    text: `Email,Full Name,Signed Up,Seats\n${rows}\n`,
    fields: FIELDS,
    previewRecords: 5,
  })
  assert.match(say(instance), /Checks cover the 5 records read so far, not the whole file/)
  assert.equal(parts(instance).cells.length, 5 * 4)
})

test("confirm is blocked while a required field is unmapped and fires with the mapping once it is not", () => {
  const got = []
  const instance = render(CsvColumnMapper, {
    text: "Email,Other\na@b.c,x\nd@e.f,y\n",
    fields: FIELDS,
    onConfirm: (result) => got.push(result),
  })
  assert.equal(parts(instance).button.props.disabled, true)
  parts(instance).fieldSelects[1].props.onChange({ target: { value: "1" } })
  instance.rerender()
  assert.equal(parts(instance).button.props.disabled, false)
  parts(instance).button.props.onClick()
  assert.equal(got.length, 1)
  assert.equal(got[0].mapping.full_name, 1)
  assert.equal(got[0].delimiter, ",")
  assert.equal(got[0].hasHeader, true)
  assert.deepEqual(got[0].headers, ["Email", "Other"])
})

test("no confirm handler means no button, rather than a dead one", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  assert.equal(parts(instance).button, undefined)
})

test("an empty text says so and renders no table", () => {
  const instance = render(CsvColumnMapper, { text: "", fields: FIELDS })
  assert.match(say(instance), /Nothing to map yet/)
  assert.equal(byTag(walk(instance.tree), "table").length, 0)
})

test("a controlled mapping is not overridden by the component's own suggestion", () => {
  const instance = render(CsvColumnMapper, {
    text: CSV,
    fields: FIELDS,
    value: { email: 1, full_name: 0, signed_up: null, seats: null },
  })
  assert.deepEqual(
    parts(instance).fieldSelects.map((n) => n.props.value),
    ["1", "0", "", ""]
  )
})

test("every control is labelled and the group is named", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS, onConfirm: () => {} })
  const p = parts(instance)
  assert.equal(p.group.props["aria-label"], "Match columns to fields")
  assert.ok(p.delimiter.props.children.length > 0)
  for (const select of p.fieldSelects) assert.equal(typeof select.props.id, "string")
  const ids = p.labels.map((n) => n.props.htmlFor).filter(Boolean)
  for (const select of p.fieldSelects) assert.ok(ids.includes(select.props.id), `${select.props.id} has no label`)
})

test("the table carries a caption and column scopes for a screen reader", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  const p = parts(instance)
  assert.match(text(p.caption), /2 records/)
  assert.ok(byTag(p.nodes, "th").every((n) => n.props.scope === "col"))
})

test("a required field is marked for a screen reader and not only with an asterisk", () => {
  const instance = render(CsvColumnMapper, { text: CSV, fields: FIELDS })
  const srOnly = walk(instance.tree).filter(
    (n) => typeof n.props?.className === "string" && n.props.className.includes("sr-only")
  )
  assert.ok(srOnly.some((n) => text(n).includes("required")))
})

test("the live region is present before it has anything to say", () => {
  // A live region inserted at the same moment as its text is not announced, so it ships empty.
  const instance = render(CsvColumnMapper, {
    text: "Email,Full Name\na@b.c,Ada\nd@e.f,Grace\n",
    fields: [FIELDS[0], FIELDS[1]],
  })
  const live = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(live.length, 1)
})

test("the live region exists, and is empty, while there is no file yet", () => {
  // The asynchronous case: nothing on screen until the bytes land. If the region lived inside the
  // branch that renders the table, it would arrive in the same commit as its first message.
  //
  // Empty, too: every required field is unmapped before a file exists, and announcing that is a
  // complaint about a decision the reader has not been given the chance to make.
  const instance = render(CsvColumnMapper, { text: "", fields: FIELDS })
  const live = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(live.length, 1)
  assert.match(String(live[0].props.className), /sr-only/)
  assert.equal(byTag(walk(instance.tree), "p").length, 1) // only "Nothing to map yet"
  assert.match(say(instance), /Nothing to map yet/)
  assert.ok(!/required/.test(say(instance)))
})

test("the live region is the same element before and after it has something to say", () => {
  // Same element, same position in the tree — so it is a change to a region already being watched
  // rather than a new region nobody is watching.
  const instance = render(CsvColumnMapper, {
    text: "Email,Other\na@b.c,x\nd@e.f,y\n",
    fields: FIELDS,
  })
  const before = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(before.length, 1)
  assert.ok(!String(before[0].props.className).includes("sr-only"), "should be saying something")
  // Complete the mapping; the region keeps its place and empties.
  parts(instance).fieldSelects[1].props.onChange({ target: { value: "1" } })
  instance.rerender()
  const after = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(after.length, 1)
  assert.equal(after[0].props.id, before[0].props.id)
})

test("an unterminated quote is reported to the reader", () => {
  const instance = render(CsvColumnMapper, {
    text: 'Email,Full Name\na@b.c,"Ada\nd@e.f,Grace\n',
    fields: [FIELDS[0], FIELDS[1]],
  })
  assert.match(say(instance), /quoted cell is never closed/)
})

test("a ragged file still renders every column it found", () => {
  const instance = render(CsvColumnMapper, {
    text: "Email,Full Name\na@b.c,Ada,extra\nd@e.f\n",
    fields: [FIELDS[0], FIELDS[1]],
  })
  assert.equal(parts(instance).headerCells.length, 3)
  assert.equal(parts(instance).cells.length, 6)
})

test("messages can be replaced without replacing the component", () => {
  const instance = render(CsvColumnMapper, {
    text: CSV,
    fields: FIELDS,
    messages: { headerLabel: "1行目は見出し", ignore: "— 取り込まない —" },
  })
  const nodes = walk(instance.tree)
  assert.ok(nodes.some((n) => text(n).includes("1行目は見出し")))
  assert.ok(byTag(nodes, "option").some((n) => text(n) === "— 取り込まない —"))
})

test("disabled turns off every control", () => {
  const instance = render(CsvColumnMapper, {
    text: CSV,
    fields: FIELDS,
    disabled: true,
    onConfirm: () => {},
  })
  const p = parts(instance)
  assert.equal(p.delimiter.props.disabled, true)
  assert.equal(p.checkbox.props.disabled, true)
  assert.equal(p.button.props.disabled, true)
  for (const select of p.fieldSelects) assert.equal(select.props.disabled, true)
})
