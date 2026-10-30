import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// No incremental cache: the app has no ISR or cached data, only static shells and API routes.
export default defineCloudflareConfig({});
