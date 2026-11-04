import { errorResponse, requireUser } from "@/lib/auth";
import { assertStorageAvailable, createUpload, getAsset, renameAsset } from "@/lib/storage";
import { LIBRARY_PREFIX, thumbKeyFor, UPLOAD_RULES, type UploadKind } from "@/lib/uploads";

/**
 * { kind, contentType, size, thumb? } → { key, uploadUrl, thumbKey?, thumbUploadUrl? }.
 * Reserves a key in the user's bucket and returns signed URLs to PUT the file (and its
 * JPEG thumbnail) to directly; then call /api/uploads/complete.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const { kind, contentType, size, thumb } = (await request.json()) as {
      kind: UploadKind;
      contentType: string;
      size: number;
      thumb?: boolean;
    };
    const rules = UPLOAD_RULES[kind];
    if (!rules) return Response.json({ error: "Unknown upload kind" }, { status: 400 });
    const ext = rules.types[contentType];
    if (!ext) return Response.json({ error: `Unsupported file type. Use ${rules.label}.` }, { status: 400 });
    if (!(size > 0) || size > rules.maxBytes)
      return Response.json({ error: `File too large. Use ${rules.label}.` }, { status: 400 });
    await assertStorageAvailable(user.id, size);

    const key = `${LIBRARY_PREFIX}${crypto.randomUUID()}.${ext}`;
    const thumbKey = thumb && kind !== "audio" ? thumbKeyFor(key) : undefined;
    const [uploadUrl, thumbUploadUrl] = await createUpload(user.id, thumbKey ? [key, thumbKey] : [key]);
    return Response.json({ key, uploadUrl, thumbKey, thumbUploadUrl });
  } catch (e) {
    return errorResponse(e);
  }
}

const libraryAsset = async (userId: string, key: string) =>
  key.startsWith(LIBRARY_PREFIX) ? getAsset(userId, key) : undefined;

/** { key, name } — rename a library item. */
export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const { key, name } = (await request.json()) as { key: string; name: string };
    const clean = name?.trim().slice(0, 120);
    if (!clean) return Response.json({ error: "Name can't be empty" }, { status: 400 });
    if (!(await libraryAsset(user.id, key))) return Response.json({ error: "Not found" }, { status: 404 });
    await renameAsset(user.id, key, clean);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
