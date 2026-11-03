import { errorResponse, requireUser } from "@/lib/auth";
import { shouldCancelFal } from "@/lib/falTypes";
import { cancelFalJob, getFalJob, publicFalJob, removeFalJob, syncFalJob } from "@/lib/falJobs";

/** The job, refreshed from fal while it is still in flight. */
export async function GET(_req: Request, ctx: RouteContext<"/api/fal/[id]">) {
  try {
    const user = await requireUser();
    const job = await syncFalJob(user.id, (await ctx.params).id);
    if (!job) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(publicFalJob(job));
  } catch (e) {
    return errorResponse(e);
  }
}

/** Cancels a queued or running request at fal's cancel_url, then removes it locally. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/fal/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const job = await getFalJob(user.id, id);
    if (!job) return Response.json({ error: "Not found" }, { status: 404 });
    if (shouldCancelFal(job.status)) {
      await cancelFalJob(user.id, job).catch((e) => console.error(`[fal ${id} cancel]`, (e as Error).message));
    }
    await removeFalJob(user.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
