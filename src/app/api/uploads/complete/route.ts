import { errorResponse } from "@/lib/auth";
import { completeUpload, deleteAsset, discardUpload, storageUsage } from "@/lib/storage";
import { LIBRARY_PREFIX, thumbKeyFor, UPLOAD_RULES, uploadKindOf } from "@/lib/uploads";
import { requireWorkspace } from "@/lib/workspaces";

const KEY_RE = new RegExp(`^${LIBRARY_PREFIX}[0-9a-f-]{36}\\.[a-z0-9]+$`);

/**
 * { key, name, duration?, peaks?, thumb? } — call after the browser's PUTs succeed.
 * Checks what actually landed in the bucket (a signed URL can't limit size or type),
 * records it in the library and counts it toward the user's quota.
 */
export async function POST(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const body = (await request.json()) as {
      key: string;
      name?: string;
      duration?: number;
      peaks?: number[];
      thumb?: boolean;
    };
    const { key } = body;
    if (!KEY_RE.test(key ?? "")) return Response.json({ error: "Invalid upload key" }, { status: 400 });

    const asset = await completeUpload(workspace.id, key, {
      createdBy: user.id,
      name: body.name?.trim().slice(0, 120) || key.split("/").pop()!,
      meta: {
        duration: Number.isFinite(body.duration) ? Math.round(body.duration! * 100) / 100 : undefined,
        // Waveform bars for audio: up to 64 values, 0–100.
        peaks: Array.isArray(body.peaks)
          ? body.peaks.slice(0, 64).map((p) => Math.max(0, Math.min(100, Math.round(Number(p) || 0))))
          : undefined,
        thumb: body.thumb ? thumbKeyFor(key) : undefined,
      },
    });
    if (!asset) return Response.json({ error: "Upload not found. Try again." }, { status: 404 });

    const kind = uploadKindOf(asset.contentType);
    const rules = kind && UPLOAD_RULES[kind];
    const usage = await storageUsage(workspace.id);
    const problem = !rules
      ? "Unsupported file type"
      : asset.bytes > rules.maxBytes * 1.1 // allowance for the thumbnail
        ? `File too large. Use ${rules.label}.`
        : usage.bytes > usage.quotaBytes
          ? "Your storage is full. Delete some uploads or videos to make room."
          : undefined;
    if (problem) {
      await deleteAsset(asset).catch(() => discardUpload(workspace.id, key));
      return Response.json({ error: problem }, { status: 400 });
    }
    return Response.json({ key, bytes: asset.bytes });
  } catch (e) {
    return errorResponse(e);
  }
}
