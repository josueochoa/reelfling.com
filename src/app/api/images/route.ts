import { errorResponse } from "@/lib/auth";
import { openGenerationKey, resolveAvailableRoute, runWithCap } from "@/lib/generationKey";
import { enqueueImageJob, insertImageGeneration, listImageGenerations, type ImageGeneration } from "@/lib/images";
import { invalidMentions } from "@/lib/mentions";
import type { KeySource } from "@/lib/scope";
import {
  estimateRouteCost,
  getImageModel,
  imageProviderFor,
  imageRequestError,
  ratioAllowed,
  type ImageKeyProvider,
  type ImageQuality,
  type ImageResolution,
} from "@/lib/registry";
import { assertStorageAvailable, getAsset } from "@/lib/storage";
import { isAssetKey, uploadKindOf } from "@/lib/uploads";
import { preferredRoute } from "@/lib/registry/routing";
import { getRoutePreference } from "@/lib/routes";
import { requireWorkspace } from "@/lib/workspaces";

export async function GET(request: Request) {
  try {
    const { workspace } = await requireWorkspace(request);
    return Response.json(await listImageGenerations(workspace.id));
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
    const { user, workspace } = await requireWorkspace(request);
    const req = (await request.json()) as ImageRequest & { keySource?: KeySource };
    const model = getImageModel(req.model);
    if (!model) return bad(`Unknown model "${req.model}"`);
    const prompt = req.prompt?.trim();
    const refs = Array.isArray(req.references) ? req.references : [];
    const invalid = imageRequestError(model, { prompt, ratio: req.ratio, resolution: req.resolution, quality: req.quality, count: req.count, references: refs });
    if (invalid || !prompt) return bad(invalid ?? "Write a prompt");
    for (const key of refs) {
      // Uploads or generated images.
      const asset = isAssetKey(key) ? await getAsset(workspace.id, key) : undefined;
      if (!asset || !(uploadKindOf(asset.contentType) === "image" || asset.contentType.startsWith("image/")))
        return bad("A reference isn't an image in your uploads. Remove it and add it again.");
    }
    const mentions = invalidMentions(prompt, { Image: refs.length, Video: 0, Audio: 0 });
    if (mentions.length) return bad(`Prompt references ${mentions.join(", ")}, which isn't attached`);
    const requested: KeySource =
      workspace.kind === "team" && req.keySource === "member" ? "member" : workspace.kind === "team" ? "team" : "member";
    const legacy = requested === "member" && workspace.kind === "team" ? user.activeProvider : workspace.activeProvider;
    const saved = await getRoutePreference(user.id, model.id);
    const explicit = typeof req.route === "string" ? req.route : null;
    const { route, source } = await resolveAvailableRoute(model, workspace, user.id, {
      requested,
      // imageProviderFor is the fallback: active image key, else any image key.
      prefer: (keyed) => preferredRoute(model, keyed, [explicit, saved, imageProviderFor(legacy, [...keyed])])?.provider,
    });
    if (route.provider !== "argolink" && route.provider !== "openrouter")
      return bad("This model isn't available on the image tab.");
    const imageProvider: ImageKeyProvider = route.provider;
    await assertStorageAvailable(workspace.id);
    const estimate = estimateRouteCost(model, imageProvider, { resolution: req.resolution, count: req.count }) ?? 0;
    const opened = await openGenerationKey({
      workspace,
      userId: user.id,
      provider: imageProvider,
      requested: source,
      estimate,
    });
    // Cap is checked before the job is queued. The queue is not the provider, but a
    // rejected job must not be stored or run.
    await runWithCap(opened, async () => undefined);

    // "auto": the reference's shape if there is one; otherwise the model's own fallback.
    let aspect: string | undefined = req.ratio;
    if (req.ratio === "auto")
      aspect =
        refs.length && req.autoRatio && ratioAllowed(model, req.autoRatio, req.resolution) && req.autoRatio !== "auto"
          ? req.autoRatio
          : model.capabilities.autoFallback;

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
      keySource: opened.source,
      route: imageProvider,
      routeEndpoint: route.endpoint,
      estimatedCost: estimate,
      keyWorkspaceId: opened.keyWorkspaceId,
      createdAt: now,
      updatedAt: now,
    };
    await insertImageGeneration(workspace.id, gen, user.id);
    await enqueueImageJob(workspace.id, user.id, gen.id);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
