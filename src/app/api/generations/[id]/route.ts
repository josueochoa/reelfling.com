import { getProvider, ProviderError } from "@/lib/providers";
import { getGeneration, removeGeneration, syncGeneration } from "@/lib/store";

/** Returns the generation, refreshing it from the provider if it's still in flight. */
export async function GET(_req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  const { id } = await ctx.params;
  try {
    const gen = await syncGeneration(id);
    if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(gen);
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}

/** Cancels the upstream task when possible, then removes it locally. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/generations/[id]">) {
  const { id } = await ctx.params;
  const gen = await getGeneration(id);
  if (!gen) return Response.json({ error: "Not found" }, { status: 404 });
  // Running tasks can't always be cancelled upstream; we still drop them locally.
  await getProvider(gen.provider ?? "modelark").deleteTask(gen.taskId).catch(() => {});
  await removeGeneration(id);
  return new Response(null, { status: 204 });
}
