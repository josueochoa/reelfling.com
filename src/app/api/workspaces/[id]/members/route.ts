import { errorResponse, requireUser } from "@/lib/auth";
import { getWorkspace, permit, listInvites, listMembers, NotFoundError } from "@/lib/workspaces";

/** The team's members; owners and admins also see pending invites. */
export async function GET(_request: Request, ctx: RouteContext<"/api/workspaces/[id]/members">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws) throw new NotFoundError("Workspace not found");
    const [members, invites] = await Promise.all([
      listMembers(ws.id),
      permit(ws.role, "invite") ? listInvites(ws.id) : [],
    ]);
    return Response.json({ workspace: ws, members, invites });
  } catch (e) {
    return errorResponse(e);
  }
}
