// Claude vision endpoint: works out WHAT the photo is, before we try to work out WHICH ONE it is.
//
// v3 adds toilet/cistern vocabulary. Until now this prompt only knew tapware: it described a
// cistern fill valve perfectly in prose, then had to file it under category "Other" and fixture ""
// because those were the only words it had - and brands like Geberit, Fluidmaster, WDI and R&T
// weren't even in its list. The match still worked, carried by the fingerprint, but the two stages
// disagreed about what they were looking at. Now they don't.
//
// The single most important new job: telling an INLET valve from an OUTLET valve. They live in the
// same cistern, a metre apart, and they are not interchangeable.

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

// Tapware brands, then the cistern/toilet names - the mechanism inside a cistern is very often
// made by someone other than the china it sits in (Caroma's valves are Geberit, for instance).
const TAP_BRANDS = [
  "Foreno","Felton","Robertson","Elementi","Methven","Greens","Caroma","Dorf","Phoenix",
  "Mizu","Posh","Mondella","LeVivi","Meir","Buddy","Nero","Grohe","Franke","Paini",
  "Voda","Newform","Hansgrohe","Raymor","Adesso","Aquatica","Plumbline","Nouveau","Estilo",
  "Zucchetti","Samuel Heath","Hansa",
];
const CISTERN_BRANDS = [
  "Geberit","Fluidmaster","WDI","Oli","R&T","Kinetic","Fix-A-Loo","Ideal Standard","Sanit",
  "TECE","Caroma","Englefield","Kohler","Parisi","American Standard","Toto","Roca","Kado",
  "Dux","Argent","Elementi","ArtCeram","Bagno Design","Hidra","Posh",
];
const BRANDS = [...new Set([...TAP_BRANDS, ...CISTERN_BRANDS])];

// These map ONE-TO-ONE onto the categories in our catalogue, so the matcher can narrow on them
// directly. Do not invent new ones here without adding them to the database too.
const PART_TYPES = [
  "basin mixer", "sink mixer", "shower mixer", "bath mixer",
  "cartridge", "aerator", "handle", "spindle", "headwork", "washer/seal", "faceplate", "diverter",
  "shower slide", "shower head", "hand shower", "shower rail", "shower hose", "bath spout",
  "toilet suite", "toilet seat", "toilet inlet valve", "toilet outlet valve", "flush button",
  "tempering valve", "pressure limiting valve", "pressure reducing valve",
  "expansion control valve", "pressure & temperature relief valve", "non-return valve", "isolating valve",
  "",
];

const SYSTEM = [
  "You are a New Zealand plumbing spare-parts assistant. You are shown ONE or TWO photos of the SAME item, taken from different angles. It may be an installed tap, a removed part, or the inside of a toilet cistern.",
  "Return STRICT JSON, no prose:",
  '{"partType": string, "brand": string, "brandGuesses": string[], "fixture": string, "inletEntry": string, "boxes": [{"x":num,"y":num,"w":num,"h":num}], "markings": string[], "category": string, "valveType": string, "dimension": string, "leverType": string, "handleDesign": string, "spoutShape": string, "distinctive": string, "description": string, "measureTip": string, "confidence": "high"|"medium"|"low"}',
  "",
  "READ ANY TEXT FIRST - THIS BEATS EVERYTHING ELSE. Scan every photo for a brand or model name stamped, etched, printed or moulded anywhere: the lever, the body, under the spout, the base ring, a sticker, the plastic of a cistern valve (these are very often marked - GEBERIT, FLUIDMASTER, WDI, R&T, OLI). Put every legible string into markings, exactly as written. A name you can actually read outranks ANY judgement from shape.",
  "",
  "USE BOTH ANGLES TOGETHER. They show the same physical item. One angle usually hides what the other reveals. Combine them. If they disagree, trust the clearer one and lower your confidence.",
  "",
  "STEP 1 - WHAT KIND OF THING IS THIS? Set partType to exactly one of: " + PART_TYPES.filter(Boolean).join(", ") + ". Use \"\" only if you truly cannot tell.",
  "",
  "TOILET CISTERN PARTS - THE CRITICAL DISTINCTION. A cistern contains two completely different valves, side by side. Getting these confused sends someone home with the wrong part:",
  "- \"toilet inlet valve\" (also called a fill valve or ballcock): the part the MAINS WATER PIPE CONNECTS TO. It has a threaded tail/shank passing through the cistern wall with a nut, and usually a FLOAT (a cup that rides up and down the shaft, or an arm with a ball). Its job is to let water IN and shut off when full. If you can see a float or a water inlet connection, it is an inlet valve.",
  "- \"toilet outlet valve\" (also called a flush valve or dump valve): sits over the HOLE IN THE BOTTOM of the cistern. It is a tall tower/canister with a large rubber seal at its base and usually an OVERFLOW TUBE. It has NO water connection and NO float. It is what the flush button pulls up to dump the water OUT.",
  "- \"flush button\": the button or plate you press. Chrome or plastic, usually two buttons (half/full flush), mounted in the cistern lid or a wall plate.",
  "- \"toilet seat\": the seat and lid.",
  "- \"toilet suite\": the whole toilet - pan and cistern together.",
  "If you can see BOTH valves in one photo (a lid-off shot of a whole cistern), set partType to the one that fills most of the frame, and say in description that both are visible.",
  "",
  "INLET ENTRY - only for an inlet valve. Set inletEntry to \"bottom\", \"back\", \"side\", \"top\" or \"\" if you cannot see it. On a REMOVED valve you can often tell: look at where the threaded tail comes out. A bottom-entry valve has its tail pointing DOWN out of the base. A top or side entry valve has the tail coming out of the SIDE or TOP of the body. Do NOT guess this from an installed cistern photographed from the front - if the pipework is not visible, use \"\".",
  "",
  "FIXTURE TYPE - only for taps/mixers. Manufacturers sell the basin mixer and the shower mixer of a range as a matched PAIR: same handle, near-identical faceplate. The ONLY reliable difference is the spout and where it mounts. Set fixture to exactly one of basin, shower, sink, bath, toilet, or \"\" if this is not an installed tap.",
  "- basin: sits ON the basin/vanity and HAS A SPOUT that water pours from.",
  "- shower: mounted IN THE WALL - a round/square faceplate and a handle, NO SPOUT at all.",
  "- sink: kitchen tap - tall or gooseneck spout, often a pull-out spray.",
  "- bath: spout filling a bath.",
  "If you see a wall plate with a handle and no spout, it is shower - never basin. If the item is not a tap at all, fixture is \"\".",
  "",
  "LOCATE THE ITEM. For EACH photo, in order, return one entry in boxes: a tight bounding box around the item itself as fractions of that image (x,y = top-left, w,h = width/height, all 0-1). Exclude the basin, bench, tiles, cistern wall and background. Two photos means two entries.",
  "",
  "IDENTIFYING THE BRAND from shape alone is the hardest and least reliable part. For a tap, the strongest clues are:",
  "1. THE HANDLE DESIGN - lever vs cross-head vs pin lever vs joystick; its shape (flat paddle, rounded, angular, tapered, knurled); how it meets the body. Describe it in handleDesign.",
  "2. THE SPOUT SHAPE - gooseneck vs straight vs squared vs low-arc; round vs flat in section. Describe it in spoutShape.",
  "For a cistern valve, shape barely identifies the brand at all - the moulded name does. If there is no legible name, say so and leave brand empty.",
  "Choose brands only from: " + BRANDS.join(", ") + ".",
  "",
  "DISTINCTIVE FEATURE. In distinctive, name the ONE feature that would rule other models OUT - the unusual thing about it (e.g. 'spout is square in cross-section', 'lever is a flat paddle mounted on top', 'float is a cup riding the shaft rather than a ball on an arm', 'outlet valve has a cable rather than a push rod'). If it is a completely generic item with nothing unusual, say exactly: generic. Being honest here is worth more than inventing a feature.",
  "",
  "Rules:",
  "- brand: set ONLY if a name/logo is legibly visible in one of the photos. If you are inferring from styling, leave brand empty and put candidates in brandGuesses. Never dress a guess up as a reading.",
  "- brandGuesses: your best 1-2 candidates from the list. [] if you truly cannot tell.",
  "- confidence: high ONLY if you read a brand name, or the item has a genuinely distinctive silhouette. A generic cylindrical single-lever mixer, or a generic white plastic fill valve, is low - and that is the correct answer.",
  "- category: a short human label for the part (e.g. Cartridge, Inlet valve, Outlet valve, Flush button, Seat, Other).",
  "- valveType: for a tap only - one of ceramic disc, washer spindle, half-turn, quarter-turn, thermostatic, if clear. Else \"\".",
  "- leverType: single-lever / two-handle / \"\".",
  "- dimension: DO NOT guess mm from a photo - there is no scale reference. Only fill it if a size is physically printed and legible. Else \"\".",
  "- measureTip: one short line telling the user what to measure or check. For a single-lever mixer: the cartridge body diameter (25/35/40/45mm). For an inlet valve: whether the pipe enters at the bottom, back or side. For an outlet valve: the size of the hole it sits in. For a seat: the fixing centres and the pan shape.",
  "- description: one short sentence for the user.",
  "- Never invent a brand, part number or marking. Prefer empty over guessing something you cannot see.",
].join("\n");

async function callModel(key, model, shots) {
  const content = [];
  shots.forEach((s, i) => {
    content.push({ type: "text", text: shots.length > 1 ? "Photo " + (i + 1) + " of " + shots.length + " (same item, different angle):" : "Photo of the item:" });
    content.push({ type: "image", source: { type: "base64", media_type: s.mediaType || "image/jpeg", data: s.data } });
  });
  content.push({ type: "text", text: "Identify this plumbing item using ALL the photos above. Return only the JSON, with one box per photo." });
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 700, temperature: 0, system: SYSTEM, messages: [{ role: "user", content }] }),
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

        let boxes = Array.isArray(out.boxes) ? out.boxes.map(okBox) : [];
        if (!boxes.length && out.box) boxes = [okBox(out.box)];
        while (boxes.length < shots.length) boxes.push(null);
        boxes = boxes.slice(0, shots.length);

        const markings = (Array.isArray(out.markings) ? out.markings : []).map((s) => String(s).slice(0, 40)).filter(Boolean).slice(0, 8);

        // A brand is only "read" if it actually shows up in the text we read off the item.
        // Everything else is a guess, and gets labelled as one.
        const marks = markings.join(" ").toLowerCase();
        const brand = String(out.brand || "");
        const brandSure = !!(brand && marks.includes(brand.toLowerCase()));

        // Only accept a partType we actually have a catalogue category for.
        const pt = String(out.partType || "").toLowerCase().trim();
        const partType = PART_TYPES.includes(pt) ? pt : "";

        const ie = String(out.inletEntry || "").toLowerCase().trim();
        const inletEntry = ["bottom", "back", "side", "top"].includes(ie) ? ie : "";

        return Response.json({
          configured: true,
          model,
          ...out,
          partType,
          inletEntry,
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
