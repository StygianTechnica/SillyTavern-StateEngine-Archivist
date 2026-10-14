// The memory browser: every chat Archivist holds memory for - including
// chats that no longer exist, flagged as missing - and, for the chosen
// chat, its memories with search and filters. The user can delete single
// memories, a selection, or everything stored for a chat. Deleting here is
// the ONLY way stored memory is ever removed; Archivist never deletes on
// its own (src/memory/chat-lifecycle.js).
//
// Two views of the chosen chat: its MEMORIES (search, filters, deletion),
// and its COMPILED memory (src/compiler/) - character profiles, scene state,
// session details, relationships and the timeline, each fact with its colour
// tag and a link to the chat messages it came from (for the open chat, a
// click jumps there). Everything the compiler wrote can be edited or
// deleted there (src/ui/compiled-edit.js); a deleted item stays deleted
// through later compiles.
//
// Opened from the drawer's "Review memories" button. What it shows comes
// from src/ui/memory-browser-model.js; every memory's text is put on the
// page as text, never as markup.

import { LOG_PREFIX } from '../constants.js';
import { SCOPES, IMPORTANCE_LEVELS } from '../memory/schema.js';
import { getAllMemories, deleteMemoryRecords, deleteChatMemories, MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { listChatEntries, getChatEntry, getCurrentChatRef, chatKeyFor } from '../memory/registry.js';
import { checkChatsExist } from '../memory/chat-existence.js';
import { getObject, addObjectAlias } from '../api/objects.js';
import { groupChats, filterChoices, filterRecords, shortDate, sourceLabel } from './memory-browser-model.js';
import { confirmAction } from './confirm.js';
import {
    getCompiledMemory, compileOpenChat, isCompiling, getCompilerStatus, onCompilerStatus, COMPILED_CHANGED_EVENT,
    editCompiledMemoryItem, deleteCompiledMemoryItem, editCompiledMemorySummary,
} from '../compiler/compiler.js';
import { findViewItem, editValues, buildEditForm, itemButtons } from './compiled-edit.js';
import { getChatPhraseTics, removePhraseTic, PHRASE_TICS_CHANGED_EVENT } from '../compiler/phrase-tic-tracker.js';
import { WARN_AT } from '../compiler/phrase-tics.js';
import { compilerLine } from './drawer-model.js';
import { jumpToMessage } from './chat-jump.js';

const EMPTY_FILTERS = Object.freeze({ search: '', subtype: '', scope: '', importance: '', entity: '', tag: '' });

const state = {
    open: false,
    selectedKey: null,
    records: [],
    names: new Map(),     // entity id -> name, for the selected chat
    existence: new Map(), // chatKey -> true | false | null
    filters: { ...EMPTY_FILTERS },
    checked: new Set(),   // ids of the memories ticked for "Delete selected"
    view: 'memories',     // 'memories' | 'compiled'
    compiled: null,       // the selected chat's compiled view (getCompiledMemory), or null
    editing: null,        // { kind, key, values } - the compiled item being edited
    tics: [],             // the selected chat's phrase tics
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
    let compiled = null;
    try {
        compiled = entry ? await getCompiledMemory(key) : null;
    } catch {
        compiled = null;
    }
    if (token !== loadToken) return;
    state.tics = key ? getChatPhraseTics(key) : [];
    state.records = records;
    state.names = names;
    state.compiled = compiled;
    const ids = new Set(records.map((r) => r.id));
    state.checked = new Set([...state.checked].filter((id) => ids.has(id)));
    render();
}

// The chat list, then whether each chat still exists (slower: may ask the
// server), redrawn when known.
async function loadChats() {
    const entries = listChatEntries();
    const open = openChatKey();
    // The open chat - even with nothing stored yet - unless another chat
    // with memories is chosen.
    if (!state.selectedKey || (!getChatEntry(state.selectedKey) && state.selectedKey !== open)) {
        state.selectedKey = open ?? entries[0]?.chatKey ?? null;
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
    const { subtypes, entities, tags } = filterChoices(state.records);
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
    fill('tag', tags, 'Any tag');
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
    for (const tag of record.tags ?? []) meta.append(el('span', `ar-mb-tag ar-mb-memory-tag ar-mb-memory-tag-${tag}`, tag));
    if (record.tone) meta.append(el('span', 'ar-mb-tone', record.tone));
    body.append(meta, el('div', 'ar-mb-record-text', record.text));
    const named = (ids) => ids.map((id) => state.names.get(id) ?? id).join(', ');
    if (record.entity_ids.length) body.append(el('div', 'ar-mb-record-entities', `About: ${named(record.entity_ids)}`));
    if (record.witness_ids?.length) body.append(el('div', 'ar-mb-record-entities', `Present: ${named(record.witness_ids)}`));
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
    // The open chat with nothing stored yet has no registry entry.
    const openRef = !entry && state.selectedKey && state.selectedKey === openChatKey() ? getCurrentChatRef() : null;
    const shownChat = entry ?? openRef;
    part('title').textContent = shownChat ? `${shownChat.displayName ? `${shownChat.displayName} - ` : ''}${shownChat.chatId}` : 'No chat open';
    part('toolbar').hidden = !entry;
    part('chatActions').hidden = !entry;
    const list = part('records');
    if (!entry) {
        part('count').textContent = '';
        list.replaceChildren(el('div', 'ar-mb-empty', openRef
            ? 'No memories stored for this chat yet. With Archivist enabled, they are stored as State Engine extracts them after each AI reply - the drawer\'s "Last update" line shows what happened the last time.'
            : 'No chat is open, and no chat has memories stored yet.'));
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

// ---- the compiled view

// "message #12" / "messages #3-8" for an item's message_range, as a link
// that jumps there when its chat is open.
function messageLink(range) {
    if (!range) return null;
    const label = range.from === range.to ? `message #${range.from}` : `messages #${range.from}-${range.to}`;
    if (state.selectedKey !== openChatKey()) {
        const text = el('span', 'ar-mb-link ar-mb-link-off', label);
        text.title = 'Open this chat to jump to the messages';
        return text;
    }
    const link = el('button', 'ar-mb-link', label);
    link.type = 'button';
    link.dataset.mbJump = String(range.from);
    link.title = `Show ${label} in the chat`;
    return link;
}

function tagChip(item) {
    const chip = el('span', 'ar-mb-chip', item.color_name);
    chip.style.setProperty('--ar-chip', item.color_hex);
    return chip;
}

// The edit form in place of an item's row while it is being edited.
function editable(kind, key, buildRow) {
    const editing = state.editing;
    if (!editing || editing.kind !== kind || editing.key !== key) return buildRow();
    const row = el('div', 'ar-mb-fact ar-mb-editing');
    row.append(buildEditForm(kind, editing.values));
    return row;
}

function factRow(fact) {
    return editable('fact', fact.id, () => factRowView(fact));
}

function factRowView(fact) {
    const row = el('div', 'ar-mb-fact');
    row.style.setProperty('--ar-chip', fact.color_hex);
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(tagChip(fact));
    if (fact.theme) meta.append(el('span', '', fact.theme));
    const about = fact.entities.map((e) => e.name).filter(Boolean).join(', ');
    if (about) meta.append(el('span', '', `about ${about}`));
    const link = messageLink(fact.message_range);
    if (link) meta.append(link);
    if (fact.edited_at) meta.append(el('span', 'ar-mb-tag', 'edited'));
    meta.append(itemButtons('fact', fact.id));
    row.append(meta, el('div', 'ar-mb-record-text', fact.text));
    if (fact.contradicts?.length) row.title = `Contradicts: ${fact.contradicts.join(', ')}`;
    return row;
}

function section(title, rows, emptyText) {
    const box = el('div', 'ar-mb-section');
    box.append(el('div', 'ar-mb-section-title', title));
    box.append(...(rows.length ? rows : [el('div', 'ar-mb-empty', emptyText)]));
    return box;
}

// The polarity as a bar from -3 to +3, coloured by its sign.
function polarityBar(polarity, label) {
    const bar = el('span', 'ar-mb-polarity');
    bar.dataset.sign = polarity > 0 ? 'positive' : (polarity < 0 ? 'negative' : 'neutral');
    bar.style.setProperty('--ar-polarity', String(Math.abs(polarity) / 3));
    bar.title = `${label} (${polarity > 0 ? '+' : ''}${polarity} on -3..+3)`;
    bar.append(el('span', 'ar-mb-polarity-fill'));
    return bar;
}

function relationshipRow(rel, { from = true } = {}) {
    return editable('relationship', rel.item_key, () => relationshipRowView(rel, { from }));
}

function relationshipRowView(rel, { from }) {
    const row = el('div', 'ar-mb-fact');
    row.style.setProperty('--ar-chip', rel.color_hex);
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(tagChip(rel), el('span', 'ar-mb-strong', `${from ? `${rel.from.name} -> ` : ''}${rel.to.name}`), el('span', '', rel.type));
    meta.append(polarityBar(rel.polarity, rel.polarity_label), el('span', '', `${rel.polarity_label} · ${rel.intensity} intensity${rel.trend ? ` · ${rel.trend}` : ''}`));
    const link = messageLink(rel.message_range);
    if (link) meta.append(link);
    if (rel.edited_at) meta.append(el('span', 'ar-mb-tag', 'edited'));
    meta.append(itemButtons('relationship', rel.item_key));
    row.append(meta, el('div', 'ar-mb-record-text', rel.text));
    return row;
}

// A grid of who feels what toward whom: rows "from", columns "to", each
// cell coloured by polarity, its type written in it.
function relationshipMap(map) {
    if (map.entities.length < 2) return null;
    const key = (e) => e.id ?? `name:${e.name.toLowerCase()}`;
    const cells = new Map(map.cells.map((c) => [`${key(c.from)}|${key(c.to)}`, c]));
    const scroller = el('div', 'ar-mb-map-scroll');
    const table = el('table', 'ar-mb-map');
    const head = el('tr');
    head.append(el('th', 'ar-mb-map-corner', 'from \\ to'), ...map.entities.map((e) => el('th', '', e.name)));
    table.append(head);
    for (const from of map.entities) {
        const row = el('tr');
        row.append(el('th', '', from.name));
        for (const to of map.entities) {
            const cell = cells.get(`${key(from)}|${key(to)}`);
            const td = el('td', from === to ? 'ar-mb-map-self' : '');
            if (cell) {
                td.dataset.sign = cell.polarity > 0 ? 'positive' : (cell.polarity < 0 ? 'negative' : 'neutral');
                td.style.setProperty('--ar-polarity', String(Math.abs(cell.polarity) / 3));
                td.textContent = cell.type;
                td.title = `${from.name} -> ${to.name}: ${cell.type}, ${cell.polarity_label} (${cell.polarity > 0 ? '+' : ''}${cell.polarity}), ${cell.intensity} intensity${cell.trend ? `, ${cell.trend}` : ''}`;
            }
            row.append(td);
        }
        table.append(row);
    }
    scroller.append(table);
    return scroller;
}

// "Traits: kind, stubborn" lines for a profile's insights.
function insightLines(profile) {
    const lines = [];
    for (const [field, label] of [['traits', 'Traits'], ['habits', 'Habits'], ['stressors', 'Stressors'], ['motivations', 'Motivations']]) {
        if (profile[field]?.length) lines.push([label, profile[field].join(', ')]);
    }
    if (profile.summary) lines.unshift(['Now', profile.summary]);
    if (profile.arc) lines.push(['Arc', profile.arc]);
    if (profile.emotional_state) lines.push(['Feeling', profile.emotional_state]);
    return lines.map(([label, text]) => {
        const line = el('div', 'ar-mb-insight');
        line.append(el('span', 'ar-mb-insight-label', `${label}: `), el('span', '', text));
        return line;
    });
}

function profileBox(profile) {
    const box = el('div', 'ar-mb-profile');
    const head = el('div', 'ar-mb-profile-head');
    head.append(el('span', 'ar-mb-owner-name', profile.name));
    if (profile.entity_type) head.append(el('span', 'ar-mb-tag', profile.entity_type));
    let insights = el('div', 'ar-mb-insights');
    if (profile.insights_key) {
        const buttons = itemButtons('character', profile.insights_key);
        buttons.title = 'Edit or delete these insights (each fact below has its own buttons)';
        head.append(buttons);
        insights = editable('character', profile.insights_key, () => {
            const wrap = el('div', 'ar-mb-insights');
            wrap.append(...insightLines(profile));
            return wrap;
        });
    }
    box.append(head, insights, ...profile.facts.map(factRow));
    const outgoing = profile.relationships.filter((r) => r.direction === 'out');
    if (outgoing.length) box.append(...outgoing.map((r) => relationshipRow(r, { from: false })));
    return box;
}

const STATUS_LABELS = { open: 'Open', active: 'Active', resolved: 'Resolved', abandoned: 'Abandoned' };

function threadRow(thread) {
    return editable('thread', thread.id, () => threadRowView(thread));
}

function threadRowView(thread) {
    const row = el('div', `ar-mb-fact ar-mb-thread ar-mb-thread-${thread.status}`);
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(el('span', 'ar-mb-status', STATUS_LABELS[thread.status] ?? thread.status), el('span', '', thread.kind), el('span', 'ar-mb-strong', thread.title));
    if (thread.entity) meta.append(el('span', 'ar-mb-tag', `${thread.entity.type ?? 'object'}: ${thread.entity.name}`));
    const link = messageLink(thread.message_range);
    if (link) meta.append(link);
    if (thread.edited_at) meta.append(el('span', 'ar-mb-tag', 'edited'));
    meta.append(itemButtons('thread', thread.id));
    row.append(meta, el('div', 'ar-mb-record-text', thread.text));
    if (thread.progress) row.append(el('div', 'ar-mb-record-entities', `Progress: ${thread.progress}`));
    const involved = thread.involved.map((e) => e.name).filter(Boolean).join(', ');
    if (involved) row.append(el('div', 'ar-mb-record-entities', `Involves: ${involved}`));
    return row;
}

const WORLD_SECTIONS = [
    ['secret', 'Secrets', 'No secrets yet.'],
    ['location', 'Locations', 'No places yet.'],
    ['faction', 'Factions and groups', 'No groups yet.'],
    ['item', 'Items', 'No items yet.'],
    ['event', 'World events', 'Nothing going on in the world yet.'],
    ['lore', 'Lore and rules', 'No lore yet.'],
];

function worldRow(entry) {
    return editable('world', entry.id, () => worldRowView(entry));
}

function worldRowView(entry) {
    // A secret revealed or disproven, an event over: kept, but settled.
    const settled = ['revealed', 'disproven', 'over'].includes(entry.status);
    const row = el('div', `ar-mb-fact${settled ? ' ar-mb-settled' : ''}`);
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(el('span', 'ar-mb-strong', entry.name));
    if (entry.entity) meta.append(el('span', 'ar-mb-tag', entry.entity.type ?? 'object'));
    if (entry.status) meta.append(el('span', '', entry.status));
    const link = messageLink(entry.message_range);
    if (link) meta.append(link);
    if (entry.edited_at) meta.append(el('span', 'ar-mb-tag', 'edited'));
    meta.append(itemButtons('world', entry.id));
    row.append(meta, el('div', 'ar-mb-record-text', entry.text));
    const knownBy = entry.known_by.map((e) => e.name).filter(Boolean).join(', ');
    if (entry.kind === 'secret') row.append(el('div', 'ar-mb-record-entities', `Known by: ${knownBy || 'nobody named yet'}`));
    const involved = entry.involved.map((e) => e.name).filter(Boolean).join(', ');
    if (involved) row.append(el('div', 'ar-mb-record-entities', `Connected: ${involved}`));
    return row;
}

function timelineRow(item) {
    const row = el('div', `ar-mb-fact ar-mb-timeline${item.major ? ' ar-mb-major' : ''}`);
    const meta = el('div', 'ar-mb-record-meta');
    if (item.major) meta.append(el('span', 'ar-mb-status', 'Major'));
    meta.append(el('span', '', `${words(item.scope)} · ${item.importance}`));
    if (item.tone) meta.append(el('span', '', item.tone));
    const link = messageLink(item.message_index === null ? null : { from: item.message_index, to: item.message_index });
    if (link) meta.append(link);
    if (item.message_date) meta.append(el('span', '', shortDate(item.message_date) || item.message_date));
    row.append(meta, el('div', 'ar-mb-record-text', item.text));
    const witnesses = item.witnesses.map((w) => w.name ?? w.id).join(', ');
    if (witnesses) row.append(el('div', 'ar-mb-record-entities', `Witnessed by: ${witnesses}`));
    return row;
}

function compileButton(name, label, icon, title) {
    const button = el('button', 'menu_button menu_button_icon', '');
    button.type = 'button';
    button.dataset.mb = name;
    button.title = title;
    button.append(el('i', `fa-solid ${icon}`), el('span', '', label));
    button.disabled = isCompiling();
    return button;
}

// What the compiler is doing (or did last) for the chat shown: the
// drawer's status line, so a click on Compile now always shows something.
function compileStatusLine(view) {
    const status = getCompilerStatus();
    const forThisChat = status && status.chatKey === state.selectedKey;
    const line = compilerLine(forThisChat ? status : null, view ? { at: view.compiledAt, pending: view.pending } : null);
    const node = el('div', `ar-mb-compile-status${line.error ? ' ar-mb-compile-error' : ''}`, line.text);
    node.dataset.mb = 'compileStatus';
    return node;
}

function renderCompiled() {
    const list = part('records');
    const view = state.compiled;
    const isOpen = state.selectedKey === openChatKey();
    const head = el('div', 'ar-mb-compiled-head');
    head.append(compileStatusLine(view));
    if (isOpen && (!view || view.pending)) head.append(compileButton('compileNow', view ? `Compile the ${view.pending} new` : 'Compile now', 'fa-gears', 'Compile this chat\'s new memories now'));
    if (isOpen && view) head.append(compileButton('compileRebuild', 'Rebuild', 'fa-arrows-rotate', 'Start over: compile every memory of this chat from scratch'));
    if (!view) {
        const empty = el('div', 'ar-mb-empty', isOpen
            ? 'Not compiled yet. The compiler runs on its own once enough memories have arrived (Archivist drawer -> Compiler), or now:'
            : 'Not compiled yet. Open this chat to compile it.');
        list.replaceChildren(empty, head);
        part('count').textContent = '';
        return;
    }
    const time = view.compiledAt ? shortDate(view.compiledAt) : '';
    const tone = view.recent_tone.length ? ` · lately ${view.recent_tone.map((t) => t.tone).join(', ')}` : '';
    part('count').textContent = `compiled ${time}${view.pending ? ` · ${view.pending} new since` : ''}${tone}`;
    if (view.outdated) {
        head.append(el('div', 'ar-mb-empty', 'Compiled before character insights, story threads and the world were added - Rebuild to fill them in for the whole chat.'));
    }
    const worldSections = WORLD_SECTIONS.map(([kind, title, emptyText]) => section(title, view.world[kind].map(worldRow), emptyText));
    const map = relationshipMap(view.relationship_map);
    const suggestions = view.alias_suggestions ?? [];
    list.replaceChildren(
        head,
        ...(suggestions.length ? [section('Suggested aliases', suggestions.map(aliasRow), '')] : []),
        section('Story so far', view.story_summary ? [summaryRow(view.story_summary, 'story')] : [], 'No summary yet - the next compile writes one.'),
        section('Characters', view.character_profiles.map(profileBox), 'No lasting facts or insights yet.'),
        section('Scene', sceneRows(view), 'Nothing about the current scene yet.'),
        section('Session', view.session_details.map(factRow), 'Nothing about this part of the story.'),
        section('Relationship map', map ? [map] : [], 'Needs relationships between at least two characters.'),
        section('Relationships', view.relationships.map((r) => relationshipRow(r)), 'No relationships yet.'),
        section('Story threads and quests', view.threads.map(threadRow), 'No plot hooks, open threads or quests yet.'),
        ...worldSections,
        section('Timeline', view.timeline.map(timelineRow), 'No events yet.'),
        section('Phrase tics', state.tics.map(ticRow), 'No repeated stock phrases found in the narration lately.'),
    );
}

// A phrase tic: how much it is in use, and a button to forget it (it can
// be found again later - nothing is banned).
function ticRow(tic) {
    const inUse = tic.count >= WARN_AT;
    const row = el('div', `ar-mb-fact${inUse ? '' : ' ar-mb-settled'}`);
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(el('span', 'ar-mb-status', inUse ? 'In use' : 'Watching'), el('span', '', `count ${tic.count}`));
    if (tic.last_used) meta.append(el('span', '', `last seen ${shortDate(tic.last_used)}`));
    const remove = el('button', 'menu_button fa-solid fa-trash-can ar-mb-item-button');
    remove.type = 'button';
    remove.title = 'Forget this phrase tic (the compiler may find it again if it keeps coming back)';
    remove.dataset.mbTic = tic.key;
    const buttons = el('span', 'ar-mb-item-buttons');
    buttons.append(remove);
    meta.append(buttons);
    row.append(meta, el('div', 'ar-mb-record-text', tic.phrase));
    row.title = inUse ? 'The Curator block Phrase tics to vary asks the model to word this differently for now.' : 'Seen repeated; asked about only if it keeps coming back.';
    return row;
}

function summaryRow(text, which) {
    return editable('summary', which, () => {
        const row = el('div', 'ar-mb-fact ar-mb-summary');
        const meta = el('div', 'ar-mb-record-meta');
        meta.append(itemButtons('summary', which, { remove: false }));
        row.append(meta, el('div', 'ar-mb-record-text', text));
        return row;
    });
}

// The scene: the compiler's summary of it, the facts it classed SCENE, and
// - from the memories themselves - what just happened in it.
function sceneRows(view) {
    const rows = [];
    if (view.scene_summary) rows.push(summaryRow(view.scene_summary, 'scene'));
    rows.push(...view.scene_state.map(factRow));
    for (const memory of view.scene_recent ?? []) {
        const row = el('div', 'ar-mb-fact ar-mb-scene-recent');
        const meta = el('div', 'ar-mb-record-meta');
        meta.append(el('span', '', 'just happened'));
        if (memory.tone) meta.append(el('span', '', memory.tone));
        const link = messageLink({ from: memory.message_index, to: memory.message_index });
        if (link) meta.append(link);
        row.append(meta, el('div', 'ar-mb-record-text', memory.text));
        rows.push(row);
    }
    return rows;
}

// A name the story uses for an object that the object doesn't have
// (entity-link.js aliasSuggestions), with a button that adds it.
function aliasRow(suggestion, index) {
    const row = el('div', 'ar-mb-fact ar-mb-alias');
    const meta = el('div', 'ar-mb-record-meta');
    meta.append(el('span', 'ar-mb-strong', `"${suggestion.alias}"`), el('span', '', `for ${suggestion.object_name}`));
    if (suggestion.object_type) meta.append(el('span', 'ar-mb-tag', suggestion.object_type));
    const add = el('button', 'menu_button menu_button_icon', '');
    add.type = 'button';
    add.dataset.mbAlias = String(index);
    add.title = `Add "${suggestion.alias}" to ${suggestion.object_name}'s aliases in State Engine, so it is recognised by that name everywhere`;
    add.append(el('i', 'fa-solid fa-tag'), el('span', '', 'Add alias'));
    meta.append(add);
    row.append(meta, el('div', 'ar-mb-record-entities', 'The memories call it by this name - as an alias, State Engine and every extension link it to this object directly.'));
    return row;
}

async function addSuggestedAlias(index) {
    const suggestion = state.compiled?.alias_suggestions?.[index];
    const entry = getChatEntry(state.selectedKey ?? '');
    if (!suggestion || !entry) return;
    try {
        const updated = await addObjectAlias(entry.chatId, suggestion.object_id, suggestion.alias);
        if (!updated) throw new Error('State Engine refused the alias');
        toastr.success(`"${suggestion.alias}" is now an alias of ${suggestion.object_name}.`, 'Archivist');
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not add the alias', err);
        toastr.error('The alias could not be added - see the browser console.', 'Archivist');
    }
    await loadSelected();
}

function renderViewSwitch() {
    for (const button of overlay.querySelectorAll('[data-mb-view]')) {
        button.classList.toggle('ar-mb-view-active', button.dataset.mbView === state.view);
    }
}

function render() {
    if (!overlay || !state.open) return;
    renderChats();
    renderViewSwitch();
    renderRecords();
    if (state.view === 'compiled' && getChatEntry(state.selectedKey ?? '')) {
        part('toolbar').hidden = true;
        part('chatActions').hidden = true;
        renderCompiled();
    }
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

// ---- editing the compiled memory

const KIND_NAMES = { fact: 'fact', relationship: 'relationship', character: 'set of character insights', thread: 'story thread', world: 'world entry' };

function startEdit(kind, key) {
    const item = findViewItem(state.compiled, kind, key);
    if (!item) return;
    state.editing = { kind, key, values: editValues(kind, item) };
    render();
    overlay.querySelector('.ar-mb-editing [data-mb-field]')?.focus();
}

async function saveEdit() {
    const editing = state.editing;
    if (!editing) return;
    try {
        const changed = editing.kind === 'summary'
            ? await editCompiledMemorySummary(state.selectedKey, editing.key, editing.values.text)
            : await editCompiledMemoryItem(state.selectedKey, editing.kind, editing.key, editing.values);
        if (!changed) toastr.warning('That item is gone - the compiled memory changed meanwhile.', 'Archivist');
        state.editing = null;
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not save the edit', err);
        toastr.error(`The change could not be saved: ${err?.message ?? err}`, 'Archivist');
        return;
    }
    await loadSelected();
}

async function removeItem(kind, key) {
    const item = findViewItem(state.compiled, kind, key);
    if (!item) return;
    const what = item.title ?? item.name ?? item.text ?? (item.from ? `${item.from.name} -> ${item.to.name}` : '');
    const question = `Delete this ${KIND_NAMES[kind] ?? 'item'}?\n\n"${what}"\n\nLater compiles leave it out; the memories it came from are kept.`;
    if (!await confirmAction(question)) return;
    try {
        await deleteCompiledMemoryItem(state.selectedKey, kind, key);
        if (state.editing?.kind === kind && state.editing?.key === key) state.editing = null;
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not delete the compiled item', err);
        toastr.error(`It could not be deleted: ${err?.message ?? err}`, 'Archivist');
    }
    await loadSelected();
}

// Compile now / Rebuild from the compiled view. Its progress and outcome
// show in the view's status line (re-drawn on every compiler status).
async function runCompile(rebuild) {
    const started = await compileOpenChat({ rebuild, reason: rebuild ? 'rebuild' : 'manual' });
    if (!started) toastr.info(isCompiling() ? 'The compiler is already running - it shows its progress here.' : 'Open this chat to compile it.', 'Archivist');
    await loadSelected();
}

function onClick(e) {
    if (e.target === overlay || e.target.closest('[data-mb="close"]')) {
        closeMemoryBrowser();
        return;
    }
    const viewButton = e.target.closest('[data-mb-view]');
    if (viewButton) {
        state.view = viewButton.dataset.mbView;
        state.editing = null;
        render();
        return;
    }
    const edit = e.target.closest('[data-mb-edit]');
    if (edit) {
        startEdit(edit.dataset.mbEdit, edit.dataset.mbKey);
        return;
    }
    const remove = e.target.closest('[data-mb-remove]');
    if (remove) {
        void removeItem(remove.dataset.mbRemove, remove.dataset.mbKey);
        return;
    }
    const tic = e.target.closest('[data-mb-tic]');
    if (tic) {
        removePhraseTic(state.selectedKey, tic.dataset.mbTic);
        void loadSelected();
        return;
    }
    if (e.target.closest('[data-mb-save]')) {
        void saveEdit();
        return;
    }
    if (e.target.closest('[data-mb-cancel]')) {
        state.editing = null;
        void loadSelected();
        return;
    }
    const jump = e.target.closest('[data-mb-jump]');
    if (jump) {
        void jumpToMessage(Number(jump.dataset.mbJump));
        return;
    }
    if (e.target.closest('[data-mb="compileNow"]')) {
        void runCompile(false);
        return;
    }
    const alias = e.target.closest('[data-mb-alias]');
    if (alias) {
        alias.disabled = true;
        void addSuggestedAlias(Number(alias.dataset.mbAlias));
        return;
    }
    if (e.target.closest('[data-mb="compileRebuild"]')) {
        void confirmAction('Rebuild the compiled memory of this chat from every memory? It starts over and runs the compiler over all of them, which can take a while and uses the compiler\'s connection.')
            .then((yes) => (yes ? runCompile(true) : null));
        return;
    }
    const chat = e.target.closest('[data-chat-key]');
    if (chat) {
        state.selectedKey = chat.dataset.chatKey;
        state.editing = null;
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
    const field = e.target.dataset?.mbField;
    if (field && state.editing) {
        state.editing.values[field] = e.target.value;
        return;
    }
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
                        <div class="ar-mb-views">
                            <button type="button" class="menu_button" data-mb-view="memories" title="The memories as stored - search, filter, delete">Memories</button>
                            <button type="button" class="menu_button" data-mb-view="compiled" title="Profiles, scene, session, relationships and timeline, compiled from the memories">Compiled</button>
                        </div>
                        <small class="ar-mb-count" data-mb="count"></small>
                    </div>
                    <div class="ar-mb-toolbar" data-mb="toolbar">
                        <input type="search" class="text_pole ar-mb-search" data-mb="search" placeholder="Search text and names..." />
                        <select class="text_pole" data-mb="subtype" title="Type"></select>
                        <select class="text_pole" data-mb="scope" title="Scope"></select>
                        <select class="text_pole" data-mb="importance" title="Importance"></select>
                        <select class="text_pole" data-mb="entity" title="Who or what it is about, or who was there"></select>
                        <select class="text_pole" data-mb="tag" title="Tag"></select>
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
        if (!state.open || e.key !== 'Escape' || document.querySelector('.popup:not([hidden])')) return;
        // Escape leaves an edit first, then the window.
        if (state.editing) {
            state.editing = null;
            void loadSelected();
        } else {
            closeMemoryBrowser();
        }
    });
    // Stay current while open: new memories, deletions, renamed chats.
    // An edit in progress is not redrawn under the user's cursor: the
    // window catches up when it is saved or cancelled.
    const refresh = () => {
        if (state.open && !state.editing) {
            render();
            void loadSelected();
        }
    };
    SillyTavern.getContext().eventSource.on(MEMORIES_CHANGED_EVENT, refresh);
    SillyTavern.getContext().eventSource.on(COMPILED_CHANGED_EVENT, refresh);
    SillyTavern.getContext().eventSource.on(PHRASE_TICS_CHANGED_EVENT, refresh);
    // The compiled view shows what the compiler is doing as it does it.
    onCompilerStatus(() => {
        if (state.open && state.view === 'compiled' && !state.editing) render();
    });
}

// Opens the browser on the open chat (or the first chat with memories).
// `view`: 'memories' (default) or 'compiled'.
export async function openMemoryBrowser({ view = 'memories' } = {}) {
    // (Re)built when missing - something may have removed it from the page.
    if (!overlay?.isConnected) build();
    state.open = true;
    state.view = view;
    state.selectedKey = null;
    state.editing = null;
    state.filters = { ...EMPTY_FILTERS };
    state.checked.clear();
    overlay.hidden = false;
    await loadChats();
}

export function closeMemoryBrowser() {
    state.open = false;
    if (overlay) overlay.hidden = true;
}
