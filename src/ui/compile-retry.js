// When a compile stops on an error, a toast says so and offers to run it
// again - on a click, never on its own: the user may rather do something
// else meanwhile, and nothing is lost by waiting. A retry goes on from the
// last finished batch (each one is saved), even after a Rebuild - so it is
// a plain compile, never a rebuild that would start over.

import { compileOpenChat, onCompilerStatus } from '../compiler/compiler.js';
import { getCurrentChatRef, chatKeyFor } from '../memory/registry.js';

// The error as the toast shows it - a model's broken answer can be long.
const MAX_ERROR = 200;

let toast = null;
let shownFor = null; // finishedAt of the failure the toast is about

function clearToast() {
    if (!toast) return;
    try {
        toastr.clear(toast);
    } catch {
        // Already gone.
    }
    toast = null;
}

// Compiles the failed chat again - if it is still the open one. Resolves
// to whether a compile started.
export async function retryCompile(failed) {
    clearToast();
    const ref = getCurrentChatRef();
    if (!ref || chatKeyFor(ref) !== failed.chatKey) {
        toastr.info(`Open "${failed.chatId}" and compile it from the Archivist drawer to try again.`, 'Archivist');
        return false;
    }
    return compileOpenChat({ reason: 'retry' });
}

// The compiler's status listener: offers a retry once per failure, and
// takes the offer back when a compile starts.
export function onCompileStatus(status) {
    if (!status) return;
    if (status.running) {
        clearToast();
        return;
    }
    if (status.outcome !== 'failed' || status.finishedAt === shownFor) return;
    shownFor = status.finishedAt;
    clearToast();
    const failed = { chatKey: status.chatKey, chatId: status.chatId };
    const error = String(status.error || 'see the browser console');
    const why = error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR)}...` : error;
    toast = toastr.warning(`The compiler stopped: ${why}. What it finished is saved. Click here to try again.`, 'Archivist', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        escapeHtml: true,
        onclick: () => retryCompile(failed),
    });
}

export function startCompileRetry() {
    onCompilerStatus(onCompileStatus);
}
