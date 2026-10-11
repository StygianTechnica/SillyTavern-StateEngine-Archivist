// The memory browser: every chat Archivist holds memory for - including
// chats that no longer exist, flagged as missing - and, for the chosen
// chat, its memories with search and filters. The user can delete single
// memories, a selection, or everything stored for a chat. Deleting here is
// the ONLY way stored memory is ever removed; Archivist never deletes on
// its own (src/memory/chat-lifecycle.js).
//
// Opened from the drawer's "Review memories" button. What it shows comes
// from src/ui/memory-browser-model.js; every memory's text is put on the
// page as text, never as markup.

import { LOG_PREFIX } from '../constants.js';
import { SCOPES, IMPORTANCE_LEVELS } from '../memory/schema.js';
import { getAllMemories, deleteMemoryRecords, deleteChatMemories, MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { listChatEntries, getChatEntry, getCurrentChatRef, chatKeyFor } from '../memory/registry.js';
import { checkChatsExist } from '../memory/chat-existence.js';
import { getObject } from '../api/objects.js';
import { groupChats, filterChoices, filterRecords, shortDate, sourceLabel } from './memory-browser-model.js';
import { confirmAction } from './confirm.js';

const EMPTY_FILTERS = Object.freeze({ search: '', subtype: '', scope: '', importance: '', entity: '' });

const state = {
    open: false,
    selectedKey: null,
    records: [],
    names: new Map(),     // entity id -> name, for the selected chat
    existence: new Map(), // chatKey -> true | false | null
    filters: { ...EMPTY_FILTERS },
    checked: new Set(),   // ids of the memories ticked for "Delete selected"
};
let overlay = null;
let loadToken = 0;
let listening = false;

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};
const part = (name) => overlay.querySelector(`[data-mb="${name}"]`);
const words = (token) => String(token ?? '').replace(/_/g, ' ');

function openChatKey() {
    const ref = getCurrentChatRef();
    return ref ? chatKeyFor(ref) : null;
}

// ------------------------------------------------------------------ data

// The selected chat's records and its entities' names. Never throws.
async function loadSelected() {
    const token = ++loadToken;
    const key = state.selectedKey;
    const entry = key ? getChatEntry(key) : null;
    const records = entry ? await getAllMemories(key) : [];
    const names = new Map();
    for (const id of filterChoices(records).entities) {
        try {
            const object = await getObject(entry.chatId, id);
            if (object?.name) names.set(id, object.name);
        } catch {
            // A name State Engine cannot give: the id is shown instead.
        }
    }
    if (token !== loadToken) return;
    state.records = records;
    state.names = names;
    const ids = new Set(records.map((r) => r.id));
    state.checked = new Set([...state.checked].filter((id) => ids.has(id)));
    render();
}

// The chat list, then whether each chat still exists (slower: may ask the
// server), redrawn when known.
async function loadChats() {
    const entries = listChatEntries();
    if (!state.selectedKey || !getChatEntry(state.selectedKey)) {
        const open = openChatKey();
        state.selectedKey = open && getChatEntry(open) ? open : (entries[0]?.chatKey ?? null);
    }
    render();
    await loadSelected();
    try {
        state.existence = await checkChatsExist(entries);
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not check which chats still exist', err);
    }
    if (state.open) render();
}

// --------------------------------------------------------------- render

function renderChats() {
    const list = part('chats');
    const groups = groupChats(listChatEntries(), state.existence, openChatKey());
    if (groups.length === 0) {
        list.replaceChildren(el('div', 'ar-mb-empty', 'No memories stored yet. Enable Archivist and chat - memories appear here as they are stored.'));
        return;
    }
    list.replaceChildren(...groups.map((group) => {
        const box = el('div', 'ar-mb-owner');
        box.append(el('div', 'ar-mb-owner-name', group.label));
        for (const chat of group.chats) {
            const row = el('button', `ar-mb-chat${chat.chatKey === state.selectedKey ? ' ar-mb-selected' : ''}${chat.missing ? ' ar-mb-missing' : ''}`);
            row.type = 'button';
            row.dataset.chatKey = chat.chatKey;
            const name = el('span', 'ar-mb-chat-name', chat.entry.chatId);
            const meta = el('span', 'ar-mb-chat-meta', `${chat.entry.recordCount} · ${shortDate(chat.entry.updatedAt)}`);
            row.append(name, meta);
            if (chat.open) row.append(el('span', 'ar-mb-tag', 'open'));
            if (chat.missing) row.append(el('span', 'ar-mb-tag ar-mb-tag-missing', 'missing'));
            row.title = chat.missing
                ? `${chat.entry.chatId}\nThis chat (or its ${chat.entry.groupId ? 'group' : 'character'}) no longer exists in SillyTavern. Its memories are kept until you delete them.`
                : chat.entry.chatId;
            box.append(row);
        }
        return box;
    }));
}

function option(value, label, selected) {
    const node = el('option', '', label);
    node.value = value;
    node.selected = value === selected;
    return node;
}

function renderFilters() {
    const { subtypes, entities } = filterChoices(state.records);
    const fill = (name, values, anyLabel, label = (v) => v) => {
        const select = part(name);
        const current = state.filters[name];
        // A filter value no longer present (its memories deleted) is dropped.
        if (current && !values.includes(current)) state.filters[name] = '';
        select.replaceChildren(option('', anyLabel, state.filters[name]), ...values.map((v) => option(v, label(v), state.filters[name])));
    };
    fill('subtype', subtypes, 'Any type', words);
    fill('scope', [...SCOPES], 'Any scope', words);
    fill('importance', [...IMPORTANCE_LEVELS], 'Any importance');
    fill('entity', entities, 'Anyone', (id) => state.names.get(id) ?? id);
    if (part('search').value !== state.filters.search) part('search').value = state.filters.search;
}

function recordRow(record) {
    const row = el('div', `ar-mb-record ar-importance-${record.importance}`);
    row.dataset.id = record.id;
    const tick = el('input');
    tick.type = 'checkbox';
    tick.dataset.mbCheck = record.id;
    tick.checked = state.checked.has(record.id);
    tick.title = 'Select for "Delete selected"';
    const body = el('div', 'ar-mb-record-body');
    const meta = el('div', 'ar-mb-record-meta');
    for (const text of [words(record.subtype), words(record.scope), record.importance, sourceLabel(record.source_message_id), shortDate(record.created_at)]) {
        if (text) meta.append(el('span', '', text));
    }
    body.append(meta, el('div', 'ar-mb-record-text', record.text));
    if (record.entity_ids.length) {
        body.append(el('div', 'ar-mb-record-entities', `About: ${record.entity_ids.map((id) => state.names.get(id) ?? id).join(', ')}`));
    }
    row.title = `${record.id}\nFrom: ${record.source_message_id}`;
    const remove = el('button', 'menu_button fa-solid fa-trash-can ar-mb-delete-one');
    remove.type = 'button';
    remove.title = 'Delete this memory';
    remove.dataset.mbDelete = record.id;
    row.append(tick, body, remove);
    return row;
}

function renderRecords() {
    const entry = state.selectedKey ? getChatEntry(state.selectedKey) : null;
    part('title').textContent = entry ? `${entry.displayName ? `${entry.displayName} - ` : ''}${entry.chatId}` : 'No chat selected';
    part('toolbar').hidden = !entry;
    part('chatActions').hidden = !entry;
    const list = part('records');
    if (!entry) {
        list.replaceChildren();
        part('count').textContent = '';
        return;
    }
    renderFilters();
    const shown = filterRecords(state.records, state.filters, state.names);
    part('count').textContent = shown.length === state.records.length
        ? `${state.records.length} ${state.records.length === 1 ? 'memory' : 'memories'}`
        : `${shown.length} of ${state.records.length} memories`;
    const deleteSelected = part('deleteSelected');
    deleteSelected.disabled = state.checked.size === 0;
    deleteSelected.querySelector('span').textContent = state.checked.size ? `Delete selected (${state.checked.size})` : 'Delete selected';
    list.replaceChildren(...(shown.length
        ? shown.map(recordRow)
        : [el('div', 'ar-mb-empty', state.records.length ? 'No memories match these filters.' : 'This chat has no memories stored.')]));
}

function render() {
    if (!overlay || !state.open) return;
    renderChats();
    renderRecords();
}

// -------------------------------------------------------------- actions

async function deleteIds(ids, question) {
    if (ids.length === 0 || !await confirmAction(question)) return;
    try {
        await deleteMemoryRecords(state.selectedKey, ids);
        for (const id of ids) state.checked.delete(id);
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not delete memories', err);
        toastr.error('The memories could not be deleted - see the browser console.', 'Archivist');
    }
    await loadSelected();
}

async function deleteSelectedChat() {
    const entry = getChatEntry(state.selectedKey);
    if (!entry) return;
    const missing = state.existence.get(state.selectedKey) === false;
    const question = `Delete all ${entry.recordCount} memories stored for "${entry.chatId}"?${missing ? '' : ' The chat itself is not touched, but Archivist forgets everything it remembered from it.'} This cannot be undone.`;
    if (!await confirmAction(question)) return;
    try {
        await deleteChatMemories(state.selectedKey);
        state.selectedKey = null;
        state.checked.clear();
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not delete the chat\'s memories', err);
        toastr.error('The memories could not be deleted - see the browser console.', 'Archivist');
    }
    await loadChats();
}

function onClick(e) {
    if (e.target === overlay || e.target.closest('[data-mb="close"]')) {
        closeMemoryBrowser();
        return;
    }
    const chat = e.target.closest('[data-chat-key]');
    if (chat) {
        state.selectedKey = chat.dataset.chatKey;
        state.filters = { ...EMPTY_FILTERS };
        state.checked.clear();
        render();
        void loadSelected();
        return;
    }
    const one = e.target.closest('[data-mb-delete]');
    if (one) {
        const record = state.records.find((r) => r.id === one.dataset.mbDelete);
        void deleteIds([one.dataset.mbDelete], `Delete this memory?\n\n"${record?.text ?? ''}"`);
        return;
    }
    if (e.target.closest('[data-mb="deleteSelected"]')) {
        const ids = [...state.checked];
        void deleteIds(ids, `Delete the ${ids.length} selected ${ids.length === 1 ? 'memory' : 'memories'}? This cannot be undone.`);
        return;
    }
    if (e.target.closest('[data-mb="selectShown"]')) {
        const shown = filterRecords(state.records, state.filters, state.names);
        const all = shown.length > 0 && shown.every((r) => state.checked.has(r.id));
        for (const r of shown) {
            if (all) state.checked.delete(r.id);
            else state.checked.add(r.id);
        }
        renderRecords();
        return;
    }
    if (e.target.closest('[data-mb="deleteChat"]')) {
        void deleteSelectedChat();
        return;
    }
    if (e.target.closest('[data-mb="refresh"]')) void loadChats();
}

function onInput(e) {
    const check = e.target.dataset?.mbCheck;
    if (check) {
        if (e.target.checked) state.checked.add(check);
        else state.checked.delete(check);
        renderRecords();
        return;
    }
    const name = e.target.dataset?.mb;
    if (name && Object.prototype.hasOwnProperty.call(state.filters, name)) {
        state.filters[name] = e.target.value;
        renderRecords();
        if (name === 'search') part('search').focus();
    }
}

function build() {
    overlay = el('div', 'ar-mb-overlay');
    overlay.hidden = true;
    // Static markup only - everything with data in it is built as elements.
    overlay.innerHTML = `
        <div class="ar-mb-window" role="dialog" aria-label="Archivist memories">
            <div class="ar-mb-header">
                <b><i class="fa-solid fa-book-bookmark"></i> Archivist Memories</b>
                <div class="ar-mb-header-buttons">
                    <button type="button" class="menu_button fa-solid fa-rotate" data-mb="refresh" title="Reload"></button>
                    <button type="button" class="menu_button fa-solid fa-xmark" data-mb="close" title="Close"></button>
                </div>
            </div>
            <div class="ar-mb-body">
                <div class="ar-mb-chats" data-mb="chats"></div>
                <div class="ar-mb-main">
                    <div class="ar-mb-main-head">
                        <b data-mb="title"></b>
                        <small class="ar-mb-count" data-mb="count"></small>
                    </div>
                    <div class="ar-mb-toolbar" data-mb="toolbar">
                        <input type="search" class="text_pole ar-mb-search" data-mb="search" placeholder="Search text and names..." />
                        <select class="text_pole" data-mb="subtype" title="Type"></select>
                        <select class="text_pole" data-mb="scope" title="Scope"></select>
                        <select class="text_pole" data-mb="importance" title="Importance"></select>
                        <select class="text_pole" data-mb="entity" title="Who or what it is about"></select>
                    </div>
                    <div class="ar-mb-records" data-mb="records"></div>
                    <div class="ar-mb-actions" data-mb="chatActions">
                        <button type="button" class="menu_button menu_button_icon" data-mb="selectShown" title="Select (or unselect) every memory the filters show"><i class="fa-solid fa-check-double"></i><span>Select shown</span></button>
                        <button type="button" class="menu_button menu_button_icon" data-mb="deleteSelected"><i class="fa-solid fa-trash-can"></i><span>Delete selected</span></button>
                        <button type="button" class="menu_button menu_button_icon ar-mb-danger" data-mb="deleteChat" title="Delete every memory stored for this chat"><i class="fa-solid fa-dumpster"></i><span>Delete all for this chat</span></button>
                    </div>
                </div>
            </div>
        </div>`;
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('input', onInput);
    overlay.addEventListener('change', onInput);
    document.body.append(overlay);

    // Page-wide listeners, once however often the window is rebuilt.
    if (listening) return;
    listening = true;
    document.addEventListener('keydown', (e) => {
        if (state.open && e.key === 'Escape' && !document.querySelector('.popup:not([hidden])')) closeMemoryBrowser();
    });
    // Stay current while open: new memories, deletions, renamed chats.
    SillyTavern.getContext().eventSource.on(MEMORIES_CHANGED_EVENT, () => {
        if (state.open) {
            render();
            void loadSelected();
        }
    });
}

// Opens the browser on the open chat (or the first chat with memories).
export async function openMemoryBrowser() {
    // (Re)built when missing - something may have removed it from the page.
    if (!overlay?.isConnected) build();
    state.open = true;
    state.selectedKey = null;
    state.filters = { ...EMPTY_FILTERS };
    state.checked.clear();
    overlay.hidden = false;
    await loadChats();
}

export function closeMemoryBrowser() {
    state.open = false;
    if (overlay) overlay.hidden = true;
}
