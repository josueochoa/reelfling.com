// Development-only stand-in for provider calls. Never used in production, and it
// never echoes the key it was given.

import { env } from "../db";
import type { ProviderCredentials } from "../keys";
import type { StudioProviderId } from "../registry";
import type { VideoProvider } from "./types";

export function mockProviders() {
  if (process.env.NODE_ENV === "production") return false;
  try {
    return env().MOCK_PROVIDERS === "true";
  } catch {
    return process.env.MOCK_PROVIDERS === "true";
  }
}

export function mockVideoProvider(id: StudioProviderId, creds: ProviderCredentials): VideoProvider {
  // The key is accepted so the signature matches a real provider, and then ignored.
  void creds.baseUrl;
  return {
    id,
    label: id,
    async verifyKey() {
      return { detail: "Mock provider" };
    },
    async createTask() {
      return { taskId: `mock-${crypto.randomUUID()}` };
    },
    async getTask() {
      return { status: "queued" };
    },
    async deleteTask() {},
    async fetchVideo() {
      return new Response(null, { status: 404 });
    },
  };
}
