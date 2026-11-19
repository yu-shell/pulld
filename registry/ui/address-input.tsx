"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { COUNTRY_CODES, getCountryName } from "@/registry/ui/country-select"

/**
 * A postal address form whose fields are the ones the selected country actually writes.
 *
 * The reason this is a component and not a street/city/state/zip layout with a country dropdown on
 * top is that there is no such thing as the fields of an address. Japan writes the postal code
 * first, then the prefecture, and has **no city field at all** — the municipality belongs to the
 * street-address block. The United Kingdom has no state. Hong Kong has no postal code but
 * *requires* an area. Singapore has no state but requires a six-digit postal code. Ireland's
 * Eircode is optional, and Ireland has a townland line above the town that almost nothing else
 * does. A form with a required "State" and a required "ZIP" is a form a large part of the world
 * cannot complete, and the usual workaround — marking them optional and hiding them behind
 * "international" — moves the problem into the data instead of solving it.
 *
 * So the field list, the order, the labels, which fields may be left empty and the shape of the
 * postal code all come out of `COUNTRY_RULES` below, which is derived from the dataset Chrome's own
 * address autofill uses (Google's Address Data Service, the data behind libaddressinput). It is
 * re-derivable: `node scripts/address-data.mjs` prints the table and `--check` diffs the shipped
 * one against upstream and names any country that has drifted. Nothing in it was written from
 * memory, which matters more than it sounds — the first draft of this component's own design note
 * had Japan's fields as "postal code, prefecture, municipality" and had Hong Kong down as having
 * neither a state nor a postal code, and both are wrong in the measured data.
 *
 * What it deliberately does not do:
 *
 *   - **No subdivision lists.** The administrative area is a text input, not a select of the 47
 *     prefectures or the 50 states. Those lists are a different component's worth of data, they go
 *     stale, and `autocomplete="address-level1"` already lets the browser fill the field. Pass
 *     `administrativeAreaOptions` to turn it into a select where you do have the list.
 *   - **No recipient name or organisation.** They are part of a printed address label but they are
 *     almost always already collected elsewhere in the form, and bundling them here produces two
 *     name fields. Render them yourself; in the countries that write the address largest-unit-first
 *     (`order` starting with `S` or `Z` — Japan, China, Korea, Hong Kong, Taiwan) the recipient
 *     conventionally comes *last*, after the street.
 *   - **No address lookup.** No postal-code-to-address call, no autocomplete service, no network.
 *
 * ```tsx
 * const [address, setAddress] = React.useState(() => emptyAddress("US"))
 *
 * <AddressInput
 *   value={address}
 *   onChange={setAddress}
 *   autoCompleteSection="shipping"
 *   namePrefix="shipping"
 * />
 * ```
 *
 * Validate on submit with the same rules the fields show on blur:
 *
 * ```tsx
 * const errors = validateAddress(address)
 * if (Object.keys(errors).length) return setShowErrors(true)
 * ```
 */

/** The locale country names are resolved in before hydration. See `namesReady` below. */
const HYDRATION_LOCALE = "en-US"

/** The parts of a postal address this component collects, named as HTML autofill names them. */
export type AddressField =
  | "addressLine1"
  | "addressLine2"
  | "addressLine3"
  | "dependentLocality"
  | "locality"
  | "administrativeArea"
  | "postalCode"

/**
 * A whole address. Every field is always present, even the ones the country does not use, so a
 * partly-filled address is fully representable and a controlled parent can store it without
 * dropping keystrokes.
 */
export type AddressValue = { country: string } & Record<AddressField, string>

/**
 * One country's deviations from the default.
 *
 * `order` is the address fields that country writes, in its own order, as letters: `A` street
 * address, `D` dependent locality, `C` locality, `S` administrative area, `Z` postal code. `US` is
 * `"ACSZ"`, `JP` is `"ZSA"`, `HK` is `"SCA"`. `required` is the subset that may not be empty, and
 * when absent the country inherits the default. The three `*Type` keys name the field rather than
 * labelling it — `state: "prefecture"` resolves through `FIELD_LABELS`, so one override translates
 * every country that calls it that.
 */
type CountryRule = {
  order: string
  required?: string
  state?: string
  locality?: string
  postal?: string
  sub?: string
  pattern?: string
  upperPostal?: boolean
}

/**
 * What a country inherits where it says nothing: a street address and a city, both required.
 *
 * This is upstream's `ZZ` entry, and it is the entry 54 countries rely on entirely — they ship no
 * format of their own. Four of those still override `require` (Antigua and Barbuda asks only for
 * the street), which is why the order and the required set are inherited separately.
 */
const DEFAULT_ORDER = "AC"
const DEFAULT_REQUIRED = "AC"
const DEFAULT_LABEL_TYPES = {
  state: "province",
  locality: "city",
  postal: "postal",
  sub: "suburb",
} as const

/**
 * Derived from Google's Address Data Service (Apache-2.0), 252 countries, by
 * `node scripts/address-data.mjs`. Run that with `--check` to diff this against upstream.
 *
 * The literal decoration upstream carries in its format strings — the 〒 before a Japanese postal
 * code, the word SINGAPORE, the comma in "Springfield, IL 62704" — is dropped on purpose. It is
 * for *printing* an address label; a form needs the order and the presence, not the punctuation.
 */
const COUNTRY_RULES: Record<string, CountryRule> = {
  AC: { order: "ACZ", pattern: "ASCN 1ZZ" },
  AD: { order: "AZC", pattern: "AD[1-7]0\\d" },
  AE: { order: "AS", required: "AS", state: "emirate" },
  AF: { order: "ACZ", pattern: "\\d{4}" },
  AG: { order: "AC", required: "A" },
  AI: { order: "ACZ", pattern: "(?:AI-)?2640" },
  AL: { order: "AZC", pattern: "\\d{4}" },
  AM: { order: "AZCS", pattern: "(?:37)?\\d{4}" },
  AO: { order: "AC" },
  AQ: { order: "AC" },
  AR: { order: "AZCS", pattern: "[A-HJ-NP-Z]\\d{4}[A-Z]{3}", upperPostal: true },
  AS: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(96799)(?:[ \\-](\\d{4}))?" },
  AT: { order: "AZC", required: "ACZ", pattern: "\\d{4}" },
  AU: { order: "ACSZ", required: "ACSZ", state: "state", locality: "suburb", pattern: "\\d{4}" },
  AW: { order: "AC" },
  AX: { order: "AZC", required: "ACZ", pattern: "22\\d{3}" },
  AZ: { order: "AZC", pattern: "\\d{4}" },
  BA: { order: "AZC", pattern: "\\d{5}" },
  BB: { order: "ACSZ", state: "parish", pattern: "BB\\d{5}" },
  BD: { order: "ACZ", pattern: "\\d{4}" },
  BE: { order: "AZC", required: "ACZ", pattern: "\\d{4}" },
  BF: { order: "AC" },
  BG: { order: "AZC", pattern: "\\d{4}" },
  BH: { order: "ACZ", pattern: "(?:^|\\b)(?:1[0-2]|[1-9])\\d{2}(?:$|\\b)" },
  BI: { order: "AC" },
  BJ: { order: "AC" },
  BL: { order: "AZC", required: "ACZ", pattern: "9[78][01]\\d{2}" },
  BM: { order: "ACZ", pattern: "[A-Z]{2} ?[A-Z0-9]{2}" },
  BN: { order: "ACZ", pattern: "[A-Z]{2} ?\\d{4}" },
  BO: { order: "AC" },
  BQ: { order: "AC" },
  BR: { order: "ADCSZ", required: "ASCZ", state: "state", sub: "neighborhood", pattern: "\\d{5}-?\\d{3}" },
  BS: { order: "ACS", state: "island" },
  BT: { order: "ACZ", pattern: "\\d{5}" },
  BV: { order: "AC" },
  BW: { order: "AC" },
  BY: { order: "AZCS", pattern: "\\d{6}" },
  BZ: { order: "AC" },
  CA: { order: "ACSZ", required: "ACSZ", pattern: "[ABCEGHJKLMNPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d", upperPostal: true },
  CC: { order: "ACSZ", pattern: "6799" },
  CD: { order: "AC" },
  CF: { order: "AC" },
  CG: { order: "AC" },
  CH: { order: "AZC", required: "ACZ", pattern: "\\d{4}" },
  CI: { order: "AC" },
  CK: { order: "AC" },
  CL: { order: "AZCS", pattern: "\\d{7}" },
  CM: { order: "AC" },
  CN: { order: "ZSCDA", required: "ACSZ", sub: "district", pattern: "\\d{6}" },
  CO: { order: "ADCSZ", required: "AS", state: "department", pattern: "\\d{6}" },
  CR: { order: "ASCZ", required: "ACS", pattern: "\\d{4,5}|\\d{3}-\\d{4}" },
  CU: { order: "ACSZ", pattern: "\\d{5}" },
  CV: { order: "AZCS", state: "island", pattern: "\\d{4}" },
  CW: { order: "AC" },
  CX: { order: "ACSZ", pattern: "6798" },
  CY: { order: "AZC", pattern: "\\d{4}" },
  CZ: { order: "AZC", required: "ACZ", pattern: "\\d{3} ?\\d{2}" },
  DE: { order: "AZC", required: "ACZ", pattern: "\\d{5}" },
  DJ: { order: "AC" },
  DK: { order: "AZC", required: "ACZ", pattern: "\\d{4}" },
  DM: { order: "AC" },
  DO: { order: "AZC", pattern: "\\d{5}" },
  DZ: { order: "AZC", pattern: "\\d{5}" },
  EC: { order: "AZC", pattern: "\\d{6}", upperPostal: true },
  EE: { order: "AZCS", required: "ACZ", pattern: "\\d{5}" },
  EG: { order: "ACSZ", pattern: "\\d{7}|\\d{5}" },
  EH: { order: "AZC", pattern: "\\d{5}" },
  ER: { order: "AC" },
  ES: { order: "AZCS", required: "ACSZ", pattern: "\\d{5}" },
  ET: { order: "AZC", pattern: "\\d{4}" },
  FI: { order: "AZC", required: "ACZ", pattern: "\\d{5}" },
  FJ: { order: "AC" },
  FK: { order: "ACZ", required: "ACZ", pattern: "FIQQ 1ZZ", upperPostal: true },
  FM: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(9694[1-4])(?:[ \\-](\\d{4}))?" },
  FO: { order: "AZC", pattern: "\\d{3}" },
  FR: { order: "AZC", required: "ACZ", pattern: "\\d{2} ?\\d{3}" },
  GA: { order: "AC" },
  GB: { order: "ACZ", required: "ACZ", locality: "post_town", pattern: "GIR ?0AA|(?:(?:AB|AL|B|BA|BB|BD|BF|BH|BL|BN|BR|BS|BT|BX|CA|CB|CF|CH|CM|CO|CR|CT|CV|CW|DA|DD|DE|DG|DH|DL|DN|DT|DY|E|EC|EH|EN|EX|FK|FY|G|GL|GY|GU|HA|HD|HG|HP|HR|HS|HU|HX|IG|IM|IP|IV|JE|KA|KT|KW|KY|L|LA|LD|LE|LL|LN|LS|LU|M|ME|MK|ML|N|NE|NG|NN|NP|NR|NW|OL|OX|PA|PE|PH|PL|PO|PR|RG|RH|RM|S|SA|SE|SG|SK|SL|SM|SN|SO|SP|SR|SS|ST|SW|SY|TA|TD|TF|TN|TQ|TR|TS|TW|UB|W|WA|WC|WD|WF|WN|WR|WS|WV|YO|ZE)(?:\\d[\\dA-Z]? ?\\d[ABD-HJLN-UW-Z]{2}))|BFPO ?\\d{1,4}", upperPostal: true },
  GD: { order: "AC" },
  GE: { order: "AZC", pattern: "\\d{4}" },
  GF: { order: "AZC", required: "ACZ", pattern: "9[78]3\\d{2}" },
  GG: { order: "ACZ", required: "ACZ", pattern: "GY\\d[\\dA-Z]? ?\\d[ABD-HJLN-UW-Z]{2}", upperPostal: true },
  GH: { order: "AC" },
  GI: { order: "AZ", required: "A", pattern: "GX11 1AA" },
  GL: { order: "AZC", required: "ACZ", pattern: "39\\d{2}" },
  GM: { order: "AC" },
  GN: { order: "ZAC", pattern: "\\d{3}" },
  GP: { order: "AZC", required: "ACZ", pattern: "9[78][01]\\d{2}" },
  GQ: { order: "AC" },
  GR: { order: "AZC", required: "ACZ", pattern: "\\d{3} ?\\d{2}" },
  GS: { order: "ACZ", required: "ACZ", pattern: "SIQQ 1ZZ", upperPostal: true },
  GT: { order: "AZC", pattern: "\\d{5}" },
  GU: { order: "ACZ", required: "ACZ", postal: "zip", pattern: "(969(?:[12]\\d|3[12]))(?:[ \\-](\\d{4}))?" },
  GW: { order: "AZC", pattern: "\\d{4}" },
  GY: { order: "AC" },
  HK: { order: "SCA", required: "AS", state: "area", locality: "district" },
  HM: { order: "ACSZ", pattern: "\\d{4}" },
  HN: { order: "ACSZ", required: "ACS", state: "department", pattern: "\\d{5}" },
  HR: { order: "AZC", pattern: "\\d{5}" },
  HT: { order: "AZC", pattern: "\\d{4}" },
  HU: { order: "CAZ", required: "ACZ", pattern: "\\d{4}" },
  ID: { order: "ACSZ", required: "AS", pattern: "\\d{5}" },
  IE: { order: "ADCSZ", state: "county", postal: "eircode", sub: "townland", pattern: "[\\dA-Z]{3} ?[\\dA-Z]{4}" },
  IL: { order: "ACZ", pattern: "\\d{5}(?:\\d{2})?" },
  IM: { order: "ACZ", required: "ACZ", pattern: "IM\\d[\\dA-Z]? ?\\d[ABD-HJLN-UW-Z]{2}", upperPostal: true },
  IN: { order: "ACZS", required: "ACSZ", state: "state", postal: "pin", pattern: "\\d{6}" },
  IO: { order: "ACZ", required: "ACZ", pattern: "BBND 1ZZ", upperPostal: true },
  IQ: { order: "ACSZ", required: "ACS", pattern: "\\d{5}" },
  IR: { order: "SCDAZ", sub: "neighborhood", pattern: "\\d{5}-?\\d{5}" },
  IS: { order: "AZC", pattern: "\\d{3}" },
  IT: { order: "AZCS", required: "ACSZ", pattern: "\\d{5}" },
  JE: { order: "ACZ", required: "ACZ", pattern: "JE\\d[\\dA-Z]? ?\\d[ABD-HJLN-UW-Z]{2}", upperPostal: true },
  JM: { order: "ACS", required: "ACS", state: "parish" },
  JO: { order: "ACZ", pattern: "\\d{5}" },
  JP: { order: "ZSA", required: "ASZ", state: "prefecture", pattern: "\\d{3}-?\\d{4}" },
  KE: { order: "ACZ", pattern: "\\d{5}" },
  KG: { order: "AZC", pattern: "\\d{6}" },
  KH: { order: "ACZ", pattern: "\\d{5,6}" },
  KI: { order: "ASC", state: "island" },
  KM: { order: "AC" },
  KN: { order: "ACS", required: "ACS", state: "island" },
  KP: { order: "ZSCA" },
  KR: { order: "SCDAZ", required: "ACSZ", state: "do_si", sub: "district", pattern: "\\d{5}", upperPostal: true },
  KW: { order: "AZC", pattern: "\\d{5}" },
  KY: { order: "ASZ", required: "AS", state: "island", pattern: "KY\\d-\\d{4}" },
  KZ: { order: "ZSCA", pattern: "[A-Z]\\d{2}[A-Z0-9]{4}|\\d{6}" },
  LA: { order: "AZC", pattern: "\\d{5}" },
  LB: { order: "ACZ", pattern: "(?:\\d{4})(?: ?(?:\\d{4}))?" },
  LC: { order: "AC" },
  LI: { order: "AZC", required: "ACZ", pattern: "948[5-9]|949[0-8]" },
  LK: { order: "ACZ", pattern: "\\d{5}" },
  LR: { order: "AZC", pattern: "\\d{4}" },
  LS: { order: "ACZ", pattern: "\\d{3}" },
  LT: { order: "AZCS", required: "ACZ", pattern: "\\d{5}" },
  LU: { order: "AZC", required: "ACZ", pattern: "\\d{4}" },
  LV: { order: "ASCZ", required: "ACZ", pattern: "LV-\\d{4}" },
  LY: { order: "AC" },
  MA: { order: "AZC", pattern: "\\d{5}" },
  MC: { order: "AZC", pattern: "980\\d{2}" },
  MD: { order: "AZC", pattern: "\\d{4}" },
  ME: { order: "AZC", pattern: "8\\d{4}" },
  MF: { order: "AZC", required: "ACZ", pattern: "9[78][01]\\d{2}" },
  MG: { order: "AZC", pattern: "\\d{3}" },
  MH: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(969[67]\\d)(?:[ \\-](\\d{4}))?" },
  MK: { order: "AZC", pattern: "\\d{4}" },
  ML: { order: "AC" },
  MM: { order: "ACZ", pattern: "\\d{5}" },
  MN: { order: "ACSZ", pattern: "\\d{5}" },
  MO: { order: "A", required: "A" },
  MP: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(9695[012])(?:[ \\-](\\d{4}))?" },
  MQ: { order: "AZC", required: "ACZ", pattern: "9[78]2\\d{2}" },
  MR: { order: "AC" },
  MS: { order: "AC" },
  MT: { order: "ACZ", pattern: "[A-Z]{3} ?\\d{2,4}", upperPostal: true },
  MU: { order: "AZC", pattern: "\\d{3}(?:\\d{2}|[A-Z]{2}\\d{3})", upperPostal: true },
  MV: { order: "ACZ", pattern: "\\d{5}" },
  MW: { order: "AC" },
  MX: { order: "ADZCS", required: "ACSZ", state: "state", sub: "neighborhood", pattern: "\\d{5}", upperPostal: true },
  MY: { order: "ADZCS", required: "ACZ", state: "state", sub: "village_township", pattern: "\\d{5}" },
  MZ: { order: "AZCS", pattern: "\\d{4}" },
  NA: { order: "ACZ", pattern: "\\d{5}" },
  NC: { order: "AZC", required: "ACZ", pattern: "988\\d{2}" },
  NE: { order: "AZC", pattern: "\\d{4}" },
  NF: { order: "ACSZ", pattern: "2899" },
  NG: { order: "ADCZS", state: "state", pattern: "[A-Z]{2}[ -]?(?:0[1-9]|[1-9]\\d)[ -]?[A-Z\\d]{3}[ -]?[A-Z]{2}[ -]?(?:0[1-9]|[1-9]\\d)|\\d{6}", upperPostal: true },
  NI: { order: "AZCS", state: "department", pattern: "\\d{5}" },
  NL: { order: "AZC", required: "ACZ", pattern: "[1-9]\\d{3} ?(?:[A-RT-Z][A-Z]|S[BCE-RT-Z])" },
  NO: { order: "AZC", required: "ACZ", locality: "post_town", pattern: "\\d{4}" },
  NP: { order: "ACZ", pattern: "\\d{5}" },
  NR: { order: "AS", required: "AS", state: "district" },
  NU: { order: "AC" },
  NZ: { order: "ADCZ", required: "ACDZ", pattern: "\\d{4}" },
  OM: { order: "AZC", pattern: "(?:PC )?\\d{3}" },
  PA: { order: "ACS" },
  PE: { order: "ACZS", locality: "district", pattern: "(?:LIMA \\d{1,2}|CALLAO 0?\\d)|[0-2]\\d{4}" },
  PF: { order: "AZCS", required: "ACSZ", state: "island", pattern: "987\\d{2}" },
  PG: { order: "ACZS", required: "ACS", pattern: "\\d{3}" },
  PH: { order: "ADCZS", pattern: "\\d{4}" },
  PK: { order: "ADCZ", pattern: "\\d{5}" },
  PL: { order: "AZC", required: "ACZ", pattern: "\\d{2}-\\d{3}" },
  PM: { order: "AZC", required: "ACZ", pattern: "9[78]5\\d{2}" },
  PN: { order: "ACZ", required: "ACZ", pattern: "PCRN 1ZZ", upperPostal: true },
  PR: { order: "ACZ", required: "ACZ", postal: "zip", pattern: "(00[679]\\d{2})(?:[ \\-](\\d{4}))?" },
  PS: { order: "AC" },
  PT: { order: "AZC", required: "ACZ", pattern: "\\d{4}-\\d{3}" },
  PW: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(969(?:39|40))(?:[ \\-](\\d{4}))?" },
  PY: { order: "AZC", pattern: "\\d{6}" },
  QA: { order: "AC" },
  RE: { order: "AZC", required: "ACZ", pattern: "9[78]4\\d{2}" },
  RO: { order: "AZSC", required: "ACZ", pattern: "\\d{6}" },
  RS: { order: "AZC", pattern: "\\d{5,6}" },
  RU: { order: "ACSZ", required: "ACSZ", state: "oblast", pattern: "\\d{6}" },
  RW: { order: "AC" },
  SA: { order: "ACZ", pattern: "\\d{5}" },
  SB: { order: "AC" },
  SC: { order: "ACS", state: "island" },
  SD: { order: "ACZ", locality: "district", pattern: "\\d{5}" },
  SE: { order: "AZC", required: "ACZ", locality: "post_town", pattern: "\\d{3} ?\\d{2}" },
  SG: { order: "AZ", required: "AZ", pattern: "\\d{6}" },
  SH: { order: "ACZ", required: "ACZ", pattern: "(?:ASCN|STHL) 1ZZ", upperPostal: true },
  SI: { order: "AZC", pattern: "\\d{4}" },
  SJ: { order: "AZC", required: "ACZ", locality: "post_town", pattern: "\\d{4}" },
  SK: { order: "AZC", required: "ACZ", pattern: "\\d{3} ?\\d{2}" },
  SL: { order: "AC" },
  SM: { order: "AZC", required: "AZ", pattern: "4789\\d" },
  SN: { order: "AZC", pattern: "\\d{5}" },
  SO: { order: "ACSZ", required: "ACS", pattern: "[A-Z]{2} ?\\d{5}" },
  SR: { order: "ACS" },
  SS: { order: "AC" },
  ST: { order: "AC" },
  SV: { order: "AZCS", required: "ACS", pattern: "[1-3][1-7][0-2]\\d", upperPostal: true },
  SX: { order: "AC" },
  SY: { order: "AC", locality: "district" },
  SZ: { order: "ACZ", pattern: "[HLMS]\\d{3}", upperPostal: true },
  TA: { order: "ACZ", pattern: "TDCU 1ZZ" },
  TC: { order: "ACZ", required: "ACZ", pattern: "TKCA 1ZZ", upperPostal: true },
  TD: { order: "AC" },
  TF: { order: "AC" },
  TG: { order: "AC" },
  TH: { order: "ADCSZ", pattern: "\\d{5}" },
  TJ: { order: "AZC", pattern: "\\d{6}" },
  TK: { order: "AC" },
  TL: { order: "AC" },
  TM: { order: "AZC", pattern: "\\d{6}" },
  TN: { order: "AZC", pattern: "\\d{4}" },
  TO: { order: "AC" },
  TR: { order: "AZCS", required: "ACZ", locality: "district", pattern: "\\d{5}" },
  TT: { order: "ACZ", pattern: "\\d{6}" },
  TV: { order: "ACS", state: "island" },
  TW: { order: "ZSCA", required: "ACSZ", state: "county", locality: "district", pattern: "\\d{3}(?:\\d{2,3})?" },
  TZ: { order: "AZC", pattern: "\\d{4,5}" },
  UA: { order: "ACSZ", required: "ACZ", state: "oblast", pattern: "\\d{5}" },
  UG: { order: "AC" },
  UM: { order: "ACSZ", required: "ACS", state: "state", postal: "zip", pattern: "96898" },
  US: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(\\d{5})(?:[ \\-](\\d{4}))?" },
  UY: { order: "AZCS", pattern: "\\d{5}" },
  UZ: { order: "AZCS", pattern: "\\d{6}" },
  VA: { order: "AZC", pattern: "00120" },
  VC: { order: "ACZ", pattern: "VC\\d{4}" },
  VE: { order: "ACZS", required: "ACS", state: "state", pattern: "\\d{4}" },
  VG: { order: "ACZ", required: "A", pattern: "VG\\d{4}" },
  VI: { order: "ACSZ", required: "ACSZ", state: "state", postal: "zip", pattern: "(008(?:(?:[0-4]\\d)|(?:5[01])))(?:[ \\-](\\d{4}))?" },
  VN: { order: "ACSZ", required: "AS", pattern: "\\d{5}\\d?" },
  VU: { order: "AC" },
  WF: { order: "AZC", required: "ACZ", pattern: "986\\d{2}" },
  WS: { order: "AC" },
  XK: { order: "AZC", pattern: "[1-7]\\d{4}" },
  YE: { order: "AC" },
  YT: { order: "AZC", required: "ACZ", pattern: "976\\d{2}" },
  ZA: { order: "ADCZ", required: "ACZ", pattern: "\\d{4}" },
  ZM: { order: "AZC", pattern: "\\d{5}" },
  ZW: { order: "AC" },
}

/**
 * The English word for each field name upstream uses, plus the fields that are the same everywhere.
 *
 * Keyed by name *type* rather than by country so that one entry covers every country that calls the
 * field that, and so a caller translating the form overrides a dozen countries at once by passing
 * `labels={{ prefecture: "都道府県" }}`. `district` and `suburb` each appear upstream as both an
 * administrative-area name and a locality name; one entry serves both because the word is the same.
 */
export const FIELD_LABELS: Record<string, string> = {
  // Administrative area, as the twelve countries' worth of variants upstream distinguishes.
  province: "Province",
  state: "State",
  county: "County",
  parish: "Parish",
  island: "Island",
  department: "Department",
  emirate: "Emirate",
  prefecture: "Prefecture",
  do_si: "Do / Si",
  district: "District",
  area: "Area",
  oblast: "Oblast",
  // Locality.
  city: "City",
  post_town: "Post town",
  suburb: "Suburb",
  // Postal code.
  postal: "Postal code",
  zip: "ZIP code",
  eircode: "Eircode",
  pin: "PIN code",
  // Dependent locality, the line between the street and the town.
  neighborhood: "Neighborhood",
  townland: "Townland",
  village_township: "Village / township",
  // The fields whose name does not vary by country.
  country: "Country",
  addressLine1: "Address",
  addressLine2: "Address line 2",
  addressLine3: "Address line 3",
}

/** The letters `order` and `required` are written in, as the fields they stand for. */
const LETTER_FIELDS: Record<string, AddressField> = {
  D: "dependentLocality",
  C: "locality",
  S: "administrativeArea",
  Z: "postalCode",
}

const ADDRESS_LINES: AddressField[] = ["addressLine1", "addressLine2", "addressLine3"]

export type ResolvedAddressRule = {
  country: string
  /** Address fields in this country's order, as letters from `ADCSZ`. */
  order: string
  /** The subset of `order` that may not be left empty. */
  required: string
  labelTypes: { state: string; locality: string; postal: string; sub: string }
  /** The postal code's shape, unanchored, exactly as upstream writes it. */
  pattern?: string
  /** Whether this country writes its postal code in capitals. */
  upperPostal: boolean
}

/**
 * The rules for a country code, falling back to the default for one that is not in the table.
 *
 * Unknown codes resolve rather than throw, because a country list is a moving target and a form
 * that renders nothing is worse than one that asks for a street and a city. Case is normalised:
 * `autocomplete="country"` can hand back a lower-case code.
 */
export function rulesFor(country: string): ResolvedAddressRule {
  const code = (country ?? "").trim().toUpperCase()
  const rule = COUNTRY_RULES[code] ?? { order: DEFAULT_ORDER }
  return {
    country: code,
    order: rule.order,
    required: rule.required ?? DEFAULT_REQUIRED,
    labelTypes: {
      state: rule.state ?? DEFAULT_LABEL_TYPES.state,
      locality: rule.locality ?? DEFAULT_LABEL_TYPES.locality,
      postal: rule.postal ?? DEFAULT_LABEL_TYPES.postal,
      sub: rule.sub ?? DEFAULT_LABEL_TYPES.sub,
    },
    pattern: rule.pattern,
    upperPostal: rule.upperPostal === true,
  }
}

export type AddressFieldSpec = {
  field: AddressField
  label: string
  required: boolean
  /** The HTML autofill token, already carrying any section prefix. */
  autoComplete: string
  /** `numeric` only where the postal code cannot contain a letter. */
  inputMode?: "numeric"
  /** The postal code's shape, unanchored. Only ever set on `postalCode`. */
  pattern?: string
  /** Whether this field's value is conventionally written in capitals. */
  upper: boolean
}

export type AddressFieldsOptions = {
  /** How many street-address lines to render, 1 to 3. Defaults to 2. */
  addressLines?: 1 | 2 | 3
  /** Overrides for `FIELD_LABELS`, by name type or by field name. */
  labels?: Partial<Record<string, string>>
  /**
   * An autofill section, prefixed to every token: `"shipping"`, `"billing"`, or `"section-<name>"`.
   *
   * Without it, a page with a shipping *and* a billing address gives the browser two fields both
   * claiming to be `postal-code`, and it fills one of them — this is the whole reason the HTML
   * autofill grammar has a section prefix.
   */
  autoCompleteSection?: string
}

/**
 * Whether a postal code pattern can match something with a letter in it.
 *
 * Used only to pick the mobile keyboard, so a wrong answer costs a keyboard and not a value. The
 * test is deliberately crude: strip the escapes that *contain* letters without meaning one (`\d`,
 * `\s`) and see whether a letter survives. Japan's `\d{3}-?\d{4}` has none, the UK's has a hundred.
 */
function isDigitsOnly(pattern: string): boolean {
  return !/[A-Za-z]/.test(pattern.replace(/\\[dswDSWbB]/g, ""))
}

/**
 * The fields to render for a country, in order, with their labels, required flags and autofill
 * tokens.
 *
 * Exported because the layout is sometimes the caller's: a checkout that wants the postal code and
 * the city on one row, or a read-only summary that wants the same labels the form used, can read
 * the specs and lay them out itself rather than reimplementing the table.
 */
export function fieldsFor(country: string, options: AddressFieldsOptions = {}): AddressFieldSpec[] {
  const { addressLines = 2, labels, autoCompleteSection } = options
  const rule = rulesFor(country)
  const label = (key: string) => labels?.[key] ?? FIELD_LABELS[key] ?? key
  const token = (name: string) =>
    autoCompleteSection ? `${autoCompleteSection.trim()} ${name}` : name
  const specs: AddressFieldSpec[] = []

  for (const letter of rule.order) {
    if (letter === "A") {
      const count = Math.min(Math.max(addressLines, 1), 3)
      for (let i = 0; i < count; i += 1) {
        specs.push({
          field: ADDRESS_LINES[i],
          label: label(ADDRESS_LINES[i]),
          // Only the first line is ever required: the second is "Apartment 4B", and a country that
          // requires an address requires a street, not two lines of one.
          required: i === 0 && rule.required.includes("A"),
          // A single line is the whole street address; several are its numbered parts. Getting this
          // wrong is the difference between the browser filling one field and filling none.
          autoComplete: token(count === 1 ? "street-address" : `address-line${i + 1}`),
          upper: false,
        })
      }
      continue
    }
    const field = LETTER_FIELDS[letter]
    if (!field) continue
    if (field === "postalCode") {
      specs.push({
        field,
        label: label(rule.labelTypes.postal),
        required: rule.required.includes("Z"),
        autoComplete: token("postal-code"),
        inputMode: rule.pattern && isDigitsOnly(rule.pattern) ? "numeric" : undefined,
        pattern: rule.pattern,
        upper: rule.upperPostal,
      })
      continue
    }
    specs.push({
      field,
      label: label(
        field === "locality"
          ? rule.labelTypes.locality
          : field === "administrativeArea"
            ? rule.labelTypes.state
            : rule.labelTypes.sub
      ),
      required: rule.required.includes(letter),
      // The three levels below the country, outermost first. `address-level1` is the state even in
      // the countries that do not call it one, and `address-level3` is the line above the town.
      autoComplete: token(
        field === "locality"
          ? "address-level2"
          : field === "administrativeArea"
            ? "address-level1"
            : "address-level3"
      ),
      upper: false,
    })
  }
  return specs
}

/**
 * The anchored regular expression a country's postal code must match, or null where it has none.
 *
 * The wrapping `(?:…)` is not cosmetic. Several patterns upstream are a top-level alternation — the
 * UK's is `GIR ?0AA|(?:AB|AL|…)…|BFPO ?\d{1,4}` — so `^` and `$` written straight onto it would
 * anchor the first and last branch only, and `"nonsense GIR 0AA nonsense"` would pass. The group is
 * what makes the anchors apply to the whole thing.
 */
export function postalCodePattern(country: string): RegExp | null {
  const { pattern } = rulesFor(country)
  if (!pattern) return null
  try {
    return new RegExp(`^(?:${pattern})$`)
  } catch {
    return null
  }
}

/**
 * A postal code tidied the way the country writes it: trimmed, inner runs of space collapsed, and
 * capitalised only where upstream says that country capitalises it.
 *
 * Ireland is the case that explains the caveat: an Eircode is alphanumeric and is printed in
 * capitals, but upstream does not mark it `upper`, so this leaves `d02 af30` alone. Validation
 * upper-cases before matching regardless, so the value is accepted either way — what is not done
 * is overriding upstream on how it is written.
 */
export function normalizePostalCode(country: string, raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ")
  return rulesFor(country).upperPostal ? collapsed.toUpperCase() : collapsed
}

/**
 * Whether a postal code fits its country's shape. Empty is valid here — emptiness is the required
 * check's business, and a field that is both optional and malformed-when-empty cannot be left
 * alone.
 */
export function isValidPostalCode(country: string, raw: string): boolean {
  const value = raw.trim().replace(/\s+/g, " ")
  if (value === "") return true
  const pattern = postalCodePattern(country)
  if (!pattern) return true
  // Matched in capitals because the patterns are written in them and postal codes are not
  // case-sensitive anywhere; `sw1a 1aa` is a London postcode however it was typed.
  return pattern.test(value.toUpperCase())
}

export type AddressMessages = {
  required?: (label: string) => string
  invalid?: (label: string) => string
}

const DEFAULT_MESSAGES: Required<AddressMessages> = {
  required: (label) => `${label} is required`,
  invalid: (label) => `Enter a valid ${label}`,
}

/** A blank address for a country, ready to put in state. */
export function emptyAddress(country = ""): AddressValue {
  return {
    country,
    addressLine1: "",
    addressLine2: "",
    addressLine3: "",
    dependentLocality: "",
    locality: "",
    administrativeArea: "",
    postalCode: "",
  }
}

/**
 * The problems with an address, by field, empty when there are none.
 *
 * Only the fields the country actually uses are checked: a stale `administrativeArea` left over
 * from a different country is not an error here, because changing the country clears it. Exported
 * so a submit handler runs exactly what the fields showed on blur rather than a second opinion.
 */
export function validateAddress(
  value: AddressValue,
  options: AddressFieldsOptions & { messages?: AddressMessages } = {}
): Partial<Record<AddressField, string>> {
  const messages = { ...DEFAULT_MESSAGES, ...options.messages }
  const errors: Partial<Record<AddressField, string>> = {}
  for (const spec of fieldsFor(value.country, options)) {
    const raw = value[spec.field] ?? ""
    if (spec.required && raw.trim() === "") {
      errors[spec.field] = messages.required(spec.label)
      continue
    }
    if (spec.field === "postalCode" && !isValidPostalCode(value.country, raw)) {
      errors[spec.field] = messages.invalid(spec.label)
    }
  }
  return errors
}

const ADDRESS_FIELDS: AddressField[] = [
  ...ADDRESS_LINES,
  "dependentLocality",
  "locality",
  "administrativeArea",
  "postalCode",
]

/** Whether two addresses agree on every field, so a controlled re-render is not a change. */
function sameAddress(a: AddressValue, b: AddressValue): boolean {
  if (a.country !== b.country) return false
  return ADDRESS_FIELDS.every((field) => (a[field] ?? "") === (b[field] ?? ""))
}

/** Fills in whatever a caller left out, so the internal value always has every field. */
function completeAddress(partial: Partial<AddressValue> | undefined): AddressValue {
  return { ...emptyAddress(), ...partial } as AddressValue
}

export interface AddressInputProps {
  /** The address, when the parent owns it. Every field should be present; missing ones read empty. */
  value?: AddressValue
  defaultValue?: Partial<AddressValue>
  onChange?: (value: AddressValue) => void
  /** How many street-address lines to render, 1 to 3. Defaults to 2. */
  addressLines?: 1 | 2 | 3
  /** The countries to offer. Defaults to every country `country-select` knows. */
  countries?: readonly string[]
  /** Language for the country names. Left out, the runtime's own, resolved after mount. */
  locale?: string
  /** Overrides for `FIELD_LABELS`, by name type (`prefecture`) or field name (`addressLine1`). */
  labels?: Partial<Record<string, string>>
  messages?: AddressMessages
  /** An autofill section prefix: `"shipping"`, `"billing"`, `"section-<name>"`. */
  autoCompleteSection?: string
  /** Turns the administrative area into a select — pass the subdivisions you have. */
  administrativeAreaOptions?: readonly { value: string; label: string }[]
  /** Show every error at once, not only for fields that have been visited. For submit. */
  showErrors?: boolean
  /** An accessible name for the group of fields. Defaults to "Address". */
  legend?: string
  disabled?: boolean
  /** Prefix for each input's `name`, so the address posts with a plain form. */
  namePrefix?: string
  id?: string
  className?: string
}

/**
 * Renders the country's own address fields, in its own order, with its own labels.
 *
 * The country comes first regardless of where that country writes it, because it decides what the
 * rest of the form is: asking for it last means re-labelling and re-ordering fields the reader has
 * already filled in. It is a native `<select>` rather than this registry's `country-select`
 * deliberately — a custom combobox cannot be filled by the browser, and `autocomplete="country"` on
 * the field that determines every other field is worth more here than a searchable list. The
 * country *names* still come from `country-select`, so the spelling matches wherever both appear.
 */
export const AddressInput = React.forwardRef<HTMLDivElement, AddressInputProps>(
  function AddressInput(
    {
      value,
      defaultValue,
      onChange,
      addressLines = 2,
      countries,
      locale,
      labels,
      messages,
      autoCompleteSection,
      administrativeAreaOptions,
      showErrors = false,
      legend,
      disabled = false,
      namePrefix,
      id,
      className,
    },
    forwardedRef
  ) {
    const isControlled = value !== undefined
    const [fields, setFields] = React.useState<AddressValue>(() =>
      completeAddress(isControlled ? value : defaultValue)
    )
    const [touched, setTouched] = React.useState<Partial<Record<AddressField, boolean>>>({})

    const fieldsRef = React.useRef(fields)
    fieldsRef.current = fields

    // Re-seed from the prop only when it disagrees with what is on screen. A parent that rebuilds
    // the object on every render still passes an equal address, and echoing that back would reset
    // the field being typed in; comparing by field rather than by identity is what makes a
    // controlled address typable at all.
    React.useEffect(() => {
      // `value === undefined` is exactly `!isControlled`, so this is the whole guard — naming both
      // read as two checks and was one, which is how a mutation of either survived the suite.
      if (value === undefined) return
      const next = completeAddress(value)
      if (!sameAddress(next, fieldsRef.current)) setFields(next)
    }, [isControlled, value])

    const [mounted, setMounted] = React.useState(false)
    React.useEffect(() => {
      setMounted(true)
    }, [])
    // Country names are resolved after mount unless the caller pinned the language. The server's
    // locale is the server's, so `Intl.DisplayNames(undefined)` renders a different word on each
    // side of hydration; until then the options show their codes — present, correct, submittable.
    const namesReady = mounted || locale !== undefined

    const reactId = React.useId()
    const base = id ?? reactId
    const fieldId = (field: string) => `${base}-${field}`
    const errorId = (field: string) => `${base}-${field}-error`
    const legendId = `${base}-legend`

    const specs = React.useMemo(
      () => fieldsFor(fields.country, { addressLines, labels, autoCompleteSection }),
      [fields.country, addressLines, labels, autoCompleteSection]
    )

    const errors = React.useMemo(
      () => validateAddress(fields, { addressLines, labels, autoCompleteSection, messages }),
      [fields, addressLines, labels, autoCompleteSection, messages]
    )

    const countryLabel = labels?.country ?? FIELD_LABELS.country
    const options = React.useMemo(() => {
      const list = countries ?? COUNTRY_CODES
      if (!namesReady) return list.map((code) => ({ code, name: code }))
      const named = list.map((code) => ({ code, name: getCountryName(code, locale) }))
      // Sorted through a collator rather than by code point, which is the difference between a
      // usable list and a broken one: a plain sort drops every country whose name starts with an
      // accent — Åland Islands, Österreich — below Zimbabwe, where nobody scrolls.
      //
      // Constructed defensively because a malformed `locale` prop makes the constructor throw, and
      // an unordered list is a far smaller failure than a form that will not render at all.
      try {
        const collator = new Intl.Collator(locale)
        return named.sort((a, b) => collator.compare(a.name, b.name))
      } catch {
        return named
      }
    }, [countries, namesReady, locale])

    // One commit path, and it always writes the local state — the value carries every field, so a
    // half-filled address round-trips through a controlled parent without losing anything.
    function commit(next: AddressValue) {
      setFields(next)
      onChange?.(next)
    }

    function setField(field: AddressField, next: string) {
      commit({ ...fields, [field]: next })
    }

    /**
     * Changing the country clears the fields the new one does not have.
     *
     * The alternative — keeping them so switching back restores them — means the value carries a
     * US state while the address is in Hong Kong, and that is what eventually gets submitted. The
     * fields that survive are the ones both countries use, which is the common case of correcting
     * the country after the browser guessed wrong.
     */
    function changeCountry(nextCountry: string) {
      const keep = new Set(
        fieldsFor(nextCountry, { addressLines, labels, autoCompleteSection }).map((s) => s.field)
      )
      const next = emptyAddress(nextCountry)
      for (const field of ADDRESS_FIELDS) {
        if (keep.has(field)) next[field] = fields[field]
      }
      setTouched({})
      commit(next)
    }

    function blur(spec: AddressFieldSpec) {
      setTouched((t) => ({ ...t, [spec.field]: true }))
      if (spec.field !== "postalCode") return
      const tidied = normalizePostalCode(fields.country, fields.postalCode)
      if (tidied !== fields.postalCode) commit({ ...fields, postalCode: tidied })
    }

    return (
      <div
        ref={forwardedRef}
        role="group"
        aria-labelledby={legend ? legendId : undefined}
        aria-label={legend ? undefined : "Address"}
        className={cn("flex flex-col gap-4", className)}
      >
        {legend ? (
          <span id={legendId} className="text-sm font-medium">
            {legend}
          </span>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={fieldId("country")} className="text-sm font-medium">
            {countryLabel}
          </label>
          <select
            id={fieldId("country")}
            name={namePrefix ? `${namePrefix}.country` : undefined}
            value={fields.country}
            onChange={(event) => changeCountry(event.target.value)}
            disabled={disabled}
            autoComplete={
              autoCompleteSection ? `${autoCompleteSection.trim()} country` : "country"
            }
            aria-required={true}
            className={cn(
              "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            <option value="">{`Select a ${countryLabel.toLowerCase()}`}</option>
            {options.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </div>

        {specs.map((spec) => {
          const message = errors[spec.field]
          const show = Boolean(message) && (showErrors || touched[spec.field] === true)
          const isArea = spec.field === "administrativeArea"
          const shared = {
            id: fieldId(spec.field),
            name: namePrefix ? `${namePrefix}.${spec.field}` : undefined,
            value: fields[spec.field] ?? "",
            disabled,
            autoComplete: spec.autoComplete,
            "aria-required": spec.required,
            "aria-invalid": show ? true : undefined,
            "aria-describedby": show ? errorId(spec.field) : undefined,
            onBlur: () => blur(spec),
            className: cn(
              "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors",
              "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
              show && "border-destructive focus-visible:ring-destructive"
            ),
          }
          return (
            <div key={spec.field} className="flex flex-col gap-1.5">
              <label htmlFor={fieldId(spec.field)} className="text-sm font-medium">
                {spec.label}
                {spec.required ? null : (
                  <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
                )}
              </label>
              {isArea && administrativeAreaOptions ? (
                <select
                  {...shared}
                  onChange={(event) => setField(spec.field, event.target.value)}
                >
                  <option value="">{`Select a ${spec.label.toLowerCase()}`}</option>
                  {administrativeAreaOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...shared}
                  type="text"
                  inputMode={spec.inputMode}
                  autoCapitalize={spec.upper ? "characters" : undefined}
                  spellCheck={false}
                  onChange={(event) => setField(spec.field, event.target.value)}
                />
              )}
              {show ? (
                <p id={errorId(spec.field)} role="alert" className="text-sm text-destructive">
                  {message}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    )
  }
)
