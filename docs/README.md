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
- **Review memories** - right under it: opens the memory browser.
- **Status** - *On*, *Off*, or *Not working: ...* with the reason.
- **Last update** - what happened the last time State Engine sent memories:
  how many were stored, or why they couldn't be. Your first stop when
  memories don't appear.
- **Repair** (while enabled) - puts Archivist's State Engine preset back if
  it was deleted, switches it back on for this chat, and stores anything
  waiting in its variable.
- **Catch-up** - see below.
- **This chat** - how many memories the open chat has, and the newest
  five. Hover one for who it is about, the message it came from, and when
  it was stored.

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
what gets remembered - Archivist keeps your wording, except when an Archivist
update improves the built-in instructions (it then replaces them once).

**Give State Engine room to answer:** its max-tokens setting caps the whole
update response, memories included. A few memories add 50-80 tokens each; a
response cut off at the limit can't be read, and the whole update is lost.
Around 800-1000 is a good setting.

### Catch-up: memories from earlier messages

For a chat that existed before you enabled Archivist (or while it was off):

1. Open the chat, then **Extensions -> Archivist -> Catch-up**.
2. Choose a **Connection**: *Same as State Engine*, or any SillyTavern
   connection profile - e.g. a model with a bigger context, or a cheaper one,
   for a long history.
3. **Messages per chunk** (default 50) - how many messages each call reads.
   Smaller chunks are more reliable on small models.
4. **Max tokens** (default 2000) - the longest answer a call may give. A
   chunk of many messages can hold many memories; too low, and the answer is
   cut off and lost.
5. **Run catch-up for this chat**. The status line shows *Chunk 3 of 12 - 14
   memories stored so far*; keep chatting, or switch chats - it keeps working
   on the chat it started on. **Cancel** stops after the chunk in progress.

Messages that already have memories (from live extraction or an earlier
catch-up) are skipped, and Archivist remembers how far catch-up got - run it
again later and it only reads what's new, or retries chunks that failed.
Each chunk is told what is already remembered, so it doesn't repeat it.

Catch-up uses its own State Engine preset, **Archivist History Catch-Up**
(an independent preset - it doesn't take part in the per-message update).
It works whether or not *Enable Archivist* is on.

### The compiler: characters, relationships, threads, the world, timeline

Raw memories pile up and repeat themselves. The compiler turns a chat's
memories into structured knowledge:

- **Story so far** - a summary of the story, revised with each compile
- **Characters** - lasting facts, by character (and place, faction...), and
  what the memories reveal about each character: personality traits,
  habits, stressors, motivations, their arc so far, how they feel lately
- **Scene** - a summary of the current scene, what holds in it (arrivals,
  weather, transport), and what just happened - the scene memories of the
  newest dozen messages, straight from the memories
- **Session** - what holds for this part of the story
- **Relationships** - each direction of a pair: what the relationship is
  (friend, mentor, colleague, rival... in the model's own words), its
  polarity from -3 hostile to +3 devoted, its intensity (low / medium /
  high) and whether it is warming or cooling - with a **relationship map**,
  a grid of who feels what toward whom
- **Story threads and quests** - plot hooks, unresolved threads, quest
  seeds, with their status (open, active, resolved, abandoned) and progress
- **The world** - secrets and who knows them, locations, factions and
  groups, items, ongoing world events, lore and rules of the setting
- **Timeline** - the story's events, in order: major ones marked, who
  witnessed them, their tone, and when the message was written

Every memory also records who was present, tags for prioritizing it
(important, trivial, contextual, emotional) and its emotional tone.

Memories saying the same thing are merged into one canonical fact ("Lucian
works at Maple Heights gym", not five memories about shifts there), and facts
that can't both be true are flagged. Every fact has a colour tag -
**Permanent** (blue), **Session** (yellow), **Scene** (green),
**Relationship** (purple), **Contradiction** (red) - and links back to the
chat messages it came from.

It doesn't run on every message. In the drawer's **Compiler** section:

- **Compile automatically** - on, it compiles once enough new memories have
  arrived (**After new memories**, default 15 - near-repeats don't count), or
  after a while with some (**Or every**, default 30 minutes), but never right
  after the last compile (**Not within**, default 5 minutes). Only while
  Archivist is enabled.
- **Connection** and **Max tokens** - its own model, like catch-up's. The
  whole compiled list comes back each time, so give it room (default 3000).
- **Compile now** - compile the new memories now. **Rebuild** - start over
  from every memory.
- **Also compile story threads, quests and the world** - on by default; it
  is a second model call per batch (the **Archivist World Compiler**
  preset), so turn it off to save tokens.

Each compile only sends the memories added since the last one, with the
current compiled knowledge - so profiles stay stable and long chats stay
cheap. A compile that fails, or whose answer would drop everything, leaves
the previous result in place.

A chat compiled before characters, threads and the world existed says so
in its Compiled view - **Rebuild** it to fill them in for the whole chat.

See it in **Review memories -> Compiled** - its status line shows what the
compiler is doing, or why the last compile failed, and **Compile now** and
**Rebuild** work from there too. Click a fact's *message #12* (or
*messages #3-8*) to jump to that part of the chat. A fact resting only on
memories that are gone - a regenerated reply, another swipe - drops out of
the view until they are back.

Everything the compiler wrote can be corrected there: hover a fact, a
relationship, a character's insights, a story thread or quest, a world entry
or a summary for its **pencil** (edit) and **bin** (delete) buttons. A
deleted item stays deleted - later compiles, and a Rebuild, leave it out -
while the memories it came from are kept. Edited items are marked *edited*.

Each character the memories show enough of gets a **summary** - who they are
*now*, judged by what they have done so far - rewritten as the story moves on,
alongside their traits, habits, stressors, motivations, arc and feeling.

The compiler keeps relationships, characters, threads and world entries
(secrets included) even when its answer leaves one out - a long list loses
items by accident, not on purpose. Only you delete them; facts are the one
thing the model drops itself, when the story shows they no longer hold.

The compiler uses two State Engine presets of its own, **Archivist Memory
Compiler** and **Archivist World Compiler** (independent presets). State
Engine queues their runs, catch-up's and its own per-message update on the
connection they share, one at a time - so a compile started while catch-up
runs just waits its turn.

### Archivist in the prompt (with Curator)

With the **Curator** extension installed, Archivist's knowledge can go into
the prompt the model writes the story from. Open Curator's Prompt Analyzer:
the **State Engine Variables** bank lists Archivist's blocks - tick the
ones you want and drag them where they belong:

- **Story so far** - the compiled summary
- **Current scene** - its summary, what holds in it, what just happened
- **Characters in the scene** - traits, motivations, stressors, feelings of
  the characters present
- **Relationships in the scene** - between the characters present and your
  persona: type, polarity, intensity, trend
- **Open threads and quests** - plot hooks, threads and quests still open
- **Recent events** - the latest events, with who witnessed them
- **Secrets (narrator only)** - secrets still kept and who knows them:
  knowledge for the narrator, not something the characters know

"Present" is State Engine's own idea of who is in the scene (the characters
marked present); without that, whoever the newest scene memories name.
Archivist keeps the blocks current as memories arrive, after a compile and
when the scene changes; a block with nothing to say sends nothing. They
work while Archivist is enabled for the chat.

### The memory browser

Every chat Archivist holds memory for, grouped by character or group, on
the left; the chosen chat on the right - its **Memories** (newest first), or
its **Compiled** memory (see above).

- **Search** the text, the tone and the names of who or what a memory is
  about; **filter** by type, scope, importance, tag, or entity (who it is
  about or who was present).
- **Delete** one memory (the bin on its row), the ones you tick
  (**Select shown** ticks everything the filters show), or **everything
  stored for a chat**. Each asks first; none can be undone.
- A chat that no longer exists in SillyTavern - deleted, or its character
  or group deleted - is **struck through and tagged *missing***. Its
  memories are kept until you delete them here.

### When messages change

Every memory is attached to the exact message - and swipe - it came from,
so you never have to clean up after rewriting the story:

| You...                         | That message's memories...                                            |
|--------------------------------|------------------------------------------------------------------------|
| **regenerate** a reply         | are removed; the new reply's are stored as usual                       |
| **swipe** to another reply     | are set aside, and come back if you swipe back                         |
| **delete a swipe**             | are removed                                                            |
| **delete a message**           | are removed (memories of later messages stay attached to theirs)       |
| **edit a message**             | are removed and, while Archivist is enabled, the message is read again |

An edit only counts when the text changed. Re-reading an edited message uses
the catch-up preset and connection (see above). Set-aside swipe memories
aren't shown anywhere - not in the drawer, the memory browser, or what other
extensions read for the open chat - but they stay stored until that swipe is
deleted.

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
- **Enabled, but no memories appear** - look at the drawer's **Last
  update** line first: it says whether memories arrived and why they weren't
  stored. The browser console has a matching `[Archivist]` line for each.
  Then check that State Engine's prompted
  updates run (its own variables change after a reply), that its max tokens
  isn't too low (see above), and that
  **Archivist Recent Memory Collection** is active for the chat in State
  Engine's manager. State Engine warns before you deactivate or delete it
  while Archivist runs; if you did anyway, Archivist switches it back on the
  next time a chat opens, or at once with **Repair**.

## Further reading

- [api.md](api.md) - the query APIs, for extension authors.
- [architecture.md](architecture.md) - how Archivist is put together.
- [how-to-extend.md](how-to-extend.md) - reference for the State Engine
  calls an extension like this one builds on.
