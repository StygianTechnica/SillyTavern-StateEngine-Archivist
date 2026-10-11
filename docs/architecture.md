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
  chat-existence.js           which registered chats still exist (for the browser)

src/extraction/               State Engine produces memories; Archivist stores them
  memory-variable.js          the prompted record-list variable and its instructions
  converter.js                model output -> memory record fields (entity names -> ids)
  messages.js                 source_message_id for a chat message
  live.js                     the live preset, harvesting, enable switch, self-repair
  catch-up-plan.js            which messages a catch-up pass reads, chunks, context text
  catch-up.js                 the catch-up preset and the background pass

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

State Engine's own max-tokens setting caps the whole update response, memory
included: a few memories add 50-80 tokens each, and a cut-off response loses
the whole update, not just the memories. Around 800-1000 leaves room.

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
4. A run State Engine turns away because another independent preset is
   running (`skipped-in-progress`) is retried every 2 s, up to 30 times. A
   chunk that still fails is counted and reported; the pass carries on and
   the resume point stays before it, so the next pass retries it.

Progress (`getCatchUpProgress()`, `onCatchUpProgress()`) drives the drawer.
Cancel stops between chunks. A pass keeps writing to the chat it started on
if the user switches chats; only one pass runs at a time.

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

## The UI

- **Drawer** (`settings.html`, `src/ui/settings-drawer.js`) - the enable
  switch, status, Repair, the open chat's newest memories.
- **Memory browser** (`src/ui/memory-browser.js`) - all chats, search,
  filters, deletion. Deleting there (`deleteMemoryRecords()`,
  `deleteChatMemories()`) is the only way a stored memory is ever removed.

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
