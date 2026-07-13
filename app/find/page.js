"use client";
import { useMemo, useState } from "react";
import parts from "../../lib/parts.json";
import models from "../../lib/models.json";
import cartimg from "../../lib/cartimg.json";
import { listBrands, applyFilters, nextQuestion } from "../../lib/matcher.js";

const FIELD_LABEL = { productType: "Fixing", valveFamily: "Valve", brand: "Brand", category: "Part", dimension: "Size", valveType: "Mechanism" };
const modelsByBrand = {};
for (const mo of models) (modelsByBrand[mo.brand] ||= []).push(mo);

// The toilet section reads from the DATABASE, not the bundled parts.json snapshot.
// The snapshot has 12 seats and no photos; the database has the real catalogue, with pictures,
// and it grows every time we add stock.
const TOILET_CATS = ["toilet suite", "toilet seat", "toilet inlet valve", "toilet outlet valve", "flush button"];
const TOILET_LABEL = {
  "toilet suite": "🚽 Toilet suite",
  "toilet seat": "🪑 Toilet seat",
  "toilet inlet valve": "💧 Inlet (fill) valve",
  "toilet outlet valve": "🌀 Outlet (flush) valve",
  "flush button": "⏺ Flush button / plate",
};
const TOILET_HINT = {
  "toilet suite": "Find your suite first — it tells us the seat and the valves.",
  "toilet seat": "Match the shape and the fixing. Seats are the most-replaced toilet part.",
  "toilet inlet valve": "The valve the water pipe feeds into. Check bottom / back / side entry.",
  "toilet outlet valve": "The flush valve inside the cistern.",
  "flush button": "The button or plate you press.",
};

async function downscale(dataUrl, maxSide) {
  // A photo straight off a phone is 4-12MB. Base64-encoded that blows past the vision API's
  // per-image limit and the whole request is REJECTED - which is why real phone photos failed
  // while small test images worked. Shrink it here, in the browser, before it is ever sent.
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const side = Math.max(img.width, img.height);
    if (!side) return null;
    const scale = Math.min(1, (maxSide || 1600) / side);
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    cv.getContext("2d").drawImage(img, 0, 0, w, h);
    return cv.toDataURL("image/jpeg", 0.88);
  } catch { return null; }
}

async function cropToBox(dataUrl, box) {
  // Every catalogue photo is a clean studio shot - white background, tap filling the frame.
  // The customer photographs a tap on a basin, with tiles and a window behind it. CLIP embeds the
  // WHOLE picture, so the background goes into the fingerprint and we end up comparing
  // "tap in a bathroom" against "tap on white". Cropping to just the tap closes that gap.
  if (!box || !(box.w > 0.05) || !(box.h > 0.05)) return null;
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const pad = 0.06; // a little breathing room so we never clip the spout or the base
    const x = Math.max(0, box.x - pad) * img.width;
    const y = Math.max(0, box.y - pad) * img.height;
    let w = Math.min(1, box.w + pad * 2) * img.width;
    let h = Math.min(1, box.h + pad * 2) * img.height;
    w = Math.min(w, img.width - x); h = Math.min(h, img.height - y);
    if (w < 40 || h < 40) return null;
    // letterbox onto white so the result is framed like a product shot
    const size = Math.max(w, h);
    const cv = document.createElement("canvas");
    cv.width = 512; cv.height = 512;
    const cx = cv.getContext("2d");
    cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, 512, 512);
    const scale = 512 / size;
    cx.drawImage(img, x, y, w, h, (512 - w * scale) / 2, (512 - h * scale) / 2, w * scale, h * scale);
    return cv.toDataURL("image/jpeg", 0.9).split(",")[1];
  } catch { return null; }
}

function inferType(ai) {
  // Prefer the explicit fixture the vision step now returns (basin/shower/sink/bath).
  // A basin mixer and its paired shower mixer look near-identical, so this call matters.
  const fx = String((ai && ai.fixture) || "").toLowerCase().trim();
  if (["basin", "shower", "sink", "bath", "toilet"].includes(fx)) return fx;
  const s = (((ai && ai.description) || "") + " " + ((ai && ai.category) || "")).toLowerCase();
  if (/shower/.test(s)) return "shower";
  if (/(sink|kitchen)/.test(s)) return "sink";
  if (/bath/.test(s)) return "bath";
  if (/basin|lavatory|vanity/.test(s)) return "basin";
  return "";
}
const BRAND_PRIORITY = ["Felton","Methven","Foreno","Voda","Greens","LeVivi","Robertson","Caroma","Grohe","Hansgrohe","Phoenix","Nero","Meir","Dorf","Mizu","Posh","Paini","Newform","Mondella","Buddy","Franke"];
function buildCandidates(ai) {
  const t = inferType(ai);
  const brandsToTry = [];
  if (ai && ai.brand) brandsToTry.push(ai.brand);
  if (ai && Array.isArray(ai.brandGuesses)) for (const g of ai.brandGuesses) if (!brandsToTry.includes(g)) brandsToTry.push(g);
  let pool = [];
  for (const b of brandsToTry) { const arr = modelsByBrand[b]; if (arr) pool.push(...arr.filter((m) => m.photo)); }
  if (pool.length >= 2) {
    if (t) { const f = pool.filter((m) => (m.model || "").toLowerCase().includes(t)); if (f.length >= 2) pool = f; }
    const seen = new Set(); const out = [];
    for (const m of pool) { if (seen.has(m.model)) continue; seen.add(m.model); out.push(m); if (out.length >= 12) break; }
    return out;
  }
  const sample = [];
  for (const b of BRAND_PRIORITY) {
    const arr = (modelsByBrand[b] || []).filter((m) => m.photo && (!t || (m.model || "").toLowerCase().includes(t)));
    if (arr.length) sample.push(arr[0]);
    if (sample.length >= 12) break;
  }
  return sample;
}

function detectionsToAnswers(all, ai) {
  const order = [["productType", "Tapware"], ["brand", ai.brand]];
  const ans = []; let cur = {};
  for (const [field, val] of order) {
    if (!val) continue;
    const trial = { ...cur, [field]: val };
    if (applyFilters(all, trial).length > 0) { cur = trial; ans.push({ field, value: val }); }
  }
  return ans;
}

function distinctValues(rows, field) {
  const m = new Map();
  for (const p of rows) { const v = (p[field] || "").trim(); if (v) m.set(v, (m.get(v) || 0) + 1); }
  return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

function MeasureHelp() {
  return (
    <details className="measure">
      <summary>📏 How to measure your cartridge</summary>
      <p>Pull the old cartridge out and measure straight across the round body (the diameter) with a ruler or vernier calipers. That measurement in millimetres is what decides the part.</p>
      <p><b>Common sizes:</b> 25mm, 35mm, 40mm and 45mm.</p>
    </details>
  );
}

export default function Find() {
  const [answers, setAnswers] = useState([]);
  const [forceResults, setForceResults] = useState(false);
  const [skipModel, setSkipModel] = useState(false);
  const [modelResult, setModelResult] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [file, setFile] = useState(null);
  const [vmatch, setVmatch] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [ai, setAi] = useState(null);
  const [bFilter, setBFilter] = useState("");
  const [toilet, setToilet] = useState(null);
  const [tb, setTb] = useState(null);          // toilet browse: { cat, brand, items, brands, loading }
  const [tcounts, setTcounts] = useState(null);

  const sel = useMemo(() => answers.reduce((o, a) => ((o[a.field] = a.value), o), {}), [answers]);
  const pool = useMemo(() => applyFilters(parts, sel), [sel]);
  const brands = useMemo(() => listBrands(pool), [pool]);
  const brandSet = useMemo(() => new Set(listBrands(parts).map((b) => b.brand)), []);
  const q = useMemo(() => (sel.brand ? nextQuestion(parts, sel) : null), [sel]);
  const guesses = useMemo(() => (ai && Array.isArray(ai.brandGuesses) ? ai.brandGuesses.filter((g) => brandSet.has(g)) : []), [ai, brandSet]);

  const modelCards = useMemo(() => {
    if (sel.productType !== "Tapware" || !sel.brand) return [];
    const cat = modelsByBrand[sel.brand];
    if (cat && cat.length) return cat.map((mo) => ({ model: mo.model, photo: mo.photo, size: mo.size, cartPart: mo.cartPart, buyUrl: mo.buyUrl, exploded: mo.exploded, confirm: mo.confirm }));
    const rows = applyFilters(parts, sel).filter((p) => p.tapPhoto && p.category === "Cartridge");
    const byRange = new Map();
    for (const p of rows) if (!byRange.has(p.range)) byRange.set(p.range, { model: p.range, photo: p.tapPhoto, size: p.dimension, cartPart: p.partNumber, buyUrl: p.buyUrl, exploded: p.explodedUrl, confirm: false });
    return [...byRange.values()];
  }, [sel]);

  const add = (field, value) => { setForceResults(false); setSkipModel(false); setModelResult(null); setVmatch(null); setAnswers((a) => [...a.filter((x) => x.field !== field), { field, value }]); };
  const back = () => {
    setForceResults(false); setSkipModel(false);
    if (tb && tb.cat) { setTb({ cat: null, brand: "", items: null, brands: null, loading: false }); return; }
    if (tb) { setTb(null); return; }
    if (vmatch) { setVmatch(null); return; }
    if (modelResult) { setModelResult(null); return; }
    setAnswers((a) => a.slice(0, -1));
  };
  const reset = () => { setForceResults(false); setSkipModel(false); setModelResult(null); setAnswers([]); setPhoto(null); setFile(null); setAi(null); setVmatch(null); setToilet(null); setTb(null); };

  // --- Toilet browse, straight off the live database ---
  async function openToiletBrowse() {
    setTb({ cat: null, brand: "", items: null, brands: null, loading: false });
    if (!tcounts) {
      try {
        const r = await fetch("/api/browse?counts=1");
        const j = await r.json();
        if (j && j.counts) setTcounts(j.counts);
      } catch { /* menu still works without counts */ }
    }
  }
  async function loadBrowse(cat, brand) {
    setTb({ cat, brand: brand || "", items: null, brands: null, loading: true });
    try {
      const url = "/api/browse?category=" + encodeURIComponent(cat) + (brand ? "&brand=" + encodeURIComponent(brand) : "");
      const r = await fetch(url);
      const j = await r.json();
      setTb({ cat, brand: brand || "", items: (j && j.items) || [], brands: (j && j.brands) || [], loading: false });
    } catch {
      setTb({ cat, brand: brand || "", items: [], brands: [], loading: false });
    }
  }

  // A cistern gives no clue from the front whether the water feeds in at the bottom, the back
  // or the side. We cannot see it, so we ask - guessing would send someone home with the wrong valve.
  async function loadToiletParts(inlet) {
    if (!toilet) return;
    setToilet((t) => ({ ...t, inlet, loading: true, parts: null }));
    try {
      const r = await fetch("/api/toilet?suite=" + encodeURIComponent(toilet.suiteId) + "&inlet=" + encodeURIComponent(inlet));
      const j = await r.json();
      setToilet((t) => ({ ...t, inlet, loading: false, parts: j && !j.error ? j : null }));
    } catch { setToilet((t) => ({ ...t, inlet, loading: false, parts: null })); }
  }

  function pickModel(card, brandOverride) {
    const brand = brandOverride || card.brand || sel.brand;
    const found = card.cartPart ? parts.filter((p) => p.partNumber === card.cartPart) : [];
    let res;
    if (found.length) res = found.map((p) => ({ ...p, range: card.model, tapPhoto: card.photo || p.tapPhoto, explodedUrl: p.explodedUrl || card.exploded }));
    else res = [{ id: "m-" + card.model, brand: brand, range: card.model, component: card.size ? card.size + " ceramic cartridge" : "Replacement cartridge", category: "Cartridge", partNumber: card.cartPart || "", valveType: "", dimension: card.size || "", supersession: "", buyUrl: card.buyUrl, sourceUrl: card.buyUrl, verified: card.confirm ? "" : "Y", notes: card.confirm ? "Cartridge size from a retailer listing — confirm before ordering." : "This model uses a standard cartridge of this size; the maker doesn't sell a separate cartridge code.", photo: "", tapPhoto: card.photo, productType: "Tapware", valveFamily: "", explodedUrl: card.exploded }];
    setModelResult(res);
  }

  function onPickMatch(m) {
    setVmatch(null);
    const _cat = String((m.part && m.part.category) || "").toLowerCase();
    if (m.kind === "part" && m.part && _cat.indexOf("toilet suite") !== -1) {
      setToilet({ suiteId: String(m.part.id || "").replace(/^db-/, ""), suite: { brand: m.brand, model: m.model, partNo: m.part.partNumber || "" }, inlet: null, parts: null, loading: false });
      return;
    }
    if (m.kind === "part" && m.part) { setAnswers([{ field: "productType", value: m.part.productType || "Valve" }, { field: "brand", value: m.brand }]); setModelResult([m.part]); return; }
    if (m.kind === "cart" && m.card) { setAnswers([{ field: "productType", value: "Tapware" }, { field: "brand", value: m.brand || "Universal" }]); setModelResult([m.card]); return; }
    setAnswers([{ field: "productType", value: "Tapware" }, { field: "brand", value: m.brand }]);
    pickModel(m, m.brand);
  }

  function onPhoto(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setFile(f); setPhoto(URL.createObjectURL(f)); setAi(null); setModelResult(null);
  }

  async function runIdentify() {
    if (!file || analysing) return;
    setAi(null); setAnalysing(true); setModelResult(null);
    try {
      const rawUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
      // shrink the phone photo first - full-size ones are rejected by the vision API
      const dataUrl = (await downscale(String(rawUrl), 1600)) || String(rawUrl);
      const base64 = String(dataUrl).split(",")[1];
      const mediaType = (String(dataUrl).match(/data:(.*?);/) || [])[1] || "image/jpeg";
      const resp = await fetch("/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: base64, mediaType }) });
      const j = await resp.json();
      if (!resp.ok && j && (j.error === "rate_limited" || j.error === "image_too_large")) { setAi({ status: "notice", message: j.message }); return; }
      if (!j || j.configured === false) { setAi({ status: "off" }); return; }
      if (j.error) { setAi({ status: "error" }); return; }
      setAi(j);
      const pref = detectionsToAnswers(parts, j);
      try {
        const bg = [j.brand, ...(Array.isArray(j.brandGuesses) ? j.brandGuesses : [])].filter(Boolean);
        // Did we actually READ the maker's name off the tap (stamped on the handle/body)? That is
        // near-certain, unlike a guess from its shape - tell the matcher it can trust it.
        const marks = (Array.isArray(j.markings) ? j.markings : []).join(" ").toLowerCase();
        const brandSure = !!(j.brand && marks.includes(String(j.brand).toLowerCase()));
        // fingerprint the CROPPED tap, not the whole bathroom
        const cropped = await cropToBox(String(dataUrl), j.box);
        const qData = cropped || base64;
        const qMedia = cropped ? "image/jpeg" : mediaType;
        const mResp = await fetch("/api/match", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: qData, mediaType: qMedia, type: inferType(j), brandGuesses: bg, brand: j.brand || "", brandSure }) });
        const mj = await mResp.json();
        if (mj && Array.isArray(mj.ranked) && mj.ranked.length) {
          const top = mj.ranked.filter((r) => r.photo).slice(0, 6);
          if (top.length) setVmatch(top);
        }
      } catch { /* visual match is best-effort; ignore failures */ }
      if (pref.length) { setForceResults(false); setAnswers(pref); }
    } catch { setAi({ status: "error" }); } finally { setAnalysing(false); }
  }

  const stage = analysing ? "loading"
    : toilet ? "toilet"
    : tb ? "tbrowse"
    : (vmatch && vmatch.length) ? "matches"
    : modelResult ? "modelresult"
    : !sel.productType ? "type"
    : (sel.productType === "Valve" && !sel.valveFamily) ? "family"
    : !sel.brand ? "brand"
    : (sel.productType === "Tapware" && !skipModel && modelCards.length >= 1) ? "model"
    : (forceResults || !q) ? "results" : "question";

  const matches = pool;
  const toiletTotal = tcounts ? Object.values(tcounts).reduce((a, b) => a + b, 0) : null;

  return (
    <main className="finder">
      <div className="container">
        <h1 style={{ fontSize: 24, margin: "8px 0 2px" }}>Find your spare part</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Snap or upload a photo, or pick your way to the exact part.</p>

        {ai && ai.description && !analysing && stage !== "results" && stage !== "modelresult" && (
          <div className="aibar">
            <b>From your photo:</b> {ai.description}
            {ai.handleDesign ? <div className="reads"><span><b>Handle:</b> {ai.handleDesign}</span>{ai.spoutShape ? <span><b>Spout:</b> {ai.spoutShape}</span> : null}</div> : null}
          </div>
        )}
        {ai && ai.status === "off" && <div className="aibar muted">Photo recognition isn&apos;t switched on yet — pick your brand below.</div>}
        {ai && ai.status === "error" && <div className="aibar muted">Couldn&apos;t read that photo — pick your brand below.</div>}
        {ai && ai.status === "notice" && <div className="aibar muted">{ai.message || "Please try again in a moment."} You can also pick your brand below.</div>}

        <div className="crumbs">
          {answers.map((a) => (<span className="crumb" key={a.field}>{FIELD_LABEL[a.field]}: <b>{a.value}</b></span>))}
          {tb && <span className="crumb">Fixing: <b>Toilet</b></span>}
          {tb && tb.cat && <span className="crumb">Part: <b>{(TOILET_LABEL[tb.cat] || tb.cat).replace(/^\S+\s/, "")}</b></span>}
          {modelResult && <span className="crumb">Model: <b>{modelResult[0].range}</b></span>}
          {(answers.length > 0 || modelResult || tb) && (<><button className="crumb" onClick={back}>← Back</button><button className="crumb" onClick={reset}>Start over</button></>)}
        </div>

        {stage === "loading" && (
          <div className="panel">
            <div className="loadcard">
              <span className="spin big" />
              <div>
                <b>Identifying your tap…</b>
                <div className="sub">Reading the shape, then comparing it against our catalogue photos. This takes a few seconds.</div>
              </div>
            </div>
            {photo && <img src={photo} className="thumb" alt="your tap" style={{ marginTop: 12 }} />}
          </div>
        )}

        {stage === "type" && (
          <div className="panel">
            <div className="uploader">
              <div className="icon">📷</div>
              <div className="txt">
                <b>{analysing ? "Analysing your photo…" : "Fixing a tap? Show us a photo"}</b>
                {analysing ? "Reading the handle and spout to guess the brand." : "We guess the brand, then you pick the exact model."}
              </div>
              <div className="upbtns">
                <label className="btn btn-ghost">📷 Take photo<input type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} /></label>
                <label className="btn btn-ghost">🖼 Upload<input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} /></label>
              </div>
              {photo && <img src={photo} className="thumb" alt="your part" />}
              {photo && <button className="btn btn-primary goid" onClick={runIdentify} disabled={analysing}>{analysing ? <><span className="spin" /> Identifying…</> : "🔍 Identify this tap"}</button>}
            </div>
            {analysing && (
              <div className="loadcard">
                <span className="spin big" />
                <div>
                  <b>Identifying your tap…</b>
                  <div className="sub">Reading the shape, then comparing it against our catalogue photos. This takes a few seconds.</div>
                </div>
              </div>
            )}
            <h2>What are you fixing?</h2>
            <div className="grid">
              <button className="opt bigopt" onClick={() => add("productType", "Tapware")}>🚰 Tap / mixer <span className="c">{parts.filter((p) => p.productType === "Tapware").length}</span></button>
              <button className="opt bigopt" onClick={() => add("productType", "Valve")}>🎛 Valve <span className="c">{parts.filter((p) => p.productType === "Valve").length}</span></button>
              <button className="opt bigopt" onClick={openToiletBrowse}>🚽 Toilet{toiletTotal ? <span className="c">{toiletTotal}</span> : null}</button>
            </div>
          </div>
        )}

        {stage === "tbrowse" && (
          <div className="panel">
            {!tb.cat && (
              <>
                <h2>What toilet part?</h2>
                <p className="sub">Not sure which valve? Start with the suite — pick your toilet and we&apos;ll show the seat, the valves and the button that fit it.</p>
                <div className="grid">
                  {TOILET_CATS.map((c) => (
                    <button className="opt bigopt" key={c} onClick={() => loadBrowse(c, "")}>
                      {TOILET_LABEL[c]}
                      {tcounts && tcounts[c] ? <span className="c">{tcounts[c]}</span> : null}
                    </button>
                  ))}
                </div>
              </>
            )}

            {tb.cat && (
              <>
                <h2>{(TOILET_LABEL[tb.cat] || tb.cat).replace(/^\S+\s/, "")}</h2>
                <p className="sub">{TOILET_HINT[tb.cat] || "Pick the one that looks like yours."}</p>

                {tb.brands && tb.brands.length > 1 && (
                  <div className="guessrow" style={{ flexWrap: "wrap" }}>
                    <button className={"opt guess" + (tb.brand ? "" : " on")} onClick={() => loadBrowse(tb.cat, "")}>All</button>
                    {tb.brands.map((b) => (
                      <button className={"opt guess" + (tb.brand === b.brand ? " on" : "")} key={b.brand} onClick={() => loadBrowse(tb.cat, b.brand)}>
                        {b.brand} <span className="c">{b.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {tb.loading && <div className="aibar">Loading the catalogue…</div>}

                {!tb.loading && tb.items && tb.items.length === 0 && (
                  <p className="sub">Nothing in the catalogue for that yet.</p>
                )}

                {!tb.loading && tb.items && tb.items.length > 0 && (
                  <div className="models">
                    {tb.items.map((p) => (
                      <div className="modelcard" key={p.id}>
                        <div className="mimg">{p.photo ? <img src={p.photo} alt={p.model} loading="lazy" /> : <span className="mph">no photo</span>}</div>
                        <div className="minfo">
                          <div className="mname">{[p.brand, p.model].filter(Boolean).join(" ")}</div>
                          {(p.partNo || p.size) && <div className="mhint">{[p.partNo, p.size].filter(Boolean).join(" · ")}</div>}
                          {p.fits && <div className="mhint">{p.fits.length > 110 ? p.fits.slice(0, 110) + "…" : p.fits}</div>}
                          {p.cat === "toilet suite" ? null : null}
                          {p.buyUrl && <a className="smallbtn" href={p.buyUrl} target="_blank" rel="noreferrer">Buy / info &rarr;</a>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="toolbar">
                  <button className="btn btn-ghost" onClick={back}>← Back</button>
                  <button className="btn btn-ghost" onClick={reset}>Start over</button>
                </div>

                <p className="feedback-row">
                  Yours isn&apos;t here?{" "}
                  <a href="mailto:myhappyplace@web.de?subject=TapSnap%20%E2%80%94%20missing%20toilet%20part&body=Tell%20us%20the%20brand%20and%20model%20if%20you%20know%20it%2C%20and%20attach%20a%20photo%3A%0A%0A">Tell us</a>{" "}
                  and we&apos;ll add it.
                </p>
              </>
            )}
          </div>
        )}

        {stage === "family" && (
          <div className="panel">
            <h2>What kind of valve?</h2>
            <p className="sub">Tempering valves reduce hot-water temperature; the others control pressure and relief.</p>
            <div className="grid">
              {distinctValues(applyFilters(parts, { productType: sel.productType }), "valveFamily").map((o) => (
                <button className="opt" key={o.value} onClick={() => add("valveFamily", o.value)}>{o.value} <span className="c">{o.count}</span></button>
              ))}
            </div>
          </div>
        )}

        {stage === "brand" && (
          <div className="panel">
            {sel.productType === "Tapware" && guesses.length > 0 && (
              <div className="guessrow">
                <span className="glabel">Looks like:</span>
                {guesses.map((g) => (<button key={g} className="opt guess" onClick={() => add("brand", g)}>{g}</button>))}
                <span className="ghint">— tap one, or pick from the list</span>
              </div>
            )}
            <h2>Which brand is it?</h2>
            <p className="sub">{sel.productType === "Tapware" ? <>Look for a name on the tap, handle or flange. No name? Pick <b>Universal</b>.</> : "Check the valve body or label for the maker."}</p>
            <input className="brandfilter" type="text" inputMode="search" placeholder="🔍 Start typing your brand…" value={bFilter} onChange={(e) => setBFilter(e.target.value)} />
            {(() => {
              const t = bFilter.trim().toLowerCase();
              const shown = t ? brands.filter((b) => b.brand.toLowerCase().includes(t)) : brands;
              return shown.length ? (
                <div className="grid">
                  {shown.map((b) => (<button className="opt" key={b.brand} onClick={() => { setBFilter(""); add("brand", b.brand); }}>{b.brand} <span className="c">{b.count}</span></button>))}
                </div>
              ) : (
                <p className="sub" style={{ marginTop: 10 }}>No brand matches that. Try fewer letters, or clear the box and pick Universal.</p>
              );
            })()}
          </div>
        )}

        {stage === "matches" && (
          <div className="panel">
            <div className="matchhead">
              {photo && <img src={photo} className="thumb" alt="your tap" />}
              <div>
                <h2>Closest matches to your photo</h2>
                <p className="sub">Ranked by how closely each matches your tap. Pick the right one — or browse all brands.</p>
              </div>
            </div>
            <div className="models">
              {vmatch.map((m) => (
                <button className="modelcard" key={m.brand + m.model} onClick={() => onPickMatch(m)}>
                  <div className="mimg">{m.photo ? <img src={m.photo} alt={m.model} loading="lazy" /> : <span className="mph">no photo</span>}</div>
                  <div className="minfo">
                    <div className="mname">{m.brand} {m.model}</div>
                    <div className={m.same ? "mscore good" : "mscore"}>{m.same ? "Strong match" : "Possible"} · {Math.round(m.score)}%</div>
                  </div>
                </button>
              ))}
            </div>
            <div className="toolbar">
              <button className="btn btn-ghost" onClick={() => setVmatch(null)}>None of these — browse brands</button>
              <button className="btn btn-ghost" onClick={reset}>Start over</button>
            </div>
            <p className="feedback-row">
              None of these right, or your part isn&apos;t listed?{" "}
              <a href="mailto:myhappyplace@web.de?subject=TapSnap%20%E2%80%94%20wrong%20or%20missing%20part&body=Tell%20us%20what%20you%20were%20looking%20for%20(brand%20and%20model%20if%20known)%2C%20and%20attach%20your%20photo%20if%20you%20can%3A%0A%0A">Tell us</a>{" "}
              and we&apos;ll add it.
            </p>
          </div>
        )}

        {stage === "model" && (
          <div className="panel">
            <h2>Which of these is your tap?</h2>
            <p className="sub">Recognise it by shape — the model tells us the cartridge, so you won&apos;t need to measure. Not sure? Skip and go by size.</p>
            <div className="models">
              {modelCards.map((mo) => (
                <button className="modelcard" key={mo.model} onClick={() => pickModel(mo)}>
                  <div className="mimg">{mo.photo ? <img src={mo.photo} alt={mo.model} loading="lazy" /> : <span className="mph">no photo yet</span>}</div>
                  <div className="minfo">
                    <div className="mname">{mo.model}</div>
                    {(mo.size || mo.cartPart) && <div className="mhint">→ {[mo.size, mo.cartPart].filter(Boolean).join(" ")}{mo.confirm ? " ?" : ""}</div>}
                  </div>
                </button>
              ))}
            </div>
            <div className="toolbar">
              <button className="btn btn-ghost" onClick={() => setSkipModel(true)}>Not sure — go by size instead</button>
              <button className="btn btn-ghost" onClick={back}>Back</button>
            </div>
          </div>
        )}

        {stage === "question" && q && (
          <div className="panel">
            <h2>{q.label}</h2>
            <p className="sub">{q.remaining} possible parts so far — pick one to narrow it down.</p>
            {q.field === "dimension" && sel.productType === "Tapware" && <MeasureHelp />}
            <div className="grid">
              {q.options.map((o) => (<button className="opt" key={o.value} onClick={() => add(q.field, o.value)}>{o.value} <span className="c">{o.count}</span></button>))}
            </div>
            <div className="toolbar">
              <button className="btn btn-primary" onClick={() => setForceResults(true)}>Show matching parts ({matches.length})</button>
              <button className="btn btn-ghost" onClick={back}>Back</button>
            </div>
          </div>
        )}

        {stage === "toilet" && toilet && (
          <div className="panel">
            <div className="matchhead">
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>{[toilet.suite.brand, toilet.suite.model].filter(Boolean).join(" ")}</h2>
                <p className="mhint" style={{ margin: "2px 0 0" }}>Toilet suite{toilet.suite.partNo ? " · " + toilet.suite.partNo : ""}</p>
              </div>
              <button className="btn" type="button" onClick={() => setToilet(null)}>Back</button>
            </div>

            {!toilet.inlet && (
              <div style={{ marginTop: 14 }}>
                <h3 style={{ fontSize: 16, marginBottom: 4 }}>Where does the water pipe enter the cistern?</h3>
                <p className="mhint" style={{ marginTop: 0 }}>A photo can&rsquo;t show this &mdash; have a look behind or underneath the cistern. It decides which inlet valve you need.</p>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                  {[["bottom", "Bottom", "Pipe comes up underneath"], ["back", "Back", "Pipe comes through the wall behind"], ["side", "Side / top", "Pipe enters from the side or above"]].map((o) => (
                    <button key={o[0]} type="button" className="btn" style={{ flexDirection: "column", alignItems: "flex-start", textAlign: "left", minWidth: 168 }} onClick={() => loadToiletParts(o[0])}>
                      <span style={{ fontWeight: 700 }}>{o[1]}</span>
                      <span className="mhint" style={{ fontWeight: 400 }}>{o[2]}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {toilet.loading && <div className="aibar" style={{ marginTop: 14 }}>Finding the parts that fit&hellip;</div>}

            {toilet.parts && (
              <div style={{ marginTop: 16 }}>
                {toilet.parts.geberitNote && (
                  <div className="aibar" style={{ marginBottom: 12 }}>Heads up: Caroma&rsquo;s inlet valves are made by Geberit, so the part in your hand may well say GEBERIT on it. That is still the right part.</div>
                )}
                {[["Replacement seat", toilet.parts.seats], ["Inlet valve — " + toilet.inlet + " entry", toilet.parts.inletValves], ["Outlet / flush valve", toilet.parts.outletValves], ["Flush button / plate", toilet.parts.buttons]].map((sec) => (
                  <div key={sec[0]} style={{ marginBottom: 18 }}>
                    <h3 style={{ fontSize: 15, marginBottom: 8 }}>{sec[0]}</h3>
                    {(!sec[1] || !sec[1].length) ? (
                      <p className="mhint" style={{ marginTop: 0 }}>Nothing in the catalogue matches this suite yet.</p>
                    ) : (
                      <div className="models">
                        {sec[1].map((p) => (
                          <div className="modelcard" key={p.id}>
                            <div className="mimg">{p.photo ? <img src={p.photo} alt={p.model} loading="lazy" /> : <span className="mph">no photo</span>}</div>
                            <div className="minfo">
                              <div className="mname">{[p.brand, p.model].filter(Boolean).join(" ")}</div>
                              <div className="mhint">{p.partNo}{p.note ? " · " + p.note : ""}</div>
                              {p.buyUrl && <a className="smallbtn" href={p.buyUrl} target="_blank" rel="noreferrer">Buy / info &rarr;</a>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(stage === "results" || stage === "modelresult") && (
          <div className="results">
            {(() => { const list = modelResult || matches; return (<>
              <h2>{list.length} matching part{list.length === 1 ? "" : "s"}</h2>
              <p className="sub">{list.length > 1 ? "These all fit. Check the photo (and diagram) against yours." : "Here is your part — check it against yours."}</p>
              <div className="cards">{list.map((p) => <PartCard key={p.id} p={p} />)}</div>
              <div className="toolbar">
                <button className="btn btn-ghost" onClick={back}>← Back</button>
                <button className="btn btn-ghost" onClick={reset}>Start over</button>
              </div>
            </>); })()}
          </div>
        )}
      </div>
    </main>
  );
}

function PartCard({ p }) {
  const verified = p.verified === "Y";
  const pn = p.partNumber || (p.dimension ? p.dimension + " cartridge" : "Cartridge");
  const spareImg = p.photo || (cartimg.byCode && cartimg.byCode[p.partNumber]) || (cartimg.bySize && cartimg.bySize[p.dimension]) || "";
  return (
    <div className="card">
      <div className="imgs">
        <figure className="imgfig">
          <div className="imgwrap">{spareImg ? <img src={spareImg} alt={p.component} loading="lazy" /> : <span className="ph">{p.category}</span>}</div>
          <figcaption>{p.productType === "Valve" ? "The part" : "Spare part"}</figcaption>
        </figure>
        {p.tapPhoto && (
          <figure className="imgfig">
            <div className="imgwrap"><img src={p.tapPhoto} alt="the tap this fits" loading="lazy" /></div>
            <figcaption>Fits this tap</figcaption>
          </figure>
        )}
      </div>
      <div className="body">
        <div className="pn">{pn}</div>
        <div className="name">{p.component}</div>
        {p.range && <div className="fits">Fits: {p.range}</div>}
        <div className="chips">
          {p.valveFamily && <span className="chip">{p.valveFamily}</span>}
          {p.valveType && <span className="chip">{p.valveType}</span>}
          {p.dimension && <span className="chip">{p.dimension}</span>}
          <span className="chip">{p.brand}</span>
        </div>
        <span className={"badge " + (verified ? "v" : "d")}>{verified ? "✓ Verified source" : "⚠ Confirm fit"}</span>
        {p.notes && <div className="note2">{p.notes}</div>}
        {p.supersession && <div className="super">Supersession: {p.supersession}</div>}
        <div className="foot">
          {p.buyUrl && <a className="smallbtn" href={p.buyUrl} target="_blank" rel="noreferrer">Buy / info →</a>}
          {p.explodedUrl && <a className="diagram" href={p.explodedUrl} target="_blank" rel="noreferrer">📐 Diagram</a>}
          {p.sourceUrl && !p.explodedUrl && <a className="src" href={p.sourceUrl} target="_blank" rel="noreferrer">source</a>}
        </div>
      </div>
    </div>
  );
}
