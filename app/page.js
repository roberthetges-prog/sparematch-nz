import Link from "next/link";
import parts from "../lib/parts.json";

export default function Home() {
  const brands = [...new Set(parts.map((p) => p.brand))];
  const total = parts.length;
  return (
    <main>
      <section className="hero">
        <div className="container">
          <span className="pill">Built for New Zealand plumbers</span>
          <h1>Find the right tap spare part in seconds.</h1>
          <p>
            Stop guessing at the merchant counter. Snap the tap or the removed cartridge,
            tell us the size, and get the exact part — with the part number and where to buy it.
          </p>
          <div className="actions">
            <Link href="/find" className="btn btn-primary">📷 Snap a photo</Link>
            <Link href="/find" className="btn btn-ghost">Pick your brand</Link>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <div className="container">
          <h2>How it works</h2>
          <p className="lead">No account, no manuals — just a couple of taps.</p>
          <div className="steps">
            <div className="step">
              <div className="n">1</div>
              <h3>Snap or pick your brand</h3>
              <p>Photograph the tap or the removed cartridge, or just pick the brand. No brand name? Choose Universal.</p>
            </div>
            <div className="step">
              <div className="n">2</div>
              <h3>Give us the size</h3>
              <p>Almost every single-lever mixer takes a cartridge, so the size is what matters — measure the diameter (25, 35, 40 or 45mm).</p>
            </div>
            <div className="step">
              <div className="n">3</div>
              <h3>Get the exact part</h3>
              <p>See the part number, a reference photo to confirm the match, any supersession, and a link to buy it.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" style={{ background: "#fff", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        <div className="container">
          <h2>{brands.length} brands, {total}+ genuine parts and growing</h2>
          <p className="lead">Every part number is sourced from a manufacturer or retailer listing — nothing made up.</p>
          <div className="brands">{brands.map((b) => (<span className="brand-chip" key={b}>{b}</span>))}</div>
          <p className="note">Starting with tapware spares. Hot water / califonts, cylinders and fittings are on the roadmap.</p>
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ textAlign: "center" }}>
          <h2>Ready to find a part?</h2>
          <p className="lead" style={{ marginBottom: 20 }}>It takes about ten seconds.</p>
          <Link href="/find" className="btn btn-primary">📷 Snap a photo</Link>
        </div>
      </section>
    </main>
  );
}
