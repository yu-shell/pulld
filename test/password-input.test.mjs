// password-input was the only field in this registry that dropped the caller's ref. Standalone it
// looked perfect — you can type, the toggle works — because a ref only matters once a form library
// asks for the element. `register()` from react-hook-form and shadcn's `FormField` both read an
// uncontrolled field through its ref, so a dropped ref means the form records no password at all
// while every visible part of the component keeps working.
//
// The probe that found it was wrong twice before it was right: comparing against a component that
// bridges its ref through `useImperativeHandle` (which the harness stubs away) shows "no ref" for a
// component that is perfectly fine. The control here is floating-label-input, which hands the
// caller's own ref straight to its input — so a passing control proves the probe can see a ref at
// all before the failing case is allowed to mean anything.
import { test } from "node:test"
import assert from "node:assert/strict"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { loadComponent, render, walk, byTag } from "./_react-harness.mjs"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const icons = new Proxy({}, { get: () => () => null })

const { PasswordInput } = loadComponent(join(ROOT, "registry", "ui", "password-input.tsx"), {
  stubs: { "lucide-react": icons },
})
const { FloatingLabelInput } = loadComponent(
  join(ROOT, "registry", "ui", "floating-label-input.tsx"),
  { stubs: { "lucide-react": icons } }
)

/** Renders with a ref of our own in the forwarded position and hands back the field it landed on. */
function fieldFor(Component, props = {}) {
  const ref = { current: null }
  const instance = render((p) => Component(p, ref), props)
  const inputs = byTag(walk(instance.tree), "input")
  return { ref, input: inputs[0], instance, inputs }
}

test("the control shows this probe can see a forwarded ref at all", () => {
  const { ref, input } = fieldFor(FloatingLabelInput, { label: "Email" })
  assert.equal(input.props.ref, ref, "floating-label-input hands the caller's ref to its input")
})

test("the caller's ref reaches the password field itself", () => {
  const { ref, input } = fieldFor(PasswordInput, { name: "password" })
  assert.equal(input.props.type, "password")
  assert.equal(input.props.ref, ref, "a form library reading this field through its ref finds nothing")
})

test("native input props still pass straight through", () => {
  const { input } = fieldFor(PasswordInput, {
    name: "password",
    autoComplete: "new-password",
    required: true,
    placeholder: "••••••••",
  })
  assert.equal(input.props.name, "password")
  assert.equal(input.props.autoComplete, "new-password")
  assert.equal(input.props.required, true)
  assert.equal(input.props.placeholder, "••••••••")
})

test("the toggle swaps the field type and says which state it is in", () => {
  const { instance, input } = fieldFor(PasswordInput)
  const readAll = () => walk(instance.tree)
  const button = byTag(readAll(), "button")[0]
  assert.equal(input.props.type, "password")
  assert.equal(button.props["aria-pressed"], false)
  assert.equal(button.props["aria-label"], "Show password")
  // The toggle must never be a tab stop: it sits between the password field and the submit button,
  // and a keyboard user tabbing out of a password should reach submit, not a reveal control.
  assert.equal(button.props.tabIndex, -1)
  assert.equal(button.props.type, "button", "a bare button inside a form would submit it")

  button.props.onClick()
  instance.rerender()
  const after = byTag(readAll(), "input")[0]
  const buttonAfter = byTag(readAll(), "button")[0]
  assert.equal(after.props.type, "text")
  assert.equal(buttonAfter.props["aria-pressed"], true)
  assert.equal(buttonAfter.props["aria-label"], "Hide password", "the name has to follow the state")
})
