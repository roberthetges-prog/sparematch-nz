// Fingerprint the images our normal backfill cannot fetch.
//
// THE PROBLEM. Some retailer CDNs - Mitre 10's ccapi.mitre10.co.nz is the one that bit us - serve
// a real browser perfectly (5 requests out of 5) but block datacenter IPs, so Vercel gets nothing.
// Those products can never be fingerprinted, and so can never be found by photo.
//
// WHAT DOESN'T WORK, and why (both measured, not assumed):
//  * An image proxy (wsrv.nl) reaches Mitre 10 only about 1 attempt in 5.
//  * Fetching in the admin's browser and posting the pixels back: the browser DISPLAYS the image
//    but cannot READ it, because the CDN sends no CORS headers, so the canvas is tainted.
//
// WHAT DOES WORK: the proxy, retried. One attempt is a coin toss; eight attempts with backoff
// gets through, and once the proxy has the image cached it stays reachable. So we keep the DIRECT
// url on the product (users are browsers - they get it first time, every time) and do the
// retrying here, out of sight, only for the stragglers.

import { sbAdmin } from "../../../lib/supabase.js";

export const runtime = "nodejs";
export const maxDuration = 60;

const DIM = 256;
const ATTEMPTS = 8;

function keyJina() { return (process.env.JINA_API_KEY || "").trim(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Route through the image proxy, which fetches from an origin the CDN doesn't refuse.
function viaProxy(url, bust) {
  const bare = String(url).replace(/^https?:\/\//, "");
  return "https://wsrv.nl/?url=ssl:" + bare + "&w=512&output=jpg&q=88&cb=" + bust;
}

async function grab(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", accept: "image/*" },
    });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 512) return null; // a few bytes of error page, not a photo
    return buf;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Try direct first (free and instant when it works), then keep asking the proxy.
async function fetchStubborn(url) {
  const direct = await grab(url);
  if (direct) return { buf: direct, how: "direct" };
  for (let i = 0; i < ATTEMPTS; i++) {
    const buf = await grab(viaProxy(url, i));
    if (buf) return { buf, how: "proxy after " + (i + 1) + (i ? " attempts" : " attempt") };
    await sleep(400 + i * 300);
  }
  return null;
}

async function jinaEmbed(key, dataUrl) {
  const r = await fetch("https://api.jina.ai/v1/embeddings", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + key },
    body: JSON.stringify({ model: "jina-clip-v2", dimensions: DIM, normalized: true, embedding_type: "float", input: [{ image: dataUrl }] }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const v = j && j.data && j.data[0] && j.data[0].embedding;
  return Array.isArray(v) && v.length === DIM ? v : null;
}

export async function POST(request) {
  const pw = (process.env.ADMIN_PASSWORD || "").trim();
  if (!pw) return Response.json({ error: "admin password not configured" }, { status: 500 });
  const key = keyJina();
  if (!key) return Response.json({ error: "embedding key not configured" }, { status: 500 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad request" }, { status: 400 }); }
  if (!body || String(body.password || "") !== pw) return Response.json({ error: "wrong password" }, { status: 401 });

  const sb = sbAdmin();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });

  // Deliberately small: each image can cost 8 proxy attempts, and we have 60s.
  const limit = Math.min(Math.max(Number(body.limit) || 4, 1), 6);

  // Pull a generous slice, then work per DISTINCT PICTURE rather than per product. Makers publish
  // one shot for a whole valve range - 39 of our rows share just 20 images - so fetching per row
  // would pay for the same download a dozen times over.
  const { data: rows, error } = await sb
    .from("products")
    .select("id,brand,model,photo_url")
    .is("embedding", null)
    .not("photo_url", "is", null)
    .eq("active", true)
    .limit(200);
  if (error) return Response.json({ error: "query failed" }, { status: 500 });
  if (!rows || !rows.length) return Response.json({ embedded: 0, remaining: 0, notes: [], stillStuck: [] });

  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.photo_url)) byUrl.set(r.photo_url, []);
    byUrl.get(r.photo_url).push(r);
  }
  const urls = [...byUrl.keys()].slice(0, limit);

  let embedded = 0;
  const notes = [];
  const stillStuck = [];

  for (const url of urls) {
    const group = byUrl.get(url);
    const first = group[0];
    const got = await fetchStubborn(url);
    if (!got) { stillStuck.push(`${first.brand} ${first.model}`); continue; }
    const dataUrl = "data:image/jpeg;base64," + got.buf.toString("base64");
    const vec = await jinaEmbed(key, dataUrl);
    if (!vec) { stillStuck.push(`${first.brand} ${first.model} (fetched, but embedding failed)`); continue; }
    // Same picture, same fingerprint - so write it to every row that uses this picture. That is
    // not a shortcut: an identical file genuinely has an identical fingerprint.
    const { error: upErr } = await sb
      .from("products")
      .update({ embedding: "[" + vec.join(",") + "]" })
      .eq("photo_url", url)
      .is("embedding", null)
      .eq("active", true);
    if (upErr) { stillStuck.push(`${first.brand} ${first.model} (couldn't save)`); continue; }
    embedded += group.length;
    notes.push(`${first.brand} ${first.model}${group.length > 1 ? ` (+${group.length - 1} sharing this picture)` : ""} — ${got.how}`);
  }

  const { count } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .is("embedding", null)
    .not("photo_url", "is", null)
    .eq("active", true);

  return Response.json({ embedded, remaining: count || 0, notes, stillStuck });
}

export async function GET(request) {
  const url = new URL(request.url);
  if (String(url.searchParams.get("list") || "") !== "1") return Response.json({ error: "not found" }, { status: 404 });
  const sb = sbAdmin();
  if (!sb) return Response.json({ error: "database not configured" }, { status: 500 });
  const { data, error } = await sb
    .from("products")
    .select("id,brand,model,photo_url")
    .is("embedding", null)
    .not("photo_url", "is", null)
    .eq("active", true)
    .limit(25);
  if (error) return Response.json({ error: "query failed" }, { status: 500 });
  return Response.json({ items: data || [] });
}
