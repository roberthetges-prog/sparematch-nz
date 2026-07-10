import "./globals.css";
import Link from "next/link";
import { Analytics } from "@vercel/analytics/react";

const DESC =
  "Identify the exact spare part for your tap, mixer, valve or cartridge. Photograph it or answer a couple of quick questions and get the correct part — with the part number and where to buy it. Built for plumbers across New Zealand and Australia.";

export const metadata = {
  metadataBase: new URL("https://tapsnap.vercel.app"),
  applicationName: "TapSnap",
  title: "TapSnap — Find the right tap spare part fast",
  description: DESC,
  manifest: "/manifest.json",
  appleWebApp: { capable: true, title: "TapSnap", statusBarStyle: "default" },
  formatDetection: { telephone: false },
  icons: { icon: "/icon-192.png", shortcut: "/icon-192.png", apple: "/apple-touch-icon.png" },
  openGraph: {
    type: "website",
    url: "https://tapsnap.vercel.app",
    siteName: "TapSnap",
    title: "TapSnap — Snap a tap, get the exact spare part",
    description: DESC,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "TapSnap — snap a tap, valve or cartridge and get the exact spare part" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "TapSnap — Snap a tap, get the exact spare part",
    description: DESC,
    images: ["/og.png"],
  },
};

export const viewport = {
  themeColor: "#1f3a5f",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en-NZ">
      <body>
        <header className="site-header">
          <div className="container">
            <Link href="/" className="brand-logo">
              <span className="brand-mark">🔧</span> <span>Tap<span style={{ color: "#e8722c" }}>Snap</span></span>
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
            TapSnap — spare-part finder for New Zealand and Australian tapware. Part data is sourced from
            manufacturer and retailer listings; always confirm the part before fitting. © {new Date().getFullYear()}.
            <span className="footlinks">
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <a href="mailto:myhappyplace@web.de?subject=TapSnap%20feedback">Feedback</a>
            </span>
          </div>
        </footer>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}",
          }}
        />
        <Analytics />
      </body>
    </html>
  );
}
