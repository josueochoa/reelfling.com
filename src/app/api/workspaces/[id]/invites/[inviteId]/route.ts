import { errorResponse, requireUser } from "@/lib/auth";
import { getWorkspace, NotFoundError, requireAdmin, revokeInvite } from "@/lib/workspaces";

/** Revoke an invite (owners and admins). */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/workspaces/[id]/invites/[inviteId]">) {
  try {
    const user = await requireUser();
    const { id, inviteId } = await ctx.params;
    const ws = await getWorkspace(user.id, id);
    if (!ws) throw new NotFoundError("Team not found");
    requireAdmin(ws);
    await revokeInvite(ws.id, inviteId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
