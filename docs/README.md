# State Engine Archivist

## What this is

Archivist is the memory subsystem for chats that use the
[State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
extension. It:

- **stores** structured memories State Engine extracts from the story -
  events, facts, relationship changes, secrets - one file per chat;
- **indexes** them by the State Engine objects they are about (characters,
  locations, ...) and by type;
- **serves** them to other extensions (Scenario Builder, Pretty Panels)
  through read-only query APIs - see [api.md](api.md);
- lets you **review and delete** them in the memory browser.

Archivist does not write narrative, summarize, or change State Engine
objects. Memory extraction itself is done by State Engine's model call;
Archivist decides what is asked for, then stores what comes back.

## Requirements

- A working SillyTavern install.
- The [State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine)
  extension installed alongside this one, with prompted updates working
  (a connection State Engine can use).

## Installing

1. Install the State Engine extension first (SillyTavern's extension
   installer, or clone it into `public/scripts/extensions/third-party/`).
2. Install this extension the same way, as a SIBLING folder under the same
   `third-party/` directory - Archivist imports State Engine from
   `../SillyTavern-StateEngine/`.
3. Reload SillyTavern. An **Archivist** drawer appears under Extensions.
   (If State Engine is missing or disabled you get a single popup saying
   so, and Archivist does nothing else.)

## Using it

### The drawer (Extensions -> Archivist)

- **Enable Archivist** - off by default. While on, every AI reply's new
  memories are stored. Turning it off stores nothing new; what is already
  stored stays, and other extensions can still read it.
- **Status** - *On*, *Off*, or *Not working: ...* with the reason.
- **Repair** (while enabled) - puts Archivist's State Engine preset back if
  it was deleted, and switches it back on for this chat.
- **This chat** - how many memories the open chat has, and the newest
  five. Hover one for who it is about, the message it came from, and when
  it was stored.
- **Review memories** - opens the memory browser.

### How memories are made

When Archivist is enabled, it switches on its own State Engine preset,
**Archivist Recent Memory Collection**, for the open chat. That preset
holds one variable, `archivist__memories`, which State Engine fills in
during its regular update after each AI reply - in the **same** model call
as your other variables, so there is no extra call per message. Archivist
then reads it, stores the memories against that reply, and empties it for
the next turn.

Each memory names the characters, places and other objects it is about.
Archivist looks those names up among State Engine's objects; a name
State Engine doesn't know is left out (Archivist never creates objects).

You can edit the variable's instructions in State Engine's manager to tune
what gets remembered - Archivist keeps your wording.

### The memory browser

Every chat Archivist holds memory for, grouped by character or group, on
the left; the chosen chat's memories on the right, newest first.

- **Search** the text and the names of who or what a memory is about;
  **filter** by type, scope, importance or entity.
- **Delete** one memory (the bin on its row), the ones you tick
  (**Select shown** ticks everything the filters show), or **everything
  stored for a chat**. Each asks first; none can be undone.
- A chat that no longer exists in SillyTavern - deleted, or its character
  or group deleted - is **struck through and tagged *missing***. Its
  memories are kept until you delete them here.

### Renamed and deleted chats

- **Renamed** - its memories follow it to the new name automatically.
- **Deleted** - its memories are **kept**; a notice says so. Review or
  delete them in the memory browser. Archivist never deletes memory on its
  own.

### Where memory is stored

One file per chat in your SillyTavern data folder:
`user/files/archivist-memories-<chat name>-<code>.json`, each a JSON list
of memory records (the shape is in [api.md](api.md)). Archivist's settings
remember which file belongs to which chat. Back these files up with the
rest of your SillyTavern data.

### If something goes wrong

- **Status says *Not working*** - press **Repair**. If it keeps failing,
  the browser console lines starting with `[Archivist]` say why.
- **Enabled, but no memories appear** - check that State Engine's prompted
  updates run (its own variables change after a reply), and that
  **Archivist Recent Memory Collection** is active for the chat in State
  Engine's manager. State Engine warns before you deactivate or delete it
  while Archivist runs; if you did anyway, Archivist switches it back on the
  next time a chat opens, or at once with **Repair**.
- **Memories from a swiped-away reply** - they stay stored (Archivist
  doesn't change memories); delete them in the memory browser.

## Coming next

- **Catch-up** - extracting memories from chat history that existed before
  Archivist was enabled, in the background, through a separate State
  Engine preset - so older chats get memory too, without waiting.

## Further reading

- [api.md](api.md) - the query APIs, for extension authors.
- [architecture.md](architecture.md) - how Archivist is put together.
- [how-to-extend.md](how-to-extend.md) - reference for the State Engine
  calls an extension like this one builds on.
