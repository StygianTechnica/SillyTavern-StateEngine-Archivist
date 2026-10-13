// Keeps the prompt-context variables (src/context/prompt-context.js) of the
// open chat current, for Curator to inject. They live in the live preset
// (src/extraction/live.js) - active for the chat while Archivist is
// enabled - as plain, non-prompted text variables: Archivist writes them,
// the model is never asked for them. Curator reads their values just before
// each prompt is sent.
//
// Re-built (debounced) after memories change, after a compile, on a chat
// change, and when State Engine's variables change (characters arriving or
// leaving the scene). Only a block whose text changed is written, so
// Archivist's own writes - which State Engine announces as a variables
// change too - settle at once.

import { LOG_PREFIX } from '../constants.js';
import { getSettings } from '../settings.js';
import { getVariableValue, setVariableValue, qualifiedName, VARIABLES_CHANGED_EVENT } from '../api/variables.js';
import { listObjects } from '../api/objects.js';
import { getCurrentChatRef } from '../memory/registry.js';
import { MEMORIES_CHANGED_EVENT } from '../memory/archivist.js';
import { getCompiledMemory, COMPILED_CHANGED_EVENT } from '../compiler/compiler.js';
import { nameKey } from '../compiler/entity-link.js';
import { LIVE_PRESET } from '../extraction/live.js';
import { CONTEXT_BLOCKS, buildPromptContext } from './prompt-context.js';

// The Curator capabilities for each block's variable: offered for injection,
// as a user message (Curator's suggested role).
export const CONTEXT_CAPABILITIES = CONTEXT_BLOCKS.flatMap(([name]) => [
    `curator.inject:${qualifiedName(name)}`,
    `curator.inject.role:user:${qualifiedName(name)}`,
]);
export const CONTEXT_VARIABLE_NAMES = CONTEXT_BLOCKS.map(([name]) => qualifiedName(name));

// The characters in the scene - State Engine's present ones; failing that,
// those the newest scene memories name or were witnessed by - and the
// user's persona (its character object when there is one).
async function whoIsHere(chatId, view) {
    let characters = [];
    try {
        characters = await listObjects(chatId, 'character');
    } catch {
        characters = [];
    }
    let present = characters.filter((c) => (c.runtime?.present ?? c.present) === true);
    if (present.length === 0) {
        const ids = new Set((view?.scene_recent ?? []).flatMap((m) => [...m.entity_ids, ...m.witness_ids]));
        present = characters.filter((c) => ids.has(c.id));
    }
    let personaName = '';
    try {
        personaName = SillyTavern.getContext().name1 ?? '';
    } catch {
        personaName = '';
    }
    const key = nameKey(personaName);
    const persona = !key ? null
        : characters.find((c) => [c.name, ...(c.aliases ?? [])].some((n) => nameKey(n) === key)) ?? { id: null, name: personaName, aliases: [] };
    return { present, persona };
}

// Rebuilds the open chat's blocks and writes the changed ones. Never throws.
export async function syncPromptContext() {
    const ref = getCurrentChatRef();
    if (!ref || !getSettings().enabled) return;
    try {
        const view = await getCompiledMemory();
        const texts = buildPromptContext(view, await whoIsHere(ref.chatId, view));
        for (const [name] of CONTEXT_BLOCKS) {
            const current = await getVariableValue(ref.chatId, name);
            if ((current ?? '') === texts[name]) continue;
            await setVariableValue(ref.chatId, LIVE_PRESET, name, texts[name]);
        }
    } catch (err) {
        console.warn(LOG_PREFIX, 'could not update the prompt context for Curator', err);
    }
}

const DEBOUNCE_MS = 1500;

export function startPromptContext() {
    const { eventSource, eventTypes } = SillyTavern.getContext();
    let timer = null;
    const later = () => {
        clearTimeout(timer);
        timer = setTimeout(() => void syncPromptContext(), DEBOUNCE_MS);
    };
    for (const event of [MEMORIES_CHANGED_EVENT, COMPILED_CHANGED_EVENT, VARIABLES_CHANGED_EVENT, eventTypes.CHAT_CHANGED]) eventSource.on(event, later);
    later();
}
