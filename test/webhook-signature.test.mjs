// Unit tests for the Polar webhook signature gate (functions/api/polar-webhook.js).
// This is the security boundary that decides whether a request may provision or REVOKE a paid
// Search/Pro license, so a regression here is high-stakes and silent (a forged webhook would be
// accepted, or a genuine one rejected). functions/ is excluded from tsconfig, so `node --test` is
// its only automated coverage. We exercise the pure primitives (timingSafeEqual, secretCandidates)
// and a full sign→verify round-trip through verifySignature, including the failure modes the gate
// must reject: tampered body, expired timestamp, wrong secret, and missing headers.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  timingSafeEqual,
  secretCandidates,
  hmacB64,
  verifySignature,
} from "../functions/api/polar-webhook.js"

// verifySignature only calls headers.get(name); a plain Map wrapper is enough.
const headersOf = (obj) => ({ get: (k) => (k in obj ? obj[k] : null) })
const nowSec = () => Math.floor(Date.now() / 1000)

// Reproduce exactly what Polar signs: base64(HMAC-SHA256(key, `${id}.${ts}.${body}`)), header as a
// space-separated list of `v1,<sig>` tokens. Uses the module's own hmacB64 + secretCandidates so
// the test signs the same way production verifies.
async function signedHeaders(secret, { id, ts, body, tokenPrefix = "v1," }) {
  const [keyBytes] = secretCandidates(secret) // first candidate = utf8(secret)
  const sig = await hmacB64(keyBytes, `${id}.${ts}.${body}`)
  return headersOf({
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": `${tokenPrefix}${sig}`,
  })
}

test("timingSafeEqual: true only for equal strings; length mismatch and non-strings are false", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true)
  assert.equal(timingSafeEqual("abc", "abd"), false)
  assert.equal(timingSafeEqual("abc", "ab"), false) // different length
  assert.equal(timingSafeEqual("", ""), true)
  assert.equal(timingSafeEqual(null, "abc"), false)
  assert.equal(timingSafeEqual("abc", undefined), false)
})

test("secretCandidates: always tries the raw utf8 secret first", () => {
  const cands = secretCandidates("plain-secret")
  assert.ok(cands.length >= 1)
  assert.deepEqual(Array.from(cands[0]), Array.from(new TextEncoder().encode("plain-secret")))
})

test("secretCandidates: a polar_whs_ secret also yields a prefix-stripped candidate", () => {
  const withPrefix = secretCandidates("polar_whs_abcdef")
  const stripped = new TextEncoder().encode("abcdef")
  const hasStripped = withPrefix.some(
    (c) => c.length === stripped.length && stripped.every((b, i) => b === c[i])
  )
  assert.ok(hasStripped, "expected a candidate equal to utf8('abcdef')")
})

test("verifySignature: accepts a correctly signed, fresh payload", async () => {
  const secret = "polar_whs_test"
  const ts = nowSec()
  const body = JSON.stringify({ type: "subscription.created", data: { id: "sub_1" } })
  const headers = await signedHeaders(secret, { id: "evt_1", ts, body })
  assert.equal(await verifySignature(secret, headers, body), true)
})

test("verifySignature: accepts when the header carries several space-separated tokens", async () => {
  const secret = "polar_whs_test"
  const ts = nowSec()
  const body = "{}"
  const [keyBytes] = secretCandidates(secret)
  const good = await hmacB64(keyBytes, `evt_2.${ts}.${body}`)
  const headers = headersOf({
    "webhook-id": "evt_2",
    "webhook-timestamp": String(ts),
    // a wrong token alongside the correct one — the gate must still accept
    "webhook-signature": `v1,AAAAstillwrong v1,${good}`,
  })
  assert.equal(await verifySignature(secret, headers, body), true)
})

test("verifySignature: rejects a tampered body (signature no longer matches)", async () => {
  const secret = "polar_whs_test"
  const ts = nowSec()
  const body = JSON.stringify({ type: "subscription.created", data: { id: "sub_1" } })
  const headers = await signedHeaders(secret, { id: "evt_1", ts, body })
  const tampered = JSON.stringify({ type: "subscription.created", data: { id: "sub_HACKED" } })
  assert.equal(await verifySignature(secret, headers, tampered), false)
})

test("verifySignature: rejects a stale timestamp outside the 5-minute replay window", async () => {
  const secret = "polar_whs_test"
  const ts = nowSec() - 400 // > 300s old
  const body = "{}"
  const headers = await signedHeaders(secret, { id: "evt_3", ts, body })
  assert.equal(await verifySignature(secret, headers, body), false)
})

test("verifySignature: rejects a valid signature made with the wrong secret", async () => {
  const ts = nowSec()
  const body = "{}"
  const headers = await signedHeaders("polar_whs_attacker", { id: "evt_4", ts, body })
  assert.equal(await verifySignature("polar_whs_real", headers, body), false)
})

test("verifySignature: rejects when required Standard-Webhooks headers are missing", async () => {
  const secret = "polar_whs_test"
  const body = "{}"
  assert.equal(await verifySignature(secret, headersOf({}), body), false)
  assert.equal(
    await verifySignature(
      secret,
      headersOf({ "webhook-id": "evt_5", "webhook-timestamp": String(nowSec()) }),
      body
    ),
    false
  )
})

test("verifySignature: rejects a non-numeric timestamp", async () => {
  const secret = "polar_whs_test"
  const body = "{}"
  const [keyBytes] = secretCandidates(secret)
  const sig = await hmacB64(keyBytes, `evt_6.not-a-number.${body}`)
  const headers = headersOf({
    "webhook-id": "evt_6",
    "webhook-timestamp": "not-a-number",
    "webhook-signature": `v1,${sig}`,
  })
  assert.equal(await verifySignature(secret, headers, body), false)
})
