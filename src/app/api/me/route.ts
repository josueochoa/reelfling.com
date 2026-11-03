import { authMode, errorResponse, signOutUrl } from "@/lib/auth";
import { getBilling } from "@/lib/billing";
import { listKeys } from "@/lib/keys";
import type { ProviderId } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { storageUsage, teamStorage } from "@/lib/storage";
import { invitesForEmail, listWorkspaces, requireAdmin, requireWorkspace, setActiveProvider } from "@/lib/workspaces";

/**
 * The signed-in user, their plan and storage (across all workspaces); the workspace this
 * request acts in (its keys, masked, the provider it generates with, and a team's
 * storage); all their workspaces; invites waiting for them; and how to sign out.
 */
export async function GET(request: Request) {
  try {
    // Falls back to Personal: the page follows whatever workspace this returns.
    const { user, workspace } = await requireWorkspace(request, { fallback: true });
    const [keys, billing, storage, team, workspaces, invites] = await Promise.all([
      listKeys(workspace.id),
      getBilling(user.id),
      storageUsage(user.id),
      workspace.kind === "team" ? teamStorage(workspace.id) : undefined,
      listWorkspaces(user.id),
      invitesForEmail(user.email, user.id),
    ]);
    return Response.json({
      user,
      billing,
      workspace,
      workspaces,
      invites,
      keys,
      storage,
      teamStorage: team,
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
