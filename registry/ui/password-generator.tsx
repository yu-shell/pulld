"use client"

import * as React from "react"
import { RefreshCw } from "lucide-react"

import { cn } from "@/lib/utils"
import { CopyButton } from "@/registry/ui/copy-button"

/**
 * The pools a generated password draws from, one per class the user can switch on.
 *
 * The symbol pool is deliberately not "every printable punctuation mark". It leaves out the quote,
 * backtick, backslash, space, slash and angle brackets — the characters most often stripped by a
 * signup form's own input filter, and the ones that turn a password into a quoting problem the
 * moment it travels through a shell command, a CSV export or an HTML attribute. A password the user
 * cannot paste back in is worse than a slightly smaller alphabet: 23 symbols still buy 4.5 bits per
 * character, and the length control buys bits far more cheaply than exotic punctuation does.
 */
export const CHARACTER_POOLS = {
  lowercase: "abcdefghijklmnopqrstuvwxyz",
  uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  digits: "0123456789",
  symbols: "!@#$%^&*()-_=+[]{}:;,.?",
} as const

/** One switchable class of characters. */
export type CharacterClass = keyof typeof CHARACTER_POOLS

/** The order the classes are offered in, and the order required characters are drawn in. */
export const CHARACTER_CLASSES = Object.keys(CHARACTER_POOLS) as CharacterClass[]

/**
 * The characters that collide with another character in most UI fonts.
 *
 * Excluding them is for passwords that get read off one screen and typed into another — a router
 * label, a printed voucher, a password dictated over a phone call. It costs entropy (the alphabet
 * drops from 85 to 80 characters, about 0.09 bits each), so it is off by default and worth turning
 * on only when a human eye is in the loop.
 */
export const AMBIGUOUS_CHARACTERS = "0O1lI"

/**
 * Supplies uniformly distributed 32-bit values. Only exists so the generator can be tested against
 * a known sequence; production callers should leave it alone and get `crypto.getRandomValues`.
 */
export type RandomSource = (count: number) => Uint32Array

/**
 * Draws from the platform CSPRNG.
 *
 * Web Crypto refuses a single request larger than 65536 bytes, which is 16384 uint32s. Nothing here
 * comes close: the drawer below refills in fixed batches of 64 regardless of how long the password
 * is, so the cap is a fact about the platform rather than a case this function has to handle.
 */
const defaultRandom: RandomSource = (count) => {
  const values = new Uint32Array(count)
  crypto.getRandomValues(values)
  return values
}

/**
 * Returns a function giving uniform integers in `[0, bound)`, buffering its draws.
 *
 * The reason this is not `value % bound` is modulo bias. 2^32 is not divisible by 85, so the low
 * remainder values would come up marginally more often than the high ones — a real, if small, tilt
 * that a generator has no excuse for. Values at or above the largest exact multiple of `bound` are
 * thrown away and redrawn instead. With a 32-bit draw the rejection probability is about one in a
 * hundred million per character, so the loop is a correctness statement far more than a cost.
 */
function createIndexDrawer(random: RandomSource) {
  let buffer: Uint32Array = new Uint32Array(0)
  let cursor = 0

  const nextValue = () => {
    if (cursor >= buffer.length) {
      buffer = random(64)
      cursor = 0
    }
    return buffer[cursor++]
  }

  return (bound: number) => {
    const limit = 2 ** 32 - (2 ** 32 % bound)
    let value = nextValue()
    while (value >= limit) value = nextValue()
    return value % bound
  }
}

/** How a password should be put together. */
export interface GeneratePasswordOptions {
  /** How many characters to produce. */
  length?: number
  /** Which classes may appear. An empty list is rejected — there would be nothing to draw from. */
  classes?: CharacterClass[]
  /** Drop the characters that look alike in most fonts (see {@link AMBIGUOUS_CHARACTERS}). */
  excludeAmbiguous?: boolean
  /** Guarantee at least one character from every enabled class. */
  requireEachClass?: boolean
  /** Replaces the built-in symbol pool, for a site that rejects some of it. */
  symbolSet?: string
  /** Test seam. Defaults to `crypto.getRandomValues`. */
  random?: RandomSource
}

/** The pools actually in play for a set of options, already filtered, in class order. */
export function buildPools({
  classes = CHARACTER_CLASSES,
  excludeAmbiguous = false,
  symbolSet,
}: Pick<GeneratePasswordOptions, "classes" | "excludeAmbiguous" | "symbolSet"> = {}): string[] {
  const enabled = CHARACTER_CLASSES.filter((name) => classes.includes(name))
  return enabled
    .map((name) => {
      const pool = name === "symbols" && symbolSet !== undefined ? symbolSet : CHARACTER_POOLS[name]
      return excludeAmbiguous
        ? Array.from(pool)
            .filter((character) => !AMBIGUOUS_CHARACTERS.includes(character))
            .join("")
        : pool
    })
    .filter((pool) => pool.length > 0)
}

/**
 * Builds one password.
 *
 * Two things here are easy to get subtly wrong, and both are the reason to install this rather than
 * write it inline:
 *
 * 1. **The source.** `Math.random` is a fast PRNG, not a secret one — its state is recoverable from
 *    its own output, so a password built from it is not unguessable. This draws from the platform
 *    CSPRNG, without modulo bias (see {@link createIndexDrawer}).
 * 2. **The class guarantee.** The obvious way to honour "must contain a digit" is to overwrite a
 *    fixed position with one, which tells an attacker where the digit is and shrinks the search.
 *    Instead one character is drawn from each required pool, the rest from the whole alphabet, and
 *    the result is shuffled with a Fisher-Yates pass whose indices come from the same unbiased
 *    drawer — so no position is special.
 *
 * Requiring each class does narrow the space slightly, by excluding the strings that miss a class.
 * At the lengths this is used for the difference is far below a bit; {@link entropyBits} reports the
 * uniform-draw figure and its doc says so.
 *
 * @throws If no class is enabled, or if `length` is too small to hold one character per required
 * class — both are caller mistakes with no sensible silent fallback.
 */
export function generatePassword({
  length = 20,
  classes = CHARACTER_CLASSES,
  excludeAmbiguous = false,
  requireEachClass = true,
  symbolSet,
  random = defaultRandom,
}: GeneratePasswordOptions = {}): string {
  const pools = buildPools({ classes, excludeAmbiguous, symbolSet })
  if (pools.length === 0) throw new Error("generatePassword: no character class is enabled")
  if (requireEachClass && length < pools.length) {
    throw new Error(
      `generatePassword: length ${length} cannot hold one character from each of ${pools.length} classes`
    )
  }

  const alphabet = pools.join("")
  const drawIndex = createIndexDrawer(random)
  const characters: string[] = []

  if (requireEachClass) {
    for (const pool of pools) characters.push(pool[drawIndex(pool.length)])
  }
  while (characters.length < length) {
    characters.push(alphabet[drawIndex(alphabet.length)])
  }

  for (let i = characters.length - 1; i > 0; i--) {
    const j = drawIndex(i + 1)
    const swap = characters[i]
    characters[i] = characters[j]
    characters[j] = swap
  }

  return characters.join("")
}

/**
 * Bits of entropy in a uniformly drawn password of `length` over an alphabet of `alphabetSize`.
 *
 * This is the honest measure for a *generated* password and it is not the same question
 * `password-strength` answers. That component scores a password a person chose, where the length
 * and the alphabet say almost nothing — `Password1!` and a random ten-character string share both
 * and are nowhere near each other. Here the draw really is uniform, so the arithmetic holds.
 */
export function entropyBits(length: number, alphabetSize: number): number {
  if (length <= 0 || alphabetSize <= 1) return 0
  return length * Math.log2(alphabetSize)
}

const CLASS_LABELS: Record<CharacterClass, string> = {
  lowercase: "Lowercase",
  uppercase: "Uppercase",
  digits: "Digits",
  symbols: "Symbols",
}

export interface PasswordGeneratorProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "onChange"> {
  /** Controlled password. Leave unset to let the component hold its own. */
  value?: string
  /** Called with every newly generated password. */
  onValueChange?: (password: string) => void
  /** Starting length. Clamped into `[minLength, maxLength]`. */
  defaultLength?: number
  /** Shortest the length control will go. Raised to the number of enabled classes when required. */
  minLength?: number
  /** Longest the length control will go. */
  maxLength?: number
  /** Classes switched on to begin with. */
  defaultClasses?: CharacterClass[]
  /** Start with look-alike characters excluded. */
  defaultExcludeAmbiguous?: boolean
  /** Guarantee one character from each enabled class. */
  requireEachClass?: boolean
  /** Replaces the built-in symbol pool. */
  symbolSet?: string
  /** Produce a password on mount. Turn off to start empty. */
  autoGenerate?: boolean
  /** Show the character count and entropy under the field. */
  showEntropy?: boolean
}

/**
 * A password generator: a read-only field holding the password, a control to draw a new one, a copy
 * button, and the switches that decide what it is made of.
 *
 * The first password is produced in an effect rather than during render, because a value drawn while
 * rendering would differ between the server pass and the client pass and React would report a
 * hydration mismatch — the one bug that makes a generator look broken in a Next.js app while working
 * perfectly in isolation.
 *
 * The generated password is never announced aloud. Regenerating announces only that it happened; the
 * value itself is left to be read from the field, so a screen reader does not speak a fresh secret
 * into a room the moment a button is pressed.
 */
export function PasswordGenerator({
  value,
  onValueChange,
  defaultLength = 20,
  minLength = 8,
  maxLength = 64,
  defaultClasses = CHARACTER_CLASSES,
  defaultExcludeAmbiguous = false,
  requireEachClass = true,
  symbolSet,
  autoGenerate = true,
  showEntropy = true,
  className,
  ...props
}: PasswordGeneratorProps) {
  const fieldId = React.useId()
  const lengthId = React.useId()

  const [internalValue, setInternalValue] = React.useState("")
  const [classes, setClasses] = React.useState<CharacterClass[]>(() =>
    CHARACTER_CLASSES.filter((name) => defaultClasses.includes(name))
  )
  const [excludeAmbiguous, setExcludeAmbiguous] = React.useState(defaultExcludeAmbiguous)
  const [generation, setGeneration] = React.useState(0)

  const isControlled = value !== undefined
  const password = isControlled ? value : internalValue

  const pools = buildPools({ classes, excludeAmbiguous, symbolSet })
  const alphabetSize = pools.reduce((total, pool) => total + pool.length, 0)

  // A required class needs a slot, so the floor is whichever is larger. Without this the length
  // control could ask for a password `generatePassword` is right to refuse.
  const lowestLength = Math.max(minLength, requireEachClass ? pools.length : 1)
  const highestLength = Math.max(lowestLength, maxLength)
  const [length, setLength] = React.useState(() =>
    Math.min(Math.max(defaultLength, minLength), maxLength)
  )
  const effectiveLength = Math.min(Math.max(length, lowestLength), highestLength)

  const regenerate = () => {
    const next = generatePassword({
      length: effectiveLength,
      classes,
      excludeAmbiguous,
      requireEachClass,
      symbolSet,
    })
    // A controlled parent owns the value; it still gets told, it just is not overwritten here.
    if (!isControlled) setInternalValue(next)
    onValueChange?.(next)
    setGeneration((count) => count + 1)
  }

  // Guarded by a ref rather than by an effect's dependency list: deps say when React *may* re-run an
  // effect, not when it must, and "exactly once, after mount" is a claim the component should make
  // for itself rather than borrow from the scheduler.
  const hasAutoGenerated = React.useRef(false)
  React.useEffect(() => {
    if (hasAutoGenerated.current || !autoGenerate) return
    hasAutoGenerated.current = true
    regenerate()
  })

  const toggleClass = (name: CharacterClass) => {
    setClasses((current) =>
      current.includes(name)
        ? current.filter((entry) => entry !== name)
        : CHARACTER_CLASSES.filter((entry) => entry === name || current.includes(entry))
    )
  }

  const bits = Math.round(entropyBits(effectiveLength, alphabetSize))

  return (
    <div className={cn("flex w-full flex-col gap-4", className)} {...props}>
      <div className="flex items-center gap-2">
        <input
          id={fieldId}
          readOnly
          value={password}
          type="text"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label="Generated password"
          placeholder="Press Generate"
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm text-foreground shadow-sm placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <CopyButton value={password} disabled={password.length === 0} className="h-9 w-9 shrink-0" />
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <label htmlFor={lengthId} className="text-sm font-medium text-foreground">
            Length
          </label>
          <span className="font-mono text-sm tabular-nums text-muted-foreground">
            {effectiveLength}
          </span>
        </div>
        {/* Left as the browser draws it. `accent-color` (Tailwind's `accent-*`) themes a native range
            and checkbox from the shadcn palette in both light and dark; `appearance-none` would turn
            that styling off and take the thumb with it unless a ::-webkit-slider-thumb rule replaced
            it, which is a lot of vendor CSS to own for no gain. */}
        <input
          id={lengthId}
          type="range"
          min={lowestLength}
          max={highestLength}
          step={1}
          value={effectiveLength}
          onChange={(event) => setLength(Number(event.target.value))}
          className="w-full cursor-pointer accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Characters to include</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {CHARACTER_CLASSES.map((name) => {
            const checked = classes.includes(name)
            // The last class on cannot be switched off: an empty alphabet has nothing to draw from,
            // and disabling the control says so more plainly than an error appearing afterwards.
            const isLastEnabled = checked && classes.length === 1
            return (
              <label
                key={name}
                className={cn(
                  "flex items-center gap-2 text-sm text-foreground",
                  isLastEnabled && "opacity-60"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLastEnabled}
                  onChange={() => toggleClass(name)}
                  className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                />
                {CLASS_LABELS[name]}
              </label>
            )
          })}
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={excludeAmbiguous}
              onChange={(event) => setExcludeAmbiguous(event.target.checked)}
              className="h-4 w-4 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            No look-alikes
          </label>
        </div>
      </fieldset>

      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={regenerate}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Generate
        </button>
        {showEntropy ? (
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums">{effectiveLength}</span> characters ·{" "}
            <span className="tabular-nums">{bits}</span> bits
          </p>
        ) : null}
      </div>

      {/* Re-keyed on purpose: a live region only speaks when its content changes, and "New password
          generated" is the same sentence every time. Replacing the node is the mutation. */}
      <div aria-live="polite" className="sr-only">
        {generation > 0 ? <span key={generation}>New password generated</span> : null}
      </div>
    </div>
  )
}
