import { errorResponse, requireUser } from "@/lib/auth";
import { ForbiddenError, getWorkspace, NotFoundError, permit, transferOwnership } from "@/lib/workspaces";

/** { userId } — the owner hands the team to an admin and becomes an admin. */
export async function POST(request: Request, ctx: RouteContext<"/api/workspaces/[id]/transfer">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws || ws.kind !== "team") throw new NotFoundError("Team not found");
    if (!permit(ws.role, "transfer")) throw new ForbiddenError("Only the team's owner can transfer it.");
    const userId = String(((await request.json()) as { userId?: string }).userId ?? "");
    if (!userId || userId === user.id) return Response.json({ error: "Pick an admin to transfer to" }, { status: 400 });
    await transferOwnership(ws.id, user.id, userId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
