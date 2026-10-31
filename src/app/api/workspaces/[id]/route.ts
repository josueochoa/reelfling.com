import { errorResponse, requireUser } from "@/lib/auth";
import { ForbiddenError, getWorkspace, NotFoundError, renameWorkspace } from "@/lib/workspaces";

/** { name } — rename a team (owner only). */
export async function PATCH(request: Request, ctx: RouteContext<"/api/workspaces/[id]">) {
  try {
    const user = await requireUser();
    const ws = await getWorkspace(user.id, (await ctx.params).id);
    if (!ws) throw new NotFoundError("Workspace not found");
    if (ws.kind !== "team" || ws.role !== "owner") throw new ForbiddenError("Only the team's owner can rename it.");
    const name = String(((await request.json()) as { name?: string }).name ?? "")
      .trim()
      .slice(0, 60);
    if (!name) return Response.json({ error: "Give the team a name" }, { status: 400 });
    await renameWorkspace(ws.id, name);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
