import { deleteUserAsset } from "@/lib/assets";
import { errorResponse, requireUser } from "@/lib/auth";
import { listAssets } from "@/lib/storage";

/** All of the user's assets (uploads and generated), newest first. */
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listAssets(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

/** { keys } — delete assets. Generated ones take their generation with them (see assets.ts). */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const { keys } = (await request.json()) as { keys: string[] };
    if (!Array.isArray(keys) || keys.length > 500) return Response.json({ error: "Invalid keys" }, { status: 400 });
    for (const key of keys) await deleteUserAsset(user.id, key);
    return new Response(null, { status: 204 });
  } catch (e) {
    return errorResponse(e);
  }
}
