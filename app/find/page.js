"use client";
import { useEffect, useMemo, useState } from "react";
import parts from "../../lib/parts.json";
import models from "../../lib/models.json";
import cartimg from "../../lib/cartimg.json";
import { applyFilters } from "../../lib/matcher.js";

const modelsByBrand = {};
for (const mo of models) (modelsByBrand[mo.brand] ||= []).push(mo);

// EVERYTHING the user browses comes from the DATABASE (/api/browse), never from the bundled
// parts.json snapshot. That snapshot is frozen: it showed 12 toilet seats with no photos while
// the database held 53 with pictures, and every product we ingested stayed invisible until a
// redeploy. Browse must read live, or the catalogue work is wasted.
const MIXER_CATS = ["basin mixer", "sink mixer", "shower mixer", "bath mixer"];

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
  // What we hand the matcher to narrow the search with.
  //
  // BE CAREFUL HERE. Narrowing on a guess is only safe when the guess is safe. We measured the
  // vision step calling a textbook bottom-entry FILL valve - black cup float, threaded tail out
  // the bottom - an "outlet valve", with high confidence. Had we narrowed on that, the correct
  // part could not have appeared at all: a wrong label doesn't just mislead, it deletes the right
  // answer from the pool. So for the two cistern valves we deliberately narrow only to the coarse
  // "toilet" family and let the reranker - which sees the candidate photos side by side, and knows
  // a float means inlet - make the call. Comparing pictures beats classifying one in isolation.
  const pt = String((ai && ai.partType) || "").toLowerCase().trim();
  if (pt === "toilet inlet valve" || pt === "toilet outlet valve") return "toilet";
  if (pt) return pt;
  // Older/looser answers: fall back to the fixture. "basin" still narrows "basin mixer".
  const fx = String((ai && ai.fixture) || "").toLowerCase().trim();
  if (["basin", "shower", "sink", "bath", "toilet"].includes(fx)) return fx;
  const s = (((ai && ai.description) || "") + " " + ((ai && ai.category) || "")).toLowerCase();
  if (/shower/.test(s)) return "shower";
  if (/(sink|kitchen)/.test(s)) return "sink";
  if (/bath/.test(s)) return "bath";
  if (/basin|lavatory|vanity/.test(s)) return "basin";
  return "";
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
  const [modelResult, setModelResult] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [file, setFile] = useState(null);
  const [vmatch, setVmatch] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [ai, setAi] = useState(null);
  const [toilet, setToilet] = useState(null);
  const [groups, setGroups] = useState(null);
  const [br, setBr] = useState(null); // { group, label, cats, cat, catLabel, brand, items, brands, loading, sel }

  useEffect(() => {
    let live = true;
    fetch("/api/browse?groups=1")
      .then((r) => r.json())
      .then((j) => { if (live && j && j.groups) setGroups(j.groups); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const reset = () => { setModelResult(null); setPhoto(null); setFile(null); setAi(null); setVmatch(null); setToilet(null); setBr(null); };
  const back = () => {
    if (br && br.sel) { setBr({ ...br, sel: null }); return; }
    if (br && br.cat) { setBr({ ...br, cat: null, catLabel: "", brand: "", items: null, brands: null, sel: null }); return; }
    if (br) { setBr(null); return; }
    if (vmatch) { setVmatch(null); return; }
    if (modelResult) { setModelResult(null); return; }
  };

  function openGroup(g) {
    setBr({ group: g.key, label: g.label, cats: g.cats, cat: null, catLabel: "", brand: "", items: null, brands: null, loading: false, sel: null });
  }
  async function loadCat(cat, catLabel, brand) {
    setBr((b) => ({ ...b, cat, catLabel, brand: brand || "", items: null, brands: b && b.brand === (brand || "") ? b.brands : null, loading: true, sel: null }));
    try {
      const url = "/api/browse?category=" + encodeURIComponent(cat) + (brand ? "&brand=" + encodeURIComponent(brand) : "");
      const j = await (await fetch(url)).json();
      setBr((b) => ({ ...b, cat, catLabel, brand: brand || "", items: (j && j.items) || [], brands: brand ? b.brands : (j && j.brands) || [], loading: false, sel: null }));
    } catch {
      setBr((b) => ({ ...b, cat, catLabel, brand: brand || "", items: [], loading: false, sel: null }));
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

  function openSuite(item) {
    setToilet({ suiteId: String(item.id), suite: { brand: item.brand, model: item.model, partNo: item.partNo || "" }, inlet: null, parts: null, loading: false });
  }

  function pickModel(card, brandOverride) {
    const brand = brandOverride || card.brand || "";
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
    if (m.kind === "part" && m.part) { setModelResult([m.part]); return; }
    if (m.kind === "cart" && m.card) { setModelResult([m.card]); return; }
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
      const dataUrl = (await downscale(String(rawUrl), 1600)) || String(rawUrl);
      const base64 = String(dataUrl).split(",")[1];
      const mediaType = (String(dataUrl).match(/data:(.*?);/) || [])[1] || "image/jpeg";
      const resp = await fetch("/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: base64, mediaType }) });
      const j = await resp.json();
      if (!resp.ok && j && (j.error === "rate_limited" || j.error === "image_too_large")) { setAi({ status: "notice", message: j.message }); return; }
      if (!j || j.configured === false) { setAi({ status: "off" }); return; }
      if (j.error) { setAi({ status: "error" }); return; }
      setAi(j);
      try {
        const bg = [j.brand, ...(Array.isArray(j.brandGuesses) ? j.brandGuesses : [])].filter(Boolean);
        // Did we actually READ the maker's name off the tap (stamped on the handle/body)? That is
        // near-certain, unlike a guess from its shape - tell the matcher it can trust it.
        const marks = (Array.isArray(j.markings) ? j.markings : []).join(" ").toLowerCase();
        const brandSure = !!(j.brand && marks.includes(String(j.brand).toLowerCase()));
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
    } catch { setAi({ status: "error" }); } finally { setAnalysing(false); }
  }

  const stage = analysing ? "loading"
    : toilet ? "toilet"
    : br ? "browse"
    : (vmatch && vmatch.length) ? "matches"
    : modelResult ? "modelresult"
    : "type";

  const crumbs = useMemo(() => {
    const c = [];
    if (br) c.push(["Fixing", br.label]);
    if (br && br.catLabel) c.push(["Part", br.catLabel]);
    if (br && br.brand) c.push(["Brand", br.brand]);
    if (modelResult) c.push(["Model", modelResult[0].range]);
    return c;
  }, [br, modelResult]);

  return (
    <main className="finder">
      <div className="container">
        <h1 style={{ fontSize: 24, margin: "8px 0 2px" }}>Find your spare part</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Snap or upload a photo, or pick your way to the exact part.</p>

        {ai && ai.description && !analysing && stage !== "modelresult" && (
          <div className="aibar">
            <b>From your photo:</b> {ai.description}
            {ai.handleDesign ? <div className="reads"><span><b>Handle:</b> {ai.handleDesign}</span>{ai.spoutShape ? <span><b>Spout:</b> {ai.spoutShape}</span> : null}</div> : null}
          </div>
        )}
        {ai && ai.status === "off" && <div className="aibar muted">Photo recognition isn&apos;t switched on yet — pick your part below.</div>}
        {ai && ai.status === "error" && <div className="aibar muted">Couldn&apos;t read that photo — pick your part below.</div>}
        {ai && ai.status === "notice" && <div className="aibar muted">{ai.message || "Please try again in a moment."} You can also pick your part below.</div>}

        <div className="crumbs">
          {crumbs.map((c) => (<span className="crumb" key={c[0]}>{c[0]}: <b>{c[1]}</b></span>))}
          {(br || modelResult || vmatch || toilet) && (<><button className="crumb" onClick={back}>← Back</button><button className="crumb" onClick={reset}>Start over</button></>)}
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
            <h2>What are you fixing?</h2>
            {!groups && <p className="sub">Loading the catalogue…</p>}
            <div className="grid">
              {(groups || []).map((g) => (
                <button className="opt bigopt" key={g.key} onClick={() => openGroup(g)}>
                  {g.icon} {g.label} <span className="c">{g.total}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {stage === "browse" && br && (
          <div className="panel">
            {/* 1. which kind of part */}
            {!br.cat && (
              <>
                <h2>{br.label} — what exactly?</h2>
                <p className="sub">Pick the part you&apos;re replacing. Everything here is live from the catalogue.</p>
                <div className="grid">
                  {br.cats.map((c) => (
                    <button className="opt bigopt" key={c.cat} onClick={() => loadCat(c.cat, c.label, "")} style={{ flexDirection: "column", alignItems: "flex-start", textAlign: "left" }}>
                      <span style={{ fontWeight: 700 }}>{c.label} <span className="c">{c.count}</span></span>
                      {c.hint ? <span className="mhint" style={{ fontWeight: 400 }}>{c.hint}</span> : null}
                    </button>
                  ))}
                </div>
              </>
            )}

            {/* 3. one product, in detail */}
            {br.cat && br.sel && (
              <>
                <div className="matchhead">
                  <div>
                    <h2 style={{ margin: 0, fontSize: 18 }}>{[br.sel.brand, br.sel.model].filter(Boolean).join(" ")}</h2>
                    <p className="mhint" style={{ margin: "2px 0 0" }}>{br.catLabel}{(br.sel.sku || br.sel.partNo) ? " · " + (br.sel.sku || br.sel.partNo) : ""}</p>
                  </div>
                  <button className="btn" type="button" onClick={() => setBr({ ...br, sel: null })}>Back</button>
                </div>
                <div className="models" style={{ marginTop: 12 }}>
                  <div className="modelcard" style={{ maxWidth: 320 }}>
                    <div className="mimg">{br.sel.photo ? <img src={br.sel.photo} alt={br.sel.model} /> : <span className="mph">no photo</span>}</div>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  {MIXER_CATS.includes(br.sel.category) && (
                    // partNo is the CARTRIDGE code. sku is the shop's code for the tap itself.
                    // Only ever call something a cartridge if it actually is one.
                    br.sel.partNo ? (
                      <div className="aibar">
                        <b>Takes cartridge:</b> {[br.sel.partNo, br.sel.size].filter(Boolean).join(" · ")}
                        {br.sel.confirm ? <div className="mhint" style={{ marginTop: 4 }}>Confirm the size and fit before ordering.</div> : null}
                      </div>
                    ) : (
                      <>
                        <div className="aibar muted">
                          We don&apos;t have the cartridge code for this model yet{br.sel.size ? <> — but the maker states a <b>{br.sel.size}</b> cartridge</> : null}. Pull the old one out and measure it before you order.
                        </div>
                        <MeasureHelp />
                      </>
                    )
                  )}
                  {br.sel.fits && <p className="sub" style={{ marginTop: 10 }}>{br.sel.fits}</p>}
                  <div className="toolbar">
                    {br.sel.category === "toilet suite" && <button className="btn btn-primary" onClick={() => openSuite(br.sel)}>Find the parts for this suite →</button>}
                    {br.sel.buyUrl && <a className="btn btn-ghost" href={br.sel.buyUrl} target="_blank" rel="noreferrer">Buy / info →</a>}
                    {br.sel.exploded && <a className="btn btn-ghost" href={br.sel.exploded} target="_blank" rel="noreferrer">📐 Diagram</a>}
                  </div>
                </div>
              </>
            )}

            {/* 2. the visual picker */}
            {br.cat && !br.sel && (
              <>
                <h2>{br.catLabel}</h2>
                <p className="sub">Recognise yours by shape. {br.items ? br.items.length : ""} {br.items ? (br.items.length === 1 ? "product" : "products") : ""} in the catalogue.</p>

                {br.brands && br.brands.length > 1 && (
                  <div className="guessrow" style={{ flexWrap: "wrap" }}>
                    <button className="opt guess" onClick={() => loadCat(br.cat, br.catLabel, "")}>All</button>
                    {br.brands.map((b) => (
                      <button className="opt guess" key={b.brand} onClick={() => loadCat(br.cat, br.catLabel, b.brand)}>
                        {b.brand} <span className="c">{b.count}</span>
                      </button>
                    ))}
                  </div>
                )}

                {br.loading && <div className="aibar">Loading the catalogue…</div>}

                {!br.loading && br.items && br.items.length === 0 && <p className="sub">Nothing in the catalogue for that yet.</p>}

                {!br.loading && br.items && br.items.length > 0 && (
                  <div className="models">
                    {br.items.map((p) => (
                      <button className="modelcard" key={p.id} onClick={() => setBr({ ...br, sel: p })}>
                        <div className="mimg">{p.photo ? <img src={p.photo} alt={p.model} loading="lazy" /> : <span className="mph">no photo</span>}</div>
                        <div className="minfo">
                          <div className="mname">{[p.brand, p.model].filter(Boolean).join(" ")}</div>
                          {(p.sku || p.partNo || p.size) && <div className="mhint">{[p.sku || p.partNo, p.size].filter(Boolean).join(" · ")}</div>}
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                <div className="toolbar">
                  <button className="btn btn-ghost" onClick={back}>← Back</button>
                  <button className="btn btn-ghost" onClick={reset}>Start over</button>
                </div>

                <p className="feedback-row">
                  Yours isn&apos;t here?{" "}
                  <a href="mailto:myhappyplace@web.de?subject=TapSnap%20%E2%80%94%20missing%20part&body=Tell%20us%20the%20brand%20and%20model%20if%20you%20know%20it%2C%20and%20attach%20a%20photo%3A%0A%0A">Tell us</a>{" "}
                  and we&apos;ll add it.
                </p>
              </>
            )}
          </div>
        )}

        {stage === "matches" && (
          <div className="panel">
            <div className="matchhead">
              {photo && <img src={photo} className="thumb" alt="your tap" />}
              <div>
                <h2>Closest matches to your photo</h2>
                <p className="sub">Ranked by how closely each matches your tap. Pick the right one — or browse instead.</p>
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
              <button className="btn btn-ghost" onClick={() => setVmatch(null)}>None of these — browse instead</button>
              <button className="btn btn-ghost" onClick={reset}>Start over</button>
            </div>
            <p className="feedback-row">
              None of these right, or your part isn&apos;t listed?{" "}
              <a href="mailto:myhappyplace@web.de?subject=TapSnap%20%E2%80%94%20wrong%20or%20missing%20part&body=Tell%20us%20what%20you%20were%20looking%20for%20(brand%20and%20model%20if%20known)%2C%20and%20attach%20your%20photo%20if%20you%20can%3A%0A%0A">Tell us</a>{" "}
              and we&apos;ll add it.
            </p>
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

        {stage === "modelresult" && modelResult && (
          <div className="results">
            <h2>{modelResult.length} matching part{modelResult.length === 1 ? "" : "s"}</h2>
            <p className="sub">{modelResult.length > 1 ? "These all fit. Check the photo (and diagram) against yours." : "Here is your part — check it against yours."}</p>
            <div className="cards">{modelResult.map((p) => <PartCard key={p.id} p={p} />)}</div>
            <div className="toolbar">
              <button className="btn btn-ghost" onClick={back}>← Back</button>
              <button className="btn btn-ghost" onClick={reset}>Start over</button>
            </div>
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
