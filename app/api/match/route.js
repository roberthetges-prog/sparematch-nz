// Two-stage visual matcher — v2 (multi-angle + calibrated abstention).
//
// WHY v2: real-world testing showed the reranker declaring same=true on FOUR different
// brands at once (92/88/85/83). A confident wrong answer is worse than an honest "pick one
// of these three" — get it wrong twice and the plumber never opens the app again.
//
// STAGE 1 (recall): embed EVERY angle the user gave us with Jina CLIP v2, run each against
//   pgvector, then fuse the ranked lists with Reciprocal Rank Fusion. A product that looks
//   right from BOTH angles beats one that only looks right from one.
// STAGE 2 (rerank): Claude vision sees all the customer's angles side by side against the
//   candidates, and is allowed to mark AT MOST ONE as same=true.
// STAGE 3 (decide): the server calibrates. Clear winner -> answer. Otherwise -> top 3 plus one
//   discriminating question the user settles by looking at their own tap.

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

// Calibration thresholds — deliberately strict.
const WIN_SCORE = 78;   // top candidate must be at least this good to be called an answer
const WIN_GAP = 8;      // ...and this far clear of the runner-up

const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]").replace(/jina_[A-Za-z0-9_\-]+/g, "[redacted]");
function readKey() { const raw = (process.env.ANTHROPIC_API_KEY || "").trim(); const m = raw.match(/sk-ant-[A-Za-z0-9_\-]+/); return m ? m[0] : raw; }
function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

const modelByKey = {}; for (const m of models) modelByKey[m.brand + "|" + m.model] = m;
const partById = {}; for (const p of parts) partById[p.id] = p;
function resolveKey(k) {
  if (k.startsWith("P|")) { const p = partById[+k.slice(2)]; if (!p || !p.photo) return null; return { kind: "part", brand: p.brand, model: (p.range || p.component || p.category || ""), photo: p.photo, part: p }; }
  if (k.startsWith("C|")) { const code = k.slice(2); const url = (cartimg.byCode || {})[code]; if (!url) return null; return { kind: "cart", brand: "", model: code + " cartridge", photo: url, card: { id: "c-" + code, brand: "", range: code + " cartridge", component: "Ceramic disc cartridge", category: "Cartridge", partNumber: code, valveType: "", dimension: "", supersession: "", buyUrl: "", sourceUrl: "", verified: "Y", notes: "Matched by cartridge photo - confirm the size and fit before ordering.", photo: url, tapPhoto: "", productType: "Tapware", valveFamily: "", explodedUrl: "" } }; }
  const m = modelByKey[k]; if (!m || !m.photo) return null; return { kind: "tap", brand: m.brand, model: m.model, photo: m.photo, size: m.size, cartPart: m.cartPart, buyUrl: m.buyUrl, exploded: m.exploded, confirm: m.confirm };
}
function cardOf(m) { return { id: m.model, brand: m.brand, model: m.model, photo: m.photo, size: m.size || "", cartPart: m.cartPart || "", buyUrl: m.buyUrl || "", exploded: m.exploded || "", confirm: !!m.confirm }; }

// ---------- embedding recall ----------
let CAT = null;
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
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: [{ image: "data:" + (mediaType || "image/jpeg") + ";base64," + data }] }),
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
  for (const r of scored) { if (seen.has(r.k)) continue; seen.add(r.k); const c = resolveKey(r.k); if (c && c.photo) { c.key = r.k; out.push(c); } if (out.length >= topN) break; }
  return out;
}

// ---------- Supabase pgvector recall ----------
function cap(s) { s = String(s || ""); return s ? s[0].toUpperCase() + s.slice(1) : s; }
function cardFromRow(row, component) {
  return { id: "db-" + row.id, brand: row.brand || "", range: row.fits || "", component: component || row.model, category: cap(row.category), partNumber: row.part_no || "", valveType: "", dimension: row.size || "", supersession: "", buyUrl: row.buy_url || "", sourceUrl: row.buy_url || "", verified: "Y", notes: row.confirm ? "Confirm the size and fit before ordering." : "", photo: row.photo_url, tapPhoto: "", productType: "Tapware", valveFamily: "", explodedUrl: row.exploded || "" };
}
function candFromRow(row) {
  const cat = String(row.category || "").toLowerCase();
  if (cat === "cartridge") return { kind: "cart", brand: row.brand || "", model: row.model, photo: row.photo_url, card: cardFromRow(row, "Ceramic disc cartridge") };
  if (cat.includes("mixer") || cat === "tap") return { kind: "tap", brand: row.brand, model: row.model, photo: row.photo_url, size: row.size, cartPart: row.part_no, buyUrl: row.buy_url, exploded: row.exploded, confirm: row.confirm };
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
    let c = row.source_key ? resolveKey(row.source_key) : null;
    if (!c) c = candFromRow(row);
    if (c && c.photo) { c.cat = String(row.category || "").toLowerCase(); c.key = "db" + row.id; out.push(c); }
  }
  return out;
}

// Reciprocal Rank Fusion - merge the ranked lists produced by each camera angle.
// A product that ranks decently from BOTH angles outranks one that only nails a single view.
// This is the whole point of the second photo: it cancels out the flukes of one angle.
const RRF_K = 20;
function fuse(lists) {
  const acc = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    list.forEach((c, i) => {
      const k = c.key || ((c.brand || "") + "|" + (c.model || ""));
      const cur = acc.get(k);
      const add = 1 / (RRF_K + i + 1);
      if (cur) { cur.rrf += add; cur.seen += 1; }
      else acc.set(k, { c, rrf: add, seen: 1 });
    });
  }
  return [...acc.values()].sort((a, b) => (b.seen - a.seen) || (b.rrf - a.rrf)).map((e) => e.c);
}

// Only trust the brand when it was physically READ off the part (stamped/etched name).
// A brand *guessed* from styling is exactly the confident-but-wrong signal we are killing.
function narrowByBrand(cands, brand) {
  if (!brand || !Array.isArray(cands) || !cands.length) return cands;
  const b = String(brand).toLowerCase().trim();
  const hit = cands.filter((c) => { const cb = String(c.brand || "").toLowerCase(); return cb && (cb.includes(b) || b.includes(cb)); });
  return hit.length >= 2 ? hit : cands;
}

// A basin mixer and its matching shower mixer are a styled PAIR - same handle, same faceplate.
function narrowByFixture(cands, type) {
  if (!type || !Array.isArray(cands) || !cands.length) return cands;
  const hit = cands.filter((c) => (c.cat || "").includes(type));
  const rest = cands.filter((c) => !(c.cat || "").includes(type));
  if (hit.length >= 6) return hit;
  if (hit.length) return [...hit, ...rest];
  return cands;
}

// ---------- Claude vision rerank ----------
const SYSTEM = [
  "You are a plumbing tapware visual-matching expert. You are shown ONE OR TWO CUSTOMER PHOTOS of the SAME tap from different angles, then several numbered CATALOGUE photos of known products.",
  "Use every customer angle together - one angle may hide the spout profile or the handle join that the other reveals. Judge: overall silhouette and proportions; spout shape and cross-section; handle/lever shape, size and where it joins the body; the base/escutcheon; mount type. Ignore finish, colour, background, lighting.",
  "",
  "CRITICAL - FIXTURE TYPE COMES FIRST. Within a range the manufacturer sells a BASIN mixer and a SHOWER mixer as a matched pair: identical handle, near-identical faceplate. They are DIFFERENT products and must never be matched to each other.",
  "- BASIN mixer: stands on the basin/vanity WITH A SPOUT that water pours from.",
  "- SHOWER mixer: mounted IN THE WALL - faceplate and handle, NO spout.",
  "- SINK/kitchen mixer: tall or gooseneck spout, often a pull-out spray.",
  "- BATH mixer: spout over a bath.",
  "A candidate whose FIXTURE differs from the customer photo must score below 30 and same=false, however alike the handle looks.",
  "",
  "CRITICAL - HONEST CONFIDENCE. Being confidently wrong destroys this product. Most single-lever mixers genuinely look alike; that is a FACT about tapware, not a failure of your eyesight.",
  "- AT MOST ONE candidate may have same=true. Never two.",
  "- Set same=true ONLY if that candidate matches on a SPECIFIC, NAMEABLE detail the others do not share (e.g. 'spout is square in section, all others are round'; 'lever is a flat paddle, others are cylindrical pins'). State that detail in reason.",
  "- If several candidates are equally plausible generic cylindrical mixers, set same=false for ALL of them. That is the correct and useful answer.",
  "- score is visual-design similarity 0-100. Do NOT compress everything into 80-95. If you cannot tell candidates apart they should sit at the SAME score, and none should be above 75.",
  "",
  "DISCRIMINATING QUESTION. If no candidate earns same=true, look at your top 3 and find the ONE physical feature that separates them - something the customer can check by walking to the tap and looking at it (spout cross-section round vs square; lever flat paddle vs round pin; base round vs square; body straight vs tapered; a brand name visible on the body or under the spout). Return it as question with 2-4 options; each option maps to the candidate ids it points to.",
  "",
  'Return STRICT JSON only: {"ranked":[{"id":<number>,"score":<0-100>,"same":<true|false>,"reason":"<max 10 words>"}],"question":"<question or empty>","options":[{"label":"<what they would see>","ids":[<ids>]}]}',
  "Include every candidate id (1..N) once, sorted by score descending.",
].join("\n");

async function toInline(photo) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(photo, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 TapSnapBot" } }); clearTimeout(t);
    if (!r.ok) return null;
    let media = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer()); if (!buf.length || buf.length > 4500000) return null;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) { if (buf[0] === 0xff && buf[1] === 0xd8) media = "image/jpeg"; else if (buf[0] === 0x89 && buf[1] === 0x50) media = "image/png"; else if (buf.slice(0, 4).toString("ascii") === "RIFF") media = "image/webp"; else return null; }
    return { media, data: buf.toString("base64") };
  } catch { return null; }
}
async function visionCall(key, shots, prepared) {
  const content = [];
  shots.forEach((s, i) => {
    content.push({ type: "text", text: shots.length > 1 ? "CUSTOMER PHOTO - angle " + (i + 1) + " of " + shots.length + " (same tap):" : "CUSTOMER PHOTO (the tap to identify):" });
    content.push({ type: "image", source: { type: "base64", media_type: s.mediaType || "image/jpeg", data: s.data } });
  });
  prepared.forEach((c, i) => {
    content.push({ type: "text", text: "Candidate " + (i + 1) + " - " + c.brand + " " + c.model + ":" });
    content.push({ type: "image", source: { type: "base64", media_type: c.img.media, data: c.img.data } });
  });
  content.push({ type: "text", text: "Rank all " + prepared.length + " candidates (ids 1.." + prepared.length + ") against the customer tap. Remember: at most ONE same=true, and only for a nameable distinguishing detail. Return only the JSON." });
  for (const model of MODELS) {
    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model, max_tokens: 1000, temperature: 0, system: SYSTEM, messages: [{ role: "user", content }] }) });
    } catch { return null; }
    if (resp.ok) {
      const json = await resp.json();
      const text = (json.content || []).map((c) => c.text || "").join("").trim();
      const m = text.match(/\{[\s\S]*\}/); if (!m) return null;
      let parsed; try { parsed = JSON.parse(m[0]); } catch { return null; }
      const ranked = (parsed.ranked || [])
        .filter((r) => r && Number.isFinite(+r.id) && +r.id >= 1 && +r.id <= prepared.length)
        .map((r) => { const c = prepared[+r.id - 1]; return { ...c, img: undefined, vid: +r.id, score: Math.max(0, Math.min(100, +r.score || 0)), same: !!r.same, reason: String(r.reason || "").slice(0, 70) }; });
      // Belt and braces: the model is told at most one same=true. Enforce it anyway.
      let kept = false;
      for (const r of ranked.slice().sort((a, b) => b.score - a.score)) { if (r.same) { if (kept) r.same = false; else kept = true; } }
      const q = String(parsed.question || "").slice(0, 160);
      const opts = (Array.isArray(parsed.options) ? parsed.options : [])
        .map((o) => ({ label: String((o && o.label) || "").slice(0, 70), ids: (Array.isArray(o && o.ids) ? o.ids : []).map(Number).filter((n) => n >= 1 && n <= prepared.length) }))
        .filter((o) => o.label && o.ids.length);
      return { ranked, question: q, options: opts };
    }
    const t = await resp.text(); if (!/not_found/i.test(t)) return null;
  }
  return null;
}
async function rerank(key, shots, cands) {
  const inlined = await Promise.all(cands.map((c) => toInline(c.photo)));
  const prepared = cands.map((c, i) => ({ ...c, img: inlined[i] })).filter((c) => c.img);
  if (prepared.length < 2) return null;
  const full = await visionCall(key, shots, prepared);
  if (full && full.ranked && full.ranked.length) { full.ranked.sort((a, b) => b.score - a.score); return full; }
  const CH = 5; const chunks = [];
  for (let i = 0; i < prepared.length; i += CH) { let ch = prepared.slice(i, i + CH); if (ch.length === 1 && prepared.length > 1) ch = prepared.slice(Math.max(0, prepared.length - 2)); if (ch.length >= 2) chunks.push(ch); }
  const results = await Promise.all(chunks.map((ch) => visionCall(key, shots, ch)));
  const merged = []; for (const r of results) if (r && r.ranked && r.ranked.length) merged.push(...r.ranked);
  const seen = new Set(); const out = [];
  for (const r of merged.sort((a, b) => b.score - a.score)) { const k = r.brand + "|" + r.model; if (seen.has(k)) continue; seen.add(k); out.push(r); }
  let kept = false; for (const r of out) { if (r.same) { if (kept) r.same = false; else kept = true; } }
  return out.length ? { ranked: out, question: "", options: [] } : null;
}

// ---------- fallback two-round (Claude only) ----------
async function twoRound(key, shots, type, guesses) {
  const photod = models.filter((m) => m.photo);
  const typed = type ? photod.filter((m) => (m.model || "").toLowerCase().includes(type)) : photod;
  const pool = typed.length >= 6 ? typed : photod;
  const byBrand = {}; for (const m of pool) (byBrand[m.brand] = byBrand[m.brand] || []).push(m);
  const brandOrder = [...new Set([...guesses, ...PRIORITY, ...Object.keys(byBrand)])].filter((b) => byBrand[b]);
  const recallList = []; for (const b of brandOrder) { for (let i = 0; i < 2 && i < byBrand[b].length; i++) recallList.push(byBrand[b][i]); if (recallList.length >= 16) break; }
  if (recallList.length < 2) return null;
  const r1 = await rerank(key, shots, recallList.map(cardOf)); if (!r1 || !r1.ranked.length) return null;
  const topBrands = []; for (const r of r1.ranked) { if (!topBrands.includes(r.brand)) topBrands.push(r.brand); if (topBrands.length >= 5) break; }
  const perBrand = topBrands.map((b) => (byBrand[b] || [])); const seen = new Set(); const prec = [];
  for (let idx = 0; prec.length < 14; idx++) { let added = false; for (const list of perBrand) { const m = list[idx]; if (!m) continue; const k = m.brand + "|" + m.model; if (seen.has(k)) continue; seen.add(k); prec.push(m); added = true; if (prec.length >= 14) break; } if (!added) break; }
  const r2 = prec.length >= 2 ? await rerank(key, shots, prec.map(cardOf)) : null;
  return (r2 && r2.ranked.length ? r2 : r1);
}

// ---- Cost / abuse guardrails ----
const RL = { ip: new Map(), global: [] };
const IP_MAX = 25, IP_WINDOW = 5 * 60 * 1000;
const GLOBAL_MAX = 60, GLOBAL_WINDOW = 60 * 1000;
const MAX_IMG = 9000000;
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

  // Accept either the new multi-angle {images:[{data,mediaType}]} or the legacy {data,mediaType}.
  let shots = Array.isArray(body && body.images) ? body.images : [];
  if (!shots.length && body && body.data) shots = [{ data: body.data, mediaType: body.mediaType }];
  shots = shots.filter((s) => s && typeof s.data === "string" && s.data.length).slice(0, 3);
  if (!shots.length) return Response.json({ configured: true, error: "no image" }, { status: 400 });
  if (shots.some((s) => s.data.length > MAX_IMG)) return Response.json({ configured: true, error: "image_too_large", message: "That image is too large - please try a smaller photo." }, { status: 413 });

  const type = String((body && body.type) || "").toLowerCase();
  const guesses = Array.isArray(body && body.brandGuesses) ? body.brandGuesses.filter(Boolean) : [];
  const brandSure = !!(body && body.brandSure);
  const brand = String((body && body.brand) || "");

  const rl = rateLimited(clientIp(request));
  if (rl.limited) return Response.json({ configured: true, error: "rate_limited", message: "You're going a bit fast - give it a few seconds and try again." }, { status: 429 });

  let res = null, stage = "fallback";
  const jkey = keyJina();
  try {
    if (jkey) {
      const qvs = (await Promise.all(shots.map((s) => embedQuery(jkey, s.data, s.mediaType)))).filter(Boolean);
      if (qvs.length) {
        let cands = null, src = "db";
        const lists = (await Promise.all(qvs.map((qv) => recallDB(qv, 60)))).filter(Boolean);
        if (lists.length) cands = fuse(lists);
        if (!cands && embeddings && embeddings.length > 5) { cands = fuse(qvs.map((qv) => recall(qv, type, 24))); src = "bundled"; }
        if (cands) {
          if (brandSure) cands = narrowByBrand(cands, brand);   // only when the name was READ off the part
          cands = narrowByFixture(cands, type);
        }
        if (cands && cands.length >= 2) {
          const rr = await rerank(key, shots, cands.slice(0, 12));
          if (rr && rr.ranked.length) { res = rr; stage = "embed+rerank:" + src + (type ? ":" + type : "") + ":x" + qvs.length; }
        }
      }
    }
  } catch (e) { /* fall through */ }

  if (!res) { try { res = await twoRound(key, shots, type, guesses); stage = "tworound"; } catch { res = null; } }
  if (!res) return Response.json({ configured: true, stage, decision: "none", ranked: [] });

  const ranked = res.ranked;
  const top = ranked[0], second = ranked[1];

  // ---- Calibration: the guard that stops us being confidently wrong. ----
  // We only call it an answer when the winner is genuinely good AND genuinely clear of the pack.
  const clear = !!(top && top.same && top.score >= WIN_SCORE && (!second || top.score - second.score >= WIN_GAP));
  const decision = clear ? "confident" : "choose";

  // When unsure, hand back the single question that separates the top 3, so the user settles it
  // with one glance at their own tap instead of us guessing and burning their trust.
  const top3 = ranked.slice(0, 3);
  const idset = new Set(top3.map((r) => r.vid));
  const options = decision === "choose"
    ? (res.options || []).map((o) => ({ label: o.label, ids: o.ids.filter((i) => idset.has(i)) })).filter((o) => o.ids.length)
    : [];
  const question = decision === "choose" && options.length >= 2 ? res.question : "";

  const shape = (r) => ({ id: r.id || r.model, vid: r.vid, brand: r.brand, model: r.model, photo: r.photo, size: r.size, cartPart: r.cartPart, buyUrl: r.buyUrl, exploded: r.exploded, confirm: r.confirm, score: r.score, same: r.same, reason: r.reason, kind: r.kind || "tap", part: r.part, card: r.card });
  return Response.json({
    configured: true,
    stage,
    decision,
    angles: shots.length,
    question,
    options,
    ranked: ranked.slice(0, 6).map(shape),
  });
}
