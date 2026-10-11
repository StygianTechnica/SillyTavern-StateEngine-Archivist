import { openChat, getContext } from './harness/st.js';
import {
    getCurrentChatRef, chatKeyFor, fileNameFor, ensureChatEntry, getChatEntry,
    findChatEntriesById, listChatEntries, updateChatEntry, removeChatEntry,
} from '../src/memory/registry.js';

describe('getCurrentChatRef', () => {
    it('identifies a solo chat by its character avatar', () => {
        expect(getCurrentChatRef()).toEqual({ chatId: 'Chat A', characterAvatar: 'alice.png', groupId: null, displayName: 'Alice' });
    });

    it('identifies a group chat by its group id', () => {
        openChat({ chatId: 'Party Chat', characterId: undefined, groupId: 'g1' });
        expect(getCurrentChatRef()).toEqual({ chatId: 'Party Chat', characterAvatar: null, groupId: 'g1', displayName: 'Party' });
    });

    it('is null with no chat open', () => {
        openChat({ chatId: undefined });
        expect(getCurrentChatRef()).toBeNull();
    });
});

describe('chat keys and file names', () => {
    const alice = { chatId: 'main', characterAvatar: 'alice.png', groupId: null };
    const bob = { chatId: 'main', characterAvatar: 'bob.png', groupId: null };

    it('keeps same-named chats of different characters apart', () => {
        expect(chatKeyFor(alice)).toBe('char:alice.png:main');
        expect(chatKeyFor(bob)).toBe('char:bob.png:main');
        expect(fileNameFor(chatKeyFor(alice), 'main')).not.toBe(fileNameFor(chatKeyFor(bob), 'main'));
    });

    it('keys a group chat by group', () => {
        expect(chatKeyFor({ chatId: 'x', groupId: 'g1' })).toBe('group:g1:x');
    });

    it('produces file names SillyTavern\'s upload accepts', () => {
        const name = fileNameFor('char:a.png:Alice - 2026-10-11@13h05m22s', 'Alice - 2026-10-11@13h05m22s');
        expect(name).toMatch(/^[a-zA-Z0-9_\-.]+$/);
        expect(name).toMatch(/^archivist-memories-Alice_-_2026-10-11_13h05m22s-[0-9a-f]{8}\.json$/);
    });

    it('handles chat ids with no usable characters, and caps long ones', () => {
        expect(fileNameFor('k', '日本語')).toMatch(/^archivist-memories-chat-[0-9a-f]{8}\.json$/);
        expect(fileNameFor('k', 'x'.repeat(200)).length).toBeLessThan(90);
    });
});

describe('registry entries', () => {
    it('creates an entry once and persists settings', () => {
        const ref = getCurrentChatRef();
        const { chatKey, entry } = ensureChatEntry(ref);
        expect(chatKey).toBe('char:alice.png:Chat A');
        expect(entry).toMatchObject({ chatId: 'Chat A', characterAvatar: 'alice.png', groupId: null, displayName: 'Alice', recordCount: 0, updatedAt: null });
        expect(getContext().saveSettingsDebounced).toHaveBeenCalled();
        expect(ensureChatEntry(ref).entry).toBe(entry);
        expect(getContext().extensionSettings.archivist.chats[chatKey]).toBe(entry);
    });

    it('refreshes the display name when it changes', () => {
        ensureChatEntry(getCurrentChatRef());
        getContext().characters[0].name = 'Alice the Bold';
        expect(ensureChatEntry(getCurrentChatRef()).entry.displayName).toBe('Alice the Bold');
    });

    it('finds, lists, updates and removes entries', () => {
        ensureChatEntry({ chatId: 'main', characterAvatar: 'alice.png', groupId: null });
        ensureChatEntry({ chatId: 'main', characterAvatar: 'bob.png', groupId: null });
        ensureChatEntry({ chatId: 'other', characterAvatar: 'bob.png', groupId: null });

        expect(findChatEntriesById('main').map((e) => e.chatKey)).toEqual(['char:alice.png:main', 'char:bob.png:main']);
        expect(listChatEntries()).toHaveLength(3);

        expect(updateChatEntry('char:bob.png:main', { recordCount: 4 }).recordCount).toBe(4);
        expect(updateChatEntry('missing', { recordCount: 1 })).toBeNull();

        expect(removeChatEntry('char:bob.png:main')).toBe(true);
        expect(removeChatEntry('char:bob.png:main')).toBe(false);
        expect(getChatEntry('char:bob.png:main')).toBeNull();
    });
});
