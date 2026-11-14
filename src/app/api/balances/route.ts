import { errorResponse, requireUser } from "@/lib/auth";
import type { ProviderBalance } from "@/lib/balance";
import { getCredentials, listKeys } from "@/lib/keys";
import { argoBalance } from "@/lib/providers/argolink";
import { falAccountBalance } from "@/lib/providers/fal";
import { openRouterKeyBalance } from "@/lib/providers/openrouter";
import type { ProviderId } from "@/lib/registry";

// A slow provider shouldn't hold the others back.
const TIMEOUT_MS = 8000;

async function balanceOf(userId: string, provider: ProviderId): Promise<ProviderBalance> {
  // BytePlus has no balance endpoint for an API key.
  if (provider === "modelark") return { provider, note: "BytePlus doesn't report a balance for an API key" };
  const creds = await getCredentials(userId, provider);
  if (!creds) return { provider, note: "No key saved" };
  if (provider === "argolink") return argoBalance(creds);
  if (provider === "openrouter") return openRouterKeyBalance(creds.apiKey);
  return falAccountBalance(creds.apiKey);
}

function withTimeout(work: Promise<ProviderBalance>, provider: ProviderId): Promise<ProviderBalance> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<ProviderBalance>((resolve) => {
    timer = setTimeout(() => resolve({ provider, note: "The provider took too long to answer" }), TIMEOUT_MS);
  });
  // The provider's message can echo the key, so a failure is reported without it.
  const safe = work.catch((): ProviderBalance => ({ provider, note: "Couldn't read the balance" }));
  return Promise.race([safe, late]).finally(() => clearTimeout(timer));
}

/** What each of the user's providers says is left, read now with their own keys. */
export async function GET() {
  try {
    const user = await requireUser();
    const keys = await listKeys(user.id);
    const balances = await Promise.all(keys.map((key) => withTimeout(balanceOf(user.id, key.provider), key.provider)));
    return Response.json({ balances, at: Date.now() }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
