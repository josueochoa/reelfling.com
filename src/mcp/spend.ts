// Quotes and the daily spend cap. A paid tool only runs a request it priced first, so
// Claude always shows the cost before anything starts, and a quote starts one job at most.

import type { ConnectorEnv } from "./app";

/** Per user and connection, over the last 24 hours, in USD. */
export const DAILY_CAP_USD = 20;
export const QUOTE_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type QuoteKind = "video" | "image";

export interface Quote {
  id: string;
  userId: string;
  clientId: string;
  kind: QuoteKind;
  /** The exact body sent to POST /api/generations or /api/images. */
  request: Record<string, unknown>;
  cost: number;
  expiresAt: number;
}

/** Short, so Claude can pass it back without copying a long token. */
const quoteId = () => `q_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export async function saveQuote(env: ConnectorEnv, quote: Omit<Quote, "id">, now = Date.now()): Promise<Quote> {
  const saved = { ...quote, id: quoteId() };
  await env.DB.batch([
    // Old quotes are only kept long enough to explain why they can't be used.
    env.DB.prepare("DELETE FROM connector_quotes WHERE expires_at < ?").bind(now - DAY_MS),
    env.DB.prepare(
      "INSERT INTO connector_quotes (id, user_id, client_id, kind, request, cost, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(saved.id, saved.userId, saved.clientId, saved.kind, JSON.stringify(saved.request), saved.cost, saved.expiresAt),
  ]);
  return saved;
}

/** The quote, or why it can't be used. */
export async function readQuote(
  env: ConnectorEnv,
  id: string,
  who: { userId: string; clientId: string },
  now = Date.now(),
): Promise<Quote | { error: string }> {
  const row = await env.DB.prepare(
    "SELECT id, user_id, client_id, kind, request, cost, expires_at FROM connector_quotes WHERE id = ?",
  )
    .bind(id.trim())
    .first<{ id: string; user_id: string; client_id: string; kind: QuoteKind; request: string; cost: number; expires_at: number }>();
  if (!row) return { error: "There's no quote with that id. Get a quote first." };
  if (row.user_id !== who.userId || row.client_id !== who.clientId)
    return { error: "That quote belongs to another connection. Get a new quote." };
  if (row.expires_at <= now) return { error: "That quote expired. Get a new quote." };
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    kind: row.kind,
    request: JSON.parse(row.request) as Record<string, unknown>,
    cost: row.cost,
    expiresAt: row.expires_at,
  };
}

export async function spentToday(env: ConnectorEnv, userId: string, clientId: string, now = Date.now()) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(cost), 0) AS spent FROM connector_calls WHERE user_id = ? AND client_id = ? AND created_at > ?",
  )
    .bind(userId, clientId, now - DAY_MS)
    .first<{ spent: number }>();
  return row?.spent ?? 0;
}

const USED = "That quote was already used. Get a new quote.";

/**
 * Records the call before the job starts, in one statement: it inserts nothing when the
 * cap would be passed, and the unique quote id refuses a quote that was already used.
 */
export async function claimQuote(env: ConnectorEnv, quote: Quote, now = Date.now()): Promise<{ id: string } | { error: string }> {
  const used = await env.DB.prepare("SELECT 1 AS used FROM connector_calls WHERE quote_id = ?").bind(quote.id).first();
  if (used) return { error: USED };
  const id = crypto.randomUUID();
  try {
    const result = await env.DB.prepare(
      `INSERT INTO connector_calls (id, user_id, client_id, quote_id, kind, cost, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COALESCE(SUM(cost), 0) FROM connector_calls
              WHERE user_id = ? AND client_id = ? AND created_at > ?) + ? <= ?`,
    )
      .bind(id, quote.userId, quote.clientId, quote.id, quote.kind, quote.cost, now, quote.userId, quote.clientId, now - DAY_MS, quote.cost, DAILY_CAP_USD)
      .run();
    if (result.meta.changes) return { id };
  } catch (e) {
    if (/UNIQUE/i.test(String((e as Error).message))) return { error: USED };
    throw e;
  }
  const spent = await spentToday(env, quote.userId, quote.clientId, now);
  return {
    error: `This would pass the $${DAILY_CAP_USD} daily limit for this connection ($${spent.toFixed(2)} spent in the last 24 hours, this costs $${quote.cost.toFixed(2)}).`,
  };
}

export async function recordJob(env: ConnectorEnv, callId: string, jobId: string) {
  await env.DB.prepare("UPDATE connector_calls SET job_id = ? WHERE id = ?").bind(jobId, callId).run();
}

/** The job didn't start, so it doesn't count, and the quote can be tried again. */
export async function releaseClaim(env: ConnectorEnv, callId: string) {
  await env.DB.prepare("DELETE FROM connector_calls WHERE id = ?").bind(callId).run();
}
