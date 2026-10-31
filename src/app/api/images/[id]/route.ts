import { errorResponse } from "@/lib/auth";
import { getImageGeneration, removeImageGeneration } from "@/lib/images";
import { requireCanModify, requireWorkspace } from "@/lib/workspaces";

/** The generation's current state (the page polls this while it runs). */
export async function GET(request: Request, ctx: RouteContext<"/api/images/[id]">) {
  try {
    const { workspace } = await requireWorkspace(request);
    const gen = await getImageGeneration(workspace.id, (await ctx.params).id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(gen);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Deletes the generation and its images. Its creator or a team admin. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/images/[id]">) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const gen = await getImageGeneration(workspace.id, id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    requireCanModify(workspace, user, gen.createdBy);
    await removeImageGeneration(workspace.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
