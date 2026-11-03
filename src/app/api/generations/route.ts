import { errorResponse } from "@/lib/auth";
import { openGenerationKey, runWithCap } from "@/lib/generationKey";
import { invalidMentions, normalizeMentions } from "@/lib/mentions";
import { createProvider } from "@/lib/providers";
import { applyCameraMove } from "@/lib/registry/camera-apply";
import { catalogModel } from "@/lib/registry/generated";
import { estimateCost, isVideo, mentionSyntax, routeFor, videoRequestError } from "@/lib/registry";
import { assertStorageAvailable, getAsset, providerUrl } from "@/lib/storage";
import { insertGeneration, listGenerations } from "@/lib/store";
import type { GenerateRequest, Generation, GenerationInputs, MediaBlock } from "@/lib/types";
import { requireWorkspace } from "@/lib/workspaces";
import type { KeySource } from "@/lib/scope";
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

function mentionError(req: GenerateRequest): string | null {
  const frames = req.mode === "frames";
  const counts = frames ? { Image: 0, Video: 0, Audio: 0 } : { Image: ni(req), Video: nv(req), Audio: na(req) };
  const bad = invalidMentions(req.prompt ?? "", counts);
  if (bad.length) return `Prompt references ${bad.join(", ")}, which ${bad.length === 1 ? "isn't" : "aren't"} attached`;
  return null;
}

interface ResolvedMedia {
  /** URL the provider fetches. */
  url: string;
  /** R2 key when the value was `upload:<key>`. */
  key?: string;
  name?: string;
}

/**
 * Swaps an `upload:<key>` (an upload or a generated asset) for a link the provider can
 * download, checking it's a file of the right kind. https and data: URLs pass through.
 */
async function resolveOne(workspaceId: string, value: string, kind: UploadKind): Promise<ResolvedMedia> {
  if (!isUploadRef(value)) return { url: value };
  const key = uploadKeyOf(value);
  const asset = isAssetKey(key) ? await getAsset(workspaceId, key) : undefined;
  const assetKind = asset && (uploadKindOf(asset.contentType) ?? (asset.contentType.startsWith("image/") && "image"));
  if (!asset || assetKind !== kind)
    throw Object.assign(new Error("A reference is no longer in your uploads. Remove it and add it again."), {
      status: 400,
    });
  const name = asset.name?.trim().slice(0, 120) || key.split("/").pop();
  return { url: await providerUrl(asset), key, name };
}

async function resolveList(workspaceId: string, items: string[] | undefined, kind: UploadKind) {
  if (!items) return undefined;
  return Promise.all(items.map((v) => resolveOne(workspaceId, v, kind)));
}

/** Reference blocks in the order the client showed them. Kind and name come from the files we resolved. */
function orderedBlocks(order: string[] | undefined, groups: [UploadKind, ResolvedMedia[] | undefined][]): MediaBlock[] {
  const byKey = new Map<string, MediaBlock>();
  const fallback: MediaBlock[] = [];
  for (const [kind, list] of groups) {
    for (const media of list ?? []) {
      if (!media.key || byKey.has(media.key)) continue;
      const block: MediaBlock = { kind, key: media.key, ...(media.name && { name: media.name }) };
      byKey.set(media.key, block);
      fallback.push(block);
    }
  }
  if (!order?.length) return fallback;
  const ordered: MediaBlock[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    const block = byKey.get(key);
    if (!block || seen.has(key)) continue;
    ordered.push(block);
    seen.add(key);
  }
  for (const block of fallback) if (!seen.has(block.key)) ordered.push(block);
  return ordered;
}

function frameFields(media: ResolvedMedia | undefined, keyName: "firstFrameKey" | "lastFrameKey") {
  if (!media?.key) return {};
  const nameKey = keyName === "firstFrameKey" ? "firstFrameName" : "lastFrameName";
  return { [keyName]: media.key, ...(media.name && { [nameKey]: media.name }) };
}

export async function POST(request: Request) {
  try {
    const { user, workspace } = await requireWorkspace(request);
    const req = (await request.json()) as GenerateRequest & { keySource?: KeySource };
    const requested = workspace.kind === "team" && req.keySource === "member" ? "member" : workspace.kind === "team" ? "team" : "member";
    const providerId =
      requested === "member" && workspace.kind === "team" ? user.activeProvider : workspace.activeProvider;
    if (!providerId) return Response.json({ error: "Add an API key in Settings to start generating" }, { status: 400 });

    const model = catalogModel(req.model);
    const route = model && routeFor(model, providerId);
    if (!model || !isVideo(model) || !route)
      return Response.json({ error: `Model "${req.model}" isn't available on this provider` }, { status: 400 });
    const invalid = videoRequestError(model, req) ?? mentionError(req);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    await assertStorageAvailable(workspace.id);
    const estimate = estimateCost(model, { resolution: req.resolution, duration: req.duration, audio: !!req.generateAudio }) ?? 0;
    const opened = await openGenerationKey({
      workspace,
      userId: user.id,
      provider: providerId,
      requested,
      estimate,
    });

    const caps = model.capabilities;
    if (!caps.audio) delete req.generateAudio;
    if (!caps.seed) delete req.seed;
    if (!caps.watermark) delete req.watermark;
    if (!(caps.camera && caps.camera.fixed)) delete req.cameraFixed;

    const frames = req.mode === "frames";
    const [first, last, referenceImages, referenceVideos, referenceAudios] = await Promise.all([
      frames && req.firstFrame ? resolveOne(workspace.id, req.firstFrame, "image") : undefined,
      frames && req.firstFrame && req.lastFrame ? resolveOne(workspace.id, req.lastFrame, "image") : undefined,
      resolveList(workspace.id, frames ? undefined : req.referenceImages, "image"),
      resolveList(workspace.id, frames ? undefined : req.referenceVideos, "video"),
      resolveList(workspace.id, frames ? undefined : req.referenceAudios, "audio"),
    ]);
    const blocks = frames
      ? undefined
      : orderedBlocks(req.referenceOrder, [
          ["image", referenceImages],
          ["video", referenceVideos],
          ["audio", referenceAudios],
        ]);

    // The record keeps the prompt as written. applyCameraMove may append a camera
    // sentence, or set camera_fixed, only on the copy the provider receives.
    const provider = createProvider(providerId, opened.creds);
    const { taskId } = await runWithCap(opened, () =>
      provider.createTask(
      applyCameraMove(model, {
        ...req,
        model: route.endpoint,
        prompt: normalizeMentions(req.prompt, mentionSyntax(model.refSyntax)),
        firstFrame: first?.url,
        lastFrame: last?.url,
        referenceImages: referenceImages?.map((media) => media.url),
        referenceVideos: referenceVideos?.map((media) => media.url),
        referenceAudios: referenceAudios?.map((media) => media.url),
      }),
    ));
    const now = Date.now();
    const inputs: GenerationInputs = {
      firstFrame: frames && !!first,
      lastFrame: frames && !!first && !!last,
      images: frames ? 0 : ni(req),
      videos: frames ? 0 : nv(req),
      audios: frames ? 0 : na(req),
      ...frameFields(first, "firstFrameKey"),
      ...frameFields(last, "lastFrameKey"),
      ...(blocks && blocks.length > 0 && { blocks }),
    };
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
      ...(req.cameraMove ? { cameraMove: req.cameraMove } : {}),
      inputs,
      keySource: opened.source,
      route: providerId,
      routeEndpoint: route.endpoint,
      estimatedCost: estimate,
      keyWorkspaceId: opened.keyWorkspaceId,
      createdAt: now,
      updatedAt: now,
    };
    await insertGeneration(workspace.id, gen, user.id);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
