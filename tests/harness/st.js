// A stand-in for the parts of SillyTavern Archivist talks to: the
// SillyTavern.getContext() object and the user-files endpoints, backed by
// an in-memory "disk" (files: name -> text).

export const files = new Map();
export const requests = [];

let context;

const listeners = new Map();
export const eventSource = {
    on(event, fn) { (listeners.get(event) ?? listeners.set(event, []).get(event)).push(fn); },
    emit: vi.fn(async (event, ...args) => { for (const fn of listeners.get(event) ?? []) await fn(...args); }),
};

// Fresh context for each test. Defaults to an open solo chat "Chat A" with
// the character Alice (avatar alice.png).
export function resetSillyTavern(overrides = {}) {
    files.clear();
    requests.length = 0;
    listeners.clear();
    eventSource.emit.mockClear();
    context = {
        chatId: 'Chat A',
        characterId: 0,
        groupId: null,
        characters: [{ name: 'Alice', avatar: 'alice.png' }, { name: 'Bob', avatar: 'bob.png' }],
        groups: [{ id: 'g1', name: 'Party', chat_id: 'Party Chat' }],
        extensionSettings: {},
        saveSettingsDebounced: vi.fn(),
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test' }),
        eventSource,
        eventTypes: { CHAT_CHANGED: 'chat_id_changed' },
        ...overrides,
    };
    return context;
}

export const getContext = () => context;

// Opens a different chat, the way SillyTavern's context reflects it.
export function openChat({ chatId, characterId = 0, groupId = null }) {
    Object.assign(context, { chatId, characterId, groupId });
}

const decodeBase64 = (data) => new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));

// Mirrors the server: GET /user/files/<name>, POST /api/files/upload and
// /api/files/delete. `failNext` makes the next matching request fail.
const failures = [];
export function failNext(method, pathStart, status = 500) {
    failures.push({ method, pathStart, status });
}

export async function fakeFetch(url, options = {}) {
    const method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method, url, body, options });

    const failure = failures.findIndex((f) => f.method === method && url.startsWith(f.pathStart));
    if (failure !== -1) return new Response('fail', { status: failures.splice(failure, 1)[0].status });

    if (method === 'GET' && url.startsWith('/user/files/')) {
        const name = decodeURIComponent(url.slice('/user/files/'.length));
        return files.has(name) ? new Response(files.get(name), { status: 200 }) : new Response('Not found', { status: 404 });
    }
    if (method === 'POST' && url === '/api/files/upload') {
        if (!/^[a-zA-Z0-9_\-.]+$/.test(body.name)) return new Response('Illegal character in filename', { status: 400 });
        files.set(body.name, decodeBase64(body.data));
        return Response.json({ path: `user/files/${body.name}` });
    }
    if (method === 'POST' && url === '/api/files/delete') {
        const name = body.path.replace(/^user\/files\//, '');
        if (!files.has(name)) return new Response('File not found', { status: 404 });
        files.delete(name);
        return new Response('OK', { status: 200 });
    }
    return new Response('Unknown endpoint', { status: 404 });
}
