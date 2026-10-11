// @vitest-environment jsdom
//
// The memory browser: its display rules (memory-browser-model.js), and the
// window itself, clicked through as a user would.

import { getContext, characterChats, files } from './harness/st.js';
import { resetFakeStateEngine } from './harness/state-engine.js';
import { loadCurrentChat, addMemoryRecords } from '../src/memory/archivist.js';
import { getCurrentChatRef, getChatEntry } from '../src/memory/registry.js';
import { groupChats, filterChoices, filterRecords, sourceLabel, shortDate } from '../src/ui/memory-browser-model.js';
import { openMemoryBrowser, closeMemoryBrowser } from '../src/ui/memory-browser.js';

vi.mock('../src/api/state-engine.js', () => import('./harness/state-engine-mock.js'));

const ALICE = 'char:alice.png:Chat A';
const rec = (id, extra = {}) => ({ id, subtype: 'event', scope: 'scene', importance: 'medium', text: id, entity_ids: [], source_message_id: 's', chat_id: 'c', created_at: 't', ...extra });
const item = (text, extra = {}) => ({ text, subtype: 'event', scope: 'scene', importance: 'medium', source_message_id: 'Chat A#3@d', ...extra });

describe('memory browser model', () => {
    it('groups chats by owner, owners by name, chats newest first, with missing and open flags', () => {
        const entries = [
            { chatKey: 'char:b.png:1', entry: { chatId: '1', characterAvatar: 'b.png', displayName: 'Bob', updatedAt: '2026-01-01' } },
            { chatKey: 'char:a.png:1', entry: { chatId: '1', characterAvatar: 'a.png', displayName: 'Alice', updatedAt: '2026-01-01' } },
            { chatKey: 'char:a.png:2', entry: { chatId: '2', characterAvatar: 'a.png', displayName: 'Alice', updatedAt: '2026-02-01' } },
            { chatKey: 'group:g:x', entry: { chatId: 'x', groupId: 'g', displayName: '', updatedAt: null } },
        ];
        const groups = groupChats(entries, new Map([['char:a.png:1', false], ['char:a.png:2', null]]), 'char:b.png:1');
        expect(groups.map((g) => g.label)).toEqual(['Alice', 'Bob', 'Group chat']);
        expect(groups[0].chats.map((c) => [c.chatKey, c.missing])).toEqual([['char:a.png:2', false], ['char:a.png:1', true]]);
        expect(groups[1].chats[0].open).toBe(true);
    });

    it('offers each subtype and entity once, sorted', () => {
        const records = [rec('a', { subtype: 'secret', entity_ids: ['chr_b', 'chr_a'] }), rec('b', { entity_ids: ['chr_a'] })];
        expect(filterChoices(records)).toEqual({ subtypes: ['event', 'secret'], entities: ['chr_a', 'chr_b'] });
    });

    it('filters by every field, newest first, searching text and entity names', () => {
        const records = [
            rec('one', { text: 'Mira hid the key', subtype: 'secret', entity_ids: ['chr_mira'] }),
            rec('two', { text: 'They reached the inn', scope: 'long_term', importance: 'high' }),
            rec('three', { text: 'A storm', entity_ids: ['loc_inn'] }),
        ];
        const ids = (filters, names) => filterRecords(records, filters, names).map((r) => r.id);
        expect(ids({})).toEqual(['three', 'two', 'one']);
        expect(ids({ subtype: 'secret' })).toEqual(['one']);
        expect(ids({ scope: 'long_term' })).toEqual(['two']);
        expect(ids({ importance: 'high' })).toEqual(['two']);
        expect(ids({ entity: 'loc_inn' })).toEqual(['three']);
        expect(ids({ search: 'KEY' })).toEqual(['one']);
        expect(ids({ search: 'rusty' }, new Map([['loc_inn', 'The Rusty Anchor']]))).toEqual(['three']);
        expect(ids({ search: 'storm', importance: 'high' })).toEqual([]);
    });

    it('labels sources and dates for people', () => {
        expect(sourceLabel('Chat A#12@2026')).toBe('message #12');
        expect(sourceLabel('Chat A#unknown')).toBe('Chat A#unknown');
        expect(shortDate('')).toBe('');
        expect(shortDate('not a date')).toBe('');
        expect(shortDate('2026-10-11T12:00:00.000Z')).not.toBe('');
    });
});

describe('the memory browser window', () => {
    let fake;
    const q = (selector) => document.querySelector(selector);
    const qa = (selector) => [...document.querySelectorAll(selector)];
    const waitFor = (check) => vi.waitFor(check, { timeout: 1000, interval: 5 });
    const texts = () => qa('.ar-mb-record-text').map((n) => n.textContent);
    const answerPopup = (answer) => {
        getContext().callGenericPopup = vi.fn(async () => (answer ? 1 : 0));
    };

    beforeEach(async () => {
        fake = resetFakeStateEngine();
        fake.addObject('chr_mira', 'character', 'Mira');
        document.body.innerHTML = '';
        globalThis.toastr = { info: vi.fn(), success: vi.fn(), error: vi.fn() };
        Object.assign(getContext(), { POPUP_TYPE: { CONFIRM: 2 }, POPUP_RESULT: { AFFIRMATIVE: 1 } });
        answerPopup(true);
        characterChats.set('alice.png', ['Chat A']);
        await loadCurrentChat();
        await addMemoryRecords(getCurrentChatRef(), [
            item('Mira hid the key.', { subtype: 'secret', importance: 'high', entity_ids: ['chr_mira'] }),
            item('They reached the inn.'),
        ]);
        await addMemoryRecords({ chatId: 'Old Chat', characterAvatar: 'alice.png', groupId: null, displayName: 'Alice' }, [item('From a deleted chat.')]);
    });

    afterEach(() => closeMemoryBrowser());

    it('opens on the open chat, newest first, with entity names', async () => {
        await openMemoryBrowser();
        await waitFor(() => expect(texts()).toEqual(['They reached the inn.', 'Mira hid the key.']));
        expect(q('[data-mb="title"]').textContent).toBe('Alice - Chat A');
        expect(q('[data-mb="count"]').textContent).toBe('2 memories');
        expect(q('.ar-mb-record-entities').textContent).toBe('About: Mira');
    });

    it('lists every chat, flagging one that no longer exists', async () => {
        await openMemoryBrowser();
        await waitFor(() => expect(q('[data-chat-key="char:alice.png:Old Chat"]').classList.contains('ar-mb-missing')).toBe(true));
        expect(q(`[data-chat-key="${ALICE}"]`).classList.contains('ar-mb-missing')).toBe(false);
        expect(q(`[data-chat-key="${ALICE}"]`).textContent).toContain('open');
    });

    it('shows another chat when it is clicked', async () => {
        await openMemoryBrowser();
        q('[data-chat-key="char:alice.png:Old Chat"]').click();
        await waitFor(() => expect(texts()).toEqual(['From a deleted chat.']));
    });

    it('filters as the user types and picks', async () => {
        await openMemoryBrowser();
        await waitFor(() => expect(texts()).toHaveLength(2));
        const search = q('[data-mb="search"]');
        search.value = 'inn';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(texts()).toEqual(['They reached the inn.']);
        expect(q('[data-mb="count"]').textContent).toBe('1 of 2 memories');

        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        const entity = q('[data-mb="entity"]');
        expect([...entity.options].map((o) => o.textContent)).toEqual(['Anyone', 'Mira']);
        entity.value = 'chr_mira';
        entity.dispatchEvent(new Event('change', { bubbles: true }));
        expect(texts()).toEqual(['Mira hid the key.']);
    });

    it('deletes one memory after confirmation, and keeps it on Cancel', async () => {
        await openMemoryBrowser();
        await waitFor(() => expect(texts()).toHaveLength(2));

        answerPopup(false);
        q('[data-mb-delete]').click();
        await waitFor(() => expect(getContext().callGenericPopup).toHaveBeenCalled());
        expect(getChatEntry(ALICE).recordCount).toBe(2);

        answerPopup(true);
        q('[data-mb-delete]').click();
        await waitFor(() => expect(texts()).toEqual(['Mira hid the key.']));
        expect(getChatEntry(ALICE).recordCount).toBe(1);
    });

    it('deletes the selected memories', async () => {
        await openMemoryBrowser();
        await waitFor(() => expect(texts()).toHaveLength(2));
        expect(q('[data-mb="deleteSelected"]').disabled).toBe(true);

        q('[data-mb="selectShown"]').click();
        expect(q('[data-mb="deleteSelected"]').textContent).toContain('Delete selected (2)');
        q('[data-mb="deleteSelected"]').click();
        await waitFor(() => expect(q('.ar-mb-empty').textContent).toBe('This chat has no memories stored.'));
        expect(getChatEntry(ALICE).recordCount).toBe(0);
    });

    it('deletes everything stored for a chat', async () => {
        await openMemoryBrowser();
        q('[data-chat-key="char:alice.png:Old Chat"]').click();
        await waitFor(() => expect(texts()).toEqual(['From a deleted chat.']));
        const fileName = getChatEntry('char:alice.png:Old Chat').fileName;

        q('[data-mb="deleteChat"]').click();
        await waitFor(() => expect(q('[data-chat-key="char:alice.png:Old Chat"]')).toBeNull());
        expect(files.has(fileName)).toBe(false);
        expect(getChatEntry('char:alice.png:Old Chat')).toBeNull();
        expect(getChatEntry(ALICE)).not.toBeNull();
    });

    it('shows memory text as text, never markup', async () => {
        await addMemoryRecords(getCurrentChatRef(), [item('<img src=x onerror=alert(1)>')]);
        await openMemoryBrowser();
        await waitFor(() => expect(texts()[0]).toBe('<img src=x onerror=alert(1)>'));
        expect(q('.ar-mb-records img')).toBeNull();
    });

    it('closes on the close button', async () => {
        await openMemoryBrowser();
        q('[data-mb="close"]').click();
        expect(q('.ar-mb-overlay').hidden).toBe(true);
    });

    it('opens on the open chat even when it has nothing stored yet', async () => {
        const { deleteChatMemories } = await import('../src/memory/archivist.js');
        await deleteChatMemories(ALICE);
        await openMemoryBrowser();
        await waitFor(() => expect(q('[data-mb="title"]').textContent).toBe('Alice - Chat A'));
        expect(q('.ar-mb-records .ar-mb-empty').textContent).toMatch(/^No memories stored for this chat yet/);
        expect(q('[data-chat-key="char:alice.png:Old Chat"]')).not.toBeNull();
    });

    it('says so when nothing is stored at all', async () => {
        const { deleteChatMemories } = await import('../src/memory/archivist.js');
        await deleteChatMemories(ALICE);
        await deleteChatMemories('char:alice.png:Old Chat');
        await openMemoryBrowser();
        await waitFor(() => expect(q('.ar-mb-chats .ar-mb-empty').textContent).toMatch(/^No memories stored yet/));
        expect(q('[data-mb="toolbar"]').hidden).toBe(true);
    });
});
