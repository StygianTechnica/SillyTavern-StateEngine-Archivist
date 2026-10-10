# Architecture

This template is deliberately thin: four files under `src/api/` - three
that each wrap exactly one State Engine API call, plus one that checks
the dependency is actually there before any of them run - one
`src/extension.js` that ties them together in the right order, and one
`src/index.js` that starts it all when SillyTavern loads the page. This
document explains what those calls actually do and why they're needed,
so extending the template is a decision about *your* extension's
design, not a guessing game about the scaffold's.

## Reaching the State Engine API

The State Engine extension does not expose a global like
`window.stateEngine` the way it does for its World Info surface
(`window.StateEngineWI`). The only way to reach `stateEngine.*` today is
an ES module import of its `src/api/index.js` (and, for the identity
helper `ensureInstanceId()`, its `src/api/identity.js` directly - that
one function is deliberately not part of the `stateEngine` object). This
template imports both with a relative path that assumes the State
Engine extension is installed as a SIBLING folder to this one:

```
public/scripts/extensions/third-party/
  SillyTavern-StateEngine/                    <- the State Engine extension
  SillyTavern-StateEngine-ExtensionTemplate/  <- this one (or your renamed clone)
```

If your install has the State Engine extension under a different folder
name, update the two `const ..._PATH` lines repeated at the top of
`src/api/namespace.js`, `registration.js`, and `capabilities.js` (they
each import the same two things, from the same relative path,
independently - see "Why the path is repeated three times", below) -
there's nowhere else in the template this assumption is baked in.

Each of those three files imports its two paths with a DYNAMIC
`import()` INSIDE its exported function, not a static `import ... from`
at the top of the file. This is deliberate, not a style choice: a
static import is resolved when the module graph loads - before
`src/api/dependency-check.js` (below) ever gets a chance to run its own
check - so if the path doesn't resolve (State Engine genuinely not
installed), a static import would crash the whole extension outright. A
dynamic import only runs, and only fails, at the moment
`claimNamespace()`/`registerWithStateEngine()`/`declareCapabilities()`
is actually called - which `src/extension.js` only does after
confirming State Engine is present.

### Why the path is repeated three times

Each `src/api/*.js` file wraps exactly one call, independently, by
design (see "Extension lifecycle", below) - so the two path constants
are copied into each file rather than pulled from one shared module.
This keeps every file individually readable ("this file does one thing,
here's everything it needs to do it") at the cost of three places to
edit if you ever rename your State Engine install folder. If that
trade-off doesn't suit your extension once it grows, factoring the two
constants into their own small module is a reasonable, purely
structural change - it wouldn't alter any behavior described here.

## Extension lifecycle

1. **SillyTavern loads `manifest.json`**, reads `js` (`"src/index.js"`),
   and fetches that file as an ES module. SillyTavern does not call any
   particular exported function from it - loading the file is the only
   contract.
2. **`src/index.js` runs.** It calls `jQuery(() => { void initExtension(); })`
   - the same "wait for the page to be ready, then self-start"
     convention every SillyTavern extension uses, since nothing else is
     going to call your extension's init for you. Not awaited - nothing
     downstream needs this extension's own startup to block the rest of
     the page.
3. **`initExtension()` (`src/extension.js`) checks the State Engine
   dependency FIRST**, before anything else - see "Dependency checking",
   below. If it's missing, this is where the lifecycle ends: one popup,
   one warning logged, and `initExtension()` returns. Nothing past this
   point ever runs.
4. **Only if the check passes**, `initExtension()` runs the three real
   calls, in order:
   - `claimNamespace()` - see "Namespaces", below.
   - `registerWithStateEngine()` - see "Registration", below.
   - `declareCapabilities()` - see "Capabilities", below.
5. **Every later page load repeats steps 3-4.** There is no "first run
   only" special case anywhere in this template - `createNamespace()` is
   idempotent for the same extension re-claiming the same namespace, and
   `registerExtension()`/`declareCapabilities()` simply replace the
   previous declaration with an identical one. Your extension's own
   later code (once you add some) can rely on the namespace already
   being claimed by the time anything else in your extension runs,
   without needing its own "is this the first load?" check - as long as
   it also only runs after the dependency check has passed (which
   anything called from inside `initExtension()`, after that check,
   automatically satisfies).

There is no shutdown/teardown lifecycle to hook into - a SillyTavern
extension's code just stops running when the page unloads.

## Dependency checking

Every extension built from this template automatically verifies that
the State Engine extension is actually present before doing anything
else - `src/api/dependency-check.js`, called first thing inside
`initExtension()`. Three failure modes are treated as one: not
installed, not enabled, or its API not reachable all produce the exact
same result (one popup, initialization aborted) - the check doesn't try
to tell them apart, since the useful action for a user is identical in
all three cases ("go install/enable it").

- **The signal**: `window.StateEngineWI`, a global the State Engine
  extension sets for ITSELF once its own startup sequence finishes -
  which only happens if SillyTavern actually loaded and ran it as an
  enabled extension. No file path is probed or hardcoded to detect
  this - it's a runtime check, not an import.
- **The race**: this extension's own script might run before State
  Engine's asynchronous startup has finished, even if State Engine is
  perfectly healthy. Rather than guessing with an arbitrary delay, the
  check waits - at most once - for SillyTavern's own `APP_READY` event
  (the same signal State Engine's own `initialization-engine.js` waits
  for internally), then re-checks the same signal exactly one more
  time. If `APP_READY` already fired before this ran, or there's no
  event bus to wait on, it doesn't hang - it resolves immediately and
  moves on to the one re-check. This is a single bounded wait, never a
  retry loop.
- **The third failure mode** ("its API cannot be reached") is caught by
  wrapping the three real calls in `initExtension()`'s own try/catch:
  even if `window.StateEngineWI` was present, an unexpected failure
  calling `claimNamespace()`/etc. (a version mismatch, a broken install)
  triggers the exact same popup rather than an uncaught error.
- **The popup**: plain language, shown through SillyTavern's own Popup
  UI when available, falling back to a guaranteed `window.alert()`
  otherwise - see the "must not crash" reasoning in
  `dependency-check.js`'s own comments. A module-level flag ensures it
  is shown AT MOST once per page load, no matter how many times
  something calls `warnStateEngineMissing()`.

You do not need to repeat this check anywhere else in your own code -
anything you add inside (or called from) `initExtension()`, after the
three State Engine calls, only ever runs once the dependency is already
confirmed present.

## Namespaces

A namespace is the prefix every variable and preset your extension
creates through the State Engine carries - `myExtension__mood`, not
`mood`. It exists so two different extensions (or the same extension
loaded twice by mistake) can never collide on a variable name.

- **Claiming** (`stateEngine.createNamespace(extensionId, instanceId,
  namespace)`, wrapped by `src/api/namespace.js`) is a one-time
  registration of "this extension id owns this namespace" - it creates
  no variables or presets itself. An extension owns at most one
  namespace; claiming a second one for the same `extensionId` throws.
- **Identity**: every write this API accepts is checked against
  `(extensionId, instanceId)` - `instanceId` is a per-browser-tab token
  (`ensureInstanceId()`) that stops one extension from acting through
  another's identity by accident. It is not a security boundary against
  genuinely hostile code in the same page, only a mistake-catcher.
- Once claimed, every `stateEngine.createVariable`/`createPreset`/etc.
  call names the namespace it targets (`def.namespace`, or a
  `{ namespace, presetName, ... }` ref), and every WRITE is refused
  unless that namespace is the one your `extensionId` owns.
- **Reads are wider than writes.** Calls that only read or display state
  - `listAllVariables`, `getVariableValue(s)`, `getVariableImage`,
  `listRoles`/`resolveRoles`, the character reads, the datetime
  formatters - accept any registered extension and span EVERY
  namespace, including the user's own `se` one, and return copies. So
  do a few chat-level actions that change no definition:
  `activatePreset`/`deactivatePreset`, `assignRole`, `requestRoles`. In
  short: anything that edits a definition is owner-only; anything that
  shows or binds state is open to registered callers - which is why
  every extension should claim a namespace even if it never creates a
  variable.

## Registration

`stateEngine.registerExtension(extensionId, instanceId, metadata)`
(wrapped by `src/api/registration.js`) is pure discovery metadata -
`{ namespace, variables?, capabilities?, dependsOn?, description? }` -
so another extension can find out your extension exists and what it
claims to provide, via `stateEngine.getRegisteredExtensions()` or
`getExtensionRegistration(extensionId)`. It creates nothing: no preset,
no variable, no capability graph edge. Registering is *optional* in the
sense that nothing breaks if you skip it, but it's what makes your
extension discoverable, so this template does it unconditionally.

A call to `registerExtension()` REPLACES any previous registration for
your `extensionId` - it does not merge field-by-field with what you
registered on an earlier load. If you later add real variables, list
their fully-qualified names (`myExtension__mood`, not `mood`) in
`metadata.variables` so other extensions can see what you expose.

## Capabilities

`stateEngine.declareCapabilities(extensionId, instanceId, capabilities)`
(wrapped by `src/api/capabilities.js`) is a second, narrower discovery
layer: plain strings like `"ui.panel"` or `"data.inventory"` describing
what your extension PROVIDES, separate from registration's broader
metadata. Another extension can look up who provides a capability via
`stateEngine.getExtensionsProviding(capability)`, and declare its own
dependency on one via `stateEngine.declareDependencies(...)` - see
[how-to-extend.md](how-to-extend.md), "Declaring dependencies".

Nothing validates that a declared dependency's provider actually
exists or is installed - the capability graph is advisory, not
enforced. A capability string means whatever the extensions using it
agree it means; there is no central registry of valid capability names.
