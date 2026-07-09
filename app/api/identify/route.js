// Claude vision endpoint: classifies a tap/part photo into our schema.
// Keeps the API key server-side. Returns {configured:false} gracefully if no key set,
// so the site keeps working (question-only flow) until a key is added in Vercel.

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.VISION_MODEL || "claude-3-5-sonnet-20241022";

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

export async function POST(request) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json({ configured: false });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ configured: true, error: "bad request" }, { status: 400 });
  }
  const { data, mediaType } = body || {};
  if (!data) return Response.json({ configured: true, error: "no image" }, { status: 400 });

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
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

    if (!resp.ok) {
      const t = await resp.text();
      return Response.json({ configured: true, error: "vision api error", detail: t.slice(0, 300) }, { status: 502 });
    }
    const json = await resp.json();
    const text = (json.content || []).map((c) => c.text || "").join("").trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ configured: true, error: "no json", raw: text.slice(0, 300) });
    const parsed = JSON.parse(match[0]);
    return Response.json({ configured: true, ...parsed });
  } catch (e) {
    return Response.json({ configured: true, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
