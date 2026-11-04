import { errorResponse } from "@/lib/auth";
import { getCredentials } from "@/lib/keys";
import { providerForWorkspace } from "@/lib/providers";
import { cancelFal } from "@/lib/providers/fal";
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

/** Cancels the upstream task when possible, then removes it locally. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/generations/[id]">) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const gen = await getGeneration(workspace.id, id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    requireCanModify(workspace, user, gen.createdBy);
    const keyWorkspace = gen.keyWorkspaceId || workspace.id;
    if ((gen.route ?? gen.provider) === "fal") {
      if (gen.falCancelUrl) {
        const creds = await getCredentials(keyWorkspace, "fal");
        if (creds) await cancelFal(creds.apiKey, gen.falCancelUrl).catch(() => {});
      }
    } else {
      const provider = gen.provider && gen.provider !== "fal" ? gen.provider : "modelark";
      await providerForWorkspace(keyWorkspace, provider)
        .then((p) => p.deleteTask(gen.taskId))
        .catch(() => {});
    }
    await removeGeneration(workspace.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
