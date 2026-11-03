import { authMode, errorResponse, signOutUrl } from "@/lib/auth";
import { listKeys } from "@/lib/keys";
import { isStudioProvider, type ProviderId } from "@/lib/registry";
import { memberCap, monthSpend } from "@/lib/spend";
import { storageUsage } from "@/lib/storage";
import { invitesForEmail, listWorkspaces, requireKeyManager, requireWorkspace, setActiveProvider } from "@/lib/workspaces";

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
      auth: { mode: authMode(), signOutUrl: signOutUrl(), dev: process.env.NODE_ENV === "development" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { activeProvider } — which of this workspace's keys generations use. */
export async function PATCH(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    requireKeyManager(workspace);
    const { activeProvider } = (await request.json()) as { activeProvider: ProviderId };
    if (!isStudioProvider(activeProvider)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!(await listKeys(workspace.id)).some((k) => k.provider === activeProvider))
      return Response.json({ error: "Add a key for that provider first" }, { status: 400 });
    await setActiveProvider(workspace, activeProvider);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
