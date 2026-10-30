import { errorResponse, requireUser } from "@/lib/auth";
import { getImageGeneration, removeImageGeneration } from "@/lib/images";

/** The generation's current state (the page polls this while it runs). */
export async function GET(_req: Request, ctx: RouteContext<"/api/images/[id]">) {
  try {
    const user = await requireUser();
    const gen = await getImageGeneration(user.id, (await ctx.params).id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(gen);
  } catch (e) {
    return errorResponse(e);
  }
}

/** Deletes the generation and its images. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/images/[id]">) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    if (!(await getImageGeneration(user.id, id))) return Response.json({ error: "Not found" }, { status: 404 });
    await removeImageGeneration(user.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
