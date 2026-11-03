import { errorResponse, requireUser } from "@/lib/auth";
import { invalidMentions, normalizeMentions } from "@/lib/mentions";
import { getModel, type ModelSpec } from "@/lib/models";
import { providerForUser } from "@/lib/providers";
import { assertStorageAvailable, getAsset, providerUrl } from "@/lib/storage";
import { insertGeneration, listGenerations } from "@/lib/store";
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

function frameFields(media: ResolvedMedia | undefined, keyName: "firstFrameKey" | "lastFrameKey") {
  if (!media?.key) return {};
  const nameKey = keyName === "firstFrameKey" ? "firstFrameName" : "lastFrameName";
  return { [keyName]: media.key, ...(media.name && { [nameKey]: media.name }) };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const providerId = user.activeProvider;
    if (!providerId) return Response.json({ error: "Add an API key in Settings to start generating" }, { status: 400 });
    const provider = await providerForUser(user.id, providerId);

    const req = (await request.json()) as GenerateRequest;
    const model = getModel(req.model);
    if (!model || model.provider !== providerId)
      return Response.json({ error: `Model "${req.model}" isn't available on ${provider.label}` }, { status: 400 });
    const invalid = validate(req, model);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    // The result will be copied into the user's bucket, so don't start one they can't keep.
    await assertStorageAvailable(user.id);

    // Drop params the provider would reject.
    if (!model.audio) delete req.generateAudio;
    if (!model.features.seed) delete req.seed;
    if (!model.features.watermark) delete req.watermark;
    if (!model.features.cameraFixed) delete req.cameraFixed;

    const frames = req.mode === "frames";
    const [first, last, referenceImages, referenceVideos, referenceAudios] = await Promise.all([
      frames && req.firstFrame ? resolveOne(user.id, req.firstFrame, "image") : undefined,
      frames && req.firstFrame && req.lastFrame ? resolveOne(user.id, req.lastFrame, "image") : undefined,
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

    // Prompts are stored as written ("@Image 2"); the provider gets its own syntax.
    // Adapters read the fields they know; referenceOrder is only stored on the record below.
    const { taskId } = await provider.createTask({
      ...req,
      prompt: normalizeMentions(req.prompt, model.refSyntax),
      firstFrame: first?.url,
      lastFrame: last?.url,
      referenceImages: referenceImages?.map((m) => m.url),
      referenceVideos: referenceVideos?.map((m) => m.url),
      referenceAudios: referenceAudios?.map((m) => m.url),
    });
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
      inputs,
      createdAt: now,
      updatedAt: now,
    };
    await insertGeneration(user.id, gen);
    return Response.json(gen, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
