// Which registered chats still exist in SillyTavern - for the memory
// browser, which flags the ones that don't (deleted, or their character or
// group deleted) so the user can review and remove their memories.
//
//   solo chat   its character (by avatar) is still in context.characters,
//               and POST /api/characters/chats lists the chat
//   group chat  its group is still in context.groups, and group.chats
//               lists the chat
//
// Each answer is true, false, or null when it could not be told (a request
// failed) - unknown is never shown as missing.

async function characterChatIds(avatar) {
    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: SillyTavern.getContext().getRequestHeaders(),
        body: JSON.stringify({ avatar_url: avatar, simple: true }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    // { error: true } means the character has no chats folder at all.
    if (!Array.isArray(data)) return data?.error ? new Set() : null;
    return new Set(data.map((chat) => String(chat.file_id ?? chat.file_name ?? '').replace(/\.jsonl$/i, '')));
}

// `entries`: [{ chatKey, entry }] from the registry. Resolves to a Map of
// chatKey -> true | false | null. One request per character, however many
// of its chats are asked about.
export async function checkChatsExist(entries) {
    const context = SillyTavern.getContext();
    const result = new Map();
    const perCharacter = new Map();

    for (const { chatKey, entry } of entries) {
        if (entry.groupId) {
            const group = (context.groups || []).find((g) => String(g.id) === String(entry.groupId));
            result.set(chatKey, !!group && Array.isArray(group.chats) && group.chats.map(String).includes(entry.chatId));
            continue;
        }
        if (!(context.characters || []).some((c) => c.avatar === entry.characterAvatar)) {
            result.set(chatKey, false);
            continue;
        }
        if (!perCharacter.has(entry.characterAvatar)) {
            perCharacter.set(entry.characterAvatar, characterChatIds(entry.characterAvatar).catch(() => null));
        }
        const ids = await perCharacter.get(entry.characterAvatar);
        result.set(chatKey, ids === null ? null : ids.has(entry.chatId));
    }
    return result;
}
