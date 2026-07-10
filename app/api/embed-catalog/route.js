// One-time (re-runnable) builder: computes an image embedding for every catalogue photo via
// Jina CLIP v2, quantises to int8 + base64 for compactness, and returns them as JSON.
// Call this once after JINA_API_KEY is set, capture the output, and commit it as lib/embeddings.json.
// Paginate with ?start=0&count=120 to stay within limits.

import models from "../../../lib/models.json";

export const runtime = "nodejs";
export const maxDuration = 120;

const DIM = 256;              // Matryoshka-truncated dims (good retrieval, small)
const BATCH = 12;            // images per Jina request
const scrub = (s) => String(s).replace(/[A-Za-z0-9_\-]{20,}/g, (m) => (m.startsWith("jina_") ? "[redacted]" : m));

function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function embedImages(key, urls) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: urls.map((u) => ({ image: u })) }),
  });
  if (!r.ok) throw new Error("jina " + r.status + " " + scrub(await r.text()).slice(0, 200));
  const j = await r.json();
  // returns data:[{index, embedding:[...]}]
  const out = new Array(urls.length).fill(null);
  for (const d of j.data || []) if (Number.isInteger(d.index)) out[d.index] = d.embedding;
  return out;
}

function toB64Int8(vec) {
  const a = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) a[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * 127)));
  return Buffer.from(a.buffer).toString("base64");
}

export async function GET(request) {
  const key = keyJina();
  if (!key) return Response.json({ error: "no JINA_API_KEY" }, { status: 400 });
  const url = new URL(request.url);
  const start = parseInt(url.searchParams.get("start") || "0", 10);
  const count = parseInt(url.searchParams.get("count") || "120", 10);

  const rows = models.filter((m) => m.photo).map((m) => ({ k: m.brand + "|" + m.model, b: m.brand, m: m.model, p: m.photo }));
  const slice = rows.slice(start, start + count);

  const results = [];
  try {
    for (let i = 0; i < slice.length; i += BATCH) {
      const chunk = slice.slice(i, i + BATCH);
      let vecs;
      try { vecs = await embedImages(key, chunk.map((c) => c.p)); }
      catch (e) { vecs = chunk.map(() => null); }
      chunk.forEach((c, j) => { if (vecs[j]) results.push({ k: c.k, b: c.b, m: c.m, p: c.p, v: toB64Int8(vecs[j]) }); });
    }
  } catch (e) {
    return Response.json({ error: scrub(String(e)).slice(0, 200) }, { status: 500 });
  }
  return Response.json({ total: rows.length, start, count, returned: results.length, dim: DIM, embeddings: results });
}
