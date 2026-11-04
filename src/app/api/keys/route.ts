import { errorResponse, requireUser } from "@/lib/auth";
import { deleteKey, savedKeyBody, saveKey } from "@/lib/keys";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/registry";
import { createProvider } from "@/lib/providers";
import { verifyFalKey } from "@/lib/providers/fal";

/** { provider, apiKey, baseUrl? } — verifies the key against the provider, then stores it encrypted. */
export async function PUT(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { provider: ProviderId; apiKey: string; baseUrl?: string };
    const apiKey = body.apiKey?.trim();
    if (!(body.provider in PROVIDER_INFO)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!apiKey) return Response.json({ error: "Paste an API key" }, { status: 400 });
    // Only known endpoints — a free-form URL would let the server be pointed anywhere.
    const baseUrl =
      body.provider === "modelark" && body.baseUrl && body.baseUrl in MODELARK_REGIONS ? body.baseUrl : undefined;

    let detail: string | undefined;
    try {
      if (body.provider === "fal") await verifyFalKey(apiKey);
      else ({ detail } = await createProvider(body.provider, { apiKey, baseUrl }).verifyKey());
    } catch (e) {
      const message = (e as Error).message.split(apiKey).join("[redacted]");
      return Response.json(
        { error: `${PROVIDER_INFO[body.provider].label} rejected this key: ${message}` },
        { status: 400 },
      );
    }

    await saveKey(user.id, body.provider, apiKey, baseUrl);
    return Response.json(savedKeyBody(apiKey, detail));
  } catch (e) {
    return errorResponse(e);
  }
}

/** ?provider=… — forget a key. Later generations pick another keyed route. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const provider = new URL(request.url).searchParams.get("provider") as ProviderId;
    await deleteKey(user.id, provider);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
