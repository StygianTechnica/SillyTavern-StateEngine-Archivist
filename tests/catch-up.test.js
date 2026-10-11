// Catch-up: planning (catch-up-plan.js) and the background pass
// (catch-up.js) against the State Engine stand-in, whose `respond` plays
// the model.

import { getContext, openChat } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords, getAllMemories, getMemoriesForEntity } from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { sourceMessageId } from '../src/extraction/messages.js';
import { uncoveredIndexes, toChunks, carryOver, chunkContext, sourceIndexFor, MAX_MESSAGE_CHARS } from '../src/extraction/catch-up-plan.js';
import {
    startCatchUp, cancelCatchUp, getCatchUpProgress, onCatchUpProgress, isCatchUpRunning,
    CATCH_UP_PRESET, CATCH_UP_HEADER, BUSY_RETRY_MS,
} from '../src/extraction/catch-up.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const VAR = 'archivist__catchup_memories';
const msg = (i, extra = {}) => ({ name: i % 2 ? 'Mira' : 'User', is_user: i % 2 === 0, mes: `message ${i}`, send_date: `d${i}`, ...extra });
const chatOf = (n) => Array.from({ length: n }, (_, i) => msg(i));
const rec = (chatId, i, chat, extra = {}) => ({ id: `m${i}`, subtype: 'event', scope: 'scene', importance: 'medium', text: `memory ${i}`, entity_ids: [], source_message_id: sourceMessageId(chatId, i, chat[i]), chat_id: chatId, created_at: 't', ...extra });

describe('planning', () => {
    const chat = chatOf(8);

    it('sends every message when nothing is covered', () => {
        expect(uncoveredIndexes(chat, [], 'C')).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });

    it('skips messages with memories, and a user message whose reply has memories', () => {
        expect(uncoveredIndexes(chat, [rec('C', 3, chat)], 'C')).toEqual([0, 1, 4, 5, 6, 7]);
    });

    it('does not count a memory from an edited message (different send date)', () => {
        const old = rec('C', 3, chat, { source_message_id: 'C#3@older' });
        expect(uncoveredIndexes(chat, [old], 'C')).toContain(3);
    });

    it('resumes after the last catch-up, unless that message changed', () => {
        expect(uncoveredIndexes(chat, [], 'C', { index: 4, sendDate: 'd4' })).toEqual([5, 6, 7]);
        expect(uncoveredIndexes(chat, [], 'C', { index: 4, sendDate: 'other' })).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(uncoveredIndexes(chat, [], 'C', { index: 99, sendDate: 'd99' })).toHaveLength(8);
    });

    it('never sends hidden or empty messages', () => {
        const withHidden = [msg(0), msg(1, { is_system: true }), msg(2, { mes: '  ' }), msg(3)];
        expect(uncoveredIndexes(withHidden, [], 'C')).toEqual([0, 3]);
    });

    it('chunks', () => {
        expect(toChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(toChunks([], 50)).toEqual([]);
        expect(toChunks([1, 2], 0)).toEqual([[1], [2]]);
    });

    it('carries the newest important memories from before the chunk, oldest first, within a budget', () => {
        const records = [
            rec('C', 1, chat, { text: 'old high', importance: 'high' }),
            rec('C', 2, chat, { text: 'low one', importance: 'low' }),
            rec('C', 3, chat, { text: 'recent medium' }),
            rec('C', 6, chat, { text: 'after the chunk starts' }),
        ];
        expect(carryOver(records, 5)).toEqual(['- old high', '- recent medium']);
        expect(carryOver(records, 5, 18)).toEqual(['- recent medium']);
    });

    it('labels each message with its index and speaker, and trims huge ones', () => {
        const long = [msg(0), msg(1, { mes: 'x'.repeat(MAX_MESSAGE_CHARS + 50) })];
        const text = chunkContext(long, [0, 1], ['- known']);
        expect(text).toMatch(/^Already remembered \(do not repeat these\):\n- known\n\nChat messages:\n\[#0\] User: message 0\n\[#1\] Mira: x+\.\.\.$/);
        expect(chunkContext(long, [0], [])).toBe('Chat messages:\n[#0] User: message 0');
    });

    it('attributes a memory to the message it names, else the chunk\'s last reply', () => {
        expect(sourceIndexFor({ message_index: 3 }, [2, 3, 4], chat)).toBe(3);
        expect(sourceIndexFor({ message_index: '#4' }, [2, 3, 4], chat)).toBe(4);
        expect(sourceIndexFor({ message_index: 9 }, [2, 3, 4], chat)).toBe(3);
        expect(sourceIndexFor({}, [2, 3, 4], chat)).toBe(3);
    });
});

describe('the catch-up pass', () => {
    let fake;
    let passes;
    const run = async () => {
        const done = [];
        const started = await startCatchUp({ whenDone: (p) => done.push(p) });
        if (started) await done[0];
        passes.push(getCatchUpProgress());
        return started;
    };
    const contexts = () => fake.calls.filter((c) => c.name === 'runIndependentPreset').map((c) => c.args[2]);

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        fake.addObject('chr_mira', 'character', 'Mira');
        passes = [];
        getContext().chat = chatOf(6);
        getSettings().chunkSize = 2;
        await loadCurrentChat();
        // The "model": one memory per chunk, about its second message.
        fake.respond = async (context) => {
            const indexes = [...context.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
            return [{ text: `Mira did something in ${indexes.join('+')}`, subtype: 'event', importance: 'high', entities: ['Mira'], message_index: indexes[1] ?? indexes[0] }];
        };
    });

    it('creates its own independent preset with the catch-up header and variable', async () => {
        await run();
        const preset = fake.presets.get(`archivist.${CATCH_UP_PRESET}`);
        expect(preset.independentPreset).toBe(true);
        expect(preset.independentConfig.promptedHeader).toBe(CATCH_UP_HEADER);
        expect(preset.variables.get(VAR)).toMatchObject({ type: 'array', itemType: 'record', prompted: { newEachTurn: true } });
        expect(preset.variables.get(VAR).prompted.instructions).toContain('message_index');
    });

    it('runs on the chosen connection with its own max tokens', async () => {
        getSettings().connectionProfileId = 'profile-big';
        getSettings().catchUpMaxTokens = 3000;
        await run();
        const config = fake.calls.filter((c) => c.name === 'configureIndependentPreset').at(-1).args[2];
        expect(config).toMatchObject({ connectionProfileId: 'profile-big', maxTokens: 3000, enabled: true });
    });

    it('reads the chat in chunks and stores each memory against the message it came from', async () => {
        await run();
        expect(contexts()).toHaveLength(3);
        expect(contexts()[0]).toContain('[#0] User: message 0\n[#1] Mira: message 1');
        const memories = await getAllMemories();
        expect(memories.map((m) => m.text)).toEqual(['Mira did something in 0+1', 'Mira did something in 2+3', 'Mira did something in 4+5']);
        expect(memories.map((m) => m.source_message_id)).toEqual(['Chat A#1@d1', 'Chat A#3@d3', 'Chat A#5@d5']);
        expect(getMemoriesForEntity('chr_mira')).toHaveLength(3);
        expect(fake.readValue('Chat A', VAR)).toEqual([]);
        expect(passes[0]).toMatchObject({ running: false, outcome: 'completed', total: 3, done: 3, messages: 6, stored: 3, failedChunks: 0 });
    });

    it('passes what is already remembered into later chunks', async () => {
        await run();
        expect(contexts()[0]).not.toContain('Already remembered');
        expect(contexts()[2]).toContain('Already remembered (do not repeat these):\n- Mira did something in 0+1\n- Mira did something in 2+3');
    });

    it('resumes rather than repeating: a second run finds nothing to do', async () => {
        await run();
        expect(getChatEntry('char:alice.png:Chat A').catchUp).toEqual({ index: 5, sendDate: 'd5' });
        await run();
        expect(passes[1].outcome).toBe('nothing');
        expect(contexts()).toHaveLength(3);
    });

    it('picks up only the messages added since', async () => {
        await run();
        getContext().chat.push(msg(6), msg(7));
        await run();
        expect(contexts().at(-1)).toBe('Already remembered (do not repeat these):\n- Mira did something in 0+1\n- Mira did something in 2+3\n- Mira did something in 4+5\n\nChat messages:\n[#6] User: message 6\n[#7] Mira: message 7');
    });

    it('skips messages live extraction already covered', async () => {
        await addMemoryRecords(getCurrentChatRef(), [{ text: 'live', source_message_id: 'Chat A#3@d3' }]);
        await run();
        expect(contexts().join('\n')).not.toMatch(/\[#[23]\]/);
    });

    it('reports a failed chunk, carries on, and keeps the resume point before it', async () => {
        let call = 0;
        const respond = fake.respond;
        fake.respond = async (context) => {
            call++;
            if (call === 2) throw new Error('model timed out');
            return respond(context);
        };
        await run();
        expect(passes[0]).toMatchObject({ outcome: 'completed', failedChunks: 1, lastError: 'model timed out', stored: 2 });
        expect(getChatEntry('char:alice.png:Chat A').catchUp).toEqual({ index: 1, sendDate: 'd1' });

        // The next run retries what failed.
        await run();
        expect(contexts().at(-1)).toContain('[#2] User: message 2');
    });

    it('fails when every chunk fails', async () => {
        fake.respond = async () => { throw new Error('no connection'); };
        await run();
        expect(passes[0]).toMatchObject({ outcome: 'failed', failedChunks: 3, lastError: 'no connection' });
    });

    it('waits and retries while another independent preset is running', async () => {
        vi.useFakeTimers();
        try {
            let busy = 2;
            const respond = fake.respond;
            fake.respond = async (context) => (busy-- > 0 ? 'busy' : respond(context));
            const done = [];
            await startCatchUp({ whenDone: (p) => done.push(p) });
            await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS * 3);
            await done[0];
            expect(getCatchUpProgress()).toMatchObject({ outcome: 'completed', failedChunks: 0, stored: 3 });
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops between chunks when cancelled, keeping what it stored', async () => {
        const respond = fake.respond;
        fake.respond = async (context) => {
            cancelCatchUp();
            return respond(context);
        };
        await run();
        expect(passes[0]).toMatchObject({ outcome: 'cancelled', done: 1, stored: 1 });
        expect(await getAllMemories()).toHaveLength(1);
    });

    it('keeps writing to the chat it started on when the user switches chats', async () => {
        const respond = fake.respond;
        fake.respond = async (context, info) => {
            openChat({ chatId: 'Bob Chat', characterId: 1 });
            return respond(context, info);
        };
        await run();
        expect(fake.calls.filter((c) => c.name === 'runIndependentPreset').every((c) => c.args[0] === 'Chat A')).toBe(true);
        expect(await getAllMemories('Chat A')).toHaveLength(3);
        expect(getChatEntry('char:bob.png:Bob Chat')).toBeNull();
    });

    it('runs one pass at a time, and only with a chat open', async () => {
        const done = [];
        expect(await startCatchUp({ whenDone: (p) => done.push(p) })).toBe(true);
        expect(isCatchUpRunning()).toBe(true);
        expect(await startCatchUp()).toBe(false);
        await done[0];

        openChat({ chatId: undefined });
        expect(await startCatchUp()).toBe(false);
    });

    it('reports progress as it goes', async () => {
        const seen = [];
        const stop = onCatchUpProgress((p) => seen.push(`${p.done}/${p.total}`));
        await run();
        stop();
        expect(seen).toEqual(expect.arrayContaining(['0/3', '1/3', '2/3', '3/3']));
    });
});
