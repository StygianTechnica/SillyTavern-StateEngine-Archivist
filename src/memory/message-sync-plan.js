// Matching a chat's memories to its messages as they are NOW - plain
// functions, no SillyTavern calls, so they can be tested on their own. The
// runner is src/memory/message-sync.js.
//
// A memory's source_message_id is "<chatId>#<index>@<send_date>". In
// SillyTavern, send_date is set when a message (or a swipe) is written - an
// ISO timestamp to the millisecond - and every swipe keeps its own in
// message.swipe_info[]. So send_date identifies one specific message AND
// swipe, while the index only says where it sits now. For each memory:
//
//   its send_date is a message's CURRENT one  -> shown; its index corrected
//                                                if messages before it were
//                                                deleted or added
//   it is an inactive swipe's send_date        -> HIDDEN - kept, and shown
//                                                again if the user swipes back
//   it is nowhere in the chat                  -> REMOVED - the message was
//                                                regenerated, deleted, or the
//                                                swipe deleted
//
// A memory with no send_date to go by ("Chat#unknown", or a message that
// had none) is left alone.

// "<chatId>#<index>@<send_date>" -> { index, stamp }, or null. Read from the
// end, so a chat id containing "#" or "@" can't confuse it.
export function parseSource(sourceMessageId) {
    const match = /#(\d+)@([^#]*)$/.exec(String(sourceMessageId ?? ''));
    return match ? { index: Number(match[1]), stamp: match[2] } : null;
}

// When a memory's message was written in the chat (its send_date): an ISO
// timestamp when it reads as a date, else the stamp as SillyTavern wrote
// it (older chats used "October 12, 2026 7:24am"), or null when unknown.
// This is real time - not the story's own clock.
export function messageDateOf(record) {
    const stamp = parseSource(record?.source_message_id)?.stamp;
    if (!stamp) return null;
    const time = Date.parse(stamp);
    return Number.isNaN(time) ? stamp : new Date(time).toISOString();
}

// Every send_date in `chat` -> where it is: [{ index, current }] (current:
// the message's shown swipe, or a message without swipes).
function stampsOf(chat) {
    const where = new Map();
    const add = (stamp, index, current) => {
        if (!stamp) return;
        if (!where.has(stamp)) where.set(stamp, []);
        where.get(stamp).push({ index, current });
    };
    chat.forEach((message, index) => {
        if (!message) return;
        const current = String(message.send_date ?? '');
        add(current, index, true);
        for (const swipe of Array.isArray(message.swipe_info) ? message.swipe_info : []) {
            const stamp = String(swipe?.send_date ?? '');
            if (stamp && stamp !== current) add(stamp, index, false);
        }
    });
    return where;
}

// What to do with `records` (the open chat's, hidden ones included) for
// `chat` as it is now: { remove: [ids], hidden: [ids], repoint: Map(id ->
// corrected source_message_id) }.
export function planMessageSync(records, chat, chatId) {
    const where = stampsOf(Array.isArray(chat) ? chat : []);
    const remove = [];
    const hidden = [];
    const repoint = new Map();
    for (const record of records) {
        const source = parseSource(record.source_message_id);
        if (!source || !source.stamp) continue;
        const found = where.get(source.stamp);
        if (!found) {
            remove.push(record.id);
            continue;
        }
        // The same send_date twice (older chats stored it to the minute):
        // the one at the memory's own index wins.
        const at = found.find((f) => f.index === source.index) ?? found[0];
        if (!at.current) hidden.push(record.id);
        const next = `${chatId}#${at.index}@${source.stamp}`;
        if (next !== record.source_message_id) repoint.set(record.id, next);
    }
    return { remove, hidden, repoint };
}

// The ids of the memories that came from the message at `index` as it is
// now (its shown swipe) - what an edit of that message makes stale.
export function memoriesOfMessage(records, chat, index) {
    const stamp = String(chat?.[index]?.send_date ?? '');
    if (!stamp) return [];
    return records.filter((record) => {
        const source = parseSource(record.source_message_id);
        return source && source.index === index && source.stamp === stamp;
    }).map((record) => record.id);
}
