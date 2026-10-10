// Thin wrapper around the State Engine API's capability-declaration call.
// No additional logic belongs in this file - see src/extension.js for
// where this gets called, and docs/architecture.md for how capabilities
// work.

// See src/api/namespace.js for why this is a dynamic import, and why
// these two paths (adjust if your State Engine folder is named
// differently) are repeated per-file rather than centralized - each
// src/api/*.js file wraps exactly one call, independently, on purpose.
const API_PATH = '../../../SillyTavern-StateEngine/src/api/index.js';
const IDENTITY_PATH = '../../../SillyTavern-StateEngine/src/api/identity.js';

// Declares the capabilities this extension provides - plain strings
// such as "ui.panel" or "data.inventory" - so another extension can find
// it via stateEngine.getExtensionsProviding(capability). REPLACES (does
// not merge with) any list this extensionId declared on an earlier load;
// an empty array clears it. See the State Engine API Reference,
// "Extension Capability Graph".
export async function declareCapabilities(extensionId, capabilities) {
    const { stateEngine } = await import(API_PATH);
    const { ensureInstanceId } = await import(IDENTITY_PATH);
    return stateEngine.declareCapabilities(extensionId, ensureInstanceId(), capabilities);
}
