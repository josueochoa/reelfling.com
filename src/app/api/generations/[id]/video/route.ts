import { AuthError } from "@/lib/auth";
import { serveAsset } from "@/lib/storage";
import { ensureStoredVideo, getGeneration } from "@/lib/store";
import { requireWorkspace } from "@/lib/workspaces";

/** Plays (or with ?download, saves) the stored MP4. Membership is checked, so a removed member gets no new URL. */
export async function GET(request: Request, ctx: RouteContext<"/api/generations/[id]/video">) {
  try {
    const { workspace } = await requireWorkspace(request);
    const { id } = await ctx.params;
    const gen = await getGeneration(workspace.id, id);
    if (!gen || gen.status !== "succeeded") return new Response("Not found", { status: 404 });
    const asset = await ensureStoredVideo(workspace.id, gen).catch((e) => {
      console.error(`[${id}]`, (e as Error).message);
      return undefined;
    });
    if (!asset) return new Response("Video not ready", { status: 404 });
    const download = new URL(request.url).searchParams.has("download");
    return serveAsset(asset, download ? { downloadName: `seedance-${id.slice(0, 8)}.mp4` } : {});
  } catch (e) {
    if (e instanceof AuthError) return new Response("Not signed in", { status: 401 });
    return new Response("Not found", { status: 404 });
  }
}
