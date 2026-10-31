import { errorResponse } from "@/lib/auth";
import { providerForWorkspace } from "@/lib/providers";
import { getGeneration, removeGeneration, syncGeneration } from "@/lib/store";
import { requireCanModify, requireWorkspace } from "@/lib/workspaces";

/** Returns the generation, refreshing it from the provider if it's still in flight. */
export async function GET(request: Request, ctx: RouteContext<"/api/generations/[id]">) {
  try {
    const { workspace } = await requireWorkspace(request);
    const gen = await syncGeneration(workspace.id, (await ctx.params).id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(gen);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Cancels the upstream task when possible, then removes it. Its creator or a team admin. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/generations/[id]">) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const gen = await getGeneration(workspace.id, id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    requireCanModify(workspace, user, gen.createdBy);
    // Best effort: running tasks can't always be cancelled, and the key may be gone.
    await providerForWorkspace(workspace.id, gen.provider ?? "modelark")
      .then((p) => p.deleteTask(gen.taskId))
      .catch(() => {});
    await removeGeneration(workspace.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
