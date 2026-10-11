# SillyTavern-StateEngine-Archivist

Memory storage for SillyTavern chats, built on the
[State Engine](https://github.com/StygianTechnica/SillyTavern-StateEngine) API.
Archivist stores the structured memory records State Engine extracts from each chat
message, indexes them by entity and subtype, and serves them to other extensions
(Scenario Builder, Pretty Panels). A catch-up pass extracts memory from chat history
that existed before Archivist was enabled.

Status: in development (MVP 0.1). See [docs/README.md](docs/README.md).
