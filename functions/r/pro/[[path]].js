// Pro block gate: serves a Pro block's JSON only when a valid license key is presented
// (via `?key=`), validated against the D1 `licenses` table; otherwise returns 402.
// Pro block contents live in _pro-blocks.js, which is not committed and not served statically,
// so they cannot be retrieved without a valid key.
//
// The gate itself is in functions/_pro-gate.js and takes the block map as a parameter — this file
// is the one place that names the uncommitted module, which is what lets the gate be unit-tested
// (test/pro-gate.test.mjs) on a checkout that does not have it.
import { PRO_BLOCKS } from "../../_pro-blocks.js"
import { handleProGet } from "../../_pro-gate.js"

export const onRequestGet = (context) => handleProGet(context, PRO_BLOCKS)
