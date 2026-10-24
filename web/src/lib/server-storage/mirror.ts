// Mirrors selected localStorage keys (synchronous zustand stores: provider/model config, prompt sources)
// to the storage server. Last write wins; values are pulled before the app's stores are created.
import { OfflineError, storageApi } from "./client";
import { ownRevs } from "./core";

export const MIRROR_DB = "__localStorage";
export const MIRROR_STORE = "default";
export const MIRRORED_KEYS = new Set(["infinite-canvas:ai_config_store", "infinite-canvas:prompt_source_store_v2"]);

const revs = new Map<string, number>();
const lastSynced = new Map<string, string | null>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let originalSet: (this: Storage, key: string, value: string) => void;
let originalRemove: (this: Storage, key: string) => void;

const setLocal = (key: string, value: string) => originalSet.call(window.localStorage, key, value);

async function push(key: string) {
    const value = window.localStorage.getItem(key);
    if (value === lastSynced.get(key)) return;
    try {
        if (value === null) {
            ownRevs.add(await storageApi.remove(MIRROR_DB, MIRROR_STORE, key));
            revs.delete(key);
        } else {
            let result = await storageApi.put(MIRROR_DB, MIRROR_STORE, key, value, revs.get(key) ?? 0);
            if (!result.ok) result = await storageApi.put(MIRROR_DB, MIRROR_STORE, key, value); // last write wins
            if (result.ok) {
                ownRevs.add(result.rev);
                revs.set(key, result.rev);
            }
        }
        lastSynced.set(key, value);
    } catch (error) {
        if (!(error instanceof OfflineError)) console.warn("[server-storage] config push failed", key, error);
        schedule(key, 10_000);
    }
}

function schedule(key: string, delay = 500) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => void push(key), delay));
}

/** Pull shared values into localStorage (before stores are created) and start mirroring writes. */
export async function startMirror() {
    originalSet = Storage.prototype.setItem;
    originalRemove = Storage.prototype.removeItem;
    for (const key of MIRRORED_KEYS) {
        try {
            const remote = await storageApi.get(MIRROR_DB, MIRROR_STORE, key);
            if (remote && remote !== "not-modified" && typeof remote.value === "string") {
                setLocal(key, remote.value);
                revs.set(key, remote.rev);
                lastSynced.set(key, remote.value);
            } else if (remote === null && window.localStorage.getItem(key) !== null) {
                schedule(key, 0); // first run: share this browser's config
            }
        } catch (error) {
            if (!(error instanceof OfflineError)) console.warn("[server-storage] config pull failed", key, error);
        }
    }
    Storage.prototype.setItem = function (key: string, value: string) {
        originalSet.call(this, key, value);
        if (this === window.localStorage && MIRRORED_KEYS.has(key)) schedule(key);
    };
    Storage.prototype.removeItem = function (key: string) {
        originalRemove.call(this, key);
        if (this === window.localStorage && MIRRORED_KEYS.has(key)) schedule(key);
    };
}

/** Another browser changed a mirrored key: refresh localStorage and rehydrate the owning store. */
export async function applyMirrorChange(key: string, rev: number) {
    if (revs.get(key) === rev) return;
    const remote = await storageApi.get(MIRROR_DB, MIRROR_STORE, key);
    if (!remote || remote === "not-modified" || typeof remote.value !== "string") return;
    setLocal(key, remote.value);
    revs.set(key, remote.rev);
    lastSynced.set(key, remote.value);
    if (key === "infinite-canvas:ai_config_store") {
        const { useConfigStore } = await import("@/stores/use-config-store");
        await useConfigStore.persist.rehydrate();
    } else if (key === "infinite-canvas:prompt_source_store_v2") {
        const { usePromptSourceStore } = await import("@/stores/use-prompt-source-store");
        await usePromptSourceStore.persist.rehydrate();
    }
}
