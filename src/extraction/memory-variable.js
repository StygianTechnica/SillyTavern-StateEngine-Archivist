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
// leave out private / tags / tone when they add nothing, and is ANSWER
// LAST (State Engine prompted.answerLast): asked after the other variables,
// so an answer cut off at the limit loses memories, not the user's own
// variables (State Engine keeps every value finished before the cut).
// "present" is always asked for: left optional, the model gave it for under
// 1% of memories, and Scenario Builder's perspective (who knows what) reads
// it. A private inner experience (a dream, vision, thought) is present only
// for the one who had it.

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
    '"present": always - the names of the characters present who saw or heard it (for a secret, only those who know it); it decides who knows what later, so never leave it out when anyone else could have seen it;',
    '"private": true when the memory is the inner experience of one person - a dream, vision, thought, recollection, unspoken feeling, or something they saw or did while alone - and then "present" is ONLY that person, even if others were in the room (all they saw was the outside of it: someone sleeping, someone going quiet);',
    `"tags": any of ${MEMORY_TAGS.map((t) => `"${t}"`).join(', ')} that apply - important (matters for the story going forward), trivial (a passing detail), contextual (background that explains other things), emotional (a feeling or emotional moment);`,
    '"tone": its emotional tone in a word or two, such as tense, warm, playful, somber}.',
    'Leave out "private", "tags" and "tone" when they add nothing.',
].join(' ');

// What to look for - shared by both modes.
const WHAT_COUNTS = 'Record what happened or came to light: events (what someone did, decided or went through), facts (about a person, place or thing), relationship changes, secrets, plans and promises. '
    + 'A PROMISE is any promise, oath, vow, pledge or deal someone makes - marriage vows, a sworn oath, "I will come back for you": record it as a memory of subtype "promise" naming who made it, to whom, and what it binds them to; and record it again, as a "promise" memory, when it is kept, broken or released. '
    + 'A PLAN is a course of action the characters lay out or agree on to reach a goal, even when nobody calls it a plan ("first we find the old map in the archive, then we get the ferryman on our side, then we cross before the storm"): record it as ONE memory of subtype "plan", "high" importance, tagged "important", whose text gives the goal and every step in order ("Plan to cross the river: 1. find the old map in the archive; 2. win over the ferryman, who wants payment; 3. cross before the storm breaks"), with each step\'s conditions or dangers. A plan always counts among the memories that matter most. '
    + 'What happens inside a simulation, a training exercise, a game, a test run, a dream or a story someone tells is not real: say so in the memory text, in its own words ("In the training simulation, Cyril and Inji broke into a mock Novakorp vault") and never record it as if it happened in the world - nothing taken in it is really had, nobody hurt in it is really hurt. Keep saying so for every memory of it, even when the message itself no longer mentions the simulation. '
    + 'Something agreed or refused counts as a promise too - "Adam agreed Cyril will not be sent against Omicron Innovations" - record it as a "promise" memory, so it is not forgotten. '
    + 'Include small concrete details too, as "low" importance - where someone went, what they bought, how they felt about it. Do not record pure description of the surroundings.';

// The player character's feelings are in the user's own messages - what
// they think, hold back, resent - and seldom in the replies, which tend to
// have them smile along. Never asked for, they were never kept: 159
// memories of Galice "caring for" Cyril, none of him wanting her gone, and
// Archivist compiled him her fond student (Assassins Inc).
const PLAYER_FEELINGS = 'The player character - the one the user writes - often keeps their feelings to themselves, and the replies seldom say them: when the user\'s message shows how the player character feels about someone (a thought, a word held back, irritation, liking, wanting them gone), record that feeling as a private memory of subtype "relationship", naming whom it is about ("Cyril is fed up with Galice hovering over him"). What the user writes of their own character\'s feelings outweighs any reply that has them smile along.';

const LIVE_INSTRUCTIONS = [
    `Memories from the most recent roleplay message only - at most ${LIVE_MAX_MEMORIES}, the ones that matter most - and, from the user's message just before it, only the player character's feelings.`,
    WHAT_COUNTS,
    PLAYER_FEELINGS,
    ITEM_SHAPE,
    'Never repeat anything from earlier messages. Answer [] only when nothing at all happens in the most recent message.',
].join(' ');

const CATCH_UP_INSTRUCTIONS = [
    'Memories from the chat messages given.',
    WHAT_COUNTS,
    PLAYER_FEELINGS,
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
