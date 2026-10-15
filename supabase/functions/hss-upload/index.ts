// hss-upload : wearable data upload for Health Strategy Session buyers.
// Built 15 Oct 2026 (Rachel: "repurpose some of the frameworks there") from
// sleep-intake. Same bucket, same signed-upload pattern, same content-type guard.
// The browser holds NO secret. The row (one per buyer) is made by
// scripts/stripe-kit-bridge.py when it tags an HSS buyer, and the buyer's
// upload_token is their whole credential: https://sleep.taylored.health/upload/?t=<64 hex>
// Files land in sleep-exports under hss/<row id>/<file>. Up to MAX_FILES per buyer.
// The bridge reads uploaded_at to tag "HSS data received" and alert Discord.

const BUCKET = "sleep-exports";
const MAX_FILES = 6;

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ALLOWED = new Set([
  "https://sleep.taylored.health",
  "https://taylored.health",
  "https://www.taylored.health",
]);

// csv/zip/json/txt/xlsx as sleep-intake, plus fit (Garmin activity files).
const ALLOWED_EXT = new Set(["csv", "zip", "json", "txt", "xlsx", "fit"]);
const DEVICES = new Set(["whoop", "oura", "apple", "garmin", "ultrahuman", "other"]);

// A stored text/html on the storage origin is a scripting primitive.
const INLINE_RENDERABLE = new Set([
  "text/html", "application/xhtml+xml", "image/svg+xml", "text/xml",
  "application/xml", "text/javascript", "application/javascript", "application/ecmascript",
]);

function cors(origin: string | null): Record<string, string> {
  const o = origin && ALLOWED.has(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}
const bad = (m: string, o: string | null) => json({ ok: false, error: m }, 400, o);

function sanitiseFilename(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(/\\/g, "/").split("/").pop() ?? "";
  s = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "");
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || "export.zip";
}
function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
const isUuid = (v: unknown) =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isHex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const firstName = (v: unknown) => typeof v === "string" ? (v.trim().split(/\s+/)[0] ?? "") : "";

// hss/<row id>/<one safe segment>, nothing else. ".." is rejected by pattern.
function pathBelongsToRow(path: string, rowId: string): boolean {
  if (!isUuid(rowId)) return false;
  const pre = "hss/" + rowId + "/";
  if (!path.startsWith(pre)) return false;
  const seg = path.slice(pre.length);
  return /^[A-Za-z0-9._-]{1,120}$/.test(seg) && seg !== "." && seg !== "..";
}

async function pg(path: string, init: RequestInit & { prefer?: string } = {}) {
  const h: Record<string, string> = {
    apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json",
  };
  if (init.prefer) h["Prefer"] = init.prefer;
  return await fetch(SB_URL + "/rest/v1/" + path, { ...init, headers: h });
}
async function storage(path: string, init: RequestInit = {}) {
  return await fetch(SB_URL + "/storage/v1/" + path, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

type Row = { id: string; name: string | null; upload_paths: string[]; deleted_at: string | null; uploaded_at: string | null };
async function rowFor(token: unknown): Promise<Row | null | "error"> {
  if (!isHex64(token)) return null;
  const r = await pg("hss_uploads?upload_token=eq." + token + "&select=id,name,upload_paths,deleted_at,uploaded_at");
  if (!r.ok) return "error";
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].deleted_at) return null;
  return rows[0] as Row;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);
  if (!SB_URL || !SB_KEY) return json({ ok: false, error: "server misconfigured" }, 500, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad("invalid json", origin);
  }
  const action = body.action;
  const row = await rowFor(body.upload_token);
  if (row === "error") return json({ ok: false, error: "lookup failed" }, 500, origin);
  if (!row) return json({ ok: false, error: "not found" }, 403, origin);
  const count = (row.upload_paths ?? []).length;

  // ---- status: first name and how many files are in, nothing else ----
  if (action === "status") {
    return json({ ok: true, name: firstName(row.name), files: count, max: MAX_FILES }, 200, origin);
  }

  // ---- upload-url ----
  if (action === "upload-url") {
    if (count >= MAX_FILES) return json({ ok: false, error: "file limit reached" }, 403, origin);
    const filename = sanitiseFilename(body.filename);
    if (!ALLOWED_EXT.has(extensionOf(filename))) {
      return bad("file must be one of csv, zip, json, txt, xlsx, fit", origin);
    }
    const path = "hss/" + row.id + "/" + Date.now() + "-" + filename;
    const s = await storage("object/upload/sign/" + BUCKET + "/" + path, {
      method: "POST", body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!s.ok) return json({ ok: false, error: "could not sign upload" }, 500, origin);
    const sj = await s.json();
    const signed = String(sj.url ?? "");
    const qi = signed.indexOf("token=");
    const token = qi >= 0 ? signed.slice(qi + 6) : "";
    if (!token) return json({ ok: false, error: "could not sign upload" }, 500, origin);
    return json({
      ok: true, path,
      url: SB_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + path + "?token=" + token,
    }, 200, origin);
  }

  // ---- upload-done ----
  if (action === "upload-done") {
    const path = typeof body.path === "string" ? body.path : "";
    if (!pathBelongsToRow(path, row.id)) return json({ ok: false, error: "path mismatch" }, 403, origin);
    if (!ALLOWED_EXT.has(extensionOf(path))) return bad("file type not accepted", origin);
    if ((row.upload_paths ?? []).includes(path)) return json({ ok: true, files: count }, 200, origin);
    if (count >= MAX_FILES) return json({ ok: false, error: "file limit reached" }, 403, origin);
    const info = await storage("object/info/" + BUCKET + "/" + path, { method: "GET" });
    if (!info.ok) return json({ ok: false, error: "object not found in bucket" }, 400, origin);
    let stored: { content_type?: string } = {};
    try {
      stored = await info.json();
    } catch { /* unknown */ }
    const ct = String(stored.content_type ?? "").split(";")[0].trim().toLowerCase();
    if (INLINE_RENDERABLE.has(ct)) {
      await storage("object/" + BUCKET, { method: "DELETE", body: JSON.stringify({ prefixes: [path] }) });
      return bad("file content type not accepted", origin);
    }
    const now = new Date().toISOString();
    const device = typeof body.device === "string" && DEVICES.has(body.device) ? body.device : null;
    const patch: Record<string, unknown> = {
      upload_paths: [...(row.upload_paths ?? []), path],
      last_uploaded_at: now,
    };
    if (!row.uploaded_at) patch.uploaded_at = now;
    if (device) patch.device = device;
    const upd = await pg("hss_uploads?id=eq." + row.id, {
      method: "PATCH", prefer: "return=minimal", body: JSON.stringify(patch),
    });
    if (!upd.ok) return json({ ok: false, error: "update failed" }, 500, origin);
    return json({ ok: true, files: count + 1 }, 200, origin);
  }

  return bad("unknown action", origin);
});
