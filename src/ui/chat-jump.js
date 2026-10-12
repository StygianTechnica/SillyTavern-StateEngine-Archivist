// Scrolling the chat to a message - for the links from compiled memory back
// to the part of the chat it came from. SillyTavern's own /chat-jump loads
// older messages first when they aren't shown yet; without it, the message
// is scrolled to if it is on the page.
export async function jumpToMessage(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0) return false;
    try {
        const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
        if (typeof executeSlashCommandsWithOptions === 'function') {
            await executeSlashCommandsWithOptions(`/chat-jump ${i}`);
            return true;
        }
    } catch {
        // Fall back to scrolling.
    }
    const element = document.querySelector(`#chat .mes[mesid="${i}"]`);
    if (!element) return false;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return true;
}
