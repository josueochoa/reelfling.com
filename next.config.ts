import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No cacheComponents/partialPrefetching: Next can't guarantee them on the Workers runtime
  // (requests hang), and the app has nothing to cache: client-rendered pages, dynamic APIs.
  async rewrites() {
    // `/_ui` is the dev gallery. A folder named `_ui` would be a private folder, so the page
    // lives at `/dev/ui` and this rewrite is the public path. Production builds omit it.
    if (process.env.NODE_ENV !== "development") return [];
    return [{ source: "/_ui", destination: "/dev/ui" }];
  },
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
