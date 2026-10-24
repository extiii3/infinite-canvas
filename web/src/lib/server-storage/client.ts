// HTTP client for the storage server (/api, same origin, behind Cloudflare Access).

export const API_BASE = "/api";

export type Kind = "json" | "blob";
export type RemoteValue = { value: unknown; rev: number; kind: Kind };
export type PutResult = { ok: true; rev: number } | { ok: false; conflict: RemoteValue | null };
export type ListItem = { key: string; rev: number; kind: Kind; mime: string; size: number; value?: unknown };
export type Change = { db: string; store: string; key: string; rev: number; deleted: boolean; kind: Kind };

export class OfflineError extends Error {
    constructor(message = "storage server unreachable") {
        super(message);
        this.name = "OfflineError";
    }
}

function kvUrl(db: string, store: string, key?: string) {
    const parts = [db, store, ...(key === undefined ? [] : [key])].map(encodeURIComponent);
    return `${API_BASE}/kv/${parts.join("/")}`;
}

async function call(url: string, init?: RequestInit): Promise<Response> {
    let response: Response;
    try {
        response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "manual", ...init });
    } catch (error) {
        throw new OfflineError(error instanceof Error ? error.message : String(error));
    }
    // Cloudflare Access session expiry shows up as a redirect / opaque response.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400 && response.status !== 304)) throw new OfflineError("session expired");
    if (response.status >= 500) throw new OfflineError(`server error ${response.status}`);
    return response;
}

async function decode(response: Response): Promise<RemoteValue> {
    const rev = Number(response.headers.get("X-KV-Rev")) || 0;
    const kind = (response.headers.get("X-KV-Kind") === "blob" ? "blob" : "json") as Kind;
    if (kind === "blob") {
        const blob = await response.blob();
        const type = response.headers.get("Content-Type") || blob.type;
        return { value: type && blob.type !== type ? new Blob([blob], { type }) : blob, rev, kind };
    }
    return { value: await response.json(), rev, kind };
}

export const storageApi = {
    async health(): Promise<{ ok: boolean; rev: number } | null> {
        try {
            const response = await call(`${API_BASE}/health`);
            if (!response.ok) return null;
            const data = await response.json();
            return data && data.ok === true ? data : null;
        } catch (error) {
            if (error instanceof OfflineError) throw error;
            return null; // not JSON (e.g. SPA fallback) -> no backend
        }
    },

    /** null = missing; "not-modified" when knownRev still current. */
    async get(db: string, store: string, key: string, knownRev?: number): Promise<RemoteValue | null | "not-modified"> {
        const headers: Record<string, string> = {};
        if (knownRev) headers["If-None-Match"] = `"${knownRev}"`;
        const response = await call(kvUrl(db, store, key), { headers });
        if (response.status === 304) return "not-modified";
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`storage GET ${response.status}`);
        return decode(response);
    },

    /** expectedRev: undefined = unconditional, 0 = must not exist, N = must match. */
    async put(db: string, store: string, key: string, value: unknown, expectedRev?: number): Promise<PutResult> {
        const isBlob = typeof Blob !== "undefined" && value instanceof Blob;
        const headers: Record<string, string> = {
            "X-KV-Kind": isBlob ? "blob" : "json",
            "Content-Type": isBlob ? (value as Blob).type || "application/octet-stream" : "application/json",
        };
        if (expectedRev !== undefined) headers["If-Match"] = String(expectedRev);
        const body = isBlob ? (value as Blob) : JSON.stringify(value === undefined ? null : value);
        const response = await call(kvUrl(db, store, key), { method: "PUT", headers, body });
        if (response.status === 409) {
            if (response.headers.get("X-KV-Rev") === "0") return { ok: false, conflict: null };
            return { ok: false, conflict: await decode(response) };
        }
        if (!response.ok) throw new Error(`storage PUT ${response.status}`);
        return { ok: true, rev: (await response.json()).rev };
    },

    async remove(db: string, store: string, key: string): Promise<number> {
        const response = await call(kvUrl(db, store, key), { method: "DELETE" });
        if (!response.ok) throw new Error(`storage DELETE ${response.status}`);
        return (await response.json()).rev;
    },

    async clear(db: string, store: string): Promise<number> {
        const response = await call(kvUrl(db, store), { method: "DELETE" });
        if (!response.ok) throw new Error(`storage CLEAR ${response.status}`);
        return (await response.json()).rev;
    },

    async list(db: string, store: string, withValues: boolean): Promise<{ rev: number; items: ListItem[] }> {
        const response = await call(`${kvUrl(db, store)}${withValues ? "?values=1" : ""}`);
        if (!response.ok) throw new Error(`storage LIST ${response.status}`);
        return response.json();
    },

    async changes(since: number): Promise<{ rev: number; more: boolean; changes: Change[] }> {
        const response = await call(`${API_BASE}/changes?since=${since}`);
        if (!response.ok) throw new Error(`storage CHANGES ${response.status}`);
        return response.json();
    },
};
