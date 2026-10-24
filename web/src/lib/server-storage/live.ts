// Loaded after the app: connects merged keys to live store state and polls the server for other users' changes.
import { resolveMediaUrl } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";

import { storageApi, OfflineError } from "./client";
import { applyRemoteChange, flushDirty, migrateOnce, ownRevs, registerApplier } from "./core";
import { ASSET_KEY, CANVAS_KEY } from "./merge";
import { applyMirrorChange, MIRROR_DB, MIRRORED_KEYS } from "./mirror";

const POLL_MS = 8_000;
const DB = "infinite-canvas";
const STORE = "app_state";

async function hydrateAsset(asset: Asset): Promise<Asset> {
    if (asset.kind === "image" && asset.data.storageKey) {
        const dataUrl = await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? dataUrl : asset.coverUrl, data: { ...asset.data, dataUrl } } as Asset;
    }
    if (asset.kind === "video" && asset.data.storageKey) {
        const url = await resolveMediaUrl(asset.data.storageKey, asset.data.url);
        return { ...asset, coverUrl: asset.coverUrl.startsWith("blob:") ? url : asset.coverUrl, data: { ...asset.data, url } } as Asset;
    }
    return asset;
}

function registerAppliers() {
    registerApplier(DB, STORE, CANVAS_KEY, {
        current: () => {
            const state = useCanvasStore.getState();
            if (!state.hydrated) return undefined;
            return JSON.stringify({ state: { projects: state.projects, deletedProjects: state.deletedProjects }, version: useCanvasStore.persist.getOptions().version ?? 0 });
        },
        apply: (merged) => {
            if (typeof merged !== "string") return;
            const { state } = JSON.parse(merged);
            useCanvasStore.getState().replaceProjects(state?.projects || [], state?.deletedProjects || []);
        },
    });
    registerApplier(DB, STORE, ASSET_KEY, {
        current: () => {
            const state = useAssetStore.getState();
            if (!state.hydrated) return undefined;
            return JSON.stringify({ state: { assets: state.assets }, version: useAssetStore.persist.getOptions().version ?? 0 });
        },
        apply: async (merged) => {
            if (typeof merged !== "string") return;
            const { state } = JSON.parse(merged);
            const assets = await Promise.all(((state?.assets || []) as Asset[]).map(hydrateAsset));
            useAssetStore.getState().replaceAssets(assets);
        },
    });
}

let since = 0;
let polling = false;

async function poll() {
    if (polling || document.visibilityState !== "visible") return;
    polling = true;
    try {
        for (;;) {
            const result = await storageApi.changes(since);
            for (const change of result.changes) {
                if (ownRevs.has(change.rev) || change.deleted) continue;
                if (change.db === MIRROR_DB && MIRRORED_KEYS.has(change.key)) await applyMirrorChange(change.key, change.rev);
                else await applyRemoteChange(change.db, change.store, change.key, change.rev);
            }
            since = result.rev;
            if (!result.more) break;
        }
    } catch (error) {
        if (!(error instanceof OfflineError)) console.warn("[server-storage] change poll failed", error);
    } finally {
        polling = false;
    }
}

export function startLive(initialRev: number) {
    since = initialRev;
    registerAppliers();
    setInterval(() => void poll(), POLL_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") {
            void flushDirty();
            void poll();
        }
    });
    window.addEventListener("online", () => void flushDirty());
    void flushDirty();
    void migrateOnce(true); // media upload runs in the background
}
