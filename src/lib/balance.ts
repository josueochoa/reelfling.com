// What a provider says is left to spend with the user's own key. Display only: the
// provider is the one that bills, and this is its own number at the time it was read.

import type { ProviderId } from "./registry/types";

export interface ProviderBalance {
  provider: ProviderId;
  /** What is left, when the provider reports it. */
  amount?: number;
  /** ISO currency code. USD when the provider doesn't say. */
  currency?: string;
  /**
   * `account`: the account's balance. `key`: what is left of this key's spending limit,
   * which can be lower than the account's balance.
   */
  scope?: "account" | "key";
  /** Why there is no amount, in a few words. */
  note?: string;
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** ArgoLink `GET /v1/account/balance`: `{ available, currency }`. */
export function argoLinkBalance(body: { available?: unknown; currency?: unknown }): ProviderBalance {
  const amount = finite(body.available);
  if (amount === undefined) return { provider: "argolink", note: "ArgoLink didn't report a balance" };
  return {
    provider: "argolink",
    amount,
    currency: typeof body.currency === "string" && body.currency ? body.currency.toUpperCase() : "USD",
    scope: "account",
  };
}

/**
 * OpenRouter. `GET /key` gives what is left of the key's own limit, or null when the key
 * has none. `GET /credits` gives the account's totals, but only to a management key, so
 * `credits` is undefined for an ordinary one.
 */
export function openRouterBalance(
  key: { limit_remaining?: unknown } | undefined,
  credits: { total_credits?: unknown; total_usage?: unknown } | undefined,
): ProviderBalance {
  const left = finite(key?.limit_remaining);
  if (left !== undefined) return { provider: "openrouter", amount: left, currency: "USD", scope: "key" };
  const total = finite(credits?.total_credits);
  const used = finite(credits?.total_usage);
  if (total !== undefined && used !== undefined)
    return { provider: "openrouter", amount: total - used, currency: "USD", scope: "account" };
  return {
    provider: "openrouter",
    note: "This key has no spending limit, and OpenRouter only gives the account balance to a management key",
  };
}

/** fal `GET /v1/account/billing?expand=credits`: `{ credits: { current_balance, currency } }`. */
export function falBalance(body: { credits?: { current_balance?: unknown; currency?: unknown } }): ProviderBalance {
  const amount = finite(body.credits?.current_balance);
  if (amount === undefined) return { provider: "fal", note: "fal didn't report a balance for this key" };
  const currency = body.credits?.currency;
  return {
    provider: "fal",
    amount,
    currency: typeof currency === "string" && currency ? currency.toUpperCase() : "USD",
    scope: "account",
  };
}

/** "$12.34", or "12.34 EUR" for another currency. Negative balances keep their sign. */
export function formatBalance(balance: Pick<ProviderBalance, "amount" | "currency">): string | undefined {
  if (balance.amount === undefined) return undefined;
  const value = Math.abs(balance.amount).toFixed(2);
  const sign = balance.amount < 0 ? "-" : "";
  return !balance.currency || balance.currency === "USD" ? `${sign}$${value}` : `${sign}${value} ${balance.currency}`;
}

/** Below this, the header shows the balance as running low. */
export const LOW_BALANCE = 2;
