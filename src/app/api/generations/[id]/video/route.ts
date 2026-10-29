import { currentUser } from "@/lib/auth";
import { serveAsset } from "@/lib/storage";
import { ensureStoredVideo, getGeneration } from "@/lib/store";

/** Plays (or with ?download, saves) the stored MP4 — copying it from the provider first if needed. */
export async function GET(request: Request, ctx: RouteContext<"/api/generations/[id]/video">) {
  const user = await currentUser();
  if (!user) return new Response("Not signed in", { status: 401 });
  const { id } = await ctx.params;
  const gen = getGeneration(user.id, id);
  if (!gen || gen.status !== "succeeded") return new Response("Not found", { status: 404 });

  const asset = await ensureStoredVideo(user.id, gen).catch((e) => {
    console.error(`[${id}]`, e);
    return undefined;
  });
  if (!asset) return new Response("Video not ready", { status: 404 });

  const download = new URL(request.url).searchParams.has("download");
  return serveAsset(asset, request, download ? { downloadName: `seedance-${id.slice(0, 8)}.mp4` } : {});
}
