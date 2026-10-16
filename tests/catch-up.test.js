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
    startCatchUp, cancelCatchUp, getCatchUpProgress, onCatchUpProgress, isCatchUpRunning, rebuildMessagesLeft,
    CATCH_UP_PRESET, CATCH_UP_HEADER,
} from '../src/extraction/catch-up.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const VAR = 'ar__catchup_memories';
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
        const preset = fake.presets.get(`ar.${CATCH_UP_PRESET}`);
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
        expect(config).toMatchObject({ connectionProfileId: 'profile-big', maxTokens: 3000, temperature: 0.3, enabled: true });
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

describe('rebuilding the memories from the chat', () => {
    let fake;
    const rebuild = async () => {
        const done = [];
        const started = await startCatchUp({ rebuild: true, whenDone: (p) => done.push(p) });
        if (started) await done[0];
        return getCatchUpProgress();
    };
    const contexts = () => fake.calls.filter((c) => c.name === 'runIndependentPreset' && c.args[1].name === CATCH_UP_PRESET).map((c) => c.args[2]);
    const texts = async () => (await getAllMemories()).map((m) => m.text);

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        getContext().chat = chatOf(6);
        Object.assign(getSettings(), { chunkSize: 2, enabled: true, compileAuto: true, compileWorld: false });
        await loadCurrentChat();
        // What the chat had before: an old memory on messages 1 and 3, and
        // one from a swipe of message 5 that isn't shown.
        await addMemoryRecords(getCurrentChatRef(), [
            { text: 'old 1', source_message_id: 'Chat A#1@d1' },
            { text: 'old 3', source_message_id: 'Chat A#3@d3' },
            { text: 'other swipe of 5', source_message_id: 'Chat A#5@swipe' },
        ]);
        fake.respond = async (context) => {
            if (!context.includes('Chat messages:')) return { ar__compiled_facts: [{ text: 'compiled', sources: ['m1'] }] };
            const indexes = [...context.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
            return [{ text: `new ${indexes.join('+')}`, message_index: indexes[1] }];
        };
    });

    it('reads every message again and replaces each chunk\'s memories - not another swipe\'s - then recompiles', async () => {
        const { getCompilerStatus } = await import('../src/compiler/compiler.js');
        const progress = await rebuild();
        // Every message, covered or not.
        expect(contexts()).toHaveLength(3);
        expect(contexts()[0]).not.toContain('Already remembered');
        expect(contexts()[1]).toContain('Already remembered (do not repeat these):\n- new 0+1');
        expect(await texts()).toEqual(['other swipe of 5', 'new 0+1', 'new 2+3', 'new 4+5']);
        expect(progress).toMatchObject({ rebuild: true, outcome: 'completed', total: 3, stored: 3 });
        expect(getChatEntry('char:alice.png:Chat A').memoryRebuild).toBeNull();
        await vi.waitFor(() => expect(getCompilerStatus()).toMatchObject({ running: false, rebuild: true, reason: 'memory rebuild', outcome: 'compiled' }));
        expect(getCatchUpProgress().compileStarted).toBe(true);
    });

    it('keeps a failed chunk\'s old memories, and Continue reads only that chunk', async () => {
        const respond = fake.respond;
        let calls = 0;
        fake.respond = async (context) => {
            if (context.includes('Chat messages:') && ++calls === 2) throw new Error('model timed out');
            return respond(context);
        };
        const { getCompilerStatus } = await import('../src/compiler/compiler.js');
        const first = await rebuild();
        // No recompile while chunks wait to be retried.
        expect(first).toMatchObject({ outcome: 'completed', failedChunks: 1, compileStarted: false });
        expect(await texts()).toEqual(['old 3', 'other swipe of 5', 'new 0+1', 'new 4+5']);
        // Which messages are rebuilt: all but the failed chunk's.
        expect(getChatEntry('char:alice.png:Chat A').memoryRebuild).toEqual({ done: ['0@d0', '1@d1', '4@d4', '5@d5'] });
        expect(rebuildMessagesLeft('char:alice.png:Chat A')).toBe(2);

        fake.respond = respond;
        const second = await rebuild();
        expect(contexts().slice(3)).toEqual([expect.stringMatching(/\[#2\] User: message 2\n\[#3\] Mira: message 3$/)]);
        expect(second).toMatchObject({ outcome: 'completed', total: 1, failedChunks: 0 });
        expect(await texts()).toEqual(['other swipe of 5', 'new 0+1', 'new 4+5', 'new 2+3']);
        expect(getChatEntry('char:alice.png:Chat A').memoryRebuild).toBeNull();
        expect(rebuildMessagesLeft('char:alice.png:Chat A')).toBe(0);
        await vi.waitFor(() => expect(getCompilerStatus()).toMatchObject({ reason: 'memory rebuild', running: false }));
    });

    it('stops between chunks when asked, keeping the rest', async () => {
        const respond = fake.respond;
        fake.respond = async (context) => {
            if (context.includes('[#0]')) cancelCatchUp();
            return respond(context);
        };
        const progress = await rebuild();
        expect(progress).toMatchObject({ outcome: 'cancelled', done: 1 });
        expect(await texts()).toEqual(['old 3', 'other swipe of 5', 'new 0+1']);
        expect(getChatEntry('char:alice.png:Chat A').memoryRebuild).toEqual({ done: ['0@d0', '1@d1'] });
        expect(rebuildMessagesLeft('char:alice.png:Chat A')).toBe(4);
    });
});

describe('replies live extraction missed', () => {
    let fake;
    beforeEach(async () => {
        fake = resetFakeStateEngine();
        getContext().chat = chatOf(10);
        Object.assign(getSettings(), { enabled: true, chunkSize: 2 });
        await loadCurrentChat();
        fake.respond = async (context) => {
            const [index] = [...context.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
            return [{ text: `again ${index}`, message_index: index }];
        };
    });

    it('finds the replies before the newest that have no memories and were not tried', async () => {
        const { missedReplies } = await import('../src/extraction/missed-replies.js');
        const chat = chatOf(14);
        const records = [rec('C', 9, chat), rec('C', 5, chat)];
        // Replies are the odd messages; 13 is the newest. Five before it: 11, 9, 7, 5, 3.
        expect(missedReplies(chat, records, 'C')).toEqual([3, 7, 11]);
        expect(missedReplies(chat, records, 'C', new Set([sourceMessageId('C', 7, chat[7])]))).toEqual([3, 11]);
    });

    it('reads a missed reply again through the catch-up preset - once', async () => {
        const { retryMissedReplies } = await import('../src/extraction/missed-replies.js');
        await addMemoryRecords(getCurrentChatRef(), [1, 3, 5].map((i) => ({ text: `live ${i}`, source_message_id: sourceMessageId('Chat A', i, getContext().chat[i]) })));
        await retryMissedReplies();
        expect((await getAllMemories()).map((m) => m.text)).toEqual(['live 1', 'live 3', 'live 5', 'again 7']);
        expect(getChatEntry('char:alice.png:Chat A').liveRetried).toEqual(['Chat A#7@d7']);

        // Tried once: a reply that still gets nothing is left alone.
        fake.respond = async () => [];
        getContext().chat.push(msg(10), msg(11));
        await retryMissedReplies();
        expect((await getAllMemories()).map((m) => m.text)).toEqual(['live 1', 'live 3', 'live 5', 'again 7']);
        expect(getChatEntry('char:alice.png:Chat A').liveRetried).toEqual(['Chat A#7@d7', 'Chat A#9@d9']);
        const runs = fake.calls.filter((c) => c.name === 'runIndependentPreset').length;
        await retryMissedReplies();
        expect(fake.calls.filter((c) => c.name === 'runIndependentPreset').length).toBe(runs);
    });

    it('records a failed chunk with its messages and why', async () => {
        fake.respond = async (context) => {
            if (context.includes('[#2]')) throw new Error('response was not valid JSON');
            return [{ text: 'ok' }];
        };
        const done = [];
        await startCatchUp({ whenDone: (p) => done.push(p) });
        await done[0];
        expect(getCatchUpProgress().failures).toEqual([{ from: 2, to: 3, error: 'response was not valid JSON', response: null }]);
        const { failuresReport, failedRanges } = await import('../src/ui/drawer-model.js');
        expect(failedRanges(getCatchUpProgress())).toBe('#2-#3');
        expect(failuresReport(getCatchUpProgress())).toBe('Messages #2-#3: response was not valid JSON\n(the response was not kept)');
    });
});
