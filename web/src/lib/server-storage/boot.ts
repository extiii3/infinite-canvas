// Runs before any store module is imported. If the storage server is present, every localforage
// instance in the synced databases is routed through the server driver and shared config is pulled.
// Without a server (plain static hosting / `bun run dev`) nothing changes and the app stays browser-only.
import localforage from "localforage";

import { OfflineError, storageApi } from "./client";
import { initCore, LOCAL_ONLY_STORES, migrateOnce, registerMerger, SYNCED_DBS } from "./core";
import { SERVER_DRIVER, serverStorageDriver } from "./driver";
import { ASSET_KEY, CANVAS_KEY, mergeAssetValue, mergeCanvasValue } from "./merge";
import { startMirror } from "./mirror";

const MODE_FLAG = "infinite-canvas:server-storage";

/** Returns the server revision to start change polling from, or null when running browser-only. */
export async function bootServerStorage(): Promise<number | null> {
    let rev = 0;
    try {
        const health = await storageApi.health();
        if (!health) {
            localStorage.removeItem(MODE_FLAG);
            return null;
        }
        rev = health.rev;
    } catch (error) {
        if (!(error instanceof OfflineError) || !localStorage.getItem(MODE_FLAG)) return null;
        // Known server deployment but offline right now: run from the cache and sync when back.
    }
    localStorage.setItem(MODE_FLAG, "1");

    const raw = localforage.createInstance.bind(localforage);
    initCore(raw);
    await localforage.defineDriver(serverStorageDriver as unknown as LocalForageDriver);
    localforage.createInstance = ((options?: LocalForageOptions) => {
        const name = options?.name ?? "localforage";
        const storeName = options?.storeName ?? "keyvaluepairs";
        if (SYNCED_DBS.has(name) && !LOCAL_ONLY_STORES.has(storeName) && !options?.driver) return raw({ ...options, driver: SERVER_DRIVER });
        return raw(options ?? {});
    }) as typeof localforage.createInstance;
    localforage.config({ name: "infinite-canvas", storeName: "app_state" });
    await localforage.setDriver(SERVER_DRIVER);

    registerMerger("infinite-canvas", "app_state", CANVAS_KEY, mergeCanvasValue);
    registerMerger("infinite-canvas", "app_state", ASSET_KEY, mergeAssetValue);

    await startMirror();
    await migrateOnce(false).catch((error) => console.warn("[server-storage] migration incomplete", error));
    return rev;
}
