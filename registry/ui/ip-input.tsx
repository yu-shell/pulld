"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Which family an address belongs to. The two are not one field with a wider range.
 *
 * They disagree about how many bits an address has, about how many of a subnet's addresses a host
 * may use, and about whether the text in the box is the address or merely one of its spellings.
 * Everything below that reads `family` is reading one of those three differences.
 */
export type Family = 4 | 6

/** How many bits an address of each family has. This is the definition, not a measurement. */
export const BITS: Record<Family, number> = { 4: 32, 6: 128 }

/**
 * Where the IPv4 part of an IPv4-mapped IPv6 address starts (RFC 4291 §2.5.5.2).
 *
 * **A prefix written on a mapped address is not the prefix anybody means, and the error is a
 * constant.** `::ffff:10.0.0.0/8` is a legal IPv6 block, but it counts from the front of all 128
 * bits, so it covers 2^120 addresses; the IPv4 `10.0.0.0/8` somebody meant is `/104` here, which
 * covers 2^24. The ratio does not depend on the prefix — `2^(128-p) / 2^(32-p)` is `2^96` for
 * every `p` — so the mistake is always the same factor: 79,228,162,514,264,337,593,543,950,336,
 * about 7.9e28. That is why a mapped address carrying a prefix under 96 gets told about it.
 */
export const MAPPED_PREFIX_BITS = 96

export interface IpAddress {
  family: Family
  /** 4 bytes or 16. **This is the address**; the text in the box is one of its spellings. */
  bytes: readonly number[]
  /** RFC 4007 scope zone, IPv6 only. Part of the destination, not of the bytes — see `sameAddress`. */
  zone: string | null
  /** `::ffff:a.b.c.d` — sixteen bytes that denote an IPv4 host (RFC 4291 §2.5.5.2). */
  mapped: boolean
}

/** The address as one integer. `bigint` rather than `number` for the reason `addressCount` gives. */
export function bytesToBigInt(bytes: readonly number[]): bigint {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return n
}

/** The integer back as bytes of `family`. */
export function bigIntToBytes(value: bigint, family: Family): number[] {
  const length = BITS[family] / 8
  const out = new Array<number>(length)
  let n = value
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 255n)
    n >>= 8n
  }
  return out
}

/**
 * Whether two parsed addresses are the same destination.
 *
 * **Compared on the bytes, because the strings lie.** Measured, every one of these pairs is two
 * valid spellings of one address and `===` says they differ: `2001:db8::1` against
 * `2001:0db8:0000:0000:0000:0000:0000:0001`; `::1` against `0:0:0:0:0:0:0:1`; `2001:DB8::1`
 * against `2001:db8::1`; and `::ffff:192.0.2.1` against `::ffff:c000:0201`. A duplicate check
 * written on the text of an allowlist misses all four, which is how the same host gets added
 * twice and removed once.
 *
 * The zone is compared too, and it is not pedantry: `fe80::1%eth0` and `fe80::1%eth1` carry
 * identical bytes and are hosts on different links (RFC 4007). The bytes alone are not the
 * destination for a link-local address.
 */
export function sameAddress(a: IpAddress | null, b: IpAddress | null): boolean {
  if (!a || !b) return false
  if (a.family !== b.family || a.zone !== b.zone) return false
  return a.bytes.length === b.bytes.length && a.bytes.every((byte, i) => byte === b.bytes[i])
}

/**
 * The netmask of `prefix` bits, byte by byte.
 *
 * **Built per byte because the one-line version is wrong about the most consequential prefix
 * there is.** The mask everybody writes is `(0xFFFFFFFF << (32 - prefix)) >>> 0`, and measured,
 * at `prefix` 0 that is `4294967295` — not zero. JavaScript takes a shift count modulo 32, so
 * shifting by 32 shifts by nothing, and `0.0.0.0/0` comes out with a `/32` mask: a firewall UI
 * reads "the entire internet" as "one host". Eight-bit shifts cannot reach 32, so assembling the
 * mask a byte at a time does not have the failure mode at all, rather than guarding against it.
 */
export function maskBytes(family: Family, prefix: number): number[] {
  const length = BITS[family] / 8
  return Array.from({ length }, (_, i) => {
    const bits = Math.min(8, Math.max(0, prefix - i * 8))
    return (0xff << (8 - bits)) & 0xff
  })
}

/** The first address of the block `bytes/prefix` falls in. */
export function networkBytes(bytes: readonly number[], family: Family, prefix: number): number[] {
  const mask = maskBytes(family, prefix)
  return bytes.map((b, i) => b & mask[i])
}

/** The last address of that block — the IPv4 broadcast address, and in IPv6 just the last one. */
export function lastAddressBytes(
  bytes: readonly number[],
  family: Family,
  prefix: number
): number[] {
  const mask = maskBytes(family, prefix)
  return bytes.map((b, i) => (b & mask[i]) | (~mask[i] & 0xff))
}

/**
 * Whether the address has bits set below its own prefix — `192.168.1.5/24`, which is not a network.
 *
 * Reported rather than corrected, because the two repairs are a host and a subnet. Rounding it
 * down to `192.168.1.0/24` turns a rule about one machine into a rule about 256 of them, and in an
 * allowlist that is the difference the reader was writing the rule to express.
 */
export function hostBitsSet(bytes: readonly number[], family: Family, prefix: number): boolean {
  const network = networkBytes(bytes, family, prefix)
  return !bytes.every((b, i) => b === network[i])
}

/**
 * How many addresses a prefix covers.
 *
 * **`bigint`, because the IPv6 answers are not Numbers.** Measured: `2 ** 64` evaluates to
 * 18446744073709552000, where the true value is 18446744073709551616 — and `2 ** 64 - 1 === 2 ** 64`
 * is `true`, so a /64 and the whole of it minus one address are the same figure in float64. The
 * commonest subnet in IPv6 cannot be counted in a `number`. `Intl.NumberFormat` does format a
 * `bigint` exactly (measured: 2^128 comes out as all 39 digits), so there is nowhere this has to
 * be narrowed.
 */
export function addressCount(family: Family, prefix: number): bigint {
  return 1n << BigInt(BITS[family] - prefix)
}

/**
 * How many of those addresses a host can actually be given.
 *
 * **The familiar "minus two" is an IPv4 rule, and it produces impossible numbers at both ends of
 * even that axis.** Measured: `2 ** (32 - 31) - 2` is 0 and `2 ** (32 - 32) - 2` is -1, so the
 * formula claims a point-to-point link has no usable addresses and a single host has minus one.
 * RFC 3021 makes a /31 a two-address link with both ends usable, and a /32 is one host.
 *
 * On IPv6 the subtraction is wrong at every prefix, not just at the ends: **there is no broadcast
 * address in IPv6 at all** (RFC 4291 §2.7 — broadcast is replaced by multicast). What a v6 subnet
 * does reserve is one address, the Subnet-Router anycast with an all-zero interface identifier
 * (RFC 4291 §2.6.1), and a /127 inter-router link does not reserve even that (RFC 6164). One
 * formula used for both families is therefore wrong about one of them everywhere, which is the
 * same shape of mistake as quoting one metres-per-degree figure for latitude and longitude.
 */
export function usableCount(family: Family, prefix: number): bigint {
  const total = addressCount(family, prefix)
  if (family === 4) {
    if (prefix >= 32) return 1n
    if (prefix === 31) return 2n
    return total - 2n
  }
  if (prefix >= 127) return total
  return total - 1n
}

/** The dotted-quad form of four bytes. */
function formatIpv4(bytes: readonly number[]): string {
  return bytes.join(".")
}

/**
 * The address written the one way RFC 5952 allows.
 *
 * The rules that are easy to miss: hex is lowercase, each group loses its leading zeros, `::`
 * replaces the **longest** run of two or more zero groups and the **leftmost** such run when two
 * are the same length (§4.2.3), and a run of exactly one zero group is never shortened to `::`
 * (§4.2.2) — `2001:db8::1:1:1:1:1` is a legal spelling of `2001:db8:0:1:1:1:1:1` but not its
 * canonical one.
 *
 * **A mapped address is written with its dotted quad, which is the one place this disagrees with
 * the browser.** Measured, `new URL("http://[::ffff:192.0.2.1]").hostname` is `[::ffff:c000:201]`
 * — the WHATWG serialiser has no special case for §5 and prints the last four bytes as hex. Both
 * are correct spellings; only one of them is a form somebody reviewing a firewall rule can read,
 * so this returns `::ffff:192.0.2.1` and the component says what the address is in both families.
 */
export function formatAddress(address: IpAddress): string {
  if (address.family === 4) return formatIpv4(address.bytes)
  const suffix = address.zone ? `%${address.zone}` : ""
  if (address.mapped) {
    return `::ffff:${formatIpv4(address.bytes.slice(12))}${suffix}`
  }
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push((address.bytes[i] << 8) | address.bytes[i + 1])

  let bestStart = -1
  let bestLength = 0
  let start = -1
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (start < 0) start = i
      continue
    }
    if (start >= 0) {
      const length = i - start
      // `>` and not `>=`: on a tie the leftmost run wins, which is §4.2.3.
      if (length >= 2 && length > bestLength) {
        bestStart = start
        bestLength = length
      }
      start = -1
    }
  }

  const hex = groups.map((g) => g.toString(16))
  if (bestStart < 0) return `${hex.join(":")}${suffix}`
  const head = hex.slice(0, bestStart).join(":")
  const tail = hex.slice(bestStart + bestLength).join(":")
  return `${head}::${tail}${suffix}`
}

/** The canonical text for an address with an optional prefix. */
export function formatCidr(address: IpAddress, prefix: number | null): string {
  return prefix === null ? formatAddress(address) : `${formatAddress(address)}/${prefix}`
}

export type IssueCode =
  | "not-an-address"
  | "leading-zero"
  | "legacy-form"
  | "bad-prefix"
  | "prefix-range"
  | "host-bits"
  | "mapped-prefix"
  | "family-not-accepted"
  | "prefix-required"
  | "prefix-not-accepted"

export interface IpIssue {
  code: IssueCode
  /** `error` means nothing is posted. `warning` means the value stands and is flagged. */
  level: "error" | "warning"
  message: string
}

export interface IpParse {
  /** The address, or `null` for an empty box or text that is not one. */
  address: IpAddress | null
  /** The prefix length the text carried, or `null` when it carried none. */
  prefix: number | null
  /** The canonical text, or `""` when there is nothing to stand behind. */
  canonical: string
  issue: IpIssue | null
  /** Things true about a readable value: what it is, how big, what it denotes. */
  notes: string[]
  /** Unambiguous text a control can put in the box, when the field will not do it unasked. */
  suggestion: string | null
}

const EMPTY: IpParse = {
  address: null,
  prefix: null,
  canonical: "",
  issue: null,
  notes: [],
  suggestion: null,
}

const fail = (code: IssueCode, message: string, suggestion: string | null = null): IpParse => ({
  ...EMPTY,
  issue: { code, level: "error", message },
  suggestion,
})

/**
 * Reads one part of a dotted address the way the WHATWG URL parser does, which is the way every
 * browser and curl do: `0x` is hex, a leading `0` is octal, anything else is decimal.
 *
 * Returns `null` for a part that is not a number in its own radix — measured, that is why
 * `http://09.0.0.1` is not a URL at all: `09` strips to `9`, which is not an octal digit.
 */
function legacyPart(text: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16)
  if (/^0[0-7]+$/.test(text)) return Number.parseInt(text.slice(1), 8)
  if (/^\d+$/.test(text) && !(text.length > 1 && text[0] === "0")) return Number(text)
  return null
}

/**
 * The IPv4 address the legacy forms denote, or `null` when they denote none.
 *
 * One to four parts, the last of which absorbs however many bytes the earlier parts left. Verified
 * against the browser on every case it is used for below: `127.1` and `2130706433` and `0x7f.1`
 * and `0177.0.0.1` all come out `127.0.0.1`, `192.168.257` comes out `192.168.1.1`,
 * `10.16777215` comes out `10.255.255.255`, and `192.168.65536`, `10.16777216`, `1.2.3.256`,
 * `1.1.1.1.1` and `99999999999` are refused by both.
 */
export function parseLegacyIpv4(text: string): number[] | null {
  // One bound, not two: `"".split(".")` is `[""]`, so `split` never returns fewer than one part and
  // a `length < 1` guard is a condition that cannot be false. Mutation testing found it by deleting
  // it without any test noticing, which is what an unreachable guard looks like from outside.
  const parts = text.split(".")
  if (parts.length > 4) return null
  const values: number[] = []
  for (const part of parts) {
    const value = legacyPart(part)
    if (value === null) return null
    values.push(value)
  }
  for (let i = 0; i < values.length - 1; i++) if (values[i] > 255) return null
  const lastMax = 256 ** (4 - (values.length - 1)) - 1
  const last = values[values.length - 1]
  if (last > lastMax) return null
  let n = last
  for (let i = 0; i < values.length - 1; i++) n += values[i] * 256 ** (3 - i)
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
}

/** Four plain decimal parts, each 0-255, with no leading zeros. The only unambiguous IPv4 text. */
function parseStrictIpv4(text: string): number[] | null {
  const parts = text.split(".")
  if (parts.length !== 4) return null
  const bytes: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    if (part.length > 1 && part[0] === "0") return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

function readIpv4(text: string): IpParse {
  const strict = parseStrictIpv4(text)
  if (strict) {
    return {
      ...EMPTY,
      address: { family: 4, bytes: strict, zone: null, mapped: false },
      canonical: formatIpv4(strict),
    }
  }

  const parts = text.split(".")
  // The leading zero is checked before the legacy expansion, because it is the one form where the
  // two readings are different hosts rather than two spellings of one.
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const padded = parts.find((p) => p.length > 1 && p[0] === "0")
    if (padded) {
      const octal = parseLegacyIpv4(text)
      const decimal = parseStrictIpv4(parts.map((p) => String(Number(p))).join("."))
      if (octal && decimal) {
        return fail(
          "leading-zero",
          `"${padded}" reads as octal: every browser resolves this to ${formatIpv4(octal)}, while a` +
            ` tool that strips the zero resolves it to ${formatIpv4(decimal)}. Those are different` +
            ` hosts — write the one you mean without the leading zero.`,
          formatIpv4(decimal)
        )
      }
      return fail(
        "leading-zero",
        `"${padded}" has a leading zero, which makes it octal — and 8 and 9 are not octal digits,` +
          ` so browsers refuse this address outright rather than reading it either way.`,
        decimal ? formatIpv4(decimal) : null
      )
    }
  }

  const legacy = parseLegacyIpv4(text)
  if (legacy) {
    return fail(
      "legacy-form",
      `Browsers and curl read "${text}" as ${formatIpv4(legacy)}, and this runtime's own` +
        ` net.isIPv4 calls it invalid. Two answers in one process is not something a rule can be` +
        ` stored on, so write it out.`,
      formatIpv4(legacy)
    )
  }
  return fail("not-an-address", `"${text}" is not an IP address.`)
}

function readIpv6(text: string): IpParse {
  let body = text
  let zone: string | null = null
  const percent = body.indexOf("%")
  if (percent >= 0) {
    zone = body.slice(percent + 1)
    body = body.slice(0, percent)
    // A zone with no name is the one spelling `net.isIPv6` refuses while accepting `%0` (measured).
    if (zone === "") return fail("not-an-address", "A % needs the name of the link after it.")
  }

  const halves = body.split("::")
  if (halves.length > 2) {
    return fail("not-an-address", "A :: may only appear once — it is the run of zeros, so two of them have no reading.")
  }
  const compressed = halves.length === 2

  // **An embedded IPv4 address belongs at the end, and the check is on the half rather than on a
  // flag the reader of each piece sets.** A dotted quad is two groups wherever it sits, so a parser
  // that only counts groups accepts `1.2.3.4::1` and invents `102:304::1` out of it — measured,
  // `net.isIPv6("1.2.3.4::1")` is `false`. Asking whether the left half contains a dot answers it,
  // because a dot anywhere else in that half fails the piece it is in anyway; the flag that used to
  // carry this was a field whose value on the right-hand half was never read, which is what
  // mutation testing found by setting it to `true` with nothing noticing.
  if (compressed && halves[0].includes(".")) {
    return fail("not-an-address", "An embedded IPv4 address belongs at the end of the address.")
  }

  const readSide = (side: string): number[] | null => {
    if (side === "") return []
    const pieces = side.split(":")
    const groups: number[] = []
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]
      if (i === pieces.length - 1 && piece.includes(".")) {
        const quad = parseStrictIpv4(piece)
        if (!quad) return null
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
        continue
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null
      groups.push(Number.parseInt(piece, 16))
    }
    return groups
  }

  const head = readSide(halves[0])
  const tail = compressed ? readSide(halves[1]) : []
  if (!head || !tail) return fail("not-an-address", `"${text}" is not an IPv6 address.`)

  const total = head.length + tail.length
  if (compressed) {
    if (total > 7) {
      return fail(
        "not-an-address",
        "The :: has to stand for at least one group of zeros, and there is no room left for it."
      )
    }
  } else if (total !== 8) {
    return fail("not-an-address", `An IPv6 address has 8 groups; this has ${total}.`)
  }

  const groups = compressed
    ? [...head, ...Array.from({ length: 8 - total }, () => 0), ...tail]
    : head
  const bytes: number[] = []
  for (const g of groups) bytes.push((g >> 8) & 255, g & 255)

  const mapped =
    bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  const address: IpAddress = { family: 6, bytes, zone, mapped }
  return { ...EMPTY, address, canonical: formatAddress(address) }
}

export interface ParseOptions {
  /** Which families the field will stand behind. */
  families?: readonly Family[]
  /** `"address"` refuses a prefix, `"cidr"` requires one, `"either"` takes both. */
  accept?: "address" | "cidr" | "either"
}

/**
 * Reads the box as an address or a block, and says what it had to assume.
 *
 * **Empty and unreadable are kept apart**, for the reason every input in this registry keeps them
 * apart: an empty allowlist entry is not `0.0.0.0`, and `0.0.0.0/0` is every host on the internet.
 *
 * What it will not do is pick between two readings on the reader's behalf. The legacy IPv4 forms
 * are the clearest case: measured, the WHATWG URL parser — which is to say every browser, and
 * curl — resolves `127.1`, `2130706433`, `0x7f.1` and `0177.0.0.1` all to `127.0.0.1` and
 * `192.168.257` to `192.168.1.1`, while `net.isIPv4` in the very same Node process calls every one
 * of them invalid. "Is this a valid address" has two answers inside one runtime, so a field that
 * silently takes either one is deciding which tool downstream is going to be surprised. Each is
 * reported with the expansion named, for a control to apply.
 */
export function parseIpText(text: string, options: ParseOptions = {}): IpParse {
  const { families = [4, 6] as const, accept = "either" } = options
  const trimmed = text.trim()
  if (trimmed === "") return EMPTY

  const slash = trimmed.lastIndexOf("/")
  const body = slash >= 0 ? trimmed.slice(0, slash) : trimmed
  const prefixText = slash >= 0 ? trimmed.slice(slash + 1) : null
  if (body === "") return fail("not-an-address", "There is a prefix here but no address.")

  const read = body.includes(":") ? readIpv6(body) : readIpv4(body)
  if (!read.address) return read
  const address = read.address

  if (!families.includes(address.family)) {
    return fail(
      "family-not-accepted",
      `This field takes IPv${families.join(" and IPv")} addresses, and that is an IPv${address.family} address.`
    )
  }

  let prefix: number | null = null
  if (prefixText !== null) {
    if (accept === "address") {
      return fail("prefix-not-accepted", "This field takes a single address, without a /prefix.")
    }
    if (!/^\d{1,3}$/.test(prefixText)) {
      return fail("bad-prefix", `"/${prefixText}" is not a prefix length.`)
    }
    prefix = Number(prefixText)
    const limit = BITS[address.family]
    if (prefix > limit) {
      return fail(
        "prefix-range",
        `An IPv${address.family} prefix runs from /0 to /${limit}${
          address.family === 4 ? ", not /128 — that is the IPv6 limit" : ""
        }.`
      )
    }
  } else if (accept === "cidr") {
    return fail(
      "prefix-required",
      `This field takes a block, so it needs a /prefix — /${BITS[address.family]} for the single host.`
    )
  }

  const notes: string[] = []
  if (address.mapped) {
    notes.push(
      `An IPv4-mapped address: sixteen bytes that denote the IPv4 host ${formatIpv4(
        address.bytes.slice(12)
      )}.`
    )
  }
  if (address.zone) {
    notes.push(
      `Scoped to the link "${address.zone}", which is part of the destination — the same bytes on` +
        ` another link are another host — and is why this address cannot be a URL host.`
    )
  }

  if (prefix !== null) notes.push(describePrefix(address.family, prefix))

  if (prefix !== null && address.mapped && prefix < MAPPED_PREFIX_BITS) {
    const intended = MAPPED_PREFIX_BITS + prefix
    return {
      address,
      prefix,
      canonical: formatCidr(address, prefix),
      notes,
      suggestion: formatCidr(address, intended),
      issue: {
        code: "mapped-prefix",
        level: "warning",
        message:
          `/${prefix} counts from the front of all 128 bits, so this block is ${count(
            addressCount(6, prefix)
          )} addresses. The IPv4 /${prefix} you are likely to mean is /${intended} here — the` +
          ` difference is 2^96, about 7.9e28 times.`,
      },
    }
  }

  if (prefix !== null && hostBitsSet(address.bytes, address.family, prefix)) {
    const network: IpAddress = {
      ...address,
      bytes: networkBytes(address.bytes, address.family, prefix),
    }
    return {
      address,
      prefix,
      canonical: formatCidr(address, prefix),
      notes,
      suggestion: formatCidr(network, prefix),
      issue: {
        code: "host-bits",
        level: "warning",
        message:
          `${formatAddress(address)}/${prefix} is a host inside a block, not the block:` +
          ` ${formatCidr(network, prefix)} is the block. Rounding it down would widen the rule` +
          ` from 1 address to ${count(addressCount(address.family, prefix))}, so neither is` +
          ` applied for you.`,
      },
    }
  }

  return {
    address,
    prefix,
    canonical: formatCidr(address, prefix),
    notes,
    suggestion: null,
    issue: null,
  }
}

/** A count with its thousands separators. `bigint` all the way, for the reason `addressCount` gives. */
function count(value: bigint): string {
  return value.toLocaleString("en-US")
}

/**
 * What a prefix is worth, in addresses.
 *
 * **The sentence exists because the prefix is the one number in a firewall rule that is read
 * linearly and is not linear.** A /24 is 256 addresses and a /16 is 65,536 — one digit, 256 times
 * as many hosts — and a /0 is every address there is. Printing the figure is the whole of the fix.
 */
export function describePrefix(family: Family, prefix: number): string {
  const total = addressCount(family, prefix)
  const usable = usableCount(family, prefix)
  const single = prefix === BITS[family]
  if (single) return `/${prefix} is the single address.`
  const detail =
    family === 4
      ? prefix === 31
        ? "both usable on a point-to-point link (RFC 3021)"
        : `${count(usable)} usable, after the network and broadcast addresses`
      : prefix >= 127
        ? "both usable on an inter-router link (RFC 6164)"
        : `${count(usable)} usable, after the Subnet-Router anycast address — IPv6 has no broadcast address to lose`
  return `/${prefix} covers ${count(total)} addresses: ${detail}.`
}

export interface IpValue {
  canonical: string
  family: Family
  prefix: number | null
  bytes: readonly number[]
  zone: string | null
}

export interface IpInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange"> {
  value?: string
  defaultValue?: string
  /** Called with a value the field stands behind, or `null` while it does not. */
  onValueChange?: (value: IpValue | null) => void
  families?: readonly Family[]
  accept?: "address" | "cidr" | "either"
  label?: string
  /** Posts the canonical text, the family and the prefix — and posts nothing when invalid. */
  name?: string
}

/**
 * One box for an IP address or a CIDR block, which is a stricter field than it looks.
 *
 * What it is for: a firewall or allowlist entry, a VPN or subnet plan, a DNS A/AAAA record, an
 * upstream for a proxy or load balancer, a monitoring target, and the search box where somebody
 * pastes the source address out of a log.
 *
 * What it does that a text box with a regular expression does not: it normalises to the one
 * spelling RFC 5952 allows, so a duplicate check lands; it refuses the two IPv4 forms whose
 * readings disagree instead of picking one; it says what a prefix is worth in addresses; and it
 * tells the difference between an empty box and an unreadable one.
 *
 * Within pulld, `masked-input` fixes the shape of a field whose parts all follow one rule, where
 * each half of this one has its own; `number-range-input` is one axis of from-and-to; and
 * `network-status` reports the browser's own connection rather than taking an address.
 */
export function IpInput({
  value,
  defaultValue = "",
  onValueChange,
  families = [4, 6],
  accept = "either",
  label = "IP address",
  name,
  className,
  disabled,
  placeholder,
  ...rest
}: IpInputProps) {
  const isControlled = value !== undefined
  const reactId = React.useId()
  const [text, setText] = React.useState(isControlled ? (value as string) : defaultValue)

  // An outside value is written into the box only when it is a different string from the one on
  // screen, so a parent echoing the same text back cannot interrupt typing.
  const lastPushed = React.useRef<string>(isControlled ? (value as string) : defaultValue)
  React.useEffect(() => {
    if (!isControlled) return
    if (value === lastPushed.current) return
    lastPushed.current = value as string
    setText(value as string)
  }, [isControlled, value])

  const parsed = parseIpText(text, { families, accept })
  // `address !== null` is the whole condition, and the `issue?.level !== "error"` that was beside it
  // was the same rule written twice: every error-level return in `parseIpText` goes through `fail`,
  // which carries no address, and a warning-level one always carries one. Mutation testing turned
  // the `&&` into an `||` in both places here with no test noticing — which is the signature of a
  // second clause that can never change the answer.
  const found = parsed.address
  const result: IpValue | null = found
    ? {
        canonical: parsed.canonical,
        family: found.family,
        prefix: parsed.prefix,
        bytes: found.bytes,
        zone: found.zone,
      }
    : null

  // The parent hears about a value, not about a keystroke: the canonical text is the identity, so
  // retyping the same address in another spelling is not a change.
  const lastEmitted = React.useRef<string>("\u0000")
  React.useEffect(() => {
    const key = result ? result.canonical : "null"
    if (key === lastEmitted.current) return
    lastEmitted.current = key
    onValueChange?.(result)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result?.canonical])

  const bad = parsed.issue?.level === "error"
  const statusId = `${reactId}-status`
  const noteId = `${reactId}-note`
  const normalised = result && result.canonical !== text.trim() ? result.canonical : null

  const apply = (next: string) => {
    lastPushed.current = next
    setText(next)
  }

  return (
    <div role="group" aria-label={label} className={cn("flex w-full flex-col gap-2", className)}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <label htmlFor={reactId} className="text-xs font-medium text-muted-foreground">
            {label}
            <span className="sr-only">
              {accept === "address"
                ? ", a single address"
                : accept === "cidr"
                  ? ", a block written as an address and a slash and a prefix length"
                  : ", an address, or a block written with a slash and a prefix length"}
            </span>
          </label>
          <input
            id={reactId}
            // `type="text"`: there is no input type that holds an address, and `type="number"`
            // would discard every character that makes one.
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            value={text}
            aria-invalid={bad || undefined}
            aria-describedby={`${statusId} ${noteId}`}
            placeholder={placeholder ?? (accept === "cidr" ? "10.0.0.0/8" : "192.0.2.10")}
            onChange={(e) => setText(e.target.value)}
            className={cn(
              "h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 font-mono text-sm shadow-sm transition-colors",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
              bad && "border-destructive focus-visible:ring-destructive"
            )}
            {...rest}
          />
        </div>
        {parsed.suggestion ? (
          <button
            type="button"
            onClick={() => apply(parsed.suggestion as string)}
            disabled={disabled}
            className={cn(
              "h-9 shrink-0 rounded-md border border-input px-3 font-mono text-xs transition-colors",
              "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {parsed.suggestion}
            <span className="sr-only"> — put this in the box instead</span>
          </button>
        ) : null}
        {normalised ? (
          <button
            type="button"
            onClick={() => apply(normalised)}
            disabled={disabled}
            className={cn(
              "h-9 shrink-0 rounded-md border border-input px-3 font-mono text-xs transition-colors",
              "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {normalised}
            <span className="sr-only"> — the canonical spelling, RFC 5952</span>
          </button>
        ) : null}
      </div>

      {/* One polite status line for the group: two live regions race each other and a screen
          reader ends up announcing neither. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}
      >
        {parsed.issue
          ? parsed.issue.message
          : result
            ? `IPv${result.family} — ${result.canonical}`
            : accept === "cidr"
              ? "An IPv4 or IPv6 block, such as 10.0.0.0/8 or 2001:db8::/32."
              : "An IPv4 or IPv6 address, with an optional /prefix."}
      </p>
      {parsed.notes.length > 0 ? (
        <p id={noteId} className="text-xs text-muted-foreground">
          {parsed.notes.join(" ")}
        </p>
      ) : (
        <p id={noteId} className="sr-only" />
      )}

      {name ? (
        <>
          <input type="hidden" name={name} value={result ? result.canonical : ""} disabled={!result} />
          <input
            type="hidden"
            name={`${name}.family`}
            value={result ? String(result.family) : ""}
            disabled={!result}
          />
          <input
            type="hidden"
            name={`${name}.prefix`}
            value={result && result.prefix !== null ? String(result.prefix) : ""}
            disabled={!result || result.prefix === null}
          />
        </>
      ) : null}
    </div>
  )
}
