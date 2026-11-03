import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Build plain HTML/JS files, so the app can be hosted on GitHub Pages.
  // Everything runs in the browser; there is no server.
  output: "export",
  // GitHub Pages serves the site under /strava-fixer. The deploy workflow
  // sets this; when running locally it's empty, so the app is at /.
  basePath: process.env.PAGES_BASE_PATH ?? "",
  images: { unoptimized: true },
};

export default nextConfig;
