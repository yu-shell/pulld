// A camera is the one resource on the platform where getting the teardown wrong is visible to the
// user as a light on the front of their laptop. Every case below is written against a version that
// got one of these wrong:
//
//   - clearing `video.srcObject` to "stop" the camera, which blanks the preview and leaves the
//     tracks live and the recording indicator lit,
//   - starting the new camera before releasing the old one, which is NotReadableError on every
//     phone — the devices that actually have a second camera to switch to,
//   - letting a stream that arrived after the component was abandoned simply land, so the camera
//     stays on with nothing left on the page that could turn it off,
//   - asking for `{ exact: "environment" }`, which fails outright on every laptop, or for plain
//     `"environment"`, which silently hands back the front camera and photographs the user's face
//     where a passport page was wanted,
//   - photographing on `loadedmetadata`, which publishes the dimensions before any frame has been
//     decoded and yields a correctly-sized, entirely black JPEG,
//   - mirroring the saved image along with the preview, which makes every photographed document,
//     receipt and serial number read backwards,
//   - taking NotAllowedError at face value and telling everybody to change their site settings,
//     which is wrong advice on http and inside an iframe, where there is no setting and no prompt,
//   - reporting an unsupported browser as a greyed-out button with nothing beside it saying why,
//   - never revoking the object URL, so a capture screen used ten times pins ten images in memory.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const icons = new Proxy({}, { get: () => () => null })

const { CameraCapture, useCameraCapture, isCameraCaptureSupported } = loadComponent(
  join(ROOT, "registry", "ui", "camera-capture.tsx"),
  { stubs: { "lucide-react": icons } }
)

/** One video track, with the two things the component reads off it and the one it calls. */
function makeStream({ facingMode = "user", deviceId = "front" } = {}) {
  const track = {
    kind: "video",
    stopped: 0,
    onended: null,
    getSettings: () => (facingMode ? { facingMode, deviceId } : { deviceId }),
    stop() {
      track.stopped += 1
    },
  }
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  }
  return { stream, track }
}

/**
 * Installs one browser for one test.
 *
 * `mediaDevices: false` removes the property rather than setting it undefined, because that is the
 * shape the real absence has — and, on a plain-http origin, the shape a perfectly capable browser
 * has too. `policyAllows: null` does the same for `document.permissionsPolicy`, which is genuinely
 * missing outside Chromium.
 */
function browser({
  mediaDevices = true,
  permission = "prompt",
  secure = true,
  policyAllows = true,
  cameras = [
    { kind: "videoinput", deviceId: "front", label: "Front" },
    { kind: "videoinput", deviceId: "rear", label: "Rear" },
  ],
  /** What the canvas actually encodes, when that is not what was asked for. */
  encodesAs = null,
} = {}) {
  const requests = []
  const listeners = []
  const canvases = []
  const urls = { created: [], revoked: [] }
  let state = permission
  let nextUrl = 0

  const nav = {}
  if (mediaDevices) {
    nav.mediaDevices = {
      getUserMedia(constraints) {
        const record = { constraints }
        record.promise = new Promise((resolve, reject) => {
          record.resolve = resolve
          record.reject = reject
        })
        requests.push(record)
        return record.promise
      },
      enumerateDevices: async () => cameras,
    }
  }
  if (permission !== null) {
    nav.permissions = {
      query: async () => ({
        // A getter, so a status handed out before the user answered still reads the new value.
        get state() {
          return state
        },
        addEventListener(type, fn) {
          if (type === "change") listeners.push(fn)
        },
        removeEventListener(type, fn) {
          const at = listeners.indexOf(fn)
          if (at >= 0) listeners.splice(at, 1)
        },
      }),
    }
  }

  Object.defineProperty(globalThis, "navigator", { value: nav, configurable: true, writable: true })
  globalThis.window = { isSecureContext: secure }
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas")
      const ctx = {
        ops: [],
        translate: (...args) => ctx.ops.push(["translate", ...args]),
        scale: (...args) => ctx.ops.push(["scale", ...args]),
        drawImage: (...args) => ctx.ops.push(["drawImage", ...args]),
      }
      const canvas = {
        width: 0,
        height: 0,
        ctx,
        getContext: () => ctx,
        toBlob(cb, type, quality) {
          canvas.encoded = { type, quality }
          cb({ size: 1024, type: encodesAs ?? type })
        },
      }
      canvases.push(canvas)
      return canvas
    },
  }
  if (policyAllows !== null) globalThis.document.permissionsPolicy = { allowsFeature: () => policyAllows }

  URL.createObjectURL = (blob) => {
    const url = `blob:fake/${(nextUrl += 1)}`
    urls.created.push({ url, blob })
    return url
  }
  URL.revokeObjectURL = (url) => urls.revoked.push(url)

  return {
    requests,
    canvases,
    urls,
    /** The constraints of the most recent getUserMedia call. */
    get asked() {
      return requests.at(-1)?.constraints
    },
    setPermission(next) {
      state = next
      for (const fn of [...listeners]) fn()
    },
  }
}

/** Lets the getUserMedia continuation and any permission lookup behind it run. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const video = (result) => byTag(walk(result.tree), "video")[0]
const buttons = (result) => byTag(walk(result.tree), "button")
const status = (result) => walk(result.tree).find((node) => node.props?.role === "status")
/** The stand-in the component was handed for its `<video>`. */
const videoNode = (result) => result.nodes[0]

/** Drives a mounted component to a live preview with a frame ready to photograph. */
async function goLive(result, env, options = {}) {
  buttons(result)[0].props.onClick()
  result.rerender()
  const made = makeStream(options)
  env.requests.at(-1).resolve(made.stream)
  await flush()
  const node = videoNode(result)
  node.videoWidth = 1280
  node.videoHeight = 720
  node.readyState = 2
  video(result).props.onLoadedData()
  result.rerender()
  return made
}

test("the video element is in the tree before there is a stream", () => {
  browser()
  const result = render(CameraCapture, {})
  // Rendering it only once a stream exists is the classic version of this bug: `getUserMedia`
  // resolves, the ref is still null, the stream is never attached, and the camera is on with a
  // blank preview and no clue why.
  assert.ok(video(result), "no <video> at idle")
  result.unmount()
})

test("the live region is mounted, empty, and in the accessibility tree from the start", () => {
  browser()
  const result = render(CameraCapture, {})
  const region = status(result)
  assert.equal(region.props["aria-live"], "polite")
  assert.equal(region.props.children, "")
  // `hidden`, `display:none` and `aria-hidden` all take a live region out of the tree, which is the
  // same silence as not rendering it. Only `sr-only` hides it and keeps it speaking.
  assert.equal(region.props.hidden, undefined)
  assert.equal(region.props["aria-hidden"], undefined)
  assert.match(region.props.className, /sr-only/)
  result.unmount()
})

test("nothing is requested until the button is pressed", () => {
  const env = browser()
  const result = render(CameraCapture, {})
  assert.equal(env.requests.length, 0)
  result.unmount()
})

test("autoStart opens the camera on mount", () => {
  const env = browser()
  const result = render(CameraCapture, { autoStart: true })
  assert.equal(env.requests.length, 1)
  result.unmount()
})

test("facing is asked for as an ideal, never an exact, and audio is explicitly refused", () => {
  const env = browser()
  const result = render(CameraCapture, { facingMode: "environment" })
  buttons(result)[0].props.onClick()
  assert.deepEqual(env.asked.video.facingMode, { ideal: "environment" })
  // `audio: false`, not omitted: asking for audio lights the microphone indicator and puts a second
  // permission in front of somebody who wanted to take a photograph.
  assert.equal(env.asked.audio, false)
  result.unmount()
})

test("a pinned deviceId is exact and is not sent alongside a facing constraint", () => {
  const env = browser()
  const result = render(CameraCapture, { deviceId: "rear" })
  buttons(result)[0].props.onClick()
  assert.deepEqual(env.asked.video.deviceId, { exact: "rear" })
  // Two constraints naming different cameras is how a device that has both produces
  // OverconstrainedError.
  assert.equal(env.asked.video.facingMode, undefined)
  result.unmount()
})

test("a camera that does not face the way it was asked to is reported, not hidden", async () => {
  const env = browser()
  let seen = null
  const result = render(useCameraCapture, {
    facingMode: "environment",
    onFailure: () => {},
  })
  result.tree.start()
  result.rerender()
  env.requests.at(-1).resolve(makeStream({ facingMode: "user", deviceId: "front" }).stream)
  await flush()
  result.rerender()
  seen = result.tree
  assert.equal(seen.facing, "user")
  // The whole reason `{ ideal: ... }` is safe to use: the fallback is visible instead of silent.
  assert.equal(seen.facingFallback, true)
  result.unmount()
})

test("a camera that matched is not reported as a fallback", async () => {
  const env = browser()
  const result = render(useCameraCapture, { facingMode: "environment" })
  result.tree.start()
  result.rerender()
  env.requests.at(-1).resolve(makeStream({ facingMode: "environment", deviceId: "rear" }).stream)
  await flush()
  result.rerender()
  assert.equal(result.tree.facing, "environment")
  assert.equal(result.tree.facingFallback, false)
  result.unmount()
})

test("unmounting stops the tracks rather than only clearing srcObject", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  const made = await goLive(result, env)
  assert.equal(made.track.stopped, 0)
  result.unmount()
  assert.equal(made.track.stopped, 1, "the camera was left running after unmount")
  assert.equal(videoNode(result).srcObject, null)
})

test("a stream that arrives after the component is gone is stopped, not leaked", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  const made = makeStream()
  result.unmount()
  env.requests.at(-1).resolve(made.stream)
  await flush()
  // Nothing is holding this stream and nothing on the page ever will, so the only moment it can be
  // released is here.
  assert.equal(made.track.stopped, 1, "an abandoned stream kept the camera on")
})

test("taking a photo releases the camera by default", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  const made = await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  assert.equal(made.track.stopped, 1, "the recording indicator stayed lit beside a finished photo")
  result.unmount()
})

test("keepStreamAfterCapture leaves the preview running for the next shot", async () => {
  const env = browser()
  const result = render(CameraCapture, { keepStreamAfterCapture: true })
  const made = await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  assert.equal(made.track.stopped, 0)
  result.unmount()
})

test("switching cameras releases the old one before asking for the new one", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  const made = await goLive(result, env, { facingMode: "user" })
  const before = env.requests.length
  // The switch button only exists while the preview is live and there is somewhere to switch to.
  const switcher = buttons(result)[1]
  assert.ok(switcher, "no switch control on a device that reports its facing")
  switcher.props.onClick()
  // On a phone the camera is exclusive: asking first and releasing after is NotReadableError every
  // time, so the order here is the whole behaviour.
  assert.equal(made.track.stopped, 1, "the old camera was still held when the new one was asked for")
  assert.equal(env.requests.length, before + 1)
  assert.deepEqual(env.asked.video.facingMode, { ideal: "environment" })
  result.unmount()
})

test("a photo is refused while the video has dimensions but no decoded frame", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  await goLive(result, env)
  // Exactly the state `loadedmetadata` leaves behind: the size is known and nothing has been
  // decoded. A version gated on dimensions alone writes a correctly-sized black JPEG here.
  videoNode(result).readyState = 1
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  assert.equal(env.canvases.length, 0, "it photographed a frame that did not exist yet")
  assert.match(status(result).props.children, /couldn't be taken/)
  result.unmount()
})

test("a photo is drawn at the frame's own size and encoded as jpeg", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  const canvas = env.canvases[0]
  assert.equal(canvas.width, 1280)
  assert.equal(canvas.height, 720)
  assert.equal(canvas.encoded.type, "image/jpeg")
  assert.equal(canvas.ctx.ops[0][0], "drawImage")
  result.unmount()
})

test("maxWidth caps the saved image and keeps the aspect ratio", async () => {
  const env = browser()
  const result = render(CameraCapture, { maxWidth: 640 })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  const canvas = env.canvases[0]
  assert.equal(canvas.width, 640)
  assert.equal(canvas.height, 360)
  result.unmount()
})

test("the saved image is not mirrored even while the preview is", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  await goLive(result, env, { facingMode: "user" })
  assert.match(video(result).props.className, /scale-x-\[-1\]/, "a front preview was not mirrored")
  await buttons(result)[0].props.onClick()
  await flush()
  // Mirroring the file is what makes every photographed document, badge and receipt read backwards.
  assert.deepEqual(env.canvases[0].ctx.ops, [["drawImage", videoNode(result), 0, 0, 1280, 720]])
  result.unmount()
})

test("mirrorOutput flips the canvas for the people who do want a mirrored selfie", async () => {
  const env = browser()
  const result = render(CameraCapture, { mirrorOutput: true })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  assert.deepEqual(env.canvases[0].ctx.ops.slice(0, 2), [
    ["translate", 1280, 0],
    ["scale", -1, 1],
  ])
  result.unmount()
})

test("a rear camera preview is not mirrored", async () => {
  const env = browser()
  const result = render(CameraCapture, { facingMode: "environment" })
  await goLive(result, env, { facingMode: "environment", deviceId: "rear" })
  assert.doesNotMatch(video(result).props.className, /scale-x-\[-1\]/)
  result.unmount()
})

test("the object URL is released on retake and on unmount", async () => {
  const env = browser()
  const result = render(CameraCapture, { keepStreamAfterCapture: true })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  const first = env.urls.created[0].url
  // Primary button is "Retake" now.
  buttons(result)[0].props.onClick()
  result.rerender()
  assert.deepEqual(env.urls.revoked, [first], "the first photo was pinned in memory")
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  result.unmount()
  assert.equal(env.urls.revoked.length, 2)
})

test("a stored denial says so and does not offer a retry that cannot work", async () => {
  const env = browser({ permission: "prompt" })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.setPermission("denied")
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))
  await flush()
  result.rerender()
  assert.match(status(result).props.children, /site settings/)
  assert.equal(buttons(result)[0].props["aria-disabled"], true)
  // Reachable, not `disabled` — a disabled button leaves the tab order, so the one explanation of
  // why the camera is unavailable reaches everyone except the people who need it.
  assert.equal(buttons(result)[0].props.disabled, undefined)
  result.unmount()
})

test("a dismissed prompt is offered again, because asking again really re-prompts", async () => {
  const env = browser({ permission: "prompt" })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))
  await flush()
  result.rerender()
  assert.match(status(result).props.children, /dismissed/)
  assert.equal(buttons(result)[0].props["aria-disabled"], undefined)
  result.unmount()
})

test("refused while the permission is granted blames the frame, not the user", async () => {
  const env = browser({ permission: "granted" })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))
  await flush()
  result.rerender()
  // Nothing the user can change produced this, so sending them to their own settings would be a lie.
  assert.match(status(result).props.children, /isn't permitted/)
  result.unmount()
})

test("Permissions Policy is settled before the call, so no prompt is attempted", () => {
  const env = browser({ policyAllows: false })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  assert.equal(env.requests.length, 0)
  assert.match(status(result).props.children, /isn't permitted/)
  result.unmount()
})

test("another app holding the camera is its own answer, and is worth retrying", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.requests.at(-1).reject(Object.assign(new Error("busy"), { name: "NotReadableError" }))
  await flush()
  result.rerender()
  assert.match(status(result).props.children, /another app/)
  assert.equal(buttons(result)[0].props["aria-disabled"], undefined)
  result.unmount()
})

test("constraints no camera can satisfy are not retried with the same constraints", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "OverconstrainedError" }))
  await flush()
  result.rerender()
  assert.equal(buttons(result)[0].props["aria-disabled"], true)
  result.unmount()
})

test("the legacy error spellings are mapped too", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  // What older Chrome threw. A browser old enough to use it is the one that will not be updated.
  env.requests.at(-1).reject(Object.assign(new Error("none"), { name: "DevicesNotFoundError" }))
  await flush()
  result.rerender()
  assert.match(status(result).props.children, /No camera was found/)
  result.unmount()
})

test("http says it needs https, not that the browser is incapable", () => {
  browser({ mediaDevices: false, secure: false })
  const result = render(CameraCapture, {})
  // MediaDevices is [SecureContext], so the whole object is missing here — and the naive read of
  // that is "no camera support", which is false and sends the developer hunting for a browser bug.
  assert.equal(isCameraCaptureSupported(), false)
  assert.match(status(result).props.children, /secure \(https\)/)
  result.unmount()
})

test("an unsupported browser explains itself before anything is clicked", () => {
  browser({ mediaDevices: false, secure: true })
  const result = render(CameraCapture, {})
  assert.match(status(result).props.children, /can't use a camera/)
  assert.equal(buttons(result)[0].props["aria-disabled"], true)
  result.unmount()
})

test("a permission fixed in site settings clears the dead end without a reload", async () => {
  const env = browser({ permission: "prompt" })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.setPermission("denied")
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))
  await flush()
  result.rerender()
  assert.match(status(result).props.children, /site settings/)
  env.setPermission("prompt")
  await flush()
  result.rerender()
  assert.equal(status(result).props.children, "")
  assert.equal(buttons(result)[0].props["aria-disabled"], undefined)
  result.unmount()
})

test("a camera taken away mid-preview is reported instead of freezing on its last frame", async () => {
  const env = browser()
  const result = render(CameraCapture, {})
  const made = await goLive(result, env)
  assert.equal(typeof made.track.onended, "function", "nothing was listening for the source ending")
  made.track.onended()
  result.rerender()
  assert.match(status(result).props.children, /unplugged/)
  result.unmount()
})

test("the camera list is only read once the labels are real", async () => {
  const env = browser()
  const result = render(useCameraCapture, {})
  // `enumerateDevices` answers before any grant, but every label is the empty string, so a menu
  // built on mount is a column of blanks.
  assert.deepEqual(result.tree.devices, [])
  result.tree.start()
  result.rerender()
  env.requests.at(-1).resolve(makeStream().stream)
  await flush()
  result.rerender()
  assert.deepEqual(
    result.tree.devices.map((device) => device.label),
    ["Front", "Rear"]
  )
  result.unmount()
})

test("where facing is unknown, switching steps through the enumerated cameras", async () => {
  const env = browser()
  const result = render(useCameraCapture, {})
  result.tree.start()
  result.rerender()
  // A laptop webcam: no facingMode in the settings at all.
  env.requests.at(-1).resolve(makeStream({ facingMode: null, deviceId: "front" }).stream)
  await flush()
  result.rerender()
  assert.equal(result.tree.facing, "unknown")
  assert.equal(result.tree.canSwitch, true)
  result.tree.switchCamera()
  assert.deepEqual(env.asked.video.deviceId, { exact: "rear" })
  result.unmount()
})

test("a single unknown-facing camera offers no switch at all", async () => {
  const env = browser({ cameras: [{ kind: "videoinput", deviceId: "front", label: "Front" }] })
  const result = render(useCameraCapture, {})
  result.tree.start()
  result.rerender()
  env.requests.at(-1).resolve(makeStream({ facingMode: null, deviceId: "front" }).stream)
  await flush()
  result.rerender()
  assert.equal(result.tree.canSwitch, false)
  result.unmount()
})

test("the video carries the attributes an iPhone needs, and no accessible name", () => {
  browser()
  const result = render(CameraCapture, {})
  const node = video(result)
  // Without playsInline an iPhone takes the preview fullscreen over the page and the capture button.
  assert.equal(node.props.playsInline, true)
  // Muted is what makes autoplay legal at all.
  assert.equal(node.props.muted, true)
  assert.equal(node.props.autoPlay, true)
  // A live preview carries no text; the live region does the talking.
  assert.equal(node.props["aria-hidden"], "true")
  result.unmount()
})

test("the photo is a real image with alt text, not a decorative canvas", async () => {
  const env = browser()
  const result = render(CameraCapture, { photoAlt: "Your receipt" })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  result.rerender()
  const img = byTag(walk(result.tree), "img")[0]
  assert.ok(img)
  assert.equal(img.props.alt, "Your receipt")
  result.unmount()
})

test("onCapture receives the blob, its size and the encoding that actually came back", async () => {
  const env = browser()
  const seen = []
  const result = render(CameraCapture, { onCapture: (photo) => seen.push(photo) })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  assert.equal(seen.length, 1)
  assert.equal(seen[0].width, 1280)
  assert.equal(seen[0].height, 720)
  assert.equal(seen[0].type, "image/jpeg")
  assert.equal(seen[0].url, env.urls.created[0].url)
  result.unmount()
})

test("a double tap on Start does not ask for the same camera twice", () => {
  const env = browser()
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  buttons(result)[0].props.onClick()
  // The second request would be made while the first still holds the camera, and on a phone that
  // is NotReadableError — "another app is using your camera", about your own page.
  assert.equal(env.requests.length, 1)
  result.unmount()
})

test("changing your mind while the camera is still opening is not ignored", async () => {
  const env = browser()
  const result = render(useCameraCapture, {})
  result.tree.start({ facingMode: "user" })
  result.rerender()
  result.tree.start({ facingMode: "environment" })
  // Different camera, so it is a decision rather than a stutter, and it goes through.
  assert.equal(env.requests.length, 2)
  // The first one is now orphaned — it has to be stopped when it lands or the camera stays on.
  const abandoned = makeStream({ facingMode: "user" })
  env.requests[0].resolve(abandoned.stream)
  await flush()
  assert.equal(abandoned.track.stopped, 1)
  result.unmount()
})

test("a failed start can be retried with the same camera", async () => {
  const env = browser({ permission: "prompt" })
  const result = render(CameraCapture, {})
  buttons(result)[0].props.onClick()
  result.rerender()
  env.requests.at(-1).reject(Object.assign(new Error("no"), { name: "NotReadableError" }))
  await flush()
  result.rerender()
  // The in-flight guard has to be released by the failure too, or "Try again" is dead for good.
  buttons(result)[0].props.onClick()
  assert.equal(env.requests.length, 2)
  result.unmount()
})

test("calling start() on http says https, even with no button to press", async () => {
  browser({ mediaDevices: false, secure: false })
  const result = render(useCameraCapture, {})
  // The hook is exported, so a consumer laying out their own control can reach this path without
  // ever consulting `isSupported`. Blaming the browser here is the same wrong answer.
  result.tree.start()
  result.rerender()
  assert.equal(result.tree.failure.cause, "insecure-context")
  result.unmount()
})

test("switching with one unknown-facing camera does not restart the one you have", async () => {
  const env = browser({ cameras: [{ kind: "videoinput", deviceId: "front", label: "Front" }] })
  const result = render(useCameraCapture, {})
  result.tree.start()
  result.rerender()
  env.requests.at(-1).resolve(makeStream({ facingMode: null, deviceId: "front" }).stream)
  await flush()
  result.rerender()
  const before = env.requests.length
  result.tree.switchCamera()
  // Stepping from the only camera back to itself is a visible flicker and a pointless reacquisition.
  assert.equal(env.requests.length, before)
  result.unmount()
})

test("the photo reports the encoding that came back, not the one that was asked for", async () => {
  // A browser that cannot encode the requested type silently writes PNG instead, and a caller that
  // names the upload from the request ships a mislabelled file.
  const env = browser({ encodesAs: "image/png" })
  const seen = []
  const result = render(CameraCapture, { imageType: "image/webp", onCapture: (p) => seen.push(p) })
  await goLive(result, env)
  await buttons(result)[0].props.onClick()
  await flush()
  assert.equal(env.canvases[0].encoded.type, "image/webp")
  assert.equal(seen[0].type, "image/png")
  result.unmount()
})
