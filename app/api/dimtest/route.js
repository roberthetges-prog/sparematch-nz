// A/B TEST, NOT A MIGRATION. Does a full-width 1024-dim fingerprint find the right tap when the
// truncated 256-dim one does not?
//
// WHY THIS EXISTS. We fingerprint every catalogue photo with Jina CLIP v2 but keep only the first
// 256 of the 1024 numbers it produces - three quarters of the detail thrown away. The suspicion is
// that the discarded detail is exactly what separates near-identical taps: Rob photographed his
// Raymor Avon and it did not reach the shortlist at all, while five other brands' lookalikes did.
//
// Migrating for real means altering the vector column, rebuilding the index and re-fingerprinting
// all ~1,400 products - during which photo matching is dead. That is far too much to spend on a
// hunch. So this endpoint answers the question on a SAMPLE first, changing nothing:
//   - take the customer's photo
//   - embed it, and a sample of catalogue photos, at BOTH 256 and 1024
//   - rank the sample both ways, purely in memory
//   - report where the target product lands under each
// If 1024 pulls the target up, the migration is worth its downtime. If it doesn't, we have saved
// ourselves a pointless and risky rebuild - which is the more likely outcome and still a win.

import { sbAdmin, sbRead } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 60;

function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

// One Jina call, many images, at a given width. Batching matters: we have 60 seconds.
async function embedBatch(key, inputs, dims) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: dims, normalized: true, embedding_type: "float", input: inputs }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (!j || !Array.isArray(j.data)) return null;
  // Jina may return them out of order; index tells us where each belongs.
  const out = new Array(inputs.length).fill(null);
  for (const d of j.data) if (Number.isFinite(d.index) && Array.isArray(d.embedding)) out[d.index] = d.embedding;
  return out;
}

function cosine(a, b) {
  if (!a || !b) return -1;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function grab(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot", accept: "image/*" } });
    clearTimeout(t);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 512 || buf.length > 4000000) return null;
    return "data:image/jpeg;base64," + buf.toString("base64");
  } catch { return null; }
}

export async function POST(request) {
  const pw = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pw) return Response.json({ error: "admin password not configured" }, { status: 500 });
  const key = keyJina();
  if (!key) return Response.json({ error: "embedding key not configured" }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  if (!body || String(body.password || "") !== pw) return Response.json({ error: "wrong password" }, { status: 401 });

  const data = typeof body.data === "string" ? body.data : "";
  if (!data) return Response.json({ error: "no photo" }, { status: 400 });
  const category = String(body.category || "sink mixer").toLowerCase();
  const limit = Math.min(Math.max(Number(body.limit) || 24, 4), 30);

  const sb = sbAdmin() || sbRead();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });

  const { data: rows, error } = await sb
    .from("products")
    .select("id,brand,model,photo_url")
    .eq("category", category)
    .eq("active", true)
    .not("photo_url", "is", null)
    .limit(limit);
  if (error || !rows || !rows.length) return Response.json({ error: "no sample" }, { status: 500 });

  // Pull the sample's photos. Anything we cannot fetch is dropped from BOTH runs, so the two
  // rankings always compare the same products - otherwise the test would be rigged.
  const got = [];
  for (const r of rows) {
    const d = await grab(r.photo_url);
    if (d) got.push({ ...r, dataUrl: d });
  }
  if (got.length < 4) return Response.json({ error: "could not fetch enough sample photos", fetched: got.length }, { status: 500 });

  const q = "data:image/jpeg;base64," + data;
  const inputs = [{ image: q }, ...got.map((g) => ({ image: g.dataUrl }))];

  const [e256, e1024] = await Promise.all([embedBatch(key, inputs, 256), embedBatch(key, inputs, 1024)]);
  if (!e256 || !e1024) return Response.json({ error: "embedding failed" }, { status: 502 });

  const rank = (embs) => {
    const qv = embs[0];
    return got
      .map((g, i) => ({ id: g.id, brand: g.brand, model: g.model, score: cosine(qv, embs[i + 1]) }))
      .sort((a, b) => b.score - a.score)
      .map((r, i) => ({ ...r, rank: i + 1, score: Math.round(r.score * 1000) / 1000 }));
  };

  const r256 = rank(e256);
  const r1024 = rank(e1024);

  // Where did the product we KNOW is correct end up under each?
  const targetId = Number(body.targetId) || null;
  const find = (list) => (targetId ? list.find((x) => x.id === targetId) : null);
  const t256 = find(r256), t1024 = find(r1024);

  return Response.json({
    sampleSize: got.length,
    category,
    target: targetId ? {
      id: targetId,
      name: (t256 && t256.brand + " " + t256.model) || "not in sample",
      rankAt256: t256 ? t256.rank : null,
      rankAt1024: t1024 ? t1024.rank : null,
      scoreAt256: t256 ? t256.score : null,
      scoreAt1024: t1024 ? t1024.score : null,
      verdict: (t256 && t1024)
        ? (t1024.rank < t256.rank ? "1024 IS BETTER (+" + (t256.rank - t1024.rank) + " places)"
          : t1024.rank > t256.rank ? "1024 IS WORSE (-" + (t1024.rank - t256.rank) + " places)"
          : "NO CHANGE - the migration would not fix this")
        : null,
    } : null,
    top256: r256.slice(0, 8),
    top1024: r1024.slice(0, 8),
  });
}
