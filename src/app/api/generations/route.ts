import { errorResponse, requireUser } from "@/lib/auth";
import { invalidMentions, normalizeMentions } from "@/lib/mentions";
import { providerForUser } from "@/lib/providers";
import { getModel, isVideo, mentionSyntax, routeFor, videoRequestError } from "@/lib/registry";
import { assertStorageAvailable, getAsset, providerUrl } from "@/lib/storage";
import { insertGeneration, listGenerations } from "@/lib/store";
import type { GenerateRequest, Generation } from "@/lib/types";
import { isAssetKey, isUploadRef, uploadKeyOf, uploadKindOf, type UploadKind } from "@/lib/uploads";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listGenerations(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

const ni = (r: GenerateRequest) => r.referenceImages?.length ?? 0;
const nv = (r: GenerateRequest) => r.referenceVideos?.length ?? 0;
const na = (r: GenerateRequest) => r.referenceAudios?.length ?? 0;

function mentionError(req: GenerateRequest): string | null {
  const frames = req.mode === "frames";
  const counts = frames ? { Image: 0, Video: 0, Audio: 0 } : { Image: ni(req), Video: nv(req), Audio: na(req) };
  const bad = invalidMentions(req.prompt ?? "", counts);
  if (bad.length) return `Prompt references ${bad.join(", ")}, which ${bad.length === 1 ? "isn't" : "aren't"} attached`;
  return null;
}

/**
 * Swaps `upload:<key>` references (uploads or generated assets) for links the provider can
 * download, checking each is a file of the right kind.
 */
async function resolveUploads(userId: string, items: string[] | undefined, kind: UploadKind) {
  if (!items) return undefined;
  return Promise.all(
    items.map(async (v) => {
      if (!isUploadRef(v)) return v;
      const key = uploadKeyOf(v);
      const asset = isAssetKey(key) ? await getAsset(userId, key) : undefined;
      const assetKind =
        asset && (uploadKindOf(asset.contentType) ?? (asset.contentType.startsWith("image/") && "image"));
      if (!asset || assetKind !== kind)
        throw Object.assign(new Error("A reference is no longer in your uploads. Remove it and add it again."), {
          status: 400,
        });
      return providerUrl(asset);
    }),
  );
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const providerId = user.activeProvider;
    if (!providerId) return Response.json({ error: "Add an API key in Settings to start generating" }, { status: 400 });
    const provider = await providerForUser(user.id, providerId);

    const req = (await request.json()) as GenerateRequest;
    const model = getModel(req.model);
    const route = model && routeFor(model, providerId);
    if (!model || !isVideo(model) || !route)
      return Response.json({ error: `Model "${req.model}" isn't available on ${provider.label}` }, { status: 400 });
    const invalid = videoRequestError(model, req) ?? mentionError(req);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    // The result will be copied into the user's bucket, so don't start one they can't keep.
    await assertStorageAvailable(user.id);

    const [referenceImages, referenceVideos, referenceAudios] = await Promise.all([
      resolveUploads(user.id, req.referenceImages, "image"),
      resolveUploads(user.id, req.referenceVideos, "video"),
      resolveUploads(user.id, req.referenceAudios, "audio"),
    ]);

    // Prompts are stored as written ("@Image 2"); the provider gets its own syntax and model id.
    const { taskId } = await provider.createTask({
      ...req,
      model: route.endpoint,
      prompt: normalizeMentions(req.prompt, mentionSyntax(model.refSyntax)),
      referenceImages,
      referenceVideos,
      referenceAudios,
    });
    const now = Date.now();
    const frames = req.mode === "frames";
    const gen: Generation = {
      id: crypto.randomUUID(),
      provider: providerId,
      taskId,
      status: "queued",
      model: req.model,
      prompt: req.prompt,
      mode: req.mode,
      ratio: req.ratio,
      resolution: req.resolution,
      duration: req.duration,
      generateAudio: !!req.generateAudio,
      seed: req.seed,
      inputs: {
        firstFrame: frames && !!req.firstFrame,
        lastFrame: frames && !!req.firstFrame && !!req.lastFrame,
        images: frames ? 0 : ni(req),
        videos: frames ? 0 : nv(req),
        audios: frames ? 0 : na(req),
      },
      createdAt: now,
      updatedAt: now,
    };
    await insertGeneration(user.id, gen);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
