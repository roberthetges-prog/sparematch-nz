"use client";
import { useMemo, useState } from "react";
import parts from "../../lib/parts.json";
import { listBrands, applyFilters, nextQuestion } from "../../lib/matcher.js";

const FIELD_LABEL = { brand: "Brand", category: "Type", dimension: "Size", valveType: "Valve" };

function detectionsToAnswers(all, ai) {
  const order = [
    ["brand", ai.brand],
    ["category", ai.category],
    ["dimension", ai.dimension],
    ["valveType", ai.valveType],
  ];
  const ans = [];
  let cur = {};
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
      <p><b>Common sizes:</b> 25mm, 35mm, 40mm and 45mm. If you can&apos;t measure it yet, pick your best guess and check the reference photo on the result.</p>
    </details>
  );
}

export default function Find() {
  const [answers, setAnswers] = useState([]);
  const [forceResults, setForceResults] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [analysing, setAnalysing] = useState(false);
  const [ai, setAi] = useState(null);

  const brands = useMemo(() => listBrands(parts), []);
  const sel = useMemo(() => answers.reduce((o, a) => ((o[a.field] = a.value), o), {}), [answers]);
  const matches = useMemo(() => applyFilters(parts, sel), [sel]);
  const q = useMemo(() => nextQuestion(parts, sel), [sel]);

  const add = (field, value) => { setForceResults(false); setAnswers((a) => [...a.filter((x) => x.field !== field), { field, value }]); };
  const back = () => { setForceResults(false); setAnswers((a) => a.slice(0, -1)); };
  const reset = () => { setForceResults(false); setAnswers([]); setPhoto(null); setAi(null); };

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

  const showResults = !sel.brand ? false : forceResults || !q;

  return (
    <main className="finder">
      <div className="container">
        <h1 style={{ fontSize: 24, margin: "8px 0 2px" }}>Find your spare part</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>Snap a photo or pick your brand, and we&apos;ll match the exact part.</p>

        {ai && ai.description && (
          <div className="aibar">
            <b>From your photo:</b> {ai.description}
            {ai.leverType === "single-lever" ? " Looks like a single-lever mixer — that means a cartridge, so the size is the key thing." : ""}
            {ai.measureTip ? " " + ai.measureTip : ""}
          </div>
        )}
        {ai && ai.status === "off" && <div className="aibar muted">Photo recognition isn&apos;t switched on yet — pick your brand below to continue.</div>}
        {ai && ai.status === "error" && <div className="aibar muted">Couldn&apos;t read that photo — pick your brand below to continue.</div>}

        <div className="crumbs">
          {answers.map((a) => (<span className="crumb" key={a.field}>{FIELD_LABEL[a.field]}: <b>{a.value}</b></span>))}
          {answers.length > 0 && (<><button className="crumb" onClick={back}>← Back</button><button className="crumb" onClick={reset}>Start over</button></>)}
        </div>

        {!sel.brand && (
          <div className="panel">
            <div className="uploader">
              <div className="icon">📷</div>
              <div className="txt">
                <b>{analysing ? "Analysing your photo…" : "Snap the tap or the removed cartridge"}</b>
                {analysing ? "Reading the image and matching it to our parts." : "We'll detect the type and read any branding, then ask you the size."}
              </div>
              <label className="btn btn-ghost" style={{ marginLeft: "auto" }}>
                {photo ? "Change photo" : "Add photo"}
                <input type="file" accept="image/*" capture="environment" onChange={onPhoto} style={{ display: "none" }} />
              </label>
              {photo && <img src={photo} className="thumb" alt="your part" />}
            </div>
            <h2>Which brand is it?</h2>
            <p className="sub">Look for a name on the tap, handle or flange. No name? Pick <b>Universal</b> — most taps use a standard cartridge.</p>
            <div className="grid">
              {brands.map((b) => (<button className="opt" key={b.brand} onClick={() => add("brand", b.brand)}>{b.brand} <span className="c">{b.count}</span></button>))}
            </div>
          </div>
        )}

        {sel.brand && !showResults && q && (
          <div className="panel">
            {photo && (
              <div className="uploader" style={{ marginBottom: 16 }}>
                <img src={photo} className="thumb" alt="your part" />
                <div className="txt"><b>Your photo</b>{ai && ai.description ? ai.description : "Answer the question to narrow it down."}</div>
              </div>
            )}
            <h2>{q.label}</h2>
            <p className="sub">{q.remaining} possible parts so far — pick one to narrow it down.</p>
            {q.field === "dimension" && <MeasureHelp />}
            <div className="grid">
              {q.options.map((o) => (<button className="opt" key={o.value} onClick={() => add(q.field, o.value)}>{o.value} <span className="c">{o.count}</span></button>))}
            </div>
            <div className="toolbar">
              <button className="btn btn-primary" onClick={() => setForceResults(true)}>Show matching parts ({matches.length})</button>
              <button className="btn btn-ghost" onClick={back}>Back</button>
            </div>
          </div>
        )}

        {showResults && (
          <div className="results">
            <h2>{matches.length} matching part{matches.length === 1 ? "" : "s"}</h2>
            <p className="sub">{matches.length > 1 ? "These all fit your answers. Match the reference photo or your tap model to pick the right one." : "Here is your part."}</p>
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
      <div className="imgwrap">{p.photo ? <img src={p.photo} alt={p.component} loading="lazy" /> : <span className="ph">{p.category}</span>}</div>
      <div className="body">
        <div className="pn">{p.partNumber}</div>
        <div className="name">{p.component}</div>
        {p.range && <div className="fits">Fits: {p.range}</div>}
        <div className="chips">
          {p.valveType && <span className="chip">{p.valveType}</span>}
          {p.dimension && <span className="chip">{p.dimension}</span>}
          <span className="chip">{p.brand}</span>
        </div>
        <span className={"badge " + (verified ? "v" : "d")}>{verified ? "✓ Verified source" : "⚠ Confirm fit"}</span>
        {p.supersession && <div className="super">Supersession: {p.supersession}</div>}
        <div className="foot">
          {p.buyUrl && <a className="smallbtn" href={p.buyUrl} target="_blank" rel="noreferrer">Buy / info →</a>}
          {p.sourceUrl && <a className="src" href={p.sourceUrl} target="_blank" rel="noreferrer">source</a>}
        </div>
      </div>
    </div>
  );
}
