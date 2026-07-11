import sharp from "sharp";
import { sbAdmin } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 120;
const DIM = 256;
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function fetchBuf(url, ms = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot" } }); clearTimeout(t);
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

export async function GET(request) {
  const url = new URL(request.url);
  const admin = (process.env.EMBED_TOKEN || "").trim();
  if (!admin || (url.searchParams.get("key") || "").trim() !== admin) return Response.json({ error: "forbidden" }, { status: 403 });
  if (url.searchParams.get("go") !== "backfill-tapsnap") return Response.json({ error: "add ?go=backfill-tapsnap" }, { status: 400 });
  const sb = sbAdmin(); if (!sb) return Response.json({ error: "db not configured" }, { status: 500 });
  const jkey = keyJina(); if (!jkey) return Response.json({ error: "no JINA_API_KEY" }, { status: 500 });
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "25", 10) || 25, 1), 40);
  const { data: rows, error: selErr } = await sb.from("products").select("id,photo_url").is("embedding", null).not("photo_url", "is", null).order("id", { ascending: false }).limit(limit);
  if (selErr) return Response.json({ error: selErr.message }, { status: 500 });
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
  return Response.json({ processed: (rows || []).length, embedded: done, remaining, errors });
}
