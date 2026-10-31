import { errorResponse } from "@/lib/auth";
import { invalidMentions, normalizeMentions } from "@/lib/mentions";
import { getModel, type ModelSpec } from "@/lib/models";
import { providerForWorkspace } from "@/lib/providers";
import { assertStorageAvailable, getAsset, providerUrl } from "@/lib/storage";
import { insertGeneration, listGenerations } from "@/lib/store";
import { requireWorkspace } from "@/lib/workspaces";
import type { GenerateRequest, Generation } from "@/lib/types";
import { isAssetKey, isUploadRef, uploadKeyOf, uploadKindOf, type UploadKind } from "@/lib/uploads";

export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    return Response.json(await listGenerations(workspace.id));
  } catch (e) {
    return errorResponse(e);
  }
}

const ni = (r: GenerateRequest) => r.referenceImages?.length ?? 0;
const nv = (r: GenerateRequest) => r.referenceVideos?.length ?? 0;
const na = (r: GenerateRequest) => r.referenceAudios?.length ?? 0;

function validate(req: GenerateRequest, model: ModelSpec): string | null {
  const frames = req.mode === "frames";
  if (model.promptRequired && !req.prompt?.trim()) return `${model.label} needs a prompt`;
  if (!req.prompt?.trim() && !(frames && req.firstFrame) && !req.referenceImages?.length)
    return "Add a prompt or an image";
  if (!model.ratios.includes(req.ratio)) return `Ratio ${req.ratio} not supported by ${model.label}`;
  if (req.ratio === "adaptive" && !(frames && req.firstFrame)) return "Auto ratio needs a start frame";
  if (!model.resolutions.includes(req.resolution)) return `Resolution ${req.resolution} not supported`;
  if (!Number.isInteger(req.duration) || req.duration < model.durations.min || req.duration > model.durations.max)
    return `Duration must be ${model.durations.min}–${model.durations.max}s`;
  if (frames) {
    if (req.firstFrame && !model.firstFrame) return `${model.label} doesn't support image-to-video`;
    if (req.lastFrame && !req.firstFrame) return "An end frame needs a start frame";
    if (req.lastFrame && !model.lastFrame) return `${model.label} doesn't support end frames`;
  } else {
    const { images, videos, audios, total } = model.references;
    if (ni(req) > images) return `Max ${images} reference images`;
    if (nv(req) > videos) return `Max ${videos} reference videos`;
    if (na(req) > audios) return `Max ${audios} reference audio clips`;
    if (ni(req) + nv(req) + na(req) > total) return `Max ${total} references in total`;
    if (na(req) > 0 && ni(req) + nv(req) === 0) return "Audio needs at least one image or video reference";
  }
  const counts = frames ? { Image: 0, Video: 0, Audio: 0 } : { Image: ni(req), Video: nv(req), Audio: na(req) };
  const bad = invalidMentions(req.prompt ?? "", counts);
  if (bad.length) return `Prompt references ${bad.join(", ")}, which ${bad.length === 1 ? "isn't" : "aren't"} attached`;
  return null;
}

/**
 * Swaps `upload:<key>` references (uploads or generated assets) for links the provider can
 * download, checking each is a file of the right kind.
 */
async function resolveUploads(workspaceId: string, items: string[] | undefined, kind: UploadKind) {
  if (!items) return undefined;
  return Promise.all(
    items.map(async (v) => {
      if (!isUploadRef(v)) return v;
      const key = uploadKeyOf(v);
      const asset = isAssetKey(key) ? await getAsset(workspaceId, key) : undefined;
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
    const { user, workspace } = await requireWorkspace(request);
    const providerId = workspace.activeProvider;
    if (!providerId)
      return Response.json({ error: "Add an API key under API keys to start generating" }, { status: 400 });
    const provider = await providerForWorkspace(workspace.id, providerId);

    const req = (await request.json()) as GenerateRequest;
    const model = getModel(req.model);
    if (!model || model.provider !== providerId)
      return Response.json({ error: `Model "${req.model}" isn't available on ${provider.label}` }, { status: 400 });
    const invalid = validate(req, model);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    // The result will be copied into the user's bucket, so don't start one they can't keep.
    await assertStorageAvailable(workspace.id);

    // Drop params the provider would reject.
    if (!model.audio) delete req.generateAudio;
    if (!model.features.seed) delete req.seed;
    if (!model.features.watermark) delete req.watermark;
    if (!model.features.cameraFixed) delete req.cameraFixed;

    const [referenceImages, referenceVideos, referenceAudios] = await Promise.all([
      resolveUploads(workspace.id, req.referenceImages, "image"),
      resolveUploads(workspace.id, req.referenceVideos, "video"),
      resolveUploads(workspace.id, req.referenceAudios, "audio"),
    ]);

    // Prompts are stored as written ("@Image 2"); the provider gets its own syntax.
    const { taskId } = await provider.createTask({
      ...req,
      prompt: normalizeMentions(req.prompt, model.refSyntax),
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
    await insertGeneration(workspace.id, gen, user.id);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
