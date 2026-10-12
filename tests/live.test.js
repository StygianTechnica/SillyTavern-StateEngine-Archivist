import { getContext, openChat, files, failNext } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, getMemoriesForEntity, getAllMemories } from '../src/memory/archivist.js';
import { getSettings } from '../src/settings.js';
import { ensureLivePreset, syncLivePreset, harvest, startLiveExtraction, repairLiveExtraction, LIVE_PRESET, LIVE_VARIABLE_VERSION } from '../src/extraction/live.js';
import { CONTEXT_BLOCKS } from '../src/context/prompt-context.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const VAR = 'archivist__memories';
let fake;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const waitFor = (check) => vi.waitFor(check, { timeout: 1000, interval: 5 });

beforeEach(async () => {
    fake = resetFakeStateEngine();
    getContext().chat = [
        { is_user: true, mes: 'Where is the key?', send_date: 'd0' },
        { is_user: false, mes: 'Mira slips the key under the inn\'s floorboard.', send_date: 'd1' },
    ];
    fake.addObject('chr_mira', 'character', 'Mira');
    fake.addObject('loc_inn', 'location', 'The Old Inn', 'inn');
    await loadCurrentChat();
});

describe('ensureLivePreset', () => {
    it('creates a regular preset on the ai trigger, hidden from the tracker, with the memories variable', async () => {
        await ensureLivePreset();
        const preset = fake.presets.get(`archivist.${LIVE_PRESET}`);
        expect(preset).toMatchObject({ triggers: ['ai'], showInTracker: false });
        expect(preset.variables.get(VAR)).toMatchObject({ type: 'array', itemType: 'record', behaviors: { prompted: true } });
        expect(getSettings().liveVariableVersion).toBe(LIVE_VARIABLE_VERSION);
    });

    it('is idempotent and keeps the user\'s edits while the version is current', async () => {
        await ensureLivePreset();
        fake.presets.get(`archivist.${LIVE_PRESET}`).variables.get(VAR).prompted.instructions = 'my own wording';
        await ensureLivePreset();

        expect(fake.calls.filter((c) => c.name === 'createPreset')).toHaveLength(1);
        // The memory variable and the prompt-context ones (src/context/), each once.
        expect(fake.calls.filter((c) => c.name === 'createVariable')).toHaveLength(1 + CONTEXT_BLOCKS.length);
        expect(fake.calls.filter((c) => c.name === 'updateVariable')).toHaveLength(0);
        expect(fake.presets.get(`archivist.${LIVE_PRESET}`).variables.get(VAR).prompted.instructions).toBe('my own wording');
    });

    it('updates an existing variable from an older version', async () => {
        await ensureLivePreset();
        getSettings().liveVariableVersion = 0;
        await ensureLivePreset();
        expect(fake.calls.filter((c) => c.name === 'updateVariable')).toHaveLength(1);
        expect(getSettings().liveVariableVersion).toBe(LIVE_VARIABLE_VERSION);
    });

    it('is named "Archivist Recent Memory Collection"', () => {
        expect(LIVE_PRESET).toBe('Archivist Recent Memory Collection');
    });

    it('renames a preset still called "Live" in place, keeping its activations and edits', async () => {
        fake.stateEngine.createPreset('x', 'i', { namespace: 'archivist', name: 'Live', triggers: ['ai'] });
        fake.stateEngine.createVariable('x', 'i', { namespace: 'archivist', presetName: 'Live', name: 'memories', type: 'array', prompted: { instructions: 'my own wording' } });
        fake.stateEngine.activatePreset('x', 'i', 'Chat A', 'archivist', 'Live');
        getSettings().liveVariableVersion = LIVE_VARIABLE_VERSION;

        await ensureLivePreset();

        expect(fake.presets.has('archivist.Live')).toBe(false);
        expect(fake.presets.get(`archivist.${LIVE_PRESET}`).variables.get(VAR).prompted.instructions).toBe('my own wording');
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
        expect(fake.calls.filter((c) => c.name === 'createPreset')).toHaveLength(1);
    });

    it('throws when State Engine refuses the preset', async () => {
        fake.stateEngine.createPreset = () => null;
        await expect(ensureLivePreset()).rejects.toThrow('could not create');
    });
});

describe('syncLivePreset', () => {
    beforeEach(() => ensureLivePreset());

    it('activates the preset for the open chat when enabled', async () => {
        getSettings().enabled = true;
        await syncLivePreset();
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
    });

    it('deactivates it when disabled', async () => {
        getSettings().enabled = true;
        await syncLivePreset();
        getSettings().enabled = false;
        await syncLivePreset();
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(false);
    });
});

describe('self-repair', () => {
    beforeEach(async () => {
        getSettings().enabled = true;
        await ensureLivePreset();
        await syncLivePreset();
    });

    it('recreates a deleted Live preset and its variable when a chat opens, and re-activates it', async () => {
        fake.presets.delete(`archivist.${LIVE_PRESET}`);
        await syncLivePreset();
        expect(fake.presets.get(`archivist.${LIVE_PRESET}`).variables.has(VAR)).toBe(true);
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
    });

    it('recreates a deleted variable alone', async () => {
        fake.presets.get(`archivist.${LIVE_PRESET}`).variables.delete(VAR);
        await syncLivePreset();
        expect(fake.presets.get(`archivist.${LIVE_PRESET}`).variables.has(VAR)).toBe(true);
    });

    it('re-activates a preset the user deactivated', async () => {
        fake.stateEngine.deactivatePreset('x', 'i', 'Chat A', 'archivist', LIVE_PRESET);
        await repairLiveExtraction();
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);
    });

    it('leaves the preset alone while Archivist is disabled', async () => {
        getSettings().enabled = false;
        fake.presets.delete(`archivist.${LIVE_PRESET}`);
        await syncLivePreset();
        expect(fake.presets.has(`archivist.${LIVE_PRESET}`)).toBe(false);
    });

    it('keeps stored memory when the preset is deleted', async () => {
        fake.writeValue('Chat A', VAR, [{ text: 'safe' }]);
        await harvest('Chat A');
        fake.presets.delete(`archivist.${LIVE_PRESET}`);
        await syncLivePreset();
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['safe']);
    });
});

describe('harvest', () => {
    beforeEach(async () => {
        getSettings().enabled = true;
        await ensureLivePreset();
        await syncLivePreset();
    });

    it('stores the extracted memories against the newest AI message, then clears the variable', async () => {
        fake.writeValue('Chat A', VAR, [
            { text: 'Mira hid the key under the inn\'s floorboard.', subtype: 'secret', scope: 'long_term', importance: 'high', entities: ['Mira', 'inn', 'a stranger'] },
        ]);
        await harvest('Chat A');

        const [record] = await getAllMemories();
        expect(record).toMatchObject({
            text: 'Mira hid the key under the inn\'s floorboard.', subtype: 'secret', scope: 'long_term', importance: 'high',
            entity_ids: ['chr_mira', 'loc_inn'], source_message_id: 'Chat A#1@d1', chat_id: 'Chat A',
        });
        expect(fake.readValue('Chat A', VAR)).toEqual([]);
        expect(getMemoriesForEntity('loc_inn')).toHaveLength(1);
    });

    it('never creates State Engine objects for unknown names', async () => {
        fake.writeValue('Chat A', VAR, [{ text: 'A stranger arrived.', entities: ['Stranger'] }]);
        await harvest('Chat A');
        expect(fake.calls.map((c) => c.name)).not.toContain('createChatObject');
        expect((await getAllMemories())[0].entity_ids).toEqual([]);
    });

    it('does nothing when the variable is empty', async () => {
        await harvest('Chat A');
        expect(await getAllMemories()).toEqual([]);
        expect(fake.calls.filter((c) => c.name === 'setVariableValue')).toHaveLength(0);
        expect(files.size).toBe(0);
    });

    it('ignores changes in a chat that is not open', async () => {
        fake.writeValue('Other Chat', VAR, [{ text: 'elsewhere' }]);
        await harvest('Other Chat');
        expect(await getAllMemories()).toEqual([]);
        expect(fake.readValue('Other Chat', VAR)).toEqual([{ text: 'elsewhere' }]);
    });

    it('treats a chatId of null as the open chat', async () => {
        fake.writeValue('Chat A', VAR, [{ text: 'one' }]);
        await harvest(null);
        expect(await getAllMemories()).toHaveLength(1);
    });

    it('stores each memory once when change events overlap', async () => {
        fake.writeValue('Chat A', VAR, [{ text: 'one' }, { text: 'two' }]);
        await Promise.all([harvest('Chat A'), harvest('Chat A'), harvest(null)]);
        await settle();
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['one', 'two']);
    });

    it('picks up a value written while a harvest is running', async () => {
        // The next update lands right after the first was read and cleared,
        // while it is still being stored - and its change event arrives then.
        const clear = fake.stateEngine.setVariableValue;
        fake.stateEngine.setVariableValue = (...args) => {
            const result = clear(...args);
            fake.stateEngine.setVariableValue = clear;
            fake.writeValue('Chat A', VAR, [{ text: 'second' }]);
            void harvest('Chat A');
            return result;
        };
        fake.writeValue('Chat A', VAR, [{ text: 'first' }]);
        await harvest('Chat A');
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['first', 'second']);
        expect(fake.readValue('Chat A', VAR)).toEqual([]);
    });

    it('keeps memories it could not store and retries with the next harvest', async () => {
        fake.writeValue('Chat A', VAR, [{ text: 'kept for later' }]);
        failNext('POST', '/api/files/upload');
        await harvest('Chat A');
        expect(await getAllMemories()).toEqual([]);
        expect(fake.readValue('Chat A', VAR)).toEqual([]);

        await harvest('Chat A');
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['kept for later']);
    });

    it('falls back to an unknown source when the chat has no AI message', async () => {
        getContext().chat = [{ is_user: true, mes: 'hello' }];
        fake.writeValue('Chat A', VAR, [{ text: 'one' }]);
        await harvest('Chat A');
        expect((await getAllMemories())[0].source_message_id).toBe('Chat A#unknown');
    });
});

describe('startLiveExtraction', () => {
    it('stores memories as State Engine writes them while enabled', async () => {
        getSettings().enabled = true;
        await startLiveExtraction();
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(true);

        fake.writeValue('Chat A', VAR, [{ text: 'Mira laughed.', entities: ['Mira'] }]);
        await waitFor(async () => expect(getMemoriesForEntity('chr_mira')).toHaveLength(1));
        await waitFor(() => expect(fake.readValue('Chat A', VAR)).toEqual([]));
    });

    it('stores nothing while disabled', async () => {
        getSettings().enabled = false;
        await startLiveExtraction();
        fake.writeValue('Chat A', VAR, [{ text: 'ignored' }]);
        await settle();
        await settle();
        expect(await getAllMemories()).toEqual([]);
        expect(fake.isActive('Chat A', LIVE_PRESET)).toBe(false);
    });

    it('activates the preset in each chat opened while enabled', async () => {
        getSettings().enabled = true;
        await startLiveExtraction();
        openChat({ chatId: 'Bob Chat', characterId: 1 });
        await getContext().eventSource.emit('chat_id_changed');
        await waitFor(() => expect(fake.isActive('Bob Chat', LIVE_PRESET)).toBe(true));
    });
});
