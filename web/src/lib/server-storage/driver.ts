// localforage driver backed by the storage server, with the browser's IndexedDB as a cache.
// JSON values: server-first (revalidated with If-None-Match), cache fallback when offline.
// Blobs (images/videos): cache-first, immutable, never deleted server-side by clients.
import { OfflineError, storageApi } from "./client";
import { acknowledge, BLOB_STORES, fullKey, getCache, getMeta, hasMerger, schedulePush, setMeta } from "./core";

export const SERVER_DRIVER = "infiniteCanvasServerStorage";

type State = { db: string; store: string; cache: LocalForage };
type Instance = { _ss: State };
type Callback<T> = ((err: unknown, value?: T) => void) | undefined;

function withCallback<T>(promise: Promise<T>, callback: Callback<T>) {
    if (callback) promise.then((value) => callback(null, value), (error) => callback(error));
    return promise;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readBlobWithRetry(state: State, key: string) {
    // Another browser may still be uploading media its canvas already references.
    for (const delay of [0, 500, 1000, 1500, 3000]) {
        if (delay) await sleep(delay);
        const remote = await storageApi.get(state.db, state.store, key);
        if (remote && remote !== "not-modified") return remote;
    }
    return null;
}

async function getItem(state: State, key: string): Promise<unknown> {
    const { db, store, cache } = state;
    const cached = await cache.getItem(key);
    if (cached instanceof Blob) return cached;
    const fk = fullKey(db, store, key);
    const meta = await getMeta(fk);
    if (meta?.dirty) {
        void schedulePush(db, store, key);
        return cached;
    }
    try {
        const remote = BLOB_STORES.has(store) && cached === null ? await readBlobWithRetry(state, key) : await storageApi.get(db, store, key, cached !== null && meta?.rev ? meta.rev : undefined);
        if (remote === "not-modified") return cached;
        if (remote === null) {
            if (meta?.rev) {
                await cache.removeItem(key); // deleted by someone else
                await setMeta(fk, null);
                return null;
            }
            if (cached !== null) void schedulePush(db, store, key, { createOnly: true });
            return cached;
        }
        if (cached !== null && !meta && hasMerger(fk)) {
            // Unsynced local value vs shared value: merge instead of discarding either side.
            await setMeta(fk, { rev: 0, dirty: true });
            void schedulePush(db, store, key);
            return cached;
        }
        await cache.setItem(key, remote.value);
        await acknowledge(fk, remote.value, remote.rev);
        return remote.value;
    } catch (error) {
        if (!(error instanceof OfflineError)) console.warn("[server-storage] read failed", key, error);
        return cached;
    }
}

async function setItem(state: State, key: string, value: unknown) {
    const { db, store, cache } = state;
    const stored = value === undefined ? null : value;
    await cache.setItem(key, stored);
    const fk = fullKey(db, store, key);
    const meta = await getMeta(fk);
    await setMeta(fk, { rev: meta?.rev ?? 0, dirty: true });
    void schedulePush(db, store, key);
    return stored;
}

async function removeItem(state: State, key: string) {
    const { db, store, cache } = state;
    await cache.removeItem(key);
    if (BLOB_STORES.has(store)) return; // local cache eviction only
    const fk = fullKey(db, store, key);
    const meta = await getMeta(fk);
    await setMeta(fk, { rev: meta?.rev ?? 0, dirty: true, deleted: true });
    void schedulePush(db, store, key);
}

async function clear(state: State) {
    const { db, store, cache } = state;
    await cache.clear();
    if (BLOB_STORES.has(store)) return;
    await storageApi.clear(db, store).catch((error) => console.warn("[server-storage] clear failed", store, error));
}

/** Current key/value pairs, reconciled with the server (JSON stores) or from cache (blob stores). */
async function entries(state: State): Promise<Array<[string, unknown]>> {
    const { db, store, cache } = state;
    const local = async () => {
        const out: Array<[string, unknown]> = [];
        await cache.iterate((value, key) => {
            out.push([key, value]);
        });
        return out;
    };
    if (BLOB_STORES.has(store)) return local();

    let listing;
    try {
        listing = await storageApi.list(db, store, true);
    } catch (error) {
        if (!(error instanceof OfflineError)) console.warn("[server-storage] list failed", store, error);
        return local();
    }
    const out = new Map<string, unknown>();
    for (const item of listing.items) {
        const fk = fullKey(db, store, item.key);
        const meta = await getMeta(fk);
        if (meta?.dirty) {
            const cached = await cache.getItem(item.key);
            if (!meta.deleted && cached !== null) out.set(item.key, cached);
            continue;
        }
        if (item.kind === "json") {
            if (meta?.rev !== item.rev) {
                await cache.setItem(item.key, item.value);
                await acknowledge(fk, item.value, item.rev);
            }
            out.set(item.key, item.value);
        } else {
            out.set(item.key, await getItem(state, item.key));
        }
    }
    for (const key of await cache.keys()) {
        if (out.has(key)) continue;
        const fk = fullKey(db, store, key);
        const meta = await getMeta(fk);
        if (meta?.dirty) {
            if (!meta.deleted) out.set(key, await cache.getItem(key));
        } else if (meta?.rev) {
            await cache.removeItem(key); // deleted remotely
            await setMeta(fk, null);
        } else {
            out.set(key, await cache.getItem(key));
            void schedulePush(db, store, key, { createOnly: true });
        }
    }
    return [...out.entries()];
}

export const serverStorageDriver = {
    _driver: SERVER_DRIVER,
    _support: true,
    _initStorage(this: Instance, options: { name: string; storeName: string }) {
        this._ss = { db: options.name, store: options.storeName, cache: getCache(options.name, options.storeName) };
        return Promise.resolve();
    },
    getItem(this: Instance, key: string, callback?: Callback<unknown>) {
        return withCallback(getItem(this._ss, String(key)), callback);
    },
    setItem(this: Instance, key: string, value: unknown, callback?: Callback<unknown>) {
        return withCallback(setItem(this._ss, String(key), value), callback);
    },
    removeItem(this: Instance, key: string, callback?: Callback<void>) {
        return withCallback(removeItem(this._ss, String(key)), callback);
    },
    clear(this: Instance, callback?: Callback<void>) {
        return withCallback(clear(this._ss), callback);
    },
    iterate(this: Instance, iterator: (value: unknown, key: string, iterationNumber: number) => unknown, callback?: Callback<unknown>) {
        const run = async () => {
            let n = 1;
            for (const [key, value] of await entries(this._ss)) {
                const result = iterator(value, key, n++);
                if (result !== undefined) return result;
            }
            return undefined;
        };
        return withCallback(run(), callback);
    },
    keys(this: Instance, callback?: Callback<string[]>) {
        return withCallback(
            entries(this._ss).then((list) => list.map(([key]) => key)),
            callback,
        );
    },
    length(this: Instance, callback?: Callback<number>) {
        return withCallback(
            entries(this._ss).then((list) => list.length),
            callback,
        );
    },
    key(this: Instance, n: number, callback?: Callback<string | null>) {
        return withCallback(
            entries(this._ss).then((list) => list[n]?.[0] ?? null),
            callback,
        );
    },
};
