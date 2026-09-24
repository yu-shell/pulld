"use client"

import * as React from "react"
import { Camera, Loader2, RotateCcw, SwitchCamera, TriangleAlert } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The MediaDevices entry point, or null where there isn't one.
 *
 * Hand-written because TypeScript declares `readonly mediaDevices: MediaDevices` on `Navigator` —
 * not optional — so `navigator.mediaDevices.getUserMedia(...)` type-checks everywhere and then
 * throws a TypeError on the browsers, and the origins, that haven't got it.
 */
function mediaDevicesOf(): MediaDevices | null {
  if (typeof navigator === "undefined" || !("mediaDevices" in navigator)) return null
  const api: MediaDevices | undefined = navigator.mediaDevices
  return api && typeof api.getUserMedia === "function" ? api : null
}

/**
 * Whether the camera API exists here at all.
 *
 * Worth knowing what this cannot tell apart, because it is the exact inverse of the trap
 * geolocation sets. `MediaDevices` *is* `[SecureContext]`, so on a plain-http origin the entire
 * object is genuinely missing and this returns false — the feature detect fires, which feels like
 * the happy case. It isn't. The message that detect leads to — "this browser can't use a camera" —
 * is false on a browser that uses cameras perfectly well and is only refusing this origin, and it
 * sends the developer looking at the http staging box hunting for a browser bug. `start()` asks
 * `insecureContext()` before it concludes anything from this.
 */
export function isCameraCaptureSupported(): boolean {
  return mediaDevicesOf() !== null
}

/**
 * Whether this page is a non-secure context, where the camera is unavailable and always will be.
 */
function insecureContext(): boolean {
  // A browser old enough to lack `isSecureContext` must not be read as insecure — that would
  // refuse to work on the very browsers this is meant to degrade for.
  return typeof window !== "undefined" && window.isSecureContext === false
}

/**
 * Whether Permissions Policy forbids the camera in this document, where that can be asked.
 *
 * One of the four producers of an unexplained `NotAllowedError`. The default allowlist for
 * `camera` is `'self'`, so an `<iframe>` embedding this page without `allow="camera"` is refused,
 * as is any origin serving `Permissions-Policy: camera=()`. Neither is something the person
 * looking at the screen can do anything about, and neither shows a prompt.
 *
 * Best effort: the accessor is absent outside Chromium and is not in the DOM typings, so false
 * means "not known to be blocked", never "allowed".
 */
function blockedByPermissionsPolicy(): boolean {
  if (typeof document === "undefined") return false
  type Policy = { allowsFeature?: (feature: string) => boolean }
  const doc = document as Document & { permissionsPolicy?: Policy; featurePolicy?: Policy }
  const policy = doc.permissionsPolicy ?? doc.featurePolicy
  if (!policy || typeof policy.allowsFeature !== "function") return false
  try {
    return !policy.allowsFeature("camera")
  } catch {
    return false
  }
}

/**
 * Reads the stored camera permission without prompting, or null where that cannot be asked.
 *
 * The only other way to learn the permission state is to call `getUserMedia`, and that *acts* — it
 * can put a prompt in front of somebody who never asked for one, and on a phone it lights the
 * camera. This answers the same question silently, which is what makes it possible to tell the
 * four different things `NotAllowedError` means apart.
 *
 * Guarded twice: `navigator.permissions` is declared non-optional by TypeScript and is genuinely
 * absent in older browsers, and a browser that has the Permissions API may still not recognise the
 * `camera` descriptor — Firefox does not — in which case `query` rejects instead of answering. Not
 * knowing is an ordinary answer here, and every path below works without it.
 */
async function queryCameraPermission(): Promise<PermissionStatus | null> {
  if (typeof navigator === "undefined" || !("permissions" in navigator)) return null
  const permissions: Permissions | undefined = navigator.permissions
  if (!permissions || typeof permissions.query !== "function") return null
  try {
    return await permissions.query({ name: "camera" as PermissionName })
  } catch {
    return null
  }
}

/** Which way a camera points. */
export type CameraFacing = "user" | "environment"

/**
 * The facing this page actually got.
 *
 * `unknown` is the ordinary answer on a laptop: `facingMode` is optional in `MediaTrackSettings`
 * and desktop webcams routinely omit it. The specification also defines `left` and `right`, which
 * are reported as `unknown` here — they are too rare to build a mirroring rule on and neither is
 * a front camera in the sense that matters below.
 */
export type ResolvedCameraFacing = CameraFacing | "unknown"

/** One camera the browser is willing to name. */
export interface CameraDevice {
  deviceId: string
  /** Empty until a camera permission has been granted for this origin. See `devices`. */
  label: string
}

/**
 * Why the camera failed — worked out, not guessed.
 *
 * Four of these arrive as the identical `NotAllowedError`, and they need four different things
 * from four different people: `denied` is the user's own stored choice, `dismissed` is a prompt
 * closed without an answer, `insecure-context` and `blocked-by-policy` are the developer's to fix
 * and are invisible to the user.
 */
export type CameraFailureCause =
  | "unsupported"
  | "insecure-context"
  | "blocked-by-policy"
  | "denied"
  | "dismissed"
  | "no-camera"
  | "in-use"
  | "unsatisfiable"
  | "interrupted"
  | "capture-failed"
  | "unknown"

export interface CameraFailure {
  cause: CameraFailureCause
  /** The `DOMException.name` the browser used, or null when this was settled before any call. */
  code: string | null
  /** Wording safe to show as-is. Override per cause with the `messages` prop. */
  message: string
  /**
   * Whether trying again, right now, can produce a different answer.
   *
   * False for `denied` is the point of the component. Once the camera is blocked for an origin the
   * browser refuses without prompting, so a "Try again" is a button that cannot work: it returns
   * the same error instantly for as long as the page is open. The only way out runs through the
   * browser's own site settings, which is what the copy for that case says — and why the
   * permission `change` listener below exists, so that coming back from those settings costs
   * nothing.
   */
  retryable: boolean
}

/**
 * Where the camera has got to.
 *
 * `prompting` and `starting` are split because conflating them is a small lie: a spinner labelled
 * "Starting the camera" over an unanswered permission dialog is describing something that is not
 * happening, and the wait is unbounded because a person deciding whether to hand over their camera
 * is not a fault. `starting` is the same wait where the Permissions API could not say a prompt was
 * coming. `live` means a frame has actually arrived — see `onLoadedData` below, and note that it
 * is deliberately not `loadedmetadata`.
 */
export type CameraPhase =
  | "idle"
  | "prompting"
  | "starting"
  | "live"
  | "capturing"
  | "captured"
  | "error"

const RETRYABLE: Record<CameraFailureCause, boolean> = {
  unsupported: false,
  "insecure-context": false,
  "blocked-by-policy": false,
  denied: false,
  dismissed: true,
  "no-camera": true,
  "in-use": true,
  // The constraints asked for something this device has not got. Asking again with the same
  // constraints fails the same way; `switchCamera` or `selectDevice` is the move that can work.
  unsatisfiable: false,
  interrupted: true,
  "capture-failed": true,
  unknown: true,
}

const DEFAULT_MESSAGES: Record<CameraFailureCause, string> = {
  unsupported: "This browser can't use a camera.",
  "insecure-context":
    "The camera needs a secure (https) connection, so the browser refused without asking.",
  "blocked-by-policy": "This page isn't permitted to use the camera.",
  denied:
    "The camera is blocked for this site. Allow it in your browser's site settings — this page can't ask again.",
  dismissed: "The camera request was dismissed.",
  "no-camera": "No camera was found on this device.",
  "in-use": "The camera is being used by another app.",
  unsatisfiable: "No camera on this device matches what the page asked for.",
  interrupted: "The camera stopped — it may have been unplugged or taken by another app.",
  "capture-failed": "The photo couldn't be taken.",
  unknown: "The camera couldn't be started.",
}

/**
 * Maps a `getUserMedia` rejection to a cause. `NotAllowedError` is resolved separately.
 *
 * The legacy spellings are not decoration: `PermissionDeniedError`, `DevicesNotFoundError`,
 * `TrackStartError` and `ConstraintNotSatisfiedError` are what older Chrome and the prefixed
 * implementations threw, and a browser old enough to use the prefixed entry point is exactly the
 * one that will not be updated.
 */
function causeForError(name: string): CameraFailureCause | null {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return null
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "no-camera"
    // The camera exists, the permission is fine, and the operating system will not hand it over —
    // almost always because a video call in another app or another tab already holds it. There is
    // no error on the platform that maps onto this one; it is the camera's own.
    case "NotReadableError":
    case "TrackStartError":
      return "in-use"
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "unsatisfiable"
    case "AbortError":
      return "interrupted"
    // Thrown where media support has been disabled at the browser level.
    case "SecurityError":
      return "blocked-by-policy"
    default:
      return "unknown"
  }
}

/** The facing the browser actually gave us, read off the live track rather than assumed. */
function resolveFacing(track: MediaStreamTrack | null | undefined): ResolvedCameraFacing {
  const mode = track?.getSettings?.().facingMode
  return mode === "user" || mode === "environment" ? mode : "unknown"
}

/** Stops every track on a stream. The only thing that turns the camera light off. */
function stopTracks(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks?.() ?? []) {
    track.onended = null
    track.stop()
  }
}

/** Fits `width`x`height` inside the caps, keeping the aspect ratio. Rounded to whole pixels. */
function fitWithin(
  width: number,
  height: number,
  maxWidth?: number,
  maxHeight?: number
): { width: number; height: number } {
  const scale = Math.min(
    1,
    maxWidth && maxWidth > 0 ? maxWidth / width : 1,
    maxHeight && maxHeight > 0 ? maxHeight / height : 1
  )
  if (scale >= 1) return { width, height }
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** A photo taken from the live preview. */
export interface CapturedPhoto {
  /** The encoded image. This is the thing to upload: `form.append("photo", blob, "photo.jpg")`. */
  blob: Blob
  /**
   * An object URL for showing it, owned by this component.
   *
   * Revoked on retake, on the next capture and on unmount, because an object URL pins its blob in
   * memory until somebody releases it and a capture screen is used over and over. Anything that
   * has to outlive the component — a preview elsewhere on the page, a value kept in form state —
   * should make its own from `blob` and revoke that itself.
   */
  url: string
  width: number
  height: number
  /** The encoding actually used. Not always what was asked for: see `imageType`. */
  type: string
}

/** The props to spread onto the `<video>` a headless consumer lays out. */
export interface CameraVideoProps {
  ref: React.RefObject<HTMLVideoElement | null>
  autoPlay: boolean
  playsInline: boolean
  muted: boolean
  onLoadedData: React.ReactEventHandler<HTMLVideoElement>
  onPlaying: React.ReactEventHandler<HTMLVideoElement>
}

export interface UseCameraCaptureOptions {
  /**
   * Which camera to ask for. Default `"user"`.
   *
   * Sent as `{ ideal: ... }`, never `{ exact: ... }`, and that choice is the whole of the second
   * trap this component exists for. `{ exact: "environment" }` fails outright with
   * `OverconstrainedError` on any device without a rear camera — every laptop — so a document
   * scanner written that way is broken on desktop. Plain `"environment"` never fails and instead
   * *silently hands back the front camera*, so the same scanner quietly photographs the user's
   * face and uploads it as their passport page. Neither is acceptable, so this takes the third
   * option: ask for the ideal, then read back what arrived and say so. `facing` reports the camera
   * actually in use and `facingFallback` is true when it is not the one that was asked for, which
   * is the signal a caller needs and that neither constraint spelling gives you.
   */
  facingMode?: CameraFacing
  /**
   * Pin one specific camera by id, from `devices`. Takes precedence over `facingMode`.
   *
   * Sent as `{ exact: ... }`, which is right here and wrong for facing: an `ideal` device id is
   * advisory, so the browser is free to ignore it and open a different camera, which makes a
   * "choose your camera" menu that does not choose.
   */
  deviceId?: string
  /** Resolution to ask for, as an ideal. Default 1280x720. The browser may give something else. */
  idealWidth?: number
  idealHeight?: number
  /**
   * Cap on the saved image, in pixels. Undefined keeps the camera's own resolution.
   *
   * Worth setting for anything that gets uploaded. A modern phone hands back 1080p or better and
   * re-encodes to a file of a few hundred kilobytes to a couple of megabytes per shot, which is
   * fine once and is not fine for the eight photos of a damaged parcel taken on a train.
   */
  maxWidth?: number
  maxHeight?: number
  /**
   * Encoding for the saved image. Default `"image/jpeg"`.
   *
   * JPEG rather than PNG deliberately: a camera frame is a photograph, and PNG stores it losslessly
   * at roughly an order of magnitude more bytes for no visible gain. A browser that does not
   * support the type asked for silently encodes PNG instead, which is why `CapturedPhoto.type`
   * reports what came back rather than what was requested.
   */
  imageType?: string
  /** 0 to 1, for lossy types. Default 0.92. */
  imageQuality?: number
  /**
   * Mirror the preview. Defaults to mirroring anything that is not known to face away.
   *
   * A front camera shown unmirrored is disorienting — you reach left and the reflection goes
   * right — which is why every video call mirrors your own tile. `unknown`, which is what a laptop
   * webcam reports, is treated as front-facing for this purpose because that is what it almost
   * always is.
   */
  mirrorPreview?: boolean
  /**
   * Mirror the *saved* image too. Default false, and it should usually stay false.
   *
   * This is the pair of settings people collapse into one, and collapsing them ruins the component
   * for half its uses: mirror the output and every photographed document, name badge, serial
   * number, whiteboard and receipt comes out with its text backwards. Selfies are the only case
   * where a mirrored file is what the user expected, and even phone cameras default to saving the
   * unmirrored frame.
   */
  mirrorOutput?: boolean
  /**
   * Keep the camera running after a photo is taken. Default false.
   *
   * Off by default because a recording indicator that stays lit next to a photo you have already
   * taken is the complaint this component is built to avoid, and because on a phone an idle camera
   * is a warm battery. The cost is that `retake` has to start the camera again, which takes about a
   * second — no second permission prompt, since the grant is already stored. Turn it on for a flow
   * that takes several shots in a row.
   */
  keepStreamAfterCapture?: boolean
  /** Start the camera on mount instead of waiting for `start()`. Default false. */
  autoStart?: boolean
  onCapture?: (photo: CapturedPhoto) => void
  /**
   * Called when something fails.
   *
   * Not `onError`: that is a native DOM attribute React defines on every element, so a prop by
   * that name collides with it as soon as these options are spread onto an element.
   */
  onFailure?: (failure: CameraFailure) => void
}

export interface UseCameraCaptureResult {
  phase: CameraPhase
  /** The last failure, or null. Cleared when the camera starts or a photo is taken. */
  failure: CameraFailure | null
  /** The photo just taken, or null. */
  photo: CapturedPhoto | null
  /** The stored permission, or "unknown" where the Permissions API can't say. */
  permission: PermissionState | "unknown"
  /** Whether the API exists. Starts true so the server and first client render agree. */
  isSupported: boolean
  /** The facing of the camera actually running. */
  facing: ResolvedCameraFacing
  /** True when the camera that arrived is not the one that was asked for. See `facingMode`. */
  facingFallback: boolean
  /** Whether the preview is being mirrored. */
  mirrored: boolean
  /**
   * The cameras this browser will name.
   *
   * Empty until the camera has been started once, and deliberately so: `enumerateDevices` answers
   * before any permission has been granted, but every `label` is the empty string, so a camera
   * menu built on mount is a list of blanks. Populated after a stream opens, when the labels are
   * real.
   */
  devices: CameraDevice[]
  activeDeviceId: string | null
  /** Whether there is another camera to switch to. */
  canSwitch: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** Spread onto your own `<video>`; carries the attributes that are not optional. */
  videoProps: CameraVideoProps
  /** Open the camera. Safe to call while one is running — the old stream is released first. */
  start: (override?: { facingMode?: CameraFacing; deviceId?: string }) => void
  /** Release the camera and go back to idle. */
  stop: () => void
  /** Take a photo from the current frame. */
  capture: () => Promise<CapturedPhoto | null>
  /** Throw the photo away and go back to the preview, restarting the camera if it was released. */
  retake: () => void
  /** Flip between front and rear, or step to the next camera where facing is unknown. */
  switchCamera: () => void
  selectDevice: (deviceId: string) => void
}

/**
 * The whole behaviour, for a capture screen you lay out yourself.
 */
export function useCameraCapture(options: UseCameraCaptureOptions = {}): UseCameraCaptureResult {
  const {
    facingMode = "user",
    deviceId,
    autoStart = false,
    mirrorPreview,
  } = options

  const [phase, setPhase] = React.useState<CameraPhase>("idle")
  const [failure, setFailure] = React.useState<CameraFailure | null>(null)
  const [photo, setPhoto] = React.useState<CapturedPhoto | null>(null)
  const [permission, setPermission] = React.useState<PermissionState | "unknown">("unknown")
  const [isSupported, setIsSupported] = React.useState(true)
  const [facing, setFacing] = React.useState<ResolvedCameraFacing>("unknown")
  const [facingFallback, setFacingFallback] = React.useState(false)
  const [devices, setDevices] = React.useState<CameraDevice[]>([])
  const [activeDeviceId, setActiveDeviceId] = React.useState<string | null>(null)

  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const streamRef = React.useRef<MediaStream | null>(null)
  const photoRef = React.useRef<CapturedPhoto | null>(null)
  const mountedRef = React.useRef(true)
  // Every start gets a number, and a continuation that is not the current one is dropped. There is
  // no way to cancel a `getUserMedia` already in flight, so without this a stream from an abandoned
  // attempt lands on top of a fresh one — and, worse, lands with nothing holding it, which is a
  // camera left switched on that no control on the page can reach. See `settle` below.
  const sessionRef = React.useRef(0)
  /**
   * Which camera the request in flight asked for, or null when none is.
   *
   * A second `getUserMedia` for the same camera while the first is still acquiring is never useful
   * and is actively harmful: on a phone the first request already holds the camera, so the
   * duplicate comes back `NotReadableError` and somebody who double-tapped Start is told another
   * app has their camera. Stopping the old stream first cannot help, because at that moment there
   * is no stream yet to stop. A request for a *different* camera is let through — that is a
   * deliberate change of mind, and the orphaned stream is stopped in `settle` when it arrives.
   */
  const pendingKeyRef = React.useRef<string | null>(null)
  const requestedFacingRef = React.useRef<CameraFacing>(facingMode)
  const facingRef = React.useRef<ResolvedCameraFacing>("unknown")
  const devicesRef = React.useRef<CameraDevice[]>([])
  const activeDeviceIdRef = React.useRef<string | null>(null)
  const permissionRef = React.useRef<PermissionState | "unknown">("unknown")
  const failureRef = React.useRef<CameraFailure | null>(null)

  // Options are read through a ref rather than closed over, so `start` and `capture` keep stable
  // identities. A callback that changes when an inline `onCapture` or a fresh `messages` object
  // changes would restart the camera on an unrelated re-render, and a camera that flickers off and
  // on mid-session is a worse bug than any it could fix.
  const optionsRef = React.useRef(options)
  React.useEffect(() => {
    optionsRef.current = options
  })

  // Declared before everything that reads it: under StrictMode the cleanups run and the effects run
  // again, and if this came last the second pass would see `false` and quietly refuse to work.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const active = React.useCallback((id: number) => mountedRef.current && sessionRef.current === id, [])

  const fail = React.useCallback((cause: CameraFailureCause, code: string | null) => {
    const next: CameraFailure = {
      cause,
      code,
      message: DEFAULT_MESSAGES[cause],
      retryable: RETRYABLE[cause],
    }
    failureRef.current = next
    setFailure(next)
    setPhase("error")
    optionsRef.current.onFailure?.(next)
  }, [])

  /**
   * Settles support on mount, with the reason rather than a bare boolean.
   *
   * Reporting only `isSupported: false` is what produces the thing this component argues against
   * everywhere else: a greyed-out button with nothing next to it saying why. Nobody has clicked
   * anything yet, so there is no failure to describe, and the one person who cannot use the camera
   * is the one told the least. Settling the cause here means the copy is on screen before the first
   * click, and `onFailure` fires early enough for a form to drop the field entirely.
   */
  React.useEffect(() => {
    if (isCameraCaptureSupported()) return
    // Reported once. `fail` mints a fresh failure object every call, so an unguarded version
    // re-announces itself through `onFailure` on every StrictMode remount — and a consumer that
    // shows a toast per failure gets two of them for a browser that was never going to work.
    if (failureRef.current) return
    setIsSupported(false)
    fail(insecureContext() ? "insecure-context" : "unsupported", null)
  }, [fail])

  /** Releases the object URL of the photo we are holding. */
  const releasePhoto = React.useCallback(() => {
    const held = photoRef.current
    photoRef.current = null
    if (held && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(held.url)
    }
  }, [])

  /**
   * Hands the camera back.
   *
   * Setting `srcObject` to null is not this, and believing it is costs an afternoon: the preview
   * goes black, the component looks stopped, and the operating system's camera light stays on
   * because the tracks are still live. `track.stop()` is the only thing that ends the capture, and
   * it has to happen on every path out — unmount, an explicit stop, a photo taken, and before any
   * restart.
   */
  const stopStream = React.useCallback(() => {
    const stream = streamRef.current
    streamRef.current = null
    stopTracks(stream)
    const video = videoRef.current
    if (video) video.srcObject = null
    facingRef.current = "unknown"
    activeDeviceIdRef.current = null
    if (mountedRef.current) {
      setFacing("unknown")
      setActiveDeviceId(null)
      setFacingFallback(false)
    }
  }, [])

  /**
   * Re-reads the camera list.
   *
   * Called after a stream opens rather than on mount. `enumerateDevices` answers either way, but
   * before a grant every `label` is the empty string and every `deviceId` may be too, so a menu
   * built at mount time offers a column of blanks.
   */
  const refreshDevices = React.useCallback(async () => {
    const api = mediaDevicesOf()
    if (!api || typeof api.enumerateDevices !== "function") return
    try {
      const all = await api.enumerateDevices()
      const cameras = all
        .filter((device) => device.kind === "videoinput")
        .map((device) => ({ deviceId: device.deviceId, label: device.label }))
      devicesRef.current = cameras
      if (mountedRef.current) setDevices(cameras)
    } catch {
      // Nothing here is worth failing a working camera over.
    }
  }, [])

  const start = React.useCallback(
    (override?: { facingMode?: CameraFacing; deviceId?: string }) => {
      const opts = optionsRef.current
      const api = mediaDevicesOf()
      if (!api) {
        setIsSupported(false)
        // The object is missing on http as well as on a browser that has no camera support at all,
        // and the two need opposite advice. Asked in this order so the http case says the true
        // thing instead of blaming the browser.
        fail(insecureContext() ? "insecure-context" : "unsupported", null)
        return
      }
      if (insecureContext()) {
        fail("insecure-context", null)
        return
      }
      if (blockedByPermissionsPolicy()) {
        fail("blocked-by-policy", null)
        return
      }

      const wantDevice = override?.deviceId ?? opts.deviceId
      const wantFacing = override?.facingMode ?? opts.facingMode ?? "user"
      const key = wantDevice ? `device:${wantDevice}` : `facing:${wantFacing}`
      if (pendingKeyRef.current === key) return
      requestedFacingRef.current = wantFacing

      // Released before asking, not after. On a phone the camera is exclusive: a second
      // `getUserMedia` while the first stream is still live comes back `NotReadableError`, so a
      // switch written as start-then-stop fails every time on the devices that have two cameras to
      // switch between.
      stopStream()

      const id = sessionRef.current + 1
      sessionRef.current = id
      pendingKeyRef.current = key
      failureRef.current = null
      setFailure(null)
      // "prompt" is the one state that reliably means a dialog is about to appear. Where the
      // Permissions API could not answer, claiming to know would be the lie.
      setPhase(permissionRef.current === "prompt" ? "prompting" : "starting")

      const video: MediaTrackConstraints = {}
      if (wantDevice) {
        // Exact, and no facing alongside it: two constraints naming different cameras is how you
        // get an OverconstrainedError out of a device that has both of them.
        video.deviceId = { exact: wantDevice }
      } else {
        video.facingMode = { ideal: wantFacing }
      }
      video.width = { ideal: opts.idealWidth ?? 1280 }
      video.height = { ideal: opts.idealHeight ?? 720 }

      const done = () => {
        if (sessionRef.current === id) pendingKeyRef.current = null
      }

      const settle = (stream: MediaStream) => {
        done()
        if (!active(id)) {
          // Abandoned while in flight. Nothing is holding this stream and nothing else ever will,
          // so it has to be stopped here or the camera stays on for the life of the page.
          stopTracks(stream)
          return
        }
        streamRef.current = stream
        const [track] = stream.getVideoTracks?.() ?? []
        const got = resolveFacing(track)
        facingRef.current = got
        setFacing(got)
        setFacingFallback(!wantDevice && got !== "unknown" && got !== wantFacing)
        const settings = track?.getSettings?.()
        activeDeviceIdRef.current = settings?.deviceId ?? null
        setActiveDeviceId(settings?.deviceId ?? null)

        // The source ending on its own — a webcam unplugged, the camera seized by the operating
        // system, the permission revoked from the browser's own UI while the page is open. Nothing
        // else reports it, and without this the preview simply freezes on its last frame.
        if (track) {
          track.onended = () => {
            if (!active(id)) return
            stopStream()
            fail("interrupted", "ended")
          }
        }

        const node = videoRef.current
        if (node) {
          node.srcObject = stream
          // Belt and braces for a consumer who laid out their own <video> and dropped `muted`:
          // an unmuted video is not allowed to autoplay, so the preview never starts and nothing
          // says why. Setting the property is what counts — the attribute alone does not.
          node.muted = true
          const played = node.play?.()
          // A rejection here is not fatal and must not be reported as one: `autoPlay` on a muted,
          // inline video starts it regardless, and `play()` is rejected merely for being
          // interrupted by the next load.
          if (played && typeof played.catch === "function") played.catch(() => {})
        }
        void refreshDevices()
      }

      const reject = (error: unknown) => {
        done()
        if (!active(id)) return
        const name = (error as DOMException | undefined)?.name ?? "unknown"
        const mapped = causeForError(name)
        if (mapped) {
          fail(mapped, name)
          return
        }

        // NotAllowedError, which is four different things.
        //
        // The two checked before the call are checked again, because a document can be moved into a
        // frame that forbids the feature between the two moments, and because a browser reaching
        // here when the pre-checks could not run still deserves the right answer. Then the stored
        // state decides the rest, read now rather than taken from React state: pressing Block both
        // fails this call and fires `change`, and there is no guarantee the event has arrived.
        if (insecureContext()) {
          fail("insecure-context", name)
          return
        }
        if (blockedByPermissionsPolicy()) {
          fail("blocked-by-policy", name)
          return
        }
        void queryCameraPermission().then((status) => {
          if (!active(id)) return
          if (!status) {
            // Nothing can tell these apart here, so the copy for `denied` carries the day — it is
            // the only one of the two that stays broken, and advice to check site settings is
            // harmless to somebody who merely closed the dialog.
            fail("denied", name)
            return
          }
          setPermission(status.state)
          permissionRef.current = status.state
          if (status.state === "denied") {
            fail("denied", name)
            return
          }
          // Refused while the stored answer is "granted" can only come from above the user — a
          // frame or a header — so sending them to their own settings would be wrong.
          if (status.state === "granted") {
            fail("blocked-by-policy", name)
            return
          }
          // Still "prompt": nothing was stored, so the dialog was closed rather than answered.
          // This is the one refusal worth offering a retry for, and asking again really re-prompts.
          fail("dismissed", name)
        })
      }

      try {
        const request = api.getUserMedia({ video, audio: false })
        // `audio: false`, not omitted. Asking for audio as well lights the microphone indicator and
        // puts a second permission in front of the user, for a component that takes photographs.
        request.then(settle, reject)
      } catch (error) {
        // A browser that throws synchronously rather than rejecting — the prefixed implementations
        // did, and a TypeError for malformed constraints still does.
        reject(error)
      }
    },
    [active, fail, refreshDevices, stopStream]
  )

  const stop = React.useCallback(() => {
    // Bumping the id first orphans anything still in flight, so a stream that arrives after this
    // is stopped by `settle` instead of quietly switching the camera back on.
    sessionRef.current += 1
    pendingKeyRef.current = null
    stopStream()
    failureRef.current = null
    setFailure(null)
    setPhase("idle")
  }, [stopStream])

  const capture = React.useCallback(async (): Promise<CapturedPhoto | null> => {
    const opts = optionsRef.current
    const node = videoRef.current
    if (!node || !streamRef.current) {
      fail("capture-failed", null)
      return null
    }

    // HAVE_CURRENT_DATA. This is the gate, and `loadedmetadata` is not: metadata publishes
    // `videoWidth` and `videoHeight`, so a canvas sized from them looks correct, but no frame has
    // necessarily been decoded yet and `drawImage` then paints nothing. The result is a photo of
    // exactly the right dimensions, entirely black, which passes every check a caller is likely to
    // write — it has a blob, it has a size, it is a valid JPEG.
    const width = node.videoWidth
    const height = node.videoHeight
    if ((node.readyState ?? 0) < 2 || !width || !height) {
      fail("capture-failed", null)
      return null
    }

    setPhase("capturing")
    const size = fitWithin(width, height, opts.maxWidth, opts.maxHeight)
    const canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      fail("capture-failed", null)
      return null
    }
    // A camera frame is nearly always drawn smaller than it arrived, and the default resampling
    // makes a downscale of that size crunchy in exactly the place people look at — a face.
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    if (opts.mirrorOutput) {
      ctx.translate(size.width, 0)
      ctx.scale(-1, 1)
    }
    ctx.drawImage(node, 0, 0, size.width, size.height)

    const type = opts.imageType ?? "image/jpeg"
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, opts.imageQuality ?? 0.92)
    })
    if (!mountedRef.current) return null
    if (!blob) {
      fail("capture-failed", null)
      return null
    }

    releasePhoto()
    const next: CapturedPhoto = {
      blob,
      url: URL.createObjectURL(blob),
      width: size.width,
      height: size.height,
      // What came back, not what was asked for: a browser that cannot encode the requested type
      // falls back to PNG without saying so, and a caller naming the upload ".jpg" from the request
      // ships a mislabelled file.
      type: blob.type || type,
    }
    photoRef.current = next
    setPhoto(next)
    failureRef.current = null
    setFailure(null)
    setPhase("captured")
    if (!opts.keepStreamAfterCapture) stopStream()
    opts.onCapture?.(next)
    return next
  }, [fail, releasePhoto, stopStream])

  const retake = React.useCallback(() => {
    releasePhoto()
    setPhoto(null)
    if (streamRef.current) {
      setPhase("live")
      return
    }
    start()
  }, [releasePhoto, start])

  const switchCamera = React.useCallback(() => {
    // Where the browser tells us which way the camera points, flip that — it is the request a phone
    // understands, and it keeps working when device ids are reshuffled between sessions, which
    // Safari does. Where facing is unknown, which is the ordinary answer on a laptop, step through
    // the enumerated cameras instead.
    if (facingRef.current !== "unknown") {
      start({ facingMode: facingRef.current === "user" ? "environment" : "user" })
      return
    }
    const list = devicesRef.current
    if (list.length < 2) return
    const at = list.findIndex((device) => device.deviceId === activeDeviceIdRef.current)
    const next = list[(at + 1) % list.length]
    if (next) start({ deviceId: next.deviceId })
  }, [start])

  const selectDevice = React.useCallback((id: string) => start({ deviceId: id }), [start])

  /**
   * Reads the stored permission and keeps the dead end honest.
   *
   * The `change` event is the reason this is a subscription rather than one read. A user sent to
   * site settings by the `denied` message comes back to a page that is still open, and the browser
   * fires `change` the moment they flip the switch. Handling it turns "allow it in your settings"
   * into advice that visibly works; ignoring it leaves the button dead until a reload, which is the
   * point at which people conclude the site is broken.
   */
  React.useEffect(() => {
    let status: PermissionStatus | null = null
    let cancelled = false

    const handleChange = () => {
      if (!status) return
      const next = status.state
      setPermission(next)
      permissionRef.current = next
      if (next === "denied") return
      if (failureRef.current?.cause === "denied") {
        failureRef.current = null
        setFailure(null)
        setPhase("idle")
      }
    }

    void queryCameraPermission().then((result) => {
      if (cancelled || !result) return
      status = result
      setPermission(result.state)
      permissionRef.current = result.state
      result.addEventListener("change", handleChange)
    })

    return () => {
      cancelled = true
      status?.removeEventListener("change", handleChange)
    }
  }, [])

  // The camera and the object URL both belong to the browser, not to this component, so navigating
  // away inside a single-page app is exactly the moment they would be leaked: the tracks keep the
  // camera light on with no control left that could turn it off, and the blob stays in memory.
  React.useEffect(
    () => () => {
      sessionRef.current += 1
      stopStream()
      releasePhoto()
    },
    [releasePhoto, stopStream]
  )

  React.useEffect(() => {
    if (autoStart) start()
  }, [autoStart, start])

  // A `facingMode` prop that changes while the camera is live is a request to turn it round. Guarded
  // against what it asked for last, not against what arrived, so a device that falls back to the
  // only camera it has does not sit here restarting forever.
  React.useEffect(() => {
    if (!streamRef.current) return
    if (facingMode === requestedFacingRef.current) return
    start({ facingMode })
  }, [facingMode, start])

  React.useEffect(() => {
    if (!streamRef.current || !deviceId) return
    if (deviceId === activeDeviceIdRef.current) return
    start({ deviceId })
  }, [deviceId, start])

  const videoProps = React.useMemo<CameraVideoProps>(
    () => ({
      ref: videoRef,
      autoPlay: true,
      // Without this an iPhone takes the preview fullscreen the moment it plays, covering the page
      // and the capture button with a native video player.
      playsInline: true,
      // Required for autoplay to be allowed at all.
      muted: true,
      // `loadeddata`, not `loadedmetadata`: metadata means the dimensions are known, which is not
      // the same as a frame existing. See `capture`, where the difference is a black photograph.
      onLoadedData: () => {
        if (streamRef.current) setPhase("live")
      },
      // Belt and braces: `loadeddata` is the event that means a frame exists, and `playing` is the
      // one every browser fires for a live stream. Taking either avoids a preview that runs while
      // the component still says it is starting.
      onPlaying: () => {
        if (streamRef.current) setPhase("live")
      },
    }),
    []
  )

  const mirrored = mirrorPreview ?? facing !== "environment"
  const canSwitch = facing !== "unknown" || devices.length > 1

  return {
    phase,
    failure,
    photo,
    permission,
    isSupported,
    facing,
    facingFallback,
    mirrored,
    devices,
    activeDeviceId,
    canSwitch,
    videoRef,
    videoProps,
    start,
    stop,
    capture,
    retake,
    switchCamera,
    selectDevice,
  }
}

export interface CameraCaptureProps
  extends Omit<React.ComponentPropsWithoutRef<"div">, "children" | "onCapture">,
    UseCameraCaptureOptions {
  /** Accessible name for the whole capture area. */
  label?: string
  /** Resting label on the primary button. */
  startLabel?: string
  captureLabel?: string
  retakeLabel?: string
  switchLabel?: string
  retryLabel?: string
  /** Alt text for the photo just taken. */
  photoAlt?: string
  /** Per-cause wording, merged over the defaults. */
  messages?: Partial<Record<CameraFailureCause, string>>
  /** Status wording. Each one is announced through the live region as it becomes true. */
  promptingMessage?: string
  startingMessage?: string
  liveMessage?: string
  capturedMessage?: string
  /** Shown when the device had no camera facing the way this asked. See `facingMode`. */
  facingFallbackMessage?: string
  /** Hide the message under the controls. It stays in the live region either way. */
  hideMessage?: boolean
  /** Class for the preview frame. `className` goes to the wrapper. */
  previewClassName?: string
}

/**
 * A "take a photo" control that hands the camera back when it is done with it.
 */
export function CameraCapture({
  label = "Camera",
  startLabel = "Start camera",
  captureLabel = "Take photo",
  retakeLabel = "Retake",
  switchLabel = "Switch camera",
  retryLabel = "Try again",
  photoAlt = "The photo you just took",
  messages,
  promptingMessage = "Waiting for camera permission…",
  startingMessage = "Starting the camera…",
  liveMessage = "The camera is on.",
  capturedMessage = "Photo taken.",
  facingFallbackMessage = "This device has only one camera, so it stayed on the one it has.",
  hideMessage = false,
  previewClassName,
  facingMode,
  deviceId,
  idealWidth,
  idealHeight,
  maxWidth,
  maxHeight,
  imageType,
  imageQuality,
  mirrorPreview,
  mirrorOutput,
  keepStreamAfterCapture,
  autoStart,
  onCapture,
  onFailure,
  className,
  ...props
}: CameraCaptureProps) {
  const {
    phase,
    failure,
    photo,
    facingFallback,
    mirrored,
    canSwitch,
    videoProps,
    start,
    capture,
    retake,
    switchCamera,
  } = useCameraCapture({
    facingMode,
    deviceId,
    idealWidth,
    idealHeight,
    maxWidth,
    maxHeight,
    imageType,
    imageQuality,
    mirrorPreview,
    mirrorOutput,
    keepStreamAfterCapture,
    autoStart,
    onCapture,
    onFailure,
  })

  // The message is referenced by id from the primary button, so it needs one that survives
  // hydration.
  const messageId = React.useId()

  const busy = phase === "prompting" || phase === "starting" || phase === "capturing"
  const live = phase === "live"

  const message = failure
    ? (messages?.[failure.cause] ?? failure.message)
    : phase === "prompting"
      ? promptingMessage
      : phase === "starting"
        ? startingMessage
        : phase === "captured"
          ? capturedMessage
          : live
            ? [liveMessage, facingFallback ? facingFallbackMessage : ""].filter(Boolean).join(" ")
            : ""

  // The only states where pressing the primary button is a real offer. A failure marked
  // non-retryable keeps the control reachable and says why, rather than dangling an action that
  // cannot work.
  const actionable = !busy && failure?.retryable !== false

  const primaryLabel = photo ? retakeLabel : live ? captureLabel : failure?.retryable ? retryLabel : startLabel
  const PrimaryIcon = busy ? Loader2 : photo ? RotateCcw : failure && !failure.retryable ? TriangleAlert : Camera

  function handlePrimary() {
    if (!actionable) return
    if (photo) {
      retake()
      return
    }
    if (live) {
      void capture()
      return
    }
    start()
  }

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}
      {...props}
    >
      <div
        className={cn(
          "relative aspect-[4/3] w-full overflow-hidden rounded-md border border-input bg-muted",
          previewClassName
        )}
      >
        {/*
          Mounted from the first render and never conditionally rendered. A <video> that only
          appears once there is a stream is not in the tree when `getUserMedia` resolves, so the ref
          is null, the stream is never attached, and what you get is a camera that is switched on
          with no preview and no obvious reason why. A live preview also carries nothing for a
          screen reader — there is no text in it — so it is hidden from the accessibility tree and
          the live region below does the talking.
        */}
        <video
          {...videoProps}
          aria-hidden="true"
          className={cn(
            "h-full w-full object-cover",
            mirrored && "scale-x-[-1]",
            (photo || phase === "idle" || phase === "error") && "invisible"
          )}
        />
        {photo ? (
          <img
            src={photo.url}
            alt={photoAlt}
            className="absolute inset-0 h-full w-full bg-background object-contain"
          />
        ) : null}
        {phase === "idle" || phase === "error" ? (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Camera className="h-8 w-8" aria-hidden="true" />
          </div>
        ) : null}
        {busy ? (
          <div className="absolute inset-0 grid place-items-center bg-background/60">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handlePrimary}
          // `aria-disabled` rather than `disabled`, so the control keeps its place in the tab order
          // and can still be reached and read. A real `disabled` button is skipped entirely, which
          // means the one explanation of why the camera is unavailable is delivered to everyone
          // except the people who most need it.
          aria-disabled={actionable ? undefined : true}
          aria-busy={busy || undefined}
          aria-describedby={message ? messageId : undefined}
          data-phase={phase}
          data-cause={failure?.cause}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-input bg-transparent px-4 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          <PrimaryIcon className={cn("h-4 w-4", busy && "animate-spin")} aria-hidden="true" />
          {primaryLabel}
        </button>
        {live && canSwitch ? (
          <button
            type="button"
            onClick={switchCamera}
            aria-label={switchLabel}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-transparent transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <SwitchCamera className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/*
        Mounted from the start and left empty, never conditionally rendered, and never `hidden`.
        A live region inserted into the document already holding its text is not reliably announced,
        and `hidden`, `display:none` and `aria-hidden` all take it out of the accessibility tree,
        which is the same silence as not rendering it. `sr-only` is the one way to hide it visually
        and keep it speaking.
      */}
      <p
        id={messageId}
        role="status"
        aria-live="polite"
        className={cn("text-sm text-muted-foreground", (hideMessage || !message) && "sr-only")}
      >
        {message}
      </p>
    </div>
  )
}
