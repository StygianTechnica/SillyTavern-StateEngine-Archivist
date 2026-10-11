// Module mock for src/api/state-engine.js: hands the current fake State
// Engine (tests/harness/state-engine.js) to every wrapper in src/api/.

import { fake } from './state-engine.js';

export async function getStateEngine() {
    return { stateEngine: fake.stateEngine, instanceId: 'test-instance' };
}
