// Keeping a compile inside the model's context. A local model with a small
// context (8k) stops the answer as soon as prompt + answer reach it - the
// prompt grows with the compiled store, so a long chat left the answer
// almost no room and it was cut off mid-fact. So before each run the
// prompt's size is estimated, room is kept for the answer, and the input
// shrinks until it fits:
//   1. every compiled item, with up to COMPILE_BATCH new memories;
//   2. only the items bearing on the batch (about its characters, places and
//      things; SCENE facts; threads the author wrote) - the others are kept
//      as they are, unseen (every answer is a list of changes);
//   3. smaller batches, down to MIN_BATCH, with 1 and 2;
//   4. as many of the bearing items as fit, most bearing first, with batches
//      down to a single memory.
// When not even one memory fits, the compile stops with an error - it never
// sends a prompt that overflows. Plain functions - compiler.js runs them.

import { factLine, relationshipLine, characterLine, threadLines, worldLine } from './compile-plan.js';

// A rough count, on the safe side: English runs near 4 characters a token
// in Llama 3's tokenizer, JSON and names fewer.
export const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text) => Math.ceil(String(text ?? '').length / CHARS_PER_TOKEN);

// The context assumed when neither Archivist's setting nor SillyTavern says.
export const DEFAULT_CONTEXT_TOKENS = 8192;
// The answer never takes more than this share of the context.
export const MAX_ANSWER_SHARE = 0.5;
// Kept free for what the estimate misses (the chat template, tokenizer
// differences): this share of the context, at least SAFETY_MIN tokens.
export const SAFETY_SHARE = 0.05;
export const SAFETY_MIN = 200;
// State Engine's output rules and the closing request it adds to every
// prompt (src/core/settings-core.js DEFAULT_UNIFIED_VARIABLE_RULES), in
// characters, rounded up.
export const STATE_ENGINE_RULES_CHARS = 1000;
// The words State Engine adds around each variable's instructions.
const PER_VARIABLE_CHARS = 160;
// Batches shrink to this before the knowledge shown is cut to what fits.
export const MIN_BATCH = 5;

// The context, in tokens: Archivist's own setting when given (> 0), else
// SillyTavern's (its Max context), else DEFAULT_CONTEXT_TOKENS.
export function contextTokens(setting, sillyTavernMaxContext) {
    for (const value of [setting, sillyTavernMaxContext]) {
        const n = Math.floor(Number(value));
        if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_CONTEXT_TOKENS;
}

// The room kept for the answer: the compiler's Max tokens, but never more
// than MAX_ANSWER_SHARE of the context.
export function answerTokens(maxTokens, context) {
    const wanted = Math.floor(Number(maxTokens)) > 0 ? Math.floor(Number(maxTokens)) : 3000;
    return Math.max(1, Math.min(wanted, Math.floor(context * MAX_ANSWER_SHARE)));
}

// The characters a preset's prompt takes besides the context it is handed:
// its header, State Engine's rules, and each variable's instructions.
export function presetOverheadChars(header, instructions) {
    return String(header ?? '').length + STATE_ENGINE_RULES_CHARS
        + instructions.reduce((sum, text) => sum + String(text ?? '').length + PER_VARIABLE_CHARS, 0);
}

// The characters left for a preset's context: what the context holds after
// the answer's room, the safety margin and the preset's own text.
export function contextBudgetChars({ context, answer, overheadChars }) {
    const safety = Math.max(SAFETY_MIN, Math.ceil(context * SAFETY_SHARE));
    return Math.floor((context - answer - safety) * CHARS_PER_TOKEN) - overheadChars;
}

// ---- what bears on a batch

const lower = (value) => String(value ?? '').trim().toLowerCase();

// What a batch is about: its memories' entity and witness ids, their names
// (`nameOf(id)`), and their text.
export function batchFocus(batch, nameOf = () => null) {
    const ids = new Set(batch.flatMap((r) => [...(r.entity_ids ?? []), ...(r.witness_ids ?? [])]));
    const names = new Set([...ids].map((id) => lower(nameOf(id))).filter(Boolean));
    const text = lower([...batch.map((r) => r.text), ...names].join('\n'));
    return { ids, names, text };
}

// Whether an entity ({ id, name }, or a name) is one the batch is about:
// its id, its name, or its name's first word (a first name), in the batch.
export function bearsOn(entity, focus) {
    if (!entity) return false;
    if (typeof entity === 'object' && entity.id && focus.ids.has(entity.id)) return true;
    const name = lower(typeof entity === 'string' ? entity : entity.name);
    if (name.length < 3) return false;
    if (focus.names.has(name) || mentions(focus.text, name)) return true;
    const [first] = name.split(/\s+/);
    return first !== name && first.length >= 4 && mentions(focus.text, first);
}

// Whether `text` has `words` as whole words.
const mentions = (text, words) => new RegExp(`(^|[^\\p{L}\\p{N}])${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(text);

// The lists of each part, how each item reads, and how near it is to a
// batch: 0 always shown, 1 bears on the batch, 2 next in line, 3 the rest.
const near = (entities, focus) => (entities.some((e) => bearsOn(e, focus)) ? 1 : 3);

export const MEMORY_LISTS = Object.freeze([
    { key: 'facts', line: factLine, rank: (f, focus) => Math.min(near(f.entities ?? [], focus), f.classification === 'SCENE' ? 1 : 3) },
    { key: 'relationships', line: relationshipLine, rank: (r, focus) => near([r.from, r.to], focus) },
    { key: 'characters', line: characterLine, rank: (c, focus) => near([c.entity], focus) },
]);

export const WORLD_LISTS = Object.freeze([
    {
        key: 'threads',
        line: threadLines,
        rank: (t, focus) => {
            if (t.added_by === 'user') return 0;
            const rank = near([t.entity, ...(t.involved ?? []), ...(t.steps ?? []).flatMap((s) => s.involved ?? [])], focus);
            return rank === 3 && (t.status === 'active' || t.status === 'open') ? 2 : rank;
        },
    },
    {
        key: 'world',
        line: worldLine,
        rank: (w, focus) => near([w.entity, w.name, ...(w.involved ?? []), ...(w.known_by ?? []), ...(w.made_by ?? []), ...(w.made_to ?? [])], focus),
    },
]);

// The context for one part that fits `budget` characters:
// { context, partial: { [list]: true when cut }, shown: { [list]: Set of
// the shown items' ids } }, or null when it does not fit.
//   compiled  the compiled state; batch, focus  the batch and batchFocus()
//   lists     MEMORY_LISTS or WORLD_LISTS
//   render(view, partial) -> the context for a compiled state `view`
//   cut       false: everything, or what bears on the batch (steps 1, 2);
//             true: also as much of it as fits (step 4)
export function fitPart({ compiled, focus, lists, render, budget, cut = false }) {
    const full = render(compiled, {});
    if (full.length <= budget) return { context: full, partial: {}, shown: {} };
    const view = (pick) => {
        const next = { ...compiled };
        const partial = {};
        const shown = {};
        for (const list of lists) {
            const items = compiled[list.key] ?? [];
            next[list.key] = items.filter((item, i) => pick(list, item, i));
            partial[list.key] = next[list.key].length < items.length;
            shown[list.key] = new Set(next[list.key].map((item) => item.id).filter(Boolean));
        }
        return { next, partial, shown };
    };
    const bearing = view((list, item) => list.rank(item, focus) <= 1);
    const focused = render(bearing.next, bearing.partial);
    if (focused.length <= budget) return { context: focused, partial: bearing.partial, shown: bearing.shown };
    if (!cut) return null;

    // As many as fit, nearest first - the newest first among equals.
    const allCut = Object.fromEntries(lists.map((list) => [list.key, (compiled[list.key] ?? []).length > 0]));
    let room = budget - render(view(() => false).next, allCut).length;
    if (room < 0) return null;
    const candidates = lists.flatMap((list) => (compiled[list.key] ?? []).map((item, i) => ({ list, i, rank: list.rank(item, focus), cost: list.line(item).length + 1 })));
    candidates.sort((a, b) => a.rank - b.rank || b.i - a.i);
    const chosen = new Set();
    for (const c of candidates) {
        if (c.cost > room) continue;
        room -= c.cost;
        chosen.add(`${c.list.key}#${c.i}`);
    }
    const capped = view((list, item, i) => chosen.has(`${list.key}#${i}`));
    const context = render(capped.next, capped.partial);
    return context.length <= budget ? { context, partial: capped.partial, shown: capped.shown } : null;
}

// The next batch to compile from `pending` (memories, oldest first) and
// each part's context for it: { batch, parts: [fitPart() result], trimmed }
// - trimmed when the batch is smaller than it could be or a list was cut.
// Null when not even one memory fits (steps above).
//   parts  [{ lists, budget, render(view, batch, partial) }]
export function planBatch(pending, { compiled, parts, nameOf = () => null, maxBatch, minBatch = MIN_BATCH }) {
    const largest = Math.min(maxBatch, pending.length);
    const sizes = [];
    for (let size = largest; size >= 1; size = size === 1 ? 0 : Math.max(1, Math.floor(size / 2))) sizes.push(size);
    const attempt = (size, cut) => {
        const batch = pending.slice(0, size);
        const focus = batchFocus(batch, nameOf);
        const fitted = [];
        for (const part of parts) {
            const fit = fitPart({ compiled, focus, lists: part.lists, budget: part.budget, cut, render: (view, partial) => part.render(view, batch, partial) });
            if (!fit) return null;
            fitted.push(fit);
        }
        const cutList = fitted.some((fit) => Object.values(fit.partial).some(Boolean));
        return { batch, parts: fitted, trimmed: cutList || size < largest };
    };
    // Nothing pending (a rebuild of no memories): the knowledge alone.
    if (largest === 0) return attempt(0, true);
    const floor = Math.min(minBatch, largest);
    for (const size of sizes.filter((s) => s >= floor)) {
        const plan = attempt(size, false);
        if (plan) return plan;
    }
    for (const size of sizes.filter((s) => s <= floor)) {
        const plan = attempt(size, true);
        if (plan) return plan;
    }
    return null;
}
