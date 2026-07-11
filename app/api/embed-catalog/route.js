// One-time (re-runnable) builder: computes an image embedding for every catalogue photo via
// Jina CLIP v2. We fetch each image server-side and send it to Jina as base64 (so a single
// unreachable URL can't fail the batch). Quantised to int8 + base64 for compactness.
// Paginate with ?start=0&count=60. Capture output and commit as lib/embeddings.json.

import models from "../../../lib/models.json";
import parts from "../../../lib/parts.json";
import cartimg from "../../../lib/cartimg.json";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 120;

const DIM = 256;
const BATCH = 20;
const scrub = (s) => String(s).replace(/jina_[A-Za-z0-9_\-]+/g, "[redacted]");
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

async function toDataURI(url) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot" } });
    clearTimeout(t);
    if (!r.ok) return null;
    let media = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 12000000) return null;
    try {
      const small = await sharp(buf).resize(512, 512, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 82 }).toBuffer();
      return `data:image/jpeg;base64,${small.toString("base64")}`;
    } catch { return null; }
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jinaEmbed(key, dataURIs) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: dataURIs.map((u) => ({ image: u })) }),
    });
    if (r.ok) { const j = await r.json(); const out = new Array(dataURIs.length).fill(null); for (const d of j.data || []) if (Number.isInteger(d.index)) out[d.index] = d.embedding; return out; }
    const body = scrub(await r.text()).slice(0, 200);
    if (r.status === 429 && attempt < 3) { await sleep(20000); continue; } // rate-limited: wait a window and retry
    throw new Error("jina " + r.status + " " + body);
  }
  return dataURIs.map(() => null);
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
  const admin = (process.env.EMBED_TOKEN || "").trim();
  const given = (url.searchParams.get("key") || "").trim();
  if (!admin || given !== admin) return Response.json({ error: "forbidden" }, { status: 403 });
  const start = parseInt(url.searchParams.get("start") || "0", 10);
  const count = Math.min(Math.max(parseInt(url.searchParams.get("count") || "20", 10) || 20, 1), 60);

  const tapRows = models.filter((m) => m.photo).map((m) => ({ k: m.brand + "|" + m.model, b: m.brand, m: m.model, p: m.photo }));
  const partRows = parts.filter((p) => p.photo).map((p) => ({ k: "P|" + p.id, b: p.brand, m: (p.range || p.component || p.category || ""), p: p.photo }));
  const cartRows = Object.entries((cartimg && cartimg.byCode) || {}).map(([code, url]) => ({ k: "C|" + code, b: "", m: code + " cartridge", p: url }));
  const rows = tapRows.concat(partRows, cartRows);
  const slice = rows.slice(start, start + count);

  // fetch all images -> data URIs (drop failures)
  const uris = await Promise.all(slice.map((c) => toDataURI(c.p)));
  const prepared = slice.map((c, i) => ({ ...c, uri: uris[i] })).filter((c) => c.uri);

  const results = []; const errors = [];
  for (let i = 0; i < prepared.length; i += BATCH) {
    const chunk = prepared.slice(i, i + BATCH);
    let vecs = null;
    try { vecs = await jinaEmbed(key, chunk.map((c) => c.uri)); }
    catch (e) {
      if (errors.length < 3) errors.push(scrub(String(e && e.message || e)).slice(0, 200));
      // fall back to single-image embeds so one bad image doesn't drop the whole chunk
      vecs = [];
      for (const c of chunk) { try { const v = await jinaEmbed(key, [c.uri]); vecs.push(v[0]); } catch { vecs.push(null); } }
    }
    chunk.forEach((c, j) => { if (vecs[j]) results.push({ k: c.k, b: c.b, m: c.m, v: toB64Int8(vecs[j]) }); });
  }
  return Response.json({ total: rows.length, start, count, fetched: prepared.length, returned: results.length, dim: DIM, errors, embeddings: results });
}
