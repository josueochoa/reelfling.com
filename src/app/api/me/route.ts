import { authMode, errorResponse, signOutUrl } from "@/lib/auth";
import { listKeys } from "@/lib/keys";
import type { ProviderId } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { storageUsage } from "@/lib/storage";
import { invitesForEmail, listWorkspaces, requireAdmin, requireWorkspace, setActiveProvider } from "@/lib/workspaces";

/**
 * The signed-in user; the workspace this request acts in (its keys, masked, the provider
 * it generates with, storage used); all their workspaces; invites waiting for them; and
 * how to sign out.
 */
export async function GET(request: Request) {
  try {
    // Falls back to Personal: the page follows whatever workspace this returns.
    const { user, workspace } = await requireWorkspace(request, { fallback: true });
    const [keys, storage, workspaces, invites] = await Promise.all([
      listKeys(workspace.id),
      storageUsage(workspace.id),
      listWorkspaces(user.id),
      invitesForEmail(user.email, user.id),
    ]);
    return Response.json({
      user,
      workspace,
      workspaces,
      invites,
      keys,
      storage,
      auth: { mode: authMode(), signOutUrl: signOutUrl() },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/** { activeProvider } — switch which of the workspace's keys is used (admins, in a team). */
export async function PATCH(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    requireAdmin(workspace);
    const { activeProvider } = (await request.json()) as { activeProvider: ProviderId };
    if (!(activeProvider in PROVIDERS)) return Response.json({ error: "Unknown provider" }, { status: 400 });
    if (!(await listKeys(workspace.id)).some((k) => k.provider === activeProvider))
      return Response.json({ error: "Add a key for that provider first" }, { status: 400 });
    await setActiveProvider(workspace.id, activeProvider);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
