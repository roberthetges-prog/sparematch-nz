// Two-stage visual matcher.
// STAGE 1 (recall): if catalogue image embeddings exist (lib/embeddings.json, built via Jina CLIP v2),
//   embed the uploaded photo with Jina and rank the WHOLE catalogue by cosine similarity -> top candidates.
//   No brand-narrowing that can drop the right product; scales to thousands of items.
// STAGE 2 (rerank): Claude vision compares the photo against the top candidates for precision.
// FALLBACK: if no Jina key / embeddings, use the previous two-round Claude-only matcher.

import models from "../../../lib/models.json";
import parts from "../../../lib/parts.json";
import cartimg from "../../../lib/cartimg.json";
import embeddings from "../../../lib/embeddings.json";
import { sbAdmin, sbRead } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODELS = process.env.VISION_MODEL ? [process.env.VISION_MODEL] : ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"];
const PRIORITY = ["Felton","Methven","Foreno","Voda","Greens","LeVivi","Robertson","Caroma","Grohe","Hansgrohe","Phoenix","Nero","Meir","Dorf","Mizu","Posh","Paini","Newform","Mondella","Buddy","Franke"];
const DIM = 256;

const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]").replace(/jina_[A-Za-z0-9_\-]+/g, "[redacted]");
function readKey() { const raw = (process.env.ANTHROPIC_API_KEY || "").trim(); const m = raw.match(/sk-ant-[A-Za-z0-9_\-]+/); return m ? m[0] : raw; }
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

const modelByKey = {}; for (const m of models) modelByKey[m.brand + "|" + m.model] = m;
const partById = {}; for (const p of parts) partById[p.id] = p;
function resolveKey(k) {
  if (k.startsWith("P|")) { const p = partById[+k.slice(2)]; if (!p || !p.photo) return null; return { kind: "part", brand: p.brand, model: (p.range || p.component || p.category || ""), photo: p.photo, part: p }; }
  if (k.startsWith("C|")) { const code = k.slice(2); const url = (cartimg.byCode || {})[code]; if (!url) return null; return { kind: "cart", brand: "", model: code + " cartridge", photo: url, card: { id: "c-" + code, brand: "", range: code + " cartridge", component: "Ceramic disc cartridge", category: "Cartridge", partNumber: code, valveType: "", dimension: "", supersession: "", buyUrl: "", sourceUrl: "", verified: "Y", notes: "Matched by cartridge photo \u2014 confirm the size and fit before ordering.", photo: url, tapPhoto: "", productType: "Tapware", valveFamily: "", explodedUrl: "" } }; }
  const m = modelByKey[k]; if (!m || !m.photo) return null; return { kind: "tap", brand: m.brand, model: m.model, photo: m.photo, size: m.size, cartPart: m.cartPart, buyUrl: m.buyUrl, exploded: m.exploded, confirm: m.confirm };
}
function cardOf(m) { return { id: m.model, brand: m.brand, model: m.model, photo: m.photo, size: m.size || "", cartPart: m.cartPart || "", buyUrl: m.buyUrl || "", exploded: m.exploded || "", confirm: !!m.confirm }; }

// ---------- embedding recall ----------
let CAT = null; // decoded catalogue vectors
function catalogue() {
  if (CAT) return CAT;
  CAT = [];
  for (const e of embeddings) {
    if (!e || !e.v) continue;
    const buf = Buffer.from(e.v, "base64");
    const a = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const f = new Float32Array(a.length); let n = 0;
    for (let i = 0; i < a.length; i++) { f[i] = a[i] / 127; n += f[i] * f[i]; }
    n = Math.sqrt(n) || 1; for (let i = 0; i < f.length; i++) f[i] /= n;
    CAT.push({ k: e.k, b: e.b, m: e.m, vec: f });
  }
  return CAT;
}
async function embedQuery(key, data, mediaType) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: [{ image: `data:${mediaType || "image/jpeg"};base64,${data}` }] }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const v = j.data && j.data[0] && j.data[0].embedding;
  if (!v) return null;
  const f = new Float32Array(v.length); let n = 0;
  for (let i = 0; i < v.length; i++) { f[i] = v[i]; n += v[i] * v[i]; }
  n = Math.sqrt(n) || 1; for (let i = 0; i < f.length; i++) f[i] /= n;
  return f;
}
function recall(qvec, type, topN) {
  const cat = catalogue();
  const scored = cat.map((c) => { let s = 0; for (let i = 0; i < qvec.length; i++) s += qvec[i] * c.vec[i]; return { k: c.k, s }; });
  if (type) { const t = type.toLowerCase(); for (const r of scored) if ((r.k || "").toLowerCase().includes(t)) r.s += 0.03; }
  scored.sort((a, b) => b.s - a.s);
  const out = []; const seen = new Set();
  for (const r of scored) { if (seen.has(r.k)) continue; seen.add(r.k); const c = resolveKey(r.k); if (c && c.photo) out.push(c); if (out.length >= topN) break; }
  return out;
}

// ---------- Supabase pgvector recall (scales to 100k+, no redeploy to add items) ----------
function cap(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function cardFromRow(row, component) {
  return { id: "db-" + row.id, brand: row.brand || "", range: row.fits || "", component: component || row.model, category: cap(row.category), partNumber: row.part_no || "", valveType: "", dimension: row.size || "", supersession: "", buyUrl: row.buy_url || "", sourceUrl: row.buy_url || "", verified: "Y", notes: row.confirm ? "Confirm the size and fit before ordering." : "", photo: row.photo_url, tapPhoto: "", productType: "Tapware", valveFamily: "", explodedUrl: row.exploded || "" };
}
function candFromRow(row) {
  const cat = String(row.category || "").toLowerCase();
  if (cat === "cartridge") return { kind: "cart", brand: row.brand || "", model: row.model, photo: row.photo_url, card: cardFromRow(row, "Ceramic disc cartridge") };
  if (cat === "mixer") return { kind: "tap", brand: row.brand, model: row.model, photo: row.photo_url, size: row.size, cartPart: row.part_no, buyUrl: row.buy_url, exploded: row.exploded, confirm: row.confirm };
  return { kind: "part", brand: row.brand || "", model: row.model, photo: row.photo_url, part: cardFromRow(row) };
}
async function recallDB(qvec, topN) {
  const sb = sbAdmin() || sbRead();
  if (!sb) return null;
  const vecStr = "[" + Array.from(qvec).join(",") + "]";
  const { data, error } = await sb.rpc("match_products", { query_embedding: vecStr, match_count: topN, filter_category: null });
  if (error || !Array.isArray(data)) return null;
  const out = [];
  for (const row of data) {
    let c = row.source_key ? resolveKey(row.source_key) : null; // rich card from bundled data when available
    if (!c) c = candFromRow(row);                                 // else build straight from the DB row (e.g. newly ingested)
    if (c && c.photo) out.push(c);
  }
  return out;
}

// ---------- Claude vision rerank ----------
const SYSTEM = `You are a plumbing tapware visual-matching expert. A CUSTOMER PHOTO of a tap/mixer is shown first, then several numbered CATALOGUE photos of known products.
Judge which catalogue products are the SAME physical tap design as the customer's: overall silhouette/proportions; spout shape and cross-section; handle/lever design and position; mount type. Ignore finish/colour, background, angle, lighting.
Return STRICT JSON only: {"ranked":[{"id":<number>,"score":<0-100>,"same":<true|false>,"reason":"<max 8 words>"}]}
- Include every candidate id (1..N) once, sorted by score descending. score = visual-design similarity. same = true only if very likely the same product. Be discriminating.`;
async function toInline(photo) {
  try { const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(photo, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot" } }); clearTimeout(t);
    if (!r.ok) return null; let media = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer()); if (!buf.length || buf.length > 4500000) return null;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) { if (buf[0] === 0xff && buf[1] === 0xd8) media = "image/jpeg"; else if (buf[0] === 0x89 && buf[1] === 0x50) media = "image/png"; else if (buf.slice(0,4).toString("ascii") === "RIFF") media = "image/webp"; else return null; }
    return { media, data: buf.toString("base64") };
  } catch { return null; }
}
async function visionCall(key, userData, userMedia, prepared) {
  const content = [ { type: "text", text: "CUSTOMER PHOTO (the tap to identify):" }, { type: "image", source: { type: "base64", media_type: userMedia || "image/jpeg", data: userData } } ];
  prepared.forEach((c, i) => { content.push({ type: "text", text: `Candidate ${i + 1} — ${c.brand} ${c.model}:` }); content.push({ type: "image", source: { type: "base64", media_type: c.img.media, data: c.img.data } }); });
  content.push({ type: "text", text: `Rank all ${prepared.length} candidates (ids 1..${prepared.length}) by how closely they match the CUSTOMER PHOTO. Return only the JSON.` });
  for (const model of MODELS) {
    let resp; try { resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 800, temperature: 0, system: SYSTEM, messages: [{ role: "user", content }] }) }); } catch { return null; }
    if (resp.ok) { const json = await resp.json(); const text = (json.content || []).map((c) => c.text || "").join("").trim(); const m = text.match(/\{[\s\S]*\}/); if (!m) return null; let parsed; try { parsed = JSON.parse(m[0]); } catch { return null; }
      return (parsed.ranked || []).filter((r) => r && Number.isFinite(+r.id) && +r.id >= 1 && +r.id <= prepared.length).map((r) => { const c = prepared[+r.id - 1]; return { ...c, img: undefined, score: Math.max(0, Math.min(100, +r.score || 0)), same: !!r.same, reason: String(r.reason || "").slice(0, 60) }; }); }
    const t = await resp.text(); if (!/not_found/i.test(t)) return null;
  }
  return null;
}
async function rerank(key, userData, userMedia, cands) {
  const inlined = await Promise.all(cands.map((c) => toInline(c.photo)));
  const prepared = cands.map((c, i) => ({ ...c, img: inlined[i] })).filter((c) => c.img);
  if (prepared.length < 2) return null;
  const full = await visionCall(key, userData, userMedia, prepared);
  if (full && full.length) return full.sort((a, b) => b.score - a.score);
  const CH = 5; const chunks = [];
  for (let i = 0; i < prepared.length; i += CH) { let ch = prepared.slice(i, i + CH); if (ch.length === 1 && prepared.length > 1) ch = prepared.slice(Math.max(0, prepared.length - 2)); if (ch.length >= 2) chunks.push(ch); }
  const results = await Promise.all(chunks.map((ch) => visionCall(key, userData, userMedia, ch)));
  const merged = []; for (const r of results) if (r && r.length) merged.push(...r);
  const seen = new Set(); const out = [];
  for (const r of merged.sort((a, b) => b.score - a.score)) { const k = r.brand + "|" + r.model; if (seen.has(k)) continue; seen.add(k); out.push(r); }
  return out.length ? out : null;
}

// ---------- fallback two-round (Claude only) ----------
async function twoRound(key, data, mediaType, type, guesses) {
  const photod = models.filter((m) => m.photo);
  const typed = type ? photod.filter((m) => (m.model || "").toLowerCase().includes(type)) : photod;
  const pool = typed.length >= 6 ? typed : photod;
  const byBrand = {}; for (const m of pool) (byBrand[m.brand] = byBrand[m.brand] || []).push(m);
  const brandOrder = [...new Set([...guesses, ...PRIORITY, ...Object.keys(byBrand)])].filter((b) => byBrand[b]);
  const recallList = []; for (const b of brandOrder) { for (let i = 0; i < 2 && i < byBrand[b].length; i++) recallList.push(byBrand[b][i]); if (recallList.length >= 16) break; }
  if (recallList.length < 2) return [];
  const r1 = await rerank(key, data, mediaType, recallList.map(cardOf)); if (!r1 || !r1.length) return [];
  const topBrands = []; for (const r of r1) { if (!topBrands.includes(r.brand)) topBrands.push(r.brand); if (topBrands.length >= 5) break; }
  const perBrand = topBrands.map((b) => (byBrand[b] || [])); const seen = new Set(); const prec = [];
  for (let idx = 0; prec.length < 14; idx++) { let added = false; for (const list of perBrand) { const m = list[idx]; if (!m) continue; const k = m.brand + "|" + m.model; if (seen.has(k)) continue; seen.add(k); prec.push(m); added = true; if (prec.length >= 14) break; } if (!added) break; }
  const r2 = prec.length >= 2 ? await rerank(key, data, mediaType, prec.map(cardOf)) : null;
  return (r2 && r2.length ? r2 : r1);
}

// ---- Cost / abuse guardrails (best-effort, per warm instance) ----
const RL = { ip: new Map(), global: [] };
const IP_MAX = 25, IP_WINDOW = 5 * 60 * 1000;      // 25 matches / 5 min per IP
const GLOBAL_MAX = 60, GLOBAL_WINDOW = 60 * 1000;  // 60 matches / min circuit-breaker
const MAX_IMG = 9_000_000;                          // ~6.5MB of base64
function clientIp(request) {
  const h = request.headers;
  return ((h.get("x-forwarded-for") || "").split(",")[0].trim()) || h.get("x-real-ip") || "unknown";
}
function rateLimited(ip) {
  const now = Date.now();
  RL.global = RL.global.filter((t) => now - t < GLOBAL_WINDOW);
  if (RL.global.length >= GLOBAL_MAX) return { limited: true, scope: "global" };
  let arr = (RL.ip.get(ip) || []).filter((t) => now - t < IP_WINDOW);
  if (arr.length >= IP_MAX) { RL.ip.set(ip, arr); return { limited: true, scope: "ip" }; }
  arr.push(now); RL.ip.set(ip, arr); RL.global.push(now);
  if (RL.ip.size > 5000) { for (const [k, v] of RL.ip) { if (!v.length || now - v[v.length - 1] > IP_WINDOW) RL.ip.delete(k); } }
  return { limited: false };
}

export async function POST(request) {
  const key = readKey();
  if (!key || !key.startsWith("sk-ant-")) return Response.json({ configured: false });
  let body; try { body = await request.json(); } catch { return Response.json({ configured: true, error: "bad request" }, { status: 400 }); }
  const { data, mediaType } = body || {};
  const type = (body?.type || "").toLowerCase();
  const guesses = Array.isArray(body?.brandGuesses) ? body.brandGuesses.filter(Boolean) : [];
  if (!data) return Response.json({ configured: true, error: "no image" }, { status: 400 });
  if (typeof data === "string" && data.length > MAX_IMG) return Response.json({ configured: true, error: "image_too_large", message: "That image is too large — please try a smaller photo." }, { status: 413 });
  const rl = rateLimited(clientIp(request));
  if (rl.limited) return Response.json({ configured: true, error: "rate_limited", message: "You're going a bit fast — give it a few seconds and try again." }, { status: 429 });

  let ranked = [], stage = "fallback";
  const jkey = keyJina();
  try {
    if (jkey) {
      const qv = await embedQuery(jkey, data, mediaType);
      if (qv) {
        let cands = await recallDB(qv, 18);            // Supabase pgvector (live catalogue, no redeploy)
        let src = "db";
        if (!cands && embeddings && embeddings.length > 5) { cands = recall(qv, type, 18); src = "bundled"; }
        if (cands && cands.length >= 2) {
          const rr = await rerank(key, data, mediaType, cands.slice(0, 12));
          if (rr && rr.length) { ranked = rr; stage = "embed+rerank:" + src; }
        }
      }
    }
  } catch (e) { /* fall through */ }

  if (!ranked.length) { try { ranked = await twoRound(key, data, mediaType, type, guesses); stage = "tworound"; } catch { ranked = []; } }

  const finalRanked = ranked.slice(0, 6).map((r) => ({ id: r.id || r.model, brand: r.brand, model: r.model, photo: r.photo, size: r.size, cartPart: r.cartPart, buyUrl: r.buyUrl, exploded: r.exploded, confirm: r.confirm, score: r.score, same: r.same, reason: r.reason, kind: r.kind || "tap", part: r.part, card: r.card }));
  return Response.json({ configured: true, stage, ranked: finalRanked });
}
