// A yes/no question to the user, through SillyTavern's own confirmation
// popup when it is there (window.confirm otherwise). Resolves to true for
// yes. `question` is plain text - escaped here, line breaks kept.

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c]);
}

export async function confirmAction(question) {
    try {
        const { callGenericPopup, POPUP_TYPE, POPUP_RESULT } = SillyTavern.getContext();
        if (typeof callGenericPopup === 'function' && POPUP_TYPE) {
            const html = `<div style="white-space: pre-wrap; text-align: left;">${escapeHtml(question)}</div>`;
            const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM);
            return result === (POPUP_RESULT?.AFFIRMATIVE ?? 1);
        }
    } catch {
        // Fall through to the browser's own confirm.
    }
    return window.confirm(question);
}

// A line of text from the user, through SillyTavern's input popup when it
// is there (window.prompt otherwise), starting from `initial`. Resolves to
// the text, or null when cancelled.
export async function askText(question, initial = '') {
    try {
        const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
        if (typeof callGenericPopup === 'function' && POPUP_TYPE) {
            const html = `<div style="white-space: pre-wrap; text-align: left;">${escapeHtml(question)}</div>`;
            const result = await callGenericPopup(html, POPUP_TYPE.INPUT, initial);
            return typeof result === 'string' ? result : null;
        }
    } catch {
        // Fall through to the browser's own prompt.
    }
    return window.prompt(question, initial);
}
