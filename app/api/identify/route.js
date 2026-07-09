// Claude vision endpoint: classifies a tap/part photo into our schema.
// Keeps the API key server-side. Returns {configured:false} gracefully if no key set,
// so the site keeps working (question-only flow) until a key is added in Vercel.

export const runtime = "nodejs";
export const maxDuration = 30;

// Try these in order; use the first the account has access to. Override with VISION_MODEL.
const MODELS = process.env.VISION_MODEL
  ? [process.env.VISION_MODEL]
  : ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-4-8"];

const scrub = (s) => String(s).replace(/sk-ant-[A-Za-z0-9_\-]+/g, "[redacted]");
function readKey() {
  const raw = (process.env.ANTHROPIC_API_KEY || "").trim();
  const m = raw.match(/sk-ant-[A-Za-z0-9_\-]+/);
  return m ? m[0] : raw;
}

const BRANDS = [
  "Foreno","Felton","Robertson","Methven","Greens","Caroma","Dorf","Phoenix",
  "Mizu","Posh","Mondella","LeVivi","Meir","Buddy","Nero","Grohe","Franke","Paini",
];
const CATEGORIES = ["Cartridge","Spindle","Headwork","Washer/Seal","Aerator","Handle","Tool","Other"];
const VALVES = ["ceramic disc","washer spindle","half-turn","quarter-turn","thermostatic"];

const SYSTEM = `You are a New Zealand plumbing spare-parts assistant. You are shown a photo of a tap/mixer or a removed tap part.
Return STRICT JSON, no prose:
{"brand": string, "brandGuesses": string[], "category": string, "valveType": string, "dimension": string, "leverType": string, "handleDesign": string, "spoutShape": string, "description": string, "measureTip": string, "confidence": "high"|"medium"|"low"}

IDENTIFYING THE BRAND is the hardest and most valuable part. The strongest visual clues, in order, are:
1. THE HANDLE DESIGN — look hard at it: lever vs cross-head vs pin lever vs joystick; the lever's shape (flat paddle, rounded, angular/squared, tapered, knurled); how it meets the body; any distinctive curve or notch. Describe it in "handleDesign".
2. THE SPOUT SHAPE — gooseneck/swan-neck vs straight vs squared vs low-arc; round vs flat/rectangular section; how it joins the body. Describe it in "spoutShape".
Reason about which brand these design cues most resemble, choosing only from this list: ${BRANDS.join(", ")}.

Rules:
- brand: set ONLY if a name/logo is legibly visible OR the handle+spout design is a confident match. Otherwise "".
- brandGuesses: ALWAYS give your best 1-2 candidate brands from the list based on the handle and spout design, even when unsure (this helps the user start). Use [] only if you truly cannot tell.
- Most single-lever mixers are repaired with a CARTRIDGE, so set category to "Cartridge" for a single-lever tap or a cylindrical cartridge.
- category one of ${CATEGORIES.join(", ")}; valveType one of ${VALVES.join(", ")} if clear.
- leverType: "single-lever" / "two-handle" / "".
- dimension: DO NOT guess mm from the photo (no scale reference). Only fill if a size is physically printed and legible; else "".
- measureTip: one line reminding the user to measure the cartridge body diameter (25/35/40/45mm) for the exact part.
- description: one short sentence for the user.
- Never invent a brand or part number. Prefer "" / [] over guessing a name you are not seeing cues for.`;

async function callModel(key, model, data, mediaType) {
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data } },
            { type: "text", text: "Identify this plumbing part. Return only the JSON." },
          ],
        },
      ],
    }),
  });
}

export async function POST(request) {
  const key = readKey();
  if (!key || !key.startsWith("sk-ant-")) return Response.json({ configured: false });

  let body;
  try { body = await request.json(); } catch { return Response.json({ configured: true, error: "bad request" }, { status: 400 }); }
  const { data, mediaType } = body || {};
  if (!data) return Response.json({ configured: true, error: "no image" }, { status: 400 });

  let lastDetail = "";
  try {
    for (const model of MODELS) {
      const resp = await callModel(key, model, data, mediaType);
      if (resp.ok) {
        const json = await resp.json();
        const text = (json.content || []).map((c) => c.text || "").join("").trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return Response.json({ configured: true, error: "no json" });
        return Response.json({ configured: true, model, ...JSON.parse(match[0]) });
      }
      const t = await resp.text();
      lastDetail = scrub(t).slice(0, 300);
      if (!/not_found/i.test(t)) break; // only fall through when the model isn't available
    }
    return Response.json({ configured: true, error: "vision api error", detail: lastDetail }, { status: 502 });
  } catch (e) {
    return Response.json({ configured: true, error: scrub(e).slice(0, 200) }, { status: 500 });
  }
}
