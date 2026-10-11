// Memories follow the messages they came from: regenerated, swiped,
// edited and deleted messages (message-sync-plan.js, message-sync.js, and
// the memory core's hidden records).

import { getContext, eventSource } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import {
    loadCurrentChat, addMemoryRecords, getAllMemories, getMemoriesForEntity, getMemoriesBySubtype, getOpenChatRecords, MEMORIES_CHANGED_EVENT,
} from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry } from '../src/memory/registry.js';
import { getSettings } from '../src/settings.js';
import { parseSource, planMessageSync, memoriesOfMessage } from '../src/memory/message-sync-plan.js';
import { syncOpenChat, onMessageEdited, startMessageSync } from '../src/memory/message-sync.js';
import { rememberExtracted, forgetFingerprints } from '../src/memory/message-fingerprints.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const ALICE = 'char:alice.png:Chat A';
const rec = (id, source, extra = {}) => ({ id, subtype: 'event', scope: 'scene', importance: 'medium', text: id, entity_ids: [], source_message_id: source, chat_id: 'C', created_at: 't', ...extra });

describe('the plan', () => {
    const chat = [
        { mes: 'hi', is_user: true, send_date: 'u0' },
        { mes: 'reply B', send_date: 's1b', swipe_id: 1, swipe_info: [{ send_date: 's1a' }, { send_date: 's1b' }] },
        { mes: 'more', is_user: true, send_date: 'u2' },
    ];

    it('reads a source from the end, so a chat id with # or @ is fine', () => {
        expect(parseSource('My #1 @chat#12@2026-10-11T17:31:25.123Z')).toEqual({ index: 12, stamp: '2026-10-11T17:31:25.123Z' });
        expect(parseSource('Chat#unknown')).toBeNull();
        expect(parseSource(undefined)).toBeNull();
    });

    it('keeps the shown swipe\'s memories, hides another swipe\'s, removes a gone message\'s', () => {
        const plan = planMessageSync([rec('shown', 'C#1@s1b'), rec('other', 'C#1@s1a'), rec('gone', 'C#3@s3'), rec('user', 'C#0@u0')], chat, 'C');
        expect(plan.remove).toEqual(['gone']);
        expect(plan.hidden).toEqual(['other']);
        expect(plan.repoint.size).toBe(0);
    });

    it('corrects the index of a message that moved', () => {
        const plan = planMessageSync([rec('moved', 'C#5@u2')], chat, 'C');
        expect(plan.repoint.get('moved')).toBe('C#2@u2');
        expect(plan.remove).toEqual([]);
    });

    it('prefers the memory\'s own index when a send date repeats (older chats)', () => {
        const twins = [{ mes: 'a', send_date: 'same' }, { mes: 'b', send_date: 'same' }];
        expect(planMessageSync([rec('second', 'C#1@same')], twins, 'C').repoint.size).toBe(0);
    });

    it('leaves memories with no send date to go by alone', () => {
        const plan = planMessageSync([rec('unknown', 'C#unknown'), rec('blank', 'C#1@')], chat, 'C');
        expect(plan).toEqual({ remove: [], hidden: [], repoint: new Map() });
    });

    it('finds the memories of one message as it is shown now', () => {
        const records = [rec('shown', 'C#1@s1b'), rec('other', 'C#1@s1a'), rec('elsewhere', 'C#0@u0')];
        expect(memoriesOfMessage(records, chat, 1)).toEqual(['shown']);
        expect(memoriesOfMessage(records, chat, 9)).toEqual([]);
    });
});

describe('following the chat', () => {
    let fake;
    const reply = (text, sendDate, extra = {}) => ({ name: 'Mira', is_user: false, mes: text, send_date: sendDate, ...extra });
    const texts = async () => (await getAllMemories()).map((m) => m.text).sort();
    const store = (text, index, extra = {}) => {
        const message = getContext().chat[index];
        return addMemoryRecords(getCurrentChatRef(), [{ text, entity_ids: ['chr_mira'], source_message_id: `Chat A#${index}@${message.send_date}`, ...extra }]);
    };

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        forgetFingerprints();
        getContext().chat = [
            { name: 'User', is_user: true, mes: 'Where is the key?', send_date: 'd0' },
            reply('Mira hides the key.', 'd1'),
            { name: 'User', is_user: true, mes: 'And then?', send_date: 'd2' },
            reply('Mira leaves.', 'd3', { swipe_id: 0, swipes: ['Mira leaves.'], swipe_info: [{ send_date: 'd3' }] }),
        ];
        await loadCurrentChat();
        await store('key hidden', 1);
        await store('Mira left', 3);
    });

    it('regenerate: the deleted reply\'s memories go; the rest stay', async () => {
        getContext().chat.length = 3; // SillyTavern deletes the reply before regenerating
        await syncOpenChat();
        expect(await texts()).toEqual(['key hidden']);
        expect(getChatEntry(ALICE).recordCount).toBe(1);
    });

    it('swipe: the old swipe\'s memories are hidden, and come back when swiped back', async () => {
        const last = getContext().chat[3];
        Object.assign(last, { mes: 'Mira stays.', send_date: 'd3b', swipe_id: 1, swipes: ['Mira leaves.', 'Mira stays.'], swipe_info: [{ send_date: 'd3' }, { send_date: 'd3b' }] });
        await syncOpenChat();
        await store('Mira stayed', 3);

        expect(await texts()).toEqual(['Mira stayed', 'key hidden']);
        expect(getMemoriesForEntity('chr_mira').map((m) => m.text)).toEqual(['key hidden', 'Mira stayed']);
        expect(getMemoriesBySubtype('fact')).toHaveLength(2);
        expect(getChatEntry(ALICE).recordCount).toBe(3); // the hidden one is still stored

        Object.assign(last, { mes: 'Mira leaves.', send_date: 'd3', swipe_id: 0 });
        await syncOpenChat();
        expect(await texts()).toEqual(['Mira left', 'key hidden']);
    });

    it('deleting a swipe removes its memories', async () => {
        const last = getContext().chat[3];
        Object.assign(last, { mes: 'Mira stays.', send_date: 'd3b', swipe_id: 1, swipe_info: [{ send_date: 'd3' }, { send_date: 'd3b' }] });
        await syncOpenChat();
        Object.assign(last, { swipe_id: 0, swipe_info: [{ send_date: 'd3b' }] }); // swipe 0 deleted
        await syncOpenChat();
        expect(getOpenChatRecords().records.map((r) => r.text)).toEqual(['key hidden']);
    });

    it('deleting a message in the middle re-indexes the later memories', async () => {
        getContext().chat.splice(1, 1);
        await syncOpenChat();
        const [left] = await getAllMemories();
        expect(left).toMatchObject({ text: 'Mira left', source_message_id: 'Chat A#2@d3' });
    });

    it('does nothing to an empty chat array (still loading), however it looks', async () => {
        getContext().chat = [];
        await syncOpenChat();
        expect(await texts()).toEqual(['Mira left', 'key hidden']);
    });

    it('announces what it changed', async () => {
        eventSource.emit.mockClear();
        getContext().chat.length = 3;
        await syncOpenChat();
        expect(eventSource.emit).toHaveBeenCalledWith(MEMORIES_CHANGED_EVENT, { chatId: 'Chat A', chatKey: ALICE });
        eventSource.emit.mockClear();
        await syncOpenChat();
        expect(eventSource.emit).not.toHaveBeenCalledWith(MEMORIES_CHANGED_EVENT, expect.anything());
    });

    describe('edits', () => {
        beforeEach(() => {
            getSettings().enabled = true;
            fake.respond = async (context) => [{ text: `re-read: ${/\[#1\] Mira: (.*)/.exec(context)?.[1]}`, message_index: 1 }];
        });

        it('replace the edited message\'s memories with a fresh extraction', async () => {
            rememberExtracted('Chat A', getContext().chat[1]);
            getContext().chat[1].mes = 'Mira throws the key in the river.';
            await onMessageEdited(1);
            expect(await texts()).toEqual(['Mira left', 're-read: Mira throws the key in the river.']);
            expect(fake.calls.filter((c) => c.name === 'runIndependentPreset')).toHaveLength(1);
        });

        it('leave memories alone when the text did not change', async () => {
            rememberExtracted('Chat A', getContext().chat[1]);
            await onMessageEdited(1);
            expect(await texts()).toEqual(['Mira left', 'key hidden']);
            expect(fake.calls.filter((c) => c.name === 'runIndependentPreset')).toHaveLength(0);
        });

        it('re-extract when it is unknown whether the text changed (after a reload)', async () => {
            await onMessageEdited(1);
            expect(await texts()).toEqual(['Mira left', 're-read: Mira hides the key.']);
        });

        it('only remove the stale memories while Archivist is disabled', async () => {
            getSettings().enabled = false;
            getContext().chat[1].mes = 'changed';
            await onMessageEdited(1);
            expect(await texts()).toEqual(['Mira left']);
            expect(fake.calls.filter((c) => c.name === 'runIndependentPreset')).toHaveLength(0);
        });

        it('ignore a message with no memories', async () => {
            await onMessageEdited(0);
            expect(fake.calls.filter((c) => c.name === 'runIndependentPreset')).toHaveLength(0);
        });

        it('keep the removal when the re-extraction fails', async () => {
            fake.respond = async () => { throw new Error('model down'); };
            getContext().chat[1].mes = 'changed';
            await onMessageEdited(1);
            expect(await texts()).toEqual(['Mira left']);
        });
    });

    it('is wired to SillyTavern\'s message events', async () => {
        Object.assign(getContext().eventTypes, { MESSAGE_DELETED: 'message_deleted', MESSAGE_EDITED: 'message_edited' });
        startMessageSync();
        getContext().chat.length = 3;
        await eventSource.emit('message_deleted', 3);
        await vi.waitFor(async () => expect(await texts()).toEqual(['key hidden']));
    });
});
