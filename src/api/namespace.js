// Thin wrapper around the State Engine API's namespace-claiming call.
// No additional logic belongs in this file - see src/extension.js for
// where this gets called, and docs/architecture.md for how namespaces work.

// Adjust these two paths if your State Engine installation folder is
// named differently than "SillyTavern-StateEngine" (SillyTavern installs
// extensions as sibling folders under .../extensions/third-party/, and
// there is currently no global `window.stateEngine` to reach instead -
// see docs/architecture.md, "Reaching the State Engine API").
//
// Deliberately a DYNAMIC import, not a static one at the top of the
// file: a static import is resolved when the module graph loads, before
// src/api/dependency-check.js ever gets a chance to run its own check -
// if the path doesn't resolve (State Engine genuinely not installed),
// that would crash the whole extension outright. A dynamic import only
// runs, and only fails, when claimNamespace() is actually called - which
// src/extension.js only does after confirming State Engine is present.
const API_PATH = '../../../SillyTavern-StateEngine/src/api/index.js';
const IDENTITY_PATH = '../../../SillyTavern-StateEngine/src/api/identity.js';

// Claims `namespace` for `extensionId`. Idempotent for the SAME
// extensionId re-claiming the same namespace on a later page load;
// throws if the namespace is already taken by a different extension, or
// if this extensionId already owns a different namespace. See the State
// Engine API Reference, "Caller Identity".
export async function claimNamespace(extensionId, namespace) {
    const { stateEngine } = await import(API_PATH);
    const { ensureInstanceId } = await import(IDENTITY_PATH);
    return stateEngine.createNamespace(extensionId, ensureInstanceId(), namespace);
}
