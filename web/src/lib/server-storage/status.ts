// Observable sync status for the UI (no app imports: safe to load before boot).

export type SyncStatus = {
    mode: "cloud" | "local";
    online: boolean;
    pending: number;
    lastSyncAt: number | null;
};

let status: SyncStatus = { mode: "local", online: true, pending: 0, lastSyncAt: null };
const listeners = new Set<() => void>();

export function getSyncStatus() {
    return status;
}

export function subscribeSyncStatus(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function updateSyncStatus(patch: Partial<SyncStatus>) {
    const next = { ...status, ...patch };
    if (next.mode === status.mode && next.online === status.online && next.pending === status.pending && next.lastSyncAt === status.lastSyncAt) return;
    status = next;
    listeners.forEach((listener) => listener());
}

/** Keys with writes not yet confirmed by the server (in flight or waiting for retry). */
const pendingKeys = new Set<string>();

export function markPending(fk: string, isPending: boolean) {
    if (isPending) pendingKeys.add(fk);
    else pendingKeys.delete(fk);
    updateSyncStatus({ pending: pendingKeys.size });
}
