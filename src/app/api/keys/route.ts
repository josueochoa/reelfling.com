import { errorResponse, requireUser, setActiveProvider } from "@/lib/auth";
import { deleteKey, listKeys, saveKey } from "@/lib/keys";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/models";
import { createProvider, PROVIDERS } from "@/lib/providers";

/** { provider, apiKey, baseUrl? } — verifies the key against the provider, then stores it encrypted. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { provider: ProviderId; apiKey: string; baseUrl?: string };
    const apiKey = body.apiKey?.trim();
    if (!(body.provider in PROVIDERS)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!apiKey) return Response.json({ error: "Paste an API key" }, { status: 400 });
    // Only known endpoints — a free-form URL would let the server be pointed anywhere.
    const baseUrl =
      body.provider === "modelark" && body.baseUrl && body.baseUrl in MODELARK_REGIONS ? body.baseUrl : undefined;

    let detail: string | undefined;
    try {
      ({ detail } = await createProvider(body.provider, { apiKey, baseUrl }).verifyKey());
    } catch (e) {
      return Response.json(
        { error: `${PROVIDER_INFO[body.provider].label} rejected this key: ${(e as Error).message}` },
        { status: 400 },
      );
    }

    saveKey(user.id, body.provider, apiKey, baseUrl);
    if (!user.activeProvider) setActiveProvider(user.id, body.provider);
    return Response.json({ ok: true, detail });
  } catch (e) {
    return errorResponse(e);
  }
}

/** ?provider=… — forget a key. Falls back to the user's other key, if any. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const provider = new URL(request.url).searchParams.get("provider") as ProviderId;
    deleteKey(user.id, provider);
    if (user.activeProvider === provider) setActiveProvider(user.id, listKeys(user.id)[0]?.provider ?? null);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
