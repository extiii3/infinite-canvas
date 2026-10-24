// Storage boot must finish before the app (and its persisted stores) is imported.
import { bootServerStorage } from "@/lib/server-storage/boot";

void (async () => {
    let rev: number | null = null;
    try {
        rev = await bootServerStorage();
    } catch (error) {
        console.error("[server-storage] boot failed, running browser-only", error);
    }
    await import("./app");
    if (rev !== null) {
        const { startLive } = await import("@/lib/server-storage/live");
        startLive(rev);
    }
})();
