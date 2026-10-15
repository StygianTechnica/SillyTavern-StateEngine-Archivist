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
//
// It is NEW EACH TURN (State Engine prompted.newEachTurn): Archivist empties
// it after every run, so shown with its current value under State Engine's
// "repeat the current value if nothing changed" rule, the model kept
// answering that empty list. NEW EACH TURN shows no current value and asks
// for a fresh answer every turn.
//
// What counts as a memory is set low on purpose: small models, given an easy
// way out ("[] if nothing is worth remembering"), took it for almost every
// message. Small concrete details are stored as "low" importance instead -
// importance and the memory browser are how they are sorted out later.
//
// The LIVE variable shares one answer - and one token limit (State Engine's
// Max response length) - with every other variable of the per-message
// update. So it asks for at most LIVE_MAX_MEMORIES memories, lets the model
// leave out present / tags / tone when they add nothing, and is ANSWER
// LAST (State Engine prompted.answerLast): asked after the other variables,
// so an answer cut off at the limit loses memories, not the user's own
// variables (State Engine keeps every value finished before the cut).

import { KNOWN_SUBTYPES, MEMORY_TAGS } from '../memory/schema.js';

// The live preset's variable, and the catch-up preset's - State Engine
// variable names are unique across presets, so they differ.
export const MEMORY_VARIABLE = 'memories';
export const CATCH_UP_MEMORY_VARIABLE = 'catchup_memories';

// Memories asked for per message in live extraction.
export const LIVE_MAX_MEMORIES = 4;

const ITEM_SHAPE = [
    'Each item is an object:',
    '{"text": one self-contained sentence stating the memory, naming who and what it is about;',
    `"subtype": one of ${KNOWN_SUBTYPES.join(', ')} (or another single word if none fits);`,
    '"scope": "scene" (matters only for the current scene), "session" (matters for this part of the story) or "long_term" (should be remembered from now on);',
    '"importance": "low", "medium" or "high";',
    '"entities": the names of the characters, places, factions, items, creatures and lore involved, exactly as the story names them;',
    '"present": the names of the characters present who saw or heard it (for a secret, only those who know it);',
    `"tags": any of ${MEMORY_TAGS.map((t) => `"${t}"`).join(', ')} that apply - important (matters for the story going forward), trivial (a passing detail), contextual (background that explains other things), emotional (a feeling or emotional moment);`,
    '"tone": its emotional tone in a word or two, such as tense, warm, playful, somber}.',
    'Leave out "present", "tags" and "tone" when they add nothing.',
].join(' ');

// What to look for - shared by both modes.
const WHAT_COUNTS = 'Record what happened or came to light: events (what someone did, decided or went through), facts (about a person, place or thing), relationship changes, secrets and plans. '
    + 'A PLAN is a course of action the characters lay out or agree on to reach a goal, even when nobody calls it a plan ("first we find the old map in the archive, then we get the ferryman on our side, then we cross before the storm"): record it as ONE memory of subtype "plan", "high" importance, tagged "important", whose text gives the goal and every step in order ("Plan to cross the river: 1. find the old map in the archive; 2. win over the ferryman, who wants payment; 3. cross before the storm breaks"), with each step\'s conditions or dangers. A plan always counts among the memories that matter most. '
    + 'Include small concrete details too, as "low" importance - where someone went, what they bought, how they felt about it. Do not record pure description of the surroundings.';

const LIVE_INSTRUCTIONS = [
    `Memories from the most recent roleplay message only - at most ${LIVE_MAX_MEMORIES}, the ones that matter most.`,
    WHAT_COUNTS,
    ITEM_SHAPE,
    'Never repeat anything from earlier messages. Answer [] only when nothing at all happens in the most recent message.',
].join(' ');

const CATCH_UP_INSTRUCTIONS = [
    'Memories from the chat messages given.',
    WHAT_COUNTS,
    ITEM_SHAPE,
    'Also give "message_index": the [#number] of the message the memory comes from.',
    'Never repeat a memory listed under "Already remembered". Answer [] only when nothing at all happens in the messages.',
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
        prompted: mode === 'catch-up'
            ? { instructions: CATCH_UP_INSTRUCTIONS, newEachTurn: true }
            : { instructions: LIVE_INSTRUCTIONS, newEachTurn: true, answerLast: true },
    };
}
