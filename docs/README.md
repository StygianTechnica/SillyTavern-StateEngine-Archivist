# State Engine Archivist

## What this is

Archivist is the memory subsystem for chats that use the
[State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
extension. It:

- **stores** structured memory records extracted by State Engine, one JSON
  file per chat;
- **indexes** them by entity (the State Engine objects involved) and by
  subtype (event, fact, relationship, secret, ...);
- **exposes** query APIs other extensions read from - Scenario Builder and
  Pretty Panels read memory, they never write it;
- **runs a catch-up pass** over a chat's existing history, in the
  background, so older chats get memory too.

Archivist does not generate narrative, summarize, or change State Engine
objects or variables beyond clearing its own extraction variables after
storing what they held.

## Requirements

- A working SillyTavern install.
- The [State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
  extension installed alongside this one (Archivist calls into its API
  directly - see [architecture.md](architecture.md), "Reaching the State
  Engine API").

## Installing

1. Install the State Engine extension first, if you haven't already
   (SillyTavern's extension installer, or clone it manually into
   `public/scripts/extensions/third-party/`).
2. Install this extension the same way, as a SIBLING folder under the same
   `third-party/` directory - the import paths in `src/api/*.js` assume
   `SillyTavern-StateEngine` is one level up from
   `SillyTavern-StateEngine-Archivist`.
3. Reload SillyTavern. The browser console shows
   `[Archivist] initialized - namespace "archivist" claimed.`
   (If State Engine is missing or disabled you'll instead see a single
   popup saying so, and Archivist does nothing else.)

## Identity

Archivist's State Engine identity lives in `src/constants.js`:

```js
export const EXTENSION_ID = 'SillyTavern-StateEngine-Archivist';
export const NAMESPACE = 'archivist';   // prefixes every preset/variable Archivist creates
```

## Further reading

- [architecture.md](architecture.md) - the startup lifecycle, dependency
  check, and the State Engine concepts (namespaces, registration,
  capabilities) Archivist's init sequence is built on.
- [how-to-extend.md](how-to-extend.md) - reference for the State Engine
  calls (presets, variables, values, independent presets, events, roles,
  objects) an extension like this one builds on.
