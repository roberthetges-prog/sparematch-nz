// Visual matcher: compares the customer's uploaded tap photo against a shortlist of
// our own catalogue product photos and ranks which are the same product.
// Uses Claude vision (multi-image compare). Keeps the API key server-side.

export const runtime = "nodejs";
export const maxDuration = 45;

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
- Include EVERY candidate id exactly once, sorted by score descending.
- score = visual-design similarity to the customer photo (100 = clearly the same product/design family, 0 = clearly different).
- same = true only when it is very likely the same product or an identical-body variant.
- Be discriminating: do not give everything a high score. Most candidates should score low unless the shape genuinely matches.`;

async function callModel(key, model, userData, userMedia, candidates) {
  const content = [
    { type: "text", text: "CUSTOMER PHOTO (the tap to identify):" },
    { type: "image", source: { type: "base64", media_type: userMedia || "image/jpeg", data: userData } },
  ];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `Candidate ${i + 1} — ${c.brand} ${c.model}:` });
    content.push({ type: "image", source: { type: "url", url: c.photo } });
  });
  content.push({ type: "text", text: `Rank all ${candidates.length} candidates (ids 1..${candidates.length}) by how closely they match the CUSTOMER PHOTO. Return only the JSON.` });
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
  candidates = candidates.slice(0, 12); // keep latency/token in check

  let lastDetail = "";
  try {
    for (const model of MODELS) {
      const resp = await callModel(key, model, data, mediaType, candidates);
      if (resp.ok) {
        const json = await resp.json();
        const text = (json.content || []).map((c) => c.text || "").join("").trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return Response.json({ configured: true, ranked: [] });
        let parsed; try { parsed = JSON.parse(match[0]); } catch { return Response.json({ configured: true, ranked: [] }); }
        const ranked = (parsed.ranked || [])
          .filter((r) => r && Number.isFinite(+r.id) && +r.id >= 1 && +r.id <= candidates.length)
          .map((r) => ({ ...candidates[+r.id - 1], score: Math.max(0, Math.min(100, +r.score || 0)), same: !!r.same, reason: String(r.reason || "").slice(0, 60) }));
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
