# Architecture

How Archivist is put together. The first half is Archivist's own design -
storage, indexes, extraction, the UI. The second half ("Reaching the State
Engine API" onwards) is the State Engine integration it inherits from the
extension template: the dependency check, namespace, registration and
capabilities every State Engine extension sets up first.

## Module map

```
src/index.js                  entry point (manifest "js"); calls initExtension()
src/extension.js              startup order - see "Extension lifecycle"
src/constants.js              EXTENSION_ID, NAMESPACE ("archivist"), LOG_PREFIX
src/settings.js               extensionSettings.archivist: switches + the chat registry

src/memory/                   the memory core - no State Engine calls
  schema.js                   the Memory Record (spec section 2): build, validate, normalize
  storage.js                  memories.json files: read, queued read-modify-write, delete
  registry.js                 chat registry: which chat owns which file
  indexes.js                  memoryByEntity / memoryBySubtype (spec section 4)
  archivist.js                open chat's records + indexes; add, delete, move; the 3 query APIs
  chat-lifecycle.js           follows renamed chats; keeps deleted chats' memory
  message-sync-plan.js        matching memories to messages (by send_date)
  message-sync.js             follows regenerated, swiped, edited, deleted messages
  message-fingerprints.js     each message's text when last extracted (edits)
  chat-existence.js           which registered chats still exist (for the browser)

src/extraction/               State Engine produces memories; Archivist stores them
  memory-variable.js          the prompted record-list variable and its instructions
  converter.js                model output -> memory record fields (entity names -> ids)
  messages.js                 source_message_id for a chat message
  live.js                     the live preset, harvesting, enable switch, self-repair
  catch-up-plan.js            which messages a catch-up pass reads, chunks, context text
  catch-up.js                 the catch-up preset and the background pass

src/compiler/                 compiled memory: profiles and insights, scene, session,
                              relationships, threads and quests, the world, timeline
  compiled-schema.js          classifications, colour tags, polarity/intensity/status scales
  compile-plan.js             run contexts, parsing the answers, the view (with message links)
  schedule.js                 when to compile on its own
  compiler.js                 the two compiler presets, batched runs, storage, scheduling
  dossier.js                  from an object to everything known about it

src/context/                  Archivist's knowledge as prompt text, for Curator
  prompt-context.js           the blocks, built from the compiled view (plain functions)
  prompt-sync.js              keeps the open chat's block variables current
src/ui/                       the drawer, the memory browser, confirmations
src/public-api.js             what other extensions use (docs/api.md)
src/api/                      thin State Engine wrappers (see "Reaching the State Engine API")
```

## Memory storage

The spec asks for `/data/chats/<chat_id>/memories.json`. A browser extension
can't write there, so each chat's "memories.json" is a real file in the
user's data folder, written through SillyTavern's own file API
(`src/memory/storage.js` is the only code that touches it):

| Operation | Request                                                          |
|-----------|------------------------------------------------------------------|
| write     | `POST /api/files/upload { name, data: base64 }` -> `user/files/<name>` |
| read      | `GET /user/files/<name>` (no cache)                              |
| delete    | `POST /api/files/delete { path: "user/files/<name>" }`           |

Each file is a JSON array of memory records. Safety rules:

- **One change per file at a time.** Every read-modify-write goes through
  `updateMemoryFile()`, which queues changes per file and runs them in call
  order - two writers appending at once (live extraction and, later,
  catch-up) both keep their records.
- **A damaged file is never overwritten.** If a file exists but isn't a
  JSON array, the update fails and the file is left alone.
- Archivist is the only writer (spec section 3). Records are only ever
  appended, except when the user deletes them in the memory browser.

## The chat registry

A SillyTavern chat id is only the chat's file name, and two characters can
each have a chat with the same name. So Archivist identifies a chat by a
**chat key** - the owner plus the chat id, the same distinction State
Engine's own chat state records:

```
char:<character avatar>:<chat id>    a solo chat
group:<group id>:<chat id>           a group chat
```

`settings.chats[chatKey]` holds `{ chatId, characterAvatar, groupId,
displayName, fileName, recordCount, updatedAt }`. It is what lets the memory
browser list chats that are not open - or no longer exist - and what maps a
chat to its file. The file name is `archivist-memories-<slug>-<hash>.json`
(SillyTavern accepts only `[a-zA-Z0-9_.-]`); the registry, not the name, is
the source of truth.

## Indexes and the query APIs

`src/memory/archivist.js` keeps the **open chat's** records in memory and
builds both indexes from them (`buildIndexes()`, always in full): at
startup, on every chat change, after records are added, after the user
deletes some. `getMemoriesForEntity()` and `getMemoriesBySubtype()` read the
indexes, so they are synchronous and answer for the open chat;
`getAllMemories(chatId)` can read any chat's file, so it is async. All three
hand out copies. See [api.md](api.md).

## Live extraction

`src/extraction/live.js`. Archivist owns a regular State Engine preset,
**Archivist Recent Memory Collection** (`triggers: ['ai']`, hidden from the
tracker), with one variable, `archivist__memories`: a prompted list of
records (`itemType: 'record'`). While Archivist is enabled the preset is
active for the open chat, so State Engine fills the variable during its
ordinary per-message update - no extra model call.

1. State Engine writes the model's answer and emits
   `state_engine_variables_changed`.
2. `harvest()` reads the variable and **clears it at once** (so an
   overlapping event finds nothing to store twice), converts the items
   (`converter.js`) and stores them with `addMemoryRecords()`, attributed
   to the newest AI message. If storing fails, the items are kept and
   retried with the next harvest. Each harvest that received memories is
   reported - `getLastHarvest()`, the drawer's *Last update* line and an
   `[Archivist]` console line - so a user can see whether memories arrive
   and why they weren't stored.
3. The indexes are rebuilt and `archivist_memories_changed` is emitted.

Each item also names who was **present** (resolved to `witness_ids`, like
`entities`), its prioritization **tags** (important / trivial / contextual /
emotional) and its emotional **tone**. The converter records each resolved
id's object type in `entity_types`, so a memory says what kind of object it
links to.

Three details of the variable (`memory-variable.js`):

- It is **NEW EACH TURN** (State Engine's `prompted.newEachTurn`). Archivist
  empties it after every run; shown with that empty current value under
  State Engine's "repeat the current value if nothing changed" rule, the
  model kept answering `[]`. NEW EACH TURN shows no current value and asks
  for a fresh answer every turn.
- The instructions spell out the item shape, and set a low bar for what
  counts: small concrete details are stored as `low` importance rather than
  skipped, and `[]` is only for a message where nothing happens.
- Its `itemSchema` requires only `text`. State Engine drops an item missing
  any schema field; Archivist's converter defaults or fixes the rest, so a
  memory isn't lost because the model left out its importance.

Entity names in an item are looked up with State Engine's
`getObjectByAlias` across every object type; a name that matches nothing is
left out - Archivist never creates objects.

The variable is only rewritten when `LIVE_VARIABLE_VERSION` goes up, so a
user's own edits to its instructions survive reloads - until an Archivist
update raises the version, which replaces them once.

State Engine's own *Max response length* (default 300; or its connection
profile's *Max tokens*) caps the whole update response, memory included: a
memory adds 50-110 tokens. So the live variable asks for at most 4 memories,
lets the model leave out present / tags / tone when they add nothing, and is
ANSWER LAST (`prompted.answerLast`): asked after the user's own variables.
State Engine keeps every value an answer finished before being cut off, so
a cut-off answer loses memories rather than the rest of the update. The
drawer warns while the limit is under 1000; around 1000-1200 leaves room.

### Self-repair

The user can deactivate or delete Archivist's preset in State Engine's
manager - State Engine warns while Archivist runs, but allows it. While
Archivist is enabled, each chat change recreates whatever is missing and
re-activates the preset; the drawer's **Repair** does the same at once.
Event listeners are registered before the preset is set up, so a failure
at startup can be repaired without a reload. Stored memory is never at
risk: it lives in Archivist's files, not in State Engine variables.

## Catch-up

`src/extraction/catch-up.js` (spec sections 5 and 6). An **independent**
State Engine preset, **Archivist History Catch-Up**, with its own variable
`archivist__catchup_memories` (variable names are unique across presets) -
kept apart from live extraction so both run at once.

A pass, for the chat open when it starts:

1. **Snapshot** the chat's messages. **Plan** (`catch-up-plan.js`) which to
   send: not hidden ones, not ones some stored memory came from (matched by
   index *and* send date), not a user message whose reply is covered (live
   extraction attributes a turn's memories to the reply), and not ones at or
   before the chat's resume point (`entry.catchUp = { index, sendDate }`,
   trusted only while that message is unchanged). Chunk them by
   `settings.chunkSize`.
2. **Configure** the preset each pass: `connectionProfileId` (the user's
   pick - `''` is State Engine's own), `maxTokens` (`catchUpMaxTokens`), and
   its own system header - State Engine's talks about a "most recent
   roleplay message" a history chunk doesn't have.
3. **Per chunk:** set the preset's context to an *Already remembered* list
   (the newest medium/high memories from before the chunk, within 1500
   characters) followed by the messages, each as `[#index] Name: text`;
   `runIndependentPreset()`; read and clear the variable; convert - each item
   attributed to the `message_index` it names, else the chunk's last reply -
   and `addMemoryRecords()`. While every chunk so far has succeeded, move the
   resume point to the chunk's last message.
4. State Engine queues each run behind whatever else is using the same
   connection (its main update, the compiler) and resolves when it has
   run - Archivist never waits or retries on its own. A chunk that fails is
   counted and reported; the pass carries on and the resume point stays
   before it, so the next pass retries it.

Progress (`getCatchUpProgress()`, `onCatchUpProgress()`) drives the drawer.
Cancel stops between chunks. A pass keeps writing to the chat it started on
if the user switches chats; only one pass runs at a time.

## Memories follow their messages

A memory's `source_message_id` is `<chatId>#<index>@<send_date>`.
SillyTavern sets `send_date` when a message or a swipe is written (an ISO
timestamp to the millisecond) and keeps each swipe's in `swipe_info[]`, so
`send_date` identifies one message and swipe; the index is only where it
sits now. Nothing is written into the chat.

`src/memory/message-sync.js` re-matches the open chat's memories on
`MESSAGE_DELETED`, `MESSAGE_SWIPED`, `MESSAGE_SWIPE_DELETED`,
`MESSAGE_RECEIVED`, `MESSAGE_UPDATED` and `CHAT_CHANGED`
(`planMessageSync()` in `message-sync-plan.js`):

- its `send_date` is a message's current one -> shown, index corrected if
  messages before it moved;
- it is an inactive swipe's -> **hidden**: kept on disk, left out of the
  indexes and the open chat's API answers (`state.hidden` in the core);
  swiping back shows it again;
- it is nowhere -> **removed** (regenerated - SillyTavern deletes the reply
  first - deleted, or its swipe deleted).

`MESSAGE_EDITED` removes the edited message's memories and, while Archivist
is enabled, re-extracts that one message through the catch-up preset
(`reextractMessage()`). SillyTavern reports every confirmed edit, changed or
not, so a fingerprint of each message's text at extraction
(`message-fingerprints.js`, this session only) skips edits that changed
nothing. Changes are applied to the open chat only, one at a time, after its
memory has loaded; an empty chat array while memories exist is treated as
"not loaded yet", never as "everything was deleted". A memory with no
`send_date` to go by (`Chat#unknown`) is left alone.

The catch-up preset's runs - a pass's chunks and an edit's re-extraction -
go through one queue, as they share the preset's context.

## The compiler

`src/compiler/`. Raw memories -> structured, deduplicated knowledge,
through two **independent** State Engine presets sharing the compiler's
connection, max tokens and header style. Each answers in NEW EACH TURN
record lists, read and cleared after each run:

| Preset                        | Lists                                                        |
|-------------------------------|--------------------------------------------------------------|
| **Archivist Memory Compiler** | `compiled_facts`, `compiled_relationships`, `compiled_characters`, `compiled_tension` |
| **Archivist World Compiler**  | `compiled_threads`, `compiled_world`                         |

Two presets, so each prompt shows only the lists its part updates and each
answer (a complete list every time) stays a manageable size. Each batch
runs the memory part, then the world part; both are queued by State Engine
on the connection like any other run. *Also compile story threads, quests
and the world* (`settings.compileWorld`) turns the second part off.

| Code (deterministic)                            | The model (a compile run)                         |
|-------------------------------------------------|---------------------------------------------------|
| grouping by entity / classification             | merging similar facts, canonical statements      |
| the timeline (event memories, message order)    | themes, classification of merged facts           |
| colour tags, the relationship map               | relationships: type (free text), polarity -3..3, intensity, trend |
| witnesses, major events, recent tone            | character insights: traits, habits, stressors, motivations, arc |
| scheduling (`schedule.js`)                      | contradictions                                   |
| linking names to objects (and their types)      | threads and quests (status, progress), world entries by kind |

Polarity is a whole number from -3 (hostile) to 3 (devoted) with a word
per step, and intensity low / medium / high: models keep to a few named
steps far better than to a fine-grained number. Relationship *type* is the
model's own words, never a fixed list. An empty answer for a list that had
items is taken as the model leaving it out, and the previous list is kept
(facts keep their stricter rule, below).

**Linking.** Every compiled entity is `{ id, name, type }`: a name that
matches a State Engine object (by name or alias, any object type) gets its
id and object type. A thread whose title names an object - a quest - is
linked to it; so is a world entry naming a location, faction or item.
`dossier.js` goes the other way: `getEntityDossier()` gathers an object's
profile, relationships, threads and quests, world entries, secrets it
knows, and the memories about it or witnessed by it.

**Incremental.** A compiled state - `{ facts, relationships, characters,
threads, world, included: [memory ids], compiledAt, schema }`, one JSON file
per chat
(`archivist-compiled-...json`, next to the memories) - is updated by handing
the model the current facts (`[f3] PERMANENT · employment · about Lucian:
...`) and relationships plus only the memories not `included` yet (`[m1]`,
local refs), in batches of 20 (`COMPILE_BATCH`), and taking back the complete updated lists.
`parseCompileOutput()` keeps a continued fact's id and earlier sources, maps
refs back to memory ids, resolves entity names to State Engine object ids,
and refuses an answer that would drop every fact (the previous state is
kept). Rebuild starts from an empty state. The state is saved after every
batch. A run that fails stops there - never retried on its own; a toast
says so and offers a retry on a click (`src/ui/compile-retry.js`), a plain
compile that goes on from the last saved batch, even after a Rebuild.

A state compiled before the world compiler (no `schema`, read as 1) still
works; its view is flagged `outdated` - a Rebuild fills in insights, threads
and the world for every memory, not just the new ones.

**The view** (`buildCompiledView()`, what `getCompiledMemory()` returns) is
built against the chat's memories as they are now: facts resting only on
gone memories (deleted, another swipe) drop out, contradictions are red on
both sides, and every fact and relationship carries its message links -
`source_messages` and `message_range`, from its source memories'
`source_message_id`s, whose indexes message-sync keeps current.

**Scheduling** (`maybeCompile()`, after memory changes - debounced - and
every minute): only while Archivist is enabled and *Compile automatically*
is on; never with no new memories; never within `compileMinGapMinutes` of
the last compile; at `compileThreshold` new memories (near-repeats - 80%
word overlap - don't count), or after `compileIntervalMinutes` with at least
one. Removed memories don't trigger a compile: the view already accounts for
them.

## Renamed and deleted chats

`src/memory/chat-lifecycle.js` follows SillyTavern's events:

- `CHAT_RENAMED` (`{ avatarId, groupId, oldFileName, newFileName }`, names
  with `.jsonl`): `moveChatMemories()` moves the registry entry to the new
  chat key and rewrites `chat_id` in the records; the file keeps its name.
  If the new name already has memories of its own, nothing moves.
- `CHAT_DELETED` / `GROUP_CHAT_DELETED`: nothing is deleted - a notice says
  the memories were kept. The memory browser marks the chat missing
  (`chat-existence.js`: the character or group is gone, or
  `POST /api/characters/chats` / `group.chats` no longer lists it), and the
  user decides.

## Prompt context for Curator

`src/context/`. Curator injects State Engine variables that an extension
offers with a `curator.inject:<variable>` capability (Curator's
docs/injection-blocks.md). Archivist declares one for each block in
`CONTEXT_BLOCKS` (story so far, current scene, characters and relationships
in the scene, open threads and quests, recent events, secrets) and keeps
them as plain, non-prompted text variables in the live preset - so they
have values while Archivist is enabled for the chat, and the model is never
asked for them.

`buildPromptContext()` builds the texts from the compiled view, focused on
who is in play: the characters State Engine marks present (else those the
newest scene memories name) and the user's persona, matched by id or name
words (`entity-link.js` `nameKey`). Threads are filtered the same way: an
active thread is always given, an open one (a plot hook, a quest seed) only
when a character in the scene is involved in it or one of its plan steps;
a plan shows its goal, the step it is on and the next. `syncPromptContext()` rebuilds them,
debounced, after memories change, after a compile, on a chat change and on
State Engine's variables-changed event, and writes only the blocks whose
text changed - so its own writes, which State Engine announces as a change
too, settle at once.

The memory part of the compiler also answers two text variables,
`compiled_story_summary` and `compiled_scene_summary`, stored as
`compiled.summary` (`parseSummary()`: a new answer replaces, an empty one
keeps; `sceneAt` records the newest message the scene summary was written
from). The view's Scene adds `scene_recent` - the scene-scope memories of
the newest `SCENE_WINDOW` messages, from the memories themselves, since the
model rarely classes a fact SCENE.

Story tension: the memory part also answers `compiled_tension`, one reading
of the story's tension at the batch's newest memories - threat,
uncertainty and emotional, each 0..5, and a reason. `parseTension()` adds it
to `compiled.tension` with its overall (the average of the three) and the
batch's newest message and memory; a reading at the same message as the
last one replaces it. The model sees the last `TENSION_CONTEXT` readings,
so it keeps to one scale. The series is one point per compile batch - a
graph of the story's tension (the memory browser draws one), and something
pacing can read later. A Rebuild starts the series over, one point per
`COMPILE_BATCH` memories, so a rebuilt series is coarser than a live one.

The Current scene block is about NOW: who is present, the scene summary only
while it was written from the newest `SCENE_WINDOW` messages, SCENE facts
only from those messages (the compiler keeps old ones around), and the last
few scene memories. A summary or fact from a scene long over is left out.

**Left-out items are kept.** Each compile answer is the complete list, and a
model drops items from a long list by accident - so `carriedForward()` keeps
every relationship, character, thread and world entry the answer leaves out,
and a thread or world entry answered under a new id with the same words as a
current one continues it (`matchByWords()`). Only facts are dropped by the
model. The user removes the rest: `removeCompiledItem()` records each deleted
item in `compiled.dismissed` (by its words, not its id - a Rebuild gives new
ids), the parsers leave out anything matching, and the context lists them
under "Removed by the user". A Rebuild keeps `dismissed`.

## The UI

- **Drawer** (`settings.html`, `src/ui/settings-drawer.js`) - the enable
  switch, status, Repair, the open chat's newest memories.
- **Memory browser** (`src/ui/memory-browser.js`) - all chats, search,
  filters (tag, and who it is about or who was present), deletion. Its
  Compiled view shows the compiler's status line - running, done, or why
  it failed - with Compile now and Rebuild, then characters, scene,
  session, the relationship map and list, threads and quests, the world by
  kind, and the timeline (major events, witnesses, tone). Deleting there (`deleteMemoryRecords()`,
  `deleteChatMemories()`) is the only way a stored memory is ever removed.
  Every compiled item has edit and delete buttons (`src/ui/compiled-edit.js`,
  compiler.js `editCompiledMemoryItem()` / `deleteCompiledMemoryItem()` /
  `editCompiledMemorySummary()`, refused while that chat is compiling - the
  run would write over the change).

What each shows is computed by plain functions (`drawer-model.js`,
`memory-browser-model.js`); memory text always goes on the page as text,
never markup. Confirmations use SillyTavern's own popup (`confirm.js`).

## Reaching the State Engine API

The State Engine extension does not expose a global like
`window.stateEngine` the way it does for its World Info surface
(`window.StateEngineWI`). The only way to reach `stateEngine.*` today is
an ES module import of its `src/api/index.js` (and, for the identity
helper `ensureInstanceId()`, its `src/api/identity.js` directly - that
one function is deliberately not part of the `stateEngine` object).
Archivist imports both with a relative path that assumes the State
Engine extension is installed as a SIBLING folder to this one:

```
public/scripts/extensions/third-party/
  SillyTavern-StateEngine/            <- the State Engine extension
  SillyTavern-StateEngine-Archivist/  <- this one
```

If your install has the State Engine extension under a different folder
name, update the two `const ..._PATH` lines repeated at the top of
`src/api/namespace.js`, `registration.js`, and `capabilities.js` (they
each import the same two things, from the same relative path,
independently - see "Why the path is repeated three times", below) -
there's nowhere else in Archivist this assumption is baked in.

Each of those three files imports its two paths with a DYNAMIC
`import()` INSIDE its exported function, not a static `import ... from`
at the top of the file. This is deliberate, not a style choice: a
static import is resolved when the module graph loads - before
`src/api/dependency-check.js` (below) ever gets a chance to run its own
check - so if the path doesn't resolve (State Engine genuinely not
installed), a static import would crash the whole extension outright. A
dynamic import only runs, and only fails, at the moment
`claimNamespace()`/`registerWithStateEngine()`/`declareCapabilities()`
is actually called - which `src/extension.js` only does after
confirming State Engine is present.

### Why the path is repeated three times

Each `src/api/*.js` file wraps exactly one call, independently, by
design (see "Extension lifecycle", below) - so the two path constants
are copied into each file rather than pulled from one shared module.
This keeps every file individually readable ("this file does one thing,
here's everything it needs to do it") at the cost of three places to
edit if you ever rename your State Engine install folder. If that
trade-off doesn't suit your extension once it grows, factoring the two
constants into their own small module is a reasonable, purely
structural change - it wouldn't alter any behavior described here.

Archivist does exactly that for everything it added: the template's three
wrappers keep their own paths, but `src/api/presets.js`, `variables.js` and
`objects.js` all load State Engine through one shared module,
`src/api/state-engine.js` - so an install with a differently named State
Engine folder needs those four files' paths adjusted.

## Extension lifecycle

1. **SillyTavern loads `manifest.json`**, reads `js` (`"src/index.js"`),
   and fetches that file as an ES module. SillyTavern does not call any
   particular exported function from it - loading the file is the only
   contract.
2. **`src/index.js` runs.** It calls `jQuery(() => { void initExtension(); })`
   - the same "wait for the page to be ready, then self-start"
     convention every SillyTavern extension uses, since nothing else is
     going to call your extension's init for you. Not awaited - nothing
     downstream needs this extension's own startup to block the rest of
     the page.
3. **`initExtension()` (`src/extension.js`) checks the State Engine
   dependency FIRST**, before anything else - see "Dependency checking",
   below. If it's missing, this is where the lifecycle ends: one popup,
   one warning logged, and `initExtension()` returns. Nothing past this
   point ever runs.
4. **Only if the check passes**, `initExtension()` runs the three real
   calls, in order:
   - `claimNamespace()` - see "Namespaces", below.
   - `registerWithStateEngine()` - see "Registration", below.
   - `declareCapabilities()` - see "Capabilities", below.
5. **Then Archivist's own startup**, each step logged rather than shown as
   the missing-dependency popup if it fails:
   - the memory core: settings, chat-change and chat-lifecycle listeners,
     the open chat's memory, `window.StateEngineArchivist`;
   - live extraction: its listeners, then its preset (a failure here shows
     in the drawer, with Repair);
   - the drawer.
6. **Every later page load repeats steps 3-5.** There is no "first run
   only" special case anywhere in Archivist - `createNamespace()` is
   idempotent for the same extension re-claiming the same namespace, and
   `registerExtension()`/`declareCapabilities()` simply replace the
   previous declaration with an identical one. Your extension's own
   later code (once you add some) can rely on the namespace already
   being claimed by the time anything else in your extension runs,
   without needing its own "is this the first load?" check - as long as
   it also only runs after the dependency check has passed (which
   anything called from inside `initExtension()`, after that check,
   automatically satisfies).

There is no shutdown/teardown lifecycle to hook into - a SillyTavern
extension's code just stops running when the page unloads.

## Dependency checking

Archivist automatically verifies that
the State Engine extension is actually present before doing anything
else - `src/api/dependency-check.js`, called first thing inside
`initExtension()`. Three failure modes are treated as one: not
installed, not enabled, or its API not reachable all produce the exact
same result (one popup, initialization aborted) - the check doesn't try
to tell them apart, since the useful action for a user is identical in
all three cases ("go install/enable it").

- **The signal**: `window.StateEngineWI`, a global the State Engine
  extension sets for ITSELF once its own startup sequence finishes -
  which only happens if SillyTavern actually loaded and ran it as an
  enabled extension. No file path is probed or hardcoded to detect
  this - it's a runtime check, not an import.
- **The race**: this extension's own script might run before State
  Engine's asynchronous startup has finished, even if State Engine is
  perfectly healthy. Rather than guessing with an arbitrary delay, the
  check waits - at most once - for SillyTavern's own `APP_READY` event
  (the same signal State Engine's own `initialization-engine.js` waits
  for internally), then re-checks the same signal exactly one more
  time. If `APP_READY` already fired before this ran, or there's no
  event bus to wait on, it doesn't hang - it resolves immediately and
  moves on to the one re-check. This is a single bounded wait, never a
  retry loop.
- **The third failure mode** ("its API cannot be reached") is caught by
  wrapping the three real calls in `initExtension()`'s own try/catch:
  even if `window.StateEngineWI` was present, an unexpected failure
  calling `claimNamespace()`/etc. (a version mismatch, a broken install)
  triggers the exact same popup rather than an uncaught error.
- **The popup**: plain language, shown through SillyTavern's own Popup
  UI when available, falling back to a guaranteed `window.alert()`
  otherwise - see the "must not crash" reasoning in
  `dependency-check.js`'s own comments. A module-level flag ensures it
  is shown AT MOST once per page load, no matter how many times
  something calls `warnStateEngineMissing()`.

You do not need to repeat this check anywhere else in your own code -
anything you add inside (or called from) `initExtension()`, after the
three State Engine calls, only ever runs once the dependency is already
confirmed present.

## Namespaces

A namespace is the prefix every variable and preset your extension
creates through the State Engine carries - `archivist__memories`, not
`memories`. It exists so two different extensions (or the same extension
loaded twice by mistake) can never collide on a variable name.

- **Claiming** (`stateEngine.createNamespace(extensionId, instanceId,
  namespace)`, wrapped by `src/api/namespace.js`) is a one-time
  registration of "this extension id owns this namespace" - it creates
  no variables or presets itself. An extension owns at most one
  namespace; claiming a second one for the same `extensionId` throws.
- **Identity**: every write this API accepts is checked against
  `(extensionId, instanceId)` - `instanceId` is a per-browser-tab token
  (`ensureInstanceId()`) that stops one extension from acting through
  another's identity by accident. It is not a security boundary against
  genuinely hostile code in the same page, only a mistake-catcher.
- Once claimed, every `stateEngine.createVariable`/`createPreset`/etc.
  call names the namespace it targets (`def.namespace`, or a
  `{ namespace, presetName, ... }` ref), and every WRITE is refused
  unless that namespace is the one your `extensionId` owns.
- **Reads are wider than writes.** Calls that only read or display state
  - `listAllVariables`, `getVariableValue(s)`, `getVariableImage`,
  `listRoles`/`resolveRoles`, the character reads, the datetime
  formatters - accept any registered extension and span EVERY
  namespace, including the user's own `se` one, and return copies. So
  do a few chat-level actions that change no definition:
  `activatePreset`/`deactivatePreset`, `assignRole`, `requestRoles`. In
  short: anything that edits a definition is owner-only; anything that
  shows or binds state is open to registered callers - which is why
  every extension should claim a namespace even if it never creates a
  variable.

## Registration

`stateEngine.registerExtension(extensionId, instanceId, metadata)`
(wrapped by `src/api/registration.js`) is pure discovery metadata -
`{ namespace, variables?, capabilities?, dependsOn?, description? }` -
so another extension can find out your extension exists and what it
claims to provide, via `stateEngine.getRegisteredExtensions()` or
`getExtensionRegistration(extensionId)`. It creates nothing: no preset,
no variable, no capability graph edge. Registering is *optional* in the
sense that nothing breaks if you skip it, but it's what makes your
extension discoverable, so Archivist does it unconditionally.

A call to `registerExtension()` REPLACES any previous registration for
your `extensionId` - it does not merge field-by-field with what you
registered on an earlier load. If you later add real variables, list
their fully-qualified names (`archivist__memories`, not `memories`) in
`metadata.variables` so other extensions can see what you expose.

## Capabilities

`stateEngine.declareCapabilities(extensionId, instanceId, capabilities)`
(wrapped by `src/api/capabilities.js`) is a second, narrower discovery
layer: plain strings like `"ui.panel"` or `"data.inventory"` describing
what your extension PROVIDES, separate from registration's broader
metadata. Another extension can look up who provides a capability via
`stateEngine.getExtensionsProviding(capability)`, and declare its own
dependency on one via `stateEngine.declareDependencies(...)` - see
[how-to-extend.md](how-to-extend.md), "Declaring dependencies".

Nothing validates that a declared dependency's provider actually
exists or is installed - the capability graph is advisory, not
enforced. A capability string means whatever the extensions using it
agree it means; there is no central registry of valid capability names.
