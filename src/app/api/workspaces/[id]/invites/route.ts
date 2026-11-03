import { errorResponse, requireUser } from "@/lib/auth";
import { createInvite, ForbiddenError, getWorkspace, NotFoundError, permit, type Role } from "@/lib/workspaces";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * { email?, role } — invite by email, or without an email for a link. The token is
 * returned once; only its hash is stored. Owners and admins. Teams only.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/workspaces/[id]/invites">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
    if (!permit(ws.role, "invite")) throw new ForbiddenError("Only the team's owner and admins can invite.");
    const { email, role } = (await request.json()) as { email?: string; role?: Role };
    if (role !== "admin" && role !== "member")
      return Response.json({ error: "Role must be admin or member" }, { status: 400 });
    const clean = email?.trim().toLowerCase();
    if (clean && !EMAIL_RE.test(clean))
      return Response.json({ error: "That doesn't look like an email address" }, { status: 400 });
    const { invite, token } = await createInvite(ws.id, user, role, clean || undefined);
    const link = token ? new URL(`/invite/${token}`, request.url).toString() : undefined;
    return Response.json({ invite, link }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
