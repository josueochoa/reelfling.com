import { errorResponse, requireUser } from "@/lib/auth";
import {
  deleteTeam,
  ForbiddenError,
  getWorkspace,
  NotFoundError,
  permit,
  renameWorkspace,
  setTeamFlags,
} from "@/lib/workspaces";

/** Rename, or turn member keys / admin key management on. Owner only. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/workspaces/[id]">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws) throw new NotFoundError("Workspace not found");
    if (ws.kind !== "team") throw new ForbiddenError("Only a team can be changed here.");
    const body = (await request.json()) as { name?: string; memberKeys?: boolean; adminsManageKeys?: boolean };
    if (body.name != null) {
      if (!permit(ws.role, "rename")) throw new ForbiddenError("Only the team's owner can rename it.");
      const name = String(body.name).trim().slice(0, 60);
      if (!name) return Response.json({ error: "Give the team a name" }, { status: 400 });
      await renameWorkspace(ws.id, name);
    }
    if (body.memberKeys != null || body.adminsManageKeys != null) {
      if (!permit(ws.role, "setMemberKeys")) throw new ForbiddenError("Only the team's owner can change that.");
      await setTeamFlags(ws.id, {
        ...(body.memberKeys != null && { memberKeys: !!body.memberKeys }),
        ...(body.adminsManageKeys != null && { adminsManageKeys: !!body.adminsManageKeys }),
      });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Deletes the team, its rows and its bucket. Owner only, after the client confirms. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/workspaces/[id]">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
    if (!permit(ws.role, "deleteTeam")) throw new ForbiddenError("Only the team's owner can delete it.");
    await deleteTeam(ws.id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
