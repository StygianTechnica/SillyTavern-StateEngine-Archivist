// The memory extraction variable: a prompted list of records that State
// Engine fills in with new memories, read and cleared by Archivist after
// each run. The live preset (src/extraction/live.js) and the catch-up
// preset each hold their own copy, built here, so the two never share a
// value and can run at the same time.
//
// State Engine describes a record list to the model only as "array of
// record", so the item shape is spelled out in the instructions below. Its
// itemSchema requires just `text`: State Engine drops any item missing a
// schema field, and Archivist's converter (src/extraction/converter.js)
// fills in or fixes everything else - a memory should not be lost because
// the model left out its importance.

import { KNOWN_SUBTYPES } from '../memory/schema.js';

export const MEMORY_VARIABLE = 'memories';

const ITEM_SHAPE = [
    'Each item is an object:',
    '{"text": one self-contained sentence stating the memory, naming who and what it is about;',
    `"subtype": one of ${KNOWN_SUBTYPES.join(', ')} (or another single word if none fits);`,
    '"scope": "scene" (matters only for the current scene), "session" (matters for this part of the story) or "long_term" (should be remembered from now on);',
    '"importance": "low", "medium" or "high";',
    '"entities": the names of the characters, places, factions, items, creatures and lore involved, exactly as the story names them}.',
].join(' ');

const LIVE_INSTRUCTIONS = [
    'NEW memories from the most recent roleplay message only: events, facts, relationship changes and secrets worth remembering later in the story.',
    ITEM_SHAPE,
    'Never repeat a memory from earlier messages. Answer [] when the most recent message adds nothing worth remembering.',
].join(' ');

const CATCH_UP_INSTRUCTIONS = [
    'Memories from the chat messages given: events, facts, relationship changes and secrets worth remembering later in the story.',
    ITEM_SHAPE,
    'Also give "message_index": the [#number] of the message the memory comes from.',
    'Never repeat a memory listed under "Already remembered". Answer [] when the messages hold nothing worth remembering.',
].join(' ');

// The variable definition (without namespace/presetName/name) for
// `mode` 'live' or 'catch-up'.
export function memoryVariableDef(mode) {
    return {
        label: 'Memories',
        description: 'New memories for Archivist to store. Cleared by Archivist after each run.',
        type: 'array',
        itemType: 'record',
        itemSchema: { text: { type: 'string' } },
        defaultValue: [],
        scope: 'chat',
        showInTracker: false,
        behaviors: { prompted: true, increment: false },
        prompted: { instructions: mode === 'catch-up' ? CATCH_UP_INSTRUCTIONS : LIVE_INSTRUCTIONS },
    };
}
