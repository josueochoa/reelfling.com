import { errorResponse, requireUser } from "@/lib/auth";
import { enqueueImageJob, insertImageGeneration, listImageGenerations, type ImageGeneration } from "@/lib/images";
import { listKeys } from "@/lib/keys";
import { invalidMentions } from "@/lib/mentions";
import { availabilityError, availabilityFor, routeProviders } from "@/lib/registry/availability";
import {
  estimateRouteCost,
  imagePriceMegapixels,
  imageProviderFor,
  imageRequestAspect,
  imageRequestError,
  isImage,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/registry";
import { catalogModel, FAL_IMAGE_ENDPOINTS } from "@/lib/registry/generated";
import { preferredRoute } from "@/lib/registry/routing";
import { getRoutePreference } from "@/lib/routes";
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
  /** Provider route chosen in the picker or restored by Reuse. */
  route?: string;
}

const bad = (error: string) => Response.json({ error }, { status: 400 });

/** Validates and queues an image generation; the page polls GET /api/images/:id. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const req = (await request.json()) as ImageRequest;
    const found = catalogModel(req.model);
    const model = found && isImage(found) ? found : undefined;
    if (!model) return bad(`Unknown model "${req.model}"`);
    const prompt = req.prompt?.trim();
    const refs = Array.isArray(req.references) ? req.references : [];
    const invalid = imageRequestError(model, { prompt, ratio: req.ratio, resolution: req.resolution, quality: req.quality, count: req.count, references: refs });
    if (invalid || !prompt) return bad(invalid ?? "Write a prompt");
    for (const key of refs) {
      // Uploads or generated images.
      const asset = isAssetKey(key) ? await getAsset(user.id, key) : undefined;
      if (!asset || !(uploadKindOf(asset.contentType) === "image" || asset.contentType.startsWith("image/")))
        return bad("A reference isn't an image in your uploads. Remove it and add it again.");
    }
    const mentions = invalidMentions(prompt, { Image: refs.length, Video: 0, Audio: 0 });
    if (mentions.length) return bad(`Prompt references ${mentions.join(", ")}, which isn't attached`);
    const keyed = new Set((await listKeys(user.id)).map((key) => key.provider));
    const gate = availabilityFor(routeProviders(model.routes), keyed);
    if (!gate.available) return bad(availabilityError(gate.needs));
    const saved = await getRoutePreference(user.id, model.id);
    const explicit = typeof req.route === "string" ? req.route : null;
    const route = preferredRoute(model, keyed, [explicit, saved, imageProviderFor(user.activeProvider, [...keyed])]);
    const falImage = route?.provider === "fal" && FAL_IMAGE_ENDPOINTS.has(route.endpoint) && !!model.inputs;
    if (
      !route ||
      !(route.provider === "argolink" || route.provider === "openrouter" || (route.provider === "fal" && falImage))
    )
      return bad("This model isn't available on the image tab.");
    const imageProvider = route.provider;
    await assertStorageAvailable(user.id);

    const priceInput = {
      ratio: req.ratio,
      resolution: req.resolution,
      references: refs.length,
      autoRatio: req.autoRatio,
    };
    const aspect = imageRequestAspect(model, priceInput);
    const estimate =
      estimateRouteCost(model, imageProvider, {
        resolution: req.resolution,
        count: req.count,
        quality: req.quality,
        referenceImages: refs.length,
        megapixels: imagePriceMegapixels(model, priceInput),
      }) ?? 0;

    const now = Date.now();
    const gen: ImageGeneration = {
      id: crypto.randomUUID(),
      provider: imageProvider,
      model: model.id,
      prompt,
      status: "queued",
      ratio: req.ratio,
      aspect,
      resolution: req.resolution,
      quality: model.capabilities.qualities ? (req.quality ?? "auto") : undefined,
      count: req.count,
      references: refs,
      images: [],
      cost: estimate,
      route: imageProvider,
      routeEndpoint: route.endpoint,
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
