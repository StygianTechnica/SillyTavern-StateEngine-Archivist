// Runs before every test file (vitest.config.js): installs the SillyTavern
// stand-in from st.js as the browser globals Archivist expects.

import { getContext, fakeFetch, resetSillyTavern } from './st.js';

globalThis.window = globalThis;
globalThis.SillyTavern = { getContext };
globalThis.fetch = vi.fn(fakeFetch);

beforeEach(() => {
    resetSillyTavern();
    globalThis.fetch.mockClear();
});
