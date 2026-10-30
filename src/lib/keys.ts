// Per-user provider API keys (BYOK), encrypted at rest.

import type { ProviderId } from "./models";
import { decrypt, encrypt } from "./crypto";
import { all, first, run } from "./db";

export interface KeySummary {
  provider: ProviderId;
  last4: string;
  baseUrl: string | null;
  createdAt: number;
}

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string;
}

export async function saveKey(userId: string, provider: ProviderId, apiKey: string, baseUrl?: string) {
  await run(
    `INSERT INTO api_keys (user_id, provider, secret, last4, base_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       secret = excluded.secret, last4 = excluded.last4, base_url = excluded.base_url, created_at = excluded.created_at`,
    userId,
    provider,
    encrypt(apiKey),
    apiKey.slice(-4),
    baseUrl ?? null,
    Date.now(),
  );
}

export async function deleteKey(userId: string, provider: ProviderId) {
  await run("DELETE FROM api_keys WHERE user_id = ? AND provider = ?", userId, provider);
}

export async function listKeys(userId: string): Promise<KeySummary[]> {
  const rows = await all<{ provider: ProviderId; last4: string; base_url: string | null; created_at: number }>(
    "SELECT provider, last4, base_url, created_at FROM api_keys WHERE user_id = ?",
    userId,
  );
  return rows.map((r) => ({ provider: r.provider, last4: r.last4, baseUrl: r.base_url, createdAt: r.created_at }));
}

export async function getCredentials(userId: string, provider: ProviderId): Promise<ProviderCredentials | undefined> {
  const row = await first<{ secret: string; base_url: string | null }>(
    "SELECT secret, base_url FROM api_keys WHERE user_id = ? AND provider = ?",
    userId,
    provider,
  );
  if (!row) return undefined;
  return { apiKey: decrypt(row.secret), baseUrl: row.base_url ?? undefined };
}
