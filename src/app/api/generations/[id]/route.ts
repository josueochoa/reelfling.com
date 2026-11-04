import { errorResponse, requireUser } from "@/lib/auth";
import { getCredentials } from "@/lib/keys";
import { providerForUser } from "@/lib/providers";
import { cancelFal } from "@/lib/providers/fal";
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
    const gen = await getGeneration(user.id, id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    // Best effort: running tasks can't always be cancelled, and the key may be gone.
    if ((gen.route ?? gen.provider) === "fal") {
      if (gen.falCancelUrl) {
        const creds = await getCredentials(user.id, "fal");
        if (creds) await cancelFal(creds.apiKey, gen.falCancelUrl).catch(() => {});
      }
    } else {
      const providerId = gen.provider && gen.provider !== "fal" ? gen.provider : "modelark";
      await providerForUser(user.id, providerId)
        .then((p) => p.deleteTask(gen.taskId))
        .catch(() => {});
    }
    await removeGeneration(user.id, id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
