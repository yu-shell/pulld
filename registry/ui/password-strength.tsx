import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Why this is not a checklist of "one uppercase, one digit, one symbol":
 * composition rules push people toward `Password1!`, which is trivially
 * guessable, while rejecting `correct horse battery staple`, which is not.
 * NIST SP 800-63B says the same thing — screen against known-bad passwords and
 * let length do the work. So the score here is an estimate of how many guesses
 * the password would survive, and the only hard rule is a minimum length.
 */

/** Why a password scored the way it did. Stable codes so the text can be translated. */
export type PasswordWarning =
  | "too-short"
  | "common"
  | "user-input"
  | "repeat"
  | "sequence"
  | "keyboard"
  | "year"

/** What to do about it. Stable codes so the text can be translated. */
export type PasswordSuggestion =
  | "longer"
  | "passphrase"
  | "avoid-common"
  | "avoid-personal"
  | "avoid-repeat"
  | "avoid-sequence"
  | "avoid-year"

export type PasswordFeedbackCode = PasswordWarning | PasswordSuggestion

export interface PasswordStrengthOptions {
  /**
   * Things a guesser already knows about this user or this site: their email,
   * username, display name, the product name. A password built out of them is
   * weak however random it looks, and this is the check hand-rolled meters
   * always miss.
   */
  userInputs?: string[]
  /**
   * Extra passwords to treat as known-bad, most guessable first — e.g. a slice
   * of a breach list you ship or fetch. Merged with the small built-in list.
   */
  blocklist?: string[]
  /** Below this the score is capped at 1, whatever the estimate says (default 8). */
  minLength?: number
}

export interface PasswordStrengthResult {
  /** 0 very weak … 4 very strong. */
  score: 0 | 1 | 2 | 3 | 4
  /** log10 of the estimated number of guesses needed. */
  guessesLog10: number
  /** Length in code points, so an emoji counts as one character. */
  length: number
  /** The single biggest weakness, or null when nothing cheap was found. */
  warning: PasswordWarning | null
  /** At most two, most useful first. */
  suggestions: PasswordSuggestion[]
}

/**
 * The passwords that appear at the top of every breach list, most common first —
 * the index is used as the rank, so `123456` costs fewer guesses than `monkey`.
 * Deliberately small: a real blocklist is megabytes and belongs behind an API,
 * which is what `blocklist` is for. This covers the ones that must never score
 * above "very weak" even when the page is offline.
 */
const COMMON =
  "123456 password 123456789 12345678 12345 qwerty 1234567 111111 1234567890 123123 abc123 1234 password1 iloveyou 000000 qwerty123 1q2w3e4r admin letmein welcome monkey dragon sunshine princess football baseball 654321 shadow master jennifer 111111111 superman qwertyuiop 123321 mustang 1qaz2wsx zaq12wsx asdfghjkl michael computer whatever passw0rd trustno1 batman jordan23 harley robert matthew daniel andrew lakers andrea buster joshua hunter ranger tigger soccer hockey killer george charlie dallas jessica pepper 1111 austin william golfer summer heather hammer yankees maggie biteme enter ashley thunder cowboy silver richard orange merlin michelle corvette bigdog cheese 121212 patrick martin freedom ginger nicole sparky yellow camaro secret falcon taylor 131313 hello scooter please porsche guitar chelsea black diamond nascar jackson cameron amanda wizard money phoenix mickey bailey knight iceman tigers purple dakota aaaaaa player morgan starwars boomer cowboys edward charles booboo coffee bulldog ncc1701 rabbit peanut johnny gandalf spanky winter brandy compaq carlos tennis james mike brandon fender anthony cookie chicken maverick chicago joseph diablo 666666 willie chris panther yamaha justin banana driver marine angels fishing david maddog wilson captain bigdaddy bronco voyager rangers birdie trouble white topgun green magic rachel slayer scott 2000 asdf video london 7777777 marlboro srinivas internet action carter jasper monster teresa jeremy 11111111 bill crystal peter pookie rascal stupid shannon murphy frank hannah dave eagle1 11111 mother nathan raiders steve forever angel viking root guest changeme qwe123 123qwe 1q2w3e 987654321 555555 abcd1234 welcome123 letmein123 iloveyou1 password123 test123 987654 112233 696969 pokemon starwars1 samsung google flower asdfgh zxcvbnm qwerty1 princess1 sunshine1"
    .split(" ")

/**
 * QWERTY rows, unshifted. A run along one of these (`asdfgh`, `zxcvbn`) reads as
 * random but is one of the first things a cracker tries.
 */
const KEYBOARD_ROWS = [
  "`1234567890-=",
  "qwertyuiop[]\\",
  "asdfghjkl;'",
  "zxcvbnm,./",
]

/** The substitutions people believe make a word unguessable. They do not. */
const LEET: Record<string, string> = {
  "0": "o",
  "1": "l",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l",
  "+": "t",
  "(": "c",
}

const unleet = (s: string) => s.replace(/[0-9@$!|+(]/g, (c) => LEET[c] ?? c)

/**
 * How many characters a brute-force attack would have to try per position. The
 * classes are added rather than maxed, because mixing them is what widens the
 * alphabet — one alphabet per class present, not per character.
 */
function alphabetSize(s: string) {
  let n = 0
  if (/[a-z]/.test(s)) n += 26
  if (/[A-Z]/.test(s)) n += 26
  if (/[0-9]/.test(s)) n += 10
  // Printable ASCII that is not a letter or a digit: the 33 punctuation keys.
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(s)) n += 33
  // Anything above ASCII. A flat 100 rather than "all of Unicode", because a
  // person reaching past ASCII picks from their own keyboard, not from 150,000
  // code points.
  if (/[^\x00-\x7f]/.test(s)) n += 100
  return Math.max(n, 1)
}

/**
 * `password` -> 1 guess, `Password` -> a few, `pAsSwOrD` -> more. Capitalising
 * the first letter or shouting the whole word are the two variants everyone
 * tries first, so they are nearly free; anything else is worth a little.
 */
function caseFactor(token: string) {
  if (!/[A-Z]/.test(token)) return 1
  if (/^[^a-z]*$/.test(token)) return 2
  if (/^.[^A-Z]*$/.test(token)) return 2
  return 8
}

interface Match {
  /** Start index, inclusive, in code points. */
  i: number
  /** End index, exclusive. */
  j: number
  warning: PasswordWarning
  /** log10 of the guesses this span costs on its own. */
  cost: number
}

const log10 = (n: number) => Math.log10(Math.max(n, 1))

/**
 * Every span of the password that a guesser gets cheaply. Overlaps are fine and
 * expected — the segmentation below picks whichever combination is cheapest,
 * which is the attacker's job, not ours.
 */
function findMatches(
  cps: string[],
  ranked: Map<string, number>,
  context: Set<string>,
  longestWord: number
): Match[] {
  const out: Match[] = []
  const n = cps.length

  // Dictionary and context. Both the literal text and its de-leeted form are
  // looked up, so `P@ssw0rd` is found where `password` is.
  //
  // Spans longer than the longest word anyone is looking for cannot match, and
  // skipping them is what keeps this off the critical path: it runs on every
  // keystroke of a controlled input, and the unbounded version cost 22ms on a
  // pasted 128-character string — long enough to drop frames while typing.
  for (let i = 0; i < n; i++) {
    let token = ""
    const last = Math.min(n, i + longestWord)
    for (let j = i; j < last; j++) {
      token += cps[j]
      if (token.length < 3) continue
      const lower = token.toLowerCase()
      const plain = ranked.get(lower)
      const folded = ranked.get(unleet(lower))
      const rank = Math.min(plain ?? Infinity, folded ?? Infinity)
      const leetFactor = plain === undefined && folded !== undefined ? 4 : 1
      if (Number.isFinite(rank)) {
        out.push({
          i,
          j: j + 1,
          warning: "common",
          cost: log10(rank * caseFactor(token) * leetFactor),
        })
      }
      if (context.has(lower) || context.has(unleet(lower))) {
        // Known to whoever is attacking this account, so effectively free.
        out.push({ i, j: j + 1, warning: "user-input", cost: log10(caseFactor(token)) })
      }
    }
  }

  // Maximal runs of one repeated character.
  for (let i = 0; i < n; ) {
    let j = i + 1
    while (j < n && cps[j] === cps[i]) j++
    if (j - i >= 3) {
      out.push({
        i,
        j,
        warning: "repeat",
        cost: log10(alphabetSize(cps[i]) * (j - i)),
      })
    }
    i = j
  }

  // Maximal runs stepping by one through the alphabet or the digits, either way.
  for (let i = 0; i < n; ) {
    let j = i + 1
    let step = 0
    while (j < n && sameClass(cps[i], cps[j])) {
      const delta = cps[j].codePointAt(0)! - cps[j - 1].codePointAt(0)!
      if (delta !== 1 && delta !== -1) break
      if (step === 0) step = delta
      else if (delta !== step) break
      j++
    }
    if (j - i >= 3) {
      const base = /[0-9]/.test(cps[i]) ? 10 : 26
      out.push({ i, j, warning: "sequence", cost: log10(base * (j - i) * 2) })
    }
    i = Math.max(j - 1, i + 1)
  }

  // Runs along one row of the keyboard, either direction.
  for (let i = 0; i < n; i++) {
    for (const row of KEYBOARD_ROWS) {
      let j = i + 1
      let step = 0
      while (j < n) {
        const a = row.indexOf(cps[j - 1].toLowerCase())
        const b = row.indexOf(cps[j].toLowerCase())
        if (a < 0 || b < 0) break
        const delta = b - a
        if (delta !== 1 && delta !== -1) break
        if (step === 0) step = delta
        else if (delta !== step) break
        j++
      }
      if (j - i >= 3) {
        out.push({ i, j, warning: "keyboard", cost: log10(10 * (j - i) * 2) })
      }
    }
  }

  // Digit runs people pick from a calendar rather than at random. A year is the
  // common case (`Acme2026!`); six or eight digits are dated well below their
  // brute-force cost because a date is what they nearly always are. Where that
  // guess is wrong the password is only reported as weaker than it is, which is
  // the safe direction for a meter to be wrong in.
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && /[0-9]/.test(cps[j])) j++
    const len = j - i
    if (len === 4) {
      const year = Number(cps.slice(i, j).join(""))
      if (year >= 1900 && year <= 2099) {
        out.push({ i, j, warning: "year", cost: log10(200) })
      }
    } else if (len === 6 || len === 8) {
      out.push({ i, j, warning: "year", cost: log10(36500) })
    }
    i = Math.max(j, i + 1)
  }

  return out
}

/** Two characters are comparable as a sequence only within one alphabet. */
function sameClass(a: string, b: string) {
  if (/[0-9]/.test(a)) return /[0-9]/.test(b)
  if (/[a-z]/.test(a)) return /[a-z]/.test(b)
  if (/[A-Z]/.test(a)) return /[A-Z]/.test(b)
  return false
}

/**
 * Only the first 128 code points are segmented. Beyond that the cost is already
 * astronomical and the O(n²) search is not worth running on a pasted file.
 */
const SCORED_LENGTH = 128

/**
 * Estimate how many guesses a password would survive. Pure and synchronous, so
 * it can gate a submit button as well as drive the meter:
 *
 * ```ts
 * const { score } = estimatePasswordStrength(password, { userInputs: [email] })
 * <Button disabled={score < 2}>Create account</Button>
 * ```
 */
export function estimatePasswordStrength(
  password: string,
  options: PasswordStrengthOptions = {}
): PasswordStrengthResult {
  const { userInputs = [], blocklist = [], minLength = 8 } = options
  const text = typeof password === "string" ? password : ""
  const all = Array.from(text)
  const cps = all.slice(0, SCORED_LENGTH)
  const n = cps.length

  if (n === 0) {
    return { score: 0, guessesLog10: 0, length: 0, warning: null, suggestions: [] }
  }

  // Rank is a word's position in whichever list ranks it highest, not its
  // position in the two lists concatenated. Concatenating meant that passing a
  // large blocklist pushed the built-in entries down past its length — hand it
  // ten thousand breached passwords and `password` stopped scoring as one.
  const ranked = new Map<string, number>()
  for (const list of [blocklist, COMMON]) {
    for (let k = 0; k < list.length; k++) {
      const word = String(list[k] ?? "").toLowerCase()
      if (!word) continue
      const rank = k + 1
      const seen = ranked.get(word)
      if (seen === undefined || rank < seen) ranked.set(word, rank)
    }
  }

  // An email is not guessed whole — its pieces are. `jane.doe@acme.com` puts
  // jane, doe and acme in play as much as the address itself, and so does
  // janedoe, which is what the separators were hiding.
  const context = new Set<string>()
  for (const input of userInputs) {
    const value = String(input ?? "").toLowerCase()
    for (const part of [value, value.replace(/[^a-z0-9]+/g, ""), ...value.split(/[^a-z0-9]+/)]) {
      if (part.length >= 3) context.add(part)
    }
  }

  // Bound for the substring scan. Measured in UTF-16 units, which never
  // undercounts code points, so no match can be skipped by it.
  let longestWord = 0
  for (const word of ranked.keys()) longestWord = Math.max(longestWord, word.length)
  for (const word of context) longestWord = Math.max(longestWord, word.length)

  const perChar = log10(alphabetSize(text))
  const matches = findMatches(cps, ranked, context, longestWord)
  const endingAt: Match[][] = Array.from({ length: n + 1 }, () => [])
  for (const m of matches) endingAt[m.j].push(m)

  // Cheapest way to spell the password out of the spans above, brute-forcing
  // whatever is left over. Segment count is not penalised, so a password built
  // of many cheap pieces is if anything under-rated — again, the safe direction.
  const best = new Array<number>(n + 1).fill(Infinity)
  const via = new Array<Match | null>(n + 1).fill(null)
  const from = new Array<number>(n + 1).fill(0)
  best[0] = 0
  for (let i = 1; i <= n; i++) {
    best[i] = best[i - 1] + perChar
    from[i] = i - 1
    for (const m of endingAt[i]) {
      const total = best[m.i] + m.cost
      if (total < best[i]) {
        best[i] = total
        from[i] = m.i
        via[i] = m
      }
    }
  }

  const guessesLog10 = best[n] + (all.length - n) * perChar

  let score: PasswordStrengthResult["score"] =
    guessesLog10 < 3 ? 0 : guessesLog10 < 6 ? 1 : guessesLog10 < 8 ? 2 : guessesLog10 < 10 ? 3 : 4

  // The widest span the segmentation actually used — the part of the password
  // that is carrying the least weight.
  let weakest: Match | null = null
  for (let i = n; i > 0; i = from[i]) {
    const m = via[i]
    if (m && (!weakest || m.j - m.i > weakest.j - weakest.i)) weakest = m
  }

  let warning: PasswordWarning | null = weakest ? weakest.warning : null
  if (all.length < minLength) {
    // Saying "Fair" about something the form is going to reject is worse than
    // saying nothing, so length overrides the estimate rather than adding to it.
    warning = "too-short"
    if (score > 1) score = 1
  }

  const suggestions: PasswordSuggestion[] = []
  const add = (s: PasswordSuggestion) => {
    if (!suggestions.includes(s)) suggestions.push(s)
  }
  if (warning === "too-short") add("longer")
  else if (warning === "common") {
    add("avoid-common")
    add("passphrase")
  } else if (warning === "user-input") add("avoid-personal")
  else if (warning === "repeat") add("avoid-repeat")
  else if (warning === "sequence" || warning === "keyboard") add("avoid-sequence")
  else if (warning === "year") add("avoid-year")
  if (score < 3) add(warning ? "longer" : "passphrase")

  return {
    score,
    guessesLog10,
    length: all.length,
    warning,
    suggestions: suggestions.slice(0, 2),
  }
}

/** Band names, weakest first. Replace with your own to translate the meter. */
export const passwordStrengthLabels = [
  "Very weak",
  "Weak",
  "Fair",
  "Strong",
  "Very strong",
] as const

/** English text for every feedback code. Pass `messages` to override any of them. */
export const passwordStrengthMessages: Record<PasswordFeedbackCode, string> = {
  "too-short": "This password is too short.",
  common: "This is one of the most commonly used passwords.",
  "user-input": "This looks like your name, your email, or this site.",
  repeat: "Repeated characters like “aaa” are quick to guess.",
  sequence: "Runs like “abc” or “123” are quick to guess.",
  keyboard: "Keyboard patterns like “qwerty” are quick to guess.",
  year: "Dates and years are quick to guess.",
  longer: "Add a few more characters — length beats symbols.",
  passphrase: "A few unrelated words are strong and easy to remember.",
  "avoid-common": "Pick something that is not on every leaked-password list.",
  "avoid-personal": "Avoid your name, your email, and this site’s name.",
  "avoid-repeat": "Avoid repeating the same character.",
  "avoid-sequence": "Avoid straight runs from the alphabet or the keyboard.",
  "avoid-year": "Avoid birthdays and years.",
}

/** Bar colour per score, weakest first. */
const BAR_CLASSES = [
  "bg-destructive",
  "bg-destructive",
  "bg-amber-500 dark:bg-amber-400",
  "bg-emerald-600 dark:bg-emerald-500",
  "bg-emerald-600 dark:bg-emerald-500",
] as const

const TEXT_CLASSES = [
  "text-destructive",
  "text-destructive",
  "text-amber-600 dark:text-amber-400",
  "text-emerald-600 dark:text-emerald-400",
  "text-emerald-600 dark:text-emerald-400",
] as const

interface PasswordStrengthProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children">,
    PasswordStrengthOptions {
  /** The password to score. Render this next to your own input; it never renders the value. */
  value: string
  /** Show the band name beside the bars (default true). */
  showLabel?: boolean
  /** Show one line of advice under the bars (default true). */
  showFeedback?: boolean
  /** Band names, weakest first — pass translated strings here. */
  labels?: readonly string[]
  /** Override any of the feedback strings, e.g. to translate them. */
  messages?: Partial<Record<PasswordFeedbackCode, string>>
  /** Accessible name for the meter (default "Password strength"). */
  "aria-label"?: string
}

/**
 * A strength meter for a password field. Reads `value`, never renders it.
 *
 * It uses no hooks, so it works in a server component and needs no `"use client"`
 * of its own — the client boundary stays on whatever owns the password state.
 *
 * The band name is the only thing in the live region, so a screen reader hears
 * "Weak" once when the password crosses into weak and stays quiet for the
 * keystrokes in between. The advice line is deliberately left out of it — it can
 * change on any keystroke, and announcing it would talk over the typing. Give
 * the component an `id` and the advice is tied to the meter with
 * aria-describedby as well; without one it is read in document order.
 */
export const PasswordStrength = React.forwardRef<
  HTMLDivElement,
  PasswordStrengthProps
>(function PasswordStrength(
  {
    className,
    value,
    userInputs,
    blocklist,
    minLength,
    showLabel = true,
    showFeedback = true,
    labels = passwordStrengthLabels,
    messages,
    "aria-label": ariaLabel = "Password strength",
    id,
    ...props
  },
  ref
) {
  const text = typeof value === "string" ? value : ""
  const { score, warning, suggestions } = estimatePasswordStrength(text, {
    userInputs,
    blocklist,
    minLength,
  })
  const empty = text.length === 0
  const label = labels[score] ?? passwordStrengthLabels[score]
  const say = (code: PasswordFeedbackCode) =>
    messages?.[code] ?? passwordStrengthMessages[code]

  const advice = empty
    ? ""
    : [warning, suggestions[0]]
        .filter((code): code is PasswordFeedbackCode => Boolean(code))
        .map(say)
        .join(" ")

  // Both bands at the bottom light one bar: "very weak" and "weak" differ in what
  // they are called, not in how full the meter looks.
  const filled = empty ? 0 : Math.max(score, 1)

  // Only wired up when the caller gave the component an id to derive one from; a
  // dangling aria-describedby is worse than none. Without it the advice is still
  // read out, just in document order rather than together with the meter.
  const showAdvice = showFeedback && advice !== ""
  const adviceId = id && showAdvice ? `${id}-advice` : undefined

  return (
    <div ref={ref} id={id} className={cn("flex flex-col gap-1.5", className)} {...props}>
      <div
        role="meter"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={4}
        aria-valuenow={score}
        aria-valuetext={empty ? "No password entered" : label}
        aria-describedby={adviceId}
        className="flex h-1.5 w-full gap-1"
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              "h-full flex-1 rounded-full bg-muted transition-colors",
              i < filled && BAR_CLASSES[score]
            )}
          />
        ))}
      </div>

      {showLabel ? (
        <span
          aria-hidden="true"
          className={cn(
            "min-h-4 text-xs font-medium",
            empty ? "text-muted-foreground" : TEXT_CLASSES[score]
          )}
        >
          {empty ? "" : label}
        </span>
      ) : null}

      {/* The only thing announced, and it changes only when the band does. */}
      <span className="sr-only" aria-live="polite">
        {empty ? "" : `${ariaLabel}: ${label}`}
      </span>

      {showAdvice ? (
        <p id={adviceId} className="text-xs text-muted-foreground">
          {advice}
        </p>
      ) : null}
    </div>
  )
})
