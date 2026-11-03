"use client";

// Plans UI: the storage meter, and the Plan & billing dialog (subscribe through Stripe
// Checkout; change plan, card or cancel in Stripe's Customer Portal).

import { useEffect, useState } from "react";
import type { Billing, PlanPrice } from "@/lib/billing";
import { PLANS, type PaidPlanId, type PlanId } from "@/lib/plans";
import { apiJson, type Me } from "./api";
import { formatBytes } from "./UserMenu";

export function StorageMeter({ label, used, total }: { label: string; used: number; total: number }) {
  const full = used >= total;
  return (
    <div className="text-xs">
      <div className="flex justify-between gap-2 text-zinc-400">
        <span>{label}</span>
        <span className={`tabular-nums ${full ? "text-red-300" : "text-zinc-200"}`}>
          {formatBytes(used)} of {formatBytes(total)}
        </span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${full ? "bg-red-400" : "bg-accent"}`}
          style={{ width: `${Math.min(100, total ? (used / total) * 100 : 100)}%` }}
        />
      </div>
    </div>
  );
}

const formatPrice = (p: PlanPrice) =>
  `${new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: p.currency.toUpperCase(),
    minimumFractionDigits: p.amount % 100 ? 2 : 0,
  }).format(p.amount / 100)} / ${p.interval}`;

const formatDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });

const LIVE = ["active", "trialing", "past_due"];

export function PlanDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const [data, setData] = useState<{
    billing: Billing;
    prices: Partial<Record<PaidPlanId, PlanPrice>>;
    enabled: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiJson<NonNullable<typeof data>>("/api/billing")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const billing = data?.billing ?? me.billing;
  const subscribed = LIVE.includes(billing.status ?? "") && !billing.comped;

  /** Leaves for Stripe (Checkout or the portal). */
  async function go(action: string, path: string, body?: object) {
    setBusy(action);
    setError(null);
    try {
      const { url } = await apiJson<{ url: string }>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  const portal = () => go("portal", "/api/billing/portal");

  function action(plan: PlanId): { label: string; run?: () => void } {
    if (plan === billing.plan) return { label: "Current plan" };
    if (billing.comped) return { label: "—" };
    if (!data?.enabled) return { label: "Coming soon" };
    // Switching or cancelling an existing subscription happens in Stripe's portal.
    if (subscribed) return { label: plan === "free" ? "Downgrade" : "Switch", run: portal };
    if (plan === "free") return { label: "—" };
    if (!data.prices[plan]) return { label: "Coming soon" };
    return { label: "Upgrade", run: () => go(plan, "/api/billing/checkout", { plan }) };
  }

  const status = billing.comped
    ? `Your ${PLANS[billing.plan].label} plan was set up for you by ReelFling.`
    : billing.status === "past_due"
      ? "Your last payment failed. Update your card under Manage billing to keep your plan."
      : subscribed && billing.renewsAt
        ? billing.cancelAtPeriodEnd
          ? `Cancelled: you're on ${PLANS[billing.plan].label} until ${formatDate(billing.renewsAt)}, then Free.`
          : `Renews on ${formatDate(billing.renewsAt)}.`
        : null;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Plan and billing"
        className="m-auto max-h-[90dvh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-white/10 bg-panel p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Plan & billing</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Your storage covers every file you make, in your Personal workspace and in any team. In a team, each
              member brings their own storage.
            </p>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-white" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="mt-5 rounded-xl bg-white/[0.03] p-4">
          <StorageMeter
            label={`Your storage · ${PLANS[billing.plan].label}`}
            used={me.storage.bytes}
            total={me.storage.quotaBytes}
          />
          {status && (
            <p className={`mt-3 text-xs ${billing.status === "past_due" ? "text-red-300" : "text-zinc-400"}`}>
              {status}
            </p>
          )}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {Object.values(PLANS).map((plan) => {
            const current = plan.id === billing.plan;
            const price = plan.id === "free" ? "$0" : data?.prices[plan.id] && formatPrice(data.prices[plan.id]!);
            const { label, run } = action(plan.id);
            return (
              <div
                key={plan.id}
                className={`flex flex-col rounded-xl border p-4 ${current ? "border-accent/60 bg-accent/5" : "border-white/10"}`}
              >
                <p className="font-semibold">{plan.label}</p>
                <p className="mt-1 h-5 text-sm text-zinc-300 tabular-nums">{price ?? (data ? "—" : "")}</p>
                <ul className="mt-3 flex-1 space-y-1.5 text-sm text-zinc-400">
                  <li>{plan.storageGb} GB storage</li>
                  <li>{plan.teams ? "Create teams" : "Join teams"}</li>
                </ul>
                <button
                  disabled={!run || !!busy}
                  onClick={run}
                  className={`mt-4 rounded-lg py-2 text-sm font-semibold transition disabled:cursor-default ${
                    !run
                      ? "bg-white/5 text-zinc-500"
                      : plan.id === "free"
                        ? "bg-white/10 text-zinc-200 hover:bg-white/15 disabled:opacity-50"
                        : "bg-accent text-ink hover:brightness-110 disabled:opacity-50"
                  }`}
                >
                  {busy === plan.id ? "Opening…" : label}
                </button>
              </div>
            );
          })}
        </div>

        {error && <p className="mt-4 text-sm text-red-300">{error}</p>}

        {billing.hasCustomer && data?.enabled && (
          <div className="mt-5 flex items-center justify-between gap-4 border-t border-white/5 pt-4 text-sm">
            <span className="text-zinc-500">Change plan, update your card, download invoices or cancel.</span>
            <button
              onClick={portal}
              disabled={!!busy}
              className="shrink-0 rounded-lg bg-white/10 px-3 py-2 hover:bg-white/15 disabled:opacity-50"
            >
              {busy === "portal" ? "Opening…" : "Manage billing"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
