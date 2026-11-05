import { handleEvent, verifyWebhook } from "@/lib/billing";
import { env } from "@/lib/db";

/**
 * Stripe's webhook. No user session: the signature is the authentication. Needs to be
 * reachable past Cloudflare Access (a Bypass policy for this path; see README).
 */
export async function POST(request: Request) {
  if (!env().STRIPE_WEBHOOK_SECRET) return Response.json({ error: "Billing is off" }, { status: 503 });
  const payload = await request.text();
  if (!(await verifyWebhook(payload, request.headers.get("stripe-signature"))))
    return Response.json({ error: "Bad signature" }, { status: 400 });
  try {
    await handleEvent(JSON.parse(payload));
    return Response.json({ received: true });
  } catch (e) {
    // A 5xx makes Stripe retry later.
    console.error("Stripe webhook", e);
    return Response.json({ error: "Failed" }, { status: 500 });
  }
}
