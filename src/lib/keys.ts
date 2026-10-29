// Per-user provider API keys (BYOK), encrypted at rest.

import type { ProviderId } from "./models";
import { decrypt, encrypt } from "./crypto";
import { db } from "./db";

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

export function saveKey(userId: string, provider: ProviderId, apiKey: string, baseUrl?: string) {
  db.prepare(
    `INSERT INTO api_keys (user_id, provider, secret, last4, base_url, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       secret = excluded.secret, last4 = excluded.last4, base_url = excluded.base_url, created_at = excluded.created_at`,
  ).run(userId, provider, encrypt(apiKey), apiKey.slice(-4), baseUrl ?? null, Date.now());
}

export function deleteKey(userId: string, provider: ProviderId) {
  db.prepare("DELETE FROM api_keys WHERE user_id = ? AND provider = ?").run(userId, provider);
}

export function listKeys(userId: string): KeySummary[] {
  const rows = db
    .prepare("SELECT provider, last4, base_url, created_at FROM api_keys WHERE user_id = ?")
    .all(userId) as { provider: ProviderId; last4: string; base_url: string | null; created_at: number }[];
  return rows.map((r) => ({ provider: r.provider, last4: r.last4, baseUrl: r.base_url, createdAt: r.created_at }));
}

export function getCredentials(userId: string, provider: ProviderId): ProviderCredentials | undefined {
  const row = db
    .prepare("SELECT secret, base_url FROM api_keys WHERE user_id = ? AND provider = ?")
    .get(userId, provider) as { secret: string; base_url: string | null } | undefined;
  if (!row) return undefined;
  return { apiKey: decrypt(row.secret), baseUrl: row.base_url ?? undefined };
}
