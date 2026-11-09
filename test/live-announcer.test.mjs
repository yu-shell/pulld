// An announcer looks finished in six lines: keep a message in state, render
// `<div aria-live={politeness}>{message}</div>`, done. The cases below are written to fail
// against that and against the implementations it grows into:
//
//   - a region rendered only when there is a message, which inserts the region and its text in one
//     mutation and is reliably not announced at all,
//   - one region per app whose `aria-live` is swapped between polite and assertive, which is read
//     when the region is registered and not when the text changes,
//   - a single region written to twice with the same string, which is not a change and says nothing
//     the second time — the way "Copied" works once and then goes quiet,
//   - `role="status"` with `aria-atomic` left to the implicit mapping, which is not the same
//     region as a bare `aria-live="polite"`,
//   - a shared clear timer, which lets a polite message's expiry empty an assertive one that
//     arrived a moment later,
//   - and a queue that grows on a server, where nothing ever mounts to drain it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const {
  LiveAnnouncer,
  announce,
  clearAnnouncements,
  useAnnounce,
  writeChannel,
  clearChannel,
  channelHasText,
  EMPTY_CHANNEL,
  DEFAULT_CLEAR_AFTER_MS,
} = loadComponent(join(ROOT, "registry/ui/live-announcer.tsx"))

/** Lets the deferred flush (a 0ms task) run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Every live region in the tree, in render order: polite 0, polite 1, assertive 0, assertive 1. */
const regions = (tree) => walk(tree).filter((node) => node.props?.["aria-live"] !== undefined)
const texts = (tree) => regions(tree).map((node) => node.props.children)

/**
 * Renders one announcer and guarantees it is unmounted.
 *
 * Both halves matter. The store is module state shared by every test in this file, so a test that
 * left its announcer subscribed would have its stale `setState` closure written to by the next
 * test's announce. And `clearAnnouncements` at the start is the reset: it drops what is owed as
 * well as emptying the regions.
 */
async function withAnnouncer(props, body) {
  clearAnnouncements()
  const instance = render(LiveAnnouncer, props)
  try {
    return await body(instance)
  } finally {
    instance.unmount()
    clearAnnouncements()
  }
}

// --- the channel, as a pure function ---------------------------------------------------

test("a message goes into the empty slot and the other slot is emptied", () => {
  const first = writeChannel(EMPTY_CHANNEL, "Saved")
  assert.deepEqual(first.slots, ["Saved", ""])

  const second = writeChannel(first, "Saved again")
  assert.deepEqual(second.slots, ["", "Saved again"])
})

test("the same message twice occupies a different slot each time", () => {
  // The point of two regions. In a single region this is one unchanged value and the second
  // announcement is silent; here each write is an empty -> text change in a different node.
  const first = writeChannel(EMPTY_CHANNEL, "Copied")
  const second = writeChannel(first, "Copied")

  assert.deepEqual(first.slots, ["Copied", ""])
  assert.deepEqual(second.slots, ["", "Copied"])

  const held = (channel) => channel.slots.findIndex((text) => text !== "")
  assert.notEqual(held(first), held(second))
  // The slot that receives it was empty in the state before, which is what makes it a change.
  assert.equal(first.slots[held(second)], "")
})

test("writing alternates indefinitely rather than settling on one slot", () => {
  let channel = EMPTY_CHANNEL
  const held = []
  for (let i = 0; i < 6; i++) {
    channel = writeChannel(channel, "Copied")
    held.push(channel.slots.findIndex((text) => text !== ""))
  }
  assert.deepEqual(held, [0, 1, 0, 1, 0, 1])
})

test("clearing empties both slots and leaves the next slot where it was", () => {
  const written = writeChannel(EMPTY_CHANNEL, "Saved")
  const cleared = clearChannel(written)

  assert.deepEqual(cleared.slots, ["", ""])
  assert.equal(cleared.next, written.next)
  // So the write after a clear still lands in a slot that did not just hold text.
  assert.deepEqual(writeChannel(cleared, "Saved").slots, ["", "Saved"])
})

test("channelHasText is false for an untouched channel and true once written", () => {
  assert.equal(channelHasText(EMPTY_CHANNEL), false)
  assert.equal(channelHasText(writeChannel(EMPTY_CHANNEL, "Saved")), true)
  assert.equal(channelHasText(clearChannel(writeChannel(EMPTY_CHANNEL, "Saved"))), false)
})

// --- the regions -----------------------------------------------------------------------

test("four regions are mounted and empty before anything is announced", async () => {
  // The whole of point 1. A region that appears together with its text is not announced, so
  // there has to be something in the tree to write into while there is nothing to say.
  await withAnnouncer({ clearAfter: 0 }, (instance) => {
    assert.deepEqual(texts(instance.tree), ["", "", "", ""])
  })
})

test("polite and assertive are separate regions, not one region whose politeness is swapped", async () => {
  await withAnnouncer({ clearAfter: 0 }, (instance) => {
    const found = regions(instance.tree)
    assert.equal(found.length, 4)
    assert.deepEqual(
      found.map((node) => node.props["aria-live"]),
      ["polite", "polite", "assertive", "assertive"]
    )
    // Four distinct nodes, so no message can change another's politeness.
    assert.equal(new Set(found).size, 4)
  })
})

test("every region states its role, its politeness and its atomicity outright", async () => {
  // Point 4: `role="status"` carries an implicit aria-atomic="true" and a bare
  // `aria-live="polite"` does not, so a region that names only one of them is not the same
  // region in every reader. Each is written out.
  await withAnnouncer({ clearAfter: 0 }, (instance) => {
    for (const node of regions(instance.tree)) {
      const politeness = node.props["aria-live"]
      assert.equal(node.props.role, politeness === "assertive" ? "alert" : "status")
      assert.equal(node.props["aria-atomic"], "true")
    }
  })
})

test("the regions are hidden by clipping, never removed from the accessibility tree", async () => {
  await withAnnouncer({ clearAfter: 0 }, (instance) => {
    const wrapper = walk(instance.tree)[0]
    assert.match(wrapper.props.className, /\bsr-only\b/)
    // Any of these and nothing written here is ever read.
    assert.equal(wrapper.props["aria-hidden"], undefined)
    assert.equal(wrapper.props.hidden, undefined)
    for (const node of regions(instance.tree)) {
      assert.equal(node.props["aria-hidden"], undefined)
      assert.equal(node.props.hidden, undefined)
    }
  })
})

test("a className is added to sr-only rather than replacing it", async () => {
  await withAnnouncer({ clearAfter: 0, className: "z-50" }, (instance) => {
    const wrapper = walk(instance.tree)[0]
    assert.match(wrapper.props.className, /\bsr-only\b/)
    assert.match(wrapper.props.className, /\bz-50\b/)
  })
})

// --- announcing ------------------------------------------------------------------------

test("a message is not written into the announcer's own first commit", async () => {
  // Said before anything was mounted. If it appeared in the first commit, the region and its
  // text would arrive in one mutation — the case that is reliably ignored.
  clearAnnouncements()
  announce("Ready")
  const instance = render(LiveAnnouncer, { clearAfter: 0 })
  try {
    assert.deepEqual(texts(instance.tree), ["", "", "", ""])

    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Ready", "", "", ""])
  } finally {
    instance.unmount()
    clearAnnouncements()
  }
})

test("a polite message lands in a polite region and leaves the assertive ones alone", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("17 results")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["17 results", "", "", ""])
  })
})

test("an assertive message lands in an assertive region", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Your session expires in one minute", "assertive")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["", "", "Your session expires in one minute", ""])
  })
})

test("the same message twice changes the tree, so the second one is announced too", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Copied")
    await tick()
    instance.rerender()
    const first = texts(instance.tree)

    announce("Copied")
    await tick()
    instance.rerender()
    const second = texts(instance.tree)

    assert.deepEqual(first, ["Copied", "", "", ""])
    assert.deepEqual(second, ["", "Copied", "", ""])
    // The naive single region gives the same tree twice and says nothing the second time.
    assert.notDeepEqual(first, second)
  })
})

test("two messages of one politeness in a single task collapse to the last", async () => {
  // Not a dropped message: a region holds one value, and a reader polling after both writes
  // would only ever have seen the second. "Loading…" then "17 results" should say the latter.
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Loading…")
    announce("17 results")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["17 results", "", "", ""])
  })
})

test("a polite and an assertive message in one task both land", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Draft saved")
    announce("Upload failed", "assertive")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Draft saved", "", "Upload failed", ""])
  })
})

test("a blank or whitespace-only message is dropped", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("")
    announce("   ")
    announce("\n\t")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["", "", "", ""])
  })
})

test("clearAnnouncements empties the regions and drops what was owed", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Draft saved")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Draft saved", "", "", ""])

    clearAnnouncements()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["", "", "", ""])

    // Owed-but-unflushed is dropped too, not written on the next tick.
    announce("Stale")
    clearAnnouncements()
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["", "", "", ""])
  })
})

test("useAnnounce hands back the same function announce is", () => {
  assert.equal(useAnnounce(), announce)
  assert.equal(useAnnounce(), useAnnounce())
})

// --- expiry ----------------------------------------------------------------------------

test("a message is emptied after clearAfter, and only its own politeness is emptied", async () => {
  // A single shared timer would take the assertive message — written later, not yet expired —
  // down with the polite one.
  await withAnnouncer({ clearAfter: 40 }, async (instance) => {
    announce("Draft saved")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Draft saved", "", "", ""])

    await wait(25)
    announce("Upload failed", "assertive")
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Draft saved", "", "Upload failed", ""])

    // Past the polite message's expiry, short of the assertive one's.
    await wait(30)
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["", "", "Upload failed", ""])
  })
})

test("clearAfter 0 keeps a message in its region", async () => {
  await withAnnouncer({ clearAfter: 0 }, async (instance) => {
    announce("Draft saved")
    await tick()
    instance.rerender()
    await wait(30)
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["Draft saved", "", "", ""])
  })
})

test("the default expiry leaves a message up long enough to have been read", () => {
  // Not a number pulled from the air in either direction: short enough that a stale sentence
  // does not sit in the tree, long past any reader's chance to have taken it.
  assert.ok(DEFAULT_CLEAR_AFTER_MS >= 5000, `${DEFAULT_CLEAR_AFTER_MS} is too eager`)
  assert.ok(DEFAULT_CLEAR_AFTER_MS <= 15000, `${DEFAULT_CLEAR_AFTER_MS} leaves it up too long`)
})

// --- mounting and unmounting -----------------------------------------------------------

test("a remounted announcer starts silent instead of re-presenting the last message", async () => {
  clearAnnouncements()
  const first = render(LiveAnnouncer, { clearAfter: 0 })
  announce("Draft saved")
  await tick()
  first.rerender()
  assert.deepEqual(texts(first.tree), ["Draft saved", "", "", ""])
  first.unmount()

  const second = render(LiveAnnouncer, { clearAfter: 0 })
  try {
    assert.deepEqual(texts(second.tree), ["", "", "", ""])
    await tick()
    second.rerender()
    assert.deepEqual(texts(second.tree), ["", "", "", ""])
  } finally {
    second.unmount()
    clearAnnouncements()
  }
})

test("announcing with nothing mounted neither throws nor accumulates", async () => {
  // The queue holds one message per politeness, so a server that never mounts an announcer
  // cannot grow one. Only the last of each is owed when an announcer finally arrives.
  clearAnnouncements()
  for (let i = 0; i < 500; i++) {
    announce(`polite ${i}`)
    announce(`assertive ${i}`, "assertive")
  }
  await tick()

  const instance = render(LiveAnnouncer, { clearAfter: 0 })
  try {
    await tick()
    instance.rerender()
    assert.deepEqual(texts(instance.tree), ["polite 499", "", "assertive 499", ""])
  } finally {
    instance.unmount()
    clearAnnouncements()
  }
})
