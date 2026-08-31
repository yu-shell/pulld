// A password generator is one of the few components where "it looks right" and "it is right" come
// apart completely: every wrong implementation below produces output that reads as a fine password.
//
// So the tests here are written to fail against the specific wrong versions, not just to describe
// the happy path:
//   - modulo folding instead of rejection sampling (biased, but the passwords look identical),
//   - overwriting fixed positions to satisfy "must contain a digit" (predictable, looks identical),
//   - forgetting to filter a pool before drawing the required character from it.
// Each of those gets a case below that a correct implementation passes and that version fails.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

/** Stands in for the composed copy button so its props can be read off the tree. */
function CopyButtonStub() {
  return null
}

const {
  generatePassword,
  buildPools,
  entropyBits,
  PasswordGenerator,
  CHARACTER_POOLS,
  CHARACTER_CLASSES,
  AMBIGUOUS_CHARACTERS,
} = loadComponent(join(ROOT, "registry", "ui", "password-generator.tsx"), {
  stubs: {
    "lucide-react": icons,
    "@/registry/ui/copy-button": { CopyButton: CopyButtonStub },
  },
})

/** A random source that hands back exactly the values given, and refuses to invent more. */
function scripted(values) {
  let used = false
  return () => {
    if (used) throw new Error("the generator asked for more randomness than the script supplied")
    used = true
    return Uint32Array.from(values)
  }
}

const TWO_32 = 2 ** 32

test("every character comes from the requested alphabet, at the requested length", () => {
  const alphabet = CHARACTER_POOLS.lowercase + CHARACTER_POOLS.digits
  for (let i = 0; i < 50; i++) {
    const password = generatePassword({ length: 24, classes: ["lowercase", "digits"] })
    assert.equal(password.length, 24)
    for (const character of password) {
      assert.ok(alphabet.includes(character), `"${character}" is outside the requested alphabet`)
    }
  }
})

test("a value above the last exact multiple is redrawn, not folded", () => {
  // Ten digits into 2^32 leaves a remainder of 6, so the top six values are the biased ones. Folding
  // 4294967293 with % would yield "3"; rejecting it and taking the next value yields "7".
  const bound = 10
  const limit = TWO_32 - (TWO_32 % bound)
  assert.equal(TWO_32 % bound, 6, "this case only means something while the remainder is non-zero")

  const password = generatePassword({
    length: 1,
    classes: ["digits"],
    random: scripted([limit + 3, 7]),
  })
  assert.equal(password, "7", "a biased value was folded into the alphabet instead of being redrawn")
})

test("a value below the limit is used as it stands", () => {
  const password = generatePassword({ length: 1, classes: ["digits"], random: scripted([7]) })
  assert.equal(password, "7")
})

test("a required class does not land on a fixed position", () => {
  // Four classes and a length of four means exactly one character per class, so if the required
  // characters were written into fixed slots the uppercase letter would sit at the same index every
  // time. Across 200 draws a shuffled result visits every position.
  const positions = new Set()
  for (let i = 0; i < 200; i++) {
    const password = generatePassword({ length: 4, requireEachClass: true })
    const index = Array.from(password).findIndex((character) =>
      CHARACTER_POOLS.uppercase.includes(character)
    )
    assert.notEqual(index, -1, "the uppercase class was required but is missing")
    positions.add(index)
  }
  assert.equal(positions.size, 4, `the required character only ever appeared at ${[...positions]}`)
})

test("every enabled class shows up when each one is required", () => {
  for (let i = 0; i < 50; i++) {
    const password = generatePassword({ length: 8, requireEachClass: true })
    for (const name of CHARACTER_CLASSES) {
      const pool = CHARACTER_POOLS[name]
      assert.ok(
        Array.from(password).some((character) => pool.includes(character)),
        `${name} was required but "${password}" has none`
      )
    }
  }
})

test("without the requirement a class may legitimately be missing", () => {
  // The point is that the requirement is doing work, not that absence is desirable.
  const seenWithout = new Set()
  for (let i = 0; i < 200; i++) {
    const password = generatePassword({ length: 4, requireEachClass: false })
    seenWithout.add(CHARACTER_CLASSES.every((name) =>
      Array.from(password).some((character) => CHARACTER_POOLS[name].includes(character))
    ))
  }
  assert.ok(seenWithout.has(false), "requireEachClass:false still forced every class in")
})

test("look-alike characters are dropped from the required draw too, not just the filler", () => {
  // Filtering the joined alphabet but drawing the required character from the unfiltered pool is an
  // easy miss: it leaks exactly one look-alike, and only sometimes.
  for (let i = 0; i < 200; i++) {
    const password = generatePassword({ length: 6, excludeAmbiguous: true, requireEachClass: true })
    for (const character of password) {
      assert.ok(
        !AMBIGUOUS_CHARACTERS.includes(character),
        `"${character}" is a look-alike and should have been excluded`
      )
    }
  }
})

test("a custom symbol set replaces the built-in one", () => {
  const password = generatePassword({ length: 30, classes: ["symbols"], symbolSet: "#$" })
  assert.match(password, /^[#$]{30}$/)
})

test("impossible requests are refused rather than quietly adjusted", () => {
  assert.throws(() => generatePassword({ classes: [] }), /no character class/)
  assert.throws(
    () => generatePassword({ length: 3, requireEachClass: true }),
    /cannot hold one character/,
    "a length too small for the required classes has no sensible silent fallback"
  )
})

test("buildPools reports what is actually in play", () => {
  assert.deepEqual(buildPools({ classes: ["digits"] }), ["0123456789"])
  assert.deepEqual(buildPools({ classes: ["digits"], excludeAmbiguous: true }), ["23456789"])
  assert.deepEqual(buildPools({ classes: [] }), [])
})

test("entropy is length times log2 of the alphabet, and degenerate cases are zero", () => {
  assert.equal(entropyBits(20, 85), 20 * Math.log2(85))
  assert.equal(entropyBits(0, 85), 0)
  assert.equal(entropyBits(20, 1), 0, "an alphabet of one character carries no entropy")
})

test("the default randomness is the platform CSPRNG, not Math.random", () => {
  // The one property no amount of staring at the output can confirm. Math.random is a fast PRNG
  // whose state is recoverable from its own output, so a password built on it is not unguessable —
  // and it produces passwords that look exactly as good as the real thing.
  const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
  let calls = 0
  globalThis.crypto.getRandomValues = (array) => {
    calls++
    return real(array)
  }
  const rolled = Math.random
  Math.random = () => {
    throw new Error("generatePassword reached for Math.random")
  }
  try {
    generatePassword({ length: 16 })
  } finally {
    globalThis.crypto.getRandomValues = real
    Math.random = rolled
  }
  assert.ok(calls > 0, "no draw ever reached crypto.getRandomValues")
})

test("the shuffle walks a shrinking range, which is the only unbiased one", () => {
  // Fisher-Yates is unbiased when index i is swapped with a draw from [0, i], and biased when it is
  // swapped with a draw from the whole array — a one-character difference that no distribution of
  // output lengths or alphabets would reveal. Scripted draws pin the exact permutation instead.
  //
  // Draws: four required characters (all index 0 -> "a", "A", "0", "!"), then the shuffle asks for
  // bounds 4, 3 and 2. The last value, 3, is the one that separates them: 3 % 2 = 1 leaves the pair
  // alone, while a full-range 3 % 4 = 3 swaps it.
  const password = generatePassword({
    length: 4,
    requireEachClass: true,
    random: scripted([0, 0, 0, 0, 0, 0, 3]),
  })
  assert.equal(password, "0A!a", "the shuffle drew its index from the full range")
})

// --- the component ---------------------------------------------------------

const fieldsOf = (instance) => byTag(walk(instance.tree), "input")
const passwordFieldOf = (instance) =>
  fieldsOf(instance).find((node) => node.props["aria-label"] === "Generated password")
const copyOf = (instance) => walk(instance.tree).find((node) => node.type === CopyButtonStub)

test("a password exists by the time the component has mounted", () => {
  const instance = render(PasswordGenerator, {})
  const field = passwordFieldOf(instance)
  assert.equal(field.props.value.length, 20, "autoGenerate should have filled the field on mount")
  assert.equal(field.props.readOnly, true, "the field is an output, not something to type into")
})

test("nothing is generated during render, so the server and client agree", () => {
  // Rendering without committing is what the server does. A value drawn in the render body would
  // show up here, and would then differ from the client's own draw at hydration.
  let renderedValue = null
  render((props) => {
    const tree = PasswordGenerator(props)
    const field = byTag(walk(tree), "input").find(
      (node) => node.props["aria-label"] === "Generated password"
    )
    if (renderedValue === null) renderedValue = field.props.value
    return tree
  }, { autoGenerate: false })
  assert.equal(renderedValue, "", "a password was drawn during the render pass")
})

test("the copy button is handed the password, and is dead while there is none", () => {
  const empty = render(PasswordGenerator, { autoGenerate: false })
  assert.equal(copyOf(empty).props.value, "")
  assert.equal(copyOf(empty).props.disabled, true, "copying nothing announces a false success")

  const filled = render(PasswordGenerator, {})
  assert.equal(copyOf(filled).props.value, passwordFieldOf(filled).props.value)
  assert.equal(copyOf(filled).props.disabled, false)
})

test("pressing generate replaces the password and says so once", () => {
  const instance = render(PasswordGenerator, {})
  const before = passwordFieldOf(instance).props.value

  const liveBefore = walk(instance.tree).filter((n) => n.props?.["aria-live"] === "polite")
  assert.equal(liveBefore.length, 1, "there is exactly one live region")

  const generate = byTag(walk(instance.tree), "button").find((node) =>
    JSON.stringify(node.props.children ?? "").includes("Generate")
  )
  generate.props.onClick()
  instance.rerender()

  const after = passwordFieldOf(instance).props.value
  assert.notEqual(after, before, "the same password came back")
  assert.equal(after.length, 20)
})

test("the password itself is never put into the live region", () => {
  const instance = render(PasswordGenerator, {})
  const password = passwordFieldOf(instance).props.value
  const live = walk(instance.tree).find((node) => node.props?.["aria-live"] === "polite")
  assert.ok(
    !JSON.stringify(live.props.children ?? "").includes(password),
    "a screen reader would read the secret aloud"
  )
})

test("a controlled value is displayed and not overwritten", () => {
  const seen = []
  const instance = render(PasswordGenerator, {
    value: "held-by-the-parent",
    onValueChange: (next) => seen.push(next),
  })
  assert.equal(passwordFieldOf(instance).props.value, "held-by-the-parent")
  assert.equal(seen.length, 1, "autoGenerate should offer the parent exactly one password")
  assert.equal(seen[0].length, 20)
})

test("the length control cannot ask for a password the generator would refuse", () => {
  // Four required classes need four slots. A minLength below that would let the slider produce a
  // request generatePassword throws on.
  const instance = render(PasswordGenerator, { minLength: 1, requireEachClass: true })
  const range = fieldsOf(instance).find((node) => node.props.type === "range")
  assert.equal(Number(range.props.min), CHARACTER_CLASSES.length)
})

test("the last enabled class cannot be switched off", () => {
  const instance = render(PasswordGenerator, { defaultClasses: ["lowercase"] })
  const boxes = fieldsOf(instance).filter((node) => node.props.type === "checkbox")
  const lowercase = boxes[0]
  assert.equal(lowercase.props.checked, true)
  assert.equal(lowercase.props.disabled, true, "an empty alphabet has nothing to draw from")
})

test("switching a class off narrows the alphabet the next password comes from", () => {
  const instance = render(PasswordGenerator, {})
  const boxes = () => fieldsOf(instance).filter((node) => node.props.type === "checkbox")
  // Leave lowercase alone, turn the other three off.
  for (const name of ["uppercase", "digits", "symbols"]) {
    const index = CHARACTER_CLASSES.indexOf(name)
    boxes()[index].props.onChange()
    instance.rerender()
  }
  const generate = byTag(walk(instance.tree), "button").find((node) =>
    JSON.stringify(node.props.children ?? "").includes("Generate")
  )
  generate.props.onClick()
  instance.rerender()
  assert.match(passwordFieldOf(instance).props.value, /^[a-z]+$/)
})
