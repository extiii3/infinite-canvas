// Pure three-way merges for the shared workspace's multi-item keys (no store imports: used at boot).
// Values are the zustand persist JSON strings: {"state":{...},"version":N}.

type Item = { id?: string } & Record<string, unknown>;
type Persisted = { state?: Record<string, unknown>; version?: number };

const time = (item: Item | undefined, field: string) => {
    const value = item?.[field];
    if (typeof value === "number") return value;
    const parsed = typeof value === "string" ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
};

const byId = (items: unknown) => {
    const map = new Map<string, Item>();
    if (Array.isArray(items)) for (const item of items as Item[]) if (item?.id) map.set(item.id, item);
    return map;
};

/**
 * Merge arrays of {id, <timeField>} items. Newer edit wins; an item missing on one side is treated as
 * deleted there if it existed in base, unless the other side edited it after base (edit beats delete).
 */
export function mergeItems(base: unknown, local: unknown, remote: unknown, timeField: string): Item[] {
    const B = byId(base);
    const L = byId(local);
    const R = byId(remote);
    const out: Item[] = [];
    for (const id of new Set([...L.keys(), ...R.keys()])) {
        const l = L.get(id);
        const r = R.get(id);
        const b = B.get(id);
        if (l && r) out.push(time(l, timeField) > time(r, timeField) ? l : r); // tie -> server copy wins (convergence)
        else if (l) {
            if (!b || time(l, timeField) > time(b, timeField)) out.push(l);
        } else if (r) {
            if (!b || time(r, timeField) > time(b, timeField)) out.push(r);
        }
    }
    // Deterministic order (ties broken by id) so every browser serializes the same merge identically.
    return out.sort((a, b) => time(b, timeField) - time(a, timeField) || String(a.id).localeCompare(String(b.id)));
}

const parse = (value: unknown): Persisted | null => {
    if (typeof value !== "string") return null;
    try {
        return JSON.parse(value) as Persisted;
    } catch {
        return null;
    }
};

/** Canvas store: projects merged by updatedAt, tombstones (deletedProjects) unioned and applied. */
export function mergeCanvasValue(base: unknown, local: unknown, remote: unknown): unknown {
    const b = parse(base);
    const l = parse(local);
    const r = parse(remote);
    if (!l?.state) return remote;
    if (!r?.state) return local;
    const deletedAt = new Map<string, string>();
    for (const list of [r.state.deletedProjects, l.state.deletedProjects]) {
        if (!Array.isArray(list)) continue;
        for (const item of list as Array<{ id?: string; deletedAt?: string }>) {
            if (!item?.id || !item.deletedAt) continue;
            const current = deletedAt.get(item.id);
            if (!current || item.deletedAt > current) deletedAt.set(item.id, item.deletedAt);
        }
    }
    const projects = mergeItems(b?.state?.projects, l.state.projects, r.state.projects, "updatedAt").filter((project) => {
        const at = deletedAt.get(project.id!);
        if (!at) return true;
        if (time(project, "updatedAt") > Date.parse(at)) {
            deletedAt.delete(project.id!);
            return true;
        }
        return false;
    });
    const deletedProjects = [...deletedAt.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, at]) => ({ id, deletedAt: at }));
    return JSON.stringify({ state: { projects, deletedProjects }, version: r.version ?? l.version ?? 0 });
}

/** Asset store: assets merged by updatedAt (three-way, so deletions propagate). */
export function mergeAssetValue(base: unknown, local: unknown, remote: unknown): unknown {
    const b = parse(base);
    const l = parse(local);
    const r = parse(remote);
    if (!l?.state) return remote;
    if (!r?.state) return local;
    const assets = mergeItems(b?.state?.assets, l.state.assets, r.state.assets, "updatedAt");
    return JSON.stringify({ state: { assets }, version: r.version ?? l.version ?? 0 });
}

export const CANVAS_KEY = "infinite-canvas:canvas_store";
export const ASSET_KEY = "infinite-canvas:asset_store";
