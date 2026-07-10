// Visual matcher: compares the customer's uploaded tap photo against a shortlist of our own
// catalogue product photos and ranks which are the same product (Claude multi-image compare).
// Robustness: we fetch each candidate image server-side and base64-encode it, dropping any that
// fail to load — so Anthropic never receives an unreachable URL (which would fail the whole call).

export const runtime = "nodejs";
export const maxDuration = 60;

const MODELS = process.env.VISION_MODEL
  ? [process.env.VISION_MODEL]
  : ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"];

const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]");
function readKey() {
  const raw = (process.env.ANTHROPIC_API_KEY || "").trim();
  const m = raw.match(/sk-ant-[A-Za-z0-9_\-]+/);
  return m ? m[0] : raw;
}

const SYSTEM = `You are a plumbing tapware visual-matching expert. A CUSTOMER PHOTO of a tap/mixer is shown first, then several numbered CATALOGUE photos of known products.
Judge which catalogue products are the SAME physical tap design as the customer's, comparing in this priority order: overall silhouette and body shape; spout shape (gooseneck/straight/squared/curved) and cross-section (round vs flat); handle/lever design and where it sits; mount type (deck/wall); proportions. Ignore differences in finish/colour, background, angle, lighting and image quality — a chrome catalogue photo can still match a brushed tap of the same design.
Return STRICT JSON only, no prose:
{"ranked":[{"id":<number>,"score":<0-100>,"same":<true|false>,"reason":"<max 8 words>"}]}
Rules:
- Include EVERY candidate id (1..N) exactly once, sorted by score descending.
- score = visual-design similarity to the customer photo (100 = clearly the same product/design family, 0 = clearly different).
- same = true only when it is very likely the same product or an identical-body variant.
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
      // sniff by magic bytes
      if (buf[0] === 0xff && buf[1] === 0xd8) media = "image/jpeg";
      else if (buf[0] === 0x89 && buf[1] === 0x50) media = "image/png";
      else if (buf.slice(0, 4).toString("ascii") === "RIFF") media = "image/webp";
      else return null;
    }
    return { media, data: buf.toString("base64") };
  } catch { return null; }
}

async function callModel(key, model, userData, userMedia, prepared) {
  const content = [
    { type: "text", text: "CUSTOMER PHOTO (the tap to identify):" },
    { type: "image", source: { type: "base64", media_type: userMedia || "image/jpeg", data: userData } },
  ];
  prepared.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1} — ${c.brand} ${c.model}:` });
    content.push({ type: "image", source: { type: "base64", media_type: c.img.media, data: c.img.data } });
  });
  content.push({ type: "text", text: `Rank all ${prepared.length} candidates (ids 1..${prepared.length}) by how closely they match the CUSTOMER PHOTO. Return only the JSON.` });
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
}

export async function POST(request) {
  const key = readKey();
  if (!key || !key.startsWith("sk-ant-")) return Response.json({ configured: false });

  let body;
  try { body = await request.json(); } catch { return Response.json({ configured: true, error: "bad request" }, { status: 400 }); }
  const { data, mediaType } = body || {};
  let candidates = Array.isArray(body?.candidates) ? body.candidates.filter((c) => c && c.photo) : [];
  if (!data) return Response.json({ configured: true, error: "no image" }, { status: 400 });
  if (candidates.length < 2) return Response.json({ configured: true, ranked: [] });
  candidates = candidates.slice(0, 10);

  // Fetch + inline every candidate image; drop any that fail so one bad URL can't kill the call.
  const inlined = await Promise.all(candidates.map((c) => toInline(c.photo)));
  const prepared = candidates.map((c, i) => ({ ...c, img: inlined[i] })).filter((c) => c.img);
  if (prepared.length < 2) return Response.json({ configured: true, ranked: [], note: "candidate images unavailable" });

  let lastDetail = "";
  try {
    for (const model of MODELS) {
      const resp = await callModel(key, model, data, mediaType, prepared);
      if (resp.ok) {
        const json = await resp.json();
        const text = (json.content || []).map((c) => c.text || "").join("").trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return Response.json({ configured: true, ranked: [] });
        let parsed; try { parsed = JSON.parse(match[0]); } catch { return Response.json({ configured: true, ranked: [] }); }
        const ranked = (parsed.ranked || [])
          .filter((r) => r && Number.isFinite(+r.id) && +r.id >= 1 && +r.id <= prepared.length)
          .map((r) => { const c = prepared[+r.id - 1]; return { id: c.id, brand: c.brand, model: c.model, photo: c.photo, score: Math.max(0, Math.min(100, +r.score || 0)), same: !!r.same, reason: String(r.reason || "").slice(0, 60) }; });
        return Response.json({ configured: true, model, ranked });
      }
      const t = await resp.text();
      lastDetail = scrub(t).slice(0, 200);
      if (!/not_found/i.test(t)) break;
    }
    return Response.json({ configured: true, error: "match api error", detail: lastDetail }, { status: 502 });
  } catch (e) {
    return Response.json({ configured: true, error: scrub(e).slice(0, 200) }, { status: 500 });
  }
}
