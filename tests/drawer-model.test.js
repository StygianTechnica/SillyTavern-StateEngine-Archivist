import { statusLine, chatSummary, recentMemories, memoryView, compilerLine, RECENT_COUNT, updateTokenLimit, tokenLimitLine } from '../src/ui/drawer-model.js';

describe('statusLine', () => {
    it('says off while disabled, whatever the health', () => {
        expect(statusLine({ state: 'error', error: 'x' }, false)).toEqual({ text: expect.stringMatching(/^Off/), error: false });
    });

    it('says on while enabled and working', () => {
        expect(statusLine({ state: 'ok' }, true)).toEqual({ text: expect.stringMatching(/^On/), error: false });
    });

    it('shows the failure, and points to Repair', () => {
        const line = statusLine({ state: 'error', error: 'could not create the Live preset' }, true);
        expect(line.error).toBe(true);
        expect(line.text).toContain('could not create the Live preset');
        expect(line.text).toContain('Repair');
        expect(statusLine({ state: 'error', error: null }, true).text).toContain('State Engine refused');
    });
});

describe('chatSummary', () => {
    it('covers no chat, no memories, a few, and more than are listed', () => {
        expect(chatSummary(false, 0)).toBe('No chat open.');
        expect(chatSummary(true, 0)).toBe('No memories stored for this chat yet.');
        expect(chatSummary(true, 1)).toBe('1 memory stored for this chat:');
        expect(chatSummary(true, 3)).toBe('3 memories stored for this chat:');
        expect(chatSummary(true, 12)).toBe(`12 memories stored for this chat - the newest ${RECENT_COUNT}:`);
    });
});

describe('recentMemories', () => {
    it('lists the newest first, at most RECENT_COUNT', () => {
        const records = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}` }));
        expect(recentMemories(records).map((r) => r.id)).toEqual(['m7', 'm6', 'm5', 'm4', 'm3']);
        expect(recentMemories(records.slice(0, 2)).map((r) => r.id)).toEqual(['m1', 'm0']);
        expect(recentMemories([])).toEqual([]);
    });
});

describe('memoryView', () => {
    it('shows type, scope and importance, with the details in the tooltip', () => {
        const view = memoryView({
            id: 'm', subtype: 'secret', scope: 'long_term', importance: 'high', text: 'Mira hid the key.',
            entity_ids: ['chr_mira'], source_message_id: 'Chat A#4@d', chat_id: 'Chat A', created_at: '2026-10-11T12:00:00.000Z',
        });
        expect(view.meta).toEqual(['secret', 'long term', 'high']);
        expect(view.text).toBe('Mira hid the key.');
        expect(view.importance).toBe('high');
        expect(view.title).toContain('About: chr_mira');
        expect(view.title).toContain('From message: Chat A#4@d');
    });

    it('leaves out "About" for a memory naming no one', () => {
        const view = memoryView({ subtype: 'fact', scope: 'scene', importance: 'low', text: 't', entity_ids: [], source_message_id: 's', created_at: 'c' });
        expect(view.title).not.toContain('About');
    });
});

describe('compilerLine', () => {
    it('says what the compiler is doing or did', () => {
        expect(compilerLine(null, null).text).toBe('Not compiled yet.');
        expect(compilerLine({ running: true, batch: 2, batches: 3 }, null).text).toBe('Compiling - part 2 of 3...');
        expect(compilerLine({ running: true, rebuild: true, batches: 1 }, null).text).toBe('Rebuilding...');
        expect(compilerLine({ running: true, batch: 1, batches: 2, part: 'world' }, null).text).toBe('Compiling - part 1 of 2 (threads and world)...');
        expect(compilerLine({ outcome: 'failed', error: 'model down' }, null)).toEqual({ text: 'The last compile failed: model down.', error: true });
        expect(compilerLine({ outcome: 'compiled' }, { at: '2026-10-11T12:00:00.000Z', pending: 0 }).text).toMatch(/^Compiled .+ · up to date\.$/);
        expect(compilerLine(null, { at: '2026-10-11T12:00:00.000Z', pending: 2 }).text).toMatch(/· 2 new memories since\.$/);
    });
});

describe('the token limit warning', () => {
    it('reads the limit State Engine runs its update with', () => {
        expect(updateTokenLimit(undefined)).toBe(300);
        expect(updateTokenLimit({ responseLength: 800 })).toBe(800);
        expect(updateTokenLimit({ responseLength: 800, stateEngineProfileId: 'p', stateEngineMaxTokens: 1500 })).toBe(1500);
        expect(updateTokenLimit({ responseLength: 800, stateEngineProfileId: 'p', stateEngineMaxTokens: null })).toBe(800);
        expect(updateTokenLimit({ responseLength: 800, stateEngineMaxTokens: 1500 })).toBe(800);
    });

    it('warns while Archivist is on and the limit is too small', () => {
        expect(tokenLimitLine({ responseLength: 300 }, true)).toEqual({ text: expect.stringMatching(/limited to 300 tokens \(Max response length/), error: true });
        expect(tokenLimitLine({ responseLength: 300, stateEngineProfileId: 'p', stateEngineMaxTokens: 400 }, true).text).toContain("connection profile's Max tokens");
        expect(tokenLimitLine({ responseLength: 1200 }, true).text).toBe('');
        expect(tokenLimitLine({ responseLength: 300 }, false).text).toBe('');
    });
});
