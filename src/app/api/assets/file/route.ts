import { currentUser } from "@/lib/auth";
import { getAsset, serveAsset, streamAsset } from "@/lib/storage";
import { serveTeammateFile } from "@/lib/teammates";
import { isAssetKey } from "@/lib/uploads";

/**
 * ?key=…[&thumb=1][&download] — redirects to a short-lived signed URL.
 * `&owner=<user id>` is a teammate's file: streamed, never redirected.
 * `?bytes=1` streams the file from this origin so a canvas can read a frame.
 * The redirect target is cross-origin and would taint that canvas.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("Not signed in", { status: 401 });
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  const owner = params.get("owner");
  if (owner && owner !== user.id)
    return serveTeammateFile(user.id, owner, key, request, { thumb: params.has("thumb"), download: params.has("download") });
  const asset = isAssetKey(key) ? await getAsset(user.id, key) : undefined;
  if (!asset) return new Response("Not found", { status: 404 });
  if (params.has("bytes")) return streamAsset(asset, request);
  const name = asset.name ?? key.split("/").slice(-2).join("-");
  return serveAsset(asset, { thumb: params.has("thumb"), downloadName: params.has("download") ? name : undefined });
}
