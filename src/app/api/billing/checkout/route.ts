import { errorResponse, requireUser } from "@/lib/auth";
import { appOrigin, createCheckout } from "@/lib/billing";
import { PAID_PLANS, type PaidPlanId } from "@/lib/plans";

/** { plan } → { url } of a Stripe Checkout page to subscribe. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { plan } = (await request.json()) as { plan: PaidPlanId };
    if (!PAID_PLANS.includes(plan)) return Response.json({ error: "Unknown plan" }, { status: 400 });
    return Response.json({ url: await createCheckout(user, plan, appOrigin(request)) });
  } catch (e) {
    return errorResponse(e);
  }
}
