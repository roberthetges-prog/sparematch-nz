import sharp from "sharp";
import { sbAdmin } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const DIM = 256;
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function fetchBuf(url, ms = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot" } }); clearTimeout(t);
    if (!r.ok) return null; const ct = (r.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer()); return { ct, buf, url: r.url };
  } catch { clearTimeout(t); return null; }
}
// resolve a pasted link (product page OR image) to an image URL
async function resolveImage(link) {
  const got = await fetchBuf(link);
  if (!got) return null;
  if (got.ct.startsWith("image/")) return { imageUrl: got.url, pageUrl: null };
  const html = got.buf.toString("utf8");
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  let img = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
        || pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
        || pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (img && img.startsWith("//")) img = "https:" + img;
  if (img && img.startsWith("/")) { try { const u = new URL(link); img = u.origin + img; } catch {} }
  return img ? { imageUrl: img, pageUrl: got.url } : null;
}
async function toResizedB64(imageUrl) {
  const got = await fetchBuf(imageUrl);
  if (!got || !got.buf.length) return null;
  try { const out = await sharp(got.buf).resize(512, 512, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
    return "data:image/jpeg;base64," + out.toString("base64");
  } catch { return null; }
}
async function jinaEmbed(key, dataUri) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: [{ image: dataUri }] }) });
  if (!r.ok) return null; const j = await r.json();
  const v = j.data && j.data[0] && j.data[0].embedding; return v || null;
}

export async function POST(request) {
  let body; try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  const pass = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pass || (body.password || "") !== pass) return Response.json({ error: "unauthorized" }, { status: 401 });
  const sb = sbAdmin(); if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });
  const jkey = keyJina(); if (!jkey) return Response.json({ error: "no JINA_API_KEY" }, { status: 500 });
  const link = String(body.url || "").trim();
  if (!link || !body.model) return Response.json({ error: "url and model are required" }, { status: 400 });

  const resolved = await resolveImage(link);
  if (!resolved || !resolved.imageUrl) return Response.json({ error: "couldn't find an image at that link — paste a direct image URL or a product page with a main photo" }, { status: 422 });
  const dataUri = await toResizedB64(resolved.imageUrl);
  if (!dataUri) return Response.json({ error: "couldn't download/process the image" }, { status: 422 });
  const vec = await jinaEmbed(jkey, dataUri);
  if (!vec) return Response.json({ error: "embedding failed (Jina)" }, { status: 502 });

  const row = {
    brand: body.brand ? String(body.brand).trim() : null,
    model: String(body.model).trim(),
    category: String(body.category || "other").toLowerCase().trim(),
    size: body.size ? String(body.size).trim() : null,
    part_no: body.part_no ? String(body.part_no).trim() : null,
    fits: body.fits ? String(body.fits).trim() : null,
    photo_url: resolved.imageUrl,
    buy_url: (body.buy_url && String(body.buy_url).trim()) || resolved.pageUrl || link,
    confirm: !!body.confirm,
    source_key: "ING|" + Date.now() + "|" + Math.random().toString(36).slice(2, 7),
    embedding: "[" + vec.join(",") + "]",
  };
  const { data, error } = await sb.from("products").insert(row).select("id,brand,model,category,part_no,size,photo_url,buy_url").single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, product: data });
}
