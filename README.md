# SillyTavern-StateEngine-Archivist

Memory for SillyTavern chats, built on the
[State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine) API.

- Stores the memories State Engine extracts from each AI reply - events, facts,
  relationship changes, secrets - in the same model call as its other variables.
- Indexes them by the characters, places and other objects they are about, and by type.
- Serves them to other extensions (Scenario Builder, Pretty Panels) through
  read-only query APIs.
- Catch-up: extracts memories from a chat's earlier messages in the background,
  optionally on a different model (any SillyTavern connection profile).
- A compiler that turns memories into character profiles and insights (traits,
  habits, stressors, motivations, arcs), scene state, session details, relationships
  (type, polarity, intensity) with a relationship map, story threads and quests,
  and the world (secrets and who knows them, locations, factions, items, world
  events, lore) and a timeline - deduplicated, colour-tagged, contradictions flagged,
  every item linked back to the chat messages it came from.
- Links State Engine objects to what is known about them (`getEntityDossier`), for
  character cards and quest panels.
- A memory browser to search, review and delete memories, for every chat -
  including deleted ones.

Requires the State Engine extension, installed alongside this one.

- [User guide](docs/README.md)
- [API for extension authors](docs/api.md)
- [Architecture](docs/architecture.md)

Status: MVP 0.1.
