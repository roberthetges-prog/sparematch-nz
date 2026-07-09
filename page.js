"use client";
import { useMemo, useState } from "react";
import parts from "../../lib/parts.json";
import { listBrands, applyFilters, nextQuestion } from "../../lib/matcher.js";

const FIELD_LABEL = { brand: "Brand", category: "Type", valveType: "Valve", dimension: "Size" };

export default function Find() {
  const [answers, setAnswers] = useState([]); // [{field,value}]
  const [forceResults, setForceResults] = useState(false);
  const [photo, setPhoto] = useState(null);

  const brands = useMemo(() => listBrands(parts), []);
  const sel = useMemo(
    () => answers.reduce((o, a) => ((o[a.field] = a.value), o), {}),
    [answers]
  );
  const matches = useMemo(() => applyFilters(parts, sel), [sel]);
  const q = useMemo(() => nextQuestion(parts, sel), [sel]);

  const add = (field, value) => {
    setForceResults(false);
    setAnswers((a) => [...a.filter((x) => x.field !== field), { field, value }]);
  };
  const back = () => { setForceResults(false); setAnswers((a) => a.slice(0, -1)); };
  const reset = () => { setForceResults(false); setAnswers([]); };

  const onPhoto = (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setPhoto(URL.createObjectURL(f));
  };

  const showResults = !sel.brand ? false : forceResults || !q;

  return (
    <main className="finder">
      <div className="container">
        <h1 style={{ fontSize: 24, margin: "8px 0 2px" }}>Find your spare part</h1>
        <p style={{ color: "var(--muted)", marginTop: 0 }}>
          Answer a question or two and we&apos;ll match the exact part.
        </p>

        {/* breadcrumbs */}
        <div className="crumbs">
          {answers.map((a) => (
            <span className="crumb" key={a.field}>
              {FIELD_LABEL[a.field]}: <b>{a.value}</b>
            </span>
          ))}
          {answers.length > 0 && (
            <>
              <button className="crumb" onClick={back} style={{ cursor: "pointer" }}>← Back</button>
              <button className="crumb" onClick={reset} style={{ cursor: "pointer" }}>Start over</button>
            </>
          )}
        </div>

        {/* STEP 1: brand + photo */}
        {!sel.brand && (
          <div className="panel">
            <div className="uploader">
              <div className="icon">📷</div>
              <div className="txt">
                <b>Photo recognition is coming soon</b>
                Soon you&apos;ll snap the tap and we&apos;ll detect the brand and valve type for you.
                For now, add a photo for your own reference and pick the brand below.
              </div>
              <label className="btn btn-ghost" style={{ marginLeft: "auto" }}>
                Add photo
                <input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} />
              </label>
              {photo && <img src={photo} className="thumb" alt="your part" />}
            </div>
            <h2>Which brand is it?</h2>
            <p className="sub">Look for a name on the tap, handle or flange.</p>
            <div className="grid">
              {brands.map((b) => (
                <button className="opt" key={b.brand} onClick={() => add("brand", b.brand)}>
                  {b.brand} <span className="c">{b.count}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* STEP 2: narrowing question */}
        {sel.brand && !showResults && q && (
          <div className="panel">
            <h2>{q.label}</h2>
            <p className="sub">{q.remaining} possible parts so far — pick one to narrow it down.</p>
            <div className="grid">
              {q.options.map((o) => (
                <button className="opt" key={o.value} onClick={() => add(q.field, o.value)}>
                  {o.value} <span className="c">{o.count}</span>
                </button>
              ))}
            </div>
            <div className="toolbar">
              <button className="btn btn-primary" onClick={() => setForceResults(true)}>
                Show matching parts ({matches.length})
              </button>
              <button className="btn btn-ghost" onClick={back}>Back</button>
            </div>
          </div>
        )}

        {/* STEP 3: results */}
        {showResults && (
          <div className="results">
            <h2>{matches.length} matching part{matches.length === 1 ? "" : "s"}</h2>
            <p className="sub">
              {matches.length > 1
                ? "These all fit your answers. Match the reference photo or your tap model to pick the right one."
                : "Here is your part."}
            </p>
            <div className="cards">
              {matches.map((p) => (
                <PartCard key={p.id} p={p} />
              ))}
            </div>
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
      <div className="imgwrap">
        {p.photo ? (
          <img src={p.photo} alt={p.component} loading="lazy" />
        ) : (
          <span className="ph">{p.category}</span>
        )}
      </div>
      <div className="body">
        <div className="pn">{p.partNumber}</div>
        <div className="name">{p.component}</div>
        {p.range && <div className="fits">Fits: {p.range}</div>}
        <div className="chips">
          {p.valveType && <span className="chip">{p.valveType}</span>}
          {p.dimension && <span className="chip">{p.dimension}</span>}
          <span className="chip">{p.brand}</span>
        </div>
        <span className={"badge " + (verified ? "v" : "d")}>
          {verified ? "✓ Verified source" : "⚠ Confirm fit"}
        </span>
        {p.supersession && <div className="super">Supersession: {p.supersession}</div>}
        <div className="foot">
          {p.buyUrl && (
            <a className="smallbtn" href={p.buyUrl} target="_blank" rel="noreferrer">
              Buy / info →
            </a>
          )}
          {p.sourceUrl && (
            <a className="src" href={p.sourceUrl} target="_blank" rel="noreferrer">
              source
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
