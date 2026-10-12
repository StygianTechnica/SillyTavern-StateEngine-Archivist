// memories.json storage: one JSON file per chat, holding an ARRAY of
// memory records (spec section 3). Archivist is the only module that
// writes these files, and this is the only file in Archivist that touches
// them.
//
// The spec's path, /data/chats/<chat_id>/memories.json, is not reachable
// from a browser extension, so each chat's "memories.json" is a real file
// in the user's SillyTavern data folder, written through SillyTavern's own
// file API:
//
//   write   POST /api/files/upload  { name, data: base64 }  -> user/files/<name>
//   read    GET  /user/files/<name>
//   delete  POST /api/files/delete  { path: "user/files/<name>" }
//
// The file name for each chat comes from the chat registry
// (src/memory/registry.js).
//
// Every read-modify-write of a file goes through updateMemoryFile(), which
// runs one change per file at a time, in call order - so live extraction
// and a background catch-up appending to the same chat at once can never
// overwrite each other's records.

const FILES_DIR = 'user/files';

const locks = new Map();

// Runs `task` after every earlier task queued for `fileName` has settled
// (whether it succeeded or failed), and returns its result.
function withFileLock(fileName, task) {
    const previous = locks.get(fileName) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(task);
    const tail = run.catch(() => {});
    locks.set(fileName, tail);
    tail.then(() => {
        if (locks.get(fileName) === tail) locks.delete(fileName);
    });
    return run;
}

// UTF-8 text -> base64, in slices so a large file can't overflow the
// argument limit of String.fromCharCode.
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function requestHeaders() {
    return SillyTavern.getContext().getRequestHeaders();
}

// The records in `fileName`, or [] when the file does not exist yet.
// Throws when the file exists but cannot be read as a JSON array - so a
// damaged file is never silently replaced by an empty one.
export async function readMemoryFile(fileName) {
    const response = await fetch(`/${FILES_DIR}/${encodeURIComponent(fileName)}`, { cache: 'no-store' });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Archivist: reading ${fileName} failed (${response.status})`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`Archivist: ${fileName} does not hold a list of memory records`);
    return data;
}

async function writeJson(fileName, data) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: requestHeaders(),
        body: JSON.stringify({ name: fileName, data: toBase64(JSON.stringify(data, null, 2)) }),
    });
    if (!response.ok) throw new Error(`Archivist: writing ${fileName} failed (${response.status})`);
}

const writeMemoryFile = writeJson;

// Reads `fileName`, passes its records to `change`, and writes back what
// `change` returns - all inside the file's lock. Resolves to the records
// written.
export function updateMemoryFile(fileName, change) {
    return withFileLock(fileName, async () => {
        const current = await readMemoryFile(fileName);
        const next = await change(current);
        if (!Array.isArray(next)) throw new Error('Archivist: a memory file update must produce a list of records');
        await writeMemoryFile(fileName, next);
        return next;
    });
}

// Reads `fileName` after any queued writes to it have finished.
export function readMemoryFileQueued(fileName) {
    return withFileLock(fileName, () => readMemoryFile(fileName));
}

// Deletes `fileName`. A file that is already gone counts as deleted.
export function deleteMemoryFile(fileName) {
    return withFileLock(fileName, async () => {
        const response = await fetch('/api/files/delete', {
            method: 'POST',
            headers: requestHeaders(),
            body: JSON.stringify({ path: `${FILES_DIR}/${fileName}` }),
        });
        if (!response.ok && response.status !== 404) throw new Error(`Archivist: deleting ${fileName} failed (${response.status})`);
    });
}

// ---- other JSON files (the compiled memory, src/compiler/) - the same
// per-file queue, for a file holding a JSON object rather than a list.

// The object in `fileName`, or null when the file does not exist yet.
// Throws when it exists but isn't a JSON object.
async function readJson(fileName) {
    const response = await fetch(`/${FILES_DIR}/${encodeURIComponent(fileName)}`, { cache: 'no-store' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Archivist: reading ${fileName} failed (${response.status})`);
    const data = await response.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`Archivist: ${fileName} does not hold a JSON object`);
    return data;
}

// Reads `fileName` after any queued writes to it have finished.
export function readJsonFile(fileName) {
    return withFileLock(fileName, () => readJson(fileName));
}

// Replaces `fileName` with `data`, in the file's queue.
export function writeJsonFile(fileName, data) {
    return withFileLock(fileName, () => writeJson(fileName, data));
}
