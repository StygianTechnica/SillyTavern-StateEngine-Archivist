# How to Extend This Template

Everything below assumes you've already renamed the namespace (see
[README.md](README.md)) and confirmed the extension loads cleanly with
just the console message and nothing else. Each section is additive -
none of them depend on the others, add whichever your extension
actually needs.

All calls below go through `stateEngine.*`
(`SillyTavern-StateEngine/src/api/index.js`) with the same
`(extensionId, instanceId, ...)` identity pattern this template's own
`src/api/*.js` wrappers already use - see
[architecture.md](architecture.md) if the shape looks unfamiliar. The
full, authoritative signatures live in the State Engine's own API
Reference; this file only shows the calls most relevant to each task.

The import path in each snippet below (`'../../SillyTavern-StateEngine/...'`)
assumes the code lives in a file directly under `src/` (one level deep,
like `src/extension.js` itself) - the same sibling-folder assumption
`src/api/*.js` makes, just one `../` shallower since those live under
`src/api/` instead. Adjust the number of `../` to match wherever you
actually put the code - or, better, add your own thin wrapper under
`src/api/` (matching `namespace.js`/`registration.js`/`capabilities.js`)
for anything you end up calling from more than one place.

## Adding presets

A preset is a named group of variables your extension owns - create one
once (e.g. from `initExtension()`, or lazily the first time your
extension needs it), then activate it for whichever chat should use it:

```js
import { stateEngine } from '../../SillyTavern-StateEngine/src/api/index.js';
import { ensureInstanceId } from '../../SillyTavern-StateEngine/src/api/identity.js';

const preset = stateEngine.createPreset(EXTENSION_ID, ensureInstanceId(), {
    namespace: NAMESPACE,
    name: 'Main',
    description: 'This extension\'s primary variable set',
    triggers: ['ai'], // which prompted-update triggers this preset's variables respond to
});

stateEngine.activatePreset(EXTENSION_ID, ensureInstanceId(), chatId, NAMESPACE, 'Main');
```

`createPreset` returns `null` (not a thrown error) for an ordinary
failure like a duplicate name - check for that before assuming it
worked. `activatePreset` seeds default values, recalculates any
calculated variables, and refreshes macros for you; nothing further to
call afterward.

`activatePreset`/`deactivatePreset` are the one exception to namespace
ownership: binding a preset to a chat changes none of its definitions,
so any registered extension may switch on ANY namespace's preset - e.g.
one of the user's own `se` presets that your UI displays. Everything
that edits a preset (`createPreset`, `updatePreset`, `deletePreset`)
stays owner-only.

## Adding variables

Variables live inside a preset. Eleven types are supported - string,
number, boolean, enum, array, datetime, image, imageList, imageMap,
character, and calculated - see the State Engine's own "Variable Types"
reference for the full field shape of each. (A `character` variable
holds a character id - see "Working with characters", below - takes no
default, and cannot be incremented.) A minimal prompted string variable:

```js
stateEngine.createVariable(EXTENSION_ID, ensureInstanceId(), {
    namespace: NAMESPACE,
    presetName: 'Main',
    name: 'mood',
    type: 'string',
    defaultValue: 'calm',
    behaviors: { prompted: true, increment: false },
    prompted: { instructions: 'infer the character\'s current mood' },
});
```

The model then writes to it during the normal per-message prompted
update (or your own independent preset's update - see below). A
variable's value never goes through its definition: `createVariable`/
`updateVariable` reject a `value` field outright. To read or set a value
yourself, use the Variable Value API - see "Reading and writing variable
values", directly below.

An incrementing variable can take its step from another variable
instead of a fixed number: `increment: { delta: 1, deltaVariable:
'myExtension__speed' }` - the fixed `delta` is the fallback if the named
variable is missing or unusable, and a variable can never name itself.

## Reading and writing variable values

`variable-api.js` (above) only deals in *definitions*. The current
VALUE of a variable in a given chat goes through the Variable Value
API:

```js
const chatId = SillyTavern.getContext().chatId;

// Every preset in every namespace, each with its variables' display
// fields (label, type, min/max, enumValues, calendar...). Pass chatId to
// also get `active` per preset.
const catalog = stateEngine.listAllVariables(EXTENSION_ID, ensureInstanceId(), chatId);

// One value, or several in one store read - fully qualified names.
// -> { value, def } | undefined (undefined = the chat holds no value,
//    e.g. its preset isn't active there)
const mood = stateEngine.getVariableValue(EXTENSION_ID, ensureInstanceId(), chatId, 'myExtension__mood');
const many = stateEngine.getVariableValues(EXTENSION_ID, ensureInstanceId(), chatId, ['se__hp', 'se__location']);

// The image an image/imageList/imageMap variable is currently showing,
// already checked as safe for <img src> - or null.
const src = stateEngine.getVariableImage(EXTENSION_ID, ensureInstanceId(), chatId, 'myExtension__portrait');

// Write a value - OWNER-ONLY (your own namespace), never a calculated
// variable. Returns true/false.
stateEngine.setVariableValue(EXTENSION_ID, ensureInstanceId(), chatId,
    { namespace: NAMESPACE, presetName: 'Main', variableName: 'mood' }, 'tense');
```

Reads are open to any registered extension and span every namespace (a
display extension has to be able to show the user's own `se`
variables); they always return copies. Writes stay owner-only.

**Following changes.** There is no subscribe call - every value write
emits `state_engine_variables_changed` on SillyTavern's own event bus,
coalesced to one event per chat per engine pass. The payload is just
the `chatId` (`null` = possibly every chat); re-read whatever you care
about:

```js
SillyTavern.getContext().eventSource.on('state_engine_variables_changed', (chatId) => {
    if (chatId === null || chatId === SillyTavern.getContext().chatId) refreshMyUi();
});
```

Role changes (below) emit the same event.

## Adding UI

The State Engine API itself is UI-agnostic - it has no opinion on how
(or whether) you show anything. Nothing in this template's scaffold
needs changing to add UI; you add your own HTML/CSS and jQuery wiring
the same way any SillyTavern extension does:

1. Add a `settings.html` (or similar) fragment, and load it the way
   SillyTavern's own extension settings panels do (fetched and injected
   into the extensions drawer) or via a modal/panel your extension opens
   itself.
2. Wire it up from `src/extension.js` (or a new module you import from
   there) - populate it with the Variable Value API reads above, refresh
   it on `state_engine_variables_changed`, and call `setVariableValue`
   (your own variables) in response to user interaction.
3. Keep UI code out of `src/api/*.js` - those files exist purely as
   identity-checked API wrappers, one call each, matching this
   template's own structure. A `src/ui/` folder, added when you need it,
   is a natural place to grow into.

A few calls exist specifically for displays:

- **Dates and times.** `formatDateTime(extensionId, instanceId,
  calendarId, scalarTime, options)` and `formatDateTimePartial(...,
  fields)` render a datetime variable's value as text in its own
  calendar; `getDateTimeParts(extensionId, instanceId, calendarId,
  scalarTime)` returns the structured pieces (date fields, weekday,
  `time: { hour, minute, second, fraction }`, the calendar's clock
  sizes) for things you draw rather than print, like an analog clock.
- **Storing images.** `await importImageFile(extensionId, instanceId,
  file, { folder })` stores an uploaded `File` exactly the way State
  Engine stores image-variable files (format sniffed from the bytes, no
  SVG, 20 MB max) into `user/images/<folder>/`, and returns that
  relative path. Unlike most calls it THROWS on failure, with a message
  meant to be shown to the user.
- **Notifications.** `notify(extensionId, instanceId, { message,
  severity?, id?, callbackId? })` posts to State Engine's own
  notification panel (re-using an `id` replaces that notification rather
  than stacking duplicates); `clearNotification(extensionId, instanceId,
  id)` removes it.

## Adding independent presets

An independent preset runs its own prompted update on demand or on a
schedule, instead of participating in the standard per-message flow -
useful for a periodic summary, a background world-state tick, or
anything that shouldn't ride on every chat message:

```js
const indy = stateEngine.createIndependentPreset(EXTENSION_ID, ensureInstanceId(), {
    namespace: NAMESPACE,
    name: 'PeriodicSummary',
    connectionProfileId: '', // '' = use the currently active connection
});

// Optional: run it every real 30 minutes (natural-language time expression,
// same parser datetime variables use).
stateEngine.updateIndependentPresetSchedule(EXTENSION_ID, ensureInstanceId(), NAMESPACE, 'PeriodicSummary', {
    enabled: true,
    mode: 'interval',
    value: '30 minutes',
});

// Or run it on demand:
await stateEngine.runIndependentPreset(EXTENSION_ID, ensureInstanceId(), chatId, { namespace: NAMESPACE, name: 'PeriodicSummary' });
```

An independent preset automatically operates on every prompted/
incrementable variable IN THAT PRESET - there's no separate scoping
step; add variables to it exactly as in "Adding variables" above, just
naming `'PeriodicSummary'` as the `presetName`.

## Adding events

Events let your extension announce something happened, namespaced so
dispatching stays scoped to you while LISTENING stays open to anyone:

```js
// Declare it (optional, but makes it discoverable):
stateEngine.registerEventSource(EXTENSION_ID, ensureInstanceId(), {
    namespace: NAMESPACE,
    eventName: 'moodChanged',
});

// Fire it (namespace-qualified: "myExtension.moodChanged"):
stateEngine.fireEvent(EXTENSION_ID, ensureInstanceId(), chatId, `${NAMESPACE}.moodChanged`);

// Anyone - including your own extension - listens the ordinary
// SillyTavern way, not through the State Engine API:
SillyTavern.getContext().eventSource.on(`${NAMESPACE}.moodChanged`, () => { /* ... */ });
```

Only DISPATCHING is namespace-restricted to your extension; listening is
open to any code, since that's how other extensions would react to your
events in the first place.

## Binding to variables by role

If your extension needs "whatever variable holds the scene title" rather
than one specific variable name, don't hard-code `se__scene_title` -
define a ROLE. A role is a global, namespaced semantic tag
(`myExtension__scene.title`); each chat assigns one of its own variables
to it, so the same extension works across chats and presets that name
things differently.

```js
// Keep your namespace's roles in step with what you need (roles left out
// are deleted; roles that stay keep their assignments). Owner-only.
stateEngine.setNamespaceRoles(EXTENSION_ID, ensureInstanceId(), [
    { publicName: 'scene.title', type: 'text', label: 'Scene title' },
]);

// Tell State Engine this chat (or every chat: omit chatId) needs it, so
// the user is shown what's missing. Any namespace's role ids may be listed.
stateEngine.requestRoles(EXTENSION_ID, ensureInstanceId(), {
    key: 'main', label: 'My Extension', roles: [`${NAMESPACE}__scene.title`],
});

// Resolve to the variable actually assigned in this chat.
const { roles, missing, allAssigned } = stateEngine.resolveRoles(
    EXTENSION_ID, ensureInstanceId(), chatId, [`${NAMESPACE}__scene.title`]);
```

Role types are `text`, `number`, `boolean`, `date`, `image`, `list` and
`any` (`getRoleTypes()`). `assignRole(..., chatId, id, variableName)`
assigns (or, with `null`, clears) a chat's variable - only variables of
a preset active in that chat, of a fitting type
(`getRoleCandidates(...)` lists them). Defining/updating/deleting roles
is owner-only; reading, assigning and requesting are open to any
registered extension, since assignments belong to the chat.

## Working with characters

State Engine tracks characters in two layers: SETTINGS (global
containers of canonical, confirmed characters, with variants) and each
CHAT (which setting it uses, who's present, and characters the model
has detected but nobody has reviewed yet - "unconfirmed"). Confirming a
character moves it into the setting. A `character` variable holds a
character id.

```js
const setting = await stateEngine.ensureChatCharacterSetting(EXTENSION_ID, ensureInstanceId(), chatId); // asks the user if the chat has none
const cast = stateEngine.listCharacters(EXTENSION_ID, ensureInstanceId(), chatId);
const who = stateEngine.getCharacterByAlias(EXTENSION_ID, ensureInstanceId(), chatId, 'Mira');
// who.runtime = { present, thought, mood, intent, custom, images } - this chat's current state
```

The full surface (create/update/merge/confirm/resolve characters,
variants, per-setting runtime fields, `setCharacterRuntimeValue`) is in
the header comment of State Engine's `src/api/character-api.js`. A UI
extension that provides a Character Manager registers its opener with
`registerCharacterManager(extensionId, instanceId, opener)`; anyone can
then open it with `openCharacterManager(...)` (check
`hasCharacterManager()` first).

## Integrating with Scenario Builder

There is no Scenario-Builder-specific API - it's expected to be just
another consumer of the same namespaced `stateEngine.*` surface this
template already uses, discovering and reading your extension's
variables/presets the ordinary way (`getRegisteredExtensions`,
`listVariables`, the capability graph below). If you want your
extension to be usable FROM Scenario Builder, the useful things to do
are the same ones that make any extension discoverable:

1. Register with a clear `description` and a `variables` list naming
   what you expose (see "Registration" in [architecture.md](architecture.md)).
2. Declare a capability describing what you provide, e.g.
   `"scenario.characterState"`, so Scenario Builder (or anything else)
   can find you via `stateEngine.getExtensionsProviding(...)` rather
   than needing to know your `extensionId` in advance.
3. Define roles for the things you expose (see "Binding to variables by
   role", above), so a consumer can bind to their meaning rather than
   your variable names.
4. If Scenario Builder later publishes its own capability name to
   depend on, declare it in your own `dependsOn` list - see "Declaring
   dependencies", directly below.

## Declaring dependencies

If your extension needs something ANOTHER extension provides, declare
it the same way you declare what you yourself provide - as a plain
capability string:

```js
stateEngine.declareDependencies(EXTENSION_ID, ensureInstanceId(), ['data.inventory']);

// Find out who (if anyone) actually provides it:
const providers = stateEngine.getExtensionsProviding('data.inventory'); // [] if nobody does yet
```

Nothing enforces that a dependency's provider is installed or loaded -
`declareDependencies` just records the string for the capability graph;
resolving it (deciding what to do if `providers` comes back empty) is
entirely up to your own extension's code. A natural place for this
check is right after `initExtension()` in `src/extension.js`, or lazily
right before you actually need the dependency.
