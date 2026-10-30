import { currentUser } from "@/lib/auth";
import { getAsset, serveAsset } from "@/lib/storage";
import { isAssetKey } from "@/lib/uploads";

/** ?key=…[&thumb=1][&download] — redirects to a short-lived signed URL for one of the user's assets. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("Not signed in", { status: 401 });
  const params = new URL(request.url).searchParams;
  const key = params.get("key") ?? "";
  const asset = isAssetKey(key) ? await getAsset(user.id, key) : undefined;
  if (!asset) return new Response("Not found", { status: 404 });
  const name = asset.name ?? key.split("/").slice(-2).join("-");
  return serveAsset(asset, { thumb: params.has("thumb"), downloadName: params.has("download") ? name : undefined });
}
