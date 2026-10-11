import { files, requests, failNext } from './harness/st.js';
import { readMemoryFile, readMemoryFileQueued, updateMemoryFile, deleteMemoryFile } from '../src/memory/storage.js';

const NAME = 'archivist-memories-test-00000000.json';

describe('readMemoryFile', () => {
    it('returns [] for a file that does not exist yet', async () => {
        await expect(readMemoryFile(NAME)).resolves.toEqual([]);
    });

    it('reads a stored list, bypassing the browser cache', async () => {
        files.set(NAME, JSON.stringify([{ id: 'a' }]));
        await expect(readMemoryFile(NAME)).resolves.toEqual([{ id: 'a' }]);
        expect(requests[0].options.cache).toBe('no-store');
    });

    it('throws for a file that is not a list, or not JSON', async () => {
        files.set(NAME, '{"id":"a"}');
        await expect(readMemoryFile(NAME)).rejects.toThrow('does not hold a list');
        files.set(NAME, 'not json');
        await expect(readMemoryFile(NAME)).rejects.toThrow();
    });

    it('throws on a server error', async () => {
        failNext('GET', '/user/files/');
        await expect(readMemoryFile(NAME)).rejects.toThrow('(500)');
    });
});

describe('updateMemoryFile', () => {
    it('writes through the upload endpoint with request headers, as UTF-8', async () => {
        const text = 'Mira — “the key” 🗝️ 日本語';
        const written = await updateMemoryFile(NAME, (records) => records.concat([{ id: 'a', text }]));

        expect(written).toEqual([{ id: 'a', text }]);
        expect(JSON.parse(files.get(NAME))).toEqual([{ id: 'a', text }]);
        const upload = requests.find((r) => r.url === '/api/files/upload');
        expect(upload.body.name).toBe(NAME);
        expect(upload.options.headers['X-CSRF-Token']).toBe('test');
    });

    it('runs changes to one file one at a time, in call order', async () => {
        const appends = Array.from({ length: 10 }, (_, i) => updateMemoryFile(NAME, async (records) => {
            await new Promise((resolve) => setTimeout(resolve, 10 - i));
            return records.concat([{ id: `r${i}` }]);
        }));
        await Promise.all(appends);
        expect(JSON.parse(files.get(NAME)).map((r) => r.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    });

    it('keeps the file untouched, and later changes working, when one change fails', async () => {
        files.set(NAME, JSON.stringify([{ id: 'kept' }]));
        const failing = updateMemoryFile(NAME, () => { throw new Error('boom'); });
        const next = updateMemoryFile(NAME, (records) => records.concat([{ id: 'next' }]));

        await expect(failing).rejects.toThrow('boom');
        await expect(next).resolves.toEqual([{ id: 'kept' }, { id: 'next' }]);
    });

    it('never overwrites a damaged file', async () => {
        files.set(NAME, 'damaged');
        await expect(updateMemoryFile(NAME, (records) => records.concat([{ id: 'a' }]))).rejects.toThrow();
        expect(files.get(NAME)).toBe('damaged');
    });

    it('rejects a change that does not return a list', async () => {
        await expect(updateMemoryFile(NAME, () => null)).rejects.toThrow('must produce a list');
        expect(files.has(NAME)).toBe(false);
    });

    it('reports a failed upload', async () => {
        failNext('POST', '/api/files/upload');
        await expect(updateMemoryFile(NAME, () => [])).rejects.toThrow('(500)');
    });
});

describe('readMemoryFileQueued', () => {
    it('waits for queued writes before reading', async () => {
        const write = updateMemoryFile(NAME, async (records) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return records.concat([{ id: 'a' }]);
        });
        const read = readMemoryFileQueued(NAME);
        await write;
        await expect(read).resolves.toEqual([{ id: 'a' }]);
    });
});

describe('deleteMemoryFile', () => {
    it('deletes through the delete endpoint by user/files path', async () => {
        files.set(NAME, '[]');
        await deleteMemoryFile(NAME);
        expect(files.has(NAME)).toBe(false);
        expect(requests.at(-1).body).toEqual({ path: `user/files/${NAME}` });
    });

    it('treats an already-missing file as deleted', async () => {
        await expect(deleteMemoryFile(NAME)).resolves.toBeUndefined();
    });

    it('reports other failures', async () => {
        failNext('POST', '/api/files/delete');
        await expect(deleteMemoryFile(NAME)).rejects.toThrow('(500)');
    });
});
