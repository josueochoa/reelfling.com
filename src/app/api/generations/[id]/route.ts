import { errorResponse, requireUser } from "@/lib/auth";
import { providerForUser } from "@/lib/providers";
import { getGeneration, removeGeneration, syncGeneration } from "@/lib/store";

/** Returns the generation, refreshing it from the provider if it's still in flight. */
export async function GET(_req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  try {
    const user = await requireUser();
    const gen = await syncGeneration(user.id, (await ctx.params).id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(gen);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Cancels the upstream task when possible, then removes it locally. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const gen = getGeneration(user.id, id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    // Best effort: running tasks can't always be cancelled, and the key may be gone.
    await Promise.resolve()
      .then(() => providerForUser(user.id, gen.provider ?? "modelark").deleteTask(gen.taskId))
      .catch(() => {});
    await removeGeneration(user.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
