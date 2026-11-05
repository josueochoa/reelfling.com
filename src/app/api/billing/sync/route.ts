import { errorResponse, requireUser } from "@/lib/auth";
import { getBilling, syncFromStripe } from "@/lib/billing";

/** Re-reads the subscription from Stripe (back from Checkout or the portal, before the webhook lands). */
export async function POST() {
  try {
    const user = await requireUser();
    await syncFromStripe(user.id);
    return Response.json(await getBilling(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}
