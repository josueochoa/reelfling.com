// Plans: how much storage a person gets, and whether they can create teams. Storage is per
// person: their files count against it in every workspace they're in. Prices live in
// Stripe; STRIPE_PRICE_<PLAN> (wrangler.jsonc) says which Stripe price is which plan.
// Shared with the browser, so no server imports.

export type PlanId = "free" | "plus" | "pro";

export interface Plan {
  id: PlanId;
  label: string;
  storageGb: number;
  /** Can create and own teams. Anyone can join one. */
  teams: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", label: "Free", storageGb: 1, teams: false },
  plus: { id: "plus", label: "Plus", storageGb: 5, teams: true },
  pro: { id: "pro", label: "Pro", storageGb: 20, teams: true },
};

export const PAID_PLANS = ["plus", "pro"] as const;
export type PaidPlanId = (typeof PAID_PLANS)[number];

export const GB = 1024 ** 3;

/** "Plus and Pro": the plans that include Teams, for messages. */
export const TEAM_PLANS_LABEL = Object.values(PLANS)
  .filter((p) => p.teams)
  .map((p) => p.label)
  .join(" and ");

/** Unknown or missing ids (e.g. a plan that was retired) fall back to Free. */
export const planOf = (id: string | null | undefined): Plan => PLANS[id as PlanId] ?? PLANS.free;
