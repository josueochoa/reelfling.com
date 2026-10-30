import { errorResponse, requireUser } from "@/lib/auth";
import {
  estimateImageCost,
  getImageModel,
  gptSize,
  ratioAllowed,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/imageModels";
import { enqueueImageJob, insertImageGeneration, listImageGenerations, type ImageGeneration } from "@/lib/images";
import { getCredentials } from "@/lib/keys";
import { invalidMentions } from "@/lib/mentions";
import { assertStorageAvailable, getAsset } from "@/lib/storage";
import { isAssetKey, uploadKindOf } from "@/lib/uploads";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(await listImageGenerations(user.id));
  } catch (e) {
    return errorResponse(e);
  }
}

export interface ImageRequest {
  model: string;
  prompt: string;
  ratio: string;
  /** With ratio "auto" and a reference image: the ratio closest to it, picked in the browser. */
  autoRatio?: string;
  resolution: ImageResolution;
  quality?: ImageQuality;
  count: number;
  /** Library keys of reference images, in order. */
  references: string[];
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

/** Validates and queues an image generation; the page polls GET /api/images/:id. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const req = (await request.json()) as ImageRequest;
    const model = getImageModel(req.model);
    if (!model) return bad(`Unknown model "${req.model}"`);
    const prompt = req.prompt?.trim();
    if (!prompt) return bad("Write a prompt");
    if (!model.resolutions.includes(req.resolution)) return bad(`Resolution ${req.resolution} isn't available`);
    if (!ratioAllowed(model, req.ratio, req.resolution))
      return bad(`Ratio ${req.ratio} isn't available at ${req.resolution.toUpperCase()}`);
    if (req.quality && !model.qualities?.includes(req.quality)) return bad(`Quality ${req.quality} isn't available`);
    if (!Number.isInteger(req.count) || req.count < 1 || req.count > model.maxImages)
      return bad(`Generate 1–${model.maxImages} images at a time`);
    const refs = Array.isArray(req.references) ? req.references : [];
    if (refs.length > model.maxReferences)
      return bad(`${model.label} takes up to ${model.maxReferences} reference images`);
    for (const key of refs) {
      // Uploads or generated images.
      const asset = isAssetKey(key) ? await getAsset(user.id, key) : undefined;
      if (!asset || !(uploadKindOf(asset.contentType) === "image" || asset.contentType.startsWith("image/")))
        return bad("A reference isn't an image in your uploads. Remove it and add it again.");
    }
    const mentions = invalidMentions(prompt, { Image: refs.length, Video: 0, Audio: 0 });
    if (mentions.length) return bad(`Prompt references ${mentions.join(", ")}, which isn't attached`);
    if (!(await getCredentials(user.id, "argolink")))
      return bad("Image models run through ArgoLink. Add your ArgoLink API key under API keys.");
    await assertStorageAvailable(user.id);

    // "auto": the reference's shape if there is one; otherwise the model's own default.
    let aspect: string | undefined = req.ratio;
    if (req.ratio === "auto")
      aspect =
        refs.length && req.autoRatio && ratioAllowed(model, req.autoRatio, req.resolution) && req.autoRatio !== "auto"
          ? req.autoRatio
          : model.brand === "google"
            ? "1:1"
            : undefined;
    if (model.brand === "openai" && aspect && !gptSize(aspect, req.resolution)) aspect = undefined;

    const now = Date.now();
    const gen: ImageGeneration = {
      id: crypto.randomUUID(),
      model: model.id,
      prompt,
      status: "queued",
      ratio: req.ratio,
      aspect,
      resolution: req.resolution,
      quality: model.qualities ? (req.quality ?? "auto") : undefined,
      count: req.count,
      references: refs,
      images: [],
      cost: estimateImageCost(model, req.resolution, req.count),
      createdAt: now,
      updatedAt: now,
    };
    await insertImageGeneration(user.id, gen);
    await enqueueImageJob(user.id, gen.id);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
