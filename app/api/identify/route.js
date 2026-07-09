// Claude vision endpoint: classifies a tap/part photo into our schema.
// Keeps the API key server-side. Returns {configured:false} gracefully if no key set,
// so the site keeps working (question-only flow) until a key is added in Vercel.

export const runtime = "nodejs";
export const maxDuration = 30;

// Try these in order; use the first the account has access to. Override with VISION_MODEL.
const MODELS = process.env.VISION_MODEL
  ? [process.env.VISION_MODEL]
  : ["claude-3-5-sonnet-latest", "claude-3-5-sonnet-20240620", "claude-3-haiku-20240307"];

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

const SYSTEM = `You are a New Zealand plumbing spare-parts assistant. You are shown a photo of a tap, mixer, or a removed tap part (cartridge, spindle, headwork, washer, aerator or handle).
Identify only what you can actually see. Return STRICT JSON, no prose, with this shape:
{"brand": string, "category": string, "valveType": string, "dimension": string, "description": string, "confidence": "high"|"medium"|"low"}
Rules:
- brand: ONLY if a brand name or logo is clearly visible in the image. Must be one of: ${BRANDS.join(", ")}. Otherwise "".
- category: best guess of what the part is, one of: ${CATEGORIES.join(", ")}. If it's a whole tap, pick the most likely repair part (usually "Cartridge"). If unsure "".
- valveType: one of ${VALVES.join(", ")} if determinable, else "".
- dimension: only if a size is legible (e.g. "35mm"), else "".
- description: one short sentence describing what you see, for the user.
- Never invent a brand or a part number. Prefer "" over guessing.`;

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
