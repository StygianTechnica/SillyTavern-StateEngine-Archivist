// Identifying chat messages. SillyTavern messages have no stable id, so a
// memory's source_message_id is built from what does identify one:
//
//   <chatId>#<message index>@<send_date>
//
// The index locates the message; send_date tells a later message at the
// same index (after a deletion) or a different swipe apart from it.

export function sourceMessageId(chatId, index, message) {
    return `${chatId}#${index}@${message?.send_date ?? ''}`;
}

// A message the model wrote (not the user's, not a hidden/system one).
export function isStoryReply(message) {
    return !!message && !message.is_user && !message.is_system;
}

// Index of the newest model-written message in `chat`, or -1.
export function lastReplyIndex(chat) {
    if (!Array.isArray(chat)) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isStoryReply(chat[i])) return i;
    }
    return -1;
}
