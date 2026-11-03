// Billing with Stripe: Checkout to subscribe, the Customer Portal to change plan, card or
// cancel, and a webhook that keeps users.plan in step. Stripe is the source of truth: every
// event re-fetches the subscription, so out-of-order or repeated events are harmless.
// Plain fetch (no SDK) keeps the Worker small.

import { env, first, run } from "./db";
import { PAID_PLANS, planOf, type PaidPlanId, type PlanId } from "./plans";

const DEFAULT_API_BASE = "https://api.stripe.com/v1";

/** Statuses that keep the paid plan. past_due: Stripe is still retrying the card. */
const LIVE = new Set(["active", "trialing", "past_due"]);

export class BillingError extends Error {
  constructor(
    message: string,
    public status = 502,
    public code?: string,
  ) {
    super(message);
  }
}

/** Thrown when something needs a paid plan (e.g. creating a team). */
export class PlanRequiredError extends BillingError {
  constructor(message: string) {
    super(message, 402, "upgrade");
  }
}

// ---------------------------------------------------------------- the user's plan

export interface Billing {
  plan: PlanId;
  /** Stripe's subscription status, if they ever subscribed. */
  status: string | null;
  /** End of the paid period (renewal, or when a cancellation takes effect). */
  renewsAt: number | null;
  cancelAtPeriodEnd: boolean;
  /** On a plan set by hand, not paid through Stripe. */
  comped: boolean;
  /** Has a Stripe customer, so the portal (invoices, card) is available. */
  hasCustomer: boolean;
}

interface BillingRow {
  plan: string;
  plan_override: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  renews_at: number | null;
  cancel_at_period_end: number;
}

const billingRow = (userId: string) =>
  first<BillingRow>(
    `SELECT plan, plan_override, stripe_customer_id, stripe_subscription_id, subscription_status, renews_at,
            cancel_at_period_end FROM users WHERE id = ?`,
    userId,
  );

export async function getBilling(userId: string): Promise<Billing> {
  const row = await billingRow(userId);
  return {
    plan: planOf(row?.plan_override ?? row?.plan).id,
    status: row?.subscription_status ?? null,
    renewsAt: row?.renews_at ?? null,
    cancelAtPeriodEnd: !!row?.cancel_at_period_end,
    comped: !!row?.plan_override,
    hasCustomer: !!row?.stripe_customer_id,
  };
}

/** SQL for a user's effective plan id, given the users table aliased as `alias`. */
export const effectivePlanSql = (alias: string) => `COALESCE(${alias}.plan_override, ${alias}.plan)`;

// ---------------------------------------------------------------- Stripe API

/** Stripe's form encoding: { a: { b: [1] } } → a[b][0]=1. */
function encode(params: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === "object") return encode(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}

async function stripe<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<T> {
  const { STRIPE_SECRET_KEY, STRIPE_API_BASE } = env();
  if (!STRIPE_SECRET_KEY) throw new BillingError("Billing isn't set up yet.", 503, "billing_off");
  const query = encode(params).join("&");
  const res = await fetch(
    `${STRIPE_API_BASE || DEFAULT_API_BASE}${path}${method === "GET" && query ? `?${query}` : ""}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        ...(method === "POST" && { "Content-Type": "application/x-www-form-urlencoded" }),
        ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }),
      },
      body: method === "POST" ? query : undefined,
    },
  );
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!res.ok) {
    console.error(`Stripe ${method} ${path} → ${res.status}`, body.error?.message);
    throw new BillingError(body.error?.message || `Stripe request failed (${res.status})`);
  }
  return body as T;
}

/** The Stripe price of each paid plan, from STRIPE_PRICE_PLUS / STRIPE_PRICE_PRO. */
function priceIds(): Partial<Record<PaidPlanId, string>> {
  const e = env();
  return { plus: e.STRIPE_PRICE_PLUS || undefined, pro: e.STRIPE_PRICE_PRO || undefined };
}

const planForPrice = (priceId: string | undefined) => PAID_PLANS.find((p) => priceId && priceIds()[p] === priceId);

export interface PlanPrice {
  amount: number;
  currency: string;
  interval: string;
}

let priceCache: { at: number; prices: Partial<Record<PaidPlanId, PlanPrice>> } | undefined;

/** What each paid plan costs, as set in Stripe. Cached for 10 minutes per isolate. */
export async function planPrices(): Promise<Partial<Record<PaidPlanId, PlanPrice>>> {
  if (!env().STRIPE_SECRET_KEY) return {};
  if (priceCache && Date.now() - priceCache.at < 10 * 60 * 1000) return priceCache.prices;
  const entries = await Promise.all(
    Object.entries(priceIds()).map(async ([plan, id]) => {
      const p = await stripe<{ unit_amount: number; currency: string; recurring?: { interval: string } }>(
        "GET",
        `/prices/${encodeURIComponent(id)}`,
      ).catch(() => undefined);
      return p
        ? [[plan, { amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval ?? "month" }]]
        : [];
    }),
  );
  const prices = Object.fromEntries(entries.flat());
  priceCache = { at: Date.now(), prices };
  return prices;
}

// ---------------------------------------------------------------- checkout & portal

interface Subscription {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  /** Before API version 2025-03-31; later versions have it per item. */
  current_period_end?: number;
  metadata?: Record<string, string>;
  items: { data: { price: { id: string }; current_period_end?: number }[] };
}

/** The user's Stripe customer, created on first use. */
async function ensureCustomer(user: { id: string; email: string; name: string | null }) {
  const row = await billingRow(user.id);
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  // The idempotency key makes a double click create one customer, not two.
  const customer = await stripe<{ id: string }>(
    "POST",
    "/customers",
    { email: user.email, name: user.name ?? undefined, metadata: { user_id: user.id } },
    `customer-${user.id}`,
  );
  await run(
    "UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL",
    customer.id,
    user.id,
  );
  return (await billingRow(user.id))!.stripe_customer_id!;
}

/** A Stripe Checkout page for subscribing to a paid plan. */
export async function createCheckout(
  user: { id: string; email: string; name: string | null },
  plan: PaidPlanId,
  origin: string,
) {
  const price = priceIds()[plan];
  if (!price) throw new BillingError(`The ${planOf(plan).label} plan isn't for sale yet.`, 400);
  const row = await billingRow(user.id);
  // Changing plan goes through the portal, so nobody ends up with two subscriptions.
  if (row?.stripe_subscription_id && LIVE.has(row.subscription_status ?? ""))
    throw new BillingError("You already have a subscription. Change plans under Manage billing.", 409, "subscribed");
  const customer = await ensureCustomer(user);
  const session = await stripe<{ url: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    subscription_data: { metadata: { user_id: user.id } },
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancelled`,
  });
  return session.url;
}

/** The Stripe Customer Portal: change plan, update the card, see invoices, cancel. */
export async function createPortal(userId: string, origin: string) {
  const row = await billingRow(userId);
  if (!row?.stripe_customer_id) throw new BillingError("You don't have a subscription yet.", 400);
  const session = await stripe<{ url: string }>("POST", "/billing_portal/sessions", {
    customer: row.stripe_customer_id,
    return_url: `${origin}/?billing=portal`,
  });
  return session.url;
}

/** APP_URL, or the request's own origin. */
export const appOrigin = (request: Request) => env().APP_URL?.replace(/\/$/, "") || new URL(request.url).origin;

// ---------------------------------------------------------------- keeping plans in step

/** Records a subscription's state on its user. */
async function applySubscription(sub: Subscription) {
  const user =
    (await first<{ id: string; stripe_subscription_id: string | null }>(
      "SELECT id, stripe_subscription_id FROM users WHERE stripe_customer_id = ?",
      sub.customer,
    )) ??
    (sub.metadata?.user_id
      ? await first<{ id: string; stripe_subscription_id: string | null }>(
          "SELECT id, stripe_subscription_id FROM users WHERE id = ?",
          sub.metadata.user_id,
        )
      : undefined);
  if (!user) {
    console.error(`Stripe subscription ${sub.id}: no user for customer ${sub.customer}`);
    return;
  }
  const item = sub.items.data[0];
  const plan = planForPrice(item?.price.id);
  const periodEnd = item?.current_period_end ?? sub.current_period_end;
  if (LIVE.has(sub.status) && plan) {
    await run(
      `UPDATE users SET plan = ?, stripe_customer_id = COALESCE(stripe_customer_id, ?), stripe_subscription_id = ?,
              subscription_status = ?, renews_at = ?, cancel_at_period_end = ? WHERE id = ?`,
      plan,
      sub.customer,
      sub.id,
      sub.status,
      periodEnd ? periodEnd * 1000 : null,
      sub.cancel_at_period_end ? 1 : 0,
      user.id,
    );
    return;
  }
  if (LIVE.has(sub.status)) console.error(`Stripe subscription ${sub.id}: unknown price ${item?.price.id}`);
  // An old subscription ending doesn't touch the current one.
  if (user.stripe_subscription_id && user.stripe_subscription_id !== sub.id) return;
  await run(
    `UPDATE users SET plan = 'free', stripe_subscription_id = ?, subscription_status = ?, renews_at = NULL,
            cancel_at_period_end = 0 WHERE id = ?`,
    sub.id,
    sub.status,
    user.id,
  );
}

/** Re-reads the user's subscriptions from Stripe, e.g. right after Checkout, before the webhook lands. */
export async function syncFromStripe(userId: string) {
  const row = await billingRow(userId);
  if (!row?.stripe_customer_id || !env().STRIPE_SECRET_KEY) return;
  const { data } = await stripe<{ data: Subscription[] }>("GET", "/subscriptions", {
    customer: row.stripe_customer_id,
    status: "all",
    limit: 10,
  });
  // Newest first: a live one wins, otherwise the one we know about.
  const sub = data.find((s) => LIVE.has(s.status)) ?? data.find((s) => s.id === row.stripe_subscription_id);
  if (sub) await applySubscription(sub);
}

// ---------------------------------------------------------------- webhook

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Checks the Stripe-Signature header: HMAC-SHA256 of "<t>.<payload>", within 5 minutes. */
export async function verifyWebhook(payload: string, header: string | null) {
  const secret = env().STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new BillingError("STRIPE_WEBHOOK_SECRET isn't set", 500);
  const parts = (header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !signatures.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  return signatures.some((s) => safeEqual(s, expected));
}

interface StripeEvent {
  id: string;
  type: string;
  data: { object: { id: string; object: string; subscription?: string | null } };
}

/** Applies a verified event. Only subscription state matters, so it's re-fetched fresh. */
export async function handleEvent(event: StripeEvent) {
  const obj = event.data.object;
  const subscriptionId =
    obj.object === "subscription" ? obj.id : obj.object === "checkout.session" ? obj.subscription : undefined;
  if (!subscriptionId) return;
  await applySubscription(await stripe<Subscription>("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`));
}
