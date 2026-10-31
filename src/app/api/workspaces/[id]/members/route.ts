import { errorResponse, requireUser } from "@/lib/auth";
import { getWorkspace, isAdmin, listInvites, listMembers, NotFoundError } from "@/lib/workspaces";

/** The team's members; for owners and admins, its pending invites too. */
export async function GET(_request: Request, ctx: RouteContext<"/api/workspaces/[id]/members">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws) throw new NotFoundError("Workspace not found");
    const [members, invites] = await Promise.all([listMembers(ws.id), isAdmin(ws) ? listInvites(ws.id) : []]);
    return Response.json({ workspace: ws, members, invites });
  } catch (e) {
    return errorResponse(e);
  }
}
