import { errorResponse, requireUser } from "@/lib/auth";
import { getCredentials, listKeys } from "@/lib/keys";
import { invalidMentions, normalizeMentions } from "@/lib/mentions";
import { providerForUser } from "@/lib/providers";
import { falQueueInput, submitFal } from "@/lib/providers/fal";
import { availabilityError, availabilityFor, routeProviders } from "@/lib/registry/availability";
import { applyNativeExpansion } from "@/lib/enhance";
import { applyCameraMoves, CAMERA_MOVE_MAX } from "@/lib/registry/camera";
import { catalogModel, FAL_VIDEO_ENDPOINTS } from "@/lib/registry/generated";
import { estimateRouteCost, isStudioProvider, isVideo, mentionSyntax, videoRequestError } from "@/lib/registry";
import { preferredRoute } from "@/lib/registry/routing";
import type { FalInputMap, StudioProviderId } from "@/lib/registry/types";
import { getRoutePreference } from "@/lib/routes";
import { assertStorageAvailable, getAsset, providerUrl } from "@/lib/storage";
import { continueSequence, insertGeneration, listGenerations } from "@/lib/store";
import { templateRecord, templateRouteError } from "@/lib/templates/templates";
import type { GenerateRequest, Generation, GenerationInputs, MediaBlock } from "@/lib/types";
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
async function resolveOne(userId: string, value: string, kind: UploadKind): Promise<ResolvedMedia> {
  if (!isUploadRef(value)) return { url: value };
  const key = uploadKeyOf(value);
  const asset = isAssetKey(key) ? await getAsset(userId, key) : undefined;
  const assetKind = asset && (uploadKindOf(asset.contentType) ?? (asset.contentType.startsWith("image/") && "image"));
  if (!asset || assetKind !== kind)
    throw Object.assign(new Error("A reference is no longer in your uploads. Remove it and add it again."), {
      status: 400,
    });
  const name = asset.name?.trim().slice(0, 120) || key.split("/").pop();
  return { url: await providerUrl(asset), key, name };
}

async function resolveList(userId: string, items: string[] | undefined, kind: UploadKind) {
  if (!items) return undefined;
  return Promise.all(items.map((v) => resolveOne(userId, v, kind)));
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

/** Omit when there is no reference video. `0` still selects the with-video rate. */
async function referenceVideoSecondsOf(userId: string, req: GenerateRequest): Promise<number | undefined> {
  if (req.mode === "frames" || !req.referenceVideos?.length) return undefined;
  let sum = 0;
  for (const value of req.referenceVideos) {
    if (!isUploadRef(value)) continue;
    const asset = await getAsset(userId, uploadKeyOf(value));
    sum += asset?.meta?.duration ?? 0;
  }
  return sum;
}

type VideoRun =
  | { provider: "fal"; endpoint: string; inputs: FalInputMap }
  | { provider: StudioProviderId; endpoint: string };

/** Studio providers, or a fal video whose queue body was checked. */
function videoRun(route: { provider: string; endpoint: string }, inputs: FalInputMap | undefined): VideoRun | undefined {
  if (route.provider === "fal" && FAL_VIDEO_ENDPOINTS.has(route.endpoint) && inputs)
    return { provider: "fal", endpoint: route.endpoint, inputs };
  if (isStudioProvider(route.provider)) return { provider: route.provider, endpoint: route.endpoint };
  return undefined;
}

function frameFields(media: ResolvedMedia | undefined, keyName: "firstFrameKey" | "lastFrameKey") {
  if (!media?.key) return {};
  const nameKey = keyName === "firstFrameKey" ? "firstFrameName" : "lastFrameName";
  return { [keyName]: media.key, ...(media.name && { [nameKey]: media.name }) };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const req = (await request.json()) as GenerateRequest;
    const model = catalogModel(req.model);
    if (!model || !isVideo(model))
      return Response.json({ error: `Model "${req.model}" isn't available` }, { status: 400 });
    const keyed = new Set((await listKeys(user.id)).map((key) => key.provider));
    const gate = availabilityFor(routeProviders(model.routes), keyed);
    if (!gate.available) return Response.json({ error: availabilityError(gate.needs) }, { status: 400 });
    const saved = await getRoutePreference(user.id, model.id);
    const explicit = typeof req.route === "string" ? req.route : null;
    const route = preferredRoute(model, keyed, [explicit, saved, user.activeProvider]);
    // ModelArk, ArgoLink, and OpenRouter have a studio body. A fal video route is
    // allowed only when its queue body was checked against that endpoint's schema.
    const run = route && videoRun(route, model.inputs);
    if (!run) return Response.json({ error: "This model isn't available on the video tab." }, { status: 400 });
    const templateError = templateRouteError(req, run.provider);
    if (templateError) return Response.json({ error: templateError }, { status: 400 });
    const invalid = videoRequestError(model, req) ?? mentionError(req);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    // The result will be copied into the user's bucket, so don't start one they can't keep.
    await assertStorageAvailable(user.id);
    const referenceVideoSeconds = await referenceVideoSecondsOf(user.id, req);
    const estimate =
      estimateRouteCost(model, run.provider, {
        resolution: req.resolution,
        duration: req.duration,
        audio: !!req.generateAudio,
        referenceVideoSeconds,
      }) ?? 0;

    const caps = model.capabilities;
    if (!caps.audio) delete req.generateAudio;
    if (!caps.seed) delete req.seed;
    if (!caps.watermark) delete req.watermark;
    if (!(caps.camera && caps.camera.fixed)) delete req.cameraFixed;

    const frames = req.mode === "frames";
    const middleValues = frames && caps.frames.middle ? req.middleFrames : undefined;
    const [first, last, middle, referenceImages, referenceVideos, referenceAudios] = await Promise.all([
      frames && req.firstFrame ? resolveOne(user.id, req.firstFrame, "image") : undefined,
      frames && req.firstFrame && req.lastFrame ? resolveOne(user.id, req.lastFrame, "image") : undefined,
      middleValues?.length ? Promise.all(middleValues.map((value) => resolveOne(user.id, value, "image"))) : undefined,
      resolveList(user.id, frames ? undefined : req.referenceImages, "image"),
      resolveList(user.id, frames ? undefined : req.referenceVideos, "video"),
      resolveList(user.id, frames ? undefined : req.referenceAudios, "audio"),
    ]);
    const blocks = frames
      ? undefined
      : orderedBlocks(req.referenceOrder, [
          ["image", referenceImages],
          ["video", referenceVideos],
          ["audio", referenceAudios],
        ]);

    // The record keeps the prompt as written and the chip ids. applyCameraMoves
    // appends each chip's line, or sets a native field, only on the provider copy.
    const cameraMoves = (req.cameraMoves?.length ? req.cameraMoves : req.cameraMove ? [req.cameraMove] : []).slice(
      0,
      CAMERA_MOVE_MAX,
    );
    const nativeOn = req.promptExpansion === true;
    const withoutExpansion = { ...req };
    delete withoutExpansion.promptExpansion;
    const providerReq = applyCameraMoves(model, {
      ...withoutExpansion,
      model: run.endpoint,
      prompt: normalizeMentions(req.prompt, mentionSyntax(model.refSyntax)),
      firstFrame: first?.url,
      lastFrame: last?.url,
      middleFrames: middle?.map((item) => item.url),
      referenceImages: referenceImages?.map((media) => media.url),
      referenceVideos: referenceVideos?.map((media) => media.url),
      referenceAudios: referenceAudios?.map((media) => media.url),
    });
    // A missing fal key would 400 after the part was claimed. Check it first.
    const falCreds = run.provider === "fal" ? await getCredentials(user.id, "fal") : undefined;
    if (run.provider === "fal" && !falCreds)
      return Response.json({ error: "Add your fal API key in Settings first." }, { status: 400 });
    // Before any provider call. A missing source 400s here, so a paid task is never started.
    const continued =
      typeof req.continueFrom === "string" && req.continueFrom
        ? await continueSequence(user.id, req.continueFrom)
        : undefined;
    if (typeof req.continueFrom === "string" && req.continueFrom && !continued)
      return Response.json({ error: "That video is no longer in your feed." }, { status: 400 });
    let taskId: string;
    let falUrls: { falStatusUrl: string; falResponseUrl: string; falCancelUrl: string } | undefined;
    if (run.provider === "fal") {
      if (!falCreds) return Response.json({ error: "Add your fal API key in Settings first." }, { status: 400 });
      const submission = await submitFal(
        falCreds.apiKey,
        run.endpoint,
        applyNativeExpansion(falQueueInput(providerReq, run.inputs), model, run, nativeOn),
      );
      taskId = submission.requestId;
      falUrls = {
        falStatusUrl: submission.statusUrl,
        falResponseUrl: submission.responseUrl,
        falCancelUrl: submission.cancelUrl,
      };
    } else {
      const provider = await providerForUser(user.id, run.provider);
      ({ taskId } = await provider.createTask(providerReq));
    }
    const now = Date.now();
    const inputs: GenerationInputs = {
      firstFrame: frames && !!first,
      lastFrame: frames && !!first && !!last,
      images: frames ? 0 : ni(req),
      videos: frames ? 0 : nv(req),
      audios: frames ? 0 : na(req),
      ...frameFields(first, "firstFrameKey"),
      ...frameFields(last, "lastFrameKey"),
      ...(middle?.some((item) => item.key)
        ? {
            middleFrames: middle.flatMap((item) =>
              item.key ? [{ kind: "image" as const, key: item.key, ...(item.name && { name: item.name }) }] : [],
            ),
          }
        : {}),
      ...(blocks && blocks.length > 0 && { blocks }),
    };
    const gen: Generation = {
      id: crypto.randomUUID(),
      provider: run.provider,
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
      ...(cameraMoves.length ? { cameraMoves } : {}),
      inputs,
      route: run.provider,
      routeEndpoint: run.endpoint,
      estimatedCost: estimate,
      ...templateRecord(req),
      ...(continued && {
        sequenceId: continued.sequenceId,
        part: continued.part,
        continuedFrom: continued.sourceGenerationId,
      }),
      ...falUrls,
      createdAt: now,
      updatedAt: now,
    };
    await insertGeneration(user.id, gen);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
