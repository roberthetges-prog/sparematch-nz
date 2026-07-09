import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "SpareMatch NZ — Find the right tap spare part fast",
  description:
    "Identify the exact spare part for your tap or mixer. Answer a couple of quick questions and get the correct cartridge, spindle, washer or aerator — with the part number and where to buy it. Built for New Zealand plumbers.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en-NZ">
      <body>
        <header className="site-header">
          <div className="container">
            <Link href="/" className="brand-logo">
              <span className="brand-mark">🔧</span> SpareMatch<span style={{ color: "#e8722c" }}>NZ</span>
            </Link>
            <nav className="nav">
              <Link href="/">Home</Link>
              <Link href="/find">Find a part</Link>
            </nav>
          </div>
        </header>
        {children}
        <footer>
          <div className="container">
            SpareMatch NZ — spare-part finder for New Zealand tapware. Part data is sourced from
            manufacturer and retailer listings; always confirm the part before fitting. © {new Date().getFullYear()}.
          </div>
        </footer>
      </body>
    </html>
  );
}
