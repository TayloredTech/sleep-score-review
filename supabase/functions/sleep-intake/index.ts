// sleep-intake : public intake backend for the sleep-score review form.
// The browser holds NO secret. Everything privileged happens here.

const BUCKET = "sleep-exports";

const SB_URL = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("SB_URL") ?? "";
const SB_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("SB_SERVICE_ROLE_KEY") ??
  Deno.env.get("SERVICE_ROLE_KEY") ??
  "";

const ALLOWED = new Set([
  "https://sleep.taylored.health",
  "https://taylored.health",
  "https://www.taylored.health",
]);

// The three consents the form must carry. Names are shared with the page.
const CONSENT_KEYS = [
  "not_medical_advice",
  "store_and_delete_within_90_days",
  "no_guarantee_refund_to_end_of_call",
] as const;

// Export formats we accept. Anything else cannot reach the bucket.
const ALLOWED_EXT = new Set(["csv", "zip", "json", "txt", "xlsx"]);

// Content types a browser renders inline on the storage origin. A stored
// text/html is a scripting primitive against whoever opens the export.
const INLINE_RENDERABLE = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "text/javascript",
  "application/javascript",
  "application/ecmascript",
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

// ---------- helpers ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function makeRef(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += B32[x % 32];
  return "SSR-" + s;
}
function makeToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function sanitiseFilename(raw: unknown): string {
  let s = typeof raw === "string" ? raw : "";
  s = s.replace(/\\/g, "/");
  s = s.split("/").pop() ?? "";
  s = s.replace(/[^A-Za-z0-9._-]/g, "_");
  s = s.replace(/^[._]+/, "");
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  if (!s) s = "export.zip";
  return s;
}
function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}
const isUuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isHex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isPlainObj = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// The link must not outlive the data it points at. delete_after is null until
// the upload lands, so only a real past timestamp closes the row.
const isExpired = (row: { delete_after?: string | null }) =>
  !!row.delete_after && Date.parse(row.delete_after) <= Date.now();

// Only ever greet someone by the first word of what they typed.
const firstName = (v: unknown) =>
  typeof v === "string" ? (v.trim().split(/\s+/)[0] ?? "") : "";

// A single path segment under this row, nothing else. Rejecting ".." by
// pattern is the point: Supabase Storage resolves it and would hand one
// submitter a write of another submitter's export path.
function pathBelongsToRow(path: string, rowId: string): boolean {
  if (!isUuid(rowId)) return false;
  if (!new RegExp("^" + rowId + "/[A-Za-z0-9._-]{1,120}$").test(path)) return false;
  const seg = path.slice(rowId.length + 1);
  return seg !== "." && seg !== "..";
}

// ---------- backend calls ----------
async function pg(path: string, init: RequestInit & { prefer?: string } = {}) {
  const h: Record<string, string> = {
    apikey: SB_KEY,
    Authorization: "Bearer " + SB_KEY,
    "Content-Type": "application/json",
  };
  if (init.prefer) h["Prefer"] = init.prefer;
  return await fetch(SB_URL + "/rest/v1/" + path, { ...init, headers: h });
}
async function storage(path: string, init: RequestInit = {}) {
  return await fetch(SB_URL + "/storage/v1/" + path, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

// ---------- main ----------
Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);
  if (!SB_URL || !SB_KEY) return json({ ok: false, error: "server misconfigured" }, 500, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return bad("invalid json", origin);
  }
  const action = body.action;

  // ---- draft ----
  if (action === "draft") {
    if (!isUuid(body.draft_id)) return bad("draft_id must be a uuid", origin);
    if (!isPlainObj(body.payload)) return bad("payload must be an object", origin);
    if (JSON.stringify(body.payload).length > 200000) return bad("payload too large", origin);
    const r = await pg("sleep_partials?on_conflict=draft_id", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: JSON.stringify({
        draft_id: body.draft_id,
        payload: body.payload,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) return json({ ok: false, error: "draft save failed" }, 500, origin);
    return json({ ok: true }, 200, origin);
  }

  // ---- submit ----
  if (action === "submit") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const device = typeof body.device === "string" ? body.device.trim().toLowerCase() : "";
    if (name.length < 1 || name.length > 200) return bad("name required", origin);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 320) {
      return bad("valid email required", origin);
    }
    if (device !== "oura" && device !== "whoop") return bad("device must be oura or whoop", origin);
    const answers = isPlainObj(body.answers) ? body.answers : {};
    if (JSON.stringify(answers).length > 200000) return bad("answers too large", origin);

    // Consent is the whole legal defence, so it cannot be whatever the client
    // happened to send. Three keys, each strictly boolean true.
    if (!isPlainObj(body.consent)) return bad("all three consents must be agreed", origin);
    const rawConsent = body.consent as Record<string, unknown>;
    if (JSON.stringify(rawConsent).length > 20000) return bad("consent too large", origin);
    for (const k of CONSENT_KEYS) {
      if (rawConsent[k] !== true) return bad("all three consents must be agreed", origin);
    }
    // agreed_at comes off the server clock, never the browser's.
    const consent = { ...rawConsent, agreed_at: new Date().toISOString() };

    const safety_flag = body.safety_flag === true;

    const draft_id = body.draft_id === undefined || body.draft_id === null
      ? null
      : isUuid(body.draft_id)
      ? (body.draft_id as string)
      : undefined;
    if (draft_id === undefined) return bad("draft_id must be a uuid", origin);

    // A lost response must not cost the person a second row, a second
    // reference and a second 90-day clock.
    async function existing(): Promise<{ ref: string; upload_token: string } | null> {
      if (!draft_id) return null;
      const r = await pg(
        "sleep_submissions?draft_id=eq." + draft_id + "&select=ref,upload_token",
      );
      if (!r.ok) return null;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length === 1 && rows[0].upload_token) {
        return { ref: rows[0].ref, upload_token: rows[0].upload_token };
      }
      return null;
    }

    // The drafts table holds the same named health record with the least
    // consent behind it. Once the submission lands, the draft goes.
    async function dropDraft() {
      if (!draft_id) return;
      await pg("sleep_partials?draft_id=eq." + draft_id, {
        method: "DELETE",
        prefer: "return=minimal",
      });
    }

    const already = await existing();
    if (already) {
      await dropDraft();
      return json({ ok: true, ...already }, 200, origin);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = makeRef();
      const upload_token = makeToken();
      const r = await pg("sleep_submissions", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify({
          ref,
          name,
          email,
          device,
          answers,
          consent,
          safety_flag,
          upload_token,
          draft_id,
        }),
      });
      if (r.ok) {
        await dropDraft();
        return json({ ok: true, ref, upload_token }, 200, origin);
      }
      const txt = await r.text();
      // Two submits raced on the same draft: hand back the row that won.
      if (txt.includes("sleep_submissions_draft_id_key")) {
        const won = await existing();
        if (won) {
          await dropDraft();
          return json({ ok: true, ...won }, 200, origin);
        }
      }
      if (r.status === 409 || txt.includes("duplicate key")) continue;
      return json({ ok: false, error: "submit failed" }, 500, origin);
    }
    return json({ ok: false, error: "could not allocate reference" }, 500, origin);
  }

  // ---- upload-url ----
  if (action === "upload-url") {
    if (!isHex64(body.upload_token)) return bad("bad upload_token", origin);
    const look = await pg(
      "sleep_submissions?upload_token=eq." + body.upload_token +
        "&select=id,uploaded_at,deleted_at,delete_after",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      return json({ ok: false, error: "not found" }, 403, origin);
    }
    const row = rows[0];
    if (row.deleted_at || isExpired(row)) {
      return json({ ok: false, error: "link expired" }, 403, origin);
    }
    if (row.uploaded_at) {
      return json({ ok: false, error: "already uploaded" }, 403, origin);
    }
    const filename = sanitiseFilename(body.filename);
    // accept= on the page is advisory. This is the check that holds.
    if (!ALLOWED_EXT.has(extensionOf(filename))) {
      return bad("file must be one of csv, zip, json, txt, xlsx", origin);
    }
    const path = row.id + "/" + filename;
    const s = await storage("object/upload/sign/" + BUCKET + "/" + path, {
      method: "POST",
      body: JSON.stringify({ expiresIn: 3600 }),
    });
    if (!s.ok) return json({ ok: false, error: "could not sign upload" }, 500, origin);
    const sj = await s.json();
    const signed = String(sj.url ?? "");
    const qi = signed.indexOf("token=");
    const token = qi >= 0 ? signed.slice(qi + 6) : "";
    if (!token) return json({ ok: false, error: "could not sign upload" }, 500, origin);
    return json({
      ok: true,
      path,
      token,
      url: SB_URL + "/storage/v1/object/upload/sign/" + BUCKET + "/" + path + "?token=" + token,
    }, 200, origin);
  }

  // ---- upload-done ----
  if (action === "upload-done") {
    if (!isHex64(body.upload_token)) return bad("bad upload_token", origin);
    if (typeof body.path !== "string" || body.path.length > 300) return bad("bad path", origin);
    const look = await pg(
      "sleep_submissions?upload_token=eq." + body.upload_token +
        "&select=id,uploaded_at,deleted_at,delete_after",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1) return json({ ok: false, error: "not found" }, 403, origin);
    const row = rows[0];
    if (row.deleted_at || isExpired(row)) {
      return json({ ok: false, error: "link expired" }, 403, origin);
    }
    if (!pathBelongsToRow(body.path, String(row.id))) {
      return json({ ok: false, error: "path mismatch" }, 403, origin);
    }
    if (!ALLOWED_EXT.has(extensionOf(body.path))) {
      return bad("file must be one of csv, zip, json, txt, xlsx", origin);
    }

    const info = await storage("object/info/" + BUCKET + "/" + body.path, { method: "GET" });
    if (!info.ok) return json({ ok: false, error: "object not found in bucket" }, 400, origin);

    // The browser picks the Content-Type on the signed PUT and Supabase keeps
    // it, so a crafted client can park scripting content on the storage
    // origin. Drop it rather than record it.
    let stored: { content_type?: string } = {};
    try {
      stored = await info.json();
    } catch { /* fall through, treated as unknown */ }
    const ct = String(stored.content_type ?? "").split(";")[0].trim().toLowerCase();
    if (INLINE_RENDERABLE.has(ct)) {
      // The bulk form, because a single-object DELETE with this helper's JSON
      // content type and no body is rejected by the storage API.
      await storage("object/" + BUCKET, {
        method: "DELETE",
        body: JSON.stringify({ prefixes: [body.path] }),
      });
      return bad("file content type not accepted", origin);
    }

    const upd = await pg("sleep_submissions?id=eq." + row.id + "&select=uploaded_at,delete_after", {
      method: "PATCH",
      prefer: "return=representation",
      body: JSON.stringify({ uploaded_at: new Date().toISOString(), upload_path: body.path }),
    });
    if (!upd.ok) return json({ ok: false, error: "update failed" }, 500, origin);
    const u = await upd.json();
    return json({ ok: true, delete_after: u?.[0]?.delete_after ?? null }, 200, origin);
  }

  // ---- status ----
  if (action === "status") {
    if (!isHex64(body.upload_token)) return bad("bad upload_token", origin);
    const look = await pg(
      "sleep_submissions?upload_token=eq." + body.upload_token +
        "&select=ref,name,device,uploaded_at,deleted_at,delete_after",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].deleted_at) {
      return json({ ok: false, error: "not found" }, 403, origin);
    }
    const r0 = rows[0];
    if (isExpired(r0)) return json({ ok: false, error: "link expired" }, 403, origin);
    // Once the upload has landed the link has done its job. It must not stay
    // a working name lookup for the rest of the 90 days.
    if (r0.uploaded_at) {
      return json({ ok: true, ref: r0.ref, uploaded: true }, 200, origin);
    }
    // Before upload the page greets them, and a first name is enough for that.
    return json({
      ok: true,
      ref: r0.ref,
      name: firstName(r0.name),
      device: r0.device,
      uploaded: false,
    }, 200, origin);
  }

  return bad("unknown action", origin);
});
