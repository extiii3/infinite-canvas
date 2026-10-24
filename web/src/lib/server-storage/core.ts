// Shared sync state for the server storage driver: per-key revisions, push queue with
// optimistic concurrency, merge resolvers, offline retry and first-run migration.
import localforage from "localforage";

import { OfflineError, storageApi } from "./client";

export const SYNCED_DBS = new Set(["infinite-canvas", "infinite-canvas-plugins"]);
/** Derived/cache data that stays in this browser only. */
export const LOCAL_ONLY_STORES = new Set(["prompt_cache", "image_previews"]);
/** Immutable media: cache-first reads, and clients never delete them server-side (shared workspace safety). */
export const BLOB_STORES = new Set(["image_files", "media_files"]);
/** Stores that exist in the original browser-only build and are migrated on first run. */
export const MIGRATE_STORES: Array<[string, string]> = [
    ["infinite-canvas", "app_state"],
    ["infinite-canvas", "image_generation_logs"],
    ["infinite-canvas", "video_generation_logs"],
    ["infinite-canvas", "image_files"],
    ["infinite-canvas", "media_files"],
];

type Meta = { rev: number; dirty?: boolean; deleted?: boolean };
/** Pure three-way merge of stored values (base = last server value we knew, or null). */
export type Merger = (base: unknown | null, local: unknown, remote: unknown) => unknown;
/** Bridges a merged key to live in-memory app state once the app has loaded. */
export type Applier = { current: () => unknown | undefined; apply: (merged: unknown) => Promise<void> | void };

const SEP = "\u0001";
export const fullKey = (db: string, store: string, key: string) => `${db}${SEP}${store}${SEP}${key}`;
const splitKey = (fk: string) => fk.split(SEP) as [string, string, string];

let createRaw: typeof localforage.createInstance;
const caches = new Map<string, LocalForage>();
let metaStore: LocalForage;
const metaMemo = new Map<string, Meta | null>();

const mergers = new Map<string, Merger>();
const appliers = new Map<string, Applier>();
const bases = new Map<string, unknown>();
/** JSON of the last value the server confirmed per key, to avoid echo pushes between browsers. */
const lastServer = new Map<string, string>();
export const ownRevs = new Set<number>();

export function initCore(rawCreateInstance: typeof localforage.createInstance) {
    createRaw = rawCreateInstance;
    metaStore = createRaw({ name: "infinite-canvas-sync", storeName: "meta", driver: localforage.INDEXEDDB });
}

/** Local IndexedDB cache: the same database/object store the browser-only build used, so existing data is picked up. */
export function getCache(db: string, store: string) {
    const id = `${db}${SEP}${store}`;
    let cache = caches.get(id);
    if (!cache) {
        cache = createRaw({ name: db, storeName: store, driver: localforage.INDEXEDDB });
        caches.set(id, cache);
    }
    return cache;
}

export async function getMeta(fk: string): Promise<Meta | null> {
    if (metaMemo.has(fk)) return metaMemo.get(fk)!;
    const meta = (await metaStore.getItem<Meta>(fk).catch(() => null)) || null;
    metaMemo.set(fk, meta);
    return meta;
}

export async function setMeta(fk: string, meta: Meta | null) {
    metaMemo.set(fk, meta);
    if (meta) await metaStore.setItem(fk, meta).catch(() => undefined);
    else await metaStore.removeItem(fk).catch(() => undefined);
}

const stableJson = (value: unknown) => {
    try {
        return JSON.stringify(value === undefined ? null : value);
    } catch {
        return "";
    }
};

/** Record a value the server just confirmed (read or write). */
export async function acknowledge(fk: string, value: unknown, rev: number) {
    await setMeta(fk, { rev });
    if (!(value instanceof Blob)) lastServer.set(fk, stableJson(value));
    if (mergers.has(fk)) bases.set(fk, value);
}

export function registerMerger(db: string, store: string, key: string, merger: Merger) {
    mergers.set(fullKey(db, store, key), merger);
}

export function registerApplier(db: string, store: string, key: string, applier: Applier) {
    appliers.set(fullKey(db, store, key), applier);
}

export const hasMerger = (fk: string) => mergers.has(fk);

/** Merge a remote value with our local one (live app state if loaded, else the cache) and apply it. */
async function resolve(fk: string, cache: LocalForage, key: string, base: unknown | null, remote: unknown) {
    const merger = mergers.get(fk)!;
    const applier = appliers.get(fk);
    const live = applier?.current();
    const local = live !== undefined ? live : await cache.getItem(key);
    const merged = local === null || local === undefined ? remote : merger(base, local, remote);
    await cache.setItem(key, merged);
    if (applier) await applier.apply(merged);
    return merged;
}

// ---------- push queue ----------

const inFlight = new Map<string, Promise<void>>();
const again = new Set<string>();
let retryTimer: ReturnType<typeof setTimeout> | null = null;

export function schedulePush(db: string, store: string, key: string, options: { createOnly?: boolean } = {}) {
    const fk = fullKey(db, store, key);
    const running = inFlight.get(fk);
    if (running) {
        again.add(fk);
        return running;
    }
    const run = (async () => {
        do {
            again.delete(fk);
            await pushOnce(db, store, key, options.createOnly === true);
        } while (again.has(fk));
    })()
        .catch((error) => {
            if (!(error instanceof OfflineError)) console.warn("[server-storage] push failed", key, error);
            scheduleRetry();
        })
        .finally(() => inFlight.delete(fk));
    inFlight.set(fk, run);
    return run;
}

async function pushOnce(db: string, store: string, key: string, createOnly: boolean) {
    const fk = fullKey(db, store, key);
    const cache = getCache(db, store);
    const isBlobStore = BLOB_STORES.has(store);
    let meta = await getMeta(fk);

    if (meta?.deleted) {
        if (!isBlobStore) ownRevs.add(await storageApi.remove(db, store, key));
        lastServer.delete(fk);
        await setMeta(fk, null);
        return;
    }

    for (let attempt = 0; attempt < 6; attempt += 1) {
        const value = await cache.getItem(key);
        if (value === null || value === undefined) {
            await setMeta(fk, meta?.rev ? { rev: meta.rev } : null);
            return;
        }
        if (!createOnly && !(value instanceof Blob) && meta?.rev && stableJson(value) === lastServer.get(fk)) {
            await setMeta(fk, { rev: meta.rev });
            return; // identical to what the server already has
        }
        const expected = isBlobStore ? undefined : createOnly || !meta?.rev ? (meta?.rev ?? 0) : meta.rev;
        const result = await storageApi.put(db, store, key, value, expected);
        if (result.ok) {
            ownRevs.add(result.rev);
            await acknowledge(fk, value, result.rev);
            return;
        }

        const remote = result.conflict;
        if (!remote) {
            // Expected a version that no longer exists (deleted remotely): recreate unless this was a migration.
            if (createOnly) return;
            meta = { rev: 0, dirty: true };
            continue;
        }
        if (mergers.has(fk)) {
            const base = bases.has(fk) ? bases.get(fk)! : null;
            await acknowledge(fk, remote.value, remote.rev);
            await resolve(fk, cache, key, base, remote.value);
            meta = { rev: remote.rev, dirty: true };
            await setMeta(fk, meta);
            continue;
        }
        if (createOnly) {
            // Migration must never overwrite shared data: adopt the server copy.
            await cache.setItem(key, remote.value);
            await acknowledge(fk, remote.value, remote.rev);
            return;
        }
        // Last write wins for keys without a resolver.
        meta = { rev: remote.rev, dirty: true };
        await setMeta(fk, meta);
    }
    throw new Error(`gave up after repeated conflicts on ${key}`);
}

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        void flushDirty();
    }, 10_000);
}

/** Push everything written while offline (or before a reload interrupted the push). */
export async function flushDirty() {
    const dirty: string[] = [];
    await metaStore
        .iterate<Meta, void>((meta, fk) => {
            if (meta?.dirty) dirty.push(fk);
        })
        .catch(() => undefined);
    for (const fk of dirty) {
        const [db, store, key] = splitKey(fk);
        void schedulePush(db, store, key);
    }
}

// ---------- remote change handling ----------

/** Pull a key another browser changed and merge it into live app state. */
export async function applyRemoteChange(db: string, store: string, key: string, rev: number) {
    const fk = fullKey(db, store, key);
    if (!mergers.has(fk) || !appliers.has(fk)) return;
    const meta = await getMeta(fk);
    if (meta?.rev === rev || meta?.dirty || inFlight.has(fk)) return; // our own push will reconcile
    const remote = await storageApi.get(db, store, key);
    if (!remote || remote === "not-modified") return;
    const base = bases.has(fk) ? bases.get(fk)! : null;
    await acknowledge(fk, remote.value, remote.rev);
    const merged = await resolve(fk, getCache(db, store), key, base, remote.value);
    if (stableJson(merged) !== lastServer.get(fk)) {
        await setMeta(fk, { rev: remote.rev, dirty: true });
        void schedulePush(db, store, key);
    }
}

// ---------- migration ----------

const MIGRATION_FLAG = "infinite-canvas:server-migrated:v1";

/** Upload data from the browser-only era once per browser. Never overwrites shared data (create-only / merge).
 * blobs=false migrates JSON stores (fast, run before the app starts); blobs=true migrates media (background). */
export async function migrateOnce(blobs: boolean) {
    const flag = `${MIGRATION_FLAG}:${blobs ? "media" : "data"}`;
    if (localStorage.getItem(flag)) return;
    let complete = true;
    for (const [db, store] of MIGRATE_STORES) {
        if (BLOB_STORES.has(store) !== blobs) continue;
        const cache = getCache(db, store);
        const keys = await cache.keys().catch(() => [] as string[]);
        for (const key of keys) {
            const fk = fullKey(db, store, key);
            if (await getMeta(fk)) continue;
            await schedulePush(db, store, key, { createOnly: true });
            if (!(await getMeta(fk)) && (await cache.getItem(key)) !== null) complete = false;
        }
    }
    if (complete) localStorage.setItem(flag, new Date().toISOString());
}
