import { useEffect } from "react";

import { syncAppDataToWebdav } from "@/services/app-sync";
import { useConfigStore } from "@/stores/use-config-store";

const INTERVAL_MS = 5 * 60_000; // periodic push while the tab is open
const IDLE_MS = 60_000; // periodic sync only runs after this long without input, so it never merges mid-edit
const STARTUP_DELAY_MS = 3_000;

let running = false;

/**
 * Keeps the WebDAV copy authoritative: pulls on open, pushes when the tab is hidden/closed,
 * and syncs every few minutes while idle. Active whenever a WebDAV URL is configured.
 */
export function useWebdavAutoSync() {
    const url = useConfigStore((state) => state.webdav.url.trim());

    useEffect(() => {
        if (!url) return;
        let lastInputAt = Date.now();

        const sync = async () => {
            if (running) return;
            const { webdav, updateWebdavConfig } = useConfigStore.getState();
            if (!webdav.url.trim()) return;
            running = true;
            try {
                const result = await syncAppDataToWebdav(webdav);
                updateWebdavConfig("lastSyncedAt", result.syncedAt);
            } catch (error) {
                console.warn("[webdav auto-sync]", error);
            } finally {
                running = false;
            }
        };

        const markInput = () => {
            lastInputAt = Date.now();
        };
        const onVisibility = () => {
            if (document.visibilityState === "hidden") void sync();
        };
        const tick = () => {
            if (document.visibilityState === "visible" && Date.now() - lastInputAt < IDLE_MS) return;
            void sync();
        };

        const startup = window.setTimeout(() => void sync(), STARTUP_DELAY_MS);
        const timer = window.setInterval(tick, INTERVAL_MS);
        const inputEvents = ["pointerdown", "keydown", "wheel"] as const;
        inputEvents.forEach((name) => window.addEventListener(name, markInput, { passive: true }));
        document.addEventListener("visibilitychange", onVisibility);

        return () => {
            window.clearTimeout(startup);
            window.clearInterval(timer);
            inputEvents.forEach((name) => window.removeEventListener(name, markInput));
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [url]);
}
