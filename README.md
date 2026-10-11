# SillyTavern-StateEngine-Archivist

Memory for SillyTavern chats, built on the
[State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine) API.

- Stores the memories State Engine extracts from each AI reply - events, facts,
  relationship changes, secrets - in the same model call as its other variables.
- Indexes them by the characters, places and other objects they are about, and by type.
- Serves them to other extensions (Scenario Builder, Pretty Panels) through
  read-only query APIs.
- A memory browser to search, review and delete memories, for every chat -
  including deleted ones.

Requires the State Engine extension, installed alongside this one.

- [User guide](docs/README.md)
- [API for extension authors](docs/api.md)
- [Architecture](docs/architecture.md)

Status: MVP 0.1, in development - catch-up extraction over existing chat history is next.
