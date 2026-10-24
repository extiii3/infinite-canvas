// Infinite Canvas storage server: a revisioned key-value + blob store for the shared workspace.
// Runs on 127.0.0.1 behind nginx (/api/*), which enforces the Cloudflare origin secret.
//
//   GET    /api/health                       -> { ok, rev }
//   GET    /api/stats                        -> { keys, files, bytes, rev }
//   GET    /api/changes?since=N              -> { rev, more, changes: [{ db, store, key, rev, deleted, kind }] }
//   GET    /api/kv/:db/:store[?values=1]     -> { rev, items: [{ key, rev, kind, mime, size, value? }] }
//   GET    /api/kv/:db/:store/:key           -> raw value (X-KV-Rev, X-KV-Kind); 304 on If-None-Match
//   PUT    /api/kv/:db/:store/:key           -> { rev }; If-Match: N (0 = must not exist) -> 409 + current value on mismatch
//   DELETE /api/kv/:db/:store/:key           -> { rev }
//   DELETE /api/kv/:db/:store                -> { rev }  (tombstones every non-blob key in the store)
import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { loadUpstreams, proxyUpstream } from "./upstream";

const DATA_DIR = process.env.STORAGE_DIR || "/data/server";
const BLOB_DIR = join(DATA_DIR, "blobs");
const PORT = Number(process.env.STORAGE_PORT || 8787);
const HOST = process.env.STORAGE_HOST || "127.0.0.1";
const MAX_BODY = 200 * 1024 * 1024;
const LOG_STORAGE = (process.env.LOG_STORAGE || "writes").toLowerCase(); // all | writes | off
const upstreams = loadUpstreams();

mkdirSync(BLOB_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, "app.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  db TEXT NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL,
  kind TEXT NOT NULL, mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
  value BLOB, file TEXT, rev INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (db, store, key)
);
CREATE INDEX IF NOT EXISTS kv_rev ON kv (rev);
CREATE TABLE IF NOT EXISTS seq (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
INSERT OR IGNORE INTO seq (id, rev) VALUES (1, 0);
`);

type Row = { db: string; store: string; key: string; kind: string; mime: string; size: number; value: Uint8Array | null; file: string | null; rev: number; deleted: number };

const q = {
  rev: db.query<{ rev: number }, []>("SELECT rev FROM seq WHERE id = 1"),
  bump: db.query<{ rev: number }, []>("UPDATE seq SET rev = rev + 1 WHERE id = 1 RETURNING rev"),
  get: db.query<Row, [string, string, string]>("SELECT * FROM kv WHERE db = ? AND store = ? AND key = ?"),
  list: db.query<Row, [string, string]>("SELECT * FROM kv WHERE db = ? AND store = ? AND deleted = 0 ORDER BY key"),
  listMeta: db.query<Omit<Row, "value">, [string, string]>("SELECT db, store, key, kind, mime, size, file, rev, deleted FROM kv WHERE db = ? AND store = ? AND deleted = 0 ORDER BY key"),
  upsert: db.query(
    `INSERT INTO kv (db, store, key, kind, mime, size, value, file, rev, deleted, updated_at)
     VALUES ($db, $store, $key, $kind, $mime, $size, $value, $file, $rev, 0, $now)
     ON CONFLICT (db, store, key) DO UPDATE SET kind = $kind, mime = $mime, size = $size, value = $value, file = $file, rev = $rev, deleted = 0, updated_at = $now`,
  ),
  tomb: db.query("UPDATE kv SET deleted = 1, value = NULL, file = NULL, size = 0, rev = $rev, updated_at = $now WHERE db = $db AND store = $store AND key = $key"),
  stats: db.query<{ keys: number; files: number; bytes: number }, []>(
    "SELECT COUNT(*) AS keys, COALESCE(SUM(kind = 'blob'), 0) AS files, COALESCE(SUM(size), 0) AS bytes FROM kv WHERE deleted = 0",
  ),
  changes: db.query<{ db: string; store: string; key: string; rev: number; deleted: number; kind: string }, [number, number]>(
    "SELECT db, store, key, rev, deleted, kind FROM kv WHERE rev > ? ORDER BY rev LIMIT ?",
  ),
};

const currentRev = () => q.rev.get()!.rev;
const nextRev = () => q.bump.get()!.rev;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

function removeFile(file: string | null) {
  if (!file) return;
  try {
    unlinkSync(join(BLOB_DIR, file));
  } catch {
    /* already gone */
  }
}

function valueResponse(row: Row, status = 200) {
  const headers: Record<string, string> = {
    "X-KV-Rev": String(row.rev),
    "X-KV-Kind": row.kind,
    ETag: `"${row.rev}"`,
    "Cache-Control": "no-cache",
    "Content-Type": row.mime || (row.kind === "json" ? "application/json" : "application/octet-stream"),
  };
  if (row.kind === "blob" && row.file) return new Response(Bun.file(join(BLOB_DIR, row.file)), { status, headers });
  return new Response(row.value ?? new Uint8Array(), { status, headers });
}

function parseIfMatch(header: string | null): number | null {
  if (header === null) return null;
  const n = Number(header.replace(/"/g, "").trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

async function putValue(req: Request, dbName: string, store: string, key: string) {
  const kind = req.headers.get("X-KV-Kind") === "blob" ? "blob" : "json";
  const mime = (req.headers.get("Content-Type") || "").slice(0, 200);
  const expected = parseIfMatch(req.headers.get("If-Match"));
  const body = new Uint8Array(await req.arrayBuffer());
  if (kind === "json") {
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json({ error: "json value expected" }, 400);
    }
  }

  // Blob bytes are written before the transaction so the DB never points at a missing file.
  const file = kind === "blob" ? `${crypto.randomUUID()}` : null;
  if (file) await Bun.write(join(BLOB_DIR, file), body);

  let conflict: Row | null = null;
  let oldFile: string | null = null;
  let rev = 0;
  db.transaction(() => {
    const row = q.get.get(dbName, store, key);
    const currentRevForKey = row && !row.deleted ? row.rev : 0;
    if (expected !== null && expected !== currentRevForKey) {
      conflict = row && !row.deleted ? row : ({ rev: 0 } as Row);
      return;
    }
    oldFile = row?.file ?? null;
    rev = nextRev();
    q.upsert.run({ $db: dbName, $store: store, $key: key, $kind: kind, $mime: mime, $size: body.byteLength, $value: kind === "json" ? body : null, $file: file, $rev: rev, $now: Date.now() });
  })();

  if (conflict) {
    removeFile(file);
    const row = conflict as Row;
    if (!row.rev) return json({ error: "conflict", missing: true }, 409, { "X-KV-Rev": "0" });
    return valueResponse(row, 409);
  }
  removeFile(oldFile);
  return json({ rev }, 200, { "X-KV-Rev": String(rev) });
}

function deleteValue(dbName: string, store: string, key: string) {
  let rev = currentRev();
  let oldFile: string | null = null;
  db.transaction(() => {
    const row = q.get.get(dbName, store, key);
    if (!row || row.deleted) return;
    oldFile = row.file;
    rev = nextRev();
    q.tomb.run({ $rev: rev, $now: Date.now(), $db: dbName, $store: store, $key: key });
  })();
  removeFile(oldFile);
  return json({ rev });
}

function clearStore(dbName: string, store: string) {
  let rev = currentRev();
  db.transaction(() => {
    for (const row of q.listMeta.all(dbName, store)) {
      if (row.kind === "blob") continue; // blobs are immutable and never cleared by clients
      rev = nextRev();
      q.tomb.run({ $rev: rev, $now: Date.now(), $db: dbName, $store: store, $key: row.key });
    }
  })();
  return json({ rev });
}

function listStore(dbName: string, store: string, withValues: boolean) {
  const rows = withValues ? q.list.all(dbName, store) : q.listMeta.all(dbName, store);
  const decoder = new TextDecoder();
  const items = rows.map((row) => {
    const item: Record<string, unknown> = { key: row.key, rev: row.rev, kind: row.kind, mime: row.mime, size: row.size };
    if (withValues && row.kind === "json" && (row as Row).value) item.value = JSON.parse(decoder.decode((row as Row).value!));
    return item;
  });
  return json({ rev: currentRev(), items });
}

function changes(since: number) {
  const limit = 1000;
  const rows = q.changes.all(since, limit);
  const rev = rows.length ? rows[rows.length - 1].rev : Math.max(since, currentRev());
  return json({ rev, more: rows.length === limit, changes: rows.map((r) => ({ ...r, deleted: !!r.deleted })) });
}

function segments(pathname: string) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

async function handleApi(req: Request, url: URL): Promise<Response> {
    let parts: string[];
    try {
      parts = segments(url.pathname);
    } catch {
      return json({ error: "bad path" }, 400);
    }
    if (parts[0] !== "api") return json({ error: "not found" }, 404);
    const [, route, dbName, store, key, ...extra] = parts;
    try {
      if (route === "health" && req.method === "GET") return json({ ok: true, rev: currentRev() });
      if (route === "stats" && req.method === "GET") return json({ ...q.stats.get()!, rev: currentRev() });
      if (route === "changes" && req.method === "GET") return changes(Math.max(0, Number(url.searchParams.get("since")) || 0));
      if (route !== "kv" || !dbName || !store || extra.length) return json({ error: "not found" }, 404);
      if (!key) {
        if (req.method === "GET") return listStore(dbName, store, url.searchParams.get("values") === "1");
        if (req.method === "DELETE") return clearStore(dbName, store);
        return json({ error: "method not allowed" }, 405);
      }
      if (req.method === "GET" || req.method === "HEAD") {
        const row = q.get.get(dbName, store, key);
        if (!row || row.deleted) return json({ error: "not found" }, 404, { "X-KV-Rev": "0" });
        if (req.headers.get("If-None-Match")?.replace(/"/g, "") === String(row.rev)) {
          return new Response(null, { status: 304, headers: { "X-KV-Rev": String(row.rev), "X-KV-Kind": row.kind, ETag: `"${row.rev}"` } });
        }
        return valueResponse(row);
      }
      if (req.method === "PUT") return await putValue(req, dbName, store, key);
      if (req.method === "DELETE") return deleteValue(dbName, store, key);
      return json({ error: "method not allowed" }, 405);
    } catch (error) {
      console.error("[storage]", req.method, url.pathname, error);
      return json({ error: "internal error" }, 500);
    }
}

function logStorage(req: Request, url: URL, res: Response, ms: number) {
  if (LOG_STORAGE === "off") return;
  const write = req.method !== "GET" && req.method !== "HEAD";
  const problem = res.status >= 400 && !(res.status === 404 && !write);
  if (LOG_STORAGE !== "all" && !write && !problem) return;
  let path = url.pathname.replace(/^\/api\/?/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  const size = Number(req.headers.get("content-length") || 0);
  const rev = res.headers.get("X-KV-Rev");
  console.log(`[storage] ${req.method} ${path}${url.search} ${res.status}${rev && rev !== "0" ? ` rev=${rev}` : ""}${size ? ` ${size < 1024 ? size + "B" : (size / 1024).toFixed(1) + "KB"}` : ""} ${ms.toFixed(0)}ms`);
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  maxRequestBodySize: MAX_BODY,
  idleTimeout: 255, // seconds; slow image generations must not be cut off (Cloudflare caps at 100s anyway)
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/upstream/")) return proxyUpstream(req, url, upstreams);
    const started = performance.now();
    const res = await handleApi(req, url);
    logStorage(req, url, res, performance.now() - started);
    return res;
  },
});

console.log(`[storage] listening on ${server.hostname}:${server.port}, data in ${DATA_DIR}, storage log: ${LOG_STORAGE}`);
