import { errorResponse, requireUser } from "@/lib/auth";
import { getBilling, planPrices } from "@/lib/billing";
import { env } from "@/lib/db";

/** The user's plan and subscription, and what each paid plan costs (from Stripe). */
export async function GET() {
  try {
    const user = await requireUser();
    const [billing, prices] = await Promise.all([getBilling(user.id), planPrices()]);
    return Response.json({ billing, prices, enabled: !!env().STRIPE_SECRET_KEY });
  } catch (e) {
    return errorResponse(e);
  }
}
