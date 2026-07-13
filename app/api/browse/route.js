// Browse the LIVE catalogue (Supabase) by category.
//
// WHY THIS EXISTS: the toilet section of the finder was reading the bundled lib/parts.json,
// which is a frozen snapshot with no photos on the seats. The database has the real catalogue -
// 53 seats WITH pictures, not 12 without - and it grows every time we ingest. Anything the user
// browses has to come from the DB, or newly added stock is invisible to them.

import { sbAdmin, sbRead } from "../../../lib/supabase.js";

export const runtime = "nodejs";

const CATS = ["toilet suite", "toilet seat", "toilet inlet valve", "toilet outlet valve", "flush button"];

const LABEL = {
  "toilet suite": "Toilet suite",
  "toilet seat": "Toilet seat",
  "toilet inlet valve": "Inlet (fill) valve",
  "toilet outlet valve": "Outlet (flush) valve",
  "flush button": "Flush button / plate",
};

function shape(r) {
  return {
    id: r.id,
    brand: r.brand || "",
    model: r.model,
    category: r.category,
    partNo: r.part_no || "",
    size: r.size || "",
    fits: r.fits || "",
    photo: r.photo_url || "",
    buyUrl: r.buy_url || "",
    confirm: !!r.confirm,
  };
}

export async function GET(request) {
  const sb = sbAdmin() || sbRead();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });

  const url = new URL(request.url);

  // ?counts=1 -> how many of each toilet category we actually hold, for the menu.
  if (url.searchParams.get("counts") === "1") {
    const counts = {};
    for (const c of CATS) {
      const { count } = await sb
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("category", c)
        .eq("active", true)
        .not("photo_url", "is", null);
      counts[c] = count || 0;
    }
    return Response.json({ counts, labels: LABEL });
  }

  const cat = String(url.searchParams.get("category") || "").toLowerCase();
  if (!CATS.includes(cat)) return Response.json({ error: "unknown category" }, { status: 400 });

  const brand = String(url.searchParams.get("brand") || "").trim();

  let q = sb
    .from("products")
    .select("id,brand,model,category,part_no,size,fits,photo_url,buy_url,confirm")
    .eq("category", cat)
    .eq("active", true)
    .order("brand", { ascending: true })
    .order("model", { ascending: true })
    .limit(400);
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

  return Response.json({ category: cat, label: LABEL[cat] || cat, items, brands });
}
