// The memory browser's editor for one compiled item - a fact, a
// relationship, a character's insights, a story thread, a world entry or
// one of the two summaries. The user can correct anything the compiler
// wrote, or delete it (compiler.js editCompiledMemoryItem /
// deleteCompiledMemoryItem); a deleted item is remembered, so later
// compiles leave it out.
//
// What is edited, as fields: [field, label, input, options?], input
// 'text' | 'textarea' | 'select' ([value, label] options). Lists (traits,
// "known by") are edited as comma-separated text.

import {
    CLASSIFICATIONS, POLARITY_LABELS, INTENSITIES, TRENDS, THREAD_STATUSES, WORLD_KINDS, stepsToText,
} from '../compiler/compiled-schema.js';

const pairs = (values) => values.map((v) => [v, v]);
const POLARITIES = [3, 2, 1, 0, -1, -2, -3].map((n) => [String(n), `${n > 0 ? '+' : ''}${n} ${POLARITY_LABELS[n]}`]);

export const EDIT_FIELDS = Object.freeze({
    fact: [
        ['text', 'Fact', 'textarea'],
        ['classification', 'Classification', 'select', CLASSIFICATIONS.map((c) => [c, c.toLowerCase()])],
        ['theme', 'Theme', 'text'],
    ],
    relationship: [
        ['type', 'Relationship', 'text'],
        ['polarity', 'Feeling', 'select', POLARITIES],
        ['intensity', 'Intensity', 'select', pairs(INTENSITIES)],
        ['trend', 'Trend', 'select', [['', '(not said)'], ...pairs(TRENDS)]],
        ['text', 'Description', 'textarea'],
    ],
    character: [
        ['summary', 'Who they are now', 'textarea'],
        ['traits', 'Traits', 'text'],
        ['habits', 'Habits', 'text'],
        ['stressors', 'Stressors', 'text'],
        ['motivations', 'Motivations', 'text'],
        ['arc', 'Arc', 'textarea'],
        ['emotional_state', 'Feeling', 'text'],
    ],
    thread: [
        ['title', 'Title', 'text'],
        ['kind', 'Kind', 'text'],
        ['status', 'Status', 'select', pairs(THREAD_STATUSES)],
        ['text', 'What it is', 'textarea'],
        ['progress', 'Progress', 'textarea'],
        ['goal', 'Plan goal', 'text'],
        ['steps', 'Plan steps', 'textarea'],
    ],
    world: [
        ['name', 'Name', 'text'],
        ['kind', 'Kind', 'select', pairs(WORLD_KINDS)],
        ['status', 'Status', 'text'],
        ['known_by', 'Known by', 'text'],
        ['text', 'What is known', 'textarea'],
    ],
    summary: [
        ['text', 'Summary', 'textarea'],
    ],
});

const LIST_FIELDS = new Set(['traits', 'habits', 'stressors', 'motivations']);
const PLACEHOLDERS = {
    traits: 'comma-separated', habits: 'comma-separated', stressors: 'comma-separated', motivations: 'comma-separated',
    known_by: 'names, comma-separated',
    status: 'secret: kept / revealed / disproven · event: ongoing / over',
    goal: 'what the plan works toward (blank if not a plan)',
    steps: 'one per line, in order: [pending|active|done|skipped|failed] what to do | note',
};

// The item of `kind` with `key` in a compiled view (getCompiledMemory()),
// or null. A summary's key is 'story' or 'scene'; it comes back as { text }.
export function findViewItem(view, kind, key) {
    if (!view) return null;
    switch (kind) {
        case 'fact': {
            const facts = [...(view.scene_state ?? []), ...(view.session_details ?? []), ...(view.character_profiles ?? []).flatMap((p) => p.facts ?? [])];
            return facts.find((f) => f.id === key) ?? null;
        }
        case 'relationship': return (view.relationships ?? []).find((r) => r.item_key === key) ?? null;
        case 'character': return (view.character_profiles ?? []).find((p) => p.insights_key === key) ?? null;
        case 'thread': return (view.threads ?? []).find((t) => t.id === key) ?? null;
        case 'world': return Object.values(view.world ?? {}).flat().find((w) => w.id === key) ?? null;
        case 'summary':
            if (key === 'story') return { text: view.story_summary ?? '' };
            if (key === 'scene') return { text: view.scene_summary ?? '' };
            return null;
        default: return null;
    }
}

// The form's starting values for `item`: { field: string }.
export function editValues(kind, item) {
    const values = {};
    for (const [field] of EDIT_FIELDS[kind] ?? []) {
        const value = item?.[field];
        if (field === 'steps') values[field] = stepsToText(value);
        else if (field === 'known_by') values[field] = (value ?? []).map((e) => e?.name).filter(Boolean).join(', ');
        else if (LIST_FIELDS.has(field)) values[field] = (value ?? []).join(', ');
        else values[field] = value === null || value === undefined ? '' : String(value);
    }
    return values;
}

const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// The edit form for `kind`, filled with `values`. Its inputs carry
// data-mb-field; its buttons data-mb-save and data-mb-cancel.
export function buildEditForm(kind, values) {
    const form = el('div', 'ar-mb-edit');
    for (const [field, label, input, options] of EDIT_FIELDS[kind] ?? []) {
        const row = el('label', 'ar-mb-edit-row');
        row.append(el('span', 'ar-mb-edit-label', label));
        let control;
        if (input === 'select') {
            control = el('select', 'text_pole');
            const current = values[field] ?? '';
            const known = options.some(([value]) => value === current);
            // A value the list doesn't have (an older answer) is kept as it is.
            for (const [value, text] of known ? options : [[current, current], ...options]) {
                const option = el('option', '', text);
                option.value = value;
                option.selected = value === current;
                control.append(option);
            }
        } else {
            control = el(input === 'textarea' ? 'textarea' : 'input', 'text_pole');
            if (input !== 'textarea') control.type = 'text';
            else control.rows = Math.min(8, Math.max(2, Math.ceil(String(values[field] ?? '').length / 70)));
            control.value = values[field] ?? '';
            if (PLACEHOLDERS[field]) control.placeholder = PLACEHOLDERS[field];
        }
        control.dataset.mbField = field;
        row.append(control);
        form.append(row);
    }
    const buttons = el('div', 'ar-mb-edit-buttons');
    const save = el('button', 'menu_button menu_button_icon');
    save.type = 'button';
    save.dataset.mbSave = '';
    save.append(el('i', 'fa-solid fa-check'), el('span', '', 'Save'));
    const cancel = el('button', 'menu_button menu_button_icon');
    cancel.type = 'button';
    cancel.dataset.mbCancel = '';
    cancel.append(el('i', 'fa-solid fa-xmark'), el('span', '', 'Cancel'));
    buttons.append(save, cancel);
    form.append(buttons);
    return form;
}

// The edit and delete buttons for an item's meta line. A summary has no
// delete.
export function itemButtons(kind, key, { remove = true } = {}) {
    const box = el('span', 'ar-mb-item-buttons');
    const edit = el('button', 'menu_button fa-solid fa-pen ar-mb-item-button');
    edit.type = 'button';
    edit.title = 'Edit';
    edit.dataset.mbEdit = kind;
    edit.dataset.mbKey = key;
    box.append(edit);
    if (remove) {
        const del = el('button', 'menu_button fa-solid fa-trash-can ar-mb-item-button');
        del.type = 'button';
        del.title = 'Delete - later compiles leave it out';
        del.dataset.mbRemove = kind;
        del.dataset.mbKey = key;
        box.append(del);
    }
    return box;
}
