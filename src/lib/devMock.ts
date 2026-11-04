// Development stand-in for provider calls. Production never takes this branch:
// NODE_ENV is "production" on the Worker, and the flag is not a wrangler var.

import { env } from "./db";

/** True only while `next dev` is running. Production builds inline NODE_ENV and drop this. */
export function isNextDev(): boolean {
  return process.env.NODE_ENV === "development";
}

/** True only in `next dev` when DEV_MOCK_PROVIDERS=1. The key is not sent. */
export function devMockProviders(): boolean {
  if (!isNextDev()) return false;
  if (process.env.DEV_MOCK_PROVIDERS === "1") return true;
  try {
    return env().DEV_MOCK_PROVIDERS === "1";
  } catch {
    return false;
  }
}

/** A task id minted by the dev stand-in. Polling it must not call a provider. */
export function isDevMockTask(taskId: string): boolean {
  return devMockProviders() && taskId.startsWith("devmock-");
}
