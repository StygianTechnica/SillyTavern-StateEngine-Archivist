// Archivist's persisted settings, kept in SillyTavern's own
// extension_settings under the "archivist" key so they are saved with the
// rest of the user's settings. Memory records themselves are NOT stored
// here - they live in one JSON file per chat (src/memory/storage.js); this
// only holds switches and the small chat registry that maps each chat to
// its file (src/memory/registry.js).

const SETTINGS_KEY = 'archivist';

const DEFAULTS = {
    // The drawer's "Enable Archivist" switch: when off, no extraction runs.
    // Stored memory stays readable through the query APIs either way.
    enabled: false,
    // Messages per catch-up chunk.
    chunkSize: 50,
    // SillyTavern Connection Profile for catch-up runs ('' = the active one).
    connectionProfileId: '',
    // Chat registry: { [chatKey]: entry } - see src/memory/registry.js.
    chats: {},
};

// Returns the live settings object, creating it (and filling in any
// missing defaults) on first use.
export function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[SETTINGS_KEY] || typeof extensionSettings[SETTINGS_KEY] !== 'object') {
        extensionSettings[SETTINGS_KEY] = {};
    }
    const settings = extensionSettings[SETTINGS_KEY];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (settings[key] === undefined) settings[key] = structuredClone(value);
    }
    return settings;
}

export function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}
