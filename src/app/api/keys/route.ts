import { errorResponse } from "@/lib/auth";
import { deleteKey, listKeys, saveKey } from "@/lib/keys";
import { MODELARK_REGIONS, PROVIDER_INFO, type ProviderId } from "@/lib/models";
import { createProvider, PROVIDERS } from "@/lib/providers";
import { requireAdmin, requireWorkspace, setActiveProvider } from "@/lib/workspaces";

// Keys belong to the workspace: a user's own in Personal; in a team, shared keys that
// only owners and admins manage.

/** { provider, apiKey, baseUrl? } — verifies the key against the provider, then stores it encrypted. */
export async function PUT(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    requireAdmin(workspace);
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

    await saveKey(workspace.id, body.provider, apiKey, baseUrl, user.id);
    if (!workspace.activeProvider) await setActiveProvider(workspace.id, body.provider);
    return Response.json({ ok: true, detail });
  } catch (e) {
    return errorResponse(e);
  }
}

/** ?provider=… — forget a key. Falls back to the workspace's other key, if any. */
export async function DELETE(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    requireAdmin(workspace);
    const provider = new URL(request.url).searchParams.get("provider") as ProviderId;
    await deleteKey(workspace.id, provider);
    if (workspace.activeProvider === provider)
      await setActiveProvider(workspace.id, (await listKeys(workspace.id))[0]?.provider ?? null);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
