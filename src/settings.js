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
    // SillyTavern Connection Profile for catch-up runs ('' = State Engine's
    // own connection).
    connectionProfileId: '',
    // Max tokens for a catch-up run's answer: a chunk of many messages can
    // hold many memories.
    catchUpMaxTokens: 2000,
    // Catch-up's (and a memory rebuild's) temperature: low, like the
    // compiler's - extraction is bookkeeping, and a small model keeps to its
    // JSON at a low temperature.
    catchUpTemperature: 0.3,
    // Chat registry: { [chatKey]: entry } - see src/memory/registry.js.
    chats: {},
    // Which version of the live preset's extraction variable is installed
    // (src/extraction/live.js, LIVE_VARIABLE_VERSION). null = none yet.
    liveVariableVersion: null,
    // The same, for the catch-up preset (src/extraction/catch-up.js).
    catchUpVariableVersion: null,
    // The compiler (src/compiler/): compile on its own, by the schedule
    // (src/compiler/schedule.js) - while Archivist is enabled.
    compileAuto: true,
    // ...once this many new (not near-repeat) memories have arrived,
    compileThreshold: 15,
    // ...or this long after the last compile, with at least one new memory,
    compileIntervalMinutes: 30,
    // ...but never sooner than this after the last one.
    compileMinGapMinutes: 5,
    // The compiler's connection ('' = State Engine's) and answer size: the
    // whole compiled list comes back each run.
    compilerConnectionProfileId: '',
    compilerMaxTokens: 3000,
    // The compiler's temperature: low, so a small model keeps to the JSON
    // it is asked for (at 1 it slips - brackets, quotes, elided lists).
    compilerTemperature: 0.3,
    // Also compile story threads, quests and the world (a second run per
    // batch, through the World Compiler preset).
    compileWorld: true,
    // Which version of the compiler preset's variables is installed.
    compilerVariableVersion: null,
    // Phrase tics (src/compiler/phrase-tics.js): the compiler finds the
    // narration's repeated stock phrases, each reply is checked against
    // them, and Curator can ask the model to vary its wording...
    trackPhraseTics: true,
    // ...and a tic loses a count after this many AI replies without it.
    phraseTicFadeAfter: 10,
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
