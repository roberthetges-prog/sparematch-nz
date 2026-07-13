// Browse the LIVE catalogue (Supabase) by category.
//
// WHY THIS EXISTS: every "browse" screen in the finder used to read the bundled lib/parts.json -
// a frozen snapshot. So the database could hold 328 basin mixers and 53 photographed toilet seats
// while the app showed a stale handful with no pictures, and every product we ingested was
// invisible until someone redeployed. Anything the user browses now comes from here, live.

import { sbAdmin, sbRead } from "../../../lib/supabase.js";

export const runtime = "nodejs";

// The groups the user actually thinks in, and the DB categories behind each.
const GROUPS = {
  tap: {
    label: "Tap / mixer",
    icon: "🚰",
    cats: [
      ["basin mixer", "Basin mixer", "On the basin, has a spout."],
      ["sink mixer", "Kitchen / sink mixer", "Over the sink, often a pull-out spray."],
      ["shower mixer", "Shower mixer", "In the wall — faceplate and handle, no spout."],
      ["bath mixer", "Bath mixer", "Fills the bath."],
      ["cartridge", "Cartridge", "The part inside a single-lever mixer."],
      ["aerator", "Aerator", "The screw-in tip of the spout."],
      ["handle", "Handle / lever", ""],
      ["spindle", "Spindle", ""],
      ["headwork", "Headwork", ""],
      ["washer/seal", "Washer / seal", ""],
      ["faceplate", "Faceplate / cover plate", ""],
      ["diverter", "Diverter", ""],
    ],
  },
  shower: {
    label: "Shower",
    icon: "🚿",
    cats: [
      ["shower slide", "Slide shower / rail set", "Handpiece on a rail."],
      ["shower head", "Shower head / rose", ""],
      ["hand shower", "Hand shower", ""],
      ["shower rail", "Shower rail", ""],
      ["column shower", "Shower column", ""],
      ["shower hose", "Shower hose", ""],
      ["bath spout", "Bath spout", ""],
    ],
  },
  valve: {
    label: "Valve",
    icon: "🎛",
    cats: [
      ["tempering valve", "Tempering valve", "Limits hot-water temperature."],
      ["pressure limiting valve", "Pressure limiting valve", ""],
      ["pressure reducing valve", "Pressure reducing valve", ""],
      ["expansion control valve", "Expansion control valve", ""],
      ["pressure & temperature relief valve", "Pressure & temperature relief valve", ""],
      ["non-return valve", "Non-return valve", ""],
      ["isolating valve", "Isolating valve", ""],
      ["complete valve", "Complete valve", ""],
      ["service kit", "Service kit", ""],
    ],
  },
  toilet: {
    label: "Toilet",
    icon: "🚽",
    cats: [
      ["toilet suite", "Toilet suite", "Start here — the suite tells us the seat and the valves."],
      ["toilet seat", "Toilet seat", "The most-replaced toilet part."],
      ["toilet inlet valve", "Inlet (fill) valve", "Where the water pipe feeds in."],
      ["toilet outlet valve", "Outlet (flush) valve", "The flush valve inside the cistern."],
      ["flush button", "Flush button / plate", ""],
    ],
  },
};

const ALL_CATS = new Set();
for (const g of Object.values(GROUPS)) for (const c of g.cats) ALL_CATS.add(c[0]);

// part_no and sku are NOT the same thing and must never be shown as if they were.
// On a mixer, part_no is the CARTRIDGE code (CC25, LEVCART25, Grohe 46048000) - the number a
// plumber takes to the counter. sku is the retailer's code for the tap itself. Handing someone
// the tap's SKU when they asked for a cartridge is exactly the kind of confident wrong answer
// that loses a user for good.
function shape(r) {
  return {
    id: r.id,
    brand: r.brand || "",
    model: r.model,
    category: r.category,
    partNo: r.part_no || "",   // cartridge / spare-part code
    sku: r.sku || "",          // the product's own retail code
    size: r.size || "",
    fits: r.fits || "",
    photo: r.photo_url || "",
    buyUrl: r.buy_url || "",
    exploded: r.exploded || "",
    confirm: !!r.confirm,
  };
}

async function countOf(sb, cat) {
  const { count } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("category", cat)
    .eq("active", true)
    .not("photo_url", "is", null);
  return count || 0;
}

export async function GET(request) {
  const sb = sbAdmin() || sbRead();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });

  const url = new URL(request.url);

  // ?groups=1 -> the whole menu, with live counts, so the app never shows a category we can't fill.
  if (url.searchParams.get("groups") === "1") {
    const counts = {};
    await Promise.all([...ALL_CATS].map(async (c) => { counts[c] = await countOf(sb, c); }));
    const groups = Object.entries(GROUPS).map(([key, g]) => {
      const cats = g.cats
        .map(([cat, label, hint]) => ({ cat, label, hint, count: counts[cat] || 0 }))
        .filter((c) => c.count > 0);
      return { key, label: g.label, icon: g.icon, total: cats.reduce((a, c) => a + c.count, 0), cats };
    }).filter((g) => g.total > 0);
    return Response.json({ groups });
  }

  const cat = String(url.searchParams.get("category") || "").toLowerCase();
  if (!ALL_CATS.has(cat)) return Response.json({ error: "unknown category" }, { status: 400 });

  const brand = String(url.searchParams.get("brand") || "").trim();

  let q = sb
    .from("products")
    .select("id,brand,model,category,part_no,sku,size,fits,photo_url,buy_url,exploded,confirm")
    .eq("category", cat)
    .eq("active", true)
    .not("photo_url", "is", null)
    .order("brand", { ascending: true })
    .order("model", { ascending: true })
    .limit(500);
  if (brand) q = q.eq("brand", brand);

  const { data, error } = await q;
  if (error) return Response.json({ error: "query failed" }, { status: 500 });

  const items = (data || []).map(shape);

  // Brand facets, so a long list can be narrowed without another round trip.
  const bc = new Map();
  for (const i of items) if (i.brand) bc.set(i.brand, (bc.get(i.brand) || 0) + 1);
  const brands = [...bc.entries()]
    .map(([b, n]) => ({ brand: b, count: n }))
    .sort((a, b) => b.count - a.count || a.brand.localeCompare(b.brand));

  return Response.json({ category: cat, items, brands });
}
