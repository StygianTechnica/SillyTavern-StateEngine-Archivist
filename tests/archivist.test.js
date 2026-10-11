import { files, openChat, eventSource, failNext, getContext } from './harness/st.js';
import {
    loadCurrentChat, addMemoryRecords, getMemoriesForEntity, getMemoriesBySubtype,
    getAllMemories, getOpenChatRef, MEMORIES_CHANGED_EVENT,
} from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry } from '../src/memory/registry.js';

const ALICE_KEY = 'char:alice.png:Chat A';

const item = (text, extra = {}) => ({ text, subtype: 'event', scope: 'scene', importance: 'medium', entity_ids: [], source_message_id: 'Chat A#1@x', ...extra });

const fileOf = (chatKey) => JSON.parse(files.get(getChatEntry(chatKey).fileName));

beforeEach(async () => {
    await loadCurrentChat();
});

describe('addMemoryRecords', () => {
    it('appends records to the chat\'s file, registers the chat, and indexes them', async () => {
        const stored = await addMemoryRecords(getCurrentChatRef(), [
            item('Mira hid the key.', { subtype: 'secret', entity_ids: ['chr_mira', 'itm_key'] }),
            item('They reached the inn.', { entity_ids: ['loc_inn'] }),
        ]);

        expect(stored).toHaveLength(2);
        expect(stored.every((r) => r.chat_id === 'Chat A')).toBe(true);
        expect(fileOf(ALICE_KEY)).toEqual(stored);
        expect(getChatEntry(ALICE_KEY)).toMatchObject({ recordCount: 2, displayName: 'Alice' });
        expect(getChatEntry(ALICE_KEY).updatedAt).toEqual(expect.any(String));

        expect(getMemoriesForEntity('chr_mira').map((r) => r.text)).toEqual(['Mira hid the key.']);
        expect(getMemoriesBySubtype('event').map((r) => r.text)).toEqual(['They reached the inn.']);
    });

    it('appends to what is already stored', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('one')]);
        await addMemoryRecords(getCurrentChatRef(), [item('two')]);
        expect(fileOf(ALICE_KEY).map((r) => r.text)).toEqual(['one', 'two']);
        expect(getMemoriesBySubtype('event')).toHaveLength(2);
    });

    it('forces chat_id to the target chat and skips invalid items', async () => {
        const stored = await addMemoryRecords(getCurrentChatRef(), [item('ok', { chat_id: 'Elsewhere' }), item(''), null, item('no source', { source_message_id: '' })]);
        expect(stored.map((r) => [r.text, r.chat_id])).toEqual([['ok', 'Chat A']]);
    });

    it('does nothing for an empty batch', async () => {
        expect(await addMemoryRecords(getCurrentChatRef(), [])).toEqual([]);
        expect(await addMemoryRecords(getCurrentChatRef(), 'nope')).toEqual([]);
        expect(getChatEntry(ALICE_KEY)).toBeNull();
        expect(files.size).toBe(0);
    });

    it('announces the change on SillyTavern\'s event bus', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('one')]);
        expect(eventSource.emit).toHaveBeenCalledWith(MEMORIES_CHANGED_EVENT, { chatId: 'Chat A', chatKey: ALICE_KEY });
    });

    it('keeps both batches when live and catch-up append at once', async () => {
        const ref = getCurrentChatRef();
        await Promise.all([
            addMemoryRecords(ref, [item('live 1'), item('live 2')]),
            addMemoryRecords(ref, [item('catch-up 1')]),
            addMemoryRecords(ref, [item('live 3')]),
        ]);
        expect(fileOf(ALICE_KEY).map((r) => r.text)).toEqual(['live 1', 'live 2', 'catch-up 1', 'live 3']);
        expect(getMemoriesBySubtype('event')).toHaveLength(4);
        expect(getChatEntry(ALICE_KEY).recordCount).toBe(4);
    });

    it('stores to a chat that is not open without touching the open chat\'s indexes', async () => {
        const bobRef = { chatId: 'Bob Chat', characterAvatar: 'bob.png', groupId: null, displayName: 'Bob' };
        await addMemoryRecords(bobRef, [item('bob memory', { entity_ids: ['chr_bob'] })]);

        expect(getMemoriesForEntity('chr_bob')).toEqual([]);
        expect((await getAllMemories('Bob Chat')).map((r) => r.text)).toEqual(['bob memory']);
    });

    it('fails without losing stored records when the write fails', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('kept')]);
        failNext('POST', '/api/files/upload');
        await expect(addMemoryRecords(getCurrentChatRef(), [item('lost')])).rejects.toThrow();
        expect(fileOf(ALICE_KEY).map((r) => r.text)).toEqual(['kept']);
        expect(getMemoriesBySubtype('event').map((r) => r.text)).toEqual(['kept']);
    });
});

describe('query APIs', () => {
    it('return [] for unknown entities and subtypes', () => {
        expect(getMemoriesForEntity('chr_nobody')).toEqual([]);
        expect(getMemoriesBySubtype('nothing')).toEqual([]);
    });

    it('hand out copies that cannot change Archivist\'s state', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('original', { entity_ids: ['chr_mira'] })]);

        getMemoriesForEntity('chr_mira')[0].text = 'changed';
        getMemoriesBySubtype('event')[0].entity_ids.push('chr_intruder');
        (await getAllMemories())[0].text = 'changed again';

        expect(getMemoriesForEntity('chr_mira')[0].text).toBe('original');
        expect(getMemoriesForEntity('chr_intruder')).toEqual([]);
        expect((await getAllMemories('Chat A'))[0].text).toBe('original');
    });

    it('getAllMemories returns [] for a chat with no stored memory', async () => {
        await expect(getAllMemories('Never Seen')).resolves.toEqual([]);
    });

    it('getAllMemories accepts a registry chat key', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('one')]);
        openChat({ chatId: 'Other', characterId: 1 });
        await loadCurrentChat();
        expect((await getAllMemories(ALICE_KEY)).map((r) => r.text)).toEqual(['one']);
    });

    it('getAllMemories prefers the open chat, then the most recently updated, for a shared chat id', async () => {
        const aliceMain = { chatId: 'main', characterAvatar: 'alice.png', groupId: null };
        const bobMain = { chatId: 'main', characterAvatar: 'bob.png', groupId: null };
        await addMemoryRecords(aliceMain, [item('alice main')]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await addMemoryRecords(bobMain, [item('bob main')]);

        expect((await getAllMemories('main')).map((r) => r.text)).toEqual(['bob main']);

        openChat({ chatId: 'main', characterId: 0 });
        await loadCurrentChat();
        expect((await getAllMemories('main')).map((r) => r.text)).toEqual(['alice main']);
    });

    it('getAllMemories skips stored entries that are not valid records', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('valid')]);
        const fileName = getChatEntry(ALICE_KEY).fileName;
        files.set(fileName, JSON.stringify([...JSON.parse(files.get(fileName)), { id: 'broken' }]));
        await loadCurrentChat();
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['valid']);
    });
});

describe('loadCurrentChat', () => {
    it('loads the open chat\'s records and indexes on chat change', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('alice', { entity_ids: ['chr_alice'] })]);
        openChat({ chatId: 'Bob Chat', characterId: 1 });
        await addMemoryRecords(getCurrentChatRef(), [item('bob', { entity_ids: ['chr_bob'] })]);

        openChat({ chatId: 'Chat A', characterId: 0 });
        await loadCurrentChat();
        expect(getMemoriesForEntity('chr_alice')).toHaveLength(1);
        expect(getMemoriesForEntity('chr_bob')).toEqual([]);
        expect(getOpenChatRef()).toMatchObject({ chatId: 'Chat A', characterAvatar: 'alice.png' });
    });

    it('makes no request for a chat with no stored memory', async () => {
        fetch.mockClear();
        openChat({ chatId: 'Fresh', characterId: 1 });
        await loadCurrentChat();
        expect(fetch).not.toHaveBeenCalled();
        expect(await getAllMemories()).toEqual([]);
    });

    it('ignores an older load that finishes after a newer one', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('alice', { entity_ids: ['chr_alice'] })]);
        openChat({ chatId: 'Bob Chat', characterId: 1 });
        await addMemoryRecords(getCurrentChatRef(), [item('bob', { entity_ids: ['chr_bob'] })]);

        openChat({ chatId: 'Chat A', characterId: 0 });
        const older = loadCurrentChat();
        openChat({ chatId: 'Bob Chat', characterId: 1 });
        const newer = loadCurrentChat();
        await Promise.all([older, newer]);

        expect(getMemoriesForEntity('chr_bob')).toHaveLength(1);
        expect(getMemoriesForEntity('chr_alice')).toEqual([]);
    });

    it('starts empty, without throwing, when the chat\'s file cannot be read', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('one')]);
        files.set(getChatEntry(ALICE_KEY).fileName, 'damaged');
        await expect(loadCurrentChat()).resolves.toBeUndefined();
        expect(await getAllMemories()).toEqual([]);
    });

    it('getAllMemories waits for a load in progress', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('one')]);
        openChat({ chatId: 'Other', characterId: 1 });
        await loadCurrentChat();

        openChat({ chatId: 'Chat A', characterId: 0 });
        void loadCurrentChat();
        expect((await getAllMemories()).map((r) => r.text)).toEqual(['one']);
    });

    it('handles no open chat', async () => {
        openChat({ chatId: undefined });
        await loadCurrentChat();
        expect(getOpenChatRef()).toBeNull();
        expect(await getAllMemories()).toEqual([]);
        expect(getContext().extensionSettings.archivist.chats).toEqual({});
    });
});
