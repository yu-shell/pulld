// A box for an IP address looks finished in one line: `/^(\d{1,3}\.){3}\d{1,3}$/`, or
// `net.isIP`. The cases below are written to fail against that and against the implementations it
// grows into:
//
//   - a netmask built with `0xFFFFFFFF << (32 - prefix)`, which gives /0 a /32 mask because
//     JavaScript takes shift counts modulo 32 — "the whole internet" read as "one host",
//   - `2 ** (bits - prefix) - 2` for the usable count, which says a /31 has 0 and a /32 has -1,
//     and which is wrong about IPv6 at every prefix because IPv6 has no broadcast address,
//   - that count held in a `number`, where a /64 and a /64 minus one address are the same figure,
//   - duplicate detection by string, which misses four different spellings of one address,
//   - `010.0.0.1` accepted and stored as written, when every browser resolves it to 8.0.0.1,
//   - `127.1` refused as malformed, when every browser and curl resolve it to 127.0.0.1,
//   - `192.168.1.5/24` quietly rounded down, widening a rule from one host to 256,
//   - `::` used for a single zero group, or the rightmost of two equal runs, neither of which is
//     the canonical form RFC 5952 defines,
//   - and an empty box read as 0.0.0.0, which with a /0 is every host on the internet.
import { test } from "node:test"
import assert from "node:assert/strict"
import net from "node:net"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag, byRole } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  BITS,
  MAPPED_PREFIX_BITS,
  bytesToBigInt,
  bigIntToBytes,
  sameAddress,
  maskBytes,
  networkBytes,
  lastAddressBytes,
  hostBitsSet,
  addressCount,
  usableCount,
  formatAddress,
  formatCidr,
  parseLegacyIpv4,
  parseIpText,
  describePrefix,
  IpInput,
} = loadComponent(join(ROOT, "registry/ui/ip-input.tsx"))

const parse = (text, options) => parseIpText(text, options)
const addressOf = (text) => parse(text).address

// --- the empty box ------------------------------------------------------------------------------

test("an empty box and an unreadable box are different answers", () => {
  // 0.0.0.0/0 is every host on the internet, so a box that reads blank as zero is the one mistake
  // here with no ceiling on its cost.
  for (const text of ["", "   ", "\t"]) {
    const r = parse(text)
    assert.equal(r.address, null)
    assert.equal(r.issue, null, `${JSON.stringify(text)} is empty, not wrong`)
    assert.equal(r.canonical, "")
  }
  const junk = parse("not an address")
  assert.equal(junk.address, null)
  assert.equal(junk.issue.code, "not-an-address")
  assert.equal(junk.issue.level, "error")
})

// --- the leading zero ---------------------------------------------------------------------------

test("a leading-zero octet is refused, because the two readings are different hosts", () => {
  // Measured against the WHATWG URL parser, which is what every browser and curl implement:
  // new URL("http://010.0.0.1").hostname is "8.0.0.1", not "10.0.0.1".
  assert.equal(new URL("http://010.0.0.1").hostname, "8.0.0.1")
  const r = parse("010.0.0.1")
  assert.equal(r.address, null)
  assert.equal(r.issue.code, "leading-zero")
  assert.equal(r.issue.level, "error")
  // Both readings have to be named, or the message is just a refusal.
  assert.match(r.issue.message, /8\.0\.0\.1/)
  assert.match(r.issue.message, /10\.0\.0\.1/)
  // And the decimal reading is offered, since that is the one the reader almost certainly meant.
  assert.equal(r.suggestion, "10.0.0.1")
})

test("0177.0.0.1 is 127.0.0.1 to a browser and 177.0.0.1 to a zero-stripper", () => {
  assert.equal(new URL("http://0177.0.0.1").hostname, "127.0.0.1")
  const r = parse("0177.0.0.1")
  assert.equal(r.issue.code, "leading-zero")
  assert.match(r.issue.message, /127\.0\.0\.1/)
  assert.match(r.issue.message, /177\.0\.0\.1/)
})

test("a leading zero with an 8 or a 9 in it is refused by browsers outright", () => {
  // Measured: new URL("http://09.0.0.1") throws, because 09 strips to 9 and 9 is not an octal
  // digit. So this one has a single plausible reading and still is not a usable address.
  assert.throws(() => new URL("http://09.0.0.1"))
  const r = parse("09.0.0.1")
  assert.equal(r.issue.code, "leading-zero")
  assert.match(r.issue.message, /octal/)
  assert.equal(r.suggestion, "9.0.0.1")
})

test("a bare zero octet is not a leading zero", () => {
  assert.equal(parse("0.0.0.0").canonical, "0.0.0.0")
  assert.equal(parse("10.0.0.0").canonical, "10.0.0.0")
  // And the leading-zero rule is not allowed to fire on text that merely failed for another
  // reason: each of these has a part starting with "0", or a part longer than one digit, and the
  // fault in all three is the 256 or the letter. A verdict naming octal here would send the reader
  // to fix something that is not wrong.
  for (const text of ["0.0.0.256", "10.0.0.256", "01.2.3.x"]) {
    assert.equal(parse(text).issue.code, "not-an-address", text)
  }
})

test("255 is a legal octet in every position, and 256 is not in any", () => {
  // `> 255` and `>= 255` are one keystroke apart and the second one rejects a quarter of the
  // addresses in use. Measured against the browser in both directions.
  assert.equal(new URL("http://255.255.255.255").hostname, "255.255.255.255")
  assert.equal(parse("255.255.255.255").canonical, "255.255.255.255")
  assert.equal(new URL("http://255.1").hostname, "255.0.0.1")
  assert.deepEqual(parseLegacyIpv4("255.1"), [255, 0, 0, 1])
  assert.throws(() => new URL("http://256.1"))
  assert.equal(parseLegacyIpv4("256.1"), null, "a leading part over 255 is not an octet")
  assert.equal(parse("256.1.1.1").issue.code, "not-an-address")
})

// --- the legacy forms ---------------------------------------------------------------------------

test("the legacy IPv4 forms expand exactly as the browser expands them", () => {
  // Every expectation here was read off new URL() rather than remembered.
  const cases = [
    ["127.1", "127.0.0.1"],
    ["10.1", "10.0.0.1"],
    ["127.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["0x7f.1", "127.0.0.1"],
    ["0x7f000001", "127.0.0.1"],
    ["192.168.257", "192.168.1.1"],
    ["192.168.1", "192.168.0.1"],
    ["192.168.65535", "192.168.255.255"],
    ["10.16777215", "10.255.255.255"],
  ]
  for (const [text, expected] of cases) {
    assert.equal(new URL(`http://${text}`).hostname, expected, `browser: ${text}`)
    assert.deepEqual(parseLegacyIpv4(text), expected.split(".").map(Number), `component: ${text}`)
  }
})

test("the legacy forms the browser refuses are refused here too", () => {
  for (const text of ["192.168.65536", "10.16777216", "1.2.3.256", "1.1.1.1.1", "99999999999"]) {
    assert.throws(() => new URL(`http://${text}`), undefined, `browser should refuse ${text}`)
    assert.equal(parseLegacyIpv4(text), null, `component should refuse ${text}`)
  }
})

test("a legacy form is reported with its expansion rather than taken or refused", () => {
  // The whole point: two validators in one runtime disagree about this string, so the field is not
  // entitled to pick. Measured — the browser reads it, net.isIPv4 does not.
  assert.equal(new URL("http://127.1").hostname, "127.0.0.1")
  assert.equal(net.isIPv4("127.1"), false)
  const r = parse("127.1")
  assert.equal(r.address, null, "nothing is posted from an ambiguous spelling")
  assert.equal(r.issue.code, "legacy-form")
  assert.equal(r.suggestion, "127.0.0.1", "the expansion is offered for a control to apply")
  // The message has to name both answers and where they come from, or it reads as a bare refusal
  // of text the reader just watched a browser accept.
  assert.match(r.issue.message, /Browsers and curl read "127\.1" as 127\.0\.0\.1/)
  assert.match(r.issue.message, /net\.isIPv4 calls it invalid/)
  // Applying the suggestion has to produce something the field stands behind.
  const applied = parse(r.suggestion)
  assert.equal(applied.issue, null)
  assert.equal(applied.canonical, "127.0.0.1")
})

// --- IPv6 parsing and RFC 5952 ------------------------------------------------------------------

test("the spellings this registry's own duplicate check would miss are one address", () => {
  // Each pair is two valid spellings of one address, and === says they differ. Measured through
  // net.isIPv6 so the premise is not taken on trust.
  const pairs = [
    ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001"],
    ["::1", "0:0:0:0:0:0:0:1"],
    ["2001:DB8::1", "2001:db8::1"],
    ["::ffff:192.0.2.1", "::ffff:c000:0201"],
  ]
  for (const [a, b] of pairs) {
    assert.ok(net.isIPv6(a) && net.isIPv6(b), `${a} / ${b} should both be IPv6`)
    assert.notEqual(a, b, "the strings differ — that is the problem being solved")
    assert.ok(sameAddress(addressOf(a), addressOf(b)), `${a} and ${b} are one address`)
    assert.equal(parse(a).canonical, parse(b).canonical, `${a} and ${b} canonicalise together`)
  }
})

test("the canonical form collapses the longest run of zeros, leftmost on a tie", () => {
  const cases = [
    // One run of three beats one run of two, wherever it sits.
    ["2001:0:0:1:0:0:0:1", "2001:0:0:1::1"],
    // Two runs of two: the leftmost wins (RFC 5952 4.2.3).
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["0:0:0:0:0:0:0:0", "::"],
    ["1:0:0:0:0:0:0:0", "1::"],
    ["0:0:0:0:0:0:0:1", "::1"],
    ["2001:db8:0:0:0:0:2:1", "2001:db8::2:1"],
    // Leading zeros inside a group go, and hex is lowercase.
    ["2001:0DB8::0001", "2001:db8::1"],
  ]
  for (const [text, expected] of cases) {
    assert.ok(net.isIPv6(text), `${text} should be a valid IPv6 address`)
    assert.equal(parse(text).canonical, expected)
  }
})

test("a single zero group is never shortened to :: (RFC 5952 4.2.2)", () => {
  // 2001:db8:0:1:1:1:1:1 has exactly one zero group. The shortened spelling is legal input and is
  // not the canonical output, which is the distinction a naive "replace the first run" gets wrong.
  assert.ok(net.isIPv6("2001:db8::1:1:1:1:1"))
  assert.equal(parse("2001:db8::1:1:1:1:1").canonical, "2001:db8:0:1:1:1:1:1")
  assert.equal(parse("2001:db8:0:1:1:1:1:1").canonical, "2001:db8:0:1:1:1:1:1")
})

test("the IPv6 spellings that are not addresses are refused, each saying why", () => {
  const cases = [
    ["1::1::1", /may only appear once/],
    // Three colons is one `::` beside an empty group, not a second `::`, so it fails on the group
    // and the message says so rather than describing a rule the text did not break.
    ["2001:db8:::1", /not an IPv6 address/],
    ["2001:db8:0:0:0:0:0:0:1", /8 groups; this has 9/],
    ["2001:db8", /8 groups; this has 2/],
    ["::ffff:1.2.3", /not an IPv6 address/],
    ["2001:db8::fffff", /not an IPv6 address/],
    ["1:2:3:4:5:6:7::8", /at least one group of zeros/],
  ]
  for (const [text, message] of cases) {
    assert.equal(net.isIPv6(text), false, `net.isIPv6 should refuse ${text}`)
    const r = parse(text)
    assert.equal(r.address, null, `component should refuse ${text}`)
    assert.equal(r.issue.code, "not-an-address")
    assert.match(r.issue.message, message, `${text} should say why`)
  }
})

test("an embedded IPv4 address only reads at the end of the address", () => {
  // Measured: net.isIPv6("1.2.3.4::1") is false. The quad is two groups wherever it sits, so an
  // implementation that counts groups and stops there accepts this and invents an address —
  // 0102:0304:: with a 1 on the end — out of text nothing else in the stack will resolve.
  assert.equal(net.isIPv6("1.2.3.4::1"), false)
  const r = parse("1.2.3.4::1")
  assert.equal(r.address, null)
  assert.equal(r.issue.code, "not-an-address")
  assert.match(r.issue.message, /belongs at the end/)
  assert.equal(parse("::ffff:1.2.3.4").canonical, "::ffff:1.2.3.4")
  assert.equal(parse("64:ff9b::192.0.2.33").canonical, "64:ff9b::c000:221")
})

test("an address that only looks mapped is not treated as one", () => {
  // The mapped test is ten zero bytes then ffff, and all three parts of it carry weight: dropping
  // any one of them renames a different address ::ffff:a.b.c.d, which is a readable, plausible and
  // wrong answer. Each of these is a valid IPv6 address (measured) that is not mapped.
  for (const text of ["::fffe:192.0.2.1", "1::ffff:c000:201", "100::ffff:c000:201"]) {
    assert.equal(net.isIPv6(text), true, `${text} should be valid IPv6`)
    const r = parse(text)
    assert.equal(r.address.mapped, false, `${text} is not an IPv4-mapped address`)
    assert.ok(!r.canonical.includes("."), `${text} should not print a dotted quad: ${r.canonical}`)
    assert.deepEqual(r.notes, [], "and nothing should claim it denotes an IPv4 host")
  }
  assert.equal(parse("::fffe:192.0.2.1").canonical, "::fffe:c000:201")
  assert.equal(parse("1::ffff:c000:201").canonical, "1::ffff:c000:201")
})

test("a mapped address is written with its dotted quad, where the browser writes hex", () => {
  // Measured: the WHATWG serialiser has no RFC 5952 §5 special case.
  assert.equal(new URL("http://[::ffff:192.0.2.1]").hostname, "[::ffff:c000:201]")
  const r = parse("::ffff:192.0.2.1")
  assert.equal(r.canonical, "::ffff:192.0.2.1")
  assert.equal(r.address.family, 6, "it is sixteen bytes, so it is IPv6")
  assert.equal(r.address.mapped, true)
  // And it says what it denotes, since that is the fact the reader needs. Asserted as the whole
  // sentence: a substring check passes just as happily on all sixteen bytes joined with dots.
  assert.deepEqual(r.notes, [
    "An IPv4-mapped address: sixteen bytes that denote the IPv4 host 192.0.2.1.",
  ])
})

// --- the zone -----------------------------------------------------------------------------------

test("a zone is kept, and two zones on the same bytes are two destinations", () => {
  // Measured: net.isIPv6 takes a zone, and new URL refuses the same text outright — a legal
  // address that cannot be a URL host.
  assert.equal(net.isIPv6("fe80::1%eth0"), true)
  assert.throws(() => new URL("http://[fe80::1%eth0]"))
  const r = parse("fe80::1%eth0")
  assert.equal(r.address.zone, "eth0")
  assert.equal(r.canonical, "fe80::1%eth0")
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], /^Scoped to the link "eth0", which is part of the destination/)
  assert.match(r.notes[0], /cannot be a URL host\.$/)
  assert.equal(sameAddress(addressOf("fe80::1%eth0"), addressOf("fe80::1%eth1")), false)
  assert.equal(sameAddress(addressOf("fe80::1%eth0"), addressOf("fe80::1")), false)
  // Measured: %0 is a zone and a bare % is not.
  assert.equal(net.isIPv6("fe80::1%0"), true)
  assert.equal(net.isIPv6("fe80::1%"), false)
  assert.equal(parse("fe80::1%0").address.zone, "0")
  const bare = parse("fe80::1%")
  assert.equal(bare.address, null)
  assert.equal(bare.issue.code, "not-an-address")
  assert.match(bare.issue.message, /needs the name of the link/)
})

// --- the mask -----------------------------------------------------------------------------------

test("the /0 mask is zero, which the one-line shift version gets wrong", () => {
  // The measurement this component is built around: JavaScript takes the shift count modulo 32.
  assert.equal((0xffffffff << 32) >>> 0, 4294967295)
  assert.deepEqual(maskBytes(4, 0), [0, 0, 0, 0])
  assert.deepEqual(maskBytes(6, 0), new Array(16).fill(0))
  // So 0.0.0.0/0 is the whole internet and not one host.
  assert.deepEqual(networkBytes([203, 0, 113, 9], 4, 0), [0, 0, 0, 0])
  assert.equal(addressCount(4, 0), 4294967296n)
})

test("the mask is right at every byte boundary and inside one", () => {
  assert.deepEqual(maskBytes(4, 8), [255, 0, 0, 0])
  assert.deepEqual(maskBytes(4, 24), [255, 255, 255, 0])
  assert.deepEqual(maskBytes(4, 32), [255, 255, 255, 255])
  assert.deepEqual(maskBytes(4, 26), [255, 255, 255, 192])
  assert.deepEqual(maskBytes(4, 31), [255, 255, 255, 254])
  assert.deepEqual(maskBytes(6, 64), [...new Array(8).fill(255), ...new Array(8).fill(0)])
  assert.deepEqual(maskBytes(6, 127).slice(14), [255, 254])
})

test("the network and the last address of a block", () => {
  assert.deepEqual(networkBytes([192, 168, 1, 5], 4, 24), [192, 168, 1, 0])
  assert.deepEqual(lastAddressBytes([192, 168, 1, 5], 4, 24), [192, 168, 1, 255])
  assert.deepEqual(networkBytes([172, 16, 5, 130], 4, 26), [172, 16, 5, 128])
  assert.deepEqual(lastAddressBytes([172, 16, 5, 130], 4, 26), [172, 16, 5, 191])
})

// --- the counts ---------------------------------------------------------------------------------

test("the usable count does not go to zero at /31 or negative at /32", () => {
  // What the familiar formula produces, measured.
  assert.equal(2 ** (32 - 31) - 2, 0)
  assert.equal(2 ** (32 - 32) - 2, -1)
  // What is true: RFC 3021 makes a /31 a two-address point-to-point link.
  assert.equal(usableCount(4, 31), 2n)
  assert.equal(usableCount(4, 32), 1n)
  assert.equal(usableCount(4, 30), 2n)
  assert.equal(usableCount(4, 24), 254n)
  assert.equal(usableCount(4, 16), 65534n)
})

test("IPv6 does not lose two addresses, because it has no broadcast address", () => {
  // One formula for both families is wrong about one of them at every prefix.
  assert.equal(addressCount(6, 64), 18446744073709551616n)
  assert.equal(usableCount(6, 64), 18446744073709551615n)
  assert.equal(usableCount(6, 127), 2n, "RFC 6164 inter-router link")
  assert.equal(usableCount(6, 128), 1n)
  assert.notEqual(usableCount(6, 64), addressCount(6, 64) - 2n)
})

test("the counts have to be bigint, because float64 cannot hold a /64", () => {
  // Measured: 2 ** 64 is not the number it prints, and a /64 minus one address is the same value.
  assert.equal(2 ** 64 - 1 === 2 ** 64, true)
  assert.equal(Number.isSafeInteger(2 ** 64), false)
  assert.equal(addressCount(6, 64).toString(), "18446744073709551616")
  assert.notEqual(Number(addressCount(6, 64)).toString(), "18446744073709551616")
  assert.equal(addressCount(6, 0), 1n << 128n)
  // And Intl formats a bigint exactly, so nothing has to be narrowed to be displayed.
  assert.equal((1n << 128n).toLocaleString("en-US").split(",").length, 13)
})

test("one prefix digit is 256 times the hosts, and the sentence says the figure", () => {
  const twentyFour = describePrefix(4, 24)
  const sixteen = describePrefix(4, 16)
  assert.match(twentyFour, /256 addresses/)
  assert.match(twentyFour, /254 usable/)
  assert.match(sixteen, /65,536 addresses/)
  assert.match(sixteen, /65,534 usable/)
  assert.equal(addressCount(4, 16) / addressCount(4, 24), 256n)
  assert.match(describePrefix(4, 31), /RFC 3021/)
  assert.match(describePrefix(6, 64), /no broadcast address/)
  assert.match(describePrefix(6, 127), /RFC 6164/)
  // /126 is an ordinary subnet, so it is the anycast sentence rather than the link one.
  assert.match(describePrefix(6, 126), /Subnet-Router anycast/)
  assert.equal(describePrefix(4, 32), "/32 is the single address.")
  assert.equal(describePrefix(6, 128), "/128 is the single address.")
})

test("the prefix sentence is a note, and a bare address does not get one", () => {
  // A /prefix note on an address with no prefix would be describing a block the reader did not
  // write. Measured as the whole notes list, since the sentence is only wrong by being present.
  assert.deepEqual(parse("10.0.0.1").notes, [])
  assert.deepEqual(parse("2001:db8::1").notes, [])
  assert.deepEqual(parse("10.0.0.0/8").notes, [describePrefix(4, 8)])
  assert.deepEqual(parse("2001:db8::/32").notes, [describePrefix(6, 32)])
})

// --- prefixes -----------------------------------------------------------------------------------

test("the prefix limit is per family, and /128 on an IPv4 address says so", () => {
  assert.equal(BITS[4], 32)
  assert.equal(BITS[6], 128)
  assert.equal(parse("10.0.0.0/8").prefix, 8)
  assert.equal(parse("2001:db8::/32").prefix, 32)
  assert.equal(parse("2001:db8::/128").canonical, "2001:db8::/128")
  const over = parse("10.0.0.0/33")
  assert.equal(over.issue.code, "prefix-range")
  assert.match(over.issue.message, /\/0 to \/32/)
  const confused = parse("10.0.0.0/128")
  assert.equal(confused.issue.code, "prefix-range")
  assert.match(confused.issue.message, /IPv6/)
  assert.equal(parse("2001:db8::/129").issue.code, "prefix-range")
  assert.equal(parse("10.0.0.0/").issue.code, "bad-prefix")
  assert.equal(parse("10.0.0.0/x").issue.code, "bad-prefix")
  // A prefix with nothing in front of it says that, rather than reporting the whole string as a
  // malformed address — which is what a `/` search that skips index 0 produces.
  assert.match(parse("/24").issue.message, /prefix here but no address/)
  assert.equal(parse("/24").issue.code, "not-an-address")
})

test("host bits set is reported with both repairs and neither applied", () => {
  const r = parse("192.168.1.5/24")
  assert.equal(r.issue.code, "host-bits")
  assert.equal(r.issue.level, "warning", "it is a real block; it is just not the one written")
  assert.equal(r.address !== null, true, "a warning still stands behind the value")
  assert.equal(r.canonical, "192.168.1.5/24", "nothing was rounded")
  assert.equal(r.suggestion, "192.168.1.0/24")
  // The cost of the silent repair is named, because 1 and 256 is the difference being flagged.
  assert.match(r.issue.message, /1 address to 256/)
  assert.equal(hostBitsSet([192, 168, 1, 5], 4, 24), true)
  assert.equal(hostBitsSet([192, 168, 1, 0], 4, 24), false)
  assert.equal(parse("10.0.0.0/8").issue, null)
  // A /32 has no host bits to set, so a bare host with its own prefix is clean.
  assert.equal(parse("192.168.1.5/32").issue, null)
})

test("a prefix on a mapped address is flagged, and the factor is always 2^96", () => {
  const r = parse("::ffff:10.0.0.0/8")
  assert.equal(r.issue.code, "mapped-prefix")
  assert.equal(r.issue.level, "warning")
  assert.equal(r.suggestion, "::ffff:10.0.0.0/104")
  assert.match(r.issue.message, /7\.9e28/)
  assert.equal(MAPPED_PREFIX_BITS, 96)
  // The ratio does not depend on the prefix, which is why the message can state it as a constant.
  for (const p of [8, 16, 24]) {
    assert.equal(addressCount(6, p) / addressCount(6, MAPPED_PREFIX_BITS + p), 1n << 96n)
  }
  assert.equal((1n << 96n).toString(), "79228162514264337593543950336")
  // At or past /96 the prefix is being written about the IPv4 part, so there is nothing to flag.
  assert.equal(parse("::ffff:10.0.0.0/104").issue, null)
  // /96 is the mapped boundary itself, so the mapped warning stops — but 10.0.0.0 is then entirely
  // host bits, and that is reported on its own terms rather than being swallowed by the first rule.
  assert.equal(parse("::ffff:10.0.0.0/96").issue.code, "host-bits")
  assert.equal(parse("::ffff:0.0.0.0/96").issue, null)
})

test("accept and families narrow what the field will stand behind", () => {
  assert.equal(parse("10.0.0.1/24", { accept: "address" }).issue.code, "prefix-not-accepted")
  assert.equal(parse("10.0.0.1", { accept: "address" }).issue, null)
  assert.equal(parse("10.0.0.1", { accept: "cidr" }).issue.code, "prefix-required")
  assert.match(parse("2001:db8::1", { accept: "cidr" }).issue.message, /\/128/)
  assert.equal(parse("10.0.0.0/8", { accept: "cidr" }).issue, null)
  assert.equal(parse("2001:db8::1", { families: [4] }).issue.code, "family-not-accepted")
  assert.equal(parse("10.0.0.1", { families: [6] }).issue.code, "family-not-accepted")
  assert.equal(parse("10.0.0.1", { families: [4] }).issue, null)
})

// --- byte round-trips ---------------------------------------------------------------------------

test("bytes and integers round-trip in both families", () => {
  assert.equal(bytesToBigInt([127, 0, 0, 1]), 2130706433n)
  assert.deepEqual(bigIntToBytes(2130706433n, 4), [127, 0, 0, 1])
  assert.deepEqual(bigIntToBytes(0n, 6), new Array(16).fill(0))
  assert.deepEqual(bigIntToBytes((1n << 128n) - 1n, 6), new Array(16).fill(255))
  assert.equal(formatAddress({ family: 6, bytes: new Array(16).fill(255), zone: null, mapped: false }), "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")
  const addr = addressOf("2001:db8::1")
  assert.deepEqual(bigIntToBytes(bytesToBigInt(addr.bytes), 6), [...addr.bytes])
  assert.equal(formatCidr(addr, null), "2001:db8::1")
  assert.equal(formatCidr(addr, 64), "2001:db8::1/64")
})

test("sameAddress does not call two families equal, or anything equal to nothing", () => {
  assert.equal(sameAddress(addressOf("192.0.2.1"), addressOf("::ffff:192.0.2.1")), false)
  assert.equal(sameAddress(addressOf("192.0.2.1"), null), false)
  assert.equal(sameAddress(null, null), false)
  assert.equal(sameAddress(addressOf("10.0.0.1"), addressOf("10.0.0.2")), false)
})

// --- the rendered field -------------------------------------------------------------------------

const fieldOf = (props) => {
  const nodes = walk(render(IpInput, props).tree)
  return {
    nodes,
    inputs: byTag(nodes, "input"),
    buttons: byTag(nodes, "button"),
    status: byRole(nodes, "status")[0],
    group: byRole(nodes, "group")[0],
  }
}

const textOf = (node) => {
  const out = []
  const visit = (n) => {
    if (n === null || n === undefined || n === false) return
    if (typeof n === "string" || typeof n === "number") return void out.push(String(n))
    if (Array.isArray(n)) return void n.forEach(visit)
    if (n.props?.children !== undefined) visit(n.props.children)
  }
  visit(node)
  return out.join("")
}

test("the field is a labelled group with one status line", () => {
  const f = fieldOf({ defaultValue: "10.0.0.0/8" })
  assert.ok(f.group, "the pair of controls is one group")
  assert.equal(f.group.props["aria-label"], "IP address")
  const box = f.inputs.find((i) => i.props.type === "text")
  assert.ok(box, "the address goes in a text box, not a number box")
  assert.equal(box.props.spellCheck, false)
  assert.equal(box.props.autoComplete, "off")
  // One live region, and the box points at it.
  assert.equal(byRole(f.nodes, "status").length, 1)
  assert.equal(f.status.props["aria-live"], "polite")
  assert.ok(box.props["aria-describedby"].includes(f.status.props.id))
  assert.match(textOf(f.status), /IPv4 — 10\.0\.0\.0\/8/)
  const labels = byTag(f.nodes, "label")
  assert.equal(labels.length, 1)
  assert.equal(labels[0].props.htmlFor, box.props.id)
})

test("what the field accepts is said in the label, the hint and the placeholder", () => {
  // Three strings that have to agree with `accept`, and a screen reader only gets the first of
  // them. A field that says "an address, or a block" while refusing the block is worse than one
  // that says nothing.
  const read = (props) => {
    const f = fieldOf(props)
    const box = f.inputs.find((i) => i.props.type === "text")
    return {
      hint: textOf(byTag(f.nodes, "label")[0]),
      placeholder: box.props.placeholder,
      status: textOf(f.status),
    }
  }
  const either = read({})
  assert.match(either.hint, /an address, or a block written with a slash and a prefix length/)
  assert.equal(either.placeholder, "192.0.2.10")
  assert.match(either.status, /with an optional \/prefix/)

  const cidr = read({ accept: "cidr" })
  assert.match(cidr.hint, /a block written as an address and a slash and a prefix length/)
  assert.equal(cidr.placeholder, "10.0.0.0/8")
  assert.match(cidr.status, /such as 10\.0\.0\.0\/8 or 2001:db8::\/32/)

  const single = read({ accept: "address" })
  assert.match(single.hint, /a single address/)
  assert.equal(single.placeholder, "192.0.2.10")

  // A placeholder the caller passed wins, including an empty one — which is how a caller says
  // "show nothing", and is the case a `||` here would quietly override.
  assert.equal(read({ placeholder: "203.0.113.0/24" }).placeholder, "203.0.113.0/24")
  assert.equal(read({ placeholder: "" }).placeholder, "")
})

test("aria-invalid follows the fault and not a non-empty box", () => {
  const good = fieldOf({ defaultValue: "2001:db8::1" })
  assert.equal(good.inputs.find((i) => i.props.type === "text").props["aria-invalid"], undefined)
  const bad = fieldOf({ defaultValue: "010.0.0.1" })
  assert.equal(bad.inputs.find((i) => i.props.type === "text").props["aria-invalid"], true)
  // A warning is not an error: the value stands, so the box is not marked invalid.
  const warned = fieldOf({ defaultValue: "192.168.1.5/24" })
  assert.equal(warned.inputs.find((i) => i.props.type === "text").props["aria-invalid"], undefined)
  assert.match(textOf(warned.status), /192\.168\.1\.0\/24/)
  // aria-invalid is the only signal a screen reader gets; the border is the only one everybody
  // else gets, so it has to follow the same condition and not merely exist.
  const borderOf = (f) => f.inputs.find((i) => i.props.type === "text").props.className
  assert.match(borderOf(bad), /border-destructive/)
  assert.doesNotMatch(borderOf(good), /border-destructive/)
  assert.doesNotMatch(borderOf(warned), /border-destructive/)
})

test("the note the box points at exists even when there is no note to make", () => {
  // aria-describedby naming an element that is not in the document is a dangling reference, and a
  // screen reader reads nothing rather than reading the status. So the second target is always
  // rendered, and it is sr-only and empty when the value has nothing to add.
  const noteOf = (props) => {
    const f = fieldOf(props)
    const box = f.inputs.find((i) => i.props.type === "text")
    const id = box.props["aria-describedby"].split(" ")[1]
    const node = f.nodes.find((n) => n.type === "p" && n.props?.id === id)
    assert.ok(node, `the note target ${id} has to be in the tree`)
    return { className: node.props.className ?? "", text: textOf(node) }
  }
  const silent = noteOf({ defaultValue: "10.0.0.1" })
  assert.equal(silent.text, "")
  assert.match(silent.className, /sr-only/)
  const speaking = noteOf({ defaultValue: "10.0.0.0/8" })
  assert.match(speaking.text, /16,777,216 addresses/)
  assert.doesNotMatch(speaking.className, /sr-only/)
})

test("the controls that rewrite the box are buttons, so they cannot submit the form", () => {
  for (const value of ["127.1", "192.168.1.5/24", "2001:0db8:0000:0000:0000:0000:0000:0001"]) {
    const f = fieldOf({ defaultValue: value })
    assert.ok(f.buttons.length >= 1, `${value} should offer a rewrite`)
    for (const b of f.buttons) assert.equal(b.props.type, "button")
  }
  // A value already in canonical form has nothing to offer.
  assert.equal(fieldOf({ defaultValue: "2001:db8::1" }).buttons.length, 0)
  assert.equal(fieldOf({ defaultValue: "10.0.0.0/8" }).buttons.length, 0)

  // Both controls can be on screen at once — a warning about the block, and a respelling of the
  // host — and then they are two different offers. Each has to say which, because two buttons
  // carrying only an address apiece are indistinguishable to anyone reading them aloud.
  const both = fieldOf({ defaultValue: "2001:0DB8::1/64" })
  assert.equal(both.buttons.length, 2)
  assert.equal(textOf(both.buttons[0]), "2001:db8::/64 — put this in the box instead")
  assert.equal(textOf(both.buttons[1]), "2001:db8::1/64 — the canonical spelling, RFC 5952")
})

test("a name posts the canonical text and posts nothing it would not stand behind", () => {
  const hidden = (props) =>
    fieldOf(props).inputs.filter((i) => i.props.type === "hidden")
  const good = hidden({ defaultValue: "2001:0DB8::0001/64", name: "allow" })
  assert.equal(good.length, 3)
  const byName = Object.fromEntries(good.map((i) => [i.props.name, i.props]))
  assert.equal(byName["allow"].value, "2001:db8::1/64", "the canonical spelling is what is posted")
  assert.equal(byName["allow"].disabled, false)
  assert.equal(byName["allow.family"].value, "6")
  assert.equal(byName["allow.prefix"].value, "64")
  // Nothing posted from a value the field refused.
  for (const i of hidden({ defaultValue: "010.0.0.1", name: "allow" })) {
    assert.equal(i.props.disabled, true)
    assert.equal(i.props.value, "")
  }
  // A bare address posts no prefix, rather than posting a guessed one.
  const bare = Object.fromEntries(
    hidden({ defaultValue: "10.0.0.1", name: "allow" }).map((i) => [i.props.name, i.props])
  )
  assert.equal(bare["allow"].value, "10.0.0.1")
  assert.equal(bare["allow.prefix"].value, "")
  assert.equal(bare["allow.prefix"].disabled, true)
  // And no hidden inputs at all without a name.
  assert.equal(hidden({ defaultValue: "10.0.0.1" }).length, 0)
})

test("a controlled value is written in, and an echo of the same text is not", () => {
  const r = render(IpInput, { value: "10.0.0.0/8" })
  const boxOf = (tree) =>
    byTag(walk(tree), "input").find((i) => i.props.type === "text")
  assert.equal(boxOf(r.tree).props.value, "10.0.0.0/8")
  // A different value from the parent replaces what is in the box.
  r.update({ value: "2001:db8::/32" })
  assert.equal(boxOf(r.tree).props.value, "2001:db8::/32")
  // The same value again is not a change, so a parent re-rendering cannot interrupt typing. The
  // guard here is `===`; inverted, every outside value is ignored and the first assertion above is
  // the only one that still passes.
  r.update({ value: "2001:db8::/32" })
  assert.equal(boxOf(r.tree).props.value, "2001:db8::/32")
  r.update({ value: "192.0.2.10" })
  assert.equal(boxOf(r.tree).props.value, "192.0.2.10")
  r.unmount()
})

test("onValueChange hears a value, and the canonical form is the identity", () => {
  const seen = []
  fieldOf({ defaultValue: "::ffff:c000:0201", onValueChange: (v) => seen.push(v) })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].canonical, "::ffff:192.0.2.1")
  assert.equal(seen[0].family, 6)
  assert.equal(seen[0].prefix, null)
  const refused = []
  fieldOf({ defaultValue: "127.1", onValueChange: (v) => refused.push(v) })
  assert.deepEqual(refused, [null])
})
