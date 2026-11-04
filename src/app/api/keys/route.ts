import { errorResponse } from "@/lib/auth";
import { deleteKey, savedKeyBody, saveKey, scrubSecret } from "@/lib/keys";
import { mockProviders } from "@/lib/providers/mock";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/registry";
import { createProvider } from "@/lib/providers";
import { verifyFalKey } from "@/lib/providers/fal";
import { requireKeyManager, requireWorkspace } from "@/lib/workspaces";

/** { provider, apiKey, baseUrl? } — verifies the key, then stores it encrypted. */
export async function PUT(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    requireKeyManager(workspace);
    const body = (await request.json()) as { provider: ProviderId; apiKey: string; baseUrl?: string };
    const apiKey = body.apiKey?.trim();
    if (!(body.provider in PROVIDER_INFO)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!apiKey) return Response.json({ error: "Paste an API key" }, { status: 400 });
    const baseUrl =
      body.provider === "modelark" && body.baseUrl && body.baseUrl in MODELARK_REGIONS ? body.baseUrl : undefined;

    let detail: string | undefined;
    try {
      if (mockProviders()) detail = "Mock provider";
      else if (body.provider === "fal") await verifyFalKey(apiKey);
      else ({ detail } = await createProvider(body.provider, { apiKey, baseUrl }).verifyKey());
    } catch (e) {
      return Response.json(
        { error: `${PROVIDER_INFO[body.provider].label} rejected this key: ${scrubSecret((e as Error).message, apiKey)}` },
        { status: 400 },
      );
    }

    await saveKey(workspace.id, body.provider, apiKey, baseUrl, user.id, { team: workspace.kind === "team" });
    return Response.json(savedKeyBody(apiKey, detail));
  } catch (e) {
    return errorResponse(e);
  }
}

/** ?provider=… — forget a key. Generations pick another keyed route on their own. */
export async function DELETE(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    requireKeyManager(workspace);
    const provider = new URL(request.url).searchParams.get("provider") as ProviderId;
    await deleteKey(workspace.id, provider);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
