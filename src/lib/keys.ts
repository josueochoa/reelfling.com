// Provider API keys (BYOK), per workspace. A personal workspace holds that person's
// keys (user_id set). A team key is a row with workspace_id = the team and user_id NULL.
// Encrypted at rest. Only provider + last4 leave the server.

import type { ProviderId } from "./registry";
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

export function scrubSecret(message: string, secret: string | undefined) {
  if (!secret || !message.includes(secret)) return message;
  return message.split(secret).join("[redacted]");
}

export async function saveKey(
  workspaceId: string,
  provider: ProviderId,
  apiKey: string,
  baseUrl: string | undefined,
  createdBy: string,
  opts: { team?: boolean } = {},
) {
  // Personal rows keep user_id so the (user_id, provider) index still describes them.
  // Team rows leave user_id NULL so they don't occupy the owner's personal slot.
  const userId = opts.team ? null : workspaceId;
  await run(
    `INSERT INTO api_keys (user_id, workspace_id, provider, secret, last4, base_url, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       user_id = excluded.user_id, secret = excluded.secret, last4 = excluded.last4,
       base_url = excluded.base_url, created_at = excluded.created_at, created_by = excluded.created_by`,
    userId,
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

/** What a successful key save returns. The key itself never leaves the server; only last4 does. */
export function savedKeyBody(apiKey: string, detail?: string) {
  const body: { ok: true; last4: string; detail?: string } = { ok: true, last4: apiKey.slice(-4) };
  if (detail) body.detail = detail;
  return body;
}

export async function getCredentials(workspaceId: string, provider: ProviderId): Promise<ProviderCredentials | undefined> {
  const row = await first<{ secret: string; base_url: string | null }>(
    "SELECT secret, base_url FROM api_keys WHERE workspace_id = ? AND provider = ?",
    workspaceId,
    provider,
  );
  if (!row) return undefined;
  return { apiKey: decrypt(row.secret), baseUrl: row.base_url ?? undefined };
}
