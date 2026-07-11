import sharp from "sharp";
import { sbAdmin } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 120;
const DIM = 256;
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function fetchBuf(url, ms = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    let ref = ""; try { const u = new URL(url); ref = u.origin + "/"; } catch {}
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "accept-language": "en-NZ,en;q=0.9", "referer": ref } }); clearTimeout(t);
    if (!r.ok) return null; const buf = Buffer.from(await r.arrayBuffer()); return buf.length ? buf : null;
  } catch { clearTimeout(t); return null; }
}
async function toResizedB64(url) {
  const buf = await fetchBuf(url); if (!buf) return null;
  try { const out = await sharp(buf).resize(512, 512, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    return "data:image/jpeg;base64," + out.toString("base64"); } catch { return null; }
}
async function jinaEmbed(key, dataUri) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: [{ image: dataUri }] }) });
  if (!r.ok) return null; const j = await r.json();
  return (j.data && j.data[0] && j.data[0].embedding) || null;
}

async function runBackfill(limit) {
  const sb = sbAdmin(); if (!sb) return { error: "db not configured", status: 500 };
  const jkey = keyJina(); if (!jkey) return { error: "no JINA_API_KEY", status: 500 };
  const lim = Math.min(Math.max(parseInt(limit || "40", 10) || 40, 1), 40);
  const { data: rows, error: selErr } = await sb.from("products").select("id,photo_url").is("embedding", null).not("photo_url", "is", null).order("id", { ascending: false }).limit(lim);
  if (selErr) return { error: selErr.message, status: 500 };
  let done = 0; const errors = [];
  for (const r of rows || []) {
    const dataUri = await toResizedB64(r.photo_url);
    if (!dataUri) { errors.push({ id: r.id, e: "image" }); continue; }
    const vec = await jinaEmbed(jkey, dataUri);
    if (!vec) { errors.push({ id: r.id, e: "embed" }); continue; }
    const { error } = await sb.from("products").update({ embedding: "[" + vec.join(",") + "]" }).eq("id", r.id);
    if (error) errors.push({ id: r.id, e: error.message }); else done++;
  }
  const { count: remaining } = await sb.from("products").select("*", { count: "exact", head: true }).is("embedding", null);
  return { processed: (rows || []).length, embedded: done, remaining, errors, status: 200 };
}

// Token-gated (query ?key=EMBED_TOKEN) — for manual/CLI use.
export async function GET(request) {
  const url = new URL(request.url);
  const admin = (process.env.EMBED_TOKEN || "").trim();
  if (!admin || (url.searchParams.get("key") || "").trim() !== admin) return Response.json({ error: "forbidden" }, { status: 403 });
  if (url.searchParams.get("go") !== "backfill-tapsnap") return Response.json({ error: "add ?go=backfill-tapsnap" }, { status: 400 });
  const out = await runBackfill(url.searchParams.get("limit"));
  const { status, ...rest } = out; return Response.json(rest, { status });
}

// Password-gated (POST {password}) — triggered from the /admin page.
export async function POST(request) {
  let body; try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  const admin = (process.env.ADMIN_PASSWORD || "").trim();
  if (!admin || (body && body.password) !== admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const out = await runBackfill(body && body.limit);
  const { status, ...rest } = out; return Response.json(rest, { status });
}
