// Entry point (see manifest.json's "js" field). SillyTavern loads this
// file directly and does not call any function in it for you, so this
// file both exports initExtension (for anyone who wants to call it
// explicitly - a test, another module) and calls it itself once the
// page is ready, the same jQuery-ready convention every SillyTavern
// extension uses to self-start. No other logic belongs here - see
// src/extension.js for what initExtension() actually does.

import { initExtension } from './extension.js';

export default initExtension;

jQuery(() => {
    // initExtension() is async (it checks for the State Engine
    // dependency and, if present, awaits its API calls) - not awaited
    // here on purpose, the same fire-and-forget convention State
    // Engine's own entry point uses for its own non-blocking startup
    // work, since nothing here needs to block the rest of the page load.
    void initExtension();
});
