// One name per release, built into the pages and the app, so an open app can
// tell that a newer release is out (public/sw.js, components/pwa/RegisterSW).
// It must be the same every time this file is read during one build (it is
// read several times), so it is the commit being built - never a clock.
// Without one, the check is simply off.
function commit() {
  const fromHost = process.env.VERCEL_GIT_COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || process.env.SOURCE_COMMIT;
  if (fromHost) return fromHost;
  try {
    return require("child_process").execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}
const RELEASE = commit();

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: { NEXT_PUBLIC_RELEASE: RELEASE },
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
