/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Screens fetched ahead of time (see AppNav) stay ready to open instantly
    // for half an hour instead of the default five minutes. The pages are
    // empty shells - their data is loaded separately - so nothing goes stale.
    staleTimes: { static: 1800 },
  },
  async headers() {
    return [
      {
        // The service worker must never be cached, or phones keep running an
        // old one after an update.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Content-Type", value: "application/manifest+json; charset=utf-8" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
