import { errorResponse, requireUser } from "@/lib/auth";
import { ForbiddenError, getWorkspace, NotFoundError, permit, revokeInvite } from "@/lib/workspaces";

/** Revoke an invite. Owners and admins. Teams only. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/workspaces/[id]/invites/[inviteId]">) {
  try {
    const user = await requireUser();
    const { id, inviteId } = await ctx.params;
    const ws = await getWorkspace(user.id, id);
    if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
    if (!permit(ws.role, "revokeInvite")) throw new ForbiddenError("Only the team's owner and admins can revoke invites.");
    await revokeInvite(ws.id, inviteId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
