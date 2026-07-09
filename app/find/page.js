"use client";
import { useMemo, useState } from "react";
import parts from "../../lib/parts.json";
import { listBrands, applyFilters, nextQuestion } from "../../lib/matcher.js";

const FIELD_LABEL = { productType: "Fixing", valveFamily: "Valve", brand: "Brand", range: "Model", category: "Part", dimension: "Size", valveType: "Mechanism" };

function detectionsToAnswers(all, ai) {
  const order = [["productType", "Tapware"], ["brand", ai.brand], ["category", ai.category], ["dimension", ai.dimension], ["valveType", ai.valveType]];
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
      <p><b>Common sizes:</b> 25mm, 35mm, 40mm and 45mm. If you can&apos;t measure it yet, pick your best guess and check the reference photo on the result.</p>
    </details>
  );
}

export default function Find() {
  const [answers, setAnswers] = useState([]);
  const [forceResults, setForceResults] = useState(false);
  const [skipModel, setSkipModel] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [ai, setAi] = useState(null);

  const sel = useMemo(() => answers.reduce((o, a) => ((o[a.field] = a.value), o), {}), [answers]);
  const pool = useMemo(() => applyFilters(parts, sel), [sel]);
  const brands = useMemo(() => listBrands(pool), [pool]);
  const brandSet = useMemo(() => new Set(listBrands(parts).map((b) => b.brand)), []);
  const matches = pool;
  const q = useMemo(() => (sel.brand ? nextQuestion(parts, sel) : null), [sel]);
  const guesses = useMemo(() => (ai && Array.isArray(ai.brandGuesses) ? ai.brandGuesses.filter((g) => brandSet.has(g)) : []), [ai, brandSet]);

  const modelOptions = useMemo(() => {
    if (sel.productType !== "Tapware" || !sel.brand || sel.range) return [];
    const rows = applyFilters(parts, sel).filter((p) => p.tapPhoto);
    const byRange = new Map();
    for (const p of rows) {
      let e = byRange.get(p.range);
      if (!e) { e = { range: p.range, tap: p.tapPhoto, cart: null }; byRange.set(p.range, e); }
      if (!e.cart && p.category === "Cartridge") e.cart = p;
    }
    return [...byRange.values()];
  }, [sel]);

  const add = (field, value) => { setForceResults(false); setSkipModel(false); setAnswers((a) => [...a.filter((x) => x.field !== field), { field, value }]); };
  const back = () => { setForceResults(false); setSkipModel(false); setAnswers((a) => a.slice(0, -1)); };
  const reset = () => { setForceResults(false); setSkipModel(false); setAnswers([]); setPhoto(null); setAi(null); };

  async function onPhoto(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    setPhoto(URL.createObjectURL(f)); setAi(null); setAnalysing(true);
    try {
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
      const base64 = String(dataUrl).split(",")[1];
      const mediaType = (String(dataUrl).match(/data:(.*?);/) || [])[1] || "image/jpeg";
      const resp = await fetch("/api/identify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: base64, mediaType }) });
      const j = await resp.json();
      if (!j || j.configured === false) { setAi({ status: "off" }); return; }
      if (j.error) { setAi({ status: "error" }); return; }
      setAi(j);
      const pref = detectionsToAnswers(parts, j);
      if (pref.length) { setForceResults(false); setAnswers(pref); }
    } catch { setAi({ status: "error" }); } finally { setAnalysing(false); }
  }

  const stage = !sel.productType ? "type"
    : (sel.productType === "Valve" && !sel.valveFamily) ? "family"
    : !sel.brand ? "brand"
    : (sel.productType === "Tapware" && !sel.range && !skipModel && modelOptions.length >= 2) ? "model"
    : (forceResults || !q) ? "results" : "question";

  return (
    <main className="finder">
      <div className="container">
        <h1 style={{ fontSize: 24, margin: "8px 0 2px" }}>Find your spare part</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Snap or upload a photo, or pick your way to the exact part.</p>

        {ai && ai.description && stage !== "results" && (
          <div className="aibar">
            <b>From your photo:</b> {ai.description}
            {ai.handleDesign ? <div className="reads"><span><b>Handle:</b> {ai.handleDesign}</span>{ai.spoutShape ? <span><b>Spout:</b> {ai.spoutShape}</span> : null}</div> : null}
            {ai.measureTip ? <div>{ai.measureTip}</div> : null}
          </div>
        )}
        {ai && ai.status === "off" && <div className="aibar muted">Photo recognition isn&apos;t switched on yet — pick your brand below to continue.</div>}
        {ai && ai.status === "error" && <div className="aibar muted">Couldn&apos;t read that photo — pick your brand below to continue.</div>}

        <div className="crumbs">
          {answers.map((a) => (<span className="crumb" key={a.field}>{FIELD_LABEL[a.field]}: <b>{a.value}</b></span>))}
          {answers.length > 0 && (<><button className="crumb" onClick={back}>← Back</button><button className="crumb" onClick={reset}>Start over</button></>)}
        </div>

        {stage === "type" && (
          <div className="panel">
            <div className="uploader">
              <div className="icon">📷</div>
              <div className="txt">
                <b>{analysing ? "Analysing your photo…" : "Fixing a tap? Show us a photo"}</b>
                {analysing ? "Reading the handle and spout to guess the brand." : "We look at the handle and spout to guess the brand, then help you pick the model."}
              </div>
              <div className="upbtns">
                <label className="btn btn-ghost">📷 Take photo<input type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} /></label>
                <label className="btn btn-ghost">🖼 Upload<input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} /></label>
              </div>
              {photo && <img src={photo} className="thumb" alt="your part" />}
            </div>
            <h2>What are you fixing?</h2>
            <div className="grid">
              <button className="opt bigopt" onClick={() => add("productType", "Tapware")}>🚰 Tap / mixer <span className="c">{parts.filter((p) => p.productType === "Tapware").length}</span></button>
              <button className="opt bigopt" onClick={() => add("productType", "Valve")}>🎛 Valve <span className="c">{parts.filter((p) => p.productType === "Valve").length}</span></button>
            </div>
          </div>
        )}

        {stage === "family" && (
          <div className="panel">
            <h2>What kind of valve?</h2>
            <p className="sub">Tempering valves reduce hot-water temperature; the others control pressure and relief.</p>
            <div className="grid">
              {distinctValues(applyFilters(parts, { productType: "Valve" }), "valveFamily").map((o) => (
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
            <div className="grid">
              {brands.map((b) => (<button className="opt" key={b.brand} onClick={() => add("brand", b.brand)}>{b.brand} <span className="c">{b.count}</span></button>))}
            </div>
          </div>
        )}

        {stage === "model" && (
          <div className="panel">
            <h2>Which of these is your tap?</h2>
            <p className="sub">Recognise it by shape — the model tells us the cartridge, so you won&apos;t need to measure. Not sure? Skip and go by size.</p>
            <div className="models">
              {modelOptions.map((m) => (
                <button className="modelcard" key={m.range} onClick={() => add("range", m.range)}>
                  <div className="mimg">{m.tap ? <img src={m.tap} alt={m.range} loading="lazy" /> : null}</div>
                  <div className="minfo">
                    <div className="mname">{m.range}</div>
                    {m.cart && <div className="mhint">→ {m.cart.dimension ? m.cart.dimension + " " : ""}{m.cart.partNumber}</div>}
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

        {stage === "results" && (
          <div className="results">
            <h2>{matches.length} matching part{matches.length === 1 ? "" : "s"}</h2>
            <p className="sub">{matches.length > 1 ? "These all fit your answers. Check the photo (and diagram) against yours." : "Here is your part — check it against yours."}</p>
            <div className="cards">{matches.map((p) => <PartCard key={p.id} p={p} />)}</div>
            <div className="toolbar">
              <button className="btn btn-ghost" onClick={back}>← Refine answers</button>
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
  return (
    <div className="card">
      <div className="imgs">
        <figure className="imgfig">
          <div className="imgwrap">{p.photo ? <img src={p.photo} alt={p.component} loading="lazy" /> : <span className="ph">{p.category}</span>}</div>
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
        <div className="pn">{p.partNumber}</div>
        <div className="name">{p.component}</div>
        {p.range && <div className="fits">Fits: {p.range}</div>}
        <div className="chips">
          {p.valveFamily && <span className="chip">{p.valveFamily}</span>}
          {p.valveType && <span className="chip">{p.valveType}</span>}
          {p.dimension && <span className="chip">{p.dimension}</span>}
          <span className="chip">{p.brand}</span>
        </div>
        <span className={"badge " + (verified ? "v" : "d")}>{verified ? "✓ Verified source" : "⚠ Confirm fit"}</span>
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
