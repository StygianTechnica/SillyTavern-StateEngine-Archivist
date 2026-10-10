// Thin wrapper around the State Engine API's extension-registration call.
// No additional logic belongs in this file - see src/extension.js for
// where this gets called, and docs/architecture.md for how registration
// works.

// See src/api/namespace.js for why this is a dynamic import, and why
// these two paths (adjust if your State Engine folder is named
// differently) are repeated per-file rather than centralized - each
// src/api/*.js file wraps exactly one call, independently, on purpose.
const API_PATH = '../../../SillyTavern-StateEngine/src/api/index.js';
const IDENTITY_PATH = '../../../SillyTavern-StateEngine/src/api/identity.js';

// Declares what this extension provides, so other extensions can
// discover it. `metadata: { namespace, variables?, capabilities?,
// dependsOn?, description? }` - see the State Engine API Reference,
// "Extension Registration API", for the full field shapes. A call here
// REPLACES any previous registration for this extensionId - it does not
// merge with one from an earlier load.
export async function registerWithStateEngine(extensionId, metadata) {
    const { stateEngine } = await import(API_PATH);
    const { ensureInstanceId } = await import(IDENTITY_PATH);
    return stateEngine.registerExtension(extensionId, ensureInstanceId(), metadata);
}
