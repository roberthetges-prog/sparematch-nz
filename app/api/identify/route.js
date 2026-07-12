// Claude vision endpoint: classifies a tap/part photo into our schema.
// v2: accepts ONE OR TWO angles of the same tap. Two angles let the model see the spout
// profile AND the handle join, and give it a second chance at any stamped brand name -
// which is the single most reliable identification signal there is.
// Returns one box PER image so the client can crop each angle to the tap.

export const runtime = "nodejs";
export const maxDuration = 30;

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
  "Voda","Newform","Hansgrohe",
];
const CATEGORIES = ["Cartridge","Spindle","Headwork","Washer/Seal","Aerator","Handle","Tool","Other"];
const VALVES = ["ceramic disc","washer spindle","half-turn","quarter-turn","thermostatic"];

const SYSTEM = [
  "You are a New Zealand plumbing spare-parts assistant. You are shown ONE or TWO photos of the SAME tap/mixer (or a removed part), taken from different angles.",
  "Return STRICT JSON, no prose:",
  '{"brand": string, "brandGuesses": string[], "fixture": string, "boxes": [{"x":num,"y":num,"w":num,"h":num}], "markings": string[], "category": string, "valveType": string, "dimension": string, "leverType": string, "handleDesign": string, "spoutShape": string, "distinctive": string, "description": string, "measureTip": string, "confidence": "high"|"medium"|"low"}',
  "",
  "READ ANY TEXT FIRST - THIS BEATS EVERYTHING ELSE. Scan both photos for a brand name or model stamped, etched, printed or moulded anywhere: the front of the lever, the top of the body, under the spout, on the base ring, on a sticker. Put every legible string you can read into markings, exactly as written. A legible name on the part outranks ANY judgement you make from shape - if you can read it, the identification is settled.",
  "",
  "USE BOTH ANGLES TOGETHER. They show the same physical tap. One angle usually hides something the other reveals - a straight-on shot shows the spout profile, a top-down shot shows the lever and the base. Combine them. If the two photos disagree about a detail, trust the photo where that detail is clearer, and lower your confidence.",
  "",
  "FIXTURE TYPE IS CRITICAL - get this right before anything else. Manufacturers sell the basin mixer and the shower mixer of a range as a matched PAIR: same handle, near-identical faceplate. The ONLY reliable difference is the spout and where it mounts. Set fixture to exactly one of basin, shower, sink, bath, toilet, or empty string if the photo is a loose part (cartridge, spindle, valve) rather than an installed tap.",
  "- basin: body sits ON the basin/vanity and HAS A SPOUT that water pours from.",
  "- shower: mounted IN THE WALL - just a round/square faceplate and a handle, NO SPOUT at all.",
  "- sink: kitchen tap - tall or gooseneck spout, often a pull-out spray.",
  "- bath: spout filling a bath.",
  "If you see a wall plate with a handle and no spout, it is shower - never basin.",
  "",
  "LOCATE THE PRODUCT. For EACH photo you are given, in order, return one entry in boxes: a tight bounding box around the tap/part itself as fractions of that image (x,y = top-left, w,h = width/height, all 0-1). Exclude the basin, bench, tiles and background. If you are shown two photos, boxes must have two entries.",
  "",
  "IDENTIFYING THE BRAND from shape is the hardest and least reliable part. The strongest visual clues, in order:",
  "1. THE HANDLE DESIGN - lever vs cross-head vs pin lever vs joystick; the lever's shape (flat paddle, rounded, angular/squared, tapered, knurled); how it meets the body; any distinctive curve or notch. Describe it in handleDesign.",
  "2. THE SPOUT SHAPE - gooseneck vs straight vs squared vs low-arc; round vs flat/rectangular in section; how it joins the body. Describe it in spoutShape.",
  "Reason about which brand these cues most resemble, choosing only from: " + BRANDS.join(", ") + ".",
  "",
  "DISTINCTIVE FEATURE. In distinctive, name the ONE feature of this tap that would rule other models OUT - the thing that is unusual about it (e.g. 'spout is square in cross-section', 'lever is a flat paddle mounted on top', 'body tapers towards the base', 'exposed hex nut under the spout'). If the tap is a completely generic cylindrical mixer with nothing unusual, say exactly: generic. Being honest here is more valuable than inventing a feature.",
  "",
  "Rules:",
  "- brand: set ONLY if a name/logo is legibly visible in one of the photos. If you are inferring it from styling, leave brand empty and put your candidates in brandGuesses instead. Do not dress a guess up as a reading.",
  "- brandGuesses: ALWAYS give your best 1-2 candidate brands from the list based on handle and spout design, even when unsure. Use [] only if you truly cannot tell.",
  "- confidence: high ONLY if you read a brand name, or the tap has a genuinely distinctive silhouette. If it is a generic cylindrical single-lever mixer - the commonest shape in New Zealand - confidence is low, and that is the correct answer.",
  "- Most single-lever mixers are repaired with a CARTRIDGE, so set category to Cartridge for a single-lever tap or a cylindrical cartridge.",
  "- category one of " + CATEGORIES.join(", ") + "; valveType one of " + VALVES.join(", ") + " if clear.",
  "- leverType: single-lever / two-handle / empty.",
  "- dimension: DO NOT guess mm from the photo (no scale reference). Only fill if a size is physically printed and legible; else empty.",
  "- measureTip: one line reminding the user to measure the cartridge body diameter (25/35/40/45mm) for the exact part.",
  "- description: one short sentence for the user.",
  "- Never invent a brand, part number or marking. Prefer empty over guessing something you cannot see.",
].join("\n");

async function callModel(key, model, shots) {
  const content = [];
  shots.forEach((s, i) => {
    content.push({ type: "text", text: shots.length > 1 ? "Photo " + (i + 1) + " of " + shots.length + " (same tap, different angle):" : "Photo of the part:" });
    content.push({ type: "image", source: { type: "base64", media_type: s.mediaType || "image/jpeg", data: s.data } });
  });
  content.push({ type: "text", text: "Identify this plumbing part using ALL the photos above. Return only the JSON, with one box per photo." });
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 600, temperature: 0, system: SYSTEM, messages: [{ role: "user", content }] }),
  });
}

// ---- Cost / abuse guardrails (best-effort, per warm instance) ----
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
  if (RL.global.length >= GLOBAL_MAX) return true;
  let arr = (RL.ip.get(ip) || []).filter((t) => now - t < IP_WINDOW);
  if (arr.length >= IP_MAX) { RL.ip.set(ip, arr); return true; }
  arr.push(now); RL.ip.set(ip, arr); RL.global.push(now);
  if (RL.ip.size > 5000) { for (const [k, v] of RL.ip) { if (!v.length || now - v[v.length - 1] > IP_WINDOW) RL.ip.delete(k); } }
  return false;
}

function okBox(b) {
  if (!b || typeof b !== "object") return null;
  const n = (v) => (Number.isFinite(+v) ? Math.max(0, Math.min(1, +v)) : null);
  const x = n(b.x), y = n(b.y), w = n(b.w), h = n(b.h);
  if (x === null || y === null || w === null || h === null) return null;
  if (w < 0.05 || h < 0.05) return null;
  return { x, y, w, h };
}

export async function POST(request) {
  const key = readKey();
  if (!key || !key.startsWith("sk-ant-")) return Response.json({ configured: false });

  let body;
  try { body = await request.json(); } catch { return Response.json({ configured: true, error: "bad request" }, { status: 400 }); }

  // New: {images:[{data,mediaType}]}. Legacy: {data,mediaType}.
  let shots = Array.isArray(body && body.images) ? body.images : [];
  if (!shots.length && body && body.data) shots = [{ data: body.data, mediaType: body.mediaType }];
  shots = shots.filter((s) => s && typeof s.data === "string" && s.data.length).slice(0, 2);
  if (!shots.length) return Response.json({ configured: true, error: "no image" }, { status: 400 });
  if (shots.some((s) => s.data.length > MAX_IMG)) return Response.json({ configured: true, error: "image_too_large", message: "That image is too large - please try a smaller photo." }, { status: 413 });
  if (rateLimited(clientIp(request))) return Response.json({ configured: true, error: "rate_limited", message: "You're going a bit fast - give it a few seconds and try again." }, { status: 429 });

  let lastDetail = "";
  try {
    for (const model of MODELS) {
      const resp = await callModel(key, model, shots);
      if (resp.ok) {
        const json = await resp.json();
        const text = (json.content || []).map((c) => c.text || "").join("").trim();
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) return Response.json({ configured: true, error: "no json" });
        const out = JSON.parse(match[0]);

        // Normalise boxes: always an array as long as the photos we were given.
        let boxes = Array.isArray(out.boxes) ? out.boxes.map(okBox) : [];
        if (!boxes.length && out.box) boxes = [okBox(out.box)];
        while (boxes.length < shots.length) boxes.push(null);
        boxes = boxes.slice(0, shots.length);

        const markings = (Array.isArray(out.markings) ? out.markings : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 8);

        // A brand is only "read" if it actually appears in the text we read off the part.
        // Everything else is a guess, and gets labelled as one.
        const marks = markings.join(" ").toLowerCase();
        const brand = String(out.brand || "");
        const brandSure = !!(brand && marks.includes(brand.toLowerCase()));

        return Response.json({
          configured: true,
          model,
          ...out,
          brand,
          brandSure,
          markings,
          boxes,
          box: boxes[0] || null,   // back-compat with the single-photo client
          angles: shots.length,
        });
      }
      const t = await resp.text();
      lastDetail = scrub(t).slice(0, 300);
      if (!/not_found/i.test(t)) break;
    }
    return Response.json({ configured: true, error: "vision api error", detail: lastDetail }, { status: 502 });
  } catch (e) {
    return Response.json({ configured: true, error: scrub(e).slice(0, 200) }, { status: 500 });
  }
}
