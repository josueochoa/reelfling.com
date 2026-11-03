import { errorResponse, requireUser } from "@/lib/auth";
import {
  ForbiddenError,
  getWorkspace,
  memberRole,
  NotFoundError,
  permit,
  removeMember,
  setMemberCap,
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

/** { role?, monthlyCapUsd? } — roles: owner and admins, except the owner. Caps: owner only. */
export async function PATCH(request: Request, ctx: Ctx) {
  try {
    const { ws, targetId, targetRole } = await load(ctx);
    const body = (await request.json()) as { role?: Role; monthlyCapUsd?: number | null };
    if (body.role != null) {
      if (body.role !== "admin" && body.role !== "member")
        return Response.json({ error: "Role must be admin or member" }, { status: 400 });
      if (!permit(ws.role, "setRole", { targetIsOwner: targetRole === "owner" }))
        throw new ForbiddenError(
          targetRole === "owner" ? "The owner's role can't be changed." : "Only the team's owner and admins can change roles.",
        );
      await setMemberRole(ws.id, targetId, body.role);
    }
    if ("monthlyCapUsd" in body) {
      if (!permit(ws.role, "setCap")) throw new ForbiddenError("Only the team's owner can set a cap.");
      const cap = body.monthlyCapUsd;
      if (cap != null && (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0 || cap > 1_000_000))
        return Response.json({ error: "Cap must be a USD amount, or empty to clear it" }, { status: 400 });
      await setMemberCap(ws.id, targetId, cap ?? null);
    }
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
    if (leaving) {
      if (!permit(ws.role, "leave", { self: true }))
        throw new ForbiddenError("The owner can't leave their own team.");
    } else if (!permit(ws.role, "removeOther", { targetIsOwner: targetRole === "owner" })) {
      throw new ForbiddenError(
        targetRole === "owner" ? "The owner can't be removed." : "Only the team's owner and admins can remove members.",
      );
    }
    await removeMember(ws.id, targetId);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
