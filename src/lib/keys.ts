// Provider API keys (BYOK), per workspace: a user's own, or a team's shared keys. Encrypted at rest.

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

export async function saveKey(
  workspaceId: string,
  provider: ProviderId,
  apiKey: string,
  baseUrl: string | undefined,
  createdBy: string,
) {
  await run(
    `INSERT INTO api_keys (workspace_id, provider, secret, last4, base_url, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       secret = excluded.secret, last4 = excluded.last4, base_url = excluded.base_url,
       created_at = excluded.created_at, created_by = excluded.created_by`,
    workspaceId,
    provider,
    encrypt(apiKey),
    apiKey.slice(-4),
    baseUrl ?? null,
    Date.now(),
    createdBy,
  );
}

export async function deleteKey(workspaceId: string, provider: ProviderId) {
  await run("DELETE FROM api_keys WHERE workspace_id = ? AND provider = ?", workspaceId, provider);
}

export async function listKeys(workspaceId: string): Promise<KeySummary[]> {
  const rows = await all<{ provider: ProviderId; last4: string; base_url: string | null; created_at: number }>(
    "SELECT provider, last4, base_url, created_at FROM api_keys WHERE workspace_id = ?",
    workspaceId,
  );
  return rows.map((r) => ({ provider: r.provider, last4: r.last4, baseUrl: r.base_url, createdAt: r.created_at }));
}

export async function getCredentials(
  workspaceId: string,
  provider: ProviderId,
): Promise<ProviderCredentials | undefined> {
  const row = await first<{ secret: string; base_url: string | null }>(
    "SELECT secret, base_url FROM api_keys WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    provider,
  );
  if (!row) return undefined;
  return { apiKey: decrypt(row.secret), baseUrl: row.base_url ?? undefined };
}
