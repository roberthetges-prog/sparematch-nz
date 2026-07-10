// Two-round visual matcher.
// Round 1 (recall): compare the customer photo against a brand-diverse sample -> find the brand.
// Round 2 (precision): compare against ALL models of the top brand(s) -> the exact model.
// Candidate images are fetched + base64-inlined server-side; unreachable ones are dropped so a
// single bad URL can't fail the call. Candidate catalogue is imported here so logic can't drift.

import models from "../../../lib/models.json";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODELS = process.env.VISION_MODEL
  ? [process.env.VISION_MODEL]
  : ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"];

const PRIORITY = ["Felton","Methven","Foreno","Voda","Greens","LeVivi","Robertson","Caroma","Grohe","Hansgrohe","Phoenix","Nero","Meir","Dorf","Mizu","Posh","Paini","Newform","Mondella","Buddy","Franke"];

const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]");
function readKey() {
  const raw = (process.env.ANTHROPIC_API_KEY || "").trim();
  const m = raw.match(/sk-ant-[A-Za-z0-9_\-]+/);
  return m ? m[0] : raw;
}

const SYSTEM = `You are a plumbing tapware visual-matching expert. A CUSTOMER PHOTO of a tap/mixer is shown first, then several numbered CATALOGUE photos of known products.
Judge which catalogue products are the SAME physical tap design as the customer's, comparing in priority order: overall silhouette/proportions; spout shape (gooseneck/straight/squared/curved) and cross-section (round vs flat); handle/lever design and where it sits; mount type (deck/wall). Ignore finish/colour, background, angle, lighting and image quality.
Return STRICT JSON only: {"ranked":[{"id":<number>,"score":<0-100>,"same":<true|false>,"reason":"<max 8 words>"}]}
- Include every candidate id (1..N) once, sorted by score descending.
- score = visual-design similarity (100 = clearly the same product/design family).
- same = true only when very likely the same product or an identical-body variant.
- Be discriminating: most candidates should score low unless the shape genuinely matches.`;

async function toInline(photo) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(photo, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 SpareMatchBot" } });
    clearTimeout(t);
    if (!r.ok) return null;
    let media = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4_500_000) return null;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(media)) {
      if (buf[0] === 0xff && buf[1] === 0xd8) media = "image/jpeg";
      else if (buf[0] === 0x89 && buf[1] === 0x50) media = "image/png";
      else if (buf.slice(0, 4).toString("ascii") === "RIFF") media = "image/webp";
      else return null;
    }
    return { media, data: buf.toString("base64") };
  } catch { return null; }
}

async function rerank(key, userData, userMedia, cands) {
  // inline candidate images, drop failures
  const inlined = await Promise.all(cands.map((c) => toInline(c.photo)));
  const prepared = cands.map((c, i) => ({ ...c, img: inlined[i] })).filter((c) => c.img);
  if (prepared.length < 2) return null;
  const content = [
    { type: "text", text: "CUSTOMER PHOTO (the tap to identify):" },
    { type: "image", source: { type: "base64", media_type: userMedia || "image/jpeg", data: userData } },
  ];
  prepared.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1} — ${c.brand} ${c.model}:` });
    content.push({ type: "image", source: { type: "base64", media_type: c.img.media, data: c.img.data } });
  });
  content.push({ type: "text", text: `Rank all ${prepared.length} candidates (ids 1..${prepared.length}) by how closely they match the CUSTOMER PHOTO. Return only the JSON.` });
  for (const model of MODELS) {
    let resp;
    try {
      resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 800, temperature: 0, system: SYSTEM, messages: [{ role: "user", content }] }),
      });
    } catch { return null; }
    if (resp.ok) {
      const json = await resp.json();
      const text = (json.content || []).map((c) => c.text || "").join("").trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      let parsed; try { parsed = JSON.parse(m[0]); } catch { return null; }
      return (parsed.ranked || [])
        .filter((r) => r && Number.isFinite(+r.id) && +r.id >= 1 && +r.id <= prepared.length)
        .map((r) => { const c = prepared[+r.id - 1]; return { ...c, img: undefined, score: Math.max(0, Math.min(100, +r.score || 0)), same: !!r.same, reason: String(r.reason || "").slice(0, 60) }; })
        .sort((a, b) => b.score - a.score);
    }
    const t = await resp.text();
    if (!/not_found/i.test(t)) return null;
  }
  return null;
}

function cardOf(m) {
  return { id: m.model, brand: m.brand, model: m.model, photo: m.photo, size: m.size || "", cartPart: m.cartPart || "", buyUrl: m.buyUrl || "", exploded: m.exploded || "", confirm: !!m.confirm };
}

export async function POST(request) {
  const key = readKey();
  if (!key || !key.startsWith("sk-ant-")) return Response.json({ configured: false });
  let body;
  try { body = await request.json(); } catch { return Response.json({ configured: true, error: "bad request" }, { status: 400 }); }
  const { data, mediaType } = body || {};
  const type = (body?.type || "").toLowerCase();
  const guesses = Array.isArray(body?.brandGuesses) ? body.brandGuesses.filter(Boolean) : [];
  if (!data) return Response.json({ configured: true, error: "no image" }, { status: 400 });

  const photod = models.filter((m) => m.photo);
  const typed = type ? photod.filter((m) => (m.model || "").toLowerCase().includes(type)) : photod;
  const pool = typed.length >= 6 ? typed : photod;

  const byBrand = {};
  for (const m of pool) (byBrand[m.brand] = byBrand[m.brand] || []).push(m);

  // ---- Round 1: brand-diverse recall (prioritise AI brand guesses, then common brands) ----
  const brandOrder = [...new Set([...guesses, ...PRIORITY, ...Object.keys(byBrand)])].filter((b) => byBrand[b]);
  const recall = [];
  for (const b of brandOrder) {
    for (let i = 0; i < 2 && i < byBrand[b].length; i++) recall.push(byBrand[b][i]);
    if (recall.length >= 16) break;
  }
  if (recall.length < 2) return Response.json({ configured: true, ranked: [] });

  let round1;
  try { round1 = await rerank(key, data, mediaType, recall.map(cardOf)); } catch { round1 = null; }
  if (!round1 || !round1.length) return Response.json({ configured: true, ranked: [], note: "recall failed" });

  // top brands from round 1 (up to 3 distinct)
  const topBrands = [];
  for (const r of round1) { if (!topBrands.includes(r.brand)) topBrands.push(r.brand); if (topBrands.length >= 5) break; }

  // ---- Round 2: precision within top brand(s) — compare against ALL their models ----
  // Round-robin across the top brands so EACH is represented in round 2 (otherwise the first
  // brand's many models fill the cap and the true brand never gets compared).
  const perBrand = topBrands.map((b) => (byBrand[b] || []));
  const seen = new Set(); const precCands = [];
  for (let idx = 0; precCands.length < 14; idx++) {
    let added = false;
    for (const list of perBrand) {
      const m = list[idx];
      if (!m) continue;
      const k = m.brand + "|" + m.model;
      if (seen.has(k)) continue;
      seen.add(k); precCands.push(m); added = true;
      if (precCands.length >= 14) break;
    }
    if (!added) break;
  }

  let round2 = null;
  if (precCands.length >= 2) {
    try { round2 = await rerank(key, data, mediaType, precCands.map(cardOf)); } catch { round2 = null; }
  }

  const finalRanked = (round2 && round2.length ? round2 : round1)
    .slice(0, 6)
    .map((r) => ({ id: r.id, brand: r.brand, model: r.model, photo: r.photo, size: r.size, cartPart: r.cartPart, buyUrl: r.buyUrl, exploded: r.exploded, confirm: r.confirm, score: r.score, same: r.same, reason: r.reason }));

  return Response.json({ configured: true, rounds: round2 ? 2 : 1, topBrands, ranked: finalRanked });
}
