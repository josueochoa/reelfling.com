// Per-user, per-model route. Absent row: generations still prefer users.active_provider.

import { all, first, run } from "./db";
import { ROUTE_PROVIDERS, type RouteProvider } from "./registry";

export function isRouteProvider(id: string): id is RouteProvider {
  return (ROUTE_PROVIDERS as readonly string[]).includes(id);
}

export async function listRoutePreferences(userId: string): Promise<Record<string, string>> {
  const rows = await all<{ model_id: string; provider: string }>(
    "SELECT model_id, provider FROM route_preferences WHERE user_id = ?",
    userId,
  );
  const out: Record<string, string> = {};
  for (const row of rows) if (isRouteProvider(row.provider)) out[row.model_id] = row.provider;
  return out;
}

export async function getRoutePreference(userId: string, modelId: string): Promise<RouteProvider | null> {
  const row = await first<{ provider: string }>(
    "SELECT provider FROM route_preferences WHERE user_id = ? AND model_id = ?",
    userId,
    modelId,
  );
  return row && isRouteProvider(row.provider) ? row.provider : null;
}

export async function setRoutePreference(userId: string, modelId: string, provider: RouteProvider) {
  await run(
    `INSERT INTO route_preferences (user_id, model_id, provider) VALUES (?, ?, ?)
     ON CONFLICT (user_id, model_id) DO UPDATE SET provider = excluded.provider`,
    userId,
    modelId,
    provider,
  );
}
