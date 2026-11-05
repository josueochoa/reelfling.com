import { errorResponse, requireUser } from "@/lib/auth";
import { appOrigin, createPortal } from "@/lib/billing";

/** → { url } of the Stripe Customer Portal: change plan, card, invoices, cancel. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    return Response.json({ url: await createPortal(user.id, appOrigin(request)) });
  } catch (e) {
    return errorResponse(e);
  }
}
