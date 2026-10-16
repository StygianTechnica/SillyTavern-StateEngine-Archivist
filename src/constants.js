// Archivist's identity toward the State Engine API, shared by every module
// that makes State Engine calls (src/extension.js today; the extraction
// presets and their variables later).

// Must be unique across every extension that talks to the State Engine
// API on this SillyTavern install - it is how the State Engine tells
// Archivist's calls apart from anyone else's. Matches the folder/repo name.
export const EXTENSION_ID = 'SillyTavern-StateEngine-Archivist';

// Prefixes every variable and preset Archivist creates through the State
// Engine (e.g. a variable named "memories" is stored as
// "ar__memories"). Letters and digits only, starting with a
// letter - see the State Engine API Reference, "Namespace Model".
export const NAMESPACE = 'ar';

// Prefix for Archivist's console output.
export const LOG_PREFIX = '[Archivist]';
