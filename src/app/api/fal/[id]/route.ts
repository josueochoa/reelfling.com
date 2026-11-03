import { errorResponse } from "@/lib/auth";
import { shouldCancelFal } from "@/lib/falTypes";
import { cancelFalJob, getFalJob, publicFalJob, removeFalJob, syncFalJob } from "@/lib/falJobs";
import { requireCanModify, requireWorkspace } from "@/lib/workspaces";

/** The job, refreshed from fal while it is still in flight. */
export async function GET(request: Request, ctx: RouteContext<"/api/fal/[id]">) {
  try {
    const { workspace } = await requireWorkspace(request);
    const job = await syncFalJob(workspace.id, (await ctx.params).id);
    if (!job) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(publicFalJob(job));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Cancels a queued or running request at fal's cancel_url, then removes it locally. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/fal/[id]">) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const job = await getFalJob(workspace.id, id);
    if (!job) return Response.json({ error: "Not found" }, { status: 404 });
    requireCanModify(workspace, user, job.createdBy);
    if (shouldCancelFal(job.status)) {
      await cancelFalJob(workspace.id, job).catch((e) => console.error(`[fal ${id} cancel]`, (e as Error).message));
    }
    await removeFalJob(workspace.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
