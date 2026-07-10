export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: "https://tapsnap.vercel.app/sitemap.xml",
  };
}
