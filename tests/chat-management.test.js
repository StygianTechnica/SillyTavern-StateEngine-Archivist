// Removing and moving stored memory: the user's deletions (memory core),
// following renamed chats and keeping deleted chats' memory
// (chat-lifecycle.js), and telling which stored chats still exist
// (chat-existence.js).

import { files, getContext, openChat, characterChats, failNext, eventSource } from './harness/st.js';
import {
    loadCurrentChat, addMemoryRecords, getAllMemories, getMemoriesForEntity,
    deleteMemoryRecords, deleteChatMemories, moveChatMemories, MEMORIES_CHANGED_EVENT,
} from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry, listChatEntries, moveChatEntry, ensureChatEntry } from '../src/memory/registry.js';
import { onChatRenamed, onChatDeleted, startChatLifecycle } from '../src/memory/chat-lifecycle.js';
import { checkChatsExist } from '../src/memory/chat-existence.js';

const ALICE = 'char:alice.png:Chat A';
const item = (text, extra = {}) => ({ text, subtype: 'event', scope: 'scene', importance: 'medium', source_message_id: 'Chat A#1@d', ...extra });
const stored = (key) => JSON.parse(files.get(getChatEntry(key).fileName));

beforeEach(async () => {
    globalThis.toastr = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
    await loadCurrentChat();
});

describe('deleteMemoryRecords', () => {
    it('removes exactly those records, updates the count and the open chat\'s indexes', async () => {
        const [a, b, c] = await addMemoryRecords(getCurrentChatRef(), [item('a', { entity_ids: ['chr_x'] }), item('b'), item('c', { entity_ids: ['chr_x'] })]);
        eventSource.emit.mockClear();

        expect(await deleteMemoryRecords(ALICE, [a.id, c.id, 'mem_unknown'])).toBe(2);

        expect(stored(ALICE).map((r) => r.text)).toEqual(['b']);
        expect(getChatEntry(ALICE).recordCount).toBe(1);
        expect(getMemoriesForEntity('chr_x')).toEqual([]);
        expect((await getAllMemories()).map((r) => r.id)).toEqual([b.id]);
        expect(eventSource.emit).toHaveBeenCalledWith(MEMORIES_CHANGED_EVENT, { chatId: 'Chat A', chatKey: ALICE });
    });

    it('does nothing for an unknown chat or no ids', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a')]);
        expect(await deleteMemoryRecords('char:nobody.png:x', ['m'])).toBe(0);
        expect(await deleteMemoryRecords(ALICE, [])).toBe(0);
        expect(stored(ALICE)).toHaveLength(1);
    });

    it('works on a chat that is not open', async () => {
        const bob = { chatId: 'Bob Chat', characterAvatar: 'bob.png', groupId: null };
        const [m] = await addMemoryRecords(bob, [item('bob')]);
        expect(await deleteMemoryRecords('char:bob.png:Bob Chat', [m.id])).toBe(1);
        expect(await getAllMemories('Bob Chat')).toEqual([]);
    });

    it('removes nothing when the write fails', async () => {
        const [a] = await addMemoryRecords(getCurrentChatRef(), [item('a')]);
        failNext('POST', '/api/files/upload');
        await expect(deleteMemoryRecords(ALICE, [a.id])).rejects.toThrow();
        expect(stored(ALICE)).toHaveLength(1);
        expect(await getAllMemories()).toHaveLength(1);
    });
});

describe('deleteChatMemories', () => {
    it('deletes the file and the registry entry, and empties the open chat', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a', { entity_ids: ['chr_x'] })]);
        const fileName = getChatEntry(ALICE).fileName;

        expect(await deleteChatMemories(ALICE)).toBe(true);

        expect(files.has(fileName)).toBe(false);
        expect(getChatEntry(ALICE)).toBeNull();
        expect(await getAllMemories()).toEqual([]);
        expect(getMemoriesForEntity('chr_x')).toEqual([]);
    });

    it('is false for a chat with nothing stored', async () => {
        expect(await deleteChatMemories('char:nobody.png:x')).toBe(false);
    });

    it('keeps the entry when the file cannot be deleted', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a')]);
        failNext('POST', '/api/files/delete');
        await expect(deleteChatMemories(ALICE)).rejects.toThrow();
        expect(getChatEntry(ALICE)).not.toBeNull();
    });
});

describe('moveChatMemories and renamed chats', () => {
    it('moves the entry and rewrites chat_id, keeping the file', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a')]);
        const fileName = getChatEntry(ALICE).fileName;

        expect(await moveChatMemories(ALICE, { chatId: 'Renamed', characterAvatar: 'alice.png', groupId: null, displayName: 'Alice' })).toBe(true);

        expect(getChatEntry(ALICE)).toBeNull();
        const moved = getChatEntry('char:alice.png:Renamed');
        expect(moved).toMatchObject({ chatId: 'Renamed', fileName, recordCount: 1 });
        expect(JSON.parse(files.get(fileName))[0].chat_id).toBe('Renamed');
    });

    it('refuses when the new name already has memories of its own', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('old')]);
        await addMemoryRecords({ chatId: 'Taken', characterAvatar: 'alice.png', groupId: null }, [item('taken')]);
        expect(await moveChatMemories(ALICE, { chatId: 'Taken', characterAvatar: 'alice.png', groupId: null })).toBe(false);
        expect(getChatEntry(ALICE)).not.toBeNull();
    });

    it('follows SillyTavern\'s rename of the open chat, and the open chat shows them again', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a', { entity_ids: ['chr_x'] })]);
        // SillyTavern reloads the renamed chat first (CHAT_CHANGED), then announces the rename.
        openChat({ chatId: 'Chat A v2', characterId: 0 });
        await loadCurrentChat();
        expect(await getAllMemories()).toEqual([]);

        await onChatRenamed({ avatarId: 'alice.png', groupId: undefined, oldFileName: 'Chat A.jsonl', newFileName: 'Chat A v2.jsonl' });

        expect(getChatEntry('char:alice.png:Chat A v2')).toMatchObject({ chatId: 'Chat A v2', displayName: 'Alice' });
        expect((await getAllMemories()).map((r) => r.chat_id)).toEqual(['Chat A v2']);
        expect(getMemoriesForEntity('chr_x')).toHaveLength(1);
    });

    it('follows a group chat rename', async () => {
        const party = { chatId: 'Party Chat', characterAvatar: null, groupId: 'g1', displayName: 'Party' };
        await addMemoryRecords(party, [item('party')]);
        await onChatRenamed({ avatarId: undefined, groupId: 'g1', oldFileName: 'Party Chat.jsonl', newFileName: 'Party 2.jsonl' });
        expect(getChatEntry('group:g1:Party 2')).toMatchObject({ chatId: 'Party 2', displayName: 'Party' });
    });

    it('ignores renames of chats with nothing stored, and malformed events', async () => {
        await expect(onChatRenamed({ avatarId: 'alice.png', oldFileName: 'x.jsonl', newFileName: 'y.jsonl' })).resolves.toBeUndefined();
        await expect(onChatRenamed(null)).resolves.toBeUndefined();
        expect(listChatEntries()).toEqual([]);
    });

    it('is wired to SillyTavern\'s CHAT_RENAMED event', async () => {
        getContext().eventTypes.CHAT_RENAMED = 'chat_renamed';
        startChatLifecycle();
        await addMemoryRecords(getCurrentChatRef(), [item('a')]);
        await eventSource.emit('chat_renamed', { avatarId: 'alice.png', oldFileName: 'Chat A.jsonl', newFileName: 'B.jsonl' });
        await vi.waitFor(() => expect(getChatEntry('char:alice.png:B')).not.toBeNull());
    });
});

describe('deleted chats', () => {
    it('keeps their memories and says so', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('a'), item('b')]);
        onChatDeleted('Chat A');
        expect(getChatEntry(ALICE)).not.toBeNull();
        expect(toastr.info).toHaveBeenCalledWith(expect.stringContaining('2 memories were kept for the deleted chat "Chat A"'), 'Archivist');
    });

    it('says nothing for a chat with no memories', () => {
        onChatDeleted('Nothing Here');
        expect(toastr.info).not.toHaveBeenCalled();
    });
});

describe('checkChatsExist', () => {
    it('checks solo chats against the server, once per character', async () => {
        characterChats.set('alice.png', ['Chat A', 'Other']);
        ensureChatEntry({ chatId: 'Chat A', characterAvatar: 'alice.png', groupId: null });
        ensureChatEntry({ chatId: 'Gone', characterAvatar: 'alice.png', groupId: null });
        fetch.mockClear();

        const result = await checkChatsExist(listChatEntries());

        expect(result.get('char:alice.png:Chat A')).toBe(true);
        expect(result.get('char:alice.png:Gone')).toBe(false);
        expect(fetch.mock.calls.filter(([url]) => url === '/api/characters/chats')).toHaveLength(1);
    });

    it('treats a deleted character\'s chats, and a character with no chats folder, as missing', async () => {
        ensureChatEntry({ chatId: 'x', characterAvatar: 'deleted.png', groupId: null });
        ensureChatEntry({ chatId: 'y', characterAvatar: 'bob.png', groupId: null });
        const result = await checkChatsExist(listChatEntries());
        expect(result.get('char:deleted.png:x')).toBe(false);
        expect(result.get('char:bob.png:y')).toBe(false);
    });

    it('checks group chats against the group\'s chat list', async () => {
        getContext().groups = [{ id: 'g1', name: 'Party', chats: ['Party Chat'] }];
        ensureChatEntry({ chatId: 'Party Chat', characterAvatar: null, groupId: 'g1' });
        ensureChatEntry({ chatId: 'Old Party', characterAvatar: null, groupId: 'g1' });
        ensureChatEntry({ chatId: 'z', characterAvatar: null, groupId: 'gone' });
        const result = await checkChatsExist(listChatEntries());
        expect(result.get('group:g1:Party Chat')).toBe(true);
        expect(result.get('group:g1:Old Party')).toBe(false);
        expect(result.get('group:gone:z')).toBe(false);
    });

    it('answers unknown (never missing) when the server cannot be asked', async () => {
        ensureChatEntry({ chatId: 'Chat A', characterAvatar: 'alice.png', groupId: null });
        failNext('POST', '/api/characters/chats');
        expect((await checkChatsExist(listChatEntries())).get(ALICE)).toBeNull();
    });
});

describe('moveChatEntry', () => {
    it('refuses to overwrite an existing entry', () => {
        ensureChatEntry({ chatId: 'a', characterAvatar: 'alice.png', groupId: null });
        ensureChatEntry({ chatId: 'b', characterAvatar: 'alice.png', groupId: null });
        expect(moveChatEntry('char:alice.png:a', 'char:alice.png:b')).toBe(false);
        expect(moveChatEntry('char:alice.png:missing', 'char:alice.png:c')).toBe(false);
    });
});
