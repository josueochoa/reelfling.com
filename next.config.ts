import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No cacheComponents/partialPrefetching: Next can't guarantee them on the Workers runtime
  // (requests hang), and the app has nothing to cache: client-rendered pages, dynamic APIs.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

// Gives `next dev` the Worker's bindings (D1) and vars, via getCloudflareContext().
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
