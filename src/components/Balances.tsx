"use client";

// What each provider says is left on the user's own key, in the top bar and the account
// menu. Read again every 30 s while the page is visible, when the window regains focus,
// and a moment after anything that can spend (a generation, an image, a tool job) or
// change a key.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBalance, LOW_BALANCE, type ProviderBalance } from "@/lib/balance";
import { PROVIDER_INFO } from "@/lib/registry";
import { apiJson, BALANCE_EVENT } from "./api";

const REFRESH_MS = 30_000;
// Providers settle a charge a little after the request returns.
const AFTER_SPEND_MS = 2_000;

export interface BalancesState {
  balances: ProviderBalance[];
  /** When the balances were read, or undefined before the first answer. */
  at?: number;
  refresh: () => void;
}

/** Balances for the signed-in user. `enabled` is false until they have a key saved. */
export function useBalances(enabled: boolean): BalancesState {
  const [state, setState] = useState<{ balances: ProviderBalance[]; at?: number }>({ balances: [] });
  const busy = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled || busy.current) return;
    busy.current = true;
    apiJson<{ balances: ProviderBalance[]; at: number }>("/api/balances")
      .then((body) => setState({ balances: body.balances ?? [], at: body.at }))
      // Keep the last numbers: a failed read shouldn't blank the bar.
      .catch(() => {})
      .finally(() => {
        busy.current = false;
      });
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    refresh();
    const visible = () => document.visibilityState === "visible";
    const timer = window.setInterval(() => visible() && refresh(), REFRESH_MS);
    let pending: number | undefined;
    const soon = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(refresh, AFTER_SPEND_MS);
    };
    const onVisible = () => visible() && refresh();
    window.addEventListener(BALANCE_EVENT, soon);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(pending);
      window.removeEventListener(BALANCE_EVENT, soon);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  return { balances: enabled ? state.balances : [], at: enabled ? state.at : undefined, refresh };
}

const labelOf = (balance: ProviderBalance) => PROVIDER_INFO[balance.provider]?.label ?? balance.provider;

function detailOf(balance: ProviderBalance): string {
  if (balance.amount === undefined) return balance.note ?? "No balance reported";
  return balance.scope === "key" ? "Left on this key's spending limit" : "Account balance";
}

/** Top bar: one chip per provider that reports an amount. Click to read them again. */
export function BalanceBar({ state }: { state: BalancesState }) {
  const shown = state.balances.filter((balance) => balance.amount !== undefined);
  if (!shown.length) return null;
  return (
    <button
      onClick={state.refresh}
      data-testid="balances"
      title="Balances reported by your providers. Click to refresh."
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1 text-xs tabular-nums text-zinc-300 hover:border-white/20 hover:text-white"
    >
      {shown.map((balance, i) => {
        const low = balance.amount! < LOW_BALANCE;
        return (
          <span key={balance.provider} className="flex items-center gap-1.5" title={`${labelOf(balance)}: ${detailOf(balance)}`}>
            {i > 0 && <span className="text-zinc-700">·</span>}
            <span className="hidden text-zinc-500 md:inline">{labelOf(balance)}</span>
            <span className="text-zinc-500 md:hidden">{labelOf(balance).charAt(0)}</span>
            <span className={low ? "text-red-300" : undefined}>{formatBalance(balance)}</span>
          </span>
        );
      })}
    </button>
  );
}

/** Account menu: every provider with a key, including the ones that report nothing. */
export function BalanceList({ state }: { state: BalancesState }) {
  if (!state.balances.length) return null;
  return (
    <div className="px-2.5 py-2 text-xs" data-testid="balance-list">
      <p className="text-zinc-400">Balances</p>
      <ul className="mt-1.5 space-y-1.5">
        {state.balances.map((balance) => (
          <li key={balance.provider}>
            <div className="flex justify-between gap-3">
              <span className="text-zinc-300">{labelOf(balance)}</span>
              <span
                className={`tabular-nums ${
                  balance.amount === undefined ? "text-zinc-600" : balance.amount < LOW_BALANCE ? "text-red-300" : "text-zinc-200"
                }`}
              >
                {formatBalance(balance) ?? "—"}
              </span>
            </div>
            <p className="text-zinc-600">{detailOf(balance)}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
