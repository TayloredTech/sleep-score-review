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
const isUuid = (v: unknown) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const isHex64 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const isPlainObj = (v: unknown) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

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
    const consent = isPlainObj(body.consent) ? body.consent : {};
    if (JSON.stringify(answers).length > 200000) return bad("answers too large", origin);
    if (JSON.stringify(consent).length > 20000) return bad("consent too large", origin);
    const safety_flag = body.safety_flag === true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = makeRef();
      const upload_token = makeToken();
      const r = await pg("sleep_submissions", {
        method: "POST",
        prefer: "return=minimal",
        body: JSON.stringify({ ref, name, email, device, answers, consent, safety_flag, upload_token }),
      });
      if (r.ok) return json({ ok: true, ref, upload_token }, 200, origin);
      const txt = await r.text();
      if (r.status === 409 || txt.includes("duplicate key")) continue;
      return json({ ok: false, error: "submit failed" }, 500, origin);
    }
    return json({ ok: false, error: "could not allocate reference" }, 500, origin);
  }

  // ---- upload-url ----
  if (action === "upload-url") {
    if (!isHex64(body.upload_token)) return bad("bad upload_token", origin);
    const look = await pg(
      "sleep_submissions?upload_token=eq." + body.upload_token + "&select=id,uploaded_at,deleted_at",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1) {
      return json({ ok: false, error: "not found" }, 403, origin);
    }
    const row = rows[0];
    if (row.uploaded_at || row.deleted_at) {
      return json({ ok: false, error: "already uploaded" }, 403, origin);
    }
    const path = row.id + "/" + sanitiseFilename(body.filename);
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
      "sleep_submissions?upload_token=eq." + body.upload_token + "&select=id,uploaded_at,deleted_at",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1) return json({ ok: false, error: "not found" }, 403, origin);
    const row = rows[0];
    if (row.deleted_at) return json({ ok: false, error: "not found" }, 403, origin);
    if (!body.path.startsWith(row.id + "/")) return json({ ok: false, error: "path mismatch" }, 403, origin);

    const info = await storage("object/info/" + BUCKET + "/" + body.path, { method: "GET" });
    if (!info.ok) return json({ ok: false, error: "object not found in bucket" }, 400, origin);

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
        "&select=ref,name,device,uploaded_at,deleted_at",
    );
    if (!look.ok) return json({ ok: false, error: "lookup failed" }, 500, origin);
    const rows = await look.json();
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].deleted_at) {
      return json({ ok: false, error: "not found" }, 403, origin);
    }
    const r0 = rows[0];
    return json({
      ok: true,
      ref: r0.ref,
      name: r0.name,
      device: r0.device,
      uploaded: !!r0.uploaded_at,
    }, 200, origin);
  }

  return bad("unknown action", origin);
});
