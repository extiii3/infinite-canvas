// AI upstream proxy with server-side API keys and request/response logging (Railway deploy logs = stdout).
//
// Env:  UPSTREAM_<NAME>_URL=https://api.apimart.ai   UPSTREAM_<NAME>_KEY=sk-...
//       -> /upstream/<name>/<path> is forwarded to <URL>/<path> with "Authorization: Bearer <KEY>".
//       LOG_AI=full (default) | status | off      LOG_BODY_MAX=1500 (chars of each body preview)
// API keys, cookies and Cloudflare/origin headers are never forwarded to logs or upstreams.

type Upstream = { name: string; base: string; key: string };

const LOG_MODE = (process.env.LOG_AI || "full").toLowerCase();
const BODY_MAX = Number(process.env.LOG_BODY_MAX || 1500);
const COLLECT_MAX = 256 * 1024;

const STRIP_REQUEST = new Set([
  "host", "authorization", "cookie", "origin", "referer", "connection", "keep-alive", "transfer-encoding", "content-length",
  "x-origin-auth", "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "true-client-ip", "cdn-loop",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-warp-tag-id", "cf-access-jwt-assertion", "cf-access-authenticated-user-email",
]);
const STRIP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);

export function loadUpstreams(): Map<string, Upstream> {
  const upstreams = new Map<string, Upstream>();
  for (const [env, value] of Object.entries(process.env)) {
    const match = /^UPSTREAM_([A-Z0-9_]+)_URL$/.exec(env);
    if (!match || !value) continue;
    const key = process.env[`UPSTREAM_${match[1]}_KEY`] || "";
    const name = match[1].toLowerCase().replace(/_/g, "-");
    if (!/^https:\/\//.test(value) || !key) {
      console.log(`[ai] upstream ${name} skipped (URL must be https and KEY set)`);
      continue;
    }
    upstreams.set(name, { name, base: value.replace(/\/+$/, ""), key });
    console.log(`[ai] upstream /upstream/${name}/ -> ${value.replace(/\/+$/, "")}/`);
  }
  return upstreams;
}

// ---------- log formatting ----------

const shortId = () => Math.random().toString(36).slice(2, 8);
const kb = (n: number) => (n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

/** Shorten long strings and hide base64 / data URLs so logs stay readable and small. */
export function redact(text: string, max = BODY_MAX) {
  const cleaned = text
    .replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]+/g, (_m, mime) => `<data:${mime} ${kb(_m.length)}>`)
    .replace(/[A-Za-z0-9+/=]{300,}/g, (m) => `<base64 ${kb(m.length)}>`)
    .replace(/\s+/g, " ");
  return cleaned.length > max ? `${cleaned.slice(0, max)}… (+${cleaned.length - max} chars)` : cleaned;
}

function describeJsonRequest(body: unknown) {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  if (b.model) parts.push(`model=${b.model}`);
  const prompt = typeof b.prompt === "string" ? b.prompt : Array.isArray(b.messages) ? JSON.stringify((b.messages as unknown[]).at(-1)) : "";
  if (prompt) parts.push(`prompt="${redact(prompt, 160)}"`);
  for (const field of ["image_urls", "image", "images"]) if (Array.isArray(b[field])) parts.push(`${field}=${(b[field] as unknown[]).length}`);
  for (const field of ["size", "aspect_ratio", "resolution", "n", "stream"]) if (b[field] !== undefined) parts.push(`${field}=${b[field]}`);
  return parts.join(" ");
}

// ---------- proxy ----------

export async function proxyUpstream(req: Request, url: URL, upstreams: Map<string, Upstream>): Promise<Response> {
  const [, , name, ...rest] = url.pathname.split("/"); // ["", "upstream", name, ...path]
  const upstream = upstreams.get(name || "");
  if (!upstream) return new Response(JSON.stringify({ error: `unknown upstream "${name}"` }), { status: 404, headers: { "Content-Type": "application/json" } });

  const id = shortId();
  const started = performance.now();
  const target = `${upstream.base}/${rest.join("/")}${url.search}`;
  const path = `/${rest.join("/")}${url.search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("Authorization", `Bearer ${upstream.key}`);

  const contentType = req.headers.get("content-type") || "";
  const length = Number(req.headers.get("content-length") || 0);
  let body: BodyInit | null = null;
  let requestSummary = "";
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (contentType.includes("application/json")) {
      const text = await req.text();
      body = text;
      try {
        requestSummary = describeJsonRequest(JSON.parse(text));
      } catch {
        requestSummary = "invalid json";
      }
      requestSummary += ` (${kb(text.length)})`;
    } else {
      // Buffer so the upstream always gets a Content-Length (some providers reject chunked uploads).
      const buffer = await req.arrayBuffer();
      body = buffer;
      requestSummary = `${contentType.split(";")[0] || "body"} ${kb(buffer.byteLength || length)}`;
    }
  }
  if (LOG_MODE !== "off") console.log(`[ai ${id}] → ${req.method} ${upstream.name}${path}${requestSummary ? "  " + requestSummary : ""}`);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: req.signal, ...({ duplex: "half", timeout: false } as object) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (LOG_MODE !== "off") console.log(`[ai ${id}] ✗ ${upstream.name}${path} network error after ${((performance.now() - started) / 1000).toFixed(1)}s: ${message}`);
    return new Response(JSON.stringify({ error: "upstream unreachable", detail: message }), { status: 502, headers: { "Content-Type": "application/json" } });
  }

  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) responseHeaders.set(key, value);
  });
  const responseType = upstreamResponse.headers.get("content-type") || "";
  const textual = /json|text|event-stream|xml/.test(responseType);
  const firstByteMs = performance.now() - started;

  // Stream to the client while keeping a bounded copy for the log.
  const chunks: Uint8Array[] = [];
  let collected = 0;
  let total = 0;
  const logDone = (aborted: boolean) => {
    if (LOG_MODE === "off") return;
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const status = `${upstreamResponse.status}${upstreamResponse.ok ? "" : " " + upstreamResponse.statusText}`;
    let preview = "";
    if (LOG_MODE === "full" || !upstreamResponse.ok) {
      preview = textual ? redact(new TextDecoder().decode(Buffer.concat(chunks)).split(upstream.key).join("sk-***")) : `<${responseType || "binary"}>`;
    }
    console.log(`[ai ${id}] ← ${status} ${seconds}s (first byte ${(firstByteMs / 1000).toFixed(1)}s) ${kb(total)}${aborted ? " CLIENT-ABORTED" : ""}${preview ? "  " + preview : ""}`);
  };

  if (!upstreamResponse.body) {
    logDone(false);
    return new Response(null, { status: upstreamResponse.status, headers: responseHeaders });
  }
  const reader = upstreamResponse.body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          logDone(false);
          controller.close();
          return;
        }
        total += value.byteLength;
        if (textual && collected < COLLECT_MAX) {
          chunks.push(value.subarray(0, COLLECT_MAX - collected));
          collected += Math.min(value.byteLength, COLLECT_MAX - collected);
        }
        controller.enqueue(value);
      } catch (error) {
        logDone(true);
        controller.error(error);
      }
    },
    cancel() {
      logDone(true);
      void reader.cancel();
    },
  });
  return new Response(stream, { status: upstreamResponse.status, statusText: upstreamResponse.statusText, headers: responseHeaders });
}
