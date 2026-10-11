// Planning a catch-up pass (spec section 6) - plain functions, no State
// Engine or SillyTavern calls, so they can be tested on their own. The
// runner is src/extraction/catch-up.js.
//
// Which messages: every message of the chat (as it was when catch-up
// started) that is not already COVERED -
//   - a message some stored memory came from (live extraction or an
//     earlier catch-up), matched by index AND send date, so a chat edited
//     since doesn't fool it;
//   - a user message whose reply is covered (live extraction reads the
//     whole latest turn, the user's message included, but attributes the
//     memories to the reply);
//   - a message at or before where the last catch-up of this chat got to
//     (`progress`: { index, sendDate } - trusted only while the message at
//     that index still has that send date).
// Hidden/system messages are never sent.

import { sourceMessageId, isStoryReply } from './messages.js';

// Longest a single message may be in a chunk (characters): a huge message
// can't crowd the rest of its chunk out of the model's context.
export const MAX_MESSAGE_CHARS = 3000;
// Longest the "Already remembered" list may be (characters).
export const MAX_CARRY_CHARS = 1500;

const isSent = (message) => !!message && !message.is_system && typeof message.mes === 'string' && message.mes.trim() !== '';

// The indexes of `chat` a catch-up pass should send, in order.
export function uncoveredIndexes(chat, records, chatId, progress = null) {
    if (!Array.isArray(chat)) return [];
    const covered = new Set(records.map((r) => r.source_message_id));
    const has = (i) => covered.has(sourceMessageId(chatId, i, chat[i]));
    const progressValid = progress && Number.isInteger(progress.index)
        && chat[progress.index] && String(chat[progress.index].send_date ?? '') === String(progress.sendDate ?? '');
    const doneThrough = progressValid ? progress.index : -1;

    const out = [];
    for (let i = 0; i < chat.length; i++) {
        if (!isSent(chat[i]) || i <= doneThrough || has(i)) continue;
        if (chat[i].is_user) {
            // The reply this user message led to: the next story reply.
            let next = i + 1;
            while (next < chat.length && !isStoryReply(chat[next])) next++;
            if (next < chat.length && has(next)) continue;
        }
        out.push(i);
    }
    return out;
}

// `indexes` in chunks of at most `size`.
export function toChunks(indexes, size) {
    const n = Math.max(1, Math.floor(Number(size)) || 1);
    const chunks = [];
    for (let i = 0; i < indexes.length; i += n) chunks.push(indexes.slice(i, i + n));
    return chunks;
}

// The "Already remembered" carry-over: the newest medium/high importance
// memories stored before `beforeIndex` (by their source message index),
// newest kept first when trimming to MAX_CARRY_CHARS, listed oldest first.
export function carryOver(records, beforeIndex, maxChars = MAX_CARRY_CHARS) {
    const indexOf = (r) => Number((/#(\d+)@/.exec(r.source_message_id) ?? [])[1] ?? -1);
    const picked = [];
    let used = 0;
    for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i];
        if (r.importance === 'low' || indexOf(r) >= beforeIndex) continue;
        const line = `- ${r.text}`;
        if (used + line.length + 1 > maxChars) break;
        picked.push(line);
        used += line.length + 1;
    }
    return picked.reverse();
}

// The context a chunk's run hands the model: what is already remembered,
// then the chunk's messages, each labelled [#index] so the model can say
// which one a memory comes from.
export function chunkContext(chat, chunk, carry) {
    const lines = [];
    if (carry.length) lines.push('Already remembered (do not repeat these):', ...carry, '');
    lines.push('Chat messages:');
    for (const i of chunk) {
        const m = chat[i];
        const name = m.name || (m.is_user ? 'User' : 'Character');
        let text = m.mes.trim();
        if (text.length > MAX_MESSAGE_CHARS) text = `${text.slice(0, MAX_MESSAGE_CHARS)}...`;
        lines.push(`[#${i}] ${name}: ${text}`);
    }
    return lines.join('\n');
}

// The message a memory from `chunk` came from: the item's message_index
// when it names one of the chunk's messages, otherwise the chunk's last
// story reply (or its last message).
export function sourceIndexFor(item, chunk, chat) {
    const named = Number(String(item?.message_index ?? '').replace(/^#/, ''));
    if (Number.isInteger(named) && chunk.includes(named)) return named;
    for (let k = chunk.length - 1; k >= 0; k--) if (isStoryReply(chat[chunk[k]])) return chunk[k];
    return chunk[chunk.length - 1];
}
