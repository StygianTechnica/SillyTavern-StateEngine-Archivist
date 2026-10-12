# Archivist API (for other extensions)

Archivist stores the memory records State Engine extracts from each chat
and offers them to other extensions - Scenario Builder, Pretty Panels, or
your own - through three read-only query APIs. Nothing outside Archivist
writes memory: there is no API for adding, changing or deleting records.

## Reaching it

Two ways, the same three functions either way:

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
  character_profiles: [{ entity_id, name, facts: [fact] }],   // PERMANENT facts, by entity
  scene_state: [fact],         // SCENE facts
  session_details: [fact],     // SESSION facts
  relationships: [relationship],
  timeline: [{ memory_id, text, entity_ids, message_index, source_message_id,
               chat_id, scope, importance, created_at }],     // event memories, story order
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

relationship = {
  from: { id | null, name }, to: { id | null, name }, type, text,      // type: "trains", "distrusts"...
  tag, color_tag: 'Purple', color_name: 'Relationship', color_hex,
  chat_id, source_memory_ids, source_messages, message_range,
}
```

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
same payload - re-read `getCompiledMemory()`.

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

No relevance ranking, arcs, hooks, mysteries or dangers. Raw records are what
the model extracted, stored as they came; the compiled memory is the one
interpreted layer (profiles, relationships, a timeline, contradictions).
