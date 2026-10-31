import { errorResponse, requireUser } from "@/lib/auth";
import {
  ForbiddenError,
  getWorkspace,
  isAdmin,
  memberRole,
  NotFoundError,
  removeMember,
  setMemberRole,
  type Role,
} from "@/lib/workspaces";

type Ctx = RouteContext<"/api/workspaces/[id]/members/[userId]">;

async function load(ctx: Ctx) {
  const user = await requireUser();
  const { id, userId } = await ctx.params;
  const ws = await getWorkspace(user.id, id);
  if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
  const role = await memberRole(ws.id, userId);
  if (!role) throw new NotFoundError("Not a member");
  return { user, ws, targetId: userId, targetRole: role };
}

/** { role: "admin" | "member" } — owners and admins; the owner's role can't be changed here. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { ws, targetId, targetRole } = await load(ctx);
    const { role } = (await request.json()) as { role: Role };
    if (role !== "admin" && role !== "member")
      return Response.json({ error: "Role must be admin or member" }, { status: 400 });
    if (!isAdmin(ws)) throw new ForbiddenError("Only the team's owner and admins can change roles.");
    if (targetRole === "owner") throw new ForbiddenError("The owner's role can't be changed.");
    await setMemberRole(ws.id, targetId, role);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Remove someone (owners and admins), or leave (yourself). Their work stays in the team. */
export async function DELETE(_request: Request, ctx: Ctx) {
  try {
    const { user, ws, targetId, targetRole } = await load(ctx);
    const leaving = targetId === user.id;
    if (targetRole === "owner")
      throw new ForbiddenError(leaving ? "The owner can't leave their own team." : "The owner can't be removed.");
    if (!leaving && !isAdmin(ws)) throw new ForbiddenError("Only the team's owner and admins can remove members.");
    await removeMember(ws.id, targetId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
