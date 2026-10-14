# Archivist API (for other extensions)

Archivist stores the memory records State Engine extracts from each chat
and offers them to other extensions - Scenario Builder, Pretty Panels, or
your own - through read-only query APIs. Nothing outside Archivist
writes memory: there is no API for adding, changing or deleting records.

## Reaching it

Two ways, the same functions either way:

```js
// 1. The global, set once Archivist has started. Its presence is also the
//    signal that Archivist is installed, enabled and ready.
const archivist = window.StateEngineArchivist;
if (!archivist) {
    // Archivist isn't installed or hasn't started - carry on without memory.
}

// 2. An ES module import (adjust the path to where your extension sits -
//    SillyTavern installs extensions as sibling folders).
import { getMemoriesForEntity, getMemoriesBySubtype, getAllMemories, MEMORIES_CHANGED_EVENT }
    from '../../SillyTavern-StateEngine-Archivist/src/public-api.js';
```

Prefer the global: an import fails outright when Archivist isn't
installed, and it can run before Archivist has loaded the open chat.

Archivist also declares the State Engine capabilities `memory.store` and
`memory.query`, so an extension can find it without knowing its id:

```js
stateEngine.getExtensionsProviding('memory.query'); // ['SillyTavern-StateEngine-Archivist'] when installed
```

## The memory record

Every function returns an array of these (spec section 2 - fixed for the
MVP):

| Field               | Type       | Meaning                                                        |
|---------------------|------------|----------------------------------------------------------------|
| `id`                | string     | Unique memory id, `mem_...`                                    |
| `subtype`           | string     | `event`, `fact`, `relationship`, `secret` - or another single word the model chose |
| `scope`             | string     | `scene` (this scene only), `session` (this part of the story), `long_term` (from now on) |
| `text`              | string     | The memory, as one self-contained sentence                     |
| `entity_ids`        | string[]   | Ids of the State Engine objects it is about (`chr_...`, `loc_...`) - only objects State Engine knows |
| `source_message_id` | string     | The chat message - and swipe - it came from: `<chatId>#<message index>@<send_date>` (SillyTavern's `send_date` identifies one message and swipe; the index is kept current as messages are deleted) |
| `chat_id`           | string     | The SillyTavern chat it belongs to                             |
| `created_at`        | string     | ISO timestamp of when Archivist stored it                      |
| `importance`        | string     | `low`, `medium` or `high`                                      |
| `witness_ids`       | string[]   | Ids of the characters present - who saw or heard it (for a secret, who knows it) |
| `tags`              | string[]   | Any of `important`, `trivial`, `contextual`, `emotional` - for prioritizing |
| `tone`              | string     | Its emotional tone, a word or two (`tense`, `warm`...), `''` if none |
| `entity_types`      | object     | `{ object id: object type }` for every id in `entity_ids` and `witness_ids` (`character`, `location`, `quest`...) |

The last four were added in October 2026: records stored before have none
of them, so read them with `?? []`, `?? ''` and `?? {}`.

**When the message was written** is not a field of its own - it is the
`send_date` at the end of `source_message_id` (real time, not the story's
own clock). The compiled view hands it out as `message_date` on timeline
entries and `source_messages`.

Every record handed out is a **copy** - changing it changes nothing in
Archivist.

Memories follow their messages: a regenerated, deleted or edited message's
memories are removed or replaced, and for the **open chat** the APIs leave
out memories of swipes that aren't the one shown (they come back when the
user swipes back). So what you read always matches the story as it stands.
`getAllMemories()` for a chat that is not open returns everything stored,
including other swipes'.

## The three APIs

### `getMemoriesForEntity(entity_id)` -> `memory_record[]`

Every memory in the **open chat** that names this State Engine object,
in stored order (oldest first). Synchronous. `[]` for an unknown id, or
when no chat is open.

```js
const aboutMira = archivist.getMemoriesForEntity('chr_mira');
```

### `getMemoriesBySubtype(subtype)` -> `memory_record[]`

Every memory in the **open chat** with this subtype, in stored order.
Synchronous. `[]` when there are none.

```js
const secrets = archivist.getMemoriesBySubtype('secret');
```

### `getAllMemories(chat_id?)` -> `Promise<memory_record[]>`

Every memory stored for a chat, in stored order. **Async**, because it can
read any chat, not just the open one.

- No argument: the open chat (waits for it to finish loading after a chat
  switch).
- A SillyTavern chat id: that chat. Chat ids are file names, so two
  characters can each have a chat with the same id - then the open chat
  wins, then the one updated most recently.
- `[]` for a chat with no memories, or one whose memory file can't be read.

```js
const everything = await archivist.getAllMemories();
const thatChat = await archivist.getAllMemories('Mira - 2026-10-11@13h05m22s');
```

Why only the open chat for the first two: the indexes behind them
(`memoryByEntity`, `memoryBySubtype`) are built for the open chat only, so
those two can answer instantly. For another chat, filter
`getAllMemories(chatId)` yourself.

### `getCompiledMemory(chat_id?)` -> `Promise<compiled | null>`

The chat's **compiled** memory (the Archivist Compiler - see the user
guide): `null` when it was never compiled. `chat_id` works as for
`getAllMemories()`; omitted, the open chat.

```js
{
  compiledAt,                  // ISO time of the last compile
  pending,                     // memories stored since, not compiled in yet
  outdated,                    // true: compiled before insights, threads and the world
                               // existed - a Rebuild fills them in for the whole chat
  story_summary, scene_summary,  // the compiler's two summaries ('' until written)
  scene_summary_at,            // the newest message index the scene summary saw (null: unknown)
  newest_message_index,        // the newest message any memory comes from (null: none)
  character_profiles: [profile],
  scene_state: [fact],         // SCENE facts
  session_details: [fact],     // SESSION facts
  relationships: [relationship],
  relationship_map: {          // a grid: who feels what toward whom
    entities: [entity],
    cells: [{ from, to, polarity, polarity_label, type, intensity, trend }],
  },
  threads: [thread],           // plot hooks, unresolved threads, quest seeds; open first
  quests: [thread],            // the threads that are quests (linked to a quest object, or kind "quest")
  world: { secret: [entry], location: [entry], faction: [entry], item: [entry],
           event: [entry], lore: [entry] },
  timeline: [{ memory_id, text, entity_ids, witnesses: [{ id, name }], major, tags, tone,
               message_index, message_date, source_message_id, chat_id, scope,
               importance, created_at }],                     // event memories, story order
  recent_tone: [{ tone, count }],                             // the newest memories' tones
  alias_suggestions: [{ object_id, object_name, object_type, alias }],
                               // names the story uses for an object that it doesn't have
}

entity = { id | null, name, type | null }   // a State Engine object (type: its object type),
                                            // or a name the story uses that matches none
```

**How names link to objects.** An entity's `name` is the name the model
wrote. It links to an object by State Engine's own name/alias match, or -
failing that - when both come down to the same words (case, punctuation,
brackets, a leading article and word order ignored): "gremlin (lead)" is the
object "A lead gremlin". Links are made at compile time and again on every
`getCompiledMemory()`, so an object approved after the compile is linked
too. A name linked only by that looser match is offered in
`alias_suggestions` (the memory browser's Compiled view has an *Add alias*
button for each).

```js
profile = {
  entity_id, entity_type, name,
  facts: [fact],                            // its PERMANENT facts
  summary,                                  // who they are NOW - what their actions so far show
  traits, habits, stressors, motivations,   // [text] - inferred from the memories
  arc, emotional_state,                     // text
  insights_key,                             // identifies its insights (null without any)
  relationships: [relationship & { direction: 'out' | 'in', other: entity }],
}

fact = {
  id,                          // "f3" - stable across compiles while it is the same fact
  text, theme,                 // "employment", "finances", "transportation"...
  classification,              // "PERMANENT" | "SESSION" | "SCENE"
  entities: [{ id | null, name }],
  contradicts: [fact ids],
  // colour tag (red for a contradiction, otherwise by classification):
  tag: { name, color, hex }, color_tag, color_name, color_hex,
  // where in the chat it comes from:
  chat_id,
  source_memory_ids: [memory ids],
  source_messages: [{ memory_id, message_index, source_message_id }],   // story order
  message_range: { from, to } | null,                                   // message indexes
}

relationship = {                            // one per direction: how "from" sees "to"
  from: entity, to: entity, text,
  type,                                     // the model's own words: friend, mentor, rival, boss...
  polarity,                                 // -3..3: hostile, antagonistic, wary, neutral, friendly, close, devoted
  polarity_label,                           // that word
  intensity,                                // 'low' | 'medium' | 'high'
  trend,                                    // 'warming' | 'cooling' | 'stable' | 'volatile' | ''
  tag, color_tag: 'Purple', color_name: 'Relationship', color_hex,
  chat_id, source_memory_ids, source_messages, message_range,
  item_key,                                 // identifies it (from and to)
}

thread = {
  id,                                       // "t2" - stable across compiles
  kind,                                     // "plot hook", "unresolved thread", "quest seed", "quest"...
  title, text,
  status,                                   // 'open' | 'active' | 'resolved' | 'abandoned'
  progress,                                 // what has happened with it so far
  entity: entity | null,                    // the object its title names - a quest object
  involved: [entity],
  chat_id, source_memory_ids, source_messages, message_range,
}

entry = {                                   // a world entry
  id,                                       // "w5"
  kind,                                     // 'secret' | 'location' | 'faction' | 'item' | 'event' | 'lore'
  name, text,
  entity: entity | null,                    // the object it names (never for a secret)
  known_by: [entity],                       // a secret: who knows it
  involved: [entity],
  status,                                   // a secret: 'kept' | 'revealed' | 'disproven';
                                            // an event: 'ongoing' | 'over'
                                            // (entries are never dropped - their status says
                                            // when they no longer hold)
  chat_id, source_memory_ids, source_messages, message_range,
}
```

Polarity is a small whole-number scale with a word per step, and intensity
three words, on purpose: models keep to named steps far more reliably than
to a fine-grained number.

Colours (`hex` is Archivist's, so every UI matches): Permanent `#4a90d9`
blue, Session `#d4b03c` yellow, Scene `#4caf50` green, Relationship
`#a070e0` purple, Contradiction `#e05555` red.

The view is built against the chat's memories **as they are now**: a fact or
relationship resting only on memories that are gone (deleted, a regenerated
reply, another swipe) is left out, and `message_range` / `source_messages`
always point at the messages' current positions - use them to link a fact
back to that part of the chat (SillyTavern's `/chat-jump <index>`).

## Following changes

After any change to a chat's memory - new memories stored, the user
deleting some in the memory browser, a reply regenerated, swiped or edited,
a chat renamed - Archivist emits
`MEMORIES_CHANGED_EVENT` (`'archivist_memories_changed'`) on SillyTavern's
event bus, with `{ chatId, chatKey }`. Re-read on receipt:

```js
const { eventSource } = SillyTavern.getContext();
eventSource.on(archivist.MEMORIES_CHANGED_EVENT, ({ chatId }) => {
    if (chatId === SillyTavern.getContext().chatId) refreshMyMemoryPanel();
});
```

`chatKey` is Archivist's own id for the chat (character or group plus
chat id); you can pass it to `getAllMemories()` too.

After a compile, `COMPILED_CHANGED_EVENT` (`'archivist_compiled_changed'`),
same payload - re-read `getCompiledMemory()` (and any dossiers).

## Linking objects to memory

Memories and compiled items point at State Engine objects by id (and
`entity_types` / `entity.type` say which kind of object). Two calls go the
other way - from an object to everything Archivist knows about it:

### `getEntityDossier(entity, chat_id?)` -> `Promise<dossier | null>`

`entity` is an object id (`'chr_lucian'`), a name or alias (`'Lucian'`), or
`{ id?, name? }`. `null` when the chat has no memories.

```js
{
  entity,                 // { id | null, name, type | null }
  compiledAt,             // null when never compiled - then only the memories are filled
  profile,                // its character profile (insights, facts) or null
  relationships,          // [relationship & { direction: 'out' | 'in', other }]
  threads, quests,        // the threads it is in (a quest object: its own thread, with status and progress)
  world,                  // world entries it is, is part of, or knows (a secret)
  secrets_known,          // the secrets it knows
  memories,               // memory records about it
  witnessed,              // memory records it was present for
  timeline,               // timeline events it is in or witnessed
}
```

### `getRelationship(from, to, chat_id?)` -> `Promise<{ forward, backward } | null>`

The compiled relationship from one to the other (`forward`) and back
(`backward`), each a `relationship` or `null`. `null` when never compiled.

```js
// A character card: how this character feels about the user's persona.
const { forward } = await archivist.getRelationship(characterId, SillyTavern.getContext().name1) ?? {};
if (forward) showBadge(`${forward.type} · ${forward.polarity_label} · ${forward.intensity}`);
```

## Examples

**Scenario Builder** - what a character remembers, most important first:

```js
const rank = { high: 0, medium: 1, low: 2 };
const memories = archivist.getMemoriesForEntity(characterId)
    .filter((m) => m.scope !== 'scene')
    .sort((a, b) => rank[a.importance] - rank[b.importance]);
```

**Pretty Panels** - a log of the open chat's newest memories that stays
current:

```js
async function showLog() {
    const latest = (await archivist.getAllMemories()).slice(-10).reverse();
    render(latest.map((m) => `${m.subtype}: ${m.text}`));
}
eventSource.on(archivist.MEMORIES_CHANGED_EVENT, () => void showLog());
```

## What Archivist does not do (yet)

No relevance ranking. Raw records are what the model extracted, stored as
they came; the compiled memory is the one interpreted layer (profiles and
insights, relationships, threads and quests, the world, a timeline,
contradictions). Archivist never creates State Engine objects - a place or
quest the story names that has no object stays a name.
