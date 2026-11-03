// Team-key spend. Estimates come from the catalog; a provider-reported cost replaces
// the estimate on the row and in these sums. Member-key generations are excluded.
// This is a limit the app enforces. It is not billing.

import type { KeySource } from "./scope";
import { all, first } from "./db";

export class CapError extends Error {
  name = "CapError";
  status = 403;
  code = "cap";
  constructor(message: string) {
    super(message);
  }
}

export function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function formatUsd(n: number) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export function capMessage(cap: number, spent: number, now = Date.now()) {
  const month = new Date(now).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return `This would pass the $${formatUsd(cap)} cap for ${month}. Month-to-date total is $${formatUsd(spent)}.`;
}

/** True when this submission would go over the cap. A null cap is unset. */
export function overCap(cap: number | null, spent: number, estimate: number) {
  if (cap == null) return false;
  return spent + Math.max(0, estimate) > cap + 1e-9;
}

const AMOUNT = `COALESCE(json_extract(data, '$.reportedCost'), json_extract(data, '$.estimatedCost'), json_extract(data, '$.cost'), 0)`;

const TEAM_KEY = `json_extract(data, '$.keySource') = 'team'`;

function union(where: string) {
  const tables = ["generations", "image_generations", "fal_jobs"];
  return tables
    .map(
      (table) =>
        `SELECT created_by AS user_id, ${AMOUNT} AS usd FROM ${table} WHERE workspace_id = ? AND ${TEAM_KEY} AND ${where}`,
    )
    .join(" UNION ALL ");
}

export async function memberCap(workspaceId: string, userId: string) {
  const row = await first<{ monthly_cap_usd: number | null }>(
    "SELECT monthly_cap_usd FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
    workspaceId,
    userId,
  );
  return row?.monthly_cap_usd ?? null;
}

export async function monthSpend(workspaceId: string, userId: string, now = Date.now()) {
  const sql = `SELECT COALESCE(SUM(usd), 0) AS usd FROM (${union("created_by = ? AND created_at >= ?")})`;
  // Each table in the union binds workspace id, member, then the start of the month.
  const since = monthStart(now);
  const one = [workspaceId, userId, since] as const;
  const row = await first<{ usd: number }>(sql, ...one, ...one, ...one);
  return row?.usd ?? 0;
}

/** Spend per person since `since`, team key only. */
export async function spendByMember(workspaceId: string, since: number) {
  const sql = `SELECT user_id AS userId, COUNT(*) AS generations, COALESCE(SUM(usd), 0) AS usd
    FROM (${union("created_at >= ?")}) GROUP BY user_id`;
  const one = [workspaceId, since] as const;
  return all<{ userId: string | null; generations: number; usd: number }>(sql, ...one, ...one, ...one);
}

/**
 * Rejects a team-key submission that would pass the cap, before `start` (the
 * provider call) runs. Own-key and uncapped submissions always start.
 */
export async function startAfterCap(
  opts: { source: KeySource; cap: number | null; spent: number; estimate: number; now?: number },
  start: () => Promise<void>,
) {
  if (opts.source === "team" && overCap(opts.cap, opts.spent, opts.estimate))
    throw new CapError(capMessage(opts.cap ?? 0, opts.spent, opts.now));
  await start();
}
