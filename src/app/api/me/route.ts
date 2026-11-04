import { authMode, errorResponse, signOutUrl } from "@/lib/auth";
import { listKeys } from "@/lib/keys";
import { memberCap, monthSpend } from "@/lib/spend";
import { storageUsage } from "@/lib/storage";
import { isRouteProvider, listRoutePreferences, setRoutePreference } from "@/lib/routes";
import { invitesForEmail, listWorkspaces, requireWorkspace } from "@/lib/workspaces";

/**
 * The signed-in user, the workspace this tab is in (masked keys, route, storage),
 * their other workspaces, and email invites waiting for them.
 */
export async function GET(request: Request) {
  try {
    // Falls back to Personal: the page follows whatever workspace this returns.
    const { user, workspace } = await requireWorkspace(request, { fallback: true });
    const [keys, personalKeys, storage, workspaces, invites, cap, monthUsd] = await Promise.all([
      listKeys(workspace.id),
      listKeys(user.id),
      storageUsage(workspace.id),
      listWorkspaces(user.id),
      invitesForEmail(user.email, user.id),
      workspace.kind === "team" ? memberCap(workspace.id, user.id) : Promise.resolve(null),
      workspace.kind === "team" ? monthSpend(workspace.id, user.id) : Promise.resolve(0),
    ]);
    return Response.json({
      user,
      workspace,
      workspaces,
      invites,
      keys,
      personalKeys,
      storage,
      cap: workspace.kind === "team" ? { usd: cap, monthUsd } : null,
      routePreferences: await listRoutePreferences(user.id),
      auth: { mode: authMode(), signOutUrl: signOutUrl(), dev: process.env.NODE_ENV === "development" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { modelId, provider } — this user's route for one model. */
export async function PATCH(request: Request) {
  try {
    const { user } = await requireWorkspace(request);
    const body = (await request.json()) as { modelId?: string; provider?: string };
    const modelId = body.modelId?.trim() ?? "";
    if (!modelId || modelId.length > 200) return Response.json({ error: "Unknown model" }, { status: 400 });
    if (!body.provider || !isRouteProvider(body.provider)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    await setRoutePreference(user.id, modelId, body.provider);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
