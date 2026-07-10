import Link from "next/link";
import parts from "../lib/parts.json";

function AppleBadge() {
  return (
    <span className="badge2">
      <svg viewBox="0 0 384 512" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d="M318.7 268c-.5-58 47.4-85.8 49.5-87.2-27-39.5-69-45-83.9-45.6-35.7-3.6-69.7 21-87.8 21-18 0-46-20.5-75.6-20-38.9.6-74.8 22.6-94.8 57.4-40.4 70.1-10.3 173.8 29 230.7 19.2 27.8 42.1 59 72.1 57.9 28.9-1.2 39.8-18.7 74.8-18.7 34.7 0 44.7 18.7 75.2 18.1 31-.5 50.7-28.3 69.7-56.2 21.9-32 30.9-63 31.4-64.6-.7-.3-60.3-23.1-60.8-91.8zM255.9 82.6c15.9-19.3 26.7-46.1 23.8-72.6-22.9.9-50.6 15.3-67.1 34.5-14.7 17-27.6 44.3-24.2 70.3 25.6 2 51.7-13 67.5-32.2z" />
      </svg>
      <span className="badge2txt"><small>Download on the</small><b>App Store</b></span>
    </span>
  );
}

function GoogleBadge() {
  return (
    <span className="badge2">
      <svg viewBox="0 0 512 512" width="20" height="20" aria-hidden="true">
        <defs>
          <linearGradient id="pg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#00d3ff" />
            <stop offset="0.4" stopColor="#00e676" />
            <stop offset="0.7" stopColor="#ffd600" />
            <stop offset="1" stopColor="#ff3d00" />
          </linearGradient>
        </defs>
        <path d="M48 24c-6 3-10 9-10 17v430c0 8 4 14 10 17l246-232L48 24z" fill="url(#pg)" />
        <path d="M294 256l70-66-286-165c-5-3-11-3-16-1l232 232z" fill="#00d3ff" />
        <path d="M294 256L62 488c5 2 11 2 16-1l286-165-70-66z" fill="#ff3d00" />
        <path d="M446 222l-82-47-70 81 70 66 82-47c16-9 16-44 0-53z" fill="#ffd600" />
      </svg>
      <span className="badge2txt"><small>Get it on</small><b>Google Play</b></span>
    </span>
  );
}

function PhoneMock() {
  return (
    <svg className="phone" viewBox="0 0 300 600" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="TapSnap app preview">
      <rect x="8" y="8" width="284" height="584" rx="44" fill="#0f1f33" />
      <rect x="20" y="20" width="260" height="560" rx="32" fill="#f6f8fb" />
      <rect x="112" y="30" width="76" height="16" rx="8" fill="#0f1f33" />
      {/* app header */}
      <rect x="20" y="56" width="260" height="52" fill="#1f3a5f" />
      <rect x="42" y="70" width="24" height="24" rx="6" fill="#e8722c" />
      <path d="M54 74 l6 14 a7 7 0 1 1 -12 0 z" fill="#fff" />
      <text x="76" y="87" fontFamily="Arial, sans-serif" fontSize="15" fontWeight="800" fill="#ffffff">Tap<tspan fill="#e8722c">Snap</tspan></text>
      {/* hero card */}
      <text x="42" y="150" fontFamily="Arial, sans-serif" fontSize="17" fontWeight="800" fill="#1c2530">Find the right</text>
      <text x="42" y="172" fontFamily="Arial, sans-serif" fontSize="17" fontWeight="800" fill="#1c2530">tap part fast</text>
      <rect x="42" y="192" width="216" height="46" rx="10" fill="#e8722c" />
      <text x="150" y="221" fontFamily="Arial, sans-serif" fontSize="14" fontWeight="800" fill="#ffffff" textAnchor="middle">📷  Snap a photo</text>
      {/* result card */}
      <rect x="42" y="262" width="216" height="286" rx="14" fill="#ffffff" stroke="#e2e8f0" />
      <rect x="42" y="262" width="216" height="150" rx="14" fill="#eef2f7" />
      <rect x="120" y="292" width="60" height="90" rx="6" fill="#cdd7e3" />
      <circle cx="150" cy="315" r="15" fill="#aeb9c7" />
      <rect x="60" y="428" width="120" height="12" rx="6" fill="#1c2530" />
      <rect x="60" y="450" width="170" height="9" rx="4" fill="#8b97a6" />
      <rect x="60" y="470" width="96" height="22" rx="6" fill="#e7f4ec" />
      <text x="108" y="486" fontFamily="Arial, sans-serif" fontSize="11" fontWeight="800" fill="#2f8a4e" textAnchor="middle">Part #CC35</text>
      <rect x="60" y="504" width="180" height="30" rx="8" fill="#1f3a5f" />
      <text x="150" y="524" fontFamily="Arial, sans-serif" fontSize="12" fontWeight="700" fill="#ffffff" textAnchor="middle">Where to buy →</text>
    </svg>
  );
}

export default function Home() {
  const brands = [...new Set(parts.map((p) => p.brand))];
  const total = parts.length;
  return (
    <main>
      <section className="hero apphero">
        <div className="container heroGrid">
          <div className="heroCopy">
            <span className="pill">Built for NZ &amp; Australian plumbers</span>
            <h1>Snap a tap. Get the exact spare part.</h1>
            <p>
              Stop guessing at the merchant counter. Photograph the tap or the removed cartridge,
              tell us the size, and get the exact part — with the part number and where to buy it.
            </p>
            <div className="storebadges">
              <Link href="/find" className="storebadge" aria-label="App Store — coming soon">
                <AppleBadge />
                <span className="soon">Coming soon</span>
              </Link>
              <Link href="/find" className="storebadge" aria-label="Google Play — coming soon">
                <GoogleBadge />
                <span className="soon">Coming soon</span>
              </Link>
            </div>
            <div className="actions">
              <Link href="/find" className="btn btn-primary">📷 Use it now — free in your browser</Link>
            </div>
            <p className="installhint">On your phone? Open TapSnap and tap <b>Add to Home Screen</b> to install it like an app — no store needed.</p>
          </div>
          <div className="heromock">
            <PhoneMock />
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
