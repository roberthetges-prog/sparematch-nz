// Fingerprint an image the SERVER cannot fetch, by having the BROWSER fetch it and post the bytes.
//
// WHY THIS EXISTS: some retailer CDNs (Mitre 10's ccapi.mitre10.co.nz is the one that bit us)
// serve a real browser happily but block datacenter IPs - so Vercel gets nothing, and an image
// proxy gets through only about 1 request in 5. Those products could never be fingerprinted, and
// so could never be found by photo.
//
// The admin page loads the picture in the browser (which the CDN allows), shrinks it to 512px on
// a canvas, and posts the bytes here. We embed with Jina exactly as the normal backfill does.
// Nothing about the fingerprint differs - only how the pixels reached us.

import { sbAdmin } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const DIM = 256;

function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function jinaEmbed(key, dataUrl) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({
      model: "jina-clip-v2",
      dimensions: DIM,
      normalized: true,
      embedding_type: "float",
      input: [{ image: dataUrl }],
    }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const v = j && j.data && j.data[0] && j.data[0].embedding;
  return Array.isArray(v) && v.length === DIM ? v : null;
}

export async function POST(request) {
  const pw = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pw) return Response.json({ error: "admin password not configured" }, { status: 500 });

  const key = keyJina();
  if (!key) return Response.json({ error: "embedding key not configured" }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }

  if (!body || String(body.password || "") !== pw) {
    return Response.json({ error: "wrong password" }, { status: 401 });
  }

  const items = Array.isArray(body.items) ? body.items.slice(0, 25) : [];
  if (!items.length) return Response.json({ error: "no images" }, { status: 400 });

  const sb = sbAdmin();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });

  let embedded = 0;
  const errors = [];

  for (const it of items) {
    const id = Number(it && it.id);
    const data = it && typeof it.data === "string" ? it.data : "";
    if (!Number.isFinite(id) || !data) { errors.push({ id: it && it.id, why: "bad item" }); continue; }
    // ~2MB of base64 is plenty for a 512px JPEG; anything larger is a mistake, not a photo.
    if (data.length > 2_000_000) { errors.push({ id, why: "too large" }); continue; }

    const dataUrl = data.startsWith("data:") ? data : "data:image/jpeg;base64," + data;
    try {
      const vec = await jinaEmbed(key, dataUrl);
      if (!vec) { errors.push({ id, why: "embed failed" }); continue; }
      const { error } = await sb
        .from("products")
        .update({ embedding: "[" + vec.join(",") + "]" })
        .eq("id", id);
      if (error) { errors.push({ id, why: "save failed" }); continue; }
      embedded++;
    } catch {
      errors.push({ id, why: "error" });
    }
  }

  const { count } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)
    .not("photo_url", "is", null)
    .eq("active", true);

  return Response.json({ embedded, remaining: count || 0, errors });
}

// Tell the admin page which products still need a fingerprint, so it can fetch their
// pictures in the browser and post them back.
export async function GET(request) {
  const url = new URL(request.url);
  if (String(url.searchParams.get("list") || "") !== "1") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const sb = sbAdmin();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });
  const { data, error } = await sb
    .from("products")
    .select("id,brand,model,photo_url")
    .is("embedding", null)
    .not("photo_url", "is", null)
    .eq("active", true)
    .limit(25);
  if (error) return Response.json({ error: "query failed" }, { status: 500 });
  return Response.json({ items: data || [] });
}
